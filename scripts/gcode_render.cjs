#!/usr/bin/env node
/**
 * gcode_render.cjs — 零依赖 G-code 刀路可视化 → PNG（俯视图）。
 *
 * CLI 用法:
 *   node gcode_render.cjs <file.gcode> [--out out.png] [--size 1000]
 *
 * 程序化用法:
 *   const { renderGcode } = require('./gcode_render.cjs')
 *   renderGcode(text, size) -> { pngBase64, image, segments, bbox, ... }
 *
 * 颜色图例（按 PrusaSlicer 的 ;TYPE: 注释分类）:
 *   红    外围 / 内壁 (perimeter)
 *   蓝    内部填充 (internal infill)
 *   绿    实心填充 / 顶面 / 桥接 (solid infill)
 *   橙    裙边 / 底边 (skirt / brim)
 *   紫    支撑 (support)
 *   浅灰  空驶移动 (travel, 不挤出)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function fail(msg) { throw new Error('gcode_render: ' + msg); }

function parseArgs(argv) {
  const args = { size: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--size') args.size = Number(argv[++i]);
    else if (!args.file) args.file = a;
  }
  return args;
}

function tokenize(line) {
  const idx = line.indexOf(';');
  if (idx >= 0) line = line.slice(0, idx);
  const tokens = {};
  for (const part of line.split(/\s+/)) {
    if (!part) continue;
    const c = part[0].toUpperCase();
    const v = Number(part.slice(1));
    if (Number.isFinite(v)) tokens[c] = v;
  }
  return tokens;
}

// 解析刀路段：返回 {x1,y1,x2,y2,z,ext,type}
function parseGcode(text) {
  let x = 0, y = 0, z = 0, e = 0;
  let type = 'unknown';
  const segs = [];
  for (const raw of text.split(/\r?\n/)) {
    const tm = raw.match(/;TYPE:\s*(.+)/);
    if (tm) { type = tm[1].trim().toLowerCase(); continue; }
    const t = tokenize(raw);
    if (t.G === 0 || t.G === 1) {
      const nx = 'X' in t ? t.X : x;
      const ny = 'Y' in t ? t.Y : y;
      const nz = 'Z' in t ? t.Z : z;
      const ext = ('E' in t) && Math.abs(t.E - e) > 0;
      if ('X' in t || 'Y' in t) segs.push({ x1: x, y1: y, x2: nx, y2: ny, z: nz, ext, type });
      if ('E' in t) e = t.E;
      x = nx; y = ny; z = nz;
    } else if (t.G === 92) {
      if ('X' in t) x = t.X;
      if ('Y' in t) y = t.Y;
      if ('Z' in t) z = t.Z;
      if ('E' in t) e = t.E;
    }
  }
  return segs;
}

function colorFor(type, ext) {
  if (!ext) return [216, 216, 216]; // 空驶浅灰
  if (type.includes('skirt') || type.includes('brim')) return [255, 150, 40];   // 橙
  if (type.includes('perimeter')) return [232, 60, 50];                          // 红
  if (type.includes('solid') || type.includes('bridge') || type.includes('gap')) return [40, 180, 90]; // 绿
  if (type.includes('infill')) return [50, 120, 220];                            // 蓝
  if (type.includes('support')) return [172, 92, 220];                           // 紫
  return [60, 60, 72]; // 默认深灰
}

// ---------- PNG 编码（纯 Node，zlib + 手写 CRC32） ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngEncode(W, H, img) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = W * 3 + 1;
  const raw = Buffer.alloc(stride * H);
  for (let yy = 0; yy < H; yy++) {
    raw[yy * stride] = 0; // filter: none
    for (let xx = 0; xx < W * 3; xx++) raw[yy * stride + 1 + xx] = img[yy * W * 3 + xx];
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([len, tb, data, crc]);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function render(segs, size) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extSegs = segs.filter((s) => s.ext);
  const forBbox = extSegs.length > 0 ? extSegs : segs;
  for (const s of forBbox) {
    minX = Math.min(minX, s.x1, s.x2); maxX = Math.max(maxX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2); maxY = Math.max(maxY, s.y1, s.y2);
  }
  const w = maxX - minX, h = maxY - minY;
  const pad = Math.max(w, h) * 0.04 || 1;
  const scale = Math.min(size / (w + pad * 2), size / (h + pad * 2));
  const W = Math.max(1, Math.round((w + pad * 2) * scale));
  const H = Math.max(1, Math.round((h + pad * 2) * scale));
  const img = new Uint8Array(W * H * 3).fill(245); // 白底
  const px = (X) => Math.round((X - minX + pad) * scale);
  const py = (Y) => Math.round((Y - minY + pad) * scale); // 不翻转：文字/图案按「正读」方向显示

  for (const s of segs) {
    const [r, g, b] = colorFor(s.type, s.ext);
    const thick = s.ext ? 1 : 0;
    const x0 = px(s.x1), y0 = py(s.y1), x1 = px(s.x2), y1 = py(s.y2);
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) {
      for (let oy = -thick; oy <= thick; oy++) for (let ox = -thick; ox <= thick; ox++) {
        const xx = x0 + ox, yy = y0 + oy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) {
          const i = (yy * W + xx) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b;
        }
      }
      continue;
    }
    for (let i = 0; i <= steps; i++) {
      const cx = Math.round(x0 + (dx * i) / steps);
      const cy = Math.round(y0 + (dy * i) / steps);
      for (let oy = -thick; oy <= thick; oy++) for (let ox = -thick; ox <= thick; ox++) {
        const xx = cx + ox, yy = cy + oy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) {
          const idx = (yy * W + xx) * 3; img[idx] = r; img[idx + 1] = g; img[idx + 2] = b;
        }
      }
    }
  }
  return { W, H, img, bbox: { minX, minY, maxX, maxY } };
}

// ---------- 进程内入口（G-code 文本 -> PNG base64 + 统计） ----------
function renderGcode(text, size) {
  const segs = parseGcode(text);
  const ext = segs.filter((s) => s.ext).length;
  const travel = segs.length - ext;
  const { W, H, img, bbox } = render(segs, size || 1000);
  return {
    image: `${W}x${H}`,
    pngBase64: pngEncode(W, H, img).toString('base64'),
    segments: segs.length,
    extrusionSegments: ext,
    travelSegments: travel,
    bbox: { minX: +bbox.minX.toFixed(1), minY: +bbox.minY.toFixed(1), maxX: +bbox.maxX.toFixed(1), maxY: +bbox.maxY.toFixed(1) },
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) fail('用法: node gcode_render.cjs <file.gcode> [--out out.png] [--size 1000]');
    const text = fs.readFileSync(args.file, 'utf8');
    const segs = parseGcode(text);
    const ext = segs.filter((s) => s.ext).length;
    const travel = segs.length - ext;
    const { W, H, img, bbox } = render(segs, args.size);
    const out = args.out || (path.basename(args.file, path.extname(args.file)) + '.png');
    fs.writeFileSync(out, pngEncode(W, H, img));
    console.log(JSON.stringify({
      out,
      image: `${W}x${H}`,
      segments: segs.length,
      extrusionSegments: ext,
      travelSegments: travel,
      bbox: { minX: +bbox.minX.toFixed(1), minY: +bbox.minY.toFixed(1), maxX: +bbox.maxX.toFixed(1), maxY: +bbox.maxY.toFixed(1) },
    }, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseGcode, render, pngEncode, renderGcode };
