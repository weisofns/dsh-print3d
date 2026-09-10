#!/usr/bin/env node
/**
 * ollama_vision.cjs — 零依赖调用本地 Ollama 视觉模型描述图片。
 *
 * 用途：本地文本模型（Qwen3 等）没有视觉能力，通过本模块「借」本地视觉模型
 * （qwen2.5vl 等）的眼睛，拿回结构化文字描述，辅助判断建模方式。
 *
 * CLI 用法:
 *   node ollama_vision.cjs --image a.jpg
 *   node ollama_vision.cjs --image a.jpg --question "里面有几个孔？" --model qwen2.5vl:7b
 *
 * 程序化用法:
 *   const { describeImage } = require('./ollama_vision.cjs')
 *   const text = await describeImage({ imagePath, question, model })
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');

const DEFAULT_MODEL = 'qwen2.5vl:7b';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11434;

function fail(msg) {
  throw new Error('ollama_vision: ' + msg);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[++i];
      if (v === undefined) fail(`--${key} 缺少值`);
      args[key] = v;
    }
  }
  return args;
}

// 默认提问模板：面向 3D 打印，输出结构化、可直接指导下一步建模方式。
function defaultPrompt() {
  return [
    '你是 3D 打印辅助视觉模型。看这张图，用中文回答，严格每点一行、简洁：',
    '1) 物体：是什么',
    '2) 类型：平板(2.5D)/长方体/圆柱/圆盘/复杂立体',
    '3) 长宽比：约 X:Y',
    '4) 孔洞：有/无（几个）',
    '5) 明暗：物体比背景 亮/暗',
    '6) 建议：适合 print3d_image_to_stl 的 extrude（平板剪影挤出）、lithophane（浮雕），还是 print3d_parametric_print 参数化建模',
  ].join('\n');
}

function chatWithImage({ host, port, model, prompt, imageBase64 }) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
    stream: false,
    options: { temperature: 0.1 },
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama 返回 ${res.statusCode}：${data.slice(0, 300)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', (e) => {
      reject(new Error('无法连接 Ollama（' + host + ':' + port + '）：' + e.message + '。请先启动 ollama serve。'));
    });
    req.setTimeout(300000, () => req.destroy(new Error('Ollama 视觉请求超时')));
    req.write(body);
    req.end();
  });
}

async function describeImage({ imagePath, question, model, host, port }) {
  if (!imagePath || !fs.existsSync(imagePath)) fail('图片不存在：' + imagePath);
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const raw = await chatWithImage({
    host: host || DEFAULT_HOST,
    port: port || DEFAULT_PORT,
    model: model || DEFAULT_MODEL,
    prompt: question && String(question).trim() ? String(question) : defaultPrompt(),
    imageBase64,
  });
  try {
    const parsed = JSON.parse(raw);
    if (parsed.message && typeof parsed.message.content === 'string') return parsed.message.content.trim();
  } catch (_) {
    // 非 JSON，直接返回原文
  }
  return raw.trim();
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.image) fail('缺少 --image <图片路径>');
    const text = await describeImage({ imagePath: args.image, question: args.question, model: args.model });
    console.log(text);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { describeImage, defaultPrompt };
