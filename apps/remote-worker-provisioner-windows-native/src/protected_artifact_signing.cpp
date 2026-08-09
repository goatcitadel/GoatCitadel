#include "protected_artifact_signing.hpp"

#include <bcrypt.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <utility>

#include "ed25519_runtime.hpp"

namespace goatcitadel::remote_worker_provisioner {

namespace {

constexpr std::size_t kHashObjectMaximumBytes = 1024U;
constexpr std::size_t kPkcs8Bytes = 48U;
constexpr std::size_t kSeedBytes = 32U;
constexpr std::size_t kPublicKeyBytes = 32U;
constexpr std::size_t kSignatureBytes = 64U;
constexpr std::size_t kSha512Bytes = 64U;
constexpr std::array<std::uint8_t, 16U> kPkcs8Prefix = {
    0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
    0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U,
};
constexpr char kEvidenceDomain[] =
    "goatcitadel.remote-worker.provisioning-evidence.signature.v1";
static_assert(sizeof(kEvidenceDomain) - 1U == 60U);
#if defined(GOATCITADEL_PROVISIONER_TESTING)
constexpr std::size_t kTestPathCharacters = 1024U;
constexpr std::uint64_t kMaximumTestDeadlineMs = UINT64_C(120000);
constexpr wchar_t kArtifactName[] = L"w1b1b-p0-artifact.bin";
constexpr wchar_t kKeyName[] = L"w1b1b-p0-key.pk8";

enum class SigningCutpoint : std::uint8_t {
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

enum class SigningWipeLabel : std::uint8_t {
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

struct FailureStateForTest final {
  SigningCutpoint point = SigningCutpoint::None;
  std::uint32_t fail_on_call = 0U;
  std::uint32_t calls = 0U;
};

struct CheckpointActionStateForTest final {
  SigningCutpoint point = SigningCutpoint::None;
  ProtectedSigningCheckpointActionForTest action =
      ProtectedSigningCheckpointActionForTest::None;
  std::uint32_t act_on_call = 0U;
  std::uint32_t calls = 0U;
};

FailureStateForTest g_failure_for_test{};
CheckpointActionStateForTest g_checkpoint_action_for_test{};
ProtectedSigningIoFaultForTest g_io_fault_for_test =
    ProtectedSigningIoFaultForTest::None;
std::uint32_t g_io_fault_act_on_call_for_test = 0U;
std::uint32_t g_io_fault_calls_for_test = 0U;
HANDLE g_crash_ready_for_test = nullptr;
HANDLE g_crash_release_for_test = nullptr;
ProtectedSigningDivergenceForTest g_divergence_for_test =
    ProtectedSigningDivergenceForTest::None;
ProtectedSigningWipeObserverForTest g_wipe_observer_for_test = nullptr;
bool g_revoke_before_final_for_test = false;
thread_local ProtectedSigningLease* g_active_lease_for_test = nullptr;

bool IoFaultActsForTest(ProtectedSigningIoFaultForTest fault) noexcept {
  if (g_io_fault_for_test != fault) return false;
  ++g_io_fault_calls_for_test;
  return g_io_fault_act_on_call_for_test != 0U &&
         g_io_fault_calls_for_test == g_io_fault_act_on_call_for_test;
}

bool PermitForTest(SigningCutpoint point) noexcept {
  if (g_checkpoint_action_for_test.point == point) {
    ++g_checkpoint_action_for_test.calls;
    if (g_checkpoint_action_for_test.act_on_call != 0U &&
        g_checkpoint_action_for_test.calls ==
            g_checkpoint_action_for_test.act_on_call) {
      switch (g_checkpoint_action_for_test.action) {
        case ProtectedSigningCheckpointActionForTest::DriftGeneration:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::Generation);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftParentIdentity:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ParentIdentity);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftArtifactIdentity:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ArtifactIdentity);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftArtifactLength:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ArtifactLength);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftArtifactSha256:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ArtifactSha256);
          break;
        case ProtectedSigningCheckpointActionForTest::SignalStop:
          SignalProtectedSigningStopForTest(g_active_lease_for_test);
          break;
        case ProtectedSigningCheckpointActionForTest::OrderRevoke:
          OrderProtectedSigningRevokeForTest(g_active_lease_for_test);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftPurpose:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test, ProtectedSigningDriftForTest::Purpose);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftCustodyState:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::CustodyState);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftControlPresence:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ControlPresence);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftControlIdentity:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ControlIdentity);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftControlSha256:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test,
              ProtectedSigningDriftForTest::ControlSha256);
          break;
        case ProtectedSigningCheckpointActionForTest::DriftDeadline:
          DriftProtectedSigningLeaseForTest(
              g_active_lease_for_test, ProtectedSigningDriftForTest::Deadline);
          break;
        case ProtectedSigningCheckpointActionForTest::PauseForCrash:
          if (g_crash_ready_for_test != nullptr &&
              g_crash_ready_for_test != INVALID_HANDLE_VALUE &&
              g_crash_release_for_test != nullptr &&
              g_crash_release_for_test != INVALID_HANDLE_VALUE) {
            SetEvent(g_crash_ready_for_test);
            WaitForSingleObject(g_crash_release_for_test, INFINITE);
          }
          break;
        case ProtectedSigningCheckpointActionForTest::None:
          break;
      }
    }
  }
  if (g_failure_for_test.point != point) return true;
  ++g_failure_for_test.calls;
  return g_failure_for_test.fail_on_call == 0U ||
         g_failure_for_test.calls != g_failure_for_test.fail_on_call;
}

void ObserveWipeForTest(
    SigningWipeLabel label,
    const void* bytes,
    std::size_t size) noexcept {
  if (g_wipe_observer_for_test != nullptr && bytes != nullptr && size != 0U) {
    g_wipe_observer_for_test(
        static_cast<ProtectedSigningWipeLabelForTest>(label),
        static_cast<const std::uint8_t*>(bytes), size);
  }
}

#define GC_SIGNING_PERMIT(point) PermitForTest(SigningCutpoint::point)
#define GC_SIGNING_WIPE_PARAMETER SigningWipeLabel label,
#define GC_SIGNING_WIPE_ARGUMENT(label) SigningWipeLabel::label,
#define GC_SIGNING_CUTPOINT_PARAMETER SigningCutpoint cutpoint,
#define GC_SIGNING_CUTPOINT_ARGUMENT(point) SigningCutpoint::point,
#define GC_SIGNING_CHUNK_PERMITTED() PermitForTest(cutpoint)
#else
#define GC_SIGNING_PERMIT(point) true
#define GC_SIGNING_WIPE_PARAMETER
#define GC_SIGNING_WIPE_ARGUMENT(label)
#define GC_SIGNING_CUTPOINT_PARAMETER
#define GC_SIGNING_CUTPOINT_ARGUMENT(point)
#define GC_SIGNING_CHUNK_PERMITTED() true
#endif

bool ValidHandle(HANDLE handle) noexcept {
  return handle != nullptr && handle != INVALID_HANDLE_VALUE;
}

bool AllZero(const void* bytes, std::size_t size) noexcept {
  if (bytes == nullptr) return true;
  const auto* current = static_cast<const std::uint8_t*>(bytes);
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | current[index]);
  }
  return aggregate == 0U;
}

bool EqualBytes(
    const void* left,
    const void* right,
    std::size_t size) noexcept {
  if (left == nullptr || right == nullptr) return false;
  const auto* left_bytes = static_cast<const std::uint8_t*>(left);
  const auto* right_bytes = static_cast<const std::uint8_t*>(right);
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    difference = static_cast<std::uint8_t>(
        difference |
        static_cast<std::uint8_t>(left_bytes[index] ^ right_bytes[index]));
  }
  return difference == 0U;
}

template <typename Value>
void WipeValue(
    GC_SIGNING_WIPE_PARAMETER
    Value* value) noexcept {
  if (value == nullptr) return;
  SecureZeroMemory(value, sizeof(*value));
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  ObserveWipeForTest(label, value, sizeof(*value));
#endif
}

#define GC_WIPE_VALUE(label, value) \
  WipeValue(GC_SIGNING_WIPE_ARGUMENT(label) (value))

bool EqualIdentity(
    const ProtectedObjectIdentity& left,
    const ProtectedObjectIdentity& right) noexcept {
  return left.volume_serial_number == right.volume_serial_number &&
         EqualBytes(left.file_id.data(), right.file_id.data(), left.file_id.size());
}

bool CaptureIdentity(
    HANDLE handle,
    ProtectedObjectIdentity* identity) noexcept {
  if (!ValidHandle(handle) || identity == nullptr) return false;
  *identity = {};
  FILE_ID_INFO current{};
  if (GetFileInformationByHandleEx(
          handle, FileIdInfo, &current, sizeof(current)) == FALSE) {
    return false;
  }
  identity->volume_serial_number = current.VolumeSerialNumber;
  std::memcpy(
      identity->file_id.data(), current.FileId.Identifier,
      identity->file_id.size());
  return identity->volume_serial_number != 0U &&
         !AllZero(identity->file_id.data(), identity->file_id.size());
}

bool ValidateDirectory(
    HANDLE directory,
    const ProtectedObjectIdentity& expected) noexcept {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  ProtectedObjectIdentity identity{};
  return ValidHandle(directory) &&
         GetFileInformationByHandleEx(
             directory, FileAttributeTagInfo, &attributes,
             sizeof(attributes)) != FALSE &&
         GetFileInformationByHandleEx(
             directory, FileStandardInfo, &standard, sizeof(standard)) != FALSE &&
         (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U &&
         (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0U &&
         standard.DeletePending == FALSE && CaptureIdentity(directory, &identity) &&
         EqualIdentity(identity, expected);
}

bool ValidateFile(
    HANDLE file,
    const ProtectedObjectIdentity& expected,
    std::uint64_t expected_length) noexcept {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  ProtectedObjectIdentity identity{};
  constexpr DWORD kForbiddenAttributes =
      FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
      FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
      FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
      FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN;
  return ValidHandle(file) &&
         GetFileInformationByHandleEx(
             file, FileAttributeTagInfo, &attributes, sizeof(attributes)) != FALSE &&
         GetFileInformationByHandleEx(
             file, FileStandardInfo, &standard, sizeof(standard)) != FALSE &&
         (attributes.FileAttributes & kForbiddenAttributes) == 0U &&
         standard.DeletePending == FALSE && standard.NumberOfLinks == 1U &&
         standard.EndOfFile.QuadPart >= 0 &&
         static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) ==
             expected_length &&
         CaptureIdentity(file, &identity) && EqualIdentity(identity, expected);
}

class StreamingHash final {
 public:
  StreamingHash() noexcept = default;
  StreamingHash(const StreamingHash&) = delete;
  StreamingHash& operator=(const StreamingHash&) = delete;
  ~StreamingHash() noexcept { Close(); }

  bool Open(LPCWSTR algorithm, std::size_t expected_length) noexcept {
    if (algorithm_ != nullptr || hash_ != nullptr || algorithm == nullptr ||
        expected_length == 0U || expected_length > MAXDWORD) {
      return false;
    }
    if (BCryptOpenAlgorithmProvider(&algorithm_, algorithm, nullptr, 0U) < 0) {
      algorithm_ = nullptr;
      return false;
    }
    DWORD object_length = 0U;
    DWORD copied = 0U;
    DWORD hash_length = 0U;
    if (BCryptGetProperty(
            algorithm_, BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&object_length), sizeof(object_length),
            &copied, 0U) < 0 ||
        copied != sizeof(object_length) || object_length == 0U ||
        object_length > object_.size() ||
        BCryptGetProperty(
            algorithm_, BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hash_length), sizeof(hash_length),
            &copied, 0U) < 0 ||
        copied != sizeof(hash_length) || hash_length != expected_length ||
        BCryptCreateHash(
            algorithm_, &hash_, object_.data(), object_length, nullptr, 0U,
            0U) < 0) {
      Close();
      return false;
    }
    digest_length_ = hash_length;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    wipe_label_ = expected_length == 64U
                      ? SigningWipeLabel::Sha512Context
                      : SigningWipeLabel::Sha256Object;
#endif
    return true;
  }

  bool Update(const std::uint8_t* bytes, std::size_t size) noexcept {
    return hash_ != nullptr && (bytes != nullptr || size == 0U) &&
           size <= MAXDWORD &&
           (size == 0U ||
            BCryptHashData(
                hash_, const_cast<PUCHAR>(bytes), static_cast<ULONG>(size),
                0U) >= 0);
  }

  bool Finish(std::uint8_t* output, std::size_t size) noexcept {
    if (hash_ == nullptr || output == nullptr || size != digest_length_) {
      return false;
    }
    if (BCryptFinishHash(
            hash_, output, static_cast<ULONG>(size), 0U) < 0) {
      return false;
    }
    BCryptDestroyHash(hash_);
    hash_ = nullptr;
    return true;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  void SetWipeLabelForTest(SigningWipeLabel label) noexcept {
    wipe_label_ = label;
  }
#endif

 private:
  void Close() noexcept {
    if (hash_ != nullptr) {
      BCryptDestroyHash(hash_);
      hash_ = nullptr;
    }
    if (algorithm_ != nullptr) {
      BCryptCloseAlgorithmProvider(algorithm_, 0U);
      algorithm_ = nullptr;
    }
    digest_length_ = 0U;
    SecureZeroMemory(object_.data(), object_.size());
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    ObserveWipeForTest(wipe_label_, object_.data(), object_.size());
#endif
  }

  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
  std::array<std::uint8_t, kHashObjectMaximumBytes> object_{};
  DWORD digest_length_ = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  SigningWipeLabel wipe_label_ = SigningWipeLabel::Sha256Object;
#endif
};

bool Rewind(HANDLE file) noexcept {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (IoFaultActsForTest(ProtectedSigningIoFaultForTest::FailedRewind)) {
    return false;
  }
#endif
  LARGE_INTEGER zero{};
  LARGE_INTEGER current{};
  const bool rewound =
      ValidHandle(file) &&
      SetFilePointerEx(file, zero, &current, FILE_BEGIN) != FALSE;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (rewound &&
      IoFaultActsForTest(ProtectedSigningIoFaultForTest::SeekMismatch)) {
    current.QuadPart = 1;
  }
#endif
  return rewound && current.QuadPart == 0;
}

bool ReadExactKey(
    HANDLE file,
    const ProtectedObjectIdentity& identity,
    const std::array<std::uint8_t, 32U>& expected_hash,
    std::array<std::uint8_t, kPkcs8Bytes>* pkcs8) noexcept {
  if (pkcs8 == nullptr ||
      !ValidateFile(file, identity, kPkcs8Bytes) || !Rewind(file)) {
    return false;
  }
  pkcs8->fill(0U);
  DWORD read = 0U;
  std::uint8_t trailing = 0U;
  DWORD trailing_read = 0U;
  StreamingHash hash;
  std::array<std::uint8_t, 32U> actual_hash{};
  const bool success =
      ReadFile(
          file, pkcs8->data(), static_cast<DWORD>(pkcs8->size()), &read,
          nullptr) != FALSE &&
      read == pkcs8->size() &&
      ReadFile(file, &trailing, 1U, &trailing_read, nullptr) != FALSE &&
      trailing_read == 0U && hash.Open(BCRYPT_SHA256_ALGORITHM, 32U) &&
      hash.Update(pkcs8->data(), pkcs8->size()) &&
      hash.Finish(actual_hash.data(), actual_hash.size()) &&
      EqualBytes(actual_hash.data(), expected_hash.data(), actual_hash.size());
  SecureZeroMemory(actual_hash.data(), actual_hash.size());
  return success;
}

bool HashOpenFile(
    HANDLE file,
    std::uint64_t length,
    std::array<std::uint8_t, 32U>* output) noexcept {
  if (!ValidHandle(file) || output == nullptr || !Rewind(file)) return false;
  output->fill(0U);
  StreamingHash hash;
  std::array<std::uint8_t, kProtectedArtifactStreamingBytes> buffer{};
  std::uint64_t total = 0U;
  bool success = hash.Open(BCRYPT_SHA256_ALGORITHM, 32U);
  while (success && total < length) {
    const std::uint64_t remaining = length - total;
    const DWORD requested = static_cast<DWORD>(
        remaining < buffer.size() ? remaining : buffer.size());
    DWORD read = 0U;
    success = ReadFile(file, buffer.data(), requested, &read, nullptr) != FALSE &&
              read == requested && hash.Update(buffer.data(), read);
    total += read;
  }
  std::uint8_t trailing = 0U;
  DWORD trailing_read = 0U;
  success = success && total == length &&
            ReadFile(file, &trailing, 1U, &trailing_read, nullptr) != FALSE &&
            trailing_read == 0U &&
            hash.Finish(output->data(), output->size());
  GC_WIPE_VALUE(StreamingBuffer, &buffer);
  return success;
}

bool ControlSnapshotValid(
    const ProtectedArtifactControlSnapshot& control) noexcept {
  if (AllZero(
          control.custody_state_sha256.data(),
          control.custody_state_sha256.size())) {
    return false;
  }
  const bool identity_zero =
      control.control_identity.volume_serial_number == 0U &&
      AllZero(
          control.control_identity.file_id.data(),
          control.control_identity.file_id.size());
  const bool hash_zero = AllZero(
      control.control_sha256.data(), control.control_sha256.size());
  return control.control_present ? !identity_zero && !hash_zero
                                 : identity_zero && hash_zero;
}

bool EqualControl(
    const ProtectedArtifactControlSnapshot& left,
    const ProtectedArtifactControlSnapshot& right) noexcept {
  return left.control_present == right.control_present &&
         EqualBytes(
             left.custody_state_sha256.data(),
             right.custody_state_sha256.data(),
             left.custody_state_sha256.size()) &&
         EqualIdentity(left.control_identity, right.control_identity) &&
         EqualBytes(
             left.control_sha256.data(), right.control_sha256.data(),
             left.control_sha256.size());
}

bool UpdateSignatureDomain(
    ProtectedArtifactPurpose purpose,
    StreamingHash* hash) noexcept {
  if (hash == nullptr) return false;
  if (purpose == ProtectedArtifactPurpose::RuntimeManifest) return true;
  if (purpose != ProtectedArtifactPurpose::AdmissionEvidence) return false;
  constexpr std::uint8_t kNul = 0U;
  return hash->Update(
             reinterpret_cast<const std::uint8_t*>(kEvidenceDomain),
             sizeof(kEvidenceDomain) - 1U) &&
         hash->Update(&kNul, 1U);
}

bool StreamArtifactPass(
    HANDLE artifact,
    std::uint64_t expected_length,
    StreamingHash* first_sha512,
    StreamingHash* second_sha512,
    StreamingHash* sha256,
    GC_SIGNING_CUTPOINT_PARAMETER
    std::array<std::uint8_t, kProtectedArtifactStreamingBytes>* buffer,
    std::uint64_t* total) noexcept {
  if (!ValidHandle(artifact) || first_sha512 == nullptr || sha256 == nullptr ||
      buffer == nullptr || total == nullptr) {
    return false;
  }
  *total = 0U;
  while (*total < expected_length) {
    const std::uint64_t remaining = expected_length - *total;
    const DWORD requested = static_cast<DWORD>(
        remaining < buffer->size() ? remaining : buffer->size());
    DWORD read = 0U;
    const bool read_succeeded =
        ReadFile(artifact, buffer->data(), requested, &read, nullptr) != FALSE;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (read_succeeded &&
        IoFaultActsForTest(ProtectedSigningIoFaultForTest::ShortRead) &&
        read != 0U) {
      --read;
    }
    if (read_succeeded &&
        IoFaultActsForTest(ProtectedSigningIoFaultForTest::PrematureEof)) {
      read = 0U;
    }
#endif
    if (!read_succeeded ||
        read != requested || !first_sha512->Update(buffer->data(), read) ||
        (second_sha512 != nullptr &&
         !second_sha512->Update(buffer->data(), read)) ||
        !sha256->Update(buffer->data(), read) ||
        !GC_SIGNING_CHUNK_PERMITTED()) {
      return false;
    }
    *total += read;
  }
  std::uint8_t trailing = 0U;
  DWORD trailing_read = 0U;
  const bool trailing_succeeded =
      ReadFile(artifact, &trailing, 1U, &trailing_read, nullptr) != FALSE;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (trailing_succeeded &&
      IoFaultActsForTest(ProtectedSigningIoFaultForTest::TrailingByte)) {
    trailing_read = 1U;
  }
#endif
  return *total == expected_length && trailing_succeeded &&
         trailing_read == 0U;
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)
std::uint8_t PatternByte(std::uint64_t offset, std::uint8_t seed) noexcept {
  const std::uint64_t mixed =
      offset * UINT64_C(131) + (offset >> 3U) + seed;
  return static_cast<std::uint8_t>(mixed & UINT64_C(0xFF));
}

bool ComposeTestPath(
    const wchar_t* root,
    std::size_t root_length,
    const wchar_t* name,
    std::array<wchar_t, kTestPathCharacters>* output) noexcept {
  if (root == nullptr || name == nullptr || output == nullptr ||
      root_length == 0U || root_length + 2U >= output->size() ||
      root[root_length] != L'\0') {
    return false;
  }
  output->fill(L'\0');
  std::size_t offset = 0U;
  for (; offset < root_length; ++offset) (*output)[offset] = root[offset];
  if (offset != 0U && (*output)[offset - 1U] != L'\\') {
    (*output)[offset++] = L'\\';
  }
  for (std::size_t index = 0U; name[index] != L'\0'; ++index) {
    if (offset + 1U >= output->size()) return false;
    (*output)[offset++] = name[index];
  }
  (*output)[offset] = L'\0';
  return true;
}

bool WritePatternArtifact(
    const wchar_t* path,
    std::uint64_t length,
    std::uint8_t seed) noexcept {
  const HANDLE file = CreateFileW(
      path, GENERIC_WRITE, 0U, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_WRITE_THROUGH,
      nullptr);
  if (!ValidHandle(file)) return false;
  std::array<std::uint8_t, kProtectedArtifactStreamingBytes> buffer{};
  std::uint64_t total = 0U;
  bool success = true;
  while (success && total < length) {
    const std::uint64_t remaining = length - total;
    const DWORD requested = static_cast<DWORD>(
        remaining < buffer.size() ? remaining : buffer.size());
    for (DWORD index = 0U; index < requested; ++index) {
      buffer[index] = PatternByte(total + index, seed);
    }
    DWORD written = 0U;
    success = WriteFile(file, buffer.data(), requested, &written, nullptr) != FALSE &&
              written == requested;
    total += written;
  }
  success = success && total == length && FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  GC_WIPE_VALUE(StreamingBuffer, &buffer);
  if (!success) DeleteFileW(path);
  return success;
}

bool WriteKeyFile(
    const wchar_t* path,
    const std::array<std::uint8_t, kPkcs8Bytes>& pkcs8) noexcept {
  const HANDLE file = CreateFileW(
      path, GENERIC_WRITE, 0U, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_WRITE_THROUGH,
      nullptr);
  if (!ValidHandle(file)) return false;
  DWORD written = 0U;
  const bool success =
      WriteFile(
          file, pkcs8.data(), static_cast<DWORD>(pkcs8.size()), &written,
          nullptr) != FALSE &&
      written == pkcs8.size() && FlushFileBuffers(file) != FALSE;
  CloseHandle(file);
  if (!success) DeleteFileW(path);
  return success;
}
#endif

}  // namespace

ProtectedArtifactAuthority::ProtectedArtifactAuthority(
    ProtectedArtifactAuthority&& other) noexcept {
  MoveFrom(&other);
}

ProtectedArtifactAuthority& ProtectedArtifactAuthority::operator=(
    ProtectedArtifactAuthority&& other) noexcept {
  if (this != &other) {
    Reset();
    MoveFrom(&other);
  }
  return *this;
}

ProtectedArtifactAuthority::~ProtectedArtifactAuthority() noexcept { Reset(); }

void ProtectedArtifactAuthority::Reset() noexcept {
  if (ValidHandle(artifact_)) CloseHandle(artifact_);
  if (ValidHandle(parent_)) CloseHandle(parent_);
  if (ValidHandle(stop_event_)) CloseHandle(stop_event_);
  artifact_ = nullptr;
  parent_ = nullptr;
  stop_event_ = nullptr;
  SecureZeroMemory(&artifact_identity_, sizeof(artifact_identity_));
  SecureZeroMemory(&parent_identity_, sizeof(parent_identity_));
  SecureZeroMemory(artifact_sha256_.data(), artifact_sha256_.size());
  SecureZeroMemory(&control_, sizeof(control_));
  SecureZeroMemory(incarnation_.data(), incarnation_.size());
  purpose_ = ProtectedArtifactPurpose::RuntimeManifest;
  length_ = 0U;
  generation_ = 0U;
  deadline_ms_ = 0U;
  occupied_ = false;
  consumed_ = false;
}

void ProtectedArtifactAuthority::MoveFrom(
    ProtectedArtifactAuthority* other) noexcept {
  if (other == nullptr) return;
  artifact_ = other->artifact_;
  parent_ = other->parent_;
  stop_event_ = other->stop_event_;
  artifact_identity_ = other->artifact_identity_;
  parent_identity_ = other->parent_identity_;
  artifact_sha256_ = other->artifact_sha256_;
  control_ = other->control_;
  incarnation_ = other->incarnation_;
  purpose_ = other->purpose_;
  length_ = other->length_;
  generation_ = other->generation_;
  deadline_ms_ = other->deadline_ms_;
  occupied_ = other->occupied_;
  consumed_ = other->consumed_;
  other->artifact_ = nullptr;
  other->parent_ = nullptr;
  other->stop_event_ = nullptr;
  other->Reset();
}

ProtectedSigningLease::ProtectedSigningLease(
    ProtectedSigningLease&& other) noexcept
    : authority_(std::move(other.authority_)),
      key_file_(other.key_file_),
      key_identity_(other.key_identity_),
      key_file_sha256_(other.key_file_sha256_),
      spki_(other.spki_),
      key_id_(other.key_id_),
      current_incarnation_(other.current_incarnation_),
      current_custody_state_sha256_(other.current_custody_state_sha256_),
      current_control_(other.current_control_),
      current_purpose_(other.current_purpose_),
      current_generation_(other.current_generation_),
      consumed_(InterlockedCompareExchange(&other.consumed_, 1, 1)),
      occupied_(other.occupied_)
#if defined(GOATCITADEL_PROVISIONER_TESTING)
      , revoke_ordered_for_test_(other.revoke_ordered_for_test_)
#endif
      {
  other.key_file_ = nullptr;
  other.Reset();
  InterlockedExchange(&other.consumed_, 1);
}

ProtectedSigningLease& ProtectedSigningLease::operator=(
    ProtectedSigningLease&& other) noexcept {
  if (this != &other) {
    Reset();
    MoveFrom(&other);
  }
  return *this;
}

ProtectedSigningLease::~ProtectedSigningLease() noexcept { Reset(); }

void ProtectedSigningLease::Reset() noexcept {
  authority_.Reset();
  if (ValidHandle(key_file_)) CloseHandle(key_file_);
  key_file_ = nullptr;
  SecureZeroMemory(&key_identity_, sizeof(key_identity_));
  SecureZeroMemory(key_file_sha256_.data(), key_file_sha256_.size());
  SecureZeroMemory(spki_.data(), spki_.size());
  SecureZeroMemory(key_id_.data(), key_id_.size());
  SecureZeroMemory(current_incarnation_.data(), current_incarnation_.size());
  SecureZeroMemory(
      current_custody_state_sha256_.data(),
      current_custody_state_sha256_.size());
  SecureZeroMemory(&current_control_, sizeof(current_control_));
  current_purpose_ = ProtectedArtifactPurpose::RuntimeManifest;
  current_generation_ = 0U;
  InterlockedExchange(&consumed_, 0);
  occupied_ = false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  revoke_ordered_for_test_ = false;
#endif
}

void ProtectedSigningLease::MoveFrom(ProtectedSigningLease* other) noexcept {
  if (other == nullptr) return;
  authority_ = std::move(other->authority_);
  key_file_ = other->key_file_;
  key_identity_ = other->key_identity_;
  key_file_sha256_ = other->key_file_sha256_;
  spki_ = other->spki_;
  key_id_ = other->key_id_;
  current_incarnation_ = other->current_incarnation_;
  current_custody_state_sha256_ = other->current_custody_state_sha256_;
  current_control_ = other->current_control_;
  current_purpose_ = other->current_purpose_;
  current_generation_ = other->current_generation_;
  InterlockedExchange(
      &consumed_, InterlockedCompareExchange(&other->consumed_, 1, 1));
  occupied_ = other->occupied_;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  revoke_ordered_for_test_ = other->revoke_ordered_for_test_;
#endif
  other->key_file_ = nullptr;
  other->Reset();
  InterlockedExchange(&other->consumed_, 1);
}

bool ProtectedSigningLease::StateIsCurrent() const noexcept {
  const bool purpose_valid =
      authority_.purpose_ == ProtectedArtifactPurpose::RuntimeManifest ||
      authority_.purpose_ == ProtectedArtifactPurpose::AdmissionEvidence;
  const std::uint64_t ceiling =
      authority_.purpose_ == ProtectedArtifactPurpose::RuntimeManifest
          ? kRuntimeManifestArtifactCeiling
          : kAdmissionEvidenceArtifactCeiling;
  if (!occupied_ || !authority_.occupied_ || !authority_.consumed_ ||
      !purpose_valid || authority_.length_ > ceiling ||
      authority_.generation_ == 0U || current_generation_ == 0U ||
      AllZero(authority_.incarnation_.data(), authority_.incarnation_.size()) ||
      !ControlSnapshotValid(authority_.control_) ||
      authority_.control_.control_present ||
      current_generation_ != authority_.generation_ ||
      current_purpose_ != authority_.purpose_ ||
      !EqualBytes(
          current_incarnation_.data(), authority_.incarnation_.data(),
          current_incarnation_.size()) ||
      !EqualBytes(
          current_custody_state_sha256_.data(),
          authority_.control_.custody_state_sha256.data(),
          current_custody_state_sha256_.size()) ||
      !EqualControl(current_control_, authority_.control_) ||
      GetTickCount64() >= authority_.deadline_ms_ ||
      !ValidHandle(authority_.stop_event_)) {
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (revoke_ordered_for_test_) return false;
#endif
  return WaitForSingleObject(authority_.stop_event_, 0U) == WAIT_TIMEOUT;
}

bool ProtectedSigningLease::AuthorityIsCurrent() const noexcept {
  return StateIsCurrent() &&
         ValidateDirectory(authority_.parent_, authority_.parent_identity_) &&
         ValidateFile(
             authority_.artifact_, authority_.artifact_identity_,
             authority_.length_) &&
         ValidateFile(key_file_, key_identity_, kPkcs8Bytes);
}

bool SignProtectedArtifact(
    ProtectedSigningLease* lease,
    std::array<std::uint8_t, kSignatureBytes>* candidate_signature) noexcept {
  if (candidate_signature == nullptr) return false;
  candidate_signature->fill(0U);
  if (lease == nullptr || !lease->occupied_ ||
      InterlockedCompareExchange(&lease->consumed_, 1, 0) != 0) {
    return false;
  }
  lease->authority_.consumed_ = true;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_active_lease_for_test = lease;
#endif

  if (!GC_SIGNING_PERMIT(AfterLeaseBurn) ||
      !lease->AuthorityIsCurrent()) {
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    g_active_lease_for_test = nullptr;
#endif
    return false;
  }
  const ProtectedEd25519SigningBridgeKey bridge_key{};

  std::array<std::uint8_t, kPkcs8Bytes> pkcs8{};
  std::array<std::uint8_t, kSeedBytes> seed{};
  std::array<std::uint8_t, 64U> secret_key{};
  std::array<std::uint8_t, 64U> expanded_scalar_prefix{};
  std::array<std::uint8_t, kPublicKeyBytes> public_key{};
  std::array<std::uint8_t, kSha512Bytes> nonce_digest{};
  std::array<std::uint8_t, 32U> nonce_scalar{};
  std::array<std::uint8_t, 32U> canonical_r{};
  std::array<std::uint8_t, kSha512Bytes> challenge_digest_a{};
  std::array<std::uint8_t, kSha512Bytes> challenge_digest_b{};
  std::array<std::uint8_t, 32U> challenge_scalar_a{};
  std::array<std::uint8_t, 32U> challenge_scalar_b{};
  std::array<std::uint8_t, 32U> pass_one_sha256{};
  std::array<std::uint8_t, 32U> pass_two_sha256{};
  std::array<std::uint8_t, kSignatureBytes> local_signature{};
  std::array<std::uint8_t, kProtectedArtifactStreamingBytes> buffer{};
  StreamingHash key_id_hash;
  StreamingHash nonce_sha512;
  StreamingHash pass_one_hash;
  StreamingHash challenge_a;
  StreamingHash challenge_b;
  StreamingHash pass_two_hash;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  nonce_sha512.SetWipeLabelForTest(SigningWipeLabel::Sha512Context);
  challenge_a.SetWipeLabelForTest(SigningWipeLabel::Sha512Context);
  challenge_b.SetWipeLabelForTest(SigningWipeLabel::Sha512Context);
#endif

  bool success = false;
  do {
    if (!ReadExactKey(
            lease->key_file_, lease->key_identity_,
            lease->key_file_sha256_, &pkcs8) ||
        !GC_SIGNING_PERMIT(
            AfterKeyRead) ||
        !EqualBytes(pkcs8.data(), kPkcs8Prefix.data(), kPkcs8Prefix.size())) {
      break;
    }
    std::memcpy(
        seed.data(), pkcs8.data() + kPkcs8Prefix.size(), seed.size());
    Ed25519DerivedKeyMaterial derived{};
    if (!DeriveEd25519KeyMaterial(seed.data(), seed.size(), &derived) ||
        !EqualBytes(derived.spki.data(), lease->spki_.data(), derived.spki.size()) ||
        !EqualBytes(
            derived.public_key.data(), lease->spki_.data() + 12U,
            derived.public_key.size())) {
      WipeEd25519Owned(&derived, sizeof(derived));
      break;
    }
    std::array<std::uint8_t, 32U> derived_key_id{};
    const bool key_id_valid =
        key_id_hash.Open(BCRYPT_SHA256_ALGORITHM, derived_key_id.size()) &&
        key_id_hash.Update(derived.spki.data(), derived.spki.size()) &&
        key_id_hash.Finish(derived_key_id.data(), derived_key_id.size()) &&
        EqualBytes(
            derived_key_id.data(), lease->key_id_.data(),
            derived_key_id.size());
    SecureZeroMemory(derived_key_id.data(), derived_key_id.size());
    if (!key_id_valid) {
      WipeEd25519Owned(&derived, sizeof(derived));
      break;
    }
    std::memcpy(secret_key.data(), seed.data(), seed.size());
    std::memcpy(
        secret_key.data() + seed.size(), derived.public_key.data(),
        derived.public_key.size());
    WipeEd25519Owned(&derived, sizeof(derived));
    if (!ExpandEd25519SeedForProtectedSigning(
            bridge_key, seed.data(), expanded_scalar_prefix.data(),
            public_key.data()) ||
        !EqualBytes(
            public_key.data(), secret_key.data() + seed.size(),
            public_key.size()) ||
        !GC_SIGNING_PERMIT(
            AfterScalarExpansion)) {
      break;
    }

    if (!nonce_sha512.Open(BCRYPT_SHA512_ALGORITHM, nonce_digest.size()) ||
        !pass_one_hash.Open(BCRYPT_SHA256_ALGORITHM, pass_one_sha256.size()) ||
        !nonce_sha512.Update(
            expanded_scalar_prefix.data() + 32U, 32U) ||
        !UpdateSignatureDomain(lease->authority_.purpose_, &nonce_sha512) ||
        !Rewind(lease->authority_.artifact_)) {
      break;
    }
    std::uint64_t pass_one_count = 0U;
    if (!StreamArtifactPass(
            lease->authority_.artifact_, lease->authority_.length_,
            &nonce_sha512, nullptr, &pass_one_hash,
            GC_SIGNING_CUTPOINT_ARGUMENT(PassOneChunk)
            &buffer,
            &pass_one_count) ||
        pass_one_count != lease->authority_.length_ ||
        !pass_one_hash.Finish(
            pass_one_sha256.data(), pass_one_sha256.size()) ||
        !EqualBytes(
            pass_one_sha256.data(), lease->authority_.artifact_sha256_.data(),
            pass_one_sha256.size()) ||
        !nonce_sha512.Finish(nonce_digest.data(), nonce_digest.size())) {
      break;
    }
    ReduceEd25519ScalarForProtectedSigning(
        bridge_key, nonce_digest.data(), nonce_scalar.data());
    Ed25519ScalarBaseForProtectedSigning(
        bridge_key, nonce_scalar.data(), canonical_r.data());
    if (!GC_SIGNING_PERMIT(
            AfterCanonicalR) ||
        !lease->AuthorityIsCurrent() || !Rewind(lease->authority_.artifact_) ||
        !GC_SIGNING_PERMIT(
            AfterRewind)) {
      break;
    }

    if (!challenge_a.Open(BCRYPT_SHA512_ALGORITHM, challenge_digest_a.size()) ||
        !challenge_b.Open(BCRYPT_SHA512_ALGORITHM, challenge_digest_b.size()) ||
        !pass_two_hash.Open(BCRYPT_SHA256_ALGORITHM, pass_two_sha256.size()) ||
        !challenge_a.Update(canonical_r.data(), canonical_r.size()) ||
        !challenge_b.Update(canonical_r.data(), canonical_r.size()) ||
        !challenge_a.Update(public_key.data(), public_key.size()) ||
        !challenge_b.Update(public_key.data(), public_key.size()) ||
        !UpdateSignatureDomain(lease->authority_.purpose_, &challenge_a) ||
        !UpdateSignatureDomain(lease->authority_.purpose_, &challenge_b)) {
      break;
    }
    std::uint64_t pass_two_count = 0U;
    if (!StreamArtifactPass(
            lease->authority_.artifact_, lease->authority_.length_,
            &challenge_a, &challenge_b, &pass_two_hash,
            GC_SIGNING_CUTPOINT_ARGUMENT(PassTwoChunk)
            &buffer,
            &pass_two_count) ||
        pass_two_count != lease->authority_.length_ ||
        !pass_two_hash.Finish(
            pass_two_sha256.data(), pass_two_sha256.size()) ||
        !EqualBytes(
            pass_two_sha256.data(), lease->authority_.artifact_sha256_.data(),
            pass_two_sha256.size()) ||
        !challenge_a.Finish(
            challenge_digest_a.data(), challenge_digest_a.size()) ||
        !GC_SIGNING_PERMIT(AfterChallengeFinalizeA) ||
        !challenge_b.Finish(
            challenge_digest_b.data(), challenge_digest_b.size()) ||
        !GC_SIGNING_PERMIT(AfterChallengeFinalizeB)) {
      break;
    }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (g_divergence_for_test ==
        ProtectedSigningDivergenceForTest::ChallengeDigest) {
      challenge_digest_b[0U] ^= 0x01U;
    }
#endif
    ReduceEd25519ScalarForProtectedSigning(
        bridge_key, challenge_digest_a.data(), challenge_scalar_a.data());
    if (!GC_SIGNING_PERMIT(AfterChallengeReduceA)) break;
    ReduceEd25519ScalarForProtectedSigning(
        bridge_key, challenge_digest_b.data(), challenge_scalar_b.data());
    if (!GC_SIGNING_PERMIT(AfterChallengeReduceB)) break;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (g_divergence_for_test ==
        ProtectedSigningDivergenceForTest::ChallengeScalar) {
      challenge_scalar_b[0U] ^= 0x01U;
    }
#endif
    if (!EqualBytes(
            challenge_scalar_a.data(), challenge_scalar_b.data(),
            challenge_scalar_a.size()) ||
        !GC_SIGNING_PERMIT(
            AfterChallengeCompare)) {
      break;
    }
    std::memcpy(
        local_signature.data(), canonical_r.data(), canonical_r.size());
    Ed25519MulAddForProtectedSigning(
        bridge_key, local_signature.data() + 32U,
        challenge_scalar_a.data(), expanded_scalar_prefix.data(),
        nonce_scalar.data());
    if (!GC_SIGNING_PERMIT(
            AfterCanonicalS) ||
        !CheckEd25519EquationForProtectedSigning(
            bridge_key, local_signature.data(), public_key.data(),
            challenge_scalar_b.data()) ||
        !GC_SIGNING_PERMIT(
            AfterEquationValidation) ||
        !lease->AuthorityIsCurrent() ||
        !EqualBytes(
            pass_one_sha256.data(), pass_two_sha256.data(),
            pass_one_sha256.size())) {
      break;
    }
    std::array<std::uint8_t, kPkcs8Bytes> final_key{};
    const bool key_unchanged = ReadExactKey(
        lease->key_file_, lease->key_identity_, lease->key_file_sha256_,
        &final_key);
    GC_WIPE_VALUE(Pkcs8, &final_key);
#if defined(GOATCITADEL_PROVISIONER_TESTING)
    if (g_revoke_before_final_for_test) {
      lease->revoke_ordered_for_test_ = true;
    }
#endif
    success = key_unchanged &&
              GC_SIGNING_PERMIT(BeforeFinalRelease) &&
              lease->AuthorityIsCurrent() &&
              EqualBytes(
                  pass_one_sha256.data(),
                  lease->authority_.artifact_sha256_.data(),
                  pass_one_sha256.size());
  } while (false);

  if (success) *candidate_signature = local_signature;
  GC_WIPE_VALUE(Pkcs8, &pkcs8);
  GC_WIPE_VALUE(Seed, &seed);
  GC_WIPE_VALUE(SecretKey, &secret_key);
  GC_WIPE_VALUE(ExpandedScalarPrefix, &expanded_scalar_prefix);
  GC_WIPE_VALUE(NonceDigest, &nonce_digest);
  GC_WIPE_VALUE(NonceScalar, &nonce_scalar);
  GC_WIPE_VALUE(CanonicalR, &canonical_r);
  GC_WIPE_VALUE(ChallengeDigestA, &challenge_digest_a);
  GC_WIPE_VALUE(ChallengeDigestB, &challenge_digest_b);
  GC_WIPE_VALUE(ChallengeScalarA, &challenge_scalar_a);
  GC_WIPE_VALUE(ChallengeScalarB, &challenge_scalar_b);
  GC_WIPE_VALUE(CandidateSignature, &local_signature);
  GC_WIPE_VALUE(StreamingBuffer, &buffer);
  SecureZeroMemory(public_key.data(), public_key.size());
  SecureZeroMemory(pass_one_sha256.data(), pass_one_sha256.size());
  SecureZeroMemory(pass_two_sha256.data(), pass_two_sha256.size());
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  g_active_lease_for_test = nullptr;
#endif
  return success;
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)

bool CreateProtectedSigningLeaseForTest(
    const ProtectedSigningFactoryInputForTest& input,
    ProtectedSigningLease* output) noexcept {
  if (output == nullptr || output->occupied_ || input.isolated_root == nullptr ||
      input.isolated_root_length == 0U || input.generation == 0U ||
      input.deadline_after_ms == 0U ||
      input.deadline_after_ms > kMaximumTestDeadlineMs ||
      AllZero(input.seed.data(), input.seed.size()) ||
      AllZero(input.incarnation.data(), input.incarnation.size()) ||
      AllZero(
          input.custody_state_sha256.data(),
          input.custody_state_sha256.size()) ||
      (input.purpose != ProtectedArtifactPurpose::RuntimeManifest &&
       input.purpose != ProtectedArtifactPurpose::AdmissionEvidence)) {
    return false;
  }
  const std::uint64_t ceiling =
      input.purpose == ProtectedArtifactPurpose::RuntimeManifest
          ? kRuntimeManifestArtifactCeiling
          : kAdmissionEvidenceArtifactCeiling;
  if (input.artifact_length > ceiling) return false;

  ProtectedArtifactControlSnapshot control{};
  control.custody_state_sha256 = input.custody_state_sha256;
  if (!ControlSnapshotValid(control)) return false;

  std::array<wchar_t, kTestPathCharacters> artifact_path{};
  std::array<wchar_t, kTestPathCharacters> key_path{};
  if (!ComposeTestPath(
          input.isolated_root, input.isolated_root_length, kArtifactName,
          &artifact_path) ||
      !ComposeTestPath(
          input.isolated_root, input.isolated_root_length, kKeyName,
          &key_path)) {
    return false;
  }
  Ed25519DerivedKeyMaterial derived{};
  if (!DeriveEd25519KeyMaterial(
          input.seed.data(), input.seed.size(), &derived) ||
      !WritePatternArtifact(
          artifact_path.data(), input.artifact_length,
          input.artifact_pattern_seed) ||
      !WriteKeyFile(key_path.data(), derived.pkcs8)) {
    WipeEd25519Owned(&derived, sizeof(derived));
    DeleteFileW(artifact_path.data());
    DeleteFileW(key_path.data());
    return false;
  }

  ProtectedSigningLease candidate{};
  candidate.authority_.parent_ = CreateFileW(
      input.isolated_root, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  candidate.authority_.artifact_ = CreateFileW(
      artifact_path.data(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  candidate.key_file_ = CreateFileW(
      key_path.data(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  HANDLE stop_source = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  const std::uint64_t now = GetTickCount64();
  const bool deadline_valid =
      input.deadline_after_ms <=
      std::numeric_limits<std::uint64_t>::max() - now;
  const bool opened = ValidHandle(candidate.authority_.parent_) &&
                      ValidHandle(candidate.authority_.artifact_) &&
                      ValidHandle(candidate.key_file_) &&
                      ValidHandle(stop_source) && deadline_valid &&
                      DuplicateHandle(
                          GetCurrentProcess(), stop_source,
                          GetCurrentProcess(), &candidate.authority_.stop_event_,
                          SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, 0U) != FALSE;
  if (ValidHandle(stop_source)) CloseHandle(stop_source);
  candidate.authority_.length_ = input.artifact_length;
  candidate.authority_.purpose_ = input.purpose;
  candidate.authority_.generation_ = input.generation;
  candidate.authority_.control_ = control;
  candidate.authority_.incarnation_ = input.incarnation;
  candidate.authority_.deadline_ms_ = now + input.deadline_after_ms;
  candidate.spki_ = derived.spki;
  candidate.current_generation_ = input.generation;
  candidate.current_purpose_ = input.purpose;
  candidate.current_incarnation_ = input.incarnation;
  candidate.current_custody_state_sha256_ = input.custody_state_sha256;
  candidate.current_control_ = control;
  WipeEd25519Owned(&derived, sizeof(derived));

  StreamingHash key_id_hash;
  const bool sealed = opened &&
      CaptureIdentity(
          candidate.authority_.parent_,
          &candidate.authority_.parent_identity_) &&
      CaptureIdentity(
          candidate.authority_.artifact_,
          &candidate.authority_.artifact_identity_) &&
      CaptureIdentity(candidate.key_file_, &candidate.key_identity_) &&
      ValidateDirectory(
          candidate.authority_.parent_,
          candidate.authority_.parent_identity_) &&
      ValidateFile(
          candidate.authority_.artifact_,
          candidate.authority_.artifact_identity_, input.artifact_length) &&
      ValidateFile(candidate.key_file_, candidate.key_identity_, kPkcs8Bytes) &&
      HashOpenFile(
          candidate.authority_.artifact_, input.artifact_length,
          &candidate.authority_.artifact_sha256_) &&
      HashOpenFile(
          candidate.key_file_, kPkcs8Bytes,
          &candidate.key_file_sha256_) &&
      key_id_hash.Open(BCRYPT_SHA256_ALGORITHM, candidate.key_id_.size()) &&
      key_id_hash.Update(candidate.spki_.data(), candidate.spki_.size()) &&
      key_id_hash.Finish(candidate.key_id_.data(), candidate.key_id_.size());
  candidate.authority_.occupied_ = sealed;
  candidate.occupied_ = sealed;
  if (!sealed ||
      !GC_SIGNING_PERMIT(
          AfterFactorySealing) ||
      !GC_SIGNING_PERMIT(
          AfterLeaseIssue)) {
    candidate.Reset();
    return false;
  }
  *output = std::move(candidate);
  return output->occupied_;
}

void SetProtectedSigningFailureForTest(
    ProtectedSigningFailurePointForTest point,
    std::uint32_t fail_on_call) noexcept {
  g_failure_for_test.point = static_cast<SigningCutpoint>(point);
  g_failure_for_test.fail_on_call = fail_on_call;
  g_failure_for_test.calls = 0U;
}

void SetProtectedSigningCheckpointActionForTest(
    ProtectedSigningFailurePointForTest point,
    ProtectedSigningCheckpointActionForTest action,
    std::uint32_t act_on_call) noexcept {
  g_checkpoint_action_for_test.point = static_cast<SigningCutpoint>(point);
  g_checkpoint_action_for_test.action = action;
  g_checkpoint_action_for_test.act_on_call = act_on_call;
  g_checkpoint_action_for_test.calls = 0U;
}

void SetProtectedSigningIoFaultForTest(
    ProtectedSigningIoFaultForTest fault,
    std::uint32_t act_on_call) noexcept {
  g_io_fault_for_test = fault;
  g_io_fault_act_on_call_for_test = act_on_call;
  g_io_fault_calls_for_test = 0U;
}

void SetProtectedSigningCrashPauseForTest(
    HANDLE ready_event,
    HANDLE release_event) noexcept {
  g_crash_ready_for_test = ready_event;
  g_crash_release_for_test = release_event;
}

void SetProtectedSigningDivergenceForTest(
    ProtectedSigningDivergenceForTest divergence) noexcept {
  g_divergence_for_test = divergence;
}

void SetProtectedSigningRevokeBeforeFinalForTest(bool enabled) noexcept {
  g_revoke_before_final_for_test = enabled;
}

void SetProtectedSigningWipeObserverForTest(
    ProtectedSigningWipeObserverForTest observer) noexcept {
  g_wipe_observer_for_test = observer;
}

void ResetProtectedSigningStateForTest() noexcept {
  g_failure_for_test = {};
  g_checkpoint_action_for_test = {};
  g_io_fault_for_test = ProtectedSigningIoFaultForTest::None;
  g_io_fault_act_on_call_for_test = 0U;
  g_io_fault_calls_for_test = 0U;
  g_crash_ready_for_test = nullptr;
  g_crash_release_for_test = nullptr;
  g_divergence_for_test = ProtectedSigningDivergenceForTest::None;
  g_wipe_observer_for_test = nullptr;
  g_revoke_before_final_for_test = false;
}

void DriftProtectedSigningLeaseForTest(
    ProtectedSigningLease* lease,
    ProtectedSigningDriftForTest drift) noexcept {
  if (lease == nullptr) return;
  switch (drift) {
    case ProtectedSigningDriftForTest::Incarnation:
      lease->current_incarnation_[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::Generation:
      ++lease->current_generation_;
      break;
    case ProtectedSigningDriftForTest::Purpose:
      lease->current_purpose_ =
          lease->current_purpose_ == ProtectedArtifactPurpose::RuntimeManifest
              ? ProtectedArtifactPurpose::AdmissionEvidence
              : ProtectedArtifactPurpose::RuntimeManifest;
      break;
    case ProtectedSigningDriftForTest::CustodyState:
      lease->current_custody_state_sha256_[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::ControlPresence:
      lease->current_control_.control_present =
          !lease->current_control_.control_present;
      break;
    case ProtectedSigningDriftForTest::ControlIdentity:
      lease->current_control_.control_identity.file_id[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::ControlSha256:
      lease->current_control_.control_sha256[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::Deadline:
      lease->authority_.deadline_ms_ = GetTickCount64() - 1U;
      break;
    case ProtectedSigningDriftForTest::KeyId:
      lease->key_id_[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::ParentIdentity:
      lease->authority_.parent_identity_.file_id[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::ArtifactIdentity:
      lease->authority_.artifact_identity_.file_id[0U] ^= 0x01U;
      break;
    case ProtectedSigningDriftForTest::ArtifactLength:
      ++lease->authority_.length_;
      break;
    case ProtectedSigningDriftForTest::ArtifactSha256:
      lease->authority_.artifact_sha256_[0U] ^= 0x01U;
      break;
  }
}

bool SignalProtectedSigningStopForTest(
    ProtectedSigningLease* lease) noexcept {
  return lease != nullptr && ValidHandle(lease->authority_.stop_event_) &&
         SetEvent(lease->authority_.stop_event_) != FALSE;
}

void OrderProtectedSigningRevokeForTest(
    ProtectedSigningLease* lease) noexcept {
  if (lease != nullptr) lease->revoke_ordered_for_test_ = true;
}

bool ProtectedSigningLeaseConsumedForTest(
    const ProtectedSigningLease& lease) noexcept {
  return InterlockedCompareExchange(
             const_cast<volatile LONG*>(&lease.consumed_), 1, 1) != 0;
}

ProtectedSigningHandleSnapshotForTest ProtectedSigningHandlesForTest(
    const ProtectedSigningLease& lease) noexcept {
  return {
      lease.authority_.parent_, lease.authority_.artifact_, lease.key_file_,
      lease.authority_.stop_event_};
}

std::uint8_t ProtectedArtifactPatternByteForTest(
    std::uint64_t offset,
    std::uint8_t seed) noexcept {
  return PatternByte(offset, seed);
}

#endif

}  // namespace goatcitadel::remote_worker_provisioner
