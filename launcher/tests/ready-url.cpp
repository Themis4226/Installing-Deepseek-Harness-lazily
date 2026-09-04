#include "../ready_url.h"
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

void Require(bool value) {
    if (!value) throw std::runtime_error("ready URL regression");
}
int main() {
    dsh::ReadyAddress result;
    const std::string authenticated = "dsh web: http://127.0.0.1:3080/?token=abcDEF012_-\r\n";
    Require(dsh::ParseReadyAddress(authenticated, result));
    Require(result.port == 3080 && result.url == "http://127.0.0.1:3080/?token=abcDEF012_-");
    for (size_t size = 0; size < authenticated.size(); ++size) {
        Require(!dsh::ParseReadyAddress(authenticated.substr(0, size), result));
    }
    Require(dsh::ParseReadyAddress("dsh web: http://127.0.0.1:3080\n", result));
    Require(result.url == "http://127.0.0.1:3080/");
    Require(dsh::ParseReadyAddress("dsh web: http://127.0.0.1:65535/\n", result));
    Require(dsh::ParseReadyAddress("dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.2:3080/?token=abc)\n", result));
    const std::vector<std::string> invalid = {
        "http://127.0.0.1:3080/\n",
        "dsh web: http://localhost:3080/\n",
        "dsh web: https://127.0.0.1:3080/\n",
        "dsh web: http://127.0.0.1:0/\n",
        "dsh web: http://127.0.0.1:03080/\n",
        "dsh web: http://127.0.0.1:65536/\n",
        "dsh web: http://127.0.0.1:9999999999999999999999/\n",
        "dsh web: http://127.0.0.1:3080@evil.invalid/\n",
        "dsh web: http://127.0.0.1:3080.evil.invalid/\n",
        "dsh web: http://127.0.0.1:3080/path\n",
        "dsh web: http://127.0.0.1:3080/?token=\n",
        "dsh web: http://127.0.0.1:3080/?token=abc&next=https://evil.invalid\n",
        "dsh web: http://127.0.0.1:3080/?token=abc#fragment\n",
        "dsh web: http://127.0.0.1:3080/?token=%00\n",
        "dsh web: http://127.0.0.1:3080/?token=" + std::string(513, 'x') + "\n",
    };
    for (const auto& line : invalid) Require(!dsh::ParseReadyAddress(line, result));
    Require(dsh::RedactLaunchTokens(authenticated).find("abcDEF012_-") == std::string::npos);
    Require(dsh::RedactLaunchTokens("?token=secret (LAN: ?token=secret2)\n") ==
        "?token=[redacted] (LAN: ?token=[redacted])\n");
    Require(dsh::RedactLaunchTokens("ordinary output\n") == "ordinary output\n");
    std::cout << "Ready URL parsing, every split boundary, origin restrictions, and token redaction passed.\n";
}
