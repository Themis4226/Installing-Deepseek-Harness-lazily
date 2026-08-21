#!/usr/bin/env node

import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const nodeModules = path.resolve(process.argv[2] ?? '')
if (!process.argv[2] || path.basename(nodeModules).toLocaleLowerCase('en-US') !== 'node_modules') {
  throw new Error('Usage: node sanitize-pnpm-bin-shims.mjs <absolute-node_modules-path>')
}
if (!path.isAbsolute(process.argv[2])) {
  throw new Error('node_modules path must be absolute')
}

let inspected = 0
let sanitized = 0
let removedMarkers = 0
let removedMetadata = 0

const binDirectories = []
const pending = [nodeModules]
while (pending.length > 0) {
  const directory = pending.pop()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path.join(directory, entry.name)}`)
    if (!entry.isDirectory()) continue
    const entryPath = path.join(directory, entry.name)
    if (entry.name === '.bin') binDirectories.push(entryPath)
    else pending.push(entryPath)
  }
}

for (const binDirectory of binDirectories) {
  const entries = await readdir(binDirectory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(binDirectory, entry.name)
    const metadata = await lstat(filePath)
    if (metadata.isSymbolicLink()) throw new Error(`Refusing symbolic link in .bin: ${filePath}`)
    const bytes = await readFile(filePath)
    if (bytes.includes(0)) continue
    inspected += 1
    const text = bytes.toString('utf8')
    let fileMarkers = 0
    const cleaned = text.replace(/^# cmd-shim-target=.*(?:\r?\n|$)/gmu, () => {
      fileMarkers += 1
      return ''
    })
    if (fileMarkers === 0) continue
    await writeFile(filePath, cleaned, 'utf8')
    sanitized += 1
    removedMarkers += fileMarkers
  }
}

for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) {
  const metadataPath = path.join(nodeModules, name)
  const metadata = await lstat(metadataPath).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (metadata === null) continue
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Unexpected pnpm metadata type: ${metadataPath}`)
  }
  await rm(metadataPath)
  removedMetadata += 1
}

const virtualStore = path.join(nodeModules, '.pnpm')
const virtualEntries = await readdir(virtualStore).catch((error) => {
  if (error?.code === 'ENOENT') return null
  throw error
})
if (virtualEntries !== null) {
  if (virtualEntries.some((name) => name !== 'lock.yaml')) {
    throw new Error('Refusing to remove a non-metadata .pnpm virtual store')
  }
  await rm(virtualStore, { recursive: true })
  removedMetadata += 1
}

process.stdout.write(`${JSON.stringify({ binDirectories: binDirectories.length, inspected, sanitized, removedMarkers, removedMetadata })}\n`)
