#include "protected_operations.hpp"

#include "key_custody.hpp"
#include "operation_journal.hpp"

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr char kStateDomain[] =
    "goatcitadel.remote-worker.provisioner.custody-state.v1";
constexpr char kAclDomain[] =
    "goatcitadel.remote-worker.provisioner.state-acl.v1";
constexpr char kPairDomain[] =
    "goatcitadel.remote-worker.provisioner.keyset-pair.v1";
constexpr char kReceiptDomain[] =
    "goatcitadel.remote-worker.provisioner.keyset-receipt.v1";
constexpr char kKeysetIdentityDomain[] =
    "goatcitadel.remote-worker.provisioner.keyset-identity.v1";
constexpr char kOperatorSidDomain[] =
    "goatcitadel.remote-worker.provisioner.operator-sid.v1";
constexpr char kControlDomain[] =
    "goatcitadel.remote-worker.provisioner.revoke-control.v1";
constexpr char kControlIdentityDomain[] =
    "goatcitadel.remote-worker.provisioner.revoke-identity.v1";
constexpr char kQuarantinedIdentityDomain[] =
    "goatcitadel.remote-worker.provisioner.quarantined-keyset-identity.v1";
constexpr char kCandidateClosureDomain[] =
    "goatcitadel.remote-worker.provisioner.keyset-candidate-closure.v1";
constexpr char kQuarantineClosureDomain[] =
    "goatcitadel.remote-worker.provisioner.quarantine-closure.v1";
constexpr char kRecoveryPhysicalSnapshotDomain[] =
    "goatcitadel.remote-worker.provisioner.recovery-physical-snapshot.v1";
constexpr std::size_t kMaximumJournalRecordsPerOperation =
    static_cast<std::size_t>(kMaximumJournalAttempts) + 3U;

void WriteU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xffU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}
void WriteU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (std::size_t index = 0U; index < 4U; ++index) bytes[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & 0xffU);
}
void WriteU64(std::uint8_t* bytes, std::uint64_t value) noexcept {
  for (std::size_t index = 0U; index < 8U; ++index) bytes[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & UINT64_C(0xff));
}
std::uint16_t ReadU16(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint16_t>(bytes[0]) |
         static_cast<std::uint16_t>(bytes[1] << 8U);
}
std::uint32_t ReadU32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0U;
  for (std::size_t index = 0U; index < 4U; ++index) {
    value |= static_cast<std::uint32_t>(bytes[index]) << (index * 8U);
  }
  return value;
}
std::uint64_t ReadU64(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    value |= static_cast<std::uint64_t>(bytes[index]) << (index * 8U);
  }
  return value;
}
bool Equal(const std::uint8_t* left, const std::uint8_t* right, std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) return false;
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) difference = static_cast<std::uint8_t>(difference | (left[index] ^ right[index]));
  return difference == 0U;
}
int CompareOrdinal(const std::uint8_t* left, const std::uint8_t* right, std::size_t length) noexcept {
  for (std::size_t index = 0U; index < length; ++index) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}
bool EqualWide(const wchar_t* left, std::size_t left_length, const wchar_t* right) noexcept {
  if (left == nullptr || right == nullptr) return false;
  std::size_t right_length = 0U;
  while (right[right_length] != L'\0') ++right_length;
  if (left_length != right_length) return false;
  for (std::size_t index = 0U; index < left_length; ++index) {
    if (left[index] != right[index]) return false;
  }
  return true;
}
int HexNibble(wchar_t value) noexcept {
  if (value >= L'0' && value <= L'9') return value - L'0';
  if (value >= L'a' && value <= L'f') return value - L'a' + 10;
  return -1;
}

struct RecoveredJournalOperation final {
  bool present = false;
  bool quarantined = false;
  bool committed = false;
  bool outcome_present = false;
  bool candidate_present = false;
  bool candidate_complete = false;
  Byte16 operation_id{};
  std::uint8_t opcode = 0U;
  std::uint32_t attempt_count = 0U;
  std::uint32_t next_sequence = 0U;
  std::uint16_t effect_authorizing_publication_sequence = 0U;
  ProtectedPath path{};
  JournalRecord prepared{};
  JournalRecord prior{};
  JournalRecord outcome{};
  std::uint32_t result_length = 0U;
  std::array<std::uint8_t, kCreateKeysetResultBytes> result{};
  std::uint32_t candidate_length = 0U;
  std::array<std::uint8_t, 256U> candidate_bytes{};
  ProtectedObjectIdentity candidate_identity{};
  Byte32 candidate_closure{};
};

enum class RecoveryPublicationEventKind : std::uint8_t {
  None = 0U,
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

struct RecoveryPublicationEvent final {
  RecoveryPublicationEventKind kind = RecoveryPublicationEventKind::None;
  std::uint8_t opcode = 0U;
  std::uint8_t residue_ordinal = 0U;
  bool record_present = false;
  Byte16 operation_id{};
  JournalRecord record{};
};

enum class RecoveryReplayLifecycle : std::uint8_t {
  Unseen = 0U,
  Bootstrap = 1U,
  Active = 2U,
  Committed = 3U,
  Quarantined = 4U,
};

enum class RecoveryEffectClass : std::uint8_t;
enum class RecoveryAction : std::uint8_t;

struct RecoveryReplayOperation final {
  bool present = false;
  bool outcome_seen = false;
  bool physical_effect_applied = false;
  bool candidate_present = false;
  Byte16 operation_id{};
  std::uint8_t opcode = 0U;
  std::uint8_t next_residue_ordinal = 0U;
  RecoveryReplayLifecycle lifecycle = RecoveryReplayLifecycle::Unseen;
  RecoveryEffectClass physical_effect = static_cast<RecoveryEffectClass>(0U);
  std::uint16_t latest_revoke_residue_sequence = 0U;
  std::uint16_t effect_authorizer_sequence = 0U;
  std::uint32_t attempt_count = 0U;
  std::size_t inventory_index = 0U;
  std::uint64_t candidate_length = 0U;
  ProtectedObjectIdentity candidate_identity{};
  Byte32 candidate_content_hash{};
  Byte32 candidate_closure{};
};

struct ProtectedRecoveryReplayOutput final {
  ProtectedOperationsState projection{};
  ProtectedOperationsState nonterminal_base_projection{};
  ProtectedOperationsState mutation_prepared_projection{};
  std::array<RecoveryReplayOperation, kMaximumOperationIds> operations{};
  std::size_t operation_count = 0U;
  bool active_operation_present = false;
  Byte16 active_operation_id{};
  bool nonterminal_present = false;
  bool nonterminal_base_present = false;
  bool mutation_prepared_present = false;
  std::size_t nonterminal_inventory_index = 0U;
  RecoveryAction nonterminal_action = static_cast<RecoveryAction>(0U);
  std::uint16_t next_publication_sequence = 1U;
  std::size_t keyset_entry_count = 0U;
  std::size_t control_entry_count = 0U;
  std::size_t quarantine_entry_count = 0U;
  Byte32 physical_snapshot_digest{};
};

constexpr std::size_t kRecoveryPhysicalOperationBytes = 144U;
constexpr std::size_t kRecoveryPhysicalSnapshotStateOffset = 0U;
constexpr std::size_t kRecoveryPhysicalSnapshotOperationCountOffset = 32U;
constexpr std::size_t kRecoveryPhysicalSnapshotKeysetCountOffset = 40U;
constexpr std::size_t kRecoveryPhysicalSnapshotControlCountOffset = 48U;
constexpr std::size_t kRecoveryPhysicalSnapshotQuarantineCountOffset = 56U;
constexpr std::size_t kRecoveryPhysicalSnapshotOperationHashOffset = 64U;
constexpr std::size_t kRecoveryPhysicalSnapshotBytes = 96U;
static_assert(
    kRecoveryPhysicalSnapshotStateOffset + Byte32{}.size() <=
    kRecoveryPhysicalSnapshotBytes);
static_assert(
    kRecoveryPhysicalSnapshotOperationCountOffset + sizeof(std::uint64_t) <=
    kRecoveryPhysicalSnapshotBytes);
static_assert(
    kRecoveryPhysicalSnapshotKeysetCountOffset + sizeof(std::uint64_t) <=
    kRecoveryPhysicalSnapshotBytes);
static_assert(
    kRecoveryPhysicalSnapshotControlCountOffset + sizeof(std::uint64_t) <=
    kRecoveryPhysicalSnapshotBytes);
static_assert(
    kRecoveryPhysicalSnapshotQuarantineCountOffset + sizeof(std::uint64_t) <=
    kRecoveryPhysicalSnapshotBytes);
static_assert(
    kRecoveryPhysicalSnapshotOperationHashOffset + Byte32{}.size() ==
    kRecoveryPhysicalSnapshotBytes);
static_assert(104U + Byte32{}.size() <= kRecoveryPhysicalOperationBytes);

struct PhaseAOperationInventory final {
  bool present = false;
  bool pending_operation_directory = false;
  bool quarantine_location = false;
  bool candidate_present = false;
  bool candidate_is_revoke = false;
  Byte16 operation_id{};
  ProtectedPath path{};
  ProtectedDirectoryEntry root_entry{};
  JournalRecord prepared{};
  ProtectedDirectoryEntry candidate_entry{};
  std::array<JournalRecord, kMaximumJournalRecordsPerOperation> records{};
  std::size_t record_count = 0U;
};

constexpr std::size_t kMaximumMoveRootFiles =
    kMaximumJournalRecordsPerOperation + 1U;
constexpr std::size_t kMaximumMoveNestedFiles = 5U;
constexpr std::size_t kMaximumMoveFileBytes = kJournalRecordBytes;

struct DirectoryMoveFileAuthority final {
  bool present = false;
  std::uint16_t name_length = 0U;
  std::array<wchar_t, 64U> name{};
  std::uint64_t byte_length = 0U;
  ProtectedObjectIdentity identity{};
  Byte32 content_hash{};
  std::array<std::uint8_t, kMaximumMoveFileBytes> bytes{};
};

struct DirectoryMoveAuthority final {
  bool present = false;
  ProtectedObjectIdentity root_identity{};
  std::size_t root_file_count = 0U;
  std::array<DirectoryMoveFileAuthority, kMaximumMoveRootFiles> root_files{};
  bool nested_directory_present = false;
  std::uint16_t nested_directory_name_length = 0U;
  std::array<wchar_t, 64U> nested_directory_name{};
  ProtectedObjectIdentity nested_directory_identity{};
  std::size_t nested_file_count = 0U;
  std::array<DirectoryMoveFileAuthority, kMaximumMoveNestedFiles> nested_files{};
};

struct ResidueMetadataInventory final {
  bool present = false;
  Byte16 operation_id{};
  std::uint8_t ordinal = 0U;
  std::uint8_t kind = 0U;
  std::uint16_t publication_sequence = 0U;
  std::uint64_t byte_length = 0U;
};

enum class RecoveryChainPhase : std::uint8_t {
  PreparedOnly = 1U,
  Attempted = 2U,
  OutcomeOnly = 3U,
  Terminal = 4U,
};

enum class RecoveryEffectClass : std::uint8_t {
  Absent = 1U,
  CreateEmpty = 2U,
  BoundedPartialPending = 3U,
  ExactPending = 4U,
  ExactFinal = 5U,
  FinalResidueSourceAbsent = 6U,
  InvalidOrConflicting = 7U,
};

enum class RecoveryAction : std::uint8_t {
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

bool SelectRecoveryAction(
    std::uint8_t opcode,
    RecoveryChainPhase phase,
    RecoveryEffectClass effect,
    std::uint32_t attempt_count,
    RecoveryAction* action) noexcept {
  const bool create =
      opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset);
  const bool revoke =
      opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset);
  const bool phase_valid =
      phase == RecoveryChainPhase::PreparedOnly ||
      phase == RecoveryChainPhase::Attempted ||
      phase == RecoveryChainPhase::OutcomeOnly ||
      phase == RecoveryChainPhase::Terminal;
  const bool effect_valid =
      effect == RecoveryEffectClass::Absent ||
      effect == RecoveryEffectClass::CreateEmpty ||
      effect == RecoveryEffectClass::BoundedPartialPending ||
      effect == RecoveryEffectClass::ExactPending ||
      effect == RecoveryEffectClass::ExactFinal ||
      effect == RecoveryEffectClass::FinalResidueSourceAbsent ||
      effect == RecoveryEffectClass::InvalidOrConflicting;
  if (action == nullptr || (!create && !revoke) || !phase_valid ||
      !effect_valid || attempt_count > kMaximumJournalAttempts ||
      ((phase == RecoveryChainPhase::PreparedOnly) != (attempt_count == 0U)) ||
      (create && effect == RecoveryEffectClass::FinalResidueSourceAbsent) ||
      (revoke && effect == RecoveryEffectClass::CreateEmpty)) return false;
  *action = RecoveryAction::RejectPreserve;
  if (phase == RecoveryChainPhase::Terminal) {
    *action = RecoveryAction::StableTerminal;
    return true;
  }
  if (attempt_count >= kMaximumJournalAttempts ||
      effect == RecoveryEffectClass::InvalidOrConflicting) return true;
  if (phase == RecoveryChainPhase::OutcomeOnly) {
    if (effect == RecoveryEffectClass::ExactFinal) {
      *action = RecoveryAction::AppendAttemptThenCommitExistingOutcome;
    }
    return true;
  }
  if (opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    if (attempt_count == 0U) {
      if (effect == RecoveryEffectClass::Absent) {
        *action = RecoveryAction::EnsureEmptyCreateThenEntropy;
      } else if (effect == RecoveryEffectClass::CreateEmpty) {
        *action = RecoveryAction::AppendAttemptThenEntropy;
      }
      return true;
    }
    if (effect == RecoveryEffectClass::CreateEmpty ||
        effect == RecoveryEffectClass::BoundedPartialPending) {
      *action = RecoveryAction::AppendAttemptThenQuarantineReason1;
    } else if (effect == RecoveryEffectClass::ExactPending) {
      *action = RecoveryAction::AppendAttemptThenPromoteAndFinish;
    } else if (effect == RecoveryEffectClass::ExactFinal) {
      *action = RecoveryAction::AppendAttemptThenFinishFinal;
    }
    return true;
  }
  if (opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    if (attempt_count == 0U) {
      if (effect == RecoveryEffectClass::Absent) {
        *action = RecoveryAction::AppendAttemptThenRegenerateRevoke;
      }
      return true;
    }
    if (effect == RecoveryEffectClass::Absent ||
        effect == RecoveryEffectClass::FinalResidueSourceAbsent) {
      *action = RecoveryAction::AppendAttemptThenRegenerateRevoke;
    } else if (effect == RecoveryEffectClass::BoundedPartialPending) {
      *action = RecoveryAction::MoveRevokeResidueThenRegenerate;
    } else if (effect == RecoveryEffectClass::ExactPending) {
      *action = RecoveryAction::AppendAttemptThenPromoteAndFinish;
    } else if (effect == RecoveryEffectClass::ExactFinal) {
      *action = RecoveryAction::AppendAttemptThenFinishFinal;
    }
    return true;
  }
  return false;
}

alignas(64) std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>
    g_recovery_entries{};
alignas(64) std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>
    g_root_scan_entries{};
alignas(64) std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>
    g_quarantine_scan_entries{};
alignas(64) std::array<ProtectedResidueProjection, kMaximumResidues>
    g_deferred_residues{};
alignas(64) std::array<ProtectedOperationProjection, kMaximumResidues>
    g_deferred_residue_operations{};
alignas(64) std::array<bool, kMaximumResidues>
    g_deferred_residue_committed{};
alignas(64) std::array<bool, kMaximumPublicationSequence + 1U>
    g_publication_sequences{};
alignas(64) std::array<RecoveryPublicationEvent, kMaximumPublicationSequence + 1U>
    g_publication_events{};
alignas(64) std::array<PhaseAOperationInventory, 33U>
    g_phase_a_operations{};
alignas(64) PhaseAOperationInventory g_relocated_phase_a_scratch{};
alignas(64) ProtectedRecoveryReplayOutput g_replay_first_scratch{};
alignas(64) ProtectedRecoveryReplayOutput g_replay_second_scratch{};
alignas(64) ProtectedRecoveryReplayOutput g_replay_phase_a_scratch{};
alignas(64) std::array<RecoveredJournalOperation, 33U>
    g_recovered_operations_scratch{};
alignas(64) std::array<bool, 33U> g_recovered_present_scratch{};
alignas(64) ProtectedOperationsState g_replay_state_scratch{};
alignas(64) std::array<
    std::uint8_t,
    kMaximumOperationIds * kRecoveryPhysicalOperationBytes>
    g_recovery_physical_projection_scratch{};
alignas(64) std::array<ResidueMetadataInventory, kMaximumResidues>
    g_residue_metadata_scratch{};
alignas(64) DirectoryMoveAuthority g_directory_move_authority_scratch{};

struct PhaseAReplayScratchGuard final {
  PhaseAReplayScratchGuard() noexcept = default;
  PhaseAReplayScratchGuard(const PhaseAReplayScratchGuard&) = delete;
  PhaseAReplayScratchGuard& operator=(const PhaseAReplayScratchGuard&) = delete;
  ~PhaseAReplayScratchGuard() noexcept {
    WipeCustodyOwned(
        &g_replay_phase_a_scratch, sizeof(g_replay_phase_a_scratch));
  }
};
std::size_t g_phase_a_operation_count = 0U;
alignas(64) std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>
    g_keyset_scan_entries{};
alignas(64) std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>
    g_control_scan_entries{};
std::size_t g_phase_a_keyset_count = 0U;
std::size_t g_phase_a_control_count = 0U;
constexpr std::size_t kMaximumStateProjectionBytes =
    kStateHeaderBytes +
    kMaximumBurnedGenerations * kGenerationEntryBytes +
    kMaximumOperationIds * kOperationEntryBytes +
    kMaximumResidues * kResidueEntryBytes;
constexpr std::size_t kMaximumStateHashInputBytes =
    sizeof(kStateDomain) + kMaximumStateProjectionBytes;
static_assert(kStateHeaderBytes == 224U);
static_assert(kGenerationEntryBytes == 448U);
static_assert(kOperationEntryBytes == 64U);
static_assert(kResidueEntryBytes == 84U);
static_assert(kMaximumStateProjectionBytes == 45280U);
static_assert(kMaximumStateHashInputBytes == 45335U);
alignas(64) std::array<ProtectedGenerationProjection, kMaximumBurnedGenerations>
    g_generation_projection_scratch{};
alignas(64) std::array<ProtectedOperationProjection, kMaximumOperationIds>
    g_operation_projection_scratch{};
alignas(64) std::array<ProtectedResidueProjection, kMaximumResidues>
    g_residue_projection_scratch{};
alignas(64) std::array<std::uint8_t, kMaximumStateHashInputBytes>
    g_state_hash_input{};
#if defined(GOATCITADEL_PROVISIONER_TESTING)
alignas(64) std::array<std::uint8_t, kMaximumStateProjectionBytes>
    g_test_state_projection{};
std::size_t g_test_state_projection_length = 0U;
Byte32 g_test_state_digest{};
std::uint32_t g_recovery_duplicate_fail_on_call = 0U;
std::uint32_t g_recovery_duplicate_call_count = 0U;
ProtectedRecoveryEvidenceForTest g_recovery_evidence{};
ProtectedRecoveryPhaseBHookForTest g_recovery_phase_b_hook = nullptr;
std::uint32_t g_prepared_publication_stage = 0U;
std::uint32_t g_prepared_publication_error = ERROR_SUCCESS;
std::uint32_t g_directory_move_stage = 0U;
std::uint32_t g_directory_move_error = ERROR_SUCCESS;
std::uint32_t g_directory_move_fail_after_stage = 0U;
std::uint32_t g_journal_publication_stage = 0U;
std::uint32_t g_journal_publication_error = ERROR_SUCCESS;
std::uint32_t g_journal_publication_fail_after_stage = 0U;
std::uint32_t g_journal_publication_fail_on_ordinary_call = 0U;
std::uint32_t g_journal_publication_ordinary_call_count = 0U;
bool g_journal_publication_failure_active = false;
std::uint32_t g_revoke_control_stage = 0U;
std::uint32_t g_revoke_control_error = ERROR_SUCCESS;
std::uint32_t g_revoke_control_fail_after_stage = 0U;
std::uint32_t g_revoke_compute_count = 0U;
std::uint32_t g_create_recovery_stage = 0U;
std::uint32_t g_create_recovery_call_count = 0U;
std::uint32_t g_create_recovery_last_mode = 0U;
std::uint32_t g_revoke_recovery_stage = 0U;
std::uint32_t g_phase_b_nonterminal_revalidation_stage = 0U;
#endif

bool RecordPreparedPublicationStep(
    bool succeeded,
    std::uint32_t stage) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (succeeded) {
    g_prepared_publication_stage = stage;
  } else if (g_prepared_publication_error == ERROR_SUCCESS) {
    g_prepared_publication_error = GetLastError();
  }
#else
  (void)stage;
#endif
  return succeeded;
}

bool RecordDirectoryMoveStep(bool succeeded, std::uint32_t stage) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!succeeded) {
    if (g_directory_move_error == ERROR_SUCCESS) {
      g_directory_move_error = GetLastError();
    }
    return false;
  }
  g_directory_move_stage = stage;
  if (g_directory_move_fail_after_stage == stage) {
    g_directory_move_error = ERROR_OPERATION_ABORTED;
    SetLastError(ERROR_OPERATION_ABORTED);
    return false;
  }
#else
  (void)stage;
#endif
  return succeeded;
}

bool RecordJournalPublicationStep(
    bool succeeded,
    std::uint32_t stage) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!succeeded) {
    if (g_journal_publication_error == ERROR_SUCCESS) {
      g_journal_publication_error = GetLastError();
    }
    return false;
  }
  g_journal_publication_stage = stage;
  if (g_journal_publication_failure_active &&
      g_journal_publication_fail_after_stage == stage) {
    g_journal_publication_error = ERROR_OPERATION_ABORTED;
    SetLastError(ERROR_OPERATION_ABORTED);
    return false;
  }
#else
  (void)stage;
#endif
  return succeeded;
}

bool RecordRevokeControlStep(bool succeeded, std::uint32_t stage) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!succeeded) {
    if (g_revoke_control_error == ERROR_SUCCESS) {
      g_revoke_control_error = GetLastError();
    }
    return false;
  }
  g_revoke_control_stage = stage;
  if (g_revoke_control_fail_after_stage == stage) {
    g_revoke_control_error = ERROR_OPERATION_ABORTED;
    SetLastError(ERROR_OPERATION_ABORTED);
    return false;
  }
#else
  (void)stage;
#endif
  return succeeded;
}

bool CaptureMoveFileAuthority(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& parent_path,
    const ProtectedDirectoryEntry& entry,
    std::uint64_t maximum_length,
    DirectoryMoveFileAuthority* authority) noexcept {
  if (authority == nullptr || entry.name_length == 0U ||
      entry.name_length >= authority->name.size() ||
      (entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
      (entry.attributes &
       (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
        FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED |
        FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS |
        FILE_ATTRIBUTE_RECALL_ON_OPEN)) != 0U ||
      entry.byte_length > maximum_length ||
      entry.byte_length > authority->bytes.size()) {
    return false;
  }
  ProtectedPath file_path{};
  std::size_t observed_length = 0U;
  std::memcpy(
      authority->name.data(),
      entry.name.data(),
      entry.name_length * sizeof(wchar_t));
  authority->name_length = static_cast<std::uint16_t>(entry.name_length);
  authority->byte_length = entry.byte_length;
  if (!ComposeProtectedChildPath(
          parent_path, authority->name.data(), &file_path) ||
      !ReadProtectedExistingFile(
          filesystem,
          file_path,
          authority->bytes.data(),
          authority->bytes.size(),
          &observed_length,
          &authority->identity) ||
      observed_length != entry.byte_length ||
      !ComputeSha256(
          authority->bytes.data(), observed_length, &authority->content_hash)) {
    WipeCustodyOwned(authority, sizeof(*authority));
    return false;
  }
  authority->present = true;
  return true;
}

bool CandidateMoveMaximumLength(
    const ProtectedDirectoryEntry& entry,
    std::uint64_t* maximum_length) noexcept {
  if (maximum_length == nullptr) return false;
  constexpr std::array<const wchar_t*, 5U> kNames = {
      L"runtime-manifest.pk8",
      L"runtime-manifest.spki",
      L"admission-evidence.pk8",
      L"admission-evidence.spki",
      L"keyset-receipt.gckr"};
  constexpr std::array<std::uint64_t, 5U> kLengths = {
      48U, 44U, 48U, 44U, 640U};
  for (std::size_t index = 0U; index < kNames.size(); ++index) {
    if (EqualWide(entry.name.data(), entry.name_length, kNames[index])) {
      *maximum_length = kLengths[index];
      return true;
    }
  }
  return false;
}

bool ParseRecordComponent(
    const ProtectedDirectoryEntry& entry,
    std::uint32_t* sequence,
    JournalRecordKind* kind) noexcept;
bool ParsePendingRecordComponent(
    const ProtectedDirectoryEntry& entry,
    std::uint32_t* sequence,
    JournalRecordKind* kind) noexcept;
bool BuildGenerationComponent(
    std::uint64_t generation,
    std::array<wchar_t, 32U>* output) noexcept;

bool CaptureDirectoryMoveAuthority(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& root_path,
    HANDLE retained_root_directory,
    DirectoryMoveAuthority* authority,
    bool candidate_root = false) noexcept {
  if (authority == nullptr || retained_root_directory == nullptr ||
      retained_root_directory == INVALID_HANDLE_VALUE) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_directory_move_stage = 0U;
  g_directory_move_error = ERROR_SUCCESS;
#endif
  WipeCustodyOwned(authority, sizeof(*authority));
  std::size_t root_entry_count = 0U;
  if (!CaptureProtectedObjectIdentity(
          filesystem, retained_root_directory, &authority->root_identity) ||
      !EnumerateProtectedDirectory(
          filesystem,
          retained_root_directory,
          &g_root_scan_entries,
          &root_entry_count) ||
      root_entry_count > kMaximumMoveRootFiles + 1U) {
    WipeCustodyOwned(authority, sizeof(*authority));
    return false;
  }
  ProtectedPath nested_path{};
  std::size_t nested_entry_count = 0U;
  std::size_t prospective_root_file_count = 0U;
  std::uint64_t prospective_root_bytes = 0U;
  for (std::size_t index = 0U; index < root_entry_count; ++index) {
    const ProtectedDirectoryEntry& entry = g_root_scan_entries[index];
    if ((entry.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U) {
      std::uint32_t sequence = 0U;
      JournalRecordKind kind{};
      std::uint64_t candidate_maximum_length = 0U;
      const bool canonical_candidate = candidate_root &&
          CandidateMoveMaximumLength(entry, &candidate_maximum_length);
      const bool canonical_record =
          !candidate_root &&
          (ParseRecordComponent(entry, &sequence, &kind) ||
           ParsePendingRecordComponent(entry, &sequence, &kind));
      const bool canonical_revoke_candidate = EqualWide(
          entry.name.data(), entry.name_length, L"revoke.pending.gckc");
      if ((!canonical_candidate && !canonical_record &&
           (!canonical_revoke_candidate || candidate_root)) ||
          (entry.attributes &
           (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
            FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED |
            FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS |
            FILE_ATTRIBUTE_RECALL_ON_OPEN)) != 0U ||
          entry.byte_length >
              (canonical_candidate
                   ? candidate_maximum_length
                   : (canonical_revoke_candidate ? 256U : kJournalRecordBytes)) ||
          (candidate_root &&
           prospective_root_bytes + entry.byte_length > 824U) ||
          ++prospective_root_file_count >
              (candidate_root ? kMaximumMoveNestedFiles
                              : authority->root_files.size())) {
        WipeCustodyOwned(authority, sizeof(*authority));
        return false;
      }
      prospective_root_bytes += entry.byte_length;
      continue;
    }
    if (candidate_root || authority->nested_directory_present ||
        (entry.attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U ||
        !EqualWide(
            entry.name.data(), entry.name_length, L"keyset.pending") ||
        entry.name_length >= authority->nested_directory_name.size()) {
      WipeCustodyOwned(authority, sizeof(*authority));
      return false;
    }
    HANDLE nested_directory = nullptr;
    std::memcpy(
        authority->nested_directory_name.data(),
        entry.name.data(),
        entry.name_length * sizeof(wchar_t));
    authority->nested_directory_name_length =
        static_cast<std::uint16_t>(entry.name_length);
    bool nested_valid = ComposeProtectedChildPath(
                            root_path,
                            authority->nested_directory_name.data(),
                            &nested_path) &&
        OpenProtectedExistingDirectory(
            filesystem,
            nested_path,
            false,
            &nested_directory,
            &authority->nested_directory_identity) &&
        EnumerateProtectedDirectory(
            filesystem,
            nested_directory,
            &g_recovery_entries,
            &nested_entry_count) &&
        nested_entry_count <= authority->nested_files.size();
    if (nested_directory != nullptr && nested_directory != INVALID_HANDLE_VALUE) {
      CloseHandle(nested_directory);
    }
    std::uint64_t total_nested_bytes = 0U;
    for (std::size_t child = 0U; nested_valid && child < nested_entry_count;
         ++child) {
      std::uint64_t maximum_length = 0U;
      nested_valid = CandidateMoveMaximumLength(
                         g_recovery_entries[child], &maximum_length) &&
          (g_recovery_entries[child].attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
          (g_recovery_entries[child].attributes &
           (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
            FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED |
            FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS |
            FILE_ATTRIBUTE_RECALL_ON_OPEN)) == 0U &&
          g_recovery_entries[child].byte_length <= maximum_length &&
          total_nested_bytes + g_recovery_entries[child].byte_length <= 824U;
      if (nested_valid) {
        total_nested_bytes += g_recovery_entries[child].byte_length;
      }
    }
    if (!nested_valid) {
      WipeCustodyOwned(authority, sizeof(*authority));
      return false;
    }
    authority->nested_directory_present = true;
  }
  for (std::size_t index = 0U; index < root_entry_count; ++index) {
    const ProtectedDirectoryEntry& entry = g_root_scan_entries[index];
    if ((entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) continue;
    const bool revoke_candidate = EqualWide(
        entry.name.data(), entry.name_length, L"revoke.pending.gckc");
    std::uint64_t candidate_maximum_length = 0U;
    const bool canonical_candidate = candidate_root &&
        CandidateMoveMaximumLength(entry, &candidate_maximum_length);
    if (!CaptureMoveFileAuthority(
            filesystem,
            root_path,
            entry,
            canonical_candidate
                ? candidate_maximum_length
                : (revoke_candidate ? 256U : kJournalRecordBytes),
            &authority->root_files[authority->root_file_count])) {
      WipeCustodyOwned(authority, sizeof(*authority));
      return false;
    }
    ++authority->root_file_count;
  }
  for (std::size_t child = 0U; child < nested_entry_count; ++child) {
    std::uint64_t maximum_length = 0U;
    if (!CandidateMoveMaximumLength(
            g_recovery_entries[child], &maximum_length) ||
        !CaptureMoveFileAuthority(
            filesystem,
            nested_path,
            g_recovery_entries[child],
            maximum_length,
            &authority->nested_files[authority->nested_file_count])) {
      WipeCustodyOwned(authority, sizeof(*authority));
      return false;
    }
    ++authority->nested_file_count;
  }
  authority->present = true;
  return RecordDirectoryMoveStep(true, 1U);
}

bool EqualMoveIdentity(
    const ProtectedObjectIdentity& left,
    const ProtectedObjectIdentity& right) noexcept {
  return left.volume_serial_number == right.volume_serial_number &&
      Equal(left.file_id.data(), right.file_id.data(), left.file_id.size());
}

bool ValidateLiveQuarantineMoveAuthority(
    const DirectoryMoveAuthority& authority,
    const ProtectedObjectIdentity& candidate_identity,
    std::uint32_t quarantine_sequence,
    const JournalRecord& quarantined) noexcept {
  if (!authority.present || !authority.nested_directory_present ||
      !EqualMoveIdentity(
          authority.nested_directory_identity, candidate_identity) ||
      quarantine_sequence >= kMaximumJournalRecordsPerOperation ||
      authority.root_file_count !=
          static_cast<std::size_t>(quarantine_sequence) + 1U) {
    return false;
  }
  std::array<bool, kMaximumJournalRecordsPerOperation> sequences{};
  for (std::size_t index = 0U; index < authority.root_file_count; ++index) {
    const DirectoryMoveFileAuthority& file = authority.root_files[index];
    ProtectedDirectoryEntry entry{};
    entry.name_length = file.name_length;
    std::memcpy(
        entry.name.data(),
        file.name.data(),
        file.name_length * sizeof(wchar_t));
    entry.byte_length = file.byte_length;
    std::uint32_t filename_sequence = UINT32_MAX;
    JournalRecordKind filename_kind{};
    JournalRecord record{};
    JournalRecordKind encoded_kind{};
    std::uint32_t encoded_sequence = UINT32_MAX;
    Byte32 hash{};
    if (file.byte_length != kJournalRecordBytes ||
        !ParseRecordComponent(
            entry, &filename_sequence, &filename_kind) ||
        filename_sequence > quarantine_sequence ||
        sequences[filename_sequence]) {
      return false;
    }
    std::memcpy(record.bytes.data(), file.bytes.data(), record.bytes.size());
    if (!ValidateJournalRecord(
            record, &encoded_kind, &encoded_sequence, &hash) ||
        encoded_kind != filename_kind || encoded_sequence != filename_sequence) {
      return false;
    }
    sequences[filename_sequence] = true;
    if (filename_sequence == quarantine_sequence &&
        (filename_kind != JournalRecordKind::Quarantined ||
         !Equal(
             record.bytes.data(),
             quarantined.bytes.data(),
             record.bytes.size()))) {
      return false;
    }
  }
  for (std::uint32_t sequence = 0U; sequence <= quarantine_sequence;
       ++sequence) {
    if (!sequences[sequence]) return false;
  }
  return true;
}

const ProtectedDirectoryEntry* FindMoveEntry(
    const std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>&
        entries,
    std::size_t entry_count,
    const wchar_t* name,
    std::size_t name_length) noexcept {
  const ProtectedDirectoryEntry* found = nullptr;
  for (std::size_t index = 0U; index < entry_count; ++index) {
    if (!EqualWide(entries[index].name.data(), entries[index].name_length, name) ||
        entries[index].name_length != name_length) continue;
    if (found != nullptr) return nullptr;
    found = &entries[index];
  }
  return found;
}

bool ValidateMoveFileReadOnly(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& parent_path,
    const DirectoryMoveFileAuthority& authority) noexcept {
  if (!authority.present) return false;
  ProtectedPath path{};
  std::array<std::uint8_t, kMaximumMoveFileBytes> bytes{};
  std::size_t length = 0U;
  ProtectedObjectIdentity identity{};
  Byte32 hash{};
  const bool valid = ComposeProtectedChildPath(
                         parent_path, authority.name.data(), &path) &&
      ReadProtectedFinalFile(
          filesystem,
          path,
          bytes.data(),
          bytes.size(),
          &length,
          &identity) &&
      length == authority.byte_length &&
      EqualMoveIdentity(identity, authority.identity) &&
      Equal(bytes.data(), authority.bytes.data(), length) &&
      ComputeSha256(bytes.data(), length, &hash) &&
      Equal(hash.data(), authority.content_hash.data(), hash.size());
  WipeCustodyOwned(bytes.data(), bytes.size());
  return valid;
}

bool ValidateDirectoryMoveAuthorityReadOnly(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& final_root_path,
    const DirectoryMoveAuthority& authority) noexcept {
  if (!authority.present) return false;
  HANDLE root_directory = nullptr;
  ProtectedObjectIdentity root_identity{};
  std::size_t root_entry_count = 0U;
  bool valid = OpenProtectedExistingDirectory(
                   filesystem,
                   final_root_path,
                   false,
                   &root_directory,
                   &root_identity) &&
      EqualMoveIdentity(root_identity, authority.root_identity) &&
      EnumerateProtectedDirectory(
          filesystem,
          root_directory,
          &g_root_scan_entries,
          &root_entry_count) &&
      root_entry_count == authority.root_file_count +
          (authority.nested_directory_present ? 1U : 0U);
  for (std::size_t index = 0U; valid && index < authority.root_file_count;
       ++index) {
    const DirectoryMoveFileAuthority& file = authority.root_files[index];
    const ProtectedDirectoryEntry* entry = FindMoveEntry(
        g_root_scan_entries,
        root_entry_count,
        file.name.data(),
        file.name_length);
    valid = entry != nullptr &&
        (entry->attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
        entry->byte_length == file.byte_length;
  }
  ProtectedPath nested_path{};
  HANDLE nested_directory = nullptr;
  if (valid && authority.nested_directory_present) {
    const ProtectedDirectoryEntry* entry = FindMoveEntry(
        g_root_scan_entries,
        root_entry_count,
        authority.nested_directory_name.data(),
        authority.nested_directory_name_length);
    ProtectedObjectIdentity nested_identity{};
    std::size_t nested_entry_count = 0U;
    valid = entry != nullptr &&
        (entry->attributes & ~FILE_ATTRIBUTE_DIRECTORY) == 0U &&
        ComposeProtectedChildPath(
            final_root_path,
            authority.nested_directory_name.data(),
            &nested_path) &&
        OpenProtectedExistingDirectory(
            filesystem,
            nested_path,
            false,
            &nested_directory,
            &nested_identity) &&
        EqualMoveIdentity(
            nested_identity, authority.nested_directory_identity) &&
        EnumerateProtectedDirectory(
            filesystem,
            nested_directory,
            &g_recovery_entries,
            &nested_entry_count) &&
        nested_entry_count == authority.nested_file_count;
    for (std::size_t index = 0U;
         valid && index < authority.nested_file_count;
         ++index) {
      const DirectoryMoveFileAuthority& file = authority.nested_files[index];
      const ProtectedDirectoryEntry* child = FindMoveEntry(
          g_recovery_entries,
          nested_entry_count,
          file.name.data(),
          file.name_length);
      valid = child != nullptr &&
          (child->attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
          child->byte_length == file.byte_length;
    }
  }
  if (nested_directory != nullptr && nested_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(nested_directory);
  }
  if (root_directory != nullptr && root_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(root_directory);
  }
  for (std::size_t index = 0U; valid && index < authority.root_file_count;
       ++index) {
    valid = ValidateMoveFileReadOnly(
        filesystem, final_root_path, authority.root_files[index]);
  }
  for (std::size_t index = 0U;
       valid && index < authority.nested_file_count;
       ++index) {
    valid = ValidateMoveFileReadOnly(
        filesystem, nested_path, authority.nested_files[index]);
  }
  return valid;
}

bool ReopenFlushMoveFile(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& parent_path,
    const DirectoryMoveFileAuthority& authority,
    bool post_move) noexcept {
  ProtectedPath path{};
  HANDLE file = nullptr;
  std::uint64_t opened_length = 0U;
  ProtectedObjectIdentity identity{};
  std::array<std::uint8_t, kMaximumMoveFileBytes> bytes{};
  std::size_t read_length = 0U;
  Byte32 hash{};
  bool valid = authority.present &&
      ComposeProtectedChildPath(parent_path, authority.name.data(), &path) &&
      OpenProtectedExistingFileForParentRename(
          filesystem,
          path,
          authority.byte_length,
          &file,
          &opened_length,
          &identity) &&
      opened_length == authority.byte_length &&
      EqualMoveIdentity(identity, authority.identity) &&
      ReadProtectedOpenFile(
          filesystem,
          file,
          bytes.data(),
          bytes.size(),
          &read_length,
          &identity) &&
      read_length == authority.byte_length &&
      EqualMoveIdentity(identity, authority.identity) &&
      Equal(bytes.data(), authority.bytes.data(), read_length) &&
      ComputeSha256(bytes.data(), read_length, &hash) &&
      Equal(hash.data(), authority.content_hash.data(), hash.size()) &&
      FlushProtectedOpenFileForParentRename(filesystem, file, post_move);
  if (file != nullptr && file != INVALID_HANDLE_VALUE) CloseHandle(file);
  WipeCustodyOwned(bytes.data(), bytes.size());
  return valid;
}

bool ReopenFlushDirectoryMoveAuthority(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& final_root_path,
    const DirectoryMoveAuthority& authority,
    bool post_move) noexcept {
  ProtectedPath nested_path{};
  bool valid = !authority.nested_directory_present ||
      ComposeProtectedChildPath(
          final_root_path,
          authority.nested_directory_name.data(),
          &nested_path);
  for (std::size_t index = 0U; valid && index < authority.root_file_count;
       ++index) {
    valid = ReopenFlushMoveFile(
        filesystem, final_root_path, authority.root_files[index], post_move);
  }
  for (std::size_t index = 0U;
       valid && index < authority.nested_file_count;
       ++index) {
    valid = ReopenFlushMoveFile(
        filesystem, nested_path, authority.nested_files[index], post_move);
  }
  return valid;
}

bool MoveDirectoryWithCapturedAuthority(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& source_path,
    const ProtectedPath& final_path,
    HANDLE* source_directory,
    const DirectoryMoveAuthority& authority) noexcept {
  if (source_directory == nullptr || *source_directory == nullptr ||
      *source_directory == INVALID_HANDLE_VALUE || !authority.present) {
    return false;
  }
  bool moved = RecordDirectoryMoveStep(
      ReopenFlushDirectoryMoveAuthority(
          filesystem, source_path, authority, false),
      2U);
  if (moved) {
    moved = RecordDirectoryMoveStep(
        RenameProtectedDirectory(filesystem, *source_directory, final_path),
        3U);
  }
  CloseHandle(*source_directory);
  *source_directory = nullptr;
  if (moved) moved = RecordDirectoryMoveStep(true, 4U);
  if (moved) {
    moved = RecordDirectoryMoveStep(
        ValidateDirectoryMoveAuthorityReadOnly(
            filesystem, final_path, authority) &&
            ProtectedPathIsAbsentGuarded(filesystem, source_path),
        5U);
  }
  if (moved) {
    moved = RecordDirectoryMoveStep(
        ReopenFlushDirectoryMoveAuthority(
            filesystem, final_path, authority, true),
        6U);
  }
  if (moved) {
    moved = RecordDirectoryMoveStep(
        ValidateDirectoryMoveAuthorityReadOnly(
            filesystem, final_path, authority) &&
            ProtectedPathIsAbsentGuarded(filesystem, source_path),
        7U);
  }
  if (moved) moved = RecordDirectoryMoveStep(true, 8U);
  return moved;
}

bool CompleteCapturedDirectoryAtFinal(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& final_path,
    HANDLE* final_directory,
    const DirectoryMoveAuthority& authority) noexcept {
  if (final_directory == nullptr || *final_directory == nullptr ||
      *final_directory == INVALID_HANDLE_VALUE || !authority.present) {
    return false;
  }
  CloseHandle(*final_directory);
  *final_directory = nullptr;
  bool completed = RecordDirectoryMoveStep(
      ValidateDirectoryMoveAuthorityReadOnly(
          filesystem, final_path, authority),
      9U);
  completed = completed && RecordDirectoryMoveStep(
      ReopenFlushDirectoryMoveAuthority(
          filesystem, final_path, authority, true),
      10U);
  completed = completed && RecordDirectoryMoveStep(
      ValidateDirectoryMoveAuthorityReadOnly(
          filesystem, final_path, authority),
      11U);
  return completed;
}

bool CompleteFinalCreateKeysetDirectory(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    std::uint64_t generation) noexcept {
  if (state == nullptr || !operation.present) return false;
  std::array<wchar_t, 32U> generation_component{};
  ProtectedPath source_path{};
  ProtectedPath final_path{};
  HANDLE final_directory = nullptr;
  ProtectedObjectIdentity final_identity{};
  DirectoryMoveAuthority& authority = g_directory_move_authority_scratch;
  const bool completed =
      BuildGenerationComponent(generation, &generation_component) &&
      ComposeProtectedChildPath(
          operation.path, L"keyset.pending", &source_path) &&
      ComposeProtectedChildPath(
          state->filesystem.keysets_path,
          generation_component.data(),
          &final_path) &&
      OpenProtectedExistingDirectory(
          state->filesystem,
          final_path,
          true,
          &final_directory,
          &final_identity) &&
      CaptureDirectoryMoveAuthority(
          state->filesystem,
          final_path,
          final_directory,
          &authority,
          true) &&
      EqualMoveIdentity(final_identity, authority.root_identity) &&
      CompleteCapturedDirectoryAtFinal(
          state->filesystem,
          final_path,
          &final_directory,
          authority) &&
      ProtectedPathIsAbsentGuarded(state->filesystem, source_path);
  if (final_directory != nullptr && final_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(final_directory);
  }
  WipeCustodyOwned(&authority, sizeof(authority));
  return completed;
}

void IdentityBytes(const ProtectedObjectIdentity& identity, std::uint8_t* output) noexcept {
  WriteU64(output, identity.volume_serial_number);
  std::memcpy(output + 8U, identity.file_id.data(), identity.file_id.size());
}
bool HashDomain(
    const char* domain,
    std::size_t domain_length,
    const std::uint8_t* bytes,
    std::size_t length,
    Byte32* output) noexcept {
  if (domain == nullptr || bytes == nullptr || output == nullptr || domain_length + 1U + length > 512U) return false;
  std::array<std::uint8_t, 512U> projection{};
  std::memcpy(projection.data(), domain, domain_length);
  projection[domain_length] = 0U;
  std::memcpy(projection.data() + domain_length + 1U, bytes, length);
  return ComputeSha256(projection.data(), domain_length + 1U + length, output);
}
bool HashDomainLarge(
    const char* domain,
    std::size_t domain_length,
    const std::uint8_t* bytes,
    std::size_t length,
    Byte32* output) noexcept {
  if (domain == nullptr || bytes == nullptr || output == nullptr ||
      domain_length + 1U + length > 2048U) return false;
  std::array<std::uint8_t, 2048U> projection{};
  std::memcpy(projection.data(), domain, domain_length);
  projection[domain_length] = 0U;
  std::memcpy(projection.data() + domain_length + 1U, bytes, length);
  return ComputeSha256(projection.data(), domain_length + 1U + length, output);
}

bool AllZero(const std::uint8_t* bytes, std::size_t length) noexcept {
  if (bytes == nullptr) return length == 0U;
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool GenerationProjectionValid(
    const ProtectedGenerationProjection& projection) noexcept {
  if (!projection.present) return AllZero(projection.bytes.data(), projection.bytes.size());
  const std::uint64_t generation = ReadU64(projection.bytes.data());
  const std::uint64_t predecessor = ReadU64(projection.bytes.data() + 8U);
  const std::uint8_t lifecycle = projection.bytes[16];
  if (generation == 0U || predecessor >= generation || lifecycle < 1U || lifecycle > 5U ||
      !AllZero(projection.bytes.data() + 17U, 7U) ||
      AllZero(projection.bytes.data() + 24U, 16U)) return false;
  if (lifecycle == 4U) {
    return AllZero(projection.bytes.data() + 40U, 408U);
  }
  if (lifecycle == 5U) {
    return !AllZero(projection.bytes.data() + 40U, 24U) &&
           !AllZero(projection.bytes.data() + 416U, 32U) &&
           AllZero(projection.bytes.data() + 344U, 72U);
  }
  if (AllZero(projection.bytes.data() + 40U, 24U) ||
      AllZero(projection.bytes.data() + 64U, 120U) ||
      AllZero(projection.bytes.data() + 184U, 160U) ||
      !AllZero(projection.bytes.data() + 416U, 32U)) return false;
  if (lifecycle == 3U) {
    return !AllZero(projection.bytes.data() + 344U, 24U) &&
           !AllZero(projection.bytes.data() + 368U, 32U) &&
           !AllZero(projection.bytes.data() + 400U, 16U);
  }
  return AllZero(projection.bytes.data() + 344U, 72U);
}

bool OperationProjectionValid(
    const ProtectedOperationProjection& projection) noexcept {
  if (!projection.present) return AllZero(projection.bytes.data(), projection.bytes.size());
  const std::uint8_t opcode = projection.bytes[16];
  const std::uint8_t status = projection.bytes[17];
  if (AllZero(projection.bytes.data(), 16U) || status < 1U || status > 3U ||
      !AllZero(projection.bytes.data() + 18U, 6U)) return false;
  if (status == 3U) {
    return opcode == 0U && ReadU64(projection.bytes.data() + 24U) == 0U &&
           AllZero(projection.bytes.data() + 32U, 32U);
  }
  return (opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
          opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) &&
         ReadU64(projection.bytes.data() + 24U) != 0U &&
         !AllZero(projection.bytes.data() + 32U, 32U);
}

bool ResidueProjectionValid(
    const ProtectedResidueProjection& projection) noexcept {
  if (!projection.present) return AllZero(projection.bytes.data(), projection.bytes.size());
  const std::uint8_t ordinal = projection.bytes[16];
  const std::uint8_t kind = projection.bytes[17];
  const std::uint16_t publication_sequence = ReadU16(projection.bytes.data() + 18U);
  const std::uint64_t length = ReadU64(projection.bytes.data() + 20U);
  if (AllZero(projection.bytes.data(), 16U) || ordinal > 7U || kind < 1U || kind > 3U ||
      publication_sequence == 0U ||
      publication_sequence > kMaximumPublicationSequence ||
      AllZero(projection.bytes.data() + 28U, 24U) ||
      AllZero(projection.bytes.data() + 52U, 32U)) return false;
  if (kind == 1U) return length <= 1023U;
  if (kind == 2U) return length <= 1023U;
  return length <= 255U;
}

template <typename Projection, std::size_t Count>
void CompactPresent(
    const std::array<Projection, Count>& source,
    std::array<Projection, Count>* destination,
    std::size_t* present_count) noexcept {
  destination->fill(Projection{});
  *present_count = 0U;
  for (const Projection& entry : source) {
    if (entry.present) (*destination)[(*present_count)++] = entry;
  }
}

bool BuildCanonicalState(
    const ProtectedOperationsState& state,
    const ProtectedGenerationProjection* extra_generation,
    const ProtectedOperationProjection* extra_operation,
    const ProtectedResidueProjection* extra_residue,
    Byte32* output) noexcept {
  if (!state.filesystem.ready || output == nullptr) return false;
  std::size_t generation_count = 0U;
  std::size_t operation_count = 0U;
  std::size_t residue_count = 0U;
  for (const ProtectedGenerationProjection& entry : state.generations) {
    if (!GenerationProjectionValid(entry)) return false;
  }
  for (const ProtectedOperationProjection& entry : state.operations) {
    if (!OperationProjectionValid(entry)) return false;
  }
  for (const ProtectedResidueProjection& entry : state.residues) {
    if (!ResidueProjectionValid(entry)) return false;
  }
  CompactPresent(state.generations, &g_generation_projection_scratch, &generation_count);
  CompactPresent(state.operations, &g_operation_projection_scratch, &operation_count);
  CompactPresent(state.residues, &g_residue_projection_scratch, &residue_count);

  auto upsert_generation = [&](const ProtectedGenerationProjection* extra) noexcept -> bool {
    if (extra == nullptr) return true;
    if (!GenerationProjectionValid(*extra)) return false;
    const std::uint64_t wanted = ReadU64(extra->bytes.data());
    for (std::size_t index = 0U; index < generation_count; ++index) {
      if (ReadU64(g_generation_projection_scratch[index].bytes.data()) == wanted) {
        g_generation_projection_scratch[index] = *extra;
        return true;
      }
    }
    if (generation_count >= g_generation_projection_scratch.size()) return false;
    g_generation_projection_scratch[generation_count++] = *extra;
    return true;
  };
  auto upsert_operation = [&](const ProtectedOperationProjection* extra) noexcept -> bool {
    if (extra == nullptr) return true;
    if (!OperationProjectionValid(*extra)) return false;
    for (std::size_t index = 0U; index < operation_count; ++index) {
      if (Equal(g_operation_projection_scratch[index].bytes.data(), extra->bytes.data(), 16U)) {
        g_operation_projection_scratch[index] = *extra;
        return true;
      }
    }
    if (operation_count >= g_operation_projection_scratch.size()) return false;
    g_operation_projection_scratch[operation_count++] = *extra;
    return true;
  };
  auto upsert_residue = [&](const ProtectedResidueProjection* extra) noexcept -> bool {
    if (extra == nullptr) return true;
    if (!ResidueProjectionValid(*extra)) return false;
    for (std::size_t index = 0U; index < residue_count; ++index) {
      if (Equal(g_residue_projection_scratch[index].bytes.data(), extra->bytes.data(), 16U) &&
          g_residue_projection_scratch[index].bytes[16] == extra->bytes[16]) {
        g_residue_projection_scratch[index] = *extra;
        return true;
      }
    }
    if (residue_count >= g_residue_projection_scratch.size()) return false;
    g_residue_projection_scratch[residue_count++] = *extra;
    return true;
  };
  if (!upsert_generation(extra_generation) || !upsert_operation(extra_operation) ||
      !upsert_residue(extra_residue)) return false;
  if (extra_generation != nullptr && extra_generation->bytes[16] == 1U) {
    const std::uint64_t active_generation = ReadU64(extra_generation->bytes.data());
    for (std::size_t index = 0U; index < generation_count; ++index) {
      if (ReadU64(g_generation_projection_scratch[index].bytes.data()) != active_generation &&
          g_generation_projection_scratch[index].bytes[16] == 1U) {
        g_generation_projection_scratch[index].bytes[16] = 2U;
      }
    }
  }

  for (std::size_t left = 0U; left < generation_count; ++left) {
    if (!GenerationProjectionValid(g_generation_projection_scratch[left])) return false;
    for (std::size_t right = left + 1U; right < generation_count; ++right) {
      const std::uint64_t left_generation =
          ReadU64(g_generation_projection_scratch[left].bytes.data());
      const std::uint64_t right_generation =
          ReadU64(g_generation_projection_scratch[right].bytes.data());
      if (left_generation == right_generation) return false;
      if (right_generation < left_generation) {
        const auto temporary = g_generation_projection_scratch[left];
        g_generation_projection_scratch[left] = g_generation_projection_scratch[right];
        g_generation_projection_scratch[right] = temporary;
      }
    }
  }
  for (std::size_t left = 0U; left < operation_count; ++left) {
    if (!OperationProjectionValid(g_operation_projection_scratch[left])) return false;
    for (std::size_t right = left + 1U; right < operation_count; ++right) {
      const int order = CompareOrdinal(
          g_operation_projection_scratch[left].bytes.data(),
          g_operation_projection_scratch[right].bytes.data(), 16U);
      if (order == 0) return false;
      if (order > 0) {
        const auto temporary = g_operation_projection_scratch[left];
        g_operation_projection_scratch[left] = g_operation_projection_scratch[right];
        g_operation_projection_scratch[right] = temporary;
      }
    }
  }
  for (std::size_t left = 0U; left < residue_count; ++left) {
    if (!ResidueProjectionValid(g_residue_projection_scratch[left])) return false;
    for (std::size_t right = left + 1U; right < residue_count; ++right) {
      int order = CompareOrdinal(
          g_residue_projection_scratch[left].bytes.data(),
          g_residue_projection_scratch[right].bytes.data(), 16U);
      if (order == 0) {
        if (g_residue_projection_scratch[left].bytes[16] ==
            g_residue_projection_scratch[right].bytes[16]) return false;
        order = g_residue_projection_scratch[left].bytes[16] <
                        g_residue_projection_scratch[right].bytes[16]
                    ? -1
                    : 1;
      }
      if (order > 0) {
        const auto temporary = g_residue_projection_scratch[left];
        g_residue_projection_scratch[left] = g_residue_projection_scratch[right];
        g_residue_projection_scratch[right] = temporary;
      }
    }
  }

  std::uint32_t journal_owned = 0U;
  std::uint32_t quarantined = 0U;
  for (std::size_t index = 0U; index < operation_count; ++index) {
    if (g_operation_projection_scratch[index].bytes[17] == 1U) ++journal_owned;
    if (g_operation_projection_scratch[index].bytes[17] == 2U) ++quarantined;
  }
  std::uint32_t committed = 0U;
  std::uint32_t controls = 0U;
  std::uint64_t highest_burned = 0U;
  std::uint64_t highest_committed = 0U;
  std::uint64_t active = 0U;
  for (std::size_t index = 0U; index < generation_count; ++index) {
    const auto& bytes = g_generation_projection_scratch[index].bytes;
    const std::uint64_t generation = ReadU64(bytes.data());
    const std::uint8_t lifecycle = bytes[16];
    highest_burned = generation;
    if (lifecycle >= 1U && lifecycle <= 3U) {
      ++committed;
      highest_committed = generation;
    }
    if (lifecycle == 1U) {
      if (active != 0U) return false;
      active = generation;
    }
    if (lifecycle == 3U) ++controls;
  }
  if (operation_count > kMaximumOperationIds || generation_count > kMaximumBurnedGenerations ||
      residue_count > kMaximumResidues || controls > kMaximumBurnedGenerations) return false;

  std::array<std::uint8_t, kStateHeaderBytes> header{};
  WriteU16(header.data(), 1U);
  IdentityBytes(state.filesystem.state_root_identity, header.data() + 4U);
  IdentityBytes(state.filesystem.journal_identity, header.data() + 28U);
  IdentityBytes(state.filesystem.keysets_identity, header.data() + 52U);
  IdentityBytes(state.filesystem.controls_identity, header.data() + 76U);
  IdentityBytes(state.filesystem.quarantine_identity, header.data() + 100U);
  Byte32 acl_hash{};
  if (!HashDomain(kAclDomain, sizeof(kAclDomain) - 1U,
                  state.filesystem.security_projection.data(),
                  state.filesystem.security_projection.size(), &acl_hash)) return false;
  std::memcpy(header.data() + 124U, acl_hash.data(), acl_hash.size());
  WriteU32(header.data() + 156U, kMaximumOperationIds);
  WriteU32(header.data() + 160U, kMaximumBurnedGenerations);
  WriteU32(header.data() + 164U, kMaximumResidues);
  WriteU32(header.data() + 168U, static_cast<std::uint32_t>(operation_count));
  WriteU32(header.data() + 172U, journal_owned);
  WriteU32(header.data() + 176U, quarantined);
  WriteU32(header.data() + 180U, static_cast<std::uint32_t>(residue_count));
  WriteU32(header.data() + 184U, static_cast<std::uint32_t>(generation_count));
  WriteU32(header.data() + 188U, committed);
  WriteU32(header.data() + 192U, controls);
  WriteU64(header.data() + 200U, highest_burned);
  WriteU64(header.data() + 208U, highest_committed);
  WriteU64(header.data() + 216U, active);

  g_state_hash_input.fill(0U);
  const std::size_t domain_length = sizeof(kStateDomain) - 1U;
  std::memcpy(g_state_hash_input.data(), kStateDomain, domain_length);
  std::size_t offset = domain_length;
  g_state_hash_input[offset++] = 0U;
  std::memcpy(g_state_hash_input.data() + offset, header.data(), header.size());
  offset += header.size();
  for (std::size_t index = 0U; index < generation_count; ++index) {
    std::memcpy(g_state_hash_input.data() + offset,
                g_generation_projection_scratch[index].bytes.data(),
                kGenerationEntryBytes);
    offset += kGenerationEntryBytes;
  }
  for (std::size_t index = 0U; index < operation_count; ++index) {
    std::memcpy(g_state_hash_input.data() + offset,
                g_operation_projection_scratch[index].bytes.data(),
                kOperationEntryBytes);
    offset += kOperationEntryBytes;
  }
  for (std::size_t index = 0U; index < residue_count; ++index) {
    std::memcpy(g_state_hash_input.data() + offset,
                g_residue_projection_scratch[index].bytes.data(),
                kResidueEntryBytes);
    offset += kResidueEntryBytes;
  }
  if (offset > g_state_hash_input.size()) return false;
  const bool hashed = ComputeSha256(g_state_hash_input.data(), offset, output);
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_test_state_projection.fill(0U);
  g_test_state_projection_length = offset - (sizeof(kStateDomain));
  if (g_test_state_projection_length <= g_test_state_projection.size()) {
    std::memcpy(
        g_test_state_projection.data(),
        g_state_hash_input.data() + sizeof(kStateDomain),
        g_test_state_projection_length);
    g_test_state_digest = *output;
  } else {
    g_test_state_projection_length = 0U;
    g_test_state_digest.fill(0U);
  }
#endif
  SecureZeroMemory(g_state_hash_input.data(), offset);
  return hashed;
}

template <typename Projection, std::size_t Count, typename KeyEqual>
bool CommitProjection(
    std::array<Projection, Count>* destination,
    const Projection& projection,
    KeyEqual key_equal) noexcept {
  if (destination == nullptr || !projection.present) return false;
  for (Projection& existing : *destination) {
    if (existing.present && key_equal(existing, projection)) {
      existing = projection;
      return true;
    }
  }
  for (Projection& existing : *destination) {
    if (!existing.present) {
      existing = projection;
      return true;
    }
  }
  return false;
}

bool AppendHistoricalKey(
    ProtectedOperationsState* state,
    const std::array<std::uint8_t, 44U>& spki,
    const Byte32& key_id) noexcept {
  if (state == nullptr || AllZero(spki.data(), spki.size()) ||
      AllZero(key_id.data(), key_id.size()) ||
      state->historical_key_count > state->historical_keys.size()) return false;
  for (std::size_t index = 0U; index < state->historical_key_count; ++index) {
    const bool same_spki = Equal(
        state->historical_keys[index].spki.data(), spki.data(), spki.size());
    const bool same_key_id = Equal(
        state->historical_keys[index].key_id.data(), key_id.data(), key_id.size());
    if (same_spki != same_key_id) return false;
    if (same_spki) return true;
  }
  if (state->historical_key_count == state->historical_keys.size()) return false;
  HistoricalCustodyKey& entry =
      state->historical_keys[state->historical_key_count++];
  entry.spki = spki;
  entry.key_id = key_id;
  return true;
}

bool CommitGenerationProjection(
    ProtectedOperationsState* state,
    const ProtectedGenerationProjection& projection) noexcept {
  if (state == nullptr || !GenerationProjectionValid(projection)) return false;
  const std::uint64_t generation = ReadU64(projection.bytes.data());
  if (projection.bytes[16] == 1U) {
    for (ProtectedGenerationProjection& existing : state->generations) {
      if (existing.present && ReadU64(existing.bytes.data()) != generation &&
          existing.bytes[16] == 1U) existing.bytes[16] = 2U;
    }
  }
  return CommitProjection(
      &state->generations,
      projection,
      [](const ProtectedGenerationProjection& left,
         const ProtectedGenerationProjection& right) noexcept {
        return ReadU64(left.bytes.data()) == ReadU64(right.bytes.data());
      });
}
bool ComputeEmptyState(
    const ProtectedFilesystemState& filesystem,
    std::array<std::uint8_t, kStateHeaderBytes>* header,
    Byte32* state_sha256) noexcept {
  if (!filesystem.ready || header == nullptr || state_sha256 == nullptr) return false;
  header->fill(0U);
  WriteU16(header->data(), 1U);
  IdentityBytes(filesystem.state_root_identity, header->data() + 4U);
  IdentityBytes(filesystem.journal_identity, header->data() + 28U);
  IdentityBytes(filesystem.keysets_identity, header->data() + 52U);
  IdentityBytes(filesystem.controls_identity, header->data() + 76U);
  IdentityBytes(filesystem.quarantine_identity, header->data() + 100U);
  Byte32 acl_hash{};
  if (!HashDomain(
          kAclDomain,
          sizeof(kAclDomain) - 1U,
          filesystem.security_projection.data(),
          filesystem.security_projection.size(),
          &acl_hash)) return false;
  std::memcpy(header->data() + 124U, acl_hash.data(), acl_hash.size());
  WriteU32(header->data() + 156U, kMaximumOperationIds);
  WriteU32(header->data() + 160U, kMaximumBurnedGenerations);
  WriteU32(header->data() + 164U, kMaximumResidues);
  return HashDomain(
      kStateDomain,
      sizeof(kStateDomain) - 1U,
      header->data(),
      header->size(),
      state_sha256);
}
void Copy32(const Byte32& value, std::uint8_t* output) noexcept {
  std::memcpy(output, value.data(), value.size());
}
void BuildCreateRejection(
    const CreateKeysetRequest& request,
    std::uint16_t disposition,
    const Byte32& state,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* output) noexcept {
  output->fill(0U);
  WriteU16(output->data(), 1U);
  WriteU16(output->data() + 2U, disposition);
  std::memcpy(output->data() + 8U, request.operation_id.data(), 16U);
  WriteU64(output->data() + 24U, request.requested_generation);
  WriteU64(output->data() + 32U, request.predecessor_generation);
  std::memcpy(output->data() + 40U, request.expected_state_sha256.data(), 32U);
  Copy32(state, output->data() + 72U);
  Copy32(state, output->data() + 104U);
}
void BuildRevokeRejection(
    const RevokeKeysetRequest& request,
    std::uint16_t disposition,
    const Byte32& state,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* output) noexcept {
  output->fill(0U);
  WriteU16(output->data(), 1U);
  WriteU16(output->data() + 2U, disposition);
  std::memcpy(output->data() + 8U, request.operation_id.data(), 16U);
  WriteU64(output->data() + 24U, request.generation);
  WriteU32(output->data() + 32U, request.reason);
  std::memcpy(output->data() + 40U, request.expected_state_sha256.data(), 32U);
  Copy32(state, output->data() + 72U);
  Copy32(state, output->data() + 104U);
}

bool BuildOperationComponent(
    const Byte16& operation_id,
    bool pending,
    std::array<wchar_t, 48U>* output) noexcept {
  if (output == nullptr) return false;
  output->fill(L'\0');
  std::size_t offset = 0U;
  if (pending) (*output)[offset++] = L'.';
  (*output)[offset++] = L'o';
  (*output)[offset++] = L'p';
  (*output)[offset++] = L'-';
  constexpr wchar_t kHex[] = L"0123456789abcdef";
  for (const std::uint8_t value : operation_id) {
    (*output)[offset++] = kHex[value >> 4U];
    (*output)[offset++] = kHex[value & 0x0fU];
  }
  if (pending) {
    constexpr wchar_t kSuffix[] = L".pending";
    for (std::size_t index = 0U; kSuffix[index] != L'\0'; ++index) (*output)[offset++] = kSuffix[index];
  }
  return offset + 1U <= output->size();
}

bool BuildGenerationComponent(
    std::uint64_t generation,
    std::array<wchar_t, 32U>* output) noexcept {
  if (output == nullptr || generation == 0U) return false;
  output->fill(L'\0');
  (*output)[0] = L'g';
  (*output)[1] = L'-';
  constexpr wchar_t kHex[] = L"0123456789abcdef";
  for (std::size_t index = 0U; index < 16U; ++index) {
    const std::size_t shift = (15U - index) * 4U;
    (*output)[2U + index] = kHex[(generation >> shift) & 0x0fU];
  }
  return true;
}

bool BuildControlComponent(
    std::uint64_t generation,
    std::array<wchar_t, 48U>* output) noexcept {
  std::array<wchar_t, 32U> generation_component{};
  if (output == nullptr || !BuildGenerationComponent(generation, &generation_component)) return false;
  output->fill(L'\0');
  std::size_t offset = 0U;
  while (generation_component[offset] != L'\0') {
    (*output)[offset] = generation_component[offset];
    ++offset;
  }
  constexpr wchar_t kSuffix[] = L".revoke.gckc";
  for (std::size_t index = 0U; kSuffix[index] != L'\0'; ++index) (*output)[offset++] = kSuffix[index];
  return offset + 1U <= output->size();
}

bool BuildRecordComponent(
    std::uint32_t sequence,
    const wchar_t* kind,
    bool pending,
    std::array<wchar_t, 48U>* output) noexcept {
  if (kind == nullptr || output == nullptr) return false;
  output->fill(L'\0');
  std::size_t offset = 0U;
  if (pending) (*output)[offset++] = L'.';
  (*output)[offset++] = L's';
  constexpr wchar_t kHex[] = L"0123456789abcdef";
  for (std::size_t index = 0U; index < 8U; ++index) {
    const std::size_t shift = (7U - index) * 4U;
    (*output)[offset++] = kHex[(sequence >> shift) & 0x0fU];
  }
  (*output)[offset++] = L'-';
  for (std::size_t index = 0U; kind[index] != L'\0'; ++index) (*output)[offset++] = kind[index];
  constexpr wchar_t kPending[] = L".pending";
  constexpr wchar_t kFinal[] = L".gcjr";
  const wchar_t* suffix = pending ? kPending : kFinal;
  for (std::size_t index = 0U; suffix[index] != L'\0'; ++index) (*output)[offset++] = suffix[index];
  return offset + 1U <= output->size();
}

bool BuildResidueComponent(
    const Byte16& operation_id,
    std::uint8_t ordinal,
    std::uint16_t publication_sequence,
    const wchar_t* role,
    std::array<wchar_t, 80U>* output) noexcept {
  if (role == nullptr || output == nullptr || ordinal > 7U ||
      publication_sequence == 0U ||
      publication_sequence > kMaximumPublicationSequence) return false;
  output->fill(L'\0');
  constexpr wchar_t kPrefix[] = L"residue-op-";
  constexpr wchar_t kHex[] = L"0123456789abcdef";
  std::size_t offset = 0U;
  for (std::size_t index = 0U; kPrefix[index] != L'\0'; ++index) {
    (*output)[offset++] = kPrefix[index];
  }
  for (const std::uint8_t value : operation_id) {
    (*output)[offset++] = kHex[value >> 4U];
    (*output)[offset++] = kHex[value & 0x0fU];
  }
  (*output)[offset++] = L'-';
  (*output)[offset++] = L'r';
  (*output)[offset++] = kHex[ordinal >> 4U];
  (*output)[offset++] = kHex[ordinal & 0x0fU];
  (*output)[offset++] = L'-';
  (*output)[offset++] = L'p';
  for (std::size_t index = 0U; index < 4U; ++index) {
    const std::size_t shift = (3U - index) * 4U;
    (*output)[offset++] = kHex[(publication_sequence >> shift) & 0x0fU];
  }
  (*output)[offset++] = L'-';
  for (std::size_t index = 0U; role[index] != L'\0'; ++index) {
    if (offset + 1U >= output->size()) return false;
    (*output)[offset++] = role[index];
  }
  return offset + 1U <= output->size();
}

bool ParseResidueComponent(
    const ProtectedDirectoryEntry& entry,
    Byte16* operation_id,
    std::uint8_t* ordinal,
    std::uint16_t* publication_sequence,
    std::uint8_t* kind) noexcept {
  if (operation_id == nullptr || ordinal == nullptr ||
      publication_sequence == nullptr || kind == nullptr ||
      entry.name_length < 59U) return false;
  constexpr wchar_t kPrefix[] = L"residue-op-";
  constexpr std::size_t kPrefixLength = 11U;
  for (std::size_t index = 0U; index < kPrefixLength; ++index) {
    if (entry.name[index] != kPrefix[index]) return false;
  }
  operation_id->fill(0U);
  for (std::size_t index = 0U; index < 16U; ++index) {
    const int high = HexNibble(entry.name[kPrefixLength + index * 2U]);
    const int low = HexNibble(entry.name[kPrefixLength + index * 2U + 1U]);
    if (high < 0 || low < 0) return false;
    (*operation_id)[index] = static_cast<std::uint8_t>((high << 4) | low);
  }
  constexpr std::size_t kMarker = kPrefixLength + 32U;
  if (entry.name[kMarker] != L'-' || entry.name[kMarker + 1U] != L'r' ||
      entry.name[kMarker + 4U] != L'-' || entry.name[kMarker + 5U] != L'p' ||
      entry.name[kMarker + 10U] != L'-') return false;
  const int ordinal_high = HexNibble(entry.name[kMarker + 2U]);
  const int ordinal_low = HexNibble(entry.name[kMarker + 3U]);
  if (ordinal_high < 0 || ordinal_low < 0) return false;
  const std::uint8_t parsed_ordinal =
      static_cast<std::uint8_t>((ordinal_high << 4) | ordinal_low);
  if (parsed_ordinal > 7U ||
      AllZero(operation_id->data(), operation_id->size())) return false;
  std::uint16_t parsed_publication_sequence = 0U;
  for (std::size_t index = 0U; index < 4U; ++index) {
    const int nibble = HexNibble(entry.name[kMarker + 6U + index]);
    if (nibble < 0) return false;
    parsed_publication_sequence = static_cast<std::uint16_t>(
        (parsed_publication_sequence << 4U) | static_cast<std::uint16_t>(nibble));
  }
  if (parsed_publication_sequence == 0U ||
      parsed_publication_sequence > kMaximumPublicationSequence) return false;
  const wchar_t* role = entry.name.data() + kMarker + 11U;
  const std::size_t role_length = entry.name_length - (kMarker + 11U);
  if (EqualWide(role, role_length, L"bootstrap")) {
    *kind = 1U;
  } else if (EqualWide(role, role_length, L"journal")) {
    *kind = 2U;
  } else if (EqualWide(role, role_length, L"revoke")) {
    *kind = 3U;
  } else {
    return false;
  }
  *ordinal = parsed_ordinal;
  *publication_sequence = parsed_publication_sequence;
  return true;
}

bool ParseOperationComponent(
    const ProtectedDirectoryEntry& entry,
    Byte16* operation_id) noexcept;

bool SelectResidueOrdinal(
    const ProtectedFilesystemState& filesystem,
    const Byte16& operation_id,
    const ProtectedObjectIdentity& source_identity,
    std::uint8_t* ordinal) noexcept {
  if (ordinal == nullptr) return false;
  std::size_t count = 0U;
  if (!EnumerateProtectedDirectory(
          filesystem,
          filesystem.quarantine,
          &g_quarantine_scan_entries,
          &count) ||
      count >= kMaximumProtectedDirectoryEntries) return false;
  std::array<bool, 8U> present{};
  std::size_t matching = 0U;
  std::size_t residue_total = 0U;
  std::size_t expected_quarantine_total = 0U;
  for (const PhaseAOperationInventory& inventory : g_phase_a_operations) {
    if (inventory.present && inventory.quarantine_location) {
      ++expected_quarantine_total;
    }
  }
  for (const ProtectedResidueProjection& residue : g_deferred_residues) {
    if (residue.present) ++expected_quarantine_total;
  }
  if (count != expected_quarantine_total) return false;
  for (std::size_t index = 0U; index < count; ++index) {
    Byte16 parsed_id{};
    std::uint8_t parsed_ordinal = 0U;
    std::uint16_t parsed_publication_sequence = 0U;
    std::uint8_t parsed_kind = 0U;
    if (!ParseResidueComponent(
            g_quarantine_scan_entries[index],
            &parsed_id,
            &parsed_ordinal,
            &parsed_publication_sequence,
            &parsed_kind)) {
      Byte16 quarantined_operation_id{};
      if (!ParseOperationComponent(
              g_quarantine_scan_entries[index],
              &quarantined_operation_id)) return false;
      continue;
    }
    ++residue_total;
    if (parsed_id == operation_id) {
      if (present[parsed_ordinal]) return false;
      ProtectedPath residue_path{};
      ProtectedObjectIdentity residue_identity{};
      if (!ComposeProtectedChildPath(
              filesystem.quarantine_path,
              g_quarantine_scan_entries[index].name.data(),
              &residue_path)) return false;
      if (parsed_kind == 1U) {
        HANDLE residue_directory = nullptr;
        if ((g_quarantine_scan_entries[index].attributes &
             FILE_ATTRIBUTE_DIRECTORY) == 0U ||
            (g_quarantine_scan_entries[index].attributes &
             ~FILE_ATTRIBUTE_DIRECTORY) != 0U ||
            !OpenProtectedExistingDirectory(
                filesystem,
                residue_path,
                false,
                &residue_directory,
                &residue_identity)) return false;
        CloseHandle(residue_directory);
      } else {
        std::array<std::uint8_t, kJournalRecordBytes> residue_bytes{};
        std::size_t residue_length = 0U;
        if ((g_quarantine_scan_entries[index].attributes &
             FILE_ATTRIBUTE_DIRECTORY) != 0U ||
            g_quarantine_scan_entries[index].byte_length >
                residue_bytes.size() ||
            !ReadProtectedExistingFile(
                filesystem,
                residue_path,
                residue_bytes.data(),
                residue_bytes.size(),
                &residue_length,
                &residue_identity) ||
            residue_length != g_quarantine_scan_entries[index].byte_length) {
          WipeCustodyOwned(residue_bytes.data(), residue_bytes.size());
          return false;
        }
        WipeCustodyOwned(residue_bytes.data(), residue_bytes.size());
      }
      if (residue_identity.volume_serial_number ==
              source_identity.volume_serial_number &&
          Equal(
              residue_identity.file_id.data(),
              source_identity.file_id.data(),
              source_identity.file_id.size())) return false;
      present[parsed_ordinal] = true;
      ++matching;
    }
  }
  std::size_t expected_residue_total = 0U;
  for (const ProtectedResidueProjection& residue : g_deferred_residues) {
    if (residue.present) ++expected_residue_total;
  }
  if (residue_total != expected_residue_total ||
      residue_total >= kMaximumResidues || matching >= present.size()) return false;
  for (std::size_t index = 0U; index < matching; ++index) {
    if (!present[index]) return false;
  }
  *ordinal = static_cast<std::uint8_t>(matching);
  return true;
}

bool PreflightResidueMove(
    const ProtectedOperationsState& state,
    const Byte16& operation_id,
    const wchar_t* role,
    std::uint64_t prospective_bytes,
    std::uint8_t* ordinal) noexcept {
  if (role == nullptr || ordinal == nullptr ||
      state.next_publication_sequence == 0U ||
      state.next_publication_sequence > kMaximumPublicationSequence) {
    return false;
  }
  const bool bootstrap = EqualWide(role, 9U, L"bootstrap");
  const bool journal = EqualWide(role, 7U, L"journal");
  const bool revoke = EqualWide(role, 6U, L"revoke");
  if ((!bootstrap && !journal && !revoke) ||
      (bootstrap && prospective_bytes > 1023U) ||
      (journal && prospective_bytes > 1023U) ||
      (revoke && prospective_bytes > 255U)) return false;
  std::size_t total_count = 0U;
  std::size_t matching_count = 0U;
  std::size_t bootstrap_count = 0U;
  std::uint64_t total_bytes = 0U;
  std::uint64_t matching_bytes = 0U;
  std::array<bool, 8U> ordinals{};
  for (const ProtectedResidueProjection& residue : g_deferred_residues) {
    if (!residue.present) continue;
    ++total_count;
    const std::uint64_t residue_bytes = ReadU64(residue.bytes.data() + 20U);
    if (UINT64_MAX - total_bytes < residue_bytes) return false;
    total_bytes += residue_bytes;
    if (!Equal(residue.bytes.data(), operation_id.data(), 16U)) continue;
    const std::uint8_t existing_ordinal = residue.bytes[16];
    if (existing_ordinal >= ordinals.size() || ordinals[existing_ordinal]) {
      return false;
    }
    ordinals[existing_ordinal] = true;
    ++matching_count;
    if (residue.bytes[17] == 1U) ++bootstrap_count;
    if (UINT64_MAX - matching_bytes < residue_bytes) return false;
    matching_bytes += residue_bytes;
  }
  for (std::size_t index = 0U; index < matching_count; ++index) {
    if (!ordinals[index]) return false;
  }
  if (total_count >= kMaximumResidues || matching_count >= ordinals.size() ||
      (bootstrap && (matching_count != 0U || bootstrap_count != 0U)) ||
      (!bootstrap && bootstrap_count != 0U) ||
      UINT64_MAX - total_bytes < prospective_bytes ||
      total_bytes + prospective_bytes > 261888U ||
      UINT64_MAX - matching_bytes < prospective_bytes ||
      matching_bytes + prospective_bytes > 8184U) {
    return false;
  }
  *ordinal = static_cast<std::uint8_t>(matching_count);
  return true;
}

struct PendingNormalizationAuthority final {
  HANDLE directory = nullptr;
  HANDLE child = nullptr;
  ProtectedObjectIdentity directory_identity{};
  ProtectedObjectIdentity child_identity{};
  std::uint64_t child_length = 0U;
  std::array<std::uint8_t, kJournalRecordBytes> child_bytes{};
  std::size_t child_bytes_length = 0U;
  Byte32 child_hash{};
  bool child_present = false;
};

void ClosePendingNormalizationAuthority(
    PendingNormalizationAuthority* authority) noexcept {
  if (authority == nullptr) return;
  if (authority->child != nullptr && authority->child != INVALID_HANDLE_VALUE) {
    CloseHandle(authority->child);
  }
  if (authority->directory != nullptr &&
      authority->directory != INVALID_HANDLE_VALUE) {
    CloseHandle(authority->directory);
  }
  WipeCustodyOwned(authority, sizeof(*authority));
}

bool MoveFileToResidue(
    ProtectedOperationsState* state,
    const Byte16& operation_id,
    const wchar_t* role,
    const ProtectedPath& source_path,
    std::uint64_t prospective_bytes,
    const ProtectedResidueProjection* expected_projection = nullptr,
    PendingNormalizationAuthority* retained_authority = nullptr) noexcept {
  if (state == nullptr || state->next_publication_sequence == 0U ||
      state->next_publication_sequence > kMaximumPublicationSequence) return false;
  const ProtectedFilesystemState& filesystem = state->filesystem;
  std::uint8_t ordinal = 0U;
  std::array<wchar_t, 80U> component{};
  ProtectedPath residue_path{};
  std::array<std::uint8_t, kJournalRecordBytes> source_bytes{};
  std::array<std::uint8_t, kJournalRecordBytes> final_bytes{};
  std::size_t source_length = 0U;
  std::size_t final_length = 0U;
  std::uint64_t opened_length = 0U;
  HANDLE retained_source = nullptr;
  ProtectedObjectIdentity source_identity{};
  ProtectedObjectIdentity opened_identity{};
  ProtectedObjectIdentity final_identity{};
  Byte32 source_hash{};
  Byte32 final_hash{};
  if (!PreflightResidueMove(
          *state,
          operation_id,
          role,
          prospective_bytes,
          &ordinal)) return false;
  bool source_valid = false;
  if (retained_authority != nullptr && retained_authority->child_present &&
      retained_authority->directory == nullptr &&
      retained_authority->child != nullptr &&
      retained_authority->child != INVALID_HANDLE_VALUE) {
    retained_source = retained_authority->child;
    retained_authority->child = nullptr;
    opened_length = retained_authority->child_length;
    source_length = retained_authority->child_bytes_length;
    opened_identity = retained_authority->child_identity;
    source_identity = retained_authority->child_identity;
    source_hash = retained_authority->child_hash;
    if (source_length <= source_bytes.size()) {
      std::memcpy(
          source_bytes.data(),
          retained_authority->child_bytes.data(),
          source_length);
      source_valid = true;
    }
  } else {
    source_valid = OpenProtectedExistingFileForRename(
                       filesystem,
                       source_path,
                       prospective_bytes,
                       &retained_source,
                       &opened_length,
                       &opened_identity) &&
        opened_length == prospective_bytes &&
        ReadProtectedOpenFile(
            filesystem,
            retained_source,
            source_bytes.data(),
            source_bytes.size(),
            &source_length,
            &source_identity) &&
        source_length == prospective_bytes &&
        source_identity.volume_serial_number ==
            opened_identity.volume_serial_number &&
        Equal(
            source_identity.file_id.data(),
            opened_identity.file_id.data(),
            source_identity.file_id.size()) &&
        ComputeSha256(source_bytes.data(), source_length, &source_hash);
  }
  if (!source_valid || opened_length != prospective_bytes ||
      source_length != prospective_bytes) {
    if (retained_source != nullptr && retained_source != INVALID_HANDLE_VALUE) {
      CloseHandle(retained_source);
    }
    WipeCustodyOwned(source_bytes.data(), source_bytes.size());
    WipeCustodyOwned(final_bytes.data(), final_bytes.size());
    return false;
  }
  const std::uint8_t expected_kind = EqualWide(role, 7U, L"journal")
      ? 2U
      : EqualWide(role, 6U, L"revoke") ? 3U : 0U;
  if (expected_projection != nullptr &&
      (!expected_projection->present || expected_kind == 0U ||
       !Equal(
           expected_projection->bytes.data(),
           operation_id.data(),
           operation_id.size()) ||
       expected_projection->bytes[16] != ordinal ||
       expected_projection->bytes[17] != expected_kind ||
       ReadU16(expected_projection->bytes.data() + 18U) !=
           state->next_publication_sequence ||
       ReadU64(expected_projection->bytes.data() + 20U) != source_length ||
       ReadU64(expected_projection->bytes.data() + 28U) !=
           source_identity.volume_serial_number ||
       !Equal(
           expected_projection->bytes.data() + 36U,
           source_identity.file_id.data(),
           source_identity.file_id.size()) ||
       !Equal(
           expected_projection->bytes.data() + 52U,
           source_hash.data(),
           source_hash.size()))) {
    CloseHandle(retained_source);
    WipeCustodyOwned(source_bytes.data(), source_bytes.size());
    WipeCustodyOwned(final_bytes.data(), final_bytes.size());
    return false;
  }
  const std::uint16_t publication_sequence = state->next_publication_sequence;
  std::uint8_t verified_ordinal = 0U;
  bool moved = SelectResidueOrdinal(
                         filesystem,
                         operation_id,
                         source_identity,
                         &verified_ordinal) &&
         verified_ordinal == ordinal &&
         BuildResidueComponent(
             operation_id, ordinal, publication_sequence, role, &component) &&
         ComposeProtectedChildPath(
             filesystem.quarantine_path, component.data(), &residue_path) &&
         FlushAndRenameProtectedFile(
             filesystem, retained_source, residue_path);
  if (retained_source != nullptr && retained_source != INVALID_HANDLE_VALUE) {
    CloseHandle(retained_source);
    retained_source = nullptr;
  }
  if (moved) {
    moved = ReadProtectedFinalFile(
                filesystem,
                residue_path,
                final_bytes.data(),
                final_bytes.size(),
                &final_length,
                &final_identity) &&
            final_length == source_length &&
            final_identity.volume_serial_number ==
                source_identity.volume_serial_number &&
            Equal(
                final_identity.file_id.data(),
                source_identity.file_id.data(),
                final_identity.file_id.size()) &&
            ComputeSha256(final_bytes.data(), final_length, &final_hash) &&
            Equal(final_hash.data(), source_hash.data(), final_hash.size()) &&
            Equal(final_bytes.data(), source_bytes.data(), source_length) &&
            ProtectedPathIsAbsentGuarded(filesystem, source_path);
  }
  WipeCustodyOwned(source_bytes.data(), source_bytes.size());
  WipeCustodyOwned(final_bytes.data(), final_bytes.size());
  if (moved) ++state->next_publication_sequence;
  return moved;
}

bool MoveDirectoryToResidue(
    ProtectedOperationsState* state,
    const Byte16& operation_id,
    const wchar_t* role,
    const ProtectedPath& source_path,
    std::uint64_t prospective_bytes,
    const wchar_t* retained_child_name,
    const ProtectedResidueProjection* expected_projection = nullptr,
    PendingNormalizationAuthority* retained_authority = nullptr) noexcept {
  if (state == nullptr || state->next_publication_sequence == 0U ||
      state->next_publication_sequence > kMaximumPublicationSequence) return false;
  const ProtectedFilesystemState& filesystem = state->filesystem;
  std::uint8_t ordinal = 0U;
  std::array<wchar_t, 80U> component{};
  ProtectedPath residue_path{};
  HANDLE source_directory = nullptr;
  HANDLE retained_child = nullptr;
  ProtectedObjectIdentity identity{};
  ProtectedObjectIdentity retained_child_identity{};
  std::uint64_t retained_child_length = 0U;
  std::array<std::uint8_t, kJournalRecordBytes - 1U> retained_child_bytes{};
  std::size_t retained_child_bytes_length = 0U;
  Byte32 retained_child_hash{};
  if (!PreflightResidueMove(
          *state,
          operation_id,
          role,
          prospective_bytes,
          &ordinal)) return false;
  ProtectedPath source_child_path{};
  bool child_valid = retained_child_name == nullptr;
  if (retained_child_name != nullptr && retained_authority != nullptr &&
      retained_authority->child_present &&
      retained_authority->child != nullptr &&
      retained_authority->child != INVALID_HANDLE_VALUE) {
    retained_child = retained_authority->child;
    retained_authority->child = nullptr;
    retained_child_length = retained_authority->child_length;
    retained_child_bytes_length = retained_authority->child_bytes_length;
    retained_child_identity = retained_authority->child_identity;
    retained_child_hash = retained_authority->child_hash;
    if (retained_child_bytes_length <= retained_child_bytes.size()) {
      std::memcpy(
          retained_child_bytes.data(),
          retained_authority->child_bytes.data(),
          retained_child_bytes_length);
      child_valid = true;
    }
  } else if (retained_child_name != nullptr) {
    child_valid = ComposeProtectedChildPath(
                      source_path, retained_child_name, &source_child_path) &&
        OpenProtectedExistingFileForParentRename(
            filesystem,
            source_child_path,
            prospective_bytes,
            &retained_child,
            &retained_child_length,
            &retained_child_identity) &&
        retained_child_length == prospective_bytes &&
        ReadProtectedOpenFile(
            filesystem,
            retained_child,
            retained_child_bytes.data(),
            retained_child_bytes.size(),
            &retained_child_bytes_length,
            &identity) &&
        retained_child_bytes_length == prospective_bytes &&
        identity.volume_serial_number ==
            retained_child_identity.volume_serial_number &&
        Equal(
            identity.file_id.data(),
            retained_child_identity.file_id.data(),
            identity.file_id.size()) &&
        ComputeSha256(
            retained_child_bytes.data(),
            retained_child_bytes_length,
            &retained_child_hash);
  }
  if (!child_valid || retained_child_length != prospective_bytes ||
      retained_child_bytes_length != prospective_bytes ||
      (retained_child_name != nullptr &&
       !FlushProtectedOpenFileForParentRename(
           filesystem, retained_child, false))) {
    if (retained_child != nullptr && retained_child != INVALID_HANDLE_VALUE) {
      CloseHandle(retained_child);
    }
    WipeCustodyOwned(
        retained_child_bytes.data(), retained_child_bytes.size());
    return false;
  }
  if (retained_authority != nullptr &&
      retained_authority->directory != nullptr &&
      retained_authority->directory != INVALID_HANDLE_VALUE) {
    source_directory = retained_authority->directory;
    retained_authority->directory = nullptr;
    identity = retained_authority->directory_identity;
  } else if (!OpenProtectedExistingDirectory(
                 filesystem,
                 source_path,
                 true,
                 &source_directory,
                 &identity)) {
    if (retained_child != nullptr && retained_child != INVALID_HANDLE_VALUE) {
      CloseHandle(retained_child);
    }
    WipeCustodyOwned(
        retained_child_bytes.data(), retained_child_bytes.size());
    return false;
  }
  std::array<std::uint8_t, 96U> source_closure{};
  WriteU16(source_closure.data(), 1U);
  IdentityBytes(identity, source_closure.data() + 4U);
  if (retained_child_name != nullptr) {
    source_closure[28] = 1U;
    IdentityBytes(retained_child_identity, source_closure.data() + 32U);
    WriteU64(
        source_closure.data() + 56U, retained_child_bytes_length);
    Copy32(retained_child_hash, source_closure.data() + 64U);
  }
  Byte32 source_closure_hash{};
  if (!HashDomain(
          kQuarantineClosureDomain,
          sizeof(kQuarantineClosureDomain) - 1U,
          source_closure.data(),
          source_closure.size(),
          &source_closure_hash) ||
      (expected_projection != nullptr &&
       (!expected_projection->present ||
        !Equal(
            expected_projection->bytes.data(),
            operation_id.data(),
            operation_id.size()) ||
        expected_projection->bytes[16] != ordinal ||
        expected_projection->bytes[17] != 1U ||
        ReadU16(expected_projection->bytes.data() + 18U) !=
            state->next_publication_sequence ||
        ReadU64(expected_projection->bytes.data() + 20U) !=
            retained_child_bytes_length ||
        ReadU64(expected_projection->bytes.data() + 28U) !=
            identity.volume_serial_number ||
        !Equal(
            expected_projection->bytes.data() + 36U,
            identity.file_id.data(),
            identity.file_id.size()) ||
        !Equal(
            expected_projection->bytes.data() + 52U,
            source_closure_hash.data(),
            source_closure_hash.size())))) {
    if (retained_child != nullptr && retained_child != INVALID_HANDLE_VALUE) {
      CloseHandle(retained_child);
    }
    CloseHandle(source_directory);
    WipeCustodyOwned(
        retained_child_bytes.data(), retained_child_bytes.size());
    return false;
  }
  if (retained_child != nullptr && retained_child != INVALID_HANDLE_VALUE) {
    CloseHandle(retained_child);
    retained_child = nullptr;
  }
  DirectoryMoveAuthority& move_authority =
      g_directory_move_authority_scratch;
  bool moved = CaptureDirectoryMoveAuthority(
      filesystem, source_path, source_directory, &move_authority);
  moved = moved && EqualMoveIdentity(move_authority.root_identity, identity) &&
      !move_authority.nested_directory_present &&
      move_authority.root_file_count ==
          (retained_child_name == nullptr ? 0U : 1U);
  if (moved && retained_child_name != nullptr) {
    const DirectoryMoveFileAuthority& captured = move_authority.root_files[0];
    moved = EqualWide(
                captured.name.data(),
                captured.name_length,
                retained_child_name) &&
        captured.byte_length == prospective_bytes &&
        captured.byte_length == retained_child_bytes_length &&
        EqualMoveIdentity(captured.identity, retained_child_identity) &&
        Equal(
            captured.content_hash.data(),
            retained_child_hash.data(),
            captured.content_hash.size()) &&
        Equal(
            captured.bytes.data(),
            retained_child_bytes.data(),
            retained_child_bytes_length);
  }
  const std::uint16_t publication_sequence = state->next_publication_sequence;
  std::uint8_t verified_ordinal = 0U;
  moved = moved && SelectResidueOrdinal(
                         filesystem,
                         operation_id,
                         identity,
                         &verified_ordinal) &&
         verified_ordinal == ordinal &&
         BuildResidueComponent(
             operation_id, ordinal, publication_sequence, role, &component) &&
         ComposeProtectedChildPath(
             filesystem.quarantine_path, component.data(), &residue_path) &&
         MoveDirectoryWithCapturedAuthority(
             filesystem,
             source_path,
             residue_path,
             &source_directory,
             move_authority);
  if (moved && retained_child != nullptr) {
    moved = FlushProtectedOpenFileForParentRename(
        filesystem, retained_child, true);
  }
  if (retained_child != nullptr && retained_child != INVALID_HANDLE_VALUE) {
    CloseHandle(retained_child);
    retained_child = nullptr;
  }
  if (source_directory != nullptr && source_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(source_directory);
    source_directory = nullptr;
  }
  HANDLE final_directory = nullptr;
  ProtectedObjectIdentity final_directory_identity{};
  std::size_t final_entry_count = 0U;
  if (moved) {
    moved = OpenProtectedExistingDirectory(
                filesystem,
                residue_path,
                false,
                &final_directory,
                &final_directory_identity) &&
            final_directory_identity.volume_serial_number ==
                identity.volume_serial_number &&
            Equal(
                final_directory_identity.file_id.data(),
                identity.file_id.data(),
                identity.file_id.size()) &&
            EnumerateProtectedDirectory(
                filesystem,
                final_directory,
                &g_recovery_entries,
                &final_entry_count) &&
            final_entry_count == (retained_child_name == nullptr ? 0U : 1U) &&
            ProtectedPathIsAbsentGuarded(filesystem, source_path);
  }
  if (final_directory != nullptr && final_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(final_directory);
  }
  if (moved && retained_child_name != nullptr) {
    ProtectedPath final_child_path{};
    std::array<std::uint8_t, kJournalRecordBytes - 1U> bytes{};
    std::size_t length = 0U;
    ProtectedObjectIdentity final_child_identity{};
    Byte32 final_child_hash{};
    moved = EqualWide(
                g_recovery_entries[0].name.data(),
                g_recovery_entries[0].name_length,
                retained_child_name) &&
            g_recovery_entries[0].byte_length == prospective_bytes &&
            (g_recovery_entries[0].attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
            ComposeProtectedChildPath(
                residue_path, retained_child_name, &final_child_path) &&
            ReadProtectedFinalFile(
                filesystem,
                final_child_path,
                bytes.data(),
                bytes.size(),
                &length,
                &final_child_identity) &&
            length == prospective_bytes &&
            length == retained_child_bytes_length &&
            final_child_identity.volume_serial_number ==
                retained_child_identity.volume_serial_number &&
            Equal(
                final_child_identity.file_id.data(),
                retained_child_identity.file_id.data(),
                retained_child_identity.file_id.size()) &&
            ComputeSha256(bytes.data(), length, &final_child_hash) &&
            Equal(
                final_child_hash.data(),
                retained_child_hash.data(),
                final_child_hash.size()) &&
            Equal(
                bytes.data(),
                retained_child_bytes.data(),
                length);
    WipeCustodyOwned(bytes.data(), bytes.size());
  }
  WipeCustodyOwned(
      retained_child_bytes.data(), retained_child_bytes.size());
  WipeCustodyOwned(&move_authority, sizeof(move_authority));
  if (moved) ++state->next_publication_sequence;
  return moved;
}

bool ParseOperationComponent(
    const ProtectedDirectoryEntry& entry,
    Byte16* operation_id) noexcept {
  if (operation_id == nullptr || entry.name_length != 35U ||
      entry.name[0] != L'o' || entry.name[1] != L'p' || entry.name[2] != L'-') {
    return false;
  }
  operation_id->fill(0U);
  for (std::size_t index = 0U; index < 16U; ++index) {
    const int high = HexNibble(entry.name[3U + index * 2U]);
    const int low = HexNibble(entry.name[4U + index * 2U]);
    if (high < 0 || low < 0) return false;
    (*operation_id)[index] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return !Equal(operation_id->data(), Byte16{}.data(), operation_id->size());
}

bool ParsePendingOperationComponent(
    const ProtectedDirectoryEntry& entry,
    Byte16* operation_id) noexcept {
  if (operation_id == nullptr || entry.name_length != 44U ||
      entry.name[0] != L'.' || entry.name[1] != L'o' ||
      entry.name[2] != L'p' || entry.name[3] != L'-' ||
      !EqualWide(entry.name.data() + 36U, 8U, L".pending")) {
    return false;
  }
  operation_id->fill(0U);
  for (std::size_t index = 0U; index < 16U; ++index) {
    const int high = HexNibble(entry.name[4U + index * 2U]);
    const int low = HexNibble(entry.name[5U + index * 2U]);
    if (high < 0 || low < 0) return false;
    (*operation_id)[index] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return !AllZero(operation_id->data(), operation_id->size());
}

bool ParseRecordComponent(
    const ProtectedDirectoryEntry& entry,
    std::uint32_t* sequence,
    JournalRecordKind* kind) noexcept {
  if (sequence == nullptr || kind == nullptr || entry.name_length < 20U ||
      entry.name[0] != L's' || entry.name[9] != L'-') return false;
  std::uint32_t parsed_sequence = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    const int nibble = HexNibble(entry.name[1U + index]);
    if (nibble < 0) return false;
    parsed_sequence = (parsed_sequence << 4U) | static_cast<std::uint32_t>(nibble);
  }
  const wchar_t* suffix = entry.name.data() + 10U;
  const std::size_t suffix_length = entry.name_length - 10U;
  if (EqualWide(suffix, suffix_length, L"prepared.gcjr")) {
    *kind = JournalRecordKind::Prepared;
  } else if (EqualWide(suffix, suffix_length, L"attempt.gcjr")) {
    *kind = JournalRecordKind::Attempt;
  } else if (EqualWide(suffix, suffix_length, L"outcome.gcjr")) {
    *kind = JournalRecordKind::Outcome;
  } else if (EqualWide(suffix, suffix_length, L"committed.gcjr")) {
    *kind = JournalRecordKind::Committed;
  } else if (EqualWide(suffix, suffix_length, L"quarantined.gcjr")) {
    *kind = JournalRecordKind::Quarantined;
  } else {
    return false;
  }
  *sequence = parsed_sequence;
  return true;
}

bool ParsePendingRecordComponent(
    const ProtectedDirectoryEntry& entry,
    std::uint32_t* sequence,
    JournalRecordKind* kind) noexcept {
  if (sequence == nullptr || kind == nullptr || entry.name_length < 24U ||
      entry.name[0] != L'.' || entry.name[1] != L's' ||
      entry.name[10] != L'-') return false;
  std::uint32_t parsed_sequence = 0U;
  for (std::size_t index = 0U; index < 8U; ++index) {
    const int nibble = HexNibble(entry.name[2U + index]);
    if (nibble < 0) return false;
    parsed_sequence =
        (parsed_sequence << 4U) | static_cast<std::uint32_t>(nibble);
  }
  const wchar_t* suffix = entry.name.data() + 11U;
  const std::size_t suffix_length = entry.name_length - 11U;
  if (EqualWide(suffix, suffix_length, L"prepared.pending")) {
    *kind = JournalRecordKind::Prepared;
  } else if (EqualWide(suffix, suffix_length, L"attempt.pending")) {
    *kind = JournalRecordKind::Attempt;
  } else if (EqualWide(suffix, suffix_length, L"outcome.pending")) {
    *kind = JournalRecordKind::Outcome;
  } else if (EqualWide(suffix, suffix_length, L"committed.pending")) {
    *kind = JournalRecordKind::Committed;
  } else if (EqualWide(suffix, suffix_length, L"quarantined.pending")) {
    *kind = JournalRecordKind::Quarantined;
  } else {
    return false;
  }
  *sequence = parsed_sequence;
  return true;
}

const wchar_t* JournalKindLiteral(JournalRecordKind kind) noexcept {
  switch (kind) {
    case JournalRecordKind::Prepared: return L"prepared";
    case JournalRecordKind::Attempt: return L"attempt";
    case JournalRecordKind::Outcome: return L"outcome";
    case JournalRecordKind::Committed: return L"committed";
    case JournalRecordKind::Quarantined: return L"quarantined";
  }
  return nullptr;
}

const ProtectedDirectoryEntry* FindRecordEntry(
    std::size_t count,
    std::uint32_t wanted_sequence,
    JournalRecordKind* kind) noexcept {
  const ProtectedDirectoryEntry* found = nullptr;
  for (std::size_t index = 0U; index < count; ++index) {
    std::uint32_t sequence = 0U;
    JournalRecordKind parsed_kind{};
    if (!ParseRecordComponent(g_recovery_entries[index], &sequence, &parsed_kind)) continue;
    if (sequence == wanted_sequence) {
      if (found != nullptr) return nullptr;
      found = &g_recovery_entries[index];
      *kind = parsed_kind;
    }
  }
  return found;
}

const ProtectedDirectoryEntry* FindNamedEntry(
    std::size_t count,
    const wchar_t* name) noexcept {
  const ProtectedDirectoryEntry* found = nullptr;
  for (std::size_t index = 0U; index < count; ++index) {
    if (EqualWide(
            g_recovery_entries[index].name.data(),
            g_recovery_entries[index].name_length,
            name)) {
      if (found != nullptr) return nullptr;
      found = &g_recovery_entries[index];
    }
  }
  return found;
}

bool ReadJournalRecord(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& operation_path,
    const ProtectedDirectoryEntry& entry,
    JournalRecord* record) noexcept {
  if (record == nullptr) return false;
  ProtectedPath record_path{};
  ProtectedObjectIdentity identity{};
  std::size_t length = 0U;
  return ComposeProtectedChildPath(operation_path, entry.name.data(), &record_path) &&
         ReadProtectedExistingFile(
             filesystem,
             record_path,
             record->bytes.data(),
             record->bytes.size(),
             &length,
             &identity) &&
         length == kJournalRecordBytes;
}

bool ValidatePreparedRecordAuthority(
    const JournalRecord& prepared,
    const Byte16& operation_id) noexcept {
  JournalRecordKind kind{};
  std::uint32_t sequence = UINT32_MAX;
  Byte32 record_hash{};
  if (!ValidateJournalRecord(prepared, &kind, &sequence, &record_hash) ||
      kind != JournalRecordKind::Prepared || sequence != 0U ||
      !Equal(prepared.bytes.data() + 16U, operation_id.data(), 16U)) {
    return false;
  }
  const std::uint16_t body_length = ReadU16(prepared.bytes.data() + 38U);
  if (prepared.bytes[32] == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    CreateKeysetRequest request{};
    return DecodeCreateKeysetRequest(
               prepared.bytes.data() + 112U, body_length, &request) &&
           Equal(request.operation_id.data(), operation_id.data(), 16U);
  }
  if (prepared.bytes[32] ==
      static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    RevokeKeysetRequest request{};
    return DecodeRevokeKeysetRequest(
               prepared.bytes.data() + 112U, body_length, &request) &&
           Equal(request.operation_id.data(), operation_id.data(), 16U);
  }
  return false;
}

bool ValidatePendingRecordTransition(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& operation_path,
    const Byte16& operation_id,
    std::size_t entry_count,
    const JournalRecord& pending,
    JournalRecordKind pending_kind,
    std::uint32_t pending_sequence) noexcept {
  if (pending_sequence == 0U) {
    return pending_kind == JournalRecordKind::Prepared &&
           ValidatePreparedRecordAuthority(pending, operation_id);
  }
  JournalRecord prepared{};
  JournalRecord prior{};
  JournalRecord last_outcome{};
  bool outcome_present = false;
  bool committed_present = false;
  bool quarantined_present = false;
  for (std::uint32_t sequence = 0U; sequence < pending_sequence; ++sequence) {
    JournalRecordKind filename_kind{};
    const ProtectedDirectoryEntry* entry =
        FindRecordEntry(entry_count, sequence, &filename_kind);
    JournalRecord current{};
    JournalRecordKind record_kind{};
    std::uint32_t record_sequence = UINT32_MAX;
    Byte32 record_hash{};
    if (entry == nullptr ||
        !ReadJournalRecord(filesystem, operation_path, *entry, &current) ||
        !ValidateJournalRecord(
            current, &record_kind, &record_sequence, &record_hash) ||
        record_kind != filename_kind || record_sequence != sequence) return false;
    if (sequence == 0U) {
      if (!ValidatePreparedRecordAuthority(current, operation_id)) return false;
      prepared = current;
    } else if (!ValidateJournalTransition(prepared, prior, current)) {
      return false;
    }
    if (record_kind == JournalRecordKind::Outcome) {
      if (outcome_present || committed_present || quarantined_present) return false;
      last_outcome = current;
      outcome_present = true;
    } else if (record_kind == JournalRecordKind::Committed) {
      if (!outcome_present || committed_present || quarantined_present ||
          !Equal(
              current.bytes.data() + 400U,
              last_outcome.bytes.data() + 400U,
              432U)) return false;
      committed_present = true;
    } else if (record_kind == JournalRecordKind::Quarantined) {
      if (outcome_present || committed_present || quarantined_present) return false;
      quarantined_present = true;
    }
    prior = current;
  }
  if (!ValidateJournalTransition(prepared, prior, pending)) return false;
  if (pending_kind == JournalRecordKind::Outcome &&
      (outcome_present || committed_present || quarantined_present)) return false;
  if (pending_kind == JournalRecordKind::Committed) {
    return outcome_present && !committed_present && !quarantined_present &&
           Equal(
               pending.bytes.data() + 400U,
               last_outcome.bytes.data() + 400U,
               432U);
  }
  if (pending_kind == JournalRecordKind::Quarantined) {
    return !outcome_present && !committed_present && !quarantined_present;
  }
  return !committed_present && !quarantined_present;
}

bool NormalizePendingOperationDirectory(
    ProtectedOperationsState* state,
    const ProtectedDirectoryEntry& entry,
    const ProtectedResidueProjection* expected_residue = nullptr) noexcept {
  if (state == nullptr) return false;
  const ProtectedFilesystemState& filesystem = state->filesystem;
  Byte16 operation_id{};
  ProtectedPath pending_path{};
  HANDLE directory = nullptr;
  ProtectedObjectIdentity directory_identity{};
  if (!ParsePendingOperationComponent(entry, &operation_id) ||
      (entry.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
      (entry.attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U ||
      !ComposeProtectedChildPath(
          filesystem.journal_path, entry.name.data(), &pending_path) ||
      !OpenProtectedExistingDirectory(
          filesystem,
          pending_path,
          false,
          &directory,
          &directory_identity)) return false;
  std::size_t count = 0U;
  if (!EnumerateProtectedDirectory(
          filesystem, directory, &g_recovery_entries, &count) ||
      count > 1U) {
    CloseHandle(directory);
    return false;
  }
  CloseHandle(directory);
  if (count == 0U) {
    return MoveDirectoryToResidue(
        state,
        operation_id,
        L"bootstrap",
        pending_path,
        0U,
        nullptr,
        expected_residue);
  }
  ProtectedDirectoryEntry& child = g_recovery_entries[0];
  std::uint32_t sequence = UINT32_MAX;
  JournalRecordKind kind{};
  const bool pending_record =
      ParsePendingRecordComponent(child, &sequence, &kind);
  const bool final_record = ParseRecordComponent(child, &sequence, &kind);
  if ((!pending_record && !final_record) || sequence != 0U ||
      kind != JournalRecordKind::Prepared ||
      (child.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
      child.byte_length > kJournalRecordBytes) return false;
  if (child.byte_length < kJournalRecordBytes) {
    return MoveDirectoryToResidue(
        state,
        operation_id,
        L"bootstrap",
        pending_path,
        child.byte_length,
        child.name.data(),
        expected_residue);
  }
  JournalRecord prepared{};
  std::uint16_t publication_sequence = 0U;
  if (!ReadJournalRecord(filesystem, pending_path, child, &prepared) ||
      !ValidatePreparedRecordAuthority(prepared, operation_id) ||
      !GetJournalPublicationSequence(prepared, &publication_sequence) ||
      publication_sequence != state->next_publication_sequence) {
    return false;
  }
  if (pending_record) {
    ProtectedPath child_pending_path{};
    ProtectedPath child_final_path{};
    std::array<wchar_t, 48U> final_component{};
    ProtectedObjectIdentity promoted_identity{};
    if (!BuildRecordComponent(
            0U, L"prepared", false, &final_component) ||
        !ComposeProtectedChildPath(
            pending_path, child.name.data(), &child_pending_path) ||
        !ComposeProtectedChildPath(
            pending_path, final_component.data(), &child_final_path) ||
        !PromoteProtectedExistingFile(
            filesystem,
            child_pending_path,
            child_final_path,
            true,
            &promoted_identity)) return false;
    return true;
  }
  std::array<wchar_t, 48U> final_component{};
  ProtectedPath final_path{};
  HANDLE pending_directory = nullptr;
  ProtectedObjectIdentity pending_identity{};
  DirectoryMoveAuthority& move_authority =
      g_directory_move_authority_scratch;
  bool normalized = BuildOperationComponent(
                        operation_id, false, &final_component) &&
      ComposeProtectedChildPath(
          filesystem.journal_path, final_component.data(), &final_path) &&
      OpenProtectedExistingDirectory(
          filesystem,
          pending_path,
          true,
          &pending_directory,
          &pending_identity) &&
      CaptureDirectoryMoveAuthority(
          filesystem,
          pending_path,
          pending_directory,
          &move_authority) &&
      EqualMoveIdentity(pending_identity, move_authority.root_identity) &&
      MoveDirectoryWithCapturedAuthority(
          filesystem,
          pending_path,
          final_path,
          &pending_directory,
          move_authority);
  if (pending_directory != nullptr && pending_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(pending_directory);
  }
  WipeCustodyOwned(&move_authority, sizeof(move_authority));
  return normalized;
}

enum class PendingNormalizationKind : std::uint8_t {
  None = 0U,
  OperationDirectory = 1U,
  JournalRecord = 2U,
  RevokeCandidate = 3U,
};

struct PendingNormalizationSource final {
  PendingNormalizationKind kind = PendingNormalizationKind::None;
  bool quarantine_location = false;
  Byte16 operation_id{};
  ProtectedPath operation_path{};
  ProtectedDirectoryEntry root_entry{};
  ProtectedDirectoryEntry child_entry{};
  PendingNormalizationAuthority authority{};
};

bool PreparePendingNormalizationAuthority(
    ProtectedOperationsState* state,
    PendingNormalizationSource* source) noexcept {
  if (state == nullptr || source == nullptr ||
      source->kind == PendingNormalizationKind::None) return false;
  ClosePendingNormalizationAuthority(&source->authority);
  PendingNormalizationAuthority& authority = source->authority;
  ProtectedObjectIdentity read_identity{};
  if (source->kind == PendingNormalizationKind::OperationDirectory) {
    if (!OpenProtectedExistingDirectory(
            state->filesystem,
            source->operation_path,
            true,
            &authority.directory,
            &authority.directory_identity)) return false;
    std::size_t child_count = 0U;
    const std::size_t expected_count =
        source->child_entry.name_length == 0U ? 0U : 1U;
    if (!EnumerateProtectedDirectory(
            state->filesystem,
            authority.directory,
            &g_recovery_entries,
            &child_count) ||
        child_count != expected_count ||
        (child_count == 1U &&
         (!EqualWide(
              g_recovery_entries[0].name.data(),
              g_recovery_entries[0].name_length,
              source->child_entry.name.data()) ||
          g_recovery_entries[0].attributes != source->child_entry.attributes ||
          g_recovery_entries[0].byte_length !=
              source->child_entry.byte_length))) {
      ClosePendingNormalizationAuthority(&authority);
      return false;
    }
    if (child_count == 0U) return true;
    ProtectedPath child_path{};
    if (!ComposeProtectedChildPath(
            source->operation_path,
            source->child_entry.name.data(),
            &child_path) ||
        source->child_entry.byte_length > authority.child_bytes.size() ||
        !OpenProtectedExistingFileForParentRename(
            state->filesystem,
            child_path,
            source->child_entry.byte_length,
            &authority.child,
            &authority.child_length,
            &authority.child_identity) ||
#if defined(GOATCITADEL_PROVISIONER_TESTING)
        (++g_recovery_evidence.source_read_count, false) ||
#endif
        authority.child_length != source->child_entry.byte_length ||
        !ReadProtectedOpenFile(
            state->filesystem,
            authority.child,
            authority.child_bytes.data(),
            authority.child_bytes.size(),
            &authority.child_bytes_length,
            &read_identity) ||
        authority.child_bytes_length != authority.child_length ||
        read_identity.volume_serial_number !=
            authority.child_identity.volume_serial_number ||
        !Equal(
            read_identity.file_id.data(),
            authority.child_identity.file_id.data(),
            read_identity.file_id.size()) ||
        !ComputeSha256(
            authority.child_bytes.data(),
            authority.child_bytes_length,
            &authority.child_hash)) {
      ClosePendingNormalizationAuthority(&authority);
      return false;
    }
    authority.child_present = true;
    return true;
  }
  ProtectedPath child_path{};
  if (!ComposeProtectedChildPath(
          source->operation_path,
          source->child_entry.name.data(),
          &child_path) ||
      source->child_entry.byte_length > authority.child_bytes.size() ||
      !OpenProtectedExistingFileForRename(
          state->filesystem,
          child_path,
          source->child_entry.byte_length,
          &authority.child,
          &authority.child_length,
          &authority.child_identity) ||
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      (++g_recovery_evidence.source_read_count, false) ||
#endif
      authority.child_length != source->child_entry.byte_length ||
      !ReadProtectedOpenFile(
          state->filesystem,
          authority.child,
          authority.child_bytes.data(),
          authority.child_bytes.size(),
          &authority.child_bytes_length,
          &read_identity) ||
      authority.child_bytes_length != authority.child_length ||
      read_identity.volume_serial_number !=
          authority.child_identity.volume_serial_number ||
      !Equal(
          read_identity.file_id.data(),
          authority.child_identity.file_id.data(),
          read_identity.file_id.size()) ||
      !ComputeSha256(
          authority.child_bytes.data(),
          authority.child_bytes_length,
          &authority.child_hash)) {
    ClosePendingNormalizationAuthority(&authority);
    return false;
  }
  authority.child_present = true;
  return true;
}

bool RegisterPublicationSequence(
    std::uint16_t publication_sequence,
    std::size_t* count) noexcept {
  if (count == nullptr || publication_sequence == 0U ||
      publication_sequence > kMaximumPublicationSequence ||
      g_publication_sequences[publication_sequence]) return false;
  g_publication_sequences[publication_sequence] = true;
  ++(*count);
  return *count <= kMaximumPublicationSequence;
}

RecoveryPublicationEventKind RecordPublicationEventKind(
    JournalRecordKind kind,
    std::uint8_t flags) noexcept {
  if (kind == JournalRecordKind::Prepared) {
    return RecoveryPublicationEventKind::Prepared;
  }
  if (kind == JournalRecordKind::Attempt) {
    if (flags == 0U) return RecoveryPublicationEventKind::AttemptInitial;
    if (flags == 1U) return RecoveryPublicationEventKind::AttemptRecovery;
    if (flags == 2U) return RecoveryPublicationEventKind::AttemptReplay;
    return RecoveryPublicationEventKind::None;
  }
  if (kind == JournalRecordKind::Outcome) {
    return RecoveryPublicationEventKind::Outcome;
  }
  if (kind == JournalRecordKind::Committed) {
    return RecoveryPublicationEventKind::Committed;
  }
  if (kind == JournalRecordKind::Quarantined) {
    return RecoveryPublicationEventKind::Quarantined;
  }
  return RecoveryPublicationEventKind::None;
}

bool RegisterPublicationEvent(
    std::uint16_t publication_sequence,
    const Byte16& operation_id,
    RecoveryPublicationEventKind kind,
    std::uint8_t opcode,
    std::uint8_t residue_ordinal,
    const JournalRecord* record = nullptr) noexcept {
  if (publication_sequence == 0U ||
      publication_sequence > kMaximumPublicationSequence ||
      kind == RecoveryPublicationEventKind::None ||
      g_publication_events[publication_sequence].kind !=
          RecoveryPublicationEventKind::None ||
      AllZero(operation_id.data(), operation_id.size())) {
    return false;
  }
  g_publication_events[publication_sequence].kind = kind;
  g_publication_events[publication_sequence].opcode = opcode;
  g_publication_events[publication_sequence].residue_ordinal = residue_ordinal;
  g_publication_events[publication_sequence].operation_id = operation_id;
  if (record != nullptr) {
    g_publication_events[publication_sequence].record_present = true;
    g_publication_events[publication_sequence].record = *record;
  }
  return true;
}

const RecoveryPublicationEvent* RecoveryPublicationEventAt(
    const RecoveryPublicationEvent* events,
    std::size_t event_count,
    const RecoveryPublicationEvent* provisional_event,
    std::size_t index) noexcept {
  if (events == nullptr || index > event_count ||
      (index == event_count && provisional_event == nullptr)) return nullptr;
  return index == event_count ? provisional_event : &events[index];
}

bool ValidateRecoveryPublicationEvents(
    const RecoveryPublicationEvent* events,
    std::size_t event_count,
    const RecoveryPublicationEvent* provisional_event = nullptr) noexcept {
  if (events == nullptr || event_count > kMaximumPublicationSequence ||
      (provisional_event != nullptr &&
       event_count >= kMaximumPublicationSequence)) {
    return false;
  }
  enum class OperationLifecycle : std::uint8_t {
    Unseen = 0U,
    Bootstrap = 1U,
    Active = 2U,
    Committed = 3U,
    Quarantined = 4U,
  };
  struct OperationEventState final {
    bool present = false;
    Byte16 operation_id{};
    OperationLifecycle lifecycle = OperationLifecycle::Unseen;
    std::uint8_t opcode = 0U;
    std::uint8_t next_residue_ordinal = 0U;
    std::uint32_t attempt_count = 0U;
    bool outcome_seen = false;
    bool effect_authorized = false;
  };
  std::array<OperationEventState, kMaximumOperationIds> operation_states{};
  std::size_t operation_state_count = 0U;
  bool operation_active = false;
  Byte16 active_operation_id{};
  const std::size_t total_count =
      event_count + (provisional_event == nullptr ? 0U : 1U);
  for (std::size_t index = 0U; index < total_count; ++index) {
    const RecoveryPublicationEvent* event_pointer = RecoveryPublicationEventAt(
        events, event_count, provisional_event, index);
    if (event_pointer == nullptr) return false;
    const RecoveryPublicationEvent& event = *event_pointer;
    if (event.kind == RecoveryPublicationEventKind::None ||
        AllZero(event.operation_id.data(), event.operation_id.size())) {
      return false;
    }
    OperationEventState* operation = nullptr;
    for (std::size_t state_index = 0U;
         state_index < operation_state_count;
         ++state_index) {
      if (operation_states[state_index].operation_id == event.operation_id) {
        operation = &operation_states[state_index];
        break;
      }
    }
    if (operation == nullptr) {
      if (operation_state_count >= operation_states.size()) return false;
      operation = &operation_states[operation_state_count++];
      operation->present = true;
      operation->operation_id = event.operation_id;
    }
    const bool active_owner = operation_active &&
        event.operation_id == active_operation_id &&
        operation->lifecycle == OperationLifecycle::Active;
    const bool create = operation->opcode ==
        static_cast<std::uint8_t>(Opcode::CreateKeyset);
    const bool revoke = operation->opcode ==
        static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset);
    switch (event.kind) {
      case RecoveryPublicationEventKind::Prepared:
        if (operation_active ||
            operation->lifecycle != OperationLifecycle::Unseen ||
            (event.opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
             event.opcode !=
                 static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset))) {
          return false;
        }
        operation_active = true;
        active_operation_id = event.operation_id;
        operation->lifecycle = OperationLifecycle::Active;
        operation->opcode = event.opcode;
        break;
      case RecoveryPublicationEventKind::AttemptInitial:
        if (!active_owner || operation->outcome_seen ||
            operation->attempt_count != 0U ||
            operation->attempt_count >= kMaximumJournalAttempts) return false;
        ++operation->attempt_count;
        operation->effect_authorized = true;
        break;
      case RecoveryPublicationEventKind::AttemptRecovery:
        if (!active_owner ||
            operation->attempt_count >= kMaximumJournalAttempts) return false;
        ++operation->attempt_count;
        operation->effect_authorized = true;
        break;
      case RecoveryPublicationEventKind::AttemptReplay:
        if (operation_active ||
            operation->lifecycle != OperationLifecycle::Committed ||
            operation->attempt_count >= kMaximumJournalAttempts) return false;
        ++operation->attempt_count;
        break;
      case RecoveryPublicationEventKind::Outcome:
        if (!active_owner || operation->outcome_seen ||
            operation->attempt_count == 0U ||
            !operation->effect_authorized || (!create && !revoke)) return false;
        operation->outcome_seen = true;
        break;
      case RecoveryPublicationEventKind::Committed:
        if (!active_owner || !operation->outcome_seen ||
            operation->attempt_count == 0U ||
            !operation->effect_authorized) return false;
        operation->lifecycle = OperationLifecycle::Committed;
        operation_active = false;
        active_operation_id.fill(0U);
        break;
      case RecoveryPublicationEventKind::Quarantined:
        if (!active_owner || !create || operation->outcome_seen ||
            operation->attempt_count == 0U ||
            !operation->effect_authorized) return false;
        operation->lifecycle = OperationLifecycle::Quarantined;
        operation_active = false;
        active_operation_id.fill(0U);
        break;
      case RecoveryPublicationEventKind::BootstrapResidue:
        if (operation_active ||
            operation->lifecycle != OperationLifecycle::Unseen ||
            event.residue_ordinal != 0U) return false;
        operation->lifecycle = OperationLifecycle::Bootstrap;
        operation->next_residue_ordinal = 1U;
        break;
      case RecoveryPublicationEventKind::JournalResidue:
        if (event.residue_ordinal != operation->next_residue_ordinal ||
            !((active_owner &&
               operation->lifecycle == OperationLifecycle::Active) ||
              (!operation_active &&
               operation->lifecycle == OperationLifecycle::Committed))) {
          return false;
        }
        ++operation->next_residue_ordinal;
        break;
      case RecoveryPublicationEventKind::RevokeResidue:
        if (!active_owner || !revoke || operation->outcome_seen ||
            !operation->effect_authorized ||
            event.residue_ordinal != operation->next_residue_ordinal) {
          return false;
        }
        ++operation->next_residue_ordinal;
        operation->effect_authorized = false;
        break;
      default:
        return false;
    }
  }
  return true;
}

bool FinalizePublicationSequenceInventory(
    std::size_t publication_count,
    std::uint16_t* next_publication_sequence) noexcept {
  if (next_publication_sequence == nullptr ||
      publication_count > kMaximumPublicationSequence) return false;
  for (std::size_t sequence = 1U; sequence <= publication_count; ++sequence) {
    if (!g_publication_sequences[sequence]) return false;
  }
  *next_publication_sequence =
      static_cast<std::uint16_t>(publication_count + 1U);
  return true;
}

bool SetPendingNormalizationSource(
    const PendingNormalizationSource& candidate,
    PendingNormalizationSource* selected,
    std::size_t* count) noexcept {
  if (selected == nullptr || count == nullptr ||
      candidate.kind == PendingNormalizationKind::None || ++(*count) > 1U) {
    return false;
  }
  *selected = candidate;
  return true;
}

bool InventoryOperationPublications(
    ProtectedOperationsState* state,
    const ProtectedPath& parent_path,
    const ProtectedDirectoryEntry& root_entry,
    bool quarantine_location,
    bool pending_operation_directory,
    std::size_t* publication_count,
    PendingNormalizationSource* pending_source,
    std::size_t* pending_source_count) noexcept {
  if (state == nullptr || publication_count == nullptr ||
      pending_source == nullptr || pending_source_count == nullptr) return false;
  Byte16 operation_id{};
  if (pending_operation_directory
          ? !ParsePendingOperationComponent(root_entry, &operation_id)
          : !ParseOperationComponent(root_entry, &operation_id)) return false;
  ProtectedPath operation_path{};
  HANDLE directory = nullptr;
  ProtectedObjectIdentity identity{};
  if ((root_entry.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
      (root_entry.attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U ||
      !ComposeProtectedChildPath(
          parent_path, root_entry.name.data(), &operation_path) ||
      !OpenProtectedExistingDirectory(
          state->filesystem, operation_path, false, &directory, &identity)) {
    return false;
  }
  std::size_t entry_count = 0U;
  if (!EnumerateProtectedDirectory(
          state->filesystem, directory, &g_recovery_entries, &entry_count)) {
    CloseHandle(directory);
    return false;
  }
  CloseHandle(directory);
  if (pending_operation_directory && entry_count > 1U) return false;
  std::array<JournalRecord, kMaximumJournalRecordsPerOperation> final_records{};
  std::array<bool, kMaximumJournalRecordsPerOperation> final_record_present{};
  std::size_t final_record_count = 0U;
  bool candidate_present = false;
  bool candidate_is_revoke = false;
  ProtectedDirectoryEntry candidate_entry{};
  if (pending_operation_directory) {
    PendingNormalizationSource candidate{};
    candidate.kind = PendingNormalizationKind::OperationDirectory;
    candidate.operation_id = operation_id;
    candidate.operation_path = operation_path;
    candidate.root_entry = root_entry;
    if (!SetPendingNormalizationSource(
            candidate, pending_source, pending_source_count)) return false;
  }
  for (std::size_t index = 0U; index < entry_count; ++index) {
    std::uint32_t record_sequence = 0U;
    JournalRecordKind filename_kind{};
    if (ParseRecordComponent(
            g_recovery_entries[index], &record_sequence, &filename_kind)) {
      JournalRecord record{};
      JournalRecordKind encoded_kind{};
      std::uint32_t encoded_sequence = UINT32_MAX;
      Byte32 hash{};
      std::uint16_t publication_sequence = 0U;
      if ((g_recovery_entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
          g_recovery_entries[index].byte_length != kJournalRecordBytes ||
          !ReadJournalRecord(
              state->filesystem,
              operation_path,
              g_recovery_entries[index],
              &record) ||
          !ValidateJournalRecord(
              record, &encoded_kind, &encoded_sequence, &hash) ||
          encoded_kind != filename_kind || encoded_sequence != record_sequence ||
          encoded_sequence >= final_records.size() ||
          final_record_present[encoded_sequence] ||
          !GetJournalPublicationSequence(record, &publication_sequence) ||
          (!pending_operation_directory &&
           !RegisterPublicationSequence(publication_sequence, publication_count))) {
        return false;
      }
      final_records[encoded_sequence] = record;
      final_record_present[encoded_sequence] = true;
      ++final_record_count;
      if (pending_operation_directory) {
        pending_source->child_entry = g_recovery_entries[index];
      }
      continue;
    }
    JournalRecordKind pending_kind{};
    if (ParsePendingRecordComponent(
            g_recovery_entries[index], &record_sequence, &pending_kind)) {
      if (pending_operation_directory) {
        pending_source->child_entry = g_recovery_entries[index];
        continue;
      }
      PendingNormalizationSource candidate{};
      candidate.kind = PendingNormalizationKind::JournalRecord;
      candidate.quarantine_location = quarantine_location;
      candidate.operation_id = operation_id;
      candidate.operation_path = operation_path;
      candidate.root_entry = root_entry;
      candidate.child_entry = g_recovery_entries[index];
      if (!SetPendingNormalizationSource(
              candidate, pending_source, pending_source_count)) return false;
      continue;
    }
    if (EqualWide(
            g_recovery_entries[index].name.data(),
            g_recovery_entries[index].name_length,
            L"keyset.pending")) {
      if (pending_operation_directory || candidate_present ||
          (g_recovery_entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
          (g_recovery_entries[index].attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U) {
        return false;
      }
      candidate_present = true;
      candidate_entry = g_recovery_entries[index];
      continue;
    }
    if (EqualWide(
            g_recovery_entries[index].name.data(),
            g_recovery_entries[index].name_length,
            L"revoke.pending.gckc")) {
      if (pending_operation_directory || candidate_present ||
          (g_recovery_entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
          g_recovery_entries[index].byte_length > 256U) return false;
      candidate_present = true;
      candidate_is_revoke = true;
      candidate_entry = g_recovery_entries[index];
      if (g_recovery_entries[index].byte_length < 256U) {
        PendingNormalizationSource candidate{};
        candidate.kind = PendingNormalizationKind::RevokeCandidate;
        candidate.quarantine_location = quarantine_location;
        candidate.operation_id = operation_id;
        candidate.operation_path = operation_path;
        candidate.root_entry = root_entry;
        candidate.child_entry = g_recovery_entries[index];
        if (!SetPendingNormalizationSource(
                candidate, pending_source, pending_source_count)) return false;
      }
      continue;
    }
    return false;
  }
  if ((!pending_operation_directory && final_record_count == 0U) ||
      final_record_count > final_records.size()) return false;
  if (final_record_count != 0U) {
    for (std::size_t sequence = 0U; sequence < final_record_count; ++sequence) {
      if (!final_record_present[sequence]) return false;
    }
    if (!ValidatePreparedRecordAuthority(final_records[0], operation_id)) return false;
    if (candidate_present &&
        ((candidate_is_revoke &&
          final_records[0].bytes[32] !=
              static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) ||
         (!candidate_is_revoke &&
          final_records[0].bytes[32] !=
              static_cast<std::uint8_t>(Opcode::CreateKeyset)))) return false;
    for (std::size_t sequence = 1U; sequence < final_record_count; ++sequence) {
      if (!ValidateJournalTransition(
              final_records[0],
              final_records[sequence - 1U],
              final_records[sequence])) return false;
    }
    if (!pending_operation_directory) {
      for (std::size_t sequence = 0U; sequence < final_record_count; ++sequence) {
        std::uint16_t publication_sequence = 0U;
        JournalRecordKind kind{};
        std::uint32_t encoded_sequence = UINT32_MAX;
        Byte32 hash{};
        if (!ValidateJournalRecord(
                final_records[sequence], &kind, &encoded_sequence, &hash) ||
            !GetJournalPublicationSequence(
                final_records[sequence], &publication_sequence) ||
            !RegisterPublicationEvent(
                publication_sequence,
                operation_id,
                RecordPublicationEventKind(
                    kind, final_records[sequence].bytes[7]),
                final_records[0].bytes[32],
                0U,
                &final_records[sequence])) {
          return false;
        }
      }
    }
  }
  if (g_phase_a_operation_count >= g_phase_a_operations.size()) return false;
  PhaseAOperationInventory& inventory =
      g_phase_a_operations[g_phase_a_operation_count++];
  inventory.present = true;
  inventory.pending_operation_directory = pending_operation_directory;
  inventory.quarantine_location = quarantine_location;
  inventory.candidate_present = candidate_present;
  inventory.candidate_is_revoke = candidate_is_revoke;
  inventory.operation_id = operation_id;
  inventory.path = operation_path;
  inventory.root_entry = root_entry;
  if (candidate_present) inventory.candidate_entry = candidate_entry;
  inventory.record_count = final_record_count;
  for (std::size_t sequence = 0U; sequence < final_record_count; ++sequence) {
    inventory.records[sequence] = final_records[sequence];
  }
  if (final_record_count != 0U) inventory.prepared = final_records[0];
  return true;
}

bool NormalizePendingSource(
    ProtectedOperationsState* state,
    PendingNormalizationSource& source,
    const ProtectedResidueProjection* expected_residue = nullptr) noexcept {
  if (state == nullptr || source.kind == PendingNormalizationKind::None) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  ++g_recovery_evidence.source_mutation_count;
#endif
  if (source.kind == PendingNormalizationKind::OperationDirectory) {
    Byte16 operation_id{};
    if (!ParsePendingOperationComponent(source.root_entry, &operation_id) ||
        operation_id != source.operation_id ||
        source.authority.directory == nullptr ||
        source.authority.directory == INVALID_HANDLE_VALUE) return false;
    if (source.child_entry.name_length == 0U ||
        source.child_entry.byte_length < kJournalRecordBytes) {
      return MoveDirectoryToResidue(
          state,
          source.operation_id,
          L"bootstrap",
          source.operation_path,
          source.child_entry.byte_length,
          source.child_entry.name_length == 0U
              ? nullptr
              : source.child_entry.name.data(),
          expected_residue,
          &source.authority);
    }
    std::uint32_t sequence = UINT32_MAX;
    JournalRecordKind kind{};
    const bool pending_record = ParsePendingRecordComponent(
        source.child_entry, &sequence, &kind);
    const bool final_record = ParseRecordComponent(
        source.child_entry, &sequence, &kind);
    JournalRecord prepared{};
    std::uint16_t publication_sequence = 0U;
    if ((!pending_record && !final_record) || sequence != 0U ||
        kind != JournalRecordKind::Prepared ||
        !source.authority.child_present ||
        source.authority.child_bytes_length != prepared.bytes.size()) {
      return false;
    }
    std::memcpy(
        prepared.bytes.data(),
        source.authority.child_bytes.data(),
        prepared.bytes.size());
    if (!ValidatePreparedRecordAuthority(prepared, operation_id) ||
        !GetJournalPublicationSequence(prepared, &publication_sequence) ||
        publication_sequence != state->next_publication_sequence) return false;
    HANDLE child = source.authority.child;
    source.authority.child = nullptr;
    bool normalized = false;
    ProtectedPath child_source_path{};
    if (!ComposeProtectedChildPath(
            source.operation_path,
            source.child_entry.name.data(),
            &child_source_path)) {
      CloseHandle(child);
      return false;
    }
    if (pending_record) {
      std::array<wchar_t, 48U> final_component{};
      ProtectedPath child_final_path{};
      std::array<std::uint8_t, kJournalRecordBytes> final_bytes{};
      std::size_t final_length = 0U;
      ProtectedObjectIdentity final_identity{};
      Byte32 final_hash{};
      normalized = BuildRecordComponent(
                       0U, L"prepared", false, &final_component) &&
          ComposeProtectedChildPath(
              source.operation_path,
              final_component.data(),
              &child_final_path) &&
          FlushAndRenameProtectedFile(
              state->filesystem, child, child_final_path);
      CloseHandle(child);
      source.authority.child_present = false;
      if (normalized) {
        normalized = ReadProtectedFinalFile(
                         state->filesystem,
                         child_final_path,
                         final_bytes.data(),
                         final_bytes.size(),
                         &final_length,
                         &final_identity) &&
            final_length == source.authority.child_bytes_length &&
            final_identity.volume_serial_number ==
                source.authority.child_identity.volume_serial_number &&
            Equal(
                final_identity.file_id.data(),
                source.authority.child_identity.file_id.data(),
                final_identity.file_id.size()) &&
            ComputeSha256(final_bytes.data(), final_length, &final_hash) &&
            Equal(
                final_hash.data(),
                source.authority.child_hash.data(),
                final_hash.size()) &&
            Equal(
                final_bytes.data(),
                source.authority.child_bytes.data(),
                final_length) &&
            ProtectedPathIsAbsentGuarded(
                state->filesystem, child_source_path);
      }
      WipeCustodyOwned(final_bytes.data(), final_bytes.size());
      ClosePendingNormalizationAuthority(&source.authority);
      return normalized;
    }
    std::array<wchar_t, 48U> final_component{};
    ProtectedPath final_directory_path{};
    CloseHandle(child);
    source.authority.child_present = false;
    DirectoryMoveAuthority& move_authority =
        g_directory_move_authority_scratch;
    normalized = BuildOperationComponent(
                     operation_id, false, &final_component) &&
        ComposeProtectedChildPath(
            state->filesystem.journal_path,
            final_component.data(),
            &final_directory_path) &&
        CaptureDirectoryMoveAuthority(
            state->filesystem,
            source.operation_path,
            source.authority.directory,
            &move_authority) &&
        EqualMoveIdentity(
            move_authority.root_identity,
            source.authority.directory_identity) &&
        MoveDirectoryWithCapturedAuthority(
            state->filesystem,
            source.operation_path,
            final_directory_path,
            &source.authority.directory,
            move_authority);
    WipeCustodyOwned(&move_authority, sizeof(move_authority));
    ClosePendingNormalizationAuthority(&source.authority);
    return normalized;
  }
  ProtectedPath source_path{};
  if (!ComposeProtectedChildPath(
          source.operation_path, source.child_entry.name.data(), &source_path)) {
    return false;
  }
  if (source.kind == PendingNormalizationKind::RevokeCandidate) {
    return MoveFileToResidue(
        state,
        source.operation_id,
        L"revoke",
        source_path,
        source.child_entry.byte_length,
        expected_residue,
        &source.authority);
  }
  std::uint32_t pending_sequence = 0U;
  JournalRecordKind pending_kind{};
  if (!ParsePendingRecordComponent(
          source.child_entry, &pending_sequence, &pending_kind) ||
      (source.child_entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
      source.child_entry.byte_length > kJournalRecordBytes) return false;
  if (source.child_entry.byte_length < kJournalRecordBytes) {
    return MoveFileToResidue(
        state,
        source.operation_id,
        L"journal",
        source_path,
        source.child_entry.byte_length,
        expected_residue,
        &source.authority);
  }
  JournalRecord pending_record{};
  JournalRecordKind encoded_kind{};
  std::uint32_t encoded_sequence = UINT32_MAX;
  Byte32 hash{};
  std::uint16_t publication_sequence = 0U;
  HANDLE operation_directory = nullptr;
  ProtectedObjectIdentity operation_identity{};
  std::size_t operation_entry_count = 0U;
  std::array<wchar_t, 48U> final_component{};
  ProtectedPath final_path{};
  std::array<std::uint8_t, kJournalRecordBytes> final_bytes{};
  std::size_t final_length = 0U;
  ProtectedObjectIdentity final_identity{};
  Byte32 final_hash{};
  if (!source.authority.child_present ||
      source.authority.child == nullptr ||
      source.authority.child == INVALID_HANDLE_VALUE ||
      source.authority.child_bytes_length != pending_record.bytes.size()) {
    return false;
  }
  std::memcpy(
      pending_record.bytes.data(),
      source.authority.child_bytes.data(),
      pending_record.bytes.size());
  if (!OpenProtectedExistingDirectory(
          state->filesystem,
          source.operation_path,
          false,
          &operation_directory,
          &operation_identity) ||
      !EnumerateProtectedDirectory(
          state->filesystem,
          operation_directory,
          &g_recovery_entries,
          &operation_entry_count)) {
    if (operation_directory != nullptr &&
        operation_directory != INVALID_HANDLE_VALUE) CloseHandle(operation_directory);
    return false;
  }
  if (!ValidateJournalRecord(
          pending_record, &encoded_kind, &encoded_sequence, &hash) ||
      encoded_kind != pending_kind || encoded_sequence != pending_sequence ||
      !GetJournalPublicationSequence(pending_record, &publication_sequence) ||
      publication_sequence != state->next_publication_sequence ||
      !ValidatePendingRecordTransition(
          state->filesystem,
          source.operation_path,
          source.operation_id,
          operation_entry_count,
          pending_record,
          pending_kind,
          pending_sequence) ||
      !BuildRecordComponent(
          pending_sequence, JournalKindLiteral(pending_kind), false, &final_component) ||
      !ComposeProtectedChildPath(
          source.operation_path, final_component.data(), &final_path)) {
    CloseHandle(operation_directory);
    return false;
  }
  HANDLE child = source.authority.child;
  source.authority.child = nullptr;
  bool normalized = FlushAndRenameProtectedFile(
      state->filesystem, child, final_path);
  CloseHandle(child);
  source.authority.child_present = false;
  CloseHandle(operation_directory);
  if (normalized) {
    HANDLE final_parent = nullptr;
    ProtectedObjectIdentity final_parent_identity{};
    std::size_t final_parent_entry_count = 0U;
    normalized = ReadProtectedFinalFile(
                     state->filesystem,
                     final_path,
                     final_bytes.data(),
                     final_bytes.size(),
                     &final_length,
                     &final_identity) &&
        final_length == source.authority.child_bytes_length &&
        final_identity.volume_serial_number ==
            source.authority.child_identity.volume_serial_number &&
        Equal(
            final_identity.file_id.data(),
            source.authority.child_identity.file_id.data(),
            final_identity.file_id.size()) &&
        ComputeSha256(final_bytes.data(), final_length, &final_hash) &&
        Equal(
            final_hash.data(),
            source.authority.child_hash.data(),
            final_hash.size()) &&
        Equal(
            final_bytes.data(),
            source.authority.child_bytes.data(),
            final_length) &&
        ProtectedPathIsAbsentGuarded(state->filesystem, source_path) &&
        OpenProtectedExistingDirectory(
            state->filesystem,
            source.operation_path,
            false,
            &final_parent,
            &final_parent_identity) &&
        final_parent_identity.volume_serial_number ==
            operation_identity.volume_serial_number &&
        Equal(
            final_parent_identity.file_id.data(),
            operation_identity.file_id.data(),
            final_parent_identity.file_id.size()) &&
        EnumerateProtectedDirectory(
            state->filesystem,
            final_parent,
            &g_recovery_entries,
            &final_parent_entry_count) &&
        final_parent_entry_count == operation_entry_count;
    if (final_parent != nullptr && final_parent != INVALID_HANDLE_VALUE) {
      CloseHandle(final_parent);
    }
  }
  WipeCustodyOwned(final_bytes.data(), final_bytes.size());
  if (!normalized) return false;
  ++state->next_publication_sequence;
  return true;
}

bool BuildProvisionalResidueProjection(
    ProtectedOperationsState* state,
    const PendingNormalizationSource& source,
    const RecoveryPublicationEvent& event,
    ProtectedResidueProjection* residue,
    ProtectedOperationProjection* bootstrap_operation) noexcept {
  if (state == nullptr || residue == nullptr || bootstrap_operation == nullptr ||
      (event.kind != RecoveryPublicationEventKind::BootstrapResidue &&
       event.kind != RecoveryPublicationEventKind::JournalResidue &&
       event.kind != RecoveryPublicationEventKind::RevokeResidue)) return false;
  *residue = ProtectedResidueProjection{};
  *bootstrap_operation = ProtectedOperationProjection{};
  ProtectedObjectIdentity identity{};
  Byte32 content_hash{};
  std::uint64_t total_bytes = 0U;
  if (event.kind == RecoveryPublicationEventKind::BootstrapResidue) {
    if (source.authority.directory == nullptr ||
        source.authority.directory == INVALID_HANDLE_VALUE) return false;
    identity = source.authority.directory_identity;
    std::array<std::uint8_t, 96U> closure{};
    WriteU16(closure.data(), 1U);
    IdentityBytes(identity, closure.data() + 4U);
    if (source.authority.child_present) {
      closure[28] = 1U;
      IdentityBytes(
          source.authority.child_identity, closure.data() + 32U);
      WriteU64(
          closure.data() + 56U, source.authority.child_bytes_length);
      Copy32(source.authority.child_hash, closure.data() + 64U);
      total_bytes = source.authority.child_bytes_length;
    }
    if (!HashDomain(
            kQuarantineClosureDomain,
            sizeof(kQuarantineClosureDomain) - 1U,
            closure.data(),
            closure.size(),
            &content_hash)) return false;
    bootstrap_operation->present = true;
    std::memcpy(
        bootstrap_operation->bytes.data(),
        event.operation_id.data(),
        event.operation_id.size());
    bootstrap_operation->bytes[17] = 3U;
  } else {
    const std::size_t capacity =
        event.kind == RecoveryPublicationEventKind::JournalResidue
            ? 1023U
            : 255U;
    if (!source.authority.child_present ||
        source.authority.child == nullptr ||
        source.authority.child == INVALID_HANDLE_VALUE ||
        source.authority.child_bytes_length > capacity ||
        source.authority.child_bytes_length != source.child_entry.byte_length) {
      return false;
    }
    identity = source.authority.child_identity;
    content_hash = source.authority.child_hash;
    total_bytes = source.authority.child_bytes_length;
  }
  residue->present = true;
  std::memcpy(
      residue->bytes.data(), event.operation_id.data(),
      event.operation_id.size());
  residue->bytes[16] = event.residue_ordinal;
  residue->bytes[17] = event.kind == RecoveryPublicationEventKind::BootstrapResidue
      ? 1U
      : event.kind == RecoveryPublicationEventKind::JournalResidue ? 2U : 3U;
  WriteU16(
      residue->bytes.data() + 18U, state->next_publication_sequence);
  WriteU64(residue->bytes.data() + 20U, total_bytes);
  IdentityBytes(identity, residue->bytes.data() + 28U);
  Copy32(content_hash, residue->bytes.data() + 52U);
  return ResidueProjectionValid(*residue) &&
      (!bootstrap_operation->present ||
       OperationProjectionValid(*bootstrap_operation));
}

bool ValidatePendingNormalizationChronology(
    ProtectedOperationsState* state,
    PendingNormalizationSource& source,
    std::size_t publication_count,
    RecoveryPublicationEvent* provisional_event,
    ProtectedResidueProjection* provisional_residue,
    ProtectedOperationProjection* provisional_operation) noexcept {
  if (state == nullptr || source.kind == PendingNormalizationKind::None ||
      provisional_event == nullptr || provisional_residue == nullptr ||
      provisional_operation == nullptr ||
      publication_count >= kMaximumPublicationSequence ||
      state->next_publication_sequence != publication_count + 1U) {
    return false;
  }
  RecoveryPublicationEvent event{};
  event.operation_id = source.operation_id;
  const PhaseAOperationInventory* operation_inventory = nullptr;
  for (std::size_t index = 0U; index < g_phase_a_operation_count; ++index) {
    if (g_phase_a_operations[index].present &&
        g_phase_a_operations[index].operation_id == source.operation_id) {
      operation_inventory = &g_phase_a_operations[index];
      break;
    }
  }
  std::uint8_t prospective_residue_ordinal = 0U;
  for (const ProtectedResidueProjection& residue : g_deferred_residues) {
    if (residue.present &&
        Equal(residue.bytes.data(), source.operation_id.data(), 16U)) {
      if (prospective_residue_ordinal == UINT8_MAX) return false;
      ++prospective_residue_ordinal;
    }
  }
  if (source.kind == PendingNormalizationKind::RevokeCandidate) {
    event.kind = RecoveryPublicationEventKind::RevokeResidue;
    event.residue_ordinal = prospective_residue_ordinal;
    std::uint8_t preflight_ordinal = 0U;
    if (!PreflightResidueMove(
            *state,
            event.operation_id,
            L"revoke",
            source.child_entry.byte_length,
            &preflight_ordinal) ||
        preflight_ordinal != event.residue_ordinal ||
        !PreparePendingNormalizationAuthority(state, &source)) return false;
  } else if (source.kind == PendingNormalizationKind::JournalRecord &&
             source.child_entry.byte_length < kJournalRecordBytes) {
    event.kind = RecoveryPublicationEventKind::JournalResidue;
    event.residue_ordinal = prospective_residue_ordinal;
    std::uint8_t preflight_ordinal = 0U;
    if (!PreflightResidueMove(
            *state,
            event.operation_id,
            L"journal",
            source.child_entry.byte_length,
            &preflight_ordinal) ||
        preflight_ordinal != event.residue_ordinal ||
        !PreparePendingNormalizationAuthority(state, &source)) return false;
  } else if (source.kind == PendingNormalizationKind::OperationDirectory &&
             (source.child_entry.name_length == 0U ||
              source.child_entry.byte_length < kJournalRecordBytes)) {
    event.kind = RecoveryPublicationEventKind::BootstrapResidue;
    event.residue_ordinal = 0U;
    std::uint8_t preflight_ordinal = 0U;
    if (!PreflightResidueMove(
            *state,
            event.operation_id,
            L"bootstrap",
            source.child_entry.byte_length,
            &preflight_ordinal) ||
        preflight_ordinal != event.residue_ordinal ||
        !PreparePendingNormalizationAuthority(state, &source)) return false;
  } else {
    std::uint32_t filename_sequence = UINT32_MAX;
    JournalRecordKind filename_kind{};
    const bool pending_record = ParsePendingRecordComponent(
        source.child_entry, &filename_sequence, &filename_kind);
    const bool final_record = ParseRecordComponent(
        source.child_entry, &filename_sequence, &filename_kind);
    JournalRecord record{};
    JournalRecordKind encoded_kind{};
    std::uint32_t encoded_sequence = UINT32_MAX;
    std::uint16_t publication_sequence = 0U;
    Byte32 hash{};
    if ((!pending_record && !final_record) ||
        source.child_entry.byte_length != kJournalRecordBytes ||
        !PreparePendingNormalizationAuthority(state, &source) ||
        !source.authority.child_present ||
        source.authority.child_bytes_length != sizeof(record.bytes)) {
      return false;
    }
    std::memcpy(
        record.bytes.data(),
        source.authority.child_bytes.data(),
        record.bytes.size());
    if (
        !ValidateJournalRecord(
            record, &encoded_kind, &encoded_sequence, &hash) ||
        encoded_kind != filename_kind || encoded_sequence != filename_sequence ||
        !GetJournalPublicationSequence(record, &publication_sequence) ||
        publication_sequence != state->next_publication_sequence) {
      return false;
    }
    event.kind = RecordPublicationEventKind(encoded_kind, record.bytes[7]);
    event.record_present = true;
    event.record = record;
    event.opcode = encoded_kind == JournalRecordKind::Prepared
        ? record.bytes[32]
        : operation_inventory == nullptr
            ? 0U
            : operation_inventory->prepared.bytes[32];
  }
  if (event.kind == RecoveryPublicationEventKind::None) return false;
  g_publication_events[state->next_publication_sequence] = event;
  const bool valid = ValidateRecoveryPublicationEvents(
      g_publication_events.data() + 1U, publication_count + 1U);
  g_publication_events[state->next_publication_sequence] =
      RecoveryPublicationEvent{};
  if (!valid) return false;
  *provisional_event = event;
  *provisional_residue = ProtectedResidueProjection{};
  *provisional_operation = ProtectedOperationProjection{};
  if (event.kind == RecoveryPublicationEventKind::BootstrapResidue ||
      event.kind == RecoveryPublicationEventKind::JournalResidue ||
      event.kind == RecoveryPublicationEventKind::RevokeResidue) {
    return BuildProvisionalResidueProjection(
        state,
        source,
        event,
        provisional_residue,
        provisional_operation);
  }
  return true;
}

bool RecoverResidueProjection(
    const ProtectedFilesystemState& filesystem,
    const ProtectedDirectoryEntry& entry,
    ProtectedResidueProjection* residue,
    ProtectedOperationProjection* bootstrap_operation) noexcept {
  if (residue == nullptr || bootstrap_operation == nullptr) return false;
  *residue = ProtectedResidueProjection{};
  *bootstrap_operation = ProtectedOperationProjection{};
  Byte16 operation_id{};
  std::uint8_t ordinal = 0U;
  std::uint16_t publication_sequence = 0U;
  std::uint8_t kind = 0U;
  ProtectedPath path{};
  if (!ParseResidueComponent(
          entry, &operation_id, &ordinal, &publication_sequence, &kind) ||
      !ComposeProtectedChildPath(
          filesystem.quarantine_path, entry.name.data(), &path)) return false;
  ProtectedObjectIdentity identity{};
  Byte32 content_hash{};
  std::uint64_t total_bytes = 0U;
  if (kind == 1U) {
    if ((entry.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
        (entry.attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U) return false;
    HANDLE directory = nullptr;
    if (!OpenProtectedExistingDirectory(
            filesystem, path, false, &directory, &identity)) return false;
    std::size_t child_count = 0U;
    if (!EnumerateProtectedDirectory(
            filesystem, directory, &g_recovery_entries, &child_count) ||
        child_count > 1U) {
      CloseHandle(directory);
      return false;
    }
    CloseHandle(directory);
    std::array<std::uint8_t, 96U> closure{};
    WriteU16(closure.data(), 1U);
    IdentityBytes(identity, closure.data() + 4U);
    if (child_count == 1U) {
      const ProtectedDirectoryEntry& child = g_recovery_entries[0];
      if (!EqualWide(
              child.name.data(),
              child.name_length,
              L".s00000000-prepared.pending") ||
          (child.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
          child.byte_length > 1023U) return false;
      ProtectedPath child_path{};
      ProtectedObjectIdentity child_identity{};
      std::array<std::uint8_t, 1023U> bytes{};
      std::size_t length = 0U;
      if (!ComposeProtectedChildPath(path, child.name.data(), &child_path) ||
#if defined(GOATCITADEL_PROVISIONER_TESTING)
          (++g_recovery_evidence.residue_payload_read_count, false) ||
#endif
          !ReadProtectedExistingFile(
              filesystem,
              child_path,
              bytes.data(),
              bytes.size(),
              &length,
              &child_identity) ||
          length != child.byte_length) return false;
      Byte32 child_hash{};
      if (!ComputeSha256(bytes.data(), length, &child_hash)) return false;
      closure[28] = 1U;
      IdentityBytes(child_identity, closure.data() + 32U);
      WriteU64(closure.data() + 56U, length);
      Copy32(child_hash, closure.data() + 64U);
      total_bytes = length;
      SecureZeroMemory(bytes.data(), bytes.size());
    }
    if (!HashDomain(
            kQuarantineClosureDomain,
            sizeof(kQuarantineClosureDomain) - 1U,
            closure.data(),
            closure.size(),
            &content_hash)) return false;
    bootstrap_operation->present = true;
    std::memcpy(
        bootstrap_operation->bytes.data(), operation_id.data(), operation_id.size());
    bootstrap_operation->bytes[17] = 3U;
  } else {
    if ((entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
        (kind == 2U && entry.byte_length > 1023U) ||
        (kind == 3U && entry.byte_length > 255U)) return false;
    std::array<std::uint8_t, 1023U> bytes{};
    std::size_t length = 0U;
    const std::size_t capacity = kind == 2U ? 1023U : 255U;
    if (
#if defined(GOATCITADEL_PROVISIONER_TESTING)
        (++g_recovery_evidence.residue_payload_read_count, false) ||
#endif
        !ReadProtectedExistingFile(
            filesystem,
            path,
            bytes.data(),
            capacity,
            &length,
            &identity) ||
        length != entry.byte_length ||
        !ComputeSha256(bytes.data(), length, &content_hash)) return false;
    total_bytes = length;
    SecureZeroMemory(bytes.data(), bytes.size());
  }
  residue->present = true;
  std::memcpy(residue->bytes.data(), operation_id.data(), operation_id.size());
  residue->bytes[16] = ordinal;
  residue->bytes[17] = kind;
  WriteU16(residue->bytes.data() + 18U, publication_sequence);
  WriteU64(residue->bytes.data() + 20U, total_bytes);
  IdentityBytes(identity, residue->bytes.data() + 28U);
  Copy32(content_hash, residue->bytes.data() + 52U);
  return ResidueProjectionValid(*residue) &&
         (!bootstrap_operation->present ||
          OperationProjectionValid(*bootstrap_operation));
}

bool CommitDeferredResiduesBefore(
    ProtectedOperationsState* state,
    std::uint16_t exclusive_publication_sequence) noexcept {
  if (state == nullptr || exclusive_publication_sequence == 0U ||
      exclusive_publication_sequence > kMaximumPublicationSequence + 1U) return false;
  bool changed = false;
  for (std::size_t index = 0U; index < g_deferred_residues.size(); ++index) {
    const ProtectedResidueProjection& residue = g_deferred_residues[index];
    if (!residue.present || g_deferred_residue_committed[index] ||
        ReadU16(residue.bytes.data() + 18U) >= exclusive_publication_sequence) {
      continue;
    }
    if (!CommitProjection(
            &state->residues,
            residue,
            [](const ProtectedResidueProjection& left,
               const ProtectedResidueProjection& right) noexcept {
              return Equal(left.bytes.data(), right.bytes.data(), 17U);
            }) ||
        (g_deferred_residue_operations[index].present &&
         !CommitProjection(
             &state->operations,
             g_deferred_residue_operations[index],
             [](const ProtectedOperationProjection& left,
                const ProtectedOperationProjection& right) noexcept {
               return Equal(left.bytes.data(), right.bytes.data(), 16U);
             }))) {
      return false;
    }
    ++state->residue_count;
    if (g_deferred_residue_operations[index].present) ++state->operation_id_count;
    g_deferred_residue_committed[index] = true;
    changed = true;
  }
  return !changed || BuildCanonicalState(
      *state, nullptr, nullptr, nullptr, &state->state_sha256);
}

bool CommitRecoveryResidueAt(
    ProtectedOperationsState* state,
    std::uint16_t publication_sequence,
    const ProtectedResidueProjection* provisional_residue = nullptr,
    const ProtectedOperationProjection* provisional_operation = nullptr) noexcept {
  if (state == nullptr || publication_sequence == 0U ||
      publication_sequence > kMaximumPublicationSequence) return false;
  const ProtectedResidueProjection* residue = provisional_residue;
  const ProtectedOperationProjection* bootstrap_operation = provisional_operation;
  std::size_t match_count = residue == nullptr ? 0U : 1U;
  for (std::size_t index = 0U; index < g_deferred_residues.size(); ++index) {
    if (!g_deferred_residues[index].present ||
        ReadU16(g_deferred_residues[index].bytes.data() + 18U) !=
            publication_sequence) {
      continue;
    }
    if (residue != nullptr || ++match_count != 1U) return false;
    residue = &g_deferred_residues[index];
    bootstrap_operation = &g_deferred_residue_operations[index];
  }
  if (match_count != 1U || residue == nullptr || !residue->present ||
      ReadU16(residue->bytes.data() + 18U) != publication_sequence ||
      !CommitProjection(
          &state->residues,
          *residue,
          [](const ProtectedResidueProjection& left,
             const ProtectedResidueProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 17U);
          }) ||
      (bootstrap_operation != nullptr && bootstrap_operation->present &&
       !CommitProjection(
           &state->operations,
           *bootstrap_operation,
           [](const ProtectedOperationProjection& left,
              const ProtectedOperationProjection& right) noexcept {
             return Equal(left.bytes.data(), right.bytes.data(), 16U);
           }))) {
    return false;
  }
  ++state->residue_count;
  if (bootstrap_operation != nullptr && bootstrap_operation->present) {
    ++state->operation_id_count;
  }
  return BuildCanonicalState(
      *state, nullptr, nullptr, nullptr, &state->state_sha256);
}

bool BuildCandidateClosure(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& candidate_path,
    const ProtectedObjectIdentity& candidate_identity,
    const JournalRecord* prepared,
    ProtectedOperationsState* historical_state,
    Byte32* closure_hash,
    bool* complete_five_file_closure,
    HANDLE retained_directory = nullptr,
    bool final_read_only_validation = false) noexcept {
  if (closure_hash == nullptr || complete_five_file_closure == nullptr) return false;
  closure_hash->fill(0U);
  *complete_five_file_closure = false;
  HANDLE directory = retained_directory;
  const bool owns_directory = retained_directory == nullptr;
  ProtectedObjectIdentity reopened_identity{};
  if (!(owns_directory
            ? OpenProtectedExistingDirectory(
                  filesystem,
                  candidate_path,
                  false,
                  &directory,
                  &reopened_identity)
            : CaptureProtectedObjectIdentity(
                  filesystem, directory, &reopened_identity)) ||
      reopened_identity.volume_serial_number !=
          candidate_identity.volume_serial_number ||
      !Equal(
          reopened_identity.file_id.data(),
          candidate_identity.file_id.data(),
          candidate_identity.file_id.size())) {
    if (owns_directory && directory != nullptr &&
        directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    return false;
  }
  std::size_t entry_count = 0U;
  if (!EnumerateProtectedDirectory(
          filesystem, directory, &g_recovery_entries, &entry_count) ||
      entry_count > 5U) {
    if (owns_directory) CloseHandle(directory);
    return false;
  }
  if (owns_directory) CloseHandle(directory);
  constexpr std::array<const wchar_t*, 5U> kNames = {
      L"runtime-manifest.pk8",
      L"runtime-manifest.spki",
      L"admission-evidence.pk8",
      L"admission-evidence.spki",
      L"keyset-receipt.gckr"};
  constexpr std::array<std::size_t, 5U> kMaximumLengths = {
      48U, 44U, 48U, 44U, 640U};
  std::array<std::uint8_t, 368U> projection{};
  WriteU16(projection.data(), 1U);
  WriteU16(projection.data() + 2U, 5U);
  IdentityBytes(candidate_identity, projection.data() + 4U);
  std::array<bool, 5U> present{};
  std::array<std::uint8_t, 640U> file_bytes{};
  std::array<std::array<std::uint8_t, 640U>, 5U> observed_bytes{};
  std::array<std::size_t, 5U> observed_lengths{};
  std::array<ProtectedObjectIdentity, 5U> observed_identities{};
  std::array<Byte32, 5U> observed_hashes{};
  std::uint64_t total_bytes = 0U;
  bool valid = true;
  for (std::size_t entry_index = 0U; entry_index < entry_count && valid; ++entry_index) {
    std::size_t role = kNames.size();
    for (std::size_t candidate = 0U; candidate < kNames.size(); ++candidate) {
      if (EqualWide(
              g_recovery_entries[entry_index].name.data(),
              g_recovery_entries[entry_index].name_length,
              kNames[candidate])) {
        role = candidate;
        break;
      }
    }
    const ProtectedDirectoryEntry& entry = g_recovery_entries[entry_index];
    if (role == kNames.size() || present[role] ||
        (entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
        (entry.attributes &
         (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
          FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED |
          FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS |
          FILE_ATTRIBUTE_RECALL_ON_OPEN)) != 0U ||
        entry.byte_length > kMaximumLengths[role] ||
        total_bytes + entry.byte_length > 824U) {
      valid = false;
      break;
    }
    ProtectedPath file_path{};
    ProtectedObjectIdentity identity{};
    std::size_t length = 0U;
    file_bytes.fill(0U);
    if (!ComposeProtectedChildPath(candidate_path, kNames[role], &file_path) ||
        !(final_read_only_validation
              ? ReadProtectedFinalFile(
                    filesystem,
                    file_path,
                    file_bytes.data(),
                    kMaximumLengths[role],
                    &length,
                    &identity)
              : ReadProtectedExistingFile(
                    filesystem,
                    file_path,
                    file_bytes.data(),
                    kMaximumLengths[role],
                    &length,
                    &identity)) ||
        length != entry.byte_length) {
      valid = false;
      break;
    }
    Byte32 content_hash{};
    if (!ComputeSha256(file_bytes.data(), length, &content_hash)) {
      valid = false;
      break;
    }
    std::uint8_t* slot = projection.data() + 28U + role * 68U;
    slot[0] = 1U;
    slot[1] = 1U;
    IdentityBytes(identity, slot + 4U);
    WriteU64(slot + 28U, length);
    Copy32(content_hash, slot + 36U);
    present[role] = true;
    observed_lengths[role] = length;
    observed_identities[role] = identity;
    observed_hashes[role] = content_hash;
    std::memcpy(observed_bytes[role].data(), file_bytes.data(), length);
    total_bytes += length;

    if (historical_state != nullptr && (role == 0U || role == 2U) && length == 48U) {
      constexpr std::array<std::uint8_t, 16U> kPkcs8Prefix = {
          0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
          0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U};
      Ed25519DerivedKeyMaterial derived{};
      if (Equal(file_bytes.data(), kPkcs8Prefix.data(), kPkcs8Prefix.size()) &&
          DeriveEd25519KeyMaterial(file_bytes.data() + 16U, 32U, &derived)) {
        Byte32 key_id{};
        if (!ComputeSha256(derived.spki.data(), derived.spki.size(), &key_id) ||
            !AppendHistoricalKey(historical_state, derived.spki, key_id)) valid = false;
      }
      WipeCustodyOwned(&derived, sizeof(derived));
    } else if (historical_state != nullptr && (role == 1U || role == 3U) && length == 44U) {
      constexpr std::array<std::uint8_t, 12U> kSpkiPrefix = {
          0x30U, 0x2aU, 0x30U, 0x05U, 0x06U, 0x03U,
          0x2bU, 0x65U, 0x70U, 0x03U, 0x21U, 0x00U};
      if (Equal(file_bytes.data(), kSpkiPrefix.data(), kSpkiPrefix.size()) &&
          !AllZero(file_bytes.data() + 12U, 32U)) {
        HistoricalCustodyKey key{};
        std::memcpy(key.spki.data(), file_bytes.data(), key.spki.size());
        if (!ComputeSha256(key.spki.data(), key.spki.size(), &key.key_id) ||
            !AppendHistoricalKey(historical_state, key.spki, key.key_id)) valid = false;
      }
    }
    WipeCustodyOwned(file_bytes.data(), file_bytes.size());
  }
  if (!valid) {
    WipeCustodyOwned(file_bytes.data(), file_bytes.size());
    return false;
  }
  *complete_five_file_closure = entry_count == 5U && prepared != nullptr;
  for (std::size_t index = 0U; index < present.size(); ++index) {
    if (!present[index]) *complete_five_file_closure = false;
  }
  constexpr std::array<std::size_t, 5U> kExactLengths = {
      48U, 44U, 48U, 44U, 640U};
  for (std::size_t index = 0U; index < kExactLengths.size(); ++index) {
    if (observed_lengths[index] != kExactLengths[index]) {
      *complete_five_file_closure = false;
    }
  }
  if (*complete_five_file_closure) {
    CreateKeysetRequest request{};
    const std::uint16_t body_length = ReadU16(prepared->bytes.data() + 38U);
    constexpr std::array<std::uint8_t, 16U> kPkcs8Prefix = {
        0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
        0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U};
    Ed25519DerivedKeyMaterial runtime{};
    Ed25519DerivedKeyMaterial admission{};
    const auto& receipt = observed_bytes[4U];
    bool exact = DecodeCreateKeysetRequest(
                     prepared->bytes.data() + 112U,
                     body_length,
                     &request) &&
                 Equal(
                     observed_bytes[0U].data(),
                     kPkcs8Prefix.data(),
                     kPkcs8Prefix.size()) &&
                 Equal(
                     observed_bytes[2U].data(),
                     kPkcs8Prefix.data(),
                     kPkcs8Prefix.size()) &&
                 DeriveEd25519KeyMaterial(
                     observed_bytes[0U].data() + 16U, 32U, &runtime) &&
                 DeriveEd25519KeyMaterial(
                     observed_bytes[2U].data() + 16U, 32U, &admission) &&
                 Equal(runtime.pkcs8.data(), observed_bytes[0U].data(), 48U) &&
                 Equal(runtime.spki.data(), observed_bytes[1U].data(), 44U) &&
                 Equal(admission.pkcs8.data(), observed_bytes[2U].data(), 48U) &&
                 Equal(admission.spki.data(), observed_bytes[3U].data(), 44U) &&
                 receipt[0] == 'G' && receipt[1] == 'C' &&
                 receipt[2] == 'K' && receipt[3] == 'R' &&
                 ReadU16(receipt.data() + 4U) == 1U && receipt[6] == 1U &&
                 receipt[7] == 0U && ReadU32(receipt.data() + 8U) == 640U &&
                 ReadU32(receipt.data() + 12U) == 0U &&
                 Equal(receipt.data() + 16U, request.operation_id.data(), 16U) &&
                 ReadU64(receipt.data() + 32U) == request.requested_generation &&
                 ReadU64(receipt.data() + 40U) == request.predecessor_generation &&
                 ReadU64(receipt.data() + 48U) ==
                     ReadU64(prepared->bytes.data() + 832U);
    std::array<std::uint8_t, 24U> identity_bytes{};
    if (exact) {
      IdentityBytes(candidate_identity, identity_bytes.data());
      exact = Equal(identity_bytes.data(), receipt.data() + 56U, 24U);
    }
    for (std::size_t index = 0U; exact && index < observed_identities.size(); ++index) {
      IdentityBytes(observed_identities[index], identity_bytes.data());
      exact = Equal(
          identity_bytes.data(), receipt.data() + 80U + index * 24U, 24U);
    }
    for (std::size_t index = 0U; exact && index < 4U; ++index) {
      exact = Equal(
          observed_hashes[index].data(),
          receipt.data() + 200U + index * 32U,
          32U);
    }
    std::array<std::uint8_t, 104U> pair_projection{};
    WriteU64(pair_projection.data(), request.requested_generation);
    WriteU64(pair_projection.data() + 8U, request.predecessor_generation);
    std::memcpy(pair_projection.data() + 16U, runtime.spki.data(), 44U);
    std::memcpy(pair_projection.data() + 60U, admission.spki.data(), 44U);
    Byte32 pair_hash{};
    Byte32 receipt_hash{};
    exact = exact &&
            Equal(runtime.spki.data(), receipt.data() + 328U, 44U) &&
            Equal(admission.spki.data(), receipt.data() + 372U, 44U) &&
            HashDomain(
                kPairDomain,
                sizeof(kPairDomain) - 1U,
                pair_projection.data(),
                pair_projection.size(),
                &pair_hash) &&
            Equal(pair_hash.data(), receipt.data() + 416U, 32U) &&
            AllZero(receipt.data() + 448U, 160U) &&
            HashDomainLarge(
                kReceiptDomain,
                sizeof(kReceiptDomain) - 1U,
                receipt.data(),
                608U,
                &receipt_hash) &&
            Equal(receipt_hash.data(), receipt.data() + 608U, 32U);
    *complete_five_file_closure = exact;
    WipeCustodyOwned(&runtime, sizeof(runtime));
    WipeCustodyOwned(&admission, sizeof(admission));
  }
  const bool hashed = HashDomainLarge(
      kCandidateClosureDomain,
      sizeof(kCandidateClosureDomain) - 1U,
      projection.data(),
      projection.size(),
      closure_hash);
  WipeCustodyOwned(observed_bytes.data(), sizeof(observed_bytes));
  return hashed;
}

const ProtectedDirectoryEntry* FindNamedEntryIn(
    const std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>& entries,
    std::size_t count,
    const wchar_t* name) noexcept {
  const ProtectedDirectoryEntry* found = nullptr;
  for (std::size_t index = 0U; index < count; ++index) {
    if (!EqualWide(entries[index].name.data(), entries[index].name_length, name)) {
      continue;
    }
    if (found != nullptr) return nullptr;
    found = &entries[index];
  }
  return found;
}

bool ValidateRevokeControlAuthority(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& control_path,
    const JournalRecord& prepared) noexcept {
  RevokeKeysetRequest request{};
  const std::uint16_t body_length = ReadU16(prepared.bytes.data() + 38U);
  const std::uint16_t sid_length = ReadU16(prepared.bytes.data() + 36U);
  if (!DecodeRevokeKeysetRequest(
          prepared.bytes.data() + 112U, body_length, &request) ||
      sid_length == 0U || sid_length > 68U) return false;
  std::array<std::uint8_t, 256U> control{};
  std::size_t control_length = 0U;
  ProtectedObjectIdentity identity{};
  if (!ReadProtectedExistingFile(
          filesystem,
          control_path,
          control.data(),
          control.size(),
          &control_length,
          &identity) ||
      control_length != control.size()) return false;
  std::array<std::uint8_t, 24U> identity_bytes{};
  IdentityBytes(identity, identity_bytes.data());
  std::array<std::uint8_t, 72U> sid_projection{};
  WriteU16(sid_projection.data(), sid_length);
  std::memcpy(
      sid_projection.data() + 2U, prepared.bytes.data() + 40U, sid_length);
  Byte32 sid_hash{};
  Byte32 control_hash{};
  const bool valid = HashDomain(
                         kOperatorSidDomain,
                         sizeof(kOperatorSidDomain) - 1U,
                         sid_projection.data(),
                         2U + sid_length,
                         &sid_hash) &&
      HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          control.data(),
          224U,
          &control_hash) &&
      control[0] == 'G' && control[1] == 'C' && control[2] == 'K' &&
      control[3] == 'C' && ReadU16(control.data() + 4U) == 1U &&
      control[6] == 1U && control[7] == 0U &&
      ReadU32(control.data() + 8U) == 256U &&
      ReadU32(control.data() + 12U) == request.reason &&
      Equal(control.data() + 16U, request.operation_id.data(), 16U) &&
      ReadU64(control.data() + 32U) == request.generation &&
      ReadU64(control.data() + 40U) == ReadU64(prepared.bytes.data() + 832U) &&
      Equal(control.data() + 48U, identity_bytes.data(), 24U) &&
      Equal(
          control.data() + 72U,
          request.expected_receipt_sha256.data(),
          32U) &&
      Equal(
          control.data() + 104U,
          request.expected_state_sha256.data(),
          32U) &&
      Equal(control.data() + 136U, sid_hash.data(), 32U) &&
      AllZero(control.data() + 168U, 56U) &&
      Equal(control.data() + 224U, control_hash.data(), 32U);
  WipeCustodyOwned(control.data(), control.size());
  return valid;
}

bool ValidatePhaseAExternalTopology(
    ProtectedOperationsState* state,
    std::size_t expected_keyset_count,
    std::size_t expected_control_count) noexcept {
  std::size_t observed_keyset_count = 0U;
  std::size_t observed_control_count = 0U;
  if (state == nullptr ||
      !EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.keysets,
          &g_keyset_scan_entries,
          &observed_keyset_count) ||
      !EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.controls,
          &g_control_scan_entries,
          &observed_control_count) ||
      observed_keyset_count != expected_keyset_count ||
      observed_control_count != expected_control_count ||
      expected_keyset_count > kMaximumBurnedGenerations ||
      expected_control_count > kMaximumBurnedGenerations) return false;
  g_phase_a_keyset_count = expected_keyset_count;
  g_phase_a_control_count = expected_control_count;
  std::array<bool, kMaximumProtectedDirectoryEntries> matched_keysets{};
  std::array<bool, kMaximumProtectedDirectoryEntries> matched_controls{};
  for (std::size_t operation_index = 0U;
       operation_index < g_phase_a_operation_count;
       ++operation_index) {
    const PhaseAOperationInventory& operation =
        g_phase_a_operations[operation_index];
    if (!operation.present || operation.record_count == 0U) continue;
    const std::uint8_t opcode = operation.prepared.bytes[32];
    JournalRecordKind terminal_kind{};
    std::uint32_t terminal_sequence = UINT32_MAX;
    Byte32 terminal_hash{};
    if (!ValidateJournalRecord(
            operation.records[operation.record_count - 1U],
            &terminal_kind,
            &terminal_sequence,
            &terminal_hash)) return false;
    if (opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
      CreateKeysetRequest request{};
      const std::uint16_t body_length =
          ReadU16(operation.prepared.bytes.data() + 38U);
      std::array<wchar_t, 32U> component{};
      if (!DecodeCreateKeysetRequest(
              operation.prepared.bytes.data() + 112U,
              body_length,
              &request) ||
          !BuildGenerationComponent(request.requested_generation, &component)) {
        return false;
      }
      const ProtectedDirectoryEntry* final_entry = FindNamedEntryIn(
          g_keyset_scan_entries, expected_keyset_count, component.data());
      if (operation.candidate_present && final_entry != nullptr) return false;
      if (operation.candidate_present) {
        ProtectedPath candidate_path{};
        HANDLE directory = nullptr;
        ProtectedObjectIdentity identity{};
        Byte32 closure{};
        bool complete = false;
        if (operation.candidate_is_revoke ||
            !ComposeProtectedChildPath(
                operation.path, L"keyset.pending", &candidate_path) ||
            !OpenProtectedExistingDirectory(
                state->filesystem,
                candidate_path,
                false,
                &directory,
                &identity)) {
          if (directory != nullptr && directory != INVALID_HANDLE_VALUE) {
            CloseHandle(directory);
          }
          return false;
        }
        CloseHandle(directory);
        if (!BuildCandidateClosure(
                state->filesystem,
                candidate_path,
                identity,
                &operation.prepared,
                nullptr,
                &closure,
                &complete)) return false;
      }
      if (final_entry != nullptr) {
        const std::size_t final_index = static_cast<std::size_t>(
            final_entry - g_keyset_scan_entries.data());
        ProtectedPath final_path{};
        HANDLE directory = nullptr;
        ProtectedObjectIdentity identity{};
        Byte32 closure{};
        bool complete = false;
        if (final_index >= expected_keyset_count || matched_keysets[final_index] ||
            (final_entry->attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
            (final_entry->attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U ||
            !ComposeProtectedChildPath(
                state->filesystem.keysets_path, component.data(), &final_path) ||
            !OpenProtectedExistingDirectory(
                state->filesystem,
                final_path,
                false,
                &directory,
                &identity)) {
          if (directory != nullptr && directory != INVALID_HANDLE_VALUE) {
            CloseHandle(directory);
          }
          return false;
        }
        CloseHandle(directory);
        if (!BuildCandidateClosure(
                state->filesystem,
                final_path,
                identity,
                &operation.prepared,
                nullptr,
                &closure,
                &complete) ||
            !complete) return false;
        matched_keysets[final_index] = true;
      }
      if ((terminal_kind == JournalRecordKind::Committed &&
           final_entry == nullptr) ||
          (terminal_kind == JournalRecordKind::Quarantined &&
           (!operation.candidate_present || final_entry != nullptr))) return false;
      continue;
    }
    if (opcode != static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
      return false;
    }
    RevokeKeysetRequest request{};
    const std::uint16_t body_length =
        ReadU16(operation.prepared.bytes.data() + 38U);
    std::array<wchar_t, 48U> component{};
    if (!DecodeRevokeKeysetRequest(
            operation.prepared.bytes.data() + 112U,
            body_length,
            &request) ||
        !BuildControlComponent(request.generation, &component)) return false;
    const ProtectedDirectoryEntry* final_entry = FindNamedEntryIn(
        g_control_scan_entries, expected_control_count, component.data());
    if (operation.candidate_present && final_entry != nullptr) return false;
    if (operation.candidate_present &&
        operation.candidate_entry.byte_length == 256U) {
      ProtectedPath candidate_path{};
      if (!operation.candidate_is_revoke ||
          !ComposeProtectedChildPath(
              operation.path, L"revoke.pending.gckc", &candidate_path) ||
          !ValidateRevokeControlAuthority(
              state->filesystem, candidate_path, operation.prepared)) return false;
    }
    if (final_entry != nullptr) {
      const std::size_t final_index = static_cast<std::size_t>(
          final_entry - g_control_scan_entries.data());
      ProtectedPath final_path{};
      if (final_index >= expected_control_count || matched_controls[final_index] ||
          (final_entry->attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
          final_entry->byte_length != 256U ||
          !ComposeProtectedChildPath(
              state->filesystem.controls_path, component.data(), &final_path) ||
          !ValidateRevokeControlAuthority(
              state->filesystem, final_path, operation.prepared)) return false;
      matched_controls[final_index] = true;
    }
    if (terminal_kind == JournalRecordKind::Committed &&
        final_entry == nullptr) return false;
  }
  for (std::size_t index = 0U; index < expected_keyset_count; ++index) {
    if (!matched_keysets[index]) return false;
  }
  for (std::size_t index = 0U; index < expected_control_count; ++index) {
    if (!matched_controls[index]) return false;
  }
  return true;
}

bool WriteReadExact(
    const ProtectedFilesystemState& filesystem,
    HANDLE file,
    const std::uint8_t* bytes,
    std::size_t length) noexcept {
  if (!ProtectedFilesystemRecoveryCheckpoint(filesystem) || file == nullptr ||
      file == INVALID_HANDLE_VALUE || bytes == nullptr || length == 0U ||
      length > MAXDWORD) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Write)) return false;
#endif
  DWORD written = 0U;
  if (!ProtectedFilesystemRecoveryCheckpoint(filesystem) ||
      WriteFile(file, bytes, static_cast<DWORD>(length), &written, nullptr) == FALSE ||
      written != length ||
      !ProtectedFilesystemRecoveryCheckpoint(filesystem)) return false;
  LARGE_INTEGER zero{};
  if (SetFilePointerEx(file, zero, nullptr, FILE_BEGIN) == FALSE ||
      !ProtectedFilesystemRecoveryCheckpoint(filesystem)) return false;
  std::array<std::uint8_t, kJournalRecordBytes> readback{};
  if (length > readback.size()) return false;
  DWORD received = 0U;
  return ProtectedFilesystemRecoveryCheckpoint(filesystem) &&
         ReadFile(
             file,
             readback.data(),
             static_cast<DWORD>(length),
             &received,
             nullptr) != FALSE &&
         ProtectedFilesystemRecoveryCheckpoint(filesystem) &&
         received == length && Equal(readback.data(), bytes, length);
}

bool PublishJournalRecord(
    ProtectedOperationsState* state,
    const ProtectedPath& operation_path,
    std::uint32_t sequence,
    const wchar_t* kind,
    const JournalRecord& record,
    bool retain,
    HANDLE* retained,
    HANDLE parent_authority,
    const ProtectedObjectIdentity& expected_parent_identity) noexcept {
  if (state == nullptr || state->next_publication_sequence == 0U ||
      state->next_publication_sequence > kMaximumPublicationSequence) return false;
  if ((retain && (retained == nullptr || *retained != nullptr)) ||
      (!retain && retained != nullptr)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_journal_publication_stage = 0U;
  g_journal_publication_error = ERROR_SUCCESS;
  g_journal_publication_failure_active = false;
  if (!retain) {
    ++g_journal_publication_ordinary_call_count;
    g_journal_publication_failure_active =
        g_journal_publication_fail_after_stage != 0U &&
        (g_journal_publication_fail_on_ordinary_call == 0U ||
         g_journal_publication_fail_on_ordinary_call ==
             g_journal_publication_ordinary_call_count);
  }
#endif
  std::uint16_t publication_sequence = 0U;
  if (!GetJournalPublicationSequence(record, &publication_sequence) ||
      publication_sequence != state->next_publication_sequence) return false;
  const ProtectedFilesystemState& filesystem = state->filesystem;
  std::array<wchar_t, 48U> pending_component{};
  std::array<wchar_t, 48U> final_component{};
  ProtectedPath pending_path{};
  ProtectedPath final_path{};
  HANDLE file = nullptr;
  ProtectedObjectIdentity published_identity{};
  Byte32 published_hash{};
  ProtectedObjectIdentity initial_parent_identity{};
  if (parent_authority == nullptr ||
      parent_authority == INVALID_HANDLE_VALUE ||
      !CaptureProtectedObjectIdentity(
           filesystem, parent_authority, &initial_parent_identity) ||
       !EqualMoveIdentity(
           initial_parent_identity, expected_parent_identity)) {
    return false;
  }
  if (!BuildRecordComponent(sequence, kind, true, &pending_component) ||
      !BuildRecordComponent(sequence, kind, false, &final_component) ||
      !ComposeProtectedChildPath(operation_path, pending_component.data(), &pending_path) ||
      !ComposeProtectedChildPath(operation_path, final_component.data(), &final_path) ||
      !CreateProtectedFile(filesystem, pending_path, retain, &file) ||
      !WriteReadExact(filesystem, file, record.bytes.data(), record.bytes.size()) ||
      !CaptureProtectedObjectIdentity(
          filesystem, file, &published_identity) ||
      !ComputeSha256(
          record.bytes.data(), record.bytes.size(), &published_hash) ||
      !RecordJournalPublicationStep(
          FlushAndRenameProtectedFile(filesystem, file, final_path), 1U)) {
    if (file != nullptr && file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return false;
  }
  if (!retain) {
    CloseHandle(file);
    file = nullptr;
    std::array<std::uint8_t, kJournalRecordBytes> final_bytes{};
    std::size_t final_length = 0U;
    ProtectedObjectIdentity final_identity{};
    Byte32 final_hash{};
    const bool final_valid = RecordJournalPublicationStep(
        ReadProtectedFinalFile(
                                 filesystem,
                                 final_path,
                                 final_bytes.data(),
                                 final_bytes.size(),
                                 &final_length,
                                 &final_identity) &&
        final_length == record.bytes.size() &&
        EqualMoveIdentity(final_identity, published_identity) &&
        Equal(final_bytes.data(), record.bytes.data(), final_length) &&
        ComputeSha256(final_bytes.data(), final_length, &final_hash) &&
        Equal(final_hash.data(), published_hash.data(), final_hash.size()),
        2U) &&
        RecordJournalPublicationStep(
            ProtectedPathIsAbsentGuarded(filesystem, pending_path), 3U);
    WipeCustodyOwned(final_bytes.data(), final_bytes.size());
    if (!final_valid) {
      return false;
    }
  }
  ProtectedObjectIdentity final_parent_identity{};
  if (!RecordJournalPublicationStep(
          CaptureProtectedObjectIdentity(
              filesystem, parent_authority, &final_parent_identity) &&
          EqualMoveIdentity(
              final_parent_identity, expected_parent_identity),
          4U)) {
    if (file != nullptr && file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return false;
  }
  if (retain) {
    *retained = file;
    file = nullptr;
  }
  ++state->next_publication_sequence;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_journal_publication_stage = 5U;
#endif
  return true;
}

struct JournalParentAuthority final {
  HANDLE handle{nullptr};
  ProtectedObjectIdentity identity{};

  JournalParentAuthority() noexcept = default;
  JournalParentAuthority(const JournalParentAuthority&) = delete;
  JournalParentAuthority& operator=(const JournalParentAuthority&) = delete;

  ~JournalParentAuthority() noexcept {
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};

bool OpenJournalParentAuthority(
    ProtectedOperationsState* state,
    const ProtectedPath& operation_path,
    JournalParentAuthority* authority) noexcept {
  return state != nullptr && authority != nullptr &&
         authority->handle == nullptr &&
         OpenProtectedExistingDirectory(
             state->filesystem,
             operation_path,
             true,
             &authority->handle,
             &authority->identity);
}

bool PublishJournalRecordWithOwnedParent(
    ProtectedOperationsState* state,
    const ProtectedPath& operation_path,
    std::uint32_t sequence,
    const wchar_t* kind,
    const JournalRecord& record,
    bool retain,
    HANDLE* retained) noexcept {
  if (state == nullptr) return false;
  JournalParentAuthority parent{};
  return OpenJournalParentAuthority(state, operation_path, &parent) &&
         PublishJournalRecord(
      state,
      operation_path,
      sequence,
      kind,
      record,
      retain,
      retained,
      parent.handle,
      parent.identity);
}

bool PublishPreparedOperationDirectory(
    ProtectedOperationsState* state,
    const Byte16& operation_id,
    const JournalRecord& prepared,
    ProtectedPath* final_operation_path,
    HANDLE* final_operation_directory) noexcept {
  if (state == nullptr || final_operation_path == nullptr ||
      final_operation_directory == nullptr) {
    return false;
  }
  WipeCustodyOwned(final_operation_path, sizeof(*final_operation_path));
  *final_operation_directory = nullptr;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_prepared_publication_stage = 0U;
  g_prepared_publication_error = ERROR_SUCCESS;
#endif
  std::array<wchar_t, 48U> pending_operation_component{};
  std::array<wchar_t, 48U> final_operation_component{};
  std::array<wchar_t, 48U> pending_prepared_component{};
  std::array<wchar_t, 48U> prepared_component{};
  ProtectedPath pending_operation_path{};
  ProtectedPath final_path{};
  ProtectedPath final_pending_prepared_path{};
  ProtectedPath final_prepared_path{};
  HANDLE operation_directory = nullptr;
  HANDLE prepared_file = nullptr;
  HANDLE post_move_directory = nullptr;
  HANDLE post_move_prepared_file = nullptr;
  HANDLE validation_directory = nullptr;
  HANDLE mutable_directory = nullptr;
  ProtectedObjectIdentity operation_identity{};
  ProtectedObjectIdentity prepared_identity{};
  ProtectedObjectIdentity post_move_operation_identity{};
  ProtectedObjectIdentity post_move_prepared_identity{};
  ProtectedObjectIdentity validation_operation_identity{};
  ProtectedObjectIdentity validation_prepared_identity{};
  ProtectedObjectIdentity mutable_operation_identity{};
  std::array<std::uint8_t, kJournalRecordBytes> captured_prepared_bytes{};
  std::array<std::uint8_t, kJournalRecordBytes> post_move_prepared_bytes{};
  std::array<std::uint8_t, kJournalRecordBytes> final_prepared_bytes{};
  std::size_t captured_prepared_length = 0U;
  std::uint64_t post_move_prepared_length = 0U;
  std::size_t post_move_read_length = 0U;
  std::size_t final_prepared_length = 0U;
  std::size_t final_entry_count = 0U;
  Byte32 captured_prepared_hash{};
  Byte32 post_move_prepared_hash{};
  Byte32 final_prepared_hash{};
  bool valid = RecordPreparedPublicationStep(
      BuildOperationComponent(
          operation_id, true, &pending_operation_component) &&
      BuildOperationComponent(
          operation_id, false, &final_operation_component) &&
      BuildRecordComponent(
          0U, L"prepared", true, &pending_prepared_component) &&
      BuildRecordComponent(0U, L"prepared", false, &prepared_component) &&
      ComposeProtectedChildPath(
          state->filesystem.journal_path,
          pending_operation_component.data(),
          &pending_operation_path) &&
      ComposeProtectedChildPath(
          state->filesystem.journal_path,
          final_operation_component.data(),
          &final_path) &&
      ComposeProtectedChildPath(
          final_path,
          pending_prepared_component.data(),
          &final_pending_prepared_path) &&
      ComposeProtectedChildPath(
          final_path, prepared_component.data(), &final_prepared_path),
      1U) &&
      RecordPreparedPublicationStep(CreateProtectedDirectory(
          state->filesystem,
          pending_operation_path,
          &operation_directory), 2U) &&
      RecordPreparedPublicationStep(CaptureProtectedObjectIdentity(
          state->filesystem, operation_directory, &operation_identity), 3U) &&
      RecordPreparedPublicationStep(PublishJournalRecord(
          state,
          pending_operation_path,
          0U,
          L"prepared",
          prepared,
          true,
          &prepared_file,
          operation_directory,
          operation_identity), 4U);
  valid = valid && RecordPreparedPublicationStep(
      CaptureProtectedObjectIdentity(
          state->filesystem, prepared_file, &prepared_identity), 50U);
  valid = valid && RecordPreparedPublicationStep(ReadProtectedOpenFile(
          state->filesystem,
          prepared_file,
          captured_prepared_bytes.data(),
          captured_prepared_bytes.size(),
          &captured_prepared_length,
          &prepared_identity), 51U);
  valid = valid && RecordPreparedPublicationStep(
      captured_prepared_length == prepared.bytes.size() &&
      Equal(
          captured_prepared_bytes.data(),
          prepared.bytes.data(),
          prepared.bytes.size()) &&
      ComputeSha256(
          captured_prepared_bytes.data(),
          captured_prepared_length,
          &captured_prepared_hash), 52U);
  valid = valid && RecordPreparedPublicationStep(EnumerateProtectedDirectory(
          state->filesystem,
          operation_directory,
          &g_recovery_entries,
          &final_entry_count), 53U);
  valid = valid && RecordPreparedPublicationStep(
      final_entry_count == 1U &&
      (g_recovery_entries[0].attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
      g_recovery_entries[0].byte_length == kJournalRecordBytes &&
      EqualWide(
          g_recovery_entries[0].name.data(),
          g_recovery_entries[0].name_length,
          prepared_component.data()), 54U);
  if (prepared_file != nullptr && prepared_file != INVALID_HANDLE_VALUE) {
    CloseHandle(prepared_file);
    prepared_file = nullptr;
  }
  if (valid) {
    RecordPreparedPublicationStep(true, 6U);
  }
  valid = valid && RecordPreparedPublicationStep(RenameProtectedDirectory(
      state->filesystem, operation_directory, final_path), 7U);
  if (operation_directory != nullptr &&
      operation_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(operation_directory);
    operation_directory = nullptr;
  }
  if (valid) {
    RecordPreparedPublicationStep(true, 8U);
  }
  valid = valid && RecordPreparedPublicationStep(OpenProtectedExistingDirectory(
          state->filesystem,
          final_path,
          true,
          &post_move_directory,
          &post_move_operation_identity) &&
      post_move_operation_identity.volume_serial_number ==
          operation_identity.volume_serial_number &&
      Equal(
          post_move_operation_identity.file_id.data(),
          operation_identity.file_id.data(),
          post_move_operation_identity.file_id.size()), 9U) &&
      RecordPreparedPublicationStep(OpenProtectedExistingFileForParentRename(
          state->filesystem,
          final_prepared_path,
          kJournalRecordBytes,
          &post_move_prepared_file,
          &post_move_prepared_length,
          &post_move_prepared_identity) &&
      post_move_prepared_length == captured_prepared_length &&
      post_move_prepared_identity.volume_serial_number ==
          prepared_identity.volume_serial_number &&
      Equal(
          post_move_prepared_identity.file_id.data(),
          prepared_identity.file_id.data(),
          post_move_prepared_identity.file_id.size()) &&
      ReadProtectedOpenFile(
          state->filesystem,
          post_move_prepared_file,
          post_move_prepared_bytes.data(),
          post_move_prepared_bytes.size(),
          &post_move_read_length,
          &post_move_prepared_identity) &&
      post_move_read_length == captured_prepared_length &&
      Equal(
          post_move_prepared_bytes.data(),
          captured_prepared_bytes.data(),
          captured_prepared_length) &&
      ComputeSha256(
          post_move_prepared_bytes.data(),
          post_move_read_length,
          &post_move_prepared_hash) &&
      Equal(
          post_move_prepared_hash.data(),
          captured_prepared_hash.data(),
          post_move_prepared_hash.size()) &&
      ProtectedPathIsAbsentGuarded(
          state->filesystem, pending_operation_path) &&
      ProtectedPathIsAbsentGuarded(
          state->filesystem, final_pending_prepared_path), 10U) &&
      RecordPreparedPublicationStep(FlushProtectedOpenFileForParentRename(
          state->filesystem, post_move_prepared_file, true), 11U);
  if (post_move_prepared_file != nullptr &&
      post_move_prepared_file != INVALID_HANDLE_VALUE) {
    CloseHandle(post_move_prepared_file);
    post_move_prepared_file = nullptr;
  }
  if (post_move_directory != nullptr &&
      post_move_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(post_move_directory);
    post_move_directory = nullptr;
  }
  if (valid) {
    RecordPreparedPublicationStep(true, 12U);
  }
  final_entry_count = 0U;
  valid = valid && RecordPreparedPublicationStep(OpenProtectedExistingDirectory(
          state->filesystem,
          final_path,
          false,
          &validation_directory,
          &validation_operation_identity) &&
      validation_operation_identity.volume_serial_number ==
          operation_identity.volume_serial_number &&
      Equal(
          validation_operation_identity.file_id.data(),
          operation_identity.file_id.data(),
          validation_operation_identity.file_id.size()) &&
      EnumerateProtectedDirectory(
          state->filesystem,
          validation_directory,
          &g_recovery_entries,
          &final_entry_count) &&
      final_entry_count == 1U &&
      (g_recovery_entries[0].attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
      g_recovery_entries[0].byte_length == kJournalRecordBytes &&
      EqualWide(
          g_recovery_entries[0].name.data(),
          g_recovery_entries[0].name_length,
          prepared_component.data()), 13U) &&
      RecordPreparedPublicationStep(ReadProtectedFinalFile(
          state->filesystem,
          final_prepared_path,
          final_prepared_bytes.data(),
          final_prepared_bytes.size(),
          &final_prepared_length,
          &validation_prepared_identity) &&
      final_prepared_length == captured_prepared_length &&
      validation_prepared_identity.volume_serial_number ==
          prepared_identity.volume_serial_number &&
      Equal(
          validation_prepared_identity.file_id.data(),
          prepared_identity.file_id.data(),
          validation_prepared_identity.file_id.size()) &&
      Equal(
          final_prepared_bytes.data(),
          captured_prepared_bytes.data(),
          captured_prepared_length) &&
      ComputeSha256(
          final_prepared_bytes.data(),
          final_prepared_length,
          &final_prepared_hash) &&
      Equal(
          final_prepared_hash.data(),
          captured_prepared_hash.data(),
          final_prepared_hash.size()) &&
      ProtectedPathIsAbsentGuarded(
          state->filesystem, pending_operation_path) &&
      ProtectedPathIsAbsentGuarded(
          state->filesystem, final_pending_prepared_path), 14U);
  if (validation_directory != nullptr &&
      validation_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(validation_directory);
    validation_directory = nullptr;
  }
  if (valid) {
    RecordPreparedPublicationStep(true, 15U);
  }
  valid = valid && RecordPreparedPublicationStep(OpenProtectedExistingDirectory(
          state->filesystem,
          final_path,
          true,
          &mutable_directory,
          &mutable_operation_identity), 16U) &&
      mutable_operation_identity.volume_serial_number ==
          operation_identity.volume_serial_number &&
      Equal(
          mutable_operation_identity.file_id.data(),
          operation_identity.file_id.data(),
          mutable_operation_identity.file_id.size());
  WipeCustodyOwned(
      captured_prepared_bytes.data(), captured_prepared_bytes.size());
  WipeCustodyOwned(
      post_move_prepared_bytes.data(), post_move_prepared_bytes.size());
  WipeCustodyOwned(
      final_prepared_bytes.data(), final_prepared_bytes.size());
  if (!valid) {
    if (mutable_directory != nullptr &&
        mutable_directory != INVALID_HANDLE_VALUE) {
      CloseHandle(mutable_directory);
    }
    return false;
  }
  *final_operation_path = final_path;
  *final_operation_directory = mutable_directory;
  return true;
}

bool CompleteOutcomeRecovery(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    RecoveredJournalOperation* completed) noexcept {
  if (state == nullptr || completed == nullptr || !operation.present || operation.committed ||
      operation.quarantined || !operation.outcome_present ||
      operation.attempt_count >= kMaximumJournalAttempts) return false;
  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  const std::uint64_t creation_time =
      static_cast<std::uint64_t>(now.dwLowDateTime) |
      (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
  JournalParentAuthority parent{};
  if (!OpenJournalParentAuthority(state, operation.path, &parent)) return false;
  JournalRecord recovery_attempt{};
  JournalRecord committed{};
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Attempt,
          1U,
          operation.prepared,
          operation.prior,
          nullptr,
          nullptr,
          0U,
          creation_time,
          state->next_publication_sequence,
          &recovery_attempt) ||
      !PublishJournalRecord(
          state,
          operation.path,
          operation.next_sequence,
          L"attempt",
          recovery_attempt,
          false,
          nullptr,
          parent.handle,
          parent.identity) ||
      !EncodeFollowingJournalRecord(
          JournalRecordKind::Committed,
          0U,
          operation.prepared,
          recovery_attempt,
          nullptr,
          operation.outcome.bytes.data() + 400U,
          432U,
          creation_time,
          state->next_publication_sequence,
          &committed) ||
      !PublishJournalRecord(
          state,
          operation.path,
          operation.next_sequence + 1U,
          L"committed",
          committed,
          false,
          nullptr,
          parent.handle,
          parent.identity)) return false;
  *completed = operation;
  completed->committed = true;
  completed->prior = committed;
  completed->next_sequence += 2U;
  ++completed->attempt_count;
  completed->result_length = ReadU32(operation.outcome.bytes.data() + 404U);
  if (completed->result_length > completed->result.size()) return false;
  std::memcpy(
      completed->result.data(),
      operation.outcome.bytes.data() + 512U,
      completed->result_length);
  return true;
}

bool RecoverJournalOperation(
    ProtectedOperationsState* state,
    const ProtectedPath& parent_path,
    const ProtectedDirectoryEntry& entry,
    bool quarantine_location,
    RecoveredJournalOperation* recovered,
    bool phase_a_ignore_pending = false) noexcept {
  if (state == nullptr || recovered == nullptr ||
      (entry.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
      (entry.attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U) return false;
  const ProtectedFilesystemState& filesystem = state->filesystem;
  WipeCustodyOwned(recovered, sizeof(*recovered));
  if (!ParseOperationComponent(entry, &recovered->operation_id) ||
      !ComposeProtectedChildPath(parent_path, entry.name.data(), &recovered->path)) return false;
  HANDLE directory = nullptr;
  ProtectedObjectIdentity directory_identity{};
  if (!OpenProtectedExistingDirectory(
          filesystem,
          recovered->path,
          false,
          &directory,
          &directory_identity)) return false;
  std::size_t entry_count = 0U;
  if (!EnumerateProtectedDirectory(
          filesystem, directory, &g_recovery_entries, &entry_count)) {
    CloseHandle(directory);
    return false;
  }
  CloseHandle(directory);
  // Phase B owns every normalization mutation. Recovery reconstruction is
  // strictly read-only and rejects any provisional source that survived it.
  for (std::size_t index = 0U; index < entry_count; ++index) {
    std::uint32_t pending_sequence = 0U;
    JournalRecordKind pending_kind{};
    if (ParsePendingRecordComponent(
            g_recovery_entries[index], &pending_sequence, &pending_kind) &&
        !phase_a_ignore_pending) {
      return false;
    }
  }
  std::size_t record_count = 0U;
  std::uint32_t highest_sequence = 0U;
  bool candidate_present = false;
  bool candidate_is_revoke = false;
  ProtectedDirectoryEntry candidate_entry{};
  for (std::size_t index = 0U; index < entry_count; ++index) {
    std::uint32_t sequence = 0U;
    JournalRecordKind kind{};
    JournalRecordKind ignored_pending_kind{};
    if (phase_a_ignore_pending && ParsePendingRecordComponent(
            g_recovery_entries[index], &sequence, &ignored_pending_kind)) {
      continue;
    }
    if (ParseRecordComponent(g_recovery_entries[index], &sequence, &kind)) {
      if ((g_recovery_entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
          g_recovery_entries[index].byte_length != kJournalRecordBytes) return false;
      ++record_count;
      if (sequence > highest_sequence) highest_sequence = sequence;
      continue;
    }
    if (EqualWide(
            g_recovery_entries[index].name.data(),
            g_recovery_entries[index].name_length,
            L"keyset.pending") &&
        (g_recovery_entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U &&
        !candidate_present) {
      candidate_present = true;
      candidate_entry = g_recovery_entries[index];
      continue;
    }
    if (EqualWide(
            g_recovery_entries[index].name.data(),
            g_recovery_entries[index].name_length,
            L"revoke.pending.gckc") &&
        (g_recovery_entries[index].attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U &&
        g_recovery_entries[index].byte_length <= 256U &&
        !candidate_present) {
      candidate_present = true;
      candidate_is_revoke = true;
      candidate_entry = g_recovery_entries[index];
      continue;
    }
    return false;
  }
  if (record_count == 0U || highest_sequence + 1U != record_count) return false;
  JournalRecord prior{};
  bool outcome_present = false;
  bool committed_present = false;
  bool quarantined_present = false;
  std::uint16_t latest_revoke_residue_publication_sequence = 0U;
  for (const ProtectedResidueProjection& residue : g_deferred_residues) {
    if (residue.present && residue.bytes[17] == 3U &&
        Equal(
            residue.bytes.data(),
            recovered->operation_id.data(),
            recovered->operation_id.size())) {
      const std::uint16_t residue_publication_sequence =
          ReadU16(residue.bytes.data() + 18U);
      if (residue_publication_sequence >
          latest_revoke_residue_publication_sequence) {
        latest_revoke_residue_publication_sequence =
            residue_publication_sequence;
      }
    }
  }
  for (std::uint32_t sequence = 0U; sequence <= highest_sequence; ++sequence) {
    JournalRecordKind filename_kind{};
    const ProtectedDirectoryEntry* record_entry =
        FindRecordEntry(entry_count, sequence, &filename_kind);
    JournalRecord current{};
    JournalRecordKind record_kind{};
    std::uint32_t record_sequence = UINT32_MAX;
    Byte32 record_hash{};
    if (record_entry == nullptr ||
        !ReadJournalRecord(filesystem, recovered->path, *record_entry, &current) ||
        !ValidateJournalRecord(current, &record_kind, &record_sequence, &record_hash) ||
        record_kind != filename_kind || record_sequence != sequence) return false;
    if (sequence == 0U) {
      if (record_kind != JournalRecordKind::Prepared ||
          !Equal(current.bytes.data() + 16U, recovered->operation_id.data(), 16U)) return false;
      recovered->prepared = current;
    } else if (!ValidateJournalTransition(recovered->prepared, prior, current)) {
      return false;
    }
    if (record_kind == JournalRecordKind::Attempt) {
      ++recovered->attempt_count;
      std::uint16_t publication_sequence = 0U;
      const bool effect_attempt = current.bytes[7] == 0U || current.bytes[7] == 1U;
      if (effect_attempt &&
          recovered->effect_authorizing_publication_sequence == 0U &&
          GetJournalPublicationSequence(current, &publication_sequence) &&
          (recovered->prepared.bytes[32] ==
               static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
           publication_sequence > latest_revoke_residue_publication_sequence)) {
        recovered->effect_authorizing_publication_sequence =
            publication_sequence;
      }
    }
    if (recovered->attempt_count > kMaximumJournalAttempts) return false;
    if (record_kind == JournalRecordKind::Outcome) {
      if (outcome_present || committed_present || quarantined_present) return false;
      recovered->outcome = current;
      outcome_present = true;
    } else if (record_kind == JournalRecordKind::Committed) {
      if (!outcome_present || committed_present || quarantined_present ||
          !Equal(current.bytes.data() + 400U, recovered->outcome.bytes.data() + 400U, 432U)) {
        return false;
      }
      committed_present = true;
    } else if (record_kind == JournalRecordKind::Quarantined) {
      if (outcome_present || committed_present || quarantined_present) return false;
      quarantined_present = true;
    }
    prior = current;
  }
  if (quarantine_location && (!quarantined_present || committed_present)) return false;
  if (committed_present && candidate_present) return false;
  if (quarantined_present && !candidate_present) return false;
  recovered->quarantined = quarantined_present;
  recovered->committed = committed_present;
  recovered->outcome_present = outcome_present;
  recovered->candidate_present = candidate_present;
  recovered->opcode = recovered->prepared.bytes[32];
  if ((outcome_present || committed_present || quarantined_present) &&
      recovered->effect_authorizing_publication_sequence == 0U) return false;
  if (candidate_present &&
      ((candidate_is_revoke &&
        recovered->opcode !=
            static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) ||
       (!candidate_is_revoke &&
        recovered->opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset)))) {
    return false;
  }
  recovered->prior = prior;
  recovered->next_sequence = highest_sequence + 1U;
  const JournalRecord& terminal = quarantined_present ? prior : recovered->outcome;
  recovered->result_length = outcome_present || quarantined_present
      ? ReadU32(terminal.bytes.data() + 404U)
      : 0U;
  if ((committed_present &&
       ((recovered->opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
          recovered->result_length != kCreateKeysetResultBytes) ||
         (recovered->opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
          recovered->result_length != kRevokeKeysetResultBytes))) ||
      (quarantined_present &&
       (recovered->opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
        recovered->result_length != 0U))) return false;
  if (committed_present) {
    std::memcpy(
        recovered->result.data(),
        terminal.bytes.data() + 512U,
        recovered->result_length);
  }
  if (candidate_present) {
    ProtectedPath candidate_path{};
    if (!ComposeProtectedChildPath(
            recovered->path,
            candidate_entry.name.data(),
            &candidate_path)) return false;
    if (candidate_is_revoke) {
      std::size_t candidate_length = 0U;
      if (candidate_entry.byte_length == 0U) {
        recovered->candidate_length = 0U;
        recovered->candidate_complete = false;
      } else if (!ReadProtectedExistingFile(
                     filesystem,
                     candidate_path,
                     recovered->candidate_bytes.data(),
                     recovered->candidate_bytes.size(),
                     &candidate_length,
                     &recovered->candidate_identity) ||
                 candidate_length != candidate_entry.byte_length) {
        return false;
      } else {
        recovered->candidate_length =
            static_cast<std::uint32_t>(candidate_length);
        recovered->candidate_complete = candidate_length == 256U;
      }
    } else {
      HANDLE candidate_directory = nullptr;
      if (!OpenProtectedExistingDirectory(
              filesystem,
              candidate_path,
              false,
              &candidate_directory,
              &recovered->candidate_identity)) {
        if (candidate_directory != nullptr) CloseHandle(candidate_directory);
        return false;
      }
      CloseHandle(candidate_directory);
      bool complete_closure = false;
      if (!BuildCandidateClosure(
              filesystem,
              candidate_path,
              recovered->candidate_identity,
              &recovered->prepared,
              nullptr,
              &recovered->candidate_closure,
              &complete_closure) ||
          (quarantined_present && !Equal(
              recovered->candidate_closure.data(),
              terminal.bytes.data() + 448U,
              32U))) return false;
      recovered->candidate_complete = complete_closure;
    }
  }
  recovered->present = true;
  return true;
}

bool CreateAndWriteKeyFile(
    const ProtectedFilesystemState& filesystem,
    const ProtectedPath& directory,
    const wchar_t* name,
    const std::uint8_t* bytes,
    std::size_t length,
    HANDLE* file,
    ProtectedObjectIdentity* identity,
    Byte32* content_sha256) noexcept {
  ProtectedPath path{};
  if (file == nullptr || identity == nullptr || content_sha256 == nullptr ||
      !ComposeProtectedChildPath(directory, name, &path) ||
      !CreateProtectedFile(filesystem, path, true, file) ||
      !CaptureProtectedObjectIdentity(filesystem, *file, identity) ||
      !WriteReadExact(filesystem, *file, bytes, length) ||
      !ProtectedFilesystemRecoveryCheckpoint(filesystem) ||
      FlushFileBuffers(*file) == FALSE ||
      !ProtectedFilesystemRecoveryCheckpoint(filesystem) ||
      !ComputeSha256(bytes, length, content_sha256)) {
    if (file != nullptr && *file != nullptr && *file != INVALID_HANDLE_VALUE) {
      CloseHandle(*file);
      *file = nullptr;
    }
    return false;
  }
  return true;
}

void RememberReplay(
    ProtectedOperationReplayState* replay,
    std::uint8_t opcode,
    const Byte16& operation_id,
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const std::uint8_t* body,
    std::uint16_t body_length,
    const Byte32& stable_binding,
    bool quarantined,
    const ProtectedPath& operation_path,
    const JournalRecord& prepared,
    const JournalRecord& prior,
    std::uint32_t next_sequence,
    const std::array<std::uint8_t, kCreateKeysetResultBytes>& result,
    std::uint32_t result_length) noexcept {
  if (replay == nullptr || operator_sid == nullptr || body == nullptr ||
      operator_sid_length == 0U || operator_sid_length > replay->operator_sid.size() ||
      body_length == 0U || body_length > replay->body.size() ||
      result_length == 0U || result_length > replay->result.size()) return;
  WipeCustodyOwned(replay, sizeof(*replay));
  replay->present = true;
  replay->quarantined = quarantined;
  replay->opcode = opcode;
  replay->operation_id = operation_id;
  replay->operator_sid_length = operator_sid_length;
  std::memcpy(replay->operator_sid.data(), operator_sid, operator_sid_length);
  replay->body_length = body_length;
  std::memcpy(replay->body.data(), body, body_length);
  replay->stable_binding = stable_binding;
  replay->attempt_count = 1U;
  replay->next_sequence = next_sequence;
  replay->result_length = result_length;
  replay->result = result;
  replay->operation_path = operation_path;
  replay->prepared = prepared;
  replay->prior = prior;
}

bool ReplayAuthorityMatches(
    const ProtectedOperationReplayState& replay,
    const std::uint8_t* body,
    std::uint32_t body_length,
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    bool* body_matches,
    bool* operator_matches) noexcept {
  if (!replay.present || body == nullptr || operator_sid == nullptr ||
      body_matches == nullptr || operator_matches == nullptr) return false;
  *body_matches = body_length == replay.body_length &&
                  Equal(body, replay.body.data(), body_length);
  *operator_matches = operator_sid_length == replay.operator_sid_length &&
                      Equal(operator_sid, replay.operator_sid.data(), operator_sid_length);
  return true;
}

ProtectedOperationResult AppendCommittedReplay(
    ProtectedOperationsState* state,
    ProtectedOperationReplayState* replay,
    const Byte32& authenticated_binding,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* result,
    std::uint32_t* result_length) noexcept {
  if (state == nullptr || replay == nullptr || result == nullptr || result_length == nullptr ||
      replay->quarantined || replay->attempt_count >= kMaximumJournalAttempts) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  const std::uint64_t replay_time =
      static_cast<std::uint64_t>(now.dwLowDateTime) |
      (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
  JournalRecord replay_attempt{};
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Attempt,
          2U,
          replay->prepared,
          replay->prior,
          &authenticated_binding,
          nullptr,
          0U,
          replay_time,
          state->next_publication_sequence,
          &replay_attempt) ||
      !PublishJournalRecordWithOwnedParent(
          state,
          replay->operation_path,
          replay->next_sequence,
          L"attempt",
          replay_attempt,
          false,
          nullptr)) return ProtectedOperationResult::CustodyOrJournal;
  *result = replay->result;
  WriteU16(result->data() + 2U, 2U);
  Copy32(state->state_sha256, result->data() + 72U);
  Copy32(state->state_sha256, result->data() + 104U);
  replay->prior = replay_attempt;
  ++replay->next_sequence;
  ++replay->attempt_count;
  *result_length = replay->result_length;
  return ProtectedOperationResult::Success;
}

const ProtectedOperationProjection* FindOperationProjection(
    const ProtectedOperationsState& state,
    const Byte16& operation_id) noexcept {
  for (const ProtectedOperationProjection& projection : state.operations) {
    if (projection.present &&
        Equal(projection.bytes.data(), operation_id.data(), operation_id.size())) {
      return &projection;
    }
  }
  return nullptr;
}

const ProtectedGenerationProjection* FindGenerationProjection(
    const ProtectedOperationsState& state,
    std::uint64_t generation) noexcept {
  if (generation == 0U) return nullptr;
  for (const ProtectedGenerationProjection& projection : state.generations) {
    if (projection.present && ReadU64(projection.bytes.data()) == generation) {
      return &projection;
    }
  }
  return nullptr;
}

bool LoadReplayAuthority(
    ProtectedOperationsState* state,
    const ProtectedOperationProjection& projection,
    ProtectedOperationReplayState* replay) noexcept {
  if (state == nullptr || replay == nullptr ||
      !OperationProjectionValid(projection) || projection.bytes[17] == 3U) {
    return false;
  }
  Byte16 operation_id{};
  std::memcpy(operation_id.data(), projection.bytes.data(), operation_id.size());
  std::array<wchar_t, 48U> component{};
  ProtectedDirectoryEntry entry{};
  if (!BuildOperationComponent(operation_id, false, &component)) return false;
  std::size_t component_length = 0U;
  while (component[component_length] != L'\0') ++component_length;
  if (component_length == 0U || component_length >= entry.name.size()) return false;
  std::memcpy(
      entry.name.data(), component.data(), (component_length + 1U) * sizeof(wchar_t));
  entry.name_length = component_length;
  entry.attributes = FILE_ATTRIBUTE_DIRECTORY;
  const bool quarantined = projection.bytes[17] == 2U;
  RecoveredJournalOperation recovered{};
  if (!RecoverJournalOperation(
          state,
          quarantined ? state->filesystem.quarantine_path
                      : state->filesystem.journal_path,
          entry,
          quarantined,
          &recovered) ||
      recovered.operation_id != operation_id ||
      recovered.opcode != projection.bytes[16] ||
      (quarantined ? !recovered.quarantined : !recovered.committed)) {
    return false;
  }
  const std::uint16_t sid_length = ReadU16(recovered.prepared.bytes.data() + 36U);
  const std::uint16_t body_length = ReadU16(recovered.prepared.bytes.data() + 38U);
  Byte32 stable_binding{};
  std::memcpy(
      stable_binding.data(), recovered.prepared.bytes.data() + 304U,
      stable_binding.size());
  std::array<std::uint8_t, kCreateKeysetResultBytes> replay_result{};
  std::uint32_t replay_result_length = recovered.result_length;
  if (quarantined) {
    CreateKeysetRequest request{};
    if (!DecodeCreateKeysetRequest(
            recovered.prepared.bytes.data() + 112U, body_length, &request)) {
      return false;
    }
    WriteU16(replay_result.data(), 1U);
    WriteU16(replay_result.data() + 2U, 10U);
    std::memcpy(replay_result.data() + 8U, request.operation_id.data(), 16U);
    WriteU64(replay_result.data() + 24U, request.requested_generation);
    WriteU64(replay_result.data() + 32U, request.predecessor_generation);
    std::memcpy(
        replay_result.data() + 40U,
        request.expected_state_sha256.data(),
        request.expected_state_sha256.size());
    Copy32(state->state_sha256, replay_result.data() + 72U);
    Copy32(state->state_sha256, replay_result.data() + 104U);
    replay_result_length = kCreateKeysetResultBytes;
  } else {
    replay_result = recovered.result;
  }
  RememberReplay(
      replay,
      recovered.opcode,
      recovered.operation_id,
      recovered.prepared.bytes.data() + 40U,
      sid_length,
      recovered.prepared.bytes.data() + 112U,
      body_length,
      stable_binding,
      quarantined,
      recovered.path,
      recovered.prepared,
      recovered.prior,
      recovered.next_sequence,
      replay_result,
      replay_result_length);
  replay->attempt_count = recovered.attempt_count;
  return replay->present;
}

bool ComputeCommittedState(
    const ProtectedOperationsState& state,
    const CreateKeysetRequest& request,
    const Byte32& stable_binding,
    const ProtectedObjectIdentity& directory_identity,
    const std::array<ProtectedObjectIdentity, 5U>& file_identities,
    const std::array<Byte32, 4U>& file_hashes,
    const Byte32& receipt_hash,
    ProtectedGenerationProjection* generation_projection,
    ProtectedOperationProjection* operation_projection,
    Byte32* output) noexcept {
  if (output == nullptr || generation_projection == nullptr ||
      operation_projection == nullptr) return false;

  std::array<std::uint8_t, kGenerationEntryBytes> generation{};
  WriteU64(generation.data(), request.requested_generation);
  WriteU64(generation.data() + 8U, request.predecessor_generation);
  generation[16] = 1U;
  std::memcpy(generation.data() + 24U, request.operation_id.data(), 16U);
  IdentityBytes(directory_identity, generation.data() + 40U);
  const std::size_t identity_offsets[] = {64U, 88U, 112U, 136U, 160U};
  for (std::size_t index = 0U; index < file_identities.size(); ++index) {
    IdentityBytes(file_identities[index], generation.data() + identity_offsets[index]);
  }
  const std::size_t hash_offsets[] = {184U, 216U, 248U, 280U};
  for (std::size_t index = 0U; index < file_hashes.size(); ++index) {
    Copy32(file_hashes[index], generation.data() + hash_offsets[index]);
  }
  Copy32(receipt_hash, generation.data() + 312U);

  std::array<std::uint8_t, kOperationEntryBytes> operation{};
  std::memcpy(operation.data(), request.operation_id.data(), 16U);
  operation[16] = static_cast<std::uint8_t>(Opcode::CreateKeyset);
  operation[17] = 1U;
  WriteU64(operation.data() + 24U, request.requested_generation);
  Copy32(stable_binding, operation.data() + 32U);

  generation_projection->present = true;
  generation_projection->bytes = generation;
  operation_projection->present = true;
  operation_projection->bytes = operation;
  return BuildCanonicalState(
      state, generation_projection, operation_projection, nullptr, output);
}

bool ComputeQuarantinedState(
    const ProtectedOperationsState& state,
    const CreateKeysetRequest& request,
    const Byte32& stable_binding,
    const ProtectedObjectIdentity& candidate_identity,
    const Byte32& candidate_closure,
    ProtectedGenerationProjection* generation_projection,
    ProtectedOperationProjection* operation_projection,
    Byte32* output) noexcept {
  if (output == nullptr || generation_projection == nullptr ||
      operation_projection == nullptr) return false;

  std::array<std::uint8_t, kGenerationEntryBytes> generation{};
  WriteU64(generation.data(), request.requested_generation);
  WriteU64(generation.data() + 8U, request.predecessor_generation);
  generation[16] = 5U;
  std::memcpy(generation.data() + 24U, request.operation_id.data(), 16U);
  IdentityBytes(candidate_identity, generation.data() + 40U);
  Copy32(candidate_closure, generation.data() + 416U);

  std::array<std::uint8_t, kOperationEntryBytes> operation{};
  std::memcpy(operation.data(), request.operation_id.data(), 16U);
  operation[16] = static_cast<std::uint8_t>(Opcode::CreateKeyset);
  operation[17] = 2U;
  WriteU64(operation.data() + 24U, request.requested_generation);
  Copy32(stable_binding, operation.data() + 32U);

  generation_projection->present = true;
  generation_projection->bytes = generation;
  operation_projection->present = true;
  operation_projection->bytes = operation;
  return BuildCanonicalState(
      state, generation_projection, operation_projection, nullptr, output);
}

bool ComputeRevokedState(
    const ProtectedOperationsState& state,
    const RevokeKeysetRequest& request,
    const Byte32& revoke_stable_binding,
    const ProtectedGenerationProjection& target_generation,
    const ProtectedObjectIdentity& control_identity,
    const Byte32& control_hash,
    ProtectedGenerationProjection* generation_projection,
    ProtectedOperationProjection* operation_projection,
    Byte32* output) noexcept;

bool RecoverCommittedCreate(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    bool recovery_attempt_already_appended,
    bool phase_a_read_only = false,
    bool replay_prepared_state = false) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_create_recovery_stage = 0U;
  ++g_create_recovery_call_count;
  g_create_recovery_last_mode =
      (phase_a_read_only ? 1U : 0U) | (replay_prepared_state ? 2U : 0U);
#endif
  if (state == nullptr || !operation.present || operation.quarantined ||
      (!operation.committed &&
       (operation.attempt_count == 0U || operation.candidate_present ||
        operation.attempt_count >= kMaximumJournalAttempts)) ||
      operation.opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset)) return false;
  CreateKeysetRequest request{};
  const std::uint16_t body_length = ReadU16(operation.prepared.bytes.data() + 38U);
  const std::uint16_t sid_length = ReadU16(operation.prepared.bytes.data() + 36U);
  if (!DecodeCreateKeysetRequest(
          operation.prepared.bytes.data() + 112U,
          body_length,
          &request) ||
      !Equal(request.operation_id.data(), operation.operation_id.data(), 16U) ||
      !((phase_a_read_only || replay_prepared_state)
            ? Equal(
                  request.expected_state_sha256.data(),
                  operation.prepared.bytes.data() + 272U,
                  32U)
            : Equal(
                  request.expected_state_sha256.data(),
                  state->state_sha256.data(),
                  32U)) ||
      request.requested_generation !=
          ((phase_a_read_only || replay_prepared_state)
               ? state->highest_burned_generation
               : state->highest_burned_generation + 1U) ||
      request.predecessor_generation !=
          (replay_prepared_state
               ? state->active_predecessor_generation
               : state->highest_committed_generation)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_create_recovery_stage = 1U;
#endif
  const bool effect_already_applied = replay_prepared_state &&
      state->active_generation == request.requested_generation &&
      state->highest_committed_generation == request.requested_generation &&
      state->active_create_operation_id == request.operation_id;
  std::size_t keyset_count = 0U;
  if (!EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.keysets,
          &g_recovery_entries,
          &keyset_count) ||
      keyset_count == 0U || keyset_count > kMaximumBurnedGenerations) return false;
  std::array<wchar_t, 32U> generation_component{};
  if (!BuildGenerationComponent(request.requested_generation, &generation_component)) return false;
  const ProtectedDirectoryEntry* generation_entry =
      FindNamedEntry(keyset_count, generation_component.data());
  if (generation_entry == nullptr ||
      (generation_entry->attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
      (generation_entry->attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U) return false;
  ProtectedPath keyset_path{};
  HANDLE keyset_directory = nullptr;
  ProtectedObjectIdentity directory_identity{};
  if (!ComposeProtectedChildPath(
          state->filesystem.keysets_path,
          generation_component.data(),
          &keyset_path) ||
      !OpenProtectedExistingDirectory(
          state->filesystem,
          keyset_path,
          false,
          &keyset_directory,
          &directory_identity)) return false;
  std::size_t file_count = 0U;
  if (!EnumerateProtectedDirectory(
          state->filesystem,
          keyset_directory,
          &g_recovery_entries,
          &file_count) ||
      file_count != 5U) {
    CloseHandle(keyset_directory);
    return false;
  }
  CloseHandle(keyset_directory);
  constexpr std::array<const wchar_t*, 5U> kNames = {
      L"runtime-manifest.pk8",
      L"runtime-manifest.spki",
      L"admission-evidence.pk8",
      L"admission-evidence.spki",
      L"keyset-receipt.gckr"};
  constexpr std::array<std::size_t, 5U> kLengths = {48U, 44U, 48U, 44U, 640U};
  std::array<std::array<std::uint8_t, 640U>, 5U> file_bytes{};
  std::array<ProtectedObjectIdentity, 5U> identities{};
  std::array<Byte32, 4U> file_hashes{};
  std::array<std::size_t, 5U> lengths{};
  bool success = true;
  for (std::size_t index = 0U; index < kNames.size(); ++index) {
    const ProtectedDirectoryEntry* file_entry = FindNamedEntry(file_count, kNames[index]);
    ProtectedPath file_path{};
    if (file_entry == nullptr ||
        (file_entry->attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U ||
        file_entry->byte_length != kLengths[index] ||
        !ComposeProtectedChildPath(keyset_path, kNames[index], &file_path) ||
        !ReadProtectedExistingFile(
            state->filesystem,
            file_path,
            file_bytes[index].data(),
            kLengths[index],
            &lengths[index],
            &identities[index]) ||
        lengths[index] != kLengths[index]) {
      success = false;
      break;
    }
    if (index < 4U &&
        !ComputeSha256(file_bytes[index].data(), lengths[index], &file_hashes[index])) {
      success = false;
      break;
    }
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (success) g_create_recovery_stage = 2U;
#endif
  CustodyKeysetMaterial material{};
  Byte32 receipt_hash{};
  if (success) {
    constexpr std::array<std::uint8_t, 16U> kPkcs8Prefix = {
        0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
        0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U};
    success = Equal(file_bytes[0].data(), kPkcs8Prefix.data(), kPkcs8Prefix.size()) &&
              Equal(file_bytes[2].data(), kPkcs8Prefix.data(), kPkcs8Prefix.size()) &&
              DeriveEd25519KeyMaterial(file_bytes[0].data() + 16U, 32U, &material.runtime_manifest) &&
              DeriveEd25519KeyMaterial(file_bytes[2].data() + 16U, 32U, &material.admission_evidence) &&
              Equal(material.runtime_manifest.pkcs8.data(), file_bytes[0].data(), 48U) &&
              Equal(material.runtime_manifest.spki.data(), file_bytes[1].data(), 44U) &&
              Equal(material.admission_evidence.pkcs8.data(), file_bytes[2].data(), 48U) &&
              Equal(material.admission_evidence.spki.data(), file_bytes[3].data(), 44U) &&
              ComputeSha256(file_bytes[1].data(), 44U, &material.runtime_manifest_key_id) &&
              ComputeSha256(file_bytes[3].data(), 44U, &material.admission_evidence_key_id);
  }
  const auto& receipt = file_bytes[4];
  Byte32 side_identity{};
  if (success) {
    success = receipt[0] == 'G' && receipt[1] == 'C' && receipt[2] == 'K' && receipt[3] == 'R' &&
              ReadU16(receipt.data() + 4U) == 1U && receipt[6] == 1U && receipt[7] == 0U &&
              ReadU32(receipt.data() + 8U) == 640U && ReadU32(receipt.data() + 12U) == 0U &&
              Equal(receipt.data() + 16U, request.operation_id.data(), 16U) &&
              ReadU64(receipt.data() + 32U) == request.requested_generation &&
              ReadU64(receipt.data() + 40U) == request.predecessor_generation &&
              ReadU64(receipt.data() + 48U) == ReadU64(operation.prepared.bytes.data() + 832U);
    std::array<std::uint8_t, 24U> identity_bytes{};
    if (success) {
      IdentityBytes(directory_identity, identity_bytes.data());
      success = Equal(identity_bytes.data(), receipt.data() + 56U, 24U);
    }
    for (std::size_t index = 0U; success && index < identities.size(); ++index) {
      IdentityBytes(identities[index], identity_bytes.data());
      success = Equal(identity_bytes.data(), receipt.data() + 80U + index * 24U, 24U);
    }
    for (std::size_t index = 0U; success && index < file_hashes.size(); ++index) {
      success = Equal(file_hashes[index].data(), receipt.data() + 200U + index * 32U, 32U);
    }
    std::array<std::uint8_t, 104U> pair_projection{};
    WriteU64(pair_projection.data(), request.requested_generation);
    WriteU64(pair_projection.data() + 8U, request.predecessor_generation);
    std::memcpy(
        pair_projection.data() + 16U,
        material.runtime_manifest.spki.data(),
        material.runtime_manifest.spki.size());
    std::memcpy(
        pair_projection.data() + 60U,
        material.admission_evidence.spki.data(),
        material.admission_evidence.spki.size());
    Byte32 pair_hash{};
    success = success &&
              Equal(material.runtime_manifest.spki.data(), receipt.data() + 328U, 44U) &&
              Equal(material.admission_evidence.spki.data(), receipt.data() + 372U, 44U) &&
              HashDomain(
                  kPairDomain,
                  sizeof(kPairDomain) - 1U,
                  pair_projection.data(),
                  pair_projection.size(),
                  &pair_hash) &&
              Equal(pair_hash.data(), receipt.data() + 416U, pair_hash.size()) &&
              Equal(receipt.data() + 448U, std::array<std::uint8_t, 160U>{}.data(), 160U) &&
              HashDomain(
                  kKeysetIdentityDomain,
                  sizeof(kKeysetIdentityDomain) - 1U,
                  receipt.data() + 56U,
                  144U,
                  &side_identity) &&
              HashDomainLarge(
                  kReceiptDomain,
                  sizeof(kReceiptDomain) - 1U,
                  receipt.data(),
                  608U,
                  &receipt_hash) &&
              Equal(receipt_hash.data(), receipt.data() + 608U, 32U);
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (success) g_create_recovery_stage = 3U;
#endif
  Byte32 final_state{};
  Byte32 prepared_stable_binding{};
  std::memcpy(
      prepared_stable_binding.data(),
      operation.prepared.bytes.data() + 304U,
      prepared_stable_binding.size());
  ProtectedGenerationProjection generation_projection{};
  ProtectedOperationProjection operation_projection{};
  if (success) {
    if (effect_already_applied) {
      const ProtectedGenerationProjection* existing_generation =
          FindGenerationProjection(*state, request.requested_generation);
      const ProtectedOperationProjection* existing_operation =
          FindOperationProjection(*state, request.operation_id);
      bool identities_equal = true;
      for (std::size_t index = 0U; index < identities.size(); ++index) {
        identities_equal = identities_equal &&
            state->active_keyset_file_identities[index].volume_serial_number ==
                identities[index].volume_serial_number &&
            Equal(
                state->active_keyset_file_identities[index].file_id.data(),
                identities[index].file_id.data(),
                identities[index].file_id.size());
      }
      bool hashes_equal = true;
      for (std::size_t index = 0U; index < file_hashes.size(); ++index) {
        hashes_equal = hashes_equal && Equal(
            state->active_keyset_file_hashes[index].data(),
            file_hashes[index].data(),
            file_hashes[index].size());
      }
      success = existing_generation != nullptr && existing_operation != nullptr &&
          existing_generation->bytes[16] == 1U &&
          existing_operation->bytes[16] ==
              static_cast<std::uint8_t>(Opcode::CreateKeyset) &&
          existing_operation->bytes[17] == 1U &&
          state->active_keyset_directory_identity.volume_serial_number ==
              directory_identity.volume_serial_number &&
          Equal(
              state->active_keyset_directory_identity.file_id.data(),
              directory_identity.file_id.data(),
              directory_identity.file_id.size()) &&
          identities_equal && hashes_equal &&
          Equal(
              state->active_receipt_sha256.data(),
              receipt_hash.data(),
              receipt_hash.size());
      if (success) {
        generation_projection = *existing_generation;
        operation_projection = *existing_operation;
        final_state = state->state_sha256;
      }
    } else {
      success = ComputeCommittedState(
                  *state,
                  request,
                  prepared_stable_binding,
                  directory_identity,
                  identities,
                  file_hashes,
                  receipt_hash,
                   &generation_projection,
                  &operation_projection,
                  &final_state);
    }
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (success) g_create_recovery_stage = 4U;
#endif
  RecoveredJournalOperation completed_operation = operation;
  const RecoveredJournalOperation* authority = &operation;
  if (success && !operation.committed) {
    FILETIME now{};
    GetSystemTimeAsFileTime(&now);
    const std::uint64_t recovery_time =
        static_cast<std::uint64_t>(now.dwLowDateTime) |
        (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
    JournalRecord recovery_attempt{};
    JournalRecord outcome{};
    JournalRecord committed{};
    std::array<std::uint8_t, kCreateKeysetResultBytes> result{};
    WriteU16(result.data(), 1U);
    WriteU16(result.data() + 2U, 1U);
    std::memcpy(result.data() + 8U, request.operation_id.data(), 16U);
    WriteU64(result.data() + 24U, request.requested_generation);
    WriteU64(result.data() + 32U, request.predecessor_generation);
    std::memcpy(
        result.data() + 40U,
        request.expected_state_sha256.data(),
        request.expected_state_sha256.size());
    Copy32(request.expected_state_sha256, result.data() + 72U);
    Copy32(final_state, result.data() + 104U);
    Copy32(receipt_hash, result.data() + 136U);
    Copy32(material.runtime_manifest_key_id, result.data() + 168U);
    Copy32(material.admission_evidence_key_id, result.data() + 200U);
    std::memcpy(
        result.data() + 232U,
        material.runtime_manifest.spki.data(),
        material.runtime_manifest.spki.size());
    std::memcpy(
        result.data() + 276U,
        material.admission_evidence.spki.data(),
        material.admission_evidence.spki.size());
    std::array<std::uint8_t, 432U> outcome_fields{};
    WriteU16(outcome_fields.data(), 1U);
    WriteU16(outcome_fields.data() + 2U, 1U);
    WriteU32(outcome_fields.data() + 4U, kCreateKeysetResultBytes);
    WriteU32(outcome_fields.data() + 8U, 1U);
    Copy32(side_identity, outcome_fields.data() + 16U);
    Copy32(receipt_hash, outcome_fields.data() + 48U);
    Copy32(final_state, outcome_fields.data() + 80U);
    std::memcpy(
        outcome_fields.data() + 112U, result.data(), result.size());
    if (operation.outcome_present) {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      g_create_recovery_stage = 5U;
#endif
      success = Equal(
                    operation.outcome.bytes.data() + 400U,
                    outcome_fields.data(),
                    outcome_fields.size()) &&
                (phase_a_read_only ||
                 CompleteOutcomeRecovery(
                     state,
                     operation,
                     &completed_operation));
      if (success && phase_a_read_only) {
        completed_operation = operation;
        completed_operation.result = result;
        completed_operation.result_length = kCreateKeysetResultBytes;
      }
      if (success) authority = &completed_operation;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      if (success) g_create_recovery_stage = 6U;
#endif
    } else if (phase_a_read_only) {
      completed_operation = operation;
      completed_operation.result = result;
      completed_operation.result_length = kCreateKeysetResultBytes;
      authority = &completed_operation;
    } else {
      JournalParentAuthority parent{};
      if (!OpenJournalParentAuthority(state, operation.path, &parent)) return false;
      bool recovery_attempt_ready = false;
      std::uint32_t outcome_sequence = operation.next_sequence + 1U;
      if (recovery_attempt_already_appended) {
        recovery_attempt = operation.prior;
        recovery_attempt_ready = recovery_attempt.bytes[6] ==
                                     static_cast<std::uint8_t>(
                                         JournalRecordKind::Attempt) &&
                                 recovery_attempt.bytes[7] == 1U;
        outcome_sequence = operation.next_sequence;
      } else {
        recovery_attempt_ready = EncodeFollowingJournalRecord(
                                     JournalRecordKind::Attempt,
                                     1U,
                                     operation.prepared,
                                     operation.prior,
                                     nullptr,
                                     nullptr,
                                     0U,
                                     recovery_time,
                                     state->next_publication_sequence,
                                     &recovery_attempt) &&
                                 PublishJournalRecord(
                                     state,
                                     operation.path,
                                     operation.next_sequence,
                                     L"attempt",
                                     recovery_attempt,
                                     false,
                                     nullptr,
                                     parent.handle,
                                     parent.identity);
      }
      success = recovery_attempt_ready &&
                EncodeFollowingJournalRecord(
                    JournalRecordKind::Outcome,
                    0U,
                    operation.prepared,
                    recovery_attempt,
                    nullptr,
                    outcome_fields.data(),
                    outcome_fields.size(),
                    recovery_time,
                    state->next_publication_sequence,
                    &outcome) &&
                PublishJournalRecord(
                    state,
                    operation.path,
                    outcome_sequence,
                    L"outcome",
                    outcome,
                    false,
                    nullptr,
                    parent.handle,
                    parent.identity) &&
                EncodeFollowingJournalRecord(
                    JournalRecordKind::Committed,
                    0U,
                    operation.prepared,
                    outcome,
                    nullptr,
                    outcome_fields.data(),
                    outcome_fields.size(),
                    recovery_time,
                    state->next_publication_sequence,
                    &committed) &&
                PublishJournalRecord(
                    state,
                    operation.path,
                    outcome_sequence + 1U,
                    L"committed",
                    committed,
                    false,
                    nullptr,
                    parent.handle,
                    parent.identity);
      if (success) {
        completed_operation.committed = true;
        completed_operation.outcome_present = true;
        completed_operation.outcome = outcome;
        completed_operation.prior = committed;
        completed_operation.next_sequence = outcome_sequence + 2U;
        if (!recovery_attempt_already_appended) {
          ++completed_operation.attempt_count;
        }
        completed_operation.result = result;
        completed_operation.result_length = kCreateKeysetResultBytes;
        authority = &completed_operation;
      }
    }
  }
  if (success && (!phase_a_read_only || operation.outcome_present)) {
    success = Equal(
        final_state.data(), authority->result.data() + 104U, 32U);
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 61U;
#endif
    if (success) {
      success = Equal(
          final_state.data(), authority->outcome.bytes.data() + 480U, 32U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 62U;
#endif
    if (success) {
      success = Equal(
          side_identity.data(), authority->outcome.bytes.data() + 416U, 32U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 63U;
#endif
    if (success) {
      success = Equal(
          receipt_hash.data(), authority->outcome.bytes.data() + 448U, 32U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 64U;
#endif
    if (success) {
      success = Equal(
          receipt_hash.data(), authority->result.data() + 136U, 32U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 65U;
#endif
    if (success) {
      success = Equal(
          material.runtime_manifest_key_id.data(),
          authority->result.data() + 168U,
          32U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 66U;
#endif
    if (success) {
      success = Equal(
          material.admission_evidence_key_id.data(),
          authority->result.data() + 200U,
          32U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 67U;
#endif
    if (success) {
      success = Equal(
          material.runtime_manifest.spki.data(),
          authority->result.data() + 232U,
          44U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 68U;
#endif
    if (success) {
      success = Equal(
          material.admission_evidence.spki.data(),
          authority->result.data() + 276U,
          44U);
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (success) g_create_recovery_stage = 69U;
#endif
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (success) g_create_recovery_stage = 7U;
#endif
  if (success && !effect_already_applied) {
    success = CommitGenerationProjection(state, generation_projection) &&
              CommitProjection(
                  &state->operations,
                  operation_projection,
                  [](const ProtectedOperationProjection& left,
                     const ProtectedOperationProjection& right) noexcept {
                    return Equal(left.bytes.data(), right.bytes.data(), 16U);
                  }) &&
              AppendHistoricalKey(
                  state,
                  material.runtime_manifest.spki,
                  material.runtime_manifest_key_id) &&
              AppendHistoricalKey(
                  state,
                  material.admission_evidence.spki,
                  material.admission_evidence_key_id);
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (success) g_create_recovery_stage = 8U;
#endif
  if (success) {
    Byte32 stable_binding{};
    std::memcpy(stable_binding.data(), operation.prepared.bytes.data() + 304U, 32U);
    if (!effect_already_applied) {
      state->state_sha256 = final_state;
      state->active_generation = request.requested_generation;
      state->active_revoked = false;
      state->highest_burned_generation = request.requested_generation;
      state->highest_committed_generation = request.requested_generation;
      ++state->committed_generation_count;
      if (!phase_a_read_only && !replay_prepared_state) {
        ++state->burned_generation_count;
        ++state->operation_id_count;
      }
      state->active_receipt_sha256 = receipt_hash;
      state->runtime_manifest_spki_sha256 = material.runtime_manifest_key_id;
      state->admission_evidence_spki_sha256 = material.admission_evidence_key_id;
      state->runtime_manifest_spki = material.runtime_manifest.spki;
      state->admission_evidence_spki = material.admission_evidence.spki;
      state->active_create_operation_id = request.operation_id;
      state->active_create_stable_binding = stable_binding;
      state->active_keyset_directory_identity = directory_identity;
      state->active_keyset_file_identities = identities;
      state->active_keyset_file_hashes = file_hashes;
      state->active_predecessor_generation = request.predecessor_generation;
    }
    if (!phase_a_read_only || operation.outcome_present) {
      RememberReplay(
          &state->create_replay,
          authority->opcode,
          authority->operation_id,
          authority->prepared.bytes.data() + 40U,
          sid_length,
          authority->prepared.bytes.data() + 112U,
          body_length,
          stable_binding,
          false,
          authority->path,
          authority->prepared,
          authority->prior,
          authority->next_sequence,
          authority->result,
          authority->result_length);
      state->create_replay.attempt_count = authority->attempt_count;
    }
  }
  WipeCustodyOwned(file_bytes.data(), sizeof(file_bytes));
  WipeCustodyOwned(&material, sizeof(material));
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (success) g_create_recovery_stage = 9U;
#endif
  return success;
}

bool RecoverCommittedRevoke(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    bool phase_a_read_only = false,
    bool replay_prepared_state = false,
    const ProtectedObjectIdentity* completed_control_identity = nullptr,
    const Byte32* completed_control_hash = nullptr) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 0U;
#endif
  if (state == nullptr || !operation.present || operation.quarantined ||
      (!operation.committed &&
       ((!operation.outcome_present &&
         !((phase_a_read_only || replay_prepared_state) &&
           operation.attempt_count != 0U &&
           !operation.candidate_present)) ||
        operation.attempt_count >= kMaximumJournalAttempts)) ||
      operation.opcode != static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 1U;
#endif
  const std::uint16_t body_length = ReadU16(operation.prepared.bytes.data() + 38U);
  const std::uint16_t sid_length = ReadU16(operation.prepared.bytes.data() + 36U);
  RevokeKeysetRequest request{};
  if (!DecodeRevokeKeysetRequest(
          operation.prepared.bytes.data() + 112U,
          body_length,
          &request)) return false;
  const ProtectedGenerationProjection* target_generation =
      FindGenerationProjection(*state, request.generation);
  const bool effect_already_applied = replay_prepared_state &&
      target_generation != nullptr && target_generation->bytes[16] == 3U;
  const bool target_was_active = target_generation != nullptr &&
      target_generation->bytes[16] == 1U;
  if (target_generation == nullptr ||
      (target_generation->bytes[16] != 1U &&
       target_generation->bytes[16] != 2U &&
       !effect_already_applied) ||
      !Equal(request.operation_id.data(), operation.operation_id.data(), 16U) ||
      !((phase_a_read_only || replay_prepared_state)
            ? Equal(
                  request.expected_state_sha256.data(),
                  operation.prepared.bytes.data() + 272U,
                  32U)
            : Equal(
                  request.expected_state_sha256.data(),
                  state->state_sha256.data(),
                  32U)) ||
      !Equal(
          request.expected_receipt_sha256.data(),
          target_generation->bytes.data() + 312U,
          32U)) {
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 2U;
#endif
  std::array<wchar_t, 48U> control_component{};
  ProtectedPath control_path{};
  ProtectedObjectIdentity control_identity{};
  std::array<std::uint8_t, 256U> control{};
  std::size_t control_length = 0U;
  if (!BuildControlComponent(request.generation, &control_component) ||
      !ComposeProtectedChildPath(
          state->filesystem.controls_path,
          control_component.data(),
          &control_path) ||
      !ReadProtectedExistingFile(
          state->filesystem,
          control_path,
          control.data(),
          control.size(),
          &control_length,
          &control_identity) ||
      control_length != control.size()) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 3U;
#endif
  std::array<std::uint8_t, 24U> identity_bytes{};
  IdentityBytes(control_identity, identity_bytes.data());
  std::array<std::uint8_t, 72U> sid_projection{};
  WriteU16(sid_projection.data(), sid_length);
  if (sid_length == 0U || sid_length > 68U) return false;
  std::memcpy(
      sid_projection.data() + 2U,
      operation.prepared.bytes.data() + 40U,
      sid_length);
  Byte32 sid_hash{};
  Byte32 control_hash{};
  Byte32 control_identity_hash{};
  if (!HashDomain(
          kOperatorSidDomain,
          sizeof(kOperatorSidDomain) - 1U,
          sid_projection.data(),
          2U + sid_length,
          &sid_hash) ||
      !HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          control.data(),
          224U,
          &control_hash) ||
      !HashDomain(
          kControlIdentityDomain,
          sizeof(kControlIdentityDomain) - 1U,
          identity_bytes.data(),
          identity_bytes.size(),
          &control_identity_hash)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 4U;
#endif
  if (control[0] != 'G' || control[1] != 'C' || control[2] != 'K' || control[3] != 'C' ||
      ReadU16(control.data() + 4U) != 1U || control[6] != 1U || control[7] != 0U ||
      ReadU32(control.data() + 8U) != 256U || ReadU32(control.data() + 12U) != request.reason ||
      !Equal(control.data() + 16U, request.operation_id.data(), 16U) ||
      ReadU64(control.data() + 32U) != request.generation ||
      ReadU64(control.data() + 40U) != ReadU64(operation.prepared.bytes.data() + 832U) ||
      !Equal(control.data() + 48U, identity_bytes.data(), identity_bytes.size()) ||
      !Equal(control.data() + 72U, target_generation->bytes.data() + 312U, 32U) ||
      !Equal(control.data() + 104U, request.expected_state_sha256.data(), 32U) ||
      !Equal(control.data() + 136U, sid_hash.data(), 32U) ||
      !AllZero(control.data() + 168U, 56U) ||
      !Equal(control.data() + 224U, control_hash.data(), 32U)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 5U;
#endif
  if ((completed_control_identity == nullptr) !=
          (completed_control_hash == nullptr) ||
      (completed_control_identity != nullptr &&
       (!EqualMoveIdentity(
            control_identity, *completed_control_identity) ||
        !Equal(
            control_hash.data(),
            completed_control_hash->data(),
            control_hash.size())))) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 6U;
#endif

  Byte32 stable_binding{};
  std::memcpy(stable_binding.data(), operation.prepared.bytes.data() + 304U, 32U);
  ProtectedGenerationProjection generation_projection{};
  ProtectedOperationProjection operation_projection{};
  Byte32 final_state{};
  if (completed_control_identity != nullptr &&
      !RecordRevokeControlStep(true, 6U)) return false;
  if (effect_already_applied) {
    const ProtectedOperationProjection* existing_operation =
        FindOperationProjection(*state, request.operation_id);
    if (existing_operation == nullptr ||
        existing_operation->bytes[16] !=
            static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) ||
        existing_operation->bytes[17] != 1U ||
        ReadU64(target_generation->bytes.data() + 344U) !=
            control_identity.volume_serial_number ||
        !Equal(
            target_generation->bytes.data() + 352U,
            control_identity.file_id.data(),
            control_identity.file_id.size()) ||
        !Equal(
            target_generation->bytes.data() + 368U,
            control_hash.data(),
            control_hash.size()) ||
        !Equal(
            target_generation->bytes.data() + 400U,
            request.operation_id.data(),
            request.operation_id.size())) return false;
    generation_projection = *target_generation;
    operation_projection = *existing_operation;
    final_state = state->state_sha256;
  } else {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    ++g_revoke_compute_count;
#endif
    if (!ComputeRevokedState(
                 *state,
                 request,
                 stable_binding,
                 *target_generation,
                 control_identity,
                 control_hash,
                 &generation_projection,
                 &operation_projection,
                 &final_state)) return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 7U;
#endif
  RecoveredJournalOperation completed_operation = operation;
  const RecoveredJournalOperation* authority = &operation;
  if (!operation.committed) {
    std::array<std::uint8_t, kCreateKeysetResultBytes> result{};
    WriteU16(result.data(), 1U);
    WriteU16(result.data() + 2U, 1U);
    std::memcpy(result.data() + 8U, request.operation_id.data(), 16U);
    WriteU64(result.data() + 24U, request.generation);
    WriteU32(result.data() + 32U, request.reason);
    std::memcpy(
        result.data() + 40U,
        request.expected_state_sha256.data(),
        request.expected_state_sha256.size());
    Copy32(request.expected_state_sha256, result.data() + 72U);
    Copy32(final_state, result.data() + 104U);
    std::memcpy(
        result.data() + 136U,
        target_generation->bytes.data() + 312U,
        32U);
    Copy32(control_hash, result.data() + 168U);
    std::array<std::uint8_t, 432U> outcome_fields{};
    WriteU16(outcome_fields.data(), 2U);
    WriteU16(outcome_fields.data() + 2U, 1U);
    WriteU32(outcome_fields.data() + 4U, kRevokeKeysetResultBytes);
    WriteU32(outcome_fields.data() + 8U, 2U);
    Copy32(control_identity_hash, outcome_fields.data() + 16U);
    Copy32(control_hash, outcome_fields.data() + 48U);
    Copy32(final_state, outcome_fields.data() + 80U);
    std::memcpy(
        outcome_fields.data() + 112U,
        result.data(),
        kRevokeKeysetResultBytes);
    if (operation.outcome_present) {
      if (!Equal(
              operation.outcome.bytes.data() + 400U,
              outcome_fields.data(),
              outcome_fields.size()) ||
          (!phase_a_read_only &&
           !CompleteOutcomeRecovery(
               state, operation, &completed_operation))) return false;
      if (phase_a_read_only) {
        completed_operation = operation;
        completed_operation.result = result;
        completed_operation.result_length = kRevokeKeysetResultBytes;
      }
    } else if (phase_a_read_only) {
      completed_operation = operation;
      completed_operation.result = result;
      completed_operation.result_length = kRevokeKeysetResultBytes;
    } else {
      JournalParentAuthority parent{};
      if (!OpenJournalParentAuthority(state, operation.path, &parent)) return false;
      FILETIME now{};
      GetSystemTimeAsFileTime(&now);
      const std::uint64_t recovery_time =
          static_cast<std::uint64_t>(now.dwLowDateTime) |
          (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
      JournalRecord recovery_attempt{};
      JournalRecord outcome{};
      JournalRecord committed{};
      const std::uint32_t attempt_sequence = operation.next_sequence;
      if (!EncodeFollowingJournalRecord(
              JournalRecordKind::Attempt,
              1U,
              operation.prepared,
              operation.prior,
              nullptr,
              nullptr,
              0U,
              recovery_time,
              state->next_publication_sequence,
              &recovery_attempt) ||
          !PublishJournalRecord(
              state,
              operation.path,
              attempt_sequence,
              L"attempt",
              recovery_attempt,
              false,
              nullptr,
              parent.handle,
              parent.identity) ||
          !EncodeFollowingJournalRecord(
              JournalRecordKind::Outcome,
              0U,
              operation.prepared,
              recovery_attempt,
              nullptr,
              outcome_fields.data(),
              outcome_fields.size(),
              recovery_time,
              state->next_publication_sequence,
              &outcome) ||
          !PublishJournalRecord(
              state,
              operation.path,
              attempt_sequence + 1U,
              L"outcome",
              outcome,
              false,
              nullptr,
              parent.handle,
              parent.identity) ||
          !EncodeFollowingJournalRecord(
              JournalRecordKind::Committed,
              0U,
              operation.prepared,
              outcome,
              nullptr,
              outcome_fields.data(),
              outcome_fields.size(),
              recovery_time,
              state->next_publication_sequence,
              &committed) ||
          !PublishJournalRecord(
              state,
              operation.path,
              attempt_sequence + 2U,
              L"committed",
              committed,
              false,
              nullptr,
              parent.handle,
              parent.identity)) return false;
      completed_operation.committed = true;
      completed_operation.outcome_present = true;
      completed_operation.outcome = outcome;
      completed_operation.prior = committed;
      completed_operation.next_sequence = attempt_sequence + 3U;
      ++completed_operation.attempt_count;
      completed_operation.result = result;
      completed_operation.result_length = kRevokeKeysetResultBytes;
    }
    authority = &completed_operation;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 8U;
#endif
  if ((!phase_a_read_only || operation.outcome_present) &&
      (!Equal(final_state.data(), authority->result.data() + 104U, 32U) ||
       !Equal(final_state.data(), authority->outcome.bytes.data() + 480U, 32U) ||
      !Equal(request.expected_state_sha256.data(), authority->result.data() + 72U, 32U) ||
      !Equal(
          target_generation->bytes.data() + 312U,
          authority->result.data() + 136U,
          32U) ||
      !Equal(control_hash.data(), authority->result.data() + 168U, 32U) ||
      !Equal(control_identity_hash.data(), authority->outcome.bytes.data() + 416U, 32U) ||
       !Equal(control_hash.data(), authority->outcome.bytes.data() + 448U, 32U))) {
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 9U;
#endif
  if (!effect_already_applied) {
    if (!CommitGenerationProjection(state, generation_projection) ||
        !CommitProjection(
            &state->operations,
            operation_projection,
            [](const ProtectedOperationProjection& left,
               const ProtectedOperationProjection& right) noexcept {
              return Equal(left.bytes.data(), right.bytes.data(), 16U);
            })) return false;
    state->state_sha256 = final_state;
    if (target_was_active) {
      state->active_generation = 0U;
      state->active_revoked = true;
    }
    if (!phase_a_read_only && !replay_prepared_state) {
      ++state->operation_id_count;
    }
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 10U;
#endif
  if (!phase_a_read_only || operation.outcome_present) {
    RememberReplay(
        &state->revoke_replay,
        authority->opcode,
        authority->operation_id,
        authority->prepared.bytes.data() + 40U,
        sid_length,
        authority->prepared.bytes.data() + 112U,
        body_length,
        stable_binding,
        false,
        authority->path,
        authority->prepared,
        authority->prior,
        authority->next_sequence,
        authority->result,
        authority->result_length);
    state->revoke_replay.attempt_count = authority->attempt_count;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_recovery_stage = 11U;
#endif
  return true;
}

bool RecoverQuarantinedCreate(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    bool phase_a_read_only = false) noexcept {
  if (state == nullptr || !operation.present || !operation.quarantined ||
      operation.opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset)) return false;
  const std::uint16_t body_length = ReadU16(operation.prepared.bytes.data() + 38U);
  const std::uint16_t sid_length = ReadU16(operation.prepared.bytes.data() + 36U);
  CreateKeysetRequest request{};
  if (!DecodeCreateKeysetRequest(
          operation.prepared.bytes.data() + 112U,
          body_length,
      &request) ||
      !Equal(request.operation_id.data(), operation.operation_id.data(), 16U) ||
      !(phase_a_read_only
            ? Equal(
                  request.expected_state_sha256.data(),
                  operation.prepared.bytes.data() + 272U,
                  32U)
            : Equal(
                  request.expected_state_sha256.data(),
                  state->state_sha256.data(),
                  32U)) ||
      request.requested_generation !=
          (phase_a_read_only
               ? state->highest_burned_generation
               : state->highest_burned_generation + 1U) ||
      request.predecessor_generation != state->highest_committed_generation ||
      sid_length == 0U || sid_length > 68U) return false;
  ProtectedPath candidate_path{};
  if (!ComposeProtectedChildPath(
          operation.path, L"keyset.pending", &candidate_path)) return false;
  Byte32 closure_hash{};
  bool complete_closure = false;
  if (!BuildCandidateClosure(
      state->filesystem,
      candidate_path,
      operation.candidate_identity,
      &operation.prepared,
      state,
          &closure_hash,
          &complete_closure) ||
      !Equal(closure_hash.data(), operation.candidate_closure.data(), closure_hash.size())) {
    return false;
  }
  (void)complete_closure;
  Byte32 stable_binding{};
  std::memcpy(stable_binding.data(), operation.prepared.bytes.data() + 304U, 32U);
  ProtectedGenerationProjection generation_projection{};
  ProtectedOperationProjection operation_projection{};
  Byte32 final_state{};
  std::array<std::uint8_t, 24U> candidate_identity_bytes{};
  IdentityBytes(operation.candidate_identity, candidate_identity_bytes.data());
  Byte32 candidate_identity_hash{};
  if (!HashDomain(
          kQuarantinedIdentityDomain,
          sizeof(kQuarantinedIdentityDomain) - 1U,
          candidate_identity_bytes.data(),
          candidate_identity_bytes.size(),
          &candidate_identity_hash) ||
      !ComputeQuarantinedState(
          *state,
          request,
          stable_binding,
          operation.candidate_identity,
          closure_hash,
          &generation_projection,
          &operation_projection,
          &final_state)) return false;
  const JournalRecord& terminal = operation.prior;
  const std::uint16_t reason = ReadU16(terminal.bytes.data() + 402U);
  if (ReadU16(terminal.bytes.data() + 400U) != 3U || reason < 1U || reason > 3U ||
      ReadU32(terminal.bytes.data() + 404U) != 0U ||
      ReadU32(terminal.bytes.data() + 408U) != 3U ||
      ReadU32(terminal.bytes.data() + 412U) != 0U ||
      !Equal(candidate_identity_hash.data(), terminal.bytes.data() + 416U, 32U) ||
      !Equal(closure_hash.data(), terminal.bytes.data() + 448U, 32U) ||
      !Equal(final_state.data(), terminal.bytes.data() + 480U, 32U) ||
      !AllZero(terminal.bytes.data() + 512U, 320U) ||
      !CommitGenerationProjection(state, generation_projection) ||
      !CommitProjection(
          &state->operations,
          operation_projection,
          [](const ProtectedOperationProjection& left,
             const ProtectedOperationProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 16U);
          })) return false;
  std::array<std::uint8_t, kCreateKeysetResultBytes> result{};
  WriteU16(result.data(), 1U);
  WriteU16(result.data() + 2U, 10U);
  std::memcpy(result.data() + 8U, request.operation_id.data(), 16U);
  WriteU64(result.data() + 24U, request.requested_generation);
  WriteU64(result.data() + 32U, request.predecessor_generation);
  std::memcpy(result.data() + 40U, request.expected_state_sha256.data(), 32U);
  Copy32(request.expected_state_sha256, result.data() + 72U);
  Copy32(final_state, result.data() + 104U);
  state->state_sha256 = final_state;
  state->highest_burned_generation = request.requested_generation;
  if (!phase_a_read_only) {
    ++state->burned_generation_count;
    ++state->operation_id_count;
  }
  ++state->quarantined_operation_count;
  RememberReplay(
      &state->create_replay,
      operation.opcode,
      operation.operation_id,
      operation.prepared.bytes.data() + 40U,
      sid_length,
      operation.prepared.bytes.data() + 112U,
      body_length,
      stable_binding,
      true,
      operation.path,
      operation.prepared,
      operation.prior,
      operation.next_sequence,
      result,
      kCreateKeysetResultBytes);
  state->create_replay.attempt_count = operation.attempt_count;
  return true;
}

bool DuplicateRecoveryFilesystem(
    const ProtectedFilesystemState& source,
    ProtectedFilesystemState* destination) noexcept {
  if (!source.ready || destination == nullptr) return false;
  WipeCustodyOwned(destination, sizeof(*destination));
  destination->state_root_path = source.state_root_path;
  destination->journal_path = source.journal_path;
  destination->keysets_path = source.keysets_path;
  destination->controls_path = source.controls_path;
  destination->quarantine_path = source.quarantine_path;
  destination->state_root_identity = source.state_root_identity;
  destination->journal_identity = source.journal_identity;
  destination->keysets_identity = source.keysets_identity;
  destination->controls_identity = source.controls_identity;
  destination->quarantine_identity = source.quarantine_identity;
  destination->security_projection = source.security_projection;
  destination->security_descriptor = source.security_descriptor;
  destination->security_descriptor_length = source.security_descriptor_length;
  destination->recovery_deadline_ms = source.recovery_deadline_ms;
  const HANDLE process = GetCurrentProcess();
  const auto injected_failure = [&]() noexcept -> bool {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    const std::uint32_t call = ++g_recovery_duplicate_call_count;
    return g_recovery_duplicate_fail_on_call != 0U &&
           call == g_recovery_duplicate_fail_on_call;
#else
    return false;
#endif
  };
  if (injected_failure() ||
      !DuplicateHandle(
          process,
          source.state_root,
          process,
          &destination->state_root,
          0U,
          FALSE,
          DUPLICATE_SAME_ACCESS) ||
      injected_failure() ||
      !DuplicateHandle(
          process,
          source.journal,
          process,
          &destination->journal,
          0U,
          FALSE,
          DUPLICATE_SAME_ACCESS) ||
      injected_failure() ||
      !DuplicateHandle(
          process,
          source.keysets,
          process,
          &destination->keysets,
          0U,
          FALSE,
          DUPLICATE_SAME_ACCESS) ||
      injected_failure() ||
      !DuplicateHandle(
          process,
          source.controls,
          process,
          &destination->controls,
          0U,
          FALSE,
          DUPLICATE_SAME_ACCESS) ||
      injected_failure() ||
      !DuplicateHandle(
          process,
          source.quarantine,
          process,
          &destination->quarantine,
          0U,
          FALSE,
          DUPLICATE_SAME_ACCESS) ||
      (source.recovery_deadline_ms != 0U &&
       (injected_failure() ||
        !DuplicateHandle(
            process,
            source.recovery_stop_event,
            process,
            &destination->recovery_stop_event,
            0U,
            FALSE,
            DUPLICATE_SAME_ACCESS)))) {
    if (destination->recovery_stop_event != nullptr &&
        destination->recovery_stop_event != INVALID_HANDLE_VALUE) {
      CloseHandle(destination->recovery_stop_event);
      destination->recovery_stop_event = nullptr;
    }
    CloseProtectedFilesystem(destination);
    return false;
  }
  destination->ready = true;
  return true;
}

void CloseRecoveryFilesystem(ProtectedFilesystemState* filesystem) noexcept {
  if (filesystem == nullptr) return;
  if (filesystem->recovery_stop_event != nullptr &&
      filesystem->recovery_stop_event != INVALID_HANDLE_VALUE) {
    CloseHandle(filesystem->recovery_stop_event);
    filesystem->recovery_stop_event = nullptr;
  }
  CloseProtectedFilesystem(filesystem);
}

void CopyRecoveryProjectionState(
    const ProtectedOperationsState& source,
    ProtectedOperationsState* destination) noexcept {
  if (destination == nullptr) return;
  destination->state_sha256 = source.state_sha256;
  destination->active_generation = source.active_generation;
  destination->highest_burned_generation = source.highest_burned_generation;
  destination->highest_committed_generation = source.highest_committed_generation;
  destination->committed_generation_count = source.committed_generation_count;
  destination->burned_generation_count = source.burned_generation_count;
  destination->operation_id_count = source.operation_id_count;
  destination->quarantined_operation_count =
      source.quarantined_operation_count;
  destination->residue_count = source.residue_count;
  destination->next_publication_sequence = source.next_publication_sequence;
  destination->active_receipt_sha256 = source.active_receipt_sha256;
  destination->runtime_manifest_spki_sha256 =
      source.runtime_manifest_spki_sha256;
  destination->admission_evidence_spki_sha256 =
      source.admission_evidence_spki_sha256;
  destination->runtime_manifest_spki = source.runtime_manifest_spki;
  destination->admission_evidence_spki = source.admission_evidence_spki;
  destination->active_create_operation_id = source.active_create_operation_id;
  destination->active_create_stable_binding =
      source.active_create_stable_binding;
  destination->active_keyset_directory_identity =
      source.active_keyset_directory_identity;
  destination->active_keyset_file_identities =
      source.active_keyset_file_identities;
  destination->active_keyset_file_hashes = source.active_keyset_file_hashes;
  destination->active_predecessor_generation =
      source.active_predecessor_generation;
  destination->active_revoked = source.active_revoked;
  destination->create_replay = source.create_replay;
  destination->revoke_replay = source.revoke_replay;
  destination->generations = source.generations;
  destination->operations = source.operations;
  destination->residues = source.residues;
  destination->historical_keys = source.historical_keys;
  destination->historical_key_count = source.historical_key_count;
  destination->ready = source.ready;
}

const PhaseAOperationInventory* FindReplayInventory(
    const Byte16& operation_id,
    std::size_t* inventory_index) noexcept {
  const PhaseAOperationInventory* selected = nullptr;
  for (std::size_t index = 0U; index < g_phase_a_operation_count; ++index) {
    if (!g_phase_a_operations[index].present ||
        g_phase_a_operations[index].record_count == 0U ||
        g_phase_a_operations[index].operation_id != operation_id) continue;
    if (selected != nullptr) return nullptr;
    selected = &g_phase_a_operations[index];
    if (inventory_index != nullptr) *inventory_index = index;
  }
  return selected;
}

bool LoadRecoveredReplayOperation(
    ProtectedOperationsState* authority,
    const PhaseAOperationInventory& inventory,
    RecoveredJournalOperation* recovered) noexcept {
  if (authority == nullptr || recovered == nullptr ||
      inventory.pending_operation_directory) return false;
  const ProtectedPath& parent = inventory.quarantine_location
      ? authority->filesystem.quarantine_path
      : authority->filesystem.journal_path;
  return RecoverJournalOperation(
      authority,
      parent,
      inventory.root_entry,
      inventory.quarantine_location,
      recovered,
      true);
}

bool ClassifyReplayPhysicalEffect(
    ProtectedOperationsState* authority,
    const PhaseAOperationInventory& inventory,
    const RecoveredJournalOperation& recovered,
    RecoveryEffectClass* effect) noexcept {
  if (authority == nullptr || effect == nullptr) return false;
  *effect = RecoveryEffectClass::Absent;
  bool final_present = false;
  if (recovered.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    CreateKeysetRequest request{};
    std::array<wchar_t, 32U> component{};
    if (!DecodeCreateKeysetRequest(
            recovered.prepared.bytes.data() + 112U,
            ReadU16(recovered.prepared.bytes.data() + 38U),
            &request) ||
        !BuildGenerationComponent(request.requested_generation, &component)) {
      return false;
    }
    final_present = FindNamedEntryIn(
        g_keyset_scan_entries,
        g_phase_a_keyset_count,
        component.data()) != nullptr;
    if (recovered.candidate_present) {
      if (final_present) return false;
      if (recovered.candidate_complete) {
        *effect = RecoveryEffectClass::ExactPending;
        return true;
      }
      ProtectedPath candidate_path{};
      HANDLE directory = nullptr;
      ProtectedObjectIdentity identity{};
      if (!ComposeProtectedChildPath(
              recovered.path, L"keyset.pending", &candidate_path) ||
          !OpenProtectedExistingDirectory(
              authority->filesystem,
              candidate_path,
              false,
              &directory,
              &identity)) {
        if (directory != nullptr && directory != INVALID_HANDLE_VALUE) {
          CloseHandle(directory);
        }
        return false;
      }
      const bool empty = ProtectedDirectoryIsEmptyGuarded(
          authority->filesystem, directory);
      CloseHandle(directory);
      if (identity.volume_serial_number !=
              recovered.candidate_identity.volume_serial_number ||
          !Equal(
              identity.file_id.data(),
              recovered.candidate_identity.file_id.data(),
              identity.file_id.size())) return false;
      *effect = empty
          ? RecoveryEffectClass::CreateEmpty
          : RecoveryEffectClass::BoundedPartialPending;
      return true;
    }
  } else if (recovered.opcode ==
             static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    RevokeKeysetRequest request{};
    std::array<wchar_t, 48U> component{};
    if (!DecodeRevokeKeysetRequest(
            recovered.prepared.bytes.data() + 112U,
            ReadU16(recovered.prepared.bytes.data() + 38U),
            &request) ||
        !BuildControlComponent(request.generation, &component)) return false;
    final_present = FindNamedEntryIn(
        g_control_scan_entries,
        g_phase_a_control_count,
        component.data()) != nullptr;
    if (recovered.candidate_present) {
      if (final_present) return false;
      *effect = recovered.candidate_complete
          ? RecoveryEffectClass::ExactPending
          : RecoveryEffectClass::BoundedPartialPending;
      return true;
    }
  } else {
    return false;
  }
  *effect = final_present
      ? RecoveryEffectClass::ExactFinal
      : RecoveryEffectClass::Absent;
  (void)inventory;
  return true;
}

bool ApplyPreparedReplayState(
    ProtectedOperationsState* state,
    const RecoveryPublicationEvent& event) noexcept {
  if (state == nullptr || !event.record_present ||
      event.kind != RecoveryPublicationEventKind::Prepared ||
      !Equal(
          event.record.bytes.data() + 272U,
          state->state_sha256.data(),
          state->state_sha256.size()) ||
      state->operation_id_count >= kMaximumOperationIds) return false;
  Byte32 stable_binding{};
  std::memcpy(
      stable_binding.data(), event.record.bytes.data() + 304U,
      stable_binding.size());
  ProtectedOperationProjection operation{};
  operation.present = true;
  std::memcpy(
      operation.bytes.data(), event.operation_id.data(),
      event.operation_id.size());
  operation.bytes[16] = event.opcode;
  operation.bytes[17] = 1U;
  Copy32(stable_binding, operation.bytes.data() + 32U);
  ProtectedGenerationProjection generation{};
  const ProtectedGenerationProjection* extra_generation = nullptr;
  if (event.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    CreateKeysetRequest request{};
    if (!DecodeCreateKeysetRequest(
            event.record.bytes.data() + 112U,
            ReadU16(event.record.bytes.data() + 38U),
            &request) ||
        request.operation_id != event.operation_id ||
        request.requested_generation != state->highest_burned_generation + 1U ||
        request.predecessor_generation != state->highest_committed_generation ||
        state->burned_generation_count >= kMaximumBurnedGenerations) {
      return false;
    }
    WriteU64(operation.bytes.data() + 24U, request.requested_generation);
    generation.present = true;
    WriteU64(generation.bytes.data(), request.requested_generation);
    WriteU64(
        generation.bytes.data() + 8U, request.predecessor_generation);
    generation.bytes[16] = 4U;
    std::memcpy(
        generation.bytes.data() + 24U,
        event.operation_id.data(),
        event.operation_id.size());
    extra_generation = &generation;
  } else if (event.opcode ==
             static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    RevokeKeysetRequest request{};
    if (!DecodeRevokeKeysetRequest(
            event.record.bytes.data() + 112U,
            ReadU16(event.record.bytes.data() + 38U),
            &request) ||
        request.operation_id != event.operation_id) return false;
    const ProtectedGenerationProjection* target =
        FindGenerationProjection(*state, request.generation);
    if (target == nullptr ||
        (target->bytes[16] != 1U && target->bytes[16] != 2U) ||
        !Equal(
            request.expected_receipt_sha256.data(),
            target->bytes.data() + 312U,
            request.expected_receipt_sha256.size())) return false;
    WriteU64(operation.bytes.data() + 24U, request.generation);
  } else {
    return false;
  }
  Byte32 prepared_state{};
  if (!BuildCanonicalState(
          *state,
          extra_generation,
          &operation,
          nullptr,
          &prepared_state) ||
      (extra_generation != nullptr &&
       !CommitGenerationProjection(state, generation)) ||
      !CommitProjection(
          &state->operations,
          operation,
          [](const ProtectedOperationProjection& left,
             const ProtectedOperationProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 16U);
          })) return false;
  state->state_sha256 = prepared_state;
  ++state->operation_id_count;
  if (extra_generation != nullptr) {
    state->highest_burned_generation =
        ReadU64(generation.bytes.data());
    ++state->burned_generation_count;
  }
  return true;
}

RecoveryReplayOperation* FindOrAppendReplayOperation(
    ProtectedRecoveryReplayOutput* output,
    const Byte16& operation_id) noexcept {
  if (output == nullptr || AllZero(operation_id.data(), operation_id.size())) {
    return nullptr;
  }
  for (std::size_t index = 0U; index < output->operation_count; ++index) {
    if (output->operations[index].operation_id == operation_id) {
      return &output->operations[index];
    }
  }
  if (output->operation_count >= output->operations.size()) return nullptr;
  RecoveryReplayOperation& operation =
      output->operations[output->operation_count++];
  operation.present = true;
  operation.operation_id = operation_id;
  operation.inventory_index = g_phase_a_operation_count;
  return &operation;
}

bool ValidateRecoveryEventAuthority(
    const RecoveryPublicationEvent& event,
    std::uint16_t publication_sequence,
    const ProtectedResidueProjection* provisional_residue,
    const ProtectedOperationProjection* provisional_operation) noexcept {
  const bool record_event =
      event.kind == RecoveryPublicationEventKind::Prepared ||
      event.kind == RecoveryPublicationEventKind::AttemptInitial ||
      event.kind == RecoveryPublicationEventKind::AttemptRecovery ||
      event.kind == RecoveryPublicationEventKind::AttemptReplay ||
      event.kind == RecoveryPublicationEventKind::Outcome ||
      event.kind == RecoveryPublicationEventKind::Committed ||
      event.kind == RecoveryPublicationEventKind::Quarantined;
  if (record_event) {
    JournalRecordKind kind{};
    std::uint32_t sequence = UINT32_MAX;
    std::uint16_t encoded_publication_sequence = 0U;
    Byte32 hash{};
    if (!event.record_present ||
        !ValidateJournalRecord(event.record, &kind, &sequence, &hash) ||
        !GetJournalPublicationSequence(
            event.record, &encoded_publication_sequence) ||
        encoded_publication_sequence != publication_sequence ||
        !Equal(
            event.record.bytes.data() + 16U,
            event.operation_id.data(),
            event.operation_id.size()) ||
        event.record.bytes[32] != event.opcode ||
        RecordPublicationEventKind(kind, event.record.bytes[7]) != event.kind) {
      return false;
    }
    if (event.kind == RecoveryPublicationEventKind::Prepared) {
      if (event.record.bytes[32] != event.opcode) return false;
      if (event.opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
        CreateKeysetRequest request{};
        return DecodeCreateKeysetRequest(
                   event.record.bytes.data() + 112U,
                   ReadU16(event.record.bytes.data() + 38U),
                   &request) &&
               request.operation_id == event.operation_id &&
               Equal(
                   request.expected_state_sha256.data(),
                   event.record.bytes.data() + 272U,
                   request.expected_state_sha256.size());
      }
      if (event.opcode ==
          static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
        RevokeKeysetRequest request{};
        return DecodeRevokeKeysetRequest(
                   event.record.bytes.data() + 112U,
                   ReadU16(event.record.bytes.data() + 38U),
                   &request) &&
               request.operation_id == event.operation_id &&
               Equal(
                   request.expected_state_sha256.data(),
                   event.record.bytes.data() + 272U,
                   request.expected_state_sha256.size());
      }
      return false;
    }
    return true;
  }
  if (event.record_present ||
      (event.kind != RecoveryPublicationEventKind::BootstrapResidue &&
       event.kind != RecoveryPublicationEventKind::JournalResidue &&
       event.kind != RecoveryPublicationEventKind::RevokeResidue)) return false;
  const ProtectedResidueProjection* residue = provisional_residue;
  const ProtectedOperationProjection* bootstrap = provisional_operation;
  std::size_t matches = residue == nullptr ? 0U : 1U;
  for (std::size_t index = 0U; index < g_deferred_residues.size(); ++index) {
    if (!g_deferred_residues[index].present ||
        ReadU16(g_deferred_residues[index].bytes.data() + 18U) !=
            publication_sequence) continue;
    if (residue != nullptr || ++matches != 1U) return false;
    residue = &g_deferred_residues[index];
    bootstrap = &g_deferred_residue_operations[index];
  }
  const std::uint8_t expected_kind =
      event.kind == RecoveryPublicationEventKind::BootstrapResidue
          ? 1U
          : event.kind == RecoveryPublicationEventKind::JournalResidue ? 2U : 3U;
  if (matches != 1U || residue == nullptr || !residue->present ||
      !Equal(
          residue->bytes.data(),
          event.operation_id.data(),
          event.operation_id.size()) ||
      residue->bytes[16] != event.residue_ordinal ||
      residue->bytes[17] != expected_kind ||
      ReadU16(residue->bytes.data() + 18U) != publication_sequence) {
    return false;
  }
  return expected_kind != 1U ||
      (bootstrap != nullptr && bootstrap->present &&
       Equal(
           bootstrap->bytes.data(),
           event.operation_id.data(),
           event.operation_id.size()) &&
       bootstrap->bytes[17] == 3U);
}

bool BuildRecoveryPhysicalOperationHash(
    const ProtectedRecoveryReplayOutput& output,
    Byte32* hash) noexcept;

bool ReplayRecoveryPublications(
    ProtectedOperationsState* filesystem_authority,
    const RecoveryPublicationEvent* events,
    std::size_t event_count,
    const RecoveryPublicationEvent* provisional_event,
    const ProtectedResidueProjection* provisional_residue,
    const ProtectedOperationProjection* provisional_operation,
    ProtectedRecoveryReplayOutput* output) noexcept {
  if (filesystem_authority == nullptr || events == nullptr || output == nullptr ||
      event_count > kMaximumPublicationSequence ||
      (provisional_event != nullptr &&
       event_count >= kMaximumPublicationSequence)) return false;
  const std::size_t total_count =
      event_count + (provisional_event == nullptr ? 0U : 1U);
  for (std::size_t index = 0U; index < total_count; ++index) {
    const RecoveryPublicationEvent* event = RecoveryPublicationEventAt(
        events, event_count, provisional_event, index);
    if (event == nullptr) return false;
    const bool is_provisional = provisional_event != nullptr &&
        index == event_count;
    if (!ValidateRecoveryEventAuthority(
            *event,
            static_cast<std::uint16_t>(index + 1U),
            is_provisional ? provisional_residue : nullptr,
            is_provisional ? provisional_operation : nullptr)) return false;
  }
  if (!ValidateRecoveryPublicationEvents(
          events, event_count, provisional_event)) return false;
  WipeCustodyOwned(output, sizeof(*output));
  output->next_publication_sequence = 1U;
  output->next_publication_sequence =
      static_cast<std::uint16_t>(total_count + 1U);
  output->keyset_entry_count = g_phase_a_keyset_count;
  output->control_entry_count = g_phase_a_control_count;
  for (const PhaseAOperationInventory& inventory : g_phase_a_operations) {
    if (inventory.present && inventory.quarantine_location) {
      ++output->quarantine_entry_count;
    }
  }
  for (const ProtectedResidueProjection& residue : g_deferred_residues) {
    if (residue.present) ++output->quarantine_entry_count;
  }

  for (std::size_t index = 0U; index < total_count; ++index) {
    const RecoveryPublicationEvent* event = RecoveryPublicationEventAt(
        events, event_count, provisional_event, index);
    if (event == nullptr) return false;
    RecoveryReplayOperation* operation = FindOrAppendReplayOperation(
        output, event->operation_id);
    if (operation == nullptr) return false;
    if (event->kind == RecoveryPublicationEventKind::Prepared) {
      operation->opcode = event->opcode;
      std::size_t inventory_index = g_phase_a_operation_count;
      if (FindReplayInventory(
              operation->operation_id, &inventory_index) != nullptr) {
        operation->inventory_index = inventory_index;
      }
    } else if (event->kind ==
               RecoveryPublicationEventKind::RevokeResidue) {
      operation->latest_revoke_residue_sequence =
          static_cast<std::uint16_t>(index + 1U);
    }
  }
  for (std::size_t index = 0U; index < total_count; ++index) {
    const RecoveryPublicationEvent* event_pointer = RecoveryPublicationEventAt(
        events, event_count, provisional_event, index);
    if (event_pointer == nullptr) return false;
    const RecoveryPublicationEvent& event = *event_pointer;
    RecoveryReplayOperation* operation = FindOrAppendReplayOperation(
        output, event.operation_id);
    if (operation == nullptr ||
        (event.kind != RecoveryPublicationEventKind::AttemptInitial &&
         event.kind != RecoveryPublicationEventKind::AttemptRecovery)) {
      continue;
    }
    const std::uint16_t publication_sequence =
        static_cast<std::uint16_t>(index + 1U);
    if (operation->effect_authorizer_sequence != 0U) continue;
    if (operation->opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
        (operation->opcode ==
             static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
         publication_sequence >
             operation->latest_revoke_residue_sequence)) {
      operation->effect_authorizer_sequence = publication_sequence;
    }
  }

  WipeCustodyOwned(
      g_recovered_operations_scratch.data(),
      sizeof(g_recovered_operations_scratch));
  g_recovered_present_scratch.fill(false);
  auto& recovered_operations = g_recovered_operations_scratch;
  auto& recovered_present = g_recovered_present_scratch;
  for (std::size_t index = 0U; index < output->operation_count; ++index) {
    RecoveryReplayOperation& operation = output->operations[index];
    if (operation.inventory_index >= g_phase_a_operation_count) continue;
    const PhaseAOperationInventory& inventory =
        g_phase_a_operations[operation.inventory_index];
    if (inventory.pending_operation_directory &&
        provisional_event != nullptr &&
        provisional_event->kind == RecoveryPublicationEventKind::Prepared &&
        provisional_event->operation_id == operation.operation_id) {
      operation.inventory_index = g_phase_a_operation_count;
      continue;
    }
    if (!LoadRecoveredReplayOperation(
            filesystem_authority,
            inventory,
            &recovered_operations[operation.inventory_index]) ||
        !ClassifyReplayPhysicalEffect(
            filesystem_authority,
            inventory,
            recovered_operations[operation.inventory_index],
            &operation.physical_effect)) {
      WipeCustodyOwned(
          recovered_operations.data(), sizeof(recovered_operations));
      return false;
    }
    recovered_present[operation.inventory_index] = true;
    operation.candidate_present =
        recovered_operations[operation.inventory_index].candidate_present;
    if (operation.candidate_present) {
      const RecoveredJournalOperation& recovered =
          recovered_operations[operation.inventory_index];
      operation.candidate_identity = recovered.candidate_identity;
      operation.candidate_length = recovered.opcode ==
              static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)
          ? recovered.candidate_length
          : inventory.candidate_entry.byte_length;
      operation.candidate_closure = recovered.candidate_closure;
      if (recovered.opcode ==
              static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
          !ComputeSha256(
              recovered.candidate_bytes.data(),
              recovered.candidate_length,
              &operation.candidate_content_hash)) {
        WipeCustodyOwned(
            recovered_operations.data(), sizeof(recovered_operations));
        return false;
      }
    }
    if (operation.physical_effect == RecoveryEffectClass::ExactFinal &&
        operation.effect_authorizer_sequence == 0U) {
      WipeCustodyOwned(
          recovered_operations.data(), sizeof(recovered_operations));
      return false;
    }
  }

  WipeCustodyOwned(&g_replay_state_scratch, sizeof(g_replay_state_scratch));
  ProtectedOperationsState& replay = g_replay_state_scratch;
  if (!DuplicateRecoveryFilesystem(
          filesystem_authority->filesystem, &replay.filesystem) ||
      !BuildCanonicalState(
          replay, nullptr, nullptr, nullptr, &replay.state_sha256)) {
    CloseRecoveryFilesystem(&replay.filesystem);
    WipeCustodyOwned(recovered_operations.data(), sizeof(recovered_operations));
    WipeCustodyOwned(&replay, sizeof(replay));
    return false;
  }
  replay.next_publication_sequence =
      static_cast<std::uint16_t>(total_count + 1U);
  bool valid = true;
  for (std::size_t index = 0U; index < total_count && valid; ++index) {
    const RecoveryPublicationEvent* event_pointer = RecoveryPublicationEventAt(
        events, event_count, provisional_event, index);
    if (event_pointer == nullptr) {
      valid = false;
      break;
    }
    const RecoveryPublicationEvent& event = *event_pointer;
    const std::uint16_t publication_sequence =
        static_cast<std::uint16_t>(index + 1U);
    RecoveryReplayOperation* operation = FindOrAppendReplayOperation(
        output, event.operation_id);
    if (operation == nullptr) {
      valid = false;
      break;
    }
    const bool is_provisional = provisional_event != nullptr &&
        index == event_count;
    switch (event.kind) {
      case RecoveryPublicationEventKind::Prepared:
        CopyRecoveryProjectionState(
            replay, &output->mutation_prepared_projection);
        output->mutation_prepared_present = true;
        valid = ApplyPreparedReplayState(&replay, event);
        operation->lifecycle = RecoveryReplayLifecycle::Active;
        output->active_operation_present = true;
        output->active_operation_id = event.operation_id;
        break;
      case RecoveryPublicationEventKind::AttemptInitial:
      case RecoveryPublicationEventKind::AttemptRecovery:
        ++operation->attempt_count;
        if (publication_sequence ==
                operation->effect_authorizer_sequence &&
            operation->physical_effect == RecoveryEffectClass::ExactFinal) {
          if (operation->inventory_index >= recovered_operations.size() ||
              !recovered_present[operation->inventory_index]) {
            valid = false;
            break;
          }
          RecoveredJournalOperation& recovered =
              recovered_operations[operation->inventory_index];
          if (is_provisional && event.record_present) {
            recovered.prior = event.record;
            ++recovered.next_sequence;
            ++recovered.attempt_count;
          }
          recovered.effect_authorizing_publication_sequence =
              publication_sequence;
          valid = operation->opcode ==
                      static_cast<std::uint8_t>(Opcode::CreateKeyset)
              ? RecoverCommittedCreate(&replay, recovered, false, true)
              : RecoverCommittedRevoke(&replay, recovered, true);
          operation->physical_effect_applied = valid;
        }
        break;
      case RecoveryPublicationEventKind::AttemptReplay:
        ++operation->attempt_count;
        break;
      case RecoveryPublicationEventKind::Outcome:
        operation->outcome_seen = true;
        valid = operation->physical_effect_applied && event.record_present &&
            Equal(
                event.record.bytes.data() + 480U,
                replay.state_sha256.data(),
                replay.state_sha256.size());
        if (valid && is_provisional &&
            operation->inventory_index < recovered_operations.size() &&
            recovered_present[operation->inventory_index]) {
          RecoveredJournalOperation& recovered =
              recovered_operations[operation->inventory_index];
          recovered.outcome_present = true;
          recovered.outcome = event.record;
          recovered.prior = event.record;
          ++recovered.next_sequence;
        }
        break;
      case RecoveryPublicationEventKind::Committed:
        operation->lifecycle = RecoveryReplayLifecycle::Committed;
        output->active_operation_present = false;
        output->active_operation_id.fill(0U);
        break;
      case RecoveryPublicationEventKind::Quarantined:
        if (operation->inventory_index >= recovered_operations.size() ||
            !recovered_present[operation->inventory_index] ||
            operation->physical_effect == RecoveryEffectClass::ExactFinal) {
          valid = false;
          break;
        }
        if (is_provisional && event.record_present) {
          RecoveredJournalOperation& recovered =
              recovered_operations[operation->inventory_index];
          recovered.quarantined = true;
          recovered.prior = event.record;
          ++recovered.next_sequence;
        }
        valid = RecoverQuarantinedCreate(
            &replay,
            recovered_operations[operation->inventory_index],
            true);
        operation->physical_effect_applied = valid;
        operation->lifecycle = RecoveryReplayLifecycle::Quarantined;
        output->active_operation_present = false;
        output->active_operation_id.fill(0U);
        break;
      case RecoveryPublicationEventKind::BootstrapResidue:
      case RecoveryPublicationEventKind::JournalResidue:
      case RecoveryPublicationEventKind::RevokeResidue:
        valid = CommitRecoveryResidueAt(
            &replay,
            publication_sequence,
            is_provisional ? provisional_residue : nullptr,
            is_provisional ? provisional_operation : nullptr);
        operation->next_residue_ordinal =
            static_cast<std::uint8_t>(event.residue_ordinal + 1U);
        if (event.kind == RecoveryPublicationEventKind::BootstrapResidue) {
          operation->lifecycle = RecoveryReplayLifecycle::Bootstrap;
        }
        break;
      default:
        valid = false;
        break;
    }
  }
  if (valid && output->active_operation_present) {
    RecoveryReplayOperation* operation = FindOrAppendReplayOperation(
        output, output->active_operation_id);
    if (operation == nullptr ||
        operation->inventory_index >= recovered_operations.size() ||
        !recovered_present[operation->inventory_index]) {
      valid = provisional_event != nullptr;
    } else {
      RecoveredJournalOperation& recovered =
          recovered_operations[operation->inventory_index];
      const RecoveryChainPhase phase = recovered.outcome_present
          ? RecoveryChainPhase::OutcomeOnly
          : operation->attempt_count == 0U
              ? RecoveryChainPhase::PreparedOnly
              : RecoveryChainPhase::Attempted;
      valid = SelectRecoveryAction(
          operation->opcode,
          phase,
          operation->physical_effect,
          operation->attempt_count,
          &output->nonterminal_action);
      valid = valid &&
          output->nonterminal_action != RecoveryAction::RejectPreserve;
      output->nonterminal_present = valid;
      output->nonterminal_inventory_index = operation->inventory_index;
      if (valid) {
        CopyRecoveryProjectionState(
            replay, &output->nonterminal_base_projection);
        output->nonterminal_base_present = true;
      }
    }
  }
  if (valid) {
    replay.next_publication_sequence =
        static_cast<std::uint16_t>(total_count + 1U);
    CopyRecoveryProjectionState(replay, &output->projection);
    output->projection.next_publication_sequence =
        static_cast<std::uint16_t>(total_count + 1U);
    Byte32 operation_physical_hash{};
    std::array<std::uint8_t, kRecoveryPhysicalSnapshotBytes>
        physical_snapshot{};
    Copy32(
        replay.state_sha256,
        physical_snapshot.data() + kRecoveryPhysicalSnapshotStateOffset);
    WriteU64(
        physical_snapshot.data() +
            kRecoveryPhysicalSnapshotOperationCountOffset,
        output->operation_count);
    WriteU64(
        physical_snapshot.data() +
            kRecoveryPhysicalSnapshotKeysetCountOffset,
        output->keyset_entry_count);
    WriteU64(
        physical_snapshot.data() +
            kRecoveryPhysicalSnapshotControlCountOffset,
        output->control_entry_count);
    WriteU64(
        physical_snapshot.data() +
            kRecoveryPhysicalSnapshotQuarantineCountOffset,
        output->quarantine_entry_count);
    valid = BuildRecoveryPhysicalOperationHash(
                *output, &operation_physical_hash) &&
        ([&]() noexcept {
          Copy32(
              operation_physical_hash,
              physical_snapshot.data() +
                  kRecoveryPhysicalSnapshotOperationHashOffset);
          return HashDomain(
              kRecoveryPhysicalSnapshotDomain,
              sizeof(kRecoveryPhysicalSnapshotDomain) - 1U,
              physical_snapshot.data(),
              physical_snapshot.size(),
              &output->physical_snapshot_digest);
        })();
    WipeCustodyOwned(
        physical_snapshot.data(), physical_snapshot.size());
  }
  CloseRecoveryFilesystem(&replay.filesystem);
  WipeCustodyOwned(recovered_operations.data(), sizeof(recovered_operations));
  WipeCustodyOwned(&replay, sizeof(replay));
  if (!valid) WipeCustodyOwned(output, sizeof(*output));
  return valid;
}

bool EqualRecoveryReplayOperation(
    const RecoveryReplayOperation& left,
    const RecoveryReplayOperation& right) noexcept {
  return left.present == right.present &&
      left.outcome_seen == right.outcome_seen &&
      left.physical_effect_applied == right.physical_effect_applied &&
      left.candidate_present == right.candidate_present &&
      left.operation_id == right.operation_id &&
      left.opcode == right.opcode &&
      left.next_residue_ordinal == right.next_residue_ordinal &&
      left.lifecycle == right.lifecycle &&
      left.physical_effect == right.physical_effect &&
      left.latest_revoke_residue_sequence ==
          right.latest_revoke_residue_sequence &&
      left.effect_authorizer_sequence == right.effect_authorizer_sequence &&
      left.attempt_count == right.attempt_count &&
      left.inventory_index == right.inventory_index &&
      left.candidate_length == right.candidate_length &&
      left.candidate_identity.volume_serial_number ==
          right.candidate_identity.volume_serial_number &&
      Equal(
          left.candidate_identity.file_id.data(),
          right.candidate_identity.file_id.data(),
          left.candidate_identity.file_id.size()) &&
      Equal(
          left.candidate_content_hash.data(),
          right.candidate_content_hash.data(),
          left.candidate_content_hash.size()) &&
      Equal(
          left.candidate_closure.data(),
          right.candidate_closure.data(),
          left.candidate_closure.size());
}

bool BuildRecoveryPhysicalOperationHash(
    const ProtectedRecoveryReplayOutput& output,
    Byte32* hash) noexcept {
  if (hash == nullptr || output.operation_count > output.operations.size()) {
    return false;
  }
  g_recovery_physical_projection_scratch.fill(0U);
  for (std::size_t index = 0U; index < output.operation_count; ++index) {
    const RecoveryReplayOperation& operation = output.operations[index];
    std::uint8_t* serialized =
        g_recovery_physical_projection_scratch.data() +
        index * kRecoveryPhysicalOperationBytes;
    WriteU16(serialized, 1U);
    serialized[2] = static_cast<std::uint8_t>(
        (operation.present ? 1U : 0U) |
        (operation.outcome_seen ? 2U : 0U) |
        (operation.physical_effect_applied ? 4U : 0U) |
        (operation.candidate_present ? 8U : 0U));
    serialized[4] = operation.opcode;
    serialized[5] = operation.next_residue_ordinal;
    serialized[6] = static_cast<std::uint8_t>(operation.lifecycle);
    serialized[7] = static_cast<std::uint8_t>(operation.physical_effect);
    std::memcpy(
        serialized + 8U,
        operation.operation_id.data(),
        operation.operation_id.size());
    WriteU16(serialized + 24U, operation.latest_revoke_residue_sequence);
    WriteU16(serialized + 26U, operation.effect_authorizer_sequence);
    WriteU32(serialized + 28U, operation.attempt_count);
    WriteU64(
        serialized + 32U,
        static_cast<std::uint64_t>(operation.inventory_index));
    WriteU64(serialized + 40U, operation.candidate_length);
    IdentityBytes(operation.candidate_identity, serialized + 48U);
    Copy32(operation.candidate_content_hash, serialized + 72U);
    Copy32(operation.candidate_closure, serialized + 104U);
  }
  const bool valid = ComputeSha256(
      g_recovery_physical_projection_scratch.data(),
      output.operation_count * kRecoveryPhysicalOperationBytes,
      hash);
  WipeCustodyOwned(
      g_recovery_physical_projection_scratch.data(),
      g_recovery_physical_projection_scratch.size());
  return valid;
}

bool EqualRecoveryOperationReplayState(
    const ProtectedOperationReplayState& left,
    const ProtectedOperationReplayState& right) noexcept {
  return left.present == right.present &&
      left.quarantined == right.quarantined &&
      left.opcode == right.opcode &&
      left.operation_id == right.operation_id &&
      left.operator_sid_length == right.operator_sid_length &&
      left.operator_sid == right.operator_sid &&
      left.body_length == right.body_length &&
      left.body == right.body &&
      left.stable_binding == right.stable_binding &&
      left.attempt_count == right.attempt_count &&
      left.next_sequence == right.next_sequence &&
      left.result_length == right.result_length &&
      left.result == right.result &&
      left.operation_path.length == right.operation_path.length &&
      left.operation_path.value == right.operation_path.value &&
      left.prepared.bytes == right.prepared.bytes &&
      left.prior.bytes == right.prior.bytes;
}

bool EqualRecoveryProjectionState(
    const ProtectedOperationsState& left,
    const ProtectedOperationsState& right) noexcept {
  if (left.state_sha256 != right.state_sha256 ||
      left.active_generation != right.active_generation ||
      left.highest_burned_generation != right.highest_burned_generation ||
      left.highest_committed_generation != right.highest_committed_generation ||
      left.committed_generation_count != right.committed_generation_count ||
      left.burned_generation_count != right.burned_generation_count ||
      left.operation_id_count != right.operation_id_count ||
      left.quarantined_operation_count != right.quarantined_operation_count ||
      left.residue_count != right.residue_count ||
      left.next_publication_sequence != right.next_publication_sequence ||
      left.active_receipt_sha256 != right.active_receipt_sha256 ||
      left.runtime_manifest_spki_sha256 != right.runtime_manifest_spki_sha256 ||
      left.admission_evidence_spki_sha256 !=
          right.admission_evidence_spki_sha256 ||
      left.runtime_manifest_spki != right.runtime_manifest_spki ||
      left.admission_evidence_spki != right.admission_evidence_spki ||
      left.active_create_operation_id != right.active_create_operation_id ||
      left.active_create_stable_binding != right.active_create_stable_binding ||
      left.active_keyset_directory_identity.volume_serial_number !=
          right.active_keyset_directory_identity.volume_serial_number ||
      !Equal(
          left.active_keyset_directory_identity.file_id.data(),
          right.active_keyset_directory_identity.file_id.data(),
          left.active_keyset_directory_identity.file_id.size()) ||
      left.active_keyset_file_hashes != right.active_keyset_file_hashes ||
      left.active_predecessor_generation !=
          right.active_predecessor_generation ||
      left.active_revoked != right.active_revoked ||
      left.historical_key_count != right.historical_key_count ||
      left.ready != right.ready ||
      !EqualRecoveryOperationReplayState(
          left.create_replay, right.create_replay) ||
      !EqualRecoveryOperationReplayState(
          left.revoke_replay, right.revoke_replay)) return false;
  for (std::size_t index = 0U;
       index < left.active_keyset_file_identities.size();
       ++index) {
    if (left.active_keyset_file_identities[index].volume_serial_number !=
            right.active_keyset_file_identities[index].volume_serial_number ||
        !Equal(
            left.active_keyset_file_identities[index].file_id.data(),
            right.active_keyset_file_identities[index].file_id.data(),
            left.active_keyset_file_identities[index].file_id.size())) {
      return false;
    }
  }
  for (std::size_t index = 0U; index < left.generations.size(); ++index) {
    if (left.generations[index].present != right.generations[index].present ||
        left.generations[index].bytes != right.generations[index].bytes) {
      return false;
    }
  }
  for (std::size_t index = 0U; index < left.operations.size(); ++index) {
    if (left.operations[index].present != right.operations[index].present ||
        left.operations[index].bytes != right.operations[index].bytes) {
      return false;
    }
  }
  for (std::size_t index = 0U; index < left.residues.size(); ++index) {
    if (left.residues[index].present != right.residues[index].present ||
        left.residues[index].bytes != right.residues[index].bytes) {
      return false;
    }
  }
  for (std::size_t index = 0U; index < left.historical_keys.size(); ++index) {
    if (left.historical_keys[index].spki != right.historical_keys[index].spki ||
        left.historical_keys[index].key_id !=
            right.historical_keys[index].key_id) return false;
  }
  return true;
}

bool EqualRecoveryReplayOutputs(
    const ProtectedRecoveryReplayOutput& left,
    const ProtectedRecoveryReplayOutput& right) noexcept {
  if (left.operation_count != right.operation_count) return false;
  for (std::size_t index = 0U; index < left.operation_count; ++index) {
    if (!EqualRecoveryReplayOperation(
            left.operations[index], right.operations[index])) return false;
  }
  return left.operation_count == right.operation_count &&
      left.active_operation_present == right.active_operation_present &&
      left.active_operation_id == right.active_operation_id &&
      left.nonterminal_present == right.nonterminal_present &&
      left.nonterminal_base_present == right.nonterminal_base_present &&
      left.mutation_prepared_present == right.mutation_prepared_present &&
      left.nonterminal_inventory_index == right.nonterminal_inventory_index &&
      left.nonterminal_action == right.nonterminal_action &&
      left.next_publication_sequence == right.next_publication_sequence &&
      left.keyset_entry_count == right.keyset_entry_count &&
      left.control_entry_count == right.control_entry_count &&
      left.quarantine_entry_count == right.quarantine_entry_count &&
      Equal(
          left.physical_snapshot_digest.data(),
          right.physical_snapshot_digest.data(),
          left.physical_snapshot_digest.size()) &&
      EqualRecoveryProjectionState(left.projection, right.projection) &&
      EqualRecoveryProjectionState(
          left.nonterminal_base_projection,
          right.nonterminal_base_projection) &&
      EqualRecoveryProjectionState(
          left.mutation_prepared_projection,
          right.mutation_prepared_projection);
}

bool ValidatePhaseACanonicalReplay(
    ProtectedOperationsState* state,
    std::size_t publication_count,
    const RecoveryPublicationEvent* provisional_event,
    const ProtectedResidueProjection* provisional_residue,
    const ProtectedOperationProjection* provisional_operation,
  ProtectedRecoveryReplayOutput* output) noexcept {
  if (state == nullptr || output == nullptr) return false;
  WipeCustodyOwned(
      &g_replay_first_scratch, sizeof(g_replay_first_scratch));
  WipeCustodyOwned(
      &g_replay_second_scratch, sizeof(g_replay_second_scratch));
  ProtectedRecoveryReplayOutput& first = g_replay_first_scratch;
  ProtectedRecoveryReplayOutput& second = g_replay_second_scratch;
  const bool valid = ReplayRecoveryPublications(
                         state,
                         g_publication_events.data() + 1U,
                         publication_count,
                         provisional_event,
                         provisional_residue,
                         provisional_operation,
                         &first) &&
      ReplayRecoveryPublications(
          state,
          g_publication_events.data() + 1U,
          publication_count,
          provisional_event,
          provisional_residue,
          provisional_operation,
          &second) &&
      EqualRecoveryReplayOutputs(first, second);
  if (valid) {
    *output = second;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_recovery_evidence.canonical_replay_count += 2U;
    g_recovery_evidence.publication_count = publication_count +
        (provisional_event == nullptr ? 0U : 1U);
    g_recovery_evidence.operation_count = second.operation_count;
    g_recovery_evidence.next_publication_sequence =
        second.next_publication_sequence;
    g_recovery_evidence.active_operation_present =
        second.active_operation_present;
    g_recovery_evidence.nonterminal_present = second.nonterminal_present;
    g_recovery_evidence.canonical_state_sha256 =
        second.projection.state_sha256;
    g_recovery_evidence.physical_snapshot_sha256 =
        second.physical_snapshot_digest;
    for (std::size_t index = 0U; index < second.operation_count; ++index) {
      const RecoveryReplayOperation& source = second.operations[index];
      ProtectedRecoveryOperationEvidenceForTest& destination =
          g_recovery_evidence.operations[index];
      destination.present = source.present;
      destination.physical_effect_applied = source.physical_effect_applied;
      destination.operation_id = source.operation_id;
      destination.opcode = source.opcode;
      destination.lifecycle = static_cast<std::uint8_t>(source.lifecycle);
      destination.physical_effect =
          static_cast<std::uint8_t>(source.physical_effect);
      destination.effect_authorizer_sequence =
          source.effect_authorizer_sequence;
      destination.attempt_count = source.attempt_count;
    }
#endif
  }
  WipeCustodyOwned(&g_replay_first_scratch, sizeof(g_replay_first_scratch));
  WipeCustodyOwned(&g_replay_second_scratch, sizeof(g_replay_second_scratch));
  if (!valid) WipeCustodyOwned(output, sizeof(*output));
  return valid;
}

bool CompleteFinalRevokeControlAuthority(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    std::uint64_t generation,
    ProtectedObjectIdentity* completed_identity,
    Byte32* completed_hash) noexcept {
  if (state == nullptr || !operation.present || generation == 0U ||
      completed_identity == nullptr || completed_hash == nullptr) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_control_stage = 0U;
  g_revoke_control_error = ERROR_SUCCESS;
#endif
  std::array<wchar_t, 48U> control_component{};
  ProtectedPath pending_path{};
  ProtectedPath final_path{};
  std::array<std::uint8_t, 256U> initial_control{};
  std::array<std::uint8_t, 256U> writer_control{};
  std::array<std::uint8_t, 256U> final_control{};
  std::size_t initial_length = 0U;
  std::size_t writer_length = 0U;
  std::size_t final_length = 0U;
  std::uint64_t opened_length = 0U;
  HANDLE writer = nullptr;
  ProtectedObjectIdentity initial_identity{};
  ProtectedObjectIdentity writer_identity{};
  ProtectedObjectIdentity final_identity{};
  ProtectedObjectIdentity controls_identity{};
  std::array<std::uint8_t, 24U> identity_bytes{};
  Byte32 initial_hash{};
  Byte32 writer_hash{};
  Byte32 final_hash{};
  bool valid =
      BuildControlComponent(generation, &control_component) &&
      ComposeProtectedChildPath(
          operation.path, L"revoke.pending.gckc", &pending_path) &&
      ComposeProtectedChildPath(
          state->filesystem.controls_path,
          control_component.data(),
          &final_path) &&
      ReadProtectedFinalFile(
          state->filesystem,
          final_path,
          initial_control.data(),
          initial_control.size(),
          &initial_length,
          &initial_identity) &&
      initial_length == initial_control.size() &&
      initial_control[0] == 'G' && initial_control[1] == 'C' &&
      initial_control[2] == 'K' && initial_control[3] == 'C' &&
      ReadU16(initial_control.data() + 4U) == 1U &&
      initial_control[6] == 1U &&
      ReadU32(initial_control.data() + 8U) == initial_control.size();
  if (valid) IdentityBytes(initial_identity, identity_bytes.data());
  valid = valid &&
      Equal(
          identity_bytes.data(),
          initial_control.data() + 48U,
          identity_bytes.size()) &&
      HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          initial_control.data(),
          224U,
          &initial_hash) &&
      Equal(
          initial_hash.data(),
          initial_control.data() + 224U,
          initial_hash.size());
  valid = RecordRevokeControlStep(valid, 1U);
  valid = valid &&
      OpenProtectedExistingFileForParentRename(
          state->filesystem,
          final_path,
          initial_control.size(),
          &writer,
          &opened_length,
          &writer_identity) &&
      opened_length == initial_control.size() &&
      EqualMoveIdentity(writer_identity, initial_identity) &&
      ReadProtectedOpenFile(
          state->filesystem,
          writer,
          writer_control.data(),
          writer_control.size(),
          &writer_length,
          &writer_identity) &&
      writer_length == initial_control.size() &&
      EqualMoveIdentity(writer_identity, initial_identity) &&
      Equal(
          writer_control.data(), initial_control.data(), initial_control.size()) &&
      HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          writer_control.data(),
          224U,
          &writer_hash) &&
      Equal(writer_hash.data(), initial_hash.data(), initial_hash.size()) &&
      FlushProtectedOpenFileForParentRename(state->filesystem, writer, true);
  valid = RecordRevokeControlStep(valid, 2U);
  if (writer != nullptr && writer != INVALID_HANDLE_VALUE) CloseHandle(writer);
  writer = nullptr;
  valid = valid &&
      ReadProtectedFinalFile(
          state->filesystem,
          final_path,
          final_control.data(),
          final_control.size(),
          &final_length,
          &final_identity) &&
      final_length == initial_control.size() &&
      EqualMoveIdentity(final_identity, initial_identity) &&
      Equal(final_control.data(), initial_control.data(), initial_control.size()) &&
      HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          final_control.data(),
          224U,
          &final_hash) &&
      Equal(final_hash.data(), initial_hash.data(), initial_hash.size());
  valid = RecordRevokeControlStep(valid, 3U);
  valid = valid && RecordRevokeControlStep(
      ProtectedPathIsAbsentGuarded(state->filesystem, pending_path), 4U);
  valid = valid && RecordRevokeControlStep(
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.controls,
          &controls_identity) &&
      EqualMoveIdentity(controls_identity, state->filesystem.controls_identity),
      5U);
  WipeCustodyOwned(initial_control.data(), initial_control.size());
  WipeCustodyOwned(writer_control.data(), writer_control.size());
  WipeCustodyOwned(final_control.data(), final_control.size());
  if (valid) {
    *completed_identity = initial_identity;
    *completed_hash = initial_hash;
  }
  return valid;
}

bool CompleteFinalPreparedOperationDirectory(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation) noexcept {
  if (state == nullptr || !operation.present || operation.attempt_count != 0U ||
      operation.next_sequence != 1U || operation.candidate_present) return false;
  std::array<wchar_t, 48U> pending_component{};
  std::array<wchar_t, 48U> final_component{};
  std::array<wchar_t, 48U> prepared_component{};
  ProtectedPath pending_path{};
  HANDLE final_directory = nullptr;
  ProtectedObjectIdentity final_identity{};
  ProtectedObjectIdentity initial_journal_identity{};
  ProtectedObjectIdentity final_journal_identity{};
  std::size_t journal_entry_count = 0U;
  RecoveredJournalOperation revalidated{};
  DirectoryMoveAuthority& authority = g_directory_move_authority_scratch;
  bool valid =
      BuildOperationComponent(
          operation.operation_id, true, &pending_component) &&
      BuildOperationComponent(
          operation.operation_id, false, &final_component) &&
      BuildRecordComponent(0U, L"prepared", false, &prepared_component) &&
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.journal,
          &initial_journal_identity) &&
      EqualMoveIdentity(
          initial_journal_identity, state->filesystem.journal_identity) &&
      ComposeProtectedChildPath(
          state->filesystem.journal_path,
          pending_component.data(),
          &pending_path) &&
      OpenProtectedExistingDirectory(
          state->filesystem,
          operation.path,
          true,
          &final_directory,
          &final_identity) &&
      CaptureDirectoryMoveAuthority(
          state->filesystem,
          operation.path,
          final_directory,
          &authority) &&
      EqualMoveIdentity(final_identity, authority.root_identity) &&
      authority.root_file_count == 1U &&
      !authority.nested_directory_present && authority.nested_file_count == 0U &&
      authority.root_files[0].present &&
      EqualWide(
          authority.root_files[0].name.data(),
          authority.root_files[0].name_length,
          prepared_component.data()) &&
      authority.root_files[0].byte_length == operation.prepared.bytes.size() &&
      Equal(
          authority.root_files[0].bytes.data(),
          operation.prepared.bytes.data(),
          operation.prepared.bytes.size()) &&
      CompleteCapturedDirectoryAtFinal(
          state->filesystem,
          operation.path,
          &final_directory,
          authority) &&
      ProtectedPathIsAbsentGuarded(state->filesystem, pending_path) &&
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.journal,
          &final_journal_identity) &&
      EqualMoveIdentity(final_journal_identity, initial_journal_identity) &&
      EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.journal,
          &g_recovery_entries,
          &journal_entry_count);
  const ProtectedDirectoryEntry* final_entry = valid
      ? FindNamedEntry(journal_entry_count, final_component.data())
      : nullptr;
  valid = valid && final_entry != nullptr &&
      RecoverJournalOperation(
          state,
          state->filesystem.journal_path,
          *final_entry,
          false,
          &revalidated,
          true) &&
      revalidated.present && revalidated.attempt_count == 0U &&
      revalidated.next_sequence == 1U && !revalidated.candidate_present &&
      !revalidated.outcome_present && !revalidated.committed &&
      !revalidated.quarantined &&
      revalidated.operation_id == operation.operation_id &&
      Equal(
          revalidated.prepared.bytes.data(),
          operation.prepared.bytes.data(),
          operation.prepared.bytes.size());
  if (final_directory != nullptr && final_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(final_directory);
  }
  WipeCustodyOwned(&authority, sizeof(authority));
  return valid;
}

bool CompleteFinalBootstrapResidueDirectory(
    ProtectedOperationsState* state,
    const ProtectedResidueProjection& expected_residue,
    const ProtectedOperationProjection& expected_operation) noexcept {
  if (state == nullptr || !expected_residue.present ||
      expected_residue.bytes[16] != 0U || expected_residue.bytes[17] != 1U ||
      !expected_operation.present) return false;
  Byte16 operation_id{};
  std::memcpy(
      operation_id.data(), expected_residue.bytes.data(), operation_id.size());
  const std::uint16_t publication_sequence =
      ReadU16(expected_residue.bytes.data() + 18U);
  std::array<wchar_t, 80U> residue_component{};
  std::array<wchar_t, 48U> pending_component{};
  std::array<wchar_t, 48U> operation_component{};
  ProtectedPath final_path{};
  ProtectedPath pending_path{};
  ProtectedPath operation_path{};
  ProtectedObjectIdentity initial_quarantine_identity{};
  ProtectedObjectIdentity final_quarantine_identity{};
  ProtectedObjectIdentity initial_journal_identity{};
  ProtectedObjectIdentity final_journal_identity{};
  HANDLE final_directory = nullptr;
  ProtectedObjectIdentity final_identity{};
  std::size_t quarantine_entry_count = 0U;
  std::array<std::uint8_t, 24U> identity_bytes{};
  DirectoryMoveAuthority& authority = g_directory_move_authority_scratch;
  bool valid =
      BuildResidueComponent(
          operation_id,
          0U,
          publication_sequence,
          L"bootstrap",
          &residue_component) &&
      BuildOperationComponent(operation_id, true, &pending_component) &&
      BuildOperationComponent(operation_id, false, &operation_component) &&
      ComposeProtectedChildPath(
          state->filesystem.quarantine_path,
          residue_component.data(),
          &final_path) &&
      ComposeProtectedChildPath(
          state->filesystem.journal_path,
          pending_component.data(),
          &pending_path) &&
      ComposeProtectedChildPath(
          state->filesystem.journal_path,
          operation_component.data(),
          &operation_path) &&
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.quarantine,
          &initial_quarantine_identity) &&
      EqualMoveIdentity(
          initial_quarantine_identity,
          state->filesystem.quarantine_identity) &&
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.journal,
          &initial_journal_identity) &&
      EqualMoveIdentity(
          initial_journal_identity, state->filesystem.journal_identity) &&
      EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.quarantine,
          &g_quarantine_scan_entries,
          &quarantine_entry_count);
  const ProtectedDirectoryEntry* final_entry = valid
      ? FindNamedEntryIn(
            g_quarantine_scan_entries,
            quarantine_entry_count,
            residue_component.data())
      : nullptr;
  valid = valid && final_entry != nullptr &&
      (final_entry->attributes & FILE_ATTRIBUTE_DIRECTORY) != 0U &&
      (final_entry->attributes & ~FILE_ATTRIBUTE_DIRECTORY) == 0U &&
      OpenProtectedExistingDirectory(
          state->filesystem,
          final_path,
          true,
          &final_directory,
          &final_identity) &&
      CaptureDirectoryMoveAuthority(
          state->filesystem,
          final_path,
          final_directory,
          &authority) &&
      EqualMoveIdentity(final_identity, authority.root_identity) &&
      (IdentityBytes(authority.root_identity, identity_bytes.data()),
       Equal(
           identity_bytes.data(),
           expected_residue.bytes.data() + 28U,
           identity_bytes.size())) &&
      authority.root_file_count <= 1U && !authority.nested_directory_present &&
      authority.nested_file_count == 0U &&
      (authority.root_file_count == 0U ||
       (authority.root_files[0].present &&
        EqualWide(
            authority.root_files[0].name.data(),
            authority.root_files[0].name_length,
            L".s00000000-prepared.pending") &&
        authority.root_files[0].byte_length <= 1023U)) &&
      CompleteCapturedDirectoryAtFinal(
          state->filesystem,
          final_path,
          &final_directory,
          authority) &&
      ProtectedPathIsAbsentGuarded(state->filesystem, pending_path) &&
      ProtectedPathIsAbsentGuarded(state->filesystem, operation_path) &&
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.quarantine,
          &final_quarantine_identity) &&
      EqualMoveIdentity(
          final_quarantine_identity, initial_quarantine_identity) &&
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.journal,
          &final_journal_identity) &&
      EqualMoveIdentity(final_journal_identity, initial_journal_identity);
  ProtectedResidueProjection revalidated_residue{};
  ProtectedOperationProjection revalidated_operation{};
  valid = valid &&
      RecoverResidueProjection(
          state->filesystem,
          *final_entry,
          &revalidated_residue,
          &revalidated_operation) &&
      Equal(
          revalidated_residue.bytes.data(),
          expected_residue.bytes.data(),
          revalidated_residue.bytes.size()) &&
      Equal(
          revalidated_operation.bytes.data(),
          expected_operation.bytes.data(),
          revalidated_operation.bytes.size());
  if (final_directory != nullptr && final_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(final_directory);
  }
  WipeCustodyOwned(&authority, sizeof(authority));
  return valid;
}

ProtectedOperationResult QuarantineFailedCreate(
    ProtectedOperationsState* state,
    const CreateKeysetRequest& request,
    const std::uint8_t* body,
    std::uint16_t body_length,
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const Byte32& stable_binding,
    const JournalRecord& prepared,
    const JournalRecord& attempt,
    std::uint64_t creation_time,
    const ProtectedPath& operation_path,
    HANDLE* operation_directory,
    const ProtectedObjectIdentity& candidate_identity,
    const Byte32* observed_closure,
    std::uint32_t quarantine_sequence,
    std::uint16_t reason,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* result,
    std::uint32_t* result_length) noexcept {
  if (state == nullptr || body == nullptr || operator_sid == nullptr ||
      body_length == 0U || operator_sid_length == 0U ||
      operation_directory == nullptr || *operation_directory == nullptr ||
      *operation_directory == INVALID_HANDLE_VALUE || reason < 1U || reason > 3U ||
      result == nullptr || result_length == nullptr) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  std::array<std::uint8_t, 368U> closure_projection{};
  WriteU16(closure_projection.data(), 1U);
  WriteU16(closure_projection.data() + 2U, 5U);
  IdentityBytes(candidate_identity, closure_projection.data() + 4U);
  Byte32 closure_hash{};
  Byte32 candidate_identity_hash{};
  std::array<std::uint8_t, 24U> identity_bytes{};
  IdentityBytes(candidate_identity, identity_bytes.data());
  const bool closure_valid = observed_closure != nullptr
      ? (closure_hash = *observed_closure, true)
      : HashDomainLarge(
            kCandidateClosureDomain,
            sizeof(kCandidateClosureDomain) - 1U,
            closure_projection.data(),
            closure_projection.size(),
            &closure_hash);
  if (!closure_valid ||
      !HashDomain(
          kQuarantinedIdentityDomain,
          sizeof(kQuarantinedIdentityDomain) - 1U,
          identity_bytes.data(),
          identity_bytes.size(),
          &candidate_identity_hash)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  Byte32 final_state{};
  ProtectedGenerationProjection generation_projection{};
  ProtectedOperationProjection operation_projection{};
  if (!ComputeQuarantinedState(
          *state,
          request,
          stable_binding,
          candidate_identity,
          closure_hash,
          &generation_projection,
          &operation_projection,
          &final_state)) return ProtectedOperationResult::CustodyOrJournal;
  std::array<std::uint8_t, 112U> quarantine_fields{};
  WriteU16(quarantine_fields.data(), 3U);
  WriteU16(quarantine_fields.data() + 2U, reason);
  WriteU32(quarantine_fields.data() + 8U, 3U);
  Copy32(candidate_identity_hash, quarantine_fields.data() + 16U);
  Copy32(closure_hash, quarantine_fields.data() + 48U);
  Copy32(final_state, quarantine_fields.data() + 80U);
  JournalRecord quarantined{};
  HANDLE quarantined_file = nullptr;
  ProtectedObjectIdentity operation_identity{};
  if (!CaptureProtectedObjectIdentity(
          state->filesystem, *operation_directory, &operation_identity)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Quarantined,
          0U,
          prepared,
          attempt,
          nullptr,
          quarantine_fields.data(),
          quarantine_fields.size(),
          creation_time,
          state->next_publication_sequence,
          &quarantined) ||
      !PublishJournalRecord(
          state,
          operation_path,
          quarantine_sequence,
          L"quarantined",
          quarantined,
          true,
          &quarantined_file,
          *operation_directory,
          operation_identity)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  CloseHandle(quarantined_file);
  quarantined_file = nullptr;
  DirectoryMoveAuthority& move_authority =
      g_directory_move_authority_scratch;
  if (!CaptureDirectoryMoveAuthority(
          state->filesystem,
          operation_path,
          *operation_directory,
          &move_authority) ||
      !ValidateLiveQuarantineMoveAuthority(
          move_authority,
          candidate_identity,
          quarantine_sequence,
          quarantined)) {
    WipeCustodyOwned(&move_authority, sizeof(move_authority));
    return ProtectedOperationResult::CustodyOrJournal;
  }
  std::array<wchar_t, 48U> quarantine_component{};
  ProtectedPath quarantine_path{};
  if (!BuildOperationComponent(request.operation_id, false, &quarantine_component) ||
      !ComposeProtectedChildPath(
          state->filesystem.quarantine_path,
          quarantine_component.data(),
          &quarantine_path) ||
      !MoveDirectoryWithCapturedAuthority(
          state->filesystem,
          operation_path,
          quarantine_path,
          operation_directory,
          move_authority)) {
    WipeCustodyOwned(&move_authority, sizeof(move_authority));
    return ProtectedOperationResult::CustodyOrJournal;
  }
  WipeCustodyOwned(&move_authority, sizeof(move_authority));
  const bool operation_already_consumed =
      FindOperationProjection(*state, request.operation_id) != nullptr;
  if (!CommitGenerationProjection(state, generation_projection) ||
      !CommitProjection(
          &state->operations,
          operation_projection,
          [](const ProtectedOperationProjection& left,
             const ProtectedOperationProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 16U);
          })) return ProtectedOperationResult::CustodyOrJournal;
  result->fill(0U);
  WriteU16(result->data(), 1U);
  WriteU16(result->data() + 2U, 10U);
  std::memcpy(result->data() + 8U, request.operation_id.data(), 16U);
  WriteU64(result->data() + 24U, request.requested_generation);
  WriteU64(result->data() + 32U, request.predecessor_generation);
  std::memcpy(result->data() + 40U, request.expected_state_sha256.data(), 32U);
  Copy32(state->state_sha256, result->data() + 72U);
  Copy32(final_state, result->data() + 104U);
  state->state_sha256 = final_state;
  state->highest_burned_generation = request.requested_generation;
  if (!operation_already_consumed) {
    ++state->burned_generation_count;
    ++state->operation_id_count;
  }
  ++state->quarantined_operation_count;
  *result_length = kCreateKeysetResultBytes;
  RememberReplay(
      &state->create_replay,
      static_cast<std::uint8_t>(Opcode::CreateKeyset),
      request.operation_id,
      operator_sid,
      operator_sid_length,
      body,
      body_length,
      stable_binding,
      true,
      quarantine_path,
      prepared,
      quarantined,
      quarantine_sequence + 1U,
      *result,
      *result_length);
  return ProtectedOperationResult::Success;
}

bool RecoverNonterminalCreateAsQuarantine(
    ProtectedOperationsState* state,
    const RecoveredJournalOperation& operation,
    bool replay_prepared_state = false) noexcept {
  if (state == nullptr || !operation.present || operation.committed ||
      operation.quarantined || operation.outcome_present ||
      operation.opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
      operation.attempt_count == 0U ||
      operation.attempt_count >= kMaximumJournalAttempts ||
      !operation.candidate_present || operation.candidate_complete) return false;
  const std::uint16_t body_length =
      ReadU16(operation.prepared.bytes.data() + 38U);
  const std::uint16_t sid_length =
      ReadU16(operation.prepared.bytes.data() + 36U);
  CreateKeysetRequest request{};
  if (!DecodeCreateKeysetRequest(
          operation.prepared.bytes.data() + 112U,
          body_length,
          &request) ||
      !Equal(request.operation_id.data(), operation.operation_id.data(), 16U) ||
      !(replay_prepared_state
            ? Equal(
                  request.expected_state_sha256.data(),
                  operation.prepared.bytes.data() + 272U,
                  request.expected_state_sha256.size())
            : Equal(
                  request.expected_state_sha256.data(),
                  state->state_sha256.data(),
                  state->state_sha256.size())) ||
      request.requested_generation !=
          (replay_prepared_state
               ? state->highest_burned_generation
               : state->highest_burned_generation + 1U) ||
      request.predecessor_generation != state->highest_committed_generation) {
    return false;
  }
  Byte32 stable_binding{};
  std::memcpy(
      stable_binding.data(),
      operation.prepared.bytes.data() + 304U,
      stable_binding.size());
  if (!replay_prepared_state) {
  ProtectedGenerationProjection prepared_generation{};
  ProtectedOperationProjection prepared_operation{};
  prepared_generation.present = true;
  WriteU64(
      prepared_generation.bytes.data(), request.requested_generation);
  WriteU64(
      prepared_generation.bytes.data() + 8U,
      request.predecessor_generation);
  prepared_generation.bytes[16] = 4U;
  std::memcpy(
      prepared_generation.bytes.data() + 24U,
      request.operation_id.data(),
      request.operation_id.size());
  prepared_operation.present = true;
  std::memcpy(
      prepared_operation.bytes.data(),
      request.operation_id.data(),
      request.operation_id.size());
  prepared_operation.bytes[16] =
      static_cast<std::uint8_t>(Opcode::CreateKeyset);
  prepared_operation.bytes[17] = 1U;
  WriteU64(
      prepared_operation.bytes.data() + 24U,
      request.requested_generation);
  Copy32(stable_binding, prepared_operation.bytes.data() + 32U);
  Byte32 prepared_state{};
  if (!BuildCanonicalState(
          *state,
          &prepared_generation,
          &prepared_operation,
          nullptr,
          &prepared_state) ||
      !CommitGenerationProjection(state, prepared_generation) ||
      !CommitProjection(
          &state->operations,
          prepared_operation,
          [](const ProtectedOperationProjection& left,
             const ProtectedOperationProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 16U);
          })) return false;
  state->state_sha256 = prepared_state;
  state->highest_burned_generation = request.requested_generation;
  ++state->burned_generation_count;
  ++state->operation_id_count;
  }

  ProtectedPath candidate_path{};
  Byte32 observed_closure{};
  bool complete_closure = false;
  if (!ComposeProtectedChildPath(
          operation.path, L"keyset.pending", &candidate_path) ||
      !BuildCandidateClosure(
          state->filesystem,
          candidate_path,
          operation.candidate_identity,
          &operation.prepared,
          state,
          &observed_closure,
          &complete_closure) ||
      complete_closure ||
      !Equal(
          observed_closure.data(),
          operation.candidate_closure.data(),
          observed_closure.size())) return false;

  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  const std::uint64_t creation_time =
      static_cast<std::uint64_t>(now.dwLowDateTime) |
      (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
  HANDLE operation_directory = nullptr;
  ProtectedObjectIdentity operation_identity{};
  if (!OpenProtectedExistingDirectory(
          state->filesystem,
          operation.path,
          true,
          &operation_directory,
          &operation_identity)) return false;
  JournalRecord recovery_attempt{};
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Attempt,
          1U,
          operation.prepared,
          operation.prior,
          nullptr,
          nullptr,
          0U,
          creation_time,
          state->next_publication_sequence,
          &recovery_attempt) ||
      !PublishJournalRecord(
          state,
          operation.path,
          operation.next_sequence,
          L"attempt",
          recovery_attempt,
          false,
          nullptr,
          operation_directory,
          operation_identity)) {
    CloseHandle(operation_directory);
    return false;
  }
  std::array<std::uint8_t, kCreateKeysetResultBytes> result{};
  std::uint32_t result_length = 0U;
  const ProtectedOperationResult quarantine_result = QuarantineFailedCreate(
      state,
      request,
      operation.prepared.bytes.data() + 112U,
      body_length,
      operation.prepared.bytes.data() + 40U,
      sid_length,
      stable_binding,
      operation.prepared,
      recovery_attempt,
      creation_time,
      operation.path,
      &operation_directory,
      operation.candidate_identity,
      &observed_closure,
      operation.next_sequence + 1U,
      1U,
      &result,
      &result_length);
  if (operation_directory != nullptr &&
      operation_directory != INVALID_HANDLE_VALUE) CloseHandle(operation_directory);
  return quarantine_result == ProtectedOperationResult::Success &&
         result_length == kCreateKeysetResultBytes;
}

ProtectedOperationResult PerformCreate(
    ProtectedOperationsState* state,
    const CreateKeysetRequest& request,
    const std::uint8_t* body,
    std::uint32_t body_length,
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const Byte32& authenticated_binding,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* result,
    std::uint32_t* result_length,
    const RecoveredJournalOperation* recovery = nullptr,
    bool replay_prepared_state = false) noexcept {
  Byte32 body_hash{};
  Byte32 stable_binding{};
  if (!ComputeSha256(body, body_length, &body_hash) ||
      !ComputeStableOperationBinding(
          operator_sid,
          operator_sid_length,
          request.operation_id,
          static_cast<std::uint8_t>(Opcode::CreateKeyset),
          1U,
          body,
          body_length,
          &stable_binding)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  const std::uint64_t creation_time =
      static_cast<std::uint64_t>(now.dwLowDateTime) |
      (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
  const std::uint64_t effect_creation_time = recovery == nullptr
      ? creation_time
      : ReadU64(recovery->prepared.bytes.data() + 832U);
  PreparedJournalInput prepared_input{};
  prepared_input.operation_id = request.operation_id;
  prepared_input.opcode = static_cast<std::uint8_t>(Opcode::CreateKeyset);
  prepared_input.operator_sid = operator_sid;
  prepared_input.operator_sid_length = operator_sid_length;
  prepared_input.body = body;
  prepared_input.body_length = static_cast<std::uint16_t>(body_length);
  prepared_input.body_sha256 = body_hash;
  prepared_input.expected_state_sha256 = request.expected_state_sha256;
  prepared_input.stable_binding = stable_binding;
  prepared_input.authenticated_binding = authenticated_binding;
  prepared_input.creation_file_time = creation_time;
  prepared_input.publication_sequence = state->next_publication_sequence;
  JournalRecord prepared{};
  if (recovery == nullptr &&
      !EncodePreparedJournalRecord(prepared_input, &prepared)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  if (recovery != nullptr) {
    if (!recovery->present || recovery->committed || recovery->quarantined ||
        recovery->outcome_present ||
        recovery->opcode != static_cast<std::uint8_t>(Opcode::CreateKeyset) ||
        !(replay_prepared_state
              ? Equal(
                    request.expected_state_sha256.data(),
                    recovery->prepared.bytes.data() + 272U,
                    request.expected_state_sha256.size())
              : Equal(
                    request.expected_state_sha256.data(),
                    state->state_sha256.data(),
                    state->state_sha256.size())) ||
        request.requested_generation !=
            (replay_prepared_state
                 ? state->highest_burned_generation
                 : state->highest_burned_generation + 1U) ||
        request.predecessor_generation != state->highest_committed_generation ||
        !Equal(
            stable_binding.data(),
            recovery->prepared.bytes.data() + 304U,
            stable_binding.size())) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
    prepared = recovery->prepared;
  }

  ProtectedPath final_operation_path{};
  HANDLE operation_directory = nullptr;
  ProtectedObjectIdentity operation_identity{};
  if (recovery == nullptr) {
    if (!PublishPreparedOperationDirectory(
            state,
            request.operation_id,
            prepared,
            &final_operation_path,
            &operation_directory)) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
    if (!CaptureProtectedObjectIdentity(
            state->filesystem, operation_directory, &operation_identity)) {
      CloseHandle(operation_directory);
      return ProtectedOperationResult::CustodyOrJournal;
    }
  } else {
    final_operation_path = recovery->path;
    if (!OpenProtectedExistingDirectory(
            state->filesystem,
            final_operation_path,
            true,
            &operation_directory,
            &operation_identity)) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
  }

  ProtectedPath candidate_path{};
  HANDLE candidate_directory = nullptr;
  ProtectedObjectIdentity candidate_identity{};
  if (!ComposeProtectedChildPath(
          final_operation_path, L"keyset.pending", &candidate_path) ||
      (recovery == nullptr
           ? !CreateProtectedDirectory(
                 state->filesystem, candidate_path, &candidate_directory)
           : recovery->candidate_present
               ? !OpenProtectedExistingDirectory(
                     state->filesystem,
                     candidate_path,
                     false,
                     &candidate_directory,
                     &candidate_identity)
               : !CreateProtectedDirectory(
                     state->filesystem, candidate_path, &candidate_directory))) {
    CloseHandle(operation_directory);
    return ProtectedOperationResult::CustodyOrJournal;
  }
  if (!CaptureProtectedObjectIdentity(
          state->filesystem, candidate_directory, &candidate_identity) ||
      (recovery != nullptr && recovery->candidate_present &&
       (candidate_identity.volume_serial_number !=
            recovery->candidate_identity.volume_serial_number ||
        !Equal(
            candidate_identity.file_id.data(),
            recovery->candidate_identity.file_id.data(),
            candidate_identity.file_id.size()))) ||
      (recovery != nullptr &&
       !ProtectedDirectoryIsEmptyGuarded(
           state->filesystem, candidate_directory))) {
    CloseHandle(candidate_directory);
    CloseHandle(operation_directory);
    return ProtectedOperationResult::CustodyOrJournal;
  }
  JournalRecord attempt{};
  const std::uint32_t attempt_sequence =
      recovery == nullptr ? 1U : recovery->next_sequence;
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Attempt,
          recovery == nullptr ? 0U : 1U,
          prepared,
          recovery == nullptr ? prepared : recovery->prior,
          recovery == nullptr ? &authenticated_binding : nullptr,
          nullptr,
          0U,
          creation_time,
          state->next_publication_sequence,
          &attempt) ||
      !PublishJournalRecord(
          state,
          final_operation_path,
          attempt_sequence,
          L"attempt",
          attempt,
          false,
          nullptr,
          operation_directory,
          operation_identity)) {
    CloseHandle(candidate_directory);
    CloseHandle(operation_directory);
    return ProtectedOperationResult::CustodyOrJournal;
  }

  CustodyKeysetMaterial material{};
  const CustodyGenerationResult custody_result =
      GenerateCustodyKeyset(
          state->historical_key_count == 0U ? nullptr : state->historical_keys.data(),
          state->historical_key_count,
          &material);
  if (custody_result != CustodyGenerationResult::Success) {
    CloseHandle(candidate_directory);
    WipeCustodyOwned(&material, sizeof(material));
    const ProtectedOperationResult quarantine_result = QuarantineFailedCreate(
        state,
        request,
        body,
        static_cast<std::uint16_t>(body_length),
        operator_sid,
        operator_sid_length,
        stable_binding,
        prepared,
        attempt,
        creation_time,
        final_operation_path,
        &operation_directory,
        candidate_identity,
        nullptr,
        attempt_sequence + 1U,
        custody_result == CustodyGenerationResult::Duplicate ? 3U : 2U,
        result,
        result_length);
    if (operation_directory != nullptr &&
        operation_directory != INVALID_HANDLE_VALUE) CloseHandle(operation_directory);
    return quarantine_result;
  }
  std::array<HANDLE, 5U> files{};
  std::array<ProtectedObjectIdentity, 5U> file_identities{};
  std::array<Byte32, 4U> file_hashes{};
  ProtectedObjectIdentity directory_identity{};
  bool success = CaptureProtectedObjectIdentity(
      state->filesystem, candidate_directory, &directory_identity);
  if (success) success = CreateAndWriteKeyFile(
      state->filesystem, candidate_path, L"runtime-manifest.pk8",
      material.runtime_manifest.pkcs8.data(), material.runtime_manifest.pkcs8.size(),
      &files[0], &file_identities[0], &file_hashes[0]);
  if (success) success = CreateAndWriteKeyFile(
      state->filesystem, candidate_path, L"runtime-manifest.spki",
      material.runtime_manifest.spki.data(), material.runtime_manifest.spki.size(),
      &files[1], &file_identities[1], &file_hashes[1]);
  if (success) success = CreateAndWriteKeyFile(
      state->filesystem, candidate_path, L"admission-evidence.pk8",
      material.admission_evidence.pkcs8.data(), material.admission_evidence.pkcs8.size(),
      &files[2], &file_identities[2], &file_hashes[2]);
  if (success) success = CreateAndWriteKeyFile(
      state->filesystem, candidate_path, L"admission-evidence.spki",
      material.admission_evidence.spki.data(), material.admission_evidence.spki.size(),
      &files[3], &file_identities[3], &file_hashes[3]);

  std::array<std::uint8_t, 640U> receipt{};
  Byte32 receipt_hash{};
  if (success) {
    ProtectedPath receipt_path{};
    success = ComposeProtectedChildPath(
                  candidate_path, L"keyset-receipt.gckr", &receipt_path) &&
              CreateProtectedFile(
                  state->filesystem, receipt_path, true, &files[4]) &&
              CaptureProtectedObjectIdentity(
                  state->filesystem, files[4], &file_identities[4]);
  }
  if (success) {
    receipt[0] = 'G'; receipt[1] = 'C'; receipt[2] = 'K'; receipt[3] = 'R';
    WriteU16(receipt.data() + 4U, 1U);
    receipt[6] = 1U;
    WriteU32(receipt.data() + 8U, 640U);
    std::memcpy(receipt.data() + 16U, request.operation_id.data(), 16U);
    WriteU64(receipt.data() + 32U, request.requested_generation);
    WriteU64(receipt.data() + 40U, request.predecessor_generation);
    WriteU64(receipt.data() + 48U, effect_creation_time);
    IdentityBytes(directory_identity, receipt.data() + 56U);
    for (std::size_t index = 0U; index < file_identities.size(); ++index) {
      IdentityBytes(file_identities[index], receipt.data() + 80U + index * 24U);
    }
    for (std::size_t index = 0U; index < file_hashes.size(); ++index) {
      Copy32(file_hashes[index], receipt.data() + 200U + index * 32U);
    }
    std::memcpy(receipt.data() + 328U, material.runtime_manifest.spki.data(), 44U);
    std::memcpy(receipt.data() + 372U, material.admission_evidence.spki.data(), 44U);
    std::array<std::uint8_t, 104U> pair_projection{};
    WriteU64(pair_projection.data(), request.requested_generation);
    WriteU64(pair_projection.data() + 8U, request.predecessor_generation);
    std::memcpy(pair_projection.data() + 16U, material.runtime_manifest.spki.data(), 44U);
    std::memcpy(pair_projection.data() + 60U, material.admission_evidence.spki.data(), 44U);
    Byte32 pair_hash{};
    success = HashDomain(
                  kPairDomain,
                  sizeof(kPairDomain) - 1U,
                  pair_projection.data(),
                  pair_projection.size(),
                  &pair_hash);
    if (success) Copy32(pair_hash, receipt.data() + 416U);
    if (success) success = HashDomainLarge(
        kReceiptDomain,
        sizeof(kReceiptDomain) - 1U,
        receipt.data(),
        608U,
        &receipt_hash);
    if (success) Copy32(receipt_hash, receipt.data() + 608U);
    if (success) success = WriteReadExact(
                               state->filesystem,
                               files[4],
                               receipt.data(),
                               receipt.size()) &&
                           ProtectedFilesystemRecoveryCheckpoint(state->filesystem) &&
                           FlushFileBuffers(files[4]) != FALSE &&
                           ProtectedFilesystemRecoveryCheckpoint(state->filesystem);
  }
  std::array<wchar_t, 32U> generation_component{};
  ProtectedPath final_keyset_path{};
  Byte32 pre_move_candidate_closure{};
  bool pre_move_complete = false;
  if (success) {
    success = BuildGenerationComponent(
            request.requested_generation, &generation_component) &&
        ComposeProtectedChildPath(
            state->filesystem.keysets_path,
            generation_component.data(),
            &final_keyset_path);
  }
  if (success) {
    for (HANDLE file : files) {
      if (file == nullptr || !FlushProtectedOpenFileForParentRename(
              state->filesystem, file, false)) {
        success = false;
      }
    }
  }
  for (HANDLE& file : files) {
    if (file != nullptr) CloseHandle(file);
    file = nullptr;
  }
  if (success) {
    success = BuildCandidateClosure(
                  state->filesystem,
                  candidate_path,
                  candidate_identity,
                  &prepared,
                  nullptr,
                  &pre_move_candidate_closure,
                  &pre_move_complete,
                  candidate_directory) &&
        pre_move_complete;
  }
  if (success) {
    success = RenameProtectedDirectory(
        state->filesystem, candidate_directory, final_keyset_path);
  }
  CloseHandle(candidate_directory);
  candidate_directory = nullptr;
  Byte32 receipt_content_hash{};
  std::array<Byte32, 5U> expected_content_hashes{};
  for (std::size_t index = 0U; index < file_hashes.size(); ++index) {
    expected_content_hashes[index] = file_hashes[index];
  }
  if (success) {
    success = ComputeSha256(
        receipt.data(), receipt.size(), &receipt_content_hash);
    expected_content_hashes[4U] = receipt_content_hash;
  }
  constexpr std::array<const wchar_t*, 5U> kCandidateNames = {
      L"runtime-manifest.pk8",
      L"runtime-manifest.spki",
      L"admission-evidence.pk8",
      L"admission-evidence.spki",
      L"keyset-receipt.gckr"};
  const std::array<const std::uint8_t*, 5U> expected_bytes = {
      material.runtime_manifest.pkcs8.data(),
      material.runtime_manifest.spki.data(),
      material.admission_evidence.pkcs8.data(),
      material.admission_evidence.spki.data(),
      receipt.data()};
  constexpr std::array<std::size_t, 5U> kCandidateLengths = {
      48U, 44U, 48U, 44U, 640U};
  Byte32 pre_writer_candidate_closure{};
  bool pre_writer_complete = false;
  if (success) {
    success = BuildCandidateClosure(
                  state->filesystem,
                  final_keyset_path,
                  candidate_identity,
                  &prepared,
                  nullptr,
                  &pre_writer_candidate_closure,
                  &pre_writer_complete,
                  nullptr,
                  true) &&
        pre_writer_complete &&
        Equal(
            pre_writer_candidate_closure.data(),
            pre_move_candidate_closure.data(),
            pre_writer_candidate_closure.size()) &&
        ProtectedPathIsAbsentGuarded(state->filesystem, candidate_path);
  }
  for (std::size_t index = 0U; index < kCandidateNames.size() && success;
       ++index) {
    ProtectedPath final_file_path{};
    HANDLE final_file = nullptr;
    std::uint64_t final_file_length = 0U;
    ProtectedObjectIdentity final_file_identity{};
    std::array<std::uint8_t, 640U> final_file_bytes{};
    std::size_t final_read_length = 0U;
    Byte32 final_file_hash{};
    success = ComposeProtectedChildPath(
                  final_keyset_path,
                  kCandidateNames[index],
                  &final_file_path) &&
        OpenProtectedExistingFileForParentRename(
            state->filesystem,
            final_file_path,
            kCandidateLengths[index],
            &final_file,
            &final_file_length,
            &final_file_identity) &&
        final_file_length == kCandidateLengths[index] &&
        final_file_identity.volume_serial_number ==
            file_identities[index].volume_serial_number &&
        Equal(
            final_file_identity.file_id.data(),
            file_identities[index].file_id.data(),
            final_file_identity.file_id.size()) &&
        ReadProtectedOpenFile(
            state->filesystem,
            final_file,
            final_file_bytes.data(),
            kCandidateLengths[index],
            &final_read_length,
            &final_file_identity) &&
        final_read_length == kCandidateLengths[index] &&
        Equal(
            final_file_bytes.data(),
            expected_bytes[index],
            kCandidateLengths[index]) &&
        ComputeSha256(
            final_file_bytes.data(), final_read_length, &final_file_hash) &&
        Equal(
            final_file_hash.data(),
            expected_content_hashes[index].data(),
            final_file_hash.size()) &&
        FlushProtectedOpenFileForParentRename(
            state->filesystem, final_file, true);
    if (final_file != nullptr && final_file != INVALID_HANDLE_VALUE) {
      CloseHandle(final_file);
    }
    WipeCustodyOwned(final_file_bytes.data(), final_file_bytes.size());
  }
  Byte32 final_candidate_closure{};
  bool final_complete = false;
  if (success) {
    success = BuildCandidateClosure(
                  state->filesystem,
                  final_keyset_path,
                  candidate_identity,
                  &prepared,
                  nullptr,
                  &final_candidate_closure,
                  &final_complete,
                  nullptr,
                  true) &&
        final_complete &&
        Equal(
            final_candidate_closure.data(),
            pre_move_candidate_closure.data(),
            final_candidate_closure.size()) &&
        ProtectedPathIsAbsentGuarded(state->filesystem, candidate_path);
  }
  if (!success) {
    CloseHandle(operation_directory);
    WipeCustodyOwned(&material, sizeof(material));
    WipeCustodyOwned(receipt.data(), receipt.size());
    return ProtectedOperationResult::CustodyOrJournal;
  }

  Byte32 final_state{};
  ProtectedGenerationProjection generation_projection{};
  ProtectedOperationProjection operation_projection{};
  if (!ComputeCommittedState(
          *state,
          request,
          stable_binding,
          directory_identity,
          file_identities,
          file_hashes,
          receipt_hash,
          &generation_projection,
          &operation_projection,
          &final_state)) {
    CloseHandle(operation_directory);
    WipeCustodyOwned(&material, sizeof(material));
    WipeCustodyOwned(receipt.data(), receipt.size());
    return ProtectedOperationResult::CustodyOrJournal;
  }
  result->fill(0U);
  WriteU16(result->data(), 1U);
  WriteU16(result->data() + 2U, 1U);
  std::memcpy(result->data() + 8U, request.operation_id.data(), 16U);
  WriteU64(result->data() + 24U, request.requested_generation);
  WriteU64(result->data() + 32U, request.predecessor_generation);
  std::memcpy(result->data() + 40U, request.expected_state_sha256.data(), 32U);
  Copy32(state->state_sha256, result->data() + 72U);
  Copy32(final_state, result->data() + 104U);
  Copy32(receipt_hash, result->data() + 136U);
  Copy32(material.runtime_manifest_key_id, result->data() + 168U);
  Copy32(material.admission_evidence_key_id, result->data() + 200U);
  std::memcpy(result->data() + 232U, material.runtime_manifest.spki.data(), 44U);
  std::memcpy(result->data() + 276U, material.admission_evidence.spki.data(), 44U);

  std::array<std::uint8_t, 432U> outcome_fields{};
  WriteU16(outcome_fields.data(), 1U);
  WriteU16(outcome_fields.data() + 2U, 1U);
  WriteU32(outcome_fields.data() + 4U, kCreateKeysetResultBytes);
  WriteU32(outcome_fields.data() + 8U, 1U);
  Byte32 side_identity{};
  if (!HashDomain(
          kKeysetIdentityDomain,
          sizeof(kKeysetIdentityDomain) - 1U,
          receipt.data() + 56U,
          144U,
          &side_identity)) {
    CloseHandle(operation_directory);
    WipeCustodyOwned(&material, sizeof(material));
    WipeCustodyOwned(receipt.data(), receipt.size());
    return ProtectedOperationResult::CustodyOrJournal;
  }
  Copy32(side_identity, outcome_fields.data() + 16U);
  Copy32(receipt_hash, outcome_fields.data() + 48U);
  Copy32(final_state, outcome_fields.data() + 80U);
  std::memcpy(outcome_fields.data() + 112U, result->data(), result->size());
  JournalRecord outcome{};
  JournalRecord committed{};
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Outcome, 0U, prepared, attempt, nullptr,
          outcome_fields.data(), outcome_fields.size(), creation_time,
          state->next_publication_sequence, &outcome) ||
      !PublishJournalRecord(
          state,
          final_operation_path,
          attempt_sequence + 1U,
          L"outcome",
          outcome,
          false,
          nullptr,
          operation_directory,
          operation_identity) ||
      !EncodeFollowingJournalRecord(
          JournalRecordKind::Committed, 0U, prepared, outcome, nullptr,
          outcome_fields.data(), outcome_fields.size(), creation_time,
          state->next_publication_sequence, &committed) ||
      !PublishJournalRecord(
          state,
          final_operation_path,
          attempt_sequence + 2U,
          L"committed",
          committed,
          false,
          nullptr,
          operation_directory,
          operation_identity)) {
    CloseHandle(operation_directory);
    WipeCustodyOwned(&material, sizeof(material));
    WipeCustodyOwned(receipt.data(), receipt.size());
    return ProtectedOperationResult::CustodyOrJournal;
  }
  CloseHandle(operation_directory);
  if (!CommitGenerationProjection(state, generation_projection) ||
      !CommitProjection(
          &state->operations,
          operation_projection,
          [](const ProtectedOperationProjection& left,
             const ProtectedOperationProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 16U);
          }) ||
      !AppendHistoricalKey(
          state,
          material.runtime_manifest.spki,
          material.runtime_manifest_key_id) ||
      !AppendHistoricalKey(
          state,
          material.admission_evidence.spki,
          material.admission_evidence_key_id)) {
    WipeCustodyOwned(&material, sizeof(material));
    WipeCustodyOwned(receipt.data(), receipt.size());
    return ProtectedOperationResult::CustodyOrJournal;
  }
  state->state_sha256 = final_state;
  state->active_generation = request.requested_generation;
  state->active_revoked = false;
  state->highest_burned_generation = request.requested_generation;
  state->highest_committed_generation = request.requested_generation;
  ++state->committed_generation_count;
  if (!replay_prepared_state) {
    ++state->burned_generation_count;
    ++state->operation_id_count;
  }
  state->active_receipt_sha256 = receipt_hash;
  state->runtime_manifest_spki_sha256 = material.runtime_manifest_key_id;
  state->admission_evidence_spki_sha256 = material.admission_evidence_key_id;
  state->runtime_manifest_spki = material.runtime_manifest.spki;
  state->admission_evidence_spki = material.admission_evidence.spki;
  state->active_create_operation_id = request.operation_id;
  state->active_create_stable_binding = stable_binding;
  state->active_keyset_directory_identity = directory_identity;
  state->active_keyset_file_identities = file_identities;
  state->active_keyset_file_hashes = file_hashes;
  state->active_predecessor_generation = request.predecessor_generation;
  *result_length = kCreateKeysetResultBytes;
  RememberReplay(
      &state->create_replay,
      static_cast<std::uint8_t>(Opcode::CreateKeyset),
      request.operation_id,
      operator_sid,
      operator_sid_length,
      body,
      static_cast<std::uint16_t>(body_length),
      stable_binding,
      false,
      final_operation_path,
      prepared,
      committed,
      attempt_sequence + 3U,
      *result,
      *result_length);
  WipeCustodyOwned(&material, sizeof(material));
  WipeCustodyOwned(receipt.data(), receipt.size());
  return ProtectedOperationResult::Success;
}

bool ComputeRevokedState(
    const ProtectedOperationsState& state,
    const RevokeKeysetRequest& request,
    const Byte32& revoke_stable_binding,
    const ProtectedGenerationProjection& target_generation,
    const ProtectedObjectIdentity& control_identity,
    const Byte32& control_hash,
    ProtectedGenerationProjection* generation_projection,
    ProtectedOperationProjection* operation_projection,
    Byte32* output) noexcept {
  if (output == nullptr || generation_projection == nullptr ||
      operation_projection == nullptr) return false;

  if (!GenerationProjectionValid(target_generation) ||
      ReadU64(target_generation.bytes.data()) != request.generation ||
      (target_generation.bytes[16] != 1U &&
       target_generation.bytes[16] != 2U)) return false;
  std::array<std::uint8_t, kGenerationEntryBytes> generation =
      target_generation.bytes;
  generation[16] = 3U;
  IdentityBytes(control_identity, generation.data() + 344U);
  Copy32(control_hash, generation.data() + 368U);
  std::memcpy(generation.data() + 400U, request.operation_id.data(), 16U);

  std::array<std::uint8_t, kOperationEntryBytes> operation{};
  std::memcpy(operation.data(), request.operation_id.data(), 16U);
  operation[16] = static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset);
  operation[17] = 1U;
  WriteU64(operation.data() + 24U, request.generation);
  Copy32(revoke_stable_binding, operation.data() + 32U);
  generation_projection->present = true;
  generation_projection->bytes = generation;
  operation_projection->present = true;
  operation_projection->bytes = operation;
  return BuildCanonicalState(
      state, generation_projection, operation_projection, nullptr, output);
}

ProtectedOperationResult PerformRevoke(
    ProtectedOperationsState* state,
    const RevokeKeysetRequest& request,
    const std::uint8_t* body,
    std::uint32_t body_length,
    const std::uint8_t* operator_sid,
    std::uint16_t operator_sid_length,
    const Byte32& authenticated_binding,
    std::array<std::uint8_t, kCreateKeysetResultBytes>* result,
    std::uint32_t* result_length,
    const RecoveredJournalOperation* recovery = nullptr,
    RecoveryAction recovery_action = RecoveryAction::RejectPreserve,
    bool replay_prepared_state = false) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_revoke_control_stage = 0U;
  g_revoke_control_error = ERROR_SUCCESS;
#endif
  Byte32 body_hash{};
  Byte32 stable_binding{};
  if (!ComputeSha256(body, body_length, &body_hash) ||
      !ComputeStableOperationBinding(
          operator_sid,
          operator_sid_length,
          request.operation_id,
          static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset),
          1U,
          body,
          body_length,
          &stable_binding)) return ProtectedOperationResult::CustodyOrJournal;
  FILETIME now{};
  GetSystemTimeAsFileTime(&now);
  const std::uint64_t creation_time =
      static_cast<std::uint64_t>(now.dwLowDateTime) |
      (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
  const std::uint64_t effect_creation_time = recovery == nullptr
      ? creation_time
      : ReadU64(recovery->prepared.bytes.data() + 832U);
  PreparedJournalInput prepared_input{};
  prepared_input.operation_id = request.operation_id;
  prepared_input.opcode = static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset);
  prepared_input.operator_sid = operator_sid;
  prepared_input.operator_sid_length = operator_sid_length;
  prepared_input.body = body;
  prepared_input.body_length = static_cast<std::uint16_t>(body_length);
  prepared_input.body_sha256 = body_hash;
  prepared_input.expected_state_sha256 = request.expected_state_sha256;
  prepared_input.stable_binding = stable_binding;
  prepared_input.authenticated_binding = authenticated_binding;
  prepared_input.creation_file_time = creation_time;
  prepared_input.publication_sequence = state->next_publication_sequence;
  const ProtectedGenerationProjection* target_generation =
      FindGenerationProjection(*state, request.generation);
  const bool target_was_active = target_generation != nullptr &&
      target_generation->bytes[16] == 1U;
  if (target_generation == nullptr ||
      (target_generation->bytes[16] != 1U &&
       target_generation->bytes[16] != 2U) ||
      !Equal(
          request.expected_receipt_sha256.data(),
          target_generation->bytes.data() + 312U,
          32U)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  JournalRecord prepared{};
  if (recovery == nullptr &&
      !EncodePreparedJournalRecord(prepared_input, &prepared)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  if (recovery != nullptr) {
    if (!recovery->present || recovery->committed || recovery->quarantined ||
        recovery->outcome_present ||
        recovery->opcode !=
            static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) ||
        !(replay_prepared_state
              ? Equal(
                    request.expected_state_sha256.data(),
                    recovery->prepared.bytes.data() + 272U,
                    request.expected_state_sha256.size())
              : Equal(
                    request.expected_state_sha256.data(),
                    state->state_sha256.data(),
                    state->state_sha256.size())) ||
        !Equal(
            request.expected_receipt_sha256.data(),
            target_generation->bytes.data() + 312U,
            32U) ||
        !Equal(
            stable_binding.data(),
            recovery->prepared.bytes.data() + 304U,
            stable_binding.size()) ||
        (recovery_action != RecoveryAction::AppendAttemptThenRegenerateRevoke &&
         recovery_action != RecoveryAction::AppendAttemptThenPromoteAndFinish &&
         recovery_action != RecoveryAction::AppendAttemptThenFinishFinal)) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
    prepared = recovery->prepared;
  }
  ProtectedPath final_operation_path{};
  JournalParentAuthority journal_parent{};
  if (recovery == nullptr) {
    if (!PublishPreparedOperationDirectory(
            state,
            request.operation_id,
            prepared,
            &final_operation_path,
            &journal_parent.handle) ||
        !CaptureProtectedObjectIdentity(
            state->filesystem,
            journal_parent.handle,
            &journal_parent.identity)) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
  } else {
    final_operation_path = recovery->path;
    if (!OpenJournalParentAuthority(
            state, final_operation_path, &journal_parent)) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
  }
  JournalRecord attempt{};
  const std::uint32_t attempt_sequence =
      recovery == nullptr ? 1U : recovery->next_sequence;
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Attempt,
          recovery == nullptr ? 0U : 1U,
          prepared,
          recovery == nullptr ? prepared : recovery->prior,
          recovery == nullptr ? &authenticated_binding : nullptr,
          nullptr,
          0U,
          creation_time,
          state->next_publication_sequence,
          &attempt) ||
      !PublishJournalRecord(
          state,
          final_operation_path,
          attempt_sequence,
          L"attempt",
          attempt,
          false,
          nullptr,
          journal_parent.handle,
          journal_parent.identity)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }

  ProtectedPath pending_control_path{};
  ProtectedPath final_control_path{};
  std::array<wchar_t, 48U> control_component{};
  HANDLE control_file = nullptr;
  ProtectedObjectIdentity control_identity{};
  std::array<std::uint8_t, 256U> observed_control{};
  std::size_t observed_control_length = 0U;
  if (!ComposeProtectedChildPath(final_operation_path, L"revoke.pending.gckc", &pending_control_path) ||
      !BuildControlComponent(request.generation, &control_component) ||
      !ComposeProtectedChildPath(
          state->filesystem.controls_path,
          control_component.data(),
          &final_control_path)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  const bool regenerate = recovery == nullptr ||
      recovery_action == RecoveryAction::AppendAttemptThenRegenerateRevoke;
  const bool promote_existing = recovery != nullptr &&
      recovery_action == RecoveryAction::AppendAttemptThenPromoteAndFinish;
  if ((regenerate &&
       (!CreateProtectedFile(
            state->filesystem, pending_control_path, false, &control_file) ||
        !CaptureProtectedObjectIdentity(
            state->filesystem, control_file, &control_identity))) ||
      (promote_existing &&
       (!ReadProtectedExistingFile(
            state->filesystem,
            pending_control_path,
            observed_control.data(),
            observed_control.size(),
            &observed_control_length,
            &control_identity) ||
        observed_control_length != observed_control.size())) ||
      (!regenerate && !promote_existing &&
       (!ReadProtectedFinalFile(
            state->filesystem,
            final_control_path,
            observed_control.data(),
            observed_control.size(),
            &observed_control_length,
            &control_identity) ||
        observed_control_length != observed_control.size()))) {
    if (control_file != nullptr) CloseHandle(control_file);
    return ProtectedOperationResult::CustodyOrJournal;
  }
  std::array<std::uint8_t, 256U> control{};
  control[0] = 'G'; control[1] = 'C'; control[2] = 'K'; control[3] = 'C';
  WriteU16(control.data() + 4U, 1U);
  control[6] = 1U;
  WriteU32(control.data() + 8U, 256U);
  WriteU32(control.data() + 12U, request.reason);
  std::memcpy(control.data() + 16U, request.operation_id.data(), 16U);
  WriteU64(control.data() + 32U, request.generation);
  WriteU64(control.data() + 40U, effect_creation_time);
  IdentityBytes(control_identity, control.data() + 48U);
  std::memcpy(
      control.data() + 72U,
      target_generation->bytes.data() + 312U,
      32U);
  Copy32(state->state_sha256, control.data() + 104U);
  std::array<std::uint8_t, 72U> sid_projection{};
  WriteU16(sid_projection.data(), operator_sid_length);
  std::memcpy(sid_projection.data() + 2U, operator_sid, operator_sid_length);
  Byte32 sid_hash{};
  Byte32 control_hash{};
  if (!HashDomain(
          kOperatorSidDomain,
          sizeof(kOperatorSidDomain) - 1U,
          sid_projection.data(),
          2U + operator_sid_length,
          &sid_hash)) {
    if (control_file != nullptr) CloseHandle(control_file);
    return ProtectedOperationResult::CustodyOrJournal;
  }
  Copy32(sid_hash, control.data() + 136U);
  if (!HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          control.data(),
          224U,
          &control_hash)) {
    if (control_file != nullptr) CloseHandle(control_file);
    return ProtectedOperationResult::CustodyOrJournal;
  }
  Copy32(control_hash, control.data() + 224U);
  if (regenerate) {
    if (!WriteReadExact(
            state->filesystem, control_file, control.data(), control.size()) ||
        !FlushAndRenameProtectedFile(
            state->filesystem, control_file, final_control_path)) {
      CloseHandle(control_file);
      return ProtectedOperationResult::CustodyOrJournal;
    }
  } else if (!Equal(
                 control.data(), observed_control.data(), control.size())) {
    return ProtectedOperationResult::CustodyOrJournal;
  } else if (promote_existing) {
    ProtectedObjectIdentity promoted_identity{};
    if (!PromoteProtectedExistingFile(
            state->filesystem,
            pending_control_path,
            final_control_path,
            false,
            &promoted_identity) ||
        promoted_identity.volume_serial_number !=
            control_identity.volume_serial_number ||
        !Equal(
            promoted_identity.file_id.data(),
            control_identity.file_id.data(),
            control_identity.file_id.size())) {
      return ProtectedOperationResult::CustodyOrJournal;
    }
  }
  if (control_file != nullptr) CloseHandle(control_file);
  control_file = nullptr;
  std::array<std::uint8_t, 256U> final_control{};
  std::size_t final_control_length = 0U;
  ProtectedObjectIdentity final_control_identity{};
  ProtectedObjectIdentity final_controls_identity{};
  Byte32 final_control_hash{};
  bool final_control_valid = RecordRevokeControlStep(
      ReadProtectedFinalFile(
          state->filesystem,
          final_control_path,
          final_control.data(),
          final_control.size(),
          &final_control_length,
          &final_control_identity) &&
      final_control_length == final_control.size() &&
      EqualMoveIdentity(final_control_identity, control_identity) &&
      Equal(final_control.data(), control.data(), control.size()) &&
      HashDomain(
          kControlDomain,
          sizeof(kControlDomain) - 1U,
          final_control.data(),
          224U,
          &final_control_hash) &&
      Equal(final_control_hash.data(), control_hash.data(), control_hash.size()) &&
      Equal(
          final_control.data() + 224U,
          control_hash.data(),
          control_hash.size()),
      1U);
  final_control_valid = final_control_valid && RecordRevokeControlStep(
      ProtectedPathIsAbsentGuarded(
          state->filesystem, pending_control_path),
      4U);
  final_control_valid = final_control_valid && RecordRevokeControlStep(
      CaptureProtectedObjectIdentity(
          state->filesystem,
          state->filesystem.controls,
          &final_controls_identity) &&
      EqualMoveIdentity(
          final_controls_identity, state->filesystem.controls_identity),
      5U);
  WipeCustodyOwned(final_control.data(), final_control.size());
  WipeCustodyOwned(observed_control.data(), observed_control.size());
  if (!final_control_valid) return ProtectedOperationResult::CustodyOrJournal;

  Byte32 final_state{};
  ProtectedGenerationProjection generation_projection{};
  ProtectedOperationProjection operation_projection{};
  if (!RecordRevokeControlStep(true, 6U)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  ++g_revoke_compute_count;
#endif
  if (!ComputeRevokedState(
          *state,
          request,
          stable_binding,
          *target_generation,
          control_identity,
          control_hash,
          &generation_projection,
          &operation_projection,
          &final_state)) return ProtectedOperationResult::CustodyOrJournal;
  result->fill(0U);
  WriteU16(result->data(), 1U);
  WriteU16(result->data() + 2U, 1U);
  std::memcpy(result->data() + 8U, request.operation_id.data(), 16U);
  WriteU64(result->data() + 24U, request.generation);
  WriteU32(result->data() + 32U, request.reason);
  std::memcpy(result->data() + 40U, request.expected_state_sha256.data(), 32U);
  Copy32(state->state_sha256, result->data() + 72U);
  Copy32(final_state, result->data() + 104U);
  std::memcpy(
      result->data() + 136U,
      target_generation->bytes.data() + 312U,
      32U);
  Copy32(control_hash, result->data() + 168U);
  std::array<std::uint8_t, 432U> outcome_fields{};
  WriteU16(outcome_fields.data(), 2U);
  WriteU16(outcome_fields.data() + 2U, 1U);
  WriteU32(outcome_fields.data() + 4U, kRevokeKeysetResultBytes);
  WriteU32(outcome_fields.data() + 8U, 2U);
  Byte32 control_side_identity{};
  std::array<std::uint8_t, 24U> control_identity_bytes{};
  IdentityBytes(control_identity, control_identity_bytes.data());
  if (!HashDomain(
          kControlIdentityDomain,
          sizeof(kControlIdentityDomain) - 1U,
          control_identity_bytes.data(),
          control_identity_bytes.size(),
          &control_side_identity)) return ProtectedOperationResult::CustodyOrJournal;
  Copy32(control_side_identity, outcome_fields.data() + 16U);
  Copy32(control_hash, outcome_fields.data() + 48U);
  Copy32(final_state, outcome_fields.data() + 80U);
  std::memcpy(outcome_fields.data() + 112U, result->data(), kRevokeKeysetResultBytes);
  JournalRecord outcome{};
  JournalRecord committed{};
  if (!EncodeFollowingJournalRecord(
          JournalRecordKind::Outcome, 0U, prepared, attempt, nullptr,
          outcome_fields.data(), outcome_fields.size(), creation_time,
          state->next_publication_sequence, &outcome) ||
      !PublishJournalRecord(
          state,
          final_operation_path,
          attempt_sequence + 1U,
          L"outcome",
          outcome,
          false,
          nullptr,
          journal_parent.handle,
          journal_parent.identity) ||
      !EncodeFollowingJournalRecord(
          JournalRecordKind::Committed, 0U, prepared, outcome, nullptr,
          outcome_fields.data(), outcome_fields.size(), creation_time,
          state->next_publication_sequence, &committed) ||
      !PublishJournalRecord(
          state,
          final_operation_path,
          attempt_sequence + 2U,
          L"committed",
          committed,
          false,
          nullptr,
          journal_parent.handle,
          journal_parent.identity)) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  if (!CommitGenerationProjection(state, generation_projection) ||
      !CommitProjection(
          &state->operations,
          operation_projection,
          [](const ProtectedOperationProjection& left,
             const ProtectedOperationProjection& right) noexcept {
            return Equal(left.bytes.data(), right.bytes.data(), 16U);
          })) return ProtectedOperationResult::CustodyOrJournal;
  state->state_sha256 = final_state;
  if (target_was_active) {
    state->active_generation = 0U;
    state->active_revoked = true;
  }
  if (!replay_prepared_state &&
      state->operation_id_count >= kMaximumOperationIds) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  if (!replay_prepared_state) ++state->operation_id_count;
  *result_length = kRevokeKeysetResultBytes;
  RememberReplay(
      &state->revoke_replay,
      static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset),
      request.operation_id,
      operator_sid,
      operator_sid_length,
      body,
      static_cast<std::uint16_t>(body_length),
      stable_binding,
      false,
      final_operation_path,
      prepared,
      committed,
      attempt_sequence + 3U,
      *result,
      *result_length);
  return ProtectedOperationResult::Success;
}

}  // namespace

#if defined(GOATCITADEL_PROVISIONER_TESTING)
void SetProtectedRecoveryDuplicateFailureForTest(
    std::uint32_t fail_on_call) noexcept {
  g_recovery_duplicate_fail_on_call = fail_on_call;
  g_recovery_duplicate_call_count = 0U;
}

std::uint32_t ProtectedRecoveryDuplicateCallCountForTest() noexcept {
  return g_recovery_duplicate_call_count;
}

std::uint32_t ProtectedPreparedPublicationStageForTest() noexcept {
  return g_prepared_publication_stage;
}

std::uint32_t ProtectedPreparedPublicationErrorForTest() noexcept {
  return g_prepared_publication_error;
}

void SetProtectedDirectoryMoveFailureForTest(
    std::uint32_t fail_after_stage) noexcept {
  g_directory_move_fail_after_stage = fail_after_stage;
  g_directory_move_stage = 0U;
  g_directory_move_error = ERROR_SUCCESS;
}

std::uint32_t ProtectedDirectoryMoveStageForTest() noexcept {
  return g_directory_move_stage;
}

std::uint32_t ProtectedDirectoryMoveErrorForTest() noexcept {
  return g_directory_move_error;
}

void SetProtectedJournalPublicationFailureForTest(
    std::uint32_t fail_on_ordinary_call,
    std::uint32_t fail_after_stage) noexcept {
  g_journal_publication_fail_on_ordinary_call = fail_on_ordinary_call;
  g_journal_publication_fail_after_stage = fail_after_stage;
  g_journal_publication_ordinary_call_count = 0U;
  g_journal_publication_stage = 0U;
  g_journal_publication_error = ERROR_SUCCESS;
  g_journal_publication_failure_active = false;
  g_create_recovery_stage = 0U;
  g_create_recovery_call_count = 0U;
  g_create_recovery_last_mode = 0U;
  g_revoke_recovery_stage = 0U;
  g_phase_b_nonterminal_revalidation_stage = 0U;
}

std::uint32_t ProtectedJournalPublicationStageForTest() noexcept {
  return g_journal_publication_stage;
}

std::uint32_t ProtectedJournalPublicationErrorForTest() noexcept {
  return g_journal_publication_error;
}

std::uint32_t ProtectedJournalPublicationOrdinaryCallCountForTest() noexcept {
  return g_journal_publication_ordinary_call_count;
}

void SetProtectedRevokeControlFailureForTest(
    std::uint32_t fail_after_stage) noexcept {
  g_revoke_control_fail_after_stage = fail_after_stage;
  g_revoke_control_stage = 0U;
  g_revoke_control_error = ERROR_SUCCESS;
  g_revoke_compute_count = 0U;
  g_revoke_recovery_stage = 0U;
}

std::uint32_t ProtectedRevokeControlStageForTest() noexcept {
  return g_revoke_control_stage;
}

std::uint32_t ProtectedRevokeControlErrorForTest() noexcept {
  return g_revoke_control_error;
}

std::uint32_t ProtectedRevokeComputeCountForTest() noexcept {
  return g_revoke_compute_count;
}

std::uint32_t ProtectedCreateRecoveryStageForTest() noexcept {
  return g_create_recovery_stage;
}

std::uint32_t ProtectedCreateRecoveryCallCountForTest() noexcept {
  return g_create_recovery_call_count;
}

std::uint32_t ProtectedCreateRecoveryLastModeForTest() noexcept {
  return g_create_recovery_last_mode;
}

std::uint32_t ProtectedRevokeRecoveryStageForTest() noexcept {
  return g_revoke_recovery_stage;
}

std::uint32_t ProtectedPhaseBNonterminalRevalidationStageForTest() noexcept {
  return g_phase_b_nonterminal_revalidation_stage;
}

bool MoveProtectedDirectoryToQuarantineForTest(
    ProtectedOperationsState* state,
    const wchar_t* source_component,
    const wchar_t* final_component) noexcept {
  if (state == nullptr || !state->filesystem.ready || source_component == nullptr ||
      final_component == nullptr) return false;
  ProtectedPath source_path{};
  ProtectedPath final_path{};
  HANDLE source_directory = nullptr;
  ProtectedObjectIdentity source_identity{};
  DirectoryMoveAuthority& authority = g_directory_move_authority_scratch;
  bool moved = ComposeProtectedChildPath(
                   state->filesystem.journal_path,
                   source_component,
                   &source_path) &&
      ComposeProtectedChildPath(
          state->filesystem.quarantine_path,
          final_component,
          &final_path) &&
      OpenProtectedExistingDirectory(
          state->filesystem,
          source_path,
          true,
          &source_directory,
          &source_identity) &&
      CaptureDirectoryMoveAuthority(
          state->filesystem, source_path, source_directory, &authority) &&
      EqualMoveIdentity(source_identity, authority.root_identity) &&
      MoveDirectoryWithCapturedAuthority(
          state->filesystem,
          source_path,
          final_path,
          &source_directory,
          authority);
  if (source_directory != nullptr && source_directory != INVALID_HANDLE_VALUE) {
    CloseHandle(source_directory);
  }
  WipeCustodyOwned(&authority, sizeof(authority));
  return moved;
}

bool DuplicateProtectedRecoveryFilesystemForTest(
    const ProtectedFilesystemState& source,
    ProtectedFilesystemState* destination) noexcept {
  return DuplicateRecoveryFilesystem(source, destination);
}

void CloseProtectedRecoveryFilesystemForTest(
    ProtectedFilesystemState* filesystem) noexcept {
  CloseRecoveryFilesystem(filesystem);
}
#endif

static bool InitializeProtectedOperationsOnce(
    const wchar_t* extended_volume_root,
    std::size_t extended_volume_root_length,
    ProtectedOperationsState* state,
    std::uint64_t recovery_deadline_ms,
    HANDLE recovery_stop_event,
    bool* restart_required) noexcept {
  if (state == nullptr || restart_required == nullptr) return false;
  *restart_required = false;
  PhaseAReplayScratchGuard phase_a_scratch_guard{};
  const auto recovery_checkpoint = [&]() noexcept -> bool {
    if (recovery_deadline_ms == 0U) return true;
    return recovery_stop_event != nullptr &&
           recovery_stop_event != INVALID_HANDLE_VALUE &&
           WaitForSingleObject(recovery_stop_event, 0U) == WAIT_TIMEOUT &&
           GetTickCount64() < recovery_deadline_ms;
  };
  if (!recovery_checkpoint()) return false;
  CloseProtectedOperations(state);
  if (!OpenProtectedFilesystem(
          extended_volume_root, extended_volume_root_length, &state->filesystem)) {
    return false;
  }
  ConfigureProtectedFilesystemRecoveryGuard(
      &state->filesystem, recovery_deadline_ms, recovery_stop_event);
  if (!ProtectedFilesystemRecoveryCheckpoint(state->filesystem)) {
    CloseProtectedOperations(state);
    return false;
  }
  std::size_t journal_count = 0U;
  std::size_t quarantine_count = 0U;
  std::size_t keyset_count = 0U;
  std::size_t control_count = 0U;
  if (!EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.journal, &g_root_scan_entries, &journal_count) ||
      journal_count > 33U ||
      !EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.keysets, &g_recovery_entries, &keyset_count) ||
      keyset_count > kMaximumBurnedGenerations ||
      !EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.controls, &g_recovery_entries, &control_count) ||
      control_count > kMaximumBurnedGenerations ||
      !EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.quarantine, &g_quarantine_scan_entries, &quarantine_count) ||
      quarantine_count > kMaximumProtectedDirectoryEntries) {
    CloseProtectedOperations(state);
    return false;
  }
  if (!recovery_checkpoint()) {
    CloseProtectedOperations(state);
    return false;
  }
  g_publication_sequences.fill(false);
  g_deferred_residues.fill(ProtectedResidueProjection{});
  g_deferred_residue_operations.fill(ProtectedOperationProjection{});
  g_deferred_residue_committed.fill(false);
  WipeCustodyOwned(
      g_publication_events.data(), sizeof(g_publication_events));
  WipeCustodyOwned(
      g_phase_a_operations.data(), sizeof(g_phase_a_operations));
  g_phase_a_operation_count = 0U;
  g_phase_a_keyset_count = 0U;
  g_phase_a_control_count = 0U;
  g_residue_metadata_scratch.fill(ResidueMetadataInventory{});
  std::size_t residue_metadata_count = 0U;
  std::uint64_t residue_metadata_total_bytes = 0U;
  for (std::size_t index = 0U; index < quarantine_count; ++index) {
    Byte16 operation_id{};
    if (ParseOperationComponent(
            g_quarantine_scan_entries[index], &operation_id)) continue;
    std::uint8_t ordinal = 0U;
    std::uint16_t publication_sequence = 0U;
    std::uint8_t kind = 0U;
    if (residue_metadata_count >= kMaximumResidues ||
        !ParseResidueComponent(
            g_quarantine_scan_entries[index],
            &operation_id,
            &ordinal,
            &publication_sequence,
            &kind) ||
        ordinal >= 8U || publication_sequence == 0U ||
        publication_sequence > kMaximumPublicationSequence) {
      CloseProtectedOperations(state);
      return false;
    }
    std::uint64_t metadata_bytes = 0U;
    if (kind == 1U) {
      if ((g_quarantine_scan_entries[index].attributes &
           FILE_ATTRIBUTE_DIRECTORY) == 0U ||
          (g_quarantine_scan_entries[index].attributes &
           ~FILE_ATTRIBUTE_DIRECTORY) != 0U) {
        CloseProtectedOperations(state);
        return false;
      }
      ProtectedPath residue_path{};
      HANDLE residue_directory = nullptr;
      ProtectedObjectIdentity residue_identity{};
      std::size_t child_count = 0U;
      bool metadata_valid = ComposeProtectedChildPath(
                                state->filesystem.quarantine_path,
                                g_quarantine_scan_entries[index].name.data(),
                                &residue_path) &&
          OpenProtectedExistingDirectory(
              state->filesystem,
              residue_path,
              false,
              &residue_directory,
              &residue_identity) &&
          EnumerateProtectedDirectory(
              state->filesystem,
              residue_directory,
              &g_recovery_entries,
              &child_count) &&
          child_count <= 1U;
      if (metadata_valid && child_count == 1U) {
        metadata_valid = EqualWide(
                             g_recovery_entries[0].name.data(),
                             g_recovery_entries[0].name_length,
                             L".s00000000-prepared.pending") &&
            (g_recovery_entries[0].attributes &
             FILE_ATTRIBUTE_DIRECTORY) == 0U &&
            g_recovery_entries[0].byte_length <= 1023U;
        metadata_bytes = g_recovery_entries[0].byte_length;
      }
      if (residue_directory != nullptr &&
          residue_directory != INVALID_HANDLE_VALUE) {
        CloseHandle(residue_directory);
      }
      if (!metadata_valid) {
        CloseProtectedOperations(state);
        return false;
      }
    } else if (kind == 2U || kind == 3U) {
      const std::uint64_t maximum_bytes = kind == 2U ? 1023U : 255U;
      if ((g_quarantine_scan_entries[index].attributes &
           FILE_ATTRIBUTE_DIRECTORY) != 0U ||
          g_quarantine_scan_entries[index].byte_length > maximum_bytes) {
        CloseProtectedOperations(state);
        return false;
      }
      metadata_bytes = g_quarantine_scan_entries[index].byte_length;
    } else {
      CloseProtectedOperations(state);
      return false;
    }
    std::size_t same_operation_count = 0U;
    std::uint64_t same_operation_bytes = 0U;
    bool duplicate_ordinal = false;
    bool bootstrap_present = false;
    for (std::size_t prior = 0U; prior < residue_metadata_count; ++prior) {
      const ResidueMetadataInventory& existing =
          g_residue_metadata_scratch[prior];
      if (!existing.present || existing.operation_id != operation_id) continue;
      ++same_operation_count;
      same_operation_bytes += existing.byte_length;
      duplicate_ordinal = duplicate_ordinal || existing.ordinal == ordinal;
      bootstrap_present = bootstrap_present || existing.kind == 1U;
    }
    if (duplicate_ordinal || same_operation_count >= 8U ||
        (kind == 1U && same_operation_count != 0U) ||
        (kind != 1U && bootstrap_present) ||
        UINT64_MAX - same_operation_bytes < metadata_bytes ||
        same_operation_bytes + metadata_bytes > 8184U ||
        UINT64_MAX - residue_metadata_total_bytes < metadata_bytes ||
        residue_metadata_total_bytes + metadata_bytes > 261888U) {
      CloseProtectedOperations(state);
      return false;
    }
    ResidueMetadataInventory& metadata =
        g_residue_metadata_scratch[residue_metadata_count++];
    metadata.present = true;
    metadata.operation_id = operation_id;
    metadata.ordinal = ordinal;
    metadata.kind = kind;
    metadata.publication_sequence = publication_sequence;
    metadata.byte_length = metadata_bytes;
    residue_metadata_total_bytes += metadata_bytes;
  }
  std::size_t publication_count = 0U;
  PendingNormalizationSource pending_source{};
  std::size_t pending_source_count = 0U;
  std::array<Byte16, 33U> physical_operation_ids{};
  std::size_t physical_operation_id_count = 0U;
  for (std::size_t index = 0U; index < journal_count; ++index) {
    if (!recovery_checkpoint()) {
      CloseProtectedOperations(state);
      return false;
    }
    Byte16 operation_id{};
    const bool pending_operation = ParsePendingOperationComponent(
        g_root_scan_entries[index], &operation_id);
    const bool final_operation = pending_operation ||
        ParseOperationComponent(g_root_scan_entries[index], &operation_id);
    bool duplicate_operation_id = false;
    for (std::size_t prior = 0U; prior < physical_operation_id_count; ++prior) {
      duplicate_operation_id = duplicate_operation_id ||
          physical_operation_ids[prior] == operation_id;
    }
    if (!final_operation || duplicate_operation_id ||
        physical_operation_id_count >= 32U ||
        !InventoryOperationPublications(
            state,
            state->filesystem.journal_path,
            g_root_scan_entries[index],
            false,
            pending_operation,
            &publication_count,
            &pending_source,
            &pending_source_count)) {
      CloseProtectedOperations(state);
      return false;
    }
    physical_operation_ids[physical_operation_id_count++] = operation_id;
  }
  std::size_t revalidated_quarantine_count = 0U;
  if (!EnumerateProtectedDirectory(
          state->filesystem,
          state->filesystem.quarantine,
          &g_recovery_entries,
          &revalidated_quarantine_count) ||
      revalidated_quarantine_count != quarantine_count) {
    CloseProtectedOperations(state);
    return false;
  }
  for (std::size_t index = 0U; index < quarantine_count; ++index) {
    if (g_recovery_entries[index].name_length !=
            g_quarantine_scan_entries[index].name_length ||
        !EqualWide(
            g_recovery_entries[index].name.data(),
            g_recovery_entries[index].name_length,
            g_quarantine_scan_entries[index].name.data()) ||
        g_recovery_entries[index].attributes !=
            g_quarantine_scan_entries[index].attributes ||
        g_recovery_entries[index].byte_length !=
            g_quarantine_scan_entries[index].byte_length) {
      CloseProtectedOperations(state);
      return false;
    }
  }
  std::size_t quarantine_operation_count = 0U;
  std::uint64_t residue_bytes = 0U;
  std::size_t deferred_residue_count = 0U;
  for (std::size_t index = 0U; index < quarantine_count; ++index) {
    if (!recovery_checkpoint()) {
      CloseProtectedOperations(state);
      return false;
    }
    Byte16 operation_id{};
    if (ParseOperationComponent(
            g_quarantine_scan_entries[index], &operation_id)) {
      bool duplicate_operation_id = false;
      for (std::size_t prior = 0U; prior < physical_operation_id_count; ++prior) {
        duplicate_operation_id = duplicate_operation_id ||
            physical_operation_ids[prior] == operation_id;
      }
      if (duplicate_operation_id || physical_operation_id_count >= 32U ||
          !InventoryOperationPublications(
              state,
              state->filesystem.quarantine_path,
              g_quarantine_scan_entries[index],
              true,
              false,
              &publication_count,
              &pending_source,
              &pending_source_count)) {
        CloseProtectedOperations(state);
        return false;
      }
      physical_operation_ids[physical_operation_id_count++] = operation_id;
      if (quarantine_operation_count != index) {
        g_quarantine_scan_entries[quarantine_operation_count] =
            g_quarantine_scan_entries[index];
      }
      ++quarantine_operation_count;
      continue;
    }
    ProtectedResidueProjection residue{};
    ProtectedOperationProjection bootstrap_operation{};
    Byte16 metadata_operation_id{};
    std::uint8_t metadata_ordinal = 0U;
    std::uint16_t metadata_publication_sequence = 0U;
    std::uint8_t metadata_kind = 0U;
    const ResidueMetadataInventory* expected_metadata = nullptr;
    if (ParseResidueComponent(
            g_quarantine_scan_entries[index],
            &metadata_operation_id,
            &metadata_ordinal,
            &metadata_publication_sequence,
            &metadata_kind)) {
      for (std::size_t metadata_index = 0U;
           metadata_index < residue_metadata_count;
           ++metadata_index) {
        const ResidueMetadataInventory& candidate =
            g_residue_metadata_scratch[metadata_index];
        if (candidate.present &&
            candidate.operation_id == metadata_operation_id &&
            candidate.ordinal == metadata_ordinal &&
            candidate.publication_sequence == metadata_publication_sequence &&
            candidate.kind == metadata_kind) {
          if (expected_metadata != nullptr) {
            CloseProtectedOperations(state);
            return false;
          }
          expected_metadata = &candidate;
        }
      }
    }
    if (expected_metadata == nullptr ||
        deferred_residue_count >= kMaximumResidues ||
        !RecoverResidueProjection(
            state->filesystem,
            g_quarantine_scan_entries[index],
            &residue,
            &bootstrap_operation) ||
        !residue.present ||
        !Equal(
            residue.bytes.data(),
            expected_metadata->operation_id.data(),
            expected_metadata->operation_id.size()) ||
        residue.bytes[16] != expected_metadata->ordinal ||
        residue.bytes[17] != expected_metadata->kind ||
        ReadU16(residue.bytes.data() + 18U) !=
            expected_metadata->publication_sequence ||
        ReadU64(residue.bytes.data() + 20U) !=
            expected_metadata->byte_length) {
      CloseProtectedOperations(state);
      return false;
    }
    Byte16 residue_operation_id{};
    std::memcpy(
        residue_operation_id.data(),
        residue.bytes.data(),
        residue_operation_id.size());
    const RecoveryPublicationEventKind residue_event_kind =
        residue.bytes[17] == 1U
            ? RecoveryPublicationEventKind::BootstrapResidue
            : residue.bytes[17] == 2U
                ? RecoveryPublicationEventKind::JournalResidue
                : residue.bytes[17] == 3U
                    ? RecoveryPublicationEventKind::RevokeResidue
                    : RecoveryPublicationEventKind::None;
    if (!RegisterPublicationSequence(
            ReadU16(residue.bytes.data() + 18U), &publication_count) ||
        !RegisterPublicationEvent(
            ReadU16(residue.bytes.data() + 18U),
            residue_operation_id,
            residue_event_kind,
            0U,
            residue.bytes[16])) {
      CloseProtectedOperations(state);
      return false;
    }
    g_deferred_residues[deferred_residue_count] = residue;
    g_deferred_residue_operations[deferred_residue_count] = bootstrap_operation;
    ++deferred_residue_count;
    residue_bytes += ReadU64(residue.bytes.data() + 20U);
    if (residue_bytes > 261888U) {
      CloseProtectedOperations(state);
      return false;
    }
  }
  quarantine_count = quarantine_operation_count;
  if (!FinalizePublicationSequenceInventory(
          publication_count, &state->next_publication_sequence)) {
    CloseProtectedOperations(state);
    return false;
  }
  for (std::size_t outer = 0U; outer < g_deferred_residues.size(); ++outer) {
    if (!recovery_checkpoint()) {
      CloseProtectedOperations(state);
      return false;
    }
    if (!g_deferred_residues[outer].present) continue;
    bool earlier_same_id = false;
    for (std::size_t prior = 0U; prior < outer; ++prior) {
      earlier_same_id = earlier_same_id ||
          (g_deferred_residues[prior].present &&
           Equal(
               g_deferred_residues[prior].bytes.data(),
               g_deferred_residues[outer].bytes.data(),
               16U));
    }
    if (earlier_same_id) continue;
    std::array<bool, 8U> ordinals{};
    std::array<std::uint16_t, 8U> ordinal_publication_sequences{};
    std::size_t object_count = 0U;
    std::size_t bootstrap_count = 0U;
    std::uint64_t operation_bytes = 0U;
    for (const ProtectedResidueProjection& candidate : g_deferred_residues) {
      if (!candidate.present ||
          !Equal(
              candidate.bytes.data(),
               g_deferred_residues[outer].bytes.data(),
              16U)) continue;
      const std::uint8_t ordinal = candidate.bytes[16];
      if (ordinal >= ordinals.size() || ordinals[ordinal]) {
        CloseProtectedOperations(state);
        return false;
      }
      ordinals[ordinal] = true;
      ordinal_publication_sequences[ordinal] =
          ReadU16(candidate.bytes.data() + 18U);
      ++object_count;
      if (candidate.bytes[17] == 1U) ++bootstrap_count;
      operation_bytes += ReadU64(candidate.bytes.data() + 20U);
    }
    bool operation_directory_present = false;
    Byte16 parsed_operation_id{};
    for (std::size_t index = 0U; index < journal_count; ++index) {
      if ((ParseOperationComponent(
               g_root_scan_entries[index], &parsed_operation_id) ||
           ParsePendingOperationComponent(
               g_root_scan_entries[index], &parsed_operation_id)) &&
          Equal(
              parsed_operation_id.data(),
              g_deferred_residues[outer].bytes.data(),
              parsed_operation_id.size())) {
        operation_directory_present = true;
      }
    }
    for (std::size_t index = 0U; index < quarantine_count; ++index) {
      if (ParseOperationComponent(
              g_quarantine_scan_entries[index], &parsed_operation_id) &&
          Equal(
              parsed_operation_id.data(),
              g_deferred_residues[outer].bytes.data(),
              parsed_operation_id.size())) {
        operation_directory_present = true;
      }
    }
    if (object_count > 8U || bootstrap_count > 1U ||
        (bootstrap_count != 0U &&
         (object_count != 1U || operation_directory_present)) ||
        (bootstrap_count == 0U && !operation_directory_present) ||
        operation_bytes > 8184U) {
      CloseProtectedOperations(state);
      return false;
    }
    for (std::size_t ordinal = 0U; ordinal < object_count; ++ordinal) {
      if (!ordinals[ordinal] ||
          (ordinal != 0U &&
           ordinal_publication_sequences[ordinal - 1U] >=
               ordinal_publication_sequences[ordinal])) {
        CloseProtectedOperations(state);
        return false;
      }
    }
  }
  WipeCustodyOwned(
      &g_replay_phase_a_scratch, sizeof(g_replay_phase_a_scratch));
  ProtectedRecoveryReplayOutput& phase_a_replay = g_replay_phase_a_scratch;
  RecoveryPublicationEvent provisional_event{};
  ProtectedResidueProjection provisional_residue{};
  ProtectedOperationProjection provisional_operation{};
  if (!ValidateRecoveryPublicationEvents(
          g_publication_events.data() + 1U, publication_count) ||
      !ValidatePhaseAExternalTopology(
          state, keyset_count, control_count)) {
    CloseProtectedOperations(state);
    return false;
  }
  if (pending_source_count != 0U &&
      !ValidatePendingNormalizationChronology(
          state,
          pending_source,
          publication_count,
          &provisional_event,
          &provisional_residue,
          &provisional_operation)) {
    ClosePendingNormalizationAuthority(&pending_source.authority);
    CloseProtectedOperations(state);
    return false;
  }
  if (!ValidatePhaseACanonicalReplay(
          state,
          publication_count,
          pending_source_count == 0U ? nullptr : &provisional_event,
          pending_source_count == 0U || !provisional_residue.present
              ? nullptr
              : &provisional_residue,
          pending_source_count == 0U || !provisional_operation.present
              ? nullptr
              : &provisional_operation,
          &phase_a_replay)) {
    ClosePendingNormalizationAuthority(&pending_source.authority);
    CloseProtectedOperations(state);
    return false;
  }
  if (pending_source_count != 0U) {
    const bool normalized = NormalizePendingSource(
        state,
        pending_source,
        provisional_residue.present ? &provisional_residue : nullptr);
    ClosePendingNormalizationAuthority(&pending_source.authority);
    if (!normalized) {
      CloseProtectedOperations(state);
      return false;
    }
    CloseProtectedOperations(state);
    *restart_required = true;
    return true;
  }
  const auto restart_after_recovery = [&]() noexcept -> bool {
    CloseProtectedOperations(state);
    *restart_required = true;
    return true;
  };
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (g_recovery_phase_b_hook != nullptr) {
    const ProtectedRecoveryPhaseBHookForTest hook = g_recovery_phase_b_hook;
    g_recovery_phase_b_hook = nullptr;
    hook();
  }
  g_phase_b_nonterminal_revalidation_stage = 100U;
#endif
  CopyRecoveryProjectionState(phase_a_replay.projection, state);
  state->next_publication_sequence =
      static_cast<std::uint16_t>(publication_count + 1U);
  for (std::size_t residue_index = 0U;
       residue_index < deferred_residue_count;
       ++residue_index) {
    if (g_deferred_residues[residue_index].present &&
        g_deferred_residues[residue_index].bytes[17] == 1U &&
        !CompleteFinalBootstrapResidueDirectory(
            state,
            g_deferred_residues[residue_index],
            g_deferred_residue_operations[residue_index])) {
      CloseProtectedOperations(state);
      return false;
    }
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 101U;
#endif
  if (!phase_a_replay.nonterminal_present) {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 102U;
#endif
    for (std::size_t operation_index = 0U;
         operation_index < phase_a_replay.operation_count;
         ++operation_index) {
      const RecoveryReplayOperation& replay_operation =
          phase_a_replay.operations[operation_index];
      if (!replay_operation.present ||
          replay_operation.lifecycle !=
              RecoveryReplayLifecycle::Quarantined ||
          replay_operation.inventory_index >= g_phase_a_operation_count) {
        continue;
      }
      const PhaseAOperationInventory& inventory =
          g_phase_a_operations[replay_operation.inventory_index];
      if (inventory.quarantine_location) {
        RecoveredJournalOperation terminal{};
        RecoveredJournalOperation revalidated{};
        HANDLE final_directory = nullptr;
        ProtectedObjectIdentity final_identity{};
        ProtectedPath source_path{};
        DirectoryMoveAuthority& move_authority =
            g_directory_move_authority_scratch;
        bool completed = LoadRecoveredReplayOperation(
                             state, inventory, &terminal) &&
            terminal.quarantined && !terminal.committed &&
            terminal.operation_id == replay_operation.operation_id &&
            terminal.next_sequence == inventory.record_count &&
            terminal.candidate_present == replay_operation.candidate_present &&
            (!terminal.candidate_present ||
             (EqualMoveIdentity(
                  terminal.candidate_identity,
                  replay_operation.candidate_identity) &&
              Equal(
                  terminal.candidate_closure.data(),
                  replay_operation.candidate_closure.data(),
                  terminal.candidate_closure.size()))) &&
            ComposeProtectedChildPath(
                state->filesystem.journal_path,
                inventory.root_entry.name.data(),
                &source_path) &&
            ProtectedPathIsAbsentGuarded(state->filesystem, source_path) &&
            OpenProtectedExistingDirectory(
                state->filesystem,
                inventory.path,
                true,
                &final_directory,
                &final_identity) &&
            CaptureDirectoryMoveAuthority(
                state->filesystem,
                inventory.path,
                final_directory,
                &move_authority) &&
            EqualMoveIdentity(final_identity, move_authority.root_identity) &&
            CompleteCapturedDirectoryAtFinal(
                state->filesystem,
                inventory.path,
                &final_directory,
                move_authority) &&
            LoadRecoveredReplayOperation(state, inventory, &revalidated) &&
            revalidated.quarantined && !revalidated.committed &&
            revalidated.operation_id == terminal.operation_id &&
            revalidated.next_sequence == terminal.next_sequence &&
            revalidated.candidate_present == terminal.candidate_present &&
            Equal(
                revalidated.prior.bytes.data(),
                terminal.prior.bytes.data(),
                revalidated.prior.bytes.size()) &&
            (!terminal.candidate_present ||
             (EqualMoveIdentity(
                  revalidated.candidate_identity,
                  terminal.candidate_identity) &&
              Equal(
                  revalidated.candidate_closure.data(),
                  terminal.candidate_closure.data(),
                  revalidated.candidate_closure.size())));
        if (final_directory != nullptr &&
            final_directory != INVALID_HANDLE_VALUE) CloseHandle(final_directory);
        WipeCustodyOwned(&move_authority, sizeof(move_authority));
        if (!completed) {
          CloseProtectedOperations(state);
          return false;
        }
        continue;
      }
      RecoveredJournalOperation terminal{};
      HANDLE source_directory = nullptr;
      HANDLE final_directory = nullptr;
      ProtectedObjectIdentity source_identity{};
      ProtectedObjectIdentity final_identity{};
      std::size_t source_entry_count = 0U;
      std::size_t final_entry_count = 0U;
      std::array<wchar_t, 48U> component{};
      ProtectedPath final_path{};
      RecoveryEffectClass terminal_effect = RecoveryEffectClass::Absent;
      DirectoryMoveAuthority& move_authority =
          g_directory_move_authority_scratch;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      ++g_recovery_evidence.phase_b_revalidation_count;
#endif
      bool moved = LoadRecoveredReplayOperation(state, inventory, &terminal) &&
          terminal.quarantined && !terminal.committed &&
          terminal.operation_id == replay_operation.operation_id &&
          terminal.next_sequence == inventory.record_count &&
          ClassifyReplayPhysicalEffect(
              state, inventory, terminal, &terminal_effect) &&
          terminal_effect == replay_operation.physical_effect &&
          terminal.candidate_present == replay_operation.candidate_present &&
          (!terminal.candidate_present ||
           (terminal.candidate_identity.volume_serial_number ==
                replay_operation.candidate_identity.volume_serial_number &&
            Equal(
                terminal.candidate_identity.file_id.data(),
                replay_operation.candidate_identity.file_id.data(),
                terminal.candidate_identity.file_id.size()) &&
            inventory.candidate_entry.byte_length ==
                replay_operation.candidate_length &&
            Equal(
                terminal.candidate_closure.data(),
                replay_operation.candidate_closure.data(),
                terminal.candidate_closure.size()))) &&
          Equal(
              terminal.prior.bytes.data(),
              inventory.records[inventory.record_count - 1U].bytes.data(),
              terminal.prior.bytes.size()) &&
          OpenProtectedExistingDirectory(
              state->filesystem,
              inventory.path,
              true,
              &source_directory,
              &source_identity) &&
          EnumerateProtectedDirectory(
              state->filesystem,
              source_directory,
              &g_recovery_entries,
              &source_entry_count) &&
          source_entry_count == inventory.record_count +
              (inventory.candidate_present ? 1U : 0U) &&
          CaptureDirectoryMoveAuthority(
              state->filesystem,
              inventory.path,
              source_directory,
              &move_authority) &&
          EqualMoveIdentity(move_authority.root_identity, source_identity) &&
          BuildOperationComponent(
              inventory.operation_id, false, &component) &&
          ComposeProtectedChildPath(
              state->filesystem.quarantine_path,
              component.data(),
              &final_path) &&
#if defined(GOATCITADEL_PROVISIONER_TESTING)
          (++g_recovery_evidence.phase_b_mutation_count, false) ||
#endif
          MoveDirectoryWithCapturedAuthority(
              state->filesystem,
              inventory.path,
              final_path,
              &source_directory,
              move_authority);
      if (source_directory != nullptr &&
          source_directory != INVALID_HANDLE_VALUE) CloseHandle(source_directory);
      if (moved) {
        moved = OpenProtectedExistingDirectory(
                    state->filesystem,
                    final_path,
                    false,
                    &final_directory,
                    &final_identity) &&
            final_identity.volume_serial_number ==
                source_identity.volume_serial_number &&
            Equal(
                final_identity.file_id.data(),
                source_identity.file_id.data(),
                final_identity.file_id.size()) &&
            EnumerateProtectedDirectory(
                state->filesystem,
                final_directory,
                &g_recovery_entries,
                &final_entry_count) &&
            final_entry_count == source_entry_count &&
            ProtectedPathIsAbsentGuarded(
                state->filesystem, inventory.path);
      }
      if (final_directory != nullptr &&
          final_directory != INVALID_HANDLE_VALUE) CloseHandle(final_directory);
      WipeCustodyOwned(&move_authority, sizeof(move_authority));
      if (moved) {
        WipeCustodyOwned(
            &g_relocated_phase_a_scratch,
            sizeof(g_relocated_phase_a_scratch));
        PhaseAOperationInventory& relocated_inventory =
            g_relocated_phase_a_scratch;
        std::memcpy(
            &relocated_inventory, &inventory, sizeof(relocated_inventory));
        relocated_inventory.quarantine_location = true;
        relocated_inventory.path = final_path;
        RecoveredJournalOperation relocated{};
        moved = LoadRecoveredReplayOperation(
                    state, relocated_inventory, &relocated) &&
            relocated.quarantined &&
            relocated.operation_id == terminal.operation_id &&
            relocated.next_sequence == terminal.next_sequence &&
            relocated.candidate_present == terminal.candidate_present &&
            Equal(
                relocated.prior.bytes.data(),
                terminal.prior.bytes.data(),
                relocated.prior.bytes.size()) &&
            (!terminal.candidate_present ||
             (relocated.candidate_identity.volume_serial_number ==
                  terminal.candidate_identity.volume_serial_number &&
              Equal(
                  relocated.candidate_identity.file_id.data(),
                  terminal.candidate_identity.file_id.data(),
                  relocated.candidate_identity.file_id.size()) &&
              Equal(
                  relocated.candidate_closure.data(),
                  terminal.candidate_closure.data(),
                  relocated.candidate_closure.size())));
      }
      WipeCustodyOwned(
          &g_relocated_phase_a_scratch,
          sizeof(g_relocated_phase_a_scratch));
      if (!moved) {
        CloseProtectedOperations(state);
        return false;
      }
      return restart_after_recovery();
    }
    Byte32 rebuilt_state{};
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 103U;
#endif
    if (!recovery_checkpoint() ||
        !BuildCanonicalState(
            *state, nullptr, nullptr, nullptr, &rebuilt_state) ||
        !Equal(
            rebuilt_state.data(),
            state->state_sha256.data(),
            rebuilt_state.size())) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 104U;
#endif
    ConfigureProtectedFilesystemRecoveryGuard(&state->filesystem, 0U, nullptr);
    state->ready = true;
    return true;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 105U;
#endif
  if (!phase_a_replay.nonterminal_base_present ||
      phase_a_replay.nonterminal_inventory_index >=
          g_phase_a_operation_count) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 106U;
#endif
  CopyRecoveryProjectionState(
      phase_a_replay.nonterminal_base_projection, state);
  state->next_publication_sequence =
      static_cast<std::uint16_t>(publication_count + 1U);
  const PhaseAOperationInventory& nonterminal_inventory =
      g_phase_a_operations[phase_a_replay.nonterminal_inventory_index];
  const RecoveryReplayOperation* expected_replay_operation = nullptr;
  for (std::size_t index = 0U; index < phase_a_replay.operation_count; ++index) {
    if (phase_a_replay.operations[index].present &&
        phase_a_replay.operations[index].operation_id ==
            nonterminal_inventory.operation_id) {
      if (expected_replay_operation != nullptr) {
        CloseProtectedOperations(state);
        return false;
      }
      expected_replay_operation = &phase_a_replay.operations[index];
    }
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 107U;
#endif
  RecoveredJournalOperation recovered{};
  RecoveryEffectClass revalidated_effect = RecoveryEffectClass::Absent;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  ++g_recovery_evidence.phase_b_revalidation_count;
#endif
  if (expected_replay_operation == nullptr) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 1U;
#endif
  if (!ValidatePhaseAExternalTopology(state, keyset_count, control_count)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 2U;
#endif
  if (!LoadRecoveredReplayOperation(
          state, nonterminal_inventory, &recovered)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 3U;
#endif
  if (!ClassifyReplayPhysicalEffect(
          state,
          nonterminal_inventory,
          recovered,
          &revalidated_effect)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 4U;
#endif
  if (revalidated_effect != expected_replay_operation->physical_effect) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 5U;
#endif
  if (recovered.candidate_present !=
      expected_replay_operation->candidate_present) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 6U;
#endif
  if (recovered.attempt_count != expected_replay_operation->attempt_count) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 7U;
#endif
  if (!Equal(
          recovered.prepared.bytes.data(),
          nonterminal_inventory.prepared.bytes.data(),
          recovered.prepared.bytes.size())) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 8U;
#endif
  if (recovered.next_sequence != nonterminal_inventory.record_count) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 9U;
#endif
  if (recovered.candidate_present) {
    const std::uint64_t revalidated_length = recovered.opcode ==
            static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)
        ? recovered.candidate_length
        : nonterminal_inventory.candidate_entry.byte_length;
    Byte32 revalidated_hash{};
    if (revalidated_length != expected_replay_operation->candidate_length ||
        recovered.candidate_identity.volume_serial_number !=
            expected_replay_operation->candidate_identity.volume_serial_number ||
        !Equal(
            recovered.candidate_identity.file_id.data(),
            expected_replay_operation->candidate_identity.file_id.data(),
            recovered.candidate_identity.file_id.size()) ||
        !Equal(
            recovered.candidate_closure.data(),
            expected_replay_operation->candidate_closure.data(),
            recovered.candidate_closure.size()) ||
        (recovered.opcode ==
             static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset) &&
         (!ComputeSha256(
              recovered.candidate_bytes.data(),
              recovered.candidate_length,
              &revalidated_hash) ||
          !Equal(
              revalidated_hash.data(),
              expected_replay_operation->candidate_content_hash.data(),
              revalidated_hash.size())))) {
      CloseProtectedOperations(state);
      return false;
    }
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 10U;
#endif
  const RecoveryAction action = phase_a_replay.nonterminal_action;
  if (action == RecoveryAction::RejectPreserve ||
      action == RecoveryAction::StableTerminal) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 11U;
#endif
  if (recovered.attempt_count == 0U &&
      !CompleteFinalPreparedOperationDirectory(state, recovered)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 12U;
#endif
  const std::uint16_t body_length =
      ReadU16(recovered.prepared.bytes.data() + 38U);
  const std::uint16_t sid_length =
      ReadU16(recovered.prepared.bytes.data() + 36U);
  Byte32 authenticated_binding{};
  std::memcpy(
      authenticated_binding.data(),
      recovered.prepared.bytes.data() + 336U,
      authenticated_binding.size());
  if (recovered.opcode ==
      static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    CreateKeysetRequest request{};
    if (!DecodeCreateKeysetRequest(
            recovered.prepared.bytes.data() + 112U,
            body_length,
            &request)) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 13U;
#endif
    if (action == RecoveryAction::EnsureEmptyCreateThenEntropy ||
        action == RecoveryAction::AppendAttemptThenEntropy) {
      std::array<std::uint8_t, kCreateKeysetResultBytes> recovery_result{};
      std::uint32_t recovery_result_length = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      ++g_recovery_evidence.phase_b_mutation_count;
#endif
      if (PerformCreate(
              state,
              request,
              recovered.prepared.bytes.data() + 112U,
              body_length,
              recovered.prepared.bytes.data() + 40U,
              sid_length,
              authenticated_binding,
              &recovery_result,
              &recovery_result_length,
              &recovered,
              true) != ProtectedOperationResult::Success ||
          recovery_result_length != kCreateKeysetResultBytes) {
        CloseProtectedOperations(state);
        return false;
      }
      return restart_after_recovery();
    }
    if (action == RecoveryAction::AppendAttemptThenQuarantineReason1) {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      ++g_recovery_evidence.phase_b_mutation_count;
#endif
      if (!RecoverNonterminalCreateAsQuarantine(state, recovered, true)) {
        CloseProtectedOperations(state);
        return false;
      }
      return restart_after_recovery();
    }
    bool recovery_attempt_already_appended = false;
    if (action == RecoveryAction::AppendAttemptThenPromoteAndFinish) {
      FILETIME now{};
      GetSystemTimeAsFileTime(&now);
      const std::uint64_t recovery_time =
          static_cast<std::uint64_t>(now.dwLowDateTime) |
          (static_cast<std::uint64_t>(now.dwHighDateTime) << 32U);
      JournalRecord recovery_attempt{};
      std::array<wchar_t, 32U> generation_component{};
      ProtectedPath candidate_path{};
      ProtectedPath final_keyset_path{};
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      ++g_recovery_evidence.phase_b_mutation_count;
#endif
      if (!EncodeFollowingJournalRecord(
              JournalRecordKind::Attempt,
              1U,
              recovered.prepared,
              recovered.prior,
              nullptr,
              nullptr,
              0U,
              recovery_time,
              state->next_publication_sequence,
              &recovery_attempt) ||
          !PublishJournalRecordWithOwnedParent(
              state,
              recovered.path,
              recovered.next_sequence,
              L"attempt",
              recovery_attempt,
              false,
              nullptr) ||
          !BuildGenerationComponent(
              request.requested_generation, &generation_component) ||
          !ComposeProtectedChildPath(
              recovered.path, L"keyset.pending", &candidate_path) ||
          !ComposeProtectedChildPath(
              state->filesystem.keysets_path,
              generation_component.data(),
              &final_keyset_path)) {
        CloseProtectedOperations(state);
        return false;
      }
      HANDLE candidate_directory = nullptr;
      ProtectedObjectIdentity candidate_identity{};
      Byte32 pre_move_closure{};
      Byte32 final_closure{};
      bool pre_move_complete = false;
      bool final_complete = false;
      DirectoryMoveAuthority& move_authority =
          g_directory_move_authority_scratch;
      bool promoted = OpenProtectedExistingDirectory(
                          state->filesystem,
                          candidate_path,
                          true,
                          &candidate_directory,
                          &candidate_identity) &&
          EqualMoveIdentity(candidate_identity, recovered.candidate_identity) &&
          CaptureDirectoryMoveAuthority(
              state->filesystem,
              candidate_path,
              candidate_directory,
              &move_authority,
              true) &&
          EqualMoveIdentity(
              move_authority.root_identity, recovered.candidate_identity) &&
          BuildCandidateClosure(
              state->filesystem,
              candidate_path,
              recovered.candidate_identity,
              &recovered.prepared,
              nullptr,
              &pre_move_closure,
              &pre_move_complete,
              candidate_directory) &&
          pre_move_complete &&
          Equal(
              pre_move_closure.data(),
              recovered.candidate_closure.data(),
              pre_move_closure.size()) &&
          MoveDirectoryWithCapturedAuthority(
              state->filesystem,
              candidate_path,
              final_keyset_path,
              &candidate_directory,
              move_authority) &&
          BuildCandidateClosure(
              state->filesystem,
              final_keyset_path,
              recovered.candidate_identity,
              &recovered.prepared,
              nullptr,
              &final_closure,
              &final_complete,
              nullptr,
              true) &&
          final_complete &&
          Equal(
              final_closure.data(),
              recovered.candidate_closure.data(),
              final_closure.size()) &&
          ProtectedPathIsAbsentGuarded(
              state->filesystem, candidate_path);
      if (candidate_directory != nullptr &&
          candidate_directory != INVALID_HANDLE_VALUE) {
        CloseHandle(candidate_directory);
      }
      WipeCustodyOwned(&move_authority, sizeof(move_authority));
      if (!promoted) {
        CloseProtectedOperations(state);
        return false;
      }
      recovered.prior = recovery_attempt;
      ++recovered.next_sequence;
      ++recovered.attempt_count;
      recovered.candidate_present = false;
      recovered.candidate_complete = false;
      recovery_attempt_already_appended = true;
    }
    if ((action == RecoveryAction::AppendAttemptThenFinishFinal ||
         action == RecoveryAction::AppendAttemptThenCommitExistingOutcome) &&
        !CompleteFinalCreateKeysetDirectory(
            state, recovered, request.requested_generation)) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 14U;
#endif
    if (action != RecoveryAction::AppendAttemptThenPromoteAndFinish &&
        action != RecoveryAction::AppendAttemptThenFinishFinal &&
        action != RecoveryAction::AppendAttemptThenCommitExistingOutcome) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 15U;
    ++g_recovery_evidence.phase_b_mutation_count;
#endif
    if (!RecoverCommittedCreate(
            state,
            recovered,
            recovery_attempt_already_appended,
            false,
            true)) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 16U;
#endif
    return restart_after_recovery();
  }
  if (recovered.opcode !=
      static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    CloseProtectedOperations(state);
    return false;
  }
  RevokeKeysetRequest request{};
  if (!DecodeRevokeKeysetRequest(
          recovered.prepared.bytes.data() + 112U,
          body_length,
          &request)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 20U;
#endif
  if (action == RecoveryAction::MoveRevokeResidueThenRegenerate) {
    ProtectedPath pending_control_path{};
    if (!ComposeProtectedChildPath(
            recovered.path,
            L"revoke.pending.gckc",
            &pending_control_path)) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    ++g_recovery_evidence.phase_b_mutation_count;
#endif
    if (!MoveFileToResidue(
            state,
            recovered.operation_id,
            L"revoke",
            pending_control_path,
            recovered.candidate_length)) {
      CloseProtectedOperations(state);
      return false;
    }
    return restart_after_recovery();
  }
  if (action == RecoveryAction::AppendAttemptThenRegenerateRevoke ||
      action == RecoveryAction::AppendAttemptThenPromoteAndFinish) {
    std::array<std::uint8_t, kCreateKeysetResultBytes> recovery_result{};
    std::uint32_t recovery_result_length = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    ++g_recovery_evidence.phase_b_mutation_count;
#endif
    if (PerformRevoke(
            state,
            request,
            recovered.prepared.bytes.data() + 112U,
            body_length,
            recovered.prepared.bytes.data() + 40U,
            sid_length,
            authenticated_binding,
            &recovery_result,
            &recovery_result_length,
            &recovered,
            action,
            true) != ProtectedOperationResult::Success ||
        recovery_result_length != kRevokeKeysetResultBytes) {
      CloseProtectedOperations(state);
      return false;
    }
    return restart_after_recovery();
  }
  if (action == RecoveryAction::AppendAttemptThenFinishFinal) {
    ProtectedObjectIdentity completed_control_identity{};
    Byte32 completed_control_hash{};
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 21U;
#endif
    if (!CompleteFinalRevokeControlAuthority(
            state,
            recovered,
            request.generation,
            &completed_control_identity,
            &completed_control_hash)) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 22U;
    ++g_recovery_evidence.phase_b_mutation_count;
#endif
    if (!RecoverCommittedRevoke(
            state,
            recovered,
            false,
            true,
            &completed_control_identity,
            &completed_control_hash)) {
      CloseProtectedOperations(state);
      return false;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_phase_b_nonterminal_revalidation_stage = 23U;
#endif
    return restart_after_recovery();
  }
  ProtectedObjectIdentity completed_control_identity{};
  Byte32 completed_control_hash{};
  if (action != RecoveryAction::AppendAttemptThenCommitExistingOutcome) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 24U;
#endif
  if (!CompleteFinalRevokeControlAuthority(
          state,
          recovered,
          request.generation,
          &completed_control_identity,
          &completed_control_hash)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 25U;
  ++g_recovery_evidence.phase_b_mutation_count;
#endif
  if (!RecoverCommittedRevoke(
          state,
          recovered,
          false,
          true,
          &completed_control_identity,
          &completed_control_hash)) {
    CloseProtectedOperations(state);
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_phase_b_nonterminal_revalidation_stage = 26U;
#endif
  return restart_after_recovery();

}

bool InitializeProtectedOperations(
    const wchar_t* extended_volume_root,
    std::size_t extended_volume_root_length,
    ProtectedOperationsState* state,
    std::uint64_t recovery_deadline_ms,
    HANDLE recovery_stop_event) noexcept {
  constexpr std::size_t kMaximumRecoveryRestarts =
      kMaximumPublicationSequence + kMaximumProtectedDirectoryEntries + 1U;
  for (std::size_t restart = 0U;
       restart < kMaximumRecoveryRestarts;
       ++restart) {
    bool restart_required = false;
    if (!InitializeProtectedOperationsOnce(
            extended_volume_root,
            extended_volume_root_length,
            state,
            recovery_deadline_ms,
            recovery_stop_event,
            &restart_required)) return false;
    if (!restart_required) return true;
  }
  CloseProtectedOperations(state);
  return false;
}

void CloseProtectedOperations(ProtectedOperationsState* state) noexcept {
  if (state == nullptr) return;
  CloseProtectedFilesystem(&state->filesystem);
  SecureZeroMemory(state, sizeof(*state));
}

bool BuildProtectedInspect(
    const ProtectedOperationsState& state,
    std::uint16_t pe_machine,
    std::array<std::uint8_t, kProtectedInspectPayloadBytes>* output) noexcept {
  if (!state.ready || output == nullptr ||
      state.operation_id_count > kMaximumOperationIds ||
      state.burned_generation_count > kMaximumBurnedGenerations ||
      state.residue_count > kMaximumResidues) return false;
  std::array<std::uint8_t, 288U> projection{};
  WriteU16(projection.data(), 1U);
  const bool operation_exhausted = state.operation_id_count >= kMaximumOperationIds;
  const bool generation_exhausted = state.burned_generation_count >= kMaximumBurnedGenerations;
  std::uint16_t posture = 0U;
  if (state.active_generation != 0U) posture = operation_exhausted || generation_exhausted ? 3U : 1U;
  else if (state.burned_generation_count != 0U || state.quarantined_operation_count != 0U) posture = operation_exhausted || generation_exhausted ? 4U : 2U;
  WriteU16(projection.data() + 2U, posture);
  WriteU32(
      projection.data() + 4U,
      (operation_exhausted ? 1U : 0U) |
          (generation_exhausted ? 2U : 0U) |
          (state.quarantined_operation_count != 0U || state.residue_count != 0U ? 4U : 0U));
  WriteU64(projection.data() + 8U, kProtectedCallableOpcodeBitmap);
  Copy32(state.state_sha256, projection.data() + 16U);
  WriteU64(projection.data() + 48U, state.active_generation);
  WriteU64(projection.data() + 56U, state.highest_burned_generation);
  WriteU32(projection.data() + 64U, state.committed_generation_count);
  WriteU32(projection.data() + 68U, state.burned_generation_count);
  WriteU32(projection.data() + 72U, state.operation_id_count);
  WriteU32(projection.data() + 76U, state.quarantined_operation_count);
  WriteU32(projection.data() + 80U, state.residue_count);
  WriteU32(projection.data() + 84U, kMaximumOperationIds - state.operation_id_count);
  WriteU32(projection.data() + 88U, kMaximumBurnedGenerations - state.burned_generation_count);
  if (state.active_generation != 0U) {
    Copy32(state.active_receipt_sha256, projection.data() + 96U);
    Copy32(state.runtime_manifest_spki_sha256, projection.data() + 128U);
    Copy32(state.admission_evidence_spki_sha256, projection.data() + 160U);
    std::memcpy(projection.data() + 192U, state.runtime_manifest_spki.data(), 44U);
    std::memcpy(projection.data() + 236U, state.admission_evidence_spki.data(), 44U);
  }
  return EncodeProtectedInspectResult(
      pe_machine, projection.data(), projection.size(), output);
}

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
    std::uint32_t* result_length) noexcept {
  if (state == nullptr || !state->ready || result == nullptr || result_length == nullptr ||
      operator_sid == nullptr || operator_sid_length == 0U ||
      operator_sid_length > 68U || deadline_ms <= GetTickCount64() ||
      stop_event == nullptr || WaitForSingleObject(stop_event, 0U) != WAIT_TIMEOUT) {
    return ProtectedOperationResult::CustodyOrJournal;
  }
  result->fill(0U);
  *result_length = 0U;
  if (opcode == static_cast<std::uint8_t>(Opcode::CreateKeyset)) {
    CreateKeysetRequest request{};
    if (!DecodeCreateKeysetRequest(body, body_length, &request)) return ProtectedOperationResult::ProtocolInvalid;
    const ProtectedOperationProjection* existing_operation =
        FindOperationProjection(*state, request.operation_id);
    if (existing_operation == nullptr && state->revoke_replay.present &&
        Equal(
            request.operation_id.data(),
            state->revoke_replay.operation_id.data(),
            request.operation_id.size())) {
      BuildCreateRejection(request, 4U, state->state_sha256, result);
      *result_length = kCreateKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    const bool cached_create_replay =
        state->create_replay.present &&
        Equal(
            request.operation_id.data(),
            state->create_replay.operation_id.data(),
            request.operation_id.size());
    if (existing_operation != nullptr || cached_create_replay) {
      if (existing_operation == nullptr) {
        // The fixed cached authority is retained for the allocation-free test
        // and immediate post-commit path; recovered histories use projections.
      } else {
      if (existing_operation->bytes[16] != opcode ||
          existing_operation->bytes[17] == 3U) {
        BuildCreateRejection(request, 4U, state->state_sha256, result);
        *result_length = kCreateKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      if ((!state->create_replay.present ||
           !Equal(
               request.operation_id.data(),
               state->create_replay.operation_id.data(),
               request.operation_id.size())) &&
          !LoadReplayAuthority(
              state, *existing_operation, &state->create_replay)) {
        return ProtectedOperationResult::CustodyOrJournal;
      }
      }
      bool body_matches = false;
      bool operator_matches = false;
      if (!ReplayAuthorityMatches(
              state->create_replay,
              body,
              body_length,
              operator_sid,
              operator_sid_length,
              &body_matches,
              &operator_matches)) return ProtectedOperationResult::CustodyOrJournal;
      if (!body_matches) {
        BuildCreateRejection(request, 4U, state->state_sha256, result);
        *result_length = kCreateKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      if (!operator_matches) {
        BuildCreateRejection(request, 5U, state->state_sha256, result);
        *result_length = kCreateKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      if (state->create_replay.quarantined) {
        *result = state->create_replay.result;
        Copy32(state->state_sha256, result->data() + 72U);
        Copy32(state->state_sha256, result->data() + 104U);
        *result_length = state->create_replay.result_length;
        return ProtectedOperationResult::Success;
      }
      if (state->create_replay.attempt_count >= kMaximumJournalAttempts) {
        BuildCreateRejection(request, 8U, state->state_sha256, result);
        *result_length = kCreateKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      return AppendCommittedReplay(
          state,
          &state->create_replay,
          authenticated_binding,
          result,
          result_length);
    }
    if (!Equal(request.expected_state_sha256.data(), state->state_sha256.data(), 32U)) {
      BuildCreateRejection(request, 3U, state->state_sha256, result);
      *result_length = kCreateKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    if (state->operation_id_count >= kMaximumOperationIds) {
      BuildCreateRejection(request, 6U, state->state_sha256, result);
      *result_length = kCreateKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    if (state->burned_generation_count >= kMaximumBurnedGenerations) {
      BuildCreateRejection(request, 7U, state->state_sha256, result);
      *result_length = kCreateKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    if (request.requested_generation != state->highest_burned_generation + 1U ||
        request.predecessor_generation != state->highest_committed_generation) {
      BuildCreateRejection(request, 9U, state->state_sha256, result);
      *result_length = kCreateKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    return PerformCreate(
        state,
        request,
        body,
        body_length,
        operator_sid,
        operator_sid_length,
        authenticated_binding,
        result,
        result_length);
  }
  if (opcode == static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)) {
    RevokeKeysetRequest request{};
    if (!DecodeRevokeKeysetRequest(body, body_length, &request)) return ProtectedOperationResult::ProtocolInvalid;
    const ProtectedOperationProjection* existing_operation =
        FindOperationProjection(*state, request.operation_id);
    if (existing_operation == nullptr && state->create_replay.present &&
        Equal(
            request.operation_id.data(),
            state->create_replay.operation_id.data(),
            request.operation_id.size())) {
      BuildRevokeRejection(request, 4U, state->state_sha256, result);
      *result_length = kRevokeKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    const bool cached_revoke_replay =
        state->revoke_replay.present &&
        Equal(
            request.operation_id.data(),
            state->revoke_replay.operation_id.data(),
            request.operation_id.size());
    if (existing_operation != nullptr || cached_revoke_replay) {
      if (existing_operation == nullptr) {
        // See the CREATE cached-authority compatibility note above.
      } else {
      if (existing_operation->bytes[16] != opcode ||
          existing_operation->bytes[17] != 1U) {
        BuildRevokeRejection(request, 4U, state->state_sha256, result);
        *result_length = kRevokeKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      if ((!state->revoke_replay.present ||
           !Equal(
               request.operation_id.data(),
               state->revoke_replay.operation_id.data(),
               request.operation_id.size())) &&
          !LoadReplayAuthority(
              state, *existing_operation, &state->revoke_replay)) {
        return ProtectedOperationResult::CustodyOrJournal;
      }
      }
      bool body_matches = false;
      bool operator_matches = false;
      if (!ReplayAuthorityMatches(
              state->revoke_replay,
              body,
              body_length,
              operator_sid,
              operator_sid_length,
              &body_matches,
              &operator_matches)) return ProtectedOperationResult::CustodyOrJournal;
      if (!body_matches) {
        BuildRevokeRejection(request, 4U, state->state_sha256, result);
        *result_length = kRevokeKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      if (!operator_matches) {
        BuildRevokeRejection(request, 5U, state->state_sha256, result);
        *result_length = kRevokeKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      if (state->revoke_replay.attempt_count >= kMaximumJournalAttempts) {
        BuildRevokeRejection(request, 7U, state->state_sha256, result);
        *result_length = kRevokeKeysetResultBytes;
        return ProtectedOperationResult::Success;
      }
      return AppendCommittedReplay(
          state,
          &state->revoke_replay,
          authenticated_binding,
          result,
          result_length);
    }
    if (!Equal(request.expected_state_sha256.data(), state->state_sha256.data(), 32U)) {
      BuildRevokeRejection(request, 3U, state->state_sha256, result);
      *result_length = kRevokeKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    if (state->operation_id_count >= kMaximumOperationIds) {
      BuildRevokeRejection(request, 6U, state->state_sha256, result);
      *result_length = kRevokeKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    const ProtectedGenerationProjection* target_generation =
        FindGenerationProjection(*state, request.generation);
    if (target_generation == nullptr ||
        (target_generation->bytes[16] != 1U &&
         target_generation->bytes[16] != 2U &&
         target_generation->bytes[16] != 3U)) {
      BuildRevokeRejection(request, 8U, state->state_sha256, result);
      *result_length = kRevokeKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    if (!Equal(
            request.expected_receipt_sha256.data(),
            target_generation->bytes.data() + 312U,
            32U)) {
      BuildRevokeRejection(request, 9U, state->state_sha256, result);
      *result_length = kRevokeKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    if (target_generation->bytes[16] == 3U) {
      BuildRevokeRejection(request, 10U, state->state_sha256, result);
      *result_length = kRevokeKeysetResultBytes;
      return ProtectedOperationResult::Success;
    }
    return PerformRevoke(
        state,
        request,
        body,
        body_length,
        operator_sid,
        operator_sid_length,
        authenticated_binding,
        result,
        result_length);
  }
  return ProtectedOperationResult::ProtocolInvalid;
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)
bool InitializeEmptyProtectedOperationsForTest(
    const std::array<std::uint8_t, kStateHeaderBytes>& state_header,
    ProtectedOperationsState* state) noexcept {
  if (state == nullptr) return false;
  CloseProtectedOperations(state);
  if (!HashDomain(
          kStateDomain,
          sizeof(kStateDomain) - 1U,
          state_header.data(),
          state_header.size(),
          &state->state_sha256)) return false;
  state->ready = true;
  return true;
}

bool CalculateProtectedStateForTest(
    const ProtectedOperationsState& state,
    const ProtectedGenerationProjection* generation,
    const ProtectedOperationProjection* operation,
    const ProtectedResidueProjection* residue,
    std::array<std::uint8_t, kMaximumStateProjectionBytesForTest>* projection,
    std::size_t* projection_length,
    Byte32* digest) noexcept {
  if (projection == nullptr || projection_length == nullptr || digest == nullptr) return false;
  projection->fill(0U);
  *projection_length = 0U;
  digest->fill(0U);
  Byte32 calculated{};
  if (!BuildCanonicalState(
          state, generation, operation, residue, &calculated) ||
      g_test_state_projection_length > projection->size() ||
      !Equal(calculated.data(), g_test_state_digest.data(), calculated.size())) return false;
  std::memcpy(
      projection->data(),
      g_test_state_projection.data(),
      g_test_state_projection_length);
  *projection_length = g_test_state_projection_length;
  *digest = calculated;
  return true;
}

bool SelectProtectedRecoveryActionForTest(
    ProtectedRecoveryTestOpcode opcode,
    ProtectedRecoveryTestPhase phase,
    ProtectedRecoveryTestEffect effect,
    std::uint32_t attempt_count,
    ProtectedRecoveryTestAction* action) noexcept {
  if (action == nullptr) return false;
  RecoveryAction selected{};
  const std::uint8_t production_opcode =
      opcode == ProtectedRecoveryTestOpcode::Create
          ? static_cast<std::uint8_t>(Opcode::CreateKeyset)
          : opcode == ProtectedRecoveryTestOpcode::Revoke
              ? static_cast<std::uint8_t>(Opcode::RevokeLocalKeyset)
              : 0U;
  if (!SelectRecoveryAction(
          production_opcode,
          static_cast<RecoveryChainPhase>(phase),
          static_cast<RecoveryEffectClass>(effect),
          attempt_count,
          &selected)) return false;
  *action = static_cast<ProtectedRecoveryTestAction>(selected);
  return true;
}

bool ValidateProtectedPublicationInventoryForTest(
    const std::uint16_t* publication_sequences,
    std::size_t publication_count,
    std::uint16_t* next_publication_sequence) noexcept {
  if ((publication_count != 0U && publication_sequences == nullptr) ||
      next_publication_sequence == nullptr) return false;
  g_publication_sequences.fill(false);
  std::size_t registered = 0U;
  bool valid = true;
  for (std::size_t index = 0U; valid && index < publication_count; ++index) {
    valid = RegisterPublicationSequence(
        publication_sequences[index], &registered);
  }
  valid = valid && registered == publication_count &&
          FinalizePublicationSequenceInventory(
              registered, next_publication_sequence);
  g_publication_sequences.fill(false);
  return valid;
}

bool ValidateProtectedResidueBindingForTest(
    const wchar_t* component,
    std::size_t component_length,
    const ProtectedResidueProjection& projection) noexcept {
  ProtectedDirectoryEntry entry{};
  if (component == nullptr || component_length == 0U ||
      component_length >= entry.name.size() ||
      !ResidueProjectionValid(projection)) return false;
  std::memcpy(
      entry.name.data(), component, component_length * sizeof(wchar_t));
  entry.name_length = component_length;
  Byte16 operation_id{};
  std::uint8_t ordinal = 0U;
  std::uint16_t publication_sequence = 0U;
  std::uint8_t kind = 0U;
  return ParseResidueComponent(
             entry,
             &operation_id,
             &ordinal,
             &publication_sequence,
             &kind) &&
         Equal(operation_id.data(), projection.bytes.data(), operation_id.size()) &&
         ordinal == projection.bytes[16] && kind == projection.bytes[17] &&
         publication_sequence == ReadU16(projection.bytes.data() + 18U);
}

bool ValidateProtectedRecoveryPublicationsForTest(
    const ProtectedRecoveryPublicationForTest* publications,
    std::size_t publication_count) noexcept {
  if ((publication_count != 0U && publications == nullptr) ||
      publication_count > kMaximumPublicationSequence) return false;
  for (std::size_t index = 0U; index < publication_count; ++index) {
    const ProtectedRecoveryPublicationForTest& source = publications[index];
    const std::uint8_t kind = static_cast<std::uint8_t>(source.kind);
    if (kind < static_cast<std::uint8_t>(
                   RecoveryPublicationEventKind::Prepared) ||
        kind > static_cast<std::uint8_t>(
                   RecoveryPublicationEventKind::RevokeResidue)) {
      for (std::size_t wipe = 1U; wipe <= index; ++wipe) {
        g_publication_events[wipe] = RecoveryPublicationEvent{};
      }
      return false;
    }
    RecoveryPublicationEvent& destination = g_publication_events[index + 1U];
    destination = RecoveryPublicationEvent{};
    destination.kind = static_cast<RecoveryPublicationEventKind>(kind);
    destination.opcode = source.opcode;
    destination.residue_ordinal = source.residue_ordinal;
    destination.record_present = source.record_present;
    destination.operation_id = source.operation_id;
    destination.record = source.record;
    const bool residue = destination.kind ==
            RecoveryPublicationEventKind::BootstrapResidue ||
        destination.kind == RecoveryPublicationEventKind::JournalResidue ||
        destination.kind == RecoveryPublicationEventKind::RevokeResidue;
    if (!ValidateRecoveryEventAuthority(
            destination,
            static_cast<std::uint16_t>(index + 1U),
            residue ? &source.residue : nullptr,
            residue ? &source.bootstrap_operation : nullptr)) {
      for (std::size_t wipe = 1U; wipe <= index + 1U; ++wipe) {
        g_publication_events[wipe] = RecoveryPublicationEvent{};
      }
      return false;
    }
  }
  const bool valid = ValidateRecoveryPublicationEvents(
      g_publication_events.data() + 1U, publication_count);
  for (std::size_t index = 1U; index <= publication_count; ++index) {
    g_publication_events[index] = RecoveryPublicationEvent{};
  }
  return valid;
}

void ResetProtectedRecoveryEvidenceForTest() noexcept {
  WipeCustodyOwned(&g_recovery_evidence, sizeof(g_recovery_evidence));
  g_recovery_evidence.next_publication_sequence = 1U;
}

const ProtectedRecoveryEvidenceForTest*
ProtectedRecoveryEvidenceViewForTest() noexcept {
  return &g_recovery_evidence;
}

void SetProtectedRecoveryPhaseBHookForTest(
    ProtectedRecoveryPhaseBHookForTest hook) noexcept {
  g_recovery_phase_b_hook = hook;
}
#endif

}  // namespace goatcitadel::remote_worker_provisioner
