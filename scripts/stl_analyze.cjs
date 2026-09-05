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
function parseBinary(buf) {
  const count = buf.readUInt32LE(80);
  const triangles = [];
  let off = 84;
  for (let i = 0; i < count; i++) {
    const v = [];
    for (let k = 0; k < 3; k++) {
      v.push([buf.readFloatLE(off), buf.readFloatLE(off + 4), buf.readFloatLE(off + 8)]);
      off += 12;
    }
    off += 2; // attribute byte count
    triangles.push(v);
  }
  return { format: 'binary', triangles };
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
function analyze(triangles) {
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

    // 悬垂：面法线向下分量超过 cos(45°) ≈ 0.707，即与水平面夹角大于 45°
    if (n[2] < -Math.SQRT1_2) overhangArea += area;
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
    let parsed;
    if (buf.length >= 84 && buf.toString('latin1', 0, 5).toLowerCase() === 'solid') {
      parsed = parseAscii(buf.toString('utf8'));
    } else {
      parsed = parseBinary(buf);
    }
    if (parsed.triangles.length === 0) fail('未解析到任何三角面（文件可能不是有效 STL）');
    const result = { file: path.basename(file), format: parsed.format, ...analyze(parsed.triangles) };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseBinary, parseAscii, analyze, analyzeStlText };
