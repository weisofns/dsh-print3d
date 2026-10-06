// 回归验证：printability / stl_analyze 朝向归一化 / 生成器绕序 / 打印结果诊断
// 自包含：不依赖仓库外的图片或 STL，直接 node verify_print3d.mjs
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseStlBuffer, parseAscii, analyze } = require('./scripts/stl_analyze.cjs');
const { generate } = require('./scripts/gen_parametric_stl.cjs');
const { generate: genImage } = require('./scripts/image_to_stl.cjs');
const { viewsToStl } = require('./scripts/views_to_stl.cjs');
const { generate: genCalibration } = require('./scripts/gen_calibration_gcode.cjs');
const { diagnose } = require('./scripts/print_diagnosis.cjs');
const { makePrintabilityTool } = await import('./src/tools/printability.js');
const { makeStlAnalyzeTool } = await import('./src/tools/stl-analyze.js');
const { makeDiagnosePrintTool } = await import('./src/tools/diagnose-print.js');

const ctxStub = { sessions: { get: () => undefined }, get: () => undefined };
const execStub = { agent: { id: 'verify' } };
// 外部真实模型（二进制 STL）是可选的：设 PRINT3D_TEST_STL_DIR 指向目录，缺失则跳过该组检查
const FIXTURE_DIR = process.env.PRINT3D_TEST_STL_DIR || 'C:/Users/14045/Desktop/Inception Top - 7414257/files/';
const NAMES = ['Base_Lower', 'Base_Upper', 'Top_Lower', 'Top_Upper'].map((n) => 'Inception_Top_-_' + n + '.stl');

let failures = 0;
function check(ok, label, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
}
function lossless(value, path = 'value') {
  if (value === undefined) return path + ' = undefined';
  if (typeof value === 'number') return Number.isFinite(value) ? null : path + ' = ' + value;
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return path + ' = ' + typeof value;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const e = lossless(value[i], path + '[' + i + ']'); if (e) return e; } return null; }
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return path + ' 非 plain 对象';
    for (const k of Object.keys(value)) { const e = lossless(value[k], path + '.' + k); if (e) return e; }
  }
  return null;
}
function signedVolume(tris) {
  let v6 = 0;
  for (const [a, b, c] of tris) v6 += a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0]);
  return v6 / 6;
}
// 合成一张最小 PNG（白矩形 + 黑底），供图片/三视图生成器测试，不依赖仓库外素材
function makePng(path, w, h, rect) {
  const row = Buffer.alloc(1 + w * 3);
  const raw = Buffer.alloc((1 + w * 3) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const inside = x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3];
      const v = inside ? 255 : 0;
      const p = off + 1 + x * 3;
      raw[p] = v; raw[p + 1] = v; raw[p + 2] = v;
    }
  }
  void row;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

console.log('1) printability：二进制 STL（外部样本，可选）');
const printTool = makePrintabilityTool(ctxStub);
if (!existsSync(FIXTURE_DIR)) {
  console.log('  跳过：未找到 ' + FIXTURE_DIR + '（可用环境变量 PRINT3D_TEST_STL_DIR 指定）');
} else {
  for (const n of NAMES) {
    const file = join(FIXTURE_DIR, n);
    if (!existsSync(file)) { console.log('  跳过：' + file); continue; }
    let out;
    try { out = await printTool.execute({ stl_path: file, layer_height: 0.2 }, execStub); }
    catch (err) { check(false, n, err.message); continue; }
    const bad = lossless(out);
    check(!bad && out.volume > 0, n, bad || ('体积 ' + (out.volume / 1000).toFixed(2) + ' cm³ · ' + out.triangles + ' 面 · 推荐 ' + out.best.name + ' ' + (out.best.overhangRatio * 100).toFixed(1) + '%'));
  }
}

console.log('2) stl_analyze：绕序朝内不改变悬垂判定');
const boxStl = generate({ shape: 'box', x: 30, y: 20, z: 10 }).stl;
const outward = parseAscii(boxStl).triangles;
function toAsciiStl(tris, name) {
  const lines = ['solid ' + name];
  for (const [a, b, c] of tris) {
    lines.push('  facet normal 0 0 0');
    lines.push('    outer loop');
    for (const p of [a, b, c]) lines.push('      vertex ' + p[0].toFixed(6) + ' ' + p[1].toFixed(6) + ' ' + p[2].toFixed(6));
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push('endsolid ' + name);
  return lines.join('\n') + '\n';
}
const inwardStl = toAsciiStl(outward.map(([a, b, c]) => [a, c, b]), 'inward');
const inward = parseStlBuffer(Buffer.from(inwardStl, 'utf8')).triangles;
const outA = analyze(outward), outB = analyze(inward);
check(outward.length === inward.length, '朝内 STL 构造成功', outward.length + ' 面');
check(outA.overhangRatio === outB.overhangRatio, '悬垂占比与绕序无关', outA.overhangRatio.toFixed(4) + ' / ' + outB.overhangRatio.toFixed(4));
check(outA.overhangArea === outB.overhangArea && outA.surfaceArea === outB.surfaceArea, '悬垂面积/表面积与绕序无关');
check(outA.normalsInverted === false && outB.normalsInverted === true, 'normalsInverted 判定正确', outA.normalsInverted + ' / ' + outB.normalsInverted);
check(Math.abs(outA.volume - outB.volume) < 1e-6, '体积与绕序无关', outA.volume + ' / ' + outB.volume);
const stlTool = makeStlAnalyzeTool(ctxStub);
const stlOut = await stlTool.execute({ stl_text: inwardStl });
check(!lossless(stlOut) && stlOut.normalsInverted === true, 'print3d_stl_analyze 返回 lossless JSON 且标记朝内', 'ratio ' + stlOut.overhangRatio);

console.log('3) 生成器绕序：全部朝外');
for (const [shape, extra] of [['box', {}], ['cylinder', {}], ['tube', {}], ['sphere', {}], ['cone', {}], ['rounded_box', {}], ['gear', {}], ['gear', { bore: 0 }]]) {
  const v = signedVolume(parseAscii(generate({ shape, ...extra }).stl).triangles);
  check(v > 0, 'gen ' + shape + (extra.bore === 0 ? '(bore=0)' : ''), 'signedVol ' + v.toFixed(1));
}
const png = join(tmpdir(), 'print3d-verify-shape.png');
makePng(png, 64, 64, [12, 16, 52, 48]);
for (const mode of ['extrude', 'lithophane']) {
  const r = await genImage({ imagePath: png, mode, width_mm: 40, depth_mm: 5 });
  const stl = typeof r === 'string' ? r : (r.stl || r.text);
  check(signedVolume(parseAscii(stl).triangles) > 0, 'image_to_stl ' + mode, '');
}
const vres = await viewsToStl({ frontPath: png, topPath: png, sidePath: png, width_mm: 40 });
const vstl = typeof vres === 'string' ? vres : (vres.stl || vres.text);
check(parseAscii(vstl).triangles.length > 0 && signedVolume(parseAscii(vstl).triangles) > 0, 'views_to_model', '');

console.log('4) print3d_diagnose_print');
const diagTool = makeDiagnosePrintTool(ctxStub);
const d1 = await diagTool.execute({ symptoms: '底部翘边，边缘不粘，角落拉丝', material: 'ABS', nozzle_temp: 240, bed_temp: 90, speed: 60, enclosure: false }, execStub);
check(!lossless(d1) && d1.ranked.length > 0, '文字症状 + 参数', 'Top1 ' + d1.ranked[0].name + '(' + d1.ranked[0].confidence + ')');
check(d1.paramFindings.some((f) => f.text.indexOf('保温罩') !== -1), '无保温罩被识别');
check(d1.ranked.some((r) => r.id === 'stringing'), '拉丝被识别');
check(d1.ranked.some((r) => r.id === 'warping'), '翘边被识别');
check(diagTool.output.render({}, d1)[0].text.indexOf('打印结果诊断') === 0, 'render 输出文本');
const gcodePath = join(tmpdir(), 'print3d-verify-cube.gcode');
const cal = genCalibration({ part: 'cube', size: 20 });
writeFileSync(gcodePath, typeof cal === 'string' ? cal : (cal.gcode || cal.text));
const d2 = await diagTool.execute({ symptoms: '层间开裂', material: 'PLA', gcode_path: gcodePath }, execStub);
check(!lossless(d2) && d2.gcodeFacts && Number.isFinite(d2.gcodeFacts.layers), '带 gcode_path 交叉核对', '层数 ' + d2.gcodeFacts.layers + ' 层高 ' + d2.gcodeFacts.layerHeight + ' 喷嘴 ' + d2.gcodeFacts.nozzleTemp + '℃');
// 引擎层：照片描述文字（视觉模型输出）直接进匹配器
const d3 = diagnose({ observations: '上表面有麻点，边缘翘边', material: 'PETG', nozzle_temp: 260, bed_temp: 70, dried: false });
check(lossless(d3) === null && d3.ranked.length >= 2, '视觉描述文本逐条命中', d3.ranked.map((r) => r.name).join(' / '));
check(d3.paramFindings.length >= 2, '温度与干燥问题都被识别', d3.paramFindings.map((f) => f.text).join(' / '));
// 照片路径：Ollama 不在时应给出 visionNote 而不是崩溃（在则给出识别结果）
const d4 = await diagTool.execute({ image_path: png, material: 'PLA', nozzle_temp: 205, bed_temp: 60 }, execStub);
check(!lossless(d4) && (d4.visionUsed === true || Boolean(d4.visionNote)), '照片路径给出识别结果或明确的不可用说明', d4.visionUsed ? '已识别' : 'visionNote');
let threw = null;
try { await diagTool.execute({ material: 'PLA' }, execStub); } catch (e) { threw = e.message; }
check(Boolean(threw), '既无照片也无症状时报错', threw || '');

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
