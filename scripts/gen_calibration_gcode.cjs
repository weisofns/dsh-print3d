#!/usr/bin/env node
/**
 * gen_calibration_gcode.cjs — 零依赖校准件 G-code 生成器（Marlin/Klipper 方言）。
 *
 * CLI 用法:
 *   node gen_calibration_gcode.cjs --part cube        --size 20 --out cube.gcode
 *   node gen_calibration_gcode.cjs --part temp-tower  --start 220 --end 180 --step 5 --out tower.gcode
 *   node gen_calibration_gcode.cjs --part first-layer --size 60 --out firstlayer.gcode
 *   node gen_calibration_gcode.cjs --part retraction  --out retract.gcode
 *   node gen_calibration_gcode.cjs --part bridge      --out bridge.gcode
 *   node gen_calibration_gcode.cjs --list
 *
 * 程序化用法:
 *   const { generate } = require('./gen_calibration_gcode.cjs')
 *   generate({ part: 'cube', size: 20, nozzle: 200, bed: 60, ... }) -> { part, gcode, sizeBytes }
 *
 * 通用参数: --nozzle 200 --bed 60 --layer-height 0.2 --line-width 0.4 --speed 40
 * 生成结果必须上机前人工核对。
 */
'use strict';

const fs = require('node:fs');

function fail(msg) { throw new Error('gen_calibration_gcode: ' + msg); }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') { args.list = true; continue; }
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[++i]; if (v === undefined) fail(`--${k} 缺少值`); args[k] = v; }
  }
  return args;
}
const num = (v, dflt, min, label) => { const n = v === undefined ? dflt : Number(v); if (!Number.isFinite(n) || n < min) fail(`${label} 必须是 >= ${min} 的数值`); return n; };

// ---------- 生成器状态 ----------
const FILAMENT_AREA = Math.PI * (1.75 / 2) ** 2; // mm^2

function makeGen(cfg) {
  const g = [];
  let e = 0;
  let x = 0, y = 0, z = 0;
  const travel = cfg.speed * 60 * 3; // 空驶速度 mm/min（3×打印速度）

  const line = (s) => g.push(s);

  function travelTo(nx, ny, nz) {
    line(`G1 X${f(nx)} Y${f(ny)} Z${f(nz)} F${Math.round(travel)}`);
    x = nx; y = ny; z = nz;
  }
  // 挤出直线；extrudeLen 为耗材长度(mm)，按体积换算
  function extrudeTo(nx, ny, nz, dist, rate) {
    const vol = dist * cfg.lineWidth * cfg.layerHeight;
    const de = vol / FILAMENT_AREA;
    e += de;
    line(`G1 X${f(nx)} Y${f(ny)} Z${f(nz)} E${f(e)} F${Math.round(rate)}`);
    x = nx; y = ny; z = nz;
  }
  const f = (v) => (+v).toFixed(3);

  function startGcode() {
    line('; ==== start gcode (auto-generated, review before print) ====');
    line('G21 ; units mm');
    line('G90 ; absolute positioning');
    line('M82 ; absolute extrusion');
    line(`M140 S${cfg.bed} ; heat bed`);
    line(`M104 S${cfg.nozzle} ; heat nozzle`);
    line('G28 ; home all axes');
    line(`M190 S${cfg.bed} ; wait bed temp`);
    line(`M109 S${cfg.nozzle} ; wait nozzle temp`);
    line('G92 E0');
    // 擦嘴线
    line(`G1 Z${f(Math.max(0.3, cfg.layerHeight))} F${Math.round(travel)}`);
    line(`G1 X5 Y5 F${Math.round(travel)}`);
    const primeLen = 40;
    e += (primeLen * cfg.lineWidth * cfg.layerHeight) / FILAMENT_AREA;
    line(`G1 X5 Y45 E${f(e)} F${Math.round(cfg.speed * 60)}`);
    line('G92 E0');
    e = 0;
  }

  function endGcode() {
    line('; ==== end gcode ====');
    line('G91 ; relative positioning');
    line('G1 E-2 F1800 ; retract 2mm');
    line('G1 Z+5 F600 ; lift Z');
    line('G90 ; absolute positioning');
    line('G1 X0 Y200 F6000 ; park bed forward');
    line('M104 S0 ; nozzle off');
    line('M140 S0 ; bed off');
    line('M107 ; fan off');
    line('M84 ; steppers off');
  }

  // 打印一个矩形层：外圈 + 单向填充
  function printRectLayer(zLayer, x0, y0, x1, y1, axis) {
    // 外圈
    const cyc = [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
    for (const [px,py] of cyc) {
      const dist = Math.hypot(px - x, py - y) + Math.abs(zLayer - z) * 0; // 同层
      void dist;
      if (px !== x || py !== y) {
        const d = Math.hypot(px - x, py - y);
        extrudeTo(px, py, zLayer, d, cfg.speed * 60);
      }
    }
    // 填充
    const spacing = Math.max(cfg.lineWidth * 1.0, cfg.lineWidth);
    if (axis === 'x') {
      for (let yy = y0 + spacing / 2; yy < y1; yy += spacing) {
        const yy2 = Math.min(yy, y1 - spacing / 4);
        travelTo(x0, yy2, zLayer);
        const d = Math.hypot(x1 - x0, 0);
        extrudeTo(x1, yy2, zLayer, d, cfg.speed * 60);
      }
    } else {
      for (let xx = x0 + spacing / 2; xx < x1; xx += spacing) {
        const xx2 = Math.min(xx, x1 - spacing / 4);
        travelTo(xx2, y0, zLayer);
        const d = Math.hypot(0, y1 - y0);
        extrudeTo(xx2, y1, zLayer, d, cfg.speed * 60);
      }
    }
  }

  return { line, travelTo, extrudeTo, printRectLayer, startGcode, endGcode, f, lines: () => g, get eVal() { return e; }, set eVal(v) { e = v; }, get xVal() { return x; }, get yVal() { return y; }, get zVal() { return z; } };
}

// ---------- 各校准件 ----------
function cube(cfg) {
  const gen = makeGen(cfg);
  gen.startGcode();
  const s = cfg.size;
  const half = s / 2;
  const layers = Math.round(s / cfg.layerHeight);
  for (let i = 1; i <= layers; i++) {
    const zl = cfg.layerHeight * i;
    gen.travelTo(-half, -half, zl);
    gen.printRectLayer(zl, -half, -half, half, half, i % 2 === 1 ? 'x' : 'y');
  }
  gen.endGcode();
  return gen.lines().join('\n') + '\n';
}

function tempTower(cfg) {
  const gen = makeGen(cfg);
  gen.startGcode();
  const size = cfg.size;
  const half = size / 2;
  const segH = num(cfg.segmentHeight, 8, 1, 'segment-height');
  const layersPerSeg = Math.max(2, Math.round(segH / cfg.layerHeight));
  const start = num(cfg.start, 220, 0, 'start');
  const end = num(cfg.end, 180, 0, 'end');
  const step = num(cfg.step, 5, 1, 'step');
  if (end > start) fail('--end 不能大于 --start');
  let zCursor = 0;
  for (let t = start; t >= end; t -= step) {
    gen.line(`M109 S${Math.round(t)} ; temperature segment ${Math.round(t)}C`);
    for (let i = 0; i < layersPerSeg; i++) {
      zCursor += cfg.layerHeight;
      gen.travelTo(-half, -half, zCursor);
      const axis = (Math.round(zCursor / cfg.layerHeight) % 2 === 1) ? 'x' : 'y';
      gen.printRectLayer(zCursor, -half, -half, half, half, axis);
    }
    gen.line(`; ---- segment end ${Math.round(t)}C ----`);
  }
  gen.endGcode();
  return gen.lines().join('\n') + '\n';
}

function firstLayer(cfg) {
  const gen = makeGen(cfg);
  gen.startGcode();
  const s = cfg.size;
  const zl = cfg.layerHeight;
  gen.travelTo(0, 0, zl);
  gen.printRectLayer(zl, 0, 0, s, s, 'x');
  gen.endGcode();
  return gen.lines().join('\n') + '\n';
}

function retraction(cfg) {
  const gen = makeGen(cfg);
  gen.startGcode();
  const postR = cfg.postRadius || 4;   // 柱子半径 mm
  const postH = cfg.postHeight || 30;  // 柱子高度 mm
  const gap = cfg.gap || 10;           // 两柱间距 mm
  const layers = Math.round(postH / cfg.layerHeight);
  const cx = [-(gap / 2), (gap / 2)];
  for (let i = 1; i <= layers; i++) {
    const zl = cfg.layerHeight * i;
    // 每层在两个柱位画一个小圆（用短线段近似）
    for (const c of cx) {
      gen.travelTo(c + postR, 0, zl);
      const segs = Math.max(8, Math.round((2 * Math.PI * postR) / cfg.lineWidth));
      for (let k = 0; k < segs; k++) {
        const th = ((k + 1) / segs) * Math.PI * 2;
        const px = c + Math.cos(th) * postR;
        const py = Math.sin(th) * postR;
        const d = Math.hypot(px - gen.xVal, py - gen.yVal);
        gen.extrudeTo(px, py, zl, d, cfg.speed * 60);
      }
    }
    gen.line(`; retract layer ${i}`);
  }
  gen.endGcode();
  return gen.lines().join('\n') + '\n';
}

function bridge(cfg) {
  const gen = makeGen(cfg);
  gen.startGcode();
  const w = cfg.towerWidth || 10;    // 塔柱宽 mm
  const h = cfg.towerHeight || 20;   // 塔柱高 mm
  const span = cfg.span || 30;       // 桥跨度 mm
  const layers = Math.round(h / cfg.layerHeight);
  const x0 = 0, x1 = w, x2 = w + span, x3 = w + span + w;
  for (let i = 1; i <= layers; i++) {
    const zl = cfg.layerHeight * i;
    for (const [a, b] of [[x0, x1], [x2, x3]]) {
      gen.travelTo(a, 0, zl);
      gen.printRectLayer(zl, a, 0, b, w, 'x');
    }
  }
  // 桥（悬空段，从 x1 到 x2）
  const zl = h + cfg.layerHeight;
  gen.travelTo(x1, 0, zl);
  gen.extrudeTo(x1, w, zl, w, cfg.speed * 60);
  gen.extrudeTo(x2, w, zl, span, cfg.speed * 60);
  gen.extrudeTo(x2, 0, zl, w, cfg.speed * 60);
  gen.extrudeTo(x1, 0, zl, span, cfg.speed * 60);
  gen.endGcode();
  return gen.lines().join('\n') + '\n';
}

const PARTS = {
  cube: { fn: cube, desc: 'XYZ 校准立方体' },
  'temp-tower': { fn: tempTower, desc: '温度塔' },
  'first-layer': { fn: firstLayer, desc: '首层校准方块' },
  retraction: { fn: retraction, desc: '回抽/拉丝测试双柱' },
  bridge: { fn: bridge, desc: '架桥测试' },
};

// ---------- 进程内入口（参数对象 -> G-code 文本） ----------
function generate(params) {
  const part = params.part;
  if (!part || !PARTS[part]) fail('缺少 part（可用: ' + Object.keys(PARTS).join(', ') + '）');
  const cfg = {
    nozzle: num(params.nozzle, 200, 0, 'nozzle'),
    bed: num(params.bed, 60, 0, 'bed'),
    layerHeight: num(params.layerHeight, 0.2, 0.05, 'layer-height'),
    lineWidth: num(params.lineWidth, 0.4, 0.1, 'line-width'),
    speed: num(params.speed, 40, 1, 'speed'),
    size: num(params.size, part === 'first-layer' ? 60 : 20, 1, 'size'),
    start: params.start, end: params.end, step: params.step,
    segmentHeight: params.segmentHeight,
    postRadius: params.postRadius, postHeight: params.postHeight, gap: params.gap,
    towerWidth: params.towerWidth, towerHeight: params.towerHeight, span: params.span,
  };
  const text = PARTS[part].fn(cfg);
  return { part, gcode: text, sizeBytes: Buffer.byteLength(text, 'utf8') };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.list) {
      console.log('可用校准件:');
      for (const [k, v] of Object.entries(PARTS)) console.log(`  ${k}\t${v.desc}`);
      return;
    }
    const { part, gcode } = generate({
      part: args.part,
      nozzle: args.nozzle,
      bed: args.bed,
      layerHeight: args['layer-height'],
      lineWidth: args['line-width'],
      speed: args.speed,
      size: args.size,
      start: args.start, end: args.end, step: args.step,
      segmentHeight: args['segment-height'],
      postRadius: args['post-radius'], postHeight: args['post-height'], gap: args.gap,
      towerWidth: args['tower-width'], towerHeight: args['tower-height'], span: args.span,
    });
    const out = args.out || `${part}.gcode`;
    fs.writeFileSync(out, gcode, 'utf8');
    console.log(`已生成 ${out}（${part}，${(gcode.length / 1024).toFixed(1)} KB）`);
    console.log(`提示：上机前请人工核对温度/尺寸/固件方言。`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { PARTS, makeGen, generate };
