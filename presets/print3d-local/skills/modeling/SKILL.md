---
name: modeling
description: Use when creating parametric 3D models via OpenSCAD, or generating STL meshes programmatically (boxes, cylinders, tubes, spheres, and arranged primitives) without a slicer.
---

# 脚本化建模

两种产出：**OpenSCAD 脚本**（参数化设计，可后续渲染），或**直接生成 STL**（纯 Node，零依赖，即时可用）。

## 助手脚本：直接生成 STL（首选）

```powershell
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_parametric_stl.js" --shape box --x 20 --y 20 --z 10 --out box.stl
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_parametric_stl.js" --shape cylinder --d 20 --h 30 --segments 64 --out cyl.stl
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_parametric_stl.js" --shape tube --d 20 --id 6 --h 30 --out tube.stl
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_parametric_stl.js" --shape sphere --d 20 --segments 32 --out sphere.stl
node "$env:DSH_HOME/.agent-presets/print3d/scripts/gen_parametric_stl.js" --list
```

形状：`box`（长方体）、`cylinder`（圆柱）、`tube`（圆管）、`sphere`（球体）。输出为水密 ASCII STL，可直接切片。复杂组合件：多次生成不同形状的 STL 后，在切片软件里布尔合并，或改用 OpenSCAD。

## OpenSCAD 写法（复杂/布尔件）

```openscad
// 参数化：一个带孔方块
$fn = 64;                 // 圆面分段数
w = 30; d = 20; h = 10;   // 尺寸参数
hole = 6;

difference() {
  cube([w, d, h]);                  // 基体
  translate([w/2, d/2, -1])         // 减去中心圆孔
    cylinder(h = h + 2, d = hole);
}
```

常用：`cube([x,y,z])`、`cylinder(h=, d=)`、`sphere(d=)`、`translate([x,y,z])`、`rotate([x,y,z])`、`union()`、`difference()`、`intersection()`、`module 名(参数){...}`、`for(i=[0:n])`、`linear_extrude(height=)`、`circle(d=)`。

## 渲染 STL（需要 OpenSCAD CLI）

本机默认未装 `openscad`。若用户已安装，用：

```powershell
openscad -o out.stl model.scad
```

未安装时：能写 `.scad`、能直接生成基础 STL，但**复杂 CSG 布尔渲染**需用户装 OpenSCAD（`winget install OpenSCAD.OpenSCAD`）。不要假装能渲染复杂件。

## 设计到打印的注意点

- 最小特征 ≥ 2× 线宽（0.4mm 喷嘴 → ≥0.8mm 壁厚）。
- 悬垂角 >45° 要加支撑或改设计（倒角/圆角）。
- 底面放平、增大接触面积，避免翘边。
- 生成的 STL 交付前用 analysis 技能的 `stl_analyze.js` 验证水密性。
