# DSH maintainer official update check

This is a local maintainer-only DSH bundle. It adds an **官方更新检查** row
after the existing launcher-owned **检查更新** row in General settings.

The browser half reads the installed runtime version from the launcher's
existing read-only handshake and queries only:

`https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest`

It does not install packages, mutate the managed runtime, create releases,
write repository files, or hold GitHub/npm credentials.

Install it only into the maintainer's `web` profile from this checkout:

```powershell
$pluginPath = (Resolve-Path '.\launcher-integration\dsh-official-update-check').Path
node.exe node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add "file:$pluginPath"
```

`pnpm` must be available on `PATH`, as required by DSH's plugin manager. Restart
the desktop launcher after installation. DSH records the dependency and bundle
only in `%USERPROFILE%\.dsh\profiles\web`; the public runtime and Lite package
remain unchanged.

Remove it with:

```powershell
node.exe node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web remove @themis4226/dsh-official-update-check
```

The package is intentionally `private` and should not be included by runtime or
Lite packaging scripts.
