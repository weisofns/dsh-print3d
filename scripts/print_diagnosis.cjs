#!/usr/bin/env node
/**
 * print_diagnosis.cjs — 打印结果诊断引擎（零依赖）。
 *
 * 输入：打印件照片的视觉描述文字 / 用户口述症状 + 打印参数（材料、温度、层高、速度、有无保温）。
 * 输出：按概率排序的疑因 → 每个疑因的证据 → 修复动作（一次只改一个变量）+ 安全提醒。
 *
 * 知识来源与 skills/diagnosis/SKILL.md 一致，这里是它的可执行版本：确定性、无网络、可回放。
 *
 * CLI:
 *   node print_diagnosis.cjs --symptoms "底部翘边，边缘不粘" --material ABS --nozzle-temp 240 --bed-temp 90
 *   node print_diagnosis.cjs --observations "表面有细密横向纹路" --material PLA --speed 120
 */
'use strict';

function fail(msg) { throw new Error('print_diagnosis: ' + msg); }

// 材料窗口：nozzle/bed 为建议区间（℃），enclosure=true 表示收缩大、建议保温罩，
// dry=true 表示吸湿敏感（PETG/PA/TPU 等），speedMax 为常规热端下的速度上限（mm/s）。
const MATERIALS = {
  PLA:  { nozzle: [190, 220], bed: [50, 65],  enclosure: false, dry: false, speedMax: 100, label: 'PLA' },
  PETG: { nozzle: [230, 250], bed: [75, 85],  enclosure: false, dry: true,  speedMax: 80,  label: 'PETG' },
  ABS:  { nozzle: [240, 265], bed: [95, 110], enclosure: true,  dry: false, speedMax: 80,  label: 'ABS' },
  ASA:  { nozzle: [240, 265], bed: [90, 110], enclosure: true,  dry: false, speedMax: 80,  label: 'ASA' },
  TPU:  { nozzle: [210, 235], bed: [40, 60],  enclosure: false, dry: true,  speedMax: 40,  label: 'TPU' },
  PA:   { nozzle: [250, 280], bed: [90, 110], enclosure: true,  dry: true,  speedMax: 60,  label: 'PA(尼龙)' },
  PC:   { nozzle: [260, 290], bed: [100, 120],enclosure: true,  dry: true,  speedMax: 60,  label: 'PC' },
  PVA:  { nozzle: [190, 210], bed: [45, 60],  enclosure: false, dry: true,  speedMax: 60,  label: 'PVA' },
};
const MATERIAL_ALIAS = {
  NYLON: 'PA', '尼龙': 'PA', '聚乳酸': 'PLA', 'ABS+': 'ABS', 'PLA+': 'PLA', 'PETG-CF': 'PETG',
};

// 10 类常见打印缺陷：keywords 用于匹配照片描述/口述症状；paramFindings 用于参数侧证据。
const DEFECTS = [
  {
    id: 'warping', name: '翘边 / 首层不粘',
    keywords: ['翘边', '翘曲', '翘起', '不粘', '未粘', '脱层', '边缘翘', '底面变形', 'warp', 'warping', 'adhesion', 'curl'],
    causes: [
      '热床温度偏低，或首层 Z 偏移过高（喷嘴离床太远）',
      '床面有油污/灰尘，附着力不足',
      '首层风扇开启或冷却过早',
      '材料收缩大（ABS/ASA/PC/PA）且无保温罩',
    ],
    fixes: ['调平热床并校准 Z 偏移', '热床 +5~10℃', '首层风扇关闭，第二层起再开', '酒精清洁床面或上胶水/美纹纸', '加 brim（5~8mm）', 'ABS/ASA/PC/PA 加保温罩'],
  },
  {
    id: 'stringing', name: '拉丝 / 渗料',
    keywords: ['拉丝', '毛丝', '丝状', '渗料', '垂丝', 'stringing', 'string', 'oozing', 'whisker'],
    causes: ['回抽距离/速度不足', '喷嘴温度偏高', '移动路径跨空且未开「避免跨空」', '耗材吸湿（PETG/PA/TPU/PVA）'],
    fixes: ['加大回抽（远程 3→7mm，直驱 0.5→2mm）', '喷嘴 -5~10℃', '开启 avoid-crossing / combing', '干燥耗材（60~70℃ 4~6h）'],
  },
  {
    id: 'ringing', name: '层纹 / 振纹 (ringing)',
    keywords: ['层纹', '振纹', '波纹', '鬼影', 'ringing', 'ghosting', '振铃', '竖纹'],
    causes: ['打印速度/加速度过高', '机械松动（皮带、滑轮、热床）', '质量集中在喷头附近导致惯性抖动'],
    fixes: ['速度降 20~40%', '降低加速度/急动度（jerk）', '紧固皮带与导轨偏心轮', '把模型远离床边、减轻惯性'],
  },
  {
    id: 'layer_separation', name: '层间分离 / 开裂',
    keywords: ['层间分离', '层裂', '开裂', '分层', '断裂', 'delamination', 'split', '层粘不牢', '一掰就裂'],
    causes: ['喷嘴温度偏低，层间没熔合', '层高过大（超过喷嘴直径 75%）', '冷却风扇过强 / 环境温度低', '材料收缩大且无保温'],
    fixes: ['喷嘴 +5~15℃', '层高回到 0.75×喷嘴直径以内', '风扇降到 30~50%', 'ABS/ASA/PC/PA 加保温罩'],
  },
  {
    id: 'clogging', name: '堵头 / 挤出不足（缺料）',
    keywords: ['缺料', '挤出不足', '堵头', '堵嘴', '断续', '断料', '空隙', '孔洞', 'underextrusion', 'under-extrusion', 'clog', 'gaps'],
    causes: ['喷嘴部分堵塞或碳化积料', '挤出机打滑/张力不足', '打印温度低于材料下限', '速度超出热端流量上限（层高×线宽×速度过大）'],
    fixes: ['冷拉（cold pull）清理喷嘴', '检查并调紧挤出机张力/更换齿轮', '喷嘴 +5~15℃', '降速或降层高（体积流量 ≤ 热端上限）', '碳纤/玻纤料换硬化钢喷嘴'],
  },
  {
    id: 'elephants_foot', name: '大象脚（首层外扩）',
    keywords: ['大象脚', '象脚', '首层外扩', '底边外翻', 'elephant', 'elephants foot', '第一层变宽'],
    causes: ['首层 Z 偏移过低（喷嘴离床太近）', '热床温度过高', '首层层高/流量过大'],
    fixes: ['抬高 Z 偏移 0.02~0.05mm', '热床 -5℃', '首层层高设为 0.2mm 左右', 'PrusaSlicer 开「首层水平补偿」0.1~0.2mm'],
  },
  {
    id: 'pillowing', name: '上表面麻点 / 起泡（pillowing）',
    keywords: ['麻点', '起泡', '顶部不平', '上表面有洞', 'pillowing', 'rough top', '顶面凹陷'],
    causes: ['顶层实心层数不足', '填充率过低导致顶面塌陷', '顶层冷却不足'],
    fixes: ['顶层实心层数 ≥ 5', '填充率提高到 15~25%', '顶层风扇 100%', '适当降低顶层速度'],
  },
  {
    id: 'over_extrusion', name: '过挤出（表面鼓包 / 尺寸偏大）',
    keywords: ['过挤出', '鼓包', '堆料', '尺寸偏大', '表面粗糙凸起', 'overextrusion', 'over-extrusion', 'blob'],
    causes: ['流量倍率过高', '线宽设置超过喷嘴能力', 'E-steps 未校准'],
    fixes: ['流量 100% → 95% 试', '校准 E-steps', '线宽回到 100~110% 喷嘴直径'],
  },
  {
    id: 'z_banding', name: 'Z 轴纹路（Z banding）',
    keywords: ['z纹', 'z 纹', 'z轴纹', '层高不均', 'banding', 'z wobble', '规律竖纹'],
    causes: ['Z 丝杆弯曲/不同心', '联轴器松动', 'Z 步进/螺距配置不匹配'],
    fixes: ['检查丝杆直线度与联轴器紧固', '丝杆清洁润滑', '核对 Z 步进/螺距参数', '检查 Z 轴是否受挤压卡滞'],
  },
  {
    id: 'first_layer_ripple', name: '首层起皱 / 波浪',
    keywords: ['首层起皱', '首层波浪', '起皱', '褶皱', 'ripple', '第一层波浪'],
    causes: ['喷嘴离床过近（首层被压出波浪）', '首层挤出过量', '床面有油污或残料'],
    fixes: ['抬高 Z 偏移', '首层流量降到 95%', '清洁床面'],
  },
];

const DEFECT_BY_ID = new Map(DEFECTS.map((d) => [d.id, d]));

function normalizeMaterial(m) {
  if (!m) return null;
  const raw = String(m).trim();
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (MATERIALS[up]) return up;
  for (const [alias, key] of Object.entries(MATERIAL_ALIAS)) {
    if (up === alias.toUpperCase()) return key;
  }
  for (const key of Object.keys(MATERIALS)) {
    if (up.startsWith(key)) return key;
  }
  return null;
}

// 参数侧证据：每条带 severity + 指向的缺陷 id + 一句修复动作。
function checkParams(ctx) {
  const out = [];
  const m = ctx.materialKey;
  const win = m ? MATERIALS[m] : null;
  if (win) {
    if (Number.isFinite(ctx.nozzleTemp) && ctx.nozzleTemp > 0) {
      if (ctx.nozzleTemp < win.nozzle[0]) {
        out.push({ severity: 'warn', defects: ['layer_separation', 'clogging'],
          text: '喷嘴 ' + ctx.nozzleTemp + '℃ 低于 ' + win.label + ' 建议下限 ' + win.nozzle[0] + '℃',
          fix: '喷嘴升到 ' + win.nozzle[0] + '~' + win.nozzle[1] + '℃（先 +5℃ 试）' });
      } else if (ctx.nozzleTemp > win.nozzle[1]) {
        out.push({ severity: 'warn', defects: ['stringing', 'clogging'],
          text: '喷嘴 ' + ctx.nozzleTemp + '℃ 高于 ' + win.label + ' 建议上限 ' + win.nozzle[1] + '℃',
          fix: '喷嘴降到 ' + win.nozzle[0] + '~' + win.nozzle[1] + '℃（先 -5℃ 试）；高温易碳化堵嘴、拉丝' });
      }
    }
    if (Number.isFinite(ctx.bedTemp) && ctx.bedTemp > 0) {
      if (ctx.bedTemp < win.bed[0]) {
        out.push({ severity: 'warn', defects: ['warping'],
          text: '热床 ' + ctx.bedTemp + '℃ 低于 ' + win.label + ' 建议下限 ' + win.bed[0] + '℃',
          fix: '热床升到 ' + win.bed[0] + '~' + win.bed[1] + '℃' });
      } else if (ctx.bedTemp > win.bed[1]) {
        out.push({ severity: 'info', defects: ['elephants_foot'],
          text: '热床 ' + ctx.bedTemp + '℃ 高于 ' + win.label + ' 建议上限 ' + win.bed[1] + '℃',
          fix: '热床降 5℃ 可缓解大象脚' });
      }
    }
    if (win.enclosure && ctx.enclosure === false) {
      out.push({ severity: 'warn', defects: ['warping', 'layer_separation'],
        text: win.label + ' 收缩大，但未使用保温罩',
        fix: '加保温罩（或封箱）并调低环境气流；' + win.label + ' 打印请注意通风与 VOC 防护' });
    }
    if (win.dry && ctx.dried === false) {
      out.push({ severity: 'info', defects: ['stringing'],
        text: win.label + ' 吸湿敏感，且未做干燥处理',
        fix: '耗材干燥（60~70℃ / 4~6h）后再打印，拉丝与气泡会明显减少' });
    }
    if (Number.isFinite(ctx.speed) && ctx.speed > win.speedMax) {
      out.push({ severity: 'warn', defects: ['ringing', 'clogging'],
        text: '速度 ' + ctx.speed + 'mm/s 超过 ' + win.label + ' 常规上限 ' + win.speedMax + 'mm/s',
        fix: '速度降到 ' + Math.round(win.speedMax * 0.6) + '~' + win.speedMax + 'mm/s，并复核体积流量' });
    }
  }
  if (Number.isFinite(ctx.layerHeight) && Number.isFinite(ctx.nozzleDiameter) && ctx.nozzleDiameter > 0) {
    const limit = 0.75 * ctx.nozzleDiameter;
    if (ctx.layerHeight > limit) {
      out.push({ severity: 'warn', defects: ['layer_separation', 'clogging'],
        text: '层高 ' + ctx.layerHeight + 'mm 超过 0.75×喷嘴(' + ctx.nozzleDiameter + 'mm)=' + limit.toFixed(2) + 'mm',
        fix: '层高降到 ' + limit.toFixed(2) + 'mm 以内（' + ctx.nozzleDiameter + 'mm 喷嘴常用 0.2~0.28mm）' });
    }
  }
  return out;
}

// 文字侧匹配：症状描述（照片描述 + 用户口述）里出现的缺陷关键字。
function matchText(haystack) {
  const hay = String(haystack || '').toLowerCase();
  const hits = [];
  if (!hay.trim()) return hits;
  for (const d of DEFECTS) {
    const kw = d.keywords.filter((k) => hay.includes(k.toLowerCase()));
    if (kw.length) hits.push({ id: d.id, keywords: kw });
  }
  return hits;
}

function confidenceOf(score) {
  if (score >= 5) return '高';
  if (score >= 3) return '中';
  return '低';
}

// 参数名兼容：工具走 snake_case（nozzle_temp），CLI 解析后是 camelCase（nozzleTemp）。
function pickNum(obj, names) {
  for (const n of names) {
    const v = Number(obj[n]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

// 主入口：合并「照片/口述证据」与「参数证据」，按分数排序输出。
function diagnose(input) {
  const ctx = {
    materialKey: normalizeMaterial(input.material),
    nozzleTemp: pickNum(input, ['nozzle_temp', 'nozzleTemp']),
    bedTemp: pickNum(input, ['bed_temp', 'bedTemp']),
    layerHeight: pickNum(input, ['layer_height', 'layerHeight']),
    nozzleDiameter: pickNum(input, ['nozzle', 'nozzleDiameter']),
    speed: pickNum(input, ['speed']),
    enclosure: typeof input.enclosure === 'boolean' ? input.enclosure : null,
    dried: typeof input.dried === 'boolean' ? input.dried : null,
  };
  const observationText = [input.observations, input.symptoms].filter(Boolean).join(' ');
  const textHits = matchText(observationText);
  const paramFindings = checkParams(ctx);

  const scores = new Map();
  const evidence = new Map();
  function add(id, why, weight) {
    scores.set(id, (scores.get(id) || 0) + weight);
    if (!evidence.has(id)) evidence.set(id, []);
    if (why && evidence.get(id).indexOf(why) === -1) evidence.get(id).push(why);
  }
  for (const hit of textHits) {
    add(hit.id, '照片/描述命中关键字：' + hit.keywords.join('、'), 2 + Math.min(hit.keywords.length, 2));
  }
  for (const f of paramFindings) {
    for (const id of f.defects) add(id, '参数：' + f.text, 3);
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, score]) => {
      const d = DEFECT_BY_ID.get(id);
      return {
        id, name: d.name, score, confidence: confidenceOf(score),
        evidence: evidence.get(id) || [],
        causes: d.causes, fixes: d.fixes,
      };
    });

  const questions = [];
  if (!ctx.materialKey) questions.push('用的什么材料？（PLA/PETG/ABS/ASA/TPU/PA/PC）');
  if (!Number.isFinite(ctx.nozzleTemp) || ctx.nozzleTemp <= 0) questions.push('喷嘴温度是多少？');
  if (!Number.isFinite(ctx.bedTemp) || ctx.bedTemp <= 0) questions.push('热床温度是多少？');
  if (ctx.materialKey && MATERIALS[ctx.materialKey].enclosure && ctx.enclosure === null) {
    questions.push('有没有保温罩/封箱？');
  }
  if (!Number.isFinite(ctx.speed)) questions.push('打印速度（mm/s）是多少？');

  const safety = [];
  if (ctx.materialKey && MATERIALS[ctx.materialKey].enclosure) {
    safety.push(MATERIALS[ctx.materialKey].label + ' 打印有气味/VOC，请保持通风；取件戴手套，避免烫伤');
  }
  safety.push('任何温度/速度改动，改完先打小样验证；上机前人工核对');

  let verdict;
  if (ranked.length === 0) {
    verdict = observationText.trim()
      ? '未匹配到已知缺陷模式：请补充更具体的现象（位置/形态）或照片。'
      : '没有可诊断的输入：请给一张打印件照片，或用 symptoms 描述现象。';
  } else {
    verdict = '最可能：' + ranked[0].name + '（' + ranked[0].confidence + '），共 ' + ranked.length + ' 项疑因待排查。';
  }

  const nextSteps = [];
  if (ranked.length) {
    nextSteps.push('按上面的顺序先查第 1 项，一次只改一个变量，改完打小样对比');
    nextSteps.push('把最可能的 1~2 个修复动作写进切片配置后重打，再拍照复查');
  }
  for (const q of questions.slice(0, 3)) nextSteps.push('补充信息：' + q);

  return sanitize({
    verdict,
    observations: input.observations ? String(input.observations) : null,
    symptoms: input.symptoms ? String(input.symptoms) : null,
    material: ctx.materialKey,
    usedParams: {
      nozzle_temp: Number.isFinite(ctx.nozzleTemp) && ctx.nozzleTemp > 0 ? ctx.nozzleTemp : null,
      bed_temp: Number.isFinite(ctx.bedTemp) && ctx.bedTemp > 0 ? ctx.bedTemp : null,
      layer_height: Number.isFinite(ctx.layerHeight) ? ctx.layerHeight : null,
      nozzle: Number.isFinite(ctx.nozzleDiameter) ? ctx.nozzleDiameter : null,
      speed: Number.isFinite(ctx.speed) ? ctx.speed : null,
      enclosure: ctx.enclosure,
    },
    ranked,
    paramFindings: paramFindings.map((f) => ({ severity: f.severity, text: f.text, fix: f.fix })),
    gcodeFacts: input.gcodeFacts || null,
    questions,
    nextSteps,
    safety,
  });
}

// 工具返回值必须是 lossless JSON：递归丢掉 undefined，非有限数字转 null。
function sanitize(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) continue;
    const key = x.slice(2);
    const v = argv[++i];
    if (v === undefined) fail('--' + key + ' 缺少值');
    if (key === 'enclosure' || key === 'dried') a[key] = v === 'true' || v === '1' || v === 'yes';
    else a[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return a;
}

function main() {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (!a.symptoms && !a.observations) fail('至少要给 --symptoms 或 --observations 之一');
    const out = diagnose(a);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { diagnose, checkParams, matchText, normalizeMaterial, MATERIALS, DEFECTS };
