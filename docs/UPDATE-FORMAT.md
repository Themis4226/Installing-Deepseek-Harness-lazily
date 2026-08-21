# DSH runtime update format v1

This document defines the update contract implemented by DSH Desktop Launcher 1.2.0. It is intended for release
maintainers and for users who want to audit what the launcher downloads.

## What is updated

The 1.2.0 updater replaces only the versioned DSH runtime. It does not update the launcher executable, Node.js,
Microsoft Edge WebView2 Runtime, or `%USERPROFILE%\.dsh`. A user coming from launcher 1.1.0 must first install the
complete 1.2.0 package because 1.1.0 contains no updater.

Runtime-only is not the same as binary delta. Every update archive contains a complete runnable dependency tree for
one pinned DSH version, so the transfer can still be large.

## Production feed

The production client reads this exact feed:

`https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/update.json`

Production assets must be HTTPS GitHub Release downloads from this repository. Local files and localhost URLs are
accepted only when the launcher is explicitly placed in test mode; test overrides must never be present in a public
release shortcut or package.

`update.example.json` is an annotated-by-documentation template only. Its zero digest and sample size are deliberately
invalid for production. Do not copy it to `update.json` without replacing every release-specific value.

## Manifest schema

The feed is UTF-8 JSON with these v1 fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Must be `1`. |
| `channel` | string | Release channel: `preview` or `stable` (the initial feed uses `preview`). |
| `publishedAt` | string | UTC ISO 8601 publication time. |
| `minimumLauncherVersion` | string | Minimum launcher semantic version able to install this runtime. |
| `runtime.version` | string | Exact DSH package version and versioned directory name. |
| `runtime.platform` | string | Must be `win32` for this feed. |
| `runtime.arch` | string | Must be `x64` for this feed. |
| `runtime.format` | string | Must be `dsh-runtime-zip-v1`. |
| `runtime.asset.url` | string | Immutable HTTPS GitHub Release asset URL in this repository. |
| `runtime.asset.size` | integer | Exact asset size in bytes. |
| `runtime.asset.sha256` | string | Lowercase 64-character SHA-256 digest. |
| `releaseNotesUrl` | string | HTTPS link to the matching GitHub Release notes. |

The updater rejects unknown or missing keys rather than guessing their meaning. A future incompatible layout must use
a new `schemaVersion` and `runtime.format`.

## ZIP layout

Every archive entry must be below one top-level `runtime/` directory. A minimal layout is:

```text
runtime/
  runtime.json
  node_modules/
    @deepseek-ai/
      dsh/
        package.json
        lib/
          bin.js
```

For format v1, `runtime/` has exactly two direct children: `runtime.json` and `node_modules/`. Third-party license and
notice files remain inside their respective dependency directories. The full desktop package additionally carries a
generated license inventory under its own top-level `licenses/` directory.

`runtime/runtime.json` has exactly these fields: `schemaVersion`, `dshPackage`, `dshVersion`, `platform`, `arch`, and
`entry`. For format v1, `entry` is `node_modules/@deepseek-ai/dsh/lib/bin.js`. The package version in
`node_modules/@deepseek-ai/dsh/package.json` must match both `runtime.json` and the feed.

```json
{
  "schemaVersion": 1,
  "dshPackage": "@deepseek-ai/dsh",
  "dshVersion": "0.1.1-rc.2",
  "platform": "win32",
  "arch": "x64",
  "entry": "node_modules/@deepseek-ai/dsh/lib/bin.js"
}
```

Archives must not contain absolute paths, `..` traversal, backslash-form paths, symbolic links, hard links, device
nodes, or entries outside `runtime/`. The v1 client also imposes compressed-size, expanded-size, and file-count limits.

## Download, staging, and activation

1. Fetch and strictly validate the manifest.
2. Stream the asset while counting bytes and calculating SHA-256.
3. Inspect archive entries, then extract into a new staging directory.
4. Validate `runtime.json`, the pinned package version, and the fixed `lib/bin.js` entry point.
5. Atomically rename the completed tree to
   `%LOCALAPPDATA%\DSH Desktop Launcher\runtimes\<version>\`.
6. Record the candidate as pending while retaining the previous runtime.
7. Start DSH and load its local page. Mark the candidate healthy only after both steps succeed.
8. If the pending launch fails, restore the previous runtime and retry once.

The updater must not modify `%USERPROFILE%\.dsh`. An already validated version directory may be reused, but a partial
staging directory must never become active.

## Safe publication order

1. Build the full package and runtime archive from a clean, pinned dependency tree.
2. Generate and review dependency notices; scan the staging tree for local data and secrets.
3. Calculate the final asset byte size and SHA-256.
4. Create a draft GitHub Release, upload assets and checksums, then download and verify them independently.
5. Publish the GitHub Release and confirm its immutable asset URLs work without authentication.
6. Commit `update.json` to `main` **last**, using the exact downloaded size and digest.
7. Fetch the raw production feed and perform one clean-machine or clean-data-root update test.

Publishing `update.json` before its referenced asset is publicly available creates a broken update window and is not
supported.
