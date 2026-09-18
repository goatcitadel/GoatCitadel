#include "cell_provisioning_journal.hpp"
#include "cell_security.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace goatcitadel::worker_cell {
// Fault injection through the already-held fixture handle. Opening another
// writer is correctly excluded; NTFS trims spare allocation on writer cleanup.
struct CellProvisioningJournalTestPeer final {
  template <typename Host, typename Guest>
  static DWORD Joined(CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor, const CellFileSha256& head,
    CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& guard, const CellFootprintCellBinding& binding, void* context, Host host, Guest guest,
    CellProvisioningJoinedCapacity* output) {
    return journal.ReadJoinedCapacity(anchor, head, layout, record, limits, guard, binding, {context, host, guest}, output);
  }
  static HANDLE File(const CellProvisioningJournal& journal) { return journal.file_; }
  static DWORD RunVolume(CellProvisioningJournal& journal, const CellVolumeProvisioningCommitter& sink,
    DWORD (*verify)(void*) noexcept, DWORD (*attach)(void*) noexcept,
    DWORD (*layout)(void*, const CellDiskLayoutCommitter&) noexcept, void* context) {
    return journal.RunVolume({verify, attach, layout, context}, sink, GetTickCount64() + 10000, nullptr);
  }
  static DWORD ReadMetadata(CellProvisioningJournal& journal) { return journal.ReadJournal(); }
  static DWORD Observe(CellProvisioningJournal& journal, DWORD (*read)(void*, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellDirectoryFootprint*) noexcept, void* context, const CellProvisioningAnchor& anchor,
    const CellFileSha256& head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    CellProvisioningFootprint* output) {
    return journal.ReadMountedFootprint(read, context, anchor, head, limits, guard, output);
  }
  static void DriftCapacityBinding(CellProvisioningJournal& journal, unsigned kind) {
    if (kind == 1) journal.anchor_.file.file_id.back() ^= 1;
    if (kind == 2) journal.anchor_.prepared_sha256.back() ^= 1;
    if (kind == 3) journal.plan_.assignment_binding.back() ^= 1;
    if (kind == 4) journal.plan_.profile_sha256.back() ^= 1;
    if (kind == 5) journal.plan_.disk.virtual_bytes ^= 2 * 1024 * 1024;
    if (kind == 6) journal.plan_.disk.reserved_file_bytes ^= 2 * 1024 * 1024;
    if (kind == 7) journal.plan_.disk.identifier.Data1 ^= 1;
    if (kind == 8) journal.name_.back() ^= 1;
    if (kind == 9) journal.owner_.back() ^= 1;
    if (kind == 10) journal.controller_.back() ^= 1;
    if (kind == 11) journal.records_.back() ^= 1;
    if (kind == 12) journal.mounted_workspace_records_.back().back() ^= 1;
    if (kind == 13) journal.healthy_ = !journal.healthy_;
    if (kind == 14) journal.creating_ = !journal.creating_;
    if (kind == 15) journal.lifetime_revision_ ^= 1;
  }
  static DWORD Observe(CellProvisioningJournal& journal, DWORD (*read)(void*, const CellFootprintScanLimits&,
    const CellFootprintScanGuard&, CellDirectoryInventory*) noexcept, void* context, const CellProvisioningAnchor& anchor,
    const CellFileSha256& head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    CellProvisioningInventory* output, const CellFootprintCellBinding* binding = nullptr) {
    return journal.ReadMountedInventory(read, context, anchor, head, limits, guard, output, binding);
  }
  static DWORD RunFormat(CellProvisioningJournal& journal, const CellFormatProvisioningCommitter& sink,
    DWORD (*verify)(void*) noexcept, DWORD (*format)(void*, const CellNtfsFormatCommitter&) noexcept,
    void* context, HANDLE cancellation) {
    return journal.RunFormat({verify, format, context}, sink, GetTickCount64() + 10000, cancellation);
  }
  static DWORD RunProtection(CellProvisioningJournal& journal, const CellProtectionProvisioningCommitter& sink,
    DWORD (*verify)(void*) noexcept, DWORD (*protect)(void*, const CellVolumeProtectionCommitter&) noexcept,
    void* context, HANDLE cancellation) {
    return journal.RunProtection({verify, protect, context}, sink, GetTickCount64() + 10000, cancellation);
  }
  static DWORD RunMount(CellProvisioningJournal& journal, const CellMountProvisioningCommitter& sink,
    DWORD (*verify)(void*) noexcept, DWORD (*mount)(void*, const CellVolumeMountCommitter&) noexcept,
    void* context, HANDLE cancellation) {
    return journal.RunMount({verify, mount, context}, sink, GetTickCount64() + 10000, cancellation);
  }
  static DWORD RunMountedWorkspace(CellProvisioningJournal& journal, const CellMountedWorkspaceProvisioningCommitter& sink,
    DWORD (*verify)(void*) noexcept, DWORD (*create)(void*, const CellMountedWorkspaceCommitter&) noexcept,
    void* context, HANDLE cancellation) {
    return journal.RunMountedWorkspace({verify, create, context}, sink, GetTickCount64() + 10000, cancellation);
  }
  static const std::vector<std::uint8_t>& Bytes(const CellProvisioningJournal& journal) { return journal.records_; }
  static DWORD OpenMetadata(CellProvisioningJournal& journal, HANDLE parent, const CellFileIdentity& identity,
    const std::wstring& name, const std::wstring& user, const CellProvisioningPlan& plan, const CellProvisioningAnchor& anchor) {
    DWORD error = journal.Initialize(parent, identity, name, user, user, plan);
    journal.anchor_ = anchor;
    if (!error) error = journal.OpenFile(false);
    if (!error) error = journal.ReadJournal();
    return error;
  }
};
}
using namespace goatcitadel::worker_cell;
DWORD RunCellVirtualDiskLayoutJournalFixture(const CellDiskLayoutPlan&, const CellDiskLayoutCommitter&) noexcept;
DWORD RunCellNtfsFormatJournalFixture(const CellNtfsFormatBinding&, const CellNtfsFormatCommitter&, unsigned*, DWORD) noexcept;
DWORD RunCellVolumeProtectionJournalFixture(const CellVolumeProtectionBinding&, const CellVolumeProtectionCommitter&, unsigned*, DWORD) noexcept;
DWORD RunCellVolumeMountJournalFixture(const CellVolumeMountBinding&, const CellVolumeMountCommitter&, unsigned*, unsigned*, DWORD, DWORD) noexcept;
DWORD RunCellMountedWorkspaceJournalFixture(const CellMountedWorkspaceBinding&, const CellMountedWorkspaceCommitter&, unsigned*, unsigned) noexcept;
namespace {
unsigned checks = 0;
bool recovery_verified = false;
std::vector<CellProvisioningRecord> committed_records;
CellDiskLayoutPlan committed_layout;
std::vector<CellVolumeProvisioningRecord> committed_volume;
std::vector<CellProvisioningRecord> committed_volume_base;
std::vector<CellProvisioningRecord> committed_format_history;
std::vector<CellProvisioningRecord> committed_protection_history;
std::vector<CellProvisioningRecord> committed_mount_history;
std::vector<CellProvisioningRecord> committed_mounted_workspace_history;
struct CommitFixture final {
  unsigned refused_phase = 0, wrong_ack_phase = 0;
  std::vector<CellProvisioningRecord> attempted, committed;
  static DWORD Commit(void* context, const CellProvisioningRecord& record, CellFileSha256* acknowledgement) noexcept {
    try {
      if (!context || !acknowledgement) return ERROR_INVALID_PARAMETER;
      auto& state = *static_cast<CommitFixture*>(context);
      state.attempted.push_back(record);
      const unsigned phase = record[8];
      if (phase != state.attempted.size()) return ERROR_INVALID_DATA;
      if (phase == state.refused_phase) return ERROR_ACCESS_DENIED;
      std::copy_n(record.end() - acknowledgement->size(), acknowledgement->size(), acknowledgement->begin());
      if (phase == state.wrong_ack_phase) (*acknowledgement)[0] ^= 1;
      else state.committed.push_back(record);
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
};
struct VolumeFixture final {
  CellProvisioningJournal* journal;
  CellDiskLayoutPlan plan;
  unsigned fail = 0, wrong = 0, authorizations = 0, refuse_authorization = 0, attaches = 0, layouts = 0;
  bool revoke_after_layout = false, revoked = false;
  std::vector<CellVolumeProvisioningRecord> attempted, committed;
  static DWORD Authorize(void* context) noexcept {
    auto& self = *static_cast<VolumeFixture*>(context);
    return ++self.authorizations == self.refuse_authorization || self.revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* context) noexcept {
    auto& self = *static_cast<VolumeFixture*>(context);
    if (self.revoke_after_layout && self.committed.size() == 6) self.revoked = true;
    return ERROR_SUCCESS; // Driver is a fixture, never an actual attached disk.
  }
  static DWORD Attach(void* context) noexcept {
    auto& self = *static_cast<VolumeFixture*>(context);
    if (self.committed.size() != 1 || self.attaches) return ERROR_INVALID_STATE;
    ++self.attaches;
    return ERROR_SUCCESS;
  }
  static DWORD Layout(void* context, const CellDiskLayoutCommitter& sink) noexcept {
    auto& self = *static_cast<VolumeFixture*>(context);
    if (self.committed.size() != 2 || self.attaches != 1 || self.layouts) return ERROR_INVALID_STATE;
    ++self.layouts;
    return RunCellVirtualDiskLayoutJournalFixture(self.plan, sink);
  }
  static DWORD Commit(void* context, const CellVolumeProvisioningRecord& record, CellFileSha256* acknowledgement) noexcept {
    try {
      auto& self = *static_cast<VolumeFixture*>(context);
      self.attempted.push_back(record);
      const auto& bytes = CellProvisioningJournalTestPeer::Bytes(*self.journal);
      if (CellProvisioningJournalTestPeer::ReadMetadata(*self.journal) || bytes.size() != 5120 + self.attempted.size() * 1024 ||
          !std::equal(record.begin(), record.end(), bytes.end() - 1024) || record[8] != self.attempted.size()) return ERROR_INVALID_DATA;
      if (record[8] == self.fail) return ERROR_BROKEN_PIPE;
      std::copy_n(record.end() - acknowledgement->size(), acknowledgement->size(), acknowledgement->begin());
      if (record[8] == self.wrong) (*acknowledgement)[0] ^= 1;
      else self.committed.push_back(record);
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  CellVolumeProvisioningCommitter Committer() { return {Commit, Authorize, this}; }
  DWORD Run() {
    return CellProvisioningJournalTestPeer::RunVolume(*journal, Committer(), Verify, Attach, Layout, this);
  }
};
struct FormatFixture final {
  CellProvisioningJournal* journal;
  CellNtfsFormatBinding binding;
  unsigned fail = 0, wrong = 0, revoke_after_commit = 0, authorizations = 0, submissions = 0;
  DWORD submission_error = 0;
  bool revoked = false, revoke_after_verify = false;
  HANDLE cancellation = nullptr;
  std::vector<CellFormatProvisioningRecord> attempted, committed;
  static DWORD Authorize(void* context) noexcept {
    auto& self = *static_cast<FormatFixture*>(context); ++self.authorizations;
    return self.revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* context) noexcept {
    auto& self = *static_cast<FormatFixture*>(context);
    if (self.revoke_after_verify && self.committed.size() == 2) self.revoked = true;
    return ERROR_SUCCESS; // The formatter exercises its real sequence against a controlled RAW/NTFS driver.
  }
  static DWORD Format(void* context, const CellNtfsFormatCommitter& sink) noexcept {
    auto& self = *static_cast<FormatFixture*>(context);
    return RunCellNtfsFormatJournalFixture(self.binding, sink, &self.submissions, self.submission_error);
  }
  static DWORD Commit(void* context, const CellFormatProvisioningRecord& record, CellFileSha256* acknowledgement) noexcept {
    try {
      auto& self = *static_cast<FormatFixture*>(context);
      self.attempted.push_back(record);
      const auto& bytes = CellProvisioningJournalTestPeer::Bytes(*self.journal);
      if (CellProvisioningJournalTestPeer::ReadMetadata(*self.journal) || bytes.size() != 11264 + self.attempted.size() * 1024 ||
          !std::equal(record.begin(), record.end(), bytes.end() - 1024) || record[8] != self.attempted.size()) return ERROR_INVALID_DATA;
      if (record[8] == self.fail) return ERROR_BROKEN_PIPE;
      std::copy_n(record.end() - acknowledgement->size(), acknowledgement->size(), acknowledgement->begin());
      if (record[8] == self.wrong) (*acknowledgement)[0] ^= 1;
      else self.committed.push_back(record);
      if (record[8] == self.revoke_after_commit) self.revoked = true;
      if (self.cancellation) SetEvent(self.cancellation);
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  CellFormatProvisioningCommitter Committer() { return {Commit, Authorize, this}; }
  DWORD Run() {
    return CellProvisioningJournalTestPeer::RunFormat(*journal, Committer(), Verify, Format, this, cancellation);
  }
};
struct ProtectionFixture final {
  CellProvisioningJournal* journal;
  CellVolumeProtectionBinding binding;
  unsigned fail = 0, wrong = 0, revoke_after_commit = 0, authorizations = 0, submissions = 0;
  DWORD submission_error = 0;
  bool revoked = false, revoke_after_verify = false;
  HANDLE cancellation = nullptr;
  std::vector<CellProtectionProvisioningRecord> attempted, committed;
  static DWORD Authorize(void* context) noexcept {
    auto& self = *static_cast<ProtectionFixture*>(context); ++self.authorizations;
    return self.revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* context) noexcept {
    auto& self = *static_cast<ProtectionFixture*>(context);
    if (self.revoke_after_verify && self.committed.size() == 2) self.revoked = true;
    return ERROR_SUCCESS; // Controlled driver; the physical volume is never attached or protected here.
  }
  static DWORD Protect(void* context, const CellVolumeProtectionCommitter& sink) noexcept {
    auto& self = *static_cast<ProtectionFixture*>(context);
    return RunCellVolumeProtectionJournalFixture(self.binding, sink, &self.submissions, self.submission_error);
  }
  static DWORD Commit(void* context, const CellProtectionProvisioningRecord& record, CellFileSha256* acknowledgement) noexcept {
    try {
      auto& self = *static_cast<ProtectionFixture*>(context);
      self.attempted.push_back(record);
      const auto& bytes = CellProvisioningJournalTestPeer::Bytes(*self.journal);
      if (CellProvisioningJournalTestPeer::ReadMetadata(*self.journal) || bytes.size() != 13312 + self.attempted.size() * 1024 ||
          !std::equal(record.begin(), record.end(), bytes.end() - 1024) || record[8] != self.attempted.size()) return ERROR_INVALID_DATA;
      if (record[8] == self.fail) return ERROR_BROKEN_PIPE;
      std::copy_n(record.end() - 32, 32, acknowledgement->begin());
      if (record[8] == self.wrong) (*acknowledgement)[0] ^= 1;
      else self.committed.push_back(record);
      if (record[8] == self.revoke_after_commit) self.revoked = true;
      if (self.cancellation) SetEvent(self.cancellation);
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  CellProtectionProvisioningCommitter Committer() { return {Commit, Authorize, this}; }
  DWORD Run() {
    return CellProvisioningJournalTestPeer::RunProtection(*journal, Committer(), Verify, Protect, this, cancellation);
  }
};
struct MountFixture final {
  CellProvisioningJournal* journal;
  CellVolumeMountBinding binding;
  unsigned fail = 0, wrong = 0, revoke_after_commit = 0, authorizations = 0, creates = 0, submissions = 0;
  unsigned verifies = 0, fail_verify = 0, cancel_after_commit = 0;
  DWORD create_error = 0, mount_error = 0;
  bool revoked = false, revoke_after_verify = false;
  HANDLE cancellation = nullptr;
  std::vector<CellMountProvisioningRecord> attempted, committed;
  static DWORD Authorize(void* context) noexcept {
    auto& self = *static_cast<MountFixture*>(context); ++self.authorizations;
    return self.revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* context) noexcept {
    auto& self = *static_cast<MountFixture*>(context); ++self.verifies;
    if (self.revoke_after_verify && self.committed.size() == 4) self.revoked = true;
    // Controlled SDK driver. Its journal file is real; the VHDX stays unattached.
    return self.verifies == self.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Mount(void* context, const CellVolumeMountCommitter& sink) noexcept {
    auto& self = *static_cast<MountFixture*>(context);
    return RunCellVolumeMountJournalFixture(self.binding, sink, &self.creates, &self.submissions, self.create_error, self.mount_error);
  }
  static DWORD Commit(void* context, const CellMountProvisioningRecord& record, CellFileSha256* acknowledgement) noexcept {
    try {
      auto& self = *static_cast<MountFixture*>(context);
      self.attempted.push_back(record);
      const auto& bytes = CellProvisioningJournalTestPeer::Bytes(*self.journal);
      if (CellProvisioningJournalTestPeer::ReadMetadata(*self.journal) || bytes.size() != 15360 + self.attempted.size() * 1024 ||
          !std::equal(record.begin(), record.end(), bytes.end() - 1024) || record[8] != self.attempted.size()) return ERROR_INVALID_DATA;
      if (record[8] == self.fail) return ERROR_BROKEN_PIPE;
      std::copy_n(record.end() - 32, 32, acknowledgement->begin());
      if (record[8] == self.wrong) (*acknowledgement)[0] ^= 1;
      else self.committed.push_back(record);
      if (record[8] == self.revoke_after_commit) self.revoked = true;
      if (self.cancellation && record[8] == self.cancel_after_commit) SetEvent(self.cancellation);
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  CellMountProvisioningCommitter Committer() { return {Commit, Authorize, this}; }
  DWORD Run() {
    return CellProvisioningJournalTestPeer::RunMount(*journal, Committer(), Verify, Mount, this, cancellation);
  }
};
struct MountedWorkspaceFixture final {
  CellProvisioningJournal* journal;
  CellMountedWorkspaceBinding binding;
  unsigned fail = 0, wrong = 0, revoke_after_commit = 0, authorizations = 0, creates = 0;
  unsigned verifies = 0, fail_verify = 0, cancel_after_commit = 0, fail_create = 0;
  bool revoked = false, revoke_after_verify = false, corrupt_after_intent = false, corrupted = false;
  HANDLE cancellation = nullptr;
  std::vector<CellMountedWorkspaceProvisioningRecord> attempted, committed;
  static DWORD Authorize(void* context) noexcept {
    auto& self = *static_cast<MountedWorkspaceFixture*>(context); ++self.authorizations;
    if (self.corrupt_after_intent && !self.corrupted && self.committed.size() == 1) {
      const auto file = CellProvisioningJournalTestPeer::File(*self.journal);
      LARGE_INTEGER start{}; DWORD written = 0; const std::uint8_t corrupt = 'X';
      if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN) || !WriteFile(file, &corrupt, 1, &written, nullptr) ||
          written != 1 || !FlushFileBuffers(file)) return ERROR_WRITE_FAULT;
      self.corrupted = true;
    }
    return self.revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Verify(void* context) noexcept {
    auto& self = *static_cast<MountedWorkspaceFixture*>(context); ++self.verifies;
    if (self.revoke_after_verify && self.committed.size() == 2) self.revoked = true;
    return self.verifies == self.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Create(void* context, const CellMountedWorkspaceCommitter& sink) noexcept {
    auto& self = *static_cast<MountedWorkspaceFixture*>(context);
    return RunCellMountedWorkspaceJournalFixture(self.binding, sink, &self.creates, self.fail_create);
  }
  static DWORD Commit(void* context, const CellMountedWorkspaceProvisioningRecord& record, CellFileSha256* acknowledgement) noexcept {
    try {
      auto& self = *static_cast<MountedWorkspaceFixture*>(context); self.attempted.push_back(record);
      const auto& bytes = CellProvisioningJournalTestPeer::Bytes(*self.journal);
      if (CellProvisioningJournalTestPeer::ReadMetadata(*self.journal) || bytes.size() != 19456 + self.attempted.size() * 1024 ||
          !std::equal(record.begin(), record.end(), bytes.end() - 1024) || record[8] != self.attempted.size()) return ERROR_INVALID_DATA;
      if (record[8] == self.fail) return ERROR_BROKEN_PIPE;
      std::copy_n(record.end() - 32, 32, acknowledgement->begin());
      if (record[8] == self.wrong) (*acknowledgement)[0] ^= 1;
      else self.committed.push_back(record);
      if (record[8] == self.revoke_after_commit) self.revoked = true;
      if (self.cancellation && record[8] == self.cancel_after_commit) SetEvent(self.cancellation);
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  CellMountedWorkspaceProvisioningCommitter Committer() { return {Commit, Authorize, this}; }
  DWORD Run() {
    return CellProvisioningJournalTestPeer::RunMountedWorkspace(*journal, Committer(), Verify, Create, this, cancellation);
  }
};
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
void Check(bool condition, const char* message) {
  ++checks;
  if (checks % 128 == 0) {
    std::fprintf(stderr, "Native journal progress: checks=%u tick=%llu case=%s\n", checks,
      static_cast<unsigned long long>(GetTickCount64()), message);
    std::fflush(stderr);
  }
  if (!condition) throw std::runtime_error(std::string(message) + " (provisioning journal check " + std::to_string(checks) +
    ", native error " + std::to_string(GetLastError()) + ")");
}
std::wstring Name() {
  std::array<std::uint8_t, 16> random{};
  Check(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0,
    "generate an independent fixture cell name");
  std::wstring result = L"gc-cell-";
  constexpr wchar_t hex[] = L"0123456789abcdef";
  for (auto byte : random) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
CellProvisioningPlan Plan() {
  CellProvisioningPlan plan;
  plan.assignment_binding.fill(0x31); plan.profile_sha256.fill(0x42);
  Check(BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&plan.disk.identifier), sizeof(GUID), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0,
    "generate the independently reserved disk identity");
  plan.disk.virtual_bytes = 16ULL * 1024 * 1024; plan.disk.reserved_file_bytes = 80ULL * 1024 * 1024;
  return plan;
}
std::wstring ParentPath(HANDLE parent) {
  std::array<wchar_t, 2048> value{};
  const DWORD length = GetFinalPathNameByHandleW(parent, value.data(), static_cast<DWORD>(value.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  Check(length && length < value.size(), "resolve the exact fixture parent path");
  return {value.data(), length};
}
std::vector<std::uint8_t> Read(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  LARGE_INTEGER size{};
  Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart >= 0 && size.QuadPart <= 80LL * 1024 * 1024,
    "open a bounded independent read of owned fixture bytes");
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart));
  DWORD count = 0;
  Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count == bytes.size(),
    "independently read the complete fixture bytes");
  return bytes;
}
void Write(const std::wstring& path, const std::vector<std::uint8_t>& bytes, bool existing = true) {
  Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, existing ? OPEN_EXISTING : CREATE_NEW,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(file.value != INVALID_HANDLE_VALUE, "open only the exact owned fixture file for fault injection");
  DWORD count = 0;
  Check(WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count == bytes.size() &&
    SetEndOfFile(file.value) && FlushFileBuffers(file.value), "retain the deliberately injected fixture fault");
}
void Protect(const std::wstring& path, const std::wstring& user, bool broaden = false) {
  const std::wstring sddl = L"O:" + user + L"G:" + user + L"D:P(A;;FA;;;SY)" +
    (user == L"S-1-5-18" ? L"" : L"(A;;FA;;;" + user + L")") + L"(A;;RC;;;OW)" +
    (broaden ? L"(A;;GR;;;WD)" : L"") + L"S:(ML;;NW;;;ME)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr),
    "build an independent fixture file descriptor");
  const bool applied = SetFileSecurityW(path.c_str(), OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION, descriptor) != FALSE;
  LocalFree(descriptor);
  Check(applied, "apply permissions only to the exact test-owned file");
}
LONGLONG Allocation(HANDLE file, LONGLONG requested = -1) {
  FILE_STANDARD_INFO standard{};
  Check(file != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)),
    "inspect actual allocated bytes of the test-owned journal");
  const auto prior = standard.AllocationSize.QuadPart;
  if (requested >= 0) {
    FILE_ALLOCATION_INFO allocation{}; allocation.AllocationSize.QuadPart = requested;
    Check(requested >= standard.EndOfFile.QuadPart && SetFileInformationByHandle(file, FileAllocationInfo, &allocation, sizeof(allocation)) &&
      FlushFileBuffers(file) && GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) &&
      standard.AllocationSize.QuadPart >= requested, "apply and measure real allocation without changing journal content");
  }
  return prior;
}
bool SameDisk(const CellVirtualDiskRecord& a, const CellVirtualDiskRecord& b) {
  return a.control == b.control && a.backing == b.backing && a.spec.virtual_bytes == b.spec.virtual_bytes &&
    a.spec.reserved_file_bytes == b.spec.reserved_file_bytes && !std::memcmp(&a.spec.identifier, &b.spec.identifier, sizeof(GUID));
}
// Independent test-only command-line transfer. The child reads the actual journal;
// no journal bytes or workspace/disk completion identities are passed to it.
std::wstring RecoveryInput(const CellFileIdentity& parent, const CellProvisioningPlan& plan, const CellProvisioningAnchor& anchor) {
  std::vector<std::uint8_t> bytes;
  const auto integer = [&](std::uint64_t value) { for (unsigned i = 0; i < 8; ++i) bytes.push_back(static_cast<std::uint8_t>(value >> (i * 8))); };
  const auto identity = [&](const CellFileIdentity& value) {
    integer(value.volume_serial); bytes.insert(bytes.end(), value.file_id.begin(), value.file_id.end());
  };
  identity(parent);
  bytes.insert(bytes.end(), plan.assignment_binding.begin(), plan.assignment_binding.end());
  bytes.insert(bytes.end(), plan.profile_sha256.begin(), plan.profile_sha256.end());
  const auto* guid = reinterpret_cast<const std::uint8_t*>(&plan.disk.identifier);
  bytes.insert(bytes.end(), guid, guid + sizeof(GUID));
  integer(plan.disk.virtual_bytes); integer(plan.disk.reserved_file_bytes);
  identity(anchor.file); bytes.insert(bytes.end(), anchor.prepared_sha256.begin(), anchor.prepared_sha256.end());
  Check(bytes.size() == 176, "serialize only independent admission and anchor metadata");
  constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring output;
  for (auto byte : bytes) { output += hex[byte >> 4]; output += hex[byte & 15]; }
  return output;
}
void FreshProcess(const std::wstring& path, const std::wstring& name, const std::wstring& user,
                  const CellFileIdentity& parent, const CellProvisioningPlan& plan, const CellProvisioningAnchor& anchor) {
  std::array<wchar_t, 32768> module{};
  const DWORD length = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  Check(length && length < module.size(), "locate the already-running exact native fixture");
  const std::wstring image(module.data(), length);
  auto command = L"\"" + image + L"\" --recorded-provisioning \"" + path + L"\" " + name + L" " + user + L" " + RecoveryInput(parent, plan, anchor);
  STARTUPINFOW startup{sizeof(startup)};
  PROCESS_INFORMATION process{};
  Check(CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process),
    "start a fresh native journal recovery process with no inherited handles");
  Handle child{process.hProcess}, thread{process.hThread};
  const DWORD waited = WaitForSingleObject(child.value, 15000);
  if (waited != WAIT_OBJECT_0) {
    TerminateProcess(child.value, 99);
    Check(WaitForSingleObject(child.value, 5000) == WAIT_OBJECT_0, "join only the owned recovery child after a timeout");
  }
  DWORD exit = 1;
  Check(waited == WAIT_OBJECT_0 && GetExitCodeProcess(child.value, &exit) && exit == 0,
    "a fresh process recovers the persisted journal, exact workspace and exact disk");
  recovery_verified = true;
}
}

bool CellProvisioningRecoveryProcessVerified() { return recovery_verified; }
std::string CellProvisioningDiskLayoutIdsHex() {
  std::string result;
  for (const auto* guid : {&committed_layout.gpt_disk_id, &committed_layout.data_partition_id}) {
    const auto* bytes = reinterpret_cast<const std::uint8_t*>(guid);
    for (std::size_t index = 0; index < sizeof(GUID); ++index) {
      char hex[3]{}; sprintf_s(hex, "%02x", bytes[index]); result += hex;
    }
  }
  return result;
}
std::string ProvisioningRecordsJson(const std::vector<CellProvisioningRecord>& records) {
  constexpr char hex[] = "0123456789abcdef";
  std::string value = "[";
  for (const auto& record : records) {
    if (value.size() > 1) value += ',';
    value += '"';
    for (auto byte : record) { value += hex[byte >> 4]; value += hex[byte & 15]; }
    value += '"';
  }
  return value + "]";
}
std::string CellProvisioningCheckpointRecordsJson() { return ProvisioningRecordsJson(committed_records); }
std::string CellVolumeProvisioningRecordsJson() { return ProvisioningRecordsJson(committed_volume); }
std::string CellVolumeProvisioningCoreRecordsJson() { return ProvisioningRecordsJson(committed_volume_base); }
std::string CellFormatProvisioningHistoryJson() { return ProvisioningRecordsJson(committed_format_history); }
std::string CellProtectionProvisioningHistoryJson() { return ProvisioningRecordsJson(committed_protection_history); }
std::string CellMountProvisioningHistoryJson() { return ProvisioningRecordsJson(committed_mount_history); }
std::string CellMountedWorkspaceProvisioningHistoryJson() { return ProvisioningRecordsJson(committed_mounted_workspace_history); }
int RunCellProvisioningRecoveryFixture(int argc, wchar_t** argv) {
  if (argc != 6 || wcslen(argv[5]) != 352) return 2;
  std::array<std::uint8_t, 176> bytes{};
  const auto digit = [](wchar_t value) -> int {
    return value >= L'0' && value <= L'9' ? value - L'0' : value >= L'a' && value <= L'f' ? value - L'a' + 10 : -1;
  };
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    const int high = digit(argv[5][i * 2]), low = digit(argv[5][i * 2 + 1]);
    if (high < 0 || low < 0) return 2;
    bytes[i] = static_cast<std::uint8_t>((high << 4) | low);
  }
  std::size_t offset = 0;
  const auto integer = [&]() {
    std::uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i) value |= static_cast<std::uint64_t>(bytes[offset++]) << (i * 8);
    return value;
  };
  const auto identity = [&]() {
    CellFileIdentity value; value.volume_serial = integer();
    for (auto& byte : value.file_id) byte = bytes[offset++];
    return value;
  };
  const auto parent_identity = identity();
  CellProvisioningPlan plan;
  for (auto& byte : plan.assignment_binding) byte = bytes[offset++];
  for (auto& byte : plan.profile_sha256) byte = bytes[offset++];
  std::memcpy(&plan.disk.identifier, bytes.data() + offset, sizeof(GUID)); offset += sizeof(GUID);
  plan.disk.virtual_bytes = integer(); plan.disk.reserved_file_bytes = integer();
  CellProvisioningAnchor anchor;
  anchor.file = identity();
  for (auto& byte : anchor.prepared_sha256) byte = bytes[offset++];
  if (offset != bytes.size()) return 2;
  Handle parent{CreateFileW(argv[2], FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  CellProvisioningJournal reopened;
  CellWorkspaceIdentities workspace;
  CellVirtualDiskRecord disk;
  if (parent.value == INVALID_HANDLE_VALUE || reopened.OpenRecorded(parent.value, parent_identity, argv[3], argv[4], argv[4], plan, anchor) ||
      reopened.Phase() != CellProvisioningPhase::disk_recorded || reopened.RecordWorkspace(&workspace) || reopened.RecordDisk(&disk) ||
      disk.control != workspace.directories[1] || reopened.ProvisionDisk(anchor, 10000) != ERROR_INVALID_STATE ||
      reopened.ProvisionWorkspace(anchor) != ERROR_INVALID_STATE || reopened.Verify()) return 3;
  if (plan.disk.virtual_bytes >= 64ULL * 1024 * 1024) {
    CellDiskLayoutPlan layout;
    if (reopened.RecordDiskLayoutPlan(&layout) || !IsValidCellDiskLayoutPlan(layout)) return 4;
  }
  return 0;
}

unsigned RunCellHostCapacityJournalTests(HANDLE parent, const std::wstring& user) {
  checks = 0; const auto parent_path = ParentPath(parent);
  {
    const auto base = parent_path + L"\\" + Name();
    std::vector<std::uint8_t> descriptor;
    Check(!BuildCellParentSecurity(user, user, &descriptor), "build owned host-layout security");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
    Check(CreateDirectoryW(base.c_str(), &security), "create an exclusive host-capacity fixture beneath the admitted test parent");
    std::array<Handle, kCellCapacityAreaCount> roots;
    CellCapacityAreaRoots areas; CellCapacityLayoutRecord layout_record;
    const auto selected = Plan(); layout_record.assignment_binding = selected.assignment_binding; layout_record.profile_sha256 = selected.profile_sha256;
    for (std::size_t i = 0; i < roots.size(); ++i) {
      const auto area_path = base + L"\\area-" + std::to_wstring(i);
      Check(CreateDirectoryW(area_path.c_str(), &security), "create a disjoint owned host-area root");
      roots[i].value = CreateFileW(area_path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      FILE_ID_INFO id{};
      Check(roots[i].value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(roots[i].value, FileIdInfo, &id, sizeof(id)),
        "retain independent host-area identities");
      layout_record.roots[i].volume_serial = id.VolumeSerialNumber;
      std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), layout_record.roots[i].file_id.begin());
      areas[i] = {roots[i].value, layout_record.roots[i]};
    }
    CellProvisioningJournal owned; CellProvisioningAnchor retained; CommitFixture commits;
    const CellProvisioningCommitter committer{CommitFixture::Commit, &commits};
    const auto cell_name = Name();
    Check(!owned.Create(roots[0].value, areas[0].identity, cell_name, user, user, selected, &retained, &committer) &&
      !owned.ProvisionWorkspace(retained) && !owned.ProvisionDisk(retained, 10000),
      "create only the owned journal and unattached backing file for host-capacity composition");
    std::vector<CellProvisioningRecord> records;
    Check(!owned.RecordCheckpoints(&records) && records.size() == 5, "retain complete independent creation history for host capture");
    CellFileSha256 head{}; std::copy_n(records.back().end() - 32, 32, head.begin());
    CellCapacityLayout layout;
    Check(!layout.OpenRecorded(layout_record, areas, user, user), "open the complete protected host layout without adopting replacements");
    struct Current final {
      unsigned calls = 0, deny_at = 0;
      static DWORD Check(void* raw) noexcept {
        auto& self = *static_cast<Current*>(raw);
        return ++self.calls == self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
      }
    } current;
    CellProvisioningHostCapacity observed;
    const auto host_error = owned.ObserveHostCapacity(retained, head, layout, layout_record, {}, {Current::Check, &current}, &observed);
    if (host_error) std::fprintf(stderr, "host capacity error=%lu current_checks=%u\n", host_error, current.calls);
    Check(!host_error,
      "journal owner joins actual retained journal/VHDX handles to the complete host-root scan");
    CellVirtualDiskRecord disk;
    Check(!owned.RecordDisk(&disk), "read independently retained backing identity after host capture");
    unsigned files = 0, journal_matches = 0, backing_matches = 0;
    for (const auto& area : observed.areas) for (const auto& entry : area.entries) {
      if (!entry.directory) ++files;
      if (entry.identity == retained.file) {
        ++journal_matches;
        Check(entry.logical_file_bytes == observed.backing.journal_bytes && entry.allocated_bytes == observed.backing.journal_allocated_bytes,
          "journal contributes its independently measured counts exactly once");
      }
      if (entry.identity == disk.backing) {
        ++backing_matches;
        Check(entry.logical_file_bytes == observed.backing.backing.file_bytes && entry.allocated_bytes == observed.backing.backing.allocated_bytes,
          "backing contributes host allocation without adding guest allocation");
      }
    }
    Check(files == 2 && journal_matches == 1 && backing_matches == 1 && current.calls > 13,
      "complete host collection contains both exclusive files exactly once under repeated current authority");
    for (const auto at : {1U, current.calls / 2, current.calls}) {
      Current revoked{0, at}; auto rejected = observed;
      Check(owned.ObserveHostCapacity(retained, head, layout, layout_record, {}, {Current::Check, &revoked}, &rejected) == ERROR_ACCESS_DENIED &&
        rejected.areas == CellCapacityAreaInventories{} && rejected.backing.anchor == CellProvisioningAnchor{},
        "revocation at initial, middle or final custody check discards both joined observations");
    }
    auto changed = layout_record; changed.assignment_binding[0] ^= 1; auto rejected = observed;
    Current unused;
    Check(owned.ObserveHostCapacity(retained, head, layout, changed, {}, {Current::Check, &unused}, &rejected) == ERROR_FILE_INVALID &&
      rejected.areas == CellCapacityAreaInventories{} && rejected.backing.anchor == CellProvisioningAnchor{} && !unused.calls,
      "a host layout for another assignment cannot borrow this journal's files");
    {
      // Only the mounted-volume reader is controlled here. Host journal/VHDX
      // collection and guest directory/file pinning use their actual owners.
      const auto guest_parent_path = base + L"\\joined-guest-parent";
      Check(CreateDirectoryW(guest_parent_path.c_str(), &security), "create isolated protected guest fixture parent outside host areas");
      Handle guest_parent{CreateFileW(guest_parent_path.c_str(), FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
      FILE_ID_INFO guest_parent_id{}; CellFileIdentity guest_parent_identity;
      Check(guest_parent.value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(guest_parent.value, FileIdInfo,
        &guest_parent_id, sizeof(guest_parent_id)), "retain actual guest fixture parent identity");
      guest_parent_identity.volume_serial = guest_parent_id.VolumeSerialNumber;
      std::copy(std::begin(guest_parent_id.FileId.Identifier), std::end(guest_parent_id.FileId.Identifier), guest_parent_identity.file_id.begin());
      CellWorkspaceDirectories guest; CellWorkspaceIdentities guest_roots;
      Check(guest.Create(guest_parent.value, guest_parent_identity, cell_name, user, user) == 0 && guest.RecordIdentities(&guest_roots) == 0,
        "create real protected guest directories for the controlled mounted reader");
      const auto guest_file = guest.DirectoryPath(CellDirectory::work) + L"\\data";
      Write(guest_file, std::vector<std::uint8_t>(37, 0x61), false);
      struct Joined final {
        CellProvisioningJournal& journal; CellWorkspaceDirectories& guest; CellWorkspaceIdentities roots;
        CellCapacityLayoutRecord layout; std::wstring name, host_path, guest_file;
        unsigned mode = 0, guest_calls = 0, host_calls = 0, after_guest_checks = 0;
        bool captured = false, host_pinned = false, guest_pinned = true;
        HANDLE cancellation = nullptr;
        static bool WriterRefused(const std::wstring& path, bool directory) noexcept {
          Handle writer{CreateFileW(path.c_str(), directory ? FILE_ADD_FILE : GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)};
          return writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION;
        }
        static DWORD Authority(void* raw) noexcept {
          auto& self = *static_cast<Joined*>(raw);
          if (self.captured) {
            ++self.after_guest_checks;
            self.guest_pinned = self.guest_pinned && WriterRefused(self.guest_file, false);
            if (!self.guest_pinned) return ERROR_INVALID_DATA;
            if (self.mode == 11) return ERROR_ACCESS_DENIED;
          }
          return ERROR_SUCCESS;
        }
        static DWORD Binding(const void* raw, const std::wstring& name, const CellFileIdentity& work) noexcept {
          const auto& self = *static_cast<const Joined*>(raw);
          return name != self.name || work != self.roots.directories[static_cast<std::size_t>(CellDirectory::work)] ||
            (self.mode == 12 && self.captured) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
        }
        static DWORD Host(void* raw, const CellProvisioningAnchor& anchor, const CellFileSha256& head, CellCapacityLayout& layout,
          const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
          CellProvisioningHostCapacity* output, const CellCapacityCaptureObserver* observer) noexcept {
          auto& self = *static_cast<Joined*>(raw); ++self.host_calls;
          const auto error = self.journal.ObserveHostCapacity(anchor, head, layout, record, limits, guard, output, self.mode == 10 ? nullptr : observer);
          if (!error) {
            if (self.mode == 6) output->backing.anchor.file.file_id[0] ^= 1;
            if (self.mode == 7) output->backing.checkpoint_sha256[0] ^= 1;
            if (self.mode == 8) output->backing.profile_sha256[0] ^= 1;
            if (self.mode == 9) output->backing.assignment_binding[0] ^= 1;
          }
          return error;
        }
        static DWORD Guest(void* raw, const CellProvisioningAnchor& anchor, const CellFileSha256& head,
          const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, const CellFootprintCellBinding& binding,
          CellDirectoryInventoryPins& pins, CellProvisioningInventory* output) noexcept {
          auto& self = *static_cast<Joined*>(raw); ++self.guest_calls;
          self.host_pinned = WriterRefused(self.host_path, true);
          if (!self.host_pinned) return ERROR_INVALID_DATA;
          auto error = binding.authorize(binding.context, self.name, self.roots.directories[static_cast<std::size_t>(CellDirectory::work)]);
          CellDirectoryInventory inventory;
          if (!error) error = CaptureCellWorkspaceInventory(self.guest, self.roots, limits, guard, pins, &inventory);
          if (error) return error;
          self.captured = true;
          *output = {anchor, self.layout.assignment_binding, self.layout.profile_sha256, head, self.roots, std::move(inventory)};
          if (self.mode == 1) return ERROR_IO_INCOMPLETE;
          if (self.mode == 2) output->anchor.file.file_id[0] ^= 1;
          if (self.mode == 3) output->checkpoint_sha256[0] ^= 1;
          if (self.mode == 4) output->profile_sha256[0] ^= 1;
          if (self.mode == 5) output->assignment_binding[0] ^= 1;
          if (self.mode == 13) SetEvent(self.cancellation);
          if (self.mode == 15) Sleep(limits.wall_limit_ms + 1);
          return ERROR_SUCCESS;
        }
      };
      std::size_t combined_entries = 0;
      CellProvisioningJoinedCapacity positive;
      for (unsigned mode = 0; mode <= 15; ++mode) {
        Handle cancellation{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
        Check(cancellation.value != nullptr, "owned joined-read cancellation event");
        Joined fixture{owned, guest, guest_roots, layout_record, cell_name, base + L"\\area-1", guest_file};
        fixture.mode = mode; fixture.cancellation = cancellation.value;
        auto limits = CellFootprintScanLimits{};
        if (mode == 14) limits.max_entries = static_cast<std::uint32_t>(combined_entries - 1);
        if (mode == 15) limits.wall_limit_ms = 2000;
        CellProvisioningJoinedCapacity joined; joined.host = observed; joined.guest.anchor = retained;
        const auto error = CellProvisioningJournalTestPeer::Joined(owned, retained, head, layout, layout_record, limits,
          {Joined::Authority, &fixture, cancellation.value}, {Joined::Binding, &fixture}, &fixture, Joined::Host, Joined::Guest, &joined);
        if (!mode) {
          Check(!error && fixture.guest_calls == 1 && fixture.host_calls == 1 && fixture.host_pinned && fixture.guest_pinned &&
            fixture.after_guest_checks > 0 && joined.host.areas == observed.areas && joined.guest.inventory.entries.size() == 5 &&
            joined.guest.inventory.footprint.logical_file_bytes == 37, "positive joined read holds real host and guest handles through final authority");
          positive = joined; combined_entries = joined.guest.inventory.entries.size();
          for (const auto& area : joined.host.areas) combined_entries += area.entries.size();
        } else {
          Check(error != 0 && joined.host.areas == CellCapacityAreaInventories{} && joined.host.backing.anchor == CellProvisioningAnchor{} &&
            joined.guest == CellProvisioningInventory{}, "reader errors, substituted bindings, omitted capture, revocation and bounds clear both results");
          if (mode == 14) Check(error == ERROR_BUFFER_OVERFLOW, "combined entry ceiling applies across host and guest inventories");
          if (mode == 15) Check(error == ERROR_TIMEOUT && fixture.captured, "guest read consumes the original shared deadline");
          if (mode == 13) Check(error == ERROR_CANCELLED, "cancellation after guest capture withholds host publication");
        }
        Handle released{CreateFileW(guest_file.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
        Check(released.value != INVALID_HANDLE_VALUE, "every joined return releases guest pins without changing guest data");
      }
      Joined alias{owned, guest, guest_roots, layout_record, cell_name, base + L"\\area-1", guest_file};
      Check(CellProvisioningJournalTestPeer::Joined(owned, positive.host.backing.anchor, positive.host.backing.checkpoint_sha256,
        layout, layout_record, {}, {Joined::Authority, &alias}, {Joined::Binding, &alias}, &alias, Joined::Host, Joined::Guest, &positive) == 0 &&
        positive.host.areas == observed.areas && positive.guest.inventory.entries.size() == 5,
        "positive combined capture freezes input aliases before clearing the prior output");
    }
    struct Observer final {
      unsigned calls = 0, discards = 0;
      DWORD failure = ERROR_SUCCESS;
      CellCapacityLayout* close = nullptr;
      CellProvisioningJournal* close_journal = nullptr;
      std::wstring journal_path;
      bool journal_retained = false;
      static DWORD Capture(void* raw, const CellCapacityPinnedView& view) noexcept {
        auto& self = *static_cast<Observer*>(raw); ++self.calls;
        auto error = view.Check(); if (error) return error;
        if (self.close) self.close->Close();
        if (self.close_journal) {
          self.close_journal->Close();
          Handle held{CreateFileW(self.journal_path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
          self.journal_retained = held.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION &&
            self.close_journal->Verify() == ERROR_INVALID_STATE;
          if (!self.journal_retained) return ERROR_INVALID_DATA;
        }
        return self.failure;
      }
      static void Discard(void* raw) noexcept { ++static_cast<Observer*>(raw)->discards; }
    };
    {
      CellProvisioningJoinedCapacity joined;
      joined.host = observed; joined.guest.anchor = retained;
      const CellFootprintCellBinding binding{[](const void*, const std::wstring&, const CellFileIdentity&) noexcept -> DWORD {
        return ERROR_SUCCESS;
      }, nullptr};
      Current authority;
      Check(owned.ObserveJoinedCapacity(retained, head, layout, layout_record, {}, {Current::Check, &authority},
        {}, &joined) == ERROR_INVALID_PARAMETER && !authority.calls && joined.host.areas == CellCapacityAreaInventories{} &&
        joined.guest == CellProvisioningInventory{}, "joined capture requires cell authority before starting host collection");
      joined.host = observed; joined.guest.anchor = retained;
      Check(owned.ObserveJoinedCapacity(retained, head, layout, layout_record, {}, {Current::Check, &authority},
        binding, &joined) == ERROR_IO_INCOMPLETE && authority.calls > 13 && joined.host.areas == CellCapacityAreaInventories{} &&
        joined.guest == CellProvisioningInventory{}, "guest refusal inside a real held host scan discards both inventories");
      Check(owned.ObserveJoinedCapacity(retained, head, layout, layout_record, {}, {Current::Check, &authority},
        binding, nullptr) == ERROR_INVALID_PARAMETER, "joined capture refuses a null output");
      CellProvisioningHostCapacity retry;
      Check(owned.ObserveHostCapacity(retained, head, layout, layout_record, {}, {Current::Check, &authority}, &retry) == 0 &&
        retry.areas == observed.areas, "refused joined capture releases temporary pins and preserves the original journal and host layout");
      Check(owned.ObserveHostCapacity(retry.backing.anchor, retry.backing.checkpoint_sha256, layout, layout_record, {},
        {Current::Check, &authority}, &retry) == 0 && retry.areas == observed.areas,
        "host capture freezes bindings aliased into its own output before clearing it");
      joined.host = observed; joined.guest.anchor = retained;
      Check(owned.ObserveJoinedCapacity(joined.host.backing.anchor, joined.host.backing.checkpoint_sha256, layout, layout_record, {},
        {Current::Check, &authority}, binding, &joined) == ERROR_IO_INCOMPLETE && joined.host.areas == CellCapacityAreaInventories{} &&
        joined.guest == CellProvisioningInventory{}, "joined capture preserves aliased bindings until the actual missing-guest refusal");
    }
    for (unsigned mode = 0; mode < 3; ++mode) {
      Observer observer; if (mode == 1) observer.failure = ERROR_ACCESS_DENIED;
      if (mode == 2) observer.close = &layout;
      const CellCapacityCaptureObserver capture{&observer, Observer::Capture, Observer::Discard};
      Current authority; auto joined = observed;
      const auto error = owned.ObserveHostCapacity(retained, head, layout, layout_record, {},
        {Current::Check, &authority}, &joined, &capture);
      Check(mode == 0 ? !error && joined.areas == observed.areas : error &&
        joined.areas == CellCapacityAreaInventories{} && joined.backing.anchor == CellProvisioningAnchor{},
        "journal observer remains provisional across callback failure and layout custody loss");
      Check(observer.calls == 1 && observer.discards == (mode ? 1U : 0U),
        "journal, layout and scanner discard related evidence once across nested owners");
    }
    Check(layout.OpenRecorded(layout_record, areas, user, user) == 0, "reopen only the recorded test layout after its explicit close");
    Observer closing; closing.close_journal = &owned; closing.journal_path = base + L"\\area-0\\" + cell_name + L".provisioning";
    const CellCapacityCaptureObserver on_close{&closing, Observer::Capture, Observer::Discard};
    Current last_authority; auto refused = observed;
    Check(owned.ObserveHostCapacity(retained, head, layout, layout_record, {}, {Current::Check, &last_authority}, &refused, &on_close) != 0 &&
      closing.calls == 1 && closing.discards == 1 && closing.journal_retained && refused.areas == CellCapacityAreaInventories{} &&
      refused.backing.anchor == CellProvisioningAnchor{}, "close revokes immediately but retains journal custody until its active callback unwinds");
    Handle released{CreateFileW(closing.journal_path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(released.value != INVALID_HANDLE_VALUE && owned.Phase() == CellProvisioningPhase::none,
      "outermost read performs deferred cleanup and releases the actual journal file");
  }
  return checks;
}

unsigned RunCellProvisioningJournalTests(HANDLE parent, const CellFileIdentity& parent_identity, const std::wstring& user) {
  checks = 0; recovery_verified = false; committed_records.clear(); committed_layout = {};
  committed_volume.clear(); committed_volume_base.clear();
  committed_format_history.clear();
  committed_protection_history.clear();
  const auto parent_path = ParentPath(parent), name = Name(), path = parent_path + L"\\" + name + L".provisioning";
  const auto plan = Plan();
  CellProvisioningJournal journal;
  CellProvisioningAnchor anchor, cleared{{1, {1}}, {1}};
  CommitFixture initial_commits;
  CellProvisioningCommitter initial_committer{CommitFixture::Commit, &initial_commits};
  Check(journal.Verify() == ERROR_INVALID_STATE && journal.Phase() == CellProvisioningPhase::none,
    "an uncreated journal does not claim verified state");
  auto invalid = plan; invalid.profile_sha256 = {};
  Check(journal.Create(parent, parent_identity, name, user, user, invalid, &cleared, &initial_committer) == ERROR_INVALID_PARAMETER &&
    cleared == CellProvisioningAnchor{}, "invalid plan clears output and creates no journal");
  Check(GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES, "invalid input leaves no file");
  Check(journal.Create(parent, parent_identity, name, user, user, plan, &anchor, nullptr) == ERROR_INVALID_PARAMETER &&
    initial_commits.attempted.empty(), "creation requires an explicit canonical checkpoint committer");
  Check(journal.Create(parent, parent_identity, name, user, user, plan, &anchor, &initial_committer) == 0 &&
    anchor.file != parent_identity && journal.Phase() == CellProvisioningPhase::prepared && journal.Verify() == 0,
    "exclusive journal creation flushes and verifies the prepared plan");
  Check(GetFileAttributesW((parent_path + L"\\" + name).c_str()) == INVALID_FILE_ATTRIBUTES,
    "journal preparation precedes creation of the workspace");
  CellProvisioningJournal concurrent;
  Check(concurrent.OpenRecorded(parent, parent_identity, name, user, user, plan, anchor) == ERROR_SHARING_VIOLATION,
    "a second owner cannot open the journal concurrently");
  concurrent.Close();
  Check(concurrent.Create(parent, parent_identity, name, user, user, plan, &cleared, &initial_committer) != 0 && cleared == CellProvisioningAnchor{},
    "another creation cannot replace the existing journal");
  for (const DWORD access : std::array<DWORD, 3>{GENERIC_READ, GENERIC_WRITE, DELETE}) {
    Handle excluded{CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(excluded.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "journal custody excludes readers, writers and deletion handles");
  }
  auto wrong_anchor = anchor; wrong_anchor.prepared_sha256[0] ^= 1;
  Check(journal.ProvisionWorkspace(wrong_anchor) == ERROR_INVALID_STATE && journal.Phase() == CellProvisioningPhase::prepared,
    "workspace creation requires the exact independently retained anchor");
  Check(journal.ProvisionWorkspace(anchor) == 0 && journal.Phase() == CellProvisioningPhase::workspace_recorded,
    "workspace creation persists intent and exact verified directory identities");
  CellWorkspaceIdentities workspace;
  Check(journal.RecordWorkspace(&workspace) == 0 && workspace.parent == parent_identity,
    "the workspace completion has all recorded identities");
  Check(journal.ProvisionWorkspace(anchor) == ERROR_INVALID_STATE, "a completed workspace is never created twice");
  Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Check(cancelled.value != nullptr && journal.ProvisionDisk(anchor, 10000, cancelled.value) == ERROR_CANCELLED &&
    journal.Phase() == CellProvisioningPhase::workspace_recorded, "preexisting cancellation writes no disk intent");
  Check(journal.ProvisionDisk(anchor, 0) == ERROR_INVALID_PARAMETER && journal.Verify() == 0, "invalid disk deadlines preserve the journal");
  Check(journal.ProvisionDisk(anchor, 10000) == 0 && journal.Phase() == CellProvisioningPhase::disk_recorded,
    "native fixed-disk creation persists intent and verified backing identity");
  CellVirtualDiskRecord disk;
  Check(journal.RecordDisk(&disk) == 0 && disk.control == workspace.directories[1] && disk.spec.virtual_bytes == plan.disk.virtual_bytes,
    "disk completion binds the frozen capacity and correct control directory");
  {
    std::vector<CellProvisioningRecord> checkpoints;
    Check(journal.RecordCheckpoints(&checkpoints) == ERROR_SUCCESS && checkpoints.size() == 5,
      "backing capacity uses an independently retained complete creation history");
    CellFileSha256 head{}; std::copy_n(checkpoints.back().end() - 32, 32, head.begin());
    const auto allow = [](void*) noexcept -> DWORD { return ERROR_SUCCESS; };
    const auto empty = [](const CellProvisioningBackingFootprint& value) {
      return value.anchor == CellProvisioningAnchor{} && value.assignment_binding == CellFileSha256{} &&
        value.profile_sha256 == CellFileSha256{} && value.checkpoint_sha256 == CellFileSha256{} &&
        value.workspace == CellWorkspaceIdentities{} && value.backing.record.control == CellFileIdentity{} &&
        value.backing.record.backing == CellFileIdentity{} && IsEqualGUID(value.backing.record.spec.identifier, GUID{}) &&
        !value.backing.record.spec.virtual_bytes && !value.backing.record.spec.reserved_file_bytes &&
        !value.backing.file_bytes && !value.backing.allocated_bytes && !value.journal_bytes &&
        !value.journal_allocated_bytes && !value.host_file_allocated_bytes;
    };
    CellProvisioningBackingFootprint observed;
    Check(journal.ObserveBackingFootprint(anchor, head, 10000, {allow}, &observed) == ERROR_SUCCESS,
      "actual journal and unattached VHDX produce bound host-file accounting");
    FILE_STANDARD_INFO journal_info{};
    Check(GetFileInformationByHandleEx(CellProvisioningJournalTestPeer::File(journal), FileStandardInfo, &journal_info, sizeof(journal_info)),
      "read independent journal allocation control");
    const auto image_path = parent_path + L"\\" + name + L"\\control\\cell.vhdx";
    DWORD high = 0; SetLastError(ERROR_SUCCESS);
    const auto low = GetCompressedFileSizeW(image_path.c_str(), &high);
    Check(low != INVALID_FILE_SIZE || GetLastError() == ERROR_SUCCESS, "read independent image allocation control");
    Check(observed.anchor == anchor && observed.assignment_binding == plan.assignment_binding && observed.profile_sha256 == plan.profile_sha256 &&
      observed.checkpoint_sha256 == head && observed.workspace == workspace && observed.backing.record.backing == disk.backing &&
      observed.backing.record.control == disk.control && IsEqualGUID(observed.backing.record.spec.identifier, disk.spec.identifier),
      "host charges preserve assignment, profile, checkpoints and both file identities");
    Check(observed.journal_bytes == 5120 && observed.journal_allocated_bytes == static_cast<std::uint64_t>(journal_info.AllocationSize.QuadPart) &&
      observed.backing.allocated_bytes == ((static_cast<std::uint64_t>(high) << 32) | low) &&
      observed.host_file_allocated_bytes == observed.journal_allocated_bytes + observed.backing.allocated_bytes,
      "unique host files are charged once without adding the guest-volume allocation");
    Check(journal.ObserveBackingFootprint(observed.anchor, observed.checkpoint_sha256, 10000, {allow}, &observed) == ERROR_SUCCESS &&
      observed.anchor == anchor && observed.checkpoint_sha256 == head, "aliased journal capacity bindings survive output clearing");
    for (unsigned kind = 0; kind < 4; ++kind) {
      auto bad_anchor = anchor; auto bad_head = head;
      if (kind == 0) ++bad_anchor.file.volume_serial;
      if (kind == 1) bad_anchor.file.file_id[0] ^= 1;
      if (kind == 2) bad_anchor.prepared_sha256[0] ^= 1;
      if (kind == 3) bad_head[0] ^= 1;
      auto refused = observed;
      Check(journal.ObserveBackingFootprint(bad_anchor, bad_head, 10000, {allow}, &refused) != ERROR_SUCCESS && empty(refused),
        "foreign journal anchors and heads cannot relabel host capacity");
    }
    struct Guard final {
      CellProvisioningJournal* journal;
      unsigned calls = 0, at = 1, drift = 0;
      DWORD refusal = 0;
      HANDLE cancellation = nullptr;
      bool metadata = false;
      static DWORD Check(void* raw) noexcept {
        auto& value = *static_cast<Guard*>(raw);
        if (++value.calls != value.at) return ERROR_SUCCESS;
        if (value.refusal) return value.refusal;
        if (value.cancellation && !SetEvent(value.cancellation)) return GetLastError();
        if (value.drift) CellProvisioningJournalTestPeer::DriftCapacityBinding(*value.journal, value.drift);
        if (value.metadata) {
          FILETIME time{}; const auto file = CellProvisioningJournalTestPeer::File(*value.journal);
          if (!GetFileTime(file, nullptr, nullptr, &time)) return GetLastError();
          ULARGE_INTEGER next; next.LowPart = time.dwLowDateTime; next.HighPart = time.dwHighDateTime;
          next.QuadPart += 10000000; time.dwLowDateTime = next.LowPart; time.dwHighDateTime = next.HighPart;
          if (!SetFileTime(file, nullptr, nullptr, &time)) return GetLastError();
        }
        return ERROR_SUCCESS;
      }
    };
    Guard count{&journal};
    Check(journal.ObserveBackingFootprint(anchor, head, 10000, {Guard::Check, &count}, &observed) == ERROR_SUCCESS && count.calls == 3,
      "journal and backing observations share three bounded current-authority boundaries");
    for (unsigned at = 1; at <= count.calls; ++at) {
      Guard denied{&journal}; denied.at = at; denied.refusal = ERROR_ACCESS_DENIED;
      auto refused = observed;
      Check(journal.ObserveBackingFootprint(anchor, head, 10000, {Guard::Check, &denied}, &refused) == ERROR_ACCESS_DENIED &&
        empty(refused) && denied.calls == at, "authority loss withholds the entire joined footprint");
      Handle stopped{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
      Guard cancel{&journal}; cancel.at = at; cancel.cancellation = stopped.value;
      refused = observed;
      Check(stopped.value && journal.ObserveBackingFootprint(anchor, head, 10000, {Guard::Check, &cancel, stopped.value}, &refused) == ERROR_CANCELLED &&
        empty(refused) && cancel.calls == at, "joined footprint observes cancellation immediately after authority exchange");
      for (unsigned kind = 1; kind <= 11; ++kind) {
        Guard changed{&journal}; changed.at = at; changed.drift = kind; refused = observed;
        const auto error = journal.ObserveBackingFootprint(anchor, head, 10000, {Guard::Check, &changed}, &refused);
        CellProvisioningJournalTestPeer::DriftCapacityBinding(journal, kind);
        Check(error != ERROR_SUCCESS && empty(refused) && changed.calls == at && journal.Verify() == ERROR_SUCCESS,
          "changed journal assignment/profile/identity/policy cannot relabel retained backing bytes");
      }
    }
    Guard metadata{&journal}; metadata.at = 3; metadata.metadata = true;
    auto refused = observed;
    Check(journal.ObserveBackingFootprint(anchor, head, 10000, {Guard::Check, &metadata}, &refused) == ERROR_FILE_INVALID && empty(refused),
      "journal metadata drift invalidates a joined observation with unchanged file lengths");
    Check(journal.Verify() == ERROR_SUCCESS, "read-only capacity failure never destroys journal authority or bytes");
  }
  CellDiskLayoutPlan too_small;
  Check(journal.RecordDiskLayoutPlan(&too_small) == ERROR_INVALID_PARAMETER && IsEqualGUID(too_small.gpt_disk_id, GUID{}),
    "legacy small VHDX records remain recoverable without acquiring layout authority");
  Check(journal.ProvisionDisk(anchor, 10000) == ERROR_INVALID_STATE, "a recorded backing disk is never created twice");
  journal.Close();
  const auto bytes = Read(path);
  const auto backing_path = parent_path + L"\\" + name + L"\\control\\cell.vhdx";
  const auto backing = Read(backing_path);
  Check(bytes.size() == 5120, "exactly five bounded phase records are retained");
  FreshProcess(parent_path, name, user, parent_identity, plan, anchor);
  Check(Read(path) == bytes && Read(backing_path) == backing, "fresh-process recovery changes no journal or disk bytes");
  const auto open = [&](const CellProvisioningPlan& value, const CellProvisioningAnchor& reference) {
    journal.Close();
    return journal.OpenRecorded(parent, parent_identity, name, user, user, value, reference);
  };
  Check(open(plan, anchor) == 0, "an independent exact plan and anchor recover completed native resources");
  CellVirtualDiskRecord read_disk;
  Check(journal.RecordDisk(&read_disk) == 0 && SameDisk(disk, read_disk), "disk identity survives closing all provisioning handles");
  for (unsigned change = 0; change < 5; ++change) {
    auto other = plan;
    if (change == 0) other.assignment_binding[0] ^= 1;
    if (change == 1) other.profile_sha256[0] ^= 1;
    if (change == 2) other.disk.identifier.Data1 ^= 1;
    if (change == 3) { other.disk.virtual_bytes += 2 * 1024 * 1024; other.disk.reserved_file_bytes += 2 * 1024 * 1024; }
    if (change == 4) other.disk.reserved_file_bytes += 2 * 1024 * 1024;
    Check(open(other, anchor) != 0, "changed assignment, profile, disk identity or capacity cannot adopt a journal");
  }
  Check(open(plan, wrong_anchor) != 0, "a changed independent prepared hash is refused");
  wrong_anchor = anchor; wrong_anchor.file.file_id.back() ^= 0x80;
  Check(wrong_anchor.file != parent_identity &&
    std::any_of(wrong_anchor.file.file_id.begin(), wrong_anchor.file.file_id.end(), [](auto byte) { return byte != 0; }),
    "the substituted file ID remains valid and distinct from the parent ID");
  Check(open(plan, wrong_anchor) == ERROR_FILE_INVALID, "a changed recorded journal identity is refused");
  journal.Close();
  for (const std::size_t size : {0U, 1U, 1023U, 1025U, 2047U, 4097U, 5119U, 5121U}) {
    auto damaged = bytes; damaged.resize(size, 0);
    Write(path, damaged);
    Check(open(plan, anchor) != 0 && journal.Verify() == ERROR_INVALID_STATE, "torn and oversized records are refused without repair");
    journal.Close();
    Check(Read(path) == damaged, "failed recovery leaves the exact torn evidence unchanged");
  }
  for (const std::size_t offset : {0U, 8U, 12U, 32U, 1100U, 2600U, 4096U + 696U, 5119U}) {
    auto damaged = bytes; damaged[offset] ^= 1;
    Write(path, damaged);
    Check(open(plan, anchor) != 0, "wrong format, sequence, chain, binding, workspace or disk data is refused");
    journal.Close();
    Check(Read(path) == damaged, "corrupt evidence remains byte-identical after refusal");
  }
  for (unsigned phase = 1; phase <= 4; ++phase) {
    const std::vector<std::uint8_t> prefix(bytes.begin(), bytes.begin() + phase * 1024);
    Write(path, prefix);
    const DWORD error = open(plan, anchor);
    Check(journal.Phase() == static_cast<CellProvisioningPhase>(phase) &&
      error == static_cast<DWORD>((phase == 2 || phase == 4) ? ERROR_IO_INCOMPLETE : 0),
      "incomplete phase recovery reports persisted intent instead of inferring completion from current objects");
    Check(journal.ProvisionWorkspace(anchor) == ERROR_INVALID_STATE && journal.ProvisionDisk(anchor, 10000) == ERROR_INVALID_STATE,
      "no recovered journal can repeat or resume creation from a valid prefix");
    journal.Close();
    Check(Read(path) == prefix && Read(backing_path) == backing, "prefix recovery preserves current resources and records");
  }
  Write(path, bytes);
  Check(open(plan, anchor) == 0, "reopen exact resources before injecting allocation drift through the owned handle");
  const HANDLE held = CellProvisioningJournalTestPeer::File(journal);
  const auto allocation = Allocation(held, 128 * 1024);
  Check(allocation <= static_cast<LONGLONG>(kCellProvisioningJournalMaximumAllocatedBytes) &&
    journal.Verify() == ERROR_ACCESS_DENIED, "excess physical allocation is refused even when all logical bytes and hashes match");
  std::vector<std::uint8_t> actual(bytes.size());
  LARGE_INTEGER beginning{};
  DWORD read = 0;
  Check(SetFilePointerEx(held, beginning, nullptr, FILE_BEGIN) && ReadFile(held, actual.data(), static_cast<DWORD>(actual.size()), &read, nullptr) &&
    read == actual.size() && actual == bytes && Allocation(held) >= 128 * 1024, "refusal never rewrites or shrinks the overallocated journal");
  Allocation(held, allocation); // Restore only the independently captured fixture allocation.
  Check(journal.Verify() == ERROR_INVALID_STATE, "restoration cannot silently heal an already-refused owner");
  journal.Close();
  Check(open(plan, anchor) == 0, "the exact original allocation and bytes can be verified after fixture restoration");
  journal.Close();
  Protect(path, user, true);
  Check(open(plan, anchor) == ERROR_INVALID_SECURITY_DESCR, "broadened journal security cannot become new authority");
  journal.Close(); Protect(path, user);
  Check(open(plan, anchor) == 0, "only the independently restored exact fixture descriptor is accepted");
  Protect(path, user, true);
  Check(journal.Verify() == ERROR_INVALID_SECURITY_DESCR && journal.RecordDisk(&read_disk) == ERROR_INVALID_STATE,
    "security drift invalidates a retained owner and clears usable resource records");
  journal.Close(); Protect(path, user);
  Write(path + L":unapproved", {42}, false);
  Check(open(plan, anchor) == ERROR_ACCESS_DENIED, "alternate streams cannot hide outside the bounded journal");
  journal.Close();
  Check(DeleteFileW((path + L":unapproved").c_str()), "remove only the exact stream created by this fixture");
  const auto link = path + L".owned-link";
  Check(CreateHardLinkW(link.c_str(), path.c_str(), nullptr), "create an owned journal alias fixture");
  Check(open(plan, anchor) == ERROR_ACCESS_DENIED, "multiple hard links refuse journal recovery");
  journal.Close(); Check(DeleteFileW(link.c_str()), "remove only the test-owned alias");
  const auto original = path + L".original";
  Check(MoveFileW(path.c_str(), original.c_str()), "preserve the original journal before the missing-file fixture");
  Check(open(plan, anchor) == ERROR_FILE_NOT_FOUND && GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing recorded journals are never recreated during recovery");
  journal.Close();
  Check(Read(original) == bytes, "missing-journal recovery preserves the independently retained original");
  Check(CopyFileW(original.c_str(), path.c_str(), TRUE), "create a same-byte replacement with a different NTFS identity");
  Protect(path, user);
  Check(open(plan, anchor) == ERROR_FILE_INVALID, "identical bytes and permissions cannot replace the recorded NTFS object");
  journal.Close();
  Check(Read(path) == bytes && Read(original) == bytes && Read(backing_path) == backing,
    "refused replacement preserves both journal objects and the backing image");

  // Actual native create failures exercise durable uncertainty without synthesized records.
  for (const bool conflict_disk : {false, true}) {
    const auto conflict_name = Name();
    const auto conflict_path = parent_path + L"\\" + conflict_name;
    CellWorkspaceDirectories existing;
    CellProvisioningAnchor reference;
    CommitFixture conflict_commits;
    CellProvisioningCommitter conflict_committer{CommitFixture::Commit, &conflict_commits};
    Check(journal.Create(parent, parent_identity, conflict_name, user, user, plan, &reference, &conflict_committer) == 0,
      "prepare an independent conflicting-resource fixture");
    if (!conflict_disk) {
      Check(existing.Create(parent, parent_identity, conflict_name, user, user) == 0, "create the independently owned conflicting workspace");
      existing.Close();
    } else Check(journal.ProvisionWorkspace(reference) == 0, "prepare the disk-conflict workspace through the real journal");
    const auto marker_path = conflict_path + L"\\control\\" + (conflict_disk ? L"cell.vhdx" : L"marker.txt");
    const std::vector<std::uint8_t> marker{1, 2, 3, 4};
    Write(marker_path, marker, false);
    const DWORD failed = conflict_disk ? journal.ProvisionDisk(reference, 10000) : journal.ProvisionWorkspace(reference);
    Check(failed != 0 && journal.Phase() == (conflict_disk ? CellProvisioningPhase::disk_started : CellProvisioningPhase::workspace_started),
      "actual creation conflict leaves durable started intent with no completion claim");
    journal.Close();
    Check(journal.OpenRecorded(parent, parent_identity, conflict_name, user, user, plan, reference) == ERROR_IO_INCOMPLETE,
      "reopening an actual failed native creation requires reconciliation");
    journal.Close();
    Check(Read(marker_path) == marker, "conflicting native resource bytes are never adopted or removed");
  }
  journal.Close();
  for (unsigned refused = 1; refused <= 6; ++refused) {
    const auto controlled_name = Name(), root = parent_path + L"\\" + controlled_name;
    CommitFixture fixture;
    fixture.refused_phase = refused <= 5 ? refused : 0;
    fixture.wrong_ack_phase = refused == 6 ? 2 : 0;
    CellProvisioningCommitter committer{CommitFixture::Commit, &fixture};
    CellProvisioningAnchor reference;
    DWORD result = journal.Create(parent, parent_identity, controlled_name, user, user, plan, &reference, &committer);
    if (!result) result = journal.ProvisionWorkspace(reference);
    if (!result) result = journal.ProvisionDisk(reference, 10000);
    const unsigned failed_phase = refused == 6 ? 2 : refused;
    Check(result == static_cast<DWORD>(refused == 6 ? ERROR_INVALID_DATA : ERROR_ACCESS_DENIED) &&
      fixture.attempted.size() == failed_phase && fixture.committed.size() == failed_phase - 1,
      "native progress stops at a refused or wrong-digest canonical acknowledgement");
    Check(journal.Verify() == ERROR_INVALID_STATE && journal.ProvisionWorkspace(reference) == ERROR_INVALID_STATE &&
      journal.ProvisionDisk(reference, 10000) == ERROR_INVALID_STATE, "failed acknowledgement cannot be retried through the original owner");
    journal.Close();
    const DWORD root_attributes = GetFileAttributesW(root.c_str());
    Check((root_attributes != INVALID_FILE_ATTRIBUTES) == (failed_phase >= 3),
      "workspace creation occurs only after its started intent is acknowledged");
    const DWORD disk_attributes = GetFileAttributesW((root + L"\\control\\cell.vhdx").c_str());
    Check((disk_attributes != INVALID_FILE_ATTRIBUTES) == (failed_phase == 5),
      "disk creation occurs only after its started intent is acknowledged");
    const auto retained = Read(root + L".provisioning");
    Check(retained.size() == failed_phase * 1024 &&
      std::equal(fixture.attempted.back().begin(), fixture.attempted.back().end(), retained.end() - 1024),
      "unacknowledged native facts remain in the exact local journal for reconciliation");
  }
  {
    const auto controlled_name = Name();
    auto controlled_plan = plan;
    controlled_plan.disk.virtual_bytes = 64ULL * 1024 * 1024;
    controlled_plan.disk.reserved_file_bytes = 128ULL * 1024 * 1024;
    CommitFixture fixture;
    CellProvisioningCommitter committer{CommitFixture::Commit, &fixture};
    CellProvisioningAnchor reference;
    Check(journal.Create(parent, parent_identity, controlled_name, user, user, controlled_plan, &reference, &committer) == 0 &&
      journal.ProvisionWorkspace(reference) == 0 && journal.ProvisionDisk(reference, 10000) == 0,
      "all five canonical acknowledgements permit real workspace and disk creation");
    std::vector<CellProvisioningRecord> captured;
    Check(journal.RecordCheckpoints(&captured) == 0 && captured.size() == 5 && captured == fixture.committed,
      "verified native checkpoint exports match the exact independently acknowledged records");
    committed_records = captured;
    Check(journal.RecordDiskLayoutPlan(&committed_layout) == ERROR_SUCCESS && IsValidCellDiskLayoutPlan(committed_layout),
      "the verified recorded disk produces its frozen GPT plan without attachment");
    journal.Close();
    FreshProcess(parent_path, controlled_name, user, parent_identity, controlled_plan, reference);
    Check(journal.OpenRecorded(parent, parent_identity, controlled_name, user, user, controlled_plan, reference) == 0 &&
      journal.RecordCheckpoints(&captured) == 0 && captured == committed_records,
      "recorded recovery exports the same acknowledged native history without resuming it");
    CellDiskLayoutPlan recovered_layout;
    Check(journal.RecordDiskLayoutPlan(&recovered_layout) == ERROR_SUCCESS &&
      IsEqualGUID(recovered_layout.gpt_disk_id, committed_layout.gpt_disk_id) &&
      IsEqualGUID(recovered_layout.data_partition_id, committed_layout.data_partition_id),
      "recorded recovery preserves GPT identities without rewriting the legacy journal");
    journal.Close();
  }
  for (unsigned mode = 0; mode <= 9; ++mode) {
    const auto volume_name = Name(), file = parent_path + L"\\" + volume_name + L".provisioning";
    auto volume_plan = plan;
    volume_plan.disk.virtual_bytes = 64ULL * 1024 * 1024;
    volume_plan.disk.reserved_file_bytes = 128ULL * 1024 * 1024;
    CommitFixture core;
    CellProvisioningCommitter core_sink{CommitFixture::Commit, &core};
    CellProvisioningAnchor reference;
    Check(journal.Create(parent, parent_identity, volume_name, user, user, volume_plan, &reference, &core_sink) == 0 &&
      journal.ProvisionWorkspace(reference) == 0 && journal.ProvisionDisk(reference, 10000) == 0,
      "volume fixture starts from a real exclusively created and acknowledged VHDX");
    CellDiskLayoutPlan layout_plan;
    Check(journal.RecordDiskLayoutPlan(&layout_plan) == 0, "volume fixture uses the original canonical disk binding");
    VolumeFixture fixture{&journal, layout_plan};
    if (mode == 0) fixture.refuse_authorization = 1;
    else if (mode <= 6) fixture.fail = mode;
    else if (mode == 7) fixture.wrong = 4;
    else if (mode == 9) fixture.revoke_after_layout = true;
    if (mode == 8) {
      Check(journal.ProvisionVolume(reference, {}, 10000) == ERROR_INVALID_PARAMETER &&
        journal.ProvisionVolume(reference, fixture.Committer(), 0) == ERROR_INVALID_PARAMETER,
        "public volume preparation refuses missing authority and unbounded work before an OS operation");
      auto foreign = reference; foreign.prepared_sha256[0] ^= 1;
      Check(journal.ProvisionVolume(foreign, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
        "another prepared anchor cannot authorize volume preparation");
    }
    const DWORD result = fixture.Run();
    const unsigned attempted = mode == 0 ? 0 : mode <= 6 ? mode : mode == 7 ? 4 : 6;
    Check((result == ERROR_SUCCESS) == (mode == 8) && fixture.attempted.size() == attempted,
      "volume sequence stops at the exact refused or incorrectly acknowledged durable checkpoint");
    Check(fixture.attaches == (attempted >= 2 ? 1U : 0U) && fixture.layouts == (attempted >= 3 ? 1U : 0U),
      "attachment and GPT operations start only after their preceding acknowledgements");
    Check(fixture.Run() == ERROR_INVALID_STATE && fixture.attempted.size() == attempted,
      "a stopped or completed creator cannot retry attachment or initialize GPT again");
    const auto captured = CellProvisioningJournalTestPeer::Bytes(journal);
    Check(captured.size() == 5120 + attempted * 1024, "six volume records stay in the existing bounded journal");
    for (std::size_t index = 0; index < core.committed.size(); ++index)
      Check(std::equal(core.committed[index].begin(), core.committed[index].end(), captured.begin() + index * 1024),
        "volume progress preserves each original provisioning record byte-for-byte");
    journal.Close();
    Check(Read(file) == captured, "acknowledgement loss preserves the exact flushed local history");
    const DWORD recovered = journal.OpenRecorded(parent, parent_identity, volume_name, user, user, volume_plan, reference);
    if (!attempted) Check(recovered == 0, "refused volume authority leaves the original unattached VHDX recoverable");
    else if (attempted < 6) Check(recovered == ERROR_IO_INCOMPLETE, "interrupted volume prefixes never resume OS effects");
    else Check(recovered == ERROR_NOT_SUPPORTED, "legacy recovery cannot silently discard the retained volume history");
    Check(journal.ProvisionVolume(reference, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
      "reopening even a valid journal does not restore creation authority");
    journal.Close();
    if (mode != 8) continue;
    committed_volume = fixture.committed; committed_volume_base = core.committed;
    auto foreign_volume = committed_volume; foreign_volume.back().back() ^= 1;
    Check(journal.OpenRecorded(parent, parent_identity, volume_name, user, user, volume_plan, reference, foreign_volume) == ERROR_CRC,
      "volume recovery requires every exact independently retained checkpoint before querying OS state");
    journal.Close();
    Check(journal.OpenRecorded(parent, parent_identity, volume_name, user, user, volume_plan, reference, committed_volume) != 0,
      "complete expected fixture records still cannot substitute for actual OS attachment and layout verification");
    journal.Close();
    Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, volume_name, user, volume_plan, reference) == 0,
      "fresh metadata decoding verifies the complete native volume chain independently of OS readiness");
    journal.Close();
    for (std::size_t prefix = 1; prefix < 6; ++prefix) {
      const std::vector<std::uint8_t> partial(captured.begin(), captured.begin() + 5120 + prefix * 1024);
      Write(file, partial);
      Check(journal.OpenRecorded(parent, parent_identity, volume_name, user, user, volume_plan, reference) == ERROR_IO_INCOMPLETE,
        "every valid retained volume prefix requires reconciliation without resuming");
      journal.Close();
      Check(Read(file) == partial, "recovery preserves incomplete volume evidence without appending or truncating");
    }
    for (const std::size_t offset : {0U, 8U, 12U, 48U, 80U, 112U, 128U, 144U, 168U, 192U, 216U, 248U, 264U, 280U, 792U}) {
      auto changed = captured;
      changed[5120 + offset] ^= 1;
      BCRYPT_ALG_HANDLE algorithm = nullptr;
      Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "independent volume test hasher");
      bool hashed = true;
      for (std::size_t position = 5120; position < changed.size(); position += 1024) {
        if (position > 5120) std::copy_n(changed.begin() + position - 32, 32, changed.begin() + position + 16);
        if (BCryptHash(algorithm, nullptr, 0, changed.data() + position, 992, changed.data() + position + 992, 32) < 0) hashed = false;
      }
      BCryptCloseAlgorithmProvider(algorithm, 0);
      Check(hashed, "independent outer digests are valid despite the injected record drift");
      Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, volume_name, user, volume_plan, reference) != 0,
        "correctly rehashed authority, identity, phase, premature layout and reserved-field drift is rejected");
      journal.Close();
    }
    Write(file, captured); // Retain the successful fixture bytes after fault injection.
  }
  for (unsigned mode = 0; mode <= 11; ++mode) {
    const auto format_name = Name(), file = parent_path + L"\\" + format_name + L".provisioning";
    auto format_plan = plan;
    format_plan.disk.virtual_bytes = 64ULL * 1024 * 1024;
    format_plan.disk.reserved_file_bytes = 128ULL * 1024 * 1024;
    CommitFixture core;
    CellProvisioningCommitter core_sink{CommitFixture::Commit, &core};
    CellProvisioningAnchor reference;
    Check(journal.Create(parent, parent_identity, format_name, user, user, format_plan, &reference, &core_sink) == 0 &&
      journal.ProvisionWorkspace(reference) == 0 && journal.ProvisionDisk(reference, 10000) == 0,
      "format journal fixture owns an actual exclusively created unmounted VHDX");
    std::vector<CellFormatProvisioningRecord> no_format(1);
    Check(journal.RecordFormatCheckpoints(&no_format) == 0 && no_format.empty(), "creation-only export never invents formatting history");
    CellDiskLayoutPlan layout_plan;
    Check(journal.RecordDiskLayoutPlan(&layout_plan) == 0, "format fixture retains the original immutable layout binding");
    VolumeFixture volume{&journal, layout_plan};
    Check(volume.Run() == 0, "format fixture uses the acknowledged six-record volume protocol");
    std::array<CellDiskLayoutCheckpoint, 4> layouts;
    for (std::size_t index = 0; index < layouts.size(); ++index)
      std::copy_n(volume.committed[index + 2].begin() + 280, 512, layouts[index].begin());
    CellDiskLayoutSnapshot snapshot;
    Check(DecodeCellDiskLayoutCheckpoints(layout_plan, layouts, &snapshot) == 0, "format extent comes from the recorded GPT snapshot");
    CellNtfsFormatBinding binding;
    binding.partition_bytes = snapshot.data_length;
    binding.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
    std::copy_n(layouts.back().end() - 32, 32, binding.layout_sha256.begin());
    FormatFixture fixture{&journal, binding};
    Handle cancel;
    if (mode == 1 || mode == 2) fixture.fail = mode;
    if (mode == 3 || mode == 4) fixture.wrong = mode - 2;
    if (mode == 5) fixture.revoked = true;
    if (mode == 6 || mode == 7) fixture.revoke_after_commit = mode - 5;
    if (mode == 8) fixture.revoke_after_verify = true;
    if (mode == 9) fixture.submission_error = ERROR_TIMEOUT;
    if (mode == 10) { cancel.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); Check(cancel.value != nullptr, "format cancellation event"); fixture.cancellation = cancel.value; }
    if (mode == 11) fixture.binding.partition_bytes += 1024 * 1024;
    if (!mode) {
      Check(journal.ProvisionFormat(reference, {}, 10000) == ERROR_INVALID_PARAMETER &&
        journal.ProvisionFormat(reference, fixture.Committer(), 0) == ERROR_INVALID_PARAMETER,
        "formatting refuses absent current authority and an unbounded duration");
      auto foreign = reference; foreign.prepared_sha256[0] ^= 1;
      Check(journal.ProvisionFormat(foreign, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
        "formatting refuses another creation anchor before any OS operation");
    }
    const DWORD result = fixture.Run();
    const unsigned attempted = mode == 5 || mode == 11 ? 0 : mode == 1 || mode == 3 || mode == 6 || mode == 9 || mode == 10 ? 1 : 2;
    Check((result == ERROR_SUCCESS) == (mode == 0) && fixture.attempted.size() == attempted,
      "format faults stop at the exact acknowledged boundary");
    Check(fixture.submissions == (attempted == 2 || mode == 9 ? 1U : 0U),
      "only an acknowledged intent with current authority can reach the controlled formatter submission");
    if (mode == 9) Check(result == ERROR_TIMEOUT, "a provider timeout stays uncertain with intent only");
    if (mode == 10) Check(result == ERROR_CANCELLED, "cancellation during the intent acknowledgement stops submission");
    Check(fixture.Run() == ERROR_INVALID_STATE, "failed or completed journal owners cannot repeat formatting");
    const auto captured = CellProvisioningJournalTestPeer::Bytes(journal);
    Check(captured.size() == 11264 + attempted * 1024, "format records append within the original allocation reservation");
    Check(journal.Phase() == CellProvisioningPhase::disk_recorded && journal.VolumePhase() == CellVolumeProvisioningPhase::partitioned &&
      static_cast<unsigned>(journal.FormatPhase()) == attempted, "creation, volume and format progress stay distinct");
    for (std::size_t index = 0; index < core.committed.size(); ++index)
      Check(std::equal(core.committed[index].begin(), core.committed[index].end(), captured.begin() + index * 1024), "format preserves each creation record");
    for (std::size_t index = 0; index < volume.committed.size(); ++index)
      Check(std::equal(volume.committed[index].begin(), volume.committed[index].end(), captured.begin() + 5120 + index * 1024), "format preserves each volume record");
    CellFileSha256 base{};
    std::copy_n(core.committed.back().end() - 32, 32, base.begin());
    if (attempted) Check(ValidateCellFormatProvisioningPrefix(format_plan, reference.file, layout_plan.disk, base,
      volume.committed, fixture.attempted) == 0, "pure validation accepts the exact outer/nested format prefix without granting readiness");
    journal.Close();
    Check(Read(file) == captured, "uncertain formatting retains every flushed byte across handle closure");
    Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, format_name, user, format_plan, reference) == 0,
      "a fresh reader decodes retained creation, GPT and formatting metadata");
    Check(journal.ProvisionFormat(reference, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
      "recovered metadata never restores the original formatting authority");
    journal.Close();
    if (attempted) {
      const DWORD expected_recovery = attempted == 1 ? ERROR_IO_INCOMPLETE : ERROR_NOT_SUPPORTED;
      Check(journal.OpenRecorded(parent, parent_identity, format_name, user, user, format_plan, reference, volume.committed) ==
        expected_recovery, "volume-only recovery cannot ignore formatting intent or completion");
      journal.Close();
    }
    if (mode) continue;
    committed_format_history.resize(13);
    for (std::size_t index = 0; index < committed_format_history.size(); ++index)
      std::copy_n(captured.begin() + index * 1024, 1024, committed_format_history[index].begin());
    auto foreign = fixture.committed; foreign.back().back() ^= 1;
    Check(journal.OpenRecorded(parent, parent_identity, format_name, user, user, format_plan, reference, volume.committed, foreign) == ERROR_CRC,
      "recovery compares exact independently retained format bytes before probing native state");
    journal.Close();
    Check(journal.OpenRecorded(parent, parent_identity, format_name, user, user, format_plan, reference, volume.committed, fixture.committed) != 0,
      "complete simulated formatting history never substitutes for physical attachment and NTFS verification");
    journal.Close();
    Check(ValidateCellFormatProvisioningPrefix(format_plan, reference.file, layout_plan.disk, base, {}, fixture.committed) != 0 &&
      ValidateCellFormatProvisioningPrefix(format_plan, reference.file, layout_plan.disk, base, volume.committed, {}) != 0,
      "format metadata requires a complete independently bound volume history and nonempty format records");
    for (const std::size_t size : {11264U, 12288U, 13311U, 14336U}) {
      auto changed = captured; changed.resize(size);
      Write(file, changed);
      Check(journal.OpenRecorded(parent, parent_identity, format_name, user, user, format_plan, reference, volume.committed, fixture.committed) != 0,
        "canonical formatting records reject rollback, interrupted intent, torn completion and extra records");
      journal.Close();
      Check(Read(file) == changed, "recovery preserves the exact incomplete or corrupt format journal");
    }
    for (const std::size_t offset : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 128U, 144U, 168U, 192U, 216U, 248U, 264U,
      280U, 288U, 296U, 328U, 360U, 376U, 384U, 388U, 392U, 464U, 488U, 792U}) {
      auto changed = captured; changed[11264 + offset] ^= 1;
      BCRYPT_ALG_HANDLE algorithm = nullptr;
      Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "independent formatter journal test hasher");
      bool hashed = true;
      for (std::size_t position = 11264; position < changed.size(); position += 1024) {
        if (position > 11264) {
          std::copy_n(changed.begin() + position - 32, 32, changed.begin() + position + 16);
          std::copy_n(changed.begin() + position - 1024 + 760, 32, changed.begin() + position + 296);
        }
        if (BCryptHash(algorithm, nullptr, 0, changed.data() + position + 280, 480, changed.data() + position + 760, 32) < 0 ||
            BCryptHash(algorithm, nullptr, 0, changed.data() + position, 992, changed.data() + position + 992, 32) < 0) hashed = false;
      }
      BCryptCloseAlgorithmProvider(algorithm, 0);
      Check(hashed, "format corruption fixture has valid nested and outer digests");
      Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, format_name, user, format_plan, reference) != 0,
        "rehashing cannot legitimize changed format authority, geometry, result, reserved bytes or record order");
      journal.Close();
    }
    Write(file, captured);
  }
  for (unsigned mode = 0; mode <= 11; ++mode) {
    const auto protection_name = Name(), file = parent_path + L"\\" + protection_name + L".provisioning";
    auto protection_plan = plan;
    protection_plan.disk.virtual_bytes = 64ULL * 1024 * 1024;
    protection_plan.disk.reserved_file_bytes = 128ULL * 1024 * 1024;
    CommitFixture core;
    CellProvisioningCommitter core_sink{CommitFixture::Commit, &core};
    CellProvisioningAnchor reference;
    Check(journal.Create(parent, parent_identity, protection_name, user, user, protection_plan, &reference, &core_sink) == 0 &&
      journal.ProvisionWorkspace(reference) == 0 && journal.ProvisionDisk(reference, 10000) == 0,
      "protection fixture owns an exclusive journal and unattached VHDX");
    std::vector<CellProtectionProvisioningRecord> empty(1);
    Check(journal.RecordProtectionCheckpoints(&empty) == 0 && empty.empty(), "creation export cannot invent root protection");
    Check(journal.ProvisionProtection(reference, {}, 10000) == ERROR_INVALID_STATE, "unformatted journal cannot reach a protection driver");
    CellDiskLayoutPlan layout_plan;
    Check(journal.RecordDiskLayoutPlan(&layout_plan) == 0, "protection fixture retains original layout identity");
    VolumeFixture volume{&journal, layout_plan};
    Check(volume.Run() == 0, "protection fixture has all acknowledged volume records");
    std::array<CellDiskLayoutCheckpoint, 4> layouts{};
    for (std::size_t index = 0; index < layouts.size(); ++index)
      std::copy_n(volume.committed[index + 2].begin() + 280, 512, layouts[index].begin());
    CellDiskLayoutSnapshot snapshot;
    Check(DecodeCellDiskLayoutCheckpoints(layout_plan, layouts, &snapshot) == 0, "protection fixture has exact recorded geometry");
    CellNtfsFormatBinding format_binding;
    format_binding.partition_bytes = snapshot.data_length;
    format_binding.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
    std::copy_n(layouts.back().end() - 32, 32, format_binding.layout_sha256.begin());
    FormatFixture formatted{&journal, format_binding};
    Check(formatted.Run() == 0, "protection fixture has both acknowledged NTFS checkpoints without physical formatting");
    const auto before = CellProvisioningJournalTestPeer::Bytes(journal);
    CellVolumeProtectionBinding binding;
    binding.volume_id = format_binding.volume_id; binding.partition_bytes = snapshot.data_length;
    std::array<CellNtfsFormatCheckpoint, 2> formats{};
    for (std::size_t index = 0; index < formats.size(); ++index)
      std::copy_n(formatted.committed[index].begin() + 280, 512, formats[index].begin());
    Check(DecodeCellNtfsFormatCheckpoints(format_binding, formats, &binding.ntfs) == 0, "protection uses the exact completed NTFS identity");
    std::copy_n(formats.back().end() - 32, 32, binding.format_sha256.begin());
    binding.root.volume_serial = binding.ntfs.serial; binding.root.file_id.fill(0xd6);
    std::vector<std::uint8_t> descriptor;
    Check(BuildCellParentSecurity(user, user, &descriptor) == 0, "protection fixture freezes existing controller security");
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    Check(HashCellVolumeRootSecurity(user, user, &binding.security_sha256) == 0, "portable frozen security policy digest retained");
    ProtectionFixture fixture{&journal, binding}; Handle cancel;
    if (mode == 1 || mode == 2) fixture.fail = mode;
    if (mode == 3 || mode == 4) fixture.wrong = mode - 2;
    if (mode == 5) fixture.revoked = true;
    if (mode == 6 || mode == 7) fixture.revoke_after_commit = mode - 5;
    if (mode == 8) fixture.revoke_after_verify = true;
    if (mode == 9) fixture.submission_error = ERROR_TIMEOUT;
    if (mode == 10) { cancel.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); Check(cancel.value != nullptr, "protection cancellation event"); fixture.cancellation = cancel.value; }
    if (mode == 11) fixture.binding.security_sha256[0] ^= 1;
    const DWORD result = fixture.Run();
    const unsigned attempted = mode == 5 || mode == 11 ? 0 : mode == 1 || mode == 3 || mode == 6 || mode == 9 || mode == 10 ? 1 : 2;
    Check((result == ERROR_SUCCESS) == (mode == 0) && fixture.attempted.size() == attempted,
      "protection fault stops at the exact acknowledged boundary");
    Check(fixture.submissions == (attempted == 2 || mode == 9 ? 1U : 0U),
      "protection cannot submit even a controlled security write before acknowledged intent");
    Check(fixture.Run() == ERROR_INVALID_STATE, "completed and failed creators cannot repeat root protection");
    if (mode == 9) Check(result == ERROR_TIMEOUT, "unknown OS protection result preserves intent only");
    if (mode == 10) Check(result == ERROR_CANCELLED, "cancellation after intent prevents protection submission");
    const auto captured = CellProvisioningJournalTestPeer::Bytes(journal);
    Check(captured.size() == 13312 + attempted * 1024 && std::equal(before.begin(), before.end(), captured.begin()),
      "protection preserves all thirteen prior records within the same reservation");
    Check(journal.Phase() == CellProvisioningPhase::disk_recorded && journal.VolumePhase() == CellVolumeProvisioningPhase::partitioned &&
      journal.FormatPhase() == CellFormatProvisioningPhase::formatted && static_cast<unsigned>(journal.ProtectionPhase()) == attempted,
      "four provisioning stages keep distinct progress");
    CellFileSha256 base{}; std::copy_n(core.committed.back().end() - 32, 32, base.begin());
    if (attempted) Check(ValidateCellProtectionProvisioningPrefix(protection_plan, reference.file, layout_plan.disk, base,
      user, user, volume.committed, formatted.committed, fixture.attempted) == 0, "pure decoder validates exact outer and nested protection records");
    journal.Close();
    Check(Read(file) == captured, "every acknowledged or uncertain protection byte survives closure");
    Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, protection_name, user, protection_plan, reference) == 0,
      "new metadata reader decodes all four retained stages");
    Check(journal.ProvisionProtection(reference, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
      "metadata recovery cannot restore original protection authority");
    journal.Close();
    if (attempted) {
      const DWORD expected = attempted == 1 ? ERROR_IO_INCOMPLETE : ERROR_NOT_SUPPORTED;
      Check(journal.OpenRecorded(parent, parent_identity, protection_name, user, user, protection_plan, reference,
        volume.committed, formatted.committed) == expected, "format-only recovery cannot omit protection history");
      journal.Close();
    }
    if (mode) continue;
    committed_protection_history.resize(15);
    for (std::size_t index = 0; index < committed_protection_history.size(); ++index)
      std::copy_n(captured.begin() + index * 1024, 1024, committed_protection_history[index].begin());
    auto foreign = fixture.committed; foreign.back().back() ^= 1;
    Check(journal.OpenRecorded(parent, parent_identity, protection_name, user, user, protection_plan, reference,
      volume.committed, formatted.committed, foreign) == ERROR_CRC, "protection recovery compares independently retained exact bytes before OS probing");
    journal.Close();
    Check(journal.OpenRecorded(parent, parent_identity, protection_name, user, user, protection_plan, reference,
      volume.committed, formatted.committed, fixture.committed) != 0, "complete controlled history cannot substitute for real physical recovery");
    journal.Close(); Check(Read(file) == captured, "physical recovery refusal preserves the complete journal");
    Check(ValidateCellProtectionProvisioningPrefix(protection_plan, reference.file, layout_plan.disk, base,
      user, user, volume.committed, {}, fixture.committed) != 0 &&
      ValidateCellProtectionProvisioningPrefix(protection_plan, reference.file, layout_plan.disk, base,
        user, user, {}, formatted.committed, fixture.committed) != 0 &&
      ValidateCellProtectionProvisioningPrefix(protection_plan, reference.file, layout_plan.disk, base,
        user, user, volume.committed, formatted.committed, {}) != 0,
      "protection requires complete creation/volume/format anchors and nonempty protection history");
    Check(ValidateCellProtectionProvisioningPrefix(protection_plan, reference.file, layout_plan.disk, base,
      L"S-1-5-21-1-2-3-4", user, volume.committed, formatted.committed, fixture.committed) != 0,
      "protection cannot replace the frozen controller descriptor owner");
    for (const std::size_t size : {13312U, 14336U, 15359U, 16384U}) {
      auto changed = captured; changed.resize(size); Write(file, changed);
      Check(journal.OpenRecorded(parent, parent_identity, protection_name, user, user, protection_plan, reference,
        volume.committed, formatted.committed, fixture.committed) != 0, "canonical protection refuses rollback, torn records and unknown suffixes");
      journal.Close(); Check(Read(file) == changed, "refused protection history is never repaired or truncated");
    }
    for (const std::size_t offset : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 128U, 144U, 168U, 192U, 216U, 248U, 264U,
      280U, 288U, 292U, 296U, 328U, 360U, 392U, 408U, 416U, 424U, 432U, 440U, 448U, 464U, 792U}) {
      auto changed = captured; changed[13312 + offset] ^= 1;
      algorithm = nullptr;
      Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "independent protection journal hasher");
      bool valid_hashes = true;
      for (std::size_t position = 13312; position < changed.size(); position += 1024) {
        if (position > 13312) {
          std::copy_n(changed.begin() + position - 32, 32, changed.begin() + position + 16);
          std::copy_n(changed.begin() + position - 1024 + 760, 32, changed.begin() + position + 296);
        }
        if (BCryptHash(algorithm, nullptr, 0, changed.data() + position + 280, 480, changed.data() + position + 760, 32) < 0 ||
            BCryptHash(algorithm, nullptr, 0, changed.data() + position, 992, changed.data() + position + 992, 32) < 0) valid_hashes = false;
      }
      BCryptCloseAlgorithmProvider(algorithm, 0); Check(valid_hashes, "protection corruption fixture has valid outer and nested hashes");
      Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, protection_name, user, protection_plan, reference) != 0,
        "rehashing cannot legitimize changed protection binding, geometry, security, phase or padding");
      journal.Close();
    }
    Write(file, captured);
  }
  for (unsigned mode = 0; mode <= 23; ++mode) {
    const auto mount_name = Name(), file = parent_path + L"\\" + mount_name + L".provisioning";
    auto mount_plan = plan;
    mount_plan.disk.virtual_bytes = 64ULL * 1024 * 1024; mount_plan.disk.reserved_file_bytes = 128ULL * 1024 * 1024;
    CommitFixture core; CellProvisioningCommitter core_sink{CommitFixture::Commit, &core}; CellProvisioningAnchor reference;
    Check(journal.Create(parent, parent_identity, mount_name, user, user, mount_plan, &reference, &core_sink) == 0 &&
      journal.ProvisionWorkspace(reference) == 0 && journal.ProvisionDisk(reference, 10000) == 0,
      "mount fixture owns an exclusive journal and unattached VHDX");
    std::vector<CellMountProvisioningRecord> empty(1);
    Check(journal.RecordMountCheckpoints(&empty) == 0 && empty.empty(), "creation export cannot invent a mount");
    Check(journal.ProvisionMount(reference, {}, 10000) == ERROR_INVALID_STATE, "unprotected journal cannot invoke mount SDK");
    CellDiskLayoutPlan layout_plan; CellWorkspaceIdentities mount_workspace;
    Check(journal.RecordDiskLayoutPlan(&layout_plan) == 0 && journal.RecordWorkspace(&mount_workspace) == 0,
      "mount fixture retains independent workspace and VHDX identities");
    VolumeFixture volume{&journal, layout_plan}; Check(volume.Run() == 0, "mount fixture retains complete controlled layout history");
    std::array<CellDiskLayoutCheckpoint, 4> layouts{};
    for (std::size_t index = 0; index < layouts.size(); ++index)
      std::copy_n(volume.committed[index + 2].begin() + 280, 512, layouts[index].begin());
    CellDiskLayoutSnapshot snapshot;
    Check(DecodeCellDiskLayoutCheckpoints(layout_plan, layouts, &snapshot) == 0, "mount fixture binds exact geometry");
    CellNtfsFormatBinding format_binding;
    format_binding.partition_bytes = snapshot.data_length;
    format_binding.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
    std::copy_n(layouts.back().end() - 32, 32, format_binding.layout_sha256.begin());
    FormatFixture formatted{&journal, format_binding}; Check(formatted.Run() == 0, "mount fixture retains controlled NTFS history");
    std::array<CellNtfsFormatCheckpoint, 2> formats{};
    for (std::size_t index = 0; index < formats.size(); ++index)
      std::copy_n(formatted.committed[index].begin() + 280, 512, formats[index].begin());
    CellVolumeProtectionBinding protection_binding;
    protection_binding.volume_id = format_binding.volume_id; protection_binding.partition_bytes = snapshot.data_length;
    Check(DecodeCellNtfsFormatCheckpoints(format_binding, formats, &protection_binding.ntfs) == 0, "mount fixture retains exact NTFS root metadata");
    std::copy_n(formats.back().end() - 32, 32, protection_binding.format_sha256.begin());
    protection_binding.root.volume_serial = protection_binding.ntfs.serial; protection_binding.root.file_id.fill(0xd6);
    Check(HashCellVolumeRootSecurity(user, user, &protection_binding.security_sha256) == 0, "mount fixture freezes controller policy");
    ProtectionFixture protected_root{&journal, protection_binding}; Check(protected_root.Run() == 0, "mount fixture retains controlled root protection history");
    const auto before = CellProvisioningJournalTestPeer::Bytes(journal);
    CellVolumeMountBinding binding;
    binding.parent = mount_workspace.directories[0]; binding.volume_root = protection_binding.root;
    binding.volume_id = protection_binding.volume_id; binding.security_sha256 = protection_binding.security_sha256;
    std::copy_n(protected_root.committed.back().begin() + 760, 32, binding.protection_sha256.begin());
    MountFixture fixture{&journal, binding}; Handle cancel;
    if (mode >= 1 && mode <= 4) fixture.fail = mode;
    if (mode >= 5 && mode <= 8) fixture.wrong = mode - 4;
    if (mode == 9) fixture.revoked = true;
    if (mode >= 10 && mode <= 13) fixture.revoke_after_commit = mode - 9;
    if (mode == 14) fixture.create_error = ERROR_TIMEOUT;
    if (mode == 15) fixture.mount_error = ERROR_TIMEOUT;
    if (mode >= 16 && mode <= 19) {
      cancel.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); Check(cancel.value != nullptr, "mount cancellation event");
      fixture.cancellation = cancel.value; fixture.cancel_after_commit = mode - 15;
    }
    if (mode == 20) fixture.revoke_after_verify = true;
    if (mode == 21) fixture.binding.security_sha256[0] ^= 1;
    if (mode == 22) fixture.binding.parent.file_id[0] ^= 1;
    if (mode == 23) fixture.fail_verify = 3;
    const DWORD result = fixture.Run();
    const unsigned attempted = mode >= 1 && mode <= 4 ? mode : mode >= 5 && mode <= 8 ? mode - 4 :
      mode == 9 || mode == 21 || mode == 22 ? 0 : mode >= 10 && mode <= 13 ? mode - 9 :
      mode == 14 ? 1 : mode == 15 ? 3 : mode >= 16 && mode <= 19 ? mode - 15 : 4;
    Check((result == ERROR_SUCCESS) == (mode == 0) && fixture.attempted.size() == attempted,
      "mount fault stops at the exact acknowledgement boundary");
    Check(fixture.creates == (attempted > 1 || mode == 14 ? 1U : 0U) && fixture.submissions == (attempted == 4 || mode == 15 ? 1U : 0U),
      "neither directory nor mount submission precedes acknowledged intent");
    Check(fixture.Run() == ERROR_INVALID_STATE, "completed or failed mount attempt cannot repeat");
    if (mode == 14 || mode == 15) Check(result == ERROR_TIMEOUT, "uncertain SDK result leaves intent without repair");
    if (mode >= 16 && mode <= 19) Check(result == ERROR_CANCELLED, "cancellation after each acknowledgement refuses further progress");
    if (mode == 23) Check(result == ERROR_FILE_INVALID, "last authority exchange must precede native identity readback");
    const auto captured = CellProvisioningJournalTestPeer::Bytes(journal);
    Check(captured.size() == 15360 + attempted * 1024 && std::equal(before.begin(), before.end(), captured.begin()),
      "mount preserves all fifteen prior records within the same bounded journal");
    Check(journal.Phase() == CellProvisioningPhase::disk_recorded && journal.VolumePhase() == CellVolumeProvisioningPhase::partitioned &&
      journal.FormatPhase() == CellFormatProvisioningPhase::formatted && journal.ProtectionPhase() == CellProtectionProvisioningPhase::protected_root &&
      static_cast<unsigned>(journal.MountPhase()) == attempted, "five journal stages retain distinct progress");
    CellFileSha256 base{}; std::copy_n(core.committed.back().end() - 32, 32, base.begin());
    if (attempted) Check(ValidateCellMountProvisioningPrefix(mount_plan, reference.file, mount_workspace, layout_plan.disk, base, user, user,
      volume.committed, formatted.committed, protected_root.committed, fixture.attempted) == 0, "pure decoder accepts exact outer and nested mount prefix");
    journal.Close(); Check(Read(file) == captured, "all acknowledged and uncertain mount bytes survive closure");
    Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, mount_name, user, mount_plan, reference) == 0,
      "new metadata reader decodes all five retained stages");
    Check(journal.ProvisionMount(reference, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
      "metadata recovery cannot restore original mounting authority");
    journal.Close();
    if (attempted) {
      const DWORD expected = attempted < 4 ? ERROR_IO_INCOMPLETE : ERROR_NOT_SUPPORTED;
      Check(journal.OpenRecorded(parent, parent_identity, mount_name, user, user, mount_plan, reference,
        volume.committed, formatted.committed, protected_root.committed) == expected, "protection-only recovery cannot omit mount history");
      journal.Close();
    }
    if (mode) continue;
    committed_mount_history.resize(19);
    for (std::size_t index = 0; index < committed_mount_history.size(); ++index)
      std::copy_n(captured.begin() + index * 1024, 1024, committed_mount_history[index].begin());
    CellWorkspaceIdentities checked_workspace; CellVirtualDiskRecord checked_disk; CellFileSha256 checked_base{};
    const auto validate_core = [&](std::span<const CellProvisioningRecord> records) {
      return ValidateCellProvisioningHistory(mount_plan, parent_identity, mount_name, user, user, reference,
        records, &checked_workspace, &checked_disk, &checked_base);
    };
    Check(validate_core(core.committed) == 0 && checked_workspace == mount_workspace && checked_disk.control == layout_plan.disk.control &&
      checked_disk.backing == layout_plan.disk.backing && checked_base == base, "independent creation history recovers all original mount identities");
    for (std::size_t size = 0; size < 5; ++size) {
      Check(validate_core(std::span<const CellProvisioningRecord>(core.committed).first(size)) != 0 &&
        checked_workspace == CellWorkspaceIdentities{} && checked_disk.backing == CellFileIdentity{} && checked_base == CellFileSha256{},
        "partial core history cannot populate recovery identities");
    }
    auto excess_core = core.committed; excess_core.push_back(core.committed.back());
    Check(validate_core(excess_core) != 0, "creation recovery rejects a sixth record");
    for (const std::size_t offset : {0U, 8U, 16U, 48U, 80U, 112U, 128U, 144U, 168U, 192U, 232U, 416U, 600U, 624U, 648U, 672U, 696U, 720U, 991U}) {
      auto changed = core.committed; auto& last = changed.back(); last[offset] ^= 1;
      BCRYPT_ALG_HANDLE algorithm = nullptr;
      Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "core history mutation SHA provider");
      const auto hashed = BCryptHash(algorithm, nullptr, 0, last.data(), 992, last.data() + 992, 32);
      BCryptCloseAlgorithmProvider(algorithm, 0);
      Check(hashed >= 0 && validate_core(changed) != 0 && checked_workspace == CellWorkspaceIdentities{} &&
        checked_disk.backing == CellFileIdentity{} && checked_base == CellFileSha256{}, "rehashed core substitution cannot become mount recovery authority");
    }
    Check(ValidateCellProvisioningHistory(mount_plan, parent_identity, mount_name, L"S-1-5-18", user, reference, core.committed,
      &checked_workspace, &checked_disk, &checked_base) != 0, "independent core history binds original principals");
    auto changed_anchor = reference; changed_anchor.prepared_sha256[0] ^= 1;
    Check(ValidateCellProvisioningHistory(mount_plan, parent_identity, mount_name, user, user, changed_anchor, core.committed,
      &checked_workspace, &checked_disk, &checked_base) != 0, "independent core history requires the canonical prepared digest");
    auto foreign = fixture.committed; foreign.back().back() ^= 1;
    Check(journal.OpenRecorded(parent, parent_identity, mount_name, user, user, mount_plan, reference,
      volume.committed, formatted.committed, protected_root.committed, foreign) == ERROR_CRC,
      "mount recovery compares complete independently retained bytes before physical probing");
    journal.Close();
    Check(journal.OpenRecorded(parent, parent_identity, mount_name, user, user, mount_plan, reference,
      volume.committed, formatted.committed, {}, fixture.committed) == ERROR_INVALID_PARAMETER,
      "mount records cannot omit prior canonical protection authority");
    Check(journal.OpenRecorded(parent, parent_identity, mount_name, user, user, mount_plan, reference,
      volume.committed, formatted.committed, protected_root.committed, fixture.committed) != 0,
      "complete controlled history cannot pretend the physical VHDX was mounted");
    journal.Close(); Check(Read(file) == captured, "physical recovery refusal leaves all nineteen records intact");
    auto wrong_workspace = mount_workspace; wrong_workspace.directories[0].file_id[0] ^= 1;
    Check(ValidateCellMountProvisioningPrefix(mount_plan, reference.file, wrong_workspace, layout_plan.disk, base, user, user,
      volume.committed, formatted.committed, protected_root.committed, fixture.committed) != 0, "different recorded host root cannot be substituted");
    Check(ValidateCellMountProvisioningPrefix(mount_plan, reference.file, mount_workspace, layout_plan.disk, base, L"S-1-5-21-1-2-3-4", user,
      volume.committed, formatted.committed, protected_root.committed, fixture.committed) != 0, "mount policy cannot replace frozen controller custody");
    for (const std::size_t size : {15360U, 16384U, 17408U, 18432U, 19455U, 20480U}) {
      auto changed = captured; changed.resize(size); Write(file, changed);
      Check(journal.OpenRecorded(parent, parent_identity, mount_name, user, user, mount_plan, reference,
        volume.committed, formatted.committed, protected_root.committed, fixture.committed) != 0,
        "canonical mount recovery refuses rollback, partial/torn records and suffixes");
      journal.Close(); Check(Read(file) == changed, "refused mount history is never repaired or truncated");
    }
    const auto rehash = [&](std::vector<std::uint8_t>& changed) {
      BCRYPT_ALG_HANDLE algorithm = nullptr;
      Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "independent mount journal hasher");
      bool valid = true;
      for (std::size_t position = 15360; position < changed.size(); position += 1024) {
        if (position > 15360) {
          std::copy_n(changed.begin() + position - 32, 32, changed.begin() + position + 16);
          std::copy_n(changed.begin() + position - 1024 + 760, 32, changed.begin() + position + 296);
        }
        if (BCryptHash(algorithm, nullptr, 0, changed.data() + position + 280, 480, changed.data() + position + 760, 32) < 0 ||
            BCryptHash(algorithm, nullptr, 0, changed.data() + position, 992, changed.data() + position + 992, 32) < 0) valid = false;
      }
      BCryptCloseAlgorithmProvider(algorithm, 0); Check(valid, "mount corruption fixtures have valid nested and outer hashes");
    };
    for (const std::size_t offset : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 128U, 144U, 168U, 192U, 216U, 248U, 264U,
      280U, 288U, 292U, 296U, 328U, 360U, 392U, 408U, 416U, 432U, 440U, 456U, 464U, 480U, 792U}) {
      auto changed = captured; changed[15360 + offset] ^= 1; rehash(changed); Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, mount_name, user, mount_plan, reference) != 0,
        "rehashing cannot legitimize changed mount binding, parent, root, phase or padding");
      journal.Close();
    }
    for (const auto& forbidden : {mount_workspace.parent, mount_workspace.directories[0], mount_workspace.directories[1], mount_workspace.directories[2],
        mount_workspace.directories[3], layout_plan.disk.backing, reference.file}) {
      auto changed = captured;
      for (std::size_t position = 16384; position < changed.size(); position += 1024) {
        std::memcpy(changed.data() + position + 456, &forbidden.volume_serial, 8);
        std::copy(forbidden.file_id.begin(), forbidden.file_id.end(), changed.begin() + position + 464);
      }
      rehash(changed); Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, mount_name, user, mount_plan, reference) != 0,
        "consistent rehashed history cannot reuse another protected host object as mount directory");
      journal.Close();
    }
    Write(file, captured);
  }
  return checks;
}
namespace {
CellDirectoryFootprint& CapacitySummary(CellDirectoryFootprint& value) { return value; }
CellDirectoryFootprint& CapacitySummary(CellDirectoryInventory& value) { return value.footprint; }
const CellDirectoryFootprint& CapacityValue(const CellProvisioningFootprint& value) { return value.footprint; }
const CellDirectoryInventory& CapacityValue(const CellProvisioningInventory& value) { return value.inventory; }
template <typename Observation>
struct CapacityFixture final {
  using Bound = std::conditional_t<std::is_same_v<Observation, CellDirectoryFootprint>, CellProvisioningFootprint, CellProvisioningInventory>;
  CellProvisioningJournal* journal;
  Observation actual;
  unsigned calls = 0, reads = 0, denied_at = 0, drift_at = 0, drift_kind = 0, after_read_drift = 0;
  DWORD read_error = ERROR_SUCCESS, delay_ms = 0;
  bool wrong_root = false;
  CellFootprintScanLimits* change_limits = nullptr;
  CellFileSha256* change_head = nullptr;
  HANDLE cancellation = nullptr;
  unsigned cancel_at = 0;
  const CellFootprintCellBinding* binding = nullptr;
  CellFootprintCellBinding* change_binding = nullptr;
  static DWORD Authorize(void* raw) noexcept {
    auto& value = *static_cast<CapacityFixture*>(raw); ++value.calls;
    if (value.change_binding) *value.change_binding = {};
    if (value.calls == value.denied_at) return ERROR_ACCESS_DENIED;
    if (value.calls == value.drift_at) CellProvisioningJournalTestPeer::DriftCapacityBinding(*value.journal, value.drift_kind);
    if (value.change_limits) value.change_limits->max_entries = 65536;
    if (value.change_head) value.change_head->back() ^= 1;
    if (value.calls == value.cancel_at && !SetEvent(value.cancellation)) return GetLastError();
    if (value.delay_ms) Sleep(value.delay_ms);
    return ERROR_SUCCESS;
  }
  static DWORD Read(void* raw, const CellFootprintScanLimits&, const CellFootprintScanGuard& guard,
    Observation* output) noexcept {
    try {
    auto& value = *static_cast<CapacityFixture*>(raw); ++value.reads;
    for (unsigned index = 0; index < 2; ++index) {
      const auto error = guard.authorize(guard.context); if (error) return error;
    }
    *output = value.actual;
    if (value.wrong_root) CapacitySummary(*output).root.file_id.back() ^= 1;
    if (value.after_read_drift) CellProvisioningJournalTestPeer::DriftCapacityBinding(*value.journal, value.after_read_drift);
    return value.read_error;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  DWORD Observe(const CellProvisioningAnchor& anchor, const CellFileSha256& head, Bound* output,
    const CellFootprintScanLimits& limits = {}) {
    if constexpr (std::is_same_v<Observation, CellDirectoryInventory>)
      return CellProvisioningJournalTestPeer::Observe(*journal, Read, this, anchor, head, limits,
        {Authorize, this, cancellation}, output, binding);
    else return CellProvisioningJournalTestPeer::Observe(*journal, Read, this, anchor, head, limits,
      {Authorize, this, cancellation}, output);
  }
};
template <typename Observation>
void CapacityJournalTests(CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
  const CellProvisioningPlan& plan, const CellMountedWorkspaceBinding& binding,
  const std::vector<CellMountedWorkspaceProvisioningRecord>& records) {
  const auto before = CellProvisioningJournalTestPeer::Bytes(journal);
  CellFileSha256 head{}; std::copy_n(before.end() - 32, 32, head.begin());
  std::array<CellMountedWorkspaceCheckpoint, 2> nested{};
  for (std::size_t index = 0; index < nested.size(); ++index)
    std::copy_n(records[index].begin() + 280, 512, nested[index].begin());
  CellWorkspaceIdentities workspace;
  Check(DecodeCellMountedWorkspaceCheckpoints(binding, nested, &workspace) == 0, "capacity fixture derives roots from the acknowledged native records");
  using Fixture = CapacityFixture<Observation>;
  using Output = typename Fixture::Bound;
  const Observation actual = [&]() -> Observation {
    const CellDirectoryFootprint footprint{workspace.directories[0], 17, 4096, 1, 4};
    if constexpr (std::is_same_v<Observation, CellDirectoryFootprint>) return footprint;
    else {
      Observation inventory; inventory.footprint = footprint;
      for (const auto& identity : workspace.directories) inventory.entries.push_back({identity, true, 0, 0});
      auto file = workspace.directories[0]; file.file_id.back() ^= 0x40;
      inventory.entries.push_back({file, false, 17, 4096});
      std::sort(inventory.entries.begin(), inventory.entries.end(), [](const auto& a, const auto& b) { return a.identity.file_id < b.identity.file_id; });
      return inventory;
    }
  }();
  Fixture baseline{&journal, actual}; Output output;
  Check(baseline.Observe(anchor, head, &output) == 0 && output.anchor == anchor && output.assignment_binding == plan.assignment_binding &&
    output.profile_sha256 == plan.profile_sha256 && output.checkpoint_sha256 == head && output.workspace == workspace && CapacityValue(output) == actual,
    "capacity observation binds exact anchor, assignment, profile, complete journal head and recorded workspace");
  const auto poison = output; const auto calls = baseline.calls;
  Check(calls == 3 && baseline.reads == 1, "one controlled reader is bounded by initial and in-reader authority checks");
  Check(CellProvisioningJournalTestPeer::Bytes(journal) == before, "successful capacity observation appends no checkpoint");
  for (unsigned at = 1; at <= calls; ++at) {
    Fixture denied{&journal, actual}; denied.denied_at = at; output = poison;
    Check(denied.Observe(anchor, head, &output) == ERROR_ACCESS_DENIED && denied.calls == at && output == Output{},
      "revoked capacity authority clears bindings and numbers at every read boundary");
  }
  for (unsigned kind = 1; kind <= 15; ++kind) {
    for (const auto at : {1U, calls}) {
      Fixture drift{&journal, actual}; drift.drift_at = at; drift.drift_kind = kind; output = poison;
      const auto error = drift.Observe(anchor, head, &output);
      CellProvisioningJournalTestPeer::DriftCapacityBinding(journal, kind);
      Check(error != 0 && drift.calls == at && output == Output{},
        "binding or journal drift during authority cannot publish an earlier capacity reading");
    }
    Fixture late{&journal, actual}; late.after_read_drift = kind; output = poison;
    const auto error = late.Observe(anchor, head, &output);
    CellProvisioningJournalTestPeer::DriftCapacityBinding(journal, kind);
    Check(error != 0 && output == Output{}, "post-reader binding drift is detected before any output publication");
  }
  Fixture mismatch{&journal, actual}; auto wrong_anchor = anchor; wrong_anchor.file.file_id.back() ^= 1;
  output = poison;
  Check(mismatch.Observe(wrong_anchor, head, &output) != 0 && !mismatch.calls && !mismatch.reads && output == Output{},
    "independent anchor mismatch is refused before authority callbacks or inventory");
  auto wrong_head = head; wrong_head.back() ^= 1; output = poison;
  Check(mismatch.Observe(anchor, wrong_head, &output) != 0 && !mismatch.calls && !mismatch.reads && output == Output{},
    "independent final head mismatch cannot be adopted from local history");
  Fixture changed_input{&journal, actual}; auto caller_head = head; changed_input.change_head = &caller_head;
  Check(changed_input.Observe(anchor, caller_head, &output) == 0 && output.checkpoint_sha256 == head,
    "caller mutation cannot replace the independently frozen expected head");
  Fixture wrong_tree{&journal, actual}; wrong_tree.wrong_root = true; output = poison;
  Check(wrong_tree.Observe(anchor, head, &output) != 0 && output == Output{},
    "a successful reader for another root cannot be labeled with this journal");
  Fixture failed{&journal, actual}; failed.read_error = ERROR_IO_INCOMPLETE; output = poison;
  Check(failed.Observe(anchor, head, &output) == ERROR_IO_INCOMPLETE && output == Output{},
    "a reader error cannot leak a partial footprint or restore availability");
  Fixture bounded{&journal, actual}; CellFootprintScanLimits limits{4, 64, 10000}; bounded.change_limits = &limits; output = poison;
  Check(bounded.Observe(anchor, head, &output, limits) != 0 && output == Output{},
    "the journal freezes limits and refuses counts beyond its original bound");
  if constexpr (std::is_same_v<Observation, CellDirectoryInventory>) {
    struct Binding final {
      std::wstring name;
      CellFileIdentity work;
      mutable unsigned calls = 0;
      unsigned denied_at = 0;
      CellProvisioningJournal* journal = nullptr;
      unsigned drift_kind = 0, drift_at = 0;
      static DWORD Authorize(const void* raw, const std::wstring& name, const CellFileIdentity& work) noexcept {
        const auto& self = *static_cast<const Binding*>(raw); ++self.calls;
        if (self.journal && self.calls == self.drift_at) CellProvisioningJournalTestPeer::DriftCapacityBinding(*self.journal, self.drift_kind);
        return self.calls == self.denied_at || name != self.name || work != self.work ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
      }
    } owned{binding.cell_name, workspace.directories[static_cast<std::size_t>(CellDirectory::work)]};
    CellFootprintCellBinding cell_binding{Binding::Authorize, &owned};
    Fixture bound{&journal, actual}; bound.binding = &cell_binding;
    Check(bound.Observe(anchor, head, &output) == 0 && owned.calls == calls && output == poison,
      "journal binding receives the decoded cell name and guest work identity at each scan boundary");
    CellDirectoryInventoryPins retained;
    output = poison;
    Check(journal.CaptureMountedInventory(anchor, head, {}, {Fixture::Authorize, &baseline}, {}, retained, &output) ==
      ERROR_INVALID_PARAMETER && output == Output{} && !retained.Ready(),
      "retained journal capture requires independent cell authority and clears provisional evidence");
    Check(journal.CaptureMountedInventory(anchor, head, {}, {Fixture::Authorize, &baseline}, cell_binding, retained, nullptr) ==
      ERROR_INVALID_PARAMETER && !retained.Ready(), "retained journal capture refuses a null output before opening handles");
    output = poison;
    Check(journal.CaptureMountedInventory(anchor, head, {}, {Fixture::Authorize, &baseline}, cell_binding, retained, &output) ==
      ERROR_INVALID_STATE && output == Output{} && !retained.Ready(),
      "retained journal capture cannot substitute controlled history for absent physical mounted owners");
    Binding capture_revoked{owned.name, owned.work, 0, 1};
    const CellFootprintCellBinding refused_binding{Binding::Authorize, &capture_revoked};
    output = poison;
    Check(journal.CaptureMountedInventory(anchor, head, {}, {Fixture::Authorize, &baseline}, refused_binding, retained, &output) ==
      ERROR_ACCESS_DENIED && capture_revoked.calls == 1 && output == Output{} && !retained.Ready(),
      "retained journal capture checks current cell authority before entering the mounted reader");
    for (unsigned at = 1; at <= calls; ++at) {
      Binding revoked{owned.name, owned.work, 0, at}; cell_binding = {Binding::Authorize, &revoked};
      Fixture refused{&journal, actual}; refused.binding = &cell_binding; output = poison;
      Check(refused.Observe(anchor, head, &output) == ERROR_ACCESS_DENIED && revoked.calls == at && output == Output{} &&
        (at != 1 || refused.reads == 0), "binding revocation clears inventory and early refusal never enters native reader");
    }
    for (unsigned kind = 0; kind < 2; ++kind) {
      Binding wrong{owned.name, owned.work};
      if (kind == 0) wrong.name.back() ^= 1; else wrong.work.file_id.back() ^= 1;
      cell_binding = {Binding::Authorize, &wrong}; Fixture refused{&journal, actual}; refused.binding = &cell_binding; output = poison;
      Check(refused.Observe(anchor, head, &output) == ERROR_ACCESS_DENIED && !refused.reads && output == Output{},
        "another cell or mismatched work identity cannot authorize mounted guest inventory");
    }
    for (const unsigned kind : {8U, 15U}) for (const unsigned at : {1U, calls}) {
      Binding drift{owned.name, owned.work, 0, 0, &journal, kind, at}; cell_binding = {Binding::Authorize, &drift};
      Fixture refused{&journal, actual}; refused.binding = &cell_binding; output = poison;
      const auto error = refused.Observe(anchor, head, &output);
      CellProvisioningJournalTestPeer::DriftCapacityBinding(journal, kind);
      Check(error == ERROR_FILE_INVALID && drift.calls == at && output == Output{} && (at != 1 || !refused.reads),
        "journal identity or owner lifetime drift inside binding authorization withholds inventory");
    }
    cell_binding = {}; Fixture missing{&journal, actual}; missing.binding = &cell_binding; output = poison;
    Check(missing.Observe(anchor, head, &output) == ERROR_INVALID_PARAMETER && !missing.calls && !missing.reads && output == Output{},
      "explicit empty binding fails before caller callbacks");
    owned.calls = 0; cell_binding = {Binding::Authorize, &owned};
    Fixture changed_binding{&journal, actual}; changed_binding.binding = &cell_binding; changed_binding.change_binding = &cell_binding;
    Check(changed_binding.Observe(anchor, head, &output) == 0 && owned.calls == calls && !cell_binding.authorize && output == poison,
      "caller callback mutation cannot replace the frozen cell binding");
    Fixture oversized{&journal, actual}; output = poison;
    Check(oversized.Observe(anchor, head, &output, {20001, 64, 10000}) == ERROR_INVALID_PARAMETER &&
      !oversized.calls && !oversized.reads && output == Output{}, "oversized identity capture is refused before caller code");
    for (unsigned kind = 0; kind < 13; ++kind) {
      Fixture malformed{&journal, actual};
      auto& entries = malformed.actual.entries;
      auto& summary = malformed.actual.footprint;
      auto file = std::find_if(entries.begin(), entries.end(), [](const auto& entry) { return !entry.directory; });
      auto directory = std::find_if(entries.begin(), entries.end(), [](const auto& entry) { return entry.directory; });
      switch (kind) {
        case 0: entries.pop_back(); break;
        case 1: entries[1].identity = entries[0].identity; break;
        case 2: std::swap(entries.front(), entries.back()); break;
        case 3: file->identity.volume_serial ^= 1; break;
        case 4: file->identity.file_id.fill(0); break;
        case 5: directory->logical_file_bytes = 1; ++summary.logical_file_bytes; break;
        case 6: ++file->logical_file_bytes; break;
        case 7: ++file->allocated_bytes; break;
        case 8: ++summary.file_count; --summary.directory_count; break;
        case 9:
          directory->identity.file_id.back() ^= 0x80;
          std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return a.identity.file_id < b.identity.file_id; });
          break;
        case 10: file->logical_file_bytes = std::numeric_limits<std::uint64_t>::max(); break;
        case 11: file->allocated_bytes = std::numeric_limits<std::uint64_t>::max(); break;
        case 12: entries.push_back(*file); break;
      }
      output = poison;
      Check(malformed.Observe(anchor, head, &output) == ERROR_INVALID_DATA && output == Output{},
        "malformed object identities, membership, ordering or byte totals cannot be bound to a valid journal");
    }
  }
  Handle cancelled{CreateEventW(nullptr, TRUE, FALSE, nullptr)}; Check(cancelled.value != nullptr, "owned journal capacity cancellation event");
  Fixture cancel{&journal, actual}; cancel.cancellation = cancelled.value; cancel.cancel_at = calls; output = poison;
  Check(cancel.Observe(anchor, head, &output) == ERROR_CANCELLED && output == Output{},
    "cancellation during the final authority callback clears all capacity evidence");
  Fixture timed{&journal, actual}; timed.delay_ms = 30; output = poison;
  Check(timed.Observe(anchor, head, &output, {20000, 64, 20}) == ERROR_TIMEOUT && output == Output{},
    "authority callbacks consume the same bounded observation deadline");
  output = poison;
  const auto missing = [&]() {
    if constexpr (std::is_same_v<Observation, CellDirectoryFootprint>)
      return journal.ObserveMountedFootprint(anchor, head, {}, {Fixture::Authorize, &baseline}, &output);
    else return journal.ObserveMountedInventory(anchor, head, {}, {Fixture::Authorize, &baseline}, &output);
  }();
  Check(missing == ERROR_INVALID_STATE && output == Output{}, "production reader refuses the controlled journal's absent physical mounted owners");
  Fixture retry{&journal, actual};
  Check(retry.Observe(anchor, head, &output) == 0 && CellProvisioningJournalTestPeer::Bytes(journal) == before,
    "independent successful observation preserves all twenty-one records after refused reads");
}
}
unsigned RunCellMountedWorkspaceProvisioningJournalTests(HANDLE parent, const CellFileIdentity& parent_identity, const std::wstring& user) {
  checks = 0; committed_mounted_workspace_history.clear();
  const auto parent_path = ParentPath(parent);
  const auto plan = Plan();
  CellProvisioningJournal journal;
  for (unsigned mode = 0; mode <= 18; ++mode) {
    auto workspace_name = Name();
    // Exercise the formerly intermittent case: assigning 'f' again is not a
    // substitution when the random admitted name already starts with 'f'.
    if (mode == 13) workspace_name[8] = L'f';
    const auto file = parent_path + L"\\" + workspace_name + L".provisioning";
    auto workspace_plan = plan;
    workspace_plan.disk.virtual_bytes = 64ULL * 1024 * 1024; workspace_plan.disk.reserved_file_bytes = 128ULL * 1024 * 1024;
    CommitFixture core; CellProvisioningCommitter core_sink{CommitFixture::Commit, &core}; CellProvisioningAnchor reference;
    Check(journal.Create(parent, parent_identity, workspace_name, user, user, workspace_plan, &reference, &core_sink) == 0 &&
      journal.ProvisionWorkspace(reference) == 0 && journal.ProvisionDisk(reference, 10000) == 0,
      "mounted workspace fixture owns a real exclusive journal and an unattached VHDX");
    std::vector<CellMountedWorkspaceProvisioningRecord> empty(1);
    Check(journal.RecordMountedWorkspaceCheckpoints(&empty) == 0 && empty.empty(), "creation export cannot invent mounted workspace history");
    Check(journal.RecordMountedWorkspaceCheckpoints(nullptr) == ERROR_INVALID_PARAMETER && journal.RecordMountedWorkspace(nullptr) == ERROR_INVALID_PARAMETER,
      "null mounted workspace evidence outputs are refused");
    CellWorkspaceIdentities absent;
    Check(journal.RecordMountedWorkspace(&absent) == ERROR_INVALID_STATE && absent == CellWorkspaceIdentities{},
      "host workspace identities cannot stand in for mounted execution roots");
    Check(journal.ProvisionMountedWorkspace(reference, {}, 10000) == ERROR_INVALID_STATE,
      "an unmounted journal cannot invoke workspace directory creation");
    CellDiskLayoutPlan layout_plan; CellWorkspaceIdentities host;
    Check(journal.RecordDiskLayoutPlan(&layout_plan) == 0 && journal.RecordWorkspace(&host) == 0,
      "mounted workspace fixture retains the original host and backing identities");
    VolumeFixture volume{&journal, layout_plan}; Check(volume.Run() == 0, "mounted workspace fixture retains controlled layout history");
    std::array<CellDiskLayoutCheckpoint, 4> layouts{};
    for (std::size_t index = 0; index < layouts.size(); ++index)
      std::copy_n(volume.committed[index + 2].begin() + 280, 512, layouts[index].begin());
    CellDiskLayoutSnapshot snapshot;
    Check(DecodeCellDiskLayoutCheckpoints(layout_plan, layouts, &snapshot) == 0, "mounted workspace fixture decodes exact volume geometry");
    CellNtfsFormatBinding format_binding;
    format_binding.partition_bytes = snapshot.data_length;
    format_binding.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
    std::copy_n(layouts.back().end() - 32, 32, format_binding.layout_sha256.begin());
    FormatFixture formatted{&journal, format_binding}; Check(formatted.Run() == 0, "mounted workspace fixture retains controlled NTFS history");
    std::array<CellNtfsFormatCheckpoint, 2> formats{};
    for (std::size_t index = 0; index < formats.size(); ++index)
      std::copy_n(formatted.committed[index].begin() + 280, 512, formats[index].begin());
    CellVolumeProtectionBinding protection_binding;
    protection_binding.volume_id = format_binding.volume_id; protection_binding.partition_bytes = snapshot.data_length;
    Check(DecodeCellNtfsFormatCheckpoints(format_binding, formats, &protection_binding.ntfs) == 0, "mounted workspace fixture records NTFS identity");
    std::copy_n(formats.back().end() - 32, 32, protection_binding.format_sha256.begin());
    protection_binding.root.volume_serial = protection_binding.ntfs.serial; protection_binding.root.file_id.fill(0xd6);
    Check(HashCellVolumeRootSecurity(user, user, &protection_binding.security_sha256) == 0, "mounted workspace fixture freezes owner security");
    ProtectionFixture protected_root{&journal, protection_binding}; Check(protected_root.Run() == 0, "mounted workspace fixture retains controlled root protection");
    CellVolumeMountBinding mount_binding;
    mount_binding.parent = host.directories[0]; mount_binding.volume_root = protection_binding.root;
    mount_binding.volume_id = protection_binding.volume_id; mount_binding.security_sha256 = protection_binding.security_sha256;
    std::copy_n(protected_root.committed.back().begin() + 760, 32, mount_binding.protection_sha256.begin());
    MountFixture mounted{&journal, mount_binding}; Check(mounted.Run() == 0, "mounted workspace fixture retains complete controlled mount history");
    const auto before = CellProvisioningJournalTestPeer::Bytes(journal);
    CellMountedWorkspaceBinding binding;
    binding.cell_name = workspace_name; binding.volume_root = protection_binding.root; binding.security_sha256 = protection_binding.security_sha256;
    std::copy_n(mounted.committed.back().begin() + 760, 32, binding.mount_sha256.begin());
    MountedWorkspaceFixture fixture{&journal, binding}; Handle cancel;
    if (mode == 1 || mode == 2) fixture.fail = mode;
    if (mode == 3 || mode == 4) fixture.wrong = mode - 2;
    if (mode == 5) fixture.revoked = true;
    if (mode == 6 || mode == 7) fixture.revoke_after_commit = mode - 5;
    if (mode == 8 || mode == 9) fixture.fail_create = mode == 8 ? 1 : 4;
    if (mode == 10 || mode == 11) {
      cancel.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); Check(cancel.value != nullptr, "mounted workspace cancellation event");
      fixture.cancellation = cancel.value; fixture.cancel_after_commit = mode - 9;
    }
    if (mode == 12) fixture.revoke_after_verify = true;
    if (mode == 13) fixture.binding.cell_name[8] = fixture.binding.cell_name[8] == L'f' ? L'e' : L'f';
    if (mode == 14) fixture.binding.volume_root.file_id.back() ^= 0x80;
    if (mode == 15) fixture.fail_verify = 3;
    if (mode == 16) fixture.cancellation = INVALID_HANDLE_VALUE;
    if (mode == 17) fixture.corrupt_after_intent = true;
    if (mode == 18) fixture.binding.security_sha256[0] ^= 1;
    const DWORD result = fixture.Run();
    const unsigned attempted = mode == 5 || mode == 13 || mode == 14 || mode == 16 || mode == 18 ? 0 :
      mode == 1 || mode == 3 || mode == 6 || mode == 8 || mode == 9 || mode == 10 || mode == 17 ? 1 : 2;
    const unsigned created = attempted == 0 || mode == 1 || mode == 3 || mode == 6 || mode == 10 || mode == 17 ? 0 : mode == 8 ? 1 : 4;
    Check((result == ERROR_SUCCESS) == (mode == 0) && fixture.attempted.size() == attempted && fixture.creates == created,
      "workspace faults stop at the exact durable ACK or creation boundary");
    Check(fixture.Run() == ERROR_INVALID_STATE, "completed or failed mounted workspace attempt cannot repeat");
    if (mode == 8 || mode == 9) Check(result == ERROR_IO_DEVICE, "uncertain directory creation cannot be retried");
    if (mode == 10 || mode == 11) Check(result == ERROR_CANCELLED, "cancellation during either ACK refuses progress");
    if (mode == 15) Check(result == ERROR_FILE_INVALID, "final source readback failure prevents completion");
    if (mode == 16) Check(result == ERROR_INVALID_HANDLE && !fixture.authorizations, "invalid cancellation is refused before journal callbacks");
    if (mode == 17) Check(result == ERROR_CRC && fixture.corrupted && !fixture.creates, "held-journal drift during authority callback prevents directory writes");
    auto captured = CellProvisioningJournalTestPeer::Bytes(journal);
    if (mode == 0) {
      CapacityJournalTests<CellDirectoryFootprint>(journal, reference, workspace_plan, binding, fixture.committed);
      CapacityJournalTests<CellDirectoryInventory>(journal, reference, workspace_plan, binding, fixture.committed);
    }
    Check(captured.size() == 19456 + attempted * 1024 && std::equal(before.begin(), before.end(), captured.begin()),
      "mounted workspace appends only its own records and preserves all nineteen predecessors");
    Check(journal.MountPhase() == CellMountProvisioningPhase::mounted && static_cast<unsigned>(journal.MountedWorkspacePhase()) == attempted,
      "extended journal never projects workspace records as additional mount phases");
    CellFileSha256 base{}; std::copy_n(core.committed.back().end() - 32, 32, base.begin());
    const auto validate = [&](std::span<const CellMountedWorkspaceProvisioningRecord> records) {
      return ValidateCellMountedWorkspaceProvisioningPrefix(workspace_plan, reference.file, host, layout_plan.disk, base, workspace_name,
        user, user, volume.committed, formatted.committed, protected_root.committed, mounted.committed, records);
    };
    if (attempted) Check(validate(fixture.attempted) == 0, "pure metadata decoder accepts exact mounted workspace prefixes");
    journal.Close();
    if (mode == 17) {
      captured[0] = 'X'; Check(Read(file) == captured, "corrupted owned journal remains unchanged after refusal");
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, workspace_name, user, workspace_plan, reference) != 0,
        "fresh reader refuses the retained journal corruption");
      journal.Close(); continue;
    }
    Check(Read(file) == captured, "acknowledged and uncertain workspace records survive closure exactly");
    Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, workspace_name, user, workspace_plan, reference) == 0,
      "fresh metadata reader decodes all six retained stages");
    Check(journal.ProvisionMountedWorkspace(reference, fixture.Committer(), 10000) == ERROR_INVALID_STATE,
      "read-only metadata recovery cannot restore original workspace creation authority");
    journal.Close();
    if (attempted) {
      const DWORD expected = attempted == 1 ? ERROR_IO_INCOMPLETE : ERROR_NOT_SUPPORTED;
      Check(journal.OpenRecorded(parent, parent_identity, workspace_name, user, user, workspace_plan, reference,
        volume.committed, formatted.committed, protected_root.committed, mounted.committed) == expected,
        "mount-only recovery cannot silently omit workspace intent or completion");
      journal.Close();
    }
    if (mode) continue;
    committed_mounted_workspace_history.resize(21);
    for (std::size_t index = 0; index < committed_mounted_workspace_history.size(); ++index)
      std::copy_n(captured.begin() + index * 1024, 1024, committed_mounted_workspace_history[index].begin());
    Check(validate({}) != 0 && validate(std::span(fixture.committed).first(1)) == 0, "only nonempty workspace prefixes can be inspected");
    auto extra = fixture.committed; extra.push_back(extra.back()); Check(validate(extra) != 0, "extra workspace records are refused");
    auto wrong = fixture.committed; wrong.back().back() ^= 1;
    Check(journal.OpenRecorded(parent, parent_identity, workspace_name, user, user, workspace_plan, reference,
      volume.committed, formatted.committed, protected_root.committed, mounted.committed, wrong) == ERROR_CRC,
      "recovery requires the independently retained exact workspace bytes");
    journal.Close();
    const DWORD recovered = journal.OpenRecorded(parent, parent_identity, workspace_name, user, user, workspace_plan, reference,
      volume.committed, formatted.committed, protected_root.committed, mounted.committed, fixture.committed);
    Check(recovered != ERROR_SUCCESS && recovered != ERROR_CRC && recovered != ERROR_IO_INCOMPLETE && recovered != ERROR_NOT_SUPPORTED,
      "complete exact recovery reaches native readback and refuses the deliberately unattached disk");
    journal.Close(); Check(Read(file) == captured, "physical readback refusal cannot mutate the retained complete journal");
    for (const std::size_t size : {0U, 19456U, 20480U, 21503U, 21505U, 22528U}) {
      auto changed = captured; changed.resize(size); Write(file, changed);
      Check(journal.OpenRecorded(parent, parent_identity, workspace_name, user, user, workspace_plan, reference,
        volume.committed, formatted.committed, protected_root.committed, mounted.committed, fixture.committed) != 0,
        "canonical workspace recovery refuses rollback, incomplete records, torn writes and suffixes");
      journal.Close(); Check(Read(file) == changed, "refused workspace history is never repaired or truncated");
    }
    const auto rehash = [&](std::vector<std::uint8_t>& changed) {
      BCRYPT_ALG_HANDLE algorithm = nullptr;
      Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "independent mounted workspace journal hasher");
      bool valid = true;
      for (std::size_t position = 19456; position < changed.size(); position += 1024) {
        if (position > 19456) {
          std::copy_n(changed.begin() + position - 32, 32, changed.begin() + position + 16);
          std::copy_n(changed.begin() + position - 1024 + 760, 32, changed.begin() + position + 296);
        }
        if (BCryptHash(algorithm, nullptr, 0, changed.data() + position + 280, 480, changed.data() + position + 760, 32) < 0 ||
            BCryptHash(algorithm, nullptr, 0, changed.data() + position, 992, changed.data() + position + 992, 32) < 0) valid = false;
      }
      BCryptCloseAlgorithmProvider(algorithm, 0); Check(valid, "workspace corruption fixtures carry valid nested and outer hashes");
    };
    for (const std::size_t offset : {0U, 8U, 12U, 16U, 48U, 80U, 112U, 128U, 144U, 168U, 192U, 216U, 248U, 264U,
      280U, 288U, 292U, 296U, 328U, 360U, 392U, 432U, 440U, 456U, 552U, 759U, 792U}) {
      auto changed = captured; changed[19456 + offset] ^= 1; rehash(changed); Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, workspace_name, user, workspace_plan, reference) != 0,
        "rehashing cannot legitimize changed workspace binding, root, policy, name, phase or padding");
      journal.Close();
    }
    for (std::size_t index = 0; index < 4; ++index) {
      auto changed = captured;
      std::copy_n(changed.begin() + 20480 + 432, 24, changed.begin() + 20480 + 456 + index * 24);
      rehash(changed); Write(file, changed);
      Check(CellProvisioningJournalTestPeer::OpenMetadata(journal, parent, parent_identity, workspace_name, user, workspace_plan, reference) != 0,
        "rehashing cannot replace a workspace directory with its volume root");
      journal.Close();
    }
    auto replacement = captured; replacement[20480 + 464] ^= 1; rehash(replacement); Write(file, replacement);
    Check(journal.OpenRecorded(parent, parent_identity, workspace_name, user, user, workspace_plan, reference,
      volume.committed, formatted.committed, protected_root.committed, mounted.committed, fixture.committed) == ERROR_CRC,
      "a self-consistent replacement identity cannot replace canonical workspace evidence");
    journal.Close(); Write(file, captured);
  }
  return checks;
}
