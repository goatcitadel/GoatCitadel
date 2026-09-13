#include "cell_controller_protocol.hpp"
#include "cell_controller_client_protocol.hpp"
#include <bcrypt.h>
#include <sddl.h>
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

DWORD RunCellVirtualDiskLayoutJournalFixture(const goatcitadel::worker_cell::CellDiskLayoutPlan&,
  const goatcitadel::worker_cell::CellDiskLayoutCommitter&) noexcept;
DWORD RunCellNtfsFormatJournalFixture(const goatcitadel::worker_cell::CellNtfsFormatBinding&,
  const goatcitadel::worker_cell::CellNtfsFormatCommitter&, unsigned*, DWORD) noexcept;
DWORD RunCellVolumeProtectionJournalFixture(const goatcitadel::worker_cell::CellVolumeProtectionBinding&,
  const goatcitadel::worker_cell::CellVolumeProtectionCommitter&, unsigned*, DWORD) noexcept;
DWORD RunCellVolumeMountJournalFixture(const goatcitadel::worker_cell::CellVolumeMountBinding&,
  const goatcitadel::worker_cell::CellVolumeMountCommitter&, unsigned*, unsigned*, DWORD, DWORD) noexcept;
DWORD RunCellMountedWorkspaceJournalFixture(const goatcitadel::worker_cell::CellMountedWorkspaceBinding&,
  const goatcitadel::worker_cell::CellMountedWorkspaceCommitter&, unsigned*, unsigned) noexcept;
namespace goatcitadel::worker_cell {
// Test-only composition: real journal/files/checkpoint transport, controlled
// attachment and SDK-shaped layout replies. No privilege or disk write occurs.
struct CellProvisioningJournalTestPeer final {
  static DWORD MountedWorkspace(CellProvisioningJournal& journal, const CellMountedWorkspaceProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    if (journal.mount_records_.size() != 4) return ERROR_INVALID_STATE;
    struct Driver {
      CellMountedWorkspaceBinding binding;
      unsigned creates = 0;
      static DWORD Verify(void*) noexcept { return ERROR_SUCCESS; }
      static DWORD Create(void* raw, const CellMountedWorkspaceCommitter& committer) noexcept {
        auto& self = *static_cast<Driver*>(raw);
        return RunCellMountedWorkspaceJournalFixture(self.binding, committer, &self.creates, 0);
      }
    } driver;
    const auto& mount = journal.mount_records_.back();
    std::copy_n(mount.begin() + 480, 32, driver.binding.mount_sha256.begin());
    std::copy_n(mount.begin() + 80, 32, driver.binding.security_sha256.begin());
    std::memcpy(&driver.binding.volume_root.volume_serial, mount.data() + 152, 8);
    std::copy_n(mount.begin() + 160, 16, driver.binding.volume_root.file_id.begin());
    driver.binding.cell_name = journal.name_;
    const DWORD error = journal.RunMountedWorkspace({Driver::Verify, Driver::Create, &driver}, sink, GetTickCount64() + wall_ms, stop);
    return !error && driver.creates != 4 ? ERROR_INVALID_DATA : error;
  }
  static DWORD Mount(CellProvisioningJournal& journal, const CellMountProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    if (journal.protection_records_.size() != 2) return ERROR_INVALID_STATE;
    struct Driver {
      CellVolumeMountBinding binding;
      unsigned creates = 0, submissions = 0;
      static DWORD Verify(void*) noexcept { return ERROR_SUCCESS; }
      static DWORD Mount(void* raw, const CellVolumeMountCommitter& committer) noexcept {
        auto& self = *static_cast<Driver*>(raw);
        return RunCellVolumeMountJournalFixture(self.binding, committer, &self.creates, &self.submissions, ERROR_SUCCESS, ERROR_SUCCESS);
      }
    } driver;
    const auto& protection = journal.protection_records_.back();
    std::copy_n(protection.begin() + 480, 32, driver.binding.protection_sha256.begin());
    std::copy_n(protection.begin() + 80, 32, driver.binding.security_sha256.begin());
    std::memcpy(&driver.binding.volume_id, protection.data() + 112, 16);
    std::memcpy(&driver.binding.volume_root.volume_serial, protection.data() + 160, 8);
    std::copy_n(protection.begin() + 168, 16, driver.binding.volume_root.file_id.begin());
    driver.binding.parent = journal.workspace_record_.directories[0];
    const DWORD error = journal.RunMount({Driver::Verify, Driver::Mount, &driver}, sink, GetTickCount64() + wall_ms, stop);
    return !error && (driver.creates != 1 || driver.submissions != 1) ? ERROR_INVALID_DATA : error;
  }
  static DWORD Protection(CellProvisioningJournal& journal, const CellProtectionProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    if (journal.format_records_.size() != 2) return ERROR_INVALID_STATE;
    struct Driver {
      CellVolumeProtectionBinding binding;
      unsigned submissions = 0;
      static DWORD Verify(void*) noexcept { return ERROR_SUCCESS; }
      static DWORD Protect(void* raw, const CellVolumeProtectionCommitter& committer) noexcept {
        auto& self = *static_cast<Driver*>(raw);
        return RunCellVolumeProtectionJournalFixture(self.binding, committer, &self.submissions, ERROR_SUCCESS);
      }
    } driver;
    const auto& format = journal.format_records_.back();
    std::copy_n(format.begin() + 480, 32, driver.binding.format_sha256.begin());
    std::memcpy(&driver.binding.volume_id, format.data() + 80, 16);
    std::memcpy(&driver.binding.partition_bytes, format.data() + 96, 8);
    std::memcpy(&driver.binding.ntfs.serial, format.data() + 184, 8);
    std::memcpy(&driver.binding.ntfs.sectors, format.data() + 192, 8);
    std::memcpy(&driver.binding.ntfs.clusters, format.data() + 200, 8);
    driver.binding.root.volume_serial = driver.binding.ntfs.serial; driver.binding.root.file_id.fill(0xd6);
    const DWORD security = HashCellVolumeRootSecurity(journal.owner_, journal.controller_, &driver.binding.security_sha256);
    if (security) return security;
    const DWORD error = journal.RunProtection({Driver::Verify, Driver::Protect, &driver}, sink, GetTickCount64() + wall_ms, stop);
    return !error && driver.submissions != 1 ? ERROR_INVALID_DATA : error;
  }
  static DWORD Format(CellProvisioningJournal& journal, const CellFormatProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    if (journal.layout_records_.size() != 4) return ERROR_INVALID_STATE;
    struct Driver {
      CellNtfsFormatBinding binding;
      unsigned submissions = 0;
      static DWORD Verify(void*) noexcept { return ERROR_SUCCESS; }
      static DWORD Format(void* raw, const CellNtfsFormatCommitter& committer) noexcept {
        auto& self = *static_cast<Driver*>(raw);
        return RunCellNtfsFormatJournalFixture(self.binding, committer, &self.submissions, ERROR_SUCCESS);
      }
    } driver;
    const auto& layout = journal.layout_records_.back();
    std::copy_n(layout.begin() + 480, 32, driver.binding.layout_sha256.begin());
    std::memcpy(&driver.binding.partition_bytes, layout.data() + 300, 8);
    driver.binding.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
    const DWORD error = journal.RunFormat({Driver::Verify, Driver::Format, &driver}, sink, GetTickCount64() + wall_ms, stop);
    return !error && driver.submissions != 1 ? ERROR_INVALID_DATA : error;
  }
  static DWORD Volume(CellProvisioningJournal& journal, const CellVolumeProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    struct Driver {
      CellDiskLayoutPlan plan;
      bool attached = false;
      static DWORD Verify(void*) noexcept { return ERROR_SUCCESS; }
      static DWORD Attach(void* raw) noexcept {
        auto& self = *static_cast<Driver*>(raw);
        if (self.attached) return ERROR_INVALID_STATE;
        self.attached = true; return ERROR_SUCCESS;
      }
      static DWORD Layout(void* raw, const CellDiskLayoutCommitter& committer) noexcept {
        auto& self = *static_cast<Driver*>(raw);
        return self.attached ? RunCellVirtualDiskLayoutJournalFixture(self.plan, committer) : ERROR_INVALID_STATE;
      }
    } driver;
    const DWORD error = journal.RecordDiskLayoutPlan(&driver.plan);
    return error ? error : journal.RunVolume({Driver::Verify, Driver::Attach, Driver::Layout, &driver}, sink,
      GetTickCount64() + wall_ms, stop);
  }
};
}
using namespace goatcitadel::worker_cell;
namespace {
std::atomic<unsigned> checks{0};
unsigned sessions = 0, native_client_sessions = 0, volume_authority_checks = 0, format_authority_checks = 0, protection_authority_checks = 0, mount_authority_checks = 0;
unsigned workspace_authority_checks = 0;
using Wire = std::array<std::uint8_t, kCellControllerRequestBytes>;
void Check(bool value, const char* name) { ++checks; if (!value) throw std::runtime_error(std::string(name) + " (OS " + std::to_string(GetLastError()) + ")"); }
void Code(DWORD value, DWORD expected, const char* name) {
  if (value != expected) throw std::runtime_error(std::string(name) + ": " + std::to_string(value) + " != " + std::to_string(expected));
  ++checks;
}
struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned length = 8) {
  for (unsigned i = 0; i < length; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (i * 8));
}
std::uint32_t U32(const std::uint8_t* bytes) {
  std::uint32_t value = 0; for (unsigned i = 0; i < 4; ++i) value |= static_cast<std::uint32_t>(bytes[i]) << (8 * i); return value;
}
std::wstring Name() {
  std::array<std::uint8_t, 16> bytes{};
  Check(BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0, "independent cell ID");
  constexpr wchar_t hex[] = L"0123456789abcdef"; std::wstring name = L"gc-cell-";
  for (auto byte : bytes) { name += hex[byte >> 4]; name += hex[byte & 15]; }
  return name;
}
Wire Request(const CellFileIdentity& parent, const std::wstring& name) {
  Wire wire{}; Put(wire.data(), 1, 4); Put(wire.data() + 4, 8000, 4);
  std::fill(wire.begin() + 8, wire.begin() + 40, std::uint8_t{0x11});
  for (std::size_t i = 0; i < name.size(); ++i) wire[40 + i] = static_cast<std::uint8_t>(name[i]);
  std::fill(wire.begin() + 80, wire.begin() + 112, std::uint8_t{0x22});
  std::fill(wire.begin() + 112, wire.begin() + 144, std::uint8_t{0x33});
  Check(BCryptGenRandom(nullptr, wire.data() + 144, 16, BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0, "independent disk GUID");
  Put(wire.data() + 160, 16ULL * 1024 * 1024); Put(wire.data() + 168, 80ULL * 1024 * 1024);
  Put(wire.data() + 176, parent.volume_serial); std::copy(parent.file_id.begin(), parent.file_id.end(), wire.begin() + 184);
  return wire;
}
void DecoderCases() {
  CellFileIdentity parent; parent.volume_serial = 3; parent.file_id.fill(5);
  const auto wire = Request(parent, Name()); CellControllerNonce nonce{}; nonce.fill(0x11);
  CellControllerRequest decoded;
  Check(DecodeCellControllerRequest(wire, nonce, &decoded) && decoded.operation == 1 && decoded.wall_ms == 8000 &&
    decoded.parent == parent && decoded.plan.disk.virtual_bytes == 16ULL * 1024 * 1024, "decode frozen request");
  Wire encoded{};
  Check(EncodeCellControllerRequest(decoded, &encoded) && encoded == wire, "client encoder preserves independently encoded request bytes");
  Check(!EncodeCellControllerRequest(decoded, nullptr), "null encoder destination");
  auto invalid = decoded; invalid.cell_name += L"extra";
  Check(!EncodeCellControllerRequest(invalid, &encoded) && encoded == Wire{}, "overlong name clears encoded output");
  CellControllerClientOwner absent;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 500, decoded, absent), ERROR_INVALID_STATE, "client requires all authority and persistence callbacks");
  const auto reject = [&](auto mutate, const char* name) {
    auto changed = wire; mutate(changed); auto output = decoded;
    Check(!DecodeCellControllerRequest(changed, nonce, &output) && !output.operation && output.cell_name.empty(), name);
  };
  reject([](auto& w) { Put(w.data(), 13, 4); }, "unknown operation");
  reject([](auto& w) { Put(w.data(), 3, 4); }, "volume creation requires sufficient capacity");
  reject([](auto& w) { Put(w.data(), 5, 4); }, "format creation requires sufficient capacity");
  reject([](auto& w) { Put(w.data(), 7, 4); }, "protection creation requires sufficient capacity");
  reject([](auto& w) { Put(w.data(), 9, 4); }, "mount creation requires sufficient capacity");
  reject([](auto& w) { Put(w.data(), 11, 4); }, "mounted workspace creation requires sufficient capacity");
  reject([](auto& w) { Put(w.data() + 4, 99, 4); }, "too short deadline");
  reject([](auto& w) { Put(w.data() + 4, 600001, 4); }, "unbounded deadline");
  reject([](auto& w) { w[8] ^= 1; }, "cross-session nonce");
  reject([](auto& w) { w[40] = '.'; }, "invalid cell prefix");
  reject([](auto& w) { w[79] = '\\'; }, "path injection");
  reject([](auto& w) { w[79] = 0; }, "nul cell name");
  reject([](auto& w) { std::fill(w.begin() + 80, w.begin() + 112, std::uint8_t{0}); }, "missing assignment binding");
  reject([](auto& w) { std::fill(w.begin() + 112, w.begin() + 144, std::uint8_t{0}); }, "missing profile binding");
  reject([](auto& w) { Put(w.data() + 160, 1); }, "invalid disk capacity");
  reject([](auto& w) { std::fill(w.begin() + 144, w.begin() + 160, std::uint8_t{0}); }, "missing disk GUID");
  reject([](auto& w) { Put(w.data() + 168, 16ULL * 1024 * 1024); }, "missing metadata reservation");
  reject([](auto& w) { Put(w.data() + 176, 0); }, "missing parent identity");
  reject([](auto& w) { w[200] = 1; }, "create cannot adopt an existing journal");
  reject([](auto& w) { Put(w.data(), 2, 4); }, "recovery requires independent anchor");
  Check(!DecodeCellControllerRequest(wire, nonce, nullptr), "null decoder output");
  CellControllerSessionOwner missing;
  Check(RunCellControllerSession(nullptr, nullptr, missing).error == ERROR_INVALID_STATE, "missing trusted owner refuses dispatch");
}
struct Parent final {
  std::wstring path, user;
  CellFileIdentity identity;
  void Create(const std::wstring& root) {
    path = root + L"\\parent";
    Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "read fixture principal");
    CellControllerToken facts; Check(CollectCellControllerToken(token.value, &facts), "collect fixture principal"); user = facts.user;
    std::vector<std::uint8_t> descriptor;
    Code(BuildCellParentSecurity(user, user, &descriptor), ERROR_SUCCESS, "fixed fixture parent security");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
    Check(CreateDirectoryW(path.c_str(), &security), "create only new protected fixture parent");
    Handle file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    FILE_ID_INFO info{}; Check(file.value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(file.value, FileIdInfo, &info, sizeof(info)), "independent parent identity");
    identity.volume_serial = info.VolumeSerialNumber;
    std::copy(std::begin(info.FileId.Identifier), std::end(info.FileId.Identifier), identity.file_id.begin());
  }
};
struct Context final {
  HANDLE pipe;
  CellPipeClientEvidence peer;
  std::atomic<bool> revoked{false};
  std::atomic<ULONGLONG> watchdog{0};
  static DWORD Authorize(void* pointer, bool first) noexcept {
    auto& context = *static_cast<Context*>(pointer);
    if (context.revoked.load()) return ERROR_ACCESS_DENIED;
    return first ? context.peer.Open(context.pipe) : context.peer.Verify();
  }
  static void Arm(void* pointer, ULONGLONG value) noexcept { static_cast<Context*>(pointer)->watchdog.store(value); }
  static DWORD Volume(void*, CellProvisioningJournal& journal, const CellProvisioningAnchor&,
    const CellVolumeProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    return CellProvisioningJournalTestPeer::Volume(journal, sink, wall_ms, stop);
  }
  static DWORD Format(void*, CellProvisioningJournal& journal, const CellProvisioningAnchor&,
    const CellFormatProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    return CellProvisioningJournalTestPeer::Format(journal, sink, wall_ms, stop);
  }
  static DWORD Protection(void*, CellProvisioningJournal& journal, const CellProvisioningAnchor&,
    const CellProtectionProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    return CellProvisioningJournalTestPeer::Protection(journal, sink, wall_ms, stop);
  }
  static DWORD Mount(void*, CellProvisioningJournal& journal, const CellProvisioningAnchor&,
    const CellMountProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    return CellProvisioningJournalTestPeer::Mount(journal, sink, wall_ms, stop);
  }
  static DWORD MountedWorkspace(void*, CellProvisioningJournal& journal, const CellProvisioningAnchor&,
    const CellMountedWorkspaceProvisioningCommitter& sink, DWORD wall_ms, HANDLE stop) noexcept {
    return CellProvisioningJournalTestPeer::MountedWorkspace(journal, sink, wall_ms, stop);
  }
};
struct Outcome final { CellControllerSessionResult result; std::vector<CellProvisioningRecord> records; DWORD client_error = 0; unsigned volume_checks = 0; };
struct NativeClient final {
  CellPipeServerEvidence server;
  std::wstring root;
  unsigned sequence;
  Outcome& outcome;
  HANDLE stop;
  const char* mode;
  bool revoked = false, received = false;
  std::array<std::uint8_t, 16> receipt{};
  static DWORD Authorize(void* pointer) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    return client.revoked ? ERROR_ACCESS_DENIED : client.server.Verify();
  }
  static DWORD Checkpoint(void* pointer, const CellProvisioningRecord& record, bool acknowledge, CellFileSha256* digest) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    try {
      client.outcome.records.push_back(record);
      if (acknowledge) {
        const auto path = client.root + L"\\native-ack-" + std::to_wstring(client.sequence) + L"-" + std::to_wstring(client.outcome.records.size()) + L".bin";
        Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)}; DWORD written = 0;
        Check(file.value != INVALID_HANDLE_VALUE && WriteFile(file.value, record.data(), static_cast<DWORD>(record.size()), &written, nullptr) &&
          written == record.size() && FlushFileBuffers(file.value), "production client waits for exact fixture persistence");
        std::copy_n(record.begin() + 992, 32, digest->begin());
        if (!std::strcmp(client.mode, "native-bad-commit")) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-volume-bad-ack") && client.outcome.records.size() == 6) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-format-bad-ack") && client.outcome.records.size() == 12) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-protection-bad-ack") && client.outcome.records.size() == 14) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-protection-final-bad-ack") && client.outcome.records.size() == 15) (*digest)[0] ^= 1;
        const char* mount_failures[] = {"native-mount-prepared-bad-ack", "native-mount-directory-bad-ack", "native-mount-intent-bad-ack", "native-mount-final-bad-ack"};
        for (unsigned index = 0; index < 4; ++index)
          if (!std::strcmp(client.mode, mount_failures[index]) && client.outcome.records.size() == 16 + index) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-workspace-intent-bad-ack") && client.outcome.records.size() == 20) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-workspace-final-bad-ack") && client.outcome.records.size() == 21) (*digest)[0] ^= 1;
        if (!std::strcmp(client.mode, "native-revoke")) client.revoked = true;
        if (!std::strcmp(client.mode, "native-cancel")) SetEvent(client.stop);
        if (!std::strcmp(client.mode, "native-timeout")) WaitForSingleObject(client.stop, 500);
      }
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  static DWORD Receipt(void* pointer, const std::array<std::uint8_t, 16>& bytes) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    if (client.received) return ERROR_INVALID_DATA;
    client.received = true; client.receipt = bytes; return ERROR_SUCCESS;
  }
  static DWORD VolumeAuthority(void* pointer, std::uint32_t ordinal, std::uint32_t count, const CellFileSha256& head) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    try {
      Check(ordinal == ++client.outcome.volume_checks && count == client.outcome.records.size() && count >= 5 && count <= 21 &&
        std::equal(head.begin(), head.end(), client.outcome.records.back().begin() + 992), "authority binds the exact retained checkpoint count and head");
      const auto path = client.root + L"\\native-ack-" + std::to_wstring(client.sequence) + L"-" + std::to_wstring(count) + L".bin";
      Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr)};
      CellProvisioningRecord record{}; DWORD read = 0;
      Check(file.value != INVALID_HANDLE_VALUE && ReadFile(file.value, record.data(), static_cast<DWORD>(record.size()), &read, nullptr) &&
        read == record.size() && record == client.outcome.records.back(), "authority independently reads the previously flushed acknowledgement file");
      if (!std::strcmp(client.mode, "native-volume-denied") || (!std::strcmp(client.mode, "native-volume-final-denied") && count == 11)) return ERROR_ACCESS_DENIED;
      if (!std::strcmp(client.mode, "native-volume-cancel")) SetEvent(client.stop);
      if (!std::strcmp(client.mode, "native-volume-revoke")) client.revoked = true;
      if ((!std::strcmp(client.mode, "native-format-denied") && count == 11) ||
          (!std::strcmp(client.mode, "native-format-intent-denied") && count == 12) ||
          (!std::strcmp(client.mode, "native-format-final-denied") && count == 13)) return ERROR_ACCESS_DENIED;
      if (!std::strcmp(client.mode, "native-format-cancel") && count == 11) SetEvent(client.stop);
      if (!std::strcmp(client.mode, "native-format-revoke") && count == 11) client.revoked = true;
      if ((!std::strcmp(client.mode, "native-protection-denied") && count == 13) ||
          (!std::strcmp(client.mode, "native-protection-intent-denied") && count == 14) ||
          (!std::strcmp(client.mode, "native-protection-final-denied") && count == 15)) return ERROR_ACCESS_DENIED;
      if (!std::strcmp(client.mode, "native-protection-cancel") && count == 13) SetEvent(client.stop);
      if (!std::strcmp(client.mode, "native-protection-revoke") && count == 13) client.revoked = true;
      const char* mount_denials[] = {"native-mount-denied", "native-mount-directory-denied", "native-mount-intent-denied", "native-mount-submission-denied", "native-mount-final-denied"};
      for (unsigned index = 0; index < 5; ++index)
        if (!std::strcmp(client.mode, mount_denials[index]) && count == 15 + index) return ERROR_ACCESS_DENIED;
      if (!std::strcmp(client.mode, "native-mount-cancel") && count == 15) SetEvent(client.stop);
      if (!std::strcmp(client.mode, "native-mount-revoke") && count == 15) client.revoked = true;
      if ((!std::strcmp(client.mode, "native-workspace-denied") && count == 19) ||
          (!std::strcmp(client.mode, "native-workspace-intent-denied") && count == 20) ||
          (!std::strcmp(client.mode, "native-workspace-final-denied") && count == 21)) return ERROR_ACCESS_DENIED;
      if (!std::strcmp(client.mode, "native-workspace-cancel") && count == 19) SetEvent(client.stop);
      if (!std::strcmp(client.mode, "native-workspace-revoke") && count == 19) client.revoked = true;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_INVALID_DATA; }
  }
};
Outcome Exchange(const Parent& parent, const std::wstring& root, Wire request, const char* mode,
  const std::array<CellVolumeProvisioningRecord, 6>* volume_history = nullptr,
  const std::array<CellFormatProvisioningRecord, 2>* format_history = nullptr,
  const std::array<CellProtectionProvisioningRecord, 2>* protection_history = nullptr,
  const std::array<CellProvisioningRecord, 5>* creation_history = nullptr,
  const std::array<CellMountProvisioningRecord, 4>* mount_history = nullptr,
  const std::array<CellMountedWorkspaceProvisioningRecord, 2>* workspace_history = nullptr) {
  const auto sequence = ++sessions;
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCellProtocolTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value, "new local session fixture");
  Context context{server.value};
  CellControllerSessionOwner owner{parent.path, parent.user, parent.user, parent.identity, &context, Context::Authorize, Context::Arm};
  if (std::strcmp(mode, "native-volume-missing-owner")) owner.provision_volume = Context::Volume;
  if (std::strcmp(mode, "native-format-missing-owner")) owner.provision_format = Context::Format;
  if (std::strcmp(mode, "native-protection-missing-owner")) owner.provision_protection = Context::Protection;
  if (std::strcmp(mode, "native-mount-missing-owner")) owner.provision_mount = Context::Mount;
  if (std::strcmp(mode, "native-workspace-missing-owner")) owner.provision_mounted_workspace = Context::MountedWorkspace;
  Outcome outcome; std::exception_ptr server_error;
  std::jthread thread([&]() {
    try {
      Code(ConnectCellPipe(server.value, stop.value, GetTickCount64() + 5000), ERROR_SUCCESS, "session fixture connected");
      outcome.result = RunCellControllerSession(server.value, stop.value, owner);
      context.peer.Close(); DisconnectNamedPipe(server.value);
    } catch (...) { server_error = std::current_exception(); SetEvent(stop.value); }
  });
  Handle client{CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Check(client.value != INVALID_HANDLE_VALUE, "connect identification-only client");
  if (!std::strncmp(mode, "native-", 7)) {
    ++native_client_sessions;
    NativeClient context_client{{}, root, sequence, outcome, stop.value, mode};
    Code(context_client.server.Open(client.value), ERROR_SUCCESS, "fixture authenticates actual server before production client protocol");
    CellControllerRequest decoded; CellControllerNonce initial{}; initial.fill(0x11);
    Check(DecodeCellControllerRequest(request, initial, &decoded), "independent native client request");
    if (volume_history) decoded.volume_records = *volume_history;
    if (format_history) decoded.format_records = *format_history;
    if (protection_history) decoded.protection_records = *protection_history;
    if (creation_history) decoded.creation_records = *creation_history;
    if (mount_history) decoded.mount_records = *mount_history;
    if (workspace_history) decoded.mounted_workspace_records = *workspace_history;
    CellControllerClientOwner native{&context_client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
    native.owner_sid = parent.user; native.controller_sid = parent.user;
    outcome.client_error = RunCellControllerClientSession(client.value, stop.value,
      GetTickCount64() + (!std::strcmp(mode, "native-timeout") ? 400 : 8000), decoded, native);
    context_client.server.Close(); client.Close();
    thread.join();
    if (server_error) std::rethrow_exception(server_error);
    if (!outcome.client_error) Check(context_client.received && U32(context_client.receipt.data()) == outcome.result.error &&
      U32(context_client.receipt.data() + 12) == outcome.records.size(), "production client forwards the exact native receipt");
    else Check(!context_client.received, "failed commit or authority cannot publish a terminal receipt");
    return outcome;
  }
  const auto deadline = GetTickCount64() + 12000;
  CellControllerNonce hello{}; hello.fill(0x41);
  Code(WriteCellControllerMessage(client.value, CellControllerMessage::hello, hello.data(), 32, stop.value, deadline), ERROR_SUCCESS, "send hello");
  std::array<std::uint8_t, 64> welcome{};
  Code(ReadCellControllerMessage(client.value, CellControllerMessage::welcome, welcome.data(), 64, stop.value, deadline), ERROR_SUCCESS, "read bound welcome");
  Check(std::equal(hello.begin(), hello.end(), welcome.begin()), "welcome echoes exact hello");
  CellControllerNonce nonce{}; std::copy_n(welcome.begin() + 32, 32, nonce.begin());
  std::copy(nonce.begin(), nonce.end(), request.begin() + 8);
  if (!std::strcmp(mode, "wrong-nonce")) request[8] ^= 1;
  if (!std::strcmp(mode, "wrong-header")) {
    std::array<std::uint8_t, 16> header{}; std::memcpy(header.data(), "GCCELL01", 8);
    Put(header.data() + 8, 3, 4); Put(header.data() + 12, 0xffffffff, 4);
    Code(WriteCellPipe(client.value, header.data(), static_cast<DWORD>(header.size()), stop.value, deadline), ERROR_SUCCESS, "send impossible frame size without payload");
  } else Code(WriteCellControllerMessage(client.value, CellControllerMessage::request, request.data(), static_cast<DWORD>(request.size()), stop.value, deadline), ERROR_SUCCESS, "dispatch one request");
  const bool bad_mount_history = !std::strncmp(mode, "mount-history-", 14);
  const bool bad_workspace_history = !std::strncmp(mode, "workspace-history-", 18);
  if (bad_mount_history || bad_workspace_history) {
    Check(volume_history && format_history && protection_history && creation_history && mount_history, "independent raw recovery inputs");
    const auto history = [&](CellControllerMessage kind, const auto& records) {
      std::vector<std::uint8_t> bytes(32 + records.size() * 1024); std::copy(nonce.begin(), nonce.end(), bytes.begin());
      for (std::size_t i = 0; i < records.size(); ++i) std::copy(records[i].begin(), records[i].end(), bytes.begin() + 32 + i * 1024);
      Code(WriteCellControllerMessage(client.value, kind, bytes.data(), static_cast<DWORD>(bytes.size()), stop.value, deadline), ERROR_SUCCESS, "send preceding recovery history");
    };
    history(CellControllerMessage::volume_history, *volume_history);
    history(CellControllerMessage::format_history, *format_history);
    history(CellControllerMessage::protection_history, *protection_history);
    std::array<std::uint8_t, kCellControllerMountHistoryBytes> bytes{}; std::copy(nonce.begin(), nonce.end(), bytes.begin());
    for (std::size_t i = 0; i < 5; ++i) std::copy((*creation_history)[i].begin(), (*creation_history)[i].end(), bytes.begin() + 32 + i * 1024);
    for (std::size_t i = 0; i < 4; ++i) std::copy((*mount_history)[i].begin(), (*mount_history)[i].end(), bytes.begin() + 32 + (5 + i) * 1024);
    if (!std::strcmp(mode, "mount-history-size")) {
      std::array<std::uint8_t, 16> header{}; std::memcpy(header.data(), "GCCELL01", 8);
      Put(header.data() + 8, static_cast<unsigned>(CellControllerMessage::mount_history), 4); Put(header.data() + 12, 0xffffffff, 4);
      Code(WriteCellPipe(client.value, header.data(), static_cast<DWORD>(header.size()), stop.value, deadline), ERROR_SUCCESS, "reject oversized mount history before reading a body");
    } else {
      if (!std::strcmp(mode, "mount-history-nonce")) bytes[0] ^= 1;
      if (!std::strcmp(mode, "mount-history-creation")) bytes[32 + 4 * 1024 + 672] ^= 1;
      if (!std::strcmp(mode, "mount-history-record")) bytes[32 + 8 * 1024 + 456] ^= 1;
      Code(WriteCellControllerMessage(client.value, CellControllerMessage::mount_history, bytes.data(), static_cast<DWORD>(bytes.size()), stop.value, deadline), ERROR_SUCCESS, "send deliberately invalid independent mount history");
    }
    if (bad_workspace_history) {
      Check(workspace_history != nullptr, "independent workspace history is present");
      std::array<std::uint8_t, kCellControllerMountedWorkspaceHistoryBytes> workspaces{};
      std::copy(nonce.begin(), nonce.end(), workspaces.begin());
      for (std::size_t i = 0; i < 2; ++i) std::copy((*workspace_history)[i].begin(), (*workspace_history)[i].end(), workspaces.begin() + 32 + i * 1024);
      if (!std::strcmp(mode, "workspace-history-size")) {
        std::array<std::uint8_t, 16> header{}; std::memcpy(header.data(), "GCCELL01", 8);
        Put(header.data() + 8, static_cast<unsigned>(CellControllerMessage::mounted_workspace_history), 4); Put(header.data() + 12, 0xffffffff, 4);
        Code(WriteCellPipe(client.value, header.data(), static_cast<DWORD>(header.size()), stop.value, deadline), ERROR_SUCCESS, "reject oversized workspace history before reading its body");
      } else {
        if (!std::strcmp(mode, "workspace-history-nonce")) workspaces[0] ^= 1;
        if (!std::strcmp(mode, "workspace-history-record")) workspaces[32 + 1024 + 456] ^= 1;
        if (!std::strcmp(mode, "workspace-history-order")) std::swap_ranges(workspaces.begin() + 32, workspaces.begin() + 32 + 1024, workspaces.begin() + 32 + 1024);
        Code(WriteCellControllerMessage(client.value, CellControllerMessage::mounted_workspace_history, workspaces.data(), static_cast<DWORD>(workspaces.size()), stop.value, deadline), ERROR_SUCCESS, "send invalid independent workspace history");
      }
    }
  }
  const bool refuse_before_create = bad_mount_history || bad_workspace_history || !std::strcmp(mode, "wrong-nonce") || !std::strcmp(mode, "wrong-header");
  const bool interrupted = !std::strcmp(mode, "wrong-ack") || !std::strcmp(mode, "wrong-sequence") ||
    !std::strcmp(mode, "wrong-ack-nonce") || !std::strcmp(mode, "revoke");
  if (!refuse_before_create) {
    const unsigned expected = interrupted ? 1 : 5;
    for (unsigned i = 0; i < expected; ++i) {
      std::array<std::uint8_t, 1056> checkpoint{};
      Code(ReadCellControllerMessage(client.value, CellControllerMessage::checkpoint, checkpoint.data(), static_cast<DWORD>(checkpoint.size()), stop.value, deadline), ERROR_SUCCESS, "read actual checkpoint");
      Check(std::equal(nonce.begin(), nonce.end(), checkpoint.begin()) && U32(checkpoint.data() + 40) == i + 1, "checkpoint nonce and sequence");
      CellProvisioningRecord record{}; std::copy_n(checkpoint.begin() + 32, 1024, record.begin()); outcome.records.push_back(record);
      if (U32(request.data()) == 1) {
        const auto path = root + L"\\ack-" + std::to_wstring(sequence) + L"-" + std::to_wstring(i + 1) + L".bin";
        Handle retained{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)}; DWORD written = 0;
        Check(retained.value != INVALID_HANDLE_VALUE && WriteFile(retained.value, record.data(), static_cast<DWORD>(record.size()), &written, nullptr) &&
          written == record.size() && FlushFileBuffers(retained.value), "retain exact fixture checkpoint before acknowledgement");
        std::array<std::uint8_t, 68> ack{}; std::copy(nonce.begin(), nonce.end(), ack.begin()); Put(ack.data() + 32, i + 1, 4);
        std::copy_n(record.begin() + 992, 32, ack.begin() + 36);
        if (!std::strcmp(mode, "wrong-ack")) ack[36] ^= 1;
        if (!std::strcmp(mode, "wrong-sequence")) Put(ack.data() + 32, 2, 4);
        if (!std::strcmp(mode, "wrong-ack-nonce")) ack[0] ^= 1;
        if (!std::strcmp(mode, "revoke")) context.revoked.store(true);
        Code(WriteCellControllerMessage(client.value, CellControllerMessage::acknowledgement, ack.data(), static_cast<DWORD>(ack.size()), stop.value, deadline), ERROR_SUCCESS, "send exact or deliberate faulty acknowledgement");
      }
    }
    if (std::strcmp(mode, "revoke")) {
      std::array<std::uint8_t, 48> receipt{};
      Code(ReadCellControllerMessage(client.value, CellControllerMessage::receipt, receipt.data(), static_cast<DWORD>(receipt.size()), stop.value, deadline), ERROR_SUCCESS, "read operation receipt before disconnect");
      Check(std::equal(nonce.begin(), nonce.end(), receipt.begin()) && U32(receipt.data() + 44) == outcome.records.size(), "receipt bound to emitted records");
      auto finish = nonce; if (!std::strcmp(mode, "wrong-finish")) finish[0] ^= 1;
      Code(WriteCellControllerMessage(client.value, CellControllerMessage::finish, finish.data(), 32, stop.value, deadline), ERROR_SUCCESS, "acknowledge receipt without a new operation");
    }
  }
  thread.join();
  if (server_error) std::rethrow_exception(server_error);
  Check(context.watchdog.load() != 0, "outer watchdog deadline supplied");
  return outcome;
}
void BadReply(const std::wstring& root, const Wire& original, const CellProvisioningRecord& first, const char* mode) {
  const auto sequence = ++sessions; ++native_client_sessions;
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCellReplyTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value && done.value, "new malformed-response fixture");
  std::exception_ptr server_error;
  std::jthread thread([&]() {
    try {
      const auto deadline = GetTickCount64() + 5000;
      Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "malformed-response client connects");
      CellControllerNonce hello{};
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::hello, hello.data(), 32, stop.value, deadline), ERROR_SUCCESS, "capture actual client nonce");
      std::array<std::uint8_t, 64> welcome{}; std::copy(hello.begin(), hello.end(), welcome.begin());
      std::fill(welcome.begin() + 32, welcome.end(), std::uint8_t{0x62});
      if (!std::strcmp(mode, "welcome")) welcome[0] ^= 1;
      Code(WriteCellControllerMessage(server.value, CellControllerMessage::welcome, welcome.data(), 64, stop.value, deadline), ERROR_SUCCESS, "send controlled welcome");
      if (std::strcmp(mode, "welcome")) {
        Wire requested{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::request, requested.data(), static_cast<DWORD>(requested.size()), stop.value, deadline),
          ERROR_SUCCESS, "read actual encoded request");
        std::array<std::uint8_t, 1056> reply{}; std::copy_n(welcome.begin() + 32, 32, reply.begin());
        std::copy(first.begin(), first.end(), reply.begin() + 32);
        if (!std::strcmp(mode, "receipt")) {
          reply.fill(0); std::copy_n(welcome.begin() + 32, 32, reply.begin());
          Put(reply.data() + 36, 5, 4); Put(reply.data() + 40, 1, 4);
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::receipt, reply.data(), 48, stop.value, deadline), ERROR_SUCCESS, "fabricate premature success receipt");
        } else if (!std::strcmp(mode, "oversize") || !std::strcmp(mode, "kind") || !std::strcmp(mode, "short")) {
          std::array<std::uint8_t, 16> header{}; std::memcpy(header.data(), "GCCELL01", 8);
          Put(header.data() + 8, !std::strcmp(mode, "kind") ? 5 : 4, 4);
          Put(header.data() + 12, !std::strcmp(mode, "oversize") ? UINT32_MAX : !std::strcmp(mode, "kind") ? 68 : 1056, 4);
          Code(WriteCellPipe(server.value, header.data(), static_cast<DWORD>(header.size()), stop.value, deadline), ERROR_SUCCESS, "write controlled malformed reply header");
          if (!std::strcmp(mode, "short")) {
            Code(WriteCellPipe(server.value, reply.data(), 20, stop.value, deadline), ERROR_SUCCESS, "write incomplete reply body");
            server.Close();
          }
        } else {
          if (!std::strcmp(mode, "nonce")) reply[0] ^= 1;
          if (!std::strcmp(mode, "hash")) reply[32 + 800] ^= 1;
          if (!std::strcmp(mode, "binding")) reply[32 + 48] ^= 1;
          if (!std::strcmp(mode, "chain")) reply[32 + 16] ^= 1;
          if (!std::strcmp(mode, "sequence")) { Put(reply.data() + 32 + 8, 2, 4); Put(reply.data() + 32 + 12, 2, 4); }
          if (!std::strcmp(mode, "recovery-anchor")) reply[32 + 176] ^= 1;
          if (std::strcmp(mode, "nonce") && std::strcmp(mode, "hash")) {
            BCRYPT_ALG_HANDLE algorithm = nullptr;
            Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "fixture SHA provider");
            const auto hashed = BCryptHash(algorithm, nullptr, 0, reply.data() + 32, 992, reply.data() + 32 + 992, 32);
            BCryptCloseAlgorithmProvider(algorithm, 0);
            Check(hashed >= 0, "malformed binding still has a correct record digest");
          }
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::checkpoint, reply.data(), static_cast<DWORD>(reply.size()), stop.value, deadline),
            ERROR_SUCCESS, "send controlled invalid record");
        }
      }
      Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "client refuses reply without waiting for an absent body or next record");
    } catch (...) { server_error = std::current_exception(); SetEvent(stop.value); }
  });
  Handle pipe{CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Check(pipe.value != INVALID_HANDLE_VALUE, "malformed-response pipe opened");
  Outcome outcome; NativeClient client{{}, root, sequence, outcome, stop.value, "malformed-reply"};
  Code(client.server.Open(pipe.value), ERROR_SUCCESS, "malformed-response peer has actual OS evidence");
  auto wire = original;
  if (!std::strcmp(mode, "recovery-anchor")) {
    Put(wire.data(), 2, 4); std::copy_n(first.begin() + 168, 24, wire.begin() + 200); std::copy_n(first.begin() + 992, 32, wire.begin() + 224);
  }
  CellControllerRequest request; CellControllerNonce initial{}; initial.fill(0x11);
  Check(DecodeCellControllerRequest(wire, initial, &request), "independent malformed-response request");
  CellControllerClientOwner owner{&client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt};
  const auto result = RunCellControllerClientSession(pipe.value, stop.value, GetTickCount64() + 5000, request, owner);
  SetEvent(done.value); client.server.Close(); pipe.Close(); thread.join();
  if (server_error) std::rethrow_exception(server_error);
  if (!std::strcmp(mode, "short")) Check(result != ERROR_SUCCESS, "truncated frame is refused");
  else Code(result, ERROR_INVALID_DATA, "malformed server response is refused");
  Check(outcome.records.empty() && !client.received, "invalid response never reaches checkpoint or receipt consumer");
}
std::vector<std::uint8_t> JournalBytes(const Parent& parent, const std::wstring& name) {
  Handle file{CreateFileW((parent.path + L"\\" + name + L".provisioning").c_str(), GENERIC_READ, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, 0, nullptr)};
  LARGE_INTEGER size{};
  Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart > 0 && size.QuadPart <= 21 * 1024,
    "read independently retained volume/format journal size");
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart)); DWORD read = 0;
  Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size(),
    "read exact retained volume journal bytes");
  return bytes;
}
// Controlled server responses use records emitted by the real journal. This
// checks the production client parser; it is not physical volume recovery.
void VolumeReply(const std::wstring& root, const Wire& wire, const std::vector<CellProvisioningRecord>& records, const char* mode,
  const std::wstring& owner_sid = {}) {
  const auto sequence = ++sessions; ++native_client_sessions;
  const bool recover = !std::strncmp(mode, "recover", 7);
  const bool workspace = records.size() == 21, mount = records.size() >= 19, protection = records.size() >= 15, format = records.size() >= 13;
  const unsigned maximum = workspace ? 21 : mount ? 19 : protection ? 15 : format ? 13 : 11, boundary = workspace ? 19 : mount ? 15 : protection ? 13 : format ? 11 : 5;
  Check(records.size() == maximum, "controlled response has a complete bounded journal");
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCellVolumeReply-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 8192, 8192, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value && done.value, "create controlled volume response pipe");
  std::exception_ptr server_error;
  std::jthread thread([&]() {
    try {
      const auto deadline = GetTickCount64() + 8000;
      Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "volume response client connects");
      CellControllerNonce hello{};
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::hello, hello.data(), 32, stop.value, deadline), ERROR_SUCCESS, "volume response captures client nonce");
      std::array<std::uint8_t, 64> welcome{}; std::copy(hello.begin(), hello.end(), welcome.begin());
      std::fill(welcome.begin() + 32, welcome.end(), std::uint8_t{0x63});
      Code(WriteCellControllerMessage(server.value, CellControllerMessage::welcome, welcome.data(), 64, stop.value, deadline), ERROR_SUCCESS, "volume response sends bound welcome");
      Wire requested{};
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::request, requested.data(), static_cast<DWORD>(requested.size()), stop.value, deadline), ERROR_SUCCESS, "volume response reads request");
      CellControllerNonce nonce{}; std::copy_n(welcome.begin() + 32, 32, nonce.begin());
      if (recover) {
        std::array<std::uint8_t, kCellControllerVolumeHistoryBytes> history{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::volume_history, history.data(), static_cast<DWORD>(history.size()), stop.value, deadline), ERROR_SUCCESS, "client sends independently retained volume history");
        Check(std::equal(nonce.begin(), nonce.end(), history.begin()), "recovery history has the current nonce");
        for (std::size_t i = 0; i < 6; ++i) Check(std::equal(records[i + 5].begin(), records[i + 5].end(), history.begin() + 32 + i * 1024), "recovery history contains exact canonical bytes");
        if (format) {
          std::array<std::uint8_t, kCellControllerFormatHistoryBytes> formats{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::format_history, formats.data(), static_cast<DWORD>(formats.size()), stop.value, deadline),
            ERROR_SUCCESS, "client sends independently retained format history");
          Check(std::equal(nonce.begin(), nonce.end(), formats.begin()), "format history has the current nonce");
          for (std::size_t i = 0; i < 2; ++i) Check(std::equal(records[i + 11].begin(), records[i + 11].end(), formats.begin() + 32 + i * 1024),
            "format recovery sends exact canonical bytes");
        }
        if (protection) {
          std::array<std::uint8_t, kCellControllerProtectionHistoryBytes> protections{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::protection_history, protections.data(), static_cast<DWORD>(protections.size()), stop.value, deadline),
            ERROR_SUCCESS, "client sends independently retained protection history");
          Check(std::equal(nonce.begin(), nonce.end(), protections.begin()), "protection history has the current nonce");
          for (std::size_t i = 0; i < 2; ++i) Check(std::equal(records[i + 13].begin(), records[i + 13].end(), protections.begin() + 32 + i * 1024),
            "protection recovery sends exact canonical bytes");
        }
        if (mount) {
          std::array<std::uint8_t, kCellControllerMountHistoryBytes> mounts{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::mount_history, mounts.data(), static_cast<DWORD>(mounts.size()), stop.value, deadline),
            ERROR_SUCCESS, "client sends independently retained creation and mount history");
          Check(std::equal(nonce.begin(), nonce.end(), mounts.begin()), "mount history has the current nonce");
          for (std::size_t i = 0; i < 5; ++i) Check(std::equal(records[i].begin(), records[i].end(), mounts.begin() + 32 + i * 1024),
            "mount recovery sends original canonical workspace identities");
          for (std::size_t i = 0; i < 4; ++i) Check(std::equal(records[i + 15].begin(), records[i + 15].end(), mounts.begin() + 32 + (5 + i) * 1024),
            "mount recovery sends exact canonical mount bytes");
        }
        if (workspace) {
          std::array<std::uint8_t, kCellControllerMountedWorkspaceHistoryBytes> workspaces{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::mounted_workspace_history, workspaces.data(), static_cast<DWORD>(workspaces.size()), stop.value, deadline),
            ERROR_SUCCESS, "client sends independent workspace history");
          Check(std::equal(nonce.begin(), nonce.end(), workspaces.begin()), "workspace history binds the current nonce");
          for (std::size_t i = 0; i < 2; ++i) Check(std::equal(records[i + 19].begin(), records[i + 19].end(), workspaces.begin() + 32 + i * 1024),
            "workspace recovery sends exact canonical bytes");
        }
      }
      unsigned ordinal = 0;
      const auto challenge = [&](unsigned count, const char* corruption = "") {
        std::array<std::uint8_t, 72> bytes{}, reply{}; std::copy(nonce.begin(), nonce.end(), bytes.begin());
        Put(bytes.data() + 32, ++ordinal, 4); Put(bytes.data() + 36, count, 4);
        std::copy_n(records[count - 1].begin() + 992, 32, bytes.begin() + 40);
        if (!std::strcmp(corruption, "ordinal")) Put(bytes.data() + 32, ordinal + 1, 4);
        if (!std::strcmp(corruption, "replay")) Put(bytes.data() + 32, ordinal - 1, 4);
        if (!std::strcmp(corruption, "count")) Put(bytes.data() + 36, count + 1, 4);
        if (!std::strcmp(corruption, "head")) bytes[40] ^= 1;
        if (!std::strcmp(corruption, "nonce")) bytes[0] ^= 1;
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::volume_authority, bytes.data(), 72, stop.value, deadline), ERROR_SUCCESS, "send volume authority challenge");
        if (*corruption) return;
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::volume_authorized, reply.data(), 72, stop.value, deadline), ERROR_SUCCESS, "receive current volume authority");
        Check(reply == bytes, "client authority echoes the exact connection, ordinal, count and head");
      };
      bool faulty = false;
      for (unsigned i = 0; i < maximum; ++i) {
        if (!recover && i >= 5) {
          if (i == boundary && (!std::strcmp(mode, "ordinal") || !std::strcmp(mode, "count") || !std::strcmp(mode, "head") ||
              !std::strcmp(mode, "nonce") || !std::strcmp(mode, "replay") || !std::strcmp(mode, "bound"))) {
            if (!std::strcmp(mode, "replay")) challenge(i);
            if (!std::strcmp(mode, "bound")) while (ordinal < kCellControllerMaximumVolumeChecks) challenge(i);
            challenge(i, mode); faulty = true; break;
          }
          if (std::strcmp(mode, "missing-first") || i != boundary) {
            if (std::strcmp(mode, "missing-between") || i != boundary + 1) challenge(i);
          }
        }
        std::array<std::uint8_t, 1056> payload{}; std::copy(nonce.begin(), nonce.end(), payload.begin());
        std::copy(records[i].begin(), records[i].end(), payload.begin() + 32);
        if (i == boundary && !std::strcmp(mode, "recover-record")) std::copy(records[boundary + 1].begin(), records[boundary + 1].end(), payload.begin() + 32);
        if (i == boundary && !std::strcmp(mode, "record")) {
          payload[32 + 600] ^= 1;
          BCRYPT_ALG_HANDLE algorithm = nullptr;
          Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "volume fixture SHA provider");
          const auto hashed = BCryptHash(algorithm, nullptr, 0, payload.data() + 32, 992, payload.data() + 32 + 992, 32);
          BCryptCloseAlgorithmProvider(algorithm, 0); Check(hashed >= 0, "malformed volume metadata has a valid outer hash");
        }
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::checkpoint, payload.data(), static_cast<DWORD>(payload.size()), stop.value, deadline), ERROR_SUCCESS, "send volume protocol checkpoint");
        if (!i && !std::strcmp(mode, "sid")) { faulty = true; break; }
        if ((i == boundary && (!std::strcmp(mode, "missing-first") || !std::strcmp(mode, "record") || !std::strcmp(mode, "recover-record"))) ||
            (i == boundary + 1 && !std::strcmp(mode, "missing-between"))) { faulty = true; break; }
        if (!recover) {
          std::array<std::uint8_t, 68> ack{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::acknowledgement, ack.data(), 68, stop.value, deadline), ERROR_SUCCESS, "receive globally numbered volume checkpoint acknowledgement");
          Check(std::equal(nonce.begin(), nonce.end(), ack.begin()) && U32(ack.data() + 32) == i + 1 &&
            std::equal(records[i].begin() + 992, records[i].end(), ack.begin() + 36), "acknowledgement preserves global sequence and exact digest");
        }
      }
      if (!faulty) {
        if (!recover && std::strcmp(mode, "missing-terminal")) challenge(maximum);
        std::array<std::uint8_t, 48> bytes{}; std::copy(nonce.begin(), nonce.end(), bytes.begin());
        Put(bytes.data() + 36, 5, 4); Put(bytes.data() + 40, recover ? 0 : 1, 4); Put(bytes.data() + 44, maximum, 4);
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::receipt, bytes.data(), 48, stop.value, deadline), ERROR_SUCCESS, "send full volume receipt");
        if (std::strcmp(mode, "missing-terminal")) {
          CellControllerNonce finish{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::finish, finish.data(), 32, stop.value, deadline), ERROR_SUCCESS, "full history recovery acknowledges receipt");
          Check(finish == nonce, "recovery completion binds current connection");
        }
      }
      Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "volume client completes or refuses without another record");
    } catch (...) { server_error = std::current_exception(); SetEvent(stop.value); }
  });
  Handle pipe{CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Check(pipe.value != INVALID_HANDLE_VALUE, "open volume response client");
  Outcome outcome; NativeClient client{{}, root, sequence, outcome, stop.value, "controlled-volume-reply"};
  Code(client.server.Open(pipe.value), ERROR_SUCCESS, "volume client authenticates actual pipe server");
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest request;
  Check(DecodeCellControllerRequest(wire, initial, &request), "decode volume response request");
  if (recover) {
    request.operation = workspace ? 12 : mount ? 10 : protection ? 8 : format ? 6 : 4;
    request.anchor.file.volume_serial = request.parent.volume_serial;
    std::copy_n(records[0].begin() + 176, 16, request.anchor.file.file_id.begin());
    std::copy_n(records[0].begin() + 992, 32, request.anchor.prepared_sha256.begin());
    std::copy_n(records.begin() + 5, 6, request.volume_records.begin());
    if (format) std::copy_n(records.begin() + 11, 2, request.format_records.begin());
    if (protection) std::copy_n(records.begin() + 13, 2, request.protection_records.begin());
    if (mount) {
      std::copy_n(records.begin(), 5, request.creation_records.begin());
      std::copy_n(records.begin() + 15, 4, request.mount_records.begin());
    }
    if (workspace) std::copy_n(records.begin() + 19, 2, request.mounted_workspace_records.begin());
  }
  CellControllerClientOwner owner{&client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
  owner.owner_sid = !std::strcmp(mode, "sid") ? L"S-1-5-18" : owner_sid; owner.controller_sid = owner_sid;
  const auto result = RunCellControllerClientSession(pipe.value, stop.value, GetTickCount64() + 8000, request, owner);
  SetEvent(done.value); client.server.Close(); pipe.Close(); thread.join();
  if (server_error) std::rethrow_exception(server_error);
  const bool success = !std::strcmp(mode, "recover");
  Code(result, success ? ERROR_SUCCESS : ERROR_INVALID_DATA, "volume client accepts only exact history and fresh authority");
  const unsigned expected = !std::strcmp(mode, "sid") ? 0 : success || !std::strcmp(mode, "missing-terminal") ? maximum : !std::strcmp(mode, "missing-between") ? boundary + 1 : boundary;
  Check(outcome.records.size() == expected && client.received == success, "invalid volume response is withheld from checkpoint or success consumers");
  if (success) Check(outcome.records == records && outcome.volume_checks == 0, "read-only protocol recovery reproduces the complete history without authority for writes");
}
void VolumeActual(const Parent& parent, const std::wstring& root) {
  const auto request = [&](const std::wstring& name) {
    auto bytes = Request(parent.identity, name); Put(bytes.data(), 3, 4);
    Put(bytes.data() + 160, 64ULL * 1024 * 1024); Put(bytes.data() + 168, 128ULL * 1024 * 1024); return bytes;
  };
  const auto absent_name = Name();
  const auto absent = Exchange(parent, root, request(absent_name), "native-volume-missing-owner");
  Check(absent.result.error == ERROR_NOT_SUPPORTED && !absent.result.creation_attempted && absent.records.empty() &&
    GetFileAttributesW((parent.path + L"\\" + absent_name + L".provisioning").c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing volume composition refuses before creating even the journal");
  const auto name = Name(); const auto wire = request(name);
  const auto created = Exchange(parent, root, wire, "native-volume-create");
  Code(created.client_error, ERROR_SUCCESS, "volume client protocol completes");
  Code(created.result.error, ERROR_SUCCESS, "actual journal composes controlled attachment/layout through controller protocol");
  Check(created.result.receipt_acknowledged && created.records.size() == 11 && created.volume_checks >= 8 &&
    created.result.volume_authority_checks == created.volume_checks, "all eleven records and repeated current authority precede volume receipt");
  volume_authority_checks = created.volume_checks;
  const auto before = JournalBytes(parent, name);
  Check(before.size() == 11264, "volume journal retains eleven records");
  for (std::size_t i = 0; i < created.records.size(); ++i)
    Check(std::equal(created.records[i].begin(), created.records[i].end(), before.begin() + i * 1024), "journal bytes match every independently acknowledged checkpoint");
  auto recovery = wire; Put(recovery.data(), 4, 4);
  std::copy_n(created.records[0].begin() + 168, 24, recovery.begin() + 200);
  std::copy_n(created.records[0].begin() + 992, 32, recovery.begin() + 224);
  std::array<CellVolumeProvisioningRecord, 6> volume{}; std::copy_n(created.records.begin() + 5, 6, volume.begin());
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest decoded; Wire encoded{};
  Check(DecodeCellControllerRequest(recovery, initial, &decoded), "decode full volume recovery request");
  decoded.volume_records = volume;
  Check(ValidateCellControllerVolumeHistory(decoded) && EncodeCellControllerRequest(decoded, &encoded) && encoded == recovery,
    "encoder accepts exact complete independently retained volume history");
  for (std::size_t i = 0; i < volume.size(); ++i) {
    auto corrupt = decoded; corrupt.volume_records[i].fill(0);
    Check(!ValidateCellControllerVolumeHistory(corrupt) && !EncodeCellControllerRequest(corrupt, &encoded) && encoded == Wire{},
      "missing volume record is rejected before transport");
  }
  auto wrong_operation = decoded; wrong_operation.operation = 2;
  Check(!EncodeCellControllerRequest(wrong_operation, &encoded), "legacy recovery cannot silently discard volume history");
  const auto recovered = Exchange(parent, root, recovery, "native-volume-recover", &volume);
  Check(recovered.result.error != ERROR_SUCCESS && !recovered.result.creation_attempted && recovered.records.empty() &&
    JournalBytes(parent, name) == before, "real recovery refuses a fixture-only attachment and preserves all bytes without writes");
  for (const auto mode : {"native-volume-denied", "native-volume-final-denied", "native-volume-cancel", "native-volume-revoke", "native-volume-bad-ack"}) {
    const auto failed_name = Name(); const auto failed = Exchange(parent, root, request(failed_name), mode);
    const unsigned retained = !std::strcmp(mode, "native-volume-final-denied") ? 11 : !std::strcmp(mode, "native-volume-bad-ack") ? 6 : 5;
    Check(failed.client_error != ERROR_SUCCESS && failed.result.error != ERROR_SUCCESS && !failed.result.receipt_acknowledged &&
      failed.records.size() == retained && JournalBytes(parent, failed_name).size() == retained * 1024,
      "lost current authority or wrong volume ACK stops at the exact durable prefix");
  }
  for (const auto mode : {"missing-first", "missing-between", "missing-terminal", "ordinal", "head", "count", "nonce", "replay", "bound", "record", "recover", "recover-record"})
    VolumeReply(root, wire, created.records, mode);
}
void FormatActual(const Parent& parent, const std::wstring& root) {
  const auto request = [&](const std::wstring& name) {
    auto bytes = Request(parent.identity, name); Put(bytes.data(), 5, 4);
    Put(bytes.data() + 160, 64ULL * 1024 * 1024); Put(bytes.data() + 168, 128ULL * 1024 * 1024); return bytes;
  };
  const auto absent_name = Name();
  const auto absent = Exchange(parent, root, request(absent_name), "native-format-missing-owner");
  Check(absent.result.error == ERROR_NOT_SUPPORTED && !absent.result.creation_attempted && absent.records.empty() &&
    GetFileAttributesW((parent.path + L"\\" + absent_name + L".provisioning").c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing format composition refuses before creating the journal");
  const auto name = Name(); const auto wire = request(name);
  const auto created = Exchange(parent, root, wire, "native-format-create");
  Code(created.client_error, ERROR_SUCCESS, "format client protocol completes");
  Code(created.result.error, ERROR_SUCCESS, "actual journal composes controlled NTFS formatting through controller protocol");
  Check(created.result.receipt_acknowledged && created.records.size() == 13 && created.volume_checks > volume_authority_checks &&
    created.result.volume_authority_checks == created.volume_checks, "all thirteen records and current authority precede format success");
  format_authority_checks = created.volume_checks;
  const auto before = JournalBytes(parent, name);
  Check(before.size() == 13 * 1024, "format journal retains thirteen exact records");
  for (std::size_t i = 0; i < created.records.size(); ++i)
    Check(std::equal(created.records[i].begin(), created.records[i].end(), before.begin() + i * 1024), "format bytes match independent acknowledgements");
  auto recovery = wire; Put(recovery.data(), 6, 4);
  std::copy_n(created.records[0].begin() + 168, 24, recovery.begin() + 200);
  std::copy_n(created.records[0].begin() + 992, 32, recovery.begin() + 224);
  std::array<CellVolumeProvisioningRecord, 6> volume{}; std::copy_n(created.records.begin() + 5, 6, volume.begin());
  std::array<CellFormatProvisioningRecord, 2> formats{}; std::copy_n(created.records.begin() + 11, 2, formats.begin());
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest decoded; Wire encoded{};
  Check(DecodeCellControllerRequest(recovery, initial, &decoded), "decode format recovery request");
  decoded.volume_records = volume; decoded.format_records = formats;
  Check(ValidateCellControllerFormatHistory(decoded) && EncodeCellControllerRequest(decoded, &encoded) && encoded == recovery,
    "encoder binds both canonical format records after the full volume history");
  for (std::size_t i = 0; i < formats.size(); ++i) {
    auto corrupt = decoded; corrupt.format_records[i].fill(0);
    Check(!ValidateCellControllerFormatHistory(corrupt) && !EncodeCellControllerRequest(corrupt, &encoded) && encoded == Wire{},
      "incomplete format history cannot enter transport");
  }
  auto legacy = decoded; legacy.operation = 4;
  Check(!EncodeCellControllerRequest(legacy, &encoded), "volume-only recovery cannot discard format history");
  const auto recovered = Exchange(parent, root, recovery, "native-format-recover", &volume, &formats);
  Check(recovered.result.error != ERROR_SUCCESS && !recovered.result.creation_attempted && recovered.records.empty() &&
    JournalBytes(parent, name) == before, "real recovery refuses controlled-only formatting without any write");
  for (const auto mode : {"native-format-denied", "native-format-intent-denied", "native-format-final-denied",
      "native-format-cancel", "native-format-revoke", "native-format-bad-ack"}) {
    const auto failed_name = Name(); const auto failed = Exchange(parent, root, request(failed_name), mode);
    const unsigned retained = !std::strcmp(mode, "native-format-final-denied") ? 13 :
      (!std::strcmp(mode, "native-format-intent-denied") || !std::strcmp(mode, "native-format-bad-ack")) ? 12 : 11;
    Check(failed.client_error != ERROR_SUCCESS && failed.result.error != ERROR_SUCCESS && !failed.result.receipt_acknowledged &&
      failed.records.size() == retained && JournalBytes(parent, failed_name).size() == retained * 1024,
      "format authority/ACK failure preserves the exact durable prefix without retrying");
  }
  for (const auto mode : {"missing-first", "missing-between", "missing-terminal", "ordinal", "head", "count", "nonce", "replay", "bound", "record", "recover", "recover-record"})
    VolumeReply(root, wire, created.records, mode);
}
void ProtectionActual(const Parent& parent, const std::wstring& root) {
  const auto request = [&](const std::wstring& name) {
    auto bytes = Request(parent.identity, name); Put(bytes.data(), 7, 4);
    Put(bytes.data() + 160, 64ULL * 1024 * 1024); Put(bytes.data() + 168, 128ULL * 1024 * 1024); return bytes;
  };
  const auto absent_name = Name();
  const auto absent = Exchange(parent, root, request(absent_name), "native-protection-missing-owner");
  Check(absent.result.error == ERROR_NOT_SUPPORTED && !absent.result.creation_attempted && absent.records.empty() &&
    GetFileAttributesW((parent.path + L"\\" + absent_name + L".provisioning").c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing protection composition refuses before creating the journal");
  const auto name = Name(); const auto wire = request(name);
  const auto created = Exchange(parent, root, wire, "native-protection-create");
  Code(created.client_error, ERROR_SUCCESS, "protection client protocol completes");
  Code(created.result.error, ERROR_SUCCESS, "actual journal composes controlled root protection through controller protocol");
  Check(created.result.receipt_acknowledged && created.records.size() == 15 && created.volume_checks > format_authority_checks &&
    created.result.volume_authority_checks == created.volume_checks, "all fifteen records and current authority precede protection success");
  protection_authority_checks = created.volume_checks;
  const auto before = JournalBytes(parent, name);
  Check(before.size() == 15 * 1024, "protection journal retains fifteen exact records");
  for (std::size_t i = 0; i < created.records.size(); ++i)
    Check(std::equal(created.records[i].begin(), created.records[i].end(), before.begin() + i * 1024), "protection bytes match independent acknowledgements");
  auto recovery = wire; Put(recovery.data(), 8, 4);
  std::copy_n(created.records[0].begin() + 168, 24, recovery.begin() + 200);
  std::copy_n(created.records[0].begin() + 992, 32, recovery.begin() + 224);
  std::array<CellVolumeProvisioningRecord, 6> volume{}; std::copy_n(created.records.begin() + 5, 6, volume.begin());
  std::array<CellFormatProvisioningRecord, 2> formats{}; std::copy_n(created.records.begin() + 11, 2, formats.begin());
  std::array<CellProtectionProvisioningRecord, 2> protections{}; std::copy_n(created.records.begin() + 13, 2, protections.begin());
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest decoded; Wire encoded{};
  Check(DecodeCellControllerRequest(recovery, initial, &decoded), "decode protection recovery request");
  decoded.volume_records = volume; decoded.format_records = formats; decoded.protection_records = protections;
  Check(ValidateCellControllerProtectionHistory(decoded, parent.user, parent.user) &&
    EncodeCellControllerRequest(decoded, &encoded, parent.user, parent.user) && encoded == recovery,
    "encoder binds protection to all prior history and local custody principals");
  Check(!EncodeCellControllerRequest(decoded, &encoded) && encoded == Wire{} &&
    !ValidateCellControllerProtectionHistory(decoded, L"S-1-5-18", parent.user), "protection recovery requires trusted matching principals");
  for (std::size_t i = 0; i < protections.size(); ++i) {
    auto corrupt = decoded; corrupt.protection_records[i].fill(0);
    Check(!ValidateCellControllerProtectionHistory(corrupt, parent.user, parent.user) &&
      !EncodeCellControllerRequest(corrupt, &encoded, parent.user, parent.user) && encoded == Wire{}, "partial protection history cannot enter transport");
  }
  for (const std::size_t offset : {216u, 328u, 360u, 392u, 448u}) {
    auto corrupt = decoded; auto& record = corrupt.protection_records.back(); record[offset] ^= 1;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "protection mutation SHA provider");
    const auto inner = BCryptHash(algorithm, nullptr, 0, record.data() + 280, 480, record.data() + 760, 32);
    const auto outer = BCryptHash(algorithm, nullptr, 0, record.data(), 992, record.data() + 992, 32);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    Check(inner >= 0 && outer >= 0 && !ValidateCellControllerProtectionHistory(corrupt, parent.user, parent.user) &&
      !EncodeCellControllerRequest(corrupt, &encoded, parent.user, parent.user), "rehashed wrong format, policy, volume or root identity is refused");
  }
  for (const unsigned operation : {1u, 2u, 3u, 4u, 5u, 6u, 7u}) {
    auto legacy = decoded; legacy.operation = operation;
    Check(!EncodeCellControllerRequest(legacy, &encoded, parent.user, parent.user), "other operations cannot silently discard protection history");
  }
  const auto recovered = Exchange(parent, root, recovery, "native-protection-recover", &volume, &formats, &protections);
  Check(recovered.result.error != ERROR_SUCCESS && !recovered.result.creation_attempted && recovered.records.empty() &&
    JournalBytes(parent, name) == before, "real recovery refuses controlled-only protection without any write");
  for (const auto mode : {"native-protection-denied", "native-protection-intent-denied", "native-protection-final-denied",
      "native-protection-cancel", "native-protection-revoke", "native-protection-bad-ack", "native-protection-final-bad-ack"}) {
    const auto failed_name = Name(); const auto failed = Exchange(parent, root, request(failed_name), mode);
    const unsigned retained = (!std::strcmp(mode, "native-protection-final-denied") || !std::strcmp(mode, "native-protection-final-bad-ack")) ? 15 :
      (!std::strcmp(mode, "native-protection-intent-denied") || !std::strcmp(mode, "native-protection-bad-ack")) ? 14 : 13;
    Check(failed.client_error != ERROR_SUCCESS && failed.result.error != ERROR_SUCCESS && !failed.result.receipt_acknowledged &&
      failed.records.size() == retained && JournalBytes(parent, failed_name).size() == retained * 1024,
      "protection authority/ACK failure preserves the exact durable prefix without retrying");
  }
  for (const auto mode : {"missing-first", "missing-between", "missing-terminal", "ordinal", "head", "count", "nonce", "replay", "bound", "record", "recover", "recover-record", "sid"})
    VolumeReply(root, wire, created.records, mode, parent.user);
}
void MountActual(const Parent& parent, const std::wstring& root) {
  const auto request = [&](const std::wstring& name) {
    auto bytes = Request(parent.identity, name); Put(bytes.data(), 9, 4);
    Put(bytes.data() + 160, 64ULL * 1024 * 1024); Put(bytes.data() + 168, 128ULL * 1024 * 1024); return bytes;
  };
  const auto absent_name = Name();
  const auto absent = Exchange(parent, root, request(absent_name), "native-mount-missing-owner");
  Check(absent.result.error == ERROR_NOT_SUPPORTED && !absent.result.creation_attempted && absent.records.empty() &&
    GetFileAttributesW((parent.path + L"\\" + absent_name + L".provisioning").c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing mount composition refuses before creating any journal or VHDX");
  const auto name = Name(); const auto wire = request(name);
  const auto created = Exchange(parent, root, wire, "native-mount-create");
  Code(created.client_error, ERROR_SUCCESS, "mount client protocol completes");
  Code(created.result.error, ERROR_SUCCESS, "actual journal composes controlled fixed-folder mount through controller protocol");
  Check(created.result.receipt_acknowledged && created.records.size() == 19 && created.volume_checks > protection_authority_checks &&
    created.result.volume_authority_checks == created.volume_checks && created.volume_checks <= kCellControllerMaximumVolumeChecks,
    "all nineteen records and current authority precede mount success within the existing bound");
  mount_authority_checks = created.volume_checks;
  const auto before = JournalBytes(parent, name);
  Check(before.size() == 19 * 1024, "mount journal retains nineteen exact records");
  for (std::size_t i = 0; i < created.records.size(); ++i)
    Check(std::equal(created.records[i].begin(), created.records[i].end(), before.begin() + i * 1024), "mount bytes match independent acknowledgements");
  auto recovery = wire; Put(recovery.data(), 10, 4);
  std::copy_n(created.records[0].begin() + 168, 24, recovery.begin() + 200);
  std::copy_n(created.records[0].begin() + 992, 32, recovery.begin() + 224);
  std::array<CellVolumeProvisioningRecord, 6> volume{}; std::copy_n(created.records.begin() + 5, 6, volume.begin());
  std::array<CellFormatProvisioningRecord, 2> formats{}; std::copy_n(created.records.begin() + 11, 2, formats.begin());
  std::array<CellProtectionProvisioningRecord, 2> protections{}; std::copy_n(created.records.begin() + 13, 2, protections.begin());
  std::array<CellProvisioningRecord, 5> creation{}; std::copy_n(created.records.begin(), 5, creation.begin());
  std::array<CellMountProvisioningRecord, 4> mounts{}; std::copy_n(created.records.begin() + 15, 4, mounts.begin());
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest decoded; Wire encoded{};
  Check(DecodeCellControllerRequest(recovery, initial, &decoded), "decode mount recovery request");
  decoded.volume_records = volume; decoded.format_records = formats; decoded.protection_records = protections;
  decoded.creation_records = creation; decoded.mount_records = mounts;
  Check(ValidateCellControllerMountHistory(decoded, parent.user, parent.user) &&
    EncodeCellControllerRequest(decoded, &encoded, parent.user, parent.user) && encoded == recovery,
    "encoder binds mount to independent creation history and local custody principals");
  Check(!ValidateCellControllerMountHistory(decoded, L"S-1-5-18", parent.user) && !EncodeCellControllerRequest(decoded, &encoded),
    "mount recovery requires matching trusted principals");
  for (unsigned i = 0; i < 9; ++i) {
    auto corrupt = decoded; if (i < 5) corrupt.creation_records[i].fill(0); else corrupt.mount_records[i - 5].fill(0);
    Check(!ValidateCellControllerMountHistory(corrupt, parent.user, parent.user) &&
      !EncodeCellControllerRequest(corrupt, &encoded, parent.user, parent.user), "every independent creation and mount record is required");
  }
  for (const std::size_t offset : {328U, 360U, 392U, 408U, 432U, 456U}) {
    auto corrupt = decoded; auto& record = corrupt.mount_records.back(); record[offset] ^= 1;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "mount mutation SHA provider");
    const auto inner = BCryptHash(algorithm, nullptr, 0, record.data() + 280, 480, record.data() + 760, 32);
    const auto outer = BCryptHash(algorithm, nullptr, 0, record.data(), 992, record.data() + 992, 32);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    Check(inner >= 0 && outer >= 0 && !ValidateCellControllerMountHistory(corrupt, parent.user, parent.user) &&
      !EncodeCellControllerRequest(corrupt, &encoded, parent.user, parent.user), "rehashed wrong protection, policy, volume, parent, root or directory is refused");
  }
  for (unsigned operation = 1; operation < 10; ++operation) {
    auto legacy = decoded; legacy.operation = operation;
    Check(!EncodeCellControllerRequest(legacy, &encoded, parent.user, parent.user), "shorter operations cannot silently discard mount history");
  }
  const auto recovered = Exchange(parent, root, recovery, "native-mount-recover", &volume, &formats, &protections, &creation, &mounts);
  Check(recovered.result.error != ERROR_SUCCESS && !recovered.result.creation_attempted && recovered.records.empty() &&
    JournalBytes(parent, name) == before, "real recovery refuses controlled-only mount history without any write");
  for (const auto mode : {"mount-history-size", "mount-history-nonce", "mount-history-creation", "mount-history-record"}) {
    const auto failed = Exchange(parent, root, recovery, mode, &volume, &formats, &protections, &creation, &mounts);
    Check(failed.result.error == ERROR_INVALID_DATA && !failed.result.creation_attempted && !failed.result.receipt_written &&
      failed.records.empty() && JournalBytes(parent, name) == before, "server independently refuses malformed mount recovery without effects");
  }
  struct Failure { const char* mode; unsigned retained; };
  for (const auto& failure : {Failure{"native-mount-denied", 15}, {"native-mount-directory-denied", 16}, {"native-mount-intent-denied", 17},
      {"native-mount-submission-denied", 18}, {"native-mount-final-denied", 19}, {"native-mount-cancel", 15}, {"native-mount-revoke", 15},
      {"native-mount-prepared-bad-ack", 16}, {"native-mount-directory-bad-ack", 17}, {"native-mount-intent-bad-ack", 18}, {"native-mount-final-bad-ack", 19}}) {
    const auto failed_name = Name(); const auto failed = Exchange(parent, root, request(failed_name), failure.mode);
    Check(failed.client_error != ERROR_SUCCESS && failed.result.error != ERROR_SUCCESS && !failed.result.receipt_acknowledged &&
      failed.records.size() == failure.retained && JournalBytes(parent, failed_name).size() == failure.retained * 1024,
      "mount authority/ACK failure preserves the exact durable prefix without repeating effects");
  }
  for (const auto mode : {"missing-first", "missing-between", "missing-terminal", "ordinal", "head", "count", "nonce", "replay", "bound", "record", "recover", "recover-record", "sid"})
    VolumeReply(root, wire, created.records, mode, parent.user);
}
void MountedWorkspaceActual(const std::wstring& root) {
  Check(CreateDirectoryW(root.c_str(), nullptr), "new task-owned workspace protocol output");
  Parent parent; parent.Create(root);
  const auto request = [&](const std::wstring& name) {
    auto bytes = Request(parent.identity, name); Put(bytes.data(), 11, 4);
    Put(bytes.data() + 160, 64ULL * 1024 * 1024); Put(bytes.data() + 168, 128ULL * 1024 * 1024); return bytes;
  };
  const auto absent_name = Name();
  const auto absent = Exchange(parent, root, request(absent_name), "native-workspace-missing-owner");
  Check(absent.result.error == ERROR_NOT_SUPPORTED && !absent.result.creation_attempted && absent.records.empty() &&
    GetFileAttributesW((parent.path + L"\\" + absent_name + L".provisioning").c_str()) == INVALID_FILE_ATTRIBUTES,
    "missing workspace owner refuses before creating any journal or VHDX");
  const auto name = Name(); const auto wire = request(name);
  const auto created = Exchange(parent, root, wire, "native-workspace-create");
  Code(created.client_error, ERROR_SUCCESS, "workspace client protocol completes");
  Code(created.result.error, ERROR_SUCCESS, "journal composes controlled workspace directory creation");
  Check(created.result.receipt_acknowledged && created.records.size() == 21 && created.volume_checks >= 17 &&
    created.result.volume_authority_checks == created.volume_checks && created.volume_checks <= kCellControllerMaximumVolumeChecks,
    "all 21 records and current authority precede workspace completion within the existing bound");
  workspace_authority_checks = created.volume_checks;
  const auto before = JournalBytes(parent, name);
  Check(before.size() == 21 * 1024, "workspace journal retains 21 exact records");
  for (std::size_t i = 0; i < created.records.size(); ++i)
    Check(std::equal(created.records[i].begin(), created.records[i].end(), before.begin() + i * 1024), "workspace bytes match independent acknowledgements");
  auto recovery = wire; Put(recovery.data(), 12, 4);
  std::copy_n(created.records[0].begin() + 168, 24, recovery.begin() + 200);
  std::copy_n(created.records[0].begin() + 992, 32, recovery.begin() + 224);
  std::array<CellVolumeProvisioningRecord, 6> volume{}; std::copy_n(created.records.begin() + 5, 6, volume.begin());
  std::array<CellFormatProvisioningRecord, 2> formats{}; std::copy_n(created.records.begin() + 11, 2, formats.begin());
  std::array<CellProtectionProvisioningRecord, 2> protections{}; std::copy_n(created.records.begin() + 13, 2, protections.begin());
  std::array<CellProvisioningRecord, 5> creation{}; std::copy_n(created.records.begin(), 5, creation.begin());
  std::array<CellMountProvisioningRecord, 4> mounts{}; std::copy_n(created.records.begin() + 15, 4, mounts.begin());
  std::array<CellMountedWorkspaceProvisioningRecord, 2> workspaces{}; std::copy_n(created.records.begin() + 19, 2, workspaces.begin());
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest decoded; Wire encoded{};
  Check(DecodeCellControllerRequest(recovery, initial, &decoded), "decode complete workspace recovery");
  decoded.volume_records = volume; decoded.format_records = formats; decoded.protection_records = protections;
  decoded.creation_records = creation; decoded.mount_records = mounts; decoded.mounted_workspace_records = workspaces;
  Check(ValidateCellControllerMountedWorkspaceHistory(decoded, parent.user, parent.user) &&
    EncodeCellControllerRequest(decoded, &encoded, parent.user, parent.user) && encoded == recovery,
    "encoder binds workspace history to original mount, creation and principals");
  Check(!ValidateCellControllerMountedWorkspaceHistory(decoded, L"S-1-5-18", parent.user) && !EncodeCellControllerRequest(decoded, &encoded),
    "workspace recovery requires matching trusted principals");
  for (unsigned i = 0; i < 21; ++i) {
    auto corrupt = decoded;
    if (i < 5) corrupt.creation_records[i].fill(0);
    else if (i < 11) corrupt.volume_records[i - 5].fill(0);
    else if (i < 13) corrupt.format_records[i - 11].fill(0);
    else if (i < 15) corrupt.protection_records[i - 13].fill(0);
    else if (i < 19) corrupt.mount_records[i - 15].fill(0);
    else corrupt.mounted_workspace_records[i - 19].fill(0);
    Check(!ValidateCellControllerMountedWorkspaceHistory(corrupt, parent.user, parent.user) &&
      !EncodeCellControllerRequest(corrupt, &encoded, parent.user, parent.user), "every independent record in the complete chain is required");
  }
  for (const std::size_t offset : {328U, 360U, 392U, 432U, 456U}) {
    auto corrupt = decoded; auto& record = corrupt.mounted_workspace_records.back(); record[offset] ^= 1;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "workspace mutation SHA provider");
    const auto inner = BCryptHash(algorithm, nullptr, 0, record.data() + 280, 480, record.data() + 760, 32);
    const auto outer = BCryptHash(algorithm, nullptr, 0, record.data(), 992, record.data() + 992, 32);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    Check(inner >= 0 && outer >= 0 && !ValidateCellControllerMountedWorkspaceHistory(corrupt, parent.user, parent.user) &&
      !EncodeCellControllerRequest(corrupt, &encoded, parent.user, parent.user), "rehashed mount, policy, name, root or directory substitution is refused");
  }
  for (unsigned operation = 1; operation < 12; ++operation) {
    auto legacy = decoded; legacy.operation = operation;
    Check(!EncodeCellControllerRequest(legacy, &encoded, parent.user, parent.user), "shorter operations cannot discard workspace history");
  }
  const auto recovered = Exchange(parent, root, recovery, "native-workspace-recover", &volume, &formats, &protections, &creation, &mounts, &workspaces);
  Check(recovered.result.error != ERROR_SUCCESS && !recovered.result.creation_attempted && recovered.records.empty() &&
    JournalBytes(parent, name) == before, "real recovery refuses unattached fixture history without writes");
  for (const auto mode : {"workspace-history-size", "workspace-history-nonce", "workspace-history-record", "workspace-history-order"}) {
    const auto failed = Exchange(parent, root, recovery, mode, &volume, &formats, &protections, &creation, &mounts, &workspaces);
    Check(failed.result.error == ERROR_INVALID_DATA && !failed.result.creation_attempted && !failed.result.receipt_written &&
      failed.records.empty() && JournalBytes(parent, name) == before, "server refuses invalid workspace history without effects");
  }
  struct Failure { const char* mode; unsigned retained; };
  for (const auto& failure : {Failure{"native-workspace-denied", 19}, {"native-workspace-intent-denied", 20},
      {"native-workspace-final-denied", 21}, {"native-workspace-cancel", 19}, {"native-workspace-revoke", 19},
      {"native-workspace-intent-bad-ack", 20}, {"native-workspace-final-bad-ack", 21}}) {
    const auto failed_name = Name(); const auto failed = Exchange(parent, root, request(failed_name), failure.mode);
    Check(failed.client_error != ERROR_SUCCESS && failed.result.error != ERROR_SUCCESS && !failed.result.receipt_acknowledged &&
      failed.records.size() == failure.retained && JournalBytes(parent, failed_name).size() == failure.retained * 1024,
      "workspace authority or acknowledgement failure retains the exact prefix without retries");
  }
  for (const auto mode : {"missing-first", "missing-between", "missing-terminal", "ordinal", "head", "count", "nonce", "replay", "bound", "record", "recover", "recover-record", "sid"})
    VolumeReply(root, wire, created.records, mode, parent.user);
}
void Actual(const std::wstring& root) {
  Check(CreateDirectoryW(root.c_str(), nullptr), "new task-owned protocol output");
  Parent parent; parent.Create(root);
  VolumeActual(parent, root);
  FormatActual(parent, root);
  ProtectionActual(parent, root);
  MountActual(parent, root);
  const auto native_name = Name(); auto native_request = Request(parent.identity, native_name);
  const auto native_created = Exchange(parent, root, native_request, "native-create");
  Code(native_created.client_error, ERROR_SUCCESS, "production client creation transport completes");
  Check(native_created.result.error == ERROR_SUCCESS && native_created.result.receipt_acknowledged && native_created.records.size() == 5,
    "production client drives five actual acknowledged checkpoints");
  auto native_recovery = native_request; Put(native_recovery.data(), 2, 4);
  std::copy_n(native_created.records[0].begin() + 168, 24, native_recovery.begin() + 200);
  std::copy_n(native_created.records[0].begin() + 992, 32, native_recovery.begin() + 224);
  const auto native_recovered = Exchange(parent, root, native_recovery, "native-recover");
  Code(native_recovered.client_error, ERROR_SUCCESS, "production client recovery transport completes");
  Check(native_recovered.result.error == ERROR_SUCCESS && !native_recovered.result.creation_attempted &&
    native_recovered.records == native_created.records && native_recovered.result.receipt_acknowledged, "production client recovers exact records without creation");
  for (const auto mode : {"welcome", "nonce", "hash", "binding", "chain", "sequence", "recovery-anchor", "receipt", "oversize", "kind", "short"})
    BadReply(root, native_request, native_created.records.front(), mode);
  for (const auto mode : {"native-bad-commit", "native-revoke", "native-cancel", "native-timeout"}) {
    const auto name = Name(); const auto stopped = Exchange(parent, root, Request(parent.identity, name), mode);
    const DWORD expected = !std::strcmp(mode, "native-bad-commit") ? ERROR_INVALID_DATA : !std::strcmp(mode, "native-revoke") ? ERROR_ACCESS_DENIED
      : !std::strcmp(mode, "native-cancel") ? ERROR_OPERATION_ABORTED : ERROR_TIMEOUT;
    Code(stopped.client_error, expected, "production client refuses missing commit or expired authority before ACK");
    Check(stopped.result.error != ERROR_SUCCESS && stopped.records.size() == 1 &&
      GetFileAttributesW((parent.path + L"\\" + name).c_str()) == INVALID_FILE_ATTRIBUTES, "failed client cannot authorize workspace creation");
    Handle retained{CreateFileW((parent.path + L"\\" + name + L".provisioning").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr)};
    LARGE_INTEGER length{};
    Check(retained.value != INVALID_HANDLE_VALUE && GetFileSizeEx(retained.value, &length) && length.QuadPart == 1024,
      "failed production client retains only the prepared journal record");
  }
  const auto cell = Name(); auto request = Request(parent.identity, cell);
  const auto created = Exchange(parent, root, request, "create");
  Code(created.result.error, ERROR_SUCCESS, "actual native workspace and disk creation");
  Check(created.result.creation_attempted && created.result.receipt_acknowledged && created.result.phase == CellProvisioningPhase::disk_recorded &&
    created.records.size() == 5, "all five acknowledged creation checkpoints");
  auto recovery = request; Put(recovery.data(), 2, 4);
  std::copy_n(created.records[0].begin() + 168, 24, recovery.begin() + 200);
  std::copy_n(created.records[0].begin() + 992, 32, recovery.begin() + 224);
  const auto recovered = Exchange(parent, root, recovery, "recover");
  Code(recovered.result.error, ERROR_SUCCESS, "new session reads exact recorded resources");
  Check(!recovered.result.creation_attempted && recovered.result.receipt_acknowledged && recovered.records == created.records, "recovery does not resume creation");
  const auto wrong_finish = Exchange(parent, root, recovery, "wrong-finish");
  Check(wrong_finish.result.error == ERROR_SUCCESS && !wrong_finish.result.creation_attempted && wrong_finish.result.receipt_written &&
    !wrong_finish.result.receipt_acknowledged && wrong_finish.records == created.records, "wrong finish cannot claim receipt delivery or replay effects");
  for (const auto* mode : {"wrong-nonce", "wrong-header"}) {
    const auto bad_name = Name(); const auto invalid = Exchange(parent, root, Request(parent.identity, bad_name), mode);
    Check(invalid.result.error == ERROR_INVALID_DATA && !invalid.result.creation_attempted && invalid.records.empty() &&
      GetFileAttributesW((parent.path + L"\\" + bad_name + L".provisioning").c_str()) == INVALID_FILE_ATTRIBUTES, "wrong session or header creates no journal");
  }
  for (const auto* mode : {"wrong-ack", "wrong-sequence", "wrong-ack-nonce", "revoke"}) {
    const auto name = Name(); const auto stopped = Exchange(parent, root, Request(parent.identity, name), mode);
    Code(stopped.result.error, !std::strcmp(mode, "revoke") ? ERROR_ACCESS_DENIED : ERROR_INVALID_DATA, "refused acknowledgement stops provisioning");
    Check(stopped.records.size() == 1 && GetFileAttributesW((parent.path + L"\\" + name).c_str()) == INVALID_FILE_ATTRIBUTES,
      "unacknowledged prepared record never creates workspace");
    Handle file{CreateFileW((parent.path + L"\\" + name + L".provisioning").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr)};
    LARGE_INTEGER size{};
    Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart == 1024, "uncertain journal remains one exact record");
  }
}
}
int wmain(int count, wchar_t** arguments) {
  const bool workspace = count == 3 && !wcscmp(arguments[1], L"--mounted-workspace");
  if (count != 2 && !workspace) return 2;
  try {
    DecoderCases();
    if (workspace) {
      MountedWorkspaceActual(arguments[2]);
      std::printf("{\"checks\":%u,\"passed\":true,\"sessions\":%u,\"nativeClientSessions\":%u,\"controlledMountedWorkspaceCheckpoints\":2,\"mountedWorkspaceAuthorityChecks\":%u,\"installedService\":false,\"canonicalStorage\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"volumeRootProtected\":false,\"volumeMounted\":false}\n", checks.load(), sessions, native_client_sessions, workspace_authority_checks);
      return 0;
    }
    Actual(arguments[1]);
    std::printf("{\"checks\":%u,\"passed\":true,\"sessions\":%u,\"nativeClientSessions\":%u,\"creationCheckpoints\":5,\"recoveryCheckpoints\":5,\"controlledVolumeCheckpoints\":6,\"controlledFormatCheckpoints\":2,\"controlledProtectionCheckpoints\":2,\"controlledMountCheckpoints\":4,\"volumeAuthorityChecks\":%u,\"formatAuthorityChecks\":%u,\"protectionAuthorityChecks\":%u,\"mountAuthorityChecks\":%u,\"installedService\":false,\"canonicalStorage\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"volumeRootProtected\":false,\"volumeMounted\":false}\n", checks.load(), sessions, native_client_sessions, volume_authority_checks, format_authority_checks, protection_authority_checks, mount_authority_checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
