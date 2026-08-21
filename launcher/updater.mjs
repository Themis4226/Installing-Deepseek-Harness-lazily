import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import process from 'node:process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export const LAUNCHER_VERSION = '1.3.0'
export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/update.json'
export const RUNTIME_PLATFORM = 'win32'
export const RUNTIME_ARCH = 'x64'
export const RUNTIME_FORMAT = 'dsh-runtime-zip-v1'
export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const FIXED_RUNTIME_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

const RUNTIME_METADATA_FILE = 'runtime.json'
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_FILES = 200_000
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 30_000
const RELEASE_ASSET_PREFIX =
  '/Themis4226/Installing-Deepseek-Harness-lazily/releases/download/'
const RELEASE_NOTES_PREFIX =
  '/Themis4226/Installing-Deepseek-Harness-lazily/releases/tag/'
const execFileAsync = promisify(execFile)

export class UpdaterError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'UpdaterError'
    this.code = code
  }
}

function fail(code, message, options) {
  throw new UpdaterError(code, message, options)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail('SCHEMA_INVALID', `${label} must be an object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('SCHEMA_INVALID', `${label}.${key} is not allowed`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('SCHEMA_INVALID', `${label}.${key} is required`)
  }
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseSemver(value, label = 'version') {
  if (typeof value !== 'string' || value.length > 128) {
    fail('VERSION_INVALID', `${label} must be a semantic version string`)
  }
  const match = SEMVER_PATTERN.exec(value)
  if (!match) fail('VERSION_INVALID', `${label} is not a valid semantic version: ${value}`)
  return {
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue, 'left version')
  const right = parseSemver(rightValue, 'right version')
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const count = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftPart)
      const rightNumber = BigInt(rightPart)
      if (leftNumber < rightNumber) return -1
      if (leftNumber > rightNumber) return 1
      continue
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function parseUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    fail('SCHEMA_INVALID', `${label} must be a non-empty URL string`)
  }
  let url
  try {
    url = new URL(value)
  } catch (error) {
    fail('SCHEMA_INVALID', `${label} is not a valid URL`, { cause: error })
  }
  if (url.username || url.password || url.hash) {
    fail('URL_NOT_ALLOWED', `${label} must not contain credentials or a fragment`)
  }
  return url
}

function isLocalhost(hostname) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

function validateFetchUrl(url, { testMode, kind, redirect = false }) {
  if (testMode) {
    if (url.protocol === 'file:') return
    if (url.protocol === 'http:' && isLocalhost(url.hostname)) return
    if (url.protocol === 'https:') return
    fail('URL_NOT_ALLOWED', `${kind} URL is not allowed in test mode: ${url.href}`)
  }

  if (url.protocol !== 'https:') {
    fail('URL_NOT_ALLOWED', `${kind} URL must use HTTPS`)
  }
  const hostname = url.hostname.toLowerCase()
  if (kind === 'manifest' && !redirect) {
    if (url.href !== DEFAULT_MANIFEST_URL) {
      fail('URL_NOT_ALLOWED', `production manifest URL must be ${DEFAULT_MANIFEST_URL}`)
    }
    return
  }
  if (kind === 'asset' && !redirect) {
    if (hostname !== 'github.com' || !url.pathname.startsWith(RELEASE_ASSET_PREFIX)) {
      fail('URL_NOT_ALLOWED', 'runtime asset must be a Release asset from the configured repository')
    }
    return
  }

  const redirectAllowed =
    hostname === 'raw.githubusercontent.com' ||
    hostname === 'github.com' ||
    hostname === 'release-assets.githubusercontent.com' ||
    hostname === 'objects.githubusercontent.com' ||
    hostname.endsWith('.githubusercontent.com')
  if (!redirectAllowed) {
    fail('URL_NOT_ALLOWED', `${kind} redirect host is not allowed: ${hostname}`)
  }
}

function validateReleaseNotesUrl(value, testMode) {
  const url = parseUrl(value, 'releaseNotesUrl')
  if (testMode) {
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
      fail('URL_NOT_ALLOWED', 'releaseNotesUrl uses an unsupported scheme')
    }
    return url.href
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    !url.pathname.startsWith(RELEASE_NOTES_PREFIX)
  ) {
    fail('URL_NOT_ALLOWED', 'releaseNotesUrl must refer to this repository Release')
  }
  return url.href
}

export function validateManifest(value, { testMode = false } = {}) {
  requireExactKeys(
    value,
    ['schemaVersion', 'channel', 'publishedAt', 'minimumLauncherVersion', 'runtime', 'releaseNotesUrl'],
    [],
    'manifest',
  )
  if (value.schemaVersion !== 1) fail('SCHEMA_INVALID', 'schemaVersion must be 1')
  if (value.channel !== 'preview' && value.channel !== 'stable') {
    fail('SCHEMA_INVALID', 'channel must be preview or stable')
  }
  if (
    typeof value.publishedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.publishedAt) ||
    !Number.isFinite(Date.parse(value.publishedAt))
  ) {
    fail('SCHEMA_INVALID', 'publishedAt must be an ISO-8601 UTC timestamp')
  }
  parseSemver(value.minimumLauncherVersion, 'minimumLauncherVersion')

  requireExactKeys(
    value.runtime,
    ['version', 'platform', 'arch', 'format', 'asset'],
    [],
    'runtime',
  )
  parseSemver(value.runtime.version, 'runtime.version')
  if (value.runtime.platform !== RUNTIME_PLATFORM) {
    fail('PLATFORM_MISMATCH', `runtime.platform must be ${RUNTIME_PLATFORM}`)
  }
  if (value.runtime.arch !== RUNTIME_ARCH) {
    fail('ARCH_MISMATCH', `runtime.arch must be ${RUNTIME_ARCH}`)
  }
  if (value.runtime.format !== RUNTIME_FORMAT) {
    fail('FORMAT_MISMATCH', `runtime.format must be ${RUNTIME_FORMAT}`)
  }

  requireExactKeys(value.runtime.asset, ['url', 'size', 'sha256'], [], 'runtime.asset')
  const assetUrl = parseUrl(value.runtime.asset.url, 'runtime.asset.url')
  validateFetchUrl(assetUrl, { testMode, kind: 'asset' })
  if (
    !Number.isSafeInteger(value.runtime.asset.size) ||
    value.runtime.asset.size <= 0 ||
    value.runtime.asset.size > MAX_ASSET_BYTES
  ) {
    fail('SCHEMA_INVALID', `runtime.asset.size must be between 1 and ${MAX_ASSET_BYTES}`)
  }
  if (typeof value.runtime.asset.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.runtime.asset.sha256)) {
    fail('SCHEMA_INVALID', 'runtime.asset.sha256 must contain exactly 64 hexadecimal characters')
  }

  return Object.freeze({
    schemaVersion: 1,
    channel: value.channel,
    publishedAt: value.publishedAt,
    minimumLauncherVersion: value.minimumLauncherVersion,
    releaseNotesUrl: validateReleaseNotesUrl(value.releaseNotesUrl, testMode),
    runtime: Object.freeze({
      version: value.runtime.version,
      platform: RUNTIME_PLATFORM,
      arch: RUNTIME_ARCH,
      format: RUNTIME_FORMAT,
      asset: Object.freeze({
        url: assetUrl.href,
        size: value.runtime.asset.size,
        sha256: value.runtime.asset.sha256.toLowerCase(),
      }),
    }),
  })
}

function requestStream(url, { testMode, kind, redirects = 0 }) {
  validateFetchUrl(url, { testMode, kind, redirect: redirects > 0 })
  if (url.protocol === 'file:') {
    return Promise.resolve(createReadStream(fileURLToPath(url)))
  }
  const client = url.protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        headers: {
          Accept: kind === 'manifest' ? 'application/json' : 'application/octet-stream',
          'User-Agent': `DSH-Desktop-Launcher/${LAUNCHER_VERSION}`,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume()
          if (redirects >= MAX_REDIRECTS) {
            reject(new UpdaterError('TOO_MANY_REDIRECTS', `${kind} exceeded ${MAX_REDIRECTS} redirects`))
            return
          }
          const location = response.headers.location
          if (!location) {
            reject(new UpdaterError('HTTP_ERROR', `${kind} redirect did not include Location`))
            return
          }
          let redirected
          try {
            redirected = new URL(location, url)
            validateFetchUrl(redirected, { testMode, kind, redirect: true })
          } catch (error) {
            reject(error)
            return
          }
          requestStream(redirected, { testMode, kind, redirects: redirects + 1 }).then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new UpdaterError('HTTP_ERROR', `${kind} request returned HTTP ${status}`))
          return
        }
        resolve(response)
      },
    )
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new UpdaterError('HTTP_TIMEOUT', `${kind} request timed out`))
    })
    request.on('error', reject)
  })
}

async function readLimited(stream, limit, label) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > limit) {
      stream.destroy()
      fail('DOWNLOAD_TOO_LARGE', `${label} exceeds ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export async function loadManifest(manifestUrl, { testMode = false } = {}) {
  const url = parseUrl(manifestUrl, 'manifest URL')
  validateFetchUrl(url, { testMode, kind: 'manifest' })
  let bytes
  try {
    bytes = await readLimited(
      await requestStream(url, { testMode, kind: 'manifest' }),
      MAX_MANIFEST_BYTES,
      'manifest',
    )
  } catch (error) {
    if (error instanceof UpdaterError) throw error
    fail('MANIFEST_DOWNLOAD_FAILED', `unable to read update manifest: ${error.message}`, { cause: error })
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    fail('MANIFEST_JSON_INVALID', 'update manifest is not valid UTF-8 JSON', { cause: error })
  }
  return validateManifest(parsed, { testMode })
}

function updateStatus(manifest, currentVersion) {
  parseSemver(currentVersion, 'current version')
  if (compareSemver(LAUNCHER_VERSION, manifest.minimumLauncherVersion) < 0) {
    return 'launcher-update-required'
  }
  return compareSemver(manifest.runtime.version, currentVersion) > 0
    ? 'update-available'
    : 'up-to-date'
}

export async function checkForUpdate({ manifestUrl, currentVersion, testMode = false }) {
  const manifest = await loadManifest(manifestUrl, { testMode })
  return {
    status: updateStatus(manifest, currentVersion),
    currentVersion,
    version: manifest.runtime.version,
    minimumLauncherVersion: manifest.minimumLauncherVersion,
    releaseNotesUrl: manifest.releaseNotesUrl,
    size: manifest.runtime.asset.size,
    sha256: manifest.runtime.asset.sha256,
    manifest,
  }
}

async function syncFile(filePath) {
  // FlushFileBuffers on Windows requires a handle opened with write access.
  const handle = await open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function downloadAndHash(urlValue, destination, expected, { testMode = false } = {}) {
  const url = parseUrl(urlValue, 'runtime asset URL')
  validateFetchUrl(url, { testMode, kind: 'asset' })
  const source = await requestStream(url, { testMode, kind: 'asset' })
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > expected.size || size > MAX_ASSET_BYTES) {
        callback(new UpdaterError('SIZE_MISMATCH', `runtime asset exceeds expected size ${expected.size}`))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(source, meter, createWriteStream(destination, { flags: 'wx' }))
    await syncFile(destination)
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {})
    if (error instanceof UpdaterError) throw error
    fail('ASSET_DOWNLOAD_FAILED', `unable to download runtime asset: ${error.message}`, { cause: error })
  }
  if (size !== expected.size) {
    await rm(destination, { force: true }).catch(() => {})
    fail('SIZE_MISMATCH', `runtime asset size is ${size}, expected ${expected.size}`)
  }
  const digest = hash.digest('hex')
  if (digest !== expected.sha256.toLowerCase()) {
    await rm(destination, { force: true }).catch(() => {})
    fail('HASH_MISMATCH', `runtime asset SHA256 is ${digest}, expected ${expected.sha256.toLowerCase()}`)
  }
  return { size, sha256: digest }
}

function defaultTarPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  }
  return 'tar'
}

async function runTar(argumentsList, tarPath = defaultTarPath()) {
  try {
    return await execFileAsync(tarPath, argumentsList, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    fail('ARCHIVE_COMMAND_FAILED', `tar failed: ${error.stderr || error.message}`, { cause: error })
  }
}

export function validateArchiveEntryName(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > 1024) {
    fail('ARCHIVE_ENTRY_INVALID', 'archive contains an empty or overlong entry name')
  }
  if (/[ -]/.test(rawName) || rawName.includes('\\')) {
    fail('ARCHIVE_ENTRY_INVALID', `archive entry contains an unsafe character: ${JSON.stringify(rawName)}`)
  }
  if (rawName.startsWith('/') || rawName.startsWith('//') || /^[A-Za-z]:/.test(rawName)) {
    fail('ARCHIVE_ENTRY_INVALID', `archive entry is absolute: ${rawName}`)
  }
  const withoutTrailingSlash = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
  const parts = withoutTrailingSlash.split('/')
  if (
    parts.length === 0 ||
    parts[0] !== 'runtime' ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    fail('ARCHIVE_ENTRY_INVALID', `archive entry escapes or is outside runtime/: ${rawName}`)
  }
  return withoutTrailingSlash
}

export function validateArchiveEntryNames(entryNames) {
  if (!Array.isArray(entryNames) || entryNames.length === 0) {
    fail('ARCHIVE_EMPTY', 'runtime archive is empty')
  }
  if (entryNames.length > MAX_ARCHIVE_FILES) {
    fail('ARCHIVE_TOO_MANY_FILES', `runtime archive has more than ${MAX_ARCHIVE_FILES} entries`)
  }
  const seen = new Set()
  for (const name of entryNames) {
    const normalized = validateArchiveEntryName(name)
    const folded = normalized.toLowerCase()
    if (seen.has(folded)) {
      fail('ARCHIVE_ENTRY_INVALID', `archive contains a duplicate path: ${name}`)
    }
    seen.add(folded)
  }
  return seen
}

export async function listAndValidateArchive(archivePath, { tarPath } = {}) {
  const listing = await runTar(['-tf', archivePath], tarPath)
  const entries = listing.stdout.split(/\r?\n/).filter((line) => line.length > 0)
  validateArchiveEntryNames(entries)

  const verbose = await runTar(['-tvf', archivePath], tarPath)
  const verboseLines = verbose.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (verboseLines.length !== entries.length) {
    fail('ARCHIVE_ENTRY_INVALID', 'archive verbose listing does not match its entry listing')
  }
  for (const line of verboseLines) {
    const type = line[0]
    if (type !== '-' && type !== 'd') {
      fail('ARCHIVE_LINK_NOT_ALLOWED', `archive contains a link or unsupported entry type: ${line}`)
    }
  }
  return entries
}

async function walkExtractedTree(root) {
  let files = 0
  let bytes = 0
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      const metadata = await lstat(fullPath)
      if (metadata.isSymbolicLink()) {
        fail('RUNTIME_LINK_NOT_ALLOWED', `extracted runtime contains a link: ${fullPath}`)
      }
      if (metadata.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!metadata.isFile()) {
        fail('RUNTIME_ENTRY_INVALID', `extracted runtime contains an unsupported entry: ${fullPath}`)
      }
      files += 1
      bytes += metadata.size
      if (files > MAX_ARCHIVE_FILES || bytes > MAX_EXTRACTED_BYTES) {
        fail('RUNTIME_TOO_LARGE', 'extracted runtime exceeds the safety limit')
      }
    }
  }
  await walk(root)
  return { files, bytes }
}

function validateRuntimeMetadata(value, expectedVersion) {
  requireExactKeys(
    value,
    ['schemaVersion', 'dshPackage', 'dshVersion', 'platform', 'arch', 'entry'],
    [],
    'runtime metadata',
  )
  if (value.schemaVersion !== 1) fail('RUNTIME_INVALID', 'runtime metadata schemaVersion must be 1')
  if (value.dshPackage !== DSH_PACKAGE) fail('RUNTIME_INVALID', `runtime package must be ${DSH_PACKAGE}`)
  if (value.dshVersion !== expectedVersion) fail('RUNTIME_INVALID', 'runtime metadata version does not match manifest')
  if (value.platform !== RUNTIME_PLATFORM || value.arch !== RUNTIME_ARCH) {
    fail('RUNTIME_INVALID', 'runtime metadata platform or architecture does not match')
  }
  if (value.entry !== FIXED_RUNTIME_ENTRY) fail('RUNTIME_INVALID', 'runtime entry is not the fixed DSH entry')
}

async function readJsonFile(filePath, code, label) {
  let value
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    fail(code, `${label} is missing or invalid JSON: ${filePath}`, { cause: error })
  }
  return value
}

export async function validateRuntimeTree(runtimeRoot, expectedVersion) {
  parseSemver(expectedVersion, 'expected runtime version')
  const rootMetadata = await lstat(runtimeRoot).catch(() => null)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('RUNTIME_INVALID', `runtime root is missing or unsafe: ${runtimeRoot}`)
  }
  const tree = await walkExtractedTree(runtimeRoot)
  const metadata = await readJsonFile(
    path.join(runtimeRoot, RUNTIME_METADATA_FILE),
    'RUNTIME_INVALID',
    'runtime metadata',
  )
  validateRuntimeMetadata(metadata, expectedVersion)

  const entryPath = path.join(runtimeRoot, ...FIXED_RUNTIME_ENTRY.split('/'))
  const entryMetadata = await lstat(entryPath).catch(() => null)
  if (!entryMetadata?.isFile() || entryMetadata.isSymbolicLink()) {
    fail('RUNTIME_INVALID', `fixed DSH entry is missing or unsafe: ${entryPath}`)
  }

  const packageMetadata = await readJsonFile(
    path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    'RUNTIME_INVALID',
    'DSH package metadata',
  )
  if (
    !isPlainObject(packageMetadata) ||
    packageMetadata.name !== DSH_PACKAGE ||
    packageMetadata.version !== expectedVersion
  ) {
    fail('RUNTIME_INVALID', 'DSH package metadata does not match the manifest version')
  }
  return { ...tree, entryPath }
}

function safeVersionDirectory(version) {
  parseSemver(version, 'runtime version')
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) {
    fail('VERSION_INVALID', 'runtime version is unsafe for use as a directory name')
  }
  return version
}

function assertSafeDataRoot(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
    fail('DATA_ROOT_INVALID', 'data root must be an absolute path')
  }
  const resolved = path.resolve(dataRoot)
  if (resolved === path.parse(resolved).root) fail('DATA_ROOT_INVALID', 'filesystem root cannot be used as data root')
  return resolved
}

function assertDirectChild(candidate, parent, label) {
  const relative = path.relative(parent, candidate)
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('PATH_INVALID', `${label} is outside its expected parent`)
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function prepareRuntime({
  manifestUrl,
  dataRoot,
  currentVersion,
  testMode = false,
  tarPath,
}) {
  const resolvedDataRoot = assertSafeDataRoot(dataRoot)
  const check = await checkForUpdate({ manifestUrl, currentVersion, testMode })
  if (check.status !== 'update-available') {
    return {
      status: check.status,
      currentVersion,
      version: check.version,
      minimumLauncherVersion: check.minimumLauncherVersion,
      releaseNotesUrl: check.releaseNotesUrl,
    }
  }

  const { manifest } = check
  const version = safeVersionDirectory(manifest.runtime.version)
  const runtimesRoot = path.join(resolvedDataRoot, 'runtimes')
  const updatesRoot = path.join(resolvedDataRoot, 'updates')
  const targetRoot = path.join(runtimesRoot, version)
  assertDirectChild(targetRoot, runtimesRoot, 'runtime target')
  await mkdir(runtimesRoot, { recursive: true })
  await mkdir(updatesRoot, { recursive: true })

  if (await pathExists(targetRoot)) {
    const validation = await validateRuntimeTree(targetRoot, version)
    return {
      status: 'already-prepared',
      currentVersion,
      version,
      runtimePath: targetRoot,
      size: manifest.runtime.asset.size,
      sha256: manifest.runtime.asset.sha256,
      files: validation.files,
    }
  }

  const transaction = `${process.pid}-${randomUUID()}`
  const partialPath = path.join(updatesRoot, `runtime-${version}-${transaction}.partial`)
  const stagingRoot = path.join(updatesRoot, `staging-${version}-${transaction}`)
  assertDirectChild(partialPath, updatesRoot, 'partial download')
  assertDirectChild(stagingRoot, updatesRoot, 'staging directory')

  let moved = false
  try {
    const downloaded = await downloadAndHash(
      manifest.runtime.asset.url,
      partialPath,
      manifest.runtime.asset,
      { testMode },
    )
    await listAndValidateArchive(partialPath, { tarPath })
    await mkdir(stagingRoot, { recursive: false })
    await runTar(['-xf', partialPath, '-C', stagingRoot], tarPath)
    const stagedRuntime = path.join(stagingRoot, 'runtime')
    const validation = await validateRuntimeTree(stagedRuntime, version)
    try {
      await rename(stagedRuntime, targetRoot)
      moved = true
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
      await validateRuntimeTree(targetRoot, version)
    }
    return {
      status: moved ? 'prepared' : 'already-prepared',
      currentVersion,
      version,
      runtimePath: targetRoot,
      size: downloaded.size,
      sha256: downloaded.sha256,
      files: validation.files,
    }
  } finally {
    await rm(partialPath, { force: true }).catch(() => {})
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function parseCliArguments(argv) {
  const [command, ...rest] = argv
  if (command !== 'check' && command !== 'prepare') {
    fail('CLI_INVALID', 'command must be check or prepare')
  }
  const values = new Map()
  let testMode = false
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--test-mode') {
      if (testMode) fail('CLI_INVALID', '--test-mode was provided more than once')
      testMode = true
      continue
    }
    if (!['--manifest', '--data-root', '--current-version'].includes(argument)) {
      fail('CLI_INVALID', `unknown argument: ${argument}`)
    }
    if (values.has(argument)) fail('CLI_INVALID', `${argument} was provided more than once`)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) fail('CLI_INVALID', `${argument} requires a value`)
    values.set(argument, value)
    index += 1
  }
  for (const required of ['--manifest', '--data-root', '--current-version']) {
    if (!values.has(required)) fail('CLI_INVALID', `${required} is required`)
  }
  return {
    command,
    manifestUrl: values.get('--manifest'),
    dataRoot: assertSafeDataRoot(values.get('--data-root')),
    currentVersion: values.get('--current-version'),
    testMode,
  }
}

function publicResult(command, result) {
  return {
    ok: true,
    command,
    status: result.status,
    currentVersion: result.currentVersion,
    version: result.version,
    minimumLauncherVersion: result.minimumLauncherVersion,
    size: result.size,
    sha256: result.sha256,
    releaseNotesUrl: result.releaseNotesUrl,
    runtimePath: result.runtimePath,
    files: result.files,
  }
}

function publicError(command, error) {
  return {
    ok: false,
    command: command === 'check' || command === 'prepare' ? command : null,
    error: {
      code: error instanceof UpdaterError ? error.code : 'UNEXPECTED_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

export async function main(argv = process.argv.slice(2)) {
  let command = argv[0]
  try {
    const options = parseCliArguments(argv)
    command = options.command
    const result =
      command === 'check'
        ? await checkForUpdate(options)
        : await prepareRuntime(options)
    process.stdout.write(`${JSON.stringify(publicResult(command, result))}\n`)
    return 0
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicError(command, error))}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  process.exitCode = await main()
}
