#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "key_custody.hpp"
#include "local_transport.hpp"
#include "operation_journal.hpp"
#include "protected_filesystem.hpp"
#include "protocol.hpp"

namespace goatcitadel::remote_worker_provisioner {

constexpr std::size_t kStateHeaderBytes = 224U;
constexpr std::size_t kGenerationEntryBytes = 448U;
constexpr std::size_t kOperationEntryBytes = 64U;
constexpr std::size_t kResidueEntryBytes = 84U;
constexpr std::uint32_t kMaximumOperationIds = 256U;
constexpr std::uint32_t kMaximumBurnedGenerations = 16U;
constexpr std::uint32_t kMaximumResidues = 256U;

struct ProtectedGenerationProjection final {
  bool present = false;
  std::array<std::uint8_t, kGenerationEntryBytes> bytes{};
};

struct ProtectedOperationProjection final {
  bool present = false;
  std::array<std::uint8_t, kOperationEntryBytes> bytes{};
};

struct ProtectedResidueProjection final {
  bool present = false;
  std::array<std::uint8_t, kResidueEntryBytes> bytes{};
};

struct ProtectedOperationReplayState final {
  bool present = false;
  bool quarantined = false;
  std::uint8_t opcode = 0U;
  Byte16 operation_id{};
  std::uint16_t operator_sid_length = 0U;
  std::array<std::uint8_t, 68U> operator_sid{};
  std::uint16_t body_length = 0U;
  std::array<std::uint8_t, 100U> body{};
  Byte32 stable_binding{};
  std::uint32_t attempt_count = 0U;
  std::uint32_t next_sequence = 0U;
  std::uint32_t result_length = 0U;
  std::array<std::uint8_t, kCreateKeysetResultBytes> result{};
  ProtectedPath operation_path{};
  JournalRecord prepared{};
  JournalRecord prior{};
};

struct ProtectedOperationsState final {
  ProtectedFilesystemState filesystem{};
  Byte32 state_sha256{};
  std::uint64_t active_generation = 0U;
  std::uint64_t highest_burned_generation = 0U;
  std::uint64_t highest_committed_generation = 0U;
  std::uint32_t committed_generation_count = 0U;
  std::uint32_t burned_generation_count = 0U;
  std::uint32_t operation_id_count = 0U;
  std::uint32_t quarantined_operation_count = 0U;
  std::uint32_t residue_count = 0U;
  std::uint16_t next_publication_sequence = 1U;
  Byte32 active_receipt_sha256{};
  Byte32 runtime_manifest_spki_sha256{};
  Byte32 admission_evidence_spki_sha256{};
  std::array<std::uint8_t, 44U> runtime_manifest_spki{};
  std::array<std::uint8_t, 44U> admission_evidence_spki{};
  Byte16 active_create_operation_id{};
  Byte32 active_create_stable_binding{};
  ProtectedObjectIdentity active_keyset_directory_identity{};
  std::array<ProtectedObjectIdentity, 5U> active_keyset_file_identities{};
  std::array<Byte32, 4U> active_keyset_file_hashes{};
  std::uint64_t active_predecessor_generation = 0U;
  bool active_revoked = false;
  ProtectedOperationReplayState create_replay{};
  ProtectedOperationReplayState revoke_replay{};
  std::array<ProtectedGenerationProjection, kMaximumBurnedGenerations>
      generations{};
  std::array<ProtectedOperationProjection, kMaximumOperationIds> operations{};
  std::array<ProtectedResidueProjection, kMaximumResidues> residues{};
  std::array<HistoricalCustodyKey, kMaximumHistoricalCustodyKeys>
      historical_keys{};
  std::uint32_t historical_key_count = 0U;
  bool ready = false;
};

enum class ProtectedOperationResult : std::uint32_t {
  Success = 0U,
  ProtocolInvalid = 1U,
  CustodyOrJournal = 9U,
};

bool InitializeProtectedOperations(
    const wchar_t* extended_volume_root,
    std::size_t extended_volume_root_length,
    ProtectedOperationsState* state,
    std::uint64_t recovery_deadline_ms = 0U,
    HANDLE recovery_stop_event = nullptr) noexcept;
void CloseProtectedOperations(ProtectedOperationsState* state) noexcept;
bool BuildProtectedInspect(
    const ProtectedOperationsState& state,
    std::uint16_t pe_machine,
    std::array<std::uint8_t, kProtectedInspectPayloadBytes>* output) noexcept;
ProtectedOperationResult ExecuteProtectedOperation(
    ProtectedOperationsState* state,
    std::uint8_t opcode,
    const std::uint8_t* body,
    std::uint32_t body_length,
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const Byte32& authenticated_binding,
    std::uint64_t deadline_ms,
    HANDLE stop_event,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* result,
    std::uint32_t* result_length) noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING)
constexpr std::size_t kMaximumStateProjectionBytesForTest = 45280U;
bool InitializeEmptyProtectedOperationsForTest(
    const std::array<std::uint8_t, kStateHeaderBytes>& state_header,
    ProtectedOperationsState* state) noexcept;
bool CalculateProtectedStateForTest(
    const ProtectedOperationsState& state,
    const ProtectedGenerationProjection* generation,
    const ProtectedOperationProjection* operation,
    const ProtectedResidueProjection* residue,
    std::array<std::uint8_t, kMaximumStateProjectionBytesForTest>* projection,
    std::size_t* projection_length,
    Byte32* digest) noexcept;

enum class ProtectedRecoveryTestOpcode : std::uint8_t {
  Create = 1U,
  Revoke = 2U,
};

enum class ProtectedRecoveryTestPhase : std::uint8_t {
  PreparedOnly = 1U,
  Attempted = 2U,
  OutcomeOnly = 3U,
  Terminal = 4U,
};

enum class ProtectedRecoveryTestEffect : std::uint8_t {
  Absent = 1U,
  CreateEmpty = 2U,
  BoundedPartialPending = 3U,
  ExactPending = 4U,
  ExactFinal = 5U,
  FinalResidueSourceAbsent = 6U,
  InvalidOrConflicting = 7U,
};

enum class ProtectedRecoveryTestAction : std::uint8_t {
  StableTerminal = 1U,
  RejectPreserve = 2U,
  EnsureEmptyCreateThenEntropy = 3U,
  AppendAttemptThenEntropy = 4U,
  AppendAttemptThenQuarantineReason1 = 5U,
  AppendAttemptThenPromoteAndFinish = 6U,
  AppendAttemptThenFinishFinal = 7U,
  MoveRevokeResidueThenRegenerate = 8U,
  AppendAttemptThenRegenerateRevoke = 9U,
  AppendAttemptThenCommitExistingOutcome = 10U,
};

enum class ProtectedRecoveryPublicationKindForTest : std::uint8_t {
  Prepared = 1U,
  AttemptInitial = 2U,
  AttemptRecovery = 3U,
  AttemptReplay = 4U,
  Outcome = 5U,
  Committed = 6U,
  Quarantined = 7U,
  BootstrapResidue = 8U,
  JournalResidue = 9U,
  RevokeResidue = 10U,
};

struct ProtectedRecoveryPublicationForTest final {
  ProtectedRecoveryPublicationKindForTest kind =
      ProtectedRecoveryPublicationKindForTest::Prepared;
  std::uint8_t opcode = 0U;
  std::uint8_t residue_ordinal = 0U;
  bool record_present = false;
  Byte16 operation_id{};
  JournalRecord record{};
  ProtectedResidueProjection residue{};
  ProtectedOperationProjection bootstrap_operation{};
};

struct ProtectedRecoveryOperationEvidenceForTest final {
  bool present = false;
  bool physical_effect_applied = false;
  Byte16 operation_id{};
  std::uint8_t opcode = 0U;
  std::uint8_t lifecycle = 0U;
  std::uint8_t physical_effect = 0U;
  std::uint16_t effect_authorizer_sequence = 0U;
  std::uint32_t attempt_count = 0U;
};

struct ProtectedRecoveryEvidenceForTest final {
  std::uint32_t source_read_count = 0U;
  std::uint32_t residue_payload_read_count = 0U;
  std::uint32_t source_mutation_count = 0U;
  std::uint32_t phase_b_revalidation_count = 0U;
  std::uint32_t phase_b_mutation_count = 0U;
  std::uint32_t canonical_replay_count = 0U;
  std::size_t publication_count = 0U;
  std::size_t operation_count = 0U;
  std::uint16_t next_publication_sequence = 1U;
  bool active_operation_present = false;
  bool nonterminal_present = false;
  Byte32 canonical_state_sha256{};
  Byte32 physical_snapshot_sha256{};
  std::array<ProtectedRecoveryOperationEvidenceForTest, kMaximumOperationIds>
      operations{};
};

bool SelectProtectedRecoveryActionForTest(
    ProtectedRecoveryTestOpcode opcode,
    ProtectedRecoveryTestPhase phase,
    ProtectedRecoveryTestEffect effect,
    std::uint32_t attempt_count,
    ProtectedRecoveryTestAction* action) noexcept;
bool ValidateProtectedPublicationInventoryForTest(
    const std::uint16_t* publication_sequences,
    std::size_t publication_count,
    std::uint16_t* next_publication_sequence) noexcept;
bool ValidateProtectedResidueBindingForTest(
    const wchar_t* component,
    std::size_t component_length,
    const ProtectedResidueProjection& projection) noexcept;
bool ValidateProtectedRecoveryPublicationsForTest(
    const ProtectedRecoveryPublicationForTest* publications,
    std::size_t publication_count) noexcept;
void ResetProtectedRecoveryEvidenceForTest() noexcept;
const ProtectedRecoveryEvidenceForTest*
ProtectedRecoveryEvidenceViewForTest() noexcept;
using ProtectedRecoveryPhaseBHookForTest = void (*)() noexcept;
void SetProtectedRecoveryPhaseBHookForTest(
    ProtectedRecoveryPhaseBHookForTest hook) noexcept;
void SetProtectedRecoveryDuplicateFailureForTest(
    std::uint32_t fail_on_call) noexcept;
std::uint32_t ProtectedRecoveryDuplicateCallCountForTest() noexcept;
std::uint32_t ProtectedPreparedPublicationStageForTest() noexcept;
std::uint32_t ProtectedPreparedPublicationErrorForTest() noexcept;
void SetProtectedDirectoryMoveFailureForTest(
    std::uint32_t fail_after_stage) noexcept;
std::uint32_t ProtectedDirectoryMoveStageForTest() noexcept;
std::uint32_t ProtectedDirectoryMoveErrorForTest() noexcept;
void SetProtectedJournalPublicationFailureForTest(
    std::uint32_t fail_on_ordinary_call,
    std::uint32_t fail_after_stage) noexcept;
std::uint32_t ProtectedJournalPublicationStageForTest() noexcept;
std::uint32_t ProtectedJournalPublicationErrorForTest() noexcept;
std::uint32_t ProtectedJournalPublicationOrdinaryCallCountForTest() noexcept;
void SetProtectedRevokeControlFailureForTest(
    std::uint32_t fail_after_stage) noexcept;
std::uint32_t ProtectedRevokeControlStageForTest() noexcept;
std::uint32_t ProtectedRevokeControlErrorForTest() noexcept;
std::uint32_t ProtectedRevokeComputeCountForTest() noexcept;
std::uint32_t ProtectedCreateRecoveryStageForTest() noexcept;
std::uint32_t ProtectedCreateRecoveryCallCountForTest() noexcept;
std::uint32_t ProtectedCreateRecoveryLastModeForTest() noexcept;
std::uint32_t ProtectedRevokeRecoveryStageForTest() noexcept;
std::uint32_t ProtectedPhaseBNonterminalRevalidationStageForTest() noexcept;
bool MoveProtectedDirectoryToQuarantineForTest(
    ProtectedOperationsState* state,
    const wchar_t* source_component,
    const wchar_t* final_component) noexcept;
bool DuplicateProtectedRecoveryFilesystemForTest(
    const ProtectedFilesystemState& source,
    ProtectedFilesystemState* destination) noexcept;
void CloseProtectedRecoveryFilesystemForTest(
    ProtectedFilesystemState* filesystem) noexcept;
#endif

}  // namespace goatcitadel::remote_worker_provisioner
