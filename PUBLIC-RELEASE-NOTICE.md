# Public release notice

This project is an **unofficial community launcher** for local technical testing. It is not affiliated with,
endorsed by, sponsored by, or reviewed by DeepSeek. DeepSeek Harness may be included as a pinned upstream npm
package, but the Windows launcher, GitHub update feed, packaging, and release process are maintained by this
repository's publisher.

## One-time launcher upgrade and paired updates

Launcher 1.3.0 and earlier cannot perform the complete executable self-replacement flow. Those users must manually
download and fully extract the first 1.4.0 Windows x64 package once. Uninstalling the old copy is not required: close
it, extract 1.4.0 to a new writable directory, and retain `%USERPROFILE%\.dsh`. The existing user-facing **Check for
updates** entry remains under DSH Settings > General.

Starting with 1.4.0, the updater reads separate, strict manifests for the launcher and DSH runtime. It can apply a
launcher-only update, a runtime-only update, or stage a compatible launcher executable and runtime as one transaction.
Both candidates are downloaded and verified before the old launcher exits. A hidden native helper then backs up the
runtime state, atomically replaces the executable in the same directory, starts the new launcher, and commits only
after the DSH runtime and trusted embedded WebView bridge report healthy. A timeout, premature exit, or runtime health
failure restores both the old executable and old runtime state. The helper targets only the recorded update process;
it does not terminate unrelated Node.js processes by name.

If the helper is forcibly terminated or the machine is interrupted after replacement, the next ordinary launcher
start validates the unfinished transaction, candidate, old executable/helper, and runtime backup before either
committing an already healthy transaction or rolling back and reopening the old launcher. Incomplete recovery
material stops with an error instead of overwriting files speculatively.

Runtime archives are complete payloads, not binary delta patches, and do not include user configuration from
`%USERPROFILE%\.dsh`. The launcher settings integration is embedded as Windows resources in 1.4.0 and materialized
under the launcher's versioned LocalAppData directory at startup. It is mapped without being copied into the pinned
upstream runtime.

The repository also contains a maintainer-only **Official update check** DSH bundle. It checks the official
`@deepseek-ai/dsh` npm metadata but does not install or publish anything and holds no release credentials. The Lite
build allowlists only the public launcher update integration, so this maintainer bundle is not included for users.

The updater accepts only the repository's configured HTTPS feeds and release locations in production. It verifies
declared byte sizes and SHA-256 digests; runtime archives additionally undergo layout, metadata, and pinned-package
checks, while launcher assets must be AMD64 PE32+ executables with matching version information. These checks reduce
corruption and feed-mismatch risks, but they do not replace code signing or protect against compromise of the
publisher's GitHub account.

## Executable signing

The launcher executable is currently unsigned. Windows Defender SmartScreen may therefore identify a downloaded copy
as an unrecognized app. A production-grade release should Authenticode-sign every executable with a consistent,
verified publisher identity. Every GitHub Release should also publish SHA-256 checksums for the full package and
runtime asset. A checksum confirms bytes against the release record; it is not a verified-publisher signature.

## Artwork and trademark

The current executable embeds artwork derived from the official DeepSeek mobile app icon. Attribution in a notice
does not itself grant copyright, trademark, or artwork permission. Before presenting this launcher as a general public
product, replace that artwork with an independently owned, non-confusing icon or obtain written permission from
DeepSeek. The project name, screenshots, documentation, and UI must not imply official status.

## Release hygiene

Do not upload local WebView2 profiles, logs, Cookies, tokens, API keys, chat data, `%USERPROFILE%\.dsh`, dependency
caches, toolchains, or backup folders. GitHub's automatically generated source archives are not Windows installation
packages. Release assets must be built from a clean staging directory, include the applicable notices and license
files, and be verified after downloading them from GitHub.
