#!/usr/bin/env node
/**
 * image_to_stl.cjs — 图片 → 3D 模型 STL（零依赖核心，可选 sharp 增强）。
 *
 * 两种模式：
 *   extrude    剪影挤出：灰度二值化 → 抠出零件剪影 → 挤出成 2.5D 平板件（打印零件用）。
 *   lithophane 灰度浮雕：按灰度映射厚度，透光看就是照片（透光摆件用）。
 *
 * 图片解码优先级：sharp（若可加载，支持 JPEG/PNG/WebP 等）→ 纯 JS PNG 解码（零依赖回退）。
 *
 * CLI 用法:
 *   node image_to_stl.cjs --image a.jpg --mode extrude --width_mm 60 --depth_mm 5 --out a.stl
 *   node image_to_stl.cjs --image a.png --mode lithophane --width_mm 80 --out a.stl
 *
 * 程序化用法:
 *   const { generate } = require('./image_to_stl.cjs')
 *   const { stl, widthMm, heightMm, depthMm } = await generate({ imagePath, mode: 'extrude', width_mm: 60 })
 */
'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const { createRequire } = require('node:module');

function fail(msg) {
  throw new Error('image_to_stl: ' + msg);
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

const num = (v, dflt, min, label) => {
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isFinite(n) || n < min) fail(`${label} 必须是 >= ${min} 的数值`);
  return n;
};

// ---------- sharp 加载（可选，用于 JPEG/WebP 等） ----------
function loadSharp() {
  const dirs = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'app'));
  }
  dirs.push('C:/Program Files/DSH Desktop/resources/app');
  dirs.push('C:/Program Files (x86)/DSH Desktop/resources/app');
  for (const dir of dirs) {
    try {
      const req = createRequire(path.join(dir, 'package.json'));
      const s = req('sharp');
      if (s && typeof s === 'function') return s;
    } catch (_) {
      // 继续下一个候选
    }
  }
  try {
    return require('sharp');
  } catch (_) {
    return null;
  }
}

// ---------- PNG 解码（纯 JS，零依赖回退） ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.length < 8) fail('PNG 文件太小');
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) fail('不是 PNG 文件');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  let palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) fail(`只支持 8-bit PNG（当前 bitDepth=${bitDepth}）`);
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!width || !height) fail('PNG 缺少 IHDR');
  const bppMap = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  if (bpp === undefined) fail(`不支持的 PNG 颜色类型 ${colorType}`);
  if (colorType === 3 && !palette) fail('调色板 PNG 缺少 PLTE');

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch (e) {
    fail('PNG IDAT 解压失败');
  }

  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) fail(`不支持的 PNG filter ${filter}`);
      cur[x] = v;
    }
    out.set(cur, y * stride);
    prev = cur;
  }

  // 转灰度（0..255）
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    let r, g, b;
    if (colorType === 0) {
      r = g = b = out[i];
    } else if (colorType === 2) {
      const o = i * 3; r = out[o]; g = out[o + 1]; b = out[o + 2];
    } else if (colorType === 3) {
      const o = out[i] * 3; r = palette[o]; g = palette[o + 1]; b = palette[o + 2];
    } else if (colorType === 4) {
      r = g = b = out[i * 2];
    } else {
      const o = i * 4; r = out[o]; g = out[o + 1]; b = out[o + 2];
    }
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { width, height, gray };
}

// ---------- 灰度转换与降采样 ----------
function toGray(rgba) {
  const n = rgba.length / 4;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return gray;
}

function downsampleGray(gray, w, h, maxDim) {
  if (Math.max(w, h) <= maxDim) return { width: w, height: h, gray };
  const scale = maxDim / Math.max(w, h);
  const nw = Math.max(2, Math.round(w * scale));
  const nh = Math.max(2, Math.round(h * scale));
  const out = new Float32Array(nw * nh);
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nw; i++) {
      const x0 = Math.floor(i * w / nw), x1 = Math.max(x0 + 1, Math.floor((i + 1) * w / nw));
      const y0 = Math.floor(j * h / nh), y1 = Math.max(y0 + 1, Math.floor((j + 1) * h / nh));
      let sum = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += gray[y * w + x]; cnt++; }
      out[j * nw + i] = cnt ? sum / cnt : 0;
    }
  }
  return { width: nw, height: nh, gray: out };
}

// Otsu 自动阈值：在双峰灰度直方图上找前景/背景最佳分界（适合零件截图/剪影）。
function otsuThreshold(gray, W, H) {
  const hist = new Float64Array(256);
  const n = W * H;
  for (let i = 0; i < n; i++) {
    const v = Math.min(255, Math.max(0, Math.round(gray[i])));
    hist[v]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, best = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; best = t; }
  }
  return best;
}

// ---------- 高度场 / 二值掩码 ----------
function extrudeMask(gray, W, H, threshold, invert) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    mask[i] = invert ? (gray[i] <= threshold ? 1 : 0) : (gray[i] >= threshold ? 1 : 0);
  }
  return mask;
}

function lithophaneHeights(gray, W, H, minT, maxT, invert) {
  const z = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let v = gray[i] / 255;
    if (invert) v = 1 - v;
    z[i] = minT + (1 - v) * (maxT - minT);
  }
  return z;
}

// ---------- STL 网格 ----------
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function normalize(a) { const n = Math.hypot(a[0],a[1],a[2]); return n === 0 ? [0,0,0] : [a[0]/n, a[1]/n, a[2]/n]; }

function emit(solid, a, b, c) {
  const u = sub(b, a), v = sub(c, a);
  const n = normalize(cross(u, v));
  solid.push(`  facet normal ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
  solid.push('    outer loop');
  for (const p of [a, b, c]) solid.push(`      vertex ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
  solid.push('    endloop');
  solid.push('  endfacet');
}

// 高度场 → 水密 STL：顶面（起伏）+ 底面（平）+ 四条侧壁。
function heightMapToStl(solid, W, H, z, px, py) {
  const at = (i, j, zz) => [i * px, j * py, zz];
  // 顶面（向上）
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = at(i, j, z[j * W + i]);
      const b = at(i + 1, j, z[j * W + i + 1]);
      const c = at(i, j + 1, z[(j + 1) * W + i]);
      const d = at(i + 1, j + 1, z[(j + 1) * W + i + 1]);
      emit(solid, a, b, c);
      emit(solid, b, d, c);
    }
  }
  // 底面（向下）
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = at(i, j, 0);
      const b = at(i + 1, j, 0);
      const c = at(i, j + 1, 0);
      const d = at(i + 1, j + 1, 0);
      emit(solid, a, c, b);
      emit(solid, b, c, d);
    }
  }
  // 左壁 j=0（朝 -y）
  for (let i = 0; i < W - 1; i++) {
    const a = at(i, 0, z[i]);
    const b = at(i + 1, 0, z[i + 1]);
    const c = at(i, 0, 0);
    const d = at(i + 1, 0, 0);
    emit(solid, a, c, b);
    emit(solid, b, c, d);
  }
  // 右壁 j=H-1（朝 +y）
  for (let i = 0; i < W - 1; i++) {
    const a = at(i, H - 1, z[(H - 1) * W + i]);
    const b = at(i + 1, H - 1, z[(H - 1) * W + i + 1]);
    const c = at(i, H - 1, 0);
    const d = at(i + 1, H - 1, 0);
    emit(solid, a, b, c);
    emit(solid, b, d, c);
  }
  // 前壁 i=0（朝 -x）
  for (let j = 0; j < H - 1; j++) {
    const a = at(0, j, z[j * W]);
    const b = at(0, j + 1, z[(j + 1) * W]);
    const c = at(0, j, 0);
    const d = at(0, j + 1, 0);
    emit(solid, a, b, c);
    emit(solid, b, d, c);
  }
  // 后壁 i=W-1（朝 +x）
  for (let j = 0; j < H - 1; j++) {
    const a = at(W - 1, j, z[j * W + W - 1]);
    const b = at(W - 1, j + 1, z[(j + 1) * W + W - 1]);
    const c = at(W - 1, j, 0);
    const d = at(W - 1, j + 1, 0);
    emit(solid, a, c, b);
    emit(solid, b, c, d);
  }
}

// 二值剪影 → 柱状挤出（竖直侧壁，水密且流形）。
// 每个内部像素是一根 z∈[0,depth] 的竖柱；侧壁只在「相邻像素是外部/越界」处生成，避免相邻柱之间产生重合面。
function binaryExtrudeToStl(solid, W, H, mask, px, py, depth) {
  const v = (i, j, z) => [i * px, j * py, z];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!mask[j * W + i]) continue;
      // 8 个角点（沿用 box 的编号约定）
      const c = [
        v(i, j, 0),         // 0 min-x,min-y,bottom
        v(i + 1, j, 0),     // 1 max-x,min-y,bottom
        v(i + 1, j + 1, 0), // 2 max-x,max-y,bottom
        v(i, j + 1, 0),     // 3 min-x,max-y,bottom
        v(i, j, depth),         // 4 min-x,min-y,top
        v(i + 1, j, depth),     // 5 max-x,min-y,top
        v(i + 1, j + 1, depth), // 6 max-x,max-y,top
        v(i, j + 1, depth),     // 7 min-x,max-y,top
      ];
      // 底面（朝 -z）
      emit(solid, c[0], c[1], c[2]);
      emit(solid, c[0], c[2], c[3]);
      // 顶面（朝 +z）
      emit(solid, c[4], c[6], c[5]);
      emit(solid, c[4], c[7], c[6]);
      // 前（-y，j 下沿）：相邻下侧像素为外部时
      if (j === 0 || !mask[(j - 1) * W + i]) {
        emit(solid, c[0], c[4], c[5]);
        emit(solid, c[0], c[5], c[1]);
      }
      // 右（+x，i 上沿）
      if (i === W - 1 || !mask[j * W + i + 1]) {
        emit(solid, c[1], c[5], c[6]);
        emit(solid, c[1], c[6], c[2]);
      }
      // 后（+y，j 上沿）
      if (j === H - 1 || !mask[(j + 1) * W + i]) {
        emit(solid, c[2], c[6], c[7]);
        emit(solid, c[2], c[7], c[3]);
      }
      // 左（-x，i 下沿）
      if (i === 0 || !mask[j * W + i - 1]) {
        emit(solid, c[3], c[7], c[4]);
        emit(solid, c[3], c[4], c[0]);
      }
    }
  }
}

// ---------- 图片解码（sharp 优先，PNG 回退） ----------
async function decodeImage(filePath, maxPixels) {
  const sharp = loadSharp();
  if (sharp) {
    try {
      const { data, info } = await sharp(filePath)
        .resize(maxPixels, maxPixels, { fit: 'inside', withoutEnlargement: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const gray = toGray(data);
      return { width: info.width, height: info.height, gray, decoder: 'sharp' };
    } catch (_) {
      // 落到 PNG 回退
    }
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    const png = decodePng(buf);
    const down = downsampleGray(png.gray, png.width, png.height, maxPixels);
    return { width: down.width, height: down.height, gray: down.gray, decoder: 'png' };
  }
  fail('无法解码图片：需要 JPEG/PNG/WebP（sharp 可用时），或 PNG（纯 JS 回退）。请确认路径正确。');
}

// ---------- 主入口（异步） ----------
async function generate(params) {
  const imagePath = params.imagePath || params.image_path;
  if (!imagePath) fail('缺少 imagePath');
  const mode = params.mode === 'lithophane' ? 'lithophane' : 'extrude';
  const maxPixels = Math.round(num(params.max_pixels, 150, 16, 'max_pixels'));

  const { width: W, height: H, gray, decoder } = await decodeImage(imagePath, maxPixels);

  const widthMm = num(params.width_mm, 60, 1, 'width_mm');
  const solid = [`solid ${mode}`];
  let depthMm, widthOut, heightOut, thresholdUsed;

  if (mode === 'lithophane') {
    const px = widthMm / (W - 1);
    const minT = num(params.min_thickness_mm, 0.8, 0.2, 'min_thickness_mm');
    const maxT = num(params.max_thickness_mm, 2.5, minT + 0.2, 'max_thickness_mm');
    const z = lithophaneHeights(gray, W, H, minT, maxT, !!params.invert);
    heightMapToStl(solid, W, H, z, px, px);
    depthMm = maxT;
    widthOut = (W - 1) * px;
    heightOut = (H - 1) * px;
  } else {
    const px = widthMm / W;
    const depth = num(params.depth_mm, 5, 0.2, 'depth_mm');
    const thresh = params.threshold === undefined
      ? otsuThreshold(gray, W, H)
      : num(params.threshold, 128, 0, 'threshold');
    const mask = extrudeMask(gray, W, H, thresh, !!params.invert);
    binaryExtrudeToStl(solid, W, H, mask, px, px, depth);
    depthMm = depth;
    widthOut = W * px;
    heightOut = H * px;
    thresholdUsed = thresh;
  }

  solid.push(`endsolid ${mode}`);
  const stl = solid.join('\n') + '\n';

  return {
    mode,
    stl,
    decoder,
    widthPx: W,
    heightPx: H,
    widthMm: widthOut,
    heightMm: heightOut,
    depthMm,
    threshold: thresholdUsed,
    sizeBytes: Buffer.byteLength(stl, 'utf8'),
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.image) fail('缺少 --image <图片路径>');
    const result = await generate({ ...args, imagePath: args.image });
    const out = args.out || 'image.stl';
    fs.writeFileSync(out, result.stl, 'utf8');
    console.log(
      `已生成 ${out}（${result.mode}，${result.widthMm.toFixed(1)}×${result.heightMm.toFixed(1)}mm，高 ${result.depthMm}mm，` +
      `${result.widthPx}×${result.heightPx}px，${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB，解码=${result.decoder}）`
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { generate, decodePng, heightMapToStl, binaryExtrudeToStl, downsampleGray, toGray, otsuThreshold, extrudeMask, decodeImage };
