#!/usr/bin/env node
/**
 * printer_profile.cjs — 打印机参数配置（单一数据源）。
 *
 * 配置文件：%USERPROFILE%\.print3d\printer.json
 * 窗口程序（tools/打印机设置.bat）与所有切片工具都读写这一份，保证「所见即所切」。
 *
 * CLI:
 *   node printer_profile.cjs --get                 # 打印当前配置（JSON）
 *   node printer_profile.cjs --set nozzle=0.6      # 改单项或多项
 *   node printer_profile.cjs --defaults            # 打印内置默认值
 *   node printer_profile.cjs --path                # 打印配置文件路径
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const PROFILE_DIR = path.join(HOME, '.print3d');
const PROFILE_PATH = path.join(PROFILE_DIR, 'printer.json');

// 内置默认值：与插件各工具的默认值保持一致
const DEFAULTS = Object.freeze({
  name: 'Prusa i3',
  material: 'PLA',
  firmware: 'Marlin',
  nozzle: 0.4,
  filament_diameter: 1.75,
  bed_width: 200,
  bed_depth: 200,
  bed_height: 180,
  slicer: 'auto',
  prusa_slicer_path: '',
  cura_engine_path: '',
  layer_height: 0.2,
  first_layer_height: 0.3,
  nozzle_temp: 200,
  bed_temp: 60,
  speed: 50,
  travel_speed: 120,
  infill: 20,
  walls: 2,
  top_bottom_layers: 3,
  brim_mm: 0,
});

const NUMERIC_KEYS = new Set([
  'nozzle', 'filament_diameter', 'bed_width', 'bed_depth', 'bed_height',
  'layer_height', 'first_layer_height', 'nozzle_temp', 'bed_temp',
  'speed', 'travel_speed', 'infill', 'walls', 'top_bottom_layers', 'brim_mm',
]);

function fail(msg) { throw new Error('printer_profile: ' + msg); }

function readRaw() {
  try {
    if (!fs.existsSync(PROFILE_PATH)) return {};
    const txt = fs.readFileSync(PROFILE_PATH, 'utf8').trim();
    if (!txt) return {};
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    fail('配置文件损坏（' + PROFILE_PATH + '）：' + e.message);
  }
}

// 返回「默认值 + 文件值」合并后的完整配置
function loadProfile() {
  const raw = readRaw();
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = NUMERIC_KEYS.has(k) ? Number(v) : v;
  }
  // 保留文件里额外的自定义字段，避免窗口程序升级后丢数据
  for (const k of Object.keys(raw)) {
    if (!(k in out)) out[k] = raw[k];
  }
  return out;
}

function coerce(key, value) {
  if (!NUMERIC_KEYS.has(key)) return String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${key} 必须是数值，收到 "${value}"`);
  return n;
}

// 合并写入（只覆盖传入的键）
function saveProfile(patch) {
  const current = readRaw();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    current[k] = coerce(k, v);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const tmp = PROFILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PROFILE_PATH);
  return loadProfile();
}

function parseArgs(argv) {
  const args = { set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--get' || a === '--defaults' || a === '--path' || a === '--init') args[a.slice(2)] = true;
    else if (a === '--set') {
      const kv = argv[++i];
      if (!kv || !kv.includes('=')) fail('--set 需要 key=value');
      const idx = kv.indexOf('=');
      args.set[kv.slice(0, idx)] = kv.slice(idx + 1);
    } else if (a === '--json') {
      const j = argv[++i];
      if (!j) fail('--json 需要 JSON 字符串');
      Object.assign(args.set, JSON.parse(j));
    }
  }
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.path) { console.log(PROFILE_PATH); return; }
    if (args.defaults) { console.log(JSON.stringify(DEFAULTS, null, 2)); return; }
    if (args.init) {
      if (fs.existsSync(PROFILE_PATH)) {
        console.log('已存在，未覆盖：' + PROFILE_PATH);
      } else {
        saveProfile(DEFAULTS);
        console.log('已写入默认配置：' + PROFILE_PATH);
      }
      return;
    }
    if (Object.keys(args.set).length) {
      const merged = saveProfile(args.set);
      console.log(JSON.stringify(merged, null, 2));
      return;
    }
    console.log(JSON.stringify(loadProfile(), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { DEFAULTS, NUMERIC_KEYS, PROFILE_PATH, PROFILE_DIR, loadProfile, saveProfile };
