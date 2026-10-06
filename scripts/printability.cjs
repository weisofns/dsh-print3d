#!/usr/bin/env node
/**
 * printability.cjs — 可打印性预检（零依赖）。
 *
 * 回答的不是「这模型多大」，而是「这模型能不能打、该怎么摆」：
 *   1. 悬垂角度分档（按面积）—— 判断要多少支撑
 *   2. 建议打印方向 —— 试 6 个「面朝下」朝向，选悬垂面积最小的那个
 *   3. 床尺寸、翻倒风险、层数、耗材量估算
 *
 * 已知不覆盖：壁厚分析（需要距离场，本模块不做）。壁厚要靠切片后看刀路简图。
 *
 * CLI:
 *   node printability.cjs <model.stl> [--bed 200x200x180] [--layer 0.2] [--extrusion 0.45]
 */
'use strict';

const fs = require('node:fs');
const { parseAscii, parseBinary } = require('./stl_analyze.cjs');

function fail(m) { throw new Error('printability: ' + m); }

function loadTriangles(file) {
  if (!file || !fs.existsSync(file)) fail('STL 不存在：' + file);
  const buf = fs.readFileSync(file);
  const head = buf.subarray(0, 5).toString('ascii').toLowerCase();
  if (head === 'solid') return parseAscii(buf.toString('utf8')).triangles;
  return parseBinary(buf).triangles;
}

function rotPoint([x, y, z], axis, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  if (axis === 'x') return [x, y * c - z * s, y * s + z * c];
  if (axis === 'y') return [x * c + z * s, y, -x * s + z * c];
  return [x * c - y * s, x * s + y * c, z];
}

// 6 个「让某个面朝下」的正交朝向
const ORIENTATIONS = [
  { name: '原朝向', ops: [] },
  { name: '绕X +90°', ops: [['x', 90]] },
  { name: '绕X -90°', ops: [['x', -90]] },
  { name: '绕X 180°', ops: [['x', 180]] },
  { name: '绕Y +90°', ops: [['y', 90]] },
  { name: '绕Y -90°', ops: [['y', -90]] },
];

const applyOps = (p, ops) => ops.reduce((q, [ax, d]) => rotPoint(q, ax, d), p);

// 悬垂分档（用单位法线的 z 分量）：|nz| 越大表示该面越接近水平
const SEVERE = Math.cos((45 * Math.PI) / 180); // >0.707 → 与水平夹角<45°，必然要支撑
const WARN = Math.cos((60 * Math.PI) / 180);   // >0.5   → 45~60°，通常也要

// 有符号体积判断模型法线朝向：<0 表示绕序反转（法线朝内）。
// 自造 STL 常见 inside-out —— 切片器能自动修复所以不影响打印，但任何依赖
// 法线方向的分析（悬垂）会被整体带反，必须先归一化。
function orientationSign(tris) {
  let v6 = 0;
  for (const [a, b, c] of tris) {
    v6 += a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v6 < 0 ? -1 : 1; // -1 = 法线朝内，取反后才是真实的朝外法线
}

function evaluate(tris, ops, sign = 1) {
  // 第一趟：旋转全部顶点并求包围盒 —— 悬垂判定得先知道「床面在哪个 z」
  const rot = tris.map((tri) => [applyOps(tri[0], ops), applyOps(tri[1], ops), applyOps(tri[2], ops)]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of rot) {
    for (const v of p) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }

  // 第二趟：悬垂分档。整面贴在床面的底面 **不算** 悬垂 —— 它就在床上。
  // 少了这一步，任何平底零件（含等截面挤出件）都会被误判成大面积悬垂。
  const eps = Math.max(1e-6, (maxZ - minZ) * 1e-4);
  let totalArea = 0, severe = 0, warn = 0, mild = 0, overhang = 0;
  for (const [p0, p1, p2] of rot) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const area = len / 2;
    totalArea += area;

    const nzUnit = (nz / len) * sign; // 归一化到「朝外为正」
    const onBed = p0[2] <= minZ + eps && p1[2] <= minZ + eps && p2[2] <= minZ + eps;
    if (!onBed && nzUnit < 0) {
      const down = -nzUnit; // 0..1，越大越接近水平朝下
      if (down > SEVERE) { severe += area; overhang += area; }
      else if (down > WARN) { warn += area; overhang += area; }
      else mild += area;
    }
  }

  return {
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    height: maxZ - minZ,
    footprint: (maxX - minX) * (maxY - minY),
    totalArea, overhang, severe, warn, mild,
    overhangRatio: totalArea > 0 ? overhang / totalArea : 0,
  };
}

function checkStability(ev) {
  const shortSide = Math.min(ev.size.x, ev.size.y);
  if (shortSide <= 0) return { risk: 'unknown', note: '' };
  const ratio = ev.height / shortSide;
  if (ratio >= 5) return { risk: 'high', ratio, note: `高细比 ${ratio.toFixed(1)}:1，打印中极易晃动或被喷头带倒，建议放倒或加底边` };
  if (ratio >= 3) return { risk: 'medium', ratio, note: `高细比 ${ratio.toFixed(1)}:1，建议加底边(brim)` };
  return { risk: 'low', ratio, note: '' };
}

function checkBed(ev, bed) {
  const over = [];
  if (ev.size.x > bed.x) over.push(`X ${ev.size.x.toFixed(1)} > ${bed.x}`);
  if (ev.size.y > bed.y) over.push(`Y ${ev.size.y.toFixed(1)} > ${bed.y}`);
  if (ev.size.z > bed.z) over.push(`Z ${ev.size.z.toFixed(1)} > ${bed.z}`);
  return over;
}

function check(tris, opts = {}) {
  if (!tris.length) fail('STL 里没有三角面。');
  const bed = opts.bed || { x: 200, y: 200, z: 180 };
  const layerHeight = opts.layer_height || 0.2;
  const extrusion = opts.extrusion || 0.45;

  const sign = orientationSign(tris);
  const results = ORIENTATIONS.map((o) => ({ name: o.name, ...evaluate(tris, o.ops, sign) }));
  // 主排序：悬垂面积占比；并列时选更矮的（更稳、更快）
  const best = [...results].sort((a, b) => (a.overhangRatio - b.overhangRatio) || (a.height - b.height))[0];
  const base = results[0];

  // 体积（用有符号四面体体积，需水密；不水密时仅作参考）
  let volume = 0;
  for (const tri of tris) {
    const [a, b, c] = tri;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  volume = Math.abs(volume);

  const layers = Math.max(1, Math.round(best.height / layerHeight));
  const filamentMM = volume > 0 ? volume / (Math.PI * (1.75 / 2) ** 2) : 0;
  const grams = (volume / 1000) * 1.24;

  return {
    triangles: tris.length,
    volume,
    filamentMeters: filamentMM / 1000,
    grams,
    layerHeight,
    layers,
    extrusion,
    base: { name: base.name, size: base.size, height: base.height, overhangRatio: base.overhangRatio, severe: base.severe, warn: base.warn },
    best: { name: best.name, size: best.size, height: best.height, overhangRatio: best.overhangRatio, severe: best.severe, warn: best.warn, footprint: best.footprint },
    orientations: results.map((r) => ({ name: r.name, height: r.height, overhangRatio: r.overhangRatio, severe: r.severe, warn: r.warn })),
    stability: checkStability(best),
    bedOverflow: checkBed(best, bed),
    bed,
  };
}

// 按指定朝向重排模型：旋转 → 落到床面(z=0) → XY 居中，输出新的 ASCII STL。
// 这是「按推荐朝向打印」的落点 —— 同一个零件换个朝向，悬垂量可能差好几倍。
function orientedStl(tris, ops, name = 'oriented') {
  const rot = tris.map((t) => t.map((v) => applyOps(v, ops)));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
  for (const t of rot) {
    for (const v of t) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2];
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const out = [`solid ${name}`];
  for (const t of rot) {
    const p = t.map((v) => [v[0] - cx, v[1] - cy, v[2] - minZ]);
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    out.push(`  facet normal ${(nx / len).toFixed(6)} ${(ny / len).toFixed(6)} ${(nz / len).toFixed(6)}`);
    out.push('    outer loop');
    for (const v of p) out.push(`      vertex ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}`);
    out.push('    endloop');
    out.push('  endfacet');
  }
  out.push(`endsolid ${name}`);
  return out.join('\n') + '\n';
}

// 按名字取朝向的旋转操作（供工具按用户指定朝向对齐）
function opsForOrientation(name) {
  const hit = ORIENTATIONS.find((o) => o.name === name);
  return hit ? hit.ops : null;
}

function parseArgs(argv) {
  const a = { size: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--bed') a.bed = argv[++i];
    else if (x === '--layer') a.layer = Number(argv[++i]);
    else if (x === '--extrusion') a.extrusion = Number(argv[++i]);
    else if (!a.file) a.file = x;
  }
  return a;
}

function main() {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (!a.file) fail('用法: node printability.cjs <model.stl> [--bed 200x200x180] [--layer 0.2]');
    let bed;
    if (a.bed) {
      const [x, y, z] = a.bed.split('x').map(Number);
      bed = { x, y, z };
    }
    const r = check(loadTriangles(a.file), { bed, layer_height: a.layer, extrusion: a.extrusion });
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { check, loadTriangles, evaluate, ORIENTATIONS, orientationSign, orientedStl, opsForOrientation };
