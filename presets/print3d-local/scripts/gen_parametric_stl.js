#!/usr/bin/env node
/**
 * gen_parametric_stl.js — 零依赖参数化 STL 生成器（ASCII STL）。
 *
 * 用法:
 *   node gen_parametric_stl.js --shape box      --x 20 --y 20 --z 10 --out box.stl
 *   node gen_parametric_stl.js --shape cylinder --d 20 --h 30 --segments 64 --out cyl.stl
 *   node gen_parametric_stl.js --shape tube     --d 20 --id 6 --h 30 --segments 64 --out tube.stl
 *   node gen_parametric_stl.js --shape sphere   --d 20 --segments 32 --out sphere.stl
 *   node gen_parametric_stl.js --list
 */
'use strict';

const fs = require('node:fs');

function fail(msg) {
  console.error('gen_parametric_stl: ' + msg);
  process.exit(1);
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

const SHAPES = {
  box: { args: ['x','y','z'], desc: '长方体（居中，底面 z=0）' },
  cylinder: { args: ['d','h','segments'], desc: '圆柱（轴沿 Z）' },
  tube: { args: ['d','id','h','segments'], desc: '圆管（外径 d，内径 id）' },
  sphere: { args: ['d','segments'], desc: '球体' },
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log('可用形状:');
    for (const [k, v] of Object.entries(SHAPES)) console.log(`  ${k}\t${v.desc}\t参数: ${v.args.join(', ')}`);
    return;
  }
  const shape = args.shape;
  if (!shape || !SHAPES[shape]) fail('缺少 --shape（可用: ' + Object.keys(SHAPES).join(', ') + '）');
  const solid = [`solid ${shape}`];
  if (shape === 'box') {
    box(solid, num(args.x, 20, 0.1, 'x'), num(args.y, 20, 0.1, 'y'), num(args.z, 10, 0.1, 'z'));
  } else if (shape === 'cylinder') {
    cylinder(solid, num(args.d, 20, 0.1, 'd') / 2, num(args.h, 30, 0.1, 'h'), num(args.segments, 64, 3, 'segments'));
  } else if (shape === 'tube') {
    const d = num(args.d, 20, 0.1, 'd') / 2, id = num(args.id, 6, 0.1, 'id') / 2;
    if (id >= d) fail('id（内径）必须小于 d（外径）');
    tube(solid, d, id, num(args.h, 30, 0.1, 'h'), num(args.segments, 64, 3, 'segments'));
  } else if (shape === 'sphere') {
    sphere(solid, num(args.d, 20, 0.1, 'd') / 2, num(args.segments, 32, 3, 'segments'));
  }
  solid.push(`endsolid ${shape}`);
  const text = solid.join('\n') + '\n';
  const out = args.out || `${shape}.stl`;
  fs.writeFileSync(out, text, 'utf8');
  console.log(`已生成 ${out}（${shape}，${(text.length / 1024).toFixed(1)} KB）`);
}

main();
