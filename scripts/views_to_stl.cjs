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

// ---------- 体素重建（三视图剪影求交） ----------
async function reconstruct(params) {
  const maxPixels = Math.round(num(params.max_pixels, 400, 32, 'max_pixels'));
  const invert = !!params.invert;
  const [front, top, side] = await Promise.all([
    loadView(params.frontPath, maxPixels, invert, params.threshold),
    loadView(params.topPath, maxPixels, invert, params.threshold),
    loadView(params.sidePath, maxPixels, invert, params.threshold),
  ]);

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

  return { inside, nx, ny, nz, Xmm, Ymm, Zmm, vmm, count, sideRatio, expectRatio, ratioErr };
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
    if (!args.front || !args.top || !args.side) {
      fail('用法: node views_to_stl.cjs --front f.png --top t.png --side s.png --width_mm 60 --out m.stl');
    }
    const r = await viewsToStl({ ...args, frontPath: args.front, topPath: args.top, sidePath: args.side });
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

module.exports = { viewsToStl, reconstruct, loadView, sampleView, voxelsToStl };
