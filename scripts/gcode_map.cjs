#!/usr/bin/env node
/**
 * gcode_map.cjs — 刀路简图（多面板诊断图），纯 Node 零依赖。
 *
 * 一张图给出四个视角，供 agent 自己「看」切片结果：
 *   ① 俯视全览  X-Y 投影，按 ;TYPE: 上色 —— 整体形状 / 裙边 / 支撑 / 空驶
 *   ② 侧视轮廓  每层的 X 跨度沿 Z 堆叠 —— 悬垂、收腰、高度分布
 *   ③ 首层      最低层单独渲染 —— 床附着面积与形状
 *   ④ 顶层      最高层单独渲染 —— 顶面实心是否完整、有无破洞
 *
 * CLI:
 *   node gcode_map.cjs <file.gcode> [--out out.png] [--size 1200]
 *
 * 程序化:
 *   const { buildToolpathMap } = require('./gcode_map.cjs')
 *   const { png, stats, panels } = buildToolpathMap(text, { size: 1200 })
 */
'use strict';

const fs = require('node:fs');
const { parseGcode, pngEncode, colorFor } = require('./gcode_render.cjs');
const { drawText, textWidth } = require('./bitmap_font.cjs');

// 面板标题：英文标签 + 5×7 点阵字，让图脱离解释也能独立读懂
const PANEL_TITLES = {
  overview: 'TOP VIEW',
  side: 'SIDE PROFILE',
  first: 'FIRST LAYER',
  top: 'TOP LAYER',
};

function fail(msg) { throw new Error('gcode_map: ' + msg); }

function parseArgs(argv) {
  const args = { size: 1200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--size') args.size = Number(argv[++i]);
    else if (!args.file) args.file = a;
  }
  return args;
}

// ---------- 画布 ----------
class Canvas {
  constructor(W, H, bg) {
    this.W = W;
    this.H = H;
    this.buf = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      this.buf[i * 3] = bg[0]; this.buf[i * 3 + 1] = bg[1]; this.buf[i * 3 + 2] = bg[2];
    }
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 3;
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2];
  }
  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  stroke(x, y, w, h, c) {
    this.line(x, y, x + w - 1, y, c);
    this.line(x, y + h - 1, x + w - 1, y + h - 1, c);
    this.line(x, y, x, y + h - 1, c);
    this.line(x + w - 1, y, x + w - 1, y + h - 1, c);
  }
  fill(x, y, w, h, c) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
}

// ---------- 极简 3×5 点阵数字（面板编号） ----------
const DIGITS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

function drawGlyph(cv, gx, gy, glyph, color, scale) {
  for (let r = 0; r < glyph.length; r++) {
    for (let c = 0; c < glyph[r].length; c++) {
      if (glyph[r][c] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) cv.set(gx + c * scale + dx, gy + r * scale + dy, color);
      }
    }
  }
}

function drawNumber(cv, x, y, n, color, scale) {
  const s = String(n);
  for (let i = 0; i < s.length; i++) {
    const g = DIGITS[s[i]];
    if (g) drawGlyph(cv, x + i * 4 * scale, y, g, color, scale);
  }
}

// ---------- 层切分 ----------
function splitLayers(segs) {
  const raw = [];
  let cur = null, start = 0;
  for (let i = 0; i < segs.length; i++) {
    const z = Math.round(segs[i].z * 1000) / 1000;
    if (cur === null || z !== cur) {
      if (cur !== null) raw.push({ z: cur, start, end: i });
      cur = z; start = i;
    }
  }
  if (cur !== null) raw.push({ z: cur, start, end: segs.length });
  // 只保留真正有挤出的层：起始/结束代码里的抬升（如 Cura 的 "G1 Z15.0"）只是空移动，不构成层
  return raw.filter((L) => {
    for (let i = L.start; i < L.end; i++) {
      if (segs[i].ext) return true;
    }
    return false;
  });
}

// ---------- 投影器：把世界坐标映射到面板像素 ----------
function makeProjector(rect, proj, b) {
  const pad = 8;
  const iw = Math.max(1, rect.w - pad * 2), ih = Math.max(1, rect.h - pad * 2);
  const sx = Math.max(1e-6, b.maxX - b.minX);
  const sy = proj === 'xy' ? Math.max(1e-6, b.maxY - b.minY) : Math.max(1e-6, b.maxZ - b.minZ);
  const scale = Math.min(iw / sx, ih / sy);
  const ox = rect.x + pad + (iw - sx * scale) / 2;
  const oy = rect.y + pad + (ih - sy * scale) / 2;
  return (X, Y, Z) => (proj === 'xy'
    ? [ox + (X - b.minX) * scale, oy + (b.maxY - Y) * scale]   // 大 Y 在屏幕上方（与 PrusaSlicer 一致）
    : [ox + (X - b.minX) * scale, oy + (b.maxZ - Z) * scale]); // 大 Z 在上
}

// ---------- 图例 ----------
const LEGEND = [
  ['外墙/内壁', [232, 60, 50], 'WALL'],
  ['内部填充', [50, 120, 220], 'FILL'],
  ['实心/顶面/桥', [40, 180, 90], 'SKIN'],
  ['裙边/底边', [255, 150, 40], 'SKIRT'],
  ['支撑', [172, 92, 220], 'SUPPORT'],
  ['空驶', [222, 222, 226], 'TRAVEL'],
];

function drawLegend(cv, W, y, h) {
  const n = LEGEND.length;
  const gapx = W / n;
  const s = Math.min(16, Math.round(h * 0.5));
  const sy = y + Math.round((h - s) / 2);
  for (let i = 0; i < n; i++) {
    const x = Math.round(gapx * i + gapx * 0.1);
    cv.fill(x, sy, s, s, LEGEND[i][1]);
    cv.stroke(x, sy, s, s, [170, 175, 182]);
    // 色块右侧配字母标签，图脱离上下文也能读懂
    drawText(cv, x + s + 6, sy + Math.round((s - 7) / 2), LEGEND[i][2] || '', [110, 114, 122], 1);
  }
}

// ---------- 侧视轮廓：每层一条 X 跨度线，Z 方向铺满面板 ----------
function drawSideProfile(cv, rect, segs, layers, b) {
  const pad = Math.round(rect.w * 0.035);
  const padTop = 54;   // 给面板标题留位置，否则层线会压在标题上
  const legendH = 20;  // 面板内小图例
  const iw = Math.max(1, rect.w - pad * 2);
  const ih = Math.max(1, rect.h - padTop - pad - legendH);
  const sx = Math.max(1e-6, b.maxX - b.minX);
  const sy = Math.max(1e-6, b.maxY - b.minY);
  const spanMax = Math.max(sx, sy);
  const ox = rect.x + pad + iw * 0.05;
  const scale = (iw * 0.9) / spanMax;
  const rowH = ih / Math.max(1, layers.length);
  let prevX = null, prevY = null;

  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, has = false;
    for (let i = L.start; i < L.end; i++) {
      const s = segs[i];
      if (!s.ext) continue;
      has = true;
      x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
      y0 = Math.min(y0, s.y1, s.y2); y1 = Math.max(y1, s.y1, s.y2);
    }
    if (!has) continue;
    const y = Math.round(rect.y + padTop + ih - (li + 0.5) * rowH);
    const px0 = ox + (x0 - b.minX) * scale, px1 = ox + (x1 - b.minX) * scale;
    const py0 = ox + (y0 - b.minY) * scale, py1 = ox + (y1 - b.minY) * scale;
    // 悬垂判据：本层比下层明显外扩（X 或 Y 任一方向）—— 收腰/大象腿也会显出跨度变化
    const growX = prevX === null ? 0 : (x1 - x0) - prevX;
    const growY = prevY === null ? 0 : (y1 - y0) - prevY;
    const over = growX > Math.max(2, sx * 0.08) || growY > Math.max(2, sy * 0.08);
    cv.line(px0, y, px1, y, over ? [255, 140, 30] : [110, 145, 200]); // X 跨度
    cv.line(py0, y + 1, py1, y + 1, [186, 202, 224]);                 // Y 跨度
    prevX = x1 - x0;
    prevY = y1 - y0;
  }

  // 零件 X 范围的两条竖直参考线
  const gx0 = Math.round(ox), gx1 = Math.round(ox + sx * scale);
  const gTop = rect.y + padTop, gBot = rect.y + rect.h - pad - legendH;
  cv.line(gx0, gTop, gx0, gBot, [233, 236, 239]);
  cv.line(gx1, gTop, gx1, gBot, [233, 236, 239]);

  // 面板内小图例：区分两条曲线，让图脱离上下文也能读懂
  const ly = rect.y + rect.h - pad - legendH + 5;
  cv.fill(rect.x + pad, ly, 8, 8, [110, 145, 200]);
  drawText(cv, rect.x + pad + 12, ly + 1, 'X SPAN', [110, 114, 122], 1);
  cv.fill(rect.x + pad + 84, ly, 8, 8, [186, 202, 224]);
  drawText(cv, rect.x + pad + 96, ly + 1, 'Y SPAN', [110, 114, 122], 1);
}

// ---------- 主入口 ----------
function buildToolpathMap(text, opts = {}) {
  const segs = parseGcode(text);
  if (!segs.length) fail('没有解析到任何刀路段（确认是 PrusaSlicer 导出的 G-code）。');

  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const s of segs) {
    if (!s.ext) continue; // 包围盒只看挤出段，避免空驶乱跑拉大范围
    bounds.minX = Math.min(bounds.minX, s.x1, s.x2); bounds.maxX = Math.max(bounds.maxX, s.x1, s.x2);
    bounds.minY = Math.min(bounds.minY, s.y1, s.y2); bounds.maxY = Math.max(bounds.maxY, s.y1, s.y2);
  }
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0; bounds.maxX = 1; bounds.minY = 0; bounds.maxY = 1;
  }
  bounds.minZ = 0;

  const layers = splitLayers(segs);
  const first = layers[0];
  const last = layers[layers.length - 1];
  bounds.maxZ = Math.max(last.z, 0.01);

  // 布局：2×2 面板 + 底部图例条
  const totalW = Math.max(600, Math.round(opts.size || 1200));
  const gap = Math.round(totalW * 0.012);
  const panelW = Math.floor((totalW - gap * 3) / 2);
  const panelH = Math.floor(panelW * 0.7);
  const legendH = Math.round(totalW * 0.034);
  const totalH = gap + 2 * (panelH + gap) + legendH;
  const cv = new Canvas(totalW, totalH, opts.background || [252, 252, 250]);
  const frame = [190, 194, 198];
  const mark = [92, 97, 108];

  const panels = [
    { key: 'overview', label: '俯视全览', proj: 'xy', segs, index: 1 },
    { key: 'side', label: '侧视轮廓', proj: 'xz', segs: [], index: 2 },
    { key: 'first', label: '首层', proj: 'xy', segs: segs.slice(first.start, first.end), index: 3 },
    { key: 'top', label: '顶层', proj: 'xy', segs: segs.slice(last.start, last.end), index: 4 },
  ];

  for (let p = 0; p < panels.length; p++) {
    const col = p % 2, row = Math.floor(p / 2);
    const rect = { x: gap + col * (panelW + gap), y: gap + row * (panelH + gap), w: panelW, h: panelH };
    cv.fill(rect.x, rect.y, rect.w, rect.h, [255, 255, 255]);
    cv.stroke(rect.x, rect.y, rect.w, rect.h, frame);
    drawNumber(cv, rect.x + 9, rect.y + 9, panels[p].index, mark, 3);
    drawText(cv, rect.x + 9, rect.y + 32, PANEL_TITLES[panels[p].key] || panels[p].key, mark, 2);

    if (panels[p].key === 'side') {
      drawSideProfile(cv, rect, segs, layers, bounds);
    } else {
      const project = makeProjector(rect, 'xy', bounds);
      for (const s of panels[p].segs) {
        const [ax, ay] = project(s.x1, s.y1, s.z);
        const [bx, by] = project(s.x2, s.y2, s.z);
        cv.line(ax, ay, bx, by, colorFor(s.type, s.ext));
      }
    }
  }

  drawLegend(cv, totalW, totalH - legendH, legendH);

  // 统计
  let ext = 0, travel = 0, overhangLayers = 0, prevSpan = null;
  for (const s of segs) (s.ext ? ext++ : travel++);
  for (const L of layers) {
    let lminX = Infinity, lmaxX = -Infinity, ok = false;
    for (let i = L.start; i < L.end; i++) {
      const s = segs[i];
      if (!s.ext) continue;
      ok = true;
      lminX = Math.min(lminX, s.x1, s.x2); lmaxX = Math.max(lmaxX, s.x1, s.x2);
    }
    if (!ok) continue;
    if (prevSpan !== null && (lmaxX - lminX) - prevSpan > Math.max(2, (bounds.maxX - bounds.minX) * 0.08)) overhangLayers++;
    prevSpan = lmaxX - lminX;
  }

  const stats = {
    segments: segs.length,
    extrusionSegments: ext,
    travelSegments: travel,
    layers: layers.length,
    layerHeights: `${layers[0].z.toFixed(3)} → ${last.z.toFixed(2)} mm`,
    bounds: {
      minX: +bounds.minX.toFixed(2), maxX: +bounds.maxX.toFixed(2),
      minY: +bounds.minY.toFixed(2), maxY: +bounds.maxY.toFixed(2),
      maxZ: +bounds.maxZ.toFixed(2),
    },
    overhangLayers,
    firstLayerSegments: first.end - first.start,
    topLayerSegments: last.end - last.start,
  };

  return {
    png: pngEncode(totalW, totalH, cv.buf),
    image: `${totalW}x${totalH}`,
    stats,
    panels: panels.map((p) => ({ key: p.key, label: p.label })),
    legend: [
      ['外墙/内壁', [232, 60, 50]],
      ['内部填充', [50, 120, 220]],
      ['实心/顶面/桥', [40, 180, 90]],
      ['裙边/底边', [255, 150, 40]],
      ['支撑', [172, 92, 220]],
      ['空驶', [222, 222, 226]],
    ],
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) fail('用法: node gcode_map.cjs <file.gcode> [--out out.png] [--size 1200]');
    const text = fs.readFileSync(args.file, 'utf8');
    const r = buildToolpathMap(text, { size: args.size });
    const out = args.out || args.file.replace(/\.gcode$/i, '') + '-map.png';
    fs.writeFileSync(out, r.png);
    console.log(`已生成 ${out}（${r.image}）`);
    console.log(`层数 ${r.stats.layers}，段数 ${r.stats.segments}（挤出 ${r.stats.extrusionSegments} / 空驶 ${r.stats.travelSegments}）`);
    console.log(`尺寸 X ${r.stats.bounds.minX}~${r.stats.bounds.maxX}，Y ${r.stats.bounds.minY}~${r.stats.bounds.maxY}，Z 0~${r.stats.bounds.maxZ}`);
    console.log(`疑似悬垂层数：${r.stats.overhangLayers}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { buildToolpathMap, splitLayers, Canvas };
