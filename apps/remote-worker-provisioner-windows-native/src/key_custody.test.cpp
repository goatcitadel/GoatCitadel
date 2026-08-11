#include "key_custody.hpp"

#if defined(GOATCITADEL_PROVISIONER_TESTING)

#include <array>
#include <cstddef>
#include <cstdint>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {
bool AllZero(const void* bytes, std::size_t size) noexcept {
  if (bytes == nullptr) return false;
  const auto* current = static_cast<const std::uint8_t*>(bytes);
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | current[index]);
  }
  return aggregate == 0U;
}
}  // namespace

int RunKeyCustodyTests() noexcept {
  int failures = 0;
  std::array<std::uint8_t, 32U> first{};
  std::array<std::uint8_t, 32U> second{};
  first[0] = 1U;
  second[0] = 2U;
  gc::CustodyKeysetMaterial material{};
  gc::SetCustodyEntropyForTest(first, second, false, true);
  material.runtime_manifest.pkcs8.fill(0xa5U);
  if (gc::GenerateCustodyKeyset(nullptr, 0U, &material) !=
          gc::CustodyGenerationResult::EntropyOrDerivationFailure ||
      gc::CustodyEntropyCallCountForTest() != 1U ||
      !AllZero(&material, sizeof(material))) ++failures;
  gc::SetCustodyEntropyForTest(first, second, true, false);
  material.runtime_manifest.pkcs8.fill(0xa5U);
  if (gc::GenerateCustodyKeyset(nullptr, 0U, &material) !=
          gc::CustodyGenerationResult::EntropyOrDerivationFailure ||
      gc::CustodyEntropyCallCountForTest() != 2U ||
      !AllZero(&material, sizeof(material))) ++failures;

  std::array<std::uint8_t, 32U> zero{};
  gc::SetCustodyEntropyForTest(zero, second, true, true);
  if (gc::GenerateCustodyKeyset(nullptr, 0U, &material) !=
          gc::CustodyGenerationResult::EntropyOrDerivationFailure ||
      gc::CustodyEntropyCallCountForTest() != 2U ||
      !AllZero(&material, sizeof(material))) ++failures;

  gc::SetCustodyEntropyForTest(first, first, true, true);
  if (gc::GenerateCustodyKeyset(nullptr, 0U, &material) !=
          gc::CustodyGenerationResult::Duplicate ||
      gc::CustodyEntropyCallCountForTest() != 2U ||
      !AllZero(&material, sizeof(material))) ++failures;

  gc::SetCustodyEntropyForTest(first, second, true, true);
  if (gc::GenerateCustodyKeyset(nullptr, 0U, &material) !=
          gc::CustodyGenerationResult::Success ||
      gc::CustodyEntropyCallCountForTest() != 2U ||
      AllZero(&material, sizeof(material))) ++failures;
  const gc::CustodyKeysetMaterial canonical = material;

  std::array<gc::HistoricalCustodyKey, 4U> historical{};
  historical[0].spki = canonical.runtime_manifest.spki;
  historical[1].spki = canonical.admission_evidence.spki;
  historical[2].key_id = canonical.runtime_manifest_key_id;
  historical[3].key_id = canonical.admission_evidence_key_id;
  for (std::size_t index = 0U; index < historical.size(); ++index) {
    gc::SetCustodyEntropyForTest(first, second, true, true);
    if (gc::GenerateCustodyKeyset(&historical[index], 1U, &material) !=
            gc::CustodyGenerationResult::Duplicate ||
        gc::CustodyEntropyCallCountForTest() != 2U ||
        !AllZero(&material, sizeof(material))) ++failures;
  }

  std::array<gc::HistoricalCustodyKey,
             gc::kMaximumHistoricalCustodyKeys> exact_cap{};
  gc::SetCustodyEntropyForTest(first, second, true, true);
  if (gc::GenerateCustodyKeyset(
          exact_cap.data(), exact_cap.size(), &material) !=
          gc::CustodyGenerationResult::Success ||
      gc::CustodyEntropyCallCountForTest() != 2U ||
      AllZero(&material, sizeof(material))) ++failures;
  gc::WipeCustodyOwned(&material, sizeof(material));
  exact_cap.back().key_id = canonical.admission_evidence_key_id;
  gc::SetCustodyEntropyForTest(first, second, true, true);
  if (gc::GenerateCustodyKeyset(
          exact_cap.data(), exact_cap.size(), &material) !=
          gc::CustodyGenerationResult::Duplicate ||
      gc::CustodyEntropyCallCountForTest() != 2U ||
      !AllZero(&material, sizeof(material))) ++failures;

  gc::SetCustodyEntropyForTest(first, second, true, true);
  if (gc::GenerateCustodyKeyset(nullptr, 1U, &material) !=
          gc::CustodyGenerationResult::EntropyOrDerivationFailure ||
      gc::CustodyEntropyCallCountForTest() != 0U ||
      !AllZero(&material, sizeof(material))) ++failures;
  std::array<gc::HistoricalCustodyKey, gc::kMaximumHistoricalCustodyKeys + 1U> over_cap{};
  gc::SetCustodyEntropyForTest(first, second, true, true);
  if (gc::GenerateCustodyKeyset(over_cap.data(), over_cap.size(), &material) !=
          gc::CustodyGenerationResult::EntropyOrDerivationFailure ||
      gc::CustodyEntropyCallCountForTest() != 0U ||
      !AllZero(&material, sizeof(material))) ++failures;

  std::array<std::uint8_t, 257U> wipe_probe{};
  wipe_probe.fill(0xa5U);
  gc::WipeCustodyOwned(wipe_probe.data(), wipe_probe.size());
  if (!AllZero(wipe_probe.data(), wipe_probe.size())) ++failures;
  gc::ResetCustodyEntropyForTest();
  if (gc::CustodyEntropyCallCountForTest() != 0U) ++failures;
  gc::WipeCustodyOwned(&material, sizeof(material));
  if (!AllZero(&material, sizeof(material))) ++failures;
  return failures;
}

#endif
