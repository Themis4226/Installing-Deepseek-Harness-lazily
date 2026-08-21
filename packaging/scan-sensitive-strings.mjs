#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const rootArgument = process.argv[2]
if (!rootArgument || !path.isAbsolute(rootArgument)) {
  throw new Error('Usage: node scan-sensitive-strings.mjs <absolute-root> <sensitive-string ...>')
}
const root = path.resolve(rootArgument)
if (root === path.parse(root).root) throw new Error('Refusing to scan a filesystem root')

const needles = process.argv.slice(3).filter(Boolean).flatMap((value) => [
  { label: `${value} (UTF-8)`, bytes: Buffer.from(value, 'utf8') },
  { label: `${value} (UTF-16LE)`, bytes: Buffer.from(value, 'utf16le') },
])
if (needles.length === 0) throw new Error('At least one sensitive string is required')

let files = 0
let bytes = 0
const pending = [root]
while (pending.length > 0) {
  const directory = pending.pop()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    const metadata = await lstat(filePath)
    if (metadata.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${filePath}`)
    if (metadata.isDirectory()) {
      if (entry.name === '.git') continue
      pending.push(filePath)
      continue
    }
    if (!metadata.isFile()) continue
    files += 1
    bytes += metadata.size
    if (metadata.size === 0) continue
    const contents = await readFile(filePath)
    for (const needle of needles) {
      if (needle.bytes.length > 0 && contents.indexOf(needle.bytes) >= 0) {
        throw new Error(`Sensitive string ${needle.label} found in ${filePath}`)
      }
    }
  }
}

process.stdout.write(`${JSON.stringify({ files, bytes, sensitiveMatches: 0 })}\n`)
