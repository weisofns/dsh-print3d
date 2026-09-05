// 从 presets/<id>/ 目录构建可导入的 .dshpreset 预设包（DSH 预设打包格式）。
// 用法：node build-dshpreset.mjs [preset-id ...]   （不传参数则构建 presets/ 下全部预设）
// 产物：<id>-<插件版本>.dshpreset
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const here = dirname(fileURLToPath(import.meta.url))
const presetsDir = join(here, 'presets')
const PKG_VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
const SOURCE_DSH_VERSION = '0.1.2-alpha.1'

function collectPresetFiles(dir) {
  const files = {}
  function visit(current, prefix) {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) visit(full, rel)
      else files[`preset/${rel}`] = readFileSync(full)
    }
  }
  visit(dir, '')
  return files
}

function parsePresetYml(text) {
  const name = (text.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || ''
  const description = (text.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || ''
  return { name, description }
}

function buildPreset(id) {
  const dir = join(presetsDir, id)
  if (!existsSync(join(dir, 'agent.cordis.yml'))) {
    throw new Error(`preset "${id}" 缺少 agent.cordis.yml`)
  }
  const files = collectPresetFiles(dir)
  const yml = existsSync(join(dir, 'preset.yml')) ? readFileSync(join(dir, 'preset.yml'), 'utf8') : ''
  const { name, description } = parsePresetYml(yml)
  const manifest = {
    format: 'dsh-preset',
    version: 1,
    id,
    name: name || id,
    description,
    icon: 'sparkle',
    sourceDshVersion: SOURCE_DSH_VERSION,
    exportedAt: new Date().toISOString(),
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  const out = join(here, `${id}-${PKG_VERSION}.dshpreset`)
  writeFileSync(out, zipSync(files, { level: 6 }))
  return { out, entries: Object.keys(files).length }
}

const requested = process.argv.slice(2)
const ids = requested.length
  ? requested
  : readdirSync(presetsDir).filter((n) => existsSync(join(presetsDir, n, 'agent.cordis.yml')))

for (const id of ids) {
  const { out, entries } = buildPreset(id)
  console.log(`wrote ${out} (${entries} entries)`)
}
