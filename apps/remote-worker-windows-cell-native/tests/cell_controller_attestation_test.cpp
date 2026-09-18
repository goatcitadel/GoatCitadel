#include "cell_controller_attestation.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
#include <cstring>
using namespace goatcitadel::worker_cell;
template <std::size_t N> std::string Hex(const std::array<std::uint8_t, N>& bytes) {
  constexpr char digits[] = "0123456789abcdef"; std::string result;
  for (auto value : bytes) { result += digits[value >> 4]; result += digits[value & 15]; }
  return result;
}
struct Key final {
  NCRYPT_PROV_HANDLE provider = 0; NCRYPT_KEY_HANDLE key = 0;
  ~Key() { if (key) NCryptFreeObject(key); if (provider) NCryptFreeObject(provider); }
  bool Open(bool exportable = false) {
    DWORD usage = NCRYPT_ALLOW_SIGNING_FLAG, policy = exportable ? NCRYPT_ALLOW_EXPORT_FLAG : 0;
    return !NCryptOpenStorageProvider(&provider, MS_KEY_STORAGE_PROVIDER, 0) &&
      !NCryptCreatePersistedKey(provider, &key, NCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0, 0) &&
      !NCryptSetProperty(key, NCRYPT_KEY_USAGE_PROPERTY, reinterpret_cast<PBYTE>(&usage), sizeof(usage), 0) &&
      !NCryptSetProperty(key, NCRYPT_EXPORT_POLICY_PROPERTY, reinterpret_cast<PBYTE>(&policy), sizeof(policy), 0) && !NCryptFinalizeKey(key, 0);
  }
};
struct Event final { HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr); ~Event() { if (value) CloseHandle(value); } };
struct Guard { unsigned calls = 0, fail_at = 0; };
DWORD Check(void* raw) noexcept { auto& g = *static_cast<Guard*>(raw); return ++g.calls == g.fail_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS; }
int main() {
  unsigned checks = 0;
  const auto check = [&](bool value) { ++checks; return value; };
  Key key; Event event; if (!key.Open() || !event.value) return 1;
  ControllerPublicPoint point{}; ControllerDigest fingerprint{};
  if (!check(!ReadControllerAttestationPublicPoint(key.key, &point, &fingerprint))) return 2;
  ControllerAttestationState state; state.key_sha256 = fingerprint; state.instance.fill(2); state.authority.fill(3);
  state.installation_nonce.fill(5); state.request_sha256.fill(6);
  for (unsigned i = 0; i < 6; ++i) state.window[i].fill(static_cast<std::uint8_t>(7 + i));
  ControllerDigest nonce; nonce.fill(4);
  Guard context; ControllerAttestationGuard guard{&context, Check, event.value, GetTickCount64() + 30000};
  CellControllerAttestationSigner signer(key.key, state, guard);
  ControllerStatement statement{}; ControllerSignature signature{};
  if (!check(!signer.Sign(nonce, 1, &statement, &signature)) || !check(context.calls == 2)) return 3;
  const auto first = statement; const auto first_signature = signature;
  nonce.fill(13);
  if (!check(!signer.Sign(nonce, 2, &statement, &signature))) return 4;
  if (!check(signer.Sign(nonce, 2, &statement, &signature) != 0) || !check(statement == ControllerStatement{}) ||
      !check(signature == ControllerSignature{}) || !check(signer.Sign(nonce, 3, &statement, &signature) != 0)) return 5;
  for (unsigned mode = 0; mode < 4; ++mode) {
    Guard failing; auto local = guard; local.context = &failing; auto altered = state;
    if (mode == 0) failing.fail_at = 1;
    if (mode == 1) failing.fail_at = 2;
    if (mode == 2) local.deadline = GetTickCount64();
    if (mode == 3) altered.key_sha256.fill(42);
    CellControllerAttestationSigner rejected(key.key, altered, local);
    statement.fill(255); signature.fill(255);
    if (!check(rejected.Sign(nonce, 1, &statement, &signature) != 0) || !check(statement == ControllerStatement{}) ||
        !check(signature == ControllerSignature{}) || !check(rejected.Sign(nonce, 1, &statement, &signature) != 0)) return 6;
  }
  Key exportable; if (!exportable.Open(true)) return 7;
  ControllerPublicPoint rejected_point{}; ControllerDigest rejected_hash{};
  if (!check(ReadControllerAttestationPublicPoint(exportable.key, &rejected_point, &rejected_hash) == ERROR_ACCESS_DENIED)) return 8;
  SetEvent(event.value);
  CellControllerAttestationSigner stopped(key.key, state, guard);
  if (!check(stopped.Sign(nonce, 1, &statement, &signature) != 0) || !check(signature == ControllerSignature{})) return 9;
  // Structural wire fixture only; this does not represent a filesystem capture.
  std::vector<std::uint8_t> capture(472 + 888 + 2 * 784 + 3000);
  const auto put = [&](std::size_t offset, std::uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) capture[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
  };
  std::memcpy(capture.data(), "GCPRESP1", 8); put(8, 1); put(12, 2); put(16, 888);
  std::fill_n(capture.begin() + 24, 32, std::uint8_t{8}); std::fill_n(capture.begin() + 56, 32, std::uint8_t{9});
  std::memcpy(capture.data() + 472, "GCCAP001", 8); std::fill_n(capture.begin() + 480, 32, std::uint8_t{7});
  std::size_t at = 1360;
  for (unsigned member = 0; member < 2; ++member) {
    put(at, member); put(at + 4, member + 1); at += 8;
    std::fill_n(capture.begin() + at, 352, static_cast<std::uint8_t>(20 + member)); at += 352;
    std::fill_n(capture.begin() + at, 424, static_cast<std::uint8_t>(30 + member)); at += 424;
    for (unsigned chunk = 0; chunk <= member; ++chunk) {
      std::fill_n(capture.begin() + at, 1000, static_cast<std::uint8_t>(40 + member + chunk)); at += 1000;
    }
  }
  std::array<ControllerDigest, 6> derived{};
  if (!check(!DeriveControllerAttestationWindow(capture, state.window[5], &derived))) return 10;
  const auto derived_first = derived;
  for (const auto size : {std::size_t(0), std::size_t(1311), std::size_t(1360), capture.size() - 1}) {
    if (!check(DeriveControllerAttestationWindow(std::span(capture).first(size), state.window[5], &derived) != 0) ||
        !check(derived == std::array<ControllerDigest, 6>{})) return 11;
  }
  for (const auto offset : {0u, 8u, 12u, 16u, 20u, 88u, 472u, 1360u, 1364u}) {
    auto changed = capture; changed[offset] ^= 128;
    if (!check(DeriveControllerAttestationWindow(changed, state.window[5], &derived) != 0)) return 12;
  }
  capture.push_back(0);
  if (!check(DeriveControllerAttestationWindow(capture, state.window[5], &derived) != 0)) return 13;
  std::cout << "{\"passed\":true,\"checks\":" << checks << ",\"publicPointHex\":\"" << Hex(point)
    << "\",\"keySha256\":\"" << Hex(fingerprint) << "\",\"statementHex\":\"" << Hex(first)
    << "\",\"signatureHex\":\"" << Hex(first_signature) << "\",\"derivedWindow\":[";
  for (unsigned i = 0; i < 6; ++i) { if (i) std::cout << ','; std::cout << '"' << Hex(derived_first[i]) << '"'; }
  std::cout << "],\"persistedKeys\":false,\"volumeOperations\":false}\n";
  return 0;
}
