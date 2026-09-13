#pragma once
#include <windows.h>
#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::worker_tls {
constexpr std::size_t kMaximumHelperPathCharacters = 1023;
constexpr std::size_t kKeyHeaderBytes = 188;
constexpr std::size_t kMaximumKeyBytes = kKeyHeaderBytes + 2 * kMaximumHelperPathCharacters;
constexpr char kKeyPrefix[] = "goatcitadel-tls-v1:";
constexpr std::size_t kMaximumIdentifierCharacters = sizeof(kKeyPrefix)-1+2*kMaximumKeyBytes;
constexpr std::size_t kRequestBytes = 296;
constexpr std::size_t kResponseBytes = 200;
constexpr DWORD kOperationTimeoutMs = 5000;
constexpr DWORD kTerminationTimeoutMs = 2000;
struct KeyAuthority {
  std::uint64_t generation{};
  std::array<std::uint8_t,32> state{};
  std::array<std::uint8_t,32> receipt{};
  std::array<std::uint8_t,32> spki_sha256{};
  std::array<std::uint8_t,44> spki{};
  std::array<std::uint8_t,32> helper_sha256{};
  std::array<wchar_t,kMaximumHelperPathCharacters+1> helper_path{};
};
bool HashBytes(const std::uint8_t* bytes, std::size_t length, std::array<std::uint8_t,32>* hash) noexcept;
bool DecodeIdentifier(const char* identifier, KeyAuthority* output) noexcept;
bool IsClientCertificateVerify(const std::uint8_t* bytes,std::size_t length) noexcept;
bool BuildRequest(const KeyAuthority& authority,const std::uint8_t* preimage,std::size_t length,
    std::array<std::uint8_t,kRequestBytes>* request) noexcept;
bool DecodeResponse(const KeyAuthority& authority,const std::array<std::uint8_t,kResponseBytes>& response,
    std::array<std::uint8_t,64>* signature) noexcept;
HANDLE OpenPinnedHelper(const KeyAuthority& authority) noexcept;
// A read-only image and ancestor lease, retained before the Windows loader runs.
struct PinnedImageLease;
PinnedImageLease* RetainPinnedImage(const KeyAuthority& authority) noexcept;
void ReleasePinnedImage(PinnedImageLease* lease) noexcept;
bool SignWithPinnedHelper(const KeyAuthority& authority,HANDLE pinned_image,
    const std::uint8_t* preimage,std::size_t length,std::array<std::uint8_t,64>* signature) noexcept;
}
