#!/usr/bin/env node
/**
 * gcode_estimate.cjs — 零依赖 G-code 分析器（Marlin/Klipper 方言）。
 *
 * CLI 用法:
 *   node gcode_estimate.cjs <file.gcode> [--density <g/cm3>]
 *
 * 程序化用法:
 *   const { estimate } = require('./gcode_estimate.cjs')
 *   estimate(text, density) -> { estimatedTimeSec, filamentMM, layers, ... }
 *
 * 打印时间按匀速进给估算（忽略加减速），耗材按 1.75mm 线径计算。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(msg) {
  throw new Error('gcode_estimate: ' + msg);
}

function parseArgs(argv) {
  const out = { file: null, density: 1.24 }; // PLA 默认密度
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--density') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.density = v;
    } else if (!out.file) {
      out.file = a;
    }
  }
  return out;
}

function tokenize(line) {
  // 去掉注释
  const idx = line.indexOf(';');
  if (idx >= 0) line = line.slice(0, idx);
  const tokens = {};
  for (const part of line.split(/\s+/)) {
    if (part.length < 1) continue;
    const c = part[0].toUpperCase();
    const v = Number(part.slice(1));
    if (Number.isFinite(v)) tokens[c] = v;
    else tokens[part[0].toUpperCase()] = part.slice(1);
  }
  return tokens;
}

function estimate(text, density) {
  let x = 0, y = 0, z = 0, e = 0, f = 0;
  let xyzRel = false; // G91 相对定位
  let eRel = false;   // M83 / G91 相对挤出
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let nozzleTemp = 0, bedTemp = 0;
  const nozzleTemps = []; // M104/M109 温度序列（温度梯度，去重连续重复）
  let timeSec = 0;
  let filamentMM = 0;
  let moves = 0, extrusions = 0;
  const zValues = new Set([0]);

  for (const raw of text.split(/\r?\n/)) {
    const t = tokenize(raw);
    const code = t.G;
    if (code === 0 || code === 1) {
      const nx = 'X' in t ? (xyzRel ? x + t.X : t.X) : x;
      const ny = 'Y' in t ? (xyzRel ? y + t.Y : t.Y) : y;
      const nz = 'Z' in t ? (xyzRel ? z + t.Z : t.Z) : z;
      if ('F' in t) f = t.F;
      const hasMove = 'X' in t || 'Y' in t || 'Z' in t;
      if (hasMove) {
        moves++;
        const dx = nx - x, dy = ny - y, dz = nz - z;
        const dist = Math.hypot(dx, dy, dz);
        if (f > 0) timeSec += (dist / (f / 60));
        minX = Math.min(minX, nx); maxX = Math.max(maxX, nx);
        minY = Math.min(minY, ny); maxY = Math.max(maxY, ny);
        if ('Z' in t) zValues.add(nz);
      }
      if ('E' in t) {
        let de;
        if (eRel) { de = Math.abs(t.E); e += t.E; }
        else { de = Math.abs(t.E - e); e = t.E; }
        if (de > 0) { filamentMM += de; extrusions++; }
      }
      x = nx; y = ny; z = nz;
    } else if (code === 92) { // G92 复位坐标
      if ('X' in t) x = t.X;
      if ('Y' in t) y = t.Y;
      if ('Z' in t) z = t.Z;
      if ('E' in t) e = t.E;
    } else if (code === 90) {
      xyzRel = false; eRel = false;
    } else if (code === 91) {
      xyzRel = true; eRel = true;
    }
    const m = t.M;
    if (m === 104 || m === 109) {
      if ('S' in t && t.S > nozzleTemp) nozzleTemp = t.S;
      if ('S' in t && t.S > 0) { // 跳过 S0（关加热）
        const last = nozzleTemps[nozzleTemps.length - 1];
        if (last !== t.S) nozzleTemps.push(t.S);
      }
    }
    else if (m === 140 || m === 190) { if ('S' in t && t.S > bedTemp) bedTemp = t.S; }
    else if (m === 82) { eRel = false; } // M82 绝对挤出
    else if (m === 83) { eRel = true; }  // M83 相对挤出
  }

  const layerHeights = [...zValues].sort((a, b) => a - b);
  const layers = layerHeights.length;
  let layerHeight = null;
  if (layers >= 2) {
    const diffs = [];
    for (let i = 1; i < layerHeights.length; i++) diffs.push(layerHeights[i] - layerHeights[i - 1]);
    diffs.sort((a, b) => a - b);
    layerHeight = +diffs[Math.floor(diffs.length / 2)].toFixed(4);
  }

  const filamentArea = Math.PI * (1.75 / 2) ** 2; // mm^2
  const volumeMM3 = filamentMM * filamentArea;
  const massGrams = +(volumeMM3 / 1000 * density).toFixed(2);

  return {
    estimatedTimeSec: +timeSec.toFixed(1),
    estimatedTimeHuman: fmtTime(timeSec),
    filamentMM: +filamentMM.toFixed(1),
    filamentVolumeMM3: +volumeMM3.toFixed(1),
    filamentGrams: massGrams,
    densityAssumed: density,
    layers,
    layerHeight,
    nozzleTemp,
    nozzleTempSequence: nozzleTemps,
    bedTemp,
    bounds: {
      minX: minX === Infinity ? 0 : +minX.toFixed(2),
      maxX: maxX === -Infinity ? 0 : +maxX.toFixed(2),
      minY: minY === Infinity ? 0 : +minY.toFixed(2),
      maxY: maxY === -Infinity ? 0 : +maxY.toFixed(2),
    },
    moveCount: moves,
    extrusionCount: extrusions,
  };
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return 'unknown';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) fail('用法: node gcode_estimate.cjs <file.gcode> [--density <g/cm3>]');
    const text = fs.readFileSync(args.file, 'utf8');
    const result = estimate(text, args.density);
    result.file = path.basename(args.file);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { estimate, tokenize };
