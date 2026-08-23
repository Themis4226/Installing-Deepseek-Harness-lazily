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

export const LAUNCHER_VERSION = '1.4.0'
export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/update.json'
export const DEFAULT_LAUNCHER_MANIFEST_URL =
  'https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/launcher-update.json'
export const RUNTIME_PLATFORM = 'win32'
export const RUNTIME_ARCH = 'x64'
export const RUNTIME_FORMAT = 'dsh-runtime-zip-v1'
export const LAUNCHER_FORMAT = 'portable-exe-v1'
export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const FIXED_RUNTIME_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
export const FIXED_LAUNCHER_FILE = 'DeepSeek Harness.exe'

const RUNTIME_METADATA_FILE = 'runtime.json'
const RUNTIME_ALLOWED_TOP_LEVEL = new Set(['node_modules', RUNTIME_METADATA_FILE])
const FORBIDDEN_LAUNCHER_PACKAGE_ROOTS = [
  'runtime/node_modules/@themis4226/dsh-launcher-update-ui',
  'runtime/node_modules/@themis4226/dsh-official-update-check',
]
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MAX_LAUNCHER_ASSET_BYTES = 32 * 1024 * 1024
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
    if (Number.isInteger(options?.httpStatus)) this.httpStatus = options.httpStatus
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
  if ((kind === 'manifest' || kind === 'launcher-manifest') && !redirect) {
    const expected = kind === 'manifest' ? DEFAULT_MANIFEST_URL : DEFAULT_LAUNCHER_MANIFEST_URL
    if (url.href !== expected) {
      fail('URL_NOT_ALLOWED', `production ${kind} URL must be ${expected}`)
    }
    return
  }
  if ((kind === 'asset' || kind === 'launcher-asset') && !redirect) {
    if (hostname !== 'github.com' || !url.pathname.startsWith(RELEASE_ASSET_PREFIX)) {
      fail('URL_NOT_ALLOWED', `${kind} must be a Release asset from the configured repository`)
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

export function validateLauncherManifest(value, { testMode = false } = {}) {
  requireExactKeys(
    value,
    ['schemaVersion', 'channel', 'publishedAt', 'launcher', 'releaseNotesUrl'],
    [],
    'launcher manifest',
  )
  if (value.schemaVersion !== 1) fail('SCHEMA_INVALID', 'launcher manifest schemaVersion must be 1')
  if (value.channel !== 'preview' && value.channel !== 'stable') {
    fail('SCHEMA_INVALID', 'launcher manifest channel must be preview or stable')
  }
  if (
    typeof value.publishedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.publishedAt) ||
    !Number.isFinite(Date.parse(value.publishedAt))
  ) {
    fail('SCHEMA_INVALID', 'launcher manifest publishedAt must be an ISO-8601 UTC timestamp')
  }

  requireExactKeys(
    value.launcher,
    ['version', 'platform', 'arch', 'format', 'asset'],
    [],
    'launcher',
  )
  parseSemver(value.launcher.version, 'launcher.version')
  if (value.launcher.platform !== RUNTIME_PLATFORM) {
    fail('PLATFORM_MISMATCH', `launcher.platform must be ${RUNTIME_PLATFORM}`)
  }
  if (value.launcher.arch !== RUNTIME_ARCH) {
    fail('ARCH_MISMATCH', `launcher.arch must be ${RUNTIME_ARCH}`)
  }
  if (value.launcher.format !== LAUNCHER_FORMAT) {
    fail('FORMAT_MISMATCH', `launcher.format must be ${LAUNCHER_FORMAT}`)
  }

  requireExactKeys(value.launcher.asset, ['url', 'size', 'sha256'], [], 'launcher.asset')
  const assetUrl = parseUrl(value.launcher.asset.url, 'launcher.asset.url')
  validateFetchUrl(assetUrl, { testMode, kind: 'launcher-asset' })
  if (
    !Number.isSafeInteger(value.launcher.asset.size) ||
    value.launcher.asset.size <= 0 ||
    value.launcher.asset.size > MAX_LAUNCHER_ASSET_BYTES
  ) {
    fail('SCHEMA_INVALID', `launcher.asset.size must be between 1 and ${MAX_LAUNCHER_ASSET_BYTES}`)
  }
  if (
    typeof value.launcher.asset.sha256 !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(value.launcher.asset.sha256)
  ) {
    fail('SCHEMA_INVALID', 'launcher.asset.sha256 must contain exactly 64 hexadecimal characters')
  }

  return Object.freeze({
    schemaVersion: 1,
    channel: value.channel,
    publishedAt: value.publishedAt,
    releaseNotesUrl: validateReleaseNotesUrl(value.releaseNotesUrl, testMode),
    launcher: Object.freeze({
      version: value.launcher.version,
      platform: RUNTIME_PLATFORM,
      arch: RUNTIME_ARCH,
      format: LAUNCHER_FORMAT,
      asset: Object.freeze({
        url: assetUrl.href,
        size: value.launcher.asset.size,
        sha256: value.launcher.asset.sha256.toLowerCase(),
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
          Accept: kind.endsWith('manifest') ? 'application/json' : 'application/octet-stream',
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
          reject(
            new UpdaterError('HTTP_ERROR', `${kind} request returned HTTP ${status}`, {
              httpStatus: status,
            }),
          )
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

export async function loadLauncherManifest(manifestUrl, { testMode = false } = {}) {
  const url = parseUrl(manifestUrl, 'launcher manifest URL')
  validateFetchUrl(url, { testMode, kind: 'launcher-manifest' })
  let bytes
  try {
    const stream = await requestStream(url, { testMode, kind: 'launcher-manifest' })
    bytes = await readLimited(stream, MAX_MANIFEST_BYTES, 'launcher manifest')
  } catch (error) {
    if (error instanceof UpdaterError) throw error
    fail('MANIFEST_DOWNLOAD_FAILED', `unable to read launcher update manifest: ${error.message}`, { cause: error })
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    fail('MANIFEST_JSON_INVALID', 'launcher update manifest is not valid UTF-8 JSON', { cause: error })
  }
  return validateLauncherManifest(parsed, { testMode })
}

function updateStatus(manifest, currentVersion, launcherVersion = LAUNCHER_VERSION) {
  parseSemver(currentVersion, 'current version')
  parseSemver(launcherVersion, 'launcher version')
  if (compareSemver(launcherVersion, manifest.minimumLauncherVersion) < 0) {
    return 'launcher-update-required'
  }
  return compareSemver(manifest.runtime.version, currentVersion) > 0
    ? 'update-available'
    : 'up-to-date'
}

export async function checkForUpdate({
  manifestUrl,
  currentVersion,
  launcherVersion = LAUNCHER_VERSION,
  testMode = false,
}) {
  const manifest = await loadManifest(manifestUrl, { testMode })
  return {
    status: updateStatus(manifest, currentVersion, launcherVersion),
    currentVersion,
    version: manifest.runtime.version,
    minimumLauncherVersion: manifest.minimumLauncherVersion,
    releaseNotesUrl: manifest.releaseNotesUrl,
    size: manifest.runtime.asset.size,
    sha256: manifest.runtime.asset.sha256,
    manifest,
  }
}

export async function checkForBundle({
  manifestUrl,
  launcherManifestUrl,
  currentVersion,
  currentLauncherVersion = LAUNCHER_VERSION,
  testMode = false,
}) {
  parseSemver(currentVersion, 'current runtime version')
  parseSemver(currentLauncherVersion, 'current launcher version')
  const [runtimeManifest, launcherManifest] = await Promise.all([
    loadManifest(manifestUrl, { testMode }),
    loadLauncherManifest(launcherManifestUrl, { testMode }).catch((error) => {
      if (
        error instanceof UpdaterError &&
        error.code === 'HTTP_ERROR' &&
        error.httpStatus === 404
      ) {
        return null
      }
      throw error
    }),
  ])
  const launcherManifestAvailable = launcherManifest !== null
  const runtimeUpdateAvailable = compareSemver(runtimeManifest.runtime.version, currentVersion) > 0
  const launcherUpdateAvailable =
    launcherManifestAvailable &&
    compareSemver(launcherManifest.launcher.version, currentLauncherVersion) > 0
  const effectiveLauncherVersion = launcherUpdateAvailable
    ? launcherManifest.launcher.version
    : currentLauncherVersion

  let status = 'up-to-date'
  if (
    runtimeUpdateAvailable &&
    compareSemver(effectiveLauncherVersion, runtimeManifest.minimumLauncherVersion) < 0
  ) {
    status = 'release-incomplete'
  } else if (launcherUpdateAvailable) {
    status = 'launcher-update-available'
  } else if (runtimeUpdateAvailable) {
    status = 'update-available'
  } else if (!launcherManifestAvailable) {
    status = 'launcher-feed-unavailable'
  }

  return {
    status,
    currentVersion,
    currentLauncherVersion,
    runtimeUpdateAvailable,
    launcherUpdateAvailable,
    runtimeVersion: runtimeManifest.runtime.version,
    runtimeSize: runtimeManifest.runtime.asset.size,
    runtimeSha256: runtimeManifest.runtime.asset.sha256,
    minimumLauncherVersion: runtimeManifest.minimumLauncherVersion,
    launcherManifestAvailable,
    launcherVersion: launcherManifestAvailable
      ? launcherManifest.launcher.version
      : currentLauncherVersion,
    launcherSize: launcherManifest?.launcher.asset.size,
    launcherSha256: launcherManifest?.launcher.asset.sha256,
    releaseNotesUrl: launcherUpdateAvailable
      ? launcherManifest.releaseNotesUrl
      : runtimeManifest.releaseNotesUrl,
    runtimeManifest,
    launcherManifest,
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

export async function downloadAndHash(
  urlValue,
  destination,
  expected,
  { testMode = false, kind = 'asset', maxBytes = MAX_ASSET_BYTES } = {},
) {
  const label = kind === 'launcher-asset' ? 'launcher asset' : 'runtime asset'
  const url = parseUrl(urlValue, `${label} URL`)
  validateFetchUrl(url, { testMode, kind })
  const source = await requestStream(url, { testMode, kind })
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > expected.size || size > maxBytes) {
        callback(new UpdaterError('SIZE_MISMATCH', `${label} exceeds expected size ${expected.size}`))
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
    fail('ASSET_DOWNLOAD_FAILED', `unable to download ${label}: ${error.message}`, { cause: error })
  }
  if (size !== expected.size) {
    await rm(destination, { force: true }).catch(() => {})
    fail('SIZE_MISMATCH', `${label} size is ${size}, expected ${expected.size}`)
  }
  const digest = hash.digest('hex')
  if (digest !== expected.sha256.toLowerCase()) {
    await rm(destination, { force: true }).catch(() => {})
    fail('HASH_MISMATCH', `${label} SHA256 is ${digest}, expected ${expected.sha256.toLowerCase()}`)
  }
  return { size, sha256: digest }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function validateLauncherExecutable(executablePath, expected) {
  const metadata = await lstat(executablePath).catch(() => null)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    fail('LAUNCHER_INVALID', `launcher executable is missing or unsafe: ${executablePath}`)
  }
  if (metadata.size !== expected.size) {
    fail('SIZE_MISMATCH', `launcher executable size is ${metadata.size}, expected ${expected.size}`)
  }
  const digest = await sha256File(executablePath)
  if (digest !== expected.sha256.toLowerCase()) {
    fail('HASH_MISMATCH', `launcher executable SHA256 is ${digest}, expected ${expected.sha256.toLowerCase()}`)
  }

  const handle = await open(executablePath, 'r')
  try {
    const dosHeader = Buffer.alloc(64)
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0)
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      fail('LAUNCHER_INVALID', 'launcher executable does not have a valid DOS header')
    }
    const peOffset = dosHeader.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset > 1024 * 1024) {
      fail('LAUNCHER_INVALID', 'launcher executable has an unsafe PE header offset')
    }
    const peHeader = Buffer.alloc(26)
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset)
    if (
      peRead.bytesRead !== peHeader.length ||
      peHeader.readUInt32LE(0) !== 0x00004550 ||
      peHeader.readUInt16LE(4) !== 0x8664 ||
      peHeader.readUInt16LE(24) !== 0x020b
    ) {
      fail('LAUNCHER_INVALID', 'launcher executable is not a PE32+ AMD64 application')
    }
  } finally {
    await handle.close()
  }
  return { size: metadata.size, sha256: digest }
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
  const forbiddenRoots = FORBIDDEN_LAUNCHER_PACKAGE_ROOTS.map((value) => value.toLowerCase())
  for (const name of entryNames) {
    const normalized = validateArchiveEntryName(name)
    const folded = normalized.toLowerCase()
    if (seen.has(folded)) {
      fail('ARCHIVE_ENTRY_INVALID', `archive contains a duplicate path: ${name}`)
    }
    const directChild = normalized.split('/')[1]
    if (directChild !== undefined && !RUNTIME_ALLOWED_TOP_LEVEL.has(directChild)) {
      fail('ARCHIVE_ENTRY_INVALID', `runtime/ contains an unexpected top-level entry: ${directChild}`)
    }
    if (forbiddenRoots.some((root) => folded === root || folded.startsWith(`${root}/`))) {
      fail('ARCHIVE_ENTRY_INVALID', 'runtime archive contains a launcher-only package')
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
  const runtimeTopLevel = await readdir(runtimeRoot)
  for (const entry of runtimeTopLevel) {
    if (!RUNTIME_ALLOWED_TOP_LEVEL.has(entry)) {
      fail('RUNTIME_INVALID', `runtime contains an unexpected top-level entry: ${entry}`)
    }
  }
  for (const packageName of ['dsh-launcher-update-ui', 'dsh-official-update-check']) {
    const packagePath = path.join(runtimeRoot, 'node_modules', '@themis4226', packageName)
    if (await lstat(packagePath).catch(() => null)) {
      fail('RUNTIME_INVALID', `runtime contains a launcher-only package: ${packageName}`)
    }
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
  launcherVersion = LAUNCHER_VERSION,
  testMode = false,
  tarPath,
}) {
  const resolvedDataRoot = assertSafeDataRoot(dataRoot)
  const check = await checkForUpdate({ manifestUrl, currentVersion, launcherVersion, testMode })
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

export async function prepareLauncher({
  launcherManifestUrl,
  dataRoot,
  currentLauncherVersion = LAUNCHER_VERSION,
  testMode = false,
}) {
  const resolvedDataRoot = assertSafeDataRoot(dataRoot)
  parseSemver(currentLauncherVersion, 'current launcher version')
  const manifest = await loadLauncherManifest(launcherManifestUrl, { testMode })
  const version = safeVersionDirectory(manifest.launcher.version)
  if (compareSemver(version, currentLauncherVersion) <= 0) {
    return {
      status: 'launcher-up-to-date',
      currentLauncherVersion,
      launcherVersion: version,
      releaseNotesUrl: manifest.releaseNotesUrl,
    }
  }

  const updatesRoot = path.join(resolvedDataRoot, 'updates')
  const launchersRoot = path.join(updatesRoot, 'launchers')
  const targetRoot = path.join(launchersRoot, version)
  const targetPath = path.join(targetRoot, FIXED_LAUNCHER_FILE)
  assertDirectChild(targetRoot, launchersRoot, 'launcher target')
  await mkdir(launchersRoot, { recursive: true })

  if (await pathExists(targetRoot)) {
    await validateLauncherExecutable(targetPath, manifest.launcher.asset)
    return {
      status: 'launcher-already-prepared',
      currentLauncherVersion,
      launcherVersion: version,
      launcherPath: targetPath,
      launcherSize: manifest.launcher.asset.size,
      launcherSha256: manifest.launcher.asset.sha256,
      releaseNotesUrl: manifest.releaseNotesUrl,
    }
  }

  const transaction = `${process.pid}-${randomUUID()}`
  const stagingRoot = path.join(updatesRoot, `launcher-staging-${version}-${transaction}`)
  const stagedPath = path.join(stagingRoot, FIXED_LAUNCHER_FILE)
  assertDirectChild(stagingRoot, updatesRoot, 'launcher staging directory')
  let moved = false
  try {
    await mkdir(stagingRoot, { recursive: false })
    const downloaded = await downloadAndHash(
      manifest.launcher.asset.url,
      stagedPath,
      manifest.launcher.asset,
      { testMode, kind: 'launcher-asset', maxBytes: MAX_LAUNCHER_ASSET_BYTES },
    )
    await validateLauncherExecutable(stagedPath, manifest.launcher.asset)
    try {
      await rename(stagingRoot, targetRoot)
      moved = true
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
      await validateLauncherExecutable(targetPath, manifest.launcher.asset)
    }
    return {
      status: moved ? 'launcher-prepared' : 'launcher-already-prepared',
      currentLauncherVersion,
      launcherVersion: version,
      launcherPath: targetPath,
      launcherSize: downloaded.size,
      launcherSha256: downloaded.sha256,
      releaseNotesUrl: manifest.releaseNotesUrl,
    }
  } finally {
    if (!moved) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export async function prepareBundle({
  manifestUrl,
  launcherManifestUrl,
  dataRoot,
  currentVersion,
  currentLauncherVersion = LAUNCHER_VERSION,
  testMode = false,
  tarPath,
}) {
  const checked = await checkForBundle({
    manifestUrl,
    launcherManifestUrl,
    currentVersion,
    currentLauncherVersion,
    testMode,
  })
  if (
    checked.status === 'up-to-date' ||
    checked.status === 'launcher-feed-unavailable' ||
    checked.status === 'release-incomplete'
  ) {
    return checked
  }

  const effectiveLauncherVersion = checked.launcherUpdateAvailable
    ? checked.launcherVersion
    : currentLauncherVersion
  let runtime
  if (checked.runtimeUpdateAvailable) {
    runtime = await prepareRuntime({
      manifestUrl,
      dataRoot,
      currentVersion,
      launcherVersion: effectiveLauncherVersion,
      testMode,
      tarPath,
    })
    if (
      (runtime.status !== 'prepared' && runtime.status !== 'already-prepared') ||
      runtime.version !== checked.runtimeVersion
    ) {
      return {
        status: 'release-changed',
        currentVersion,
        currentLauncherVersion,
        releaseNotesUrl: checked.releaseNotesUrl,
      }
    }
  }
  let launcher
  if (checked.launcherUpdateAvailable) {
    launcher = await prepareLauncher({
      launcherManifestUrl,
      dataRoot,
      currentLauncherVersion,
      testMode,
    })
    if (
      (launcher.status !== 'launcher-prepared' && launcher.status !== 'launcher-already-prepared') ||
      launcher.launcherVersion !== checked.launcherVersion
    ) {
      return {
        status: 'release-changed',
        currentVersion,
        currentLauncherVersion,
        releaseNotesUrl: checked.releaseNotesUrl,
      }
    }
  }

  if (launcher) {
    return {
      status: 'bundle-prepared',
      currentVersion,
      currentLauncherVersion,
      runtimeVersion: runtime?.version,
      runtimePath: runtime?.runtimePath,
      launcherVersion: launcher.launcherVersion,
      launcherPath: launcher.launcherPath,
      launcherSize: launcher.launcherSize,
      launcherSha256: launcher.launcherSha256,
      releaseNotesUrl: launcher.releaseNotesUrl,
    }
  }
  return runtime
}

export function parseCliArguments(argv) {
  const [command, ...rest] = argv
  const commands = new Set(['check', 'prepare', 'check-bundle', 'prepare-bundle'])
  if (!commands.has(command)) {
    fail('CLI_INVALID', 'command must be check, prepare, check-bundle, or prepare-bundle')
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
    if (
      ![
        '--manifest',
        '--launcher-manifest',
        '--data-root',
        '--current-version',
        '--current-launcher-version',
      ].includes(argument)
    ) {
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
  const bundleCommand = command === 'check-bundle' || command === 'prepare-bundle'
  if (bundleCommand) {
    for (const required of ['--launcher-manifest', '--current-launcher-version']) {
      if (!values.has(required)) fail('CLI_INVALID', `${required} is required`)
    }
  } else if (values.has('--launcher-manifest') || values.has('--current-launcher-version')) {
    fail('CLI_INVALID', 'launcher manifest arguments are only valid for bundle commands')
  }
  return {
    command,
    manifestUrl: values.get('--manifest'),
    launcherManifestUrl: values.get('--launcher-manifest'),
    dataRoot: assertSafeDataRoot(values.get('--data-root')),
    currentVersion: values.get('--current-version'),
    currentLauncherVersion: values.get('--current-launcher-version'),
    testMode,
  }
}

function publicResult(command, result) {
  return {
    ok: true,
    command,
    status: result.status,
    currentVersion: result.currentVersion,
    currentLauncherVersion: result.currentLauncherVersion,
    version: result.version,
    minimumLauncherVersion: result.minimumLauncherVersion,
    size: result.size,
    sha256: result.sha256,
    releaseNotesUrl: result.releaseNotesUrl,
    runtimePath: result.runtimePath,
    runtimeVersion: result.runtimeVersion,
    runtimeSize: result.runtimeSize,
    runtimeSha256: result.runtimeSha256,
    runtimeUpdateAvailable: result.runtimeUpdateAvailable,
    launcherVersion: result.launcherVersion,
    launcherPath: result.launcherPath,
    launcherSize: result.launcherSize,
    launcherSha256: result.launcherSha256,
    launcherUpdateAvailable: result.launcherUpdateAvailable,
    launcherManifestAvailable: result.launcherManifestAvailable,
    files: result.files,
  }
}

function publicError(command, error) {
  const validCommands = new Set(['check', 'prepare', 'check-bundle', 'prepare-bundle'])
  return {
    ok: false,
    command: validCommands.has(command) ? command : null,
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
    let result
    switch (command) {
      case 'check':
        result = await checkForUpdate(options)
        break
      case 'prepare':
        result = await prepareRuntime(options)
        break
      case 'check-bundle':
        result = await checkForBundle(options)
        break
      case 'prepare-bundle':
        result = await prepareBundle(options)
        break
      default:
        fail('CLI_INVALID', `unsupported command: ${command}`)
    }
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
