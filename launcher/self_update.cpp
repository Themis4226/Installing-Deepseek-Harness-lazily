#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include "self_update.h"

#include <bcrypt.h>
#include <shellapi.h>
#include <winver.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cwctype>
#include <fstream>
#include <limits>
#include <string_view>
#include <vector>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "version.lib")

namespace dsh::self_update {
namespace {

constexpr wchar_t kHelperMode[] = L"--dsh-self-update-helper";
constexpr wchar_t kRecoveryMode[] = L"--dsh-self-update-recover";
constexpr wchar_t kHealthMode[] = L"--dsh-self-update-health";
constexpr wchar_t kTransactionOption[] = L"--transaction";
constexpr wchar_t kParentPidOption[] = L"--parent-pid";
constexpr wchar_t kDataRootOption[] = L"--data-root";
constexpr wchar_t kLauncherVersionOption[] = L"--launcher-version";
constexpr wchar_t kLauncherSizeOption[] = L"--launcher-size";
constexpr wchar_t kLauncherSha256Option[] = L"--launcher-sha256";
constexpr wchar_t kActivateRuntimeOption[] = L"--activate-runtime";
constexpr wchar_t kLauncherFileName[] = L"DeepSeek Harness.exe";
constexpr wchar_t kRuntimeStateRelativePath[] = L"updates\\state.txt";
constexpr wchar_t kDshEntryRelativePath[] = L"node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
constexpr wchar_t kDshPackageRelativePath[] = L"node_modules\\@deepseek-ai\\dsh\\package.json";
constexpr wchar_t kTestModeEnvironment[] = L"DSH_LAUNCHER_UPDATE_TEST_MODE";
constexpr wchar_t kTestTimeoutEnvironment[] = L"DSH_LAUNCHER_UPDATE_TEST_TIMEOUT_MS";
constexpr DWORD kProductionHealthTimeoutMs = 180000;
constexpr DWORD kParentExitTimeoutMs = 60000;
constexpr DWORD kHelperReadyTimeoutMs = 30000;
constexpr DWORD kReplaceRetryMs = 30000;
constexpr std::uint64_t kMaximumLauncherBytes = 32ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kMaximumStateBytes = 1024ULL * 1024ULL;

class ScopedHandle {
public:
    ScopedHandle() = default;
    explicit ScopedHandle(HANDLE value) : value_(value) {}
    ~ScopedHandle() { reset(); }
    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;
    ScopedHandle(ScopedHandle&& other) noexcept : value_(other.release()) {}
    ScopedHandle& operator=(ScopedHandle&& other) noexcept {
        if (this != &other) reset(other.release());
        return *this;
    }
    HANDLE get() const { return value_; }
    explicit operator bool() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
    HANDLE release() {
        HANDLE value = value_;
        value_ = nullptr;
        return value;
    }
    void reset(HANDLE value = nullptr) {
        if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
        value_ = value;
    }

private:
    HANDLE value_ = nullptr;
};

struct SemverCore {
    unsigned long major = 0;
    unsigned long minor = 0;
    unsigned long patch = 0;
};

struct RuntimeState {
    std::wstring active = L"bundled";
    std::wstring previous = L"bundled";
    bool pending = false;
    unsigned int attempts = 0;
};

struct TransactionMetadata {
    std::wstring transactionId;
    std::wstring targetPath;
    std::wstring launcherVersion;
    std::uint64_t launcherSize = 0;
    std::wstring launcherSha256;
    std::wstring oldLauncherSha256;
    std::wstring runtimeVersion;
};

std::wstring FormatSystemError(DWORD code) {
    wchar_t* message = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        code,
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<wchar_t*>(&message),
        0,
        nullptr);
    std::wstring result = length != 0 && message != nullptr ? std::wstring(message, length) : L"未知错误";
    if (message != nullptr) LocalFree(message);
    while (!result.empty() && iswspace(result.back())) result.pop_back();
    return result;
}

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string result(static_cast<size_t>(size), '\0');
    if (WideCharToMultiByte(
            CP_UTF8,
            WC_ERR_INVALID_CHARS,
            value.data(),
            static_cast<int>(value.size()),
            result.data(),
            size,
            nullptr,
            nullptr) != size) {
        return {};
    }
    return result;
}

std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int size = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) return {};
    std::wstring result(static_cast<size_t>(size), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8,
            MB_ERR_INVALID_CHARS,
            value.data(),
            static_cast<int>(value.size()),
            result.data(),
            size) != size) {
        return {};
    }
    return result;
}

bool EnsureDirectory(const std::filesystem::path& path, std::wstring& errorText) {
    std::error_code error;
    if (std::filesystem::create_directories(path, error) || std::filesystem::is_directory(path, error)) return true;
    const std::string message = error.message();
    errorText = L"无法创建目录：" + path.wstring() + L"（" +
        std::wstring(message.begin(), message.end()) + L"）";
    return false;
}

bool FileExists(const std::filesystem::path& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool IsSafeRegularFile(const std::filesystem::path& path, std::wstring& errorText) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        errorText = L"文件不存在：" + path.wstring();
        return false;
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        errorText = L"拒绝使用目录、链接或重解析点作为更新文件：" + path.wstring();
        return false;
    }
    return true;
}

bool FullPath(const std::filesystem::path& input, std::wstring& result, std::wstring& errorText) {
    if (input.empty() || !input.is_absolute()) {
        errorText = L"更新路径必须是绝对路径。";
        return false;
    }
    DWORD size = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
    if (size == 0 || size > 32768) {
        errorText = L"无法规范化路径：" + FormatSystemError(GetLastError());
        return false;
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(size) + 1);
    const DWORD written = GetFullPathNameW(input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (written == 0 || written >= buffer.size()) {
        errorText = L"无法规范化路径：" + FormatSystemError(GetLastError());
        return false;
    }
    result.assign(buffer.data(), written);
    while (result.size() > 3 && (result.back() == L'\\' || result.back() == L'/')) result.pop_back();
    return true;
}

std::wstring NormalizeFinalPath(std::wstring value) {
    if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        value = L"\\\\" + value.substr(8);
    } else if (value.rfind(L"\\\\?\\", 0) == 0) {
        value.erase(0, 4);
    }
    while (value.size() > 3 && (value.back() == L'\\' || value.back() == L'/')) value.pop_back();
    return value;
}

bool FinalPath(
    const std::filesystem::path& path,
    bool directory,
    std::wstring& result,
    std::wstring& errorText) {
    const DWORD flags = directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_ATTRIBUTE_NORMAL;
    ScopedHandle handle(CreateFileW(
        path.c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        flags,
        nullptr));
    if (!handle) {
        errorText = L"无法打开路径进行安全检查：" + path.wstring() + L"（" +
            FormatSystemError(GetLastError()) + L"）";
        return false;
    }
    DWORD size = GetFinalPathNameByHandleW(handle.get(), nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (size == 0 || size > 32768) {
        errorText = L"无法解析最终路径：" + FormatSystemError(GetLastError());
        return false;
    }
    std::vector<wchar_t> buffer(static_cast<size_t>(size) + 1);
    const DWORD written = GetFinalPathNameByHandleW(
        handle.get(), buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (written == 0 || written >= buffer.size()) {
        errorText = L"无法解析最终路径：" + FormatSystemError(GetLastError());
        return false;
    }
    result = NormalizeFinalPath(std::wstring(buffer.data(), written));
    return true;
}

bool EqualPath(const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

bool IsPathBelow(const std::wstring& child, const std::wstring& parent) {
    if (child.size() <= parent.size() || _wcsnicmp(child.c_str(), parent.c_str(), parent.size()) != 0) return false;
    return child[parent.size()] == L'\\' || child[parent.size()] == L'/';
}

bool ParseUnsigned(std::wstring_view text, std::uint64_t& value) {
    if (text.empty()) return false;
    std::uint64_t parsed = 0;
    for (const wchar_t character : text) {
        if (character < L'0' || character > L'9') return false;
        const unsigned int digit = static_cast<unsigned int>(character - L'0');
        if (parsed > (std::numeric_limits<std::uint64_t>::max() - digit) / 10) return false;
        parsed = parsed * 10 + digit;
    }
    value = parsed;
    return true;
}

bool ParseCoreNumber(std::wstring_view text, unsigned long& value) {
    if (text.empty() || (text.size() > 1 && text.front() == L'0')) return false;
    std::uint64_t parsed = 0;
    if (!ParseUnsigned(text, parsed) || parsed > 65535) return false;
    value = static_cast<unsigned long>(parsed);
    return true;
}

bool ValidIdentifierList(std::wstring_view text, bool rejectNumericLeadingZero) {
    if (text.empty()) return false;
    size_t position = 0;
    while (position <= text.size()) {
        const size_t end = text.find(L'.', position);
        const std::wstring_view part = text.substr(
            position, end == std::wstring_view::npos ? text.size() - position : end - position);
        if (part.empty()) return false;
        bool numeric = true;
        for (const wchar_t character : part) {
            const bool allowed = (character >= L'A' && character <= L'Z') ||
                (character >= L'a' && character <= L'z') ||
                (character >= L'0' && character <= L'9') || character == L'-';
            if (!allowed) return false;
            if (character < L'0' || character > L'9') numeric = false;
        }
        if (rejectNumericLeadingZero && numeric && part.size() > 1 && part.front() == L'0') return false;
        if (end == std::wstring_view::npos) break;
        position = end + 1;
    }
    return true;
}

bool ParseSemver(std::wstring_view text, SemverCore* core = nullptr) {
    if (text.empty() || text.size() > 80) return false;
    const size_t plus = text.find(L'+');
    if (plus != std::wstring_view::npos && text.find(L'+', plus + 1) != std::wstring_view::npos) return false;
    const std::wstring_view withoutBuild = plus == std::wstring_view::npos ? text : text.substr(0, plus);
    const std::wstring_view build = plus == std::wstring_view::npos ? std::wstring_view{} : text.substr(plus + 1);
    if (plus != std::wstring_view::npos && !ValidIdentifierList(build, false)) return false;
    const size_t dash = withoutBuild.find(L'-');
    const std::wstring_view coreText = dash == std::wstring_view::npos ? withoutBuild : withoutBuild.substr(0, dash);
    const std::wstring_view prerelease =
        dash == std::wstring_view::npos ? std::wstring_view{} : withoutBuild.substr(dash + 1);
    if (dash != std::wstring_view::npos && !ValidIdentifierList(prerelease, true)) return false;

    const size_t firstDot = coreText.find(L'.');
    const size_t secondDot = firstDot == std::wstring_view::npos ? std::wstring_view::npos : coreText.find(L'.', firstDot + 1);
    if (firstDot == std::wstring_view::npos || secondDot == std::wstring_view::npos ||
        coreText.find(L'.', secondDot + 1) != std::wstring_view::npos) {
        return false;
    }
    SemverCore parsed;
    if (!ParseCoreNumber(coreText.substr(0, firstDot), parsed.major) ||
        !ParseCoreNumber(coreText.substr(firstDot + 1, secondDot - firstDot - 1), parsed.minor) ||
        !ParseCoreNumber(coreText.substr(secondDot + 1), parsed.patch)) {
        return false;
    }
    if (core != nullptr) *core = parsed;
    return true;
}

bool IsSafeRuntimeId(const std::wstring& value) {
    if (value == L"bundled") return true;
    return ParseSemver(value);
}

bool ParseSha256(std::wstring_view text, std::wstring& normalized) {
    if (text.size() != 64) return false;
    normalized.clear();
    normalized.reserve(64);
    for (const wchar_t character : text) {
        if (!iswxdigit(character) || character > 0x7f) return false;
        normalized.push_back(static_cast<wchar_t>(towlower(character)));
    }
    return true;
}

bool IsTransactionId(std::wstring_view value) {
    if (value.size() != 36) return false;
    for (size_t index = 0; index < value.size(); ++index) {
        if (index == 8 || index == 13 || index == 18 || index == 23) {
            if (value[index] != L'-') return false;
        } else if (!iswxdigit(value[index]) || value[index] > 0x7f) {
            return false;
        }
    }
    return true;
}

bool HasInternalPrefix(std::wstring_view value) {
    return value.rfind(L"--dsh-self-update-", 0) == 0 || value == kActivateRuntimeOption;
}

std::filesystem::path CandidatePath(const std::filesystem::path& dataRoot, const std::wstring& version) {
    return dataRoot / L"updates" / L"launchers" / version / kLauncherFileName;
}

std::filesystem::path TransactionDirectory(
    const std::filesystem::path& dataRoot,
    const std::wstring& transactionId) {
    return dataRoot / L"updates" / L"self-update" / transactionId;
}

std::filesystem::path HelperPath(const std::filesystem::path& dataRoot, const std::wstring& transactionId) {
    return dataRoot / L"updates" / L"helpers" / transactionId / L"DeepSeek Harness Update Helper.exe";
}

std::wstring EventName(const std::wstring& transactionId) {
    return L"Local\\DeepSeekHarnessSelfUpdate-" + transactionId;
}

std::wstring ReadyEventName(const std::wstring& transactionId) {
    return L"Local\\DeepSeekHarnessSelfUpdateReady-" + transactionId;
}

std::wstring RecoveryReadyEventName(const std::wstring& transactionId) {
    return L"Local\\DeepSeekHarnessSelfUpdateRecoveryReady-" + transactionId;
}

std::wstring TransactionMutexName(const std::wstring& transactionId) {
    return L"Local\\DeepSeekHarnessSelfUpdateTransaction-" + transactionId;
}

bool AcquireTransactionMutex(
    const std::wstring& transactionId,
    ScopedHandle& mutex,
    std::wstring& errorText) {
    SetLastError(ERROR_SUCCESS);
    ScopedHandle created(CreateMutexW(nullptr, FALSE, TransactionMutexName(transactionId).c_str()));
    const DWORD createError = GetLastError();
    if (!created) {
        errorText = L"无法创建自更新事务互斥锁：" + FormatSystemError(createError);
        return false;
    }
    if (createError == ERROR_ALREADY_EXISTS) {
        errorText = L"该自更新事务已由另一个进程接管。";
        return false;
    }
    mutex = std::move(created);
    return true;
}

bool CurrentExecutablePath(std::filesystem::path& path, std::wstring& errorText) {
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) {
        errorText = L"无法取得启动器路径：" + FormatSystemError(GetLastError());
        return false;
    }
    path = std::filesystem::path(std::wstring(buffer.data(), length));
    return true;
}

std::wstring QuoteArgument(const std::wstring& value) {
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
        } else if (character == L'\"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            backslashes = 0;
        } else {
            result.append(backslashes, L'\\');
            backslashes = 0;
            result.push_back(character);
        }
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

bool GenerateTransactionId(std::wstring& value, std::wstring& errorText) {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        errorText = L"无法生成安全的更新事务编号。";
        return false;
    }
    // Set RFC 4122 version/variant bits. The value is used only as an unguessable
    // transaction/event identifier, not as a security credential.
    bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0f) | 0x40);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3f) | 0x80);
    wchar_t buffer[37]{};
    swprintf_s(
        buffer,
        L"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        static_cast<unsigned int>(bytes[0]), static_cast<unsigned int>(bytes[1]),
        static_cast<unsigned int>(bytes[2]), static_cast<unsigned int>(bytes[3]),
        static_cast<unsigned int>(bytes[4]), static_cast<unsigned int>(bytes[5]),
        static_cast<unsigned int>(bytes[6]), static_cast<unsigned int>(bytes[7]),
        static_cast<unsigned int>(bytes[8]), static_cast<unsigned int>(bytes[9]),
        static_cast<unsigned int>(bytes[10]), static_cast<unsigned int>(bytes[11]),
        static_cast<unsigned int>(bytes[12]), static_cast<unsigned int>(bytes[13]),
        static_cast<unsigned int>(bytes[14]), static_cast<unsigned int>(bytes[15]));
    value = buffer;
    return true;
}

bool AtomicWriteBytes(
    const std::filesystem::path& destination,
    const void* bytes,
    size_t size,
    std::wstring& errorText) {
    if (!EnsureDirectory(destination.parent_path(), errorText)) return false;
    const std::filesystem::path temporary = destination.wstring() + L".tmp-" + std::to_wstring(GetCurrentProcessId());
    ScopedHandle file(CreateFileW(
        temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) {
        errorText = L"无法写入更新事务临时文件：" + FormatSystemError(GetLastError());
        return false;
    }
    const auto* cursor = static_cast<const unsigned char*>(bytes);
    size_t remaining = size;
    while (remaining > 0) {
        const DWORD requested = static_cast<DWORD>(std::min<size_t>(remaining, 1024 * 1024));
        DWORD written = 0;
        if (!WriteFile(file.get(), cursor, requested, &written, nullptr) || written != requested) {
            const DWORD code = GetLastError();
            file.reset();
            DeleteFileW(temporary.c_str());
            errorText = L"写入更新事务失败：" + FormatSystemError(code);
            return false;
        }
        cursor += written;
        remaining -= written;
    }
    if (!FlushFileBuffers(file.get())) {
        const DWORD code = GetLastError();
        file.reset();
        DeleteFileW(temporary.c_str());
        errorText = L"刷新更新事务失败：" + FormatSystemError(code);
        return false;
    }
    file.reset();
    if (!MoveFileExW(
            temporary.c_str(),
            destination.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        const DWORD code = GetLastError();
        DeleteFileW(temporary.c_str());
        errorText = L"原子提交更新事务失败：" + FormatSystemError(code);
        return false;
    }
    return true;
}

bool AtomicWriteText(
    const std::filesystem::path& destination,
    const std::string& text,
    std::wstring& errorText) {
    return AtomicWriteBytes(destination, text.data(), text.size(), errorText);
}

bool ReadSmallFile(
    const std::filesystem::path& path,
    std::vector<unsigned char>& bytes,
    std::uint64_t maximum,
    std::wstring& errorText) {
    ScopedHandle file(CreateFileW(
        path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) {
        errorText = L"无法读取文件：" + path.wstring() + L"（" + FormatSystemError(GetLastError()) + L"）";
        return false;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.get(), &size) || size.QuadPart < 0 || static_cast<std::uint64_t>(size.QuadPart) > maximum) {
        errorText = L"文件大小超出安全范围：" + path.wstring();
        return false;
    }
    bytes.resize(static_cast<size_t>(size.QuadPart));
    size_t offset = 0;
    while (offset < bytes.size()) {
        const DWORD requested = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, 1024 * 1024));
        DWORD read = 0;
        if (!ReadFile(file.get(), bytes.data() + offset, requested, &read, nullptr) || read == 0) {
            errorText = L"读取文件失败：" + FormatSystemError(GetLastError());
            return false;
        }
        offset += read;
    }
    return true;
}

bool IsKnownPhase(std::string_view phase) {
    constexpr std::string_view phases[] = {
        "prepared",
        "waiting-parent",
        "replaced",
        "launched",
        "healthy",
        "committed",
        "recovering",
        "rolled-back",
    };
    return std::find(std::begin(phases), std::end(phases), phase) != std::end(phases);
}

bool WritePhase(
    const std::filesystem::path& dataRoot,
    const std::wstring& transactionId,
    const char* phase,
    std::wstring& errorText) {
    if (!IsTransactionId(transactionId) || phase == nullptr || !IsKnownPhase(phase)) {
        errorText = L"拒绝写入无效的自更新阶段。";
        return false;
    }
    const std::string text = "schema=1\nphase=" + std::string(phase) + "\n";
    return AtomicWriteText(TransactionDirectory(dataRoot, transactionId) / L"phase.txt", text, errorText);
}

bool WritePhase(const StartupCommand& command, const char* phase, std::wstring& errorText) {
    return WritePhase(command.dataRoot, command.transactionId, phase, errorText);
}

bool ReadPhase(
    const std::filesystem::path& dataRoot,
    const std::wstring& transactionId,
    std::string& phase,
    std::wstring& errorText) {
    std::vector<unsigned char> bytes;
    const std::filesystem::path path = TransactionDirectory(dataRoot, transactionId) / L"phase.txt";
    if (!IsSafeRegularFile(path, errorText) || !ReadSmallFile(path, bytes, 4096, errorText)) return false;
    const std::string text(bytes.begin(), bytes.end());
    const size_t firstEnd = text.find('\n');
    const size_t secondEnd = firstEnd == std::string::npos ? std::string::npos : text.find('\n', firstEnd + 1);
    if (firstEnd == std::string::npos || secondEnd == std::string::npos ||
        text.substr(0, firstEnd) != "schema=1" || text.substr(firstEnd + 1, secondEnd - firstEnd - 1).rfind("phase=", 0) != 0 ||
        text.find_first_not_of("\r\n", secondEnd + 1) != std::string::npos) {
        errorText = L"自更新阶段文件格式无效。";
        return false;
    }
    phase = text.substr(firstEnd + 7, secondEnd - firstEnd - 7);
    if (!IsKnownPhase(phase)) {
        errorText = L"自更新阶段值无效。";
        return false;
    }
    return true;
}

bool WriteTransactionMetadata(
    const StartupCommand& command,
    const std::wstring& oldLauncherSha256,
    const std::filesystem::path& target,
    std::wstring& errorText) {
    std::wstring oldHash;
    std::wstring newHash;
    std::wstring targetFull;
    if (!IsTransactionId(command.transactionId) || !ParseSemver(command.launcherVersion) ||
        !ParseSha256(oldLauncherSha256, oldHash) || !ParseSha256(command.launcherSha256, newHash) ||
        EqualPath(oldHash, newHash) || !FullPath(target, targetFull, errorText) ||
        targetFull.find_first_of(L"\r\n") != std::wstring::npos ||
        command.launcherSize == 0 || command.launcherSize > kMaximumLauncherBytes ||
        (!command.runtimeVersion.empty() && !ParseSemver(command.runtimeVersion))) {
        if (errorText.empty()) errorText = L"拒绝写入无效的自更新事务元数据。";
        return false;
    }
    const std::string transactionUtf8 = WideToUtf8(command.transactionId);
    const std::string targetUtf8 = WideToUtf8(targetFull);
    const std::string versionUtf8 = WideToUtf8(command.launcherVersion);
    const std::string runtimeUtf8 = WideToUtf8(command.runtimeVersion);
    if (transactionUtf8.empty() || targetUtf8.empty() || versionUtf8.empty() ||
        (!command.runtimeVersion.empty() && runtimeUtf8.empty())) {
        errorText = L"无法把自更新事务元数据编码为 UTF-8。";
        return false;
    }
    const std::string text =
        "schema=2\ntransaction=" + transactionUtf8 +
        "\ntargetPath=" + targetUtf8 +
        "\nlauncherVersion=" + versionUtf8 +
        "\nlauncherSize=" + std::to_string(command.launcherSize) +
        "\nlauncherSha256=" + WideToUtf8(newHash) +
        "\noldLauncherSha256=" + WideToUtf8(oldHash) +
        "\nruntimeVersion=" + runtimeUtf8 + "\n";
    return AtomicWriteText(
        TransactionDirectory(command.dataRoot, command.transactionId) / L"transaction.txt", text, errorText);
}

bool ReadTransactionMetadata(
    const std::filesystem::path& dataRoot,
    const std::wstring& transactionId,
    TransactionMetadata& metadata,
    std::wstring& errorText) {
    std::vector<unsigned char> bytes;
    const std::filesystem::path path = TransactionDirectory(dataRoot, transactionId) / L"transaction.txt";
    if (!IsSafeRegularFile(path, errorText) || !ReadSmallFile(path, bytes, 16384, errorText)) return false;
    const std::string text(bytes.begin(), bytes.end());
    std::array<bool, 8> seen{};
    TransactionMetadata parsed;
    size_t position = 0;
    while (position <= text.size()) {
        const size_t end = text.find('\n', position);
        std::string line = text.substr(position, end == std::string::npos ? text.size() - position : end - position);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!line.empty()) {
            const size_t separator = line.find('=');
            if (separator == std::string::npos) {
                errorText = L"自更新事务元数据格式无效。";
                return false;
            }
            const std::string key = line.substr(0, separator);
            const std::string value = line.substr(separator + 1);
            size_t field = seen.size();
            if (key == "schema") field = 0;
            else if (key == "transaction") field = 1;
            else if (key == "targetPath") field = 2;
            else if (key == "launcherVersion") field = 3;
            else if (key == "launcherSize") field = 4;
            else if (key == "launcherSha256") field = 5;
            else if (key == "oldLauncherSha256") field = 6;
            else if (key == "runtimeVersion") field = 7;
            if (field >= seen.size() || seen[field]) {
                errorText = L"自更新事务元数据包含未知或重复字段。";
                return false;
            }
            seen[field] = true;
            if (field == 0 && value != "2") {
                errorText = L"自更新事务元数据版本无效。";
                return false;
            }
            const std::wstring wide = Utf8ToWide(value);
            if (!value.empty() && wide.empty()) {
                errorText = L"自更新事务元数据不是有效的 UTF-8。";
                return false;
            }
            if (field == 1) parsed.transactionId = wide;
            else if (field == 2) parsed.targetPath = wide;
            else if (field == 3) parsed.launcherVersion = wide;
            else if (field == 4) {
                if (!ParseUnsigned(wide, parsed.launcherSize)) {
                    errorText = L"自更新事务文件大小无效。";
                    return false;
                }
            } else if (field == 5) parsed.launcherSha256 = wide;
            else if (field == 6) parsed.oldLauncherSha256 = wide;
            else if (field == 7) parsed.runtimeVersion = wide;
        }
        if (end == std::string::npos) break;
        position = end + 1;
    }
    std::wstring normalizedNewHash;
    std::wstring normalizedOldHash;
    std::wstring normalizedTarget;
    if (!std::all_of(seen.begin(), seen.end(), [](bool value) { return value; }) ||
        parsed.transactionId != transactionId || !ParseSemver(parsed.launcherVersion) ||
        parsed.targetPath.find_first_of(L"\r\n") != std::wstring::npos ||
        !FullPath(std::filesystem::path(parsed.targetPath), normalizedTarget, errorText) ||
        !EqualPath(normalizedTarget, parsed.targetPath) ||
        parsed.launcherSize == 0 || parsed.launcherSize > kMaximumLauncherBytes ||
        !ParseSha256(parsed.launcherSha256, normalizedNewHash) ||
        !ParseSha256(parsed.oldLauncherSha256, normalizedOldHash) ||
        EqualPath(normalizedNewHash, normalizedOldHash) ||
        (!parsed.runtimeVersion.empty() && !ParseSemver(parsed.runtimeVersion))) {
        if (errorText.empty()) errorText = L"自更新事务元数据内容无效。";
        return false;
    }
    parsed.targetPath = std::move(normalizedTarget);
    parsed.launcherSha256 = std::move(normalizedNewHash);
    parsed.oldLauncherSha256 = std::move(normalizedOldHash);
    metadata = std::move(parsed);
    return true;
}

void AppendHelperLog(const StartupCommand& command, const std::wstring& message) {
    const std::filesystem::path logPath = TransactionDirectory(command.dataRoot, command.transactionId) / L"helper.log";
    std::wstring ignored;
    if (!EnsureDirectory(logPath.parent_path(), ignored)) return;
    ScopedHandle file(CreateFileW(
        logPath.c_str(),
        FILE_APPEND_DATA,
        FILE_SHARE_READ,
        nullptr,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr));
    if (!file) return;
    const std::string line = WideToUtf8(message + L"\r\n");
    DWORD written = 0;
    if (!line.empty()) WriteFile(file.get(), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
    FlushFileBuffers(file.get());
}

std::wstring ReadHelperLog(const StartupCommand& command) {
    std::wstring ignored;
    std::vector<unsigned char> bytes;
    if (!ReadSmallFile(
            TransactionDirectory(command.dataRoot, command.transactionId) / L"helper.log",
            bytes,
            kMaximumStateBytes,
            ignored)) {
        return {};
    }
    std::string text(bytes.begin(), bytes.end());
    while (!text.empty() && (text.back() == '\r' || text.back() == '\n')) text.pop_back();
    return Utf8ToWide(text);
}

bool HashFileSha256(const std::filesystem::path& path, std::wstring& digest, std::wstring& errorText) {
    ScopedHandle file(CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr));
    if (!file) {
        errorText = L"无法读取更新文件以计算 SHA-256：" + FormatSystemError(GetLastError());
        return false;
    }

    BCRYPT_ALG_HANDLE rawAlgorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&rawAlgorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
        errorText = L"无法初始化 SHA-256。";
        return false;
    }
    struct AlgorithmCloser {
        BCRYPT_ALG_HANDLE value;
        ~AlgorithmCloser() { if (value != nullptr) BCryptCloseAlgorithmProvider(value, 0); }
    } algorithm{rawAlgorithm};

    DWORD objectLength = 0;
    DWORD resultLength = 0;
    DWORD hashLength = 0;
    if (BCryptGetProperty(
            algorithm.value,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&objectLength),
            sizeof(objectLength),
            &resultLength,
            0) < 0 ||
        BCryptGetProperty(
            algorithm.value,
            BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hashLength),
            sizeof(hashLength),
            &resultLength,
            0) < 0 ||
        hashLength != 32) {
        errorText = L"无法读取 SHA-256 参数。";
        return false;
    }
    std::vector<unsigned char> object(objectLength);
    BCRYPT_HASH_HANDLE rawHash = nullptr;
    if (BCryptCreateHash(
            algorithm.value, &rawHash, object.data(), static_cast<ULONG>(object.size()), nullptr, 0, 0) < 0) {
        errorText = L"无法创建 SHA-256 计算器。";
        return false;
    }
    struct HashCloser {
        BCRYPT_HASH_HANDLE value;
        ~HashCloser() { if (value != nullptr) BCryptDestroyHash(value); }
    } hash{rawHash};

    std::vector<unsigned char> buffer(1024 * 1024);
    for (;;) {
        DWORD bytesRead = 0;
        if (!ReadFile(file.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &bytesRead, nullptr)) {
            errorText = L"读取更新文件失败：" + FormatSystemError(GetLastError());
            return false;
        }
        if (bytesRead == 0) break;
        if (BCryptHashData(hash.value, buffer.data(), bytesRead, 0) < 0) {
            errorText = L"计算 SHA-256 失败。";
            return false;
        }
    }
    std::array<unsigned char, 32> bytes{};
    if (BCryptFinishHash(hash.value, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0) {
        errorText = L"完成 SHA-256 计算失败。";
        return false;
    }
    constexpr wchar_t digits[] = L"0123456789abcdef";
    digest.clear();
    digest.reserve(64);
    for (const unsigned char value : bytes) {
        digest.push_back(digits[value >> 4]);
        digest.push_back(digits[value & 0x0f]);
    }
    return true;
}

bool ReadAt(HANDLE file, std::uint64_t offset, void* buffer, DWORD size) {
    LARGE_INTEGER position{};
    position.QuadPart = static_cast<LONGLONG>(offset);
    if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN)) return false;
    DWORD read = 0;
    return ReadFile(file, buffer, size, &read, nullptr) && read == size;
}

bool ValidatePortableExecutable(const std::filesystem::path& path, std::uint64_t fileSize, std::wstring& errorText) {
    ScopedHandle file(CreateFileW(
        path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) {
        errorText = L"无法读取候选启动器 PE 结构：" + FormatSystemError(GetLastError());
        return false;
    }
    IMAGE_DOS_HEADER dos{};
    if (!ReadAt(file.get(), 0, &dos, sizeof(dos)) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew <= 0) {
        errorText = L"候选启动器缺少有效的 MZ/PE 文件头。";
        return false;
    }
    const std::uint64_t peOffset = static_cast<std::uint64_t>(dos.e_lfanew);
    if (peOffset > fileSize || fileSize - peOffset < sizeof(DWORD) + sizeof(IMAGE_FILE_HEADER) + sizeof(WORD)) {
        errorText = L"候选启动器的 PE 文件头越界。";
        return false;
    }
    DWORD signature = 0;
    IMAGE_FILE_HEADER header{};
    WORD optionalMagic = 0;
    if (!ReadAt(file.get(), peOffset, &signature, sizeof(signature)) || signature != IMAGE_NT_SIGNATURE ||
        !ReadAt(file.get(), peOffset + sizeof(signature), &header, sizeof(header)) ||
        !ReadAt(file.get(), peOffset + sizeof(signature) + sizeof(header), &optionalMagic, sizeof(optionalMagic)) ||
        header.Machine != IMAGE_FILE_MACHINE_AMD64 || optionalMagic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
        errorText = L"候选启动器不是有效的 Windows x64 程序。";
        return false;
    }
    return true;
}

bool ValidateVersionResource(
    const std::filesystem::path& path,
    const std::wstring& expectedVersion,
    std::wstring& errorText) {
    SemverCore expected;
    if (!ParseSemver(expectedVersion, &expected)) {
        errorText = L"候选启动器版本号不是严格的语义化版本。";
        return false;
    }
    DWORD ignored = 0;
    const DWORD size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (size == 0 || size > 16 * 1024 * 1024) {
        errorText = L"候选启动器缺少版本资源。";
        return false;
    }
    std::vector<unsigned char> bytes(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, bytes.data())) {
        errorText = L"无法读取候选启动器版本资源：" + FormatSystemError(GetLastError());
        return false;
    }
    VS_FIXEDFILEINFO* fixed = nullptr;
    UINT fixedSize = 0;
    if (!VerQueryValueW(bytes.data(), L"\\", reinterpret_cast<void**>(&fixed), &fixedSize) ||
        fixed == nullptr || fixedSize < sizeof(VS_FIXEDFILEINFO) || fixed->dwSignature != VS_FFI_SIGNATURE ||
        fixed->dwFileType != VFT_APP) {
        errorText = L"候选启动器版本资源无效。";
        return false;
    }
    if (HIWORD(fixed->dwFileVersionMS) != expected.major ||
        LOWORD(fixed->dwFileVersionMS) != expected.minor ||
        HIWORD(fixed->dwFileVersionLS) != expected.patch) {
        errorText = L"候选启动器版本资源与更新清单不一致。";
        return false;
    }
    return true;
}

bool ValidateLauncherCandidate(
    const std::filesystem::path& path,
    const std::wstring& expectedVersion,
    std::uint64_t expectedSize,
    const std::wstring& expectedSha256,
    std::wstring& errorText) {
    if (!IsSafeRegularFile(path, errorText)) return false;
    ScopedHandle file(CreateFileW(
        path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) {
        errorText = L"无法打开候选启动器：" + FormatSystemError(GetLastError());
        return false;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.get(), &size) || size.QuadPart <= 0 ||
        static_cast<std::uint64_t>(size.QuadPart) != expectedSize || expectedSize > kMaximumLauncherBytes) {
        errorText = L"候选启动器大小与更新清单不一致。";
        return false;
    }
    file.reset();
    std::wstring digest;
    if (!HashFileSha256(path, digest, errorText)) return false;
    if (_wcsicmp(digest.c_str(), expectedSha256.c_str()) != 0) {
        errorText = L"候选启动器 SHA-256 与更新清单不一致。";
        return false;
    }
    return ValidatePortableExecutable(path, expectedSize, errorText) &&
        ValidateVersionResource(path, expectedVersion, errorText);
}

bool ValidateCandidateLocation(
    const std::filesystem::path& dataRoot,
    const std::filesystem::path& candidate,
    const std::wstring& version,
    std::wstring& errorText) {
    if (!ParseSemver(version)) {
        errorText = L"候选启动器版本号无效。";
        return false;
    }
    std::wstring requestedFull;
    std::wstring expectedFull;
    if (!FullPath(candidate, requestedFull, errorText) ||
        !FullPath(CandidatePath(dataRoot, version), expectedFull, errorText) ||
        !EqualPath(requestedFull, expectedFull)) {
        if (errorText.empty()) errorText = L"候选启动器不在受管更新目录中。";
        return false;
    }
    std::wstring rootFinal;
    std::wstring candidateFinal;
    if (!FinalPath(dataRoot, true, rootFinal, errorText) ||
        !FinalPath(candidate, false, candidateFinal, errorText)) {
        return false;
    }
    if (!IsPathBelow(candidateFinal, rootFinal)) {
        errorText = L"候选启动器通过链接逃出了受管更新目录。";
        return false;
    }
    return true;
}

bool FlushExistingFile(const std::filesystem::path& path, std::wstring& errorText) {
    ScopedHandle file(CreateFileW(
        path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file || !FlushFileBuffers(file.get())) {
        errorText = L"无法刷新更新文件：" + path.wstring() + L"（" + FormatSystemError(GetLastError()) + L"）";
        return false;
    }
    return true;
}

bool ReplaceFileWithRetry(
    const std::filesystem::path& target,
    const std::filesystem::path& replacement,
    const std::filesystem::path* backup,
    DWORD timeoutMs,
    std::wstring& errorText) {
    const ULONGLONG start = GetTickCount64();
    DWORD lastError = ERROR_SUCCESS;
    do {
        if (ReplaceFileW(
                target.c_str(),
                replacement.c_str(),
                backup == nullptr ? nullptr : backup->c_str(),
                REPLACEFILE_WRITE_THROUGH,
                nullptr,
                nullptr)) {
            return true;
        }
        lastError = GetLastError();
        if (lastError != ERROR_SHARING_VIOLATION && lastError != ERROR_LOCK_VIOLATION &&
            lastError != ERROR_ACCESS_DENIED) {
            break;
        }
        Sleep(100);
    } while (GetTickCount64() - start < timeoutMs);
    errorText = L"无法原子替换启动器：" + FormatSystemError(lastError);
    return false;
}

bool QueryProcessImagePath(HANDLE process, std::filesystem::path& path, std::wstring& errorText) {
    std::vector<wchar_t> buffer(32768);
    DWORD size = static_cast<DWORD>(buffer.size());
    if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &size) || size == 0) {
        errorText = L"无法验证父启动器路径：" + FormatSystemError(GetLastError());
        return false;
    }
    path = std::filesystem::path(std::wstring(buffer.data(), size));
    return true;
}

bool StartProcess(
    const std::filesystem::path& executable,
    const std::wstring& arguments,
    bool hidden,
    PROCESS_INFORMATION& process,
    std::wstring& errorText) {
    std::wstring commandLine = QuoteArgument(executable.wstring());
    if (!arguments.empty()) commandLine += L" " + arguments;
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    if (hidden) {
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE;
    }
    const DWORD flags = hidden ? CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT : CREATE_UNICODE_ENVIRONMENT;
    const std::filesystem::path workingDirectory = executable.parent_path();
    if (!CreateProcessW(
            executable.c_str(),
            mutableCommand.data(),
            nullptr,
            nullptr,
            FALSE,
            flags,
            nullptr,
            workingDirectory.c_str(),
            &startup,
            &process)) {
        errorText = L"无法启动更新进程：" + FormatSystemError(GetLastError());
        return false;
    }
    return true;
}

void CloseProcessInformation(PROCESS_INFORMATION& process) {
    if (process.hThread != nullptr) {
        CloseHandle(process.hThread);
        process.hThread = nullptr;
    }
    if (process.hProcess != nullptr) {
        CloseHandle(process.hProcess);
        process.hProcess = nullptr;
    }
}

DWORD HealthTimeoutMs() {
    wchar_t testMode[8]{};
    if (GetEnvironmentVariableW(kTestModeEnvironment, testMode, ARRAYSIZE(testMode)) != 1 || testMode[0] != L'1') {
        return kProductionHealthTimeoutMs;
    }
    wchar_t text[32]{};
    const DWORD length = GetEnvironmentVariableW(kTestTimeoutEnvironment, text, ARRAYSIZE(text));
    std::uint64_t parsed = 0;
    if (length == 0 || length >= ARRAYSIZE(text) || !ParseUnsigned(std::wstring_view(text, length), parsed)) {
        return kProductionHealthTimeoutMs;
    }
    return static_cast<DWORD>(std::clamp<std::uint64_t>(parsed, 100, 30000));
}

bool ReadRuntimeState(const std::filesystem::path& dataRoot, RuntimeState& state, std::wstring& errorText) {
    const std::filesystem::path path = dataRoot / kRuntimeStateRelativePath;
    if (!FileExists(path)) {
        state = RuntimeState{};
        return true;
    }
    if (!IsSafeRegularFile(path, errorText)) return false;
    std::vector<unsigned char> bytes;
    if (!ReadSmallFile(path, bytes, kMaximumStateBytes, errorText)) return false;
    const std::string text(bytes.begin(), bytes.end());
    RuntimeState parsed;
    bool schema = false;
    bool schemaSeen = false;
    bool active = false;
    bool previous = false;
    bool pending = false;
    bool attempts = false;
    size_t position = 0;
    while (position <= text.size()) {
        const size_t end = text.find('\n', position);
        std::string line = text.substr(position, end == std::string::npos ? text.size() - position : end - position);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (!line.empty()) {
            const size_t separator = line.find('=');
            if (separator == std::string::npos) {
                errorText = L"运行时状态文件格式无效。";
                return false;
            }
            const std::string key = line.substr(0, separator);
            const std::string value = line.substr(separator + 1);
            const std::wstring wide(value.begin(), value.end());
            if (key == "schema" && !schemaSeen) {
                schema = value == "1";
                schemaSeen = true;
            } else if (key == "active" && !active) {
                parsed.active = wide;
                active = true;
            } else if (key == "previous" && !previous) {
                parsed.previous = wide;
                previous = true;
            } else if (key == "pending" && !pending) {
                if (value != "0" && value != "1") {
                    errorText = L"运行时状态 pending 值无效。";
                    return false;
                }
                parsed.pending = value == "1";
                pending = true;
            } else if (key == "attempts" && !attempts) {
                std::uint64_t number = 0;
                if (!ParseUnsigned(wide, number) || number > 100) {
                    errorText = L"运行时状态 attempts 值无效。";
                    return false;
                }
                parsed.attempts = static_cast<unsigned int>(number);
                attempts = true;
            } else {
                errorText = L"运行时状态文件包含未知或重复字段。";
                return false;
            }
        }
        if (end == std::string::npos) break;
        position = end + 1;
    }
    if (!schemaSeen || !schema || !active || !previous || !pending || !attempts ||
        !IsSafeRuntimeId(parsed.active) || !IsSafeRuntimeId(parsed.previous)) {
        errorText = L"运行时状态文件不完整或版本标识无效。";
        return false;
    }
    state = std::move(parsed);
    return true;
}

bool WriteRuntimeState(
    const std::filesystem::path& dataRoot,
    const RuntimeState& state,
    std::wstring& errorText) {
    if (!IsSafeRuntimeId(state.active) || !IsSafeRuntimeId(state.previous)) {
        errorText = L"拒绝写入非法的运行时版本标识。";
        return false;
    }
    const auto ascii = [](const std::wstring& value) {
        std::string result;
        result.reserve(value.size());
        for (const wchar_t character : value) result.push_back(static_cast<char>(character));
        return result;
    };
    const std::string text =
        "schema=1\nactive=" + ascii(state.active) +
        "\nprevious=" + ascii(state.previous) +
        "\npending=" + (state.pending ? std::string("1") : std::string("0")) +
        "\nattempts=" + std::to_string(state.attempts) + "\n";
    return AtomicWriteText(dataRoot / kRuntimeStateRelativePath, text, errorText);
}

bool PackageVersionMatches(const std::filesystem::path& packagePath, const std::wstring& version) {
    std::wstring ignored;
    std::vector<unsigned char> bytes;
    if (!IsSafeRegularFile(packagePath, ignored) || !ReadSmallFile(packagePath, bytes, kMaximumStateBytes, ignored)) {
        return false;
    }
    const std::string text(bytes.begin(), bytes.end());
    std::string expected;
    expected.reserve(version.size());
    for (const wchar_t character : version) expected.push_back(static_cast<char>(character));
    const size_t key = text.find("\"version\"");
    if (key == std::string::npos) return false;
    const size_t colon = text.find(':', key + 9);
    const size_t quote = colon == std::string::npos ? std::string::npos : text.find('"', colon + 1);
    const size_t end = quote == std::string::npos ? std::string::npos : text.find('"', quote + 1);
    return quote != std::string::npos && end != std::string::npos && text.substr(quote + 1, end - quote - 1) == expected;
}

bool ValidateManagedRuntime(
    const std::filesystem::path& dataRoot,
    const std::wstring& version,
    std::wstring& errorText) {
    if (!ParseSemver(version)) {
        errorText = L"待激活运行时版本号无效。";
        return false;
    }
    const std::filesystem::path root = dataRoot / L"runtimes" / version;
    const std::filesystem::path entry = root / kDshEntryRelativePath;
    const std::filesystem::path package = root / kDshPackageRelativePath;
    if (!IsSafeRegularFile(entry, errorText) || !IsSafeRegularFile(package, errorText) ||
        !PackageVersionMatches(package, version)) {
        if (errorText.empty()) errorText = L"待激活运行时内容或版本无效。";
        return false;
    }
    std::wstring rootFinal;
    std::wstring dataFinal;
    std::wstring entryFinal;
    std::wstring packageFinal;
    if (!FinalPath(dataRoot, true, dataFinal, errorText) || !FinalPath(root, true, rootFinal, errorText) ||
        !FinalPath(entry, false, entryFinal, errorText) || !FinalPath(package, false, packageFinal, errorText) ||
        !IsPathBelow(rootFinal, dataFinal) || !IsPathBelow(entryFinal, rootFinal) ||
        !IsPathBelow(packageFinal, rootFinal)) {
        if (errorText.empty()) errorText = L"待激活运行时逃出了受管数据目录。";
        return false;
    }
    return true;
}

bool ValidateManagedUpdatesDirectory(
    const std::filesystem::path& dataRoot,
    std::wstring& errorText) {
    const std::filesystem::path updates = dataRoot / L"updates";
    const DWORD attributes = GetFileAttributesW(updates.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        errorText = L"运行时状态所在的 updates 目录不存在或不安全。";
        return false;
    }
    std::wstring dataFinal;
    std::wstring updatesFinal;
    if (!FinalPath(dataRoot, true, dataFinal, errorText) ||
        !FinalPath(updates, true, updatesFinal, errorText) ||
        !IsPathBelow(updatesFinal, dataFinal)) {
        if (errorText.empty()) errorText = L"运行时状态目录逃出了受管数据目录。";
        return false;
    }
    return true;
}

bool BackupRuntimeState(const StartupCommand& command, std::wstring& errorText) {
    if (command.runtimeVersion.empty()) return true;
    if (!ValidateManagedUpdatesDirectory(command.dataRoot, errorText)) return false;
    const std::filesystem::path transaction = TransactionDirectory(command.dataRoot, command.transactionId);
    const std::filesystem::path source = command.dataRoot / kRuntimeStateRelativePath;
    const std::filesystem::path backup = transaction / L"runtime-state.backup";
    const std::filesystem::path present = transaction / L"runtime-state.present";
    const std::filesystem::path absent = transaction / L"runtime-state.absent";
    if (!EnsureDirectory(transaction, errorText)) return false;
    if (!FileExists(source)) return AtomicWriteText(absent, "1\n", errorText);
    if (!IsSafeRegularFile(source, errorText)) return false;
    std::vector<unsigned char> bytes;
    if (!ReadSmallFile(source, bytes, kMaximumStateBytes, errorText) ||
        !AtomicWriteBytes(backup, bytes.data(), bytes.size(), errorText) ||
        !AtomicWriteText(present, "1\n", errorText)) {
        return false;
    }
    return true;
}

bool RestoreRuntimeState(const StartupCommand& command, std::wstring& errorText) {
    if (command.runtimeVersion.empty()) return true;
    if (!ValidateManagedUpdatesDirectory(command.dataRoot, errorText)) return false;
    const std::filesystem::path transaction = TransactionDirectory(command.dataRoot, command.transactionId);
    const std::filesystem::path destination = command.dataRoot / kRuntimeStateRelativePath;
    const std::filesystem::path backup = transaction / L"runtime-state.backup";
    const std::filesystem::path present = transaction / L"runtime-state.present";
    const std::filesystem::path absent = transaction / L"runtime-state.absent";
    if (FileExists(present) && FileExists(backup)) {
        std::vector<unsigned char> bytes;
        return ReadSmallFile(backup, bytes, kMaximumStateBytes, errorText) &&
            AtomicWriteBytes(destination, bytes.data(), bytes.size(), errorText);
    }
    if (FileExists(absent)) {
        if (!DeleteFileW(destination.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) {
            errorText = L"无法恢复为空的运行时状态：" + FormatSystemError(GetLastError());
            return false;
        }
        return true;
    }
    errorText = L"更新事务缺少运行时状态备份。";
    return false;
}

bool DataRootsMatch(
    const std::filesystem::path& commandRoot,
    const std::filesystem::path& actualRoot,
    std::wstring& errorText) {
    std::wstring commandFull;
    std::wstring actualFull;
    if (!FullPath(commandRoot, commandFull, errorText) || !FullPath(actualRoot, actualFull, errorText)) return false;
    if (!EqualPath(commandFull, actualFull)) {
        errorText = L"更新事务的数据目录与当前启动器不一致。";
        return false;
    }
    return true;
}

bool FileHashMatches(
    const std::filesystem::path& path,
    const std::wstring& expected,
    std::wstring& errorText);

bool RestoreLauncher(
    const std::filesystem::path& target,
    const std::filesystem::path& backup,
    const std::wstring& expectedOldSha256,
    std::wstring& errorText) {
    if (!FileExists(backup)) {
        errorText = L"旧启动器备份不存在，无法进行可信回滚。";
        return false;
    }
    if (!FileHashMatches(backup, expectedOldSha256, errorText)) return false;
    if (!FileExists(target)) {
        if (MoveFileExW(backup.c_str(), target.c_str(), MOVEFILE_WRITE_THROUGH)) return true;
        errorText = L"无法恢复启动器备份：" + FormatSystemError(GetLastError());
        return false;
    }
    return ReplaceFileWithRetry(target, backup, nullptr, kReplaceRetryMs, errorText);
}

bool ValidateTransactionDirectory(
    const std::filesystem::path& dataRoot,
    const std::wstring& transactionId,
    std::wstring& errorText) {
    if (!IsTransactionId(transactionId)) {
        errorText = L"自更新事务目录名称无效。";
        return false;
    }
    const std::filesystem::path transaction = TransactionDirectory(dataRoot, transactionId);
    const DWORD attributes = GetFileAttributesW(transaction.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        errorText = L"自更新事务目录不存在或不安全。";
        return false;
    }
    std::wstring rootFinal;
    std::wstring transactionFinal;
    if (!FinalPath(dataRoot, true, rootFinal, errorText) ||
        !FinalPath(transaction, true, transactionFinal, errorText) ||
        !IsPathBelow(transactionFinal, rootFinal)) {
        if (errorText.empty()) errorText = L"自更新事务目录逃出了受管数据目录。";
        return false;
    }
    return true;
}

bool ValidateManagedFileBelowDataRoot(
    const std::filesystem::path& dataRoot,
    const std::filesystem::path& file,
    std::wstring& errorText) {
    if (!IsSafeRegularFile(file, errorText)) return false;
    std::wstring rootFinal;
    std::wstring fileFinal;
    if (!FinalPath(dataRoot, true, rootFinal, errorText) || !FinalPath(file, false, fileFinal, errorText) ||
        !IsPathBelow(fileFinal, rootFinal)) {
        if (errorText.empty()) errorText = L"受管更新文件逃出了数据目录。";
        return false;
    }
    return true;
}

bool FileHashMatches(
    const std::filesystem::path& path,
    const std::wstring& expected,
    std::wstring& errorText) {
    std::wstring actual;
    if (!IsSafeRegularFile(path, errorText) || !HashFileSha256(path, actual, errorText)) return false;
    if (_wcsicmp(actual.c_str(), expected.c_str()) != 0) {
        errorText = L"更新恢复文件的 SHA-256 与事务记录不一致：" + path.wstring();
        return false;
    }
    return true;
}

StartupCommand CommandFromMetadata(
    StartupKind kind,
    const std::filesystem::path& dataRoot,
    const TransactionMetadata& metadata) {
    StartupCommand command;
    command.kind = kind;
    command.transactionId = metadata.transactionId;
    command.dataRoot = dataRoot;
    command.launcherVersion = metadata.launcherVersion;
    command.launcherSize = metadata.launcherSize;
    command.launcherSha256 = metadata.launcherSha256;
    command.runtimeVersion = metadata.runtimeVersion;
    return command;
}

bool RuntimeTransactionIsHealthy(
    const std::filesystem::path& dataRoot,
    const TransactionMetadata& metadata,
    std::wstring& errorText) {
    if (metadata.runtimeVersion.empty()) return true;
    RuntimeState state;
    if (!ReadRuntimeState(dataRoot, state, errorText)) return false;
    return !state.pending && state.active == metadata.runtimeVersion;
}

enum class RuntimeBackupKind {
    None,
    Present,
    Absent,
};

void RemoveBestEffort(const std::filesystem::path& path);
void RemoveTreeBestEffort(const std::filesystem::path& path);
void ScheduleSelfDelete();

bool ReadExactMarker(const std::filesystem::path& path, std::wstring& errorText) {
    if (!IsSafeRegularFile(path, errorText)) return false;
    std::vector<unsigned char> bytes;
    if (!ReadSmallFile(path, bytes, 16, errorText)) return false;
    if (bytes.size() != 2 || bytes[0] != '1' || bytes[1] != '\n') {
        errorText = L"自更新事务的状态备份标记无效。";
        return false;
    }
    return true;
}

bool QueryEntryExists(
    const std::filesystem::path& path,
    bool& exists,
    std::wstring& errorText) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        exists = true;
        return true;
    }
    const DWORD code = GetLastError();
    if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) {
        exists = false;
        return true;
    }
    errorText = L"无法检查自更新事务文件：" + FormatSystemError(code);
    return false;
}

bool InspectRuntimeBackup(
    const std::filesystem::path& dataRoot,
    const TransactionMetadata& metadata,
    RuntimeBackupKind& kind,
    std::wstring& errorText) {
    kind = RuntimeBackupKind::None;
    const std::filesystem::path transaction = TransactionDirectory(dataRoot, metadata.transactionId);
    const std::filesystem::path backup = transaction / L"runtime-state.backup";
    const std::filesystem::path present = transaction / L"runtime-state.present";
    const std::filesystem::path absent = transaction / L"runtime-state.absent";
    bool backupExists = false;
    bool presentExists = false;
    bool absentExists = false;
    if (!QueryEntryExists(backup, backupExists, errorText) ||
        !QueryEntryExists(present, presentExists, errorText) ||
        !QueryEntryExists(absent, absentExists, errorText)) {
        return false;
    }
    if (!backupExists && !presentExists && !absentExists) return true;
    if (metadata.runtimeVersion.empty() || presentExists == absentExists) {
        errorText = L"自更新事务的运行时备份标记不一致。";
        return false;
    }
    if (presentExists) {
        std::vector<unsigned char> backupBytes;
        if (!backupExists || !ReadExactMarker(present, errorText) ||
            !ValidateManagedFileBelowDataRoot(dataRoot, backup, errorText) ||
            !ReadSmallFile(backup, backupBytes, kMaximumStateBytes, errorText)) {
            if (errorText.empty()) errorText = L"自更新事务的运行时状态备份无效。";
            return false;
        }
        kind = RuntimeBackupKind::Present;
        return true;
    }
    if (backupExists || !ReadExactMarker(absent, errorText)) {
        if (errorText.empty()) errorText = L"自更新事务的空运行时状态备份无效。";
        return false;
    }
    kind = RuntimeBackupKind::Absent;
    return true;
}

bool ValidateOptionalHashFile(
    const std::filesystem::path& path,
    const std::wstring& expectedHash,
    bool& exists,
    std::wstring& errorText) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    exists = attributes != INVALID_FILE_ATTRIBUTES;
    if (!exists) {
        const DWORD code = GetLastError();
        if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return true;
        errorText = L"无法检查更新恢复文件：" + FormatSystemError(code);
        return false;
    }
    return FileHashMatches(path, expectedHash, errorText);
}

bool ValidateOptionalCandidate(
    const std::filesystem::path& dataRoot,
    const TransactionMetadata& metadata,
    bool& exists,
    std::wstring& errorText) {
    const std::filesystem::path candidate = CandidatePath(dataRoot, metadata.launcherVersion);
    if (!QueryEntryExists(candidate, exists, errorText)) return false;
    if (!exists) return true;
    return ValidateCandidateLocation(dataRoot, candidate, metadata.launcherVersion, errorText) &&
        ValidateLauncherCandidate(
            candidate,
            metadata.launcherVersion,
            metadata.launcherSize,
            metadata.launcherSha256,
            errorText);
}

bool DeleteSafeRegularFileIfPresent(const std::filesystem::path& path, std::wstring& errorText) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        const DWORD code = GetLastError();
        if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return true;
        errorText = L"无法检查更新清理文件：" + FormatSystemError(code);
        return false;
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        errorText = L"拒绝删除不安全的更新清理文件：" + path.wstring();
        return false;
    }
    if (!DeleteFileW(path.c_str())) {
        errorText = L"无法删除更新清理文件：" + FormatSystemError(GetLastError());
        return false;
    }
    return true;
}

bool CleanupTrustedTransactionFiles(
    const std::filesystem::path& dataRoot,
    const std::wstring& transactionId,
    std::wstring& errorText) {
    const std::filesystem::path transaction = TransactionDirectory(dataRoot, transactionId);
    constexpr const wchar_t* files[] = {
        L"runtime-state.backup",
        L"runtime-state.present",
        L"runtime-state.absent",
        L"helper.log",
        L"phase.txt",
        L"transaction.txt",
    };
    for (const wchar_t* name : files) {
        if (!DeleteSafeRegularFileIfPresent(transaction / name, errorText)) return false;
    }
    if (!RemoveDirectoryW(transaction.c_str())) {
        const DWORD code = GetLastError();
        if (code != ERROR_DIR_NOT_EMPTY && code != ERROR_FILE_NOT_FOUND && code != ERROR_PATH_NOT_FOUND) {
            errorText = L"无法删除更新事务目录：" + FormatSystemError(code);
            return false;
        }
    }
    return true;
}

struct MatchingTransaction {
    TransactionMetadata metadata;
    std::string phase;
};

bool FindMatchingTransactions(
    const std::filesystem::path& dataRoot,
    const std::wstring& currentTarget,
    std::vector<MatchingTransaction>& matches,
    std::wstring& errorText) {
    matches.clear();
    const std::filesystem::path root = dataRoot / L"updates" / L"self-update";
    const DWORD attributes = GetFileAttributesW(root.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        const DWORD code = GetLastError();
        if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return true;
        errorText = L"无法检查自更新恢复目录：" + FormatSystemError(code);
        return false;
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        errorText = L"自更新恢复目录不是安全的普通目录。";
        return false;
    }
    std::wstring dataFinal;
    std::wstring rootFinal;
    if (!FinalPath(dataRoot, true, dataFinal, errorText) || !FinalPath(root, true, rootFinal, errorText) ||
        !IsPathBelow(rootFinal, dataFinal)) {
        if (errorText.empty()) errorText = L"自更新恢复目录逃出了受管数据目录。";
        return false;
    }

    WIN32_FIND_DATAW entry{};
    const std::filesystem::path pattern = root / L"*";
    HANDLE rawFind = FindFirstFileW(pattern.c_str(), &entry);
    if (rawFind == INVALID_HANDLE_VALUE) {
        const DWORD code = GetLastError();
        if (code == ERROR_FILE_NOT_FOUND) return true;
        errorText = L"无法枚举自更新恢复目录：" + FormatSystemError(code);
        return false;
    }
    struct FindCloser {
        HANDLE value;
        ~FindCloser() { if (value != INVALID_HANDLE_VALUE) FindClose(value); }
    } find{rawFind};

    size_t transactionCount = 0;
    do {
        const std::wstring name(entry.cFileName);
        if ((entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            name == L"." || name == L".." || !IsTransactionId(name)) {
            continue;
        }
        if (++transactionCount > 64) {
            errorText = L"待恢复的自更新事务过多，已停止自动处理。";
            return false;
        }
        if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
        std::wstring ignored;
        MatchingTransaction match;
        if (!ValidateTransactionDirectory(dataRoot, name, ignored) ||
            !ReadTransactionMetadata(dataRoot, name, match.metadata, ignored) ||
            !ReadPhase(dataRoot, name, match.phase, ignored)) {
            continue;
        }
        if (EqualPath(match.metadata.targetPath, currentTarget)) matches.push_back(std::move(match));
    } while (FindNextFileW(rawFind, &entry));
    const DWORD enumerationError = GetLastError();
    if (enumerationError != ERROR_NO_MORE_FILES) {
        errorText = L"枚举自更新恢复目录失败：" + FormatSystemError(enumerationError);
        return false;
    }
    if (matches.size() > 1) {
        errorText = L"发现多个指向当前启动器的未完成自更新事务，拒绝猜测恢复顺序。";
        return false;
    }
    return true;
}

bool ValidateRecoveryArtifacts(
    const std::filesystem::path& dataRoot,
    const std::filesystem::path& target,
    const TransactionMetadata& metadata,
    bool requireAll,
    bool& candidateExists,
    bool& backupExists,
    bool& helperExists,
    std::wstring& errorText) {
    const std::filesystem::path backup =
        target.wstring() + L".dsh-backup-" + metadata.transactionId + L".bak";
    const std::filesystem::path helper = HelperPath(dataRoot, metadata.transactionId);
    if (!ValidateOptionalCandidate(dataRoot, metadata, candidateExists, errorText) ||
        !ValidateOptionalHashFile(backup, metadata.oldLauncherSha256, backupExists, errorText) ||
        !ValidateOptionalHashFile(helper, metadata.oldLauncherSha256, helperExists, errorText) ||
        (helperExists && !ValidateManagedFileBelowDataRoot(dataRoot, helper, errorText))) {
        return false;
    }
    if (requireAll && (!candidateExists || !backupExists || !helperExists)) {
        errorText = L"未完成的启动器替换缺少候选文件、旧版备份或恢复助手。";
        return false;
    }
    return true;
}

bool CleanupRecoveryArtifacts(
    const std::filesystem::path& dataRoot,
    const std::filesystem::path& target,
    const TransactionMetadata& metadata,
    bool candidateExists,
    bool backupExists,
    bool helperExists,
    std::wstring& errorText) {
    const std::filesystem::path candidate = CandidatePath(dataRoot, metadata.launcherVersion);
    const std::filesystem::path backup =
        target.wstring() + L".dsh-backup-" + metadata.transactionId + L".bak";
    const std::filesystem::path helper = HelperPath(dataRoot, metadata.transactionId);
    if ((candidateExists && !DeleteSafeRegularFileIfPresent(candidate, errorText)) ||
        (backupExists && !DeleteSafeRegularFileIfPresent(backup, errorText)) ||
        (helperExists && !DeleteSafeRegularFileIfPresent(helper, errorText)) ||
        !CleanupTrustedTransactionFiles(dataRoot, metadata.transactionId, errorText)) {
        return false;
    }
    if (candidateExists) RemoveBestEffort(candidate.parent_path());
    if (helperExists) RemoveBestEffort(helper.parent_path());
    return true;
}

int RunRecoveryHelperInternal(
    const StartupCommand& command,
    ScopedHandle& transactionMutex,
    std::wstring& errorText) {
    AppendHelperLog(command, L"self-update recovery helper started");
    if (!ValidateTransactionDirectory(command.dataRoot, command.transactionId, errorText)) {
        AppendHelperLog(command, errorText);
        return 20;
    }
    TransactionMetadata metadata;
    std::string phase;
    if (!ReadTransactionMetadata(command.dataRoot, command.transactionId, metadata, errorText) ||
        !ReadPhase(command.dataRoot, command.transactionId, phase, errorText)) {
        AppendHelperLog(command, errorText);
        return 21;
    }

    ScopedHandle parent(OpenProcess(
        SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, command.parentProcessId));
    if (!parent) {
        errorText = L"恢复助手无法打开父启动器进程：" + FormatSystemError(GetLastError());
        AppendHelperLog(command, errorText);
        return 22;
    }
    std::filesystem::path target;
    std::wstring targetFinal;
    if (!QueryProcessImagePath(parent.get(), target, errorText) ||
        !IsSafeRegularFile(target, errorText) || !FinalPath(target, false, targetFinal, errorText)) {
        AppendHelperLog(command, errorText);
        return 22;
    }
    target = std::filesystem::path(targetFinal);
    const std::filesystem::path backup =
        target.wstring() + L".dsh-backup-" + command.transactionId + L".bak";
    const std::filesystem::path candidate = CandidatePath(command.dataRoot, metadata.launcherVersion);
    const std::filesystem::path expectedHelper = HelperPath(command.dataRoot, command.transactionId);
    RuntimeBackupKind runtimeBackup = RuntimeBackupKind::None;
    std::filesystem::path currentHelper;
    std::wstring helperFull;
    std::wstring expectedHelperFull;
    if (!EqualPath(targetFinal, metadata.targetPath) ||
        !CurrentExecutablePath(currentHelper, errorText) ||
        !FullPath(currentHelper, helperFull, errorText) || !FullPath(expectedHelper, expectedHelperFull, errorText) ||
        !EqualPath(helperFull, expectedHelperFull) ||
        !ValidateManagedFileBelowDataRoot(command.dataRoot, currentHelper, errorText) ||
        !FileHashMatches(currentHelper, metadata.oldLauncherSha256, errorText) ||
        !FileHashMatches(target, metadata.launcherSha256, errorText) ||
        !FileHashMatches(backup, metadata.oldLauncherSha256, errorText) ||
        !ValidateCandidateLocation(command.dataRoot, candidate, metadata.launcherVersion, errorText) ||
        !ValidateLauncherCandidate(
            candidate,
            metadata.launcherVersion,
            metadata.launcherSize,
            metadata.launcherSha256,
            errorText) ||
        !InspectRuntimeBackup(command.dataRoot, metadata, runtimeBackup, errorText) ||
        (!metadata.runtimeVersion.empty() && runtimeBackup == RuntimeBackupKind::None)) {
        if (errorText.empty()) errorText = L"恢复事务的目标、备份、候选或旧助手校验失败。";
        AppendHelperLog(command, errorText);
        return 23;
    }

    ScopedHandle readyEvent(OpenEventW(
        EVENT_MODIFY_STATE, FALSE, RecoveryReadyEventName(command.transactionId).c_str()));
    if (!readyEvent || !WritePhase(command, "recovering", errorText) || !SetEvent(readyEvent.get())) {
        if (errorText.empty()) errorText = L"恢复助手无法确认安全接管：" + FormatSystemError(GetLastError());
        AppendHelperLog(command, errorText);
        return 24;
    }
    const DWORD parentTimeout = std::min(kParentExitTimeoutMs, HealthTimeoutMs());
    if (WaitForSingleObject(parent.get(), parentTimeout) != WAIT_OBJECT_0) {
        errorText = L"恢复助手等待当前启动器退出超时。";
        AppendHelperLog(command, errorText);
        return 25;
    }
    parent.reset();

    if (!RestoreLauncher(target, backup, metadata.oldLauncherSha256, errorText)) {
        AppendHelperLog(command, errorText);
        return 26;
    }
    StartupCommand stateCommand = CommandFromMetadata(StartupKind::Recovery, command.dataRoot, metadata);
    if (!RestoreRuntimeState(stateCommand, errorText)) {
        AppendHelperLog(command, errorText);
        return 27;
    }
    std::wstring ignored;
    WritePhase(command, "rolled-back", ignored);
    DeleteFileW(candidate.c_str());
    RemoveBestEffort(candidate.parent_path());
    AppendHelperLog(command, L"interrupted self-update rolled back");
    RemoveTreeBestEffort(TransactionDirectory(command.dataRoot, command.transactionId));
    ScheduleSelfDelete();
    transactionMutex.reset();
    PROCESS_INFORMATION restart{};
    if (!StartProcess(target, L"", false, restart, errorText)) {
        return 28;
    }
    CloseProcessInformation(restart);
    return 0;
}

void RemoveBestEffort(const std::filesystem::path& path) {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

void RemoveTreeBestEffort(const std::filesystem::path& path) {
    std::error_code ignored;
    std::filesystem::remove_all(path, ignored);
}

void ScheduleSelfDelete() {
    std::filesystem::path executable;
    std::wstring ignored;
    if (CurrentExecutablePath(executable, ignored)) {
        MoveFileExW(executable.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
    }
}

} // namespace

ParseDisposition ParseCommandLine(
    const wchar_t* rawCommandLine,
    StartupCommand& command,
    std::wstring& errorText) {
    command = StartupCommand{};
    errorText.clear();
    if (rawCommandLine == nullptr) return ParseDisposition::Normal;
    int argumentCount = 0;
    LPWSTR* rawArguments = CommandLineToArgvW(rawCommandLine, &argumentCount);
    if (rawArguments == nullptr || argumentCount <= 0) {
        errorText = L"无法解析启动器命令行。";
        if (rawArguments != nullptr) LocalFree(rawArguments);
        return ParseDisposition::Invalid;
    }
    struct ArgumentCloser {
        LPWSTR* value;
        ~ArgumentCloser() { if (value != nullptr) LocalFree(value); }
    } arguments{rawArguments};

    if (argumentCount == 1) return ParseDisposition::Normal;
    const std::wstring_view mode(rawArguments[1]);
    if (mode != kHelperMode && mode != kRecoveryMode && mode != kHealthMode) {
        for (int index = 1; index < argumentCount; ++index) {
            if (HasInternalPrefix(rawArguments[index])) {
                errorText = L"内部自更新参数的位置或名称无效。";
                return ParseDisposition::Invalid;
            }
        }
        return ParseDisposition::Normal;
    }

    auto requirePair = [&](int keyIndex, const wchar_t* expected, std::wstring& value) -> bool {
        if (keyIndex + 1 >= argumentCount || wcscmp(rawArguments[keyIndex], expected) != 0 ||
            rawArguments[keyIndex + 1][0] == L'\0') {
            return false;
        }
        value = rawArguments[keyIndex + 1];
        return true;
    };

    std::wstring transaction;
    std::wstring dataRoot;
    std::wstring runtime;
    if (mode == kHelperMode) {
        if (argumentCount != 14 && argumentCount != 16) {
            errorText = L"自更新助手参数数量无效。";
            return ParseDisposition::Invalid;
        }
        std::wstring parentPid;
        std::wstring launcherSize;
        if (!requirePair(2, kTransactionOption, transaction) ||
            !requirePair(4, kParentPidOption, parentPid) ||
            !requirePair(6, kDataRootOption, dataRoot) ||
            !requirePair(8, kLauncherVersionOption, command.launcherVersion) ||
            !requirePair(10, kLauncherSizeOption, launcherSize) ||
            !requirePair(12, kLauncherSha256Option, command.launcherSha256) ||
            (argumentCount == 16 && !requirePair(14, kActivateRuntimeOption, runtime))) {
            errorText = L"自更新助手参数顺序或名称无效。";
            return ParseDisposition::Invalid;
        }
        std::uint64_t parent = 0;
        if (!ParseUnsigned(parentPid, parent) || parent == 0 || parent > MAXDWORD ||
            !ParseUnsigned(launcherSize, command.launcherSize) || command.launcherSize == 0 ||
            command.launcherSize > kMaximumLauncherBytes || !ParseSemver(command.launcherVersion)) {
            errorText = L"自更新助手的 PID、版本或文件大小无效。";
            return ParseDisposition::Invalid;
        }
        command.parentProcessId = static_cast<DWORD>(parent);
        command.kind = StartupKind::Helper;
    } else if (mode == kRecoveryMode) {
        if (argumentCount != 8) {
            errorText = L"自更新恢复助手参数数量无效。";
            return ParseDisposition::Invalid;
        }
        std::wstring parentPid;
        if (!requirePair(2, kTransactionOption, transaction) ||
            !requirePair(4, kParentPidOption, parentPid) ||
            !requirePair(6, kDataRootOption, dataRoot)) {
            errorText = L"自更新恢复助手参数顺序或名称无效。";
            return ParseDisposition::Invalid;
        }
        std::uint64_t parent = 0;
        if (!ParseUnsigned(parentPid, parent) || parent == 0 || parent > MAXDWORD) {
            errorText = L"自更新恢复助手的父进程 PID 无效。";
            return ParseDisposition::Invalid;
        }
        command.parentProcessId = static_cast<DWORD>(parent);
        command.kind = StartupKind::Recovery;
    } else {
        if (argumentCount != 6 && argumentCount != 8) {
            errorText = L"自更新健康检查参数数量无效。";
            return ParseDisposition::Invalid;
        }
        if (!requirePair(2, kTransactionOption, transaction) ||
            !requirePair(4, kDataRootOption, dataRoot) ||
            (argumentCount == 8 && !requirePair(6, kActivateRuntimeOption, runtime))) {
            errorText = L"自更新健康检查参数顺序或名称无效。";
            return ParseDisposition::Invalid;
        }
        command.kind = StartupKind::Health;
    }

    std::wstring normalizedSha;
    if (!IsTransactionId(transaction) ||
        (command.kind == StartupKind::Helper && !ParseSha256(command.launcherSha256, normalizedSha)) ||
        (!runtime.empty() && !ParseSemver(runtime))) {
        errorText = L"自更新事务编号、摘要或运行时版本无效。";
        return ParseDisposition::Invalid;
    }
    const std::filesystem::path parsedRoot(dataRoot);
    if (parsedRoot.empty() || !parsedRoot.is_absolute()) {
        errorText = L"自更新数据目录必须是绝对路径。";
        return ParseDisposition::Invalid;
    }
    command.transactionId = std::move(transaction);
    command.dataRoot = parsedRoot;
    command.runtimeVersion = std::move(runtime);
    if (command.kind == StartupKind::Helper) command.launcherSha256 = std::move(normalizedSha);
    return ParseDisposition::Internal;
}

bool LaunchSelfUpdateHelper(
    const LaunchRequest& request,
    LaunchResult& result,
    std::wstring& errorText) {
    result = LaunchResult{};
    errorText.clear();
    std::wstring normalizedSha;
    if (request.dataRoot.empty() || !request.dataRoot.is_absolute() ||
        !ParseSemver(request.candidateVersion) ||
        !ParseSha256(request.candidateSha256, normalizedSha) ||
        request.candidateSize == 0 || request.candidateSize > kMaximumLauncherBytes ||
        (!request.runtimeVersion.empty() && !ParseSemver(request.runtimeVersion))) {
        errorText = L"自更新请求中的路径、版本、大小或 SHA-256 无效。";
        return false;
    }
    if (!EnsureDirectory(request.dataRoot, errorText) ||
        !ValidateCandidateLocation(request.dataRoot, request.candidatePath, request.candidateVersion, errorText) ||
        !ValidateLauncherCandidate(
            request.candidatePath, request.candidateVersion, request.candidateSize, normalizedSha, errorText)) {
        return false;
    }

    std::filesystem::path currentExecutable;
    std::wstring currentDigest;
    if (!CurrentExecutablePath(currentExecutable, errorText) ||
        !IsSafeRegularFile(currentExecutable, errorText) ||
        !HashFileSha256(currentExecutable, currentDigest, errorText)) {
        return false;
    }
    if (EqualPath(currentDigest, normalizedSha)) {
        errorText = L"候选启动器与当前启动器完全相同，无需执行自更新。";
        return false;
    }
    std::wstring transactionId;
    if (!GenerateTransactionId(transactionId, errorText)) return false;
    ScopedHandle readyEvent(CreateEventW(nullptr, TRUE, FALSE, ReadyEventName(transactionId).c_str()));
    if (!readyEvent || GetLastError() == ERROR_ALREADY_EXISTS) {
        errorText = L"无法创建唯一的更新助手接管事件：" + FormatSystemError(GetLastError());
        return false;
    }
    const std::filesystem::path helper = HelperPath(request.dataRoot, transactionId);
    if (!EnsureDirectory(helper.parent_path(), errorText) ||
        !EnsureDirectory(TransactionDirectory(request.dataRoot, transactionId), errorText)) {
        return false;
    }
    if (!CopyFileW(currentExecutable.c_str(), helper.c_str(), TRUE)) {
        errorText = L"无法创建已验证启动器的更新助手副本：" + FormatSystemError(GetLastError());
        return false;
    }
    if (!FlushExistingFile(helper, errorText)) {
        DeleteFileW(helper.c_str());
        return false;
    }

    StartupCommand helperCommand;
    helperCommand.kind = StartupKind::Helper;
    helperCommand.transactionId = transactionId;
    helperCommand.dataRoot = request.dataRoot;
    helperCommand.parentProcessId = GetCurrentProcessId();
    helperCommand.launcherVersion = request.candidateVersion;
    helperCommand.launcherSize = request.candidateSize;
    helperCommand.launcherSha256 = normalizedSha;
    helperCommand.runtimeVersion = request.runtimeVersion;
    if (!WritePhase(helperCommand, "prepared", errorText)) {
        DeleteFileW(helper.c_str());
        return false;
    }

    std::wstring arguments = std::wstring(kHelperMode) +
        L" " + kTransactionOption + L" " + QuoteArgument(transactionId) +
        L" " + kParentPidOption + L" " + std::to_wstring(GetCurrentProcessId()) +
        L" " + kDataRootOption + L" " + QuoteArgument(request.dataRoot.wstring()) +
        L" " + kLauncherVersionOption + L" " + QuoteArgument(request.candidateVersion) +
        L" " + kLauncherSizeOption + L" " + std::to_wstring(request.candidateSize) +
        L" " + kLauncherSha256Option + L" " + QuoteArgument(normalizedSha);
    if (!request.runtimeVersion.empty()) {
        arguments += L" " + std::wstring(kActivateRuntimeOption) + L" " + QuoteArgument(request.runtimeVersion);
    }
    PROCESS_INFORMATION process{};
    if (!StartProcess(helper, arguments, true, process, errorText)) {
        DeleteFileW(helper.c_str());
        return false;
    }
    if (process.hThread != nullptr) {
        CloseHandle(process.hThread);
        process.hThread = nullptr;
    }
    HANDLE waits[] = {readyEvent.get(), process.hProcess};
    const DWORD readyTimeout = std::min(kHelperReadyTimeoutMs, HealthTimeoutMs());
    const DWORD wait = WaitForMultipleObjects(2, waits, FALSE, readyTimeout);
    const bool ready = wait == WAIT_OBJECT_0 && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT;
    if (!ready) {
        if (process.hProcess != nullptr && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(process.hProcess, 121);
            WaitForSingleObject(process.hProcess, 5000);
        }
        DWORD exitCode = 1;
        if (process.hProcess != nullptr) GetExitCodeProcess(process.hProcess, &exitCode);
        CloseProcessInformation(process);
        const std::wstring helperLog = ReadHelperLog(helperCommand);
        if (wait == WAIT_TIMEOUT) {
            errorText = L"更新助手在接管旧启动器前超时。";
        } else if (wait == WAIT_OBJECT_0 + 1) {
            errorText = L"更新助手在接管旧启动器前退出（代码 " + std::to_wstring(exitCode) + L"）。";
        } else if (wait == WAIT_FAILED) {
            errorText = L"等待更新助手接管失败：" + FormatSystemError(GetLastError());
        } else {
            errorText = L"更新助手未完成安全接管。";
        }
        if (!helperLog.empty()) errorText += L"\n" + helperLog;
        DeleteFileW(helper.c_str());
        RemoveBestEffort(helper.parent_path());
        RemoveTreeBestEffort(TransactionDirectory(request.dataRoot, transactionId));
        return false;
    }
    if (process.hProcess != nullptr) {
        CloseHandle(process.hProcess);
        process.hProcess = nullptr;
    }
    result.helperProcessId = process.dwProcessId;
    result.transactionId = std::move(transactionId);
    return true;
}

int RunSelfUpdateHelper(const StartupCommand& command, std::wstring& errorText) {
    errorText.clear();
    if ((command.kind != StartupKind::Helper && command.kind != StartupKind::Recovery) ||
        !IsTransactionId(command.transactionId) || command.dataRoot.empty() ||
        !command.dataRoot.is_absolute() || command.parentProcessId == 0 ||
        (command.kind == StartupKind::Helper && !ParseSemver(command.launcherVersion))) {
        errorText = L"拒绝执行无效的自更新助手命令。";
        return 2;
    }
    ScopedHandle transactionMutex;
    if (!AcquireTransactionMutex(command.transactionId, transactionMutex, errorText)) return 2;
    if (command.kind == StartupKind::Recovery) {
        return RunRecoveryHelperInternal(command, transactionMutex, errorText);
    }
    AppendHelperLog(command, L"self-update helper started");

    const std::filesystem::path candidate = CandidatePath(command.dataRoot, command.launcherVersion);
    if (!ValidateCandidateLocation(command.dataRoot, candidate, command.launcherVersion, errorText) ||
        !ValidateLauncherCandidate(
            candidate,
            command.launcherVersion,
            command.launcherSize,
            command.launcherSha256,
            errorText)) {
        AppendHelperLog(command, errorText);
        return 3;
    }

    ScopedHandle parent(OpenProcess(
        SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, command.parentProcessId));
    if (!parent) {
        errorText = L"无法打开父启动器进程：" + FormatSystemError(GetLastError());
        AppendHelperLog(command, errorText);
        return 4;
    }
    std::filesystem::path target;
    if (!QueryProcessImagePath(parent.get(), target, errorText)) {
        AppendHelperLog(command, errorText);
        return 4;
    }
    if (!IsSafeRegularFile(target, errorText)) {
        AppendHelperLog(command, errorText);
        return 4;
    }
    std::wstring targetFinal;
    if (!FinalPath(target, false, targetFinal, errorText)) {
        AppendHelperLog(command, errorText);
        return 4;
    }
    // QueryFullProcessImageNameW supplied the target. Resolve it once so a
    // legitimate installation below a junction is updated at its real path.
    target = std::filesystem::path(targetFinal);
    std::filesystem::path helperExecutable;
    const std::filesystem::path expectedHelper = HelperPath(command.dataRoot, command.transactionId);
    std::wstring helperFull;
    std::wstring expectedHelperFull;
    std::wstring parentDigest;
    std::wstring helperDigest;
    if (!CurrentExecutablePath(helperExecutable, errorText) ||
        !FullPath(helperExecutable, helperFull, errorText) ||
        !FullPath(expectedHelper, expectedHelperFull, errorText) ||
        !EqualPath(helperFull, expectedHelperFull) ||
        !ValidateManagedFileBelowDataRoot(command.dataRoot, helperExecutable, errorText) ||
        !HashFileSha256(target, parentDigest, errorText) ||
        !HashFileSha256(helperExecutable, helperDigest, errorText) ||
        !EqualPath(parentDigest, helperDigest)) {
        if (errorText.empty()) {
            errorText = L"父进程映像与已验证的旧启动器助手副本不一致。";
        }
        AppendHelperLog(command, errorText);
        return 4;
    }

    const std::wstring eventName = EventName(command.transactionId);
    ScopedHandle healthEvent(CreateEventW(nullptr, TRUE, FALSE, eventName.c_str()));
    if (!healthEvent || GetLastError() == ERROR_ALREADY_EXISTS) {
        errorText = L"无法创建唯一的更新健康事件：" + FormatSystemError(GetLastError());
        AppendHelperLog(command, errorText);
        return 5;
    }
    std::wstring journalError;
    if (!WriteTransactionMetadata(command, parentDigest, target, journalError) ||
        !WritePhase(command, "waiting-parent", journalError)) {
        errorText = std::move(journalError);
        AppendHelperLog(command, errorText);
        return 5;
    }
    ScopedHandle readyEvent(OpenEventW(EVENT_MODIFY_STATE, FALSE, ReadyEventName(command.transactionId).c_str()));
    if (!readyEvent || !SetEvent(readyEvent.get())) {
        errorText = L"无法确认更新助手已安全接管：" + FormatSystemError(GetLastError());
        AppendHelperLog(command, errorText);
        return 5;
    }

    const DWORD parentTimeout = std::min(kParentExitTimeoutMs, HealthTimeoutMs());
    if (WaitForSingleObject(parent.get(), parentTimeout) != WAIT_OBJECT_0) {
        errorText = L"等待旧启动器退出超时，未进行替换。";
        AppendHelperLog(command, errorText);
        return 6;
    }
    parent.reset();

    auto restartOldAfterAbort = [&](int exitCode, bool discardCandidate) -> int {
        if (discardCandidate) {
            DeleteFileW(candidate.c_str());
            RemoveBestEffort(candidate.parent_path());
        }
        AppendHelperLog(command, L"self-update transaction closed before restarting the old launcher");
        RemoveTreeBestEffort(TransactionDirectory(command.dataRoot, command.transactionId));
        ScheduleSelfDelete();
        transactionMutex.reset();
        PROCESS_INFORMATION restart{};
        std::wstring restartError;
        if (!StartProcess(target, L"", false, restart, restartError)) {
            if (!errorText.empty()) errorText += L"\n";
            errorText += L"旧启动器仍可手动打开，但无法自动重新打开：" + restartError;
            return exitCode;
        }
        CloseProcessInformation(restart);
        return exitCode;
    };

    if (!BackupRuntimeState(command, errorText)) {
        AppendHelperLog(command, errorText);
        return restartOldAfterAbort(7, false);
    }

    const std::filesystem::path targetTemporary =
        target.wstring() + L".dsh-update-" + command.transactionId + L".tmp";
    const std::filesystem::path targetBackup =
        target.wstring() + L".dsh-backup-" + command.transactionId + L".bak";
    DeleteFileW(targetTemporary.c_str());
    DeleteFileW(targetBackup.c_str());
    if (!CopyFileW(candidate.c_str(), targetTemporary.c_str(), TRUE) ||
        !FlushExistingFile(targetTemporary, errorText) ||
        !ValidateLauncherCandidate(
            targetTemporary,
            command.launcherVersion,
            command.launcherSize,
            command.launcherSha256,
            errorText)) {
        if (errorText.empty()) errorText = L"无法把候选启动器复制到目标目录：" + FormatSystemError(GetLastError());
        AppendHelperLog(command, errorText);
        DeleteFileW(targetTemporary.c_str());
        return restartOldAfterAbort(8, false);
    }
    if (!FileHashMatches(target, parentDigest, errorText)) {
        AppendHelperLog(command, L"目标启动器在父进程退出后发生变化，已拒绝替换。\n" + errorText);
        DeleteFileW(targetTemporary.c_str());
        return 9;
    }
    if (!ReplaceFileWithRetry(target, targetTemporary, &targetBackup, kReplaceRetryMs, errorText)) {
        AppendHelperLog(command, errorText);
        DeleteFileW(targetTemporary.c_str());
        return restartOldAfterAbort(9, false);
    }
    if (!WritePhase(command, "replaced", journalError)) {
        errorText = std::move(journalError);
        AppendHelperLog(command, errorText);
        std::wstring launcherRollbackError;
        std::wstring runtimeRollbackError;
        const bool launcherRestored =
            RestoreLauncher(target, targetBackup, parentDigest, launcherRollbackError);
        const bool runtimeRestored = RestoreRuntimeState(command, runtimeRollbackError);
        if (!launcherRestored || !runtimeRestored) {
            errorText += L"\n回滚失败：" + launcherRollbackError +
                (runtimeRollbackError.empty() ? std::wstring{} : L"\n" + runtimeRollbackError);
            AppendHelperLog(command, errorText);
            return 10;
        }
        return restartOldAfterAbort(10, false);
    }

    std::wstring healthArguments = std::wstring(kHealthMode) +
        L" " + kTransactionOption + L" " + QuoteArgument(command.transactionId) +
        L" " + kDataRootOption + L" " + QuoteArgument(command.dataRoot.wstring());
    if (!command.runtimeVersion.empty()) {
        healthArguments += L" " + std::wstring(kActivateRuntimeOption) + L" " + QuoteArgument(command.runtimeVersion);
    }
    PROCESS_INFORMATION launched{};
    if (!StartProcess(target, healthArguments, false, launched, errorText)) {
        launched.hProcess = nullptr;
        launched.hThread = nullptr;
    } else {
        if (launched.hThread != nullptr) {
            CloseHandle(launched.hThread);
            launched.hThread = nullptr;
        }
        std::wstring ignored;
        WritePhase(command, "launched", ignored);
    }

    bool healthy = false;
    if (launched.hProcess != nullptr) {
        HANDLE waits[] = {healthEvent.get(), launched.hProcess};
        const DWORD wait = WaitForMultipleObjects(2, waits, FALSE, HealthTimeoutMs());
        healthy = wait == WAIT_OBJECT_0 && WaitForSingleObject(launched.hProcess, 0) == WAIT_TIMEOUT;
        if (!healthy) {
            if (wait == WAIT_TIMEOUT) errorText = L"新版启动器健康检查超时。";
            else if (wait == WAIT_OBJECT_0 + 1) errorText = L"新版启动器在健康检查前退出。";
            else if (wait == WAIT_FAILED) errorText = L"等待新版启动器健康检查失败：" + FormatSystemError(GetLastError());
            else if (errorText.empty()) errorText = L"新版启动器未通过健康检查。";
        }
    }

    if (healthy) {
        std::wstring ignored;
        WritePhase(command, "committed", ignored);
        CloseHandle(launched.hProcess);
        DeleteFileW(targetBackup.c_str());
        DeleteFileW(candidate.c_str());
        RemoveBestEffort(candidate.parent_path());
        AppendHelperLog(command, L"self-update committed");
        RemoveTreeBestEffort(TransactionDirectory(command.dataRoot, command.transactionId));
        ScheduleSelfDelete();
        return 0;
    }

    AppendHelperLog(command, errorText);
    if (launched.hProcess != nullptr) {
        if (WaitForSingleObject(launched.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(launched.hProcess, 120);
            WaitForSingleObject(launched.hProcess, 10000);
        }
        CloseHandle(launched.hProcess);
    }
    std::wstring launcherRollbackError;
    const bool launcherRestored =
        RestoreLauncher(target, targetBackup, parentDigest, launcherRollbackError);
    std::wstring runtimeRollbackError;
    const bool runtimeRestored = RestoreRuntimeState(command, runtimeRollbackError);
    if (!launcherRestored || !runtimeRestored) {
        errorText += L"\n回滚失败：" + launcherRollbackError +
            (runtimeRollbackError.empty() ? std::wstring{} : L"\n" + runtimeRollbackError);
        AppendHelperLog(command, errorText);
        return 11;
    }
    std::wstring ignored;
    WritePhase(command, "rolled-back", ignored);
    return restartOldAfterAbort(13, true);
}

RecoveryDisposition RecoverInterruptedSelfUpdate(
    const std::filesystem::path& actualDataRoot,
    std::wstring& errorText) {
    errorText.clear();
    if (actualDataRoot.empty() || !actualDataRoot.is_absolute()) {
        errorText = L"自更新恢复要求绝对的数据目录路径。";
        return RecoveryDisposition::Error;
    }

    std::filesystem::path currentExecutable;
    std::wstring currentTarget;
    std::wstring currentDigest;
    if (!CurrentExecutablePath(currentExecutable, errorText) ||
        !IsSafeRegularFile(currentExecutable, errorText) ||
        !FinalPath(currentExecutable, false, currentTarget, errorText) ||
        !HashFileSha256(currentExecutable, currentDigest, errorText)) {
        return RecoveryDisposition::Error;
    }
    const std::filesystem::path target(currentTarget);
    std::vector<MatchingTransaction> matches;
    if (!FindMatchingTransactions(actualDataRoot, currentTarget, matches, errorText)) {
        return RecoveryDisposition::Error;
    }
    if (matches.empty()) return RecoveryDisposition::None;

    const MatchingTransaction& match = matches.front();
    const TransactionMetadata& metadata = match.metadata;
    const bool runningOld = EqualPath(currentDigest, metadata.oldLauncherSha256);
    const bool runningNew = EqualPath(currentDigest, metadata.launcherSha256);
    if (!runningOld && !runningNew) {
        errorText = L"当前启动器与其未完成更新事务中的新旧摘要均不一致。";
        return RecoveryDisposition::Error;
    }

    SetLastError(ERROR_SUCCESS);
    ScopedHandle transactionMutex(CreateMutexW(
        nullptr, FALSE, TransactionMutexName(metadata.transactionId).c_str()));
    const DWORD mutexError = GetLastError();
    if (!transactionMutex) {
        errorText = L"无法检查自更新事务是否正在运行：" + FormatSystemError(mutexError);
        return RecoveryDisposition::Error;
    }
    if (mutexError == ERROR_ALREADY_EXISTS) {
        return RecoveryDisposition::ExitForRecovery;
    }

    RuntimeBackupKind runtimeBackup = RuntimeBackupKind::None;
    if (!InspectRuntimeBackup(actualDataRoot, metadata, runtimeBackup, errorText)) {
        return RecoveryDisposition::Error;
    }
    bool candidateExists = false;
    bool backupExists = false;
    bool helperExists = false;

    if (runningOld) {
        if (!ValidateRecoveryArtifacts(
                actualDataRoot,
                target,
                metadata,
                false,
                candidateExists,
                backupExists,
                helperExists,
                errorText)) {
            return RecoveryDisposition::Error;
        }
        if (runtimeBackup != RuntimeBackupKind::None) {
            StartupCommand stateCommand = CommandFromMetadata(StartupKind::Recovery, actualDataRoot, metadata);
            if (!RestoreRuntimeState(stateCommand, errorText)) return RecoveryDisposition::Error;
        }
        StartupCommand logCommand = CommandFromMetadata(StartupKind::Recovery, actualDataRoot, metadata);
        std::wstring ignored;
        WritePhase(logCommand, "rolled-back", ignored);
        AppendHelperLog(logCommand, L"interrupted transaction already has the old launcher; cleanup committed");
        if (!CleanupRecoveryArtifacts(
                actualDataRoot,
                target,
                metadata,
                candidateExists,
                backupExists,
                helperExists,
                errorText)) {
            return RecoveryDisposition::Error;
        }
        return RecoveryDisposition::None;
    }

    std::wstring runtimeHealthError;
    const bool runtimeHealthy = RuntimeTransactionIsHealthy(actualDataRoot, metadata, runtimeHealthError);
    const bool healthCommitted = match.phase == "healthy" || match.phase == "committed";
    if (healthCommitted && runtimeHealthy) {
        if (!ValidateRecoveryArtifacts(
                actualDataRoot,
                target,
                metadata,
                false,
                candidateExists,
                backupExists,
                helperExists,
                errorText)) {
            return RecoveryDisposition::Error;
        }
        StartupCommand logCommand = CommandFromMetadata(StartupKind::Recovery, actualDataRoot, metadata);
        std::wstring ignored;
        WritePhase(logCommand, "committed", ignored);
        AppendHelperLog(logCommand, L"healthy interrupted transaction committed during normal startup");
        if (!CleanupRecoveryArtifacts(
                actualDataRoot,
                target,
                metadata,
                candidateExists,
                backupExists,
                helperExists,
                errorText)) {
            return RecoveryDisposition::Error;
        }
        return RecoveryDisposition::None;
    }

    if (!ValidateRecoveryArtifacts(
            actualDataRoot,
            target,
            metadata,
            true,
            candidateExists,
            backupExists,
            helperExists,
            errorText) ||
        (!metadata.runtimeVersion.empty() && runtimeBackup == RuntimeBackupKind::None)) {
        if (errorText.empty()) errorText = L"未完成更新不具备安全回滚所需的全部文件。";
        return RecoveryDisposition::Error;
    }

    SetLastError(ERROR_SUCCESS);
    ScopedHandle readyEvent(CreateEventW(
        nullptr, TRUE, FALSE, RecoveryReadyEventName(metadata.transactionId).c_str()));
    const DWORD eventError = GetLastError();
    if (!readyEvent) {
        errorText = L"无法创建恢复助手接管事件：" + FormatSystemError(eventError);
        return RecoveryDisposition::Error;
    }
    if (eventError == ERROR_ALREADY_EXISTS) return RecoveryDisposition::ExitForRecovery;

    // The old helper must become the sole transaction owner. The recovery-ready
    // event prevents another normal launcher from racing this handoff window.
    transactionMutex.reset();
    const std::filesystem::path helper = HelperPath(actualDataRoot, metadata.transactionId);
    const std::wstring arguments = std::wstring(kRecoveryMode) +
        L" " + kTransactionOption + L" " + QuoteArgument(metadata.transactionId) +
        L" " + kParentPidOption + L" " + std::to_wstring(GetCurrentProcessId()) +
        L" " + kDataRootOption + L" " + QuoteArgument(actualDataRoot.wstring());
    PROCESS_INFORMATION process{};
    if (!StartProcess(helper, arguments, true, process, errorText)) {
        return RecoveryDisposition::Error;
    }
    if (process.hThread != nullptr) {
        CloseHandle(process.hThread);
        process.hThread = nullptr;
    }
    HANDLE waits[] = {readyEvent.get(), process.hProcess};
    const DWORD readyTimeout = std::min(kHelperReadyTimeoutMs, HealthTimeoutMs());
    const DWORD wait = WaitForMultipleObjects(2, waits, FALSE, readyTimeout);
    const bool ready = wait == WAIT_OBJECT_0 && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT;
    if (!ready) {
        if (process.hProcess != nullptr && WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT) {
            TerminateProcess(process.hProcess, 122);
            WaitForSingleObject(process.hProcess, 5000);
        }
        DWORD exitCode = 1;
        if (process.hProcess != nullptr) GetExitCodeProcess(process.hProcess, &exitCode);
        CloseProcessInformation(process);
        const StartupCommand logCommand =
            CommandFromMetadata(StartupKind::Recovery, actualDataRoot, metadata);
        const std::wstring helperLog = ReadHelperLog(logCommand);
        if (wait == WAIT_TIMEOUT) {
            errorText = L"恢复助手在接管当前启动器前超时。";
        } else if (wait == WAIT_OBJECT_0 + 1) {
            errorText = L"恢复助手在接管当前启动器前退出（代码 " + std::to_wstring(exitCode) + L"）。";
        } else if (wait == WAIT_FAILED) {
            errorText = L"等待恢复助手接管失败：" + FormatSystemError(GetLastError());
        } else {
            errorText = L"恢复助手未完成安全接管。";
        }
        if (!helperLog.empty()) errorText += L"\n" + helperLog;
        return RecoveryDisposition::Error;
    }
    if (process.hProcess != nullptr) {
        CloseHandle(process.hProcess);
        process.hProcess = nullptr;
    }
    return RecoveryDisposition::ExitForRecovery;
}

bool ActivateRequestedRuntime(
    const StartupCommand& command,
    const std::filesystem::path& actualDataRoot,
    std::wstring& errorText) {
    errorText.clear();
    if (command.kind != StartupKind::Health) return true;
    if (!DataRootsMatch(command.dataRoot, actualDataRoot, errorText)) return false;
    TransactionMetadata metadata;
    if (!ReadTransactionMetadata(actualDataRoot, command.transactionId, metadata, errorText) ||
        metadata.runtimeVersion != command.runtimeVersion) {
        if (errorText.empty()) errorText = L"运行时激活请求与受信自更新事务不一致。";
        return false;
    }
    if (command.runtimeVersion.empty()) return true;
    if (!ValidateManagedRuntime(actualDataRoot, command.runtimeVersion, errorText)) return false;
    RuntimeState state;
    if (!ReadRuntimeState(actualDataRoot, state, errorText)) return false;
    if (state.pending) {
        if (state.active == command.runtimeVersion) return true;
        errorText = L"另一项运行时更新仍在健康检查中。";
        return false;
    }
    if (state.active == command.runtimeVersion) return true;
    state.previous = state.active;
    state.active = command.runtimeVersion;
    state.pending = true;
    state.attempts = 0;
    return WriteRuntimeState(actualDataRoot, state, errorText);
}

bool SignalUpdateHealthy(
    const StartupCommand& command,
    const std::filesystem::path& actualDataRoot,
    std::wstring& errorText) {
    errorText.clear();
    if (command.kind != StartupKind::Health) return true;
    if (!DataRootsMatch(command.dataRoot, actualDataRoot, errorText)) return false;
    TransactionMetadata metadata;
    if (!ReadTransactionMetadata(actualDataRoot, command.transactionId, metadata, errorText) ||
        metadata.runtimeVersion != command.runtimeVersion) {
        if (errorText.empty()) errorText = L"健康检查请求与受信自更新事务不一致。";
        return false;
    }
    if (!command.runtimeVersion.empty()) {
        RuntimeState state;
        if (!ReadRuntimeState(actualDataRoot, state, errorText)) return false;
        if (state.pending || state.active != command.runtimeVersion) {
            errorText = L"候选运行时尚未完成健康确认，拒绝提交启动器更新。";
            return false;
        }
    }
    std::wstring journalError;
    if (!WritePhase(command, "healthy", journalError)) {
        errorText = std::move(journalError);
        return false;
    }
    ScopedHandle event(OpenEventW(EVENT_MODIFY_STATE, FALSE, EventName(command.transactionId).c_str()));
    if (!event || !SetEvent(event.get())) {
        errorText = L"无法提交启动器健康信号：" + FormatSystemError(GetLastError());
        return false;
    }
    return true;
}

} // namespace dsh::self_update
