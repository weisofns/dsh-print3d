# 模块化扩展指南（MODULES）

本插件按「**一个能力 = 一个脚本 + 一个工具定义（+ 可选一个技能）**」组织。新增能力不改动现有模块，只需按下面三步操作。

---

## 能力分层

| 层 | 位置 | 职责 | 何时新增 |
|---|---|---|---|
| 脚本（引擎） | `scripts/<name>.cjs` | 确定性纯逻辑，零依赖，进程内可调用 + 可 CLI 独立运行 | 有新的确定性计算 |
| 工具（接口） | `src/tools/<name>.js` | 把脚本包装成带 schema 的模型工具 | 要让 Agent 直接调用脚本 |
| 技能（知识） | `skills/<name>/SKILL.md` | Markdown 知识包，Agent 按需加载 | 有新的领域知识/规则 |

---

## 步骤 1：写脚本 `scripts/<name>.cjs`

脚本必须满足两条约定，才能被工具进程内调用：

1. **导出纯函数**：`module.exports = { ... }` 暴露可复用的函数（入参/出参都是普通 JSON 或文本）。
2. **错误用 throw，不用 process.exit**：`fail(msg)` 定义为 `throw new Error(...)`，CLI 入口 `main()` 用 try/catch 转成 `process.exit(1)`。

模板：

```js
#!/usr/bin/env node
'use strict'
const fs = require('node:fs')

function fail(msg) { throw new Error('my_tool: ' + msg) }

// 纯逻辑：进程内工具直接调用这个
function compute(params) {
  // ...
  return { result: '...' }
}

function main() {
  try {
    const args = parseCliArgs(process.argv.slice(2))
    const out = compute(args)
    fs.writeFileSync(args.out || 'out.txt', out.result, 'utf8')
    console.log('done')
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

if (require.main === module) main()   // 只有 CLI 直跑才进 main
module.exports = { compute }
```

---

## 步骤 2：写工具 `src/tools/<name>.js`

```js
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compute } = require('../../scripts/my_tool.cjs')

export function makeMyTool(ctx) {                 // 工厂：需要会话 cwd / 附件等时用 ctx
  return {
    name: 'print3d_my_tool',                       // 工具名（snake_case，加 print3d_ 前缀）
    description: '一句话说明这个工具做什么。',
    parameters: {                                   // JSON Schema（根上不要设 additionalProperties）
      type: 'object',
      properties: {
        input: { type: 'string', description: '...' },
      },
      required: ['input'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {                        // 模型看到的结果文本
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {                     // 真正的计算；exec.agent.id 可经 ctx.sessions 取会话 cwd
      return compute(args)
    },
  }
}
```

然后在 `src/tools/index.js` 的 `makeToolDefinitions(ctx)` 返回数组里追加 `makeMyTool(ctx)`。

---

## 步骤 3（可选）：写技能 `skills/<name>/SKILL.md`

```markdown
---
name: <name>
description: Use when <何时使用这个技能>。
---

# 标题

正文知识……
```

并在 `src/skills.js` 的 `SKILL_IDS` 数组里追加目录名。技能会自动以 `print3d-<name>` 注册。

---

## 目录清单核对

新增一个能力后，确保：

- [ ] `scripts/<name>.cjs` 已导出纯函数、错误用 throw
- [ ] `src/tools/<name>.js` 已创建，`execute` 调用脚本纯函数
- [ ] `src/tools/index.js` 已追加新工具
- [ ] （可选）`skills/<name>/SKILL.md` 已创建，`src/skills.js` 已登记
- [ ] `README.md` 能力表已更新

---

## 约定与边界

- **纯计算优先**：默认内容进、结果出；生成类工具可用 `output_path` 直接在工作区落盘（省 token）。落盘路径从会话 `header.cwd` 解析（见 `src/tools/io.js`）。
- **`parameters` 是 JSON Schema，根上不要设 `additionalProperties`**：运行时校验要求它省略或为 true（报「implicit parameter root is open」）。
- **零依赖**：脚本只用 Node 内置模块（`fs` / `path` / `zlib`），不加 npm 依赖。
- **确定性**：同样的入参给同样的出参，便于测试与回放。
- **安全红线**：涉及温度/高温的内容，输出必须提示「上机前人工核对」。
- **不碰宿主全局**：所有注册（工具/技能）都经 `ctx.effect(...)` 挂在插件 fiber 上，插件停止即自动卸载。

## 已完成 / 未来可做

已落地（v0.1）：`output_path` 落盘、`gcode_render` 原生图片块、`print3d_slice` PrusaSlicer 桥接。

后续可做：
- 给 `print3d_slice` 增加「按本机机型 + 耗材的 PrusaSlicer 配置包」记忆，一键复用。
- `stl_analyze` 支持二进制 STL（接受 base64 输入）。
- 复杂 CSG 布尔建模桥接 OpenSCAD CLI。
