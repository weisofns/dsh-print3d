---
name: gcode
description: Use when generating, writing, or interpreting 3D printer G-code (Marlin/Klipper dialect), building safe start/end scripts, or estimating print time and filament usage from a G-code file.
---

# G-code 生成与解读

本技能覆盖 Marlin / Klipper 方言的 G-code：生成校准件、起收尾脚本，以及估算打印时间/耗材。

## 助手脚本（确定性生成，优先用）

脚本位于本预设 `scripts/` 目录，用 pwsh 运行（先 `$env:DSH_HOME` 确认家目录）：

```powershell
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_calibration_gcode.js" --part cube --size 20 --out cube.gcode
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_calibration_gcode.js" --part temp-tower --start 220 --end 180 --step 5 --out tower.gcode
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_calibration_gcode.js" --part first-layer --size 60 --out first.gcode
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_calibration_gcode.js" --part retraction --out retract.gcode
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_calibration_gcode.js" --part bridge --out bridge.gcode
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_calibration_gcode.js" --list
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gcode_estimate.js" model.gcode [--density 1.24]
```

通用参数：`--nozzle 200 --bed 60 --layer-height 0.2 --line-width 0.4 --speed 40`。

## 常用命令速查

| 命令 | 含义 |
|---|---|
| G0/G1 X.. Y.. Z.. E.. F.. | 移动/挤出（F 单位 mm/min） |
| G21 / G20 | 单位 mm / inch |
| G28 | 归零（`G28 X Y` 只归 XY） |
| G90 / G91 | 绝对 / 相对定位 |
| G92 X.. Y.. Z.. E.. | 设当前坐标（`G92 E0` 复位挤出） |
| M82 / M83 | 绝对 / 相对挤出 |
| M104 S<℃> / M109 S<℃> | 设喷头温度 / 设并等待 |
| M140 S<℃> / M190 S<℃> | 设热床温度 / 设并等待 |
| M106 S<0-255> / M107 | 风扇开（PWM）/ 关 |
| M84 | 释放电机 |
| M0 / M25 | 暂停 |

## 起手 G-code 模板（安全，Marlin）

```gcode
G21            ; 单位 mm
G90            ; 绝对坐标
M82            ; 绝对挤出
M140 S60       ; 热床预热
M104 S200      ; 喷头预热
G28            ; 归零
M190 S60       ; 等待热床
M109 S200      ; 等待喷头
G92 E0
; 擦嘴线
G1 Z0.3 F600
G1 X5 Y5 F3000
G1 X5 Y45 E2.0 F600
G92 E0
```

## 收尾 G-code 模板

```gcode
G91            ; 相对坐标
G1 E-2 F1800   ; 回抽 2mm
G1 Z+5 F600    ; 抬升
G90            ; 绝对坐标
G1 X0 Y200 F6000
M104 S0        ; 喷头关
M140 S0        ; 热床关
M107           ; 风扇关
M84            ; 电机释放
```

## 估算口径（本脚本采用）

- 打印时间 = Σ(移动距离 ÷ 进给速度)，**匀速近似**，忽略加减速，实际约为此值的 1.1–1.3 倍。
- 耗材体积 = 挤出长度 E(mm) × π×(1.75/2)²。
- 质量 = 体积 × 密度（PLA 1.24、PETG 1.27、ABS 1.04、TPU 1.21、PA 1.14 g/cm³）。

## 安全红线

- G-code 交付前**必须**包含加热（M104/M109/M140/M190）与结束关加热（M104 S0/M140 S0）。
- 温度不超过材料表上限；不确定固件（Marlin/Klipper）与床尺寸先问用户。
- 生成结果一律提示「上机前人工核对」。
