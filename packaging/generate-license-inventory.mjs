import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const stageRoot = path.resolve(process.argv[2] ?? '')
const outputRoot = path.resolve(process.argv[3] ?? path.join(stageRoot, 'licenses'))

if (!process.argv[2] || !stageRoot) {
  throw new Error('Usage: node generate-license-inventory.mjs <stage-root> [output-root]')
}

const packageRecords = []

function csv(value) {
  const text = String(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
}

function repositoryOf(pkg) {
  if (typeof pkg.repository === 'string') return pkg.repository
  if (pkg.repository && typeof pkg.repository.url === 'string') return pkg.repository.url
  return pkg.homepage ?? ''
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((item) => typeof item === 'string' ? item : item?.type).filter(Boolean).join(' OR ')
  }
  return 'UNDECLARED'
}

async function scanNodeModules(nodeModulesRoot) {
  let entries
  try {
    entries = await readdir(nodeModulesRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  const packageDirectories = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    const entryPath = path.join(nodeModulesRoot, entry.name)
    if (entry.name.startsWith('@')) {
      const scopedEntries = await readdir(entryPath, { withFileTypes: true })
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) packageDirectories.push(path.join(entryPath, scopedEntry.name))
      }
    } else {
      packageDirectories.push(entryPath)
    }
  }

  for (const packageDirectory of packageDirectories) {
    let pkg
    try {
      pkg = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new Error(`Cannot read ${packageDirectory}\\package.json: ${error.message}`)
    }

    const packagePath = path.relative(stageRoot, packageDirectory).replaceAll('\\', '/')
    const files = await readdir(packageDirectory, { withFileTypes: true })
    const licenseNames = files
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    const copiedLicenseFiles = []
    for (const licenseName of licenseNames) {
      const destination = path.join(outputRoot, 'npm-texts', packagePath, licenseName)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(packageDirectory, licenseName), destination)
      copiedLicenseFiles.push(path.relative(stageRoot, destination).replaceAll('\\', '/'))
    }

    packageRecords.push({
      name: pkg.name ?? path.basename(packageDirectory),
      version: pkg.version ?? '',
      license: licenseOf(pkg),
      packagePath,
      repository: repositoryOf(pkg),
      licenseFiles: copiedLicenseFiles,
    })

    await scanNodeModules(path.join(packageDirectory, 'node_modules'))
  }
}

await mkdir(outputRoot, { recursive: true })
await scanNodeModules(path.join(stageRoot, 'node_modules'))
packageRecords.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) ||
  a.packagePath.localeCompare(b.packagePath))

const header = ['name', 'version', 'declared_license', 'installed_path', 'repository', 'copied_license_files']
const rows = packageRecords.map((record) => [
  record.name,
  record.version,
  record.license,
  record.packagePath,
  record.repository,
  record.licenseFiles.join('; '),
].map(csv).join(','))
await writeFile(path.join(outputRoot, 'npm-packages.csv'), `\uFEFF${header.map(csv).join(',')}\n${rows.join('\n')}\n`)
await writeFile(path.join(outputRoot, 'npm-packages.json'), `${JSON.stringify(packageRecords, null, 2)}\n`)

const byLicense = Object.fromEntries(
  [...new Set(packageRecords.map((record) => record.license))]
    .sort((a, b) => a.localeCompare(b))
    .map((license) => [license, packageRecords.filter((record) => record.license === license).length]),
)
const withoutText = packageRecords.filter((record) => record.licenseFiles.length === 0)
const summary = [
  '# npm dependency license inventory',
  '',
  `Installed package instances: ${packageRecords.length}`,
  `Packages without a bundled LICENSE/COPYING/NOTICE file: ${withoutText.length}`,
  '',
  '## Declared licenses',
  '',
  ...Object.entries(byLicense).map(([license, count]) => `- ${license}: ${count}`),
  '',
  '## Packages without a bundled license text',
  '',
  ...(withoutText.length === 0
    ? ['None.']
    : withoutText.map((record) =>
      `- ${record.name}@${record.version} — ${record.license} — ${record.repository || record.packagePath}`)),
  '',
  'The original package metadata and all package-bundled license files remain in node_modules.',
  '',
]
await writeFile(path.join(outputRoot, 'README.md'), summary.join('\n'))

console.log(JSON.stringify({ packageInstances: packageRecords.length, licenses: byLicense, withoutText: withoutText.length }))
