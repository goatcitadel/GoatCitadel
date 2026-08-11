#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "ed25519_runtime.hpp"
#include "local_transport.hpp"

namespace goatcitadel::remote_worker_provisioner {

constexpr std::size_t kMaximumHistoricalCustodyKeys = 64U;

struct HistoricalCustodyKey final {
  std::array<std::uint8_t, 44U> spki{};
  Byte32 key_id{};
};

struct CustodyKeysetMaterial final {
  Ed25519DerivedKeyMaterial runtime_manifest{};
  Ed25519DerivedKeyMaterial admission_evidence{};
  Byte32 runtime_manifest_key_id{};
  Byte32 admission_evidence_key_id{};
};

enum class CustodyGenerationResult : std::uint32_t {
  Success = 0U,
  EntropyOrDerivationFailure = 1U,
  Duplicate = 2U,
};

__declspec(noinline) void WipeCustodyOwned(
    void* bytes,
    std::size_t size) noexcept;

CustodyGenerationResult GenerateCustodyKeyset(
    const HistoricalCustodyKey* historical_keys,
    std::size_t historical_key_count,
    CustodyKeysetMaterial* output) noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING)
void SetCustodyEntropyForTest(
    const std::array<std::uint8_t, 32U>& first,
    const std::array<std::uint8_t, 32U>& second,
    bool first_succeeds,
    bool second_succeeds) noexcept;
void ResetCustodyEntropyForTest() noexcept;
std::uint32_t CustodyEntropyCallCountForTest() noexcept;
#endif

}  // namespace goatcitadel::remote_worker_provisioner
