#include "cell_volume_mount.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellVolumeMountTestPeer final {
  static DWORD Run(CellVolumeMount& owner, const CellVolumeMountBinding& binding, const CellVolumeMountCommitter& committer,
    DWORD (*verify)(void*) noexcept, DWORD (*inspect)(void*, bool, bool) noexcept,
    DWORD (*create_directory)(void*, CellFileIdentity*, DWORD (*)(void*) noexcept, void*) noexcept,
    DWORD (*mount)(void*, DWORD (*)(void*) noexcept, void*) noexcept, void* context, ULONGLONG deadline, HANDLE cancellation) {
    if (owner.attempted_) return ERROR_ALREADY_INITIALIZED;
    owner.attempted_ = true; owner.state_ = CellVolumeMountState::unknown;
    owner.binding_ = binding; owner.committer_ = committer; owner.records_.reserve(4);
    return owner.Run({verify, inspect, create_directory, mount, context}, deadline, cancellation);
  }
  static DWORD Recover(CellVolumeMount& owner, const CellVolumeMountBinding& binding,
    const std::vector<CellVolumeMountCheckpoint>& records, DWORD (*verify)(void*) noexcept,
    DWORD (*inspect)(void*, bool, bool) noexcept, void* context, ULONGLONG deadline, HANDLE cancellation) {
    if (owner.attempted_) return ERROR_ALREADY_INITIALIZED;
    owner.attempted_ = true; owner.state_ = CellVolumeMountState::unknown;
    owner.binding_ = binding; owner.records_ = records;
    return owner.Recover({verify, inspect, nullptr, nullptr, context}, deadline, cancellation);
  }
  static DWORD EmptyDirectory(HANDLE directory) { return CellVolumeMount::EmptyDirectory(directory); }
  static bool Pin(CellVolumeMount& owner, HANDLE directory) {
    return DuplicateHandle(GetCurrentProcess(), directory, GetCurrentProcess(), &owner.directory_, 0, FALSE, DUPLICATE_SAME_ACCESS);
  }
  static DWORD Capture(CellVolumeMount& owner, DWORD (*verify)(void*) noexcept,
    DWORD (*inspect)(void*, bool, bool) noexcept, void* context, DWORD limit,
    const CellFootprintScanGuard& guard, const CellCapacityMountObserver& observer) {
    return owner.ReadCapacityLeaf({verify, inspect, nullptr, nullptr, context}, limit, guard, observer);
  }
  static void Drift(CellVolumeMount& owner, unsigned kind) {
    switch (kind) {
      case 1: owner.binding_.parent.file_id[0] ^= 1; break;
      case 2: owner.binding_.volume_root.file_id[0] ^= 1; break;
      case 3: owner.binding_.volume_id.Data1 ^= 1; break;
      case 4: owner.binding_.security_sha256[0] ^= 1; break;
      case 5: owner.binding_.protection_sha256[0] ^= 1; break;
      case 6: owner.directory_identity_.file_id[0] ^= 1; break;
      case 7: owner.records_.back()[100] ^= 1; break;
      case 8: owner.folder_ += L"changed"; break;
      case 9: owner.volume_path_ += L"changed"; break;
      case 10: owner.descriptor_.push_back(1); break;
    }
  }
  // Deliberately incomplete sources contain no physical disk/volume handles;
  // native Create must fail before any directory or mount SDK call.
  static void Incomplete(CellVolumeProtection& source, bool fresh, bool attempted = false) {
    source.state_ = CellVolumeProtectionState::protected_root;
    source.freshly_protected_ = fresh; source.mount_attempted_ = attempted;
  }
};
}
namespace {
unsigned checks = 0, native_checks = 0;
std::vector<CellVolumeMountCheckpoint> golden;
void Check(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(std::string(message) + " (mount check " + std::to_string(checks) +
    ", Win32 " + std::to_string(GetLastError()) + ")");
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
CellVolumeMountBinding Binding() {
  CellVolumeMountBinding value;
  value.protection_sha256.fill(0xa1); value.security_sha256.fill(0xb2);
  value.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
  value.parent.volume_serial = 0x123456789abcdef0ULL; value.parent.file_id.fill(0xc3);
  value.volume_root.volume_serial = 0xfedcba9876543210ULL; value.volume_root.file_id.fill(0xd4);
  return value;
}
CellFileIdentity Directory() {
  CellFileIdentity value; value.volume_serial = Binding().parent.volume_serial; value.file_id.fill(0xe5); return value;
}
struct Fixture final {
  CellVolumeMount owner;
  CellFileIdentity directory = Directory();
  unsigned verifies = 0, inspections = 0, authorizations = 0, creates = 0, prepares = 0, mounts = 0;
  unsigned fail_verify = 0, fail_inspect = 0, fail_authorize = 0, fail_commit = 0, bad_ack = 0;
  DWORD create_error = 0, mount_error = 0;
  bool authorized = true, created = false, mounted = false, bad_identity = false;
  std::vector<CellVolumeMountCheckpoint> retained;
  std::function<void()> preparing, submitted, creating, directory_preparing;
  std::function<void(unsigned)> committing, authorizing;
  static DWORD Verify(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw); return ++f.verifies == f.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Inspect(void* raw, bool created, bool mounted) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.inspections;
    return f.inspections == f.fail_inspect || f.created != created || f.mounted != mounted ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Authorize(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.authorizations;
    try { if (f.authorizing) f.authorizing(f.authorizations); } catch (...) { return ERROR_GEN_FAILURE; }
    return f.authorizations == f.fail_authorize || !f.authorized ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Commit(void* raw, const CellVolumeMountCheckpoint& record, CellFileSha256* ack) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    try {
      f.retained.push_back(record); const auto count = static_cast<unsigned>(f.retained.size());
      if (f.committing) f.committing(count);
      if (f.fail_commit == count) return ERROR_TIMEOUT;
      std::copy_n(record.begin() + 480, 32, ack->begin());
      if (f.bad_ack == count) (*ack)[0] ^= 1;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD CreateDirectory(void* raw, CellFileIdentity* output, DWORD (*guard)(void*) noexcept, void* context) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    try {
      if (f.directory_preparing) f.directory_preparing();
      const auto error = guard(context);
      if (error) return error;
      if (f.retained.size() != 1 || f.created || f.mounted) return ERROR_INVALID_DATA;
      ++f.creates; f.created = true; *output = f.bad_identity ? Binding().parent : f.directory;
      if (f.creating) f.creating();
      return f.create_error;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  static DWORD Mount(void* raw, DWORD (*guard)(void*) noexcept, void* context) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.prepares;
    try {
      if (f.preparing) f.preparing();
      const auto error = guard(context);
      if (error) return error;
      if (f.retained.size() != 3 || !f.created || f.mounted) return ERROR_INVALID_DATA;
      ++f.mounts; f.mounted = true;
      if (f.submitted) f.submitted();
      return f.mount_error;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  DWORD Run(ULONGLONG deadline = GetTickCount64() + 10000, HANDLE cancellation = nullptr) {
    return CellVolumeMountTestPeer::Run(owner, Binding(), {Commit, Authorize, this}, Verify, Inspect,
      CreateDirectory, Mount, this, deadline, cancellation);
  }
  DWORD Recover(const std::vector<CellVolumeMountCheckpoint>& records, const CellVolumeMountBinding& binding = Binding(),
    HANDLE cancellation = nullptr) {
    return CellVolumeMountTestPeer::Recover(owner, binding, records, Verify, Inspect, this, GetTickCount64() + 10000, cancellation);
  }
};
void Sequence() {
  Fixture success;
  Check(success.Run() == 0, "intent, exclusive directory, exact record, mount intent and completion ordered");
  Check(success.creates == 1 && success.mounts == 1 && success.retained.size() == 4 &&
    success.owner.State() == CellVolumeMountState::mounted, "one directory and one mount require four acknowledgements");
  golden = success.retained;
  Check(success.Run() == ERROR_ALREADY_INITIALIZED, "same owner cannot retry");
  success.owner.Close();
  Check(success.owner.State() == CellVolumeMountState::unknown && success.Run() == ERROR_ALREADY_INITIALIZED,
    "close releases ownership without unmounting or permitting retry");
  for (unsigned point = 1; point <= 4; ++point) {
    for (bool mismatch : {false, true}) {
      Fixture f; if (mismatch) f.bad_ack = point; else f.fail_commit = point;
      const DWORD expected_error = mismatch ? ERROR_INVALID_DATA : ERROR_TIMEOUT;
      Check(f.Run() == expected_error, "missing or inexact ACK refuses progress");
      Check(f.owner.State() == CellVolumeMountState::unknown && f.retained.size() == point &&
        f.creates == (point == 1 ? 0U : 1U) && f.mounts == (point == 4 ? 1U : 0U), "uncertainty stops at the exact mutation boundary");
      std::vector<CellVolumeMountCheckpoint> records;
      Check(f.owner.RecordCheckpoints(&records) == 0 && records == f.retained, "attempted records remain inspectable");
      Check(f.Run() == ERROR_ALREADY_INITIALIZED, "uncertain ACK never triggers retry");
    }
  }
  for (unsigned point = 1; point <= success.authorizations; ++point) {
    Fixture f; f.fail_authorize = point;
    Check(f.Run() == ERROR_ACCESS_DENIED && f.authorizations == point && f.owner.State() == CellVolumeMountState::unknown,
      "every authority refusal stops progress");
  }
  for (unsigned point = 1; point <= success.verifies; ++point) {
    Fixture f; f.fail_verify = point;
    Check(f.Run() == ERROR_FILE_INVALID && f.verifies == point && f.owner.State() == CellVolumeMountState::unknown,
      "every identity refusal stops progress");
  }
  for (unsigned point = 1; point <= success.inspections; ++point) {
    Fixture f; f.fail_inspect = point;
    Check(f.Run() == ERROR_FILE_INVALID && f.inspections == point && f.owner.State() == CellVolumeMountState::unknown,
      "wrong aliases, mount point or permissions stop progress");
  }
  { Fixture f; f.create_error = ERROR_ALREADY_EXISTS;
    Check(f.Run() == ERROR_ALREADY_EXISTS && f.creates == 1 && !f.mounts && f.retained.size() == 1,
      "existing/uncertain directory is never adopted or replaced"); }
  { Fixture f; f.bad_identity = true;
    Check(f.Run() == ERROR_INVALID_DATA && f.creates == 1 && !f.mounts && f.retained.size() == 1,
      "created directory must have its own identity on the recorded host volume"); }
  { Fixture f; f.directory_preparing = [&] { f.authorized = false; };
    Check(f.Run() == ERROR_ACCESS_DENIED && !f.creates && !f.mounts && f.retained.size() == 1,
      "revocation during directory argument preparation prevents creation"); }
  { Fixture f; f.directory_preparing = [&] { f.fail_verify = f.verifies + 1; };
    Check(f.Run() == ERROR_FILE_INVALID && !f.creates && !f.mounts,
      "identity drift during directory argument preparation prevents creation"); }
  { Fixture f; f.mount_error = ERROR_IO_DEVICE;
    Check(f.Run() == ERROR_IO_DEVICE && f.mounts == 1 && f.retained.size() == 3 && f.owner.State() == CellVolumeMountState::unknown,
      "uncertain SDK result cannot become a mounted state"); }
  { Fixture f; f.preparing = [&] { f.authorized = false; };
    Check(f.Run() == ERROR_ACCESS_DENIED && f.prepares == 1 && !f.mounts, "revocation during SDK preparation prevents mount"); }
  { Fixture f; f.preparing = [&] { f.fail_verify = f.verifies + 1; };
    Check(f.Run() == ERROR_FILE_INVALID && !f.mounts, "identity drift during SDK preparation prevents mount"); }
  { Fixture f; f.preparing = [&] { f.mounted = true; };
    Check(f.Run() == ERROR_FILE_INVALID && !f.mounts, "unexpected mount appearing before submission is refused"); }
  { Fixture f; f.committing = [&](unsigned count) { if (count == 4) f.mounted = false; };
    Check(f.Run() == ERROR_FILE_INVALID && f.retained.size() == 4 && f.owner.State() == CellVolumeMountState::unknown,
      "final ACK cannot mask an unmounted/replaced target"); }
  { Fixture f; f.authorizing = [&](unsigned count) { if (count == success.authorizations) f.fail_verify = f.verifies + 1; };
    Check(f.Run() == ERROR_FILE_INVALID, "identity readback follows the last blocking authority callback"); }
  { Fixture f; f.authorizing = [&](unsigned count) { if (count == success.authorizations) f.mounted = false; };
    Check(f.Run() == ERROR_FILE_INVALID, "mount readback follows the last blocking authority callback"); }
  for (unsigned point = 1; point <= 4; ++point) {
    Fixture f; f.committing = [&](unsigned count) { if (count == point) f.authorized = false; };
    Check(f.Run() == ERROR_ACCESS_DENIED && f.mounts == (point == 4 ? 1U : 0U), "acknowledgement cannot mask revocation");
  }
  { Fixture f;
    Check(f.Run(GetTickCount64()) == ERROR_TIMEOUT && !f.verifies && !f.creates && !f.mounts && f.retained.empty(),
      "expired deadline prevents all callbacks"); }
  Handle cancellation{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(cancellation.value != nullptr, "cancellation event created");
  for (unsigned point = 1; point <= 4; ++point) {
    ResetEvent(cancellation.value); Fixture f;
    if (point == 1) SetEvent(cancellation.value);
    if (point == 2) f.creating = [&] { SetEvent(cancellation.value); };
    if (point == 3) f.preparing = [&] { SetEvent(cancellation.value); };
    if (point == 4) f.submitted = [&] { SetEvent(cancellation.value); };
    Check(f.Run(GetTickCount64() + 10000, cancellation.value) == ERROR_CANCELLED &&
      f.mounts == (point == 4 ? 1U : 0U) && f.owner.State() == CellVolumeMountState::unknown,
      "cancellation neither resumes nor blesses an uncertain mutation");
  }
  { Fixture f; Check(f.Run(GetTickCount64() + 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE && !f.creates,
      "invalid cancellation fails before callbacks"); }
  { Fixture f; f.created = f.mounted = true;
    Check(f.Recover(golden) == 0 && f.verifies == 2 && f.inspections == 2 && !f.creates && !f.mounts && !f.authorizations &&
      f.retained.empty() && f.owner.State() == CellVolumeMountState::mounted, "complete recovery uses only read operations");
    Check(f.Run() == ERROR_ALREADY_INITIALIZED, "recovered owner cannot create"); }
  for (unsigned count : {0U, 1U, 2U, 3U, 5U}) {
    Fixture f; auto records = golden; records.resize(count);
    Check(f.Recover(records) != 0 && !f.verifies && !f.inspections && !f.creates && !f.mounts,
      "partial and extended histories cannot reach native callbacks");
  }
  { Fixture f; f.created = true;
    Check(f.Recover(golden) == ERROR_FILE_INVALID && !f.mounts, "missing mount is never repaired during recovery"); }
  { Fixture f; f.created = f.mounted = true; f.fail_verify = 2;
    Check(f.Recover(golden) == ERROR_FILE_INVALID && !f.mounts, "recovery rechecks identities after mount readback"); }
}
void Rehash(CellVolumeMountCheckpoint& record) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "fixture hash opened");
  const auto result = BCryptHash(algorithm, nullptr, 0, record.data(), 480, record.data() + 480, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0); Check(result >= 0, "fixture hash computed");
}
void Records() {
  CellFileIdentity directory;
  Check(IsValidCellVolumeMountBinding(Binding()) && DecodeCellVolumeMountCheckpoints(Binding(), golden, &directory) == 0 && directory == Directory(),
    "exact complete chain returns recorded directory identity");
  for (std::size_t count = 1; count < 4; ++count) {
    const auto prefix = std::span(golden).first(count);
    Check(ValidateCellVolumeMountCheckpointPrefix(Binding(), prefix, &directory) == 0 &&
      directory == (count > 1 ? Directory() : CellFileIdentity{}), "incomplete history remains inspectable");
    Check(DecodeCellVolumeMountCheckpoints(Binding(), prefix, &directory) == ERROR_IO_INCOMPLETE && directory == CellFileIdentity{},
      "incomplete decoder clears execution evidence");
  }
  for (const auto& mutate : std::vector<std::function<void(CellVolumeMountBinding&)>>{
      [](auto& b) { b.protection_sha256.fill(0); }, [](auto& b) { b.security_sha256.fill(0); }, [](auto& b) { b.volume_id = {}; },
      [](auto& b) { b.parent.volume_serial = 0; }, [](auto& b) { b.parent.file_id.fill(0); },
      [](auto& b) { b.volume_root.volume_serial = 0; }, [](auto& b) { b.volume_root.file_id.fill(0); },
      [](auto& b) { b.volume_root.volume_serial = b.parent.volume_serial; }}) {
    auto binding = Binding(); mutate(binding); directory = Directory();
    Check(!IsValidCellVolumeMountBinding(binding) && DecodeCellVolumeMountCheckpoints(binding, golden, &directory) == ERROR_INVALID_PARAMETER &&
      directory == CellFileIdentity{}, "incomplete or same-volume binding refused with cleared output");
  }
  for (const auto& mutate : std::vector<std::function<void(CellVolumeMountBinding&)>>{
      [](auto& b) { b.protection_sha256[0] ^= 1; }, [](auto& b) { b.security_sha256[0] ^= 1; }, [](auto& b) { ++b.volume_id.Data1; },
      [](auto& b) { ++b.parent.volume_serial; }, [](auto& b) { b.parent.file_id[0] ^= 1; },
      [](auto& b) { ++b.volume_root.volume_serial; }, [](auto& b) { b.volume_root.file_id[0] ^= 1; }}) {
    auto binding = Binding(); mutate(binding); Fixture f;
    Check(f.Recover(golden, binding) == ERROR_INVALID_DATA && !f.verifies && !f.mounts, "foreign frozen binding fails before native operations");
  }
  for (std::size_t index = 0; index < 4; ++index) {
    for (std::size_t byte = 0; byte < 512; ++byte) {
      auto records = golden; records[index][byte] ^= 1; directory = Directory();
      Check(DecodeCellVolumeMountCheckpoints(Binding(), records, &directory) == ERROR_INVALID_DATA && directory == CellFileIdentity{},
        "every changed record byte refused with cleared output");
    }
    for (std::size_t byte : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 128U, 136U, 152U, 160U, 176U, 184U, 200U, 479U}) {
      auto records = golden; records[index][byte] ^= 1; Rehash(records[index]);
      Check(DecodeCellVolumeMountCheckpoints(Binding(), records, &directory) != 0, "rehashing does not substitute for canonical binding and history");
    }
  }
  auto swapped = golden; std::swap(swapped[1], swapped[2]);
  Check(DecodeCellVolumeMountCheckpoints(Binding(), swapped, &directory) == ERROR_INVALID_DATA, "reordered phases refused");
  Check(DecodeCellVolumeMountCheckpoints(Binding(), golden, nullptr) == ERROR_INVALID_PARAMETER, "null identity output refused");
}
void EntryPoints() {
  CellVolumeProtection source; CellWorkspaceDirectories workspace; Fixture f; CellVolumeMount owner;
  const CellVolumeMountCommitter committer{Fixture::Commit, Fixture::Authorize, &f};
  Check(owner.Create(source, workspace, committer, 10000) == ERROR_INVALID_STATE && !f.authorizations, "unprotected source refused without OS writes");
  Check(owner.Create(source, workspace, {}, 10000) == ERROR_INVALID_PARAMETER, "missing canonical callbacks refused");
  Check(owner.Create(source, workspace, committer, 0) == ERROR_INVALID_PARAMETER &&
    owner.Create(source, workspace, committer, 600001) == ERROR_INVALID_PARAMETER, "unbounded or excessive deadline refused");
  CellVolumeMountTestPeer::Incomplete(source, false);
  Check(owner.Create(source, workspace, committer, 10000) == ERROR_INVALID_STATE && !f.authorizations, "recovered protection cannot authorize a fresh mount");
  CellVolumeMountTestPeer::Incomplete(source, true, true);
  Check(owner.Create(source, workspace, committer, 10000) == ERROR_INVALID_STATE && !f.authorizations, "consumed protection cannot authorize another owner");
  CellVolumeMountTestPeer::Incomplete(source, true);
  Check(owner.Create(source, workspace, committer, 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE && !f.authorizations,
    "bad cancellation refused before binding");
  Check(owner.Create(source, workspace, committer, 10000) != 0 && owner.State() == CellVolumeMountState::unknown && f.retained.empty(),
    "incomplete source cannot acquire any mount directory");
  Check(owner.Create(source, workspace, committer, 10000) == ERROR_ALREADY_INITIALIZED, "fallible source binding consumes the owner");
  CellVolumeMount replacement;
  CellVolumeMountTestPeer::Incomplete(source, true, true);
  Check(replacement.Create(source, workspace, committer, 10000) == ERROR_INVALID_STATE, "new owner cannot retry consumed protection");
  Check(replacement.Verify(source, workspace, 10000) == ERROR_INVALID_STATE, "uncreated mount cannot verify");
  std::vector<CellVolumeMountCheckpoint> output = golden;
  Check(replacement.RecordCheckpoints(&output) == ERROR_INVALID_STATE && output.empty(), "absent evidence clears output");
  Check(replacement.RecordCheckpoints(nullptr) == ERROR_INVALID_PARAMETER, "null checkpoint output refused");
  for (unsigned count : {0U, 1U, 2U, 3U, 5U}) {
    CellVolumeMount recovery; auto records = golden; records.resize(count);
    Check(recovery.OpenRecorded(source, workspace, records, 10000) == ERROR_INVALID_PARAMETER,
      "native recovery refuses incomplete or oversized records before binding");
  }
  CellVolumeMount recovery;
  Check(recovery.OpenRecorded(source, workspace, golden, 10000) != 0 && recovery.State() == CellVolumeMountState::unknown,
    "native recovery cannot open a target from an incomplete protected source");
}
HANDLE Open(const std::wstring& path) {
  return CreateFileW(path.c_str(), FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}
void CapacityLeaf(HANDLE directory) {
  struct Capture final {
    Fixture& fixture;
    unsigned calls = 0, discards = 0, drift = 0;
    DWORD callback_error = 0;
    bool provisional = false, close = false, reenter = false;
    HANDLE cancel = nullptr;
    CellCapacityMountObserver* mutate = nullptr;
    static DWORD Read(void* raw, const CellCapacityMountLeaf& leaf) noexcept {
      auto& self = *static_cast<Capture*>(raw); ++self.calls; self.provisional = true;
      const auto before = self.fixture.authorizations;
      auto error = leaf.Check();
      if (!error && (self.fixture.authorizations != before || leaf.Target().directory != Directory() ||
          leaf.Target().parent != Binding().parent || leaf.Target().volume_root != Binding().volume_root ||
          !IsEqualGUID(leaf.Target().volume_id, Binding().volume_id))) return ERROR_INVALID_DATA;
      FILE_ID_INFO info{};
      if (!error && !GetFileInformationByHandleEx(leaf.DirectoryHandle(), FileIdInfo, &info, sizeof(info))) return ERROR_INVALID_HANDLE;
      if (self.mutate) *self.mutate = {};
      if (self.cancel) SetEvent(self.cancel);
      if (self.drift) CellVolumeMountTestPeer::Drift(self.fixture.owner, self.drift);
      if (self.close) self.fixture.owner.Close();
      if (self.reenter) {
        const CellCapacityMountObserver nested{&self, Read, Discard};
        if (CellVolumeMountTestPeer::Capture(self.fixture.owner, Fixture::Verify, Fixture::Inspect, &self.fixture,
            10000, {Fixture::Authorize, &self.fixture}, nested) != ERROR_INVALID_STATE) return ERROR_INVALID_DATA;
      }
      return error ? error : self.callback_error;
    }
    static void Discard(void* raw) noexcept {
      auto& self = *static_cast<Capture*>(raw); ++self.discards; self.provisional = false;
    }
    DWORD Run(DWORD limit = 10000, HANDLE cancellation = nullptr) {
      CellCapacityMountObserver observer{this, Read, Discard}; mutate = &observer;
      return CellVolumeMountTestPeer::Capture(fixture.owner, Fixture::Verify, Fixture::Inspect, &fixture,
        limit, {Fixture::Authorize, &fixture, cancellation}, observer);
    }
  };
  const auto prepare = [&](Fixture& fixture) {
    Check(fixture.Run() == 0 && CellVolumeMountTestPeer::Pin(fixture.owner, directory),
      "capacity fixture combines controlled mount history with a real retained ordinary-directory handle");
    fixture.authorizations = fixture.verifies = fixture.inspections = 0;
  };
  Fixture success; prepare(success); Capture capture{success};
  std::vector<CellVolumeMountCheckpoint> before, after;
  Check(success.owner.RecordCheckpoints(&before) == 0, "capture records original history");
  Check(capture.Run() == 0 && capture.calls == 1 && !capture.discards && capture.provisional && success.authorizations == 2,
    "capacity leaf checks read-only custody, freezes callbacks and bounds publication by current authority");
  Check(success.owner.RecordCheckpoints(&after) == 0 && before == after && success.creates == 1 && success.mounts == 1,
    "capacity observation appends no record and invokes no create or mount callback");
  for (unsigned at : {1U, 2U}) {
    Fixture denied; prepare(denied); denied.fail_authorize = at; Capture reading{denied};
    Check(reading.Run() == ERROR_ACCESS_DENIED && reading.calls == at - 1 && reading.discards == at - 1 && !reading.provisional,
      "revoked authority refuses early or discards once after the callback");
  }
  for (unsigned at : {1U, 2U, 3U, 4U}) {
    Fixture failed; prepare(failed); failed.fail_verify = at; Capture reading{failed};
    Check(reading.Run() == ERROR_FILE_INVALID && reading.calls == (at == 1 ? 0U : 1U) &&
      reading.discards == reading.calls && !reading.provisional, "every native readback failure withholds provisional leaf evidence");
  }
  for (unsigned kind = 1; kind <= 10; ++kind) {
    Fixture drifted; prepare(drifted); Capture reading{drifted}; reading.drift = kind;
    Check(reading.Run() == ERROR_FILE_INVALID && reading.discards == 1 && !reading.provisional,
      "binding, history, target and security drift after the callback refuses publication");
  }
  for (unsigned kind = 0; kind < 3; ++kind) {
    Fixture changed; prepare(changed); Capture reading{changed};
    reading.close = kind == 0; reading.reenter = kind == 1; reading.callback_error = kind == 2 ? ERROR_IO_INCOMPLETE : 0;
    Check(reading.Run() != 0 && reading.calls == 1 && reading.discards == 1 && !reading.provisional,
      "close, nested capture and reader errors discard exactly once");
  }
  Handle cancelled{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(cancelled.value != nullptr, "owned capacity cancellation event");
  Fixture stopped; prepare(stopped); Capture reading{stopped}; reading.cancel = cancelled.value;
  Check(reading.Run(10000, cancelled.value) == ERROR_CANCELLED && reading.discards == 1 && !reading.provisional,
    "late cancellation discards provisional capacity evidence");
  Fixture timed; prepare(timed); Capture slow{timed}; timed.authorizing = [](unsigned) { Sleep(25); };
  Check(slow.Run(10) == ERROR_TIMEOUT && !slow.calls && !slow.discards,
    "authority consumes the same bounded leaf lifetime");
  Fixture absent; Capture missing{absent}; CellVolumeProtection source; CellWorkspaceDirectories workspace;
  Check(absent.owner.WithCapacityLeaf(source, workspace, 10000, {Fixture::Authorize, &absent},
    {&missing, Capture::Read, Capture::Discard}) == ERROR_INVALID_STATE && !missing.calls,
    "production entry cannot mint a leaf from missing mounted owners");
  Check(success.owner.WithCapacityLeaf(source, workspace, 10000, {Fixture::Authorize, &success},
    {&missing, Capture::Read, Capture::Discard}) != 0 && !missing.calls,
    "controlled history and an ordinary directory cannot pass production volume verification");
}
void Native(const std::wstring& root) {
  const auto before = checks;
  Check(CreateDirectoryW(root.c_str(), nullptr), "exclusive task-owned fixture directory");
  Handle directory{Open(root)};
  Check(directory.value != INVALID_HANDLE_VALUE, "ordinary directory handle opened");
  Check(CellVolumeMountTestPeer::EmptyDirectory(directory.value) == 0, "actual empty NTFS directory accepted");
  Check(CellVolumeMountTestPeer::EmptyDirectory(directory.value) == 0, "each read restarts directory enumeration");
  Check(CellVolumeMountTestPeer::EmptyDirectory(nullptr) == ERROR_INVALID_HANDLE &&
    CellVolumeMountTestPeer::EmptyDirectory(INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE, "invalid handles refused");
  Handle hidden{CreateFileW((root + L"\\hidden").c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM, nullptr)};
  Check(hidden.value != INVALID_HANDLE_VALUE, "exclusive hidden/system fixture file created");
  Check(CellVolumeMountTestPeer::EmptyDirectory(directory.value) == ERROR_DIR_NOT_EMPTY, "hidden and system files are not an empty mount directory");
  Check(CellVolumeMountTestPeer::EmptyDirectory(directory.value) == ERROR_DIR_NOT_EMPTY, "repeated inspection cannot overlook consumed enumeration");
  Check(CellVolumeMountTestPeer::EmptyDirectory(hidden.value) != 0, "ordinary file cannot stand in for directory handle");
  CapacityLeaf(directory.value);
  native_checks = checks - before;
}
}
unsigned RunCellVolumeMountTests(const std::wstring& directory) {
  Sequence(); Records(); EntryPoints(); Native(directory); return checks;
}
DWORD RunCellVolumeMountJournalFixture(const CellVolumeMountBinding& binding, const CellVolumeMountCommitter& sink,
  unsigned* creates, unsigned* submissions, DWORD create_error, DWORD mount_error) noexcept {
  if (!creates || !submissions || !sink.commit || !sink.authorize) return ERROR_INVALID_PARAMETER;
  *creates = *submissions = 0;
  try {
    Fixture fixture; fixture.create_error = create_error; fixture.mount_error = mount_error;
    fixture.directory.volume_serial = binding.parent.volume_serial; fixture.directory.file_id.fill(0xe7);
    struct Bridge { Fixture* fixture; const CellVolumeMountCommitter* sink; } context{&fixture, &sink};
    const CellVolumeMountCommitter committer{
      [](void* raw, const CellVolumeMountCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw);
        try { value.fixture->retained.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
        return value.sink->commit(value.sink->context, record, acknowledged);
      },
      [](void* raw) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw); return value.sink->authorize(value.sink->context);
      }, &context,
    };
    const DWORD error = CellVolumeMountTestPeer::Run(fixture.owner, binding, committer, Fixture::Verify, Fixture::Inspect,
      Fixture::CreateDirectory, Fixture::Mount, &fixture, GetTickCount64() + 10000, nullptr);
    *creates = fixture.creates; *submissions = fixture.mounts;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
#ifdef GOATCITADEL_CELL_MOUNT_STANDALONE
int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 2, "fresh task-owned output required"); RunCellVolumeMountTests(argv[1]);
    std::printf("{\"passed\":true,\"checks\":%u,\"nativeDirectoryChecks\":%u,\"volumeMounted\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"rootPermissionsChanged\":false,\"records\":[", checks, native_checks);
    for (std::size_t index = 0; index < golden.size(); ++index) {
      std::printf("%s\"", index ? "," : "");
      for (const auto byte : golden[index]) std::printf("%02x", static_cast<unsigned>(byte));
      std::printf("\"");
    }
    std::puts("]}"); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
#endif
