import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolveOutputPath, sessionCwd } from './io.js'

const require = createRequire(import.meta.url)
const { diagnose } = require('../../scripts/print_diagnosis.cjs')
const { describeImage } = require('../../scripts/ollama_vision.cjs')
const { estimate } = require('../../scripts/gcode_estimate.cjs')

// 专门问「缺陷」，而不是问「这是什么」——诊断要的是可判定的事实，不是物体描述。
const QC_PROMPT = [
  '你是 3D 打印质检员。看这张刚打印完的零件照片，用中文逐行回答，只写你确实看到的：',
  '1) 可见缺陷：从 [翘边/首层不粘, 拉丝, 层纹振纹, 层间分离开裂, 堵头挤出不足缺料, 大象脚首层外扩, 上表面麻点起泡, 过挤出, Z轴纹路, 首层起皱] 中挑选，可多选；确认没有就写「未见明显缺陷」',
  '2) 出现位置：底部/中部/顶部/侧面，写具体',
  '3) 严重程度：轻微/中等/严重',
  '4) 其他现象：翘曲、错层、缺料、支撑痕迹、尺寸偏差',
  '5) 照片看不清的地方：一句话',
].join('\n')

const pct = (v) => v.toFixed(1)

export function makeDiagnosePrintTool(ctx) {
  return {
    name: 'print3d_diagnose_print',
    description:
      '打印结果诊断：把「打印件照片 / 口述症状」+「材料与打印参数」变成按概率排序的故障疑因和修复动作。' +
      '有照片时先用本地视觉模型（Ollama qwen2.5vl）看缺陷，再对照材料温度/速度/层高窗口找参数侧证据；' +
      '给了 gcode_path 还会读切片文件的实际温度、层高、层数做交叉核对。' +
      '输出含证据、修复动作（一次只改一个变量）与安全提醒。需要本机 Ollama 才能看照片，纯文字症状不需要。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '打印件照片路径（绝对或相对工作区）；没有照片就只给 symptoms。' },
        symptoms: { type: 'string', description: '文字症状/现象描述，例如「底部翘边、角落拉丝」（可与照片同时给，作为补充）。' },
        material: { type: 'string', description: '材料：PLA/PETG/ABS/ASA/TPU/PA(尼龙)/PC/PVA。' },
        nozzle_temp: { type: 'number', description: '喷嘴温度 ℃。' },
        bed_temp: { type: 'number', description: '热床温度 ℃（不需要热床填 0）。' },
        layer_height: { type: 'number', description: '层高 mm。' },
        nozzle: { type: 'number', description: '喷嘴直径 mm（用于核对层高上限）。' },
        speed: { type: 'number', description: '打印速度 mm/s。' },
        enclosure: { type: 'boolean', description: '是否有保温罩/封箱（ABS/ASA/PA/PC 关键）。' },
        dried: { type: 'boolean', description: '耗材是否已干燥（PETG/PA/TPU/PVA 关键）。' },
        gcode_path: { type: 'string', description: '可选：切片得到的 .gcode 路径，用它的实际温度/层高/层数交叉核对。' },
        model: { type: 'string', description: 'Ollama 视觉模型名（默认 qwen2.5vl:7b；可选 qwen2.5vl:3b 更快）。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const lines = ['打印结果诊断：' + value.verdict]
        const p = value.usedParams || {}
        const bits = []
        if (value.material) bits.push('材料 ' + value.material)
        if (p.nozzle_temp) bits.push('喷嘴 ' + p.nozzle_temp + '℃')
        if (p.bed_temp) bits.push('热床 ' + p.bed_temp + '℃')
        if (p.layer_height) bits.push('层高 ' + p.layer_height + 'mm')
        if (p.speed) bits.push('速度 ' + p.speed + 'mm/s')
        if (p.enclosure === true) bits.push('有保温罩')
        if (p.enclosure === false) bits.push('无保温罩')
        if (bits.length) lines.push('输入参数：' + bits.join(' · '))
        if (value.observations) lines.push('照片识别：' + String(value.observations).replace(/\n/g, ' / '))
        if (value.visionNote) lines.push('视觉模型提示：' + value.visionNote)
        if (value.gcodeFacts) {
          const g = value.gcodeFacts
          const gb = []
          if (g.nozzleTemp) gb.push('喷嘴 ' + g.nozzleTemp + '℃')
          if (g.bedTemp) gb.push('热床 ' + g.bedTemp + '℃')
          if (g.layerHeight) gb.push('层高 ' + g.layerHeight + 'mm')
          if (g.layers) gb.push(g.layers + ' 层')
          if (gb.length) lines.push('G-code 实测：' + gb.join(' · '))
        }
        if (value.ranked && value.ranked.length) {
          lines.push('')
          value.ranked.forEach((r, i) => {
            lines.push((i + 1) + '. ' + r.name + '（置信 ' + r.confidence + '）')
            if (r.evidence && r.evidence.length) lines.push('   证据：' + r.evidence.join('；'))
            lines.push('   疑因：' + r.causes.slice(0, 3).join('；'))
            lines.push('   修复：' + r.fixes.slice(0, 4).join('；'))
          })
        }
        if (value.paramFindings && value.paramFindings.length) {
          lines.push('')
          lines.push('参数侧问题：')
          for (const f of value.paramFindings) lines.push('  [' + f.severity + '] ' + f.text + ' → ' + f.fix)
        }
        if (value.questions && value.questions.length) {
          lines.push('')
          lines.push('需要补充：' + value.questions.join('；'))
        }
        if (value.nextSteps && value.nextSteps.length) lines.push('下一步：' + value.nextSteps.join('；'))
        if (value.safety && value.safety.length) lines.push('安全：' + value.safety.join('；'))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec)
      let visionNote = null
      let observations = null
      let imageAbs = null

      if (args.image_path) {
        imageAbs = resolveOutputPath(args.image_path, cwd)
        if (!existsSync(imageAbs)) throw new Error('print3d_diagnose_print: 照片不存在：' + imageAbs)
        try {
          observations = await describeImage({ imagePath: imageAbs, question: QC_PROMPT, model: args.model })
        } catch (err) {
          visionNote = '照片未能识别（' + err.message + '）——本次仅按文字症状与参数诊断'
        }
      }

      let gcodeFacts = null
      let gcodeAbs = null
      if (args.gcode_path) {
        gcodeAbs = resolveOutputPath(args.gcode_path, cwd)
        if (!existsSync(gcodeAbs)) throw new Error('print3d_diagnose_print: G-code 不存在：' + gcodeAbs)
        try {
          const est = estimate(readFileSync(gcodeAbs, 'utf8'))
          gcodeFacts = {
            layers: est.layers,
            layerHeight: est.layerHeight,
            nozzleTemp: est.nozzleTemp,
            bedTemp: est.bedTemp,
            nozzleTempSequence: est.nozzleTempSequence,
            filamentGrams: est.filamentGrams,
            estimatedTimeHuman: est.estimatedTimeHuman,
          }
        } catch (err) {
          throw new Error('print3d_diagnose_print: G-code 解析失败：' + err.message)
        }
      }

      if (!args.image_path && !args.symptoms) {
        throw new Error('print3d_diagnose_print: 至少要给 image_path（打印件照片）或 symptoms（文字症状）之一。')
      }

      // G-code 里的实测值用于补全用户没给的温度/层高，避免漏检参数侧问题
      const nozzleTemp = Number.isFinite(Number(args.nozzle_temp))
        ? Number(args.nozzle_temp)
        : (gcodeFacts && gcodeFacts.nozzleTemp ? gcodeFacts.nozzleTemp : undefined)
      const bedTemp = Number.isFinite(Number(args.bed_temp))
        ? Number(args.bed_temp)
        : (gcodeFacts && gcodeFacts.bedTemp ? gcodeFacts.bedTemp : undefined)
      const layerHeight = Number.isFinite(Number(args.layer_height))
        ? Number(args.layer_height)
        : (gcodeFacts && gcodeFacts.layerHeight ? gcodeFacts.layerHeight : undefined)

      const result = diagnose({
        observations,
        symptoms: args.symptoms,
        material: args.material,
        nozzle_temp: nozzleTemp,
        bed_temp: bedTemp,
        layer_height: layerHeight,
        nozzle: args.nozzle,
        speed: args.speed,
        enclosure: args.enclosure,
        dried: args.dried,
        gcodeFacts,
      })

      const out = { ...result }
      out.visionUsed = Boolean(observations)
      if (visionNote) {
        out.visionNote = visionNote
        out.nextSteps = [...(out.nextSteps || []), '启动 Ollama（ollama serve）后重试照片识别，或改用 symptoms 描述现象']
      }
      if (imageAbs) out.imagePath = imageAbs
      if (gcodeAbs) out.gcodePath = gcodeAbs
      return out
    },
  }
}
