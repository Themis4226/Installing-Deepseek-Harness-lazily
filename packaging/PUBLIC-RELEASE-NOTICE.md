# Public release notice

This archive is an **unofficial community launcher** for technical testing. It is not affiliated with, endorsed by,
or sponsored by DeepSeek.

The in-app updater replaces only the versioned DSH runtime; it cannot replace the launcher executable. Users of
launcher 1.1.0 or 1.2.0 must install the complete 1.2.1 archive to receive the `--no-open` launcher fix. The archive
does not contain user configuration from `%USERPROFILE%\.dsh`.

The current executable embeds artwork derived from the official DeepSeek mobile app icon. Attribution in a notice
does not itself grant trademark or artwork permission. Before publishing this archive to the general public, replace
that artwork with an independently owned, non-confusing icon or obtain written permission from DeepSeek.

The launcher executable is currently unsigned. Windows Defender SmartScreen may therefore identify a downloaded copy
as an unrecognized app. A production release should Authenticode-sign the executable and final installer with a
consistent verified publisher identity and publish a SHA-256 checksum.
