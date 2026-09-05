# dsh-print3d 🖨️

面向 DeepSeek Harness 的 **3D 打印 / 增材制造能力插件**：把「参数化建模、校准件 G-code、STL/G-code 分析、刀路可视化」封装成**一等模型工具**，并把「切片 / 建模 / 分析 / 诊断」知识封装成**技能**。

- 工具核心是**确定性、零依赖**的 Node 逻辑，进程内调用，不依赖系统 `node`；`print3d_slice` 是唯一例外——它桥接本机 PrusaSlicer（可选，未装则明确报错）。
- 技能是 Markdown 知识包，Agent 用 `tool-skill` 按需加载。
- 与配套预设 [`print3d`（3D 打印工程 Agent）](../print3d-preset/) 解耦：预设提供「人设 + 引导」，本插件提供「可复用的引擎」，任何预设都能用。

---

## 能力清单

### 模型工具（6 个，注册到全局 tools 注册表）

| 工具 | 作用 | 输入 → 输出 |
|---|---|---|
| `print3d_gen_parametric_stl` | 生成水密 ASCII STL（box/cylinder/tube/sphere），直接落盘 | 参数 → STL 文件 + 路径 |
| `print3d_gen_calibration_gcode` | 生成校准件 G-code（cube/temp-tower/first-layer/retraction/bridge），直接落盘 | 参数 → G-code 文件 + 路径 |
| `print3d_stl_analyze` | STL 包围盒/体积/表面积/悬垂/非流形/水密性 | STL 文本 → JSON |
| `print3d_gcode_estimate` | G-code 打印时间/耗材/层数/温度估算 | G-code 文本 → JSON |
| `print3d_gcode_render` | 刀路俯视图 PNG（原生图片块），支持 `output_path` | G-code 文本 → 图片块 / PNG 文件 |
| `print3d_slice` | 桥接本机 PrusaSlicer，把任意 STL 切成 G-code | STL 路径 → G-code 文件 |

生成类工具（STL/G-code/PNG）**默认直接落盘**到 `桌面/3Doutput/`（分 `stl` / `gcode` / `preview` 目录）并返回路径，避免把大段文本塞进上下文（对本地小模型尤其重要）；`print3d_stl_analyze`/`print3d_gcode_estimate` 返回 JSON，`print3d_slice` 是唯一调用外部进程的工具。

### 技能（5 个，注册到全局 skills 注册表）

| 技能 | 名称 | 内容 |
|---|---|---|
| 切片 | `print3d-slicing` | 12 种材料参数表 + 层高/线宽/温度/回抽/冷却规则 |
| G-code | `print3d-gcode` | Marlin/Klipper 方言、起收尾脚本、估算口径 |
| 建模 | `print3d-modeling` | OpenSCAD 写法 + 参数化 STL 生成 |
| 分析 | `print3d-analysis` | STL/G-code 指标判读、3MF 策略 |
| 诊断 | `print3d-diagnosis` | 10 类打印故障「症状→原因→修复」 |

### CLI 脚本（5 个，随包附带）

`scripts/` 下的脚本仍可独立作为 CLI 使用（`node scripts/xxx.cjs ...`），是工具之外的兜底/高级路径，也用于「任意模型 → 文件」的落盘工作流。

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
    tools/               # 6 个工具定义（一个能力一个文件）+ io.js 共享助手
  scripts/               # 5 个零依赖 Node 脚本（.cjs，CLI + 进程内可调用）
  skills/                # 5 个 SKILL.md 知识包
  MODULES.md             # 如何按模块化新增能力
```

## 如何扩展

见 [MODULES.md](./MODULES.md)。新增一个能力 = 新增一个脚本 + 一个工具定义（+ 可选一个技能 / 一个 persona 段），不用改动现有模块。

## 本地版（零 API 成本）

本插件自带一段**精简 persona**（`src/persona.js`，经 `systemPrompt.section` 注册），面向 Ollama + Qwen3 等本地小模型：短句、明确指令、直接点名工具，让 8B 模型也能稳定跑通工具链。

配合「3D 打印工程 Agent（本地版）」预设 + 本地 `ollama-local/qwen3:8b` 模型即可全程离线免费：

1. 启动 Ollama（模型已拉取：`qwen3:8b` 等）。
2. 新建会话，预设选「3D 打印工程 Agent（本地版）」。
3. 模型选 `ollama-local / qwen3:8b`（或设为默认）。

## 构建与发布

仓库 = 插件本体 + `presets/`（预设源码）+ 构建脚本。

- **打预设包**：`node build-dshpreset.mjs [preset-id ...]` —— 从 `presets/<id>/` 生成 `<id>-<版本>.dshpreset`（先 `npm install` 装 fflate；不传 id 则构建全部预设）。
- **打插件包**：`npm pack` —— 生成 `dsh-print3d-<版本>.tgz`。
- **自动发布**：push `v*` 标签（如 `v0.1.0`）触发 GitHub Actions，自动构建 `.dshpreset` + `.tgz` 并挂到对应 Release。

## 上架插件市场

社区市场 `awesome-dsh-plugin/awesome-dsh-plugin` 靠 PR 收录，投稿文件是一份 YAML，放 `data/plugins/<owner>__<repo>.yml`：

```yaml
url: https://github.com/<owner>/<repo>
name: <owner>/<repo>
category: tools    # 合法值见仓库 data/plugins/ 里的 category 分布
description:
  en: '一句话英文简介'
  zh: '一句话中文简介'
```

流程：给仓库加 `dsh-plugin` topic（让自动扫描发现）→ fork 市场仓库 → 新建 `add-<owner>-<repo>` 分支 → 放 yml 到 `data/plugins/` → push → 提 PR。本插件已照此提交（`weisofns__dsh-print3d.yml`，分支 `add-weisofns-dsh-print3d`）。

## License

[MIT](./LICENSE)
