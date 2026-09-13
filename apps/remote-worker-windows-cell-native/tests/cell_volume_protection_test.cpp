#include "cell_volume_protection.hpp"
#include "cell_security.hpp"
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellVolumeProtectionTestPeer final {
  static DWORD Run(CellVolumeProtection& owner, const CellVolumeProtectionBinding& binding,
    const CellVolumeProtectionCommitter& committer, DWORD (*verify)(void*) noexcept, DWORD (*security)(void*) noexcept,
    DWORD (*apply)(void*, DWORD (*)(void*) noexcept, void*) noexcept, void* context, ULONGLONG deadline, HANDLE cancellation) {
    if (owner.attempted_) return ERROR_ALREADY_INITIALIZED;
    owner.attempted_ = true; owner.state_ = CellVolumeProtectionState::unknown; owner.binding_ = binding;
    owner.committer_ = committer; owner.records_.reserve(2);
    return owner.Run({verify, security, apply, context}, deadline, cancellation);
  }
  static DWORD Recover(CellVolumeProtection& owner, const CellVolumeProtectionBinding& binding,
    const std::vector<CellVolumeProtectionCheckpoint>& records, DWORD (*verify)(void*) noexcept,
    DWORD (*security)(void*) noexcept, void* context, HANDLE cancellation) {
    owner.attempted_ = true; owner.state_ = CellVolumeProtectionState::unknown; owner.binding_ = binding; owner.records_ = records;
    return owner.Recover({verify, security, nullptr, context}, GetTickCount64() + 10000, cancellation);
  }
  static HANDLE OpenRoot(const std::wstring& path, bool writable) { return CellVolumeProtection::OpenRoot(path, writable); }
  static DWORD Inspect(HANDLE root, const std::wstring& path, std::uint64_t serial, CellFileIdentity* identity) {
    return CellVolumeProtection::InspectRoot(root, path, serial, identity);
  }
  static DWORD Apply(HANDLE root, const std::vector<std::uint8_t>& descriptor, DWORD (*guard)(void*) noexcept, void* context) {
    return CellVolumeProtection::ApplySecurity(root, descriptor, guard, context);
  }
  // These incomplete sources can only reach early refusal. They contain no
  // backing disk, layout, volume path or native format driver.
  static void IncompleteSource(CellNtfsFormat& source, bool fresh) {
    source.state_ = CellNtfsFormatState::formatted; source.freshly_formatted_ = fresh;
  }
};
}
namespace {
unsigned checks = 0, native_checks = 0;
std::vector<CellVolumeProtectionCheckpoint> golden;
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (protection check " + std::to_string(checks) + ", Win32 " + std::to_string(GetLastError()) + ")");
}
CellVolumeProtectionBinding Binding() {
  CellVolumeProtectionBinding value;
  value.format_sha256.fill(0xa1); value.security_sha256.fill(0xb2);
  value.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
  value.partition_bytes = 238ULL * 1024 * 1024;
  value.ntfs = {0xfedcba9876543210ULL, 487423, 60927};
  value.root.volume_serial = value.ntfs.serial; value.root.file_id.fill(0xc3);
  return value;
}
void Rehash(CellVolumeProtectionCheckpoint& record) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "fixture SHA opened");
  const auto result = BCryptHash(algorithm, nullptr, 0, record.data(), 480, record.data() + 480, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0); Check(result >= 0, "fixture SHA computed");
}
struct Fixture final {
  CellVolumeProtection owner;
  unsigned verifies = 0, securities = 0, authorizations = 0, prepares = 0, writes = 0;
  unsigned fail_verify = 0, fail_security = 0, fail_authorize = 0, fail_commit = 0, bad_ack = 0;
  DWORD submission_error = 0;
  bool authorized = true, protected_root = false;
  std::vector<CellVolumeProtectionCheckpoint> retained;
  std::function<void()> preparing, submitted;
  std::function<void(unsigned)> committing, authorizing;
  static DWORD Verify(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw); return ++f.verifies == f.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Authorize(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.authorizations;
    try { if (f.authorizing) f.authorizing(f.authorizations); } catch (...) { return ERROR_GEN_FAILURE; }
    return f.authorizations == f.fail_authorize || !f.authorized ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Security(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    return ++f.securities == f.fail_security || !f.protected_root ? ERROR_INVALID_SECURITY_DESCR : ERROR_SUCCESS;
  }
  static DWORD Commit(void* raw, const CellVolumeProtectionCheckpoint& record, CellFileSha256* acknowledgement) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    try {
      f.retained.push_back(record); const auto count = static_cast<unsigned>(f.retained.size());
      if (f.committing) f.committing(count);
      if (count == f.fail_commit) return ERROR_TIMEOUT;
      std::copy_n(record.begin() + 480, 32, acknowledgement->begin());
      if (count == f.bad_ack) (*acknowledgement)[0] ^= 1;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Apply(void* raw, DWORD (*guard)(void*) noexcept, void* context) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.prepares;
    try {
      if (f.preparing) f.preparing();
      const auto error = guard(context);
      if (error) return error;
      if (f.retained.size() != 1) return ERROR_INVALID_DATA;
      ++f.writes; f.protected_root = true;
      if (f.submitted) f.submitted();
      return f.submission_error;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  DWORD Run(ULONGLONG deadline = GetTickCount64() + 10000, HANDLE cancellation = nullptr) {
    return CellVolumeProtectionTestPeer::Run(owner, Binding(), {Commit, Authorize, this}, Verify, Security, Apply, this, deadline, cancellation);
  }
  DWORD Recover(const std::vector<CellVolumeProtectionCheckpoint>& records, HANDLE cancellation = nullptr) {
    return CellVolumeProtectionTestPeer::Recover(owner, Binding(), records, Verify, Security, this, cancellation);
  }
};
void Sequence() {
  Fixture success;
  Check(success.Run() == 0, "protection requires intent, guarded write, security readback and completion");
  Check(success.writes == 1 && success.retained.size() == 2 && success.securities == 2 &&
    success.owner.State() == CellVolumeProtectionState::protected_root, "exactly one write and two acknowledged checkpoints");
  golden = success.retained;
  Check(success.Run() == ERROR_ALREADY_INITIALIZED && success.writes == 1, "same owner cannot retry");
  success.owner.Close(); Check(success.owner.RootHandle() == nullptr && success.owner.State() == CellVolumeProtectionState::unknown,
    "close clears usability without claiming resource deletion");
  Check(success.Run() == ERROR_ALREADY_INITIALIZED, "close cannot authorize retry");
  for (unsigned point = 1; point <= 2; ++point) {
    for (bool mismatch : {false, true}) {
      Fixture f; if (mismatch) f.bad_ack = point; else f.fail_commit = point;
      const DWORD expected_error = mismatch ? ERROR_INVALID_DATA : ERROR_TIMEOUT;
      Check(f.Run() == expected_error, "missing or inexact acknowledgement refuses progress");
      Check(f.owner.State() == CellVolumeProtectionState::unknown && f.retained.size() == point &&
        f.writes == (point == 1 ? 0U : 1U), "uncertain write remains unknown at the exact boundary");
      std::vector<CellVolumeProtectionCheckpoint> records;
      Check(f.owner.RecordCheckpoints(&records) == 0 && records == f.retained, "attempted bytes remain inspectable");
    }
  }
  for (unsigned point = 1; point <= success.verifies; ++point) {
    Fixture f; f.fail_verify = point;
    Check(f.Run() == ERROR_FILE_INVALID && f.verifies == point && f.writes <= 1 &&
      f.owner.State() == CellVolumeProtectionState::unknown, "identity failure stops progress without a retry");
  }
  for (unsigned point = 1; point <= success.authorizations; ++point) {
    Fixture f; f.fail_authorize = point;
    Check(f.Run() == ERROR_ACCESS_DENIED && f.authorizations == point && f.writes <= 1 &&
      f.owner.State() == CellVolumeProtectionState::unknown, "every authority boundary refuses stale claims");
  }
  for (unsigned point = 1; point <= 2; ++point) {
    Fixture f; f.fail_security = point;
    Check(f.Run() == ERROR_INVALID_SECURITY_DESCR && f.writes == 1 && f.owner.State() == CellVolumeProtectionState::unknown,
      "ACL readback failure cannot report a protected root");
  }
  { Fixture f; f.preparing = [&] { f.authorized = false; };
    Check(f.Run() == ERROR_ACCESS_DENIED && f.prepares == 1 && !f.writes && f.retained.size() == 1,
      "revocation immediately before SDK submission prevents the write"); }
  { Fixture f; f.preparing = [&] { f.fail_verify = f.verifies + 1; };
    Check(f.Run() == ERROR_FILE_INVALID && !f.writes, "identity substitution immediately before submission prevents the write"); }
  { Fixture f; f.submission_error = ERROR_IO_DEVICE;
    Check(f.Run() == ERROR_IO_DEVICE && f.writes == 1 && f.retained.size() == 1 &&
      f.owner.State() == CellVolumeProtectionState::unknown, "uncertain security write is retained and never repeated"); }
  { Fixture f; f.committing = [&](unsigned count) { if (count == 2) f.protected_root = false; };
    Check(f.Run() == ERROR_INVALID_SECURITY_DESCR && f.retained.size() == 2,
      "post-ack permission drift prevents success"); }
  { Fixture f; f.authorizing = [&](unsigned count) { if (count == success.authorizations) f.protected_root = false; };
    Check(f.Run() == ERROR_INVALID_SECURITY_DESCR && f.owner.State() == CellVolumeProtectionState::unknown,
      "permission drift during the last authority exchange prevents success"); }
  { Fixture f; f.authorizing = [&](unsigned count) { if (count == success.authorizations) f.fail_verify = f.verifies + 1; };
    Check(f.Run() == ERROR_FILE_INVALID && f.owner.State() == CellVolumeProtectionState::unknown,
      "identity drift during the last authority exchange prevents success"); }
  for (unsigned point : {1U, 2U}) {
    Fixture f; f.committing = [&](unsigned count) { if (count == point) f.authorized = false; };
    Check(f.Run() == ERROR_ACCESS_DENIED && f.writes == (point == 1 ? 0U : 1U), "acknowledgement cannot mask revocation");
  }
  { Fixture f; Check(f.Run(GetTickCount64()) == ERROR_TIMEOUT && !f.verifies && !f.writes && f.retained.empty(),
      "expired deadline prevents all operation callbacks"); }
  Handle cancellation; cancellation.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Check(cancellation.value != nullptr, "cancellation event created");
  for (unsigned point : {1U, 2U, 3U}) {
    ResetEvent(cancellation.value); Fixture f;
    if (point == 1) SetEvent(cancellation.value);
    if (point == 2) f.preparing = [&] { SetEvent(cancellation.value); };
    if (point == 3) f.submitted = [&] { SetEvent(cancellation.value); };
    Check(f.Run(GetTickCount64() + 10000, cancellation.value) == ERROR_CANCELLED && f.writes == (point == 3 ? 1U : 0U) &&
      f.owner.State() == CellVolumeProtectionState::unknown, "cancellation never resumes or blesses an uncertain write");
  }
  { Fixture f; Check(f.Run(GetTickCount64() + 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE && !f.writes, "invalid cancellation refused"); }
  { Fixture f; f.protected_root = true;
    Check(f.Recover(golden) == 0 && !f.writes && !f.authorizations && f.retained.empty(), "complete recovery only verifies"); }
  for (unsigned count : {0U, 1U, 3U}) {
    Fixture f; f.protected_root = true; auto records = golden; records.resize(count);
    Check(f.Recover(records) != 0 && !f.writes && !f.verifies, "partial and extended recovery cannot reach native operations");
  }
  { Fixture f; Check(f.Recover(golden) == ERROR_INVALID_SECURITY_DESCR && !f.writes, "recovery never repairs changed permissions"); }
  { Fixture f; f.protected_root = true; f.fail_verify = 2;
    Check(f.Recover(golden) == ERROR_FILE_INVALID && !f.writes, "recovery rechecks identity after security readback"); }
}
void Records() {
  Check(IsValidCellVolumeProtectionBinding(Binding()) && DecodeCellVolumeProtectionCheckpoints(Binding(), golden) == 0,
    "canonical binding and complete records accepted");
  Check(ValidateCellVolumeProtectionCheckpointPrefix(Binding(), std::span(golden).first(1)) == 0 &&
    DecodeCellVolumeProtectionCheckpoints(Binding(), std::span(golden).first(1)) == ERROR_IO_INCOMPLETE,
    "inspectable intent is not complete recovery");
  for (const auto mutate : std::vector<std::function<void(CellVolumeProtectionBinding&)>>{
    [](auto& b) { b.format_sha256.fill(0); }, [](auto& b) { b.security_sha256.fill(0); }, [](auto& b) { b.volume_id = GUID{}; },
    [](auto& b) { b.partition_bytes = 0; }, [](auto& b) { ++b.partition_bytes; }, [](auto& b) { b.partition_bytes = UINT64_MAX; },
    [](auto& b) { b.ntfs.serial = 0; }, [](auto& b) { b.ntfs.sectors -= 8; }, [](auto& b) { b.ntfs.sectors += 2; },
    [](auto& b) { ++b.ntfs.clusters; }, [](auto& b) { ++b.root.volume_serial; }, [](auto& b) { b.root.file_id.fill(0); },
  }) { auto binding = Binding(); mutate(binding);
    Check(!IsValidCellVolumeProtectionBinding(binding) && DecodeCellVolumeProtectionCheckpoints(binding, golden) == ERROR_INVALID_PARAMETER,
      "missing identity or inconsistent geometry refuses recovery"); }
  for (std::size_t index = 0; index < 2; ++index) {
    for (std::size_t byte = 0; byte < 512; ++byte) {
      auto records = golden; records[index][byte] ^= 1;
      Check(DecodeCellVolumeProtectionCheckpoints(Binding(), records) == ERROR_INVALID_DATA,
        "every altered record byte is refused");
    }
    for (std::size_t byte : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 128U, 136U, 144U, 152U, 160U, 168U, 184U, 479U}) {
      auto records = golden; records[index][byte] ^= 1; Rehash(records[index]);
      Check(DecodeCellVolumeProtectionCheckpoints(Binding(), records) != 0,
        "rehashing cannot replace a binding, reserved field or predecessor");
    }
  }
  auto reordered = golden; std::swap(reordered[0], reordered[1]);
  Check(DecodeCellVolumeProtectionCheckpoints(Binding(), reordered) == ERROR_INVALID_DATA, "reordered chain refused");
}
void EntryPoints() {
  CellFileSha256 policy{};
  Check(HashCellVolumeRootSecurity(L"S-1-5-18", L"S-1-5-18", &policy) == 0, "portable root policy digest accepts fixed principals");
  CellFileSha256 other_policy{};
  Check(HashCellVolumeRootSecurity(L"S-1-5-18", L"S-1-5-21-1-2-3-4", &other_policy) == 0 && other_policy != policy,
    "portable root policy digest binds controller identity");
  Check(HashCellVolumeRootSecurity(L"S-1-5-018", L"S-1-5-18", &policy) == ERROR_INVALID_PARAMETER && policy == CellFileSha256{},
    "noncanonical policy identity refused with cleared output");
  Check(HashCellVolumeRootSecurity(L"S-1-5-18", L"S-1-5-18", nullptr) == ERROR_INVALID_PARAMETER, "null policy digest output refused");
  CellNtfsFormat source; CellWorkspaceDirectories workspace; Fixture f;
  const CellVolumeProtectionCommitter committer{Fixture::Commit, Fixture::Authorize, &f};
  CellVolumeProtection owner;
  Check(owner.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", committer, 10000) == ERROR_INVALID_STATE,
    "unformatted source cannot open or protect any volume");
  Check(owner.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", {}, 10000) == ERROR_INVALID_PARAMETER, "missing authority refused");
  Check(owner.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", committer, 0) == ERROR_INVALID_PARAMETER, "unbounded operation refused");
  Check(owner.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", committer, 600001) == ERROR_INVALID_PARAMETER, "excessive deadline refused");
  CellVolumeProtectionTestPeer::IncompleteSource(source, false);
  Check(owner.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", committer, 10000) == ERROR_INVALID_STATE && !f.authorizations,
    "recovered format state never authorizes protection writes");
  CellVolumeProtectionTestPeer::IncompleteSource(source, true); f.authorized = false;
  Check(owner.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", committer, 10000) == ERROR_ACCESS_DENIED && f.authorizations == 1,
    "fresh source requires current canonical authority before binding");
  CellVolumeProtection other;
  Check(other.Create(source, workspace, L"S-1-5-18", L"S-1-5-18", committer, 10000) == ERROR_INVALID_STATE && f.authorizations == 1,
    "a different owner cannot reuse a consumed source");
  Check(owner.RootHandle() == nullptr, "refused owner exports no root handle");
  CellFileIdentity identity = Binding().root;
  Check(owner.RecordRoot(workspace, &identity, 10000) == ERROR_INVALID_STATE && identity == CellFileIdentity{}, "invalid root output cleared");
  std::vector<CellVolumeProtectionCheckpoint> records = golden;
  Check(owner.RecordCheckpoints(&records) == ERROR_INVALID_STATE && records.empty(), "no false retained checkpoint output");
  Check(owner.RecordCheckpoints(nullptr) == ERROR_INVALID_PARAMETER, "null record output refused");
  Check(other.OpenRecorded(source, workspace, L"S-1-5-18", L"S-1-5-18", std::span(golden).first(1), 10000) == ERROR_INVALID_PARAMETER,
    "incomplete public recovery refused before binding");
}
std::wstring CurrentUser() {
  Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "fixture token opened");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> bytes{}; DWORD used = 0;
  Check(GetTokenInformation(token.value, TokenUser, bytes.data(), static_cast<DWORD>(bytes.size()), &used) != FALSE, "fixture user read");
  LPWSTR sid = nullptr;
  Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &sid) != FALSE, "fixture user converted");
  const std::wstring result(sid); LocalFree(sid); return result;
}
std::wstring GuidPath(HANDLE handle) {
  std::array<wchar_t, 2048> value{};
  const auto length = GetFinalPathNameByHandleW(handle, value.data(), static_cast<DWORD>(value.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  Check(length && length < value.size(), "fixture GUID path read"); return {value.data(), length};
}
CellFileIdentity Identity(HANDLE handle) {
  FILE_ID_INFO file{};
  Check(GetFileInformationByHandleEx(handle, FileIdInfo, &file, sizeof(file)) != FALSE, "fixture identity read");
  CellFileIdentity output; output.volume_serial = file.VolumeSerialNumber;
  std::copy(std::begin(file.FileId.Identifier), std::end(file.FileId.Identifier), output.file_id.begin()); return output;
}
std::vector<std::uint8_t> Security(HANDLE handle) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Check(GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
    DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor) == 0, "fixture security read");
  const auto* bytes = static_cast<std::uint8_t*>(descriptor);
  std::vector<std::uint8_t> output(bytes, bytes + GetSecurityDescriptorLength(descriptor)); LocalFree(descriptor); return output;
}
void NativeDirectories(const std::wstring& base) {
  const auto before = checks;
  // The harness supplies a new task-owned evidence directory. All writes below
  // stay in exclusively created child directories; no volume is attached or formatted.
  const auto path = base + L"\\protected-directory", sibling_path = base + L"\\untouched-sibling";
  Check(CreateDirectoryW(path.c_str(), nullptr) != FALSE, "exclusive scratch directory created");
  Check(CreateDirectoryW(sibling_path.c_str(), nullptr) != FALSE, "exclusive scratch sibling created");
  Handle root, sibling; root.value = CellVolumeProtectionTestPeer::OpenRoot(path, true);
  sibling.value = CellVolumeProtectionTestPeer::OpenRoot(sibling_path, false);
  Check(root.value != INVALID_HANDLE_VALUE && sibling.value != INVALID_HANDLE_VALUE, "production root opener works on task-owned NTFS directories");
  const auto user = CurrentUser(), guid_path = GuidPath(root.value);
  const auto identity = Identity(root.value), sibling_identity = Identity(sibling.value);
  const auto original = Security(root.value), sibling_security = Security(sibling.value);
  std::vector<std::uint8_t> descriptor;
  Check(BuildCellParentSecurity(user, user, &descriptor) == 0, "frozen owner/controller descriptor built");
  CellFileIdentity observed{};
  Check(CellVolumeProtectionTestPeer::Inspect(root.value, guid_path, identity.volume_serial, &observed) == 0 && observed == identity,
    "production metadata query verifies GUID name, serial, directory identity and streams");
  Check(CellVolumeProtectionTestPeer::Inspect(root.value, guid_path, identity.volume_serial ^ 1, &observed) == ERROR_FILE_INVALID && observed == CellFileIdentity{},
    "different NTFS serial refused with cleared output");
  Check(CellVolumeProtectionTestPeer::Inspect(root.value, GuidPath(sibling.value), identity.volume_serial, &observed) == ERROR_FILE_INVALID,
    "same-volume sibling cannot substitute for the recorded name");
  Check(CellVolumeProtectionTestPeer::Inspect(INVALID_HANDLE_VALUE, guid_path, identity.volume_serial, &observed) == ERROR_INVALID_HANDLE,
    "invalid native root refused");
  const auto allow = [](void*) noexcept -> DWORD { return ERROR_SUCCESS; };
  const auto deny = [](void*) noexcept -> DWORD { return ERROR_ACCESS_DENIED; };
  Check(CellVolumeProtectionTestPeer::Apply(root.value, descriptor, deny, nullptr) == ERROR_ACCESS_DENIED && Security(root.value) == original,
    "native SDK guard refuses without changing permissions");
  Check(CellVolumeProtectionTestPeer::Apply(root.value, descriptor, nullptr, nullptr) == ERROR_INVALID_PARAMETER && Security(root.value) == original,
    "missing native SDK guard refuses without a write");
  Check(CellVolumeProtectionTestPeer::Apply(root.value, {}, allow, nullptr) == ERROR_INVALID_PARAMETER,
    "empty descriptor cannot turn into a null DACL");
  Check(CellVolumeProtectionTestPeer::Apply(root.value, descriptor, allow, nullptr) == 0, "native owner/group/DACL/label write succeeds on scratch directory");
  Check(VerifyCellSecurity(root.value, descriptor) == 0, "native readback matches exact protected descriptor");
  Check(Security(sibling.value) == sibling_security && Identity(sibling.value) == sibling_identity,
    "sibling permissions and identity remain unchanged");
  Handle current; current.value = CellVolumeProtectionTestPeer::OpenRoot(path, false);
  Check(current.value != INVALID_HANDLE_VALUE && Identity(current.value) == identity && VerifyCellSecurity(current.value, descriptor) == 0,
    "read-only native reopen verifies the exact protected directory");
  Check(CellVolumeProtectionTestPeer::Apply(current.value, descriptor, allow, nullptr) == ERROR_ACCESS_DENIED,
    "recovery handle lacks security mutation rights");
  Handle writer; writer.value = CreateFileW(path.c_str(), FILE_ADD_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Check(writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION, "held root refuses a new data writer");
  Handle deleter; deleter.value = CreateFileW(path.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Check(deleter.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION, "held root refuses a delete/rename handle");
  current.Close(); root.Close();
  writer.value = CreateFileW(path.c_str(), FILE_ADD_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Check(writer.value != INVALID_HANDLE_VALUE, "fixture competing writer opened");
  root.value = CellVolumeProtectionTestPeer::OpenRoot(path, true);
  Check(root.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION, "native root opener refuses an existing data writer");
  writer.Close(); root.value = CellVolumeProtectionTestPeer::OpenRoot(path, true);
  Check(root.value != INVALID_HANDLE_VALUE, "root reopened after task-owned competing handle closed");
  const std::wstring drift = L"O:" + user + L"G:" + user + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user + L")(A;OICI;RC;;;OW)(A;;GR;;;WD)S:(ML;OICI;NW;;;ME)";
  PSECURITY_DESCRIPTOR changed = nullptr; ULONG size = 0;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(drift.c_str(), SDDL_REVISION_1, &changed, &size) != FALSE, "fixture permission drift descriptor built");
  const auto* bytes = static_cast<std::uint8_t*>(changed); std::vector<std::uint8_t> drift_bytes(bytes, bytes + size); LocalFree(changed);
  Check(CellVolumeProtectionTestPeer::Apply(root.value, drift_bytes, allow, nullptr) == 0 &&
    VerifyCellSecurity(root.value, descriptor) == ERROR_INVALID_SECURITY_DESCR, "extra grant is detected on exact security readback");
  Check(CellVolumeProtectionTestPeer::Apply(root.value, descriptor, allow, nullptr) == 0 && VerifyCellSecurity(root.value, descriptor) == 0,
    "task-owned fixture descriptor restored");
  root.Close();
  const auto ads_path = path + L":unexpected";
  Handle ads; ads.value = CreateFileW(ads_path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(ads.value != INVALID_HANDLE_VALUE, "task-owned directory alternate stream created"); ads.Close();
  root.value = CellVolumeProtectionTestPeer::OpenRoot(path, false);
  Check(root.value != INVALID_HANDLE_VALUE && CellVolumeProtectionTestPeer::Inspect(root.value, guid_path, identity.volume_serial, &observed) == ERROR_ACCESS_DENIED,
    "directory alternate stream prevents root binding");
  native_checks = checks - before;
}
}
unsigned RunCellVolumeProtectionTests(const std::wstring& directory) {
  Sequence(); Records(); EntryPoints(); NativeDirectories(directory); return checks;
}
DWORD RunCellVolumeProtectionJournalFixture(const CellVolumeProtectionBinding& binding,
  const CellVolumeProtectionCommitter& sink, unsigned* submissions, DWORD submission_error) noexcept {
  if (!submissions || !sink.commit || !sink.authorize) return ERROR_INVALID_PARAMETER;
  *submissions = 0;
  try {
    Fixture fixture; fixture.submission_error = submission_error;
    struct Bridge { Fixture* fixture; const CellVolumeProtectionCommitter* sink; } context{&fixture, &sink};
    const CellVolumeProtectionCommitter committer{
      [](void* raw, const CellVolumeProtectionCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw);
        try { value.fixture->retained.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
        return value.sink->commit(value.sink->context, record, acknowledged);
      },
      [](void* raw) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw); return value.sink->authorize(value.sink->context);
      }, &context,
    };
    const DWORD error = CellVolumeProtectionTestPeer::Run(fixture.owner, binding, committer, Fixture::Verify, Fixture::Security,
      Fixture::Apply, &fixture, GetTickCount64() + 10000, nullptr);
    *submissions = fixture.writes;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
#ifdef GOATCITADEL_CELL_PROTECTION_STANDALONE
int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 2, "fresh task-owned evidence directory required");
    RunCellVolumeProtectionTests(argv[1]);
    std::printf("{\"componentChecks\":%u,\"nativeDirectoryChecks\":%u,\"physicalVolumeProtectionExercised\":false,\"physicalFormattingExercised\":false,\"attachmentExercised\":false,\"records\":[", checks - native_checks, native_checks);
    for (std::size_t index = 0; index < golden.size(); ++index) {
      if (index) std::printf(","); std::printf("\"");
      for (auto byte : golden[index]) std::printf("%02x", byte);
      std::printf("\"");
    }
    std::printf("]}\n"); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
#endif
