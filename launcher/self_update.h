#pragma once

#include <windows.h>

#include <cstdint>
#include <filesystem>
#include <string>

namespace dsh::self_update {

// Internal command-line modes are deliberately narrow. Normal user arguments are
// left to the launcher, while malformed --dsh-self-update-* arguments are rejected.
enum class StartupKind {
    Normal,
    Helper,
    Recovery,
    Health,
};

enum class ParseDisposition {
    Normal,
    Internal,
    Invalid,
};

enum class RecoveryDisposition {
    None,
    ExitForRecovery,
    Error,
};

struct StartupCommand {
    StartupKind kind = StartupKind::Normal;
    std::wstring transactionId;
    std::filesystem::path dataRoot;
    DWORD parentProcessId = 0;
    std::wstring launcherVersion;
    std::uint64_t launcherSize = 0;
    std::wstring launcherSha256;
    std::wstring runtimeVersion;
};

struct LaunchRequest {
    std::filesystem::path dataRoot;
    std::filesystem::path candidatePath;
    std::wstring candidateVersion;
    std::uint64_t candidateSize = 0;
    std::wstring candidateSha256;
    // Empty means launcher-only. A non-empty value is activated by the new
    // launcher before its normal runtime selection runs.
    std::wstring runtimeVersion;
};

struct LaunchResult {
    DWORD helperProcessId = 0;
    std::wstring transactionId;
};

// Call before the single-instance mutex is created. Helper mode must not be
// blocked by the normal launcher mutex. Health mode continues through normal
// startup and is signalled only after DSH and the launcher UI bridge are healthy.
ParseDisposition ParseCommandLine(
    const wchar_t* rawCommandLine,
    StartupCommand& command,
    std::wstring& errorText);

// Re-validates the candidate, copies the currently running known-good launcher
// to a private helper path, and starts that copy without a console window. The
// caller must then close DSH and exit normally so the helper can replace the EXE.
bool LaunchSelfUpdateHelper(
    const LaunchRequest& request,
    LaunchResult& result,
    std::wstring& errorText);

// Execute only when ParseCommandLine returned Internal + StartupKind::Helper or
// StartupKind::Recovery. Returns a process exit code. The helper writes its
// diagnostic log below the transaction directory because it has no window.
int RunSelfUpdateHelper(const StartupCommand& command, std::wstring& errorText);

// Call on an ordinary launch after resolving the real data root, before DSH or
// WebView startup. It commits an already healthy interrupted transaction, cleans
// a transaction that never replaced this executable, or starts the preserved
// old helper to roll back a verified interrupted replacement. Exit the current
// launcher immediately when ExitForRecovery is returned.
RecoveryDisposition RecoverInterruptedSelfUpdate(
    const std::filesystem::path& actualDataRoot,
    std::wstring& errorText);

// Execute during health-mode startup, after the launcher has resolved its real
// data root and before its normal runtime selection. This is idempotent.
bool ActivateRequestedRuntime(
    const StartupCommand& command,
    const std::filesystem::path& actualDataRoot,
    std::wstring& errorText);

// Execute only after the candidate runtime is marked healthy and the trusted
// WebView bridge has sent dsh-launcher:v1:hello. This atomically commits the
// health marker observed by the helper.
bool SignalUpdateHealthy(
    const StartupCommand& command,
    const std::filesystem::path& actualDataRoot,
    std::wstring& errorText);

} // namespace dsh::self_update
