# Runtime-only update package

`build-runtime-update.ps1` creates the versioned runtime ZIP consumed by the
desktop launcher's updater. It does not package the launcher executable, user
data, logs, `.dsh`, or a Node.js runtime. The source directory is selected
explicitly, and only its `node_modules` tree is staged.

Example (PowerShell 7):

```powershell
$root = (Resolve-Path '..').Path
$node = Join-Path $root 'toolchains\node-v24.19.0-win-x64\node.exe'
$output = Join-Path $root 'dist\runtime'
pwsh -NoProfile -File .\build-runtime-update.ps1 `
  -SourceRoot $root `
  -Version 0.1.1-rc.2 `
  -OutputDirectory $output `
  -NodeExecutable $node
```

The command refuses to overwrite an existing asset. It emits:

- `dsh-runtime-<version>-win-x64.zip`, whose only top-level directory is
  `runtime/`;
- a matching `.metadata.json` file containing the exact byte size and SHA256.

Every package is extracted to a separate temporary directory and verified
before publication. The verifier checks safe archive paths and entry types,
`runtime/runtime.json`, the fixed DSH entry, and the installed DSH package
name/version.

Run the small fixture tests with:

```powershell
pwsh -NoProfile -File .\tests\runtime-package.tests.ps1 `
  -NodeExecutable $node
```

Before publishing a real asset, exercise the launcher's own updater against it
in local test mode:

```powershell
pwsh -NoProfile -File .\tests\updater-compatibility.tests.ps1 `
  -Archive (Join-Path $output 'dsh-runtime-0.1.1-rc.2-win-x64.zip') `
  -Version 0.1.1-rc.2 `
  -UpdaterScript (Join-Path $root 'launcher\updater.mjs') `
  -NodeExecutable $node
```
