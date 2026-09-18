#pragma once
#include <windows.h>
#include <ncrypt.h>
#include <array>
#include <cstdint>
#include <span>

namespace goatcitadel::worker_cell {
using ControllerDigest = std::array<std::uint8_t, 32>;
using ControllerPublicPoint = std::array<std::uint8_t, 65>;
using ControllerStatement = std::array<std::uint8_t, 396>;
using ControllerSignature = std::array<std::uint8_t, 64>;
constexpr wchar_t kControllerAttestationKeyName[] = L"GoatCitadel.CellController.Attestation.v1";
// Opens only the administrator-provisioned machine key. Never creates, repairs,
// exports private material or changes key permissions from the service.
class ControllerAttestationKey final {
 public:
  ~ControllerAttestationKey();
  ControllerAttestationKey() = default;
  ControllerAttestationKey(const ControllerAttestationKey&) = delete;
  ControllerAttestationKey& operator=(const ControllerAttestationKey&) = delete;
  DWORD OpenInstalled(const wchar_t* controller_sid) noexcept;
  DWORD Verify() noexcept;
  NCRYPT_KEY_HANDLE Handle() const noexcept { return key_; }
  const ControllerDigest& Fingerprint() const noexcept { return fingerprint_; }
  const ControllerDigest& Instance() const noexcept { return instance_; }
 private:
  NCRYPT_PROV_HANDLE provider_ = 0;
  NCRYPT_KEY_HANDLE key_ = 0;
  ControllerDigest fingerprint_{}, instance_{};
  std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> controller_sid_{};
  bool attempted_ = false, failed_ = false;
};
struct ControllerAttestationState final {
  ControllerDigest key_sha256{}, instance{}, authority{}, installation_nonce{}, request_sha256{};
  // nonce, connection, pool snapshot, host capture, members, references.
  std::array<ControllerDigest, 6> window{};
};
struct ControllerAttestationGuard final {
  void* context = nullptr;
  DWORD (*check)(void*) noexcept = nullptr;
  HANDLE stop = nullptr;
  ULONGLONG deadline = 0;
};
DWORD ReadControllerAttestationPublicPoint(NCRYPT_KEY_HANDLE, ControllerPublicPoint*, ControllerDigest*) noexcept;
// Derive observed digests from the controller's own frozen GCPRESP1 capture.
// references is Gateway context, not a claim about native filesystem state.
DWORD DeriveControllerAttestationWindow(std::span<const std::uint8_t>, const ControllerDigest& references,
  std::array<ControllerDigest, 6>*) noexcept;
bool EncodeControllerAttestation(const ControllerAttestationState&, const ControllerDigest& challenge,
  std::uint32_t ordinal, ControllerStatement*) noexcept;

// One serialized, authenticated controller connection. Its owner retains the
// CNG key and the native writer/capture guard for this object's entire lifetime.
// No arbitrary-payload signing API: only a nonce and the next ordinal arrive
// from the peer. All state is retained by the controller before construction.
class CellControllerAttestationSigner final {
 public:
  CellControllerAttestationSigner(NCRYPT_KEY_HANDLE key, const ControllerAttestationState& state,
    const ControllerAttestationGuard& guard) noexcept : key_(key), state_(state), guard_(guard) {}
  CellControllerAttestationSigner(const CellControllerAttestationSigner&) = delete;
  CellControllerAttestationSigner& operator=(const CellControllerAttestationSigner&) = delete;
  DWORD Sign(const ControllerDigest& challenge, std::uint32_t ordinal, ControllerStatement*, ControllerSignature*) noexcept;
 private:
  DWORD Check() noexcept;
  const NCRYPT_KEY_HANDLE key_;
  const ControllerAttestationState state_;
  const ControllerAttestationGuard guard_;
  std::uint32_t ordinal_ = 0;
  bool active_ = false, failed_ = false;
};
}
