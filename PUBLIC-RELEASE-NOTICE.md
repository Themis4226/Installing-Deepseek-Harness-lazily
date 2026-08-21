# Public release notice

This project is an **unofficial community launcher** for local technical testing. It is not affiliated with,
endorsed by, sponsored by, or reviewed by DeepSeek. DeepSeek Harness may be included as a pinned upstream npm
package, but the Windows launcher, GitHub update feed, packaging, and release process are maintained by this
repository's publisher.

## One-time launcher upgrade and runtime updates

Launcher 1.1.0 has no built-in updater. Launcher 1.2.0 can update only the DSH runtime and cannot replace its own
executable; users of both versions must download the complete 1.2.1 Windows x64 package to receive the launcher fix
that suppresses the extra default-browser window. After that, the in-app updater downloads versioned runtime-only
archives. These archives are complete runtime payloads, not binary delta patches, and do not include user
configuration from `%USERPROFILE%\.dsh`.

The updater accepts only the repository's configured HTTPS feed and release locations in production. It checks the
declared byte size, SHA-256 digest, archive layout, runtime metadata, and pinned DSH package version before staging a
runtime. A newly selected runtime is committed only after a launch health check; otherwise the launcher attempts to
restore the previous runtime. These checks reduce corruption and feed-mismatch risks, but they do not replace code
signing or protect against compromise of the publisher's GitHub account.

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
