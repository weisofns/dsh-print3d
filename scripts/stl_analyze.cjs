#!/usr/bin/env node
/**
 * stl_analyze.cjs — 零依赖 STL 分析器（ASCII + 二进制）。
 *
 * CLI 用法:
 *   node stl_analyze.cjs <file.stl>
 *
 * 程序化用法（供插件工具进程内调用）:
 *   const { analyzeStlText } = require('./stl_analyze.cjs')
 *   analyzeStlText(asciiText) -> { format, triangles, bounds, volume, ... }
 *
 * 输出: 单个 JSON 对象，包含包围盒、三角面数、体积、表面积、悬垂比例、
 *       非流形边统计等。体积只在模型水密（无洞）时有物理意义。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(msg) {
  throw new Error('stl_analyze: ' + msg);
}

// ---------- 向量运算 ----------
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function norm(a) {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a) {
  const n = norm(a);
  return n === 0 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
}

// ---------- 二进制 STL 解析 ----------
// 二进制 STL 每条 facet 记录固定 50 字节：
//   [0,12) 法线   [12,48) 三个顶点   [48,50) 属性字节数
// 法线必须显式跳过。少了这一步，每条记录只前进 38 字节，从第 2 个面起
// 全部读到错误的字节偏移上 —— 读出来的是随机 bit 模式（常见 NaN/Inf），
// 体积随之算出 NaN，工具结果就不是合法 JSON 了。
const BINARY_FACET_SIZE = 50;

function parseBinary(buf) {
  if (buf.length < 84) fail('文件不足 84 字节，不是有效二进制 STL');
  const count = buf.readUInt32LE(80);
  const need = 84 + count * BINARY_FACET_SIZE;
  if (need > buf.length) {
    fail('二进制 STL 声明 ' + count + ' 个三角面（需要 ' + need + ' 字节），文件只有 ' + buf.length + ' 字节，已截断');
  }
  const triangles = [];
  let off = 84;
  for (let i = 0; i < count; i++) {
    off += 12; // 跳过 facet normal（本模块一律用顶点重算法线，文件里的 normals 不参与分析）
    const v = [];
    for (let k = 0; k < 3; k++) {
      const p = [buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8)];
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
        fail('第 ' + (i + 1) + ' 个三角面的顶点含非有限值（NaN/Inf），STL 数据已损坏');
      }
      v.push(p);
      off += 12;
    }
    off += 2; // attribute byte count
    triangles.push(v);
  }
  return { format: 'binary', triangles };
}

// 二进制 / ASCII 判定：优先看「字节数是否恰好等于 84 + 50*面数」—— 这是二进制 STL
// 的硬约束，比只看开头 5 字节是否 'solid' 可靠（大量二进制 STL 的 80 字节头写的就是
// 'solid xxx'，按 ASCII 解析会一个面都读不出来）。
function looksBinary(buf) {
  if (buf.length < 84) return false;
  const count = buf.readUInt32LE(80);
  return buf.length === 84 + count * BINARY_FACET_SIZE;
}

function parseStlBuffer(buf) {
  return looksBinary(buf) ? parseBinary(buf) : parseAscii(buf.toString('utf8'));
}

// ---------- ASCII STL 解析 ----------
function parseAscii(text) {
  const lines = text.split(/\r?\n/);
  const triangles = [];
  let current = null;
  for (let line of lines) {
    line = line.trim();
    if (line === '' || line.startsWith('solid') || line.startsWith('endsolid')) continue;
    if (line.startsWith('facet')) {
      current = [];
    } else if (line.startsWith('vertex')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)) current.push(parts);
    } else if (line.startsWith('endfacet')) {
      if (current && current.length === 3) triangles.push(current);
      current = null;
    }
  }
  return { format: 'ascii', triangles };
}

// ---------- 几何分析 ----------
// 有符号体积定向：水密 + 绕序一致的网格，朝外绕序的 ∮ 恒为正（散度定理，
// 与原点位置无关）；为负说明整个网格绕序朝内（自造/导出 STL 很常见）。
// 只依赖法线方向的分析（悬垂）必须先用它归一化，否则结果整体带反。
function orientationSign(triangles) {
  let v6 = 0;
  for (const [a, b, c] of triangles) {
    v6 += a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v6 < 0 ? -1 : 1; // -1 = 绕序朝内，法线要取反后才是真实朝外方向
}

function analyze(triangles) {
  const sign = orientationSign(triangles);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  let surfaceArea = 0;
  let overhangArea = 0;

  const edgeCount = new Map(); // "i<j" -> count
  const key = (a, b) => (a < b ? a + '<' + b : b + '<' + a);

  for (const tri of triangles) {
    const [a, b, c] = tri;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], a[k], b[k], c[k]);
      max[k] = Math.max(max[k], a[k], b[k], c[k]);
    }
    // 有符号四面体体积（水密时为正）
    volume += dot(a, cross(b, c)) / 6;

    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const n = normalize(cross(e1, e2));
    const area = norm(cross(e1, e2)) / 2;
    surfaceArea += area;

    // 悬垂：真实朝外法线的向下分量超过 cos(45°) ≈ 0.707（与水平面夹角大于 45°）。
    // 乘 sign 是为了对「绕序朝内」的 STL 免疫 —— 否则朝内模型的悬垂统计会整体反转。
    if (n[2] * sign < -Math.SQRT1_2) overhangArea += area;
  }

  // 用顶点坐标对边去重（同一顶点不同三角形实例坐标相同）
  const verts = [];
  const vkey = (v) => v[0].toFixed(6) + ',' + v[1].toFixed(6) + ',' + v[2].toFixed(6);
  const vmap = new Map();
  function vid(v) {
    const k = vkey(v);
    if (!vmap.has(k)) {
      vmap.set(k, verts.length);
      verts.push(v);
    }
    return vmap.get(k);
  }
  for (const tri of triangles) {
    const ia = vid(tri[0]);
    const ib = vid(tri[1]);
    const ic = vid(tri[2]);
    for (const [x, y] of [[ia, ib], [ib, ic], [ic, ia]]) {
      const k = key(x, y);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const n of edgeCount.values()) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
  }

  return {
    triangles: triangles.length,
    uniqueVertices: verts.length,
    bounds: {
      min: min.map((x) => +x.toFixed(4)),
      max: max.map((x) => +x.toFixed(4)),
      size: sub(max, min).map((x) => +x.toFixed(4)),
    },
    volume: +Math.abs(volume).toFixed(4),
    // true = 该 STL 绕序朝内（法线指向模型内部）。体积/水密性不受影响，
    // 但下游软件里按法线渲染/判悬垂会反，切片器通常会自动修复。
    normalsInverted: sign < 0,
    surfaceArea: +surfaceArea.toFixed(4),
    overhangArea: +overhangArea.toFixed(4),
    overhangRatio: +(surfaceArea > 0 ? overhangArea / surfaceArea : 0).toFixed(4),
    boundaryEdges,
    nonManifoldEdges,
    watertight: boundaryEdges === 0,
  };
}

// ---------- 进程内入口（ASCII STL 文本 -> 分析结果） ----------
function analyzeStlText(text) {
  const parsed = parseAscii(text);
  if (parsed.triangles.length === 0) {
    throw new Error('stl_analyze: 未解析到任何三角面（内容可能不是有效 ASCII STL）');
  }
  return { format: parsed.format, ...analyze(parsed.triangles) };
}

// ---------- CLI 主流程 ----------
function main() {
  try {
    const file = process.argv[2];
    if (!file) fail('用法: node stl_analyze.cjs <file.stl>');
    const buf = fs.readFileSync(file);
    const parsed = parseStlBuffer(buf);
    if (parsed.triangles.length === 0) fail('未解析到任何三角面（文件可能不是有效 STL）');
    const result = { file: path.basename(file), format: parsed.format, ...analyze(parsed.triangles) };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseBinary, parseAscii, parseStlBuffer, looksBinary, analyze, analyzeStlText, orientationSign };
