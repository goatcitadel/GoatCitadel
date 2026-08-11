#include "key_custody.hpp"

#include <windows.h>
#include <bcrypt.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {
namespace {

#if defined(GOATCITADEL_PROVISIONER_TESTING)
std::array<std::uint8_t, 32U> g_first_entropy{};
std::array<std::uint8_t, 32U> g_second_entropy{};
bool g_first_entropy_succeeds = true;
bool g_second_entropy_succeeds = true;
bool g_entropy_override = false;
std::uint32_t g_entropy_calls = 0U;
#endif

bool Equal(const std::uint8_t* left, const std::uint8_t* right, std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) return false;
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    difference = static_cast<std::uint8_t>(difference | (left[index] ^ right[index]));
  }
  return difference == 0U;
}

bool Entropy(std::array<std::uint8_t, 32U>* output, bool first) noexcept {
  if (output == nullptr) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  ++g_entropy_calls;
  if (g_entropy_override) {
    const bool succeeds = first ? g_first_entropy_succeeds : g_second_entropy_succeeds;
    if (!succeeds) return false;
    *output = first ? g_first_entropy : g_second_entropy;
    return true;
  }
#else
  (void)first;
#endif
  return BCryptGenRandom(
             nullptr,
             output->data(),
             static_cast<ULONG>(output->size()),
             BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
}

}  // namespace

__declspec(noinline) void WipeCustodyOwned(
    void* bytes,
    std::size_t size) noexcept {
  if (bytes != nullptr && size != 0U) SecureZeroMemory(bytes, size);
}

CustodyGenerationResult GenerateCustodyKeyset(
    const HistoricalCustodyKey* historical_keys,
    std::size_t historical_key_count,
    CustodyKeysetMaterial* output) noexcept {
  if (output == nullptr) return CustodyGenerationResult::EntropyOrDerivationFailure;
  WipeCustodyOwned(output, sizeof(*output));
  if ((historical_keys == nullptr && historical_key_count != 0U) ||
      historical_key_count > kMaximumHistoricalCustodyKeys) {
    return CustodyGenerationResult::EntropyOrDerivationFailure;
  }
  std::array<std::uint8_t, 32U> runtime_seed{};
  std::array<std::uint8_t, 32U> evidence_seed{};
  CustodyKeysetMaterial candidate{};
  CustodyGenerationResult result = CustodyGenerationResult::EntropyOrDerivationFailure;
  if (!Entropy(&runtime_seed, true) || !Entropy(&evidence_seed, false)) {
    goto cleanup;
  }
  if (Equal(runtime_seed.data(), evidence_seed.data(), runtime_seed.size())) {
    result = CustodyGenerationResult::Duplicate;
    goto cleanup;
  }
  if (!DeriveEd25519KeyMaterial(
          runtime_seed.data(), runtime_seed.size(), &candidate.runtime_manifest) ||
      !DeriveEd25519KeyMaterial(
          evidence_seed.data(), evidence_seed.size(), &candidate.admission_evidence) ||
      !ComputeSha256(
          candidate.runtime_manifest.spki.data(),
          candidate.runtime_manifest.spki.size(),
          &candidate.runtime_manifest_key_id) ||
      !ComputeSha256(
          candidate.admission_evidence.spki.data(),
          candidate.admission_evidence.spki.size(),
          &candidate.admission_evidence_key_id)) {
    goto cleanup;
  }
  if (Equal(
          candidate.runtime_manifest.spki.data(),
          candidate.admission_evidence.spki.data(),
          candidate.runtime_manifest.spki.size()) ||
      Equal(
          candidate.runtime_manifest_key_id.data(),
          candidate.admission_evidence_key_id.data(),
          candidate.runtime_manifest_key_id.size())) {
    result = CustodyGenerationResult::Duplicate;
    goto cleanup;
  }
  for (std::size_t index = 0U; index < historical_key_count; ++index) {
    if (Equal(
            candidate.runtime_manifest.spki.data(),
            historical_keys[index].spki.data(),
            candidate.runtime_manifest.spki.size()) ||
        Equal(
            candidate.admission_evidence.spki.data(),
            historical_keys[index].spki.data(),
            candidate.admission_evidence.spki.size()) ||
        Equal(
            candidate.runtime_manifest_key_id.data(),
            historical_keys[index].key_id.data(),
            candidate.runtime_manifest_key_id.size()) ||
        Equal(
            candidate.admission_evidence_key_id.data(),
            historical_keys[index].key_id.data(),
            candidate.admission_evidence_key_id.size())) {
      result = CustodyGenerationResult::Duplicate;
      goto cleanup;
    }
  }
  *output = candidate;
  result = CustodyGenerationResult::Success;

cleanup:
  WipeCustodyOwned(runtime_seed.data(), runtime_seed.size());
  WipeCustodyOwned(evidence_seed.data(), evidence_seed.size());
  WipeCustodyOwned(&candidate, sizeof(candidate));
  if (result != CustodyGenerationResult::Success) {
    WipeCustodyOwned(output, sizeof(*output));
  }
  return result;
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)
void SetCustodyEntropyForTest(
    const std::array<std::uint8_t, 32U>& first,
    const std::array<std::uint8_t, 32U>& second,
    bool first_succeeds,
    bool second_succeeds) noexcept {
  g_first_entropy = first;
  g_second_entropy = second;
  g_first_entropy_succeeds = first_succeeds;
  g_second_entropy_succeeds = second_succeeds;
  g_entropy_override = true;
  g_entropy_calls = 0U;
}

void ResetCustodyEntropyForTest() noexcept {
  WipeCustodyOwned(g_first_entropy.data(), g_first_entropy.size());
  WipeCustodyOwned(g_second_entropy.data(), g_second_entropy.size());
  g_first_entropy_succeeds = true;
  g_second_entropy_succeeds = true;
  g_entropy_override = false;
  g_entropy_calls = 0U;
}

std::uint32_t CustodyEntropyCallCountForTest() noexcept {
  return g_entropy_calls;
}
#endif

}  // namespace goatcitadel::remote_worker_provisioner
