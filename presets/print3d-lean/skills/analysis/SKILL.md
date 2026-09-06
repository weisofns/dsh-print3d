---
name: analysis
description: Use when analyzing a 3D mesh (STL/3MF) for dimensions, volume, surface area, overhangs, and manifold errors, or estimating a G-code file's print time, filament, and layer count.
---

# 模型与 G-code 分析

## STL 分析（零依赖）

```powershell
node "$env:DSH_HOME/.agent-presets/print3d-local/scripts/stl_analyze.js" model.stl
```

输出 JSON：`format`（ascii/binary）、`triangles`、`bounds`（包围盒 min/max/size）、`volume`、`surfaceArea`、`overhangRatio`、`boundaryEdges`、`nonManifoldEdges`、`watertight`。

### 指标判读

- **watertight（水密）**：`boundaryEdges === 0`。有边界边 = 有洞，切片可能出问题，需修复（MeshLab / 微软 3D Builder / Netfabb）。
- **nonManifoldEdges > 0**：存在三条以上面共享的边，模型非法，需修复。
- **volume**：水密时才有物理意义（单位 mm³）。非水密时仅作参考。
- **overhangRatio**：法线向下倾角 >45° 的面占表面积比例。>0.1 说明悬垂较多，需支撑或降层高。
- **bounds.size**：三个维度尺寸（mm），核对是否超出打印机行程、是否符合期望。

## G-code 估算

```powershell
node "$env:DSH_HOME/.agent-presets/print3d-local/scripts/gcode_estimate.js" model.gcode [--density 1.24]
```

输出：`estimatedTimeHuman`（匀速近似，实际约 1.1–1.3 倍）、`filamentMM`/`filamentGrams`、`layers`/`layerHeight`、`nozzleTemp`/`bedTemp`（打印期最高温）、`bounds`。

## 3MF 处理

3MF 是 zip + XML，纯 Node 无内置 zip 库。策略：优先请用户导出 STL 再分析；或若系统有解压工具（`tar -xf` 支持 zip），解出 `3D/3dmodel.model` 里的 mesh XML 再解析。不要承诺能完整解析 3MF。

## 分析流程建议

1. 拿到模型先跑 `stl_analyze.js`，确认尺寸与水密性。
2. 检查 overhangRatio 与最小特征，反馈支撑/设计建议。
3. 切片或生成 G-code 后跑 `gcode_estimate.js`，给出时间/耗材/温度。
4. 结果异常（体积 0、边界边多）时提示用户修复模型，不要强行切片。
