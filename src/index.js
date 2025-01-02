const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { stringToHex, chunkToUtf8String, getRandomIDPro } = require('./utils.js');
const { StreamRegex } = require('stream-regex');
const { Readable } = require('stream');

const app = express();

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 工具函数
const decodeBase64 = (str) => (str ? Buffer.from(str, 'base64').toString() : '');

const processMessages = (messages, promptInjection) => {
  return messages.map((message, index) => {
    const content = Array.isArray(message.content) ? message.content.map((c) => c.text).join('\n') : message.content;

    return {
      ...message,
      content: index === messages.length - 1 && promptInjection ? `${content}\n${promptInjection}` : content,
    };
  });
};

const getAuthToken = (authHeader) => {
  if (!authHeader) return null;

  let token = authHeader.replace('Bearer ', '');
  const keys = token.split(',').map((key) => key.trim());

  if (keys.length > 0) {
    token = keys[0]; // 使用第一个密钥
  }

  return token.includes('%3A%3A') ? token.split('%3A%3A')[1] : token;
};

const getChecksum = (headers) => {
  return (
    headers['x-cursor-checksum'] ??
    process.env['x-cursor-checksum'] ??
    `zo${getRandomIDPro({ dictType: 'max', size: 6 })}${getRandomIDPro({ dictType: 'max', size: 64 })}/${getRandomIDPro({ dictType: 'max', size: 64 })}`
  );
};

const createRequestHeaders = (authToken, checksum) => ({
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
});

// 流处理类
class StreamProcessor {
  constructor(response, options) {
    this.response = response;
    this.options = options;
    this.buffer = '';
    this.hasStarted = !options.startsWith;
  }

  async *processStream() {
    const { startsWith, endsWith, streamRegexes } = this.options;

    for await (const chunk of this.response.body) {
      let text = await chunkToUtf8String(chunk);

      // 应用正则表达式替换
      for (const { streamRegex, replacement } of streamRegexes) {
        const readable = Readable.from([text]);
        let replacedText = '';
        for await (const chunk of streamRegex.replace(readable, replacement)) {
          replacedText += chunk.toString();
        }
        text = replacedText;
      }

      if (text.length > 0) {
        this.buffer += text;

        if (!this.hasStarted) {
          const startsIndex = this.buffer.indexOf(startsWith);
          if (startsIndex !== -1) {
            this.hasStarted = true;
            this.buffer = this.buffer.substring(startsIndex + startsWith.length);
          } else {
            continue;
          }
        }

        if (endsWith) {
          const endsIndex = this.buffer.indexOf(endsWith);
          if (endsIndex !== -1) {
            yield this.buffer.substring(0, endsIndex);
            return;
          }
        }

        if (this.hasStarted) {
          if (endsWith) {
            const safeLength = Math.max(0, this.buffer.length - endsWith.length);
            if (safeLength > 0) {
              const sendText = this.buffer.substring(0, safeLength);
              this.buffer = this.buffer.substring(safeLength);
              yield sendText;
            }
          } else {
            yield this.buffer;
            this.buffer = '';
          }
        }
      }
    }

    yield this.buffer;
    return;
  }
}

// 主要路由处理
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream = false } = req.body;

    // 验证模型是否支持流式输出
    if (model.startsWith('o1-') && stream) {
      return res.status(400).json({ error: 'Model not supported stream' });
    }

    // 处理消息和认证
    const promptInjection = decodeBase64(req.headers['x-prompt-injection']);
    const convertedMessages = processMessages(messages, promptInjection);
    const authToken = getAuthToken(req.headers.authorization);

    if (!convertedMessages?.length || !authToken) {
      return res.status(400).json({
        error: 'Invalid request. Messages should be a non-empty array and authorization is required',
      });
    }

    // 准备请求参数
    const customInstruction =
      decodeBase64(req.headers['x-custom-instruction'] ?? process.env['x-custom-instruction']) ||
      'Always respond in the same language as the user or in the language specified by the user.';

    const hexData = await stringToHex(convertedMessages, model, customInstruction);
    const checksum = getChecksum(req.headers);

    // 发送请求
    const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/StreamChat', {
      method: 'POST',
      headers: createRequestHeaders(authToken, checksum),
      body: hexData,
    });

    if (stream) {
      return handleStreamResponse(req, res, response, model);
    } else {
      return handleNormalResponse(res, response, model);
    }
  } catch (error) {
    handleError(error, req, res);
  }
});

// 响应处理函数
async function handleStreamResponse(req, res, response, model) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const responseId = `chatcmpl-${uuidv4()}`;
  const startsWith = decodeBase64(req.headers['x-starts-with']);
  const endsWith = decodeBase64(req.headers['x-ends-with']);

  // 处理正则规则
  const regexRules = JSON.parse(decodeBase64(req.headers['x-regex']) || '[]');
  const streamRegexes = regexRules.map((rule) => ({
    streamRegex: new StreamRegex(new RegExp(rule.pattern, rule.flags || 'g')),
    replacement: rule.replacement,
  }));

  const streamProcessor = new StreamProcessor(response, { startsWith, endsWith, streamRegexes });

  for await (const text of streamProcessor.processStream()) {
    const chunk = {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: text } }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  return res.end();
}

async function handleNormalResponse(res, response, model) {
  let text = '';
  for await (const chunk of response.body) {
    text += await chunkToUtf8String(chunk);
  }

  text = text
    .replace(/^.*<\|END_USER\|>/s, '')
    .replace(/^\n[a-zA-Z]?/, '')
    .trim();

  return res.json({
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function handleError(error, req, res) {
  console.error('Error:', error);
  if (!res.headersSent) {
    if (req.body.stream) {
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      return res.end();
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
