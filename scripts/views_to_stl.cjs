#!/usr/bin/env node
/**
 * views_to_stl.cjs — CAD 三视图 → 3D 模型（视觉凸包重建）。
 *
 * 原理：把三视图各自的剪影沿其视线方向挤出，再求交集（体素求交）：
 *   正视图（看 X-Z 面）沿 Y 挤出
 *   俯视图（看 X-Y 面）沿 Z 挤出
 *   侧视图（看 Y-Z 面）沿 X 挤出
 *   三个挤出的交集 = 视觉凸包，对棱柱类机械件即为精确还原。
 *
 * 视图约定（三视图均"正对物体"看，图片行 0 在上）：
 *   正视图：列 0 = 最小 X，行 0 = 最大 Z
 *   俯视图：列 0 = 最小 X，行 0 = 最大 Y（后）
 *   侧视图：列 0 = 最小 Y（前），行 0 = 最大 Z
 *
 * CLI 用法:
 *   node views_to_stl.cjs --front f.png --top t.png --side s.png --width_mm 60 --voxel_mm 0.8 --out m.stl
 *
 * 程序化用法:
 *   const { viewsToStl } = require('./views_to_stl.cjs')
 *   const { stl, nx, ny, nz, Xmm, Ymm, Zmm } = await viewsToStl({ frontPath, topPath, sidePath, width_mm: 60 })
 */
'use strict';

const fs = require('node:fs');
const { decodeImage, otsuThreshold, extrudeMask } = require('./image_to_stl.cjs');

function fail(msg) {
  throw new Error('views_to_stl: ' + msg);
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

// ---------- 视图：解码 → 二值剪影 → 紧致包围盒 ----------
async function loadView(filePath, maxPixels, invert, threshold) {
  if (!fs.existsSync(filePath)) fail('视图文件不存在：' + filePath);
  const { width: W, height: H, gray } = await decodeImage(filePath, maxPixels);
  const t = threshold === undefined ? otsuThreshold(gray, W, H) : Number(threshold);
  const mask = extrudeMask(gray, W, H, t, !!invert);
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!mask[j * W + i]) continue;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  }
  if (x1 < 0) fail('该视图里找不到实体（可能阈值不对或图片反了）：' + filePath);
  return { mask, W, H, bbox: { x0, x1, y0, y1 }, bw: x1 - x0, bh: y1 - y0 };
}

// u,v ∈ [0,1]：u 左→右，v 上→下（与图片一致），映射到紧致包围盒内取样
function sampleView(view, u, v) {
  const { mask, W, bbox, bw, bh } = view;
  const col = Math.min(bbox.x1, Math.max(bbox.x0, Math.round(bbox.x0 + u * bw)));
  const row = Math.min(bbox.y1, Math.max(bbox.y0, Math.round(bbox.y0 + v * bh)));
  return mask[row * W + col];
}

// ---------- 单图三视图切分 ----------
// 1) 连通域标记  2) 邻近包围盒合并成簇  3) 取最大的三簇  4) 用轴长一致性选出 正/俯/侧 顺序
function labelComponents(mask, W, H) {
  const labels = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = [];
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const id = comps.length;
    let minX = W, maxX = -1, minY = H, maxY = -1, area = 0;
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p - x) / W;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (mask[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
        }
      }
    }
    comps.push({ id, minX, maxX, minY, maxY, area });
  }
  return comps;
}

function clusterBoxes(boxes, gapPx) {
  const parent = boxes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const gx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
      const gy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
      if (gx <= gapPx && gy <= gapPx) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < boxes.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(boxes[i]);
  }
  return [...groups.values()].map((g) => ({
    minX: Math.min(...g.map((b) => b.minX)), maxX: Math.max(...g.map((b) => b.maxX)),
    minY: Math.min(...g.map((b) => b.minY)), maxY: Math.max(...g.map((b) => b.maxY)),
    area: g.reduce((s, b) => s + b.area, 0),
    parts: g.length,
  }));
}

function cropView(mask, W, H, box) {
  const w = box.maxX - box.minX + 1, h = box.maxY - box.minY + 1;
  const m = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) m[j * w + i] = mask[(box.minY + j) * W + (box.minX + i)];
  }
  return { mask: m, W: w, H: h, bbox: { x0: 0, x1: w - 1, y0: 0, y1: h - 1 }, bw: w - 1, bh: h - 1 };
}

// 正视图 X×Z、俯视图 X×Y、侧视图 Y×Z ⇒
// 宽度关系: w_front ≈ w_top；高度关系: h_front ≈ h_side；交叉: h_top ≈ w_side
function scoreAssignment(f, t, s) {
  const d = (a, b) => Math.abs(a - b) / Math.max(1, Math.max(a, b));
  return d(f.bw, t.bw) + d(f.bh, s.bh) + d(t.bh, s.bw);
}

function assignViews(views) {
  if (views.length !== 3) fail(`切分出 ${views.length} 个视图，需要恰好 3 个。`);
  const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  let best = null;
  for (const [a, b, c] of perms) {
    const score = scoreAssignment(views[a], views[b], views[c]);
    if (!best || score < best.score) best = { score, front: views[a], top: views[b], side: views[c] };
  }
  return best;
}

async function loadDrawing(filePath, maxPixels, invert, threshold, gapRatio) {
  if (!fs.existsSync(filePath)) fail('图纸文件不存在：' + filePath);
  const { width: W, height: H, gray } = await decodeImage(filePath, maxPixels);
  const t = threshold === undefined ? otsuThreshold(gray, W, H) : Number(threshold);
  const mask = extrudeMask(gray, W, H, t, !!invert);
  const comps = labelComponents(mask, W, H);
  if (comps.length === 0) fail('图纸里找不到任何图形。');
  const gapPx = Math.round(num(gapRatio, 0.03, 0.001, 'gap_ratio') * Math.max(W, H));
  const clusters = clusterBoxes(comps, gapPx).sort((a, b) => b.area - a.area);
  if (clusters.length < 3) {
    fail(`只切出 ${clusters.length} 个视图（需要 3 个）。可调小 gap_ratio，或确认三视图之间有足够留白。`);
  }
  const views = clusters.slice(0, 3).map((box) => cropView(mask, W, H, box));
  const chosen = assignViews(views);
  return { ...chosen, gapPx, clusterCount: clusters.length, sourceSize: { W, H } };
}

// ---------- 体素重建（三视图剪影求交） ----------
async function reconstruct(params) {
  const maxPixels = Math.round(num(params.max_pixels, 400, 32, 'max_pixels'));
  const invert = !!params.invert;
  let front, top, side, split = null;
  if (params.drawingPath) {
    // 单图模式：自动切分出三视图并选出正/俯/侧顺序
    split = await loadDrawing(params.drawingPath, maxPixels, invert, params.threshold, params.gap_ratio);
    front = split.front; top = split.top; side = split.side;
  } else {
    [front, top, side] = await Promise.all([
      loadView(params.frontPath, maxPixels, invert, params.threshold),
      loadView(params.topPath, maxPixels, invert, params.threshold),
      loadView(params.sidePath, maxPixels, invert, params.threshold),
    ]);
  }

  // 物理尺寸：以 X 为准（正视图宽度 = width_mm），另两轴由各视图纵横比得到
  const Xmm = num(params.width_mm, 60, 1, 'width_mm');
  const Zmm = Xmm * front.bh / front.bw;  // 正视图：宽 X，高 Z
  const Ymm = Xmm * top.bh / top.bw;      // 俯视图：宽 X，高 Y

  // 交叉校验：侧视图的宽/高比应 ≈ Y/Z
  const sideRatio = side.bw / side.bh;
  const expectRatio = Ymm / Zmm;
  const ratioErr = Math.abs(sideRatio - expectRatio) / expectRatio;

  const vmm = num(params.voxel_mm, 0.8, 0.15, 'voxel_mm');
  const nx = Math.max(2, Math.round(Xmm / vmm));
  const ny = Math.max(2, Math.round(Ymm / vmm));
  const nz = Math.max(2, Math.round(Zmm / vmm));

  const inside = new Uint8Array(nx * ny * nz);
  let count = 0;
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    const z = (k + 0.5) / nz;
    const v = 1 - z; // 图片行：上=大 Z
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) / ny;
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) / nx;
        const ok = sampleView(front, x, v) && sampleView(top, x, 1 - y) && sampleView(side, y, v);
        if (ok) { inside[idx] = 1; count++; }
        idx++;
      }
    }
  }
  if (count === 0) fail('三视图交集为空：视图之间可能不对齐或尺寸比例不一致。');

  return {
    inside, nx, ny, nz, Xmm, Ymm, Zmm, vmm, count, sideRatio, expectRatio, ratioErr,
    splitFrom: split ? { gapPx: split.gapPx, clusterCount: split.clusterCount, assignScore: split.score } : null,
  };
}

// ---------- 体素 → 水密 STL ----------
function emit(solid, a, b, c) {
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  solid.push(`  facet normal ${(n[0]/len).toFixed(6)} ${(n[1]/len).toFixed(6)} ${(n[2]/len).toFixed(6)}`);
  solid.push('    outer loop');
  for (const p of [a, b, c]) solid.push(`      vertex ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
  solid.push('    endloop');
  solid.push('  endfacet');
}

function voxelsToStl(solid, nx, ny, nz, inside, vs) {
  const isIn = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz)
    ? 0 : inside[i + nx * (j + ny * k)];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!isIn(i, j, k)) continue;
        const x = i * vs, y = j * vs, z = k * vs;
        const c = [
          [x, y, z], [x + vs, y, z], [x + vs, y + vs, z], [x, y + vs, z],
          [x, y, z + vs], [x + vs, y, z + vs], [x + vs, y + vs, z + vs], [x, y + vs, z + vs],
        ];
        // 底 -z / 顶 +z
        if (!isIn(i, j, k - 1)) { emit(solid, c[0], c[1], c[2]); emit(solid, c[0], c[2], c[3]); }
        if (!isIn(i, j, k + 1)) { emit(solid, c[4], c[6], c[5]); emit(solid, c[4], c[7], c[6]); }
        // 前 -y / 后 +y
        if (!isIn(i, j - 1, k)) { emit(solid, c[0], c[4], c[5]); emit(solid, c[0], c[5], c[1]); }
        if (!isIn(i, j + 1, k)) { emit(solid, c[2], c[6], c[7]); emit(solid, c[2], c[7], c[3]); }
        // 左 -x / 右 +x
        if (!isIn(i - 1, j, k)) { emit(solid, c[3], c[7], c[4]); emit(solid, c[3], c[4], c[0]); }
        if (!isIn(i + 1, j, k)) { emit(solid, c[1], c[5], c[6]); emit(solid, c[1], c[6], c[2]); }
      }
    }
  }
}

// ---------- 主入口 ----------
async function viewsToStl(params) {
  const r = await reconstruct(params);
  const solid = ['solid views'];
  voxelsToStl(solid, r.nx, r.ny, r.nz, r.inside, r.vmm);
  solid.push('endsolid views');
  const stl = solid.join('\n') + '\n';
  return { ...r, stl, sizeBytes: Buffer.byteLength(stl, 'utf8') };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.drawing && (!args.front || !args.top || !args.side)) {
      fail('用法: node views_to_stl.cjs --drawing all.png --width_mm 60 --out m.stl\n' +
        '   或: node views_to_stl.cjs --front f.png --top t.png --side s.png --width_mm 60 --out m.stl');
    }
    const r = await viewsToStl({
      ...args,
      drawingPath: args.drawing,
      frontPath: args.front,
      topPath: args.top,
      sidePath: args.side,
    });
    const out = args.out || 'views.stl';
    fs.writeFileSync(out, r.stl, 'utf8');
    console.log(
      `已生成 ${out}（${r.Xmm.toFixed(1)}×${r.Ymm.toFixed(1)}×${r.Zmm.toFixed(1)}mm，` +
      `体素 ${r.nx}×${r.ny}×${r.nz}，实体 ${r.count}，${(r.sizeBytes / 1048576).toFixed(1)} MB）`
    );
    if (r.ratioErr > 0.05) {
      console.log(`注意：侧视图宽高比与正/俯视图不一致（偏差 ${(r.ratioErr * 100).toFixed(1)}%），重建可能有误。`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  viewsToStl, reconstruct, loadView, sampleView, voxelsToStl,
  loadDrawing, labelComponents, clusterBoxes, assignViews, cropView,
};
