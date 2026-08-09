#include "protected_artifact_signing.hpp"

#if defined(GOATCITADEL_PROVISIONER_TESTING)

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <limits>
#include <utility>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

constexpr wchar_t kArtifactName[] = L"w1b1b-p0-artifact.bin";
constexpr wchar_t kKeyName[] = L"w1b1b-p0-key.pk8";
constexpr wchar_t kRestartChildEnvironment[] =
    L"GOATCITADEL_PROTECTED_SIGNING_RESTART_CHILD";
constexpr wchar_t kRestartRootEnvironment[] =
    L"GOATCITADEL_PROTECTED_SIGNING_RESTART_ROOT";
constexpr wchar_t kRestartReadyEnvironment[] =
    L"GOATCITADEL_PROTECTED_SIGNING_RESTART_READY";
constexpr wchar_t kRestartOutputEnvironment[] =
    L"GOATCITADEL_PROTECTED_SIGNING_RESTART_OUTPUT";
constexpr wchar_t kRestartReleaseEnvironment[] =
    L"GOATCITADEL_PROTECTED_SIGNING_RESTART_RELEASE";
constexpr std::array<std::uint8_t, 32U> kRfc8032Seed = {
    0x9dU, 0x61U, 0xb1U, 0x9dU, 0xefU, 0xfdU, 0x5aU, 0x60U,
    0xbaU, 0x84U, 0x4aU, 0xf4U, 0x92U, 0xecU, 0x2cU, 0xc4U,
    0x44U, 0x49U, 0xc5U, 0x69U, 0x7bU, 0x32U, 0x69U, 0x19U,
    0x70U, 0x3bU, 0xacU, 0x03U, 0x1cU, 0xaeU, 0x7fU, 0x60U,
};
constexpr std::array<std::uint8_t, 64U> kRfc8032EmptySignature = {
    0xe5U, 0x56U, 0x43U, 0x00U, 0xc3U, 0x60U, 0xacU, 0x72U,
    0x90U, 0x86U, 0xe2U, 0xccU, 0x80U, 0x6eU, 0x82U, 0x8aU,
    0x84U, 0x87U, 0x7fU, 0x1eU, 0xb8U, 0xe5U, 0xd9U, 0x74U,
    0xd8U, 0x73U, 0xe0U, 0x65U, 0x22U, 0x49U, 0x01U, 0x55U,
    0x5fU, 0xb8U, 0x82U, 0x15U, 0x90U, 0xa3U, 0x3bU, 0xacU,
    0xc6U, 0x1eU, 0x39U, 0x70U, 0x1cU, 0xf9U, 0xb4U, 0x6bU,
    0xd2U, 0x5bU, 0xf5U, 0xf0U, 0x59U, 0x5bU, 0xbeU, 0x24U,
    0x65U, 0x51U, 0x41U, 0x43U, 0x8eU, 0x7aU, 0x10U, 0x0bU,
};
constexpr char kRfc8032PublicKeyHex[] =
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

struct ProtectedInteropReceipt final {
  gc::ProtectedArtifactPurpose purpose =
      gc::ProtectedArtifactPurpose::RuntimeManifest;
  std::uint64_t length = 0U;
  std::array<std::uint8_t, 64U> signature{};
  bool valid = false;
};

std::array<ProtectedInteropReceipt, 7U> g_interop_receipts{};

void StoreInteropReceipt(
    std::size_t index,
    gc::ProtectedArtifactPurpose purpose,
    std::uint64_t length,
    const std::array<std::uint8_t, 64U>& signature) noexcept {
  if (index >= g_interop_receipts.size()) return;
  g_interop_receipts[index].purpose = purpose;
  g_interop_receipts[index].length = length;
  g_interop_receipts[index].signature = signature;
  g_interop_receipts[index].valid = true;
}

bool EmitInteropReceipts() noexcept {
  constexpr char kHex[] = "0123456789abcdef";
  for (const auto& receipt : g_interop_receipts) {
    if (!receipt.valid) return false;
    std::array<char, 129U> signature_hex{};
    for (std::size_t index = 0U; index < receipt.signature.size(); ++index) {
      signature_hex[index * 2U] = kHex[receipt.signature[index] >> 4U];
      signature_hex[index * 2U + 1U] =
          kHex[receipt.signature[index] & 0x0fU];
    }
    std::array<char, 512U> line{};
    const char* purpose =
        receipt.purpose == gc::ProtectedArtifactPurpose::RuntimeManifest
            ? "runtime-manifest"
            : "admission-evidence";
    const int length = std::snprintf(
        line.data(), line.size(),
        "GCPW_PROTECTED_SIGNING_INTEROP schema=goatcitadel.remote-worker.protected-signing-interop.v1 purpose=%s length=%llu pattern_seed=49 public_key=%s signature=%s\n",
        purpose, static_cast<unsigned long long>(receipt.length),
        kRfc8032PublicKeyHex, signature_hex.data());
    DWORD written = 0U;
    if (length <= 0 || static_cast<std::size_t>(length) >= line.size() ||
        WriteFile(
            GetStdHandle(STD_OUTPUT_HANDLE), line.data(),
            static_cast<DWORD>(length), &written, nullptr) == FALSE ||
        written != static_cast<DWORD>(length)) {
      return false;
    }
  }
  return true;
}

bool AllZero(const void* bytes, std::size_t size) noexcept {
  if (bytes == nullptr) return false;
  const auto* current = static_cast<const std::uint8_t*>(bytes);
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | current[index]);
  }
  return aggregate == 0U;
}

std::uint8_t HexNibble(char value) noexcept {
  if (value >= '0' && value <= '9') {
    return static_cast<std::uint8_t>(value - '0');
  }
  if (value >= 'a' && value <= 'f') {
    return static_cast<std::uint8_t>(value - 'a' + 10);
  }
  return 0xffU;
}

bool EqualHex(
    const std::array<std::uint8_t, 64U>& bytes,
    const char* expected) noexcept {
  if (expected == nullptr) return false;
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < bytes.size(); ++index) {
    const std::uint8_t high = HexNibble(expected[index * 2U]);
    const std::uint8_t low = HexNibble(expected[index * 2U + 1U]);
    if (high == 0xffU || low == 0xffU) return false;
    difference = static_cast<std::uint8_t>(
        difference |
        static_cast<std::uint8_t>(
            bytes[index] ^ static_cast<std::uint8_t>((high << 4U) | low)));
  }
  return difference == 0U && expected[128U] == '\0';
}

template <std::size_t Size>
bool Equal(
    const std::array<std::uint8_t, Size>& left,
    const std::array<std::uint8_t, Size>& right) noexcept {
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < Size; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

void Record(int* failures, bool condition) noexcept {
  if (!condition && failures != nullptr) ++*failures;
}

bool HandleIsOpen(HANDLE handle) noexcept {
  DWORD flags = 0U;
  return handle != nullptr && handle != INVALID_HANDLE_VALUE &&
         GetHandleInformation(handle, &flags) != FALSE;
}

bool SnapshotHandlesOpen(
    const gc::ProtectedSigningHandleSnapshotForTest& handles) noexcept {
  return HandleIsOpen(handles.parent) && HandleIsOpen(handles.artifact) &&
         HandleIsOpen(handles.key) && HandleIsOpen(handles.stop) &&
         handles.parent != handles.artifact && handles.parent != handles.key &&
         handles.parent != handles.stop && handles.artifact != handles.key &&
         handles.artifact != handles.stop && handles.key != handles.stop;
}

bool SnapshotHandlesClosed(
    const gc::ProtectedSigningHandleSnapshotForTest& handles) noexcept {
  return !HandleIsOpen(handles.parent) && !HandleIsOpen(handles.artifact) &&
         !HandleIsOpen(handles.key) && !HandleIsOpen(handles.stop);
}

class IsolatedRoot final {
 public:
  IsolatedRoot() noexcept {
    std::array<wchar_t, MAX_PATH> temp{};
    const DWORD length = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
    if (length == 0U || length >= temp.size() ||
        GetTempFileNameW(temp.data(), L"gpb", 0U, path_.data()) == 0U ||
        DeleteFileW(path_.data()) == FALSE ||
        CreateDirectoryW(path_.data(), nullptr) == FALSE) {
      path_.fill(L'\0');
    }
  }

  IsolatedRoot(const IsolatedRoot&) = delete;
  IsolatedRoot& operator=(const IsolatedRoot&) = delete;

  ~IsolatedRoot() noexcept {
    if (!valid()) return;
    std::array<wchar_t, MAX_PATH> child{};
    Compose(kArtifactName, &child);
    DeleteFileW(child.data());
    Compose(kKeyName, &child);
    DeleteFileW(child.data());
    RemoveDirectoryW(path_.data());
  }

  bool valid() const noexcept { return path_[0U] != L'\0'; }
  const wchar_t* path() const noexcept { return path_.data(); }
  std::size_t length() const noexcept { return std::wcslen(path_.data()); }

 private:
  void Compose(
      const wchar_t* name,
      std::array<wchar_t, MAX_PATH>* output) const noexcept {
    if (name == nullptr || output == nullptr) return;
    output->fill(L'\0');
    const std::size_t root_length = length();
    if (root_length + 2U >= output->size()) return;
    std::wmemcpy(output->data(), path_.data(), root_length);
    std::size_t offset = root_length;
    if (offset != 0U && (*output)[offset - 1U] != L'\\') {
      (*output)[offset++] = L'\\';
    }
    const std::size_t name_length = std::wcslen(name);
    if (offset + name_length + 1U > output->size()) return;
    std::wmemcpy(output->data() + offset, name, name_length);
  }

  std::array<wchar_t, MAX_PATH> path_{};
};

gc::ProtectedSigningFactoryInputForTest Input(
    const IsolatedRoot& root,
    gc::ProtectedArtifactPurpose purpose,
    std::uint64_t length,
    std::uint8_t pattern = 0x31U) noexcept {
  gc::ProtectedSigningFactoryInputForTest input{};
  input.isolated_root = root.path();
  input.isolated_root_length = root.length();
  input.purpose = purpose;
  input.artifact_length = length;
  input.artifact_pattern_seed = pattern;
  input.seed = kRfc8032Seed;
  input.generation = 7U;
  input.custody_state_sha256.fill(0x42U);
  input.incarnation.fill(0x73U);
  input.deadline_after_ms = 120000U;
  return input;
}

bool CreateLease(
    const IsolatedRoot& root,
    gc::ProtectedArtifactPurpose purpose,
    std::uint64_t length,
    gc::ProtectedSigningLease* lease,
    std::uint8_t pattern = 0x31U) noexcept {
  return root.valid() && lease != nullptr &&
         gc::CreateProtectedSigningLeaseForTest(
             Input(root, purpose, length, pattern), lease);
}

std::uint32_t g_wipe_mask = 0U;
bool g_wipes_zero = true;

void ObserveWipe(
    gc::ProtectedSigningWipeLabelForTest label,
    const std::uint8_t* bytes,
    std::size_t size) noexcept {
  const std::uint32_t bit =
      UINT32_C(1) << (static_cast<std::uint32_t>(label) - 1U);
  g_wipe_mask |= bit;
  g_wipes_zero = g_wipes_zero && AllZero(bytes, size);
}

void TestRfcAndDomains(int* failures) noexcept {
  std::array<std::uint8_t, 64U> runtime_signature{};
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 0U,
            &lease) &&
            gc::SignProtectedArtifact(&lease, &runtime_signature) &&
            Equal(runtime_signature, kRfc8032EmptySignature) &&
            gc::ProtectedSigningLeaseConsumedForTest(lease));
    StoreInteropReceipt(
        0U, gc::ProtectedArtifactPurpose::RuntimeManifest, 0U,
        runtime_signature);
    std::array<std::uint8_t, 64U> replay{};
    replay.fill(0xa5U);
    Record(
        failures,
        !gc::SignProtectedArtifact(&lease, &replay) &&
            AllZero(replay.data(), replay.size()));
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> evidence_signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::AdmissionEvidence, 0U,
            &lease) &&
            gc::SignProtectedArtifact(&lease, &evidence_signature) &&
            !Equal(runtime_signature, evidence_signature));
  }
  std::array<std::uint8_t, 64U> runtime_pop_reference{};
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    Record(
        failures,
        CreateLease(
            root,
            gc::ProtectedArtifactPurpose::RuntimeManifest,
            gc::kRemoteWorkerPopV2ArtifactBytes,
            &lease) &&
            gc::SignProtectedArtifact(&lease, &runtime_pop_reference));
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> pop_signature{};
    Record(
        failures,
        CreateLease(
            root,
            gc::ProtectedArtifactPurpose::RemoteWorkerPopV2,
            gc::kRemoteWorkerPopV2ArtifactBytes,
            &lease) &&
            gc::SignProtectedArtifact(&lease, &pop_signature) &&
            Equal(runtime_pop_reference, pop_signature));
  }
  for (const std::uint64_t rejected_length : {
           gc::kRemoteWorkerPopV2ArtifactBytes - 1U,
           gc::kRemoteWorkerPopV2ArtifactBytes + 1U}) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    Record(
        failures,
        !CreateLease(
            root,
            gc::ProtectedArtifactPurpose::RemoteWorkerPopV2,
            rejected_length,
            &lease));
  }
}

void TestBoundariesAndDeterminism(int* failures) noexcept {
  constexpr std::array<std::uint64_t, 6U> kLengths = {
      1U, 65535U, 65536U, 65537U, 524287U, 524288U};
  constexpr std::array<const char*, 6U> kExpected = {
      "c62cd6daaefc806a9307e259d7c03bc422b97d37ed627526b52acc260a5457ba104f8e1ed2332fdc997dbc264aec3562067ba3f9da3c04e49573570a34ef070b",
      "242524eb90116157cb109aeb5fb00876f05fca7af687da8529234aa2b8d4566f3106c07621a8e41fbe14cda2913a1fac7062839679e584cc1a7ea541a9210a00",
      "44237e1d28a7f64bc8c1fcba6bdff55a7446596aae15dc225318a99429a2c0f77d9c43172f0315d6a1fcf55c4caa316e338189e694d6993579cd6376c7b0ca01",
      "f7bc4cb11cd902820c80e2940070a53fffd0f2d5b515081d589ab9c674d57b35bbfe017319da89c88148b4190348270eff0ae27dd2cd22b07843af362efa9908",
      nullptr,
      "7a089aadcdc7968cc6a8d7d1c9ded0251df8a8f3720711f2d986346d1375ca63e0d2211704d4fa437d15a691376178d085d38087b1394d8fe7f2d52684b88007",
  };
  for (std::size_t boundary = 0U; boundary < kLengths.size(); ++boundary) {
    const std::uint64_t length = kLengths[boundary];
    std::array<std::uint8_t, 64U> first{};
    std::array<std::uint8_t, 64U> second{};
    {
      IsolatedRoot root;
      gc::ProtectedSigningLease lease{};
      Record(
          failures,
          CreateLease(
              root, gc::ProtectedArtifactPurpose::RuntimeManifest, length,
              &lease) &&
              gc::SignProtectedArtifact(&lease, &first));
    }
    {
      IsolatedRoot root;
      gc::ProtectedSigningLease lease{};
      Record(
          failures,
          CreateLease(
              root, gc::ProtectedArtifactPurpose::RuntimeManifest, length,
              &lease) &&
              gc::SignProtectedArtifact(&lease, &second) && Equal(first, second));
    }
    if (kExpected[boundary] != nullptr) {
      Record(failures, EqualHex(first, kExpected[boundary]));
      const std::size_t receipt_index = boundary < 4U ? boundary + 1U : 5U;
      StoreInteropReceipt(
          receipt_index, gc::ProtectedArtifactPurpose::RuntimeManifest,
          length, first);
    }
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::AdmissionEvidence,
            gc::kAdmissionEvidenceArtifactCeiling, &lease) &&
            gc::SignProtectedArtifact(&lease, &signature) &&
            EqualHex(
                signature,
                "36b3b8971c86752f32f4b0fcfd7415a976ebb07d0746c77d4a7f3cab52c188e3efff813a0cf06458d84f0c38147e38ed4c8321b39ffdb1612e52603aba09f707"));
    StoreInteropReceipt(
        6U, gc::ProtectedArtifactPurpose::AdmissionEvidence,
        gc::kAdmissionEvidenceArtifactCeiling, signature);
  }
  for (const gc::ProtectedArtifactPurpose purpose : {
           gc::ProtectedArtifactPurpose::RuntimeManifest,
           gc::ProtectedArtifactPurpose::AdmissionEvidence}) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    auto input = Input(root, purpose, 0U);
    input.artifact_length =
        (purpose == gc::ProtectedArtifactPurpose::RuntimeManifest
             ? gc::kRuntimeManifestArtifactCeiling
             : gc::kAdmissionEvidenceArtifactCeiling) +
        1U;
    Record(
        failures,
        !gc::CreateProtectedSigningLeaseForTest(input, &lease));
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    auto input = Input(
        root, gc::ProtectedArtifactPurpose::RuntimeManifest,
        std::numeric_limits<std::uint64_t>::max());
    Record(failures, !gc::CreateProtectedSigningLeaseForTest(input, &lease));
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    auto input = Input(
        root, gc::ProtectedArtifactPurpose::RuntimeManifest, 0U);
    input.deadline_after_ms = std::numeric_limits<std::uint64_t>::max();
    Record(failures, !gc::CreateProtectedSigningLeaseForTest(input, &lease));
  }
}

void TestMoveDriftStopAndRevoke(int* failures) noexcept {
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease source{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 17U,
            &source));
    gc::ProtectedSigningLease destination(std::move(source));
    std::array<std::uint8_t, 64U> rejected{};
    std::array<std::uint8_t, 64U> accepted{};
    Record(
        failures,
        !gc::SignProtectedArtifact(&source, &rejected) &&
            gc::SignProtectedArtifact(&destination, &accepted));
  }
  constexpr std::array<gc::ProtectedSigningDriftForTest, 9U> kDrifts = {
      gc::ProtectedSigningDriftForTest::Incarnation,
      gc::ProtectedSigningDriftForTest::Generation,
      gc::ProtectedSigningDriftForTest::Purpose,
      gc::ProtectedSigningDriftForTest::CustodyState,
      gc::ProtectedSigningDriftForTest::ControlPresence,
      gc::ProtectedSigningDriftForTest::ControlIdentity,
      gc::ProtectedSigningDriftForTest::ControlSha256,
      gc::ProtectedSigningDriftForTest::Deadline,
      gc::ProtectedSigningDriftForTest::KeyId,
  };
  for (const auto drift : kDrifts) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
            &lease));
    gc::DriftProtectedSigningLeaseForTest(&lease, drift);
    Record(
        failures,
        !gc::SignProtectedArtifact(&lease, &signature) &&
            AllZero(signature.data(), signature.size()));
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
            &lease) &&
            gc::SignalProtectedSigningStopForTest(&lease) &&
            !gc::SignProtectedArtifact(&lease, &signature));
  }
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
            &lease));
    gc::SetProtectedSigningRevokeBeforeFinalForTest(true);
    Record(failures, !gc::SignProtectedArtifact(&lease, &signature));
    gc::ResetProtectedSigningStateForTest();
  }
}

void TestDivergenceFailureCutsAndWipes(int* failures) noexcept {
  DWORD handle_baseline = 0U;
  Record(
      failures,
      GetProcessHandleCount(GetCurrentProcess(), &handle_baseline) != FALSE);
  for (const auto divergence : {
           gc::ProtectedSigningDivergenceForTest::ChallengeDigest,
           gc::ProtectedSigningDivergenceForTest::ChallengeScalar}) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 3U,
            &lease));
    const auto handles = gc::ProtectedSigningHandlesForTest(lease);
    Record(failures, SnapshotHandlesOpen(handles));
    g_wipe_mask = 0U;
    g_wipes_zero = true;
    gc::SetProtectedSigningWipeObserverForTest(&ObserveWipe);
    gc::SetProtectedSigningDivergenceForTest(divergence);
    constexpr std::uint32_t kAllWipeLabels =
        (UINT32_C(1) << 15U) - 1U;
    Record(
        failures,
        !gc::SignProtectedArtifact(&lease, &signature) &&
            AllZero(signature.data(), signature.size()) && g_wipes_zero &&
            (g_wipe_mask & kAllWipeLabels) == kAllWipeLabels);
    gc::ResetProtectedSigningStateForTest();
    lease = gc::ProtectedSigningLease{};
    Record(failures, SnapshotHandlesClosed(handles));
  }

  constexpr std::array<gc::ProtectedSigningFailurePointForTest, 15U> kSignCuts = {
      gc::ProtectedSigningFailurePointForTest::AfterLeaseBurn,
      gc::ProtectedSigningFailurePointForTest::AfterKeyRead,
      gc::ProtectedSigningFailurePointForTest::AfterScalarExpansion,
      gc::ProtectedSigningFailurePointForTest::PassOneChunk,
      gc::ProtectedSigningFailurePointForTest::AfterCanonicalR,
      gc::ProtectedSigningFailurePointForTest::AfterRewind,
      gc::ProtectedSigningFailurePointForTest::PassTwoChunk,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeFinalizeA,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeFinalizeB,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeReduceA,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeReduceB,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeCompare,
      gc::ProtectedSigningFailurePointForTest::AfterCanonicalS,
      gc::ProtectedSigningFailurePointForTest::AfterEquationValidation,
      gc::ProtectedSigningFailurePointForTest::BeforeFinalRelease,
  };
  for (const auto cut : kSignCuts) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
            &lease));
    const auto handles = gc::ProtectedSigningHandlesForTest(lease);
    Record(failures, SnapshotHandlesOpen(handles));
    g_wipe_mask = 0U;
    g_wipes_zero = true;
    gc::SetProtectedSigningWipeObserverForTest(&ObserveWipe);
    gc::SetProtectedSigningFailureForTest(cut, 1U);
    const std::uint32_t required_wipes =
        cut == gc::ProtectedSigningFailurePointForTest::AfterLeaseBurn
            ? 0U
            : (UINT32_C(1) << 15U) - 1U;
    Record(
        failures,
        !gc::SignProtectedArtifact(&lease, &signature) &&
            AllZero(signature.data(), signature.size()) && g_wipes_zero &&
            (g_wipe_mask & required_wipes) == required_wipes);
    gc::ResetProtectedSigningStateForTest();
    lease = gc::ProtectedSigningLease{};
    Record(failures, SnapshotHandlesClosed(handles));
  }
  for (const auto cut : {
           gc::ProtectedSigningFailurePointForTest::PassOneChunk,
           gc::ProtectedSigningFailurePointForTest::PassTwoChunk}) {
    for (std::uint32_t chunk_call = 2U; chunk_call <= 128U; ++chunk_call) {
      IsolatedRoot root;
      gc::ProtectedSigningLease lease{};
      std::array<std::uint8_t, 64U> signature{};
      g_wipe_mask = 0U;
      g_wipes_zero = true;
      Record(
          failures,
          CreateLease(
              root, gc::ProtectedArtifactPurpose::AdmissionEvidence,
              gc::kAdmissionEvidenceArtifactCeiling, &lease));
      const auto handles = gc::ProtectedSigningHandlesForTest(lease);
      Record(failures, SnapshotHandlesOpen(handles));
      gc::SetProtectedSigningWipeObserverForTest(&ObserveWipe);
      gc::SetProtectedSigningFailureForTest(cut, chunk_call);
      constexpr std::uint32_t kScratchWipes =
          (UINT32_C(1) << 15U) - 1U;
      Record(
          failures,
          !gc::SignProtectedArtifact(&lease, &signature) &&
              AllZero(signature.data(), signature.size()) && g_wipes_zero &&
              (g_wipe_mask & kScratchWipes) == kScratchWipes);
      gc::ResetProtectedSigningStateForTest();
      lease = gc::ProtectedSigningLease{};
      Record(failures, SnapshotHandlesClosed(handles));
    }
  }

  constexpr std::array<gc::ProtectedSigningCheckpointActionForTest, 13U>
      kCheckpointActions = {
          gc::ProtectedSigningCheckpointActionForTest::DriftGeneration,
          gc::ProtectedSigningCheckpointActionForTest::DriftParentIdentity,
          gc::ProtectedSigningCheckpointActionForTest::DriftArtifactIdentity,
          gc::ProtectedSigningCheckpointActionForTest::DriftArtifactLength,
          gc::ProtectedSigningCheckpointActionForTest::DriftArtifactSha256,
          gc::ProtectedSigningCheckpointActionForTest::SignalStop,
          gc::ProtectedSigningCheckpointActionForTest::OrderRevoke,
          gc::ProtectedSigningCheckpointActionForTest::DriftPurpose,
          gc::ProtectedSigningCheckpointActionForTest::DriftCustodyState,
          gc::ProtectedSigningCheckpointActionForTest::DriftControlPresence,
          gc::ProtectedSigningCheckpointActionForTest::DriftControlIdentity,
          gc::ProtectedSigningCheckpointActionForTest::DriftControlSha256,
          gc::ProtectedSigningCheckpointActionForTest::DriftDeadline,
      };
  for (const auto cut : kSignCuts) {
    for (const auto action : kCheckpointActions) {
      IsolatedRoot root;
      gc::ProtectedSigningLease lease{};
      std::array<std::uint8_t, 64U> signature{};
      const bool chunk =
          cut == gc::ProtectedSigningFailurePointForTest::PassOneChunk ||
          cut == gc::ProtectedSigningFailurePointForTest::PassTwoChunk;
      Record(
          failures,
          CreateLease(
              root, gc::ProtectedArtifactPurpose::RuntimeManifest,
              chunk ? 65537U : 1U, &lease));
      const auto handles = gc::ProtectedSigningHandlesForTest(lease);
      Record(failures, SnapshotHandlesOpen(handles));
      gc::SetProtectedSigningCheckpointActionForTest(
          cut, action, chunk ? 2U : 1U);
      g_wipe_mask = 0U;
      g_wipes_zero = true;
      gc::SetProtectedSigningWipeObserverForTest(&ObserveWipe);
      const std::uint32_t required_action_wipes =
          cut == gc::ProtectedSigningFailurePointForTest::AfterLeaseBurn
              ? 0U
              : (UINT32_C(1) << 15U) - 1U;
      Record(
          failures,
          !gc::SignProtectedArtifact(&lease, &signature) &&
              AllZero(signature.data(), signature.size()) && g_wipes_zero &&
              (g_wipe_mask & required_action_wipes) == required_action_wipes);
      gc::ResetProtectedSigningStateForTest();
      lease = gc::ProtectedSigningLease{};
      Record(failures, SnapshotHandlesClosed(handles));
    }
  }

  for (const auto cut : {
           gc::ProtectedSigningFailurePointForTest::AfterFactorySealing,
           gc::ProtectedSigningFailurePointForTest::AfterLeaseIssue}) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    gc::SetProtectedSigningFailureForTest(cut, 1U);
    Record(
        failures,
        !gc::CreateProtectedSigningLeaseForTest(
            Input(
                root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U),
            &lease));
    Record(
        failures,
        SnapshotHandlesClosed(gc::ProtectedSigningHandlesForTest(lease)));
    gc::ResetProtectedSigningStateForTest();
  }

  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    g_wipe_mask = 0U;
    g_wipes_zero = true;
    gc::SetProtectedSigningWipeObserverForTest(&ObserveWipe);
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
            &lease) &&
            gc::SignProtectedArtifact(&lease, &signature));
    constexpr std::uint32_t kAllWipeLabels = (UINT32_C(1) << 15U) - 1U;
    Record(failures, g_wipes_zero && (g_wipe_mask & kAllWipeLabels) == kAllWipeLabels);
    gc::ResetProtectedSigningStateForTest();
  }
  DWORD handle_after = 0U;
  Record(
      failures,
      GetProcessHandleCount(GetCurrentProcess(), &handle_after) != FALSE &&
          handle_baseline == handle_after);
}

struct ConcurrentArgs final {
  gc::ProtectedSigningLease* lease = nullptr;
  HANDLE start = nullptr;
  std::array<std::uint8_t, 64U> signature{};
  bool success = false;
};

DWORD WINAPI ConcurrentSign(void* context) noexcept {
  auto* args = static_cast<ConcurrentArgs*>(context);
  if (args == nullptr || WaitForSingleObject(args->start, 10000U) != WAIT_OBJECT_0) {
    return 1U;
  }
  args->success = gc::SignProtectedArtifact(args->lease, &args->signature);
  return 0U;
}

void TestConcurrencyAndHandleStability(int* failures) noexcept {
  DWORD before = 0U;
  DWORD after = 0U;
  Record(failures, GetProcessHandleCount(GetCurrentProcess(), &before) != FALSE);
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest, 65537U,
            &lease));
    HANDLE start = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    ConcurrentArgs first{&lease, start};
    ConcurrentArgs second{&lease, start};
    HANDLE first_thread = CreateThread(nullptr, 0U, &ConcurrentSign, &first, 0U, nullptr);
    HANDLE second_thread = CreateThread(nullptr, 0U, &ConcurrentSign, &second, 0U, nullptr);
    const bool launched = start != nullptr && first_thread != nullptr &&
                          second_thread != nullptr && SetEvent(start) != FALSE;
    if (launched) {
      const std::array<HANDLE, 2U> threads = {first_thread, second_thread};
      Record(
          failures,
          WaitForMultipleObjects(
              static_cast<DWORD>(threads.size()), threads.data(), TRUE,
              30000U) == WAIT_OBJECT_0 &&
              (first.success != second.success));
    } else {
      Record(failures, false);
    }
    if (first_thread != nullptr) CloseHandle(first_thread);
    if (second_thread != nullptr) CloseHandle(second_thread);
    if (start != nullptr) CloseHandle(start);
  }
  Record(
      failures,
      GetProcessHandleCount(GetCurrentProcess(), &after) != FALSE &&
          before == after);
}

void TestPostWarmHandleStabilityAcrossCuts(int* failures) noexcept {
  gc::ProtectedSigningHandleSnapshotForTest success_handles{};
  {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    const bool created = CreateLease(
        root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U, &lease);
    success_handles = gc::ProtectedSigningHandlesForTest(lease);
    Record(
        failures,
        created && SnapshotHandlesOpen(success_handles) &&
            gc::SignProtectedArtifact(&lease, &signature));
  }
  Record(failures, SnapshotHandlesClosed(success_handles));
  DWORD before = 0U;
  Record(failures, GetProcessHandleCount(GetCurrentProcess(), &before) != FALSE);
  constexpr std::array<gc::ProtectedSigningFailurePointForTest, 15U> kCuts = {
      gc::ProtectedSigningFailurePointForTest::AfterLeaseBurn,
      gc::ProtectedSigningFailurePointForTest::AfterKeyRead,
      gc::ProtectedSigningFailurePointForTest::AfterScalarExpansion,
      gc::ProtectedSigningFailurePointForTest::PassOneChunk,
      gc::ProtectedSigningFailurePointForTest::AfterCanonicalR,
      gc::ProtectedSigningFailurePointForTest::AfterRewind,
      gc::ProtectedSigningFailurePointForTest::PassTwoChunk,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeFinalizeA,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeFinalizeB,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeReduceA,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeReduceB,
      gc::ProtectedSigningFailurePointForTest::AfterChallengeCompare,
      gc::ProtectedSigningFailurePointForTest::AfterCanonicalS,
      gc::ProtectedSigningFailurePointForTest::AfterEquationValidation,
      gc::ProtectedSigningFailurePointForTest::BeforeFinalRelease,
  };
  for (const auto cut : kCuts) {
    gc::ProtectedSigningHandleSnapshotForTest cut_handles{};
    {
      IsolatedRoot root;
      gc::ProtectedSigningLease lease{};
      std::array<std::uint8_t, 64U> signature{};
      const bool created = CreateLease(
          root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U, &lease);
      cut_handles = gc::ProtectedSigningHandlesForTest(lease);
      Record(failures, created && SnapshotHandlesOpen(cut_handles));
      gc::SetProtectedSigningFailureForTest(cut, 1U);
      Record(failures, !gc::SignProtectedArtifact(&lease, &signature));
      gc::ResetProtectedSigningStateForTest();
    }
    Record(failures, SnapshotHandlesClosed(cut_handles));
  }
  DWORD after = 0U;
  Record(
      failures,
      GetProcessHandleCount(GetCurrentProcess(), &after) != FALSE &&
          before == after);
}

void TestIoFailureSeams(int* failures) noexcept {
  struct IoCase final {
    gc::ProtectedSigningIoFaultForTest fault;
    std::uint32_t act_on_call;
    std::uint64_t length;
  };
  constexpr std::array<IoCase, 5U> kCases = {{
      {gc::ProtectedSigningIoFaultForTest::ShortRead, 1U, 65537U},
      {gc::ProtectedSigningIoFaultForTest::PrematureEof, 2U, 65537U},
      {gc::ProtectedSigningIoFaultForTest::TrailingByte, 1U, 1U},
      {gc::ProtectedSigningIoFaultForTest::FailedRewind, 2U, 1U},
      {gc::ProtectedSigningIoFaultForTest::SeekMismatch, 2U, 1U},
  }};
  for (const auto& test_case : kCases) {
    IsolatedRoot root;
    gc::ProtectedSigningLease lease{};
    std::array<std::uint8_t, 64U> signature{};
    Record(
        failures,
        CreateLease(
            root, gc::ProtectedArtifactPurpose::RuntimeManifest,
            test_case.length, &lease));
    const auto handles = gc::ProtectedSigningHandlesForTest(lease);
    Record(failures, SnapshotHandlesOpen(handles));
    gc::SetProtectedSigningIoFaultForTest(
        test_case.fault, test_case.act_on_call);
    g_wipe_mask = 0U;
    g_wipes_zero = true;
    gc::SetProtectedSigningWipeObserverForTest(&ObserveWipe);
    constexpr std::uint32_t kAllWipeLabels =
        (UINT32_C(1) << 15U) - 1U;
    Record(
        failures,
        !gc::SignProtectedArtifact(&lease, &signature) &&
            AllZero(signature.data(), signature.size()) && g_wipes_zero &&
            (g_wipe_mask & kAllWipeLabels) == kAllWipeLabels);
    gc::ResetProtectedSigningStateForTest();
    lease = gc::ProtectedSigningLease{};
    Record(failures, SnapshotHandlesClosed(handles));
  }
}

void TestDeterministicSignerCorpus(int* failures) noexcept {
  constexpr std::uint32_t kSeed = UINT32_C(0x47504357);
  constexpr std::uint32_t kProofCases = UINT32_C(65536);
  IsolatedRoot consumed_root;
  IsolatedRoot moved_root;
  gc::ProtectedSigningLease consumed{};
  gc::ProtectedSigningLease moved_source{};
  const bool prepared_consumed = CreateLease(
      consumed_root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
      &consumed);
  std::array<std::uint8_t, 64U> preparation_signature{};
  const bool consumed_once =
      prepared_consumed &&
      gc::SignProtectedArtifact(&consumed, &preparation_signature);
  const bool prepared_moved = CreateLease(
      moved_root, gc::ProtectedArtifactPurpose::RuntimeManifest, 1U,
      &moved_source);
  gc::ProtectedSigningLease moved_destination(std::move(moved_source));
  gc::ProtectedSigningLease empty{};
  std::uint32_t state = kSeed;
  std::uint32_t passed = 0U;
  for (std::uint32_t index = 0U; index < kProofCases; ++index) {
    state = state * UINT32_C(1664525) + UINT32_C(1013904223);
    bool case_passed = false;
    if ((index & UINT32_C(0xfff)) == 0U) {
      IsolatedRoot root;
      gc::ProtectedSigningLease lease{};
      std::array<std::uint8_t, 64U> signature{};
      const bool created = CreateLease(
          root, gc::ProtectedArtifactPurpose::RuntimeManifest, 65537U,
          &lease);
      switch ((state >> 24U) & 3U) {
        case 0U:
          gc::SetProtectedSigningFailureForTest(
              gc::ProtectedSigningFailurePointForTest::PassOneChunk, 1U);
          break;
        case 1U:
          gc::SetProtectedSigningFailureForTest(
              gc::ProtectedSigningFailurePointForTest::PassTwoChunk, 2U);
          break;
        case 2U:
          gc::SetProtectedSigningIoFaultForTest(
              gc::ProtectedSigningIoFaultForTest::ShortRead, 1U);
          break;
        case 3U:
          gc::SetProtectedSigningIoFaultForTest(
              gc::ProtectedSigningIoFaultForTest::TrailingByte, 1U);
          break;
      }
      case_passed =
          created && !gc::SignProtectedArtifact(&lease, &signature) &&
          AllZero(signature.data(), signature.size());
      gc::ResetProtectedSigningStateForTest();
    } else {
      std::array<std::uint8_t, 64U> signature{};
      signature.fill(0xa5U);
      switch ((state >> 24U) % 5U) {
        case 0U:
          case_passed = !gc::SignProtectedArtifact(nullptr, &signature) &&
                        AllZero(signature.data(), signature.size());
          break;
        case 1U:
          case_passed = !gc::SignProtectedArtifact(&empty, &signature) &&
                        AllZero(signature.data(), signature.size());
          break;
        case 2U:
          case_passed = !gc::SignProtectedArtifact(&moved_source, &signature) &&
                        AllZero(signature.data(), signature.size());
          break;
        case 3U:
          case_passed = !gc::SignProtectedArtifact(&consumed, &signature) &&
                        AllZero(signature.data(), signature.size());
          break;
        case 4U:
          case_passed = !gc::SignProtectedArtifact(&empty, nullptr);
          break;
      }
    }
    if (case_passed) ++passed;
  }
  Record(
      failures,
      consumed_once && prepared_moved && passed == kProofCases &&
          !gc::ProtectedSigningLeaseConsumedForTest(moved_destination));
}

int RestartChildMode() noexcept {
  std::array<wchar_t, 2U> value{};
  if (GetEnvironmentVariableW(
          kRestartChildEnvironment, value.data(),
          static_cast<DWORD>(value.size())) != 1U) {
    return 0;
  }
  return value[0U] == L'1' ? 1 : (value[0U] == L'2' ? 2 : 0);
}

int RunRestartProbeChild() noexcept {
  std::array<wchar_t, MAX_PATH> root{};
  const DWORD root_length = GetEnvironmentVariableW(
      kRestartRootEnvironment, root.data(), static_cast<DWORD>(root.size()));
  if (root_length == 0U || root_length >= root.size() ||
      root_length + 3U > root.size()) {
    return 1;
  }
  root[root_length] = L'\\';
  root[root_length + 1U] = L'*';
  root[root_length + 2U] = L'\0';
  WIN32_FIND_DATAW entry{};
  HANDLE search = FindFirstFileW(root.data(), &entry);
  bool artifact_seen = false;
  bool key_seen = false;
  bool unexpected_seen = search == INVALID_HANDLE_VALUE;
  if (search != INVALID_HANDLE_VALUE) {
    do {
      if (std::wcscmp(entry.cFileName, L".") == 0 ||
          std::wcscmp(entry.cFileName, L"..") == 0) {
        continue;
      }
      if (std::wcscmp(entry.cFileName, kArtifactName) == 0) {
        artifact_seen = true;
      } else if (std::wcscmp(entry.cFileName, kKeyName) == 0) {
        key_seen = true;
      } else {
        unexpected_seen = true;
      }
    } while (FindNextFileW(search, &entry) != FALSE);
    FindClose(search);
  }
  gc::ProtectedSigningLease empty{};
  std::array<std::uint8_t, 64U> signature{};
  return artifact_seen && key_seen && !unexpected_seen &&
                 !gc::SignProtectedArtifact(&empty, &signature) &&
                 AllZero(signature.data(), signature.size())
             ? 0
             : 1;
}

HANDLE HandleFromEnvironment(const wchar_t* name) noexcept {
  std::array<wchar_t, 32U> value{};
  const DWORD length = GetEnvironmentVariableW(
      name, value.data(), static_cast<DWORD>(value.size()));
  if (length == 0U || length >= value.size()) return nullptr;
  wchar_t* end = nullptr;
  const unsigned long long raw = std::wcstoull(value.data(), &end, 10);
  return end != value.data() && *end == L'\0'
             ? reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(raw))
             : nullptr;
}

int RunRestartCrashChild() noexcept {
  std::array<wchar_t, MAX_PATH> root{};
  const DWORD root_length = GetEnvironmentVariableW(
      kRestartRootEnvironment, root.data(), static_cast<DWORD>(root.size()));
  HANDLE ready = HandleFromEnvironment(kRestartReadyEnvironment);
  HANDLE release = HandleFromEnvironment(kRestartReleaseEnvironment);
  HANDLE signature_mapping = HandleFromEnvironment(kRestartOutputEnvironment);
  if (root_length == 0U || root_length >= root.size() || ready == nullptr ||
      release == nullptr || signature_mapping == nullptr) {
    return 1;
  }
  void* signature_view =
      MapViewOfFile(signature_mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0U, 0U, 64U);
  if (signature_view == nullptr) return 1;
  gc::ProtectedSigningFactoryInputForTest input{};
  input.isolated_root = root.data();
  input.isolated_root_length = root_length;
  input.purpose = gc::ProtectedArtifactPurpose::RuntimeManifest;
  input.artifact_length = 17U;
  input.artifact_pattern_seed = 0x31U;
  input.seed = kRfc8032Seed;
  input.generation = 7U;
  input.custody_state_sha256.fill(0x42U);
  input.incarnation.fill(0x73U);
  input.deadline_after_ms = 120000U;
  gc::ProtectedSigningLease issued_lease{};
  if (!gc::CreateProtectedSigningLeaseForTest(input, &issued_lease)) {
    UnmapViewOfFile(signature_view);
    return 1;
  }
  gc::SetProtectedSigningCrashPauseForTest(ready, release);
  gc::SetProtectedSigningCheckpointActionForTest(
      gc::ProtectedSigningFailurePointForTest::AfterKeyRead,
      gc::ProtectedSigningCheckpointActionForTest::PauseForCrash, 1U);
  const bool signed_artifact = gc::SignProtectedArtifact(
      &issued_lease,
      static_cast<std::array<std::uint8_t, 64U>*>(signature_view));
  UnmapViewOfFile(signature_view);
  return signed_artifact ? 0 : 1;
}

void TestCrashRestartInvalidation(int* failures) noexcept {
  IsolatedRoot child_root;

  std::array<wchar_t, 32768U> executable{};
  const DWORD executable_length = GetModuleFileNameW(
      nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  std::array<wchar_t, 32768U + 3U> command{};
  bool command_valid =
      executable_length != 0U && executable_length < executable.size() &&
      static_cast<std::size_t>(executable_length) + 3U <= command.size();
  if (command_valid) {
    command[0U] = L'"';
    std::wmemcpy(command.data() + 1U, executable.data(), executable_length);
    command[static_cast<std::size_t>(executable_length) + 1U] = L'"';
  }

  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE ready = CreateEventW(&security, TRUE, FALSE, nullptr);
  HANDLE release = CreateEventW(&security, TRUE, FALSE, nullptr);
  HANDLE signature_mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE, &security, PAGE_READWRITE, 0U, 64U, nullptr);
  auto* signature_view = static_cast<std::uint8_t*>(MapViewOfFile(
      signature_mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0U, 0U, 64U));
  if (signature_view != nullptr) {
    std::memset(signature_view, 0xa5, 64U);
  }
  HANDLE null_output = CreateFileW(
      L"NUL", GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = null_output;
  startup.hStdOutput = null_output;
  startup.hStdError = null_output;
  PROCESS_INFORMATION process{};
  std::array<wchar_t, 32U> ready_value{};
  std::array<wchar_t, 32U> release_value{};
  std::array<wchar_t, 32U> output_value{};
  std::swprintf(
      ready_value.data(), ready_value.size(), L"%llu",
      static_cast<unsigned long long>(
          reinterpret_cast<std::uintptr_t>(ready)));
  std::swprintf(
      release_value.data(), release_value.size(), L"%llu",
      static_cast<unsigned long long>(
          reinterpret_cast<std::uintptr_t>(release)));
  std::swprintf(
      output_value.data(), output_value.size(), L"%llu",
      static_cast<unsigned long long>(
          reinterpret_cast<std::uintptr_t>(signature_mapping)));
  const bool environment_set =
      SetEnvironmentVariableW(kRestartChildEnvironment, L"1") != FALSE &&
      SetEnvironmentVariableW(kRestartRootEnvironment, child_root.path()) != FALSE &&
      SetEnvironmentVariableW(kRestartReadyEnvironment, ready_value.data()) != FALSE &&
      SetEnvironmentVariableW(kRestartReleaseEnvironment, release_value.data()) != FALSE &&
      SetEnvironmentVariableW(kRestartOutputEnvironment, output_value.data()) != FALSE;
  const bool launched =
      command_valid && ready != nullptr && release != nullptr &&
      signature_mapping != nullptr && signature_view != nullptr &&
      null_output != INVALID_HANDLE_VALUE && environment_set &&
      CreateProcessW(
          nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
          nullptr, nullptr, &startup, &process) != FALSE;
  SetEnvironmentVariableW(kRestartChildEnvironment, nullptr);
  SetEnvironmentVariableW(kRestartRootEnvironment, nullptr);
  SetEnvironmentVariableW(kRestartReadyEnvironment, nullptr);
  SetEnvironmentVariableW(kRestartReleaseEnvironment, nullptr);
  SetEnvironmentVariableW(kRestartOutputEnvironment, nullptr);
  const bool ready_before_crash =
      launched && WaitForSingleObject(ready, 60000U) == WAIT_OBJECT_0;
  const bool signature_channel_empty =
      ready_before_crash && AllZero(signature_view, 64U);
  constexpr DWORD kCrashExit = UINT32_C(0x47504357);
  const bool terminated =
      ready_before_crash && TerminateProcess(process.hProcess, kCrashExit) != FALSE &&
      WaitForSingleObject(process.hProcess, 60000U) == WAIT_OBJECT_0;
  DWORD exit_code = 0U;
  const bool crashed =
      terminated && GetExitCodeProcess(process.hProcess, &exit_code) != FALSE &&
      exit_code == kCrashExit;
  if (process.hThread != nullptr) CloseHandle(process.hThread);
  if (process.hProcess != nullptr) CloseHandle(process.hProcess);
  if (signature_view != nullptr) UnmapViewOfFile(signature_view);
  if (signature_mapping != nullptr) CloseHandle(signature_mapping);
  if (release != nullptr) CloseHandle(release);
  if (ready != nullptr) CloseHandle(ready);

  command.fill(L'\0');
  if (command_valid) {
    command[0U] = L'"';
    std::wmemcpy(command.data() + 1U, executable.data(), executable_length);
    command[static_cast<std::size_t>(executable_length) + 1U] = L'"';
  }
  PROCESS_INFORMATION restart_process{};
  const bool restart_environment_set =
      SetEnvironmentVariableW(kRestartChildEnvironment, L"2") != FALSE &&
      SetEnvironmentVariableW(kRestartRootEnvironment, child_root.path()) != FALSE;
  const bool restart_launched =
      crashed && restart_environment_set &&
      CreateProcessW(
          nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
          nullptr, nullptr, &startup, &restart_process) != FALSE;
  SetEnvironmentVariableW(kRestartChildEnvironment, nullptr);
  SetEnvironmentVariableW(kRestartRootEnvironment, nullptr);
  DWORD restart_exit = 1U;
  const bool restart_rejected_recovery =
      restart_launched &&
      WaitForSingleObject(restart_process.hProcess, 60000U) == WAIT_OBJECT_0 &&
      GetExitCodeProcess(restart_process.hProcess, &restart_exit) != FALSE &&
      restart_exit == 0U;
  if (restart_process.hThread != nullptr) CloseHandle(restart_process.hThread);
  if (restart_process.hProcess != nullptr) CloseHandle(restart_process.hProcess);
  if (null_output != INVALID_HANDLE_VALUE) CloseHandle(null_output);

  std::array<wchar_t, MAX_PATH> serialized_lease{};
  const int serialized_length = std::swprintf(
      serialized_lease.data(), serialized_lease.size(), L"%ls\\w1b1b-p0-lease.bin",
      child_root.path());
  Record(
      failures,
      crashed && signature_channel_empty && restart_rejected_recovery &&
          serialized_length > 0 &&
          GetFileAttributesW(serialized_lease.data()) == INVALID_FILE_ATTRIBUTES &&
          child_root.valid());
}

}  // namespace

int RunProtectedArtifactSigningTests() noexcept {
  const int restart_child_mode = RestartChildMode();
  if (restart_child_mode == 1) {
    return RunRestartCrashChild();
  }
  if (restart_child_mode == 2) {
    ExitProcess(static_cast<UINT>(RunRestartProbeChild()));
  }
  int failures = 0;
  g_interop_receipts = {};
  gc::ResetProtectedSigningStateForTest();
  TestRfcAndDomains(&failures);
  TestBoundariesAndDeterminism(&failures);
  TestMoveDriftStopAndRevoke(&failures);
  TestDivergenceFailureCutsAndWipes(&failures);
  TestIoFailureSeams(&failures);
  TestConcurrencyAndHandleStability(&failures);
  TestPostWarmHandleStabilityAcrossCuts(&failures);
  TestDeterministicSignerCorpus(&failures);
  TestCrashRestartInvalidation(&failures);
  if (failures == 0 && !EmitInteropReceipts()) ++failures;
  gc::ResetProtectedSigningStateForTest();
  return failures;
}

#endif
