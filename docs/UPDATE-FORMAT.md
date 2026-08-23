# DSH launcher and runtime update formats v1

This document defines the runtime update contract introduced by DSH Desktop Launcher 1.2.0 and the separate launcher
update contract introduced by 1.4.0. It is intended for release maintainers and for users who want to audit what the
launcher downloads.

## What is updated

Launcher 1.4.0 can update the versioned DSH runtime, its own executable, or both as one compatibility-gated
transaction. It does not update Node.js, Microsoft Edge WebView2 Runtime, or `%USERPROFILE%\.dsh`. Launcher 1.3.0 and
earlier cannot execute the complete self-replacement protocol and must therefore install the first 1.4.0 full package
manually once. Later compatible releases can use the in-app flow.

Runtime-only is not the same as binary delta. Every update archive contains a complete runnable dependency tree for
one pinned DSH version, so the transfer can still be large.

## Production feed

The production client reads two independent feeds:

`https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/update.json`

`https://raw.githubusercontent.com/Themis4226/Installing-Deepseek-Harness-lazily/main/launcher-update.json`

`update.json` retains its original strict runtime-only schema so that 1.2.x and 1.3.0 clients do not reject it.
Launcher fields must never be added to that file. The second feed is consumed only by launchers that implement the
1.4.0 self-update protocol.

An exact HTTP 404 response for `launcher-update.json` means that the launcher feed has not been published yet. A
1.4.0 client continues to fetch and strictly validate `update.json`; when that runtime is already current, the check
result is `launcher-feed-unavailable`. This exception applies only to the launcher's manifest request and only to
HTTP 404. Any other HTTP status, network failure, redirect or manifest-format error remains fail-closed. Runtime
manifest failures are always fail-closed, and all downloaded assets still require their normal size, SHA-256,
structure, platform, and version checks before activation.

Production assets must be immutable HTTPS GitHub Release downloads from this repository. Local files and localhost
URLs are accepted only when the launcher is explicitly placed in test mode; test overrides must never be present in
a public release shortcut or package.

`update.example.json` is an annotated-by-documentation template only. Its zero digest and sample size are deliberately
invalid for production. `launcher-update.example.json` has the same role for the launcher feed. Do not copy either
example to its production filename without replacing every release-specific value.

## Runtime manifest schema

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

## Launcher manifest schema

`launcher-update.json` is a separate UTF-8 JSON document with these strict v1 fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Must be `1`. |
| `channel` | string | Release channel: `preview` or `stable`. |
| `publishedAt` | string | UTC ISO 8601 publication time. |
| `launcher.version` | string | Exact launcher semantic version. |
| `launcher.platform` | string | Must be `win32`. |
| `launcher.arch` | string | Must be `x64`. |
| `launcher.format` | string | Must be `portable-exe-v1`. |
| `launcher.asset.url` | string | Immutable HTTPS GitHub Release asset URL in this repository. |
| `launcher.asset.size` | integer | Exact EXE size in bytes; the v1 client caps it at 32 MiB. |
| `launcher.asset.sha256` | string | Lowercase 64-character SHA-256 digest. |
| `releaseNotesUrl` | string | HTTPS link to the matching GitHub Release notes. |

The asset must be a PE32+ AMD64 executable. Before replacement, the updater checks the declared size and SHA-256,
PE headers, architecture, fixed staging filename, and launcher version resource. The installed EXE may be renamed:
the helper identifies the exact parent-process image and requires its SHA-256 to match the known-good helper copy.
The example manifest deliberately uses a zero digest and sample byte size and is therefore not a production feed.

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

## Runtime download, staging, and activation

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

## Launcher replacement and paired rollback

When only a runtime is newer, the existing runtime activation and health-check path is used. When the launcher is
newer—or the runtime declares a `minimumLauncherVersion` newer than the installed launcher—the 1.4.0 client evaluates
both manifests as one compatibility set. It refuses an incomplete set rather than activating a runtime with an
insufficient launcher.

For a launcher or paired update:

1. Download and validate every required candidate without changing the active EXE or runtime.
2. Stop only the DSH process tree owned by this launcher.
3. Copy the running launcher to a hidden, transaction-specific native helper. The old launcher exits only after the
   helper has synchronously confirmed that it opened and revalidated the exact parent image and owns the transaction.
4. The helper revalidates the candidate EXE, backs up the current runtime state, and uses a temporary
   file in the target directory plus `ReplaceFileW` to replace the launcher atomically.
5. Start the new launcher with internal transaction and requested-runtime arguments.
6. The new launcher activates the already prepared runtime, starts DSH, receives an HTTP-successful local page, and
   waits for a trusted WebView `hello` from the exact active `127.0.0.1` origin.
7. Commit and remove the old EXE backup only after that health signal.
8. On timeout, premature new-launcher exit, runtime rollback, or failed health signal, terminate only the recorded new
   launcher PID, restore the old EXE and old runtime state, and reopen the old launcher.

The helper never selects or terminates processes by the generic `node.exe` process name.

If replacement completed but the helper was forcibly terminated or the machine was interrupted, the next ordinary
launcher startup scans at most 64 transaction directories and takes the transaction mutex before recovery. It
revalidates the fixed target path, candidate, old executable/helper hashes, and runtime-state backup. A complete
healthy transaction is committed; otherwise verified rollback material restores the old executable and runtime state
before reopening the old launcher. Missing or inconsistent material causes a bounded error instead of a speculative
file replacement.

## Launcher-owned settings integration

The public integration registers the existing **Check for updates** row through DSH's `settings.general.item`
extension point and talks to the native launcher through a narrow WebView2 message bridge. The web side can request
only an update check; download approval, asset selection, verification, activation, EXE replacement, and rollback
remain native operations. Messages are accepted only from the exact active `127.0.0.1` DSH origin.

Starting with 1.4.0, the patch, package manifest, Host entry, and browser client are embedded in the launcher EXE as
Windows resources. At startup they are materialized under
`%LOCALAPPDATA%\DSH Desktop Launcher\data\launcher-integration\<launcher-version>\`, then resolved through an exact
mapping for `@themis4226/dsh-launcher-update-ui` and its `package.json`. They must not be copied into bundled or managed
DSH `node_modules`, and they must never be included in a `dsh-runtime-zip-v1` archive. Updating the EXE therefore
updates this integration without mutating the DSH runtime.

The repository also contains the private `@themis4226/dsh-official-update-check` maintainer bundle. Its visible name is
**官方更新检查**. It only compares the installed DSH version with official `@deepseek-ai/dsh` npm metadata; it does
not download, activate, package, or publish an update and holds no npm or GitHub credentials. Lite packaging uses an
explicit integration allowlist and excludes this bundle.

## Compatibility gates and old launchers

`runtime.minimumLauncherVersion` remains the compatibility gate. A 1.4.0-or-newer client may satisfy it with the
validated candidate declared by `launcher-update.json` and install both candidates as one transaction. If the
launcher feed does not provide a sufficiently new candidate, the client reports an incomplete release and changes
nothing. The exact-404 transition behavior above does not weaken this gate: a runtime requiring a launcher newer than
the installed version cannot be activated while the launcher feed is unavailable.

Launcher 1.3.0 and earlier cannot run the full self-replacement helper protocol. They must manually install the first
1.4.0 full package once. Keeping the runtime feed schema unchanged lets those clients continue to parse it and follow
its release-notes/full-package guidance instead of receiving an unknown manifest shape.

## Safe publication order

1. Build the full package, standalone launcher asset, and any changed runtime archive from a clean, pinned dependency
   tree.
2. Generate and review dependency notices; scan the staging tree for local data and secrets.
3. Calculate every final asset byte size and SHA-256.
4. Create a draft GitHub Release, upload assets and checksums, then download and verify them independently.
5. Test launcher-only, runtime-only, paired-success, and paired-rollback paths against the downloaded bytes.
6. Publish the GitHub Release and confirm every immutable asset URL works without authentication.
7. Commit production `launcher-update.json` and `update.json` only after the assets are public, using the exact
   downloaded sizes and digests. Do not add launcher fields to `update.json`.
8. Fetch both raw production feeds and perform one clean-machine or clean-data-root update test.

Publishing either production feed before all referenced assets are publicly available creates a broken update window
and is not supported. `launcher-update.example.json` is never a production feed.
