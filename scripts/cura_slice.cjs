#!/usr/bin/env node
/**
 * cura_slice.cjs — 用 CuraEngine 切片（当前适配 Cura 15.04 / Cura_SteamEngine）。
 *
 * CuraEngine 15.04 的命令行规格（由其 -h 实测）：
 *   CuraEngine [-h] [-v] [-m 3x3matrix] [-c <config file>] [-s <settingkey>=<value>] -o <output.gcode> <model.stl>
 *
 * 两个必须知道的坑：
 *   1) 设置键名是 camelCase 且长度单位为「微米整数」：layerThickness=200 表示 0.2mm。
 *      用 Cura 界面 resources/*.ini 里的 snake_case 名（layer_height 等）会被引擎拒绝：
 *      "Failed to set 'layer_height' to '0.2'"。
 *   2) resources/machine_profiles/*.ini 带 [section] 段头，不能直接喂给 -c；
 *      该 ini 是给 Cura 的 Python 界面层用的。
 *   温度不在 -s 设置里，只能通过 startCode/endCode 注入。
 *
 * 程序化用法:
 *   const { sliceWithCura } = require('./cura_slice.cjs')
 *   await sliceWithCura('model.stl', 'out.gcode', { layer_height: 0.2, nozzle_temp: 200 })
 */
'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const CURA_CANDIDATES = [
  'C:/Program Files (x86)/Cura_15.04/CuraEngine.exe',
  'C:/Program Files/Cura_15.04/CuraEngine.exe',
  'C:/Program Files (x86)/Cura/CuraEngine.exe',
  'C:/Program Files/Ultimaker Cura 5.0/CuraEngine.exe',
  'C:/Program Files/Ultimaker Cura 4.13/CuraEngine.exe',
];

function fail(msg) { throw new Error('cura_slice: ' + msg); }

function findCuraEngine(explicit) {
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    fail(`指定的 CuraEngine 不存在：${explicit}`);
  }
  for (const c of CURA_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const num = (v, d, label) => {
  const n = v === undefined || v === null ? d : Number(v);
  if (!Number.isFinite(n)) fail(`${label} 必须是数值`);
  return n;
};

// 自带安全起收尾：起始升温并等待（含热床），结束关加热、抬升、关电机。
function buildStartCode(nozzleTemp, bedTemp) {
  return [
    `M140 S${bedTemp}`,        // 热床开始加热（不等待）
    `M109 S${nozzleTemp}`,     // 喷嘴升温并等待
    `M190 S${bedTemp}`,        // 等热床到位
    'G21',                     // 毫米单位
    'G90',                     // 绝对坐标
    'G28',                     // 回零
    'G92 E0',                  // 清零挤出量
  ].join('\n') + '\n';
}

function buildEndCode() {
  return [
    'M107',          // 关风扇
    'M104 S0',       // 关喷嘴加热
    'M140 S0',       // 关热床加热
    'G28 X0 Y0',     // X/Y 回零让出空间
    'M84',           // 关电机
  ].join('\n') + '\n';
}

function buildCuraArgs(stlAbs, outAbs, o = {}) {
  const lh = num(o.layer_height, 0.2, 'layer_height');
  const flh = num(o.first_layer_height, 0.3, 'first_layer_height');
  const fd = num(o.filament_diameter, 1.75, 'filament_diameter');
  const nz = num(o.nozzle, 0.4, 'nozzle');
  const ew = o.extrusion_width !== undefined ? Number(o.extrusion_width) : nz;
  const infill = Math.max(0, Math.min(100, num(o.infill, 20, 'infill')));
  const speed = num(o.speed, 50, 'speed');
  const travel = num(o.travel_speed, 120, 'travel_speed');
  const walls = Math.max(1, Math.round(num(o.walls, 2, 'walls')));
  const skins = Math.max(0, Math.round(num(o.top_bottom_layers, 3, 'top_bottom_layers')));
  const nozzleTemp = num(o.nozzle_temp, 200, 'nozzle_temp');
  const bedTemp = num(o.bed_temp, 60, 'bed_temp');

  const args = [];
  const s = (k, v) => { args.push('-s', `${k}=${v}`); };

  s('layerThickness', Math.round(lh * 1000));
  s('initialLayerThickness', Math.round(flh * 1000));
  s('filamentDiameter', Math.round(fd * 1000));
  s('filamentFlow', 100);
  s('extrusionWidth', Math.round(ew * 1000));
  s('layer0extrusionWidth', Math.round(ew * 1000));
  s('insetCount', walls);
  s('upSkinCount', skins);
  s('downSkinCount', skins);
  s('printSpeed', Math.round(speed));
  s('infillSpeed', Math.round(speed));
  s('inset0Speed', Math.max(5, Math.round(speed * 0.6)));
  s('insetXSpeed', Math.round(speed));
  s('skinSpeed', Math.max(5, Math.round(speed * 0.6)));
  s('moveSpeed', Math.round(travel));
  s('initialLayerSpeed', Math.max(5, Math.round(speed * 0.5)));
  s('initialSpeedupLayers', 4);
  s('perimeterBeforeInfill', 1);
  s('infillOverlap', 15);
  s('retractionAmount', 4500);
  s('retractionSpeed', 25);
  s('minimalExtrusionBeforeRetraction', 1000);
  s('retractionMinimalDistance', 1500);
  s('enableCombing', 1);
  s('supportAngle', -1);            // -1 = 关闭支撑
  s('supportEverywhere', 0);
  s('fanSpeedMin', 100);
  s('fanSpeedMax', 100);
  s('fanFullOnLayerNr', 2);
  s('minimalLayerTime', 5);
  s('minimalFeedrate', 10);

  // 填充线距（μm）：100 × 线宽(mm) × 1000 / 填充率(%)
  s('sparseInfillLineDistance', infill <= 0 ? -1 : Math.round((100 * ew * 1000) / infill));

  // 附着方式：给了 brim_mm 就做 brim（skirtDistance=0），否则一圈 skirt
  const brim = o.brim_mm === undefined ? 0 : Number(o.brim_mm);
  if (brim > 0) {
    s('skirtDistance', 0);
    s('skirtLineCount', Math.max(1, Math.round(brim / ew)));
  } else {
    s('skirtDistance', 3000);
    s('skirtLineCount', 1);
    s('skirtMinLength', 150000);
  }

  s('startCode', buildStartCode(nozzleTemp, bedTemp));
  s('endCode', buildEndCode());

  args.push('-o', outAbs, stlAbs);
  return args;
}

async function sliceWithCura(stlAbs, outAbs, opts = {}) {
  if (!stlAbs || !fs.existsSync(stlAbs)) fail('STL 不存在：' + stlAbs);
  const engine = findCuraEngine(opts.enginePath || opts.cura_engine);
  if (!engine) {
    fail('未找到 CuraEngine。已尝试：\n  ' + CURA_CANDIDATES.join('\n  ') +
      '\n可用 cura_engine 参数指定 CuraEngine.exe 的绝对路径。');
  }
  const args = buildCuraArgs(stlAbs, outAbs, opts);
  try {
    const { stderr } = await execFileAsync(engine, args, {
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const log = String(stderr || '');
    const bad = log.split(/\r?\n/).filter((l) => /Failed to (set|read)/i.test(l));
    if (bad.length) fail('CuraEngine 设置报错：\n  ' + bad.slice(0, 5).join('\n  '));
    if (!fs.existsSync(outAbs)) fail('CuraEngine 未产出 G-code。引擎日志尾部：' + log.slice(-600));
    return { outputPath: outAbs, slicer: 'cura', engine, logTail: log.slice(-800) };
  } catch (err) {
    if (err && err.message && /^cura_slice:/.test(err.message)) throw err;
    fail('CuraEngine 切片失败：' + String((err && err.stderr) || err.message).slice(-800));
  }
}

module.exports = { sliceWithCura, findCuraEngine, buildCuraArgs, CURA_CANDIDATES };
