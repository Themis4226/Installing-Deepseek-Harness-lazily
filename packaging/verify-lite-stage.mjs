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
  'launcher-integration',
])

const topLevel = await readdir(stageRoot)
const unexpected = topLevel.filter((name) => !allowedTopLevel.has(name))
if (unexpected.length > 0) {
  throw new Error(`Unexpected top-level entries: ${unexpected.join(', ')}`)
}
for (const forbidden of ['data', 'logs', 'launcher', 'build', '.git', '.npm-cache']) {
  if (topLevel.includes(forbidden)) throw new Error(`Forbidden top-level entry: ${forbidden}`)
}

const integrationFiles = [
  'package.json',
  path.join('lib', 'index.js'),
  path.join('lib', 'client.js'),
]
async function listIntegrationEntries(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    result.push(entry.isDirectory() ? `${relative}/` : relative)
    if (entry.isDirectory()) {
      result.push(...await listIntegrationEntries(path.join(directory, entry.name), relative))
    }
  }
  return result
}

const expectedIntegrationEntries = [
  'cordis.patch.yml',
  'dsh-launcher-update-ui/',
  'dsh-launcher-update-ui/package.json',
  'dsh-launcher-update-ui/lib/',
  'dsh-launcher-update-ui/lib/client.js',
  'dsh-launcher-update-ui/lib/index.js',
].sort()
const actualIntegrationEntries = (
  await listIntegrationEntries(path.join(stageRoot, 'launcher-integration'))
).sort()
if (JSON.stringify(actualIntegrationEntries) !== JSON.stringify(expectedIntegrationEntries)) {
  throw new Error(`Unexpected launcher integration entries: ${actualIntegrationEntries.join(', ')}`)
}

const integrationSource = path.join(stageRoot, 'launcher-integration', 'dsh-launcher-update-ui')
const integrationInstalled = path.join(stageRoot, 'node_modules', '@themis4226', 'dsh-launcher-update-ui')
const integrationManifest = JSON.parse(await readFile(path.join(integrationSource, 'package.json'), 'utf8'))
if (integrationManifest.name !== '@themis4226/dsh-launcher-update-ui') {
  throw new Error(`Unexpected launcher integration package: ${String(integrationManifest.name)}`)
}
for (const relative of integrationFiles) {
  await readFile(path.join(integrationSource, relative))
}
let runtimeCopyPresent = true
try {
  await lstat(integrationInstalled)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  runtimeCopyPresent = false
}
if (runtimeCopyPresent) {
  throw new Error('Launcher integration must not be copied into the immutable DSH runtime tree.')
}
const overlay = await readFile(path.join(stageRoot, 'launcher-integration', 'cordis.patch.yml'), 'utf8')
if (!overlay.includes("name: '@themis4226/dsh-launcher-update-ui'")) {
  throw new Error('Launcher integration overlay does not mount the expected package.')
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
