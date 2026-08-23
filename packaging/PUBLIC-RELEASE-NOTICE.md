# Public release notice

This archive is an **unofficial community launcher** for technical testing. It is not affiliated with, endorsed by,
or sponsored by DeepSeek.

Launcher 1.3.0 and earlier cannot perform the complete executable self-replacement flow, so those users must manually
download and fully extract the first 1.4.0 archive once. The existing **Check for updates** entry remains in DSH
Settings > General. Starting with 1.4.0, it can stage a launcher-only update, a runtime-only update, or a compatible
launcher executable and runtime together.

Both candidates are downloaded and verified before replacement. A hidden native helper backs up the old runtime
state, atomically replaces the executable in the same directory, and commits only after the new DSH runtime and
trusted embedded WebView bridge report healthy. On timeout, premature exit, or runtime failure, it restores the old
executable and runtime state. It manages only the recorded update process and does not terminate unrelated Node.js
programs by name.

If the helper is forcibly terminated or the machine is interrupted after replacement, the next ordinary launcher
start first validates the unfinished transaction and all rollback material, then commits a verified healthy result or
rolls back and reopens the old launcher. It stops with an error rather than guessing when recovery material is
incomplete.

The public update integration is embedded in the 1.4.0 executable and materialized into a versioned LocalAppData
directory; it is not written into the upstream DSH runtime. The maintainer-only **Official update check** plugin merely
checks official `@deepseek-ai/dsh` npm metadata and is excluded from this Lite archive. The archive does not contain
user configuration from `%USERPROFILE%\.dsh`.

The current executable embeds artwork derived from the official DeepSeek mobile app icon. Attribution in a notice
does not itself grant trademark or artwork permission. Before publishing this archive to the general public, replace
that artwork with an independently owned, non-confusing icon or obtain written permission from DeepSeek.

The launcher executable is currently unsigned. Windows Defender SmartScreen may therefore identify a downloaded copy
as an unrecognized app. A production release should Authenticode-sign the executable and final installer with a
consistent verified publisher identity and publish a SHA-256 checksum.
