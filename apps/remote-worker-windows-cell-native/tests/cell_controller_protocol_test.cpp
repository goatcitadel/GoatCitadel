#include "cell_controller_protocol.hpp"
#include "cell_joined_capacity_wire.hpp"
#include "cell_pool_capacity.hpp"
#include "cell_install_capacity_pipe.hpp"
#include "cell_controller_client_protocol.hpp"
#include "cell_runtime_client_session.hpp"
#include "cell_runtime_result.hpp"
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
struct CellJoinedCapacityCollectorTestPeer final {
  template <typename Owner>
  static DWORD Capture(Owner& owner, const CellJoinedCapacityReference& reference, const CellFootprintScanGuard& authority,
    const CellFootprintCellBinding& binding, CellJoinedCapacityBytes* output) {
    return CellJoinedCapacityCollector::RunOwned({&owner, Owner::Matches, Owner::Verify, Owner::Capture}, reference, authority, binding, output);
  }
};
struct CellPoolCapacityCollectorTestPeer final {
  using JoinedObserver = CellPoolCapacityCollector::JoinedObserver;
  template <typename Owner>
  static DWORD CaptureRecorded(Owner& owner, CellProvisioningJournal& current, const CellControllerRequest& request,
    const CellControllerPoolHistory& pool, const CellRuntimePoolCleanupSet& cleanup, const CellFootprintScanGuard& guard, CellPoolJoinedCapacity* output) {
    CellCapacityLayout layout;
    return CellPoolCapacityCollector::RunRecorded({&owner, Owner::Open, Owner::Read, Owner::Installations, Owner::Runtime, Owner::Capture}, INVALID_HANDLE_VALUE,
      current, request, pool, cleanup, L"owner", L"controller", layout, {}, {}, guard, output);
  }
  template <typename Owner>
  static DWORD Capture(Owner& owner, const CellCapacityLayoutRecord& record, std::span<const CellPoolCapacityMember> members,
    const CellFootprintScanGuard& authority, CellPoolCapacity* output) {
    return CellPoolCapacityCollector::Run({&owner, Owner::Borrow, Owner::Scan}, record, members, {}, authority, output, nullptr);
  }
  template <typename Owner>
  static DWORD CaptureJoined(Owner& owner, const CellCapacityLayoutRecord& record, std::span<const CellPoolGuestMember> members,
    const CellFootprintScanGuard& authority, CellPoolJoinedCapacity* output) {
    return CellPoolCapacityCollector::RunJoined({&owner, Owner::Host, Owner::Guest, Owner::Check, Owner::Close},
      record, members, {}, authority, output);
  }
};
}
using namespace goatcitadel::worker_cell;
namespace {
// Keep stdout machine-readable; flushed stderr identifies the last case even
// when the enclosing process watchdog terminates a stalled fixture.
struct CaseTiming final {
  const char* kind;
  const char* mode;
  ULONGLONG started = GetTickCount64();
  CaseTiming(const char* kind_value, const char* mode_value) : kind(kind_value), mode(mode_value) {
    std::fprintf(stderr, "case begin %s %s\n", kind, mode);
    std::fflush(stderr);
  }
  ~CaseTiming() {
    std::fprintf(stderr, "case end %s %s elapsed_ms=%llu\n", kind, mode,
      static_cast<unsigned long long>(GetTickCount64() - started));
    std::fflush(stderr);
  }
};
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
void CapacityWireCases() {
  CellControllerNonce nonce{}; nonce.fill(0x11);
  CellProvisioningFootprint value;
  value.anchor.file.volume_serial = 0xfedcba9876543210ULL; value.anchor.file.file_id.fill(0xa1);
  value.anchor.prepared_sha256.fill(0xb2); value.assignment_binding.fill(0xc3); value.profile_sha256.fill(0xd4); value.checkpoint_sha256.fill(0xe5);
  value.workspace.parent.volume_serial = 0x8877665544332211ULL; value.workspace.parent.file_id.fill(0x90);
  for (std::size_t index = 0; index < 4; ++index) {
    value.workspace.directories[index].volume_serial = value.workspace.parent.volume_serial;
    value.workspace.directories[index].file_id.fill(static_cast<std::uint8_t>(0x91 + index));
  }
  value.footprint = {value.workspace.directories[0], 0x123456789abcULL, 4096, 7, 9};
  CellControllerCapacityBytes encoded{}, expected{};
  expected.fill(0x11); Put(expected.data() + 32, 0xfedcba9876543210ULL);
  std::fill(expected.begin() + 40, expected.begin() + 56, std::uint8_t{0xa1});
  std::fill(expected.begin() + 56, expected.begin() + 88, std::uint8_t{0xb2});
  std::fill(expected.begin() + 88, expected.begin() + 120, std::uint8_t{0xc3});
  std::fill(expected.begin() + 120, expected.begin() + 152, std::uint8_t{0xd4});
  std::fill(expected.begin() + 152, expected.begin() + 184, std::uint8_t{0xe5});
  for (std::size_t index = 0; index < 5; ++index) {
    Put(expected.data() + 184 + index * 24, 0x8877665544332211ULL);
    std::fill_n(expected.begin() + 192 + index * 24, 16, static_cast<std::uint8_t>(0x90 + index));
  }
  std::copy_n(expected.begin() + 208, 24, expected.begin() + 304);
  Put(expected.data() + 328, 0x123456789abcULL); Put(expected.data() + 336, 4096);
  Put(expected.data() + 344, 7, 4); Put(expected.data() + 348, 9, 4);
  Check(EncodeCellControllerCapacity(nonce, value, &encoded) && encoded == expected,
    "capacity codec matches an independently encoded full-width identity and sparse-byte observation");
  CellProvisioningFootprint decoded;
  Check(DecodeCellControllerCapacity(nonce, expected, &decoded) && decoded == value,
    "capacity decoder preserves exact journal, assignment, profile, root and independent usage fields");
  const auto reject = [&](auto change) {
    auto bytes = expected; change(bytes); decoded = value;
    Check(!DecodeCellControllerCapacity(nonce, bytes, &decoded) && decoded == CellProvisioningFootprint{},
      "invalid capacity frame clears every identity and count");
  };
  reject([](auto& bytes) { bytes[0] ^= 1; });
  for (const auto offset : {32U, 184U, 208U, 232U, 256U, 280U}) reject([&](auto& bytes) { Put(bytes.data() + offset, 0); });
  for (const auto offset : {40U, 192U, 216U, 240U, 264U, 288U}) reject([&](auto& bytes) { std::fill_n(bytes.begin() + offset, 16, std::uint8_t{0}); });
  for (const auto offset : {56U, 88U, 120U, 152U}) reject([&](auto& bytes) { std::fill_n(bytes.begin() + offset, 32, std::uint8_t{0}); });
  reject([](auto& bytes) { bytes[304] ^= 1; });
  reject([](auto& bytes) { bytes[232] ^= 1; });
  reject([](auto& bytes) { std::copy_n(bytes.begin() + 208, 24, bytes.begin() + 232); });
  reject([](auto& bytes) { std::copy_n(bytes.begin() + 184, 24, bytes.begin() + 208); });
  reject([](auto& bytes) { Put(bytes.data() + 328, 9007199254740992ULL); });
  reject([](auto& bytes) { Put(bytes.data() + 336, 9007199254740992ULL); });
  reject([](auto& bytes) { Put(bytes.data() + 344, 20000, 4); });
  reject([](auto& bytes) { Put(bytes.data() + 348, 3, 4); });
  reject([](auto& bytes) { Put(bytes.data() + 344, 0, 4); });
  Check(!EncodeCellControllerCapacity({}, value, &encoded) && encoded == CellControllerCapacityBytes{}, "empty capacity nonce cannot be encoded");
  Check(!EncodeCellControllerCapacity(nonce, value, nullptr) && !DecodeCellControllerCapacity(nonce, expected, nullptr), "null capacity codec outputs are refused");
}
void BackingCapacityWireCases() {
  CellControllerNonce nonce{}; nonce.fill(0x11);
  CellControllerBackingCapacityBytes expected{};
  std::copy(nonce.begin(), nonce.end(), expected.begin());
  const auto identity = [&](unsigned offset, std::uint8_t tag) {
    Put(expected.data() + offset, 0xfedcba9876543210ULL);
    std::fill_n(expected.begin() + offset + 8, 16, tag);
  };
  identity(32, 0xa1);
  for (const auto offset : {56U, 88U, 120U, 152U}) std::fill_n(expected.begin() + offset, 32, static_cast<std::uint8_t>(offset));
  for (unsigned index = 0; index < 5; ++index) identity(184 + index * 24, static_cast<std::uint8_t>(0x90 + index));
  std::fill_n(expected.begin() + 304, 16, std::uint8_t{0x22});
  Put(expected.data() + 320, 64ULL * 1024 * 1024); Put(expected.data() + 328, 128ULL * 1024 * 1024);
  std::copy_n(expected.begin() + 232, 24, expected.begin() + 336); identity(360, 0xa2);
  Put(expected.data() + 384, 66ULL * 1024 * 1024); Put(expected.data() + 392, 66ULL * 1024 * 1024);
  Put(expected.data() + 400, 21 * 1024); Put(expected.data() + 408, 24576); Put(expected.data() + 416, 66ULL * 1024 * 1024 + 24576);
  CellProvisioningBackingFootprint decoded;
  Check(DecodeCellControllerBackingCapacity(nonce, expected, &decoded) && decoded.workspace.parent.volume_serial == 0xfedcba9876543210ULL &&
    decoded.backing.file_bytes == 66ULL * 1024 * 1024 && decoded.journal_bytes == 21504 && decoded.host_file_allocated_bytes == 66ULL * 1024 * 1024 + 24576,
    "host capacity decodes independent fixed bytes and full-width identities without guest allocation");
  CellControllerBackingCapacityBytes encoded{};
  Check(EncodeCellControllerBackingCapacity(nonce, decoded, &encoded) && encoded == expected, "host capacity encoder preserves every independent wire field");
  const auto reject = [&](auto change) {
    auto bytes = expected; change(bytes);
    Check(!DecodeCellControllerBackingCapacity(nonce, bytes, &decoded) && !decoded.anchor.file.volume_serial && !decoded.backing.file_bytes &&
      !decoded.journal_bytes && !decoded.host_file_allocated_bytes, "invalid host capacity clears all output");
  };
  reject([](auto& bytes) { bytes[0] ^= 1; });
  for (const auto offset : {32U, 184U, 208U, 232U, 256U, 280U, 336U, 360U}) {
    reject([&](auto& bytes) { Put(bytes.data() + offset, 0); });
    reject([&](auto& bytes) { std::fill_n(bytes.begin() + offset + 8, 16, std::uint8_t{0}); });
  }
  for (const auto offset : {56U, 88U, 120U, 152U}) reject([&](auto& bytes) { std::fill_n(bytes.begin() + offset, 32, std::uint8_t{0}); });
  reject([](auto& bytes) { std::fill_n(bytes.begin() + 304, 16, std::uint8_t{0}); });
  for (const auto offset : {32U, 208U, 232U, 256U, 280U, 360U}) reject([&](auto& bytes) { bytes[offset] ^= 1; });
  for (const auto offset : {32U, 208U, 256U, 280U, 360U}) reject([&](auto& bytes) { std::copy_n(bytes.begin() + 184, 24, bytes.begin() + offset); });
  reject([](auto& bytes) { bytes[344] ^= 1; });
  reject([](auto& bytes) { Put(bytes.data() + 320, 1); });
  reject([](auto& bytes) { Put(bytes.data() + 328, 64ULL * 1024 * 1024); });
  reject([](auto& bytes) { Put(bytes.data() + 384, 63ULL * 1024 * 1024); });
  reject([](auto& bytes) { Put(bytes.data() + 392, 65ULL * 1024 * 1024); });
  reject([](auto& bytes) { Put(bytes.data() + 392, 129ULL * 1024 * 1024); });
  reject([](auto& bytes) { Put(bytes.data() + 400, 5 * 1024); });
  reject([](auto& bytes) { Put(bytes.data() + 408, 21503); });
  reject([](auto& bytes) { Put(bytes.data() + 408, 65537); });
  for (const auto offset : {320U, 328U, 384U, 392U, 400U, 408U, 416U}) reject([&](auto& bytes) { Put(bytes.data() + offset, 9007199254740992ULL); });
  reject([](auto& bytes) { bytes[416] ^= 1; });
  Check(!DecodeCellControllerBackingCapacity(nonce, expected, nullptr) && !EncodeCellControllerBackingCapacity(nonce, decoded, nullptr), "host capacity refuses null outputs");
  Check(DecodeCellControllerBackingCapacity(nonce, expected, &decoded) && !EncodeCellControllerBackingCapacity({}, decoded, &encoded) &&
    encoded == CellControllerBackingCapacityBytes{}, "host capacity refuses a missing nonce without leaving bytes");
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
  unsigned runtime_calls = 0, install_calls = 0;
  const char* mode = "";
  unsigned hold_calls = 0, hold_checks = 0, hold_releases = 0;
  struct Hold final : CellControllerMeasurementHold {
    Context& owner;
    explicit Hold(Context& value) : owner(value) {}
    ~Hold() override { ++owner.hold_releases; }
    DWORD Verify() noexcept override {
      ++owner.hold_checks;
      return !std::strcmp(owner.mode, "native-install-revoked-hold") ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  };
  static DWORD BeginHold(void* raw, const CellControllerRequest& request, HANDLE, ULONGLONG,
      std::unique_ptr<CellControllerMeasurementHold>* output) noexcept {
    auto& self = *static_cast<Context*>(raw); ++self.hold_calls;
    if (request.operation != kCellControllerInstallOperation) return ERROR_INVALID_PARAMETER;
    if (!std::strcmp(self.mode, "native-install-denied-hold")) return ERROR_LOCK_VIOLATION;
    if (!std::strcmp(self.mode, "native-install-null-hold")) return ERROR_SUCCESS;
    try { *output = std::make_unique<Hold>(self); return ERROR_SUCCESS; }
    catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static RuntimeBundleInstallResult Install(void* raw, CellProvisioningJournal&, std::span<const std::uint8_t>,
      const CellRuntimeInstallBinding&, DWORD, const CellFootprintScanGuard&) noexcept {
    ++static_cast<Context*>(raw)->install_calls;
    RuntimeBundleInstallResult result; result.error = ERROR_NOT_SUPPORTED; return result;
  }
  static CellRuntimeSessionResult Runtime(void* raw, HANDLE, HANDLE, ULONGLONG, CellProvisioningJournal&,
    const CellControllerRuntimeBinding&) noexcept {
    auto& self = *static_cast<Context*>(raw); ++self.runtime_calls; CellRuntimeSessionResult result;
    result.error = ERROR_NOT_SUPPORTED;
    return result;
  }
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
struct Outcome final { CellControllerSessionResult result; std::vector<CellProvisioningRecord> records; DWORD client_error = 0; unsigned volume_checks = 0, server_runtime_calls = 0, client_runtime_calls = 0, server_install_calls = 0, hold_calls = 0, hold_checks = 0, hold_releases = 0; };
struct NativeClient final {
  CellPipeServerEvidence server;
  std::wstring root;
  unsigned sequence;
  Outcome& outcome;
  HANDLE stop;
  const char* mode;
  bool revoked = false, received = false;
  std::array<std::uint8_t, 16> receipt{};
  const std::vector<CellProvisioningRecord>* retained = nullptr;
  CellControllerRequest* mutable_request = nullptr;
  CellControllerClientOwner* mutable_owner = nullptr;
  unsigned capacity_calls = 0;
  unsigned installation_calls = 0;
  unsigned installation_outcomes = 0;
  CellRuntimeInstallBinding installation_expected;
  unsigned connections = 0;
  static DWORD Connected(void* raw, const CellControllerNonce& nonce) noexcept {
    auto& self = *static_cast<NativeClient*>(raw);
    if (++self.connections != 1 || !self.outcome.records.empty() || self.installation_calls ||
        std::none_of(nonce.begin(), nonce.end(), [](auto byte) { return byte != 0; })) return ERROR_INVALID_DATA;
    return Authorize(raw);
  }
  unsigned install_capacity_mode = 0, install_reserves = 0, install_verifies = 0, install_releases = 0;
  struct InstallReservation final : CellInstallCapacityReservation {
    NativeClient& client;
    explicit InstallReservation(NativeClient& value) : client(value) {}
    ~InstallReservation() override { ++client.install_releases; }
    DWORD Verify() noexcept override { ++client.install_verifies; return ERROR_SUCCESS; }
  };
  static DWORD ReserveInstall(void* raw, std::span<const std::uint8_t> bytes, const CellInstallCapacityBinding& binding,
      ULONGLONG deadline, std::unique_ptr<CellInstallCapacityReservation>* output) noexcept {
    auto& self = *static_cast<NativeClient*>(raw); ++self.install_reserves;
    // Controlled admission for reply-loop/lifetime proof only. Complete pool
    // decoding and canonical accounting have separate multi-member fixtures.
    if (bytes.size() != 1312 || bytes.back() != 0xab || binding.byte_length != bytes.size() ||
        binding.installation.nonce != self.installation_expected.nonce ||
        binding.installation.request_sha256 != self.installation_expected.request_sha256 ||
        deadline <= GetTickCount64() || self.install_reserves != 1) return ERROR_INVALID_DATA;
    if (self.install_capacity_mode == 3) return ERROR_ACCESS_DENIED;
    try { *output = std::make_unique<InstallReservation>(self); return ERROR_SUCCESS; }
    catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Installation(void* raw, const CellRuntimeInstallRequest& request, std::uint32_t ordinal) noexcept {
    auto& self = *static_cast<NativeClient*>(raw);
    if (request.binding.nonce != self.installation_expected.nonce || request.binding.request_sha256 != self.installation_expected.request_sha256 ||
        ordinal != ++self.installation_calls || !self.retained || self.outcome.records != *self.retained) return ERROR_INVALID_DATA;
    return !std::strcmp(self.mode, "installation-denied") ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD InstallationOutcome(void* raw, const std::array<std::uint8_t, 352>& bytes) noexcept {
    auto& self = *static_cast<NativeClient*>(raw); ++self.installation_outcomes;
    // Controlled validation owner here; native-written cryptographic records are
    // independently covered by the local-outcome cross-language fixture.
    if (self.installation_calls != 2 || bytes[320] != 0x99) return ERROR_INVALID_DATA;
    return !std::strcmp(self.mode, "installation-outcome-denied") ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static CellRuntimeClientSessionResult Runtime(void* raw, HANDLE, HANDLE, ULONGLONG deadline, const CellControllerRuntimeBinding& binding) noexcept {
    auto& self = *static_cast<NativeClient*>(raw); ++self.outcome.client_runtime_calls; CellRuntimeClientSessionResult result;
    if (self.outcome.records.size() != 21 || self.outcome.volume_checks != 1 || GetTickCount64() >= deadline ||
        !std::equal(binding.checkpoint_sha256.begin(), binding.checkpoint_sha256.end(), self.outcome.records.back().begin() + 992)) {
      result.error = ERROR_INVALID_DATA; return result;
    }
    result.request_acknowledged = result.input_ended = result.output_ended = result.result_received = result.retention_attempted = true;
    result.retention_confirmed = result.retention_receipt_sent = std::strcmp(self.mode, "native-runtime-client-unretained") != 0;
    result.execution.binding_verified = true; result.execution.binding = {binding.nonce, binding.request_sha256};
    if (!std::strcmp(self.mode, "runtime-other-result")) result.execution.binding.request_sha256[0] ^= 1;
    return result;
  }
  CellProvisioningFootprint capacity;
  CellProvisioningBackingFootprint backing_capacity;
  CellProvisioningInventory inventory;
  static DWORD Authorize(void* pointer) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    if (client.mutable_request) {
      *client.mutable_request = {}; client.mutable_request = nullptr;
      *client.mutable_owner = {}; client.mutable_owner = nullptr;
    }
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
    if (client.install_capacity_mode && (client.install_reserves != 1 || client.install_verifies != 2 || client.install_releases))
      return ERROR_INVALID_STATE;
    if (client.install_capacity_mode == 6) return ERROR_ACCESS_DENIED;
    if (client.received) return ERROR_INVALID_DATA;
    client.received = true; client.receipt = bytes; return ERROR_SUCCESS;
  }
  static DWORD PoolCapacity(void* pointer, const CellControllerNonce& nonce, std::span<const std::uint8_t> bytes) noexcept {
    if (bytes.size() < 1312 || std::memcmp(bytes.data(), "GCPRESP1", 8) ||
        !std::equal(nonce.begin(), nonce.end(), bytes.begin() + 24)) return ERROR_INVALID_DATA;
    return Capacity(pointer, nonce, {});
  }
  static DWORD Capacity(void* pointer, const CellControllerNonce& nonce, const CellProvisioningFootprint& observation) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    if (client.received || client.capacity_calls || client.outcome.records.size() != 21 || !client.outcome.volume_checks ||
        std::all_of(nonce.begin(), nonce.end(), [](auto byte) { return byte == 0; })) return ERROR_INVALID_DATA;
    ++client.capacity_calls; client.capacity = observation;
    if (!std::strcmp(client.mode, "capacity-callback-error")) return ERROR_WRITE_FAULT;
    if (!std::strcmp(client.mode, "capacity-callback-revoke")) client.revoked = true;
    return ERROR_SUCCESS;
  }
  static DWORD BackingCapacity(void* pointer, const CellControllerNonce& nonce, const CellProvisioningBackingFootprint& observation) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    if (client.received || client.capacity_calls || client.outcome.records.size() != 21 || !client.outcome.volume_checks ||
        std::all_of(nonce.begin(), nonce.end(), [](auto byte) { return byte == 0; })) return ERROR_INVALID_DATA;
    ++client.capacity_calls; client.backing_capacity = observation;
    if (!std::strcmp(client.mode, "capacity-callback-error")) return ERROR_WRITE_FAULT;
    if (!std::strcmp(client.mode, "capacity-callback-revoke")) client.revoked = true;
    return ERROR_SUCCESS;
  }
  static DWORD Inventory(void* pointer, const CellControllerNonce& nonce, const CellProvisioningInventory& observation) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    if (client.received || client.capacity_calls || client.outcome.records.size() != 21 || !client.outcome.volume_checks ||
        std::all_of(nonce.begin(), nonce.end(), [](auto byte) { return byte == 0; })) return ERROR_INVALID_DATA;
    try { client.inventory = observation; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
    ++client.capacity_calls;
    if (!std::strcmp(client.mode, "capacity-callback-error")) return ERROR_WRITE_FAULT;
    if (!std::strcmp(client.mode, "capacity-callback-revoke")) client.revoked = true;
    return ERROR_SUCCESS;
  }
  static DWORD VolumeAuthority(void* pointer, std::uint32_t ordinal, std::uint32_t count, const CellFileSha256& head) noexcept {
    auto& client = *static_cast<NativeClient*>(pointer);
    try {
      Check(ordinal == ++client.outcome.volume_checks && count == client.outcome.records.size() && count >= 5 && count <= 21 &&
        std::equal(head.begin(), head.end(), client.outcome.records.back().begin() + 992), "authority binds the exact retained checkpoint count and head");
      if (client.retained) {
        Check(count == 21 && client.outcome.records == *client.retained, "read-only capacity authority compares the independently retained complete history without write acknowledgements");
        return !std::strcmp(client.mode, "capacity-denied") || !std::strcmp(client.mode, "runtime-denied") ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
      }
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
void PopulateCleanup(CellControllerRequest& request, const std::wstring& sid) {
  if (!IsCellControllerCapacity(request.operation)) return;
  auto& bytes = request.cleanup_bytes; bytes.assign(252, 0);
  std::memcpy(bytes.data(), "GCCLEAN1", 8); std::fill_n(bytes.begin() + 8, 32, std::uint8_t{0xcc});
  Put(bytes.data() + 40, request.anchor.file.volume_serial);
  std::copy(request.anchor.file.file_id.begin(), request.anchor.file.file_id.end(), bytes.begin() + 48);
  std::copy(request.anchor.prepared_sha256.begin(), request.anchor.prepared_sha256.end(), bytes.begin() + 64);
  std::copy_n(request.mounted_workspace_records.back().begin() + 992, 32, bytes.begin() + 96);
  std::copy_n(request.mounted_workspace_records.back().begin() + 432, 120, bytes.begin() + 128);
  CellFileSha256 hash{}; Code(HashCellRuntimeCleanup(bytes, &hash), ERROR_SUCCESS, "hash controlled empty cleanup set");
  auto& admission = request.cleanup_admission; admission.fill(0);
  std::memcpy(admission.data(), "GCCADM01", 8); std::copy_n(bytes.begin() + 8, 32, admission.begin() + 8);
  std::copy(hash.begin(), hash.end(), admission.begin() + 40);
  Wire encoded{};
  auto pool_member = request;
  if (IsCellControllerInstallCapacity(request.operation)) {
    pool_member.operation = kCellControllerPoolCapacityOperation;
    pool_member.installation = {}; pool_member.installation_bytes = {};
    request.capture_nonce.fill(0x44);
    request.references_sha256.fill(0x55);
  }
  Check(EncodeCellControllerRequest(pool_member, &encoded, sid, sid), "encode controlled pool request");
  auto& pool = request.pool_history;
  pool.assign(kCellControllerPoolHeaderBytes + kCellControllerPoolMemberBytes, 0);
  std::memcpy(pool.data(), "GCPPOOL1", 8); Put(pool.data() + 8, 1, 4); Put(pool.data() + 12, 1, 4);
  std::fill_n(pool.begin() + 48, 32, std::uint8_t{0xbb});
  std::copy(request.plan.assignment_binding.begin(), request.plan.assignment_binding.end(), pool.begin() + 80);
  std::copy_n(encoded.begin() + 176, 24, pool.begin() + 112);
  std::fill(encoded.begin() + 8, encoded.begin() + 40, std::uint8_t{0});
  std::copy(encoded.begin(), encoded.end(), pool.begin() + kCellControllerPoolHeaderBytes);
  auto offset = kCellControllerPoolHeaderBytes + encoded.size();
  const auto append = [&](const auto& records) { for (const auto& record : records) {
    std::copy(record.begin(), record.end(), pool.begin() + offset); offset += record.size();
  } };
  append(request.creation_records); append(request.volume_records); append(request.format_records);
  append(request.protection_records); append(request.mount_records); append(request.mounted_workspace_records);
  auto& cleanup = request.pool_cleanup;
  cleanup.assign(80 + 40 + 80 + request.cleanup_bytes.size(), 0);
  std::memcpy(cleanup.data(), "GCPCLN01", 8); Put(cleanup.data() + 8, 1); Put(cleanup.data() + 12, 1);
  std::copy_n(pool.begin() + 48, 32, cleanup.begin() + 16);
  std::fill_n(cleanup.begin() + 48, 32, std::uint8_t{0xdd});
  std::copy(request.plan.assignment_binding.begin(), request.plan.assignment_binding.end(), cleanup.begin() + 80);
  Put(cleanup.data() + 112, 80); Put(cleanup.data() + 116, request.cleanup_bytes.size());
  std::copy_n(admission.begin(), 80, cleanup.begin() + 120);
  std::copy(bytes.begin(), bytes.end(), cleanup.begin() + 200);
}
Outcome Exchange(const Parent& parent, const std::wstring& root, Wire request, const char* mode,
  const std::array<CellVolumeProvisioningRecord, 6>* volume_history = nullptr,
  const std::array<CellFormatProvisioningRecord, 2>* format_history = nullptr,
  const std::array<CellProtectionProvisioningRecord, 2>* protection_history = nullptr,
  const std::array<CellProvisioningRecord, 5>* creation_history = nullptr,
  const std::array<CellMountProvisioningRecord, 4>* mount_history = nullptr,
  const std::array<CellMountedWorkspaceProvisioningRecord, 2>* workspace_history = nullptr,
  const CellControllerRuntimeBinding* runtime_binding = nullptr,
  const CellControllerRequest* installation = nullptr) {
  const CaseTiming timing("exchange", mode);
  const auto sequence = ++sessions;
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCellProtocolTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value, "new local session fixture");
  Context context{server.value};
  context.mode = mode;
  CellControllerSessionOwner owner{parent.path, parent.user, parent.user, parent.identity, &context, Context::Authorize, Context::Arm};
  if (runtime_binding && std::strcmp(mode, "native-runtime-missing-owner")) owner.run_runtime = Context::Runtime;
  if (installation && std::strcmp(mode, "native-install-no-owner")) owner.install_runtime = Context::Install;
  if (installation && std::strcmp(mode, "native-install-missing-hold")) owner.begin_measurement = Context::BeginHold;
  if (!std::strcmp(mode, "native-capacity-missing-hold")) owner.observe_capacity =
    [](void*, CellProvisioningJournal&, const CellProvisioningAnchor&, const CellFileSha256&,
      const CellFootprintScanLimits&, const CellFootprintScanGuard&, CellProvisioningFootprint*) noexcept -> DWORD { return ERROR_GEN_FAILURE; };
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
    PopulateCleanup(decoded, parent.user);
    if (runtime_binding) decoded.runtime = *runtime_binding;
    if (installation) {
      decoded.installation = installation->installation; decoded.installation_bytes = installation->installation_bytes;
      context_client.installation_expected = {decoded.installation.nonce, decoded.installation.request_sha256};
    }
    std::vector<CellProvisioningRecord> runtime_history;
    if (runtime_binding || installation) {
      const auto append = [&](const auto& rows) { runtime_history.insert(runtime_history.end(), rows.begin(), rows.end()); };
      append(decoded.creation_records); append(decoded.volume_records); append(decoded.format_records); append(decoded.protection_records);
      append(decoded.mount_records); append(decoded.mounted_workspace_records); context_client.retained = &runtime_history;
    }
    CellControllerClientOwner native{&context_client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
    native.owner_sid = parent.user; native.controller_sid = parent.user;
    native.capacity = NativeClient::Capacity;
    native.backing_capacity = NativeClient::BackingCapacity;
    native.inventory = NativeClient::Inventory;
    if (installation) { native.installation_authority = NativeClient::Installation; native.installation_outcome = NativeClient::InstallationOutcome; }
    if (IsCellControllerInstallCapacity(decoded.operation)) {
      native.connection = NativeClient::Connected;
      native.installation_capacity = {&context_client, NativeClient::ReserveInstall};
    }
    if (runtime_binding && std::strcmp(mode, "native-runtime-client-missing-owner")) native.run_runtime = NativeClient::Runtime;
    outcome.client_error = RunCellControllerClientSession(client.value, stop.value,
      GetTickCount64() + (!std::strcmp(mode, "native-runtime-long-owner") ? decoded.wall_ms : !std::strcmp(mode, "native-timeout") ? 400 : 8000), decoded, native);
    context_client.server.Close(); client.Close();
    thread.join();
    outcome.server_runtime_calls = context.runtime_calls;
    outcome.server_install_calls = context.install_calls;
    outcome.hold_calls = context.hold_calls; outcome.hold_checks = context.hold_checks; outcome.hold_releases = context.hold_releases;
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
        } else if (!std::strcmp(mode, "runtime-authority")) {
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::runtime_authority, reply.data(), 104, stop.value, deadline),
            ERROR_SUCCESS, "runtime authority is a distinct known frame outside the provisioning client protocol");
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
CellProvisioningFootprint CapacityFromHistory(const std::vector<CellProvisioningRecord>& records) {
  Check(records.size() == 21, "capacity fixture requires independently retained complete native history");
  const auto identity = [](const std::uint8_t* bytes) {
    CellFileIdentity value; std::memcpy(&value.volume_serial, bytes, 8); std::copy_n(bytes + 8, 16, value.file_id.begin()); return value;
  };
  CellProvisioningFootprint value;
  value.anchor.file = identity(records.front().data() + 168);
  std::copy_n(records.front().begin() + 992, 32, value.anchor.prepared_sha256.begin());
  std::copy_n(records.front().begin() + 48, 32, value.assignment_binding.begin());
  std::copy_n(records.front().begin() + 80, 32, value.profile_sha256.begin());
  std::copy_n(records.back().begin() + 992, 32, value.checkpoint_sha256.begin());
  value.workspace.parent = identity(records.back().data() + 432);
  for (std::size_t index = 0; index < 4; ++index) value.workspace.directories[index] = identity(records.back().data() + 456 + index * 24);
  value.footprint = {value.workspace.directories[0], 0x200000005ULL, 4096, 7, 9};
  return value;
}
CellProvisioningInventory InventoryFromHistory(const std::vector<CellProvisioningRecord>& records) {
  const auto summary = CapacityFromHistory(records);
  CellProvisioningInventory value{summary.anchor, summary.assignment_binding, summary.profile_sha256,
    summary.checkpoint_sha256, summary.workspace, {{summary.footprint.root, 0x200000005ULL, 22 * 4096, 22, 4}, {}}};
  for (const auto& root : summary.workspace.directories) value.inventory.entries.push_back({root, true, 0, 0});
  for (unsigned index = 0; index < 22; ++index) {
    CellFileIdentity file; file.volume_serial = summary.footprint.root.volume_serial;
    file.file_id.fill(0xf0); file.file_id.back() = static_cast<std::uint8_t>(index + 1);
    value.inventory.entries.push_back({file, false, index ? 0 : 0x200000005ULL, 4096});
  }
  std::sort(value.inventory.entries.begin(), value.inventory.entries.end(), [](const auto& a, const auto& b) { return a.identity.file_id < b.identity.file_id; });
  Check(ValidateCellControllerInventory(value), "controlled inventory has recorded roots and exact sparse/zero-byte object totals");
  return value;
}
CellProvisioningBackingFootprint BackingCapacityFromHistory(const std::vector<CellProvisioningRecord>& records) {
  const auto mounted = CapacityFromHistory(records);
  const auto identity = [](const std::uint8_t* bytes) {
    CellFileIdentity value; std::memcpy(&value.volume_serial, bytes, 8); std::copy_n(bytes + 8, 16, value.file_id.begin()); return value;
  };
  CellProvisioningBackingFootprint value;
  value.anchor = mounted.anchor; value.assignment_binding = mounted.assignment_binding;
  value.profile_sha256 = mounted.profile_sha256; value.checkpoint_sha256 = mounted.checkpoint_sha256;
  value.workspace.parent = identity(records[0].data() + 144);
  for (std::size_t index = 0; index < 4; ++index) value.workspace.directories[index] = identity(records[4].data() + 600 + index * 24);
  std::memcpy(&value.backing.record.spec.identifier, records[0].data() + 112, 16);
  std::memcpy(&value.backing.record.spec.virtual_bytes, records[0].data() + 128, 8);
  std::memcpy(&value.backing.record.spec.reserved_file_bytes, records[0].data() + 136, 8);
  value.backing.record.control = value.workspace.directories[1]; value.backing.record.backing = identity(records[4].data() + 696);
  value.backing.file_bytes = value.backing.allocated_bytes = value.backing.record.spec.virtual_bytes + 2 * 1024 * 1024;
  value.journal_bytes = 21504; value.journal_allocated_bytes = 24576; value.host_file_allocated_bytes = value.backing.allocated_bytes + value.journal_allocated_bytes;
  return value;
}
std::vector<std::uint8_t> PoolResponseFixture(const Wire& wire, const std::vector<CellProvisioningRecord>& records,
  const CellControllerNonce& nonce, const std::wstring& sid) {
  CellControllerNonce original{}; original.fill(0x11); CellControllerRequest request;
  Check(DecodeCellControllerRequest(wire, original, &request) && records.size() == 21, "decode full-pool session fixture");
  request.operation = kCellControllerPoolCapacityOperation; request.nonce = nonce; request.capture_nonce.fill(0x44);
  request.anchor.file.volume_serial = request.parent.volume_serial;
  std::copy_n(records[0].begin() + 176, 16, request.anchor.file.file_id.begin());
  std::copy_n(records[0].begin() + 992, 32, request.anchor.prepared_sha256.begin());
  std::copy_n(records.begin(), 5, request.creation_records.begin()); std::copy_n(records.begin() + 5, 6, request.volume_records.begin());
  std::copy_n(records.begin() + 11, 2, request.format_records.begin()); std::copy_n(records.begin() + 13, 2, request.protection_records.begin());
  std::copy_n(records.begin() + 15, 4, request.mount_records.begin()); std::copy_n(records.begin() + 19, 2, request.mounted_workspace_records.begin());
  PopulateCleanup(request, sid);
  CellCapacityLayoutRecord layout{request.plan.assignment_binding, request.plan.profile_sha256, {}};
  CellPoolJoinedCapacity observation;
  for (std::size_t i = 0; i < layout.roots.size(); ++i) {
    auto& identity = layout.roots[i]; identity.volume_serial = request.parent.volume_serial;
    identity.file_id.fill(0xcf); identity.file_id.back() = static_cast<std::uint8_t>(i);
    if (!i) identity = request.parent;
    observation.host.areas[i].entries.push_back({identity, true, 0, 4096});
  }
  const auto backing = BackingCapacityFromHistory(records);
  for (const auto& identity : backing.workspace.directories) observation.host.areas[0].entries.push_back({identity, true, 0, 4096});
  observation.host.areas[0].entries.push_back({backing.anchor.file, false, backing.journal_bytes, backing.journal_allocated_bytes});
  observation.host.areas[0].entries.push_back({backing.backing.record.backing, false, backing.backing.file_bytes, backing.backing.allocated_bytes});
  observation.host.backings.push_back(backing); observation.guests.push_back(InventoryFromHistory(records));
  for (std::size_t i = 0; i < layout.roots.size(); ++i) {
    auto& area = observation.host.areas[i]; area.footprint.root = layout.roots[i];
    std::sort(area.entries.begin(), area.entries.end(), [](const auto& a, const auto& b) { return a.identity.file_id < b.identity.file_id; });
    for (const auto& entry : area.entries) {
      area.footprint.logical_file_bytes += entry.logical_file_bytes; area.footprint.allocated_bytes += entry.allocated_bytes;
      if (entry.directory) ++area.footprint.directory_count; else ++area.footprint.file_count;
    }
  }
  std::vector<std::uint8_t> response;
  Code(EncodeCellPoolCapacityResponse(request, sid, sid, layout, request.capture_nonce, observation, &response), ERROR_SUCCESS, "encode valid full-pool client fixture");
  return response;
}
void VolumeReply(const std::wstring& root, const Wire& wire, const std::vector<CellProvisioningRecord>& records, const char* mode,
  const std::wstring& owner_sid = {}, bool backing_capacity = false, bool inventory = false, bool pool_capacity = false) {
  const CaseTiming timing("volume-reply", mode);
  const auto sequence = ++sessions; ++native_client_sessions;
  const bool capacity = !std::strncmp(mode, "capacity-", 9);
  const bool recover = capacity || !std::strncmp(mode, "recover", 7);
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
      if (capacity) Check(U32(requested.data()) == (pool_capacity ? kCellControllerPoolCapacityOperation : inventory ? kCellControllerInventoryOperation : backing_capacity ? kCellControllerBackingCapacityOperation : kCellControllerCapacityOperation), "capacity uses the read-only operation even if caller input changes");
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
      CellRuntimeCleanupAdmission cleanup;
      if (capacity) {
        std::array<std::uint8_t, 32 + kCellControllerPoolHeaderBytes> pool_header{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::pool_history_header, pool_header.data(), static_cast<DWORD>(pool_header.size()), stop.value, deadline), ERROR_SUCCESS, "receive bounded pool header");
        Check(std::equal(nonce.begin(), nonce.end(), pool_header.begin()) && U32(pool_header.data() + 40) == 1, "pool header binds nonce and complete member count");
        std::array<std::uint8_t, 32 + kCellControllerPoolMemberFirstBytes> pool_member{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::pool_history_member, pool_member.data(), static_cast<DWORD>(pool_member.size()), stop.value, deadline), ERROR_SUCCESS, "receive complete pool member");
        Check(std::equal(nonce.begin(), nonce.end(), pool_member.begin()), "pool member binds current nonce");
        std::array<std::uint8_t, 32 + kCellControllerPoolMemberBytes - kCellControllerPoolMemberFirstBytes> pool_tail{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::pool_history_member_tail, pool_tail.data(), static_cast<DWORD>(pool_tail.size()), stop.value, deadline), ERROR_SUCCESS, "receive bounded pool member tail");
        Check(std::equal(nonce.begin(), nonce.end(), pool_tail.begin()), "pool tail binds current nonce");
        std::array<std::uint8_t, 448> admission{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::cleanup_admission, admission.data(), static_cast<DWORD>(admission.size()), stop.value, deadline), ERROR_SUCCESS, "read cleanup primary admission before replay");
        Check(std::equal(nonce.begin(), nonce.end(), admission.begin()), "cleanup admission binds this connection");
        Code(DecodeCellRuntimeCleanupAdmission(std::span(admission).subspan(32, 80), &cleanup), ERROR_SUCCESS, "decode controlled cleanup admission");
        std::array<std::uint8_t, 36> cleanup_size{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::pool_cleanup_size, cleanup_size.data(), static_cast<DWORD>(cleanup_size.size()), stop.value, deadline), ERROR_SUCCESS, "read pool cleanup byte count");
        Check(std::equal(nonce.begin(), nonce.end(), cleanup_size.begin()) && U32(cleanup_size.data() + 32) == 452,
          "pool cleanup size binds this connection and entire empty set");
        std::array<std::uint8_t, 36 + 452> cleanup_chunk{};
        Code(ReadCellControllerMessage(server.value, CellControllerMessage::pool_cleanup_chunk, cleanup_chunk.data(), static_cast<DWORD>(cleanup_chunk.size()), stop.value, deadline), ERROR_SUCCESS, "read complete pool cleanup chunk");
        Check(std::equal(nonce.begin(), nonce.end(), cleanup_chunk.begin()) && U32(cleanup_chunk.data() + 32) == 0 &&
          std::memcmp(cleanup_chunk.data() + 36, "GCPCLN01", 8) == 0, "pool cleanup chunk binds nonce offset and container");
        if (pool_capacity) {
          std::array<std::uint8_t, 64> binding{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::pool_capture_binding, binding.data(), 64, stop.value, deadline), ERROR_SUCCESS, "read independent capture nonce");
          Check(std::equal(nonce.begin(), nonce.end(), binding.begin()) && std::all_of(binding.begin() + 32, binding.end(), [](auto byte) { return byte == 0x44; }), "capture nonce bound to connection");
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
      const auto capacityFrame = [&]() {
        if (pool_capacity) {
          const auto response = PoolResponseFixture(wire, records, nonce, owner_sid);
          std::array<std::uint8_t, 64> ready{}; std::copy(nonce.begin(), nonce.end(), ready.begin()); std::fill_n(ready.begin() + 32, 32, std::uint8_t{0x44});
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::pool_capacity_ready, ready.data(), 64, stop.value, deadline), ERROR_SUCCESS, "full-pool response follows cleanup");
          Code(WriteCellPoolCapacityResponse(server.value, deadline, nonce, {[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, stop.value}, response), ERROR_SUCCESS, "send complete pool response");
          if (std::strcmp(mode, "capacity-pool-no-final-authority")) challenge(maximum);
          return;
        }
        std::vector<std::uint8_t> bytes;
        const bool send_backing = !std::strcmp(mode, "capacity-wrong-kind") ? !backing_capacity : backing_capacity;
        if (send_backing) {
          CellControllerBackingCapacityBytes encoded{};
          Check(EncodeCellControllerBackingCapacity(nonce, BackingCapacityFromHistory(records), &encoded), "encode bound controlled host capacity reply");
          bytes.assign(encoded.begin(), encoded.end());
        } else {
          CellControllerCapacityBytes encoded{};
          auto summary = CapacityFromHistory(records);
          if (inventory) summary.footprint = InventoryFromHistory(records).inventory.footprint;
          Check(EncodeCellControllerCapacity(nonce, summary, &encoded), "encode bound controlled capacity reply");
          bytes.assign(encoded.begin(), encoded.end());
        }
        if (!std::strcmp(mode, "capacity-nonce")) bytes[0] ^= 1;
        if (!std::strcmp(mode, "capacity-assignment")) bytes[88] ^= 1;
        if (!std::strcmp(mode, "capacity-profile")) bytes[120] ^= 1;
        if (!std::strcmp(mode, "capacity-head")) bytes[152] ^= 1;
        if (!std::strcmp(mode, "capacity-root")) { bytes[216] ^= 1; if (!send_backing) bytes[312] ^= 1; }
        Code(WriteCellControllerMessage(server.value, send_backing ? CellControllerMessage::backing_capacity_observation :
          inventory ? CellControllerMessage::inventory_observation : CellControllerMessage::capacity_observation, bytes.data(), static_cast<DWORD>(bytes.size()), stop.value, deadline),
          ERROR_SUCCESS, "send fixed bound capacity observation");
        if (inventory && !send_backing) {
          auto value = InventoryFromHistory(records);
          if (!std::strcmp(mode, "capacity-chunk-identity")) value.inventory.entries[20].identity = value.inventory.entries[0].identity;
          if (!std::strcmp(mode, "capacity-chunk-totals")) ++value.inventory.entries.back().allocated_bytes;
          if (!std::strcmp(mode, "capacity-chunk-root")) {
            auto root_entry = std::find_if(value.inventory.entries.begin(), value.inventory.entries.end(), [](const auto& entry) { return entry.directory; });
            root_entry->identity.file_id.back() ^= 0x40;
          }
          for (std::uint32_t start = 0; start < value.inventory.entries.size(); start += 20) {
            if (start && !std::strcmp(mode, "capacity-chunk-missing")) break;
            const auto selected = !std::strcmp(mode, "capacity-chunk-duplicate") ? 0u :
              !std::strcmp(mode, "capacity-chunk-order") ? 20u - start : start;
            CellControllerInventoryChunkBytes chunk{};
            Check(EncodeCellControllerInventoryChunk(nonce, selected, std::span(value.inventory.entries).subspan(selected,
              std::min<std::size_t>(20, value.inventory.entries.size() - selected)), &chunk), "encode indexed controlled inventory batch");
            if (!std::strcmp(mode, "capacity-chunk-nonce")) chunk[0] ^= 1;
            if (start && !std::strcmp(mode, "capacity-chunk-padding")) chunk.back() = 1;
            if (!std::strcmp(mode, "capacity-chunk-count")) Put(chunk.data() + 36, 21, 4);
            if (!std::strcmp(mode, "capacity-chunk-zero")) Put(chunk.data() + 36, 0, 4);
            if (!std::strcmp(mode, "capacity-chunk-index")) Put(chunk.data() + 32, 1, 4);
            Code(WriteCellControllerMessage(server.value, CellControllerMessage::inventory_chunk, chunk.data(), static_cast<DWORD>(chunk.size()), stop.value, deadline),
              ERROR_SUCCESS, "send bounded inventory batch");
          }
          if (!std::strcmp(mode, "capacity-chunk-extra")) {
            CellControllerInventoryChunkBytes chunk{};
            Check(EncodeCellControllerInventoryChunk(nonce, 0, std::span(value.inventory.entries).first(20), &chunk), "encode unwanted repeated batch");
            Code(WriteCellControllerMessage(server.value, CellControllerMessage::inventory_chunk, chunk.data(), static_cast<DWORD>(chunk.size()), stop.value, deadline),
              ERROR_SUCCESS, "send excess batch after complete inventory");
          }
        }
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
        if (i == 18 && !std::strcmp(mode, "capacity-early")) { capacityFrame(); faulty = true; break; }
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
      if (!std::strcmp(mode, "recover-capacity")) { capacityFrame(); faulty = true; }
      if (capacity && !faulty) {
        const bool unavailable = !std::strcmp(mode, "capacity-unavailable");
        if (!unavailable && std::strcmp(mode, "capacity-no-authority")) {
          const char* corruption = !std::strncmp(mode, "capacity-authority-", 19) ? mode + 19 :
            !std::strcmp(mode, "capacity-denied") ? "denied" : "";
          challenge(maximum, corruption);
          if (*corruption) faulty = true;
        }
        if (!faulty && !unavailable && std::strcmp(mode, "capacity-no-authority") && std::strcmp(mode, "capacity-cleanup-missing")) {
          CellControllerRuntimeBindingBytes ready{};
          CellFileSha256 head{}; std::copy_n(records.back().begin() + 992, 32, head.begin());
          Check(EncodeCellControllerRuntimeBinding(nonce, {cleanup.binding.challenge, cleanup.binding.set_sha256, head}, &ready), "encode cleanup phase binding");
          const bool invalid_cleanup = !std::strcmp(mode, "capacity-cleanup-nonce") || !std::strcmp(mode, "capacity-cleanup-binding") || !std::strcmp(mode, "capacity-cleanup-head");
          if (invalid_cleanup) ready[!std::strcmp(mode, "capacity-cleanup-nonce") ? 0 : !std::strcmp(mode, "capacity-cleanup-binding") ? 64 : 96] ^= 1;
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::cleanup_ready, ready.data(), static_cast<DWORD>(ready.size()), stop.value, deadline), ERROR_SUCCESS, "invite cleanup after full history and authority");
          if (invalid_cleanup) faulty = true;
          else {
            CellRuntimeCleanupTransfer transfer(server.value, deadline, cleanup.binding,
              {[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, stop.value});
            CellRuntimeCleanupSet received;
            Code(transfer.Read(&received), ERROR_SUCCESS, "receive actual cleanup bytes in controlled server phase");
            Check(received.expectations.empty() && received.checkpoint_sha256 == head, "controlled transfer preserves empty set and head");
            if (!std::strcmp(mode, "capacity-cleanup-duplicate")) {
              Code(WriteCellControllerMessage(server.value, CellControllerMessage::cleanup_ready, ready.data(), static_cast<DWORD>(ready.size()), stop.value, deadline), ERROR_SUCCESS, "repeat cleanup ready after ACK");
              faulty = true;
            }
          }
        }
        if (!faulty && !unavailable && std::strcmp(mode, "capacity-missing")) capacityFrame();
        if (!faulty && !std::strcmp(mode, "capacity-duplicate")) { capacityFrame(); faulty = true; }
        if (!faulty && !std::strcmp(mode, "capacity-after-frame")) { challenge(maximum, "no-reply"); faulty = true; }
        if (!faulty && !std::strcmp(mode, "capacity-no-terminal")) {
          const auto sent = WriteCellControllerMessage(server.value, CellControllerMessage::hello, nonce.data(), 32, stop.value, deadline);
          // The client rejects the header before reading its body and may close
          // between those writes. Exact client rejection and zero publication
          // are asserted after joining; an arbitrary write failure is not OK.
          Check(sent == ERROR_SUCCESS || sent == ERROR_NO_DATA || sent == ERROR_BROKEN_PIPE,
            "unexpected terminal header is sent or rejected by the closing peer");
          faulty = true;
        }
        if (!faulty && (!std::strcmp(mode, "capacity-nonce") || !std::strcmp(mode, "capacity-assignment") ||
            !std::strcmp(mode, "capacity-profile") || !std::strcmp(mode, "capacity-head") || !std::strcmp(mode, "capacity-root") ||
            !std::strcmp(mode, "capacity-no-authority") || !std::strcmp(mode, "capacity-wrong-kind") || !std::strcmp(mode, "capacity-cleanup-missing"))) faulty = true;
        if (!faulty) {
          std::array<std::uint8_t, 48> bytes{}; std::copy(nonce.begin(), nonce.end(), bytes.begin());
          Put(bytes.data() + 32, unavailable || !std::strcmp(mode, "capacity-error") ? ERROR_NOT_SUPPORTED : ERROR_SUCCESS, 4);
          Put(bytes.data() + 36, 5, 4); Put(bytes.data() + 44, !std::strcmp(mode, "capacity-count") ? 20 : maximum, 4);
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::receipt, bytes.data(), 48, stop.value, deadline), ERROR_SUCCESS, "send capacity terminal receipt");
          if (!std::strcmp(mode, "capacity-good") || !std::strcmp(mode, "capacity-frozen") || unavailable) {
            CellControllerNonce finish{};
            Code(ReadCellControllerMessage(server.value, CellControllerMessage::finish, finish.data(), 32, stop.value, deadline), ERROR_SUCCESS, "capacity consumer acknowledges validated terminal receipt");
            Check(finish == nonce, "capacity finish binds this connection");
          }
        }
        faulty = true; // This branch owns capacity's terminal exchange.
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
  Outcome outcome; NativeClient client{{}, root, sequence, outcome, stop.value, capacity ? mode : "controlled-volume-reply"};
  Code(client.server.Open(pipe.value), ERROR_SUCCESS, "volume client authenticates actual pipe server");
  CellControllerNonce initial{}; initial.fill(0x11); CellControllerRequest request;
  Check(DecodeCellControllerRequest(wire, initial, &request), "decode volume response request");
  if (recover) {
    request.operation = capacity ? (pool_capacity ? kCellControllerPoolCapacityOperation : inventory ? kCellControllerInventoryOperation : backing_capacity ? kCellControllerBackingCapacityOperation : kCellControllerCapacityOperation) : workspace ? 12 : mount ? 10 : protection ? 8 : format ? 6 : 4;
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
  PopulateCleanup(request, owner_sid);
  if (pool_capacity) request.capture_nonce.fill(0x44);
  CellControllerClientOwner owner{&client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
  owner.owner_sid = !std::strcmp(mode, "sid") ? L"S-1-5-18" : owner_sid; owner.controller_sid = owner_sid;
  if (capacity) { PopulateCleanup(request, owner_sid); owner.capacity = NativeClient::Capacity; owner.backing_capacity = NativeClient::BackingCapacity; owner.inventory = NativeClient::Inventory; client.retained = &records; }
  if (pool_capacity) owner.pool_capacity = NativeClient::PoolCapacity;
  if (!std::strcmp(mode, "capacity-frozen")) { client.mutable_request = &request; client.mutable_owner = &owner; }
  // The real helper has no session nonce until the client creates one.
  if (capacity) request.nonce.fill(0);
  const auto result = RunCellControllerClientSession(pipe.value, stop.value, GetTickCount64() + 8000, request, owner);
  SetEvent(done.value); client.server.Close(); pipe.Close(); thread.join();
  if (server_error) std::rethrow_exception(server_error);
  if (capacity) {
    const bool success = !std::strcmp(mode, "capacity-good") || !std::strcmp(mode, "capacity-frozen"), unavailable = !std::strcmp(mode, "capacity-unavailable");
    const DWORD expected_error = success || unavailable ? ERROR_SUCCESS : !std::strcmp(mode, "capacity-callback-error") ? ERROR_WRITE_FAULT :
      !std::strcmp(mode, "capacity-callback-revoke") || !std::strcmp(mode, "capacity-denied") ? ERROR_ACCESS_DENIED : ERROR_INVALID_DATA;
    Code(result, expected_error, mode);
    const bool delivered = success || !std::strncmp(mode, "capacity-callback-", 18);
    Check(client.capacity_calls == (delivered ? 1u : 0u) && client.received == (success || unavailable), "capacity consumer sees only a complete validated observation and receipt");
    Check(outcome.records.size() == (!std::strcmp(mode, "capacity-early") ? 19u : 21u), "capacity never acknowledges or alters the retained checkpoint history");
    if (delivered && inventory) Check(client.inventory == InventoryFromHistory(records), "delivered inventory preserves every recorded object and large sparse byte value");
    if (delivered && !backing_capacity && !inventory && !pool_capacity) Check(client.capacity == CapacityFromHistory(records), "delivered capacity preserves all independently recorded bindings and sparse counts");
    if (delivered && backing_capacity) {
      CellControllerNonce nonce{}; nonce.fill(1); CellControllerBackingCapacityBytes actual{}, expected{};
      Check(EncodeCellControllerBackingCapacity(nonce, client.backing_capacity, &actual) &&
        EncodeCellControllerBackingCapacity(nonce, BackingCapacityFromHistory(records), &expected) && actual == expected,
        "delivered host capacity preserves independent host identities and allocation without a mounted observation");
      Check(client.capacity == CellProvisioningFootprint{}, "host observation never reaches the mounted-tree consumer");
    }
    if (unavailable) Check(U32(client.receipt.data()) == ERROR_NOT_SUPPORTED, "unsupported capacity remains unavailable rather than zero");
    return;
  }
  const bool success = !std::strcmp(mode, "recover");
  Code(result, success ? ERROR_SUCCESS : ERROR_INVALID_DATA, "volume client accepts only exact history and fresh authority");
  const unsigned expected = !std::strcmp(mode, "sid") ? 0 : success || !std::strcmp(mode, "missing-terminal") || !std::strcmp(mode, "recover-capacity") ? maximum : !std::strcmp(mode, "missing-between") ? boundary + 1 : boundary;
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
void CleanupControllerPipe(const Parent& parent, const CellControllerRequest& supplied,
    const std::vector<std::uint8_t>& bytes, const CellRuntimeCleanupBinding& binding, unsigned count, unsigned mode) {
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCleanupController-" + Name();
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr)};
  Check(stop.value && server.value != INVALID_HANDLE_VALUE, "Create exclusive cleanup controller fixture pipe");
  Handle client{CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Check(client.value != INVALID_HANDLE_VALUE, "Open cleanup controller fixture client");
  const auto deadline = GetTickCount64() + 5000;
  Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "Connect cleanup controller fixture");
  auto request = supplied; auto owner_sid = parent.user, controller_sid = parent.user;
  if (mode == 2) request.mounted_workspace_records.back().fill(0);
  if (mode == 3) owner_sid = L"S-1-5-18";
  struct Authority final {
    HANDLE pipe; bool server; unsigned mode = 0, calls = 0;
    CellControllerRequest* request = nullptr; std::wstring* owner = nullptr;
    static DWORD Check(void* raw) noexcept {
      auto& self = *static_cast<Authority*>(raw); ULONG pid = 0;
      if (!(self.server ? GetNamedPipeClientProcessId(self.pipe, &pid) : GetNamedPipeServerProcessId(self.pipe, &pid)) ||
          pid != GetCurrentProcessId()) return ERROR_ACCESS_DENIED;
      if (++self.calls == 1 && self.mode == 1) {
        self.request->mounted_workspace_records.back().fill(0); self.owner->clear();
      }
      return self.mode == 4 && self.calls >= 2 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  } writer_authority{client.value, false}, reader_authority{server.value, true, mode, 0, &request, &owner_sid};
  CellRuntimeCleanupTransfer writer(client.value, deadline, binding, {Authority::Check, &writer_authority, stop.value});
  CellRuntimeCleanupTransfer reader(server.value, deadline, binding, {Authority::Check, &reader_authority, stop.value});
  DWORD written = ERROR_IO_PENDING;
  std::thread sending([&] { written = writer.Write(bytes); });
  CellRuntimeCleanupSet received;
  CellProvisioningJournal absent_journal;
  const auto error = mode == 5 ? reader.ReadVerifiedForController(absent_journal, request, owner_sid, controller_sid, {}, &received) :
    reader.ReadForController(request, owner_sid, controller_sid, &received);
  if (error) SetEvent(stop.value);
  sending.join(); // A received ACK must finish before cancellation can be signalled.
  if (mode < 2) {
    Code(error, ERROR_SUCCESS, "Controller-bound cleanup receive succeeds under retained history");
    Code(written, ERROR_SUCCESS, "Cleanup writer receives the exact controller-bound ACK");
    Check(received.expectations.size() == count, "Controller-bound receive returns complete metadata");
    if (mode == 1) Check(owner_sid.empty(), "Caller mutation was exercised after the receiver snapshot");
  } else {
    Check(error != ERROR_SUCCESS && written != ERROR_SUCCESS && received.expectations.empty() && received.anchor == CellProvisioningAnchor{},
      "History, principal or authority refusal withholds the cleanup ACK and decoded metadata");
  }
  Code(reader.Read(&received), ERROR_INVALID_STATE, "Controller-bound read cannot downgrade to an unbound retry");
}
void CleanupBindingCases(const Parent& parent, const CellControllerRequest& request, const CellProvisioningFootprint& value) {
  const auto encode = [&](unsigned count) {
    std::vector<std::uint8_t> bytes(252 + count * 108);
    std::memcpy(bytes.data(), "GCCLEAN1", 8); std::fill_n(bytes.begin() + 8, 32, std::uint8_t{0xcc});
    const auto identity = [&](unsigned offset, const CellFileIdentity& id) {
      Put(bytes.data() + offset, id.volume_serial); std::copy(id.file_id.begin(), id.file_id.end(), bytes.begin() + offset + 8);
    };
    identity(40, value.anchor.file);
    std::copy(value.anchor.prepared_sha256.begin(), value.anchor.prepared_sha256.end(), bytes.begin() + 64);
    std::copy(value.checkpoint_sha256.begin(), value.checkpoint_sha256.end(), bytes.begin() + 96);
    identity(128, value.workspace.parent);
    for (unsigned index = 0; index < 4; ++index) identity(152 + index * 24, value.workspace.directories[index]);
    Put(bytes.data() + 248, count, 4);
    if (count) {
      std::fill_n(bytes.begin() + 252, 32, std::uint8_t{0x11}); std::fill_n(bytes.begin() + 284, 32, std::uint8_t{0x22}); std::fill_n(bytes.begin() + 316, 32, std::uint8_t{0x33});
      Put(bytes.data() + 348, 1024, 4); Put(bytes.data() + 352, 4096, 4); Put(bytes.data() + 356, 20, 4);
    }
    return bytes;
  };
  for (const auto count : {0u, 1u}) {
    const auto bytes = encode(count); CellRuntimeCleanupBinding binding; binding.challenge.fill(0xcc);
    Code(HashCellRuntimeCleanup(bytes, &binding.set_sha256), ERROR_SUCCESS, "Hash independent cleanup fixture");
    for (unsigned mode = 0; mode < 6; ++mode) CleanupControllerPipe(parent, request, bytes, binding, count, mode);
    CellRuntimeCleanupSet decoded;
    for (const auto operation : {14u, 15u, 16u, 17u}) {
      auto current = request; current.operation = operation;
      if (operation == 17) {
        current.runtime.nonce.fill(0x11); current.runtime.request_sha256.fill(0x22); current.runtime.checkpoint_sha256 = value.checkpoint_sha256;
      }
      Code(DecodeCellControllerCleanup(current, bytes, binding, parent.user, parent.user, &decoded), ERROR_SUCCESS,
        "Cleanup metadata binds complete controller measurement history");
      Check(decoded.expectations.size() == count && decoded.workspace == value.workspace, "Retain only exactly bound cleanup metadata");
    }
    const auto reject = [&](const CellControllerRequest& outer, const std::vector<std::uint8_t>& wire,
        const CellRuntimeCleanupBinding& expected, const std::wstring& owner, const std::wstring& controller) {
      decoded.expectations.resize(1); decoded.anchor = value.anchor;
      Check(DecodeCellControllerCleanup(outer, wire, expected, owner, controller, &decoded) != ERROR_SUCCESS &&
        decoded.expectations.empty() && decoded.anchor == CellProvisioningAnchor{}, "Refused cleanup exposes no partial admitted set");
    };
    for (const auto offset : {63u, 95u, 127u, 151u, 175u, 199u, 223u, 247u}) {
      auto changed = bytes; changed[offset] ^= 0x80; auto rebound = binding;
      Code(HashCellRuntimeCleanup(changed, &rebound.set_sha256), ERROR_SUCCESS, "Rehash substituted cleanup metadata");
      Code(DecodeCellRuntimeCleanup(changed, rebound, &decoded), ERROR_SUCCESS, "Substitution remains internally well-formed");
      reject(request, changed, rebound, parent.user, parent.user);
    }
    for (unsigned index = 0; index < 21; ++index) {
      auto altered = request;
      if (index < 5) altered.creation_records[index].fill(0);
      else if (index < 11) altered.volume_records[index - 5].fill(0);
      else if (index < 13) altered.format_records[index - 11].fill(0);
      else if (index < 15) altered.protection_records[index - 13].fill(0);
      else if (index < 19) altered.mount_records[index - 15].fill(0);
      else altered.mounted_workspace_records[index - 19].fill(0);
      reject(altered, bytes, binding, parent.user, parent.user);
    }
    reject(request, bytes, binding, L"S-1-5-18", parent.user);
    reject(request, bytes, binding, parent.user, L"S-1-5-18");
    auto wrong = binding; wrong.challenge[0] ^= 1; reject(request, bytes, wrong, parent.user, parent.user);
    wrong = binding; wrong.set_sha256[0] ^= 1; reject(request, bytes, wrong, parent.user, parent.user);
    for (const auto operation : {1u, 12u, 13u, 17u, 18u, 19u}) {
      auto altered = request; altered.operation = operation;
      reject(altered, bytes, binding, parent.user, parent.user);
    }
  }
}
void CapacityCases(const Parent& parent, const std::wstring& root, const Wire& wire,
  const std::vector<CellProvisioningRecord>& records, CellControllerRequest request) {
  request.operation = kCellControllerCapacityOperation;
  const auto value = CapacityFromHistory(records);
  Wire encoded{};
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user) &&
    MatchesCellControllerCapacity(request, value, parent.user, parent.user), "capacity binds all native records, local principals and independently decoded mounted identities");
  CleanupBindingCases(parent, request, value);
  const auto reject = [&](auto change) {
    auto altered = value; change(altered);
    Check(!MatchesCellControllerCapacity(request, altered, parent.user, parent.user), "capacity cannot substitute validly encoded assignment or resource identity");
  };
  reject([](auto& v) { v.anchor.file.file_id[15] ^= 1; });
  reject([](auto& v) { v.anchor.prepared_sha256[31] ^= 1; });
  reject([](auto& v) { v.assignment_binding[31] ^= 1; });
  reject([](auto& v) { v.profile_sha256[31] ^= 1; });
  reject([](auto& v) { v.checkpoint_sha256[31] ^= 1; });
  reject([](auto& v) { v.workspace.parent.file_id[15] ^= 1; });
  for (unsigned index = 0; index < 4; ++index) reject([&](auto& v) {
    v.workspace.directories[index].file_id[15] ^= 1; v.footprint.root = v.workspace.directories[0];
  });
  Check(!MatchesCellControllerCapacity(request, value, L"S-1-5-18", parent.user) &&
    !MatchesCellControllerCapacity(request, value, parent.user, L"S-1-5-18"), "capacity principals cannot come from peer metadata");
  for (unsigned index = 0; index < 21; ++index) {
    auto altered = request;
    if (index < 5) altered.creation_records[index].fill(0);
    else if (index < 11) altered.volume_records[index - 5].fill(0);
    else if (index < 13) altered.format_records[index - 11].fill(0);
    else if (index < 15) altered.protection_records[index - 13].fill(0);
    else if (index < 19) altered.mount_records[index - 15].fill(0);
    else altered.mounted_workspace_records[index - 19].fill(0);
    Check(!MatchesCellControllerCapacity(altered, value, parent.user, parent.user), "every canonical capacity history record is required");
  }
  for (const auto operation : {1u, 12u, 13u, 15u}) {
    auto altered = request; altered.operation = operation;
    Check(!MatchesCellControllerCapacity(altered, value, parent.user, parent.user), "capacity cannot be relabelled as another operation");
  }
  auto over_deadline = request; over_deadline.wall_ms = 60001;
  Check(!EncodeCellControllerRequest(over_deadline, &encoded, parent.user, parent.user), "capacity cannot inherit the longer provisioning deadline");
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "restore bounded capacity request");
  unsigned authorizations = 0;
  CellControllerClientOwner missing{&authorizations,
    [](void* context) noexcept -> DWORD { ++*static_cast<unsigned*>(context); return ERROR_ACCESS_DENIED; },
    NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
  missing.owner_sid = parent.user; missing.controller_sid = parent.user;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 1000, request, missing), ERROR_INVALID_STATE,
    "missing capacity consumer refuses before authentication or pipe IO");
  missing.capacity = NativeClient::Capacity; missing.volume_authority = nullptr;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 1000, request, missing), ERROR_INVALID_STATE,
    "missing canonical capacity authority refuses before pipe IO");
  Check(authorizations == 0, "capacity callback composition is checked before caller callbacks");
  const auto before = JournalBytes(parent, request.cell_name);
  auto unavailable_parent = parent; unavailable_parent.path += L"\\absent-capacity-owner";
  const auto unavailable = Exchange(unavailable_parent, root, encoded, "native-capacity-missing-owner", &request.volume_records,
    &request.format_records, &request.protection_records, &request.creation_records, &request.mount_records, &request.mounted_workspace_records);
  Check(unavailable.client_error == ERROR_SUCCESS && unavailable.result.error == ERROR_NOT_SUPPORTED &&
    unavailable.result.receipt_acknowledged && !unavailable.result.capacity_written && !unavailable.result.creation_attempted &&
    unavailable.records.empty() && JournalBytes(parent, request.cell_name) == before,
    "actual controller refuses missing quiescence ownership before opening even the nonexistent parent and preserves journal bytes");
  const auto missing_hold = Exchange(unavailable_parent, root, encoded, "native-capacity-missing-hold", &request.volume_records,
    &request.format_records, &request.protection_records, &request.creation_records, &request.mount_records, &request.mounted_workspace_records);
  Check(missing_hold.client_error == ERROR_SUCCESS && missing_hold.result.error == ERROR_NOT_SUPPORTED && !missing_hold.result.capacity_written &&
    missing_hold.records.empty(), "measurement callback without a retained writer hold refuses before opening parent");
  for (const auto mode : {"capacity-cleanup-missing", "capacity-cleanup-nonce", "capacity-cleanup-binding", "capacity-cleanup-head", "capacity-cleanup-duplicate"})
    VolumeReply(root, wire, records, mode, parent.user);
  for (const auto mode : {"capacity-good", "capacity-frozen", "capacity-unavailable", "capacity-missing", "capacity-no-authority",
      "capacity-early", "capacity-nonce", "capacity-assignment", "capacity-profile", "capacity-head", "capacity-root",
      "capacity-error", "capacity-count", "capacity-duplicate", "capacity-after-frame", "capacity-no-terminal",
      "capacity-authority-ordinal", "capacity-authority-head", "capacity-authority-count", "capacity-authority-nonce",
      "capacity-denied", "capacity-callback-error", "capacity-callback-revoke", "recover-capacity"})
    VolumeReply(root, wire, records, mode, parent.user);
  Check(JournalBytes(parent, request.cell_name) == before, "capacity protocol cases leave original journal unchanged");
}
void JoinedCapacityCollectorCases(const CellJoinedCapacityReference& reference, const CellProvisioningJoinedCapacity& observed,
  CellJoinedCapacityBytes* encoded) {
  const auto expected = *encoded;
  const auto empty = [](const CellJoinedCapacityBytes& bytes) {
    return bytes.host.empty() && bytes.guest_chunks.empty() && bytes.layout == CellCapacityLayoutBytes{} &&
      bytes.guest == CellControllerCapacityBytes{} && bytes.backing == CellControllerBackingCapacityBytes{};
  };
  struct Owner final {
    CellJoinedCapacityReference expected;
    CellJoinedCapacityReference* supplied;
    const CellProvisioningJoinedCapacity& value;
    unsigned mode = 0, authorizations = 0, captures = 0, verifications = 0, bindings = 0;
    bool live = true, captured = false;
    HANDLE cancellation = nullptr;
    CellFootprintScanGuard* supplied_authority = nullptr;
    CellFootprintCellBinding* supplied_binding = nullptr;
    DWORD remaining_ms = 0;
    static DWORD Matches(void* raw, const CellJoinedCapacityReference& reference) noexcept {
      const auto& self = *static_cast<Owner*>(raw); const auto& expected = self.expected;
      if (!self.live) return ERROR_INVALID_STATE;
      if (reference.owner_sid != expected.owner_sid || reference.controller_sid != expected.controller_sid || reference.layout != expected.layout ||
          reference.capture_nonce != expected.capture_nonce || reference.limits.wall_limit_ms != expected.limits.wall_limit_ms ||
          reference.history.operation != expected.history.operation || reference.history.wall_ms != expected.history.wall_ms ||
          reference.history.nonce != expected.history.nonce || reference.history.cell_name != expected.history.cell_name ||
          reference.history.parent != expected.history.parent || reference.history.anchor != expected.history.anchor ||
          reference.history.plan.assignment_binding != expected.history.plan.assignment_binding || reference.history.plan.profile_sha256 != expected.history.plan.profile_sha256 ||
          !IsEqualGUID(reference.history.plan.disk.identifier, expected.history.plan.disk.identifier) ||
          reference.history.plan.disk.virtual_bytes != expected.history.plan.disk.virtual_bytes ||
          reference.history.plan.disk.reserved_file_bytes != expected.history.plan.disk.reserved_file_bytes ||
          reference.history.creation_records != expected.history.creation_records || reference.history.volume_records != expected.history.volume_records ||
          reference.history.format_records != expected.history.format_records || reference.history.protection_records != expected.history.protection_records ||
          reference.history.mount_records != expected.history.mount_records || reference.history.mounted_workspace_records != expected.history.mounted_workspace_records)
        return ERROR_FILE_INVALID;
      return ERROR_SUCCESS;
    }
    static DWORD Verify(void* raw, const CellJoinedCapacityReference& reference) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.verifications;
      if (self.verifications == 2) {
        if (self.mode == 6) return ERROR_CRC;
        if (self.mode == 16) SetEvent(self.cancellation);
        if (self.mode == 17) self.live = false;
      }
      return Matches(raw, reference);
    }
    static DWORD Authorize(void* raw) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.authorizations;
      if (self.mode == 1 || (self.mode == 2 && self.captured)) return ERROR_ACCESS_DENIED;
      if (self.mode == 3 && self.captured) self.live = false;
      if (self.mode == 11 && self.authorizations == 1) {
        self.supplied->history.creation_records[0].fill(0); self.supplied->history.nonce.fill(0);
        self.supplied->layout.roots[0] = {}; self.supplied->capture_nonce.fill(0); self.supplied->limits.wall_limit_ms = 0;
        *self.supplied_authority = {}; *self.supplied_binding = {};
      }
      return ERROR_SUCCESS;
    }
    static DWORD Binding(const void* raw, const std::wstring& name, const CellFileIdentity& work) noexcept {
      auto& self = *const_cast<Owner*>(static_cast<const Owner*>(raw)); ++self.bindings;
      if (self.mode == 7) return ERROR_ACCESS_DENIED;
      return name == self.expected.history.cell_name && work == self.value.guest.workspace.directories[static_cast<std::size_t>(CellDirectory::work)]
        ? ERROR_SUCCESS : ERROR_FILE_INVALID;
    }
    static DWORD Capture(void* raw, const CellJoinedCapacityReference& reference, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& guard, const CellFootprintCellBinding&, CellProvisioningJoinedCapacity* output) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.captures; self.remaining_ms = limits.wall_limit_ms;
      auto error = Matches(raw, reference);
      if (!error) error = guard.authorize(guard.context);
      if (error) return error;
      try { *output = self.value; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      self.captured = true;
      if (self.mode == 4) return ERROR_READ_FAULT;
      if (self.mode == 5) output->guest.checkpoint_sha256[0] ^= 1;
      if (self.mode == 9) SetEvent(self.cancellation);
      if (self.mode == 10) Sleep(150);
      if (self.mode == 18) Sleep(120);
      return ERROR_SUCCESS;
    }
  };
  CellJoinedCapacityBytes collected;
  for (unsigned mode = 0; mode <= 18; ++mode) {
    Handle cancellation{CreateEventW(nullptr, TRUE, mode == 8, nullptr)};
    Check(cancellation.value != nullptr, "create task-owned collector cancellation event");
    auto supplied = reference;
    if (mode == 10) supplied.limits.wall_limit_ms = 100;
    if (mode == 12) supplied.limits.max_entries = 44;
    if (mode == 15) supplied.history.creation_records[0][0] ^= 1;
    if (mode == 18) supplied.history.wall_ms = 100;
    Owner owner{supplied, &supplied, observed, mode}; owner.cancellation = cancellation.value;
    CellFootprintScanGuard authority{Owner::Authorize, &owner, cancellation.value};
    CellFootprintCellBinding binding{Owner::Binding, &owner};
    owner.supplied_authority = &authority; owner.supplied_binding = &binding;
    if (mode == 13) authority.authorize = nullptr;
    if (mode == 14) binding.authorize = nullptr;
    *encoded = expected;
    const auto error = CellJoinedCapacityCollectorTestPeer::Capture(owner, supplied, authority, binding, encoded);
    if (mode == 0 || mode == 11) {
      Code(error, ERROR_SUCCESS, "collector freezes references and callback descriptors through final native readback");
      Check(encoded->layout == expected.layout && encoded->host == expected.host && encoded->guest == expected.guest &&
        encoded->guest_chunks == expected.guest_chunks && encoded->backing == expected.backing && owner.verifications == 2 &&
        owner.captures == 1 && owner.bindings == 2 && owner.authorizations >= 4, "collector publishes only after current authority, cell binding and final owner verification");
      if (!mode) collected = *encoded;
    } else {
      Check(error != ERROR_SUCCESS && empty(*encoded), "collector errors clear all old and provisional frames");
      if (mode == 1 || mode == 8 || mode == 13 || mode == 14 || mode == 15) Check(owner.captures == 0, "invalid or revoked capture never invokes collection");
      if (mode == 8 || mode == 9 || mode == 16) Code(error, ERROR_CANCELLED, "cancellation remains authoritative through final readback");
      if (mode == 10 || mode == 18) {
        Code(error, ERROR_TIMEOUT, "one deadline includes collection and respects the original request budget");
        Check(owner.captures == 1, "deadline fixture reaches collection before deliberately exhausting its budget");
      }
      if (mode == 12) Code(error, ERROR_BUFFER_OVERFLOW, "collector preserves a stricter admitted object limit");
      if (mode == 18) Check(owner.remaining_ms <= 100, "collector narrows its reader deadline to the retained request");
    }
  }
  CellProvisioningJournal closed_journal; CellCapacityLayout closed_layout;
  Owner owner{reference, nullptr, observed}; *encoded = expected;
  Code(CellJoinedCapacityCollector::Capture(closed_journal, closed_layout, reference, {Owner::Authorize, &owner}, {Owner::Binding, &owner}, encoded),
    ERROR_INVALID_STATE, "public collector refuses absent native owners without adopting or creating any storage");
  Check(empty(*encoded) && !owner.authorizations && !owner.captures, "public refusal publishes nothing and invokes no authority callback");
  *encoded = std::move(collected);
}
void PoolCapacityCases() {
  struct Owner final {
    unsigned mode = 0, borrows = 0, scans = 0, checks = 0;
    bool active[2]{}, denied = false;
    CellPoolCapacityMember* supplied_members = nullptr;
    std::vector<unsigned> finished;
    static DWORD Authority(void* raw) noexcept { return static_cast<Owner*>(raw)->denied ? ERROR_ACCESS_DENIED : ERROR_SUCCESS; }
    struct Held final {
      Owner& owner; std::size_t index;
      static DWORD Check(void* raw) noexcept {
        auto& self = *static_cast<Held*>(raw); ++self.owner.checks;
        return self.owner.active[self.index] && !self.owner.denied ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
      }
    };
    static DWORD Borrow(void* raw, std::size_t index, const CellPoolCapacityMember& member, DWORD wall,
      const CellFootprintScanGuard& authority, const CellProvisioningBackingObserver& observer,
      CellProvisioningBackingFootprint* output) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.borrows;
      if (self.mode == 11 && index == 0) self.supplied_members[1].head.fill(99);
      if (index > 1 || !wall || self.active[index] || (index && !self.active[0])) return ERROR_INVALID_STATE;
      if (self.mode == 1 && index == 1) return ERROR_ACCESS_DENIED;
      if (self.mode == 6 && index == 1) return ERROR_SUCCESS;
      auto error = authority.authorize(authority.context); if (error) return error;
      self.active[index] = true;
      Held held{self, index};
      CellProvisioningBackingFootprint value;
      value.anchor = member.anchor; value.checkpoint_sha256 = member.head;
      value.assignment_binding = member.assignment_binding; value.profile_sha256 = member.profile_sha256;
      value.workspace.parent.volume_serial = 1; value.workspace.parent.file_id[0] = 1;
      value.workspace.directories[static_cast<std::size_t>(CellDirectory::root)] = member.workspace_root;
      value.backing.record.control.volume_serial = 1; value.backing.record.control.file_id[0] = static_cast<std::uint8_t>(10 + index);
      value.backing.record.backing.volume_serial = 1; value.backing.record.backing.file_id[0] = static_cast<std::uint8_t>(20 + index);
      value.journal_bytes = 1024; value.journal_allocated_bytes = 4096;
      value.backing.file_bytes = 8192; value.backing.allocated_bytes = 8192; value.host_file_allocated_bytes = 12288;
      const std::array<CellCapacityBorrowedFile, 2> files{{
        {GetCurrentProcess(), value.workspace.parent, value.anchor.file, value.journal_bytes, value.journal_allocated_bytes},
        {GetCurrentProcess(), value.backing.record.control, value.backing.record.backing, value.backing.file_bytes, value.backing.allocated_bytes},
      }};
      const CellCapacityBorrowedFiles borrowed{files, {Held::Check, &held}};
      error = observer.capture(observer.context, borrowed, value);
      if (self.mode == 8 && index == 1) observer.capture(observer.context, borrowed, value);
      if (self.mode == 3 && index == 0) error = ERROR_ACCESS_DENIED;
      if (error || (self.mode == 7 && index == 1)) observer.discard(observer.context);
      *output = value;
      if (self.mode == 4 && index == 1) ++output->journal_bytes;
      self.active[index] = false; self.finished.push_back(static_cast<unsigned>(index));
      return self.mode == 5 ? ERROR_SUCCESS : error;
    }
    static DWORD Scan(void* raw, const CellCapacityLayoutRecord&, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& authority, CellCapacityAreaInventories* output,
      const CellCapacityBorrowedFiles* borrowed, const CellCapacityCaptureObserver*) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.scans;
      if (self.mode == 10) return !self.borrows && !borrowed ? authority.authorize(authority.context) : ERROR_INVALID_DATA;
      if (!self.active[0] || !self.active[1] || !borrowed || borrowed->files.size() != 4 ||
          !borrowed->mounts.empty() || !limits.wall_limit_ms ||
          borrowed->files[0].identity == borrowed->files[2].identity) return ERROR_INVALID_DATA;
      auto error = authority.authorize(authority.context);
      if (!error) error = borrowed->guard.authorize(borrowed->guard.context);
      if (self.mode == 9) { self.denied = true; error = authority.authorize(authority.context); }
      if (self.mode == 2 || self.mode == 5) error = ERROR_CRC;
      if (!error) (*output)[0].footprint.file_count = 4;
      return error;
    }
  };
  CellProvisioningJournal journals[2];
  CellCapacityLayoutRecord roots; roots.roots[0].volume_serial = 1; roots.roots[0].file_id[0] = 1;
  std::array<CellPoolCapacityMember, 2> members;
  for (std::size_t i = 0; i < members.size(); ++i) {
    members[i].journal = &journals[i]; members[i].anchor.file.volume_serial = 1;
    members[i].anchor.file.file_id[0] = static_cast<std::uint8_t>(30 + i);
    members[i].workspace_root.volume_serial = 1; members[i].workspace_root.file_id[0] = static_cast<std::uint8_t>(40 + i);
    members[i].anchor.prepared_sha256.fill(1); members[i].head.fill(2);
    members[i].assignment_binding.fill(static_cast<std::uint8_t>(3 + i)); members[i].profile_sha256.fill(4);
  }
  for (unsigned mode = 0; mode <= 9; ++mode) {
    Owner owner; owner.mode = mode; CellPoolCapacity result; result.backings.resize(1);
    const auto error = CellPoolCapacityCollectorTestPeer::Capture(owner, roots, members, {Owner::Authority, &owner}, &result);
    if (!mode) {
      Check(!error && result.backings.size() == 2 && result.areas[0].footprint.file_count == 4 &&
        owner.scans == 1 && owner.checks >= 4 && owner.finished == std::vector<unsigned>{1, 0},
        "one pool scan runs inside both journal borrows and releases them in reverse order");
    } else Check(error && result.backings.empty() && result.areas == CellCapacityAreaInventories{},
      "pool capture withholds every observation after member, scan, unwind, receipt or authority failure");
    Check(!owner.active[0] && !owner.active[1], "pool failures unwind all entered members");
  }
  for (unsigned mode = 0; mode < 4; ++mode) {
    auto invalid = std::vector<CellPoolCapacityMember>(members.begin(), members.end());
    if (mode == 0) invalid[1].journal = invalid[0].journal;
    if (mode == 1) invalid[1].anchor = invalid[0].anchor;
    if (mode == 2) invalid[1].head = {};
    if (mode == 3) invalid.resize(kCellCapacityPoolMaximumMembers + 1, invalid[0]);
    Owner owner; CellPoolCapacity result;
    Check(CellPoolCapacityCollectorTestPeer::Capture(owner, roots, invalid, {Owner::Authority, &owner}, &result) && !owner.borrows && !owner.scans,
      "invalid or oversized membership is refused before entering any journal");
  }
  {
    Owner owner; owner.mode = 10; CellPoolCapacity result;
    Check(!CellPoolCapacityCollectorTestPeer::Capture(owner, roots, {}, {Owner::Authority, &owner}, &result) &&
      owner.scans == 1 && !owner.borrows && result.backings.empty(),
      "empty retained membership still requires one complete host scan");
  }
  {
    auto supplied = members; Owner owner; owner.mode = 11; owner.supplied_members = supplied.data(); CellPoolCapacity result;
    Check(!CellPoolCapacityCollectorTestPeer::Capture(owner, roots, supplied, {Owner::Authority, &owner}, &result) &&
      result.backings[1].checkpoint_sha256 == members[1].head && supplied[1].head != members[1].head,
      "nested collection freezes all member bindings before the first external callback");
  }
  {
    Handle stopped{CreateEventW(nullptr, TRUE, TRUE, nullptr)}; Owner owner; CellPoolCapacity result;
    Check(stopped.value && CellPoolCapacityCollectorTestPeer::Capture(owner, roots, members,
      {Owner::Authority, &owner, stopped.value}, &result) == ERROR_CANCELLED && !owner.borrows && !owner.scans,
      "cancelled pool collection enters no native member");
    CellCapacityLayout closed;
    Check(CellPoolCapacityCollector::Capture(closed, roots, members, {}, {Owner::Authority, &owner}, &result) != ERROR_SUCCESS &&
      result.backings.empty() && result.areas == CellCapacityAreaInventories{},
      "production pool collector refuses a layout without retained root custody");
  }
}
void PoolJoinedCases() {
  // Controlled reader/pin lifetimes only. No file, virtual-disk or mounted
  // journal is opened by these operations; native scanning has separate lanes.
  struct Owner final {
    unsigned mode = 0, captured = 0, closed = 0, pin_checks = 0;
    bool host_active = false, pins[2]{}, denied = false;
    static DWORD Authority(void* raw) noexcept { return static_cast<Owner*>(raw)->denied ? ERROR_ACCESS_DENIED : ERROR_SUCCESS; }
    static DWORD Binding(const void* raw, const std::wstring&, const CellFileIdentity&) noexcept {
      return static_cast<const Owner*>(raw)->denied ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Pinned(void* raw) noexcept { return static_cast<Owner*>(raw)->host_active ? ERROR_SUCCESS : ERROR_INVALID_STATE; }
    static DWORD Host(void* raw, const CellCapacityLayoutRecord&, std::span<const CellPoolCapacityMember> members,
      const CellFootprintScanLimits&, const CellFootprintScanGuard& authority, CellPoolCapacity* output,
      const CellPoolCapacityCollectorTestPeer::JoinedObserver& observer) noexcept {
      auto& self = *static_cast<Owner*>(raw); self.host_active = self.mode != 11;
      auto error = self.mode == 7 ? ERROR_SUCCESS : observer.capture(observer.context, {Pinned, &self});
      if (self.mode == 8) observer.capture(observer.context, {Pinned, &self});
      if (!error) error = authority.authorize(authority.context);
      if (self.mode == 6) error = ERROR_CRC;
      if (error) observer.discard(observer.context);
      self.host_active = false;
      if (!error) {
        for (const auto& member : members) {
          CellProvisioningBackingFootprint value; value.anchor = member.anchor; value.checkpoint_sha256 = member.head;
          value.assignment_binding = member.assignment_binding; value.profile_sha256 = member.profile_sha256;
          output->backings.push_back(value);
        }
        if (self.mode == 9) output->backings[1].checkpoint_sha256[0] ^= 1;
        if (self.mode == 10) output->areas[0].entries.resize(20000);
      }
      return error;
    }
    static DWORD Guest(void* raw, std::size_t index, const CellPoolGuestMember& member, const CellFootprintScanLimits&,
      const CellFootprintScanGuard& authority, CellProvisioningInventory* output) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      if (index > 1 || !self.host_active || (index == 1 && !self.pins[0])) return ERROR_INVALID_STATE;
      auto error = authority.authorize(authority.context); if (error) return error;
      ++self.captured; self.pins[index] = true;
      if ((self.mode == 1 && index == 0) || (self.mode == 2 && index == 1)) return ERROR_IO_INCOMPLETE;
      output->anchor = member.host.anchor; output->checkpoint_sha256 = member.host.head;
      output->assignment_binding = member.host.assignment_binding; output->profile_sha256 = member.host.profile_sha256;
      output->inventory.entries.resize(1);
      if (self.mode == 4) output->checkpoint_sha256[0] ^= 1;
      if (self.mode == 5) self.denied = true;
      return ERROR_SUCCESS;
    }
    static DWORD Check(void* raw, std::size_t index) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.pin_checks;
      return index < 2 && self.pins[index] && !(self.mode == 3 && index == 1) ? ERROR_SUCCESS : ERROR_FILE_INVALID;
    }
    static void Close(void* raw, std::size_t index) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      if (index < 2 && self.pins[index]) { self.pins[index] = false; ++self.closed; }
    }
  };
  CellProvisioningJournal journals[2];
  for (unsigned mode = 0; mode <= 11; ++mode) {
    Owner owner; owner.mode = mode;
    std::array<CellPoolGuestMember, 2> members;
    for (std::size_t i = 0; i < members.size(); ++i) {
      auto& member = members[i]; member.host.journal = &journals[i]; member.host.anchor.file.volume_serial = 1;
      member.host.workspace_root.volume_serial = 1; member.host.workspace_root.file_id[0] = static_cast<std::uint8_t>(40 + i);
      member.host.anchor.file.file_id[0] = static_cast<std::uint8_t>(i + 1); member.host.anchor.prepared_sha256.fill(1);
      member.host.head.fill(2); member.host.assignment_binding.fill(static_cast<std::uint8_t>(i + 3)); member.host.profile_sha256.fill(4);
      member.cell_name = L"gc-cell-" + std::wstring(32, static_cast<wchar_t>(L'a' + i)); member.binding = {Owner::Binding, &owner};
    }
    CellPoolJoinedCapacity result;
    const auto error = CellPoolCapacityCollectorTestPeer::CaptureJoined(owner, {}, members, {Owner::Authority, &owner}, &result);
    if (!mode) Check(!error && result.guests.size() == 2 && result.host.backings.size() == 2 && owner.pin_checks >= 4,
      "all guest pins survive the host capture and final authority readback");
    else Check(error && result.guests.empty() && result.host.backings.empty() && result.host.areas == CellCapacityAreaInventories{},
      "joined pool capture withholds every guest and host after partial failure or mismatched evidence");
    Check(!owner.host_active && !owner.pins[0] && !owner.pins[1] && owner.closed == owner.captured,
      "joined collection releases every entered guest pin after the enclosing operation finishes");
  }
}
void BackingBorrowLifecycleCases() {
  struct Owner final {
    unsigned captures = 0, discards = 0, mode = 0, authority_calls = 0;
    const CellProvisioningBackingObserver* bridge = nullptr;
    static DWORD Authorize(void* raw) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.authority_calls;
      return self.mode == 7 || (self.mode == 6 && self.captures) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Capture(void* raw, const CellCapacityBorrowedFiles& files, const CellProvisioningBackingFootprint& footprint) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.captures;
      if (self.mode == 1) return ERROR_ACCESS_DENIED;
      if (self.mode == 3) self.bridge->capture(self.bridge->context, files, footprint);
      if (self.mode == 4) self.bridge->discard(self.bridge->context);
      return ERROR_SUCCESS;
    }
    static void Discard(void* raw) noexcept { ++static_cast<Owner*>(raw)->discards; }
  };
  for (unsigned mode = 0; mode <= 7; ++mode) {
    Owner owner; owner.mode = mode;
    {
      CellProvisioningBackingObserver supplied{&owner, Owner::Capture, Owner::Discard};
      detail::CellProvisioningBackingObservation held(supplied);
      supplied = {}; // The trusted descriptor is frozen, not retained by reference.
      Check(held.Valid(), "backing borrowing retains its original observer descriptor");
      owner.bridge = &held.Bridge();
      const CellCapacityBorrowedFiles files{{}, {Owner::Authorize, &owner}};
      const auto error = owner.bridge->capture(owner.bridge->context, files, {});
      const auto expected = mode == 1 || mode >= 6 ? ERROR_ACCESS_DENIED : (mode == 3 || mode == 4) ? ERROR_INVALID_STATE : ERROR_SUCCESS;
      Code(error, expected, "backing observer refuses failure, reentry and discarded nested evidence");
      if (mode != 2) held.Complete(); // Mode 2 models enclosing final readback failure.
      if (mode == 5) Code(owner.bridge->capture(owner.bridge->context, {}, {}), ERROR_INVALID_STATE,
        "completed backing observation cannot be captured twice");
    }
    Check(owner.captures == (mode == 7 ? 0U : 1U) && owner.discards == (mode == 0 ? 0U : 1U),
      "borrowed evidence is discarded exactly once after any attempted failure");
    if (mode == 0 || mode == 6) Check(owner.authority_calls == 2,
      "fresh borrowing authority surrounds the callback before publication");
  }
  Owner owner;
  {
    detail::CellProvisioningBackingObservation absent({&owner, nullptr, Owner::Discard});
    Check(!absent.Valid(), "missing backing capture is refused");
    detail::CellProvisioningBackingObservation incomplete({&owner, Owner::Capture, nullptr});
    Check(!incomplete.Valid(), "backing capture requires compensating discard");
    detail::CellProvisioningBackingObservation unused({&owner, Owner::Capture, Owner::Discard});
    unused.Complete();
  }
  Check(owner.captures == 0 && owner.discards == 0, "unattempted borrowing creates no evidence to discard");
  CellProvisioningJournal closed;
  CellProvisioningBackingFootprint output; output.journal_bytes = 17;
  Check(closed.WithBackingCapacity({}, {}, 1000, {}, {&owner, Owner::Capture, Owner::Discard}, &output) != ERROR_SUCCESS &&
    output.journal_bytes == 0 && !owner.captures && !owner.discards,
    "unadmitted journal clears borrowing output without invoking observers");
}
void RecordedPoolCases() {
  struct Owner final {
    unsigned mode = 0, opens = 0, captures = 0, reads[2]{}, installations[2]{}, runtimes[2]{};
    bool denied = false, bindings_checked = false;
    CellProvisioningJournal* current = nullptr;
    CellProvisioningJournal* opened = nullptr;
    CellControllerPoolHistory* supplied_pool = nullptr;
    CellRuntimePoolCleanupSet* supplied_cleanup = nullptr;
    HANDLE stop = nullptr;
    static DWORD Authority(void* raw) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      if (self.mode == 8) self.supplied_pool->members[1].plan.assignment_binding.fill(99);
      if (self.mode == 16) self.supplied_cleanup->members.clear();
      return self.mode == 1 || self.denied ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Open(void* raw, HANDLE, const CellControllerRequest& request, const std::wstring& owner,
      const std::wstring& controller, CellProvisioningJournal& journal) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.opens; self.opened = &journal;
      if (&journal == self.current || request.plan.assignment_binding[0] != 1 || owner != L"owner" || controller != L"controller") return ERROR_INVALID_STATE;
      if (self.mode == 10) SetEvent(self.stop);
      return self.mode == 2 ? ERROR_FILE_NOT_FOUND : ERROR_SUCCESS;
    }
    static DWORD Read(void* raw, CellProvisioningJournal& journal, const CellControllerRequest& request,
      CellWorkspaceIdentities* host, CellWorkspaceIdentities* guest) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      const auto index = request.plan.assignment_binding[0] - 1;
      if (index > 1 || &journal != (index ? self.current : self.opened)) return ERROR_INVALID_STATE;
      ++self.reads[index];
      if (self.mode == 3 && index == 1) return ERROR_CRC;
      if (self.mode == 6 && self.reads[index] == 2) return ERROR_CRC;
      *host = {}; *guest = {};
      host->parent.volume_serial = guest->parent.volume_serial = 7;
      host->parent.file_id.fill(1); guest->parent.file_id.fill(2);
      for (std::size_t i = 0; i < 4; ++i) {
        host->directories[i].volume_serial = guest->directories[i].volume_serial = 7;
        host->directories[i].file_id.fill(static_cast<std::uint8_t>(16 + index * 8 + i));
        guest->directories[i].file_id.fill(static_cast<std::uint8_t>(48 + index * 8 + i));
      }
      if (self.mode == 5 && self.reads[index] == 2) guest->directories[3].file_id[0] ^= 1;
      return ERROR_SUCCESS;
    }
    static DWORD Installations(void* raw, CellProvisioningJournal& journal, const CellRuntimeCleanupSet& set,
      const CellRuntimeCleanupAdmission& admission, const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      const auto index = set.anchor.file.file_id[0] - 1;
      if (index > 1 || &journal != (index ? self.current : self.opened) || !wall_ms || wall_ms > 10000 ||
          admission.binding.challenge[0] != index + 1 || self.runtimes[index]) return ERROR_INVALID_STATE;
      ++self.installations[index];
      auto error = guard.authorize(guard.context); if (error) return error;
      if (self.mode == 14) self.denied = true;
      if (self.mode == 15) SetEvent(self.stop);
      return self.mode == 12 && index == 1 ? ERROR_CRC : ERROR_SUCCESS;
    }
    static DWORD Runtime(void* raw, CellProvisioningJournal& journal, const CellRuntimeCleanupSet& set,
      const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      const auto index = set.anchor.file.file_id[0] - 1;
      if (index > 1 || &journal != (index ? self.current : self.opened) || !wall_ms || wall_ms > 10000 ||
          self.installations[index] != 1) return ERROR_INVALID_STATE;
      ++self.runtimes[index];
      auto error = guard.authorize(guard.context); if (error) return error;
      return self.mode == 13 && index == 1 ? ERROR_CRC : ERROR_SUCCESS;
    }
    static DWORD Capture(void* raw, CellCapacityLayout&, const CellCapacityLayoutRecord&,
      std::span<const CellPoolGuestMember> members, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& authority, CellPoolJoinedCapacity* output) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.captures;
      if (members.size() != 2 || self.opens != 1 || !limits.wall_limit_ms || limits.wall_limit_ms > 10000 ||
          self.installations[0] != 1 || self.installations[1] != 1 || self.runtimes[0] != 1 || self.runtimes[1] != 1) return ERROR_INVALID_STATE;
      auto error = authority.authorize(authority.context); if (error) return error;
      for (std::size_t i = 0; i < members.size(); ++i) {
        const auto& member = members[i];
        if (member.host.journal != (i ? self.current : self.opened) || member.host.assignment_binding[0] != i + 1 ||
            member.host.head[0] != 0x77 || member.host.workspace_root.file_id[0] != 16 + i * 8) return ERROR_INVALID_STATE;
        // These are live RAII-owned journal objects, not pointers to a dropped
        // temporary. Disk access is replaced only at this controlled seam.
        if (member.host.journal->Phase() != CellProvisioningPhase::none) return ERROR_INVALID_STATE;
        CellFileIdentity work{7, {}}; work.file_id.fill(static_cast<std::uint8_t>(51 + i * 8));
        if (member.binding.authorize(member.binding.context, member.cell_name, work)) return ERROR_INVALID_STATE;
        work.file_id[0] ^= 1;
        if (member.binding.authorize(member.binding.context, member.cell_name, work) != ERROR_FILE_INVALID ||
            member.binding.authorize(member.binding.context, L"another-cell", work) != ERROR_FILE_INVALID) return ERROR_INVALID_STATE;
      }
      self.bindings_checked = true;
      output->host.backings.resize(self.mode == 11 ? 1 : 2); output->guests.resize(2);
      output->host.backings[0].journal_bytes = 123;
      if (self.mode == 7) self.denied = true;
      return self.mode == 4 ? ERROR_READ_FAULT : ERROR_SUCCESS;
    }
  };
  for (unsigned mode = 0; mode <= 19; ++mode) {
    Owner owner; owner.mode = mode;
    CellProvisioningJournal current; owner.current = &current;
    CellControllerPoolHistory pool; pool.members.resize(2); owner.supplied_pool = &pool;
    for (std::size_t i = 0; i < 2; ++i) {
      auto& member = pool.members[i]; member.wall_ms = 10000;
      member.cell_name = L"gc-cell-" + std::wstring(31, L'0') + static_cast<wchar_t>(L'1' + i);
      member.anchor.file.volume_serial = 7; member.anchor.file.file_id.fill(static_cast<std::uint8_t>(i + 1));
      member.plan.assignment_binding.fill(static_cast<std::uint8_t>(i + 1));
      std::fill_n(member.mounted_workspace_records.back().begin() + 992, 32, std::uint8_t{0x77});
    }
    const auto request = pool.members[1];
    CellRuntimePoolCleanupSet cleanup; cleanup.members.resize(2); cleanup.admissions.resize(2); owner.supplied_cleanup = &cleanup;
    for (std::size_t i = 0; i < 2; ++i) {
      auto& set = cleanup.members[i]; set.anchor = pool.members[i].anchor; set.checkpoint_sha256.fill(0x77);
      set.workspace.parent.volume_serial = 7; set.workspace.parent.file_id.fill(2);
      for (std::size_t j = 0; j < 4; ++j) {
        set.workspace.directories[j].volume_serial = 7;
        set.workspace.directories[j].file_id.fill(static_cast<std::uint8_t>(48 + i * 8 + j));
      }
      cleanup.admissions[i].binding.challenge[0] = static_cast<std::uint8_t>(i + 1);
    }
    if (mode == 17) cleanup.members.pop_back();
    if (mode == 18) cleanup.members[1].anchor.file.file_id[0] ^= 1;
    if (mode == 19) cleanup.members[1].workspace.directories[3].file_id[0] ^= 1;
    Handle stop; stop.value = CreateEventW(nullptr, TRUE, mode == 9, nullptr);
    Check(stop.value != nullptr, "recorded pool cancellation event"); owner.stop = stop.value;
    CellPoolJoinedCapacity output; output.guests.resize(1);
    const auto error = CellPoolCapacityCollectorTestPeer::CaptureRecorded(owner, current, request, pool, cleanup,
      {Owner::Authority, &owner, stop.value}, &output);
    const DWORD expected = mode == 0 || mode == 8 || mode == 16 ? ERROR_SUCCESS : mode == 1 || mode == 7 || mode == 14 ? ERROR_ACCESS_DENIED :
      mode == 2 ? ERROR_FILE_NOT_FOUND : mode == 3 || mode == 6 ? ERROR_CRC : mode == 4 ? ERROR_READ_FAULT :
      mode == 5 ? ERROR_FILE_INVALID : mode == 11 || mode >= 17 ? ERROR_INVALID_DATA : mode == 12 || mode == 13 ? ERROR_CRC : ERROR_CANCELLED;
    Code(error, expected, "recorded pool refuses incomplete, changed, cancelled and revoked evidence");
    if (!error) {
      Check(owner.opens == 1 && owner.captures == 1 && owner.reads[0] == 2 && owner.reads[1] == 2 && owner.bindings_checked &&
        output.host.backings.size() == 2 && output.guests.size() == 2 && output.host.backings[0].journal_bytes == 123,
        "recorded pool reuses current journal, retains other member, freezes inputs and returns whole observation");
    } else {
      Check(output.guests.empty() && output.host.backings.empty(), "recorded pool failure publishes no partial subset");
      if (mode == 1 || mode == 9) Check(owner.opens == 0 && owner.captures == 0, "denied or cancelled pool never opens a journal");
      if (mode == 2 || mode == 3 || mode == 10) Check(owner.captures == 0, "failed admission never starts pool scan");
      if (mode >= 12) Check(owner.captures == 0, "failed cleanup coverage never starts pool scan");
      if (mode == 12) Check(owner.installations[1] == 1 && owner.runtimes[1] == 0, "installation rejection stops that member runtime read");
      if (mode == 13) Check(owner.runtimes[0] == 1 && owner.runtimes[1] == 1, "second member runtime rejection discards earlier coverage");
      if (mode == 14 || mode == 15) Check(owner.runtimes[0] == 0, "authority or cancellation after installation blocks runtime coverage");
      if (mode == 17) Check(owner.opens == 0, "missing cleanup member refuses before journal access");
    }
  }
}
void PoolCleanupCases(const Parent& parent, const CellControllerRequest& supplied) {
  auto request = supplied; PopulateCleanup(request, parent.user);
  std::vector<std::uint8_t> bytes(80 + 40 + 80 + request.cleanup_bytes.size());
  std::memcpy(bytes.data(), "GCPCLN01", 8); Put(bytes.data() + 8, 1); Put(bytes.data() + 12, 1);
  std::copy_n(request.pool_history.begin() + 48, 32, bytes.begin() + 16);
  std::fill_n(bytes.begin() + 48, 32, std::uint8_t{0xdd});
  std::copy(request.plan.assignment_binding.begin(), request.plan.assignment_binding.end(), bytes.begin() + 80);
  Put(bytes.data() + 112, 80); Put(bytes.data() + 116, request.cleanup_bytes.size());
  std::copy_n(request.cleanup_admission.begin(), 80, bytes.begin() + 120);
  std::copy(request.cleanup_bytes.begin(), request.cleanup_bytes.end(), bytes.begin() + 200);
  CellRuntimePoolCleanupSet output;
  Code(DecodeCellRuntimePoolCleanup(bytes, request, parent.user, parent.user, &output), ERROR_SUCCESS,
    "decode full admitted pool cleanup without opening journals or operating a volume");
  Check(output.members.size() == 1 && output.admissions.size() == 1 && output.members[0].anchor == request.anchor &&
    output.members[0].expectations.empty() && output.admissions[0].installations.empty(), "pool cleanup retains explicit empty namespaces");
  const auto refused = [&](const auto& changed) {
    output.members.resize(1); output.admissions.resize(1); output.snapshot_sha256.fill(1);
    Check(DecodeCellRuntimePoolCleanup(changed, request, parent.user, parent.user, &output) != ERROR_SUCCESS &&
      output.members.empty() && output.admissions.empty() && output.snapshot_sha256 == CellFileSha256{},
      "malformed pool cleanup clears all member and admission output");
  };
  for (const auto offset : {0u, 8u, 12u, 16u, 80u, 112u, 116u, 120u, 128u, 160u, 192u, 200u, 208u, 240u, 264u, 296u, 328u, 448u}) {
    auto changed = bytes; changed[offset] ^= 1; refused(changed);
  }
  auto zero = bytes; std::fill_n(zero.begin() + 48, 32, std::uint8_t{}); refused(zero);
  auto short_header = bytes; short_header.resize(79); refused(short_header);
  auto truncated = bytes; truncated.pop_back(); refused(truncated);
  auto extra = bytes; extra.push_back(0); refused(extra);
  auto padded = bytes; padded.insert(padded.begin() + 200, 336, 0); Put(padded.data() + 112, 416); refused(padded);
  auto excessive = bytes; Put(excessive.data() + 116, kMaximumCellRuntimeCleanupBytes + 108); refused(excessive);
  auto stale = request; stale.cleanup_admission[8] ^= 1;
  Check(DecodeCellRuntimePoolCleanup(bytes, stale, parent.user, parent.user, &output) != ERROR_SUCCESS && output.members.empty(),
    "pool cleanup cannot replace independently admitted current challenge");
  Check(DecodeCellRuntimePoolCleanup(bytes, request, L"", parent.user, &output) != ERROR_SUCCESS && output.members.empty(),
    "pool cleanup requires trusted history principals");
  Code(DecodeCellRuntimePoolCleanup(bytes, request, parent.user, parent.user, nullptr), ERROR_INVALID_PARAMETER,
    "pool cleanup requires result destination");
}
void PoolHistoryCases(const Parent& parent, const CellControllerRequest& request) {
  std::vector<std::uint8_t> bytes(kCellControllerPoolHeaderBytes + kCellControllerPoolMemberBytes);
  std::memcpy(bytes.data(), "GCPPOOL1", 8); Put(bytes.data() + 8, 1, 4); Put(bytes.data() + 12, 1, 4);
  std::fill_n(bytes.begin() + 48, 32, std::uint8_t{0xbb});
  std::copy(request.plan.assignment_binding.begin(), request.plan.assignment_binding.end(), bytes.begin() + 80);
  Wire encoded{};
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "Encode independently retained current pool member");
  std::copy_n(encoded.begin() + 176, 24, bytes.begin() + 112);
  std::fill(encoded.begin() + 8, encoded.begin() + 40, std::uint8_t{0});
  std::copy(encoded.begin(), encoded.end(), bytes.begin() + kCellControllerPoolHeaderBytes);
  auto position = kCellControllerPoolHeaderBytes + encoded.size();
  const auto append = [&](const auto& records) { for (const auto& record : records) {
    std::copy(record.begin(), record.end(), bytes.begin() + position); position += record.size();
  } };
  append(request.creation_records); append(request.volume_records); append(request.format_records);
  append(request.protection_records); append(request.mount_records); append(request.mounted_workspace_records);
  CellControllerPoolHistory output;
  Code(DecodeCellControllerPoolHistory(bytes, request, parent.user, parent.user, &output), ERROR_SUCCESS, "Decode complete pool without adopting or opening objects");
  Check(output.members.size() == 1 && output.members[0].nonce == request.nonce &&
    output.members[0].mounted_workspace_records == request.mounted_workspace_records, "Pool history retains exact records with receiver-owned session nonce");
  const auto refused = [&](const auto& changed) {
    Check(DecodeCellControllerPoolHistory(changed, request, parent.user, parent.user, &output) != ERROR_SUCCESS &&
      output.members.empty() && output.snapshot_sha256 == CellFileSha256{}, "Malformed pool clears complete output");
  };
  for (const auto offset : {0u, 8u, 12u, 16u, 80u, 112u, 136u, 144u, 176u, 216u, 336u}) {
    auto changed = bytes; changed[offset] ^= 1; refused(changed);
  }
  for (std::size_t index = 0; index < 21; ++index) {
    auto changed = bytes; changed[kCellControllerPoolHeaderBytes + 256 + index * 1024 + 48] ^= 1; refused(changed);
  }
  auto truncated = bytes; truncated.pop_back(); refused(truncated);
  auto extra = bytes; extra.push_back(0); refused(extra);
  auto duplicated = bytes; Put(duplicated.data() + 8, 2, 4);
  duplicated.insert(duplicated.end(), bytes.begin() + kCellControllerPoolHeaderBytes, bytes.end()); refused(duplicated);
  auto excessive = bytes; Put(excessive.data() + 8, 65, 4); refused(excessive);
  Code(DecodeCellControllerPoolHistory(bytes, request, L"", parent.user, &output), ERROR_INVALID_DATA, "Pool requires trusted original principals");
  Code(DecodeCellControllerPoolHistory(bytes, request, parent.user, parent.user, nullptr), ERROR_INVALID_PARAMETER, "Pool requires result destination");
  CellProvisioningJournal closed;
  CellCapacityLayout layout;
  auto retained_request = request; PopulateCleanup(retained_request, parent.user);
  CellPoolJoinedCapacity captured; captured.guests.resize(1);
  const CellFootprintScanGuard allowed{[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }};
  Code(CellPoolCapacityCollector::CaptureRecorded(INVALID_HANDLE_VALUE, closed, retained_request, parent.user, parent.user,
    layout, {}, {}, allowed, &captured), ERROR_INVALID_STATE, "recorded pool refuses closed original journal without reopening it");
  Check(captured.guests.empty() && captured.host.backings.empty(), "closed original journal clears whole pool capture");
}
void JoinedCapacityWireCases(const Parent& parent, const std::wstring& root,
  const std::vector<CellProvisioningRecord>& records, const CellControllerRequest& request) {
  // Controlled counts over real acknowledged journal identities. No physical
  // volume is attached, formatted or scanned by this codec fixture.
  PoolHistoryCases(parent, request);
  PoolCleanupCases(parent, request);
  CellProvisioningJoinedCapacity value{InventoryFromHistory(records), {BackingCapacityFromHistory(records), {}}};
  CellCapacityLayoutRecord layout{request.plan.assignment_binding, request.plan.profile_sha256, {}};
  CellFileSha256 nonce{}; nonce.fill(0x44);
  for (std::size_t i = 0; i < layout.roots.size(); ++i) {
    auto& id = layout.roots[i]; id.volume_serial = parent.identity.volume_serial;
    id.file_id.fill(0xc0); id.file_id.back() = static_cast<std::uint8_t>(i + 1);
    if (!i) id = value.host.backing.workspace.parent;
    value.host.areas[i].entries.push_back({id, true, 0, 4096});
  }
  for (const auto& id : value.host.backing.workspace.directories) value.host.areas[0].entries.push_back({id, true, 0, 4096});
  const auto& backing = value.host.backing;
  value.host.areas[0].entries.push_back({backing.anchor.file, false, backing.journal_bytes, backing.journal_allocated_bytes});
  value.host.areas[0].entries.push_back({backing.backing.record.backing, false, backing.backing.file_bytes, backing.backing.allocated_bytes});
  const auto recount = [&](CellProvisioningJoinedCapacity& current) {
    for (std::size_t i = 0; i < current.host.areas.size(); ++i) {
      auto& area = current.host.areas[i]; area.footprint = {}; area.footprint.root = layout.roots[i];
      std::sort(area.entries.begin(), area.entries.end(), [](const auto& a, const auto& b) { return a.identity.file_id < b.identity.file_id; });
      for (const auto& entry : area.entries) {
        area.footprint.logical_file_bytes += entry.logical_file_bytes; area.footprint.allocated_bytes += entry.allocated_bytes;
        if (entry.directory) ++area.footprint.directory_count; else ++area.footprint.file_count;
      }
    }
  };
  recount(value);
  CellJoinedCapacityBytes encoded;
  Code(EncodeCellJoinedCapacity(request, parent.user, parent.user, layout, nonce, value, &encoded), ERROR_SUCCESS,
    "joined capture encodes complete separately retained history and host roots");
  CellCapacityLayoutRecord decoded_layout{};
  Code(DecodeCellCapacityLayout(encoded.layout, &decoded_layout), ERROR_SUCCESS, "decode joined layout");
  Check(decoded_layout == layout && encoded.guest_chunks.size() == 2, "layout and multi-chunk guest inventory are retained");
  CellProvisioningFootprint summary;
  CellProvisioningBackingFootprint decoded_backing;
  Check(DecodeCellControllerCapacity(request.nonce, encoded.guest, &summary) && summary.footprint == value.guest.inventory.footprint,
    "guest summary retains exact logical and allocated bytes");
  Check(DecodeCellControllerBackingCapacity(request.nonce, encoded.backing, &decoded_backing) &&
    decoded_backing.backing.record.backing == backing.backing.record.backing &&
    decoded_backing.host_file_allocated_bytes == backing.host_file_allocated_bytes, "backing frame preserves original object and charge");
  std::vector<CellDirectoryInventoryEntry> decoded_entries;
  for (const auto& bytes : encoded.guest_chunks) {
    CellControllerInventoryChunk chunk;
    Check(DecodeCellControllerInventoryChunk(request.nonce, bytes, &chunk) && chunk.start == decoded_entries.size(), "joined chunks are contiguous");
    decoded_entries.insert(decoded_entries.end(), chunk.entries.begin(), chunk.entries.begin() + chunk.count);
  }
  Check(decoded_entries == value.guest.inventory.entries, "joined chunks preserve every guest object");
  JoinedCapacityCollectorCases({request, parent.user, parent.user, layout, nonce, {}}, value, &encoded);
  const auto original = encoded;
  auto pool_request = request; PopulateCleanup(pool_request, parent.user);
  CellPoolJoinedCapacity pool_value; pool_value.host.areas = value.host.areas;
  pool_value.host.backings.push_back(value.host.backing); pool_value.guests.push_back(value.guest);
  CellPoolJoinedCapacityBytes pool_encoded;
  Code(EncodeCellPoolJoinedCapacity(pool_request, parent.user, parent.user, layout, nonce, pool_value, &pool_encoded), ERROR_SUCCESS,
    "encode admitted complete pool with one shared host capture");
  Check(pool_encoded.members.size() == 1 && pool_encoded.host == original.host && pool_encoded.layout == original.layout &&
    pool_encoded.members[0].guest == original.guest && pool_encoded.members[0].guest_chunks == original.guest_chunks &&
    pool_encoded.members[0].backing == original.backing && pool_encoded.pool_sha256[0] == 0xbb,
    "pool encoding preserves exact legacy member bytes and admitted pool provenance");
  const auto reject_pool = [&](const CellPoolJoinedCapacity& observed, const CellControllerRequest& retained) {
    pool_encoded.host.assign(1, 1); pool_encoded.members.resize(1); pool_encoded.pool_sha256.fill(1); pool_encoded.layout.fill(1);
    Check(EncodeCellPoolJoinedCapacity(retained, parent.user, parent.user, layout, nonce, observed, &pool_encoded) != ERROR_SUCCESS,
      "pool output rejects incomplete or altered member evidence");
    Check(pool_encoded.host.empty() && pool_encoded.members.empty() && pool_encoded.pool_sha256 == CellFileSha256{} &&
      pool_encoded.layout == CellCapacityLayoutBytes{}, "pool output failure clears all earlier member and host bytes");
  };
  auto changed_pool = pool_value; changed_pool.guests.clear(); reject_pool(changed_pool, pool_request);
  changed_pool = pool_value; changed_pool.host.backings.clear(); reject_pool(changed_pool, pool_request);
  changed_pool = pool_value; changed_pool.guests.push_back(value.guest); changed_pool.host.backings.push_back(value.host.backing);
  reject_pool(changed_pool, pool_request);
  changed_pool = pool_value; changed_pool.guests[0].checkpoint_sha256[0] ^= 1; reject_pool(changed_pool, pool_request);
  changed_pool = pool_value; changed_pool.host.backings[0].assignment_binding[0] ^= 1; reject_pool(changed_pool, pool_request);
  changed_pool = pool_value; changed_pool.host.areas[0].entries.pop_back(); reject_pool(changed_pool, pool_request);
  auto changed_pool_request = pool_request; changed_pool_request.pool_history.clear(); reject_pool(pool_value, changed_pool_request);
  changed_pool_request = pool_request; changed_pool_request.operation = kCellControllerBackingCapacityOperation; reject_pool(pool_value, changed_pool_request);
  Code(EncodeCellPoolJoinedCapacity(pool_request, parent.user, parent.user, layout, nonce, pool_value, nullptr), ERROR_INVALID_PARAMETER,
    "pool encoding requires an output destination");
  const auto rejected = [&](const CellControllerRequest& history, const CellCapacityLayoutRecord& roots,
      const CellFileSha256& capture, const CellProvisioningJoinedCapacity& observed, const std::wstring& owner, const std::wstring& controller) {
    encoded = original;
    Check(EncodeCellJoinedCapacity(history, owner, controller, roots, capture, observed, &encoded) != ERROR_SUCCESS,
      "joined wire rejects inconsistent history, identities, counts or binding");
    Check(encoded.host.empty() && encoded.guest_chunks.empty() && encoded.layout == CellCapacityLayoutBytes{} &&
      encoded.guest == CellControllerCapacityBytes{} && encoded.backing == CellControllerBackingCapacityBytes{}, "failed join clears all earlier frames");
  };
  for (unsigned index = 0; index < 21; ++index) {
    auto altered = request;
    if (index < 5) altered.creation_records[index].fill(0);
    else if (index < 11) altered.volume_records[index - 5].fill(0);
    else if (index < 13) altered.format_records[index - 11].fill(0);
    else if (index < 15) altered.protection_records[index - 13].fill(0);
    else if (index < 19) altered.mount_records[index - 15].fill(0);
    else altered.mounted_workspace_records[index - 19].fill(0);
    rejected(altered, layout, nonce, value, parent.user, parent.user);
  }
  rejected(request, layout, nonce, value, L"S-1-5-18", parent.user);
  rejected(request, layout, nonce, value, parent.user, L"S-1-5-18");
  rejected(request, layout, {}, value, parent.user, parent.user);
  auto wrong_layout = layout; wrong_layout.assignment_binding[0] ^= 1;
  rejected(request, wrong_layout, nonce, value, parent.user, parent.user);
  wrong_layout = layout; wrong_layout.profile_sha256[0] ^= 1;
  rejected(request, wrong_layout, nonce, value, parent.user, parent.user);
  auto wrong_request = request; wrong_request.nonce.fill(0);
  rejected(wrong_request, layout, nonce, value, parent.user, parent.user);
  wrong_request = request; wrong_request.operation = kCellControllerRuntimeOperation;
  rejected(wrong_request, layout, nonce, value, parent.user, parent.user);
  // Each mutation remains a valid host inventory after recounting; the join
  // must refuse missing or changed original objects, not just malformed sums.
  for (const auto& entry : value.host.areas[0].entries) {
    auto changed = value;
    auto& entries = changed.host.areas[0].entries;
    entries.erase(std::find_if(entries.begin(), entries.end(), [&](const auto& item) { return item.identity == entry.identity; }));
    recount(changed); rejected(request, layout, nonce, changed, parent.user, parent.user);
    if (!entry.directory) {
      changed = value;
      for (auto& item : changed.host.areas[0].entries) if (item.identity == entry.identity) item.allocated_bytes += 4096;
      recount(changed); rejected(request, layout, nonce, changed, parent.user, parent.user);
      changed = value;
      for (auto& item : changed.host.areas[0].entries) if (item.identity == entry.identity) { item.directory = true; item.logical_file_bytes = 0; }
      recount(changed); rejected(request, layout, nonce, changed, parent.user, parent.user);
    }
  }
  auto changed = value; changed.guest.checkpoint_sha256[0] ^= 1;
  rejected(request, layout, nonce, changed, parent.user, parent.user);
  changed = value; changed.host.backing.checkpoint_sha256[0] ^= 1;
  rejected(request, layout, nonce, changed, parent.user, parent.user);
  // The bound applies to the combined observation, even if each half is small
  // enough in isolation. Individual host objects remain unique and sorted.
  changed = value;
  for (unsigned i = 0; i < 19956; ++i) {
    CellFileIdentity id{parent.identity.volume_serial, {}}; id.file_id.fill(0xd0);
    id.file_id[14] = static_cast<std::uint8_t>(i >> 8); id.file_id[15] = static_cast<std::uint8_t>(i);
    changed.host.areas[0].entries.push_back({id, false, 0, 0});
  }
  recount(changed); rejected(request, layout, nonce, changed, parent.user, parent.user);
  changed_pool = pool_value; changed_pool.host.areas = changed.host.areas;
  reject_pool(changed_pool, pool_request);
  changed.host.areas[0].entries.erase(std::find_if(changed.host.areas[0].entries.begin(), changed.host.areas[0].entries.end(),
    [](const auto& entry) { return entry.identity.file_id[0] == 0xd0; }));
  recount(changed);
  Code(EncodeCellJoinedCapacity(request, parent.user, parent.user, layout, nonce, changed, &encoded), ERROR_SUCCESS,
    "exact combined 20000-object boundary is accepted");
  changed_pool.host.areas = changed.host.areas;
  Code(EncodeCellPoolJoinedCapacity(pool_request, parent.user, parent.user, layout, nonce, changed_pool, &pool_encoded), ERROR_SUCCESS,
    "pool encoding accepts exact combined 20000-object boundary");
  // Independently retained acknowledgements are separate from emitted frames.
  const auto write = [&](const wchar_t* name, std::span<const std::uint8_t> bytes) {
    Handle file{CreateFileW((root + L"\\" + name).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
    DWORD count = 0;
    Check(file.value != INVALID_HANDLE_VALUE && WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) &&
      count == bytes.size(), "retain exact joined wire fixture in new task-owned file");
  };
  std::vector<std::uint8_t> history_bytes, chunks;
  for (const auto& record : records) history_bytes.insert(history_bytes.end(), record.begin(), record.end());
  for (const auto& chunk : original.guest_chunks) chunks.insert(chunks.end(), chunk.begin(), chunk.end());
  write(L"joined-history.bin", history_bytes); write(L"joined-layout.bin", original.layout); write(L"joined-host.bin", original.host);
  write(L"joined-guest.bin", original.guest); write(L"joined-backing.bin", original.backing); write(L"joined-chunks.bin", chunks);
}
void InventoryCases(const Parent& parent, const std::wstring& root, const Wire& wire,
  const std::vector<CellProvisioningRecord>& records, CellControllerRequest request) {
  request.operation = kCellControllerInventoryOperation;
  JoinedCapacityWireCases(parent, root, records, request);
  const auto value = InventoryFromHistory(records);
  Wire encoded{};
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user) &&
    MatchesCellControllerInventory(request, value, parent.user, parent.user), "inventory is bound to complete independent history");
  for (unsigned index = 0; index < 21; ++index) {
    auto altered = request;
    if (index < 5) altered.creation_records[index].fill(0);
    else if (index < 11) altered.volume_records[index - 5].fill(0);
    else if (index < 13) altered.format_records[index - 11].fill(0);
    else if (index < 15) altered.protection_records[index - 13].fill(0);
    else if (index < 19) altered.mount_records[index - 15].fill(0);
    else altered.mounted_workspace_records[index - 19].fill(0);
    Check(!MatchesCellControllerInventory(altered, value, parent.user, parent.user), "every independent inventory history record is required");
  }
  for (const auto operation : {1u, 12u, 13u, 14u, 15u}) {
    auto altered = request; altered.operation = operation;
    Check(!MatchesCellControllerInventory(altered, value, parent.user, parent.user), "inventory cannot be relabeled as aggregate or provisioning data");
  }
  Check(!MatchesCellControllerInventory(request, value, L"S-1-5-18", parent.user), "inventory rejects substituted local custody");
  CellControllerNonce nonce{}; nonce.fill(1);
  CellControllerInventoryChunkBytes bytes{}; CellControllerInventoryChunk chunk;
  Check(EncodeCellControllerInventoryChunk(nonce, 20, std::span(value.inventory.entries).subspan(20), &bytes) &&
    DecodeCellControllerInventoryChunk(nonce, bytes, &chunk) && chunk.start == 20 && chunk.count == 6 &&
    std::equal(chunk.entries.begin(), chunk.entries.begin() + 6, value.inventory.entries.begin() + 20), "partial last batch preserves exact identities and counts");
  const auto poison = chunk;
  for (const auto offset : {0u, 36u, 68u, 999u}) {
    auto bad = bytes; bad[offset] ^= 0xff; chunk = poison;
    Check(!DecodeCellControllerInventoryChunk(nonce, bad, &chunk) && chunk == CellControllerInventoryChunk{}, "malformed nonce, count or padding clears the whole chunk");
  }
  Check(!EncodeCellControllerInventoryChunk(nonce, 19999, std::span(value.inventory.entries).first(2), &bytes) && bytes == CellControllerInventoryChunkBytes{},
    "batch cannot exceed the total object bound");
  Check(!EncodeCellControllerInventoryChunk(nonce, 0, std::span(value.inventory.entries).first(21), &bytes) &&
    !EncodeCellControllerInventoryChunk(nonce, 0, {}, &bytes), "oversized and empty batches are refused");
  unsigned authorizations = 0;
  CellControllerClientOwner missing{&authorizations,
    [](void* context) noexcept -> DWORD { ++*static_cast<unsigned*>(context); return ERROR_ACCESS_DENIED; },
    NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
  missing.owner_sid = parent.user; missing.controller_sid = parent.user;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 1000, request, missing), ERROR_INVALID_STATE,
    "missing inventory consumer refuses before pipe access");
  missing.inventory = NativeClient::Inventory; missing.volume_authority = nullptr;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 1000, request, missing), ERROR_INVALID_STATE,
    "missing inventory authority refuses before pipe access");
  Check(!authorizations, "incomplete inventory composition never invokes caller code");
  const auto before = JournalBytes(parent, request.cell_name);
  auto absent = parent; absent.path += L"\\absent-inventory-owner";
  const auto unavailable = Exchange(absent, root, encoded, "native-capacity-missing-owner", &request.volume_records,
    &request.format_records, &request.protection_records, &request.creation_records, &request.mount_records, &request.mounted_workspace_records);
  Check(unavailable.client_error == ERROR_SUCCESS && unavailable.result.error == ERROR_NOT_SUPPORTED &&
    unavailable.result.receipt_acknowledged && !unavailable.result.capacity_written && !unavailable.result.creation_attempted && unavailable.records.empty(),
    "actual controller refuses missing inventory/quiescence owner before opening a nonexistent parent");
  for (const auto mode : {"capacity-good", "capacity-frozen", "capacity-unavailable", "capacity-missing", "capacity-no-authority",
      "capacity-early", "capacity-nonce", "capacity-assignment", "capacity-profile", "capacity-head", "capacity-root", "capacity-wrong-kind",
      "capacity-error", "capacity-count", "capacity-duplicate", "capacity-after-frame", "capacity-no-terminal",
      "capacity-authority-ordinal", "capacity-authority-head", "capacity-authority-count", "capacity-authority-nonce",
      "capacity-denied", "capacity-callback-error", "capacity-callback-revoke", "recover-capacity",
      "capacity-chunk-missing", "capacity-chunk-duplicate", "capacity-chunk-order", "capacity-chunk-nonce", "capacity-chunk-padding",
      "capacity-chunk-count", "capacity-chunk-zero", "capacity-chunk-index", "capacity-chunk-identity", "capacity-chunk-totals", "capacity-chunk-root", "capacity-chunk-extra"})
    VolumeReply(root, wire, records, mode, parent.user, false, true);
  for (const auto mode : {"capacity-good", "capacity-frozen", "capacity-unavailable", "capacity-missing", "capacity-no-terminal",
      "capacity-count", "capacity-error", "capacity-callback-error", "capacity-callback-revoke", "capacity-pool-no-final-authority"})
    VolumeReply(root, wire, records, mode, parent.user, false, false, true);
  Check(JournalBytes(parent, request.cell_name) == before, "inventory transport never changes retained native history");
}
void BackingCapacityCases(const Parent& parent, const std::wstring& root, const Wire& wire,
  const std::vector<CellProvisioningRecord>& records, CellControllerRequest request) {
  request.operation = kCellControllerBackingCapacityOperation;
  const auto value = BackingCapacityFromHistory(records);
  Wire encoded{};
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user) &&
    MatchesCellControllerBackingCapacity(request, value, parent.user, parent.user), "host capacity binds complete history and original host disk identities");
  const auto reject = [&](auto change) {
    auto altered = value; change(altered);
    Check(!MatchesCellControllerBackingCapacity(request, altered, parent.user, parent.user), "host capacity cannot substitute otherwise valid bindings");
  };
  reject([](auto& v) { v.anchor.file.file_id[15] ^= 1; });
  reject([](auto& v) { v.anchor.prepared_sha256[31] ^= 1; });
  reject([](auto& v) { v.assignment_binding[31] ^= 1; });
  reject([](auto& v) { v.profile_sha256[31] ^= 1; });
  reject([](auto& v) { v.checkpoint_sha256[31] ^= 1; });
  reject([](auto& v) { v.workspace.parent.file_id[15] ^= 1; });
  for (unsigned index = 0; index < 4; ++index) reject([&](auto& v) {
    v.workspace.directories[index].file_id[15] ^= 1; v.backing.record.control = v.workspace.directories[1];
  });
  reject([](auto& v) { v.backing.record.backing.file_id[15] ^= 1; });
  reject([](auto& v) { v.backing.record.spec.identifier.Data1 ^= 1; });
  reject([](auto& v) { v.backing.record.spec.reserved_file_bytes += 2 * 1024 * 1024; });
  Check(!MatchesCellControllerBackingCapacity(request, value, L"S-1-5-18", parent.user) &&
    !MatchesCellControllerBackingCapacity(request, value, parent.user, L"S-1-5-18"), "host observations cannot select their own principals");
  for (unsigned index = 0; index < 21; ++index) {
    auto altered = request;
    if (index < 5) altered.creation_records[index].fill(0);
    else if (index < 11) altered.volume_records[index - 5].fill(0);
    else if (index < 13) altered.format_records[index - 11].fill(0);
    else if (index < 15) altered.protection_records[index - 13].fill(0);
    else if (index < 19) altered.mount_records[index - 15].fill(0);
    else altered.mounted_workspace_records[index - 19].fill(0);
    Check(!MatchesCellControllerBackingCapacity(altered, value, parent.user, parent.user), "host observation requires every independent history record");
  }
  for (const auto operation : {1u, 12u, 13u, 14u, 16u}) {
    auto altered = request; altered.operation = operation;
    Check(!MatchesCellControllerBackingCapacity(altered, value, parent.user, parent.user), "host observation cannot be relabelled as another operation");
  }
  auto over_deadline = request; over_deadline.wall_ms = 60001;
  Check(!EncodeCellControllerRequest(over_deadline, &encoded, parent.user, parent.user), "host observation preserves the shorter deadline");
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "encode bounded host observation");
  unsigned authorizations = 0;
  CellControllerClientOwner missing{&authorizations,
    [](void* context) noexcept -> DWORD { ++*static_cast<unsigned*>(context); return ERROR_ACCESS_DENIED; },
    NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
  missing.owner_sid = parent.user; missing.controller_sid = parent.user; missing.capacity = NativeClient::Capacity;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 1000, request, missing), ERROR_INVALID_STATE,
    "a mounted-tree consumer cannot stand in for a host observation consumer");
  missing.backing_capacity = NativeClient::BackingCapacity; missing.volume_authority = nullptr;
  Code(RunCellControllerClientSession(nullptr, nullptr, GetTickCount64() + 1000, request, missing), ERROR_INVALID_STATE,
    "host observations require canonical authority before IO");
  Check(authorizations == 0, "host callback composition is checked before caller callbacks");
  const auto before = JournalBytes(parent, request.cell_name);
  auto absent = parent; absent.path += L"\\absent-host-capacity-owner";
  const auto unavailable = Exchange(absent, root, encoded, "native-capacity-missing-owner", &request.volume_records,
    &request.format_records, &request.protection_records, &request.creation_records, &request.mount_records, &request.mounted_workspace_records);
  Check(unavailable.client_error == ERROR_SUCCESS && unavailable.result.error == ERROR_NOT_SUPPORTED && unavailable.result.receipt_acknowledged &&
    !unavailable.result.capacity_written && !unavailable.result.creation_attempted && unavailable.records.empty(),
    "actual controller refuses missing host quiescence owner before even opening its parent");
  for (const auto mode : {"capacity-good", "capacity-frozen", "capacity-unavailable", "capacity-missing", "capacity-no-authority",
      "capacity-early", "capacity-nonce", "capacity-assignment", "capacity-profile", "capacity-head", "capacity-root", "capacity-wrong-kind",
      "capacity-error", "capacity-count", "capacity-duplicate", "capacity-after-frame", "capacity-no-terminal",
      "capacity-authority-ordinal", "capacity-authority-head", "capacity-authority-count", "capacity-authority-nonce",
      "capacity-denied", "capacity-callback-error", "capacity-callback-revoke", "recover-capacity"})
    VolumeReply(root, wire, records, mode, parent.user, true);
  VolumeReply(root, wire, records, "capacity-wrong-kind", parent.user);
  Check(JournalBytes(parent, request.cell_name) == before, "host protocol cases preserve every native journal byte");
}
void RuntimePeerReply(const Parent& parent, const std::wstring& root, CellControllerRequest request, unsigned mode) {
  // Real private pipe and production client; the recovered server and runtime
  // callback are controlled here. Never bypass the production journal reopen.
  const auto sequence = ++sessions; ++native_client_sessions;
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatRuntimePeer-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value && done.value, "Create owned runtime peer fixtures");
  std::vector<CellProvisioningRecord> records;
  const auto append = [&](const auto& rows) { records.insert(records.end(), rows.begin(), rows.end()); };
  append(request.creation_records); append(request.volume_records); append(request.format_records); append(request.protection_records);
  append(request.mount_records); append(request.mounted_workspace_records);
  if (mode >= 10) request.wall_ms = mode == 10 ? 600000 : mode == 11 ? 600001 : 86400000;
  const auto expected = request.runtime; const auto deadline = GetTickCount64() + 8000;
  std::exception_ptr server_error;
  std::jthread thread([&] {
    try {
      Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "Runtime peer connected");
      CellControllerNonce hello{}, nonce{}; nonce.fill(0x72);
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::hello, hello.data(), 32, stop.value, deadline), ERROR_SUCCESS, "Read runtime hello");
      std::array<std::uint8_t, 64> welcome{}; std::copy(hello.begin(), hello.end(), welcome.begin()); std::copy(nonce.begin(), nonce.end(), welcome.begin() + 32);
      Code(WriteCellControllerMessage(server.value, CellControllerMessage::welcome, welcome.data(), 64, stop.value, deadline), ERROR_SUCCESS, "Write runtime welcome");
      Wire wire{}; Code(ReadCellControllerMessage(server.value, CellControllerMessage::request, wire.data(), 256, stop.value, deadline), ERROR_SUCCESS, "Read runtime request");
      Check(U32(wire.data()) == kCellControllerRuntimeOperation, "Runtime peer receives explicit operation 17");
      for (const auto [kind, count] : {std::pair{CellControllerMessage::volume_history, kCellControllerVolumeHistoryBytes},
        std::pair{CellControllerMessage::format_history, kCellControllerFormatHistoryBytes}, std::pair{CellControllerMessage::protection_history, kCellControllerProtectionHistoryBytes},
        std::pair{CellControllerMessage::mount_history, kCellControllerMountHistoryBytes}, std::pair{CellControllerMessage::mounted_workspace_history, kCellControllerMountedWorkspaceHistoryBytes}}) {
        std::vector<std::uint8_t> history(count);
        Code(ReadCellControllerMessage(server.value, kind, history.data(), static_cast<DWORD>(count), stop.value, deadline), ERROR_SUCCESS, "Read complete runtime recovery history");
        Check(std::equal(nonce.begin(), nonce.end(), history.begin()), "Runtime history uses the current connection nonce");
      }
      CellControllerRuntimeBindingBytes ready{}; CellControllerRuntimeBinding received;
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::runtime_binding, ready.data(), 128, stop.value, deadline), ERROR_SUCCESS, "Read independent runtime proposal");
      Check(DecodeCellControllerRuntimeBinding(nonce, ready, &received) && received == expected, "Runtime proposal preserves independent admission binding");
      for (unsigned i = 0; i < (mode == 3 ? 20u : 21u); ++i) {
        std::array<std::uint8_t, 1056> checkpoint{}; std::copy(nonce.begin(), nonce.end(), checkpoint.begin());
        std::copy(records[i].begin(), records[i].end(), checkpoint.begin() + 32);
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::checkpoint, checkpoint.data(), 1056, stop.value, deadline), ERROR_SUCCESS, "Send exact recovered checkpoint");
      }
      if (mode != 3 && mode != 4) {
        std::array<std::uint8_t, 72> challenge{}, reply{}; std::copy(nonce.begin(), nonce.end(), challenge.begin());
        Put(challenge.data() + 32, 1, 4); Put(challenge.data() + 36, 21, 4); std::copy(expected.checkpoint_sha256.begin(), expected.checkpoint_sha256.end(), challenge.begin() + 40);
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::volume_authority, challenge.data(), 72, stop.value, deadline), ERROR_SUCCESS, "Recheck current canonical chain");
        const auto error = ReadCellControllerMessage(server.value, CellControllerMessage::volume_authorized, reply.data(), 72, stop.value, deadline);
        if (mode == 8) { Check(error != 0, "Denied authority receives no acknowledgement"); return; }
        Check(!error && reply == challenge, "Current canonical challenge matches exactly");
      }
      if (mode == 1) ready[64] ^= 1;
      if (mode == 2) ready[96] ^= 1;
      Code(WriteCellControllerMessage(server.value, CellControllerMessage::runtime_ready, ready.data(), 128, stop.value, deadline), ERROR_SUCCESS, "Send separate runtime handoff");
      if (mode == 5) Code(WriteCellControllerMessage(server.value, CellControllerMessage::runtime_ready, ready.data(), 128, stop.value, deadline), ERROR_SUCCESS, "Send forbidden repeated handoff");
      if (mode == 0 || mode == 7 || mode >= 10) {
        std::array<std::uint8_t, 48> receipt{}; std::copy(nonce.begin(), nonce.end(), receipt.begin()); Put(receipt.data() + 36, 5, 4); Put(receipt.data() + 44, 21, 4);
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::receipt, receipt.data(), 48, stop.value, deadline), ERROR_SUCCESS, "Send separate terminal receipt");
        CellControllerNonce finish{}; Code(ReadCellControllerMessage(server.value, CellControllerMessage::finish, finish.data(), 32, stop.value, deadline), ERROR_SUCCESS, "Read runtime finish");
        Check(finish == nonce, "Runtime finish matches connection");
      }
      Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "Runtime peer ends after one handoff");
    } catch (...) { server_error = std::current_exception(); SetEvent(stop.value); }
  });
  Handle pipe{CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Check(pipe.value != INVALID_HANDLE_VALUE, "Connect runtime client"); Outcome outcome;
  NativeClient client{{}, root, sequence, outcome, stop.value, mode == 6 ? "native-runtime-client-unretained" : mode == 8 ? "runtime-denied" : mode == 9 ? "runtime-other-result" : "runtime-peer"};
  Code(client.server.Open(pipe.value), ERROR_SUCCESS, "Authenticate runtime peer"); client.retained = &records;
  CellControllerClientOwner owner{&client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt, NativeClient::VolumeAuthority};
  owner.owner_sid = parent.user; owner.controller_sid = parent.user; owner.run_runtime = NativeClient::Runtime;
  if (mode == 7) { client.mutable_request = &request; client.mutable_owner = &owner; }
  const auto error = RunCellControllerClientSession(pipe.value, stop.value, mode >= 10 ? GetTickCount64() + request.wall_ms : deadline, request, owner);
  if (mode >= 10 && error) std::fprintf(stderr, "Long runtime mode %u client error: %lu\n", mode, error);
  SetEvent(done.value); client.server.Close(); pipe.Close(); thread.join(); if (server_error) std::rethrow_exception(server_error);
  Check(mode == 0 || mode == 7 || mode >= 10 ? !error && client.received : error && !client.received, "Only a complete exact runtime handoff may finish");
  Check(outcome.client_runtime_calls == ((mode == 0 || mode == 5 || mode == 6 || mode == 7 || mode == 9 || mode >= 10) ? 1u : 0u), "Runtime callback occurs at most once and only after all admission metadata checks");
}
void RuntimeHandoffCases(const Parent& parent, const std::wstring& root, CellControllerRequest request) {
  request.operation = kCellControllerRuntimeOperation;
  request.runtime.nonce.fill(0x31); request.runtime.request_sha256.fill(0x42);
  std::copy_n(request.mounted_workspace_records.back().begin() + 992, 32, request.runtime.checkpoint_sha256.begin());
  Wire wire{};
  Check(!IsCellControllerCreation(request.operation) && !IsCellControllerCapacity(request.operation) && CellControllerCheckpointLimit(request.operation) == 21,
    "Runtime handoff is separate from provisioning and requires all 21 records");
  Check(EncodeCellControllerRequest(request, &wire, parent.user, parent.user), "Bound runtime recovery request encodes");
  const auto before = JournalBytes(parent, request.cell_name);
  CellControllerRuntimeBindingBytes binding{}; CellControllerRuntimeBinding decoded;
  Check(EncodeCellControllerRuntimeBinding(request.nonce, request.runtime, &binding) &&
    DecodeCellControllerRuntimeBinding(request.nonce, binding, &decoded) && decoded == request.runtime, "Runtime handoff binds the connection and independent dispatch");
  for (unsigned offset : {0u, 32u, 64u, 96u}) {
    auto bad = binding; std::fill_n(bad.begin() + offset, 32, std::uint8_t{0}); decoded = request.runtime;
    Check(!DecodeCellControllerRuntimeBinding(request.nonce, bad, &decoded) && decoded == CellControllerRuntimeBinding{}, "Missing handoff identity clears all output");
  }
  for (unsigned index = 0; index < 21; ++index) {
    auto bad = request;
    if (index < 5) bad.creation_records[index].fill(0);
    else if (index < 11) bad.volume_records[index - 5].fill(0);
    else if (index < 13) bad.format_records[index - 11].fill(0);
    else if (index < 15) bad.protection_records[index - 13].fill(0);
    else if (index < 19) bad.mount_records[index - 15].fill(0);
    else bad.mounted_workspace_records[index - 19].fill(0);
    Wire rejected{}; Check(!EncodeCellControllerRequest(bad, &rejected, parent.user, parent.user), "Every independently retained runtime journal record is required");
  }
  for (unsigned mode = 0; mode < 3; ++mode) {
    auto bad = request;
    if (mode == 0) bad.runtime.checkpoint_sha256[0] ^= 1;
    if (mode == 1) bad.operation = 12;
    if (mode == 2) bad.wall_ms = 86400001;
    Wire rejected{}; Check(!EncodeCellControllerRequest(bad, &rejected, parent.user, parent.user), "Wrong journal head, relabeled recovery and unbounded runtime refuse");
  }
  const char* modes[] = {"native-runtime-present-owner", "native-runtime-missing-owner", "native-runtime-client-missing-owner"};
  DWORD mounted_refusal = ERROR_SUCCESS;
  for (unsigned mode = 0; mode < 3; ++mode) {
    const auto result = Exchange(parent, root, wire, modes[mode], &request.volume_records, &request.format_records, &request.protection_records,
      &request.creation_records, &request.mount_records, &request.mounted_workspace_records, &request.runtime);
    Check(!result.result.creation_attempted, "Runtime handoff never creates or resumes provisioning");
    Check(result.result.error && !result.result.runtime_retained && !result.result.runtime_attempted && result.server_runtime_calls == 0 && result.client_runtime_calls == 0,
      "Missing owner or unmounted fixture journal refuses before runtime dispatch");
    if (!mode) mounted_refusal = result.result.error;
  }
  auto long_request = request; long_request.wall_ms = 86400000;
  Wire long_wire{}; Check(EncodeCellControllerRequest(long_request, &long_wire, parent.user, parent.user), "Long runtime retains the complete request contract");
  const auto long_result = Exchange(parent, root, long_wire, "native-runtime-long-owner", &request.volume_records, &request.format_records,
    &request.protection_records, &request.creation_records, &request.mount_records, &request.mounted_workspace_records, &request.runtime);
  Check(long_result.result.error == mounted_refusal && long_result.result.receipt_acknowledged && !long_result.result.runtime_attempted,
    "Long server setup reaches the same real mounted-journal refusal and completes its bounded receipt");
  for (unsigned mode = 0; mode < 13; ++mode) RuntimePeerReply(parent, root, request, mode);
  Check(JournalBytes(parent, request.cell_name) == before, "Runtime handoff preserves all native journal bytes");
}
void InstallationPeer(const Parent& parent, const std::wstring& root, CellControllerRequest request, unsigned mode, unsigned capacity_mode = 0) {
  const auto sequence = ++sessions; ++native_client_sessions;
  const auto name = L"\\\\.\\pipe\\LOCAL\\GoatInstallPeer-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence);
  Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(server.value != INVALID_HANDLE_VALUE && stop.value && done.value, "Create installation peer fixtures");
  std::vector<CellProvisioningRecord> records;
  const auto append = [&](const auto& rows) { records.insert(records.end(), rows.begin(), rows.end()); };
  append(request.creation_records); append(request.volume_records); append(request.format_records); append(request.protection_records);
  append(request.mount_records); append(request.mounted_workspace_records);
  const auto expected = request.installation; const auto deadline = GetTickCount64() + 8000;
  std::exception_ptr server_error;
  std::jthread thread([&] {
    try {
      Code(ConnectCellPipe(server.value, stop.value, deadline), ERROR_SUCCESS, "Connect installation peer");
      CellControllerNonce hello{}, nonce{}; nonce.fill(0x72);
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::hello, hello.data(), 32, stop.value, deadline), ERROR_SUCCESS, "Read installation hello");
      std::array<std::uint8_t, 64> welcome{}; std::copy(hello.begin(), hello.end(), welcome.begin()); std::copy(nonce.begin(), nonce.end(), welcome.begin() + 32);
      Code(WriteCellControllerMessage(server.value, CellControllerMessage::welcome, welcome.data(), 64, stop.value, deadline), ERROR_SUCCESS, "Send installation welcome");
      Wire wire{}; Code(ReadCellControllerMessage(server.value, CellControllerMessage::request, wire.data(), 256, stop.value, deadline), ERROR_SUCCESS, "Read installation request");
      Check(U32(wire.data()) == request.operation, "Installation or recovery uses its exact operation");
      for (const auto [kind, count] : {std::pair{CellControllerMessage::volume_history, kCellControllerVolumeHistoryBytes},
        std::pair{CellControllerMessage::format_history, kCellControllerFormatHistoryBytes}, std::pair{CellControllerMessage::protection_history, kCellControllerProtectionHistoryBytes},
        std::pair{CellControllerMessage::mount_history, kCellControllerMountHistoryBytes}, std::pair{CellControllerMessage::mounted_workspace_history, kCellControllerMountedWorkspaceHistoryBytes}}) {
        std::vector<std::uint8_t> history(count);
        Code(ReadCellControllerMessage(server.value, kind, history.data(), static_cast<DWORD>(count), stop.value, deadline), ERROR_SUCCESS, "Read installation recovery history");
        Check(std::equal(nonce.begin(), nonce.end(), history.begin()), "Bind installation history connection");
      }
      CellControllerRuntimeBindingBytes binding{}; CellControllerRuntimeBinding received;
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::install_binding, binding.data(), 128, stop.value, deadline), ERROR_SUCCESS, "Read installation binding");
      Check(DecodeCellControllerRuntimeBinding(nonce, binding, &received) && received == expected, "Preserve independent installation binding");
      std::array<std::uint8_t, kCellRuntimeInstallBytes> body{};
      Code(ReadCellControllerMessage(server.value, CellControllerMessage::install_request, body.data(), static_cast<DWORD>(body.size()), stop.value, deadline), ERROR_SUCCESS, "Read exact installation frame");
      Check(body == request.installation_bytes, "Installation body is frozen");
      for (unsigned index = 0; index < (mode == 8 ? 20u : 21u); ++index) {
        std::array<std::uint8_t, 1056> checkpoint{}; std::copy(nonce.begin(), nonce.end(), checkpoint.begin());
        std::copy(records[index].begin(), records[index].end(), checkpoint.begin() + 32);
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::checkpoint, checkpoint.data(), 1056, stop.value, deadline), ERROR_SUCCESS, "Send recovered installation checkpoint");
      }
      if (mode != 9) {
        std::array<std::uint8_t, 136> challenge{}, reply{};
        std::copy(nonce.begin(), nonce.end(), challenge.begin());
        std::copy(expected.nonce.begin(), expected.nonce.end(), challenge.begin() + 32);
        std::copy(expected.request_sha256.begin(), expected.request_sha256.end(), challenge.begin() + 64);
        std::copy(expected.checkpoint_sha256.begin(), expected.checkpoint_sha256.end(), challenge.begin() + 96);
        Put(challenge.data() + 128, 1, 4); Put(challenge.data() + 132, 1, 4);
        if (mode == 2) challenge[32] ^= 1;
        if (mode == 3) challenge[64] ^= 1;
        if (mode == 4) challenge[96] ^= 1;
        if (mode == 5) Put(challenge.data() + 128, 2, 4);
        if (mode == 6) Put(challenge.data() + 132, 2, 4);
        if (mode == 11) challenge[0] ^= 1;
        if (mode == 10) Code(WriteCellControllerMessage(server.value, CellControllerMessage::volume_authority, challenge.data(), 72, stop.value, deadline), ERROR_SUCCESS, "Volume authority cannot substitute for installation authority");
        else Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_authority, challenge.data(), 136, stop.value, deadline), ERROR_SUCCESS, "Send installation challenge");
        if (mode == 0 || mode == 7 || mode >= 12) {
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::install_authorized, reply.data(), 136, stop.value, deadline), ERROR_SUCCESS, "Receive exact installation authorization");
          Check(reply == challenge, "Installation reply matches entire challenge");
          if (mode == 0 || mode >= 12) Put(challenge.data() + 128, 2, 4);
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_authority, challenge.data(), 136, stop.value, deadline), ERROR_SUCCESS, "Send next or replayed installation challenge");
          if (mode == 0 || mode >= 12) {
            Code(ReadCellControllerMessage(server.value, CellControllerMessage::install_authorized, reply.data(), 136, stop.value, deadline), ERROR_SUCCESS, "Receive final installation authorization");
            Check(reply == challenge, "Final installation reply matches");
          }
        }
      }
      if (mode == 0 || mode >= 13) {
        CellInstallCapacityChallenge capacity_challenge{};
        if (capacity_mode && capacity_mode != 2) {
          std::vector<std::uint8_t> capture(1312); std::memcpy(capture.data(), "GCPRESP1", 8);
          std::copy(nonce.begin(), nonce.end(), capture.begin() + 24); capture.back() = 0xab;
          CellInstallCapacityBinding capture_binding{nonce, {expected.nonce, expected.request_sha256}, {}, 1312};
          Code(HashCellInstallCapacityCapture(capture, &capture_binding.capture_sha256), ERROR_SUCCESS, "Hash controlled dispatch capture");
          Check(EncodeCellInstallCapacityChallenge(capture_binding, 1, &capacity_challenge), "Bind dispatch capture");
          Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_capacity_capture, capacity_challenge.data(), 144, stop.value, deadline), ERROR_SUCCESS, "Send dispatch capture header");
          CellFootprintScanGuard local{[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, stop.value};
          Code(WriteCellPoolCapacityResponse(server.value, deadline, nonce, local, capture), ERROR_SUCCESS, "Send complete controlled capture");
          if (capacity_mode == 3) {
            Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "Denied admission terminates client"); return;
          }
          CellInstallCapacityPipe channel(server.value, stop.value, deadline, capture_binding, local);
          Code(channel.Request(), ERROR_SUCCESS, "Initial reservation challenge through client dispatch");
          if (capacity_mode == 4) {
            Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_capacity_capture, capacity_challenge.data(), 144, stop.value, deadline), ERROR_SUCCESS, "Reject repeated capture");
            Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "Repeated capture terminates client"); return;
          }
          Code(channel.Request(), ERROR_SUCCESS, "Later reservation challenge through main loop");
        }
        std::array<std::uint8_t, 384> evidence{}; std::copy(nonce.begin(), nonce.end(), evidence.begin());
        std::copy(expected.nonce.begin(), expected.nonce.end(), evidence.begin() + 40);
        std::copy(expected.request_sha256.begin(), expected.request_sha256.end(), evidence.begin() + 72);
        std::copy(expected.checkpoint_sha256.begin(), expected.checkpoint_sha256.end(), evidence.begin() + 104);
        std::fill(evidence.begin() + 352, evidence.end(), std::uint8_t{0x99});
        if (mode == 13) evidence[40] ^= 1;
        if (mode == 14) evidence[72] ^= 1;
        if (mode == 15) evidence[104] ^= 1;
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_outcome, evidence.data(), 384, stop.value, deadline), ERROR_SUCCESS, "Send installation evidence");
        if (capacity_mode == 2) {
          Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "Missing capture rejects successful outcome"); return;
        }
        if (mode == 0 || mode == 17) {
          std::array<std::uint8_t, 64> ack{};
          Code(ReadCellControllerMessage(server.value, CellControllerMessage::install_outcome_received, ack.data(), 64, stop.value, deadline), ERROR_SUCCESS, "Receive validated evidence hash");
          Check(std::equal(nonce.begin(), nonce.end(), ack.begin()) && std::equal(evidence.begin() + 352, evidence.end(), ack.begin() + 32), "Exact evidence acknowledgement");
          if (capacity_mode == 5) {
            Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_capacity_authority, capacity_challenge.data(), 144, stop.value, deadline), ERROR_SUCCESS, "Reject post-outcome reservation challenge");
            Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "Late challenge terminates client"); return;
          }
          if (mode == 17) Code(WriteCellControllerMessage(server.value, CellControllerMessage::install_outcome, evidence.data(), 384, stop.value, deadline), ERROR_SUCCESS, "Refuse repeated evidence");
        }
      }
      if (mode == 0 || mode == 9 || mode == 12) {
        std::array<std::uint8_t, 48> receipt{}; std::copy(nonce.begin(), nonce.end(), receipt.begin()); Put(receipt.data() + 36, 5, 4); Put(receipt.data() + 44, 21, 4);
        Code(WriteCellControllerMessage(server.value, CellControllerMessage::receipt, receipt.data(), 48, stop.value, deadline), ERROR_SUCCESS, "Send installation receipt");
        if (mode == 0 && capacity_mode != 6) {
          CellControllerNonce finish{}; Code(ReadCellControllerMessage(server.value, CellControllerMessage::finish, finish.data(), 32, stop.value, deadline), ERROR_SUCCESS, "Read installation finish");
          Check(finish == nonce, "Installation finish binds connection");
        }
      }
      Check(WaitForSingleObject(done.value, 3000) == WAIT_OBJECT_0, "Installation client finishes or refuses");
    } catch (...) { server_error = std::current_exception(); SetEvent(stop.value); }
  });
  Handle pipe{CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Check(pipe.value != INVALID_HANDLE_VALUE, "Connect installation client"); Outcome outcome;
  NativeClient client{{}, root, sequence, outcome, stop.value, mode == 1 ? "installation-denied" : mode == 16 ? "installation-outcome-denied" : "installation-peer"};
  Code(client.server.Open(pipe.value), ERROR_SUCCESS, "Authenticate installation peer"); client.retained = &records;
  client.installation_expected = {expected.nonce, expected.request_sha256};
  client.install_capacity_mode = capacity_mode;
  CellControllerClientOwner owner{&client, NativeClient::Authorize, NativeClient::Checkpoint, NativeClient::Receipt};
  owner.owner_sid = parent.user; owner.controller_sid = parent.user; owner.installation_authority = NativeClient::Installation;
  owner.installation_outcome = NativeClient::InstallationOutcome;
  if (capacity_mode) {
    owner.connection = NativeClient::Connected;
    owner.installation_capacity = {&client, NativeClient::ReserveInstall};
  }
  const auto error = RunCellControllerClientSession(pipe.value, stop.value, deadline, request, owner);
  SetEvent(done.value); client.server.Close(); pipe.Close(); thread.join(); if (server_error) std::rethrow_exception(server_error);
  Check(mode == 0 && capacity_mode <= 1 ? !error && client.received : error && !client.received, "Only exact authorized installation receipt succeeds");
  Check(client.installation_calls == (mode == 0 || mode >= 12 ? 2u : mode == 1 || mode == 7 ? 1u : 0u), "Invalid installation challenges never reach authority owner");
  Check(client.installation_outcomes == ((mode == 0 || mode == 16 || mode == 17) && !(capacity_mode >= 2 && capacity_mode <= 4) ? 1u : 0u), "Evidence validation owner receives one exact bound record only");
  if (capacity_mode) {
    Check(client.connections == 1, "Authenticated connection precedes installation evidence");
    Check(client.install_reserves == (capacity_mode == 2 ? 0u : 1u), "Dispatch admits capture exactly once");
    Check(client.install_releases == (capacity_mode == 2 || capacity_mode == 3 ? 0u : 1u), "Dispatch releases reservation once on terminal success or failure");
    Check(client.install_verifies == (capacity_mode == 2 || capacity_mode == 3 ? 0u : capacity_mode == 4 ? 1u : 2u), "Only ordered pre-outcome challenges reach reservation");
  }
}
CellControllerRequest InstallationRequest(CellControllerRequest request) {
  request.operation = kCellControllerInstallOperation;
  auto& bytes = request.installation_bytes; std::memcpy(bytes.data(), "GCRINST1", 8);
  request.installation.nonce.fill(0x31); std::copy(request.installation.nonce.begin(), request.installation.nonce.end(), bytes.begin() + 8);
  Put(bytes.data() + 40, request.anchor.file.volume_serial, 8); std::copy(request.anchor.file.file_id.begin(), request.anchor.file.file_id.end(), bytes.begin() + 48);
  std::copy(request.anchor.prepared_sha256.begin(), request.anchor.prepared_sha256.end(), bytes.begin() + 64);
  std::copy_n(request.mounted_workspace_records.back().begin() + 992, 32, request.installation.checkpoint_sha256.begin());
  std::copy(request.installation.checkpoint_sha256.begin(), request.installation.checkpoint_sha256.end(), bytes.begin() + 96);
  std::fill(bytes.begin() + 128, bytes.begin() + 160, std::uint8_t{0x55});
  std::vector<CellRuntimeBundleFile> files{{L"node.exe", 100, {}}, {L"worker-host-receipt.json", 20, {}}};
  files[0].sha256.fill(0x66); files[1].sha256.fill(0x77); CellFileSha256 digest{};
  Code(HashRuntimeBundleManifest(files, &digest), ERROR_SUCCESS, "Hash installation fixture inventory");
  std::copy(digest.begin(), digest.end(), bytes.begin() + 160);
  for (unsigned index = 0; index < 2; ++index) { Put(bytes.data() + 192 + index * 40, files[index].bytes, 8); std::copy(files[index].sha256.begin(), files[index].sha256.end(), bytes.begin() + 200 + index * 40); }
  Code(HashCellRuntimeInstall(bytes, &request.installation.request_sha256), ERROR_SUCCESS, "Bind installation request");
  return request;
}
void InstallationCases(const Parent& parent, const std::wstring& root, CellControllerRequest request) {
  request = InstallationRequest(std::move(request));
  Wire encoded{}; Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "Encode installation with full independent history");
  unsigned unexpected_callbacks = 0;
  CellControllerClientOwner missing;
  missing.context = &unexpected_callbacks;
  missing.authorize = [](void* context) noexcept -> DWORD { ++*static_cast<unsigned*>(context); return ERROR_SUCCESS; };
  missing.checkpoint = [](void*, const CellProvisioningRecord&, bool, CellFileSha256*) noexcept -> DWORD { return ERROR_ACCESS_DENIED; };
  missing.receipt = [](void*, const std::array<std::uint8_t, 16>&) noexcept -> DWORD { return ERROR_ACCESS_DENIED; };
  missing.owner_sid = parent.user; missing.controller_sid = parent.user;
  Check(RunCellControllerClientSession(INVALID_HANDLE_VALUE, nullptr, GetTickCount64() + 8000, request, missing) == ERROR_INVALID_STATE && !unexpected_callbacks,
    "Missing installation authority refuses before endpoint callbacks or connection");
  const auto before = JournalBytes(parent, request.cell_name);
  for (unsigned mode = 0; mode < 18; ++mode) InstallationPeer(parent, root, request, mode);
  for (unsigned mode = 1; mode <= 6; ++mode) InstallationPeer(parent, root, request, 0, mode);
  request.operation = kCellControllerInstallCapacityOperation;
  Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "Encode combined controller request");
  const auto combined = Exchange(parent, root, encoded, "native-install-combined-missing-owner",
    &request.volume_records, &request.format_records, &request.protection_records, &request.creation_records,
    &request.mount_records, &request.mounted_workspace_records, nullptr, &request);
  Check(!combined.client_error && combined.result.error == ERROR_NOT_SUPPORTED && combined.result.receipt_acknowledged &&
    !combined.result.installation_attempted && !combined.server_install_calls && !combined.hold_calls,
    "Combined metadata reaches server and missing combined owner cannot fall back to legacy copy");
  request.operation = kCellControllerInstallRecoveryOperation;
  for (unsigned mode = 0; mode < 18; ++mode) InstallationPeer(parent, root, request, mode);
  // The real controller must refuse this controlled, non-installed journal.
  // Exercise both an absent copy owner and a trap owner; neither may run.
  // Successful local record reads are proven by the separate outcome fixture.
  for (unsigned mode = 0; mode < 2; ++mode) {
    Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "Encode read-only recovery");
    const auto recovered = Exchange(parent, root, encoded, mode ? "native-install-no-owner" : "native-install-recovery",
      &request.volume_records, &request.format_records, &request.protection_records, &request.creation_records,
      &request.mount_records, &request.mounted_workspace_records, nullptr, &request);
    Check(!recovered.result.installation_attempted && !recovered.server_install_calls && !recovered.result.creation_attempted,
      "Refused recovery never invokes copy or provisioning callbacks");
    Check(recovered.result.error && !recovered.result.installation_retained, "Non-installed journal cannot establish recovery success");
  }
  request.operation = kCellControllerInstallOperation;
  for (const auto mode : {"native-install-no-owner", "native-install-missing-hold", "native-install-denied-hold",
      "native-install-null-hold", "native-install-revoked-hold", "native-install-held"}) {
    Check(EncodeCellControllerRequest(request, &encoded, parent.user, parent.user), "Encode guarded installation");
    const auto result = Exchange(parent, root, encoded, mode,
      &request.volume_records, &request.format_records, &request.protection_records, &request.creation_records,
      &request.mount_records, &request.mounted_workspace_records, nullptr, &request);
    Check(result.result.error && !result.result.installation_attempted && !result.server_install_calls &&
      !result.result.creation_attempted && !result.result.installation_retained, "Installation refusal cannot copy or create resources");
    const bool missing_owner = !std::strcmp(mode, "native-install-no-owner") || !std::strcmp(mode, "native-install-missing-hold");
    Check(result.hold_calls == (missing_owner ? 0u : 1u), "Installation requires exactly one exclusion acquisition");
    const bool held = !std::strcmp(mode, "native-install-revoked-hold") || !std::strcmp(mode, "native-install-held");
    Check(result.hold_releases == (held ? 1u : 0u), "Installation exclusion is released on refusal");
    Check(held ? result.hold_checks > 0 : result.hold_checks == 0, "Retained exclusion is checked before journal access");
    if (missing_owner) Code(result.result.error, ERROR_NOT_SUPPORTED, "Missing owner refuses before journal access");
    if (!std::strcmp(mode, "native-install-denied-hold")) Code(result.result.error, ERROR_LOCK_VIOLATION, "Busy pool refuses installation");
    if (!std::strcmp(mode, "native-install-null-hold")) Code(result.result.error, ERROR_INVALID_STATE, "Successful empty hold is refused");
    if (!std::strcmp(mode, "native-install-revoked-hold")) Code(result.result.error, ERROR_ACCESS_DENIED, "Revoked exclusion refuses journal access");
  }
  Check(JournalBytes(parent, request.cell_name) == before, "Client authority fixtures do not mutate journal or install runtimes");
}
void MountedWorkspaceActual(const std::wstring& root, bool capacity_only = false, bool backing_capacity = false, bool inventory = false, bool runtime = false, bool installation = false) {
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
  if (runtime) { RuntimeHandoffCases(parent, root, decoded); return; }
  if (installation) { InstallationCases(parent, root, decoded); return; }
  if (inventory) { InventoryCases(parent, root, wire, created.records, decoded); return; }
  if (backing_capacity) { BackingCapacityCases(parent, root, wire, created.records, decoded); return; }
  if (capacity_only) { CapacityCases(parent, root, wire, created.records, decoded); return; }
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
  for (const auto mode : {"welcome", "nonce", "hash", "binding", "chain", "sequence", "recovery-anchor", "receipt", "oversize", "kind", "short", "runtime-authority"})
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
// Borrowed private-pipe transfer proof; no service, journal or disk is opened.
void PoolResponsePipeProof(const std::vector<std::uint8_t>& expected, const CellControllerNonce& nonce) {
  for (unsigned mode = 0; mode < 12; ++mode) {
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatPoolResponse-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(mode);
    Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr)};
    Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    Check(server.value != INVALID_HANDLE_VALUE && stop.value, "create task-owned pool response pipe");
    const auto deadline = GetTickCount64() + 5000;
    struct Guard {
      unsigned calls = 0, reject_at = 0; HANDLE cancel = nullptr; std::vector<std::uint8_t>* mutate = nullptr;
      static DWORD Current(void* raw) noexcept {
        auto& self = *static_cast<Guard*>(raw); ++self.calls;
        if (self.mutate) { self.mutate->assign(1, 0); self.mutate = nullptr; }
        if (self.reject_at == self.calls) {
          if (self.cancel) SetEvent(self.cancel);
          else return ERROR_ACCESS_DENIED;
        }
        return ERROR_SUCCESS;
      }
    } sender, receiver;
    auto supplied = expected;
    if (mode == 1) sender.mutate = &supplied;
    if (mode == 2 || mode == 3) receiver.reject_at = 3;
    if (mode == 3) receiver.cancel = stop.value;
    if (mode == 11) receiver.reject_at = static_cast<unsigned>(2 + 2 * ((expected.size() + 4095) / 4096) + 1);
    DWORD sent = ERROR_GEN_FAILURE;
    std::jthread thread([&] {
      sent = ConnectCellPipe(server.value, stop.value, deadline);
      if (!sent && (mode < 4 || mode == 11))
        sent = WriteCellPoolCapacityResponse(server.value, deadline, nonce, {Guard::Current, &sender, stop.value}, supplied);
      else if (!sent) {
        std::array<std::uint8_t, 36> header{}; std::copy(nonce.begin(), nonce.end(), header.begin());
        Put(header.data() + 32, mode == 4 ? kCellPoolCapacityResponseMaximumBytes + 1 : expected.size(), 4);
        if (mode == 5) header[0] ^= 1;
        sent = WriteCellControllerMessage(server.value, CellControllerMessage::pool_capacity_size, header.data(), 36, stop.value, deadline);
        for (std::size_t offset = 0; !sent && mode != 4 && mode != 5 && offset < expected.size();) {
          const auto count = std::min<std::size_t>(4096, expected.size() - offset);
          std::vector<std::uint8_t> chunk(36 + count); std::copy(nonce.begin(), nonce.end(), chunk.begin());
          Put(chunk.data() + 32, mode == 6 ? offset + 1 : offset, 4); std::copy_n(expected.begin() + offset, count, chunk.begin() + 36);
          if (mode == 7) chunk[0] ^= 1;
          if (mode == 10 && !offset) chunk[36 + 24] ^= 1;
          sent = WriteCellControllerMessage(server.value, mode == 9 ? CellControllerMessage::pool_cleanup_chunk : CellControllerMessage::pool_capacity_chunk,
            chunk.data(), static_cast<DWORD>(mode == 8 ? chunk.size() - 1 : chunk.size()), stop.value, deadline);
          offset += count;
        }
      }
    });
    Handle client{CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr)};
    std::vector<std::uint8_t> received{1, 2, 3};
    const auto result = client.value == INVALID_HANDLE_VALUE ? GetLastError() :
      ReadCellPoolCapacityResponse(client.value, deadline, nonce, {Guard::Current, &receiver, stop.value}, &received);
    SetEvent(stop.value); thread.join();
    if (mode <= 1) {
      Code(result, ERROR_SUCCESS, "complete private-pipe pool response");
      // A final sender recheck may observe the receiver's terminal stop event.
      Check(sent == ERROR_SUCCESS || sent == ERROR_CANCELLED, "sender completed bytes before receiver stop");
      Check(received == expected, "private-pipe response preserves every byte");
      if (mode == 1) Check(supplied.size() == 1, "sender freezes response before external authority callback");
    } else {
      Check(result != ERROR_SUCCESS && received.empty(), "failed pool transport publishes no partial response");
      if (mode == 2 || mode == 11) Code(result, ERROR_ACCESS_DENIED, "revocation before or after chunks prevents publication");
      if (mode == 3) Code(result, ERROR_CANCELLED, "cancelled pool response prevents publication");
    }
  }
}
// Pure cross-language pool codec proof over task-created byte fixtures. This
// path opens fixture input/output files only, never a journal, device or volume.
void InstallationCapacityAdmissionProof(const CellControllerRequest& source, const std::wstring& owner,
    const std::wstring& controller, const CellCapacityLayoutRecord& layout, const CellPoolJoinedCapacity& captured,
    const std::vector<std::uint8_t>& expected) {
  auto request = InstallationRequest(source); request.operation = kCellControllerInstallCapacityOperation;
  Wire combined{};
  Check(EncodeCellControllerRequest(request, &combined, owner, controller), "Encode combined installation operation with independent history");
  CellControllerPoolHistory retained_pool;
  Code(DecodeCellControllerPoolHistory(request.pool_history, request, owner, controller, &retained_pool), ERROR_SUCCESS,
    "Combined operation retains original read-only pool metadata");
  Check(!retained_pool.members.empty() && retained_pool.members.front().operation == kCellControllerPoolCapacityOperation,
    "Pool members never inherit installation authority");
  auto corrupt = request; corrupt.installation_bytes[192] ^= 1;
  Check(DecodeCellControllerPoolHistory(corrupt.pool_history, corrupt, owner, controller, &retained_pool) != ERROR_SUCCESS,
    "Invalid installation request cannot project into admitted pool metadata");
  struct Authority final {
    unsigned mode = 0, calls = 0, reserves = 0, releases = 0;
    bool complete_capture = false;
    const std::vector<std::uint8_t>* expected = nullptr;
    CellInstallCapacityPipeClient* client = nullptr;
    CellInstallCapacityChallenge* routed = nullptr;
    static DWORD Local(void* raw) noexcept {
      auto* self = static_cast<Authority*>(raw);
      if (self && self->routed) { self->routed->fill(0); self->routed = nullptr; }
      return ERROR_SUCCESS;
    }
    struct Reservation final : CellInstallCapacityReservation {
      Authority& owner;
      explicit Reservation(Authority& value) : owner(value) {}
      ~Reservation() override { ++owner.releases; }
      DWORD Verify() noexcept override {
        ++owner.calls;
        if (owner.mode == 7 && owner.client->Reply() != ERROR_INVALID_STATE) return ERROR_GEN_FAILURE;
        return owner.mode == 1 || (owner.mode == 2 && owner.calls == 2) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
      }
    };
    static DWORD Reserve(void* raw, std::span<const std::uint8_t> bytes, const CellInstallCapacityBinding& binding,
        ULONGLONG deadline, std::unique_ptr<CellInstallCapacityReservation>* output) noexcept {
      auto& self = *static_cast<Authority*>(raw);
      ++self.reserves;
      if (!std::equal(bytes.begin(), bytes.end(), self.expected->begin(), self.expected->end()) ||
          binding.byte_length != bytes.size() || deadline <= GetTickCount64()) return ERROR_INVALID_DATA;
      self.complete_capture = true;
      if (self.mode == 4) return ERROR_SUCCESS;
      try { *output = std::make_unique<Reservation>(self); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      if (self.mode == 6 && self.client->Reply() != ERROR_INVALID_STATE) return ERROR_GEN_FAILURE;
      return self.mode == 5 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  };
  for (unsigned mode = 0; mode < 12; ++mode) {
    const auto started = GetTickCount64();
    std::fprintf(stderr, "installation admission begin mode=%u\n", mode);
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatInstallAdmission-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(mode);
    Handle server{CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, nullptr)};
    Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    Check(server.value != INVALID_HANDLE_VALUE && stop.value, "installation admission private pipe");
    const auto deadline = GetTickCount64() + 10000;
    DWORD server_error = ERROR_GEN_FAILURE, retry = ERROR_SUCCESS; bool acquired = false;
    std::thread thread([&] {
      server_error = ConnectCellPipe(server.value, stop.value, deadline);
      if (!server_error) {
        CellInstallCapacityPipeAdmission owner_channel(server.value, stop.value, request.nonce, owner, controller,
          {Authority::Local, nullptr, stop.value});
        const auto admission = owner_channel.Admission();
        std::unique_ptr<CellInstallCapacityReservation> reservation;
        server_error = admission.reserve(admission.context, request, layout, captured, deadline, &reservation);
        acquired = reservation != nullptr;
        if (!server_error) server_error = reservation->Verify();
        reservation.reset();
        retry = admission.reserve(admission.context, request, layout, captured, deadline, &reservation);
      }
    });
    Handle client{CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
    if (client.value == INVALID_HANDLE_VALUE) { SetEvent(stop.value); thread.join(); Check(false, "connect installation admission peer"); }
    CellRuntimeInstallBinding installation{request.installation.nonce, request.installation.request_sha256};
    if (mode == 3) installation.request_sha256[0] ^= 1;
    Authority authority; authority.mode = mode; authority.expected = &expected;
    auto channel = std::make_unique<CellInstallCapacityPipeClient>(client.value, stop.value, deadline, request.nonce,
      installation, CellFootprintScanGuard{Authority::Local, &authority, stop.value});
    authority.client = channel.get();
    // The client snapshots the independently retained binding.
    installation.request_sha256.fill(0);
    const bool routed = mode >= 8 || mode == 2 || mode == 3;
    const auto receive = [&](CellControllerMessage expected_kind, CellInstallCapacityChallenge& output) {
      CellControllerMessage kind{}; std::array<std::uint8_t, 1056> bytes{};
      auto error = ReadCellControllerReply(client.value, &kind, &bytes, stop.value, deadline);
      if (!error && kind != expected_kind) error = ERROR_INVALID_DATA;
      if (!error) std::copy_n(bytes.begin(), output.size(), output.begin());
      return error;
    };
    DWORD error = ERROR_SUCCESS;
    CellInstallCapacityChallenge ready{};
    if (routed) {
      error = receive(CellControllerMessage::install_capacity_capture, ready);
      if (mode == 9) ready[32] ^= 1;
      if (mode == 11) authority.routed = &ready;
      if (!error) error = channel->BeginReceived({&authority, Authority::Reserve}, ready);
    } else error = channel->Begin({&authority, Authority::Reserve});
    if (!error) {
      if (routed) {
        error = receive(CellControllerMessage::install_capacity_authority, ready);
        if (mode == 10) ready[128] ^= 1;
        if (mode == 11) authority.routed = &ready;
        if (!error) error = channel->ReplyReceived(ready);
      } else error = channel->Reply();
    }
    if (error) SetEvent(stop.value);
    thread.join();
    const bool success = mode == 0 || mode == 8 || mode == 11;
    const bool no_capture = mode == 3 || mode == 9;
    Check(no_capture ? !authority.complete_capture && !authority.reserves : authority.complete_capture && authority.reserves == 1,
      "only exact retained installation reaches complete capture admission");
    Check(success ? !server_error && !error : server_error != ERROR_SUCCESS, "only current capture reservation stays usable");
    Check(acquired == (success || mode == 2 || mode == 10), "no reservation owner escapes rejected first admission");
    Check(retry == ERROR_INVALID_STATE, "capture admission never retries or rescans a consumed connection");
    Check(authority.calls == (success || mode == 2 ? 2u : mode == 1 || mode == 7 || mode == 10 ? 1u : 0u), "canonical checks follow exact capture delivery");
    Check(authority.releases == (success || no_capture || mode == 4 ? 0u : 1u), "failure releases client reservation before returning");
    if (!success) Check(channel->Reply() == ERROR_INVALID_STATE && channel->Begin({&authority, Authority::Reserve}) == ERROR_INVALID_STATE,
      "failed client cannot retry admission or reply");
    channel.reset();
    Check(authority.releases == (no_capture || mode == 4 ? 0u : 1u), "successful reservation releases only when retained client closes");
    std::fprintf(stderr, "installation admission end mode=%u elapsed_ms=%llu\n", mode,
      static_cast<unsigned long long>(GetTickCount64() - started));
  }
}

int PoolOutputFixture(const std::wstring& root) {
  const auto read = [&](const std::wstring& name, std::size_t maximum) {
    Handle file{CreateFileW((root + L"\\" + name).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    LARGE_INTEGER size{};
    Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart > 0 &&
      static_cast<std::uint64_t>(size.QuadPart) <= maximum, "bounded pool fixture input");
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart)); DWORD received = 0;
    Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &received, nullptr) && received == bytes.size(), "read complete pool fixture input");
    return bytes;
  };
  const auto bytes = read(L"pool.bin", kCellControllerPoolHeaderBytes + 64 * kCellControllerPoolMemberBytes);
  Check(bytes.size() >= kCellControllerPoolHeaderBytes + kCellControllerPoolMemberBytes, "pool fixture includes current history");
  CellControllerNonce nonce{}; nonce.fill(0x71); Wire header{};
  std::copy_n(bytes.begin() + kCellControllerPoolHeaderBytes, header.size(), header.begin());
  std::copy(nonce.begin(), nonce.end(), header.begin() + 8);
  CellControllerRequest current;
  Check(DecodeCellControllerRequest(header, nonce, &current), "decode fixture current request");
  std::size_t position = kCellControllerPoolHeaderBytes + header.size();
  const auto records = [&](auto& target) { for (auto& record : target) {
    std::copy_n(bytes.begin() + position, record.size(), record.begin()); position += record.size();
  } };
  records(current.creation_records); records(current.volume_records); records(current.format_records);
  records(current.protection_records); records(current.mount_records); records(current.mounted_workspace_records);
  current.pool_history = bytes;
  const std::wstring owner = L"S-1-5-18", controller = L"S-1-5-80-1-2-3-4-5";
  CellControllerPoolHistory pool;
  Code(DecodeCellControllerPoolHistory(bytes, current, owner, controller, &pool), ERROR_SUCCESS, "independently validate all fixture histories");
  CellPoolJoinedCapacity observed;
  CellCapacityLayoutRecord layout{current.plan.assignment_binding, current.plan.profile_sha256, {}};
  for (std::size_t i = 0; i < layout.roots.size(); ++i) {
    auto& id = layout.roots[i]; id.volume_serial = current.parent.volume_serial;
    id.file_id.fill(0xcf); id.file_id.back() = static_cast<std::uint8_t>(i);
    if (!i) id = current.parent;
    observed.host.areas[i].entries.push_back({id, true, 0, 4096});
  }
  for (std::size_t i = 0; i < pool.members.size(); ++i) {
    const auto suffix = std::to_wstring(i) + L".bin";
    const auto guest_bytes = read(L"guest-" + suffix, 352), backing_bytes = read(L"backing-" + suffix, 424);
    Check(guest_bytes.size() == 352 && backing_bytes.size() == 424, "exact fixture observation sizes");
    CellControllerCapacityBytes summary_bytes{}; std::copy(guest_bytes.begin(), guest_bytes.end(), summary_bytes.begin());
    CellProvisioningFootprint summary;
    Check(DecodeCellControllerCapacity(nonce, summary_bytes, &summary), "decode distinct guest fixture");
    CellProvisioningInventory guest{summary.anchor, summary.assignment_binding, summary.profile_sha256,
      summary.checkpoint_sha256, summary.workspace, {summary.footprint, {}}};
    const auto chunks = read(L"chunks-" + suffix, 1000 * 1000);
    Check(chunks.size() % 1000 == 0, "whole guest chunks");
    for (std::size_t offset = 0; offset < chunks.size(); offset += 1000) {
      CellControllerInventoryChunkBytes chunk{}; std::copy_n(chunks.begin() + offset, chunk.size(), chunk.begin());
      CellControllerInventoryChunk decoded;
      Check(DecodeCellControllerInventoryChunk(nonce, chunk, &decoded) && decoded.start == guest.inventory.entries.size(), "ordered distinct guest chunks");
      guest.inventory.entries.insert(guest.inventory.entries.end(), decoded.entries.begin(), decoded.entries.begin() + decoded.count);
    }
    CellControllerBackingCapacityBytes host_bytes{}; std::copy(backing_bytes.begin(), backing_bytes.end(), host_bytes.begin());
    CellProvisioningBackingFootprint backing;
    Check(DecodeCellControllerBackingCapacity(nonce, host_bytes, &backing), "decode distinct backing fixture");
    for (const auto& id : backing.workspace.directories) observed.host.areas[0].entries.push_back({id, true, 0, 4096});
    observed.host.areas[0].entries.push_back({backing.anchor.file, false, backing.journal_bytes, backing.journal_allocated_bytes});
    observed.host.areas[0].entries.push_back({backing.backing.record.backing, false, backing.backing.file_bytes, backing.backing.allocated_bytes});
    observed.guests.push_back(std::move(guest)); observed.host.backings.push_back(backing);
  }
  for (std::size_t i = 0; i < observed.host.areas.size(); ++i) {
    auto& area = observed.host.areas[i]; area.footprint.root = layout.roots[i];
    std::sort(area.entries.begin(), area.entries.end(), [](const auto& a, const auto& b) { return a.identity.file_id < b.identity.file_id; });
    for (const auto& entry : area.entries) {
      area.footprint.logical_file_bytes += entry.logical_file_bytes; area.footprint.allocated_bytes += entry.allocated_bytes;
      if (entry.directory) ++area.footprint.directory_count; else ++area.footprint.file_count;
    }
  }
  CellFileSha256 capture{}; capture.fill(0x44); CellPoolJoinedCapacityBytes encoded;
  Code(EncodeCellPoolJoinedCapacity(current, owner, controller, layout, capture, observed, &encoded), ERROR_SUCCESS, "encode every distinct pool member");
  Check(encoded.members.size() == pool.members.size() && encoded.pool_sha256 == pool.snapshot_sha256, "retain complete admitted pool output");
  std::vector<std::uint8_t> expected_host;
  Code(EncodeCellCapacityCapture(layout, capture, observed.host.areas, &expected_host), ERROR_SUCCESS, "encode independently retained shared host capture");
  Check(encoded.host == expected_host, "pool emits shared host exactly once without guest charges");
  for (std::size_t i = 0; i < encoded.members.size(); ++i) {
    CellProvisioningBackingFootprint backing;
    Check(DecodeCellControllerBackingCapacity(nonce, encoded.members[i].backing, &backing) && backing.anchor == pool.members[i].anchor,
      "each output retains its original journal in pool order");
    CellProvisioningFootprint guest;
    Check(DecodeCellControllerCapacity(nonce, encoded.members[i].guest, &guest) && guest.anchor == pool.members[i].anchor &&
      guest.footprint == observed.guests[i].inventory.footprint, "each output preserves its original guest summary");
    std::vector<CellDirectoryInventoryEntry> entries;
    for (const auto& chunk : encoded.members[i].guest_chunks) {
      CellControllerInventoryChunk decoded;
      Check(DecodeCellControllerInventoryChunk(nonce, chunk, &decoded) && decoded.start == entries.size(), "each output preserves contiguous guest chunks");
      entries.insert(entries.end(), decoded.entries.begin(), decoded.entries.begin() + decoded.count);
    }
    Check(entries == observed.guests[i].inventory.entries, "each output preserves every original guest object");
  }
  const auto write = [&](const std::wstring& name, std::span<const std::uint8_t> data) {
    Handle file{CreateFileW((root + L"\\" + name).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
    DWORD written = 0;
    Check(file.value != INVALID_HANDLE_VALUE && WriteFile(file.value, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) &&
      written == data.size(), "retain exact pool codec output without replacing input");
  };
  write(L"output-layout.bin", encoded.layout); write(L"output-host.bin", encoded.host); write(L"output-pool-sha256.bin", encoded.pool_sha256);
  std::vector<std::uint8_t> response;
  Code(EncodeCellPoolCapacityResponse(current, owner, controller, layout, capture, observed, &response), ERROR_SUCCESS, "encode complete bounded pool response");
  Check(response.size() <= kCellPoolCapacityResponseMaximumBytes, "pool response stays within transport bound");
  write(L"output-response.bin", response);
  PoolResponsePipeProof(response, nonce);
  current.capture_nonce = capture;
  InstallationCapacityAdmissionProof(current, owner, controller, layout, observed, response);
  for (std::size_t i = 0; i < encoded.members.size(); ++i) {
    const auto suffix = std::to_wstring(i) + L".bin";
    write(L"output-guest-" + suffix, encoded.members[i].guest);
    write(L"output-backing-" + suffix, encoded.members[i].backing);
    std::vector<std::uint8_t> chunks;
    for (const auto& chunk : encoded.members[i].guest_chunks) chunks.insert(chunks.end(), chunk.begin(), chunk.end());
    write(L"output-chunks-" + suffix, chunks);
  }
  Check(observed.guests.size() >= 2, "multi-member fixture");
  std::swap(observed.guests[0], observed.guests[1]);
  Code(EncodeCellPoolJoinedCapacity(current, owner, controller, layout, capture, observed, &encoded), ERROR_INVALID_DATA, "refuse swapped pool guest histories");
  Check(encoded.members.empty() && encoded.host.empty(), "swapped pool output publishes nothing");
  Code(EncodeCellPoolCapacityResponse(current, owner, controller, layout, capture, observed, &response), ERROR_INVALID_DATA, "response refuses swapped member evidence");
  Check(response.empty(), "refused response preserves no partial bytes");
  std::swap(observed.guests[0], observed.guests[1]); observed.host.backings.pop_back();
  Code(EncodeCellPoolJoinedCapacity(current, owner, controller, layout, capture, observed, &encoded), ERROR_INVALID_DATA, "refuse missing final pool backing");
  Check(encoded.members.empty() && encoded.host.empty(), "missing final member publishes nothing");
  std::printf("{\"passed\":true,\"members\":%zu,\"checks\":%u,\"physicalVolumeScanned\":false}\n", pool.members.size(), checks.load());
  return 0;
}
int wmain(int count, wchar_t** arguments) {
  if (count == 3 && !wcscmp(arguments[1], L"--pool-output")) {
    try { return PoolOutputFixture(arguments[2]); }
    catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
  }
  const bool workspace = count == 3 && !wcscmp(arguments[1], L"--mounted-workspace");
  const bool capacity = count == 3 && !wcscmp(arguments[1], L"--capacity");
  const bool backing_capacity = count == 3 && !wcscmp(arguments[1], L"--backing-capacity");
  const bool inventory = count == 3 && !wcscmp(arguments[1], L"--inventory");
  const bool runtime = count == 3 && !wcscmp(arguments[1], L"--runtime-handoff");
  const bool installation = count == 3 && !wcscmp(arguments[1], L"--installation");
  if (count != 2 && !workspace && !capacity && !backing_capacity && !inventory && !runtime && !installation) return 2;
  try {
    DecoderCases();
    CapacityWireCases();
    BackingCapacityWireCases();
    BackingBorrowLifecycleCases();
    PoolCapacityCases();
    PoolJoinedCases();
    RecordedPoolCases();
    if (workspace || capacity || backing_capacity || inventory || runtime || installation) {
      MountedWorkspaceActual(arguments[2], capacity, backing_capacity, inventory, runtime, installation);
      std::printf("{\"checks\":%u,\"passed\":true,\"sessions\":%u,\"nativeClientSessions\":%u,\"controlledMountedWorkspaceCheckpoints\":2,\"mountedWorkspaceAuthorityChecks\":%u,\"installedService\":false,\"canonicalStorage\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"volumeRootProtected\":false,\"volumeMounted\":false}\n", checks.load(), sessions, native_client_sessions, workspace_authority_checks);
      return 0;
    }
    Actual(arguments[1]);
    std::printf("{\"checks\":%u,\"passed\":true,\"sessions\":%u,\"nativeClientSessions\":%u,\"creationCheckpoints\":5,\"recoveryCheckpoints\":5,\"controlledVolumeCheckpoints\":6,\"controlledFormatCheckpoints\":2,\"controlledProtectionCheckpoints\":2,\"controlledMountCheckpoints\":4,\"volumeAuthorityChecks\":%u,\"formatAuthorityChecks\":%u,\"protectionAuthorityChecks\":%u,\"mountAuthorityChecks\":%u,\"installedService\":false,\"canonicalStorage\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"volumeRootProtected\":false,\"volumeMounted\":false}\n", checks.load(), sessions, native_client_sessions, volume_authority_checks, format_authority_checks, protection_authority_checks, mount_authority_checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
