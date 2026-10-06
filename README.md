# dsh-print3d 🖨️

面向 DeepSeek Harness 的 **3D 打印 / 增材制造能力插件**：把「参数化建模、校准件 G-code、STL/G-code 分析、刀路可视化」封装成**一等模型工具**，并把「切片 / 建模 / 分析 / 诊断」知识封装成**技能**。

- 工具核心是**确定性、零依赖**的 Node 逻辑，进程内调用，不依赖系统 `node`；`print3d_slice` 是唯一例外——它桥接本机切片器，支持 **PrusaSlicer** 与 **CuraEngine**（`slicer=auto|prusa|cura`，两者都没装则明确报错）。
- 技能是 Markdown 知识包，Agent 用 `tool-skill` 按需加载。
- 与配套预设 [`print3d`（3D 打印工程 Agent）](../print3d-preset/) 解耦：预设提供「人设 + 引导」，本插件提供「可复用的引擎」，任何预设都能用。

---

## 能力清单

### 模型工具（14 个，注册到全局 tools 注册表）

**建模 / 生成**

| 工具 | 作用 | 输入 → 输出 |
|---|---|---|
| `print3d_gen_parametric_stl` | 生成水密 ASCII STL（box/cylinder/tube/sphere/cone/rounded_box/gear），直接落盘 | 参数 → STL 文件 + 路径 |
| `print3d_image_to_stl` | 图片转模型：`extrude` 剪影挤出 / `lithophane` 透光浮雕 / `engrave` 凹字 / `base_mm` 加底板 | 图片 → STL 文件 |
| `print3d_views_to_model` | CAD 三视图 → 3D 模型（剪影求交 = 视觉凸包）；支持单图自动切分或三张独立图 | 视图 → STL 文件 |
| `print3d_gen_calibration_gcode` | 生成校准件 G-code（cube/temp-tower/first-layer/retraction/bridge），直接落盘 | 参数 → G-code 文件 + 路径 |
| `print3d_parametric_print` | 一键：参数化建模 + 切片，返回 STL 与 G-code 两条路径 | 参数 → STL + G-code |

**切片**（`slicer=auto` 优先 PrusaSlicer，没有则用 CuraEngine）

| 工具 | 作用 | 输入 → 输出 |
|---|---|---|
| `print3d_slice` | 把任意 STL 切成 G-code；Cura 后端可调层高/耗材直径/喷嘴/填充/温度/速度/底边 | STL 路径 → G-code 文件 |

**分析 / 可视化**

| 工具 | 作用 | 输入 → 输出 |
|---|---|---|
| `print3d_stl_analyze` | STL 包围盒/体积/表面积/悬垂/非流形/水密性（法线朝向自动归一化，绕序朝内也判得对） | STL 文本 → JSON |
| `print3d_printability_check` | 可打印性预检：悬垂分档、6 朝向择优、床尺寸、翻倒风险、层数与耗材 | STL 路径 → JSON |
| `print3d_gcode_estimate` | G-code 打印时间/耗材/层数/温度序列估算 | G-code 文本 → JSON |
| `print3d_gcode_render` | 刀路俯视图 PNG（原生图片块），支持 `output_path` | G-code 文本 → 图片块 / PNG 文件 |
| `print3d_toolpath_map` | 刀路简图：四面板诊断图（俯视/侧视/首层/顶层 + 图例），供 Agent 自己检视切片结果 | G-code 路径/文本 → 图片块 + PNG |

**诊断 / 视觉辅助 / 配置**

| 工具 | 作用 | 输入 → 输出 |
|---|---|---|
| `print3d_diagnose_print` | 打印结果诊断：打印件照片（本机视觉模型）/ 文字症状 + 材料温度速度 → 按概率排序的疑因、证据、修复动作；可带 `gcode_path` 交叉核对实际参数 | 照片/症状/参数 → JSON |
| `print3d_image_describe` | 借本机视觉模型（Ollama `qwen2.5vl`）描述图片，供无视觉能力的本地文本模型使用 | 图片 → 结构化文字 |
| `print3d_printer_profile` | 打印机参数单一数据源（喷嘴/耗材/床/温度/速度/切片后端），切片与预检的默认值来源 | 读/写 → 配置 JSON |

生成类工具（STL/G-code/PNG）**默认直接落盘**到 `桌面/3Doutput/`（分 `stl` / `gcode` / `preview` 目录）并返回路径，避免把大段文本塞进上下文（对本地小模型尤其重要）；`print3d_stl_analyze`/`print3d_gcode_estimate` 返回 JSON，`print3d_slice` 是唯一调用外部进程的工具。

### 技能（5 个，注册到全局 skills 注册表）

| 技能 | 名称 | 内容 |
|---|---|---|
| 切片 | `print3d-slicing` | 12 种材料参数表 + 层高/线宽/温度/回抽/冷却规则 |
| G-code | `print3d-gcode` | Marlin/Klipper 方言、起收尾脚本、估算口径 |
| 建模 | `print3d-modeling` | OpenSCAD 写法 + 参数化 STL 生成 |
| 分析 | `print3d-analysis` | STL/G-code 指标判读、3MF 策略 |
| 诊断 | `print3d-diagnosis` | 10 类打印故障「症状→原因→修复」 |

### CLI 脚本（13 个，随包附带）

`scripts/` 下的脚本仍可独立作为 CLI 使用（`node scripts/xxx.cjs ...`），是工具之外的兜底/高级路径，也用于「任意模型 → 文件」的落盘工作流。

| 脚本 | 作用 |
|---|---|
| `stl_analyze.cjs` | STL 包围盒/体积/水密性分析 |
| `gen_parametric_stl.cjs` | 参数化 STL 生成 |
| `gen_calibration_gcode.cjs` | 校准件 G-code 生成 |
| `gcode_estimate.cjs` | G-code 时间/耗材估算 |
| `gcode_render.cjs` | 刀路俯视图渲染（同时兼容 PrusaSlicer 与 Cura 的 `;TYPE:` 命名） |
| `gcode_map.cjs` | 刀路简图（四面板诊断） |
| `image_to_stl.cjs` | 图片 → STL（挤出/浮雕/凹字） |
| `views_to_stl.cjs` | 三视图 → STL（视觉凸包 + 单图自动切分） |
| `print_diagnosis.cjs` | 打印结果诊断引擎（缺陷关键字 + 材料参数窗口 → 排序疑因与修复） |
| `printability.cjs` | 可打印性预检（悬垂分档 / 朝向择优 / 翻倒风险） |
| `printer_profile.cjs` | 打印机参数读写（单一数据源） |
| `ollama_vision.cjs` | 调本地 Ollama 视觉模型描述图片 |
| `cura_slice.cjs` | CuraEngine 切片后端 |

> `cura_slice.cjs` 适配的是 **Cura 15.04（Cura_SteamEngine）**。三个实测得到的坑：设置键名必须是 camelCase 且长度单位为**微米整数**（`layerThickness=200` 表示 0.2mm），用 Cura 界面 `resources/*.ini` 里的 snake_case 名会被引擎拒绝（`Failed to set`）；`resources/machine_profiles/*.ini` 带 `[section]` 段头，不能直接喂给 `-c`；**温度不在 `-s` 项里**，只能通过 `startCode`/`endCode` 注入。

---

## 安装

完全退出 DSH 后，进入 DSH 安装目录：

```powershell
pnpm exec dsh plugin --profile web add dsh-print3d
# 或本地包
pnpm exec dsh plugin --profile web add "C:\path\to\dsh-print3d"
```

重启 DSH。安装后，任意预设的 Agent 都能直接调用 `print3d_*` 工具、加载 `print3d-*` 技能。

> 依赖：标准 DSH 主机组合已提供 `tools` 与 `skills` 注册表（`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-skill`），本插件无需额外 npm 依赖。

---

## 快速使用

```text
用户：给我一个 20×20×10 的方块 STL，再生成它的校准 G-code，估算打印时间。
```

Agent 流程：

1. `print3d_gen_parametric_stl(shape="box", x=20, y=20, z=10)` → STL 文本 → `write` 落盘 `part.stl`
2. `print3d_gen_calibration_gcode(part="cube", size=20)` → G-code 文本 → `write` 落盘 `part.gcode`
3. `print3d_gcode_estimate(gcode_text=...)` → 时间/耗材/层数

---

## 安全红线

- 打印涉及高温：任何参数与 G-code 交付前都**提示上机前人工核对**，不声称绝对安全。
- 温度不超过材料供应商推荐范围；ABS/ASA/尼龙等提醒通风与 VOC。
- 打印机型号 / 材料 / 固件（Marlin/Klipper）不明确时先询问，不凭空假设。

---

## 目录结构

```text
dsh-print3d/
  package.json           # 插件清单 + dsh.bundle.patch
  cordis.patch.yml       # 把插件行插入主机组合
  src/
    index.js             # 插件入口：注册工具 + 技能 + persona
    skills.js            # 从 skills/ 读取并注册 5 个技能
    persona.js           # 精简 persona（systemPrompt 段，面向本地小模型）
    tools/               # 14 个工具定义（一个能力一个文件）+ io.js 共享助手
  scripts/               # 14 个零依赖 Node 脚本（.cjs，CLI + 进程内可调用）
  skills/                # 5 个 SKILL.md 知识包
  MODULES.md             # 如何按模块化新增能力
  verify_print3d.mjs     # 自包含回归：解析/绕序/生成器/诊断（node verify_print3d.mjs）
```

## 如何扩展

见 [MODULES.md](./MODULES.md)。新增一个能力 = 新增一个脚本 + 一个工具定义（+ 可选一个技能 / 一个 persona 段），不用改动现有模块。

## 本地版（零 API 成本）

本插件自带一段**精简 persona**（`src/persona.js`，经 `systemPrompt.section` 注册），面向 Ollama + Qwen3 等本地小模型：短句、明确指令、直接点名工具，让 8B 模型也能稳定跑通工具链。

配合「3D 打印工程 Agent（本地版）」预设 + 本地 `ollama-local/qwen3:8b` 模型即可全程离线免费：

1. 启动 Ollama（模型已拉取：`qwen3:8b` 等）。
2. 新建会话，预设选「3D 打印工程 Agent（本地版）」。
3. 模型选 `ollama-local / qwen3:8b`（或设为默认）。

## License

[MIT](./LICENSE)
