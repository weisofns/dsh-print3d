#!/usr/bin/env node
/**
 * gen_parametric_stl.cjs — 零依赖参数化 STL 生成器（ASCII STL）。
 *
 * CLI 用法:
 *   node gen_parametric_stl.cjs --shape box      --x 20 --y 20 --z 10 --out box.stl
 *   node gen_parametric_stl.cjs --shape cylinder --d 20 --h 30 --segments 64 --out cyl.stl
 *   node gen_parametric_stl.cjs --shape tube     --d 20 --id 6 --h 30 --segments 64 --out tube.stl
 *   node gen_parametric_stl.cjs --shape sphere   --d 20 --segments 32 --out sphere.stl
 *   node gen_parametric_stl.cjs --list
 *
 * 程序化用法:
 *   const { generate } = require('./gen_parametric_stl.cjs')
 *   generate({ shape: 'box', x: 20, y: 20, z: 10 }) -> { shape, stl, sizeBytes }
 */
'use strict';

const fs = require('node:fs');

function fail(msg) {
  throw new Error('gen_parametric_stl: ' + msg);
}

function parseArgs(argv) {
  const args = {};
  const flags = new Set(['--list']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { args[a.slice(2)] = true; continue; }
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

// ---------- 三角面发射 ----------
function emit(solid, a, b, c) {
  const u = sub(b, a), v = sub(c, a);
  const n = normalize(cross(u, v));
  solid.push(`  facet normal ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
  solid.push('    outer loop');
  for (const p of [a, b, c]) solid.push(`      vertex ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
  solid.push('    endloop');
  solid.push('  endfacet');
}

// ---------- 向量 ----------
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function normalize(a) { const n = Math.hypot(a[0],a[1],a[2]); return n === 0 ? [0,0,0] : [a[0]/n, a[1]/n, a[2]/n]; }

function ring(radius, z, segments) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push([Math.cos(t) * radius, Math.sin(t) * radius, z]);
  }
  return pts;
}

// 圆盘（fan），normal 决定向上(+z)还是向下(-z)
function disc(solid, center, rim, up) {
  for (let i = 0; i < rim.length; i++) {
    const a = rim[i], b = rim[(i + 1) % rim.length];
    up ? emit(solid, center, a, b) : emit(solid, center, b, a);
  }
}

function box(solid, X, Y, Z) {
  const x = X / 2, y = Y / 2;
  const v = [
    [-x,-y,0],[ x,-y,0],[ x, y,0],[-x, y,0], // 底面
    [-x,-y,Z],[ x,-y,Z],[ x, y,Z],[-x, y,Z], // 顶面
  ];
  const f = [
    [0,1,2],[0,2,3],   // 底 (向下)
    [4,6,5],[4,7,6],   // 顶 (向上)
    [0,4,5],[0,5,1],   // 前
    [1,5,6],[1,6,2],   // 右
    [2,6,7],[2,7,3],   // 后
    [3,7,4],[3,4,0],   // 左
  ];
  for (const [a,b,c] of f) emit(solid, v[a], v[b], v[c]);
}

function cylinder(solid, r, h, seg) {
  const bot = ring(r, 0, seg);
  const top = ring(r, h, seg);
  disc(solid, [0,0,0], bot, false); // 底向下
  disc(solid, [0,0,h], top, true);  // 顶向上
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    emit(solid, bot[i], bot[j], top[i]);
    emit(solid, bot[j], top[j], top[i]);
  }
}

function tube(solid, ro, ri, h, seg) {
  const ob = ring(ro, 0, seg), ot = ring(ro, h, seg);
  const ib = ring(ri, 0, seg), it = ring(ri, h, seg);
  // 底面环形（外向下、内向下）
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    emit(solid, ob[i], ob[j], ib[i]);
    emit(solid, ob[j], ib[j], ib[i]);
    emit(solid, ib[i], ib[j], it[j]);  // 内壁
    emit(solid, ib[i], it[j], it[i]);
  }
  // 顶面环形
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    emit(solid, ot[i], it[i], ot[j]);
    emit(solid, ot[j], it[i], it[j]);
  }
  // 外壁
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    emit(solid, ob[i], ot[i], ob[j]);
    emit(solid, ob[j], ot[i], ot[j]);
  }
}

function sphere(solid, r, seg) {
  const lat = Math.max(6, Math.floor(seg / 2));
  const pts = [];
  for (let i = 0; i <= lat; i++) {
    const phi = (i / lat) * Math.PI; // 0..π
    pts.push([]);
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      pts[i].push([
        r * Math.sin(phi) * Math.cos(th),
        r * Math.sin(phi) * Math.sin(th),
        r * Math.cos(phi),
      ]);
    }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      const a = pts[i][j], b = pts[i][k], c = pts[i+1][j], d = pts[i+1][k];
      emit(solid, a, b, c);
      emit(solid, b, d, c);
    }
  }
}

function cone(solid, r1, r2, h, seg) {
  const bot = ring(r1, 0, seg);
  const top = ring(r2, h, seg);
  if (r1 > 0) disc(solid, [0, 0, 0], bot, false);
  if (r2 > 0) disc(solid, [0, 0, h], top, true);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    emit(solid, bot[i], bot[j], top[i]);
    if (r2 > 0) emit(solid, bot[j], top[j], top[i]);
  }
}

function roundedRectOutline(X, Y, r, n) {
  const x = X / 2 - r, y = Y / 2 - r;
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let k = 0; k <= n; k++) {
      const a = a0 + (a1 - a0) * (k / n);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(x, y, 0, Math.PI / 2);                 // 右上
  arc(-x, y, Math.PI / 2, Math.PI);          // 左上
  arc(-x, -y, Math.PI, 3 * Math.PI / 2);     // 左下
  arc(x, -y, 3 * Math.PI / 2, 2 * Math.PI);  // 右下
  return pts;
}

function roundedBox(solid, X, Y, Z, r, seg) {
  const n = Math.max(2, Math.round(seg / 4));
  const pts2d = roundedRectOutline(X, Y, r, n);
  const bot = pts2d.map((p) => [p[0], p[1], 0]);
  const top = pts2d.map((p) => [p[0], p[1], Z]);
  disc(solid, [0, 0, 0], bot, false);
  disc(solid, [0, 0, Z], top, true);
  const N = bot.length;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    emit(solid, bot[i], bot[j], top[i]);
    emit(solid, bot[j], top[j], top[i]);
  }
}

function gear(solid, teeth, module, thickness, bore, seg) {
  const rp = module * teeth / 2;
  const ra = rp + module;
  const rr = rp - 1.25 * module;
  const pitch = 2 * Math.PI / teeth;
  const tipHalf = pitch * 0.25;
  const baseHalf = pitch * 0.5;
  const M = Math.max(24, teeth * 8, Math.round(seg));

  // 梯形齿廓：齿顶(ra) / 斜边 / 齿根(rr)
  function gearR(a) {
    let la = a % pitch;
    if (la < 0) la += pitch;
    if (la > pitch / 2) la = pitch - la;
    if (la <= tipHalf) return ra;
    if (la <= baseHalf) return ra + (rr - ra) * (la - tipHalf) / (baseHalf - tipHalf);
    return rr;
  }

  const ob = [], ot = [];
  for (let j = 0; j < M; j++) {
    const a = (j / M) * 2 * Math.PI;
    const R = gearR(a);
    ob.push([R * Math.cos(a), R * Math.sin(a), 0]);
    ot.push([R * Math.cos(a), R * Math.sin(a), thickness]);
  }

  if (bore > 0) {
    const br = bore / 2;
    const ib = [], it = [];
    for (let j = 0; j < M; j++) {
      const a = (j / M) * 2 * Math.PI;
      ib.push([br * Math.cos(a), br * Math.sin(a), 0]);
      it.push([br * Math.cos(a), br * Math.sin(a), thickness]);
    }
    for (let i = 0; i < M; i++) {
      const j = (i + 1) % M;
      emit(solid, ob[i], ob[j], ib[i]);
      emit(solid, ob[j], ib[j], ib[i]);
      emit(solid, ib[i], ib[j], it[j]);
      emit(solid, ib[i], it[j], it[i]);
    }
    for (let i = 0; i < M; i++) {
      const j = (i + 1) % M;
      emit(solid, ot[i], it[i], ot[j]);
      emit(solid, ot[j], it[i], it[j]);
    }
  } else {
    disc(solid, [0, 0, 0], ob, false);
    disc(solid, [0, 0, thickness], ot, true);
  }

  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    emit(solid, ob[i], ot[i], ob[j]);
    emit(solid, ob[j], ot[i], ot[j]);
  }
}

const SHAPES = {
  box: { args: ['x','y','z'], desc: '长方体（居中，底面 z=0）' },
  cylinder: { args: ['d','h','segments'], desc: '圆柱（轴沿 Z）' },
  tube: { args: ['d','id','h','segments'], desc: '圆管（外径 d，内径 id）' },
  sphere: { args: ['d','segments'], desc: '球体' },
  cone: { args: ['d1','d2','h','segments'], desc: '圆台/圆锥（d2=0 为圆锥）' },
  rounded_box: { args: ['x','y','z','r','segments'], desc: '圆角盒（圆角半径 r）' },
  gear: { args: ['teeth','module','thickness','bore','segments'], desc: '直齿齿轮（梯形齿，简化）' },
};

// ---------- 进程内入口（参数对象 -> 水密 ASCII STL 文本） ----------
function generate(params) {
  const shape = params.shape;
  if (!shape || !SHAPES[shape]) fail('缺少 shape（可用: ' + Object.keys(SHAPES).join(', ') + '）');
  const solid = [`solid ${shape}`];
  if (shape === 'box') {
    box(solid, num(params.x, 20, 0.1, 'x'), num(params.y, 20, 0.1, 'y'), num(params.z, 10, 0.1, 'z'));
  } else if (shape === 'cylinder') {
    cylinder(solid, num(params.d, 20, 0.1, 'd') / 2, num(params.h, 30, 0.1, 'h'), num(params.segments, 64, 3, 'segments'));
  } else if (shape === 'tube') {
    const d = num(params.d, 20, 0.1, 'd') / 2, id = num(params.id, 6, 0.1, 'id') / 2;
    if (id >= d) fail('id（内径）必须小于 d（外径）');
    tube(solid, d, id, num(params.h, 30, 0.1, 'h'), num(params.segments, 64, 3, 'segments'));
  } else if (shape === 'sphere') {
    sphere(solid, num(params.d, 20, 0.1, 'd') / 2, num(params.segments, 32, 3, 'segments'));
  } else if (shape === 'cone') {
    const d1 = num(params.d1, 20, 0.1, 'd1');
    const d2 = num(params.d2, 10, 0, 'd2');
    cone(solid, d1 / 2, d2 / 2, num(params.h, 30, 0.1, 'h'), num(params.segments, 64, 3, 'segments'));
  } else if (shape === 'rounded_box') {
    const X = num(params.x, 20, 0.1, 'x'), Y = num(params.y, 20, 0.1, 'y'), Z = num(params.z, 10, 0.1, 'z');
    const r = num(params.r, 3, 0.1, 'r');
    if (r >= Math.min(X, Y) / 2) fail('r（圆角半径）必须小于 min(x,y)/2');
    roundedBox(solid, X, Y, Z, r, num(params.segments, 64, 3, 'segments'));
  } else if (shape === 'gear') {
    const teeth = Math.round(num(params.teeth, 12, 3, 'teeth'));
    const module = num(params.module, 1, 0.1, 'module');
    const thickness = num(params.thickness, 5, 0.1, 'thickness');
    const bore = num(params.bore, 4, 0, 'bore');
    gear(solid, teeth, module, thickness, bore, num(params.segments, 128, 16, 'segments'));
  }
  solid.push(`endsolid ${shape}`);
  const text = solid.join('\n') + '\n';
  return { shape, stl: text, sizeBytes: Buffer.byteLength(text, 'utf8') };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.list) {
      console.log('可用形状:');
      for (const [k, v] of Object.entries(SHAPES)) console.log(`  ${k}\t${v.desc}\t参数: ${v.args.join(', ')}`);
      return;
    }
    const { shape, stl } = generate(args);
    const out = args.out || `${shape}.stl`;
    fs.writeFileSync(out, stl, 'utf8');
    console.log(`已生成 ${out}（${shape}，${(stl.length / 1024).toFixed(1)} KB）`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { SHAPES, generate, box, cylinder, tube, sphere, cone, roundedBox, gear };
