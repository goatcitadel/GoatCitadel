#include "cell_controller_attestation.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>
#include <sddl.h>
#pragma comment(lib, "ncrypt.lib")
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
namespace {
template <std::size_t N> bool Nonzero(const std::array<std::uint8_t, N>& bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; });
}
DWORD Hash(const std::uint8_t* bytes, ULONG length, ControllerDigest* output) noexcept {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto result = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(bytes), length, output->data(), 32);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return result < 0 ? ERROR_INVALID_DATA : ERROR_SUCCESS;
}
}
ControllerAttestationKey::~ControllerAttestationKey() {
  if (key_) NCryptFreeObject(key_);
  if (provider_) NCryptFreeObject(provider_);
}
DWORD ControllerAttestationKey::OpenInstalled(const wchar_t* controller_sid) noexcept {
  if (attempted_) { failed_ = true; return ERROR_INVALID_STATE; }
  attempted_ = true;
  PSID sid = nullptr;
  if (!controller_sid || !ConvertStringSidToSidW(controller_sid, &sid)) { failed_ = true; return ERROR_INVALID_SID; }
  const auto copied = CopySid(static_cast<DWORD>(controller_sid_.size()), controller_sid_.data(), sid);
  LocalFree(sid);
  if (!copied || NCryptOpenStorageProvider(&provider_, MS_KEY_STORAGE_PROVIDER, 0) ||
      NCryptOpenKey(provider_, &key_, kControllerAttestationKeyName, 0, NCRYPT_MACHINE_KEY_FLAG | NCRYPT_SILENT_FLAG)) {
    failed_ = true; return ERROR_ACCESS_DENIED;
  }
  ControllerPublicPoint point{};
  auto error = ReadControllerAttestationPublicPoint(key_, &point, &fingerprint_);
  if (!error && BCryptGenRandom(nullptr, instance_.data(), static_cast<ULONG>(instance_.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    error = ERROR_GEN_FAILURE;
  if (!error) error = Verify();
  if (error) failed_ = true;
  return error;
}
DWORD ControllerAttestationKey::Verify() noexcept {
  if (failed_ || !key_ || !Nonzero(instance_)) return ERROR_INVALID_STATE;
  ControllerPublicPoint point{}; ControllerDigest digest{};
  auto error = ReadControllerAttestationPublicPoint(key_, &point, &digest);
  DWORD flags = 0, size = 0;
  if (!error && (digest != fingerprint_ ||
      NCryptGetProperty(key_, NCRYPT_KEY_TYPE_PROPERTY, reinterpret_cast<PBYTE>(&flags), sizeof(flags), &size, 0) ||
      size != sizeof(flags) || flags != NCRYPT_MACHINE_KEY_FLAG)) error = ERROR_ACCESS_DENIED;
  std::array<std::uint8_t, 4096> security{};
  if (!error && (NCryptGetProperty(key_, NCRYPT_SECURITY_DESCR_PROPERTY, security.data(),
      static_cast<DWORD>(security.size()), &size, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION) ||
      !size || size > security.size() || !IsValidSecurityDescriptor(security.data()))) error = ERROR_ACCESS_DENIED;
  if (!error) {
    PSID owner = nullptr; BOOL defaulted = FALSE, present = FALSE;
    PACL acl = nullptr; SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
    std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> system{}; DWORD system_size = static_cast<DWORD>(system.size());
    if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system.data(), &system_size) ||
        !GetSecurityDescriptorOwner(security.data(), &owner, &defaulted) || defaulted || !owner || !EqualSid(owner, system.data()) ||
        !GetSecurityDescriptorControl(security.data(), &control, &revision) || !(control & SE_DACL_PROTECTED) ||
        !GetSecurityDescriptorDacl(security.data(), &present, &acl, &defaulted) || !present || defaulted || !acl ||
        !IsValidAcl(acl) || acl->AceCount != 2) error = ERROR_ACCESS_DENIED;
    bool has_system = false, has_controller = false;
    for (DWORD index = 0; !error && index < 2; ++index) {
      void* raw = nullptr;
      if (!GetAce(acl, index, &raw)) { error = ERROR_ACCESS_DENIED; break; }
      auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags ||
          (ace->Mask != GENERIC_ALL && ace->Mask != FILE_ALL_ACCESS) || !IsValidSid(&ace->SidStart)) { error = ERROR_ACCESS_DENIED; break; }
      if (EqualSid(&ace->SidStart, system.data()) && !has_system) has_system = true;
      else if (EqualSid(&ace->SidStart, controller_sid_.data()) && !has_controller) has_controller = true;
      else error = ERROR_ACCESS_DENIED;
    }
    if (!has_system || !has_controller) error = ERROR_ACCESS_DENIED;
  }
  if (error) failed_ = true;
  return error;
}
DWORD DeriveControllerAttestationWindow(std::span<const std::uint8_t> capture, const ControllerDigest& references,
  std::array<ControllerDigest, 6>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  constexpr std::size_t maximum = 88 + 384 + 840 + 48 * 20000 + 64 * (8 + 352 + 424) + 1063 * 1000;
  if (capture.size() < 1312 || capture.size() > maximum || !Nonzero(references)) return ERROR_INVALID_DATA;
  try {
    // This is an encoder boundary, not an ingress validator or an admission
    // decision. The native capture owner has already checked the journal,
    // member identities, layout and writer exclusion before producing bytes.
    const std::vector<std::uint8_t> bytes(capture.begin(), capture.end());
    const auto u32 = [&](std::size_t offset) {
      std::uint32_t value = 0;
      for (unsigned i = 0; i < 4; ++i) value |= std::uint32_t(bytes[offset + i]) << (8 * i);
      return value;
    };
    const auto count = u32(12), host_size = u32(16);
    if (std::memcmp(bytes.data(), "GCPRESP1", 8) || u32(8) != 1 || u32(20) || !count || count > 64 ||
        host_size < 840 || host_size > 840 + 48 * 20000 || (host_size - 840) % 48 ||
        host_size > bytes.size() - 472 || std::memcmp(bytes.data() + 472, "GCCAP001", 8) ||
        !std::equal(bytes.begin() + 88, bytes.begin() + 472, bytes.begin() + 512)) return ERROR_INVALID_DATA;
    std::array<ControllerDigest, 6> result{};
    std::copy_n(bytes.begin() + 480, 32, result[0].begin());
    std::copy_n(bytes.begin() + 24, 32, result[1].begin());
    std::copy_n(bytes.begin() + 56, 32, result[2].begin());
    if (!Nonzero(result[0]) || !Nonzero(result[1]) || !Nonzero(result[2])) return ERROR_INVALID_DATA;
    constexpr char domain[] = "goatcitadel.native-capacity-capture.v1";
    std::vector<std::uint8_t> host(sizeof(domain) + host_size);
    std::memcpy(host.data(), domain, sizeof(domain));
    std::copy_n(bytes.begin() + 472, host_size, host.begin() + sizeof(domain));
    auto error = Hash(host.data(), static_cast<ULONG>(host.size()), &result[3]);
    if (error) return error;
    // Match canonicalJsonString: sorted object keys, ordered arrays, lowercase
    // fixed hex. Only bounded native byte strings enter this JSON encoding.
    std::string members = "[";
    const auto hex = [&](std::size_t start, std::size_t size) {
      constexpr char digits[] = "0123456789abcdef";
      members += '"';
      for (std::size_t i = start; i < start + size; ++i) {
        members += digits[bytes[i] >> 4]; members += digits[bytes[i] & 15];
      }
      members += '"';
    };
    std::size_t position = 472 + host_size, chunks = 0;
    for (std::size_t index = 0; index < count; ++index) {
      if (bytes.size() - position < 8) return ERROR_INVALID_DATA;
      const auto ordinal = u32(position), chunk_count = u32(position + 4); position += 8;
      if (ordinal != index || !chunk_count || chunk_count > 1063 - chunks ||
          776 + std::size_t(chunk_count) * 1000 > bytes.size() - position) return ERROR_INVALID_DATA;
      chunks += chunk_count;
      if (index) members += ',';
      members += "{\"backingObservationHex\":"; hex(position + 352, 424);
      members += ",\"guestChunkHex\":[";
      for (std::size_t chunk = 0; chunk < chunk_count; ++chunk) {
        if (chunk) members += ',';
        hex(position + 776 + chunk * 1000, 1000);
      }
      members += "],\"guestObservationHex\":"; hex(position, 352); members += '}';
      position += 776 + std::size_t(chunk_count) * 1000;
    }
    if (position != bytes.size()) return ERROR_INVALID_DATA;
    members += ']';
    error = Hash(reinterpret_cast<const std::uint8_t*>(members.data()), static_cast<ULONG>(members.size()), &result[4]);
    if (error) return error;
    result[5] = references; *output = result;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ReadControllerAttestationPublicPoint(NCRYPT_KEY_HANDLE key, ControllerPublicPoint* point, ControllerDigest* fingerprint) noexcept {
  if (!point || !fingerprint) return ERROR_INVALID_PARAMETER;
  *point = {}; *fingerprint = {};
  if (!key) return ERROR_INVALID_HANDLE;
  DWORD policy = 0, usage = 0, count = 0;
  if (NCryptGetProperty(key, NCRYPT_EXPORT_POLICY_PROPERTY, reinterpret_cast<PBYTE>(&policy), sizeof(policy), &count, 0) ||
      count != sizeof(policy) || policy != 0 ||
      NCryptGetProperty(key, NCRYPT_KEY_USAGE_PROPERTY, reinterpret_cast<PBYTE>(&usage), sizeof(usage), &count, 0) ||
      count != sizeof(usage) || usage != NCRYPT_ALLOW_SIGNING_FLAG) return ERROR_ACCESS_DENIED;
  std::array<std::uint8_t, sizeof(BCRYPT_ECCKEY_BLOB) + 64> blob{};
  if (NCryptExportKey(key, 0, BCRYPT_ECCPUBLIC_BLOB, nullptr, blob.data(), static_cast<DWORD>(blob.size()), &count, 0) ||
      count != blob.size()) return ERROR_INVALID_DATA;
  BCRYPT_ECCKEY_BLOB header{}; std::memcpy(&header, blob.data(), sizeof(header));
  if (header.dwMagic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC || header.cbKey != 32) return ERROR_INVALID_DATA;
  ControllerPublicPoint candidate{}; candidate[0] = 4;
  std::copy_n(blob.begin() + sizeof(header), 64, candidate.begin() + 1);
  constexpr char domain[] = "goatcitadel.controller-attestation-key.v1";
  std::array<std::uint8_t, sizeof(domain) + 65> bytes{};
  std::memcpy(bytes.data(), domain, sizeof(domain));
  std::copy(candidate.begin(), candidate.end(), bytes.begin() + sizeof(domain));
  ControllerDigest digest{};
  const auto error = Hash(bytes.data(), static_cast<ULONG>(bytes.size()), &digest);
  if (!error) { *point = candidate; *fingerprint = digest; }
  return error;
}
bool EncodeControllerAttestation(const ControllerAttestationState& state, const ControllerDigest& challenge,
  std::uint32_t ordinal, ControllerStatement* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!ordinal || ordinal > 65536 || !Nonzero(challenge) || !Nonzero(state.key_sha256) || !Nonzero(state.instance) ||
      !Nonzero(state.authority) || !Nonzero(state.installation_nonce) || !Nonzero(state.request_sha256) ||
      std::any_of(state.window.begin(), state.window.end(), [](const auto& value) { return !Nonzero(value); })) return false;
  ControllerStatement bytes{}; std::memcpy(bytes.data(), "GCCATT01", 8);
  for (unsigned i = 0; i < 4; ++i) bytes[8 + i] = static_cast<std::uint8_t>(ordinal >> (i * 8));
  const ControllerDigest* digests[] = {&state.key_sha256, &state.instance, &state.authority, &challenge,
    &state.installation_nonce, &state.request_sha256, &state.window[0], &state.window[1], &state.window[2],
    &state.window[3], &state.window[4], &state.window[5]};
  for (unsigned i = 0; i < 12; ++i) std::copy(digests[i]->begin(), digests[i]->end(), bytes.begin() + 12 + i * 32);
  *output = bytes; return true;
}
DWORD CellControllerAttestationSigner::Check() noexcept {
  if (failed_ || !guard_.check || !guard_.stop || !guard_.deadline) return ERROR_INVALID_STATE;
  if (WaitForSingleObject(guard_.stop, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
  if (GetTickCount64() >= guard_.deadline) return ERROR_TIMEOUT;
  auto error = guard_.check(guard_.context);
  if (!error && failed_) error = ERROR_INVALID_STATE;
  ControllerPublicPoint point{}; ControllerDigest fingerprint{};
  if (!error) error = ReadControllerAttestationPublicPoint(key_, &point, &fingerprint);
  if (!error && fingerprint != state_.key_sha256) error = ERROR_INVALID_DATA;
  if (!error && WaitForSingleObject(guard_.stop, 0) != WAIT_TIMEOUT) error = ERROR_OPERATION_ABORTED;
  if (!error && GetTickCount64() >= guard_.deadline) error = ERROR_TIMEOUT;
  return error;
}
DWORD CellControllerAttestationSigner::Sign(const ControllerDigest& challenge, std::uint32_t ordinal,
  ControllerStatement* output, ControllerSignature* signature) noexcept {
  if (output) *output = {};
  if (signature) *signature = {};
  if (!output || !signature || failed_ || active_ || ordinal_ >= 65536 || ordinal != ordinal_ + 1) {
    failed_ = true; return ERROR_INVALID_STATE;
  }
  active_ = true;
  ControllerStatement bytes{}; ControllerSignature candidate{}; ControllerDigest digest{};
  DWORD count = 0;
  auto error = EncodeControllerAttestation(state_, challenge, ordinal, &bytes) ? Check() : ERROR_INVALID_DATA;
  if (!error) error = Hash(bytes.data(), static_cast<ULONG>(bytes.size()), &digest);
  if (!error && (NCryptSignHash(key_, nullptr, digest.data(), 32, candidate.data(), 64, &count, 0) || count != 64)) error = ERROR_INVALID_DATA;
  if (!error) error = Check();
  active_ = false;
  if (error) { failed_ = true; return error; }
  ordinal_ = ordinal; *output = bytes; *signature = candidate;
  return ERROR_SUCCESS;
}
}
