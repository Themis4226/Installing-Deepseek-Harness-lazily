#pragma once

#include <string>
#include <string_view>

namespace dsh {
struct ReadyAddress {
    unsigned short port = 0;
    std::string url;
};

// Only complete, canonical loopback startup lines may supply the WebView URL.
inline bool ParseReadyAddress(std::string_view line, ReadyAddress& address) {
    constexpr std::string_view marker = "dsh web: http://127.0.0.1:";
    if (line.empty() || line.back() != '\n') return false;
    line.remove_suffix(1);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    if (line.substr(0, marker.size()) != marker) return false;
    const size_t end = line.find(' ', marker.size());
    const auto value = line.substr(marker.size(), end == std::string_view::npos
        ? std::string_view::npos : end - marker.size());
    size_t digits = 0;
    unsigned int port = 0;
    while (digits < value.size() && value[digits] >= '0' && value[digits] <= '9') {
        if (digits >= 5) return false;
        port = port * 10 + static_cast<unsigned int>(value[digits++] - '0');
    }
    if (digits == 0 || port == 0 || port > 65535 || value[0] == '0') return false;
    const auto suffix = value.substr(digits);
    constexpr std::string_view tokenPrefix = "/?token=";
    if (!suffix.empty() && suffix != "/") {
        if (suffix.substr(0, tokenPrefix.size()) != tokenPrefix) return false;
        const auto token = suffix.substr(tokenPrefix.size());
        if (token.empty() || token.size() > 512) return false;
        for (char ch : token) {
            if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') || ch == '-' || ch == '_')) return false;
        }
    }
    address.port = static_cast<unsigned short>(port);
    address.url = "http://127.0.0.1:" + std::to_string(port) +
        (suffix.empty() ? "/" : std::string(suffix));
    return true;
}

inline std::string RedactLaunchTokens(std::string line) {
    size_t position = 0;
    while ((position = line.find("?token=", position)) != std::string::npos) {
        const size_t start = position + 7;
        const size_t end = line.find_first_of(" \t\r\n)", start);
        line.replace(start, end == std::string::npos ? std::string::npos : end - start, "[redacted]");
        position = start + 10;
    }
    return line;
}
}
