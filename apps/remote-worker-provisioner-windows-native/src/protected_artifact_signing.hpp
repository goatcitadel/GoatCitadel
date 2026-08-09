#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

#include "protected_filesystem.hpp"

namespace goatcitadel::remote_worker_provisioner {

constexpr std::uint64_t kRuntimeManifestArtifactCeiling = UINT64_C(524288);
constexpr std::uint64_t kAdmissionEvidenceArtifactCeiling = UINT64_C(8388608);
constexpr std::size_t kProtectedArtifactStreamingBytes = 65536U;

enum class ProtectedArtifactPurpose : std::uint8_t {
  RuntimeManifest = 1U,
  AdmissionEvidence = 2U,
};

struct ProtectedArtifactControlSnapshot final {
  std::array<std::uint8_t, 32U> custody_state_sha256{};
  bool control_present = false;
  ProtectedObjectIdentity control_identity{};
  std::array<std::uint8_t, 32U> control_sha256{};
};

class ProtectedSigningLease;
struct ProtectedSigningFactoryInput;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
struct ProtectedSigningFactoryInputForTest;
struct ProtectedSigningHandleSnapshotForTest;
enum class ProtectedSigningDriftForTest : std::uint8_t;
#endif

class ProtectedArtifactAuthority final {
 public:
  ProtectedArtifactAuthority(const ProtectedArtifactAuthority&) = delete;
  ProtectedArtifactAuthority& operator=(const ProtectedArtifactAuthority&) = delete;
  ProtectedArtifactAuthority(ProtectedArtifactAuthority&& other) noexcept;
  ProtectedArtifactAuthority& operator=(ProtectedArtifactAuthority&& other) noexcept;
  ~ProtectedArtifactAuthority() noexcept;

 private:
  ProtectedArtifactAuthority() noexcept;
  void Reset() noexcept;
  void MoveFrom(ProtectedArtifactAuthority* other) noexcept;

  HANDLE artifact_ = nullptr;
  HANDLE parent_ = nullptr;
  HANDLE stop_event_ = nullptr;
  ProtectedObjectIdentity artifact_identity_{};
  ProtectedObjectIdentity parent_identity_{};
  std::array<std::uint8_t, 32U> artifact_sha256_{};
  ProtectedArtifactControlSnapshot control_{};
  std::array<std::uint8_t, 32U> incarnation_{};
  ProtectedArtifactPurpose purpose_ = ProtectedArtifactPurpose::RuntimeManifest;
  std::uint64_t length_ = 0U;
  std::uint64_t generation_ = 0U;
  std::uint64_t deadline_ms_ = 0U;
  bool occupied_ = false;
  bool consumed_ = false;

  friend class ProtectedSigningLease;
  friend bool SignProtectedArtifact(
      ProtectedSigningLease* lease,
      std::array<std::uint8_t, 64U>* candidate_signature) noexcept;
  friend bool CreateProtectedSigningLease(
      const ProtectedSigningFactoryInput& input,
      ProtectedSigningLease* output) noexcept;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  friend bool CreateProtectedSigningLeaseForTest(
      const ProtectedSigningFactoryInputForTest& input,
      ProtectedSigningLease* output) noexcept;
  friend void DriftProtectedSigningLeaseForTest(
      ProtectedSigningLease* lease,
      ProtectedSigningDriftForTest drift) noexcept;
  friend bool SignalProtectedSigningStopForTest(
      ProtectedSigningLease* lease) noexcept;
  friend ProtectedSigningHandleSnapshotForTest ProtectedSigningHandlesForTest(
      const ProtectedSigningLease& lease) noexcept;
#endif
};

class ProtectedSigningLease final {
 public:
  ProtectedSigningLease() noexcept;
  ProtectedSigningLease(const ProtectedSigningLease&) = delete;
  ProtectedSigningLease& operator=(const ProtectedSigningLease&) = delete;
  ProtectedSigningLease(ProtectedSigningLease&& other) noexcept;
  ProtectedSigningLease& operator=(ProtectedSigningLease&& other) noexcept;
  ~ProtectedSigningLease() noexcept;

 private:
  void Reset() noexcept;
  void MoveFrom(ProtectedSigningLease* other) noexcept;
  bool StateIsCurrent() const noexcept;
  bool AuthorityIsCurrent() const noexcept;

  ProtectedArtifactAuthority authority_{};
  HANDLE key_file_ = nullptr;
  ProtectedObjectIdentity key_identity_{};
  std::array<std::uint8_t, 32U> key_file_sha256_{};
  std::array<std::uint8_t, 44U> spki_{};
  std::array<std::uint8_t, 32U> key_id_{};
  std::array<std::uint8_t, 32U> current_incarnation_{};
  std::array<std::uint8_t, 32U> current_custody_state_sha256_{};
  ProtectedArtifactControlSnapshot current_control_{};
  ProtectedArtifactPurpose current_purpose_ =
      ProtectedArtifactPurpose::RuntimeManifest;
  std::uint64_t current_generation_ = 0U;
  alignas(4) volatile LONG consumed_ = 0;
  bool occupied_ = false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  bool revoke_ordered_for_test_ = false;
#endif

  friend bool SignProtectedArtifact(
      ProtectedSigningLease* lease,
      std::array<std::uint8_t, 64U>* candidate_signature) noexcept;
  friend bool CreateProtectedSigningLease(
      const ProtectedSigningFactoryInput& input,
      ProtectedSigningLease* output) noexcept;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  friend bool CreateProtectedSigningLeaseForTest(
      const ProtectedSigningFactoryInputForTest& input,
      ProtectedSigningLease* output) noexcept;
  friend void DriftProtectedSigningLeaseForTest(
      ProtectedSigningLease* lease,
      ProtectedSigningDriftForTest drift) noexcept;
  friend bool SignalProtectedSigningStopForTest(
      ProtectedSigningLease* lease) noexcept;
  friend void OrderProtectedSigningRevokeForTest(
      ProtectedSigningLease* lease) noexcept;
  friend bool ProtectedSigningLeaseConsumedForTest(
      const ProtectedSigningLease& lease) noexcept;
  friend ProtectedSigningHandleSnapshotForTest ProtectedSigningHandlesForTest(
      const ProtectedSigningLease& lease) noexcept;
#endif
};

// Production composition passes only already-open, no-follow protected handles
// and immutable authority projections. The factory duplicates every handle;
// ownership never crosses this boundary and no key bytes are returned.
struct ProtectedSigningFactoryInput final {
  HANDLE parent = nullptr;
  HANDLE artifact = nullptr;
  HANDLE key_file = nullptr;
  HANDLE stop_event = nullptr;
  ProtectedObjectIdentity parent_identity{};
  ProtectedObjectIdentity artifact_identity{};
  ProtectedObjectIdentity key_identity{};
  std::array<std::uint8_t, 32U> artifact_sha256{};
  std::array<std::uint8_t, 32U> key_file_sha256{};
  std::array<std::uint8_t, 44U> spki{};
  std::array<std::uint8_t, 32U> key_id{};
  std::array<std::uint8_t, 32U> custody_state_sha256{};
  std::array<std::uint8_t, 32U> incarnation{};
  ProtectedArtifactPurpose purpose = ProtectedArtifactPurpose::RuntimeManifest;
  std::uint64_t artifact_length = 0U;
  std::uint64_t generation = 0U;
  std::uint64_t deadline_ms = 0U;
};

__declspec(noinline) bool CreateProtectedSigningLease(
    const ProtectedSigningFactoryInput& input,
    ProtectedSigningLease* output) noexcept;

__declspec(noinline) bool SignProtectedArtifact(
    ProtectedSigningLease* lease,
    std::array<std::uint8_t, 64U>* candidate_signature) noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING)

enum class ProtectedSigningFailurePointForTest : std::uint8_t {
  None = 0U,
  AfterFactorySealing = 1U,
  AfterLeaseIssue = 2U,
  AfterLeaseBurn = 3U,
  AfterKeyRead = 4U,
  AfterScalarExpansion = 5U,
  PassOneChunk = 6U,
  AfterCanonicalR = 7U,
  AfterRewind = 8U,
  PassTwoChunk = 9U,
  AfterChallengeFinalizeA = 10U,
  AfterChallengeFinalizeB = 11U,
  AfterChallengeReduceA = 12U,
  AfterChallengeReduceB = 13U,
  AfterChallengeCompare = 14U,
  AfterCanonicalS = 15U,
  AfterEquationValidation = 16U,
  BeforeFinalRelease = 17U,
};

enum class ProtectedSigningWipeLabelForTest : std::uint8_t {
  Pkcs8 = 1U,
  Seed = 2U,
  SecretKey = 3U,
  ExpandedScalarPrefix = 4U,
  NonceDigest = 5U,
  NonceScalar = 6U,
  CanonicalR = 7U,
  ChallengeDigestA = 8U,
  ChallengeDigestB = 9U,
  ChallengeScalarA = 10U,
  ChallengeScalarB = 11U,
  StreamingBuffer = 12U,
  CandidateSignature = 13U,
  Sha512Context = 14U,
  Sha256Object = 15U,
};

enum class ProtectedSigningDivergenceForTest : std::uint8_t {
  None = 0U,
  ChallengeDigest = 1U,
  ChallengeScalar = 2U,
};

enum class ProtectedSigningDriftForTest : std::uint8_t {
  Incarnation = 1U,
  Generation = 2U,
  Purpose = 3U,
  CustodyState = 4U,
  ControlPresence = 5U,
  ControlIdentity = 6U,
  ControlSha256 = 7U,
  Deadline = 8U,
  KeyId = 9U,
  ParentIdentity = 10U,
  ArtifactIdentity = 11U,
  ArtifactLength = 12U,
  ArtifactSha256 = 13U,
};

enum class ProtectedSigningCheckpointActionForTest : std::uint8_t {
  None = 0U,
  DriftGeneration = 1U,
  DriftParentIdentity = 2U,
  DriftArtifactIdentity = 3U,
  DriftArtifactLength = 4U,
  DriftArtifactSha256 = 5U,
  SignalStop = 6U,
  OrderRevoke = 7U,
  DriftPurpose = 8U,
  DriftCustodyState = 9U,
  DriftControlPresence = 10U,
  DriftControlIdentity = 11U,
  DriftControlSha256 = 12U,
  DriftDeadline = 13U,
  PauseForCrash = 14U,
};

enum class ProtectedSigningIoFaultForTest : std::uint8_t {
  None = 0U,
  ShortRead = 1U,
  PrematureEof = 2U,
  TrailingByte = 3U,
  FailedRewind = 4U,
  SeekMismatch = 5U,
};

using ProtectedSigningWipeObserverForTest = void (*)(
    ProtectedSigningWipeLabelForTest label,
    const std::uint8_t* bytes,
    std::size_t size) noexcept;

struct ProtectedSigningFactoryInputForTest final {
  const wchar_t* isolated_root = nullptr;
  std::size_t isolated_root_length = 0U;
  ProtectedArtifactPurpose purpose = ProtectedArtifactPurpose::RuntimeManifest;
  std::uint64_t artifact_length = 0U;
  std::uint8_t artifact_pattern_seed = 0U;
  std::array<std::uint8_t, 32U> seed{};
  std::uint64_t generation = 1U;
  std::array<std::uint8_t, 32U> custody_state_sha256{};
  std::array<std::uint8_t, 32U> incarnation{};
  std::uint64_t deadline_after_ms = 120000U;
};

struct ProtectedSigningHandleSnapshotForTest final {
  HANDLE parent = nullptr;
  HANDLE artifact = nullptr;
  HANDLE key = nullptr;
  HANDLE stop = nullptr;
};

bool CreateProtectedSigningLeaseForTest(
    const ProtectedSigningFactoryInputForTest& input,
    ProtectedSigningLease* output) noexcept;
void SetProtectedSigningFailureForTest(
    ProtectedSigningFailurePointForTest point,
    std::uint32_t fail_on_call) noexcept;
void SetProtectedSigningCheckpointActionForTest(
    ProtectedSigningFailurePointForTest point,
    ProtectedSigningCheckpointActionForTest action,
    std::uint32_t act_on_call) noexcept;
void SetProtectedSigningIoFaultForTest(
    ProtectedSigningIoFaultForTest fault,
    std::uint32_t act_on_call) noexcept;
void SetProtectedSigningCrashPauseForTest(
    HANDLE ready_event,
    HANDLE release_event) noexcept;
void SetProtectedSigningDivergenceForTest(
    ProtectedSigningDivergenceForTest divergence) noexcept;
void SetProtectedSigningRevokeBeforeFinalForTest(bool enabled) noexcept;
void SetProtectedSigningWipeObserverForTest(
    ProtectedSigningWipeObserverForTest observer) noexcept;
void ResetProtectedSigningStateForTest() noexcept;
void DriftProtectedSigningLeaseForTest(
    ProtectedSigningLease* lease,
    ProtectedSigningDriftForTest drift) noexcept;
bool SignalProtectedSigningStopForTest(
    ProtectedSigningLease* lease) noexcept;
void OrderProtectedSigningRevokeForTest(
    ProtectedSigningLease* lease) noexcept;
bool ProtectedSigningLeaseConsumedForTest(
    const ProtectedSigningLease& lease) noexcept;
ProtectedSigningHandleSnapshotForTest ProtectedSigningHandlesForTest(
    const ProtectedSigningLease& lease) noexcept;
std::uint8_t ProtectedArtifactPatternByteForTest(
    std::uint64_t offset,
    std::uint8_t seed) noexcept;

#endif

}  // namespace goatcitadel::remote_worker_provisioner
