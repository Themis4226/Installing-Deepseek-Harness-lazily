import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  FIXED_RUNTIME_ENTRY,
  UpdaterError,
  checkForUpdate,
  compareSemver,
  parseCliArguments,
  prepareRuntime,
  validateArchiveEntryNames,
  validateManifest,
} from '../updater.mjs'

const execFileAsync = promisify(execFile)
const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const UPDATER_PATH = path.resolve(TEST_DIRECTORY, '..', 'updater.mjs')
const TAR_PATH =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
const REMOTE_VERSION = '0.1.1-rc.2'
const CURRENT_VERSION = '0.1.1-rc.1'

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  crcTable[index] = value >>> 0
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

async function createStoredZip(zipPath, entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents ?? '', 'utf8')
    const checksum = crc32(contents)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(contents.length, 18)
    local.writeUInt32LE(contents.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, contents)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(contents.length, 20)
    central.writeUInt32LE(contents.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    const unixMode = entry.unixMode ?? 0o100644
    central.writeUInt32LE((unixMode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + contents.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  await writeFile(zipPath, Buffer.concat([...localParts, centralDirectory, end]))
}

function runtimeMetadata(version = REMOTE_VERSION) {
  return JSON.stringify({
    schemaVersion: 1,
    dshPackage: '@deepseek-ai/dsh',
    dshVersion: version,
    platform: 'win32',
    arch: 'x64',
    entry: FIXED_RUNTIME_ENTRY,
  })
}

function goodRuntimeEntries(version = REMOTE_VERSION) {
  return [
    { name: 'runtime/runtime.json', contents: runtimeMetadata(version) },
    {
      name: 'runtime/node_modules/@deepseek-ai/dsh/package.json',
      contents: JSON.stringify({ name: '@deepseek-ai/dsh', version }),
    },
    {
      name: `runtime/${FIXED_RUNTIME_ENTRY}`,
      contents: '#!/usr/bin/env node\nconsole.log("fixture")\n',
    },
  ]
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function makeManifest(assetPath, changes = {}) {
  const assetStats = await stat(assetPath)
  const value = {
    schemaVersion: 1,
    channel: 'preview',
    publishedAt: '2026-08-21T15:00:00Z',
    minimumLauncherVersion: '1.2.0',
    runtime: {
      version: REMOTE_VERSION,
      platform: 'win32',
      arch: 'x64',
      format: 'dsh-runtime-zip-v1',
      asset: {
        url: pathToFileURL(assetPath).href,
        size: assetStats.size,
        sha256: await sha256(assetPath),
      },
    },
    releaseNotesUrl: 'https://example.invalid/runtime-v0.1.1-rc.2',
  }
  if (changes.top) Object.assign(value, changes.top)
  if (changes.runtime) Object.assign(value.runtime, changes.runtime)
  if (changes.asset) Object.assign(value.runtime.asset, changes.asset)
  return value
}

async function makeFixture(t, entries = goodRuntimeEntries()) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-updater-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assetPath = path.join(root, 'runtime.zip')
  const manifestPath = path.join(root, 'update.json')
  const dataRoot = path.join(root, 'launcher-data')
  await createStoredZip(assetPath, entries)
  const manifest = await makeManifest(assetPath)
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  return {
    root,
    assetPath,
    manifest,
    manifestPath,
    manifestUrl: pathToFileURL(manifestPath).href,
    dataRoot,
  }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function assertUpdaterCode(code) {
  return (error) => error instanceof UpdaterError && error.code === code
}

test('semantic version comparison handles release candidates numerically', () => {
  assert.equal(compareSemver('0.1.1-rc.2', '0.1.1-rc.1'), 1)
  assert.equal(compareSemver('0.1.1-rc.10', '0.1.1-rc.2'), 1)
  assert.equal(compareSemver('0.1.1', '0.1.1-rc.99'), 1)
  assert.equal(compareSemver('0.1.1+build.2', '0.1.1+build.1'), 0)
})

test('manifest validation is strict about schema and runtime identity', async (t) => {
  const fixture = await makeFixture(t)
  assert.equal(validateManifest(fixture.manifest, { testMode: true }).runtime.version, REMOTE_VERSION)

  const unknown = structuredClone(fixture.manifest)
  unknown.unexpected = true
  assert.throws(() => validateManifest(unknown, { testMode: true }), assertUpdaterCode('SCHEMA_INVALID'))

  const platform = structuredClone(fixture.manifest)
  platform.runtime.platform = 'linux'
  assert.throws(() => validateManifest(platform, { testMode: true }), assertUpdaterCode('PLATFORM_MISMATCH'))

  const architecture = structuredClone(fixture.manifest)
  architecture.runtime.arch = 'arm64'
  assert.throws(() => validateManifest(architecture, { testMode: true }), assertUpdaterCode('ARCH_MISMATCH'))

  const format = structuredClone(fixture.manifest)
  format.runtime.format = 'zip'
  assert.throws(() => validateManifest(format, { testMode: true }), assertUpdaterCode('FORMAT_MISMATCH'))

  const version = structuredClone(fixture.manifest)
  version.runtime.version = 'v0.1.1'
  assert.throws(() => validateManifest(version, { testMode: true }), assertUpdaterCode('VERSION_INVALID'))

  const size = structuredClone(fixture.manifest)
  size.runtime.asset.size = 0
  assert.throws(() => validateManifest(size, { testMode: true }), assertUpdaterCode('SCHEMA_INVALID'))

  const hash = structuredClone(fixture.manifest)
  hash.runtime.asset.sha256 = 'abc'
  assert.throws(() => validateManifest(hash, { testMode: true }), assertUpdaterCode('SCHEMA_INVALID'))
})

test('CLI arguments have one fixed check or prepare shape', async (t) => {
  const fixture = await makeFixture(t)
  const parsed = parseCliArguments([
    'check',
    '--manifest',
    fixture.manifestUrl,
    '--data-root',
    fixture.dataRoot,
    '--current-version',
    CURRENT_VERSION,
    '--test-mode',
  ])
  assert.equal(parsed.command, 'check')
  assert.equal(parsed.testMode, true)
  assert.throws(
    () => parseCliArguments(['check', '--manifest', fixture.manifestUrl]),
    assertUpdaterCode('CLI_INVALID'),
  )
})

test('check and prepare install a valid immutable runtime without active state', async (t) => {
  const fixture = await makeFixture(t)
  const checked = await checkForUpdate({
    manifestUrl: fixture.manifestUrl,
    currentVersion: CURRENT_VERSION,
    testMode: true,
  })
  assert.equal(checked.status, 'update-available')
  assert.equal(checked.size, fixture.manifest.runtime.asset.size)
  assert.equal(checked.sha256, fixture.manifest.runtime.asset.sha256)

  const prepared = await prepareRuntime({
    manifestUrl: fixture.manifestUrl,
    dataRoot: fixture.dataRoot,
    currentVersion: CURRENT_VERSION,
    testMode: true,
    tarPath: TAR_PATH,
  })
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.version, REMOTE_VERSION)
  assert.equal(
    await readFile(path.join(prepared.runtimePath, ...FIXED_RUNTIME_ENTRY.split('/')), 'utf8'),
    '#!/usr/bin/env node\nconsole.log("fixture")\n',
  )
  assert.equal(await exists(path.join(fixture.dataRoot, 'state.txt')), false)
  assert.equal(await exists(path.join(fixture.dataRoot, 'updates', 'state.txt')), false)
  assert.equal(await exists(path.join(fixture.dataRoot, 'active.json')), false)

  const repeated = await prepareRuntime({
    manifestUrl: fixture.manifestUrl,
    dataRoot: fixture.dataRoot,
    currentVersion: CURRENT_VERSION,
    testMode: true,
    tarPath: TAR_PATH,
  })
  assert.equal(repeated.status, 'already-prepared')
})

test('prepare rejects a bad SHA256 without installing a runtime', async (t) => {
  const fixture = await makeFixture(t)
  fixture.manifest.runtime.asset.sha256 = '0'.repeat(64)
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), 'utf8')
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('HASH_MISMATCH'),
  )
  assert.equal(await exists(path.join(fixture.dataRoot, 'runtimes', REMOTE_VERSION)), false)
})

test('prepare rejects a bad declared size without installing a runtime', async (t) => {
  const fixture = await makeFixture(t)
  fixture.manifest.runtime.asset.size += 1
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest), 'utf8')
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('SIZE_MISMATCH'),
  )
  assert.equal(await exists(path.join(fixture.dataRoot, 'runtimes', REMOTE_VERSION)), false)
})

test('path traversal entries are rejected before extraction', async (t) => {
  const fixture = await makeFixture(t, [
    ...goodRuntimeEntries(),
    { name: '../escape.txt', contents: 'must not escape' },
  ])
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('ARCHIVE_ENTRY_INVALID'),
  )
  assert.equal(await exists(path.join(fixture.root, 'escape.txt')), false)
  assert.equal(await exists(path.join(fixture.dataRoot, 'escape.txt')), false)
  assert.throws(
    () => validateArchiveEntryNames(['runtime/runtime.json', 'runtime/../escape.txt']),
    assertUpdaterCode('ARCHIVE_ENTRY_INVALID'),
  )
})

test('archive links are rejected before extraction', async (t) => {
  const fixture = await makeFixture(t, [
    ...goodRuntimeEntries(),
    {
      name: 'runtime/unsafe-link',
      contents: '../outside',
      unixMode: 0o120777,
    },
  ])
  await assert.rejects(
    prepareRuntime({
      manifestUrl: fixture.manifestUrl,
      dataRoot: fixture.dataRoot,
      currentVersion: CURRENT_VERSION,
      testMode: true,
      tarPath: TAR_PATH,
    }),
    assertUpdaterCode('ARCHIVE_LINK_NOT_ALLOWED'),
  )
})

test('prepare CLI writes exactly one JSON line on stdout', async (t) => {
  const fixture = await makeFixture(t)
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      UPDATER_PATH,
      'prepare',
      '--manifest',
      fixture.manifestUrl,
      '--data-root',
      fixture.dataRoot,
      '--current-version',
      CURRENT_VERSION,
      '--test-mode',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  assert.equal(stderr, '')
  const lines = stdout.trimEnd().split(/\r?\n/)
  assert.equal(lines.length, 1)
  const result = JSON.parse(lines[0])
  assert.equal(result.ok, true)
  assert.equal(result.command, 'prepare')
  assert.equal(result.status, 'prepared')
  assert.equal(result.version, REMOTE_VERSION)
})
