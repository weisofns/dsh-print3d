# 3D 打印工程 Agent（print3d-local）

面向 3D 打印与增材制造的全流程助手。预设 id：`print3d-local`，显示名：**3D 打印工程 Agent（本地版）**。

## 一句话说明

把「切片参数推荐、G-code 生成、脚本化建模、模型分析、打印诊断」这五件事，用一个会自己动手的 Agent 串起来：能读模型、能生成 G-code、能切片（配合 PrusaSlicer）、能估算时间耗材、能可视化刀路。

---

## 快速开始

1. 新建会话，预设选 **「3D 打印工程 Agent」**。
2. 直接说人话，例如：
   - 「给我一个 220→190℃ 的 PETG 温塔 G-code」
   - 「分析这个 STL 有没有洞、体积多大」
   - 「把这个模型按我的 Prusa 切片，告诉我打多久用多少料」
3. Agent 会在需要时自动加载对应技能（slicing / gcode / modeling / analysis / diagnosis）。

---

## 能力清单（5 个技能包）

| 技能 | 目录 | 作用 |
|---|---|---|
| slicing | `skills/slicing/` | 切片参数推荐：12 种材料参数表 + 层高/线宽/温度/回抽/冷却规则 |
| gcode | `skills/gcode/` | G-code 方言参考、起收尾脚本模板、估算口径 |
| modeling | `skills/modeling/` | OpenSCAD 脚本化建模 + 纯 Node 直接生成 STL |
| analysis | `skills/analysis/` | STL/G-code 分析指标判读、3MF 处理策略 |
| diagnosis | `skills/diagnosis/` | 10 类打印故障的「症状→原因→修复」决策树 |

技能文件为 `skills/<名称>/SKILL.md`，Agent 通过 `tool-skill` 按需加载。

---

## 脚本工具（零依赖 Node，5 个）

脚本位于 `scripts/` 目录。Agent 在会话里用 pwsh 运行：

```powershell
# 先确认家目录
$env:DSH_HOME
# 脚本路径 = ${DSH_HOME}/.agent-presets/print3d-local/scripts/<脚本>
```

### 1. stl_analyze.js —— STL 分析

```powershell
node "$env:DSH_HOME/.agent-presets/print3d-local/scripts/stl_analyze.js" model.stl
```

输出 JSON：包围盒、三角面数、体积、表面积、悬垂比例、非流形边、水密性。支持 ASCII + 二进制 STL。

### 2. gen_calibration_gcode.js —— 校准件 G-code 生成

```powershell
node .../gen_calibration_gcode.js --part cube        --size 20 --out cube.gcode
node .../gen_calibration_gcode.js --part temp-tower  --start 220 --end 180 --step 5 --out tower.gcode
node .../gen_calibration_gcode.js --part first-layer --size 60 --out first.gcode
node .../gen_calibration_gcode.js --part retraction  --out retract.gcode
node .../gen_calibration_gcode.js --part bridge      --out bridge.gcode
node .../gen_calibration_gcode.js --list
```

通用参数：`--nozzle 200 --bed 60 --layer-height 0.2 --line-width 0.4 --speed 40`。输出为 Marlin/Klipper 方言 G-code，自带安全起收尾（升温/关加热）。

### 3. gen_parametric_stl.js —— 参数化 STL 生成

```powershell
node .../gen_parametric_stl.js --shape box      --x 20 --y 20 --z 10 --out box.stl
node .../gen_parametric_stl.js --shape cylinder --d 20 --h 30 --out cyl.stl
node .../gen_parametric_stl.js --shape tube     --d 20 --id 6 --h 30 --out tube.stl
node .../gen_parametric_stl.js --shape sphere   --d 20 --out sphere.stl
node .../gen_parametric_stl.js --list
```

形状：box / cylinder / tube / sphere，输出为**水密** ASCII STL，可直接切片。

### 4. gcode_estimate.js —— G-code 估算

```powershell
node .../gcode_estimate.js model.gcode [--density 1.24]
```

输出 JSON：打印时间（匀速近似，实际约 1.1–1.3 倍）、耗材长度/质量、层数/层高、打印期最高温、打印范围。支持绝对/相对挤出（M82/M83）。

### 5. gcode_render.js —— G-code 刀路可视化

```powershell
node .../gcode_render.js model.gcode --out 预览.png [--size 1000]
```

输出 PNG 俯视图，按 `;TYPE:` 注释上色：

| 颜色 | 含义 |
|---|---|
| 红 | 外墙/内壁（perimeter） |
| 蓝 | 内部填充（internal infill） |
| 绿 | 实心填充/顶面/桥接 |
| 橙 | 裙边/底边（skirt/brim） |
| 紫 | 支撑（support） |
| 浅灰 | 空驶移动（不挤出） |

---

## 全流程示例（STL → 切片 → 分析 → 可视化）

```powershell
# 1. 生成模型
node .../gen_parametric_stl.js --shape box --x 25 --y 25 --z 10 --out part.stl
# 2. 切片（需安装 PrusaSlicer）
& "C:\Program Files\Prusa3D\PrusaSlicer\prusa-slicer-console.exe" --export-gcode --output part.gcode part.stl
# 3. 估算时间/耗材
node .../gcode_estimate.js part.gcode
# 4. 可视化刀路
node .../gcode_render.js part.gcode --out part_preview.png
```

---

## 依赖与边界（重要）

- **切片**：真实「任意模型 → G-code」需要切片器。本机已装 **PrusaSlicer**（`winget install Prusa3D.PrusaSlicer`），无头命令 `prusa-slicer-console --export-gcode --output out.gcode --load config.ini model.stl`。未装时，Agent 只能生成校准件/参数化件的 G-code，任意模型需装切片器。
- **OpenSCAD 渲染**：复杂 CSG 布尔渲染需 OpenSCAD CLI（`winget install OpenSCAD.OpenSCAD`）。基础 STL 可直接由 `gen_parametric_stl.js` 生成。
- **3MF**：是 zip+XML，纯 Node 无内置 zip 库，Agent 走「建议转 STL」或尽力读取。
- **零依赖**：所有脚本纯 Node 内置模块（`fs`/`zlib`），无 npm 依赖。

## 安全红线

- 打印涉及高温，任何参数与 G-code 都要**上机前人工核对**。
- 温度不超材料供应商推荐范围；ABS/ASA/尼龙等提醒通风与 VOC。
- 打印机型号或材料不明确时，Agent 会用 `tool-ask-user` 询问，不凭空假设。

---

## 待办（真机对接）

打印机到位后，补充具体机型与常用耗材，即可：
1. 在 PrusaSlicer 选定机型档案 + 耗材，导出配置包（`.ini`）。
2. 给 Agent 增加「按本机 Prusa 一键切片」技能（`--load 配置包 + --export-gcode`）。
