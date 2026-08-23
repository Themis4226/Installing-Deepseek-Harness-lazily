import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const stageRoot = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  throw new Error('Usage: node verify-lite-stage.mjs <stage-root> [sensitive-string ...]')
}

const allowedTopLevel = new Set([
  'DeepSeek Harness.exe',
  'node_modules',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'README.md',
  'PUBLIC-RELEASE-NOTICE.md',
  'THIRD_PARTY_NOTICES.md',
  'licenses',
  'RELEASE.json',
])

const topLevel = await readdir(stageRoot)
const unexpected = topLevel.filter((name) => !allowedTopLevel.has(name))
if (unexpected.length > 0) {
  throw new Error(`Unexpected top-level entries: ${unexpected.join(', ')}`)
}
for (const forbidden of ['data', 'logs', 'launcher', 'launcher-integration', 'build', '.git', '.npm-cache']) {
  if (topLevel.includes(forbidden)) throw new Error(`Forbidden top-level entry: ${forbidden}`)
}

for (const packageName of ['dsh-launcher-update-ui', 'dsh-official-update-check']) {
  try {
    await lstat(path.join(stageRoot, 'node_modules', '@themis4226', packageName))
    throw new Error(`Launcher-only package must not be copied into the immutable runtime: ${packageName}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

const needles = process.argv.slice(3).filter(Boolean).flatMap((value) => [
  { label: `${value} (UTF-8)`, bytes: Buffer.from(value, 'utf8') },
  { label: `${value} (UTF-16LE)`, bytes: Buffer.from(value, 'utf16le') },
])

let fileCount = 0
let totalBytes = 0

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    const metadata = await lstat(fullPath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Symbolic link/reparse point is not allowed: ${fullPath}`)
    }
    if (entry.isDirectory()) {
      await walk(fullPath)
      continue
    }
    if (!entry.isFile()) continue

    fileCount += 1
    totalBytes += metadata.size
    if (needles.length === 0 || metadata.size === 0) continue
    const data = await readFile(fullPath)
    for (const needle of needles) {
      if (needle.bytes.length > 0 && data.indexOf(needle.bytes) >= 0) {
        throw new Error(`Sensitive string ${needle.label} found in ${fullPath}`)
      }
    }
  }
}

await walk(stageRoot)
console.log(JSON.stringify({ fileCount, totalBytes, topLevel: topLevel.sort() }))
