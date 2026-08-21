#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PACKAGE_NAME = '@deepseek-ai/dsh'
const PLATFORM = 'win32'
const ARCH = 'x64'
const FORMAT = 'dsh-runtime-zip-v1'
const FIXED_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const PACKAGE_JSON = 'node_modules/@deepseek-ai/dsh/package.json'
const FORBIDDEN_LAUNCHER_INTEGRATION = 'runtime/node_modules/@themis4226/dsh-launcher-update-ui'
const MAX_FILES = 200_000
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function fail(message) {
  const error = new Error(message)
  error.name = 'RuntimePackageValidationError'
  throw error
}

function parseArguments(argv) {
  const result = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      result.json = true
      continue
    }
    if (argument !== '--archive' && argument !== '--version' && argument !== '--tar') {
      fail(`unknown argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`missing value for ${argument}`)
    result[argument.slice(2)] = value
    index += 1
  }
  if (!result.archive) fail('--archive is required')
  if (!result.version) fail('--version is required')
  if (!SEMVER.test(result.version)) fail(`invalid semantic version: ${result.version}`)
  return result
}

function defaultTarPath() {
  if (process.platform !== 'win32') return 'tar'
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return path.join(windowsRoot, 'System32', 'tar.exe')
}

async function runTar(tarPath, arguments_) {
  try {
    return await execFileAsync(tarPath, arguments_, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim()
    fail(`tar failed: ${detail}`)
  }
}

function normalizeArchiveEntry(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) fail('archive contains an empty entry name')
  if (rawName.includes('\\')) fail(`archive entry uses a backslash: ${rawName}`)
  if (/[\u0000-\u001f\u007f]/u.test(rawName)) fail('archive entry contains a control character')
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    fail(`archive entry is absolute: ${rawName}`)
  }

  const withoutTrailingSlash = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
  if (!withoutTrailingSlash) fail('archive contains an invalid root entry')
  const segments = withoutTrailingSlash.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`archive entry has an unsafe path: ${rawName}`)
  }
  if (segments[0] !== 'runtime') fail(`archive entry is outside runtime/: ${rawName}`)
  return withoutTrailingSlash
}

async function inspectArchive(archivePath, tarPath) {
  const [{ stdout: namesOutput }, { stdout: verboseOutput }] = await Promise.all([
    runTar(tarPath, ['-tf', archivePath]),
    runTar(tarPath, ['-tvf', archivePath]),
  ])

  const rawNames = namesOutput.split(/\r?\n/u).filter((line) => line.length > 0)
  if (rawNames.length === 0) fail('archive is empty')
  if (rawNames.length > MAX_FILES) fail(`archive has more than ${MAX_FILES} entries`)

  const names = []
  const caseInsensitiveNames = new Set()
  const forbiddenIntegration = FORBIDDEN_LAUNCHER_INTEGRATION.toLocaleLowerCase('en-US')
  for (const rawName of rawNames) {
    const name = normalizeArchiveEntry(rawName)
    const folded = name.toLocaleLowerCase('en-US')
    if (caseInsensitiveNames.has(folded)) fail(`archive has a duplicate or case-colliding entry: ${name}`)
    if (folded === forbiddenIntegration || folded.startsWith(`${forbiddenIntegration}/`)) {
      fail('archive contains launcher UI integration inside the DSH runtime tree')
    }
    caseInsensitiveNames.add(folded)
    names.push(name)
  }

  const verboseLines = verboseOutput.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  if (verboseLines.length !== rawNames.length) {
    fail('archive listing is inconsistent')
  }
  for (const line of verboseLines) {
    const type = line[0]
    if (type !== '-' && type !== 'd') fail('archive contains a link or unsupported entry type')
  }

  const required = [
    'runtime/runtime.json',
    `runtime/${FIXED_ENTRY}`,
    `runtime/${PACKAGE_JSON}`,
  ]
  for (const requiredPath of required) {
    if (!caseInsensitiveNames.has(requiredPath.toLocaleLowerCase('en-US'))) {
      fail(`archive is missing required entry: ${requiredPath}`)
    }
  }

  for (const name of names) {
    const directChild = name.split('/')[1]
    if (directChild && directChild !== 'runtime.json' && directChild !== 'node_modules') {
      fail(`runtime/ contains an unexpected top-level entry: ${directChild}`)
    }
  }

  return { archiveEntries: rawNames.length }
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected fields`)
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    fail(`${label} is missing or invalid JSON: ${error.message}`)
  }
}

async function walkTree(root) {
  const pending = [root]
  let files = 0
  let directories = 0
  let extractedBytes = 0

  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      const metadata = await lstat(entryPath)
      if (metadata.isSymbolicLink()) fail(`extracted runtime contains a symbolic link: ${entryPath}`)
      if (metadata.isDirectory()) {
        directories += 1
        pending.push(entryPath)
      } else if (metadata.isFile()) {
        files += 1
        extractedBytes += metadata.size
      } else {
        fail(`extracted runtime contains an unsupported filesystem entry: ${entryPath}`)
      }
      if (files + directories > MAX_FILES) fail(`extracted runtime has more than ${MAX_FILES} entries`)
      if (extractedBytes > MAX_EXTRACTED_BYTES) {
        fail(`extracted runtime exceeds ${MAX_EXTRACTED_BYTES} bytes`)
      }
    }
  }
  return { files, directories, extractedBytes }
}

async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyRuntimePackage({ archive, version, tar = defaultTarPath() }) {
  const archivePath = path.resolve(archive)
  const archiveMetadata = await lstat(archivePath).catch(() => null)
  if (!archiveMetadata?.isFile() || archiveMetadata.isSymbolicLink()) {
    fail(`archive is missing or unsafe: ${archivePath}`)
  }

  const archiveInspection = await inspectArchive(archivePath, tar)
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-verify-'))
  try {
    await runTar(tar, ['-xf', archivePath, '-C', temporaryRoot])
    const runtimeRoot = path.join(temporaryRoot, 'runtime')
    const runtimeMetadata = await readJson(path.join(runtimeRoot, 'runtime.json'), 'runtime metadata')
    requireExactKeys(
      runtimeMetadata,
      ['schemaVersion', 'dshPackage', 'dshVersion', 'platform', 'arch', 'entry'],
      'runtime metadata',
    )
    if (runtimeMetadata.schemaVersion !== 1) fail('runtime metadata schemaVersion must be 1')
    if (runtimeMetadata.dshPackage !== PACKAGE_NAME) fail(`runtime metadata package must be ${PACKAGE_NAME}`)
    if (runtimeMetadata.dshVersion !== version) fail('runtime metadata version does not match the expected version')
    if (runtimeMetadata.platform !== PLATFORM || runtimeMetadata.arch !== ARCH) {
      fail('runtime metadata platform or architecture does not match win32/x64')
    }
    if (runtimeMetadata.entry !== FIXED_ENTRY) fail('runtime metadata fixed entry is incorrect')

    const runtimeTopLevel = await readdir(runtimeRoot)
    const allowedTopLevel = new Set(['node_modules', 'runtime.json'])
    for (const entry of runtimeTopLevel) {
      if (!allowedTopLevel.has(entry)) fail(`runtime contains an unexpected top-level entry: ${entry}`)
    }

    const packageMetadata = await readJson(path.join(runtimeRoot, ...PACKAGE_JSON.split('/')), 'DSH package metadata')
    if (packageMetadata?.name !== PACKAGE_NAME || packageMetadata?.version !== version) {
      fail('DSH package name/version does not match the expected runtime')
    }

    const fixedEntryPath = path.join(runtimeRoot, ...FIXED_ENTRY.split('/'))
    const fixedEntryMetadata = await lstat(fixedEntryPath).catch(() => null)
    if (!fixedEntryMetadata?.isFile() || fixedEntryMetadata.isSymbolicLink()) {
      fail(`fixed DSH entry is missing or unsafe: ${FIXED_ENTRY}`)
    }

    const tree = await walkTree(runtimeRoot)
    return {
      schemaVersion: 1,
      valid: true,
      version,
      platform: PLATFORM,
      arch: ARCH,
      format: FORMAT,
      fixedEntry: FIXED_ENTRY,
      archive: archivePath,
      size: archiveMetadata.size,
      sha256: await sha256(archivePath),
      archiveEntries: archiveInspection.archiveEntries,
      files: tree.files,
      directories: tree.directories,
      extractedBytes: tree.extractedBytes,
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const result = await verifyRuntimePackage(options)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === new URL(`file://${process.argv[1]?.replaceAll('\\', '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`${error.name || 'Error'}: ${error.message}\n`)
    process.exitCode = 1
  })
}
