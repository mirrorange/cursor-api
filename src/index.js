const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { stringToHex, chunkToUtf8String, getRandomIDPro } = require('./utils.js');
const app = express();

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/v1/chat/completions', async (req, res) => {
  // o1开头的模型，不支持流式输出
  if (req.body.model.startsWith('o1-') && req.body.stream) {
    return res.status(400).json({
      error: 'Model not supported stream',
    });
  }

  let currentKeyIndex = 0;
  try {
    const { model, messages, stream = false } = req.body;

    // 获取并解码 prompt injection
    const encodedPromptInjection = req.headers['x-prompt-injection'] || '';
    const promptInjection = encodedPromptInjection ? 
      Buffer.from(encodedPromptInjection, 'base64').toString() : '';

    // 新增：将messages中的content从列表转换为字符串，并在最后一条消息中添加 prompt injection
    const convertedMessages = messages.map((message, index) => {
      if (Array.isArray(message.content)) {
        message.content = message.content.map(c => c.text).join('\n');
      }
      // 如果是最后一条消息且存在 prompt injection，则添加到消息末尾
      if (index === messages.length - 1 && promptInjection) {
        message.content = `${message.content}\n${promptInjection}`;
      }
      return message;
    });

    let authToken = req.headers.authorization?.replace('Bearer ', '');
    // 处理逗号分隔的密钥
    const keys = authToken.split(',').map((key) => key.trim());
    if (keys.length > 0) {
      // 确保 currentKeyIndex 不会越界
      if (currentKeyIndex >= keys.length) {
        currentKeyIndex = 0;
      }
      // 使用当前索引获取密钥
      authToken = keys[currentKeyIndex];
    }
    if (authToken && authToken.includes('%3A%3A')) {
      authToken = authToken.split('%3A%3A')[1];
    }
    if (!convertedMessages || !Array.isArray(convertedMessages) || convertedMessages.length === 0 || !authToken) {
      return res.status(400).json({
        error: 'Invalid request. Messages should be a non-empty array and authorization is required',
      });
    }

    // 获取并解码 CustomInstruction 
    const encodedCustomInstruction = req.headers['x-custom-instruction'] ?? process.env['x-custom-instruction'];
    const customInstruction = encodedCustomInstruction ? 
      Buffer.from(encodedCustomInstruction, 'base64').toString() : 
      'Always respond in the same language as the user or in the language specified by the user.';

    const hexData = await stringToHex(convertedMessages, model, customInstruction);

    // 获取checksum，req header中传递优先，环境变量中的等级第二，最后随机生成
    const checksum =
      req.headers['x-cursor-checksum'] ??
      process.env['x-cursor-checksum'] ??
      `zo${getRandomIDPro({ dictType: 'max', size: 6 })}${getRandomIDPro({ dictType: 'max', size: 64 })}/${getRandomIDPro({ dictType: 'max', size: 64 })}`;

    const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/StreamChat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+proto',
        authorization: `Bearer ${authToken}`,
        'connect-accept-encoding': 'gzip,br',
        'connect-protocol-version': '1',
        'user-agent': 'connect-es/1.4.0',
        'x-amzn-trace-id': `Root=${uuidv4()}`,
        'x-cursor-checksum': checksum,
        'x-cursor-client-version': '0.42.3',
        'x-cursor-timezone': 'Asia/Shanghai',
        'x-ghost-mode': 'false',
        'x-request-id': uuidv4(),
        Host: 'api2.cursor.sh',
      },
      body: hexData,
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = `chatcmpl-${uuidv4()}`;
      const encodedStartsWith = req.headers['x-starts-with'] || '';
      const encodedEndsWith = req.headers['x-ends-with'] || '';
      
      // Base64 解码
      const startsWith = encodedStartsWith ? Buffer.from(encodedStartsWith, 'base64').toString() : '';
      const endsWith = encodedEndsWith ? Buffer.from(encodedEndsWith, 'base64').toString() : '';
      
      let buffer = '';
      let hasStarted = !startsWith; // 如果没有 startsWith，则直接开始输出

      // 使用封装的函数处理 chunk
      for await (const chunk of response.body) {
        const text = await chunkToUtf8String(chunk);
        if (text.length > 0) {
          buffer += text;
          
          // 处理 startsWith 条件
          if (!hasStarted) {
            const startsIndex = buffer.indexOf(startsWith);
            if (startsIndex !== -1) {
              hasStarted = true;
              buffer = buffer.substring(startsIndex + startsWith.length);
            } else {
              continue; // 继续等待直到找到 startsWith
            }
          }

          // 处理 endsWith 条件
          if (endsWith) {
            const endsIndex = buffer.indexOf(endsWith);
            if (endsIndex !== -1) {
              // 发送最后一段文本并结束
              const finalText = buffer.substring(0, endsIndex);
              if (finalText.length > 0) {
                res.write(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: finalText,
                        },
                      },
                    ],
                  })}\n\n`
                );
              }
              res.write('data: [DONE]\n\n');
              return res.end();
            }
          }

          // 发送缓冲区中的文本
          if (hasStarted) {
            if (endsWith) {
              // 如果设置了 endsWith，保留最后一个 chunk 以防它包含 endsWith 的部分内容
              const safeLength = Math.max(0, buffer.length - endsWith.length);
              if (safeLength > 0) {
                const sendText = buffer.substring(0, safeLength);
                buffer = buffer.substring(safeLength);
                res.write(
                  `data: ${JSON.stringify({
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: sendText,
                        },
                      },
                    ],
                  })}\n\n`
                );
              }
            } else {
              // 如果没有设置 endsWith，直接发送整个缓冲区
              res.write(
                `data: ${JSON.stringify({
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        content: buffer,
                      },
                    },
                  ],
                })}\n\n`
              );
              buffer = '';
            }
          }
        }
      }

      // 发送剩余的缓冲区内容
      if (hasStarted && buffer.length > 0) {
        res.write(
          `data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  content: buffer,
                },
              },
            ],
          })}\n\n`
        );
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      let text = '';
      // 在非流模式下也使用封装的函数
      for await (const chunk of response.body) {
        text += await chunkToUtf8String(chunk);
      }
      // 对解析后的字符串进行进一步处理
      text = text.replace(/^.*<\|END_USER\|>/s, '');
      text = text.replace(/^\n[a-zA-Z]?/, '').trim();
      // console.log(text)

      return res.json({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    }
  } catch (error) {
    console.error('Error:', error);
    if (!res.headersSent) {
      if (req.body.stream) {
        res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
        return res.end();
      } else {
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
