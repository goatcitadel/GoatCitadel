#include "cell_provisioning_journal.hpp"
#include "cell_runtime_bundle.hpp"
#include "cell_security.hpp"
#include <winternl.h>
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#include <string_view>
#include <limits>
#include <type_traits>
#include <utility>
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::size_t record_bytes = 1024, digest_offset = record_bytes - 32, workspace_offset = 600;
constexpr std::size_t core_bytes = record_bytes * 5, volume_end = record_bytes * 11;
constexpr std::size_t format_end = record_bytes * 13, protection_end = record_bytes * 15;
constexpr std::size_t mount_end = record_bytes * 19, maximum_bytes = record_bytes * 21;
using Record = CellProvisioningRecord;
DWORD Error() noexcept { const DWORD value = GetLastError(); return value ? value : ERROR_GEN_FAILURE; }
bool Nonzero(const auto& bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; });
}
bool IdentityValid(const CellFileIdentity& value) noexcept { return value.volume_serial && Nonzero(value.file_id); }
bool ValidPlan(const CellProvisioningPlan& plan) noexcept {
  return Nonzero(plan.assignment_binding) && Nonzero(plan.profile_sha256) && IsValidCellVirtualDiskSpec(plan.disk);
}
void Integer(Record& output, std::size_t& offset, std::uint64_t value, unsigned size = 8) noexcept {
  for (unsigned i = 0; i < size; ++i) output[offset++] = static_cast<std::uint8_t>(value >> (i * 8));
}
std::uint64_t ReadInteger(const Record& input, std::size_t& offset) noexcept {
  std::uint64_t value = 0;
  for (unsigned i = 0; i < 8; ++i) value |= static_cast<std::uint64_t>(input[offset++]) << (i * 8);
  return value;
}
void Identity(Record& output, std::size_t& offset, const CellFileIdentity& value) noexcept {
  Integer(output, offset, value.volume_serial);
  std::copy(value.file_id.begin(), value.file_id.end(), output.begin() + offset); offset += value.file_id.size();
}
CellFileIdentity ReadIdentity(const Record& input, std::size_t& offset) noexcept {
  CellFileIdentity value;
  value.volume_serial = ReadInteger(input, offset);
  std::copy_n(input.begin() + offset, value.file_id.size(), value.file_id.begin()); offset += value.file_id.size();
  return value;
}
DWORD Encode(Record* output, CellProvisioningPhase phase, const CellProvisioningPlan& plan,
             const CellFileIdentity& parent, const CellFileIdentity& journal,
             const std::wstring& name, const std::wstring& owner, const std::wstring& controller,
             const CellWorkspaceIdentities& workspace, const CellVirtualDiskRecord& disk,
             const CellFileSha256& prior) noexcept {
  *output = {};
  auto& bytes = *output;
  constexpr std::string_view magic = "GCCELLP1";
  std::copy(magic.begin(), magic.end(), bytes.begin());
  std::size_t offset = magic.size();
  Integer(bytes, offset, static_cast<unsigned>(phase), 4);
  Integer(bytes, offset, static_cast<unsigned>(phase), 4);
  const auto copy = [&](const auto& value) {
    std::copy(value.begin(), value.end(), bytes.begin() + offset); offset += value.size();
  };
  copy(prior); copy(plan.assignment_binding); copy(plan.profile_sha256);
  std::memcpy(bytes.data() + offset, &plan.disk.identifier, sizeof(GUID)); offset += sizeof(GUID);
  Integer(bytes, offset, plan.disk.virtual_bytes); Integer(bytes, offset, plan.disk.reserved_file_bytes);
  Identity(bytes, offset, parent); Identity(bytes, offset, journal);
  const auto text = [&](const std::wstring& value, std::size_t length) {
    for (std::size_t i = 0; i < value.size(); ++i) bytes[offset + i] = static_cast<std::uint8_t>(value[i]);
    offset += length;
  };
  // Initialize already validated canonical ASCII names and SIDs with these bounds.
  text(name, 40); text(owner, 184); text(controller, 184);
  if (offset != workspace_offset) return ERROR_INVALID_DATA;
  if (phase >= CellProvisioningPhase::workspace_recorded)
    for (const auto& identity : workspace.directories) Identity(bytes, offset, identity);
  else offset += 4 * 24;
  if (phase == CellProvisioningPhase::disk_recorded) Identity(bytes, offset, disk.backing);
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(digest_offset),
    bytes.data() + digest_offset, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status < 0 ? ERROR_GEN_FAILURE : ERROR_SUCCESS;
}
bool ValidWorkspace(const CellWorkspaceIdentities& workspace, const CellFileIdentity& journal) noexcept {
  for (std::size_t i = 0; i < workspace.directories.size(); ++i) {
    const auto& identity = workspace.directories[i];
    if (!IdentityValid(identity) || identity.volume_serial != workspace.parent.volume_serial ||
        identity == workspace.parent || identity == journal) return false;
    for (std::size_t previous = 0; previous < i; ++previous)
      if (workspace.directories[previous] == identity) return false;
  }
  return true;
}
DWORD EncodeStorageRecord(Record* output, const char (&magic)[9], unsigned sequence, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  const CellFileSha256& previous, const CellDiskLayoutCheckpoint* layout) noexcept {
  *output = {};
  CellDiskLayoutPlan expected;
  DWORD error = DeriveCellDiskLayoutPlan(disk, plan.assignment_binding, plan.profile_sha256, &expected);
  if (error) return error;
  auto& bytes = *output;
  std::memcpy(bytes.data(), magic, 8);
  std::size_t offset = 8;
  Integer(bytes, offset, sequence, 4); Integer(bytes, offset, sequence, 4);
  const auto copy = [&](const auto& value) {
    std::copy(value.begin(), value.end(), bytes.begin() + offset); offset += value.size();
  };
  copy(previous); copy(plan.assignment_binding); copy(plan.profile_sha256);
  std::memcpy(bytes.data() + offset, &disk.spec.identifier, sizeof(GUID)); offset += sizeof(GUID);
  Integer(bytes, offset, disk.spec.virtual_bytes); Integer(bytes, offset, disk.spec.reserved_file_bytes);
  Identity(bytes, offset, journal); Identity(bytes, offset, disk.control); Identity(bytes, offset, disk.backing);
  copy(base);
  std::memcpy(bytes.data() + offset, &expected.gpt_disk_id, sizeof(GUID)); offset += sizeof(GUID);
  std::memcpy(bytes.data() + offset, &expected.data_partition_id, sizeof(GUID)); offset += sizeof(GUID);
  if (offset != 280) return ERROR_INVALID_DATA;
  if (layout) copy(*layout);
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(digest_offset),
    bytes.data() + digest_offset, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status < 0 ? ERROR_GEN_FAILURE : ERROR_SUCCESS;
}
DWORD EncodeVolume(Record* output, unsigned sequence, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  const CellFileSha256& previous, const CellDiskLayoutCheckpoint* layout) noexcept {
  if (sequence < 1 || sequence > 6 || (sequence >= 3) != (layout != nullptr)) return ERROR_INVALID_PARAMETER;
  return EncodeStorageRecord(output, "GCCVOL01", sequence, plan, journal, disk, base, previous, layout);
}
DWORD DecodeVolume(std::span<const std::uint8_t> bytes, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  std::vector<CellDiskLayoutCheckpoint>* layouts) {
  layouts->clear();
  if (bytes.size() % record_bytes || bytes.size() > 6 * record_bytes) return ERROR_INVALID_DATA;
  layouts->reserve(4);
  CellFileSha256 previous = base;
  CellDiskLayoutPlan expected_plan;
  if (!bytes.empty()) {
    const DWORD error = DeriveCellDiskLayoutPlan(disk, plan.assignment_binding, plan.profile_sha256, &expected_plan);
    if (error) return error;
  }
  for (std::size_t position = 0; position < bytes.size(); position += record_bytes) {
    const unsigned sequence = static_cast<unsigned>(position / record_bytes) + 1;
    Record actual{}, expected{};
    std::copy_n(bytes.begin() + position, record_bytes, actual.begin());
    CellDiskLayoutCheckpoint layout{};
    if (sequence >= 3) {
      std::copy_n(actual.begin() + 280, layout.size(), layout.begin());
      layouts->push_back(layout);
      CellDiskLayoutSnapshot snapshot;
      const DWORD error = ValidateCellDiskLayoutCheckpointPrefix(expected_plan, *layouts, &snapshot);
      if (error) return error;
    }
    const DWORD error = EncodeVolume(&expected, sequence, plan, journal, disk, base, previous, sequence >= 3 ? &layout : nullptr);
    if (error) return error;
    if (expected != actual) return ERROR_CRC;
    std::copy_n(actual.begin() + digest_offset, previous.size(), previous.begin());
  }
  return ERROR_SUCCESS;
}
DWORD DecodeFormat(std::span<const std::uint8_t> bytes, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  std::span<const CellDiskLayoutCheckpoint> layouts, std::vector<CellNtfsFormatCheckpoint>* formats) {
  formats->clear();
  if (bytes.size() % record_bytes || bytes.size() > 2 * record_bytes) return ERROR_INVALID_DATA;
  if (bytes.empty()) return ERROR_SUCCESS;
  CellDiskLayoutPlan layout_plan;
  DWORD error = DeriveCellDiskLayoutPlan(disk, plan.assignment_binding, plan.profile_sha256, &layout_plan);
  CellDiskLayoutSnapshot snapshot;
  if (!error) error = DecodeCellDiskLayoutCheckpoints(layout_plan, layouts, &snapshot);
  if (error) return error;
  CellNtfsFormatBinding binding;
  binding.partition_bytes = snapshot.data_length;
  std::copy_n(layouts.back().end() - binding.layout_sha256.size(), binding.layout_sha256.size(), binding.layout_sha256.begin());
  formats->reserve(2);
  CellFileSha256 previous = base;
  for (std::size_t position = 0; position < bytes.size(); position += record_bytes) {
    const unsigned sequence = static_cast<unsigned>(position / record_bytes) + 1;
    Record actual{}, expected{};
    std::copy_n(bytes.begin() + position, record_bytes, actual.begin());
    CellNtfsFormatCheckpoint checkpoint{};
    std::copy_n(actual.begin() + 280, checkpoint.size(), checkpoint.begin());
    // The first native volume identity is observed only after binding the exact
    // recorded partition. Subsequent records must retain it; recovery rebinds OS
    // state independently and also compares the canonical outer records.
    if (!position) std::memcpy(&binding.volume_id, checkpoint.data() + 80, sizeof(GUID));
    formats->push_back(checkpoint);
    CellNtfsIdentity identity;
    error = ValidateCellNtfsFormatCheckpointPrefix(binding, *formats, &identity);
    if (!error) error = EncodeStorageRecord(&expected, "GCCFMT01", sequence, plan, journal, disk, base, previous, &checkpoint);
    if (error) return error;
    if (actual != expected) return ERROR_CRC;
    std::copy_n(actual.begin() + digest_offset, previous.size(), previous.begin());
  }
  return ERROR_SUCCESS;
}
DWORD DecodeProtection(std::span<const std::uint8_t> bytes, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  const std::wstring& owner, const std::wstring& controller, std::span<const CellDiskLayoutCheckpoint> layouts,
  std::span<const CellNtfsFormatCheckpoint> formats, std::vector<CellVolumeProtectionCheckpoint>* protections) {
  protections->clear();
  if (bytes.size() % record_bytes || bytes.size() > 2 * record_bytes) return ERROR_INVALID_DATA;
  if (bytes.empty()) return ERROR_SUCCESS;
  if (formats.size() != 2) return ERROR_IO_INCOMPLETE;
  CellDiskLayoutPlan layout_plan;
  DWORD error = DeriveCellDiskLayoutPlan(disk, plan.assignment_binding, plan.profile_sha256, &layout_plan);
  CellDiskLayoutSnapshot snapshot;
  if (!error) error = DecodeCellDiskLayoutCheckpoints(layout_plan, layouts, &snapshot);
  if (error) return error;
  CellVolumeProtectionBinding binding;
  CellNtfsFormatBinding format_binding;
  format_binding.partition_bytes = binding.partition_bytes = snapshot.data_length;
  std::copy_n(layouts.back().end() - 32, 32, format_binding.layout_sha256.begin());
  std::memcpy(&format_binding.volume_id, formats[0].data() + 80, sizeof(GUID));
  binding.volume_id = format_binding.volume_id;
  error = DecodeCellNtfsFormatCheckpoints(format_binding, formats, &binding.ntfs);
  if (error) return error;
  std::copy_n(formats.back().end() - 32, 32, binding.format_sha256.begin());
  error = HashCellVolumeRootSecurity(owner, controller, &binding.security_sha256);
  if (error) return error;
  protections->reserve(2);
  CellFileSha256 previous = base;
  for (std::size_t position = 0; position < bytes.size(); position += record_bytes) {
    Record actual{}, expected{};
    std::copy_n(bytes.begin() + position, record_bytes, actual.begin());
    CellVolumeProtectionCheckpoint checkpoint{};
    std::copy_n(actual.begin() + 280, checkpoint.size(), checkpoint.begin());
    if (!position) {
      std::memcpy(&binding.root.volume_serial, checkpoint.data() + 160, sizeof(binding.root.volume_serial));
      std::copy_n(checkpoint.begin() + 168, binding.root.file_id.size(), binding.root.file_id.begin());
    }
    protections->push_back(checkpoint);
    error = ValidateCellVolumeProtectionCheckpointPrefix(binding, *protections);
    if (!error) error = EncodeStorageRecord(&expected, "GCCPRV01", static_cast<unsigned>(position / record_bytes) + 1,
      plan, journal, disk, base, previous, &checkpoint);
    if (error) return error;
    if (actual != expected) return ERROR_CRC;
    std::copy_n(actual.begin() + digest_offset, previous.size(), previous.begin());
  }
  return ERROR_SUCCESS;
}
DWORD DecodeMount(std::span<const std::uint8_t> bytes, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellWorkspaceIdentities& workspace, const CellVirtualDiskRecord& disk,
  const CellFileSha256& base, const std::wstring& owner, const std::wstring& controller,
  std::span<const CellVolumeProtectionCheckpoint> protections, std::vector<CellVolumeMountCheckpoint>* mounts) {
  mounts->clear();
  if (bytes.size() % record_bytes || bytes.size() > 4 * record_bytes) return ERROR_INVALID_DATA;
  if (bytes.empty()) return ERROR_SUCCESS;
  if (protections.size() != 2) return ERROR_IO_INCOMPLETE;
  if (!IdentityValid(workspace.parent) || workspace.parent == journal || workspace.parent == disk.backing ||
      !ValidWorkspace(workspace, journal) || workspace.directories[1] != disk.control ||
      std::find(workspace.directories.begin(), workspace.directories.end(), disk.backing) != workspace.directories.end())
    return ERROR_INVALID_DATA;
  // The preceding protection records have already been independently decoded.
  // The mount cannot choose a different policy, host parent or protected root.
  CellVolumeMountBinding binding;
  binding.parent = workspace.directories[0];
  std::copy_n(protections.back().end() - 32, 32, binding.protection_sha256.begin());
  std::memcpy(&binding.volume_id, protections.back().data() + 112, sizeof(GUID));
  std::memcpy(&binding.volume_root.volume_serial, protections.back().data() + 160, sizeof(binding.volume_root.volume_serial));
  std::copy_n(protections.back().begin() + 168, 16, binding.volume_root.file_id.begin());
  DWORD error = HashCellVolumeRootSecurity(owner, controller, &binding.security_sha256);
  if (error) return error;
  mounts->reserve(4);
  CellFileSha256 previous = base;
  for (std::size_t position = 0; position < bytes.size(); position += record_bytes) {
    Record actual{}, expected{};
    std::copy_n(bytes.begin() + position, record_bytes, actual.begin());
    CellVolumeMountCheckpoint checkpoint{};
    std::copy_n(actual.begin() + 280, checkpoint.size(), checkpoint.begin());
    mounts->push_back(checkpoint);
    CellFileIdentity directory{};
    error = ValidateCellVolumeMountCheckpointPrefix(binding, *mounts, &directory);
    if (!error && IdentityValid(directory) && (directory == workspace.parent || directory == journal || directory == disk.backing ||
        std::find(workspace.directories.begin(), workspace.directories.end(), directory) != workspace.directories.end())) error = ERROR_INVALID_DATA;
    if (!error) error = EncodeStorageRecord(&expected, "GCCMNV01", static_cast<unsigned>(position / record_bytes) + 1,
      plan, journal, disk, base, previous, &checkpoint);
    if (error) return error;
    if (actual != expected) return ERROR_CRC;
    std::copy_n(actual.begin() + digest_offset, previous.size(), previous.begin());
  }
  return ERROR_SUCCESS;
}
DWORD DecodeMountedWorkspace(std::span<const std::uint8_t> bytes, const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  const std::wstring& name, const std::wstring& owner, const std::wstring& controller,
  std::span<const CellVolumeMountCheckpoint> mounts, std::vector<CellMountedWorkspaceCheckpoint>* records,
  CellWorkspaceIdentities* identities = nullptr) {
  records->clear();
  if (identities) *identities = {};
  if (bytes.size() % record_bytes || bytes.size() > 2 * record_bytes) return ERROR_INVALID_DATA;
  if (bytes.empty()) return ERROR_SUCCESS;
  if (mounts.size() != 4) return ERROR_IO_INCOMPLETE;
  // The complete preceding mount history has already been independently decoded.
  CellMountedWorkspaceBinding binding;
  binding.cell_name = name;
  std::copy_n(mounts.back().end() - 32, 32, binding.mount_sha256.begin());
  std::memcpy(&binding.volume_root.volume_serial, mounts.back().data() + 152, sizeof(binding.volume_root.volume_serial));
  std::copy_n(mounts.back().begin() + 160, 16, binding.volume_root.file_id.begin());
  DWORD error = HashCellVolumeRootSecurity(owner, controller, &binding.security_sha256);
  if (error) return error;
  records->reserve(2);
  CellFileSha256 previous = base;
  CellWorkspaceIdentities captured;
  for (std::size_t position = 0; position < bytes.size(); position += record_bytes) {
    Record actual{}, expected{};
    std::copy_n(bytes.begin() + position, record_bytes, actual.begin());
    CellMountedWorkspaceCheckpoint checkpoint{};
    std::copy_n(actual.begin() + 280, checkpoint.size(), checkpoint.begin());
    records->push_back(checkpoint);
    error = ValidateCellMountedWorkspaceCheckpointPrefix(binding, *records, &captured);
    if (!error) error = EncodeStorageRecord(&expected, "GCCMWP01", static_cast<unsigned>(position / record_bytes) + 1,
      plan, journal, disk, base, previous, &checkpoint);
    if (error) return error;
    if (actual != expected) return ERROR_CRC;
    std::copy_n(actual.begin() + digest_offset, previous.size(), previous.begin());
  }
  if (identities) *identities = captured;
  return ERROR_SUCCESS;
}
DWORD VolumeControl(ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() < deadline ? ERROR_SUCCESS : ERROR_TIMEOUT;
}
DWORD Remaining(ULONGLONG deadline) noexcept {
  const ULONGLONG now = GetTickCount64();
  return now < deadline ? static_cast<DWORD>(std::min<ULONGLONG>(600000, deadline - now)) : 0;
}
}

DWORD ValidateCellProvisioningHistory(const CellProvisioningPlan& plan, const CellFileIdentity& parent,
  const std::wstring& name, const std::wstring& owner, const std::wstring& controller,
  const CellProvisioningAnchor& anchor, std::span<const CellProvisioningRecord> records,
  CellWorkspaceIdentities* workspace_output, CellVirtualDiskRecord* disk_output, CellFileSha256* digest_output) noexcept {
  if (!workspace_output || !disk_output || !digest_output) return ERROR_INVALID_PARAMETER;
  *workspace_output = {}; *disk_output = {}; *digest_output = {};
  if (!ValidPlan(plan) || !IdentityValid(parent) || !IdentityValid(anchor.file) || parent == anchor.file ||
      parent.volume_serial != anchor.file.volume_serial || !Nonzero(anchor.prepared_sha256) || records.size() != 5 ||
      name.size() != 40 || name.compare(0, 8, L"gc-cell-") || name.find_first_not_of(L"0123456789abcdef", 8) != std::wstring::npos)
    return ERROR_INVALID_DATA;
  CellFileSha256 policy{};
  if (HashCellVolumeRootSecurity(owner, controller, &policy)) return ERROR_INVALID_DATA;
  try {
    CellWorkspaceIdentities workspace; workspace.parent = parent;
    CellVirtualDiskRecord disk;
    CellFileSha256 prior{};
    for (std::size_t index = 0; index < records.size(); ++index) {
      const auto phase = static_cast<CellProvisioningPhase>(index + 1);
      const auto& actual = records[index];
      if (phase >= CellProvisioningPhase::workspace_recorded) {
        CellWorkspaceIdentities captured; captured.parent = parent;
        std::size_t offset = workspace_offset;
        for (auto& identity : captured.directories) identity = ReadIdentity(actual, offset);
        if (!ValidWorkspace(captured, anchor.file) || (index > 2 && captured != workspace)) return ERROR_INVALID_DATA;
        workspace = captured;
        if (phase == CellProvisioningPhase::disk_recorded) {
          disk = {plan.disk, workspace.directories[1], ReadIdentity(actual, offset)};
          if (!IdentityValid(disk.backing) || disk.backing.volume_serial != parent.volume_serial || disk.backing == parent ||
              disk.backing == anchor.file || std::find(workspace.directories.begin(), workspace.directories.end(), disk.backing) != workspace.directories.end())
            return ERROR_INVALID_DATA;
        }
      }
      Record expected{};
      const DWORD error = Encode(&expected, phase, plan, parent, anchor.file, name, owner, controller, workspace, disk, prior);
      if (error) return error;
      if (expected != actual) return ERROR_CRC;
      std::copy_n(actual.begin() + digest_offset, prior.size(), prior.begin());
      if (!index && prior != anchor.prepared_sha256) return ERROR_CRC;
    }
    *workspace_output = workspace; *disk_output = disk; *digest_output = prior;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD ValidateCellVolumeProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  std::span<const CellVolumeProvisioningRecord> records) noexcept {
  if (!ValidPlan(plan) || !IdentityValid(journal) || !Nonzero(base) || records.empty() || records.size() > 6 ||
      !IsEqualGUID(disk.spec.identifier, plan.disk.identifier) || disk.spec.virtual_bytes != plan.disk.virtual_bytes ||
      disk.spec.reserved_file_bytes != plan.disk.reserved_file_bytes || journal.volume_serial != disk.control.volume_serial ||
      journal == disk.control || journal == disk.backing) return ERROR_INVALID_DATA;
  try {
    std::vector<CellDiskLayoutCheckpoint> layouts;
    return DecodeVolume({reinterpret_cast<const std::uint8_t*>(records.data()), records.size_bytes()},
      plan, journal, disk, base, &layouts);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD ValidateCellFormatProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> records) noexcept {
  if (volume.size() != 6 || records.empty() || records.size() > 2) return ERROR_INVALID_DATA;
  DWORD error = ValidateCellVolumeProvisioningPrefix(plan, journal, disk, base, volume);
  if (error) return error;
  try {
    std::vector<CellDiskLayoutCheckpoint> layouts;
    error = DecodeVolume({reinterpret_cast<const std::uint8_t*>(volume.data()), volume.size_bytes()},
      plan, journal, disk, base, &layouts);
    CellFileSha256 volume_base{};
    std::copy_n(volume.back().end() - volume_base.size(), volume_base.size(), volume_base.begin());
    std::vector<CellNtfsFormatCheckpoint> formats;
    return error ? error : DecodeFormat({reinterpret_cast<const std::uint8_t*>(records.data()), records.size_bytes()},
      plan, journal, disk, volume_base, layouts, &formats);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD ValidateCellProtectionProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  const std::wstring& owner, const std::wstring& controller, std::span<const CellVolumeProvisioningRecord> volume,
  std::span<const CellFormatProvisioningRecord> format, std::span<const CellProtectionProvisioningRecord> records) noexcept {
  if (format.size() != 2 || records.empty() || records.size() > 2) return ERROR_INVALID_DATA;
  DWORD error = ValidateCellFormatProvisioningPrefix(plan, journal, disk, base, volume, format);
  if (error) return error;
  try {
    std::vector<CellDiskLayoutCheckpoint> layouts;
    error = DecodeVolume({reinterpret_cast<const std::uint8_t*>(volume.data()), volume.size_bytes()}, plan, journal, disk, base, &layouts);
    CellFileSha256 volume_base{}, format_base{};
    std::copy_n(volume.back().end() - 32, 32, volume_base.begin());
    std::copy_n(format.back().end() - 32, 32, format_base.begin());
    std::vector<CellNtfsFormatCheckpoint> formats;
    if (!error) error = DecodeFormat({reinterpret_cast<const std::uint8_t*>(format.data()), format.size_bytes()},
      plan, journal, disk, volume_base, layouts, &formats);
    std::vector<CellVolumeProtectionCheckpoint> protections;
    return error ? error : DecodeProtection({reinterpret_cast<const std::uint8_t*>(records.data()), records.size_bytes()},
      plan, journal, disk, format_base, owner, controller, layouts, formats, &protections);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD ValidateCellMountProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellWorkspaceIdentities& workspace,
  const CellVirtualDiskRecord& disk, const CellFileSha256& base, const std::wstring& owner, const std::wstring& controller,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> format,
  std::span<const CellProtectionProvisioningRecord> protection, std::span<const CellMountProvisioningRecord> records) noexcept {
  if (protection.size() != 2 || records.empty() || records.size() > 4) return ERROR_INVALID_DATA;
  DWORD error = ValidateCellProtectionProvisioningPrefix(plan, journal, disk, base, owner, controller, volume, format, protection);
  if (error) return error;
  try {
    std::array<CellVolumeProtectionCheckpoint, 2> protections{};
    for (std::size_t index = 0; index < protections.size(); ++index)
      std::copy_n(protection[index].begin() + 280, protections[index].size(), protections[index].begin());
    CellFileSha256 protection_base{};
    std::copy_n(protection.back().end() - 32, 32, protection_base.begin());
    std::vector<CellVolumeMountCheckpoint> mounts;
    return DecodeMount({reinterpret_cast<const std::uint8_t*>(records.data()), records.size_bytes()},
      plan, journal, workspace, disk, protection_base, owner, controller, protections, &mounts);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD ValidateCellMountedWorkspaceProvisioningPrefix(const CellProvisioningPlan& plan,
  const CellFileIdentity& journal, const CellWorkspaceIdentities& workspace,
  const CellVirtualDiskRecord& disk, const CellFileSha256& base,
  const std::wstring& name, const std::wstring& owner, const std::wstring& controller,
  std::span<const CellVolumeProvisioningRecord> volume, std::span<const CellFormatProvisioningRecord> format,
  std::span<const CellProtectionProvisioningRecord> protection, std::span<const CellMountProvisioningRecord> mount,
  std::span<const CellMountedWorkspaceProvisioningRecord> records) noexcept {
  if (mount.size() != 4 || records.empty() || records.size() > 2) return ERROR_INVALID_DATA;
  DWORD error = ValidateCellMountProvisioningPrefix(plan, journal, workspace, disk, base, owner, controller, volume, format, protection, mount);
  if (error) return error;
  try {
    std::array<CellVolumeMountCheckpoint, 4> mounts{};
    for (std::size_t index = 0; index < mounts.size(); ++index)
      std::copy_n(mount[index].begin() + 280, mounts[index].size(), mounts[index].begin());
    CellFileSha256 mount_base{};
    std::copy_n(mount.back().end() - 32, 32, mount_base.begin());
    std::vector<CellMountedWorkspaceCheckpoint> workspaces;
    return DecodeMountedWorkspace({reinterpret_cast<const std::uint8_t*>(records.data()), records.size_bytes()},
      plan, journal, disk, mount_base, name, owner, controller, mounts, &workspaces);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

CellProvisioningJournal::~CellProvisioningJournal() { Close(); }
CellProvisioningJournal::CapacityReadScope::CapacityReadScope(CellProvisioningJournal& value) noexcept : owner(value) {
  if (!owner.capacity_close_pending_ && owner.capacity_read_depth_ != std::numeric_limits<unsigned>::max()) {
    ++owner.capacity_read_depth_; entered = true;
  }
}
CellProvisioningJournal::CapacityReadScope::~CapacityReadScope() {
  if (entered && --owner.capacity_read_depth_ == 0 && owner.capacity_close_pending_) owner.Close();
}
void CellProvisioningJournal::Close() noexcept {
  if (lifetime_revision_ != std::numeric_limits<std::uint64_t>::max()) ++lifetime_revision_;
  healthy_ = false; creating_ = false;
  // Revoke immediately, but do not destroy a native owner whose synchronous
  // read/copy callback is still on the stack. The outermost borrower releases it.
  if (capacity_read_depth_) { capacity_close_pending_ = true; return; }
  capacity_close_pending_ = false;
  mounted_workspace_.reset(); mount_.reset(); protection_.reset(); formatter_.reset();
  layout_.Close(); device_.Close(); attachment_.Close(); disk_.Close(); workspace_.Close();
  if (file_ != INVALID_HANDLE_VALUE) CloseHandle(file_);
  file_ = INVALID_HANDLE_VALUE;
  parent_guard_.Close();
  plan_ = {}; anchor_ = {}; committer_ = {}; workspace_record_ = {}; disk_record_ = {};
  name_.clear(); owner_.clear(); controller_.clear(); descriptor_.clear(); records_.clear();
  phase_ = CellProvisioningPhase::none;
  volume_phase_ = CellVolumeProvisioningPhase::none; layout_records_.clear(); volume_committer_ = {};
  volume_deadline_ = 0; volume_cancellation_ = nullptr;
  format_phase_ = CellFormatProvisioningPhase::none; format_records_.clear(); format_committer_ = {};
  format_deadline_ = 0; format_cancellation_ = nullptr;
  protection_phase_ = CellProtectionProvisioningPhase::none; protection_records_.clear(); protection_committer_ = {};
  protection_deadline_ = 0; protection_cancellation_ = nullptr;
  mount_phase_ = CellMountProvisioningPhase::none; mount_records_.clear(); mount_committer_ = {};
  mount_deadline_ = 0; mount_cancellation_ = nullptr;
  mounted_workspace_phase_ = CellMountedWorkspaceProvisioningPhase::none; mounted_workspace_records_.clear(); mounted_workspace_committer_ = {};
  mounted_workspace_deadline_ = 0; mounted_workspace_cancellation_ = nullptr;
}
DWORD CellProvisioningJournal::Refuse(DWORD error) noexcept {
  healthy_ = false;
  // A refusal may originate inside a layout/formatter checkpoint callback.
  // Keep its live stack/handles intact until Close; permanent attachments remain
  // retained either way. The failed journal cannot authorize further operations.
  return error;
}
DWORD CellProvisioningJournal::Initialize(HANDLE parent, const CellFileIdentity& expected_parent,
  const std::wstring& name, const std::wstring& owner, const std::wstring& controller,
  const CellProvisioningPlan& plan) noexcept {
  if (file_ != INVALID_HANDLE_VALUE || parent_guard_.parent_) return ERROR_ALREADY_INITIALIZED;
  try {
    if (!ValidPlan(plan) || !IdentityValid(expected_parent)) return ERROR_INVALID_PARAMETER;
    DWORD error = parent_guard_.Initialize(parent, expected_parent, name, owner, controller);
    if (error) return error;
    plan_ = plan; name_ = name; owner_ = owner; controller_ = controller;
    descriptor_ = parent_guard_.parent_descriptor_;
    error = MakeCellControlFileSecurity(descriptor_);
    if (error) Close();
    return error;
  } catch (...) { Close(); return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::OpenFile(bool create_new) noexcept {
  try {
    DWORD error = parent_guard_.VerifyParent();
    if (error) return error;
    const HMODULE module = GetModuleHandleW(L"ntdll.dll");
    const auto create_address = module ? GetProcAddress(module, "NtCreateFile") : nullptr;
    const auto convert_address = module ? GetProcAddress(module, "RtlNtStatusToDosError") : nullptr;
    if (!create_address || !convert_address) return ERROR_PROC_NOT_FOUND;
    decltype(&NtCreateFile) create = nullptr;
    decltype(&RtlNtStatusToDosError) convert = nullptr;
    static_assert(sizeof(create) == sizeof(create_address) && sizeof(convert) == sizeof(convert_address));
    std::memcpy(&create, &create_address, sizeof(create)); std::memcpy(&convert, &convert_address, sizeof(convert));
    const auto component = name_ + L".provisioning";
    UNICODE_STRING name{};
    name.Buffer = const_cast<wchar_t*>(component.c_str());
    name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t)); name.MaximumLength = name.Length;
    OBJECT_ATTRIBUTES attributes{};
    attributes.Length = sizeof(attributes); attributes.RootDirectory = parent_guard_.parent_;
    attributes.ObjectName = &name; attributes.Attributes = OBJ_CASE_INSENSITIVE | 0x00001000UL; // OBJ_DONT_REPARSE
    attributes.SecurityDescriptor = create_new ? descriptor_.data() : nullptr;
    IO_STATUS_BLOCK io{};
    HANDLE file = nullptr;
    const NTSTATUS status = create(&file, FILE_GENERIC_READ | FILE_GENERIC_WRITE, &attributes, &io, nullptr,
      FILE_ATTRIBUTE_NORMAL, 0, create_new ? FILE_CREATE : FILE_OPEN,
      FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_WRITE_THROUGH | FILE_OPEN_REPARSE_POINT, nullptr, 0);
    if (status < 0) return convert(status);
    file_ = file;
    return io.Information == (create_new ? 2U : 1U) ? ERROR_SUCCESS : ERROR_INVALID_STATE;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::InspectFile(std::uint64_t* size) noexcept {
  if (file_ == INVALID_HANDLE_VALUE || GetFileType(file_) != FILE_TYPE_DISK) return ERROR_INVALID_HANDLE;
  DWORD error = parent_guard_.VerifyParent();
  if (error) return error;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO identity{};
  if (!GetFileInformationByHandleEx(file_, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(file_, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(file_, FileIdInfo, &identity, sizeof(identity))) return Error();
  constexpr DWORD unsafe = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
    FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
    FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
  if ((attributes.FileAttributes & unsafe) || attributes.ReparseTag || standard.Directory || standard.DeletePending ||
      standard.NumberOfLinks != 1 || standard.EndOfFile.QuadPart < 0 || standard.EndOfFile.QuadPart > maximum_bytes ||
      standard.AllocationSize.QuadPart < standard.EndOfFile.QuadPart ||
      standard.AllocationSize.QuadPart > static_cast<LONGLONG>(kCellProvisioningJournalMaximumAllocatedBytes) ||
      identity.VolumeSerialNumber != parent_guard_.parent_identity_.volume_serial) return ERROR_ACCESS_DENIED;
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> storage{};
  if (!GetFileInformationByHandleEx(file_, FileStreamInfo, storage.data(), static_cast<DWORD>(storage.size()))) return Error();
  const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(storage.data());
  constexpr std::wstring_view default_stream = L"::$DATA";
  if (stream->NextEntryOffset || stream->StreamNameLength != default_stream.size() * sizeof(wchar_t) ||
      std::memcmp(stream->StreamName, default_stream.data(), stream->StreamNameLength)) return ERROR_ACCESS_DENIED;
  CellFileIdentity actual;
  actual.volume_serial = identity.VolumeSerialNumber;
  std::copy(std::begin(identity.FileId.Identifier), std::end(identity.FileId.Identifier), actual.file_id.begin());
  if (!IdentityValid(actual)) return ERROR_FILE_INVALID;
  if (IdentityValid(anchor_.file)) {
    if (actual != anchor_.file) return ERROR_FILE_INVALID;
  } else anchor_.file = actual; // Exclusive creation only; recovery supplies its anchor first.
  error = VerifyCellSecurity(file_, descriptor_);
  if (!error) *size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  return error;
}
DWORD CellProvisioningJournal::ReadJournal() noexcept {
  try {
    std::uint64_t size = 0;
    DWORD error = InspectFile(&size);
    if (error) return error;
    if (size < record_bytes || size % record_bytes) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    LARGE_INTEGER zero{};
    DWORD count = 0;
    if (!SetFilePointerEx(file_, zero, nullptr, FILE_BEGIN) ||
        !ReadFile(file_, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr)) return Error();
    if (count != bytes.size()) return ERROR_HANDLE_EOF;
    if (!records_.empty() && records_ != bytes) return ERROR_CRC;
    CellFileSha256 prior{};
    CellWorkspaceIdentities workspace;
    workspace.parent = parent_guard_.parent_identity_;
    CellVirtualDiskRecord disk;
    for (std::size_t position = 0; position < std::min(bytes.size(), core_bytes); position += record_bytes) {
      const auto phase = static_cast<CellProvisioningPhase>(position / record_bytes + 1);
      Record actual{}, expected{};
      std::copy_n(bytes.begin() + position, record_bytes, actual.begin());
      if (phase >= CellProvisioningPhase::workspace_recorded) {
        CellWorkspaceIdentities captured;
        captured.parent = workspace.parent;
        std::size_t offset = workspace_offset;
        for (auto& identity : captured.directories) identity = ReadIdentity(actual, offset);
        if (!ValidWorkspace(captured, anchor_.file) ||
            (phase > CellProvisioningPhase::workspace_recorded && captured != workspace)) return ERROR_INVALID_DATA;
        workspace = captured;
        if (phase == CellProvisioningPhase::disk_recorded) {
          disk = {plan_.disk, workspace.directories[1], ReadIdentity(actual, offset)};
          if (!IdentityValid(disk.backing) || disk.backing.volume_serial != workspace.parent.volume_serial ||
              disk.backing == workspace.parent || disk.backing == anchor_.file ||
              std::find(workspace.directories.begin(), workspace.directories.end(), disk.backing) != workspace.directories.end())
            return ERROR_INVALID_DATA;
        }
      }
      error = Encode(&expected, phase, plan_, workspace.parent, anchor_.file, name_, owner_, controller_, workspace, disk, prior);
      if (error) return error;
      if (expected != actual) return ERROR_CRC;
      std::copy_n(actual.begin() + digest_offset, prior.size(), prior.begin());
      if (!position && prior != anchor_.prepared_sha256) return ERROR_CRC;
    }
    std::vector<CellDiskLayoutCheckpoint> layouts;
    if (bytes.size() > core_bytes) {
      error = DecodeVolume(std::span(bytes).subspan(core_bytes, std::min(bytes.size(), volume_end) - core_bytes),
        plan_, anchor_.file, disk, prior, &layouts);
      if (error) return error;
    }
    std::vector<CellNtfsFormatCheckpoint> formats;
    if (bytes.size() > volume_end) {
      CellFileSha256 volume_base{};
      std::copy_n(bytes.begin() + volume_end - volume_base.size(), volume_base.size(), volume_base.begin());
      error = DecodeFormat(std::span(bytes).subspan(volume_end, std::min(bytes.size(), format_end) - volume_end),
        plan_, anchor_.file, disk, volume_base, layouts, &formats);
      if (error) return error;
    }
    std::vector<CellVolumeProtectionCheckpoint> protections;
    if (bytes.size() > format_end) {
      CellFileSha256 format_base{};
      std::copy_n(bytes.begin() + format_end - 32, 32, format_base.begin());
      error = DecodeProtection(std::span(bytes).subspan(format_end, std::min(bytes.size(), protection_end) - format_end), plan_, anchor_.file, disk, format_base,
        owner_, controller_, layouts, formats, &protections);
      if (error) return error;
    }
    std::vector<CellVolumeMountCheckpoint> mounts;
    if (bytes.size() > protection_end) {
      CellFileSha256 protection_base{};
      std::copy_n(bytes.begin() + protection_end - 32, 32, protection_base.begin());
      error = DecodeMount(std::span(bytes).subspan(protection_end, std::min(bytes.size(), mount_end) - protection_end),
        plan_, anchor_.file, workspace, disk, protection_base,
        owner_, controller_, protections, &mounts);
      if (error) return error;
    }
    std::uint64_t after = 0;
    std::vector<CellMountedWorkspaceCheckpoint> workspaces;
    if (bytes.size() > mount_end) {
      CellFileSha256 mount_base{};
      std::copy_n(bytes.begin() + mount_end - 32, 32, mount_base.begin());
      error = DecodeMountedWorkspace(std::span(bytes).subspan(mount_end), plan_, anchor_.file, disk, mount_base,
        name_, owner_, controller_, mounts, &workspaces);
      if (error) return error;
    }
    error = InspectFile(&after);
    if (error || after != size) return error ? error : ERROR_FILE_INVALID;
    records_ = std::move(bytes); workspace_record_ = workspace; disk_record_ = disk;
    phase_ = static_cast<CellProvisioningPhase>(std::min<std::uint64_t>(size / record_bytes, 5));
    volume_phase_ = static_cast<CellVolumeProvisioningPhase>(size > core_bytes ? (std::min<std::uint64_t>(size, volume_end) - core_bytes) / record_bytes : 0);
    layout_records_ = std::move(layouts);
    format_phase_ = static_cast<CellFormatProvisioningPhase>(size > volume_end ? (std::min<std::uint64_t>(size, format_end) - volume_end) / record_bytes : 0);
    format_records_ = std::move(formats);
    protection_phase_ = static_cast<CellProtectionProvisioningPhase>(size > format_end ? (std::min<std::uint64_t>(size, protection_end) - format_end) / record_bytes : 0);
    protection_records_ = std::move(protections);
    mount_phase_ = static_cast<CellMountProvisioningPhase>(size > protection_end ? (std::min<std::uint64_t>(size, mount_end) - protection_end) / record_bytes : 0);
    mount_records_ = std::move(mounts);
    mounted_workspace_phase_ = static_cast<CellMountedWorkspaceProvisioningPhase>(size > mount_end ? (size - mount_end) / record_bytes : 0);
    mounted_workspace_records_ = std::move(workspaces);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::Append(CellProvisioningPhase next) noexcept {
  try {
    if (!healthy_ || static_cast<unsigned>(next) != static_cast<unsigned>(phase_) + 1 ||
        next > CellProvisioningPhase::disk_recorded) return ERROR_INVALID_STATE;
    std::uint64_t size = 0;
    DWORD error = InspectFile(&size);
    if (error || size != records_.size()) return Refuse(error ? error : ERROR_FILE_INVALID);
    CellFileSha256 prior{};
    if (!records_.empty()) std::copy_n(records_.end() - prior.size(), prior.size(), prior.begin());
    Record record;
    error = Encode(&record, next, plan_, parent_guard_.parent_identity_, anchor_.file,
      name_, owner_, controller_, workspace_record_, disk_record_, prior);
    if (error) return Refuse(error);
    auto next_records = records_; // Allocate before the write boundary.
    next_records.insert(next_records.end(), record.begin(), record.end());
    LARGE_INTEGER offset{}; offset.QuadPart = static_cast<LONGLONG>(size);
    DWORD written = 0;
    if (!SetFilePointerEx(file_, offset, nullptr, FILE_BEGIN) ||
        !WriteFile(file_, record.data(), static_cast<DWORD>(record.size()), &written, nullptr)) return Refuse(Error());
    if (written != record.size()) return Refuse(ERROR_WRITE_FAULT);
    if (!FlushFileBuffers(file_)) return Refuse(Error());
    if (next == CellProvisioningPhase::prepared)
      std::copy_n(record.begin() + digest_offset, anchor_.prepared_sha256.size(), anchor_.prepared_sha256.begin());
    records_ = std::move(next_records);
    error = ReadJournal();
    if (error) return Refuse(error);
    if (!committer_.commit) return Refuse(ERROR_INVALID_STATE);
    {
      CellFileSha256 acknowledged{}, expected{};
      std::copy_n(record.begin() + digest_offset, expected.size(), expected.begin());
      error = committer_.commit(committer_.context, record, &acknowledged);
      if (error || acknowledged != expected || !healthy_ || phase_ != next)
        return Refuse(error ? error : ERROR_INVALID_DATA);
    }
    return ERROR_SUCCESS;
  } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellProvisioningJournal::Create(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& name,
  const std::wstring& owner, const std::wstring& controller, const CellProvisioningPlan& plan,
  CellProvisioningAnchor* output, const CellProvisioningCommitter* committer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!committer || !committer->commit) return ERROR_INVALID_PARAMETER;
  DWORD error = Initialize(parent, expected_parent, name, owner, controller, plan);
  if (error) return error;
  committer_ = *committer;
  error = OpenFile(true);
  if (error) { Close(); return error; }
  std::uint64_t size = 0;
  error = InspectFile(&size);
  if (error || size) return Refuse(error ? error : ERROR_INVALID_DATA);
  healthy_ = true;
  creating_ = true;
  error = Append(CellProvisioningPhase::prepared);
  if (!error) *output = anchor_;
  return error;
}
DWORD CellProvisioningJournal::OpenRecorded(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& name,
  const std::wstring& owner, const std::wstring& controller, const CellProvisioningPlan& plan,
  const CellProvisioningAnchor& anchor, std::span<const CellVolumeProvisioningRecord> expected_volume,
  std::span<const CellFormatProvisioningRecord> expected_format,
  std::span<const CellProtectionProvisioningRecord> expected_protection,
  std::span<const CellMountProvisioningRecord> expected_mount,
  std::span<const CellMountedWorkspaceProvisioningRecord> expected_mounted_workspace) noexcept {
  if (!IdentityValid(anchor.file) || !Nonzero(anchor.prepared_sha256) || anchor.file == expected_parent ||
      anchor.file.volume_serial != expected_parent.volume_serial || (!expected_volume.empty() && expected_volume.size() != 6) ||
      (!expected_format.empty() && (expected_format.size() != 2 || expected_volume.size() != 6)) ||
      (!expected_protection.empty() && (expected_protection.size() != 2 || expected_format.size() != 2 || expected_volume.size() != 6)) ||
      (!expected_mount.empty() && (expected_mount.size() != 4 || expected_protection.size() != 2 || expected_format.size() != 2 || expected_volume.size() != 6)) ||
      (!expected_mounted_workspace.empty() && (expected_mounted_workspace.size() != 2 || expected_mount.size() != 4)))
    return ERROR_INVALID_PARAMETER;
  DWORD error = Initialize(parent, expected_parent, name, owner, controller, plan);
  if (error) return error;
  anchor_ = anchor;
  error = OpenFile(false);
  if (!error) error = ReadJournal();
  if (error) return Refuse(error);
  if (!expected_volume.empty()) {
    if (records_.size() < volume_end) return Refuse(ERROR_IO_INCOMPLETE);
    for (std::size_t index = 0; index < expected_volume.size(); ++index)
      if (!std::equal(expected_volume[index].begin(), expected_volume[index].end(), records_.begin() + core_bytes + index * record_bytes))
        return Refuse(ERROR_CRC);
  }
  if (!expected_format.empty()) {
    if (records_.size() < format_end) return Refuse(ERROR_IO_INCOMPLETE);
    for (std::size_t index = 0; index < expected_format.size(); ++index)
      if (!std::equal(expected_format[index].begin(), expected_format[index].end(), records_.begin() + volume_end + index * record_bytes))
        return Refuse(ERROR_CRC);
  }
  if (!expected_protection.empty()) {
    if (records_.size() < protection_end) return Refuse(ERROR_IO_INCOMPLETE);
    for (std::size_t index = 0; index < expected_protection.size(); ++index)
      if (!std::equal(expected_protection[index].begin(), expected_protection[index].end(), records_.begin() + format_end + index * record_bytes))
        return Refuse(ERROR_CRC);
  }
  if (!expected_mount.empty()) {
    if (records_.size() < mount_end) return Refuse(ERROR_IO_INCOMPLETE);
    for (std::size_t index = 0; index < expected_mount.size(); ++index)
      if (!std::equal(expected_mount[index].begin(), expected_mount[index].end(), records_.begin() + protection_end + index * record_bytes))
        return Refuse(ERROR_CRC);
  }
  if (!expected_mounted_workspace.empty()) {
    if (records_.size() != maximum_bytes) return Refuse(ERROR_IO_INCOMPLETE);
    for (std::size_t index = 0; index < expected_mounted_workspace.size(); ++index)
      if (!std::equal(expected_mounted_workspace[index].begin(), expected_mounted_workspace[index].end(), records_.begin() + mount_end + index * record_bytes))
        return Refuse(ERROR_CRC);
  }
  if (mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::intent) return Refuse(ERROR_IO_INCOMPLETE);
  if (mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::recorded && expected_mounted_workspace.empty()) return Refuse(ERROR_NOT_SUPPORTED);
  if (mount_phase_ != CellMountProvisioningPhase::none && mount_phase_ != CellMountProvisioningPhase::mounted) return Refuse(ERROR_IO_INCOMPLETE);
  if (mount_phase_ == CellMountProvisioningPhase::mounted && expected_mount.empty()) return Refuse(ERROR_NOT_SUPPORTED);
  if (protection_phase_ == CellProtectionProvisioningPhase::intent) return Refuse(ERROR_IO_INCOMPLETE);
  if (protection_phase_ == CellProtectionProvisioningPhase::protected_root && expected_protection.empty()) return Refuse(ERROR_NOT_SUPPORTED);
  if (format_phase_ == CellFormatProvisioningPhase::intent) return Refuse(ERROR_IO_INCOMPLETE);
  if (format_phase_ == CellFormatProvisioningPhase::formatted && expected_format.empty()) return Refuse(ERROR_NOT_SUPPORTED);
  if (phase_ == CellProvisioningPhase::workspace_started || phase_ == CellProvisioningPhase::disk_started)
    return Refuse(ERROR_IO_INCOMPLETE);
  if (phase_ >= CellProvisioningPhase::workspace_recorded)
    error = workspace_.OpenRecorded(parent_guard_.parent_, workspace_record_, name_, owner_, controller_);
  if (!error && phase_ == CellProvisioningPhase::disk_recorded) {
    if (volume_phase_ == CellVolumeProvisioningPhase::none) error = disk_.OpenRecorded(workspace_, disk_record_, 10000);
    else if (volume_phase_ != CellVolumeProvisioningPhase::partitioned) error = ERROR_IO_INCOMPLETE;
    // Legacy helpers cannot silently report only the creation prefix of a volume
    // journal. A volume-aware caller must supply all independently retained bytes.
    else if (expected_volume.empty()) error = ERROR_NOT_SUPPORTED;
    else error = RecoverVolume();
  }
  if (!error && format_phase_ == CellFormatProvisioningPhase::formatted) error = RecoverFormat();
  if (!error && protection_phase_ == CellProtectionProvisioningPhase::protected_root) error = RecoverProtection();
  if (!error && mount_phase_ == CellMountProvisioningPhase::mounted) error = RecoverMount();
  if (!error && mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::recorded) error = RecoverMountedWorkspace();
  if (error) return Refuse(error);
  healthy_ = true;
  return Verify();
}
DWORD CellProvisioningJournal::Verify() noexcept {
  if (!healthy_) return ERROR_INVALID_STATE;
  DWORD error = ReadJournal();
  if (!error && phase_ >= CellProvisioningPhase::workspace_recorded) error = workspace_.Verify();
  if (!error && phase_ == CellProvisioningPhase::disk_recorded) {
    if (volume_phase_ == CellVolumeProvisioningPhase::none) error = disk_.Verify(workspace_);
    else if (volume_phase_ != CellVolumeProvisioningPhase::partitioned) error = ERROR_IO_INCOMPLETE;
    else error = layout_.Verify(workspace_, 10000);
  }
  if (!error && format_phase_ != CellFormatProvisioningPhase::none) {
    if (format_phase_ != CellFormatProvisioningPhase::formatted) error = ERROR_IO_INCOMPLETE;
    else error = formatter_ ? formatter_->Verify(workspace_, 10000) : ERROR_INVALID_STATE;
  }
  if (!error && protection_phase_ != CellProtectionProvisioningPhase::none) {
    if (protection_phase_ != CellProtectionProvisioningPhase::protected_root) error = ERROR_IO_INCOMPLETE;
    else error = protection_ ? protection_->Verify(workspace_, 10000) : ERROR_INVALID_STATE;
  }
  if (!error && mount_phase_ != CellMountProvisioningPhase::none) {
    if (mount_phase_ != CellMountProvisioningPhase::mounted) error = ERROR_IO_INCOMPLETE;
    else error = mount_ && protection_ ? mount_->Verify(*protection_, workspace_, 10000) : ERROR_INVALID_STATE;
  }
  if (!error && mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::none) {
    if (mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded) error = ERROR_IO_INCOMPLETE;
    else error = mounted_workspace_ && mount_ && protection_ ? mounted_workspace_->Verify(*mount_, *protection_, workspace_, 10000) : ERROR_INVALID_STATE;
  }
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::ProvisionWorkspace(const CellProvisioningAnchor& anchor) noexcept {
  if (!creating_ || anchor != anchor_ || phase_ != CellProvisioningPhase::prepared) return ERROR_INVALID_STATE;
  DWORD error = Verify();
  if (!error) error = Append(CellProvisioningPhase::workspace_started);
  if (!error) error = workspace_.Create(parent_guard_.parent_, parent_guard_.parent_identity_, name_, owner_, controller_);
  if (!error) error = workspace_.RecordIdentities(&workspace_record_);
  if (!error) error = Append(CellProvisioningPhase::workspace_recorded);
  return error ? Refuse(error) : Verify();
}
DWORD CellProvisioningJournal::ProvisionDisk(const CellProvisioningAnchor& anchor, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!creating_ || anchor != anchor_ || phase_ != CellProvisioningPhase::workspace_recorded) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD waited = WaitForSingleObject(cancellation, 0);
    if (waited != WAIT_TIMEOUT) return waited == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
  }
  DWORD error = Verify();
  if (!error) error = Append(CellProvisioningPhase::disk_started);
  if (!error) error = disk_.Create(workspace_, plan_.disk, wall_limit_ms, cancellation);
  if (!error) error = disk_.RecordIdentity(workspace_, &disk_record_);
  if (!error) error = Append(CellProvisioningPhase::disk_recorded);
  return error ? Refuse(error) : Verify();
}
DWORD CellProvisioningJournal::RecordWorkspace(CellWorkspaceIdentities* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (phase_ != CellProvisioningPhase::workspace_recorded && phase_ != CellProvisioningPhase::disk_recorded) return ERROR_INVALID_STATE;
  const DWORD error = Verify();
  if (!error) *output = workspace_record_;
  return error;
}
DWORD CellProvisioningJournal::RecordDisk(CellVirtualDiskRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (phase_ != CellProvisioningPhase::disk_recorded) return ERROR_INVALID_STATE;
  const DWORD error = Verify();
  if (!error) *output = disk_record_;
  return error;
}
DWORD CellProvisioningJournal::RecordCheckpoints(std::vector<CellProvisioningRecord>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  DWORD error = Verify();
  if (error) return error;
  try {
    std::vector<CellProvisioningRecord> captured(std::min(records_.size(), core_bytes) / record_bytes);
    for (std::size_t i = 0; i < captured.size(); ++i)
      std::copy_n(records_.begin() + i * record_bytes, record_bytes, captured[i].begin());
    *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::RecordDiskLayoutPlan(CellDiskLayoutPlan* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  CellVirtualDiskRecord disk;
  const DWORD error = RecordDisk(&disk);
  return error ? error : DeriveCellDiskLayoutPlan(disk, plan_.assignment_binding, plan_.profile_sha256, output);
}
DWORD CellProvisioningJournal::CheckVolume() noexcept {
  if (!healthy_ || !creating_ || !volume_committer_.authorize || !volume_committer_.commit) return ERROR_INVALID_STATE;
  DWORD error = VolumeControl(volume_deadline_, volume_cancellation_);
  if (!error) error = volume_committer_.authorize(volume_committer_.context);
  if (!error && (!healthy_ || !creating_)) error = ERROR_INVALID_STATE;
  if (!error) error = VolumeControl(volume_deadline_, volume_cancellation_);
  return error;
}
DWORD CellProvisioningJournal::AppendVolume(CellVolumeProvisioningPhase next, const CellDiskLayoutCheckpoint* layout) noexcept {
  try {
    if (!healthy_ || !creating_ || phase_ != CellProvisioningPhase::disk_recorded ||
        static_cast<unsigned>(next) != static_cast<unsigned>(volume_phase_) + 1 ||
        next > CellVolumeProvisioningPhase::partitioned) return ERROR_INVALID_STATE;
    DWORD error = CheckVolume();
    if (!error) error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 base{}, previous{};
    std::copy_n(records_.begin() + core_bytes - base.size(), base.size(), base.begin());
    std::copy_n(records_.end() - previous.size(), previous.size(), previous.begin());
    Record record{};
    error = EncodeVolume(&record, static_cast<unsigned>(next), plan_, anchor_.file, disk_record_, base, previous, layout);
    if (error) return Refuse(error);
    auto next_records = records_; // All allocation/validation precedes the write.
    next_records.insert(next_records.end(), record.begin(), record.end());
    std::vector<CellDiskLayoutCheckpoint> checked;
    error = DecodeVolume(std::span(next_records).subspan(core_bytes), plan_, anchor_.file, disk_record_, base, &checked);
    if (!error) error = CheckVolume();
    if (error) return Refuse(error);
    const auto before = records_.size();
    LARGE_INTEGER offset{}; offset.QuadPart = static_cast<LONGLONG>(before);
    DWORD written = 0;
    if (!SetFilePointerEx(file_, offset, nullptr, FILE_BEGIN) ||
        !WriteFile(file_, record.data(), static_cast<DWORD>(record.size()), &written, nullptr)) return Refuse(Error());
    if (written != record.size()) return Refuse(ERROR_WRITE_FAULT);
    if (!FlushFileBuffers(file_)) return Refuse(Error());
    records_ = std::move(next_records);
    error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 expected{}, acknowledged{};
    std::copy_n(record.begin() + digest_offset, expected.size(), expected.begin());
    error = volume_committer_.commit(volume_committer_.context, record, &acknowledged);
    if (!error && (acknowledged != expected || !healthy_ || volume_phase_ != next)) error = ERROR_INVALID_DATA;
    if (!error) error = CheckVolume();
    return error ? Refuse(error) : ERROR_SUCCESS;
  } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellProvisioningJournal::RunVolume(const VolumeOperations& operations,
  const CellVolumeProvisioningCommitter& committer, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!healthy_ || !creating_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::none) return ERROR_INVALID_STATE;
  if (!committer.authorize || !committer.commit || !operations.verify || !operations.attach || !operations.layout)
    return ERROR_INVALID_PARAMETER;
  volume_committer_ = committer; volume_deadline_ = deadline; volume_cancellation_ = cancellation;
  DWORD error = CheckVolume();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = AppendVolume(CellVolumeProvisioningPhase::attachment_intent);
  if (!error) error = CheckVolume();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckVolume();
  if (!error) error = operations.attach(operations.context);
  if (!error) error = CheckVolume();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = AppendVolume(CellVolumeProvisioningPhase::attached);
  const CellDiskLayoutCommitter bridge{
    [](void* context, const CellDiskLayoutCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
      if (!acknowledged) return ERROR_INVALID_PARAMETER;
      *acknowledged = {};
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const unsigned sequence = static_cast<unsigned>(journal.volume_phase_) + 1;
      if (sequence < 3 || sequence > 6) return ERROR_INVALID_STATE;
      const DWORD result = journal.AppendVolume(static_cast<CellVolumeProvisioningPhase>(sequence), &record);
      if (!result) std::copy_n(record.end() - acknowledged->size(), acknowledged->size(), acknowledged->begin());
      return result;
    },
    [](void* context) noexcept -> DWORD { return static_cast<CellProvisioningJournal*>(context)->CheckVolume(); }, this,
  };
  if (!error) error = CheckVolume();
  if (!error) error = operations.layout(operations.context, bridge);
  if (!error && volume_phase_ != CellVolumeProvisioningPhase::partitioned) error = ERROR_IO_INCOMPLETE;
  if (!error) error = CheckVolume();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckVolume();
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::ProvisionVolume(const CellProvisioningAnchor& anchor,
  const CellVolumeProvisioningCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!creating_ || !healthy_ || anchor != anchor_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::none) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.authorize || !committer.commit) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = VolumeControl(deadline, cancellation);
  CellDiskLayoutPlan plan;
  if (!error) error = RecordDiskLayoutPlan(&plan);
  if (!error) error = CheckCellVolumeManagementPrivilege();
  if (error) return Refuse(error);
  const VolumeOperations operations{
    [](void* context) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      if (journal.attachment_.State() == CellAttachmentState::attached) return journal.attachment_.Verify(journal.workspace_);
      return journal.disk_.Verify(journal.workspace_);
    },
    [](void* context) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.volume_deadline_);
      return remaining ? journal.attachment_.Attach(journal.disk_, journal.workspace_, remaining, journal.volume_cancellation_)
        : ERROR_TIMEOUT;
    },
    [](void* context, const CellDiskLayoutCommitter& bridge) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      CellDiskLayoutPlan layout_plan;
      DWORD result = DeriveCellDiskLayoutPlan(journal.disk_record_, journal.plan_.assignment_binding,
        journal.plan_.profile_sha256, &layout_plan);
      DWORD remaining = Remaining(journal.volume_deadline_);
      if (!result) result = remaining ? journal.device_.Open(journal.attachment_, journal.workspace_, remaining,
        journal.volume_cancellation_) : ERROR_TIMEOUT;
      remaining = Remaining(journal.volume_deadline_);
      if (!result) result = remaining ? journal.layout_.Create(journal.device_, journal.workspace_, layout_plan, bridge,
        remaining, journal.volume_cancellation_) : ERROR_TIMEOUT;
      return result;
    }, this,
  };
  error = RunVolume(operations, committer, deadline, cancellation);
  if (!error) error = Verify();
  if (!error) error = CheckVolume(); // Final native readback cannot outlive its grant or deadline.
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::RecoverVolume() noexcept {
  if (volume_phase_ != CellVolumeProvisioningPhase::partitioned || layout_records_.size() != 4) return ERROR_IO_INCOMPLETE;
  CellDiskLayoutPlan plan;
  DWORD error = DeriveCellDiskLayoutPlan(disk_record_, plan_.assignment_binding, plan_.profile_sha256, &plan);
  const ULONGLONG deadline = GetTickCount64() + 10000;
  if (!error) error = attachment_.OpenRecorded(workspace_, disk_record_, Remaining(deadline));
  DWORD remaining = Remaining(deadline);
  if (!error) error = remaining ? device_.Open(attachment_, workspace_, remaining) : ERROR_TIMEOUT;
  remaining = Remaining(deadline);
  if (!error) error = remaining ? layout_.OpenRecorded(device_, workspace_, plan, layout_records_, remaining) : ERROR_TIMEOUT;
  return error;
}
DWORD CellProvisioningJournal::RecordVolumeCheckpoints(std::vector<CellVolumeProvisioningRecord>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  const DWORD error = Verify();
  if (error) return error;
  try {
    if (records_.size() <= core_bytes) return ERROR_SUCCESS;
    std::vector<CellVolumeProvisioningRecord> captured((std::min(records_.size(), volume_end) - core_bytes) / record_bytes);
    for (std::size_t index = 0; index < captured.size(); ++index)
      std::copy_n(records_.begin() + core_bytes + index * record_bytes, record_bytes, captured[index].begin());
    *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::CheckFormat() noexcept {
  if (!healthy_ || !creating_ || !format_committer_.authorize || !format_committer_.commit ||
      phase_ != CellProvisioningPhase::disk_recorded || volume_phase_ != CellVolumeProvisioningPhase::partitioned)
    return ERROR_INVALID_STATE;
  DWORD error = VolumeControl(format_deadline_, format_cancellation_);
  if (!error) error = format_committer_.authorize(format_committer_.context);
  if (!error && (!healthy_ || !creating_)) error = ERROR_INVALID_STATE;
  if (!error) error = VolumeControl(format_deadline_, format_cancellation_);
  return error;
}
DWORD CellProvisioningJournal::AppendFormat(CellFormatProvisioningPhase next, const CellNtfsFormatCheckpoint& checkpoint) noexcept {
  try {
    if (static_cast<unsigned>(next) != static_cast<unsigned>(format_phase_) + 1 ||
        next > CellFormatProvisioningPhase::formatted) return ERROR_INVALID_STATE;
    DWORD error = CheckFormat();
    if (!error) error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 base{}, previous{};
    std::copy_n(records_.begin() + volume_end - base.size(), base.size(), base.begin());
    std::copy_n(records_.end() - previous.size(), previous.size(), previous.begin());
    Record record{};
    error = EncodeStorageRecord(&record, "GCCFMT01", static_cast<unsigned>(next), plan_, anchor_.file, disk_record_, base, previous, &checkpoint);
    if (error) return Refuse(error);
    auto next_records = records_;
    next_records.insert(next_records.end(), record.begin(), record.end());
    std::vector<CellNtfsFormatCheckpoint> checked;
    error = DecodeFormat(std::span(next_records).subspan(volume_end), plan_, anchor_.file, disk_record_, base, layout_records_, &checked);
    if (!error) error = CheckFormat();
    if (error) return Refuse(error);
    LARGE_INTEGER offset{}; offset.QuadPart = static_cast<LONGLONG>(records_.size());
    DWORD written = 0;
    if (!SetFilePointerEx(file_, offset, nullptr, FILE_BEGIN) ||
        !WriteFile(file_, record.data(), static_cast<DWORD>(record.size()), &written, nullptr)) return Refuse(Error());
    if (written != record.size()) return Refuse(ERROR_WRITE_FAULT);
    if (!FlushFileBuffers(file_)) return Refuse(Error());
    records_ = std::move(next_records);
    error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 expected{}, acknowledged{};
    std::copy_n(record.begin() + digest_offset, expected.size(), expected.begin());
    error = format_committer_.commit(format_committer_.context, record, &acknowledged);
    if (!error && (acknowledged != expected || !healthy_ || format_phase_ != next)) error = ERROR_INVALID_DATA;
    if (!error) error = CheckFormat();
    return error ? Refuse(error) : ERROR_SUCCESS;
  } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellProvisioningJournal::RunFormat(const FormatOperations& operations,
  const CellFormatProvisioningCommitter& committer, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!healthy_ || !creating_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::none)
    return ERROR_INVALID_STATE;
  if (!committer.authorize || !committer.commit || !operations.verify || !operations.format) return ERROR_INVALID_PARAMETER;
  format_committer_ = committer; format_deadline_ = deadline; format_cancellation_ = cancellation;
  const CellNtfsFormatCommitter bridge{
    [](void* context, const CellNtfsFormatCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
      if (!acknowledged) return ERROR_INVALID_PARAMETER;
      *acknowledged = {};
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const unsigned sequence = static_cast<unsigned>(journal.format_phase_) + 1;
      if (sequence > 2) return ERROR_INVALID_STATE;
      const DWORD error = journal.AppendFormat(static_cast<CellFormatProvisioningPhase>(sequence), record);
      // The formatter may submit Windows work only after the outer record was
      // durably acknowledged under current authority. Its own hash stays exact.
      if (!error) std::copy_n(record.end() - acknowledged->size(), acknowledged->size(), acknowledged->begin());
      return error;
    },
    [](void* context) noexcept -> DWORD { return static_cast<CellProvisioningJournal*>(context)->CheckFormat(); }, this,
  };
  DWORD error = CheckFormat();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckFormat();
  if (!error) error = operations.format(operations.context, bridge);
  if (!error && format_phase_ != CellFormatProvisioningPhase::formatted) error = ERROR_IO_INCOMPLETE;
  if (!error) error = CheckFormat();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckFormat();
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::ProvisionFormat(const CellProvisioningAnchor& anchor,
  const CellFormatProvisioningCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!creating_ || !healthy_ || anchor != anchor_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::none)
    return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.authorize || !committer.commit) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = VolumeControl(deadline, cancellation);
  if (!error) error = Verify();
  if (!error) error = CheckCellVolumeManagementPrivilege();
  if (error) return Refuse(error);
  try { formatter_ = std::make_unique<CellNtfsFormat>(); } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
  const FormatOperations operations{
    [](void* context) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.format_deadline_);
      if (!remaining) return ERROR_TIMEOUT;
      if (journal.format_phase_ == CellFormatProvisioningPhase::formatted)
        return journal.formatter_->Verify(journal.workspace_, remaining, journal.format_cancellation_);
      return journal.layout_.Verify(journal.workspace_, remaining, journal.format_cancellation_);
    },
    [](void* context, const CellNtfsFormatCommitter& bridge) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.format_deadline_);
      return remaining ? journal.formatter_->Create(journal.layout_, journal.workspace_, bridge, remaining, journal.format_cancellation_)
        : ERROR_TIMEOUT;
    }, this,
  };
  error = RunFormat(operations, committer, deadline, cancellation);
  if (!error) error = Verify();
  if (!error) error = CheckFormat();
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::RecoverFormat() noexcept {
  if (format_phase_ != CellFormatProvisioningPhase::formatted || format_records_.size() != 2) return ERROR_IO_INCOMPLETE;
  try { formatter_ = std::make_unique<CellNtfsFormat>(); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  return formatter_->OpenRecorded(layout_, workspace_, format_records_, 10000);
}
DWORD CellProvisioningJournal::RecordFormatCheckpoints(std::vector<CellFormatProvisioningRecord>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  const DWORD error = Verify();
  if (error) return error;
  try {
    if (records_.size() <= volume_end) return ERROR_SUCCESS;
    std::vector<CellFormatProvisioningRecord> captured((std::min(records_.size(), format_end) - volume_end) / record_bytes);
    for (std::size_t index = 0; index < captured.size(); ++index)
      std::copy_n(records_.begin() + volume_end + index * record_bytes, record_bytes, captured[index].begin());
    *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::CheckProtection() noexcept {
  if (!healthy_ || !creating_ || !protection_committer_.authorize || !protection_committer_.commit ||
      phase_ != CellProvisioningPhase::disk_recorded || volume_phase_ != CellVolumeProvisioningPhase::partitioned ||
      format_phase_ != CellFormatProvisioningPhase::formatted) return ERROR_INVALID_STATE;
  DWORD error = VolumeControl(protection_deadline_, protection_cancellation_);
  if (!error) error = protection_committer_.authorize(protection_committer_.context);
  if (!error && (!healthy_ || !creating_)) error = ERROR_INVALID_STATE;
  return error ? error : VolumeControl(protection_deadline_, protection_cancellation_);
}
DWORD CellProvisioningJournal::AppendProtection(CellProtectionProvisioningPhase next, const CellVolumeProtectionCheckpoint& checkpoint) noexcept {
  try {
    if (static_cast<unsigned>(next) != static_cast<unsigned>(protection_phase_) + 1 ||
        next > CellProtectionProvisioningPhase::protected_root) return ERROR_INVALID_STATE;
    DWORD error = CheckProtection();
    if (!error) error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 base{}, previous{};
    std::copy_n(records_.begin() + format_end - 32, 32, base.begin());
    std::copy_n(records_.end() - 32, 32, previous.begin());
    Record record{};
    error = EncodeStorageRecord(&record, "GCCPRV01", static_cast<unsigned>(next), plan_, anchor_.file, disk_record_, base, previous, &checkpoint);
    if (error) return Refuse(error);
    auto next_records = records_;
    next_records.insert(next_records.end(), record.begin(), record.end());
    std::vector<CellVolumeProtectionCheckpoint> checked;
    error = DecodeProtection(std::span(next_records).subspan(format_end), plan_, anchor_.file, disk_record_, base,
      owner_, controller_, layout_records_, format_records_, &checked);
    if (!error) error = CheckProtection();
    if (error) return Refuse(error);
    LARGE_INTEGER offset{}; offset.QuadPart = static_cast<LONGLONG>(records_.size());
    DWORD written = 0;
    if (!SetFilePointerEx(file_, offset, nullptr, FILE_BEGIN) ||
        !WriteFile(file_, record.data(), static_cast<DWORD>(record.size()), &written, nullptr)) return Refuse(Error());
    if (written != record.size()) return Refuse(ERROR_WRITE_FAULT);
    if (!FlushFileBuffers(file_)) return Refuse(Error());
    records_ = std::move(next_records);
    error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 expected{}, acknowledged{};
    std::copy_n(record.begin() + digest_offset, expected.size(), expected.begin());
    error = protection_committer_.commit(protection_committer_.context, record, &acknowledged);
    if (!error && (acknowledged != expected || !healthy_ || protection_phase_ != next)) error = ERROR_INVALID_DATA;
    if (!error) error = CheckProtection();
    return error ? Refuse(error) : ERROR_SUCCESS;
  } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellProvisioningJournal::RunProtection(const ProtectionOperations& operations,
  const CellProtectionProvisioningCommitter& committer, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!healthy_ || !creating_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::formatted ||
      protection_phase_ != CellProtectionProvisioningPhase::none) return ERROR_INVALID_STATE;
  if (!committer.authorize || !committer.commit || !operations.verify || !operations.protect) return ERROR_INVALID_PARAMETER;
  protection_committer_ = committer; protection_deadline_ = deadline; protection_cancellation_ = cancellation;
  const CellVolumeProtectionCommitter bridge{
    [](void* context, const CellVolumeProtectionCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
      if (!acknowledged) return ERROR_INVALID_PARAMETER;
      *acknowledged = {};
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const unsigned sequence = static_cast<unsigned>(journal.protection_phase_) + 1;
      if (sequence > 2) return ERROR_INVALID_STATE;
      const DWORD error = journal.AppendProtection(static_cast<CellProtectionProvisioningPhase>(sequence), record);
      if (!error) std::copy_n(record.end() - 32, 32, acknowledged->begin());
      return error;
    },
    [](void* context) noexcept -> DWORD { return static_cast<CellProvisioningJournal*>(context)->CheckProtection(); }, this,
  };
  DWORD error = CheckProtection();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckProtection();
  if (!error) error = operations.protect(operations.context, bridge);
  if (!error && protection_phase_ != CellProtectionProvisioningPhase::protected_root) error = ERROR_IO_INCOMPLETE;
  if (!error) error = CheckProtection();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckProtection();
  if (!error) error = operations.verify(operations.context);
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::ProvisionProtection(const CellProvisioningAnchor& anchor,
  const CellProtectionProvisioningCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!creating_ || !healthy_ || anchor != anchor_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::formatted ||
      protection_phase_ != CellProtectionProvisioningPhase::none || !formatter_) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.authorize || !committer.commit) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = VolumeControl(deadline, cancellation);
  if (!error) error = Verify();
  if (error) return Refuse(error);
  try { protection_ = std::make_unique<CellVolumeProtection>(); } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
  const ProtectionOperations operations{
    [](void* context) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.protection_deadline_);
      if (!remaining) return ERROR_TIMEOUT;
      if (journal.protection_phase_ == CellProtectionProvisioningPhase::protected_root)
        return journal.protection_->Verify(journal.workspace_, remaining, journal.protection_cancellation_);
      return journal.formatter_->Verify(journal.workspace_, remaining, journal.protection_cancellation_);
    },
    [](void* context, const CellVolumeProtectionCommitter& bridge) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.protection_deadline_);
      return remaining ? journal.protection_->Create(*journal.formatter_, journal.workspace_, journal.owner_, journal.controller_,
        bridge, remaining, journal.protection_cancellation_) : ERROR_TIMEOUT;
    }, this,
  };
  error = RunProtection(operations, committer, deadline, cancellation);
  if (!error) error = CheckProtection();
  if (!error) error = Verify();
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::RecoverProtection() noexcept {
  if (protection_phase_ != CellProtectionProvisioningPhase::protected_root || protection_records_.size() != 2 || !formatter_)
    return ERROR_IO_INCOMPLETE;
  try { protection_ = std::make_unique<CellVolumeProtection>(); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  return protection_->OpenRecorded(*formatter_, workspace_, owner_, controller_, protection_records_, 10000);
}
DWORD CellProvisioningJournal::RecordProtectionCheckpoints(std::vector<CellProtectionProvisioningRecord>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  const DWORD error = Verify();
  if (error) return error;
  try {
    if (records_.size() <= format_end) return ERROR_SUCCESS;
    std::vector<CellProtectionProvisioningRecord> captured((std::min(records_.size(), protection_end) - format_end) / record_bytes);
    for (std::size_t index = 0; index < captured.size(); ++index)
      std::copy_n(records_.begin() + format_end + index * record_bytes, record_bytes, captured[index].begin());
    *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::CheckMount() noexcept {
  const auto eligible = [&]() noexcept {
    return healthy_ && creating_ && mount_committer_.authorize && mount_committer_.commit &&
      phase_ == CellProvisioningPhase::disk_recorded && volume_phase_ == CellVolumeProvisioningPhase::partitioned &&
      format_phase_ == CellFormatProvisioningPhase::formatted && protection_phase_ == CellProtectionProvisioningPhase::protected_root;
  };
  if (!eligible()) return ERROR_INVALID_STATE;
  DWORD error = VolumeControl(mount_deadline_, mount_cancellation_);
  if (!error) error = mount_committer_.authorize(mount_committer_.context);
  if (!error && !eligible()) error = ERROR_INVALID_STATE;
  return error ? error : VolumeControl(mount_deadline_, mount_cancellation_);
}
DWORD CellProvisioningJournal::AppendMount(CellMountProvisioningPhase next, const CellVolumeMountCheckpoint& checkpoint) noexcept {
  try {
    if (static_cast<unsigned>(next) != static_cast<unsigned>(mount_phase_) + 1 || next > CellMountProvisioningPhase::mounted)
      return ERROR_INVALID_STATE;
    DWORD error = CheckMount();
    if (!error) error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 base{}, previous{};
    std::copy_n(records_.begin() + protection_end - 32, 32, base.begin());
    std::copy_n(records_.end() - 32, 32, previous.begin());
    Record record{};
    error = EncodeStorageRecord(&record, "GCCMNV01", static_cast<unsigned>(next), plan_, anchor_.file, disk_record_, base, previous, &checkpoint);
    if (error) return Refuse(error);
    auto next_records = records_;
    next_records.insert(next_records.end(), record.begin(), record.end());
    std::vector<CellVolumeMountCheckpoint> checked;
    error = DecodeMount(std::span(next_records).subspan(protection_end), plan_, anchor_.file, workspace_record_, disk_record_, base,
      owner_, controller_, protection_records_, &checked);
    if (!error) error = CheckMount();
    // The last blocking authority exchange precedes a fresh held-file read.
    if (!error) error = ReadJournal();
    if (!error) error = VolumeControl(mount_deadline_, mount_cancellation_);
    if (error) return Refuse(error);
    LARGE_INTEGER offset{}; offset.QuadPart = static_cast<LONGLONG>(records_.size());
    DWORD written = 0;
    if (!SetFilePointerEx(file_, offset, nullptr, FILE_BEGIN) ||
        !WriteFile(file_, record.data(), static_cast<DWORD>(record.size()), &written, nullptr)) return Refuse(Error());
    if (written != record.size()) return Refuse(ERROR_WRITE_FAULT);
    if (!FlushFileBuffers(file_)) return Refuse(Error());
    records_ = std::move(next_records);
    error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 expected{}, acknowledged{};
    std::copy_n(record.begin() + digest_offset, expected.size(), expected.begin());
    error = mount_committer_.commit(mount_committer_.context, record, &acknowledged);
    if (!error && (acknowledged != expected || !healthy_ || mount_phase_ != next)) error = ERROR_INVALID_DATA;
    if (!error) error = CheckMount();
    return error ? Refuse(error) : ERROR_SUCCESS;
  } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellProvisioningJournal::RunMount(const MountOperations& operations, const CellMountProvisioningCommitter& committer,
  ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!healthy_ || !creating_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::formatted ||
      protection_phase_ != CellProtectionProvisioningPhase::protected_root || mount_phase_ != CellMountProvisioningPhase::none)
    return ERROR_INVALID_STATE;
  if (!committer.authorize || !committer.commit || !operations.verify || !operations.mount) return ERROR_INVALID_PARAMETER;
  mount_committer_ = committer; mount_deadline_ = deadline; mount_cancellation_ = cancellation;
  const CellVolumeMountCommitter bridge{
    [](void* context, const CellVolumeMountCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
      if (!acknowledged) return ERROR_INVALID_PARAMETER;
      *acknowledged = {};
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const unsigned sequence = static_cast<unsigned>(journal.mount_phase_) + 1;
      if (sequence > 4) return ERROR_INVALID_STATE;
      const DWORD error = journal.AppendMount(static_cast<CellMountProvisioningPhase>(sequence), record);
      if (!error) std::copy_n(record.end() - 32, 32, acknowledged->begin());
      return error;
    },
    [](void* context) noexcept -> DWORD { return static_cast<CellProvisioningJournal*>(context)->CheckMount(); }, this,
  };
  DWORD error = CheckMount();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckMount();
  if (!error) error = operations.mount(operations.context, bridge);
  if (!error && mount_phase_ != CellMountProvisioningPhase::mounted) error = ERROR_IO_INCOMPLETE;
  if (!error) error = CheckMount();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckMount();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = VolumeControl(deadline, cancellation);
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::ProvisionMount(const CellProvisioningAnchor& anchor,
  const CellMountProvisioningCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!creating_ || !healthy_ || anchor != anchor_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::formatted ||
      protection_phase_ != CellProtectionProvisioningPhase::protected_root || mount_phase_ != CellMountProvisioningPhase::none || !protection_)
    return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.authorize || !committer.commit) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = VolumeControl(deadline, cancellation);
  if (!error) error = Verify();
  if (error) return Refuse(error);
  try { mount_ = std::make_unique<CellVolumeMount>(); } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
  const MountOperations operations{
    [](void* context) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.mount_deadline_);
      if (!remaining) return ERROR_TIMEOUT;
      if (journal.mount_phase_ == CellMountProvisioningPhase::mounted)
        return journal.mount_->Verify(*journal.protection_, journal.workspace_, remaining, journal.mount_cancellation_);
      return journal.protection_->Verify(journal.workspace_, remaining, journal.mount_cancellation_);
    },
    [](void* context, const CellVolumeMountCommitter& bridge) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.mount_deadline_);
      return remaining ? journal.mount_->Create(*journal.protection_, journal.workspace_, bridge, remaining, journal.mount_cancellation_) : ERROR_TIMEOUT;
    }, this,
  };
  error = RunMount(operations, committer, deadline, cancellation);
  if (!error) error = CheckMount();
  if (!error) error = Verify();
  if (!error) error = VolumeControl(deadline, cancellation);
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::RecoverMount() noexcept {
  if (mount_phase_ != CellMountProvisioningPhase::mounted || mount_records_.size() != 4 || !protection_) return ERROR_IO_INCOMPLETE;
  try { mount_ = std::make_unique<CellVolumeMount>(); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  return mount_->OpenRecorded(*protection_, workspace_, mount_records_, 10000);
}
DWORD CellProvisioningJournal::RecordMountCheckpoints(std::vector<CellMountProvisioningRecord>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  const DWORD error = Verify();
  if (error) return error;
  try {
    if (records_.size() <= protection_end) return ERROR_SUCCESS;
    std::vector<CellMountProvisioningRecord> captured((std::min(records_.size(), mount_end) - protection_end) / record_bytes);
    for (std::size_t index = 0; index < captured.size(); ++index)
      std::copy_n(records_.begin() + protection_end + index * record_bytes, record_bytes, captured[index].begin());
    *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::CheckMountedWorkspace() noexcept {
  const auto eligible = [&]() noexcept {
    return healthy_ && creating_ && mounted_workspace_committer_.authorize && mounted_workspace_committer_.commit &&
      phase_ == CellProvisioningPhase::disk_recorded && volume_phase_ == CellVolumeProvisioningPhase::partitioned &&
      format_phase_ == CellFormatProvisioningPhase::formatted && protection_phase_ == CellProtectionProvisioningPhase::protected_root &&
      mount_phase_ == CellMountProvisioningPhase::mounted;
  };
  if (!eligible()) return ERROR_INVALID_STATE;
  DWORD error = VolumeControl(mounted_workspace_deadline_, mounted_workspace_cancellation_);
  if (!error) error = mounted_workspace_committer_.authorize(mounted_workspace_committer_.context);
  if (!error) error = ReadJournal();
  if (!error && !eligible()) error = ERROR_INVALID_STATE;
  return error ? error : VolumeControl(mounted_workspace_deadline_, mounted_workspace_cancellation_);
}
DWORD CellProvisioningJournal::AppendMountedWorkspace(CellMountedWorkspaceProvisioningPhase next,
  const CellMountedWorkspaceCheckpoint& checkpoint) noexcept {
  try {
    if (static_cast<unsigned>(next) != static_cast<unsigned>(mounted_workspace_phase_) + 1 ||
        next > CellMountedWorkspaceProvisioningPhase::recorded) return ERROR_INVALID_STATE;
    DWORD error = CheckMountedWorkspace();
    if (!error) error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 base{}, previous{};
    std::copy_n(records_.begin() + mount_end - 32, 32, base.begin());
    std::copy_n(records_.end() - 32, 32, previous.begin());
    Record record{};
    error = EncodeStorageRecord(&record, "GCCMWP01", static_cast<unsigned>(next), plan_, anchor_.file, disk_record_, base, previous, &checkpoint);
    if (error) return Refuse(error);
    auto next_records = records_;
    next_records.insert(next_records.end(), record.begin(), record.end());
    std::vector<CellMountedWorkspaceCheckpoint> checked;
    error = DecodeMountedWorkspace(std::span(next_records).subspan(mount_end), plan_, anchor_.file, disk_record_, base,
      name_, owner_, controller_, mount_records_, &checked);
    if (!error) error = CheckMountedWorkspace();
    // A callback can block or change retained state. Read the held file again
    // after the last authority exchange and before appending any bytes.
    if (!error) error = ReadJournal();
    if (!error) error = VolumeControl(mounted_workspace_deadline_, mounted_workspace_cancellation_);
    if (error) return Refuse(error);
    LARGE_INTEGER offset{}; offset.QuadPart = static_cast<LONGLONG>(records_.size());
    DWORD written = 0;
    if (!SetFilePointerEx(file_, offset, nullptr, FILE_BEGIN) ||
        !WriteFile(file_, record.data(), static_cast<DWORD>(record.size()), &written, nullptr)) return Refuse(Error());
    if (written != record.size()) return Refuse(ERROR_WRITE_FAULT);
    if (!FlushFileBuffers(file_)) return Refuse(Error());
    records_ = std::move(next_records);
    error = ReadJournal();
    if (error) return Refuse(error);
    CellFileSha256 expected{}, acknowledged{};
    std::copy_n(record.begin() + digest_offset, expected.size(), expected.begin());
    error = mounted_workspace_committer_.commit(mounted_workspace_committer_.context, record, &acknowledged);
    if (!error && (acknowledged != expected || !healthy_ || mounted_workspace_phase_ != next)) error = ERROR_INVALID_DATA;
    if (!error) error = CheckMountedWorkspace();
    return error ? Refuse(error) : ERROR_SUCCESS;
  } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellProvisioningJournal::RunMountedWorkspace(const MountedWorkspaceOperations& operations,
  const CellMountedWorkspaceProvisioningCommitter& committer, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!healthy_ || !creating_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::formatted ||
      protection_phase_ != CellProtectionProvisioningPhase::protected_root || mount_phase_ != CellMountProvisioningPhase::mounted ||
      mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::none) return ERROR_INVALID_STATE;
  if (!committer.authorize || !committer.commit || !operations.verify || !operations.create) return ERROR_INVALID_PARAMETER;
  mounted_workspace_committer_ = committer; mounted_workspace_deadline_ = deadline; mounted_workspace_cancellation_ = cancellation;
  const CellMountedWorkspaceCommitter bridge{
    [](void* context, const CellMountedWorkspaceCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
      if (!acknowledged) return ERROR_INVALID_PARAMETER;
      *acknowledged = {};
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const unsigned sequence = static_cast<unsigned>(journal.mounted_workspace_phase_) + 1;
      if (sequence > 2) return ERROR_INVALID_STATE;
      const DWORD error = journal.AppendMountedWorkspace(static_cast<CellMountedWorkspaceProvisioningPhase>(sequence), record);
      if (!error) std::copy_n(record.end() - 32, 32, acknowledged->begin());
      return error;
    },
    [](void* context) noexcept -> DWORD { return static_cast<CellProvisioningJournal*>(context)->CheckMountedWorkspace(); }, this,
  };
  DWORD error = CheckMountedWorkspace();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckMountedWorkspace();
  if (!error) error = operations.create(operations.context, bridge);
  if (!error && mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded) error = ERROR_IO_INCOMPLETE;
  if (!error) error = CheckMountedWorkspace();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = CheckMountedWorkspace();
  if (!error) error = operations.verify(operations.context);
  if (!error) error = VolumeControl(deadline, cancellation);
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::ProvisionMountedWorkspace(const CellProvisioningAnchor& anchor,
  const CellMountedWorkspaceProvisioningCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!creating_ || !healthy_ || anchor != anchor_ || phase_ != CellProvisioningPhase::disk_recorded ||
      volume_phase_ != CellVolumeProvisioningPhase::partitioned || format_phase_ != CellFormatProvisioningPhase::formatted ||
      protection_phase_ != CellProtectionProvisioningPhase::protected_root || mount_phase_ != CellMountProvisioningPhase::mounted ||
      mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::none || !mount_ || !protection_) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.authorize || !committer.commit) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = VolumeControl(deadline, cancellation);
  if (!error) error = Verify();
  if (error) return Refuse(error);
  try { mounted_workspace_ = std::make_unique<CellMountedWorkspace>(); } catch (...) { return Refuse(ERROR_NOT_ENOUGH_MEMORY); }
  const MountedWorkspaceOperations operations{
    [](void* context) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.mounted_workspace_deadline_);
      if (!remaining) return ERROR_TIMEOUT;
      if (journal.mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::recorded)
        return journal.mounted_workspace_->Verify(*journal.mount_, *journal.protection_, journal.workspace_, remaining, journal.mounted_workspace_cancellation_);
      return journal.mount_->Verify(*journal.protection_, journal.workspace_, remaining, journal.mounted_workspace_cancellation_);
    },
    [](void* context, const CellMountedWorkspaceCommitter& bridge) noexcept -> DWORD {
      auto& journal = *static_cast<CellProvisioningJournal*>(context);
      const DWORD remaining = Remaining(journal.mounted_workspace_deadline_);
      return remaining ? journal.mounted_workspace_->Create(*journal.mount_, *journal.protection_, journal.workspace_,
        journal.owner_, journal.controller_, bridge, remaining, journal.mounted_workspace_cancellation_) : ERROR_TIMEOUT;
    }, this,
  };
  error = RunMountedWorkspace(operations, committer, deadline, cancellation);
  if (!error) error = CheckMountedWorkspace();
  if (!error) error = Verify();
  if (!error) error = VolumeControl(deadline, cancellation);
  return error ? Refuse(error) : ERROR_SUCCESS;
}
DWORD CellProvisioningJournal::RecoverMountedWorkspace() noexcept {
  if (mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded || mounted_workspace_records_.size() != 2 || !mount_ || !protection_)
    return ERROR_IO_INCOMPLETE;
  try { mounted_workspace_ = std::make_unique<CellMountedWorkspace>(); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  return mounted_workspace_->OpenRecorded(*mount_, *protection_, workspace_, owner_, controller_, mounted_workspace_records_, 10000);
}
DWORD CellProvisioningJournal::RecordMountedWorkspace(CellWorkspaceIdentities* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  DWORD error = Verify();
  if (!error && (mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded || !mounted_workspace_ || !mount_ || !protection_))
    error = ERROR_INVALID_STATE;
  if (error) return error;
  error = mounted_workspace_->RecordIdentities(*mount_, *protection_, workspace_, output, 10000);
  return error ? Refuse(error) : ERROR_SUCCESS;
}
RuntimeBundleInstallResult CellProvisioningJournal::InstallRuntime(const CellProvisioningAnchor& supplied_anchor,
    const CellFileSha256& supplied_head, PinnedCellRuntimeBundle& source, PinnedCellRuntimeBundle& output,
    DWORD wall_limit_ms, const CellFootprintScanGuard& supplied_guard) noexcept {
  RuntimeBundleInstallResult result;
  const auto anchor = supplied_anchor; const auto head = supplied_head; const auto guard = supplied_guard;
  if (output.Ready()) { result.error = ERROR_ALREADY_INITIALIZED; return result; }
  if (!source.Ready() || runtime_install_active_ || !healthy_ || lifetime_revision_ == std::numeric_limits<std::uint64_t>::max()) {
    result.error = ERROR_INVALID_STATE; return result;
  }
  if (!guard.authorize || !wall_limit_ms || wall_limit_ms > 60000 || !Nonzero(head)) {
    result.error = ERROR_INVALID_PARAMETER; return result;
  }
  CapacityReadScope borrowed(*this);
  if (!borrowed.entered) { result.error = ERROR_INVALID_STATE; return result; }
  struct Active final { bool& value; explicit Active(bool& flag) : value(flag) { value = true; } ~Active() { value = false; } } active(runtime_install_active_);
  try {
    const auto deadline = GetTickCount64() + wall_limit_ms;
    result.error = VolumeControl(deadline, guard.cancellation);
    if (!result.error && anchor_ != anchor) result.error = ERROR_FILE_INVALID;
    if (!result.error) { result.error = ReadJournal(); if (result.error) Refuse(result.error); }
    if (!result.error && (records_.size() != maximum_bytes || mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded ||
        !mounted_workspace_ || !mount_ || !protection_)) result.error = ERROR_IO_INCOMPLETE;
    if (!result.error && !std::equal(head.begin(), head.end(), records_.end() - 32)) result.error = ERROR_CRC;
    if (result.error) return result;
    struct Context final {
      CellProvisioningJournal& journal;
      CellProvisioningAnchor anchor;
      CellProvisioningPlan plan;
      std::vector<std::uint8_t> records, descriptor;
      std::vector<CellMountedWorkspaceCheckpoint> checkpoints;
      std::wstring name, owner, controller;
      HANDLE file;
      std::uint64_t lifetime;
      bool creating;
      CellMountedWorkspace* mounted;
      CellVolumeMount* mount;
      CellVolumeProtection* protection;
      CellFootprintScanGuard guard;
      ULONGLONG deadline;
      bool Matches() const noexcept {
        return journal.healthy_ && journal.runtime_install_active_ && journal.lifetime_revision_ == lifetime && journal.creating_ == creating &&
          journal.anchor_ == anchor && journal.file_ == file && journal.records_ == records && journal.descriptor_ == descriptor &&
          journal.mounted_workspace_records_ == checkpoints && journal.name_ == name && journal.owner_ == owner && journal.controller_ == controller &&
          journal.plan_.assignment_binding == plan.assignment_binding && journal.plan_.profile_sha256 == plan.profile_sha256 &&
          IsEqualGUID(journal.plan_.disk.identifier, plan.disk.identifier) && journal.plan_.disk.virtual_bytes == plan.disk.virtual_bytes &&
          journal.plan_.disk.reserved_file_bytes == plan.disk.reserved_file_bytes &&
          journal.phase_ == CellProvisioningPhase::disk_recorded && journal.volume_phase_ == CellVolumeProvisioningPhase::partitioned &&
          journal.format_phase_ == CellFormatProvisioningPhase::formatted && journal.protection_phase_ == CellProtectionProvisioningPhase::protected_root &&
          journal.mount_phase_ == CellMountProvisioningPhase::mounted &&
          journal.mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::recorded &&
          journal.mounted_workspace_.get() == mounted && journal.mount_.get() == mount && journal.protection_.get() == protection;
      }
      DWORD Verify() const noexcept {
        auto error = VolumeControl(deadline, guard.cancellation);
        if (!error && !Matches()) error = ERROR_FILE_INVALID;
        if (!error) { error = journal.ReadJournal(); if (error) journal.Refuse(error); }
        if (!error && !Matches()) error = ERROR_FILE_INVALID;
        std::vector<CellMountedWorkspaceCheckpoint> actual;
        if (!error) error = mounted->RecordCheckpoints(&actual);
        if (!error && actual != checkpoints) error = ERROR_CRC;
        return error ? error : VolumeControl(deadline, guard.cancellation);
      }
      static DWORD Authorize(void* raw) noexcept {
        const auto& self = *static_cast<Context*>(raw);
        auto error = self.Verify();
        if (!error) error = self.guard.authorize(self.guard.context);
        return error ? error : self.Verify();
      }
    } context{*this, anchor, plan_, records_, descriptor_, mounted_workspace_records_, name_, owner_, controller_, file_,
      lifetime_revision_, creating_, mounted_workspace_.get(), mount_.get(), protection_.get(), guard, deadline};
    result.error = Context::Authorize(&context);
    if (result.error) return result;
    const auto remaining = Remaining(deadline);
    if (!remaining) { result.error = ERROR_TIMEOUT; return result; }
    result = context.mounted->InstallRuntime(*context.mount, *context.protection, workspace_, source, output, remaining,
      {Context::Authorize, &context, guard.cancellation});
    if (!result.error) result.error = Context::Authorize(&context);
    if (result.error) { result.verified = false; output.Reset(); }
    return result;
  } catch (...) { result.error = ERROR_NOT_ENOUGH_MEMORY; result.verified = false; output.Reset(); return result; }
}
DWORD CellProvisioningJournal::RecordMountedWorkspaceCheckpoints(std::vector<CellMountedWorkspaceProvisioningRecord>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  const DWORD error = Verify();
  if (error) return error;
  try {
    if (records_.size() <= mount_end) return ERROR_SUCCESS;
    std::vector<CellMountedWorkspaceProvisioningRecord> captured((records_.size() - mount_end) / record_bytes);
    for (std::size_t index = 0; index < captured.size(); ++index)
      std::copy_n(records_.begin() + mount_end + index * record_bytes, record_bytes, captured[index].begin());
    *output = std::move(captured);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::ObserveMountedInventory(const CellProvisioningAnchor& expected_anchor,
  const CellFileSha256& expected_head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellProvisioningInventory* output, const CellFootprintCellBinding* binding) noexcept {
  return ReadMountedInventory([](void* raw, const CellFootprintScanLimits& frozen_limits,
    const CellFootprintScanGuard& frozen_guard, CellDirectoryInventory* inventory) noexcept -> DWORD {
    auto& journal = *static_cast<CellProvisioningJournal*>(raw);
    if (!journal.mounted_workspace_ || !journal.mount_ || !journal.protection_) return ERROR_INVALID_STATE;
    std::vector<CellMountedWorkspaceCheckpoint> records;
    auto error = journal.mounted_workspace_->RecordCheckpoints(&records);
    if (!error && records != journal.mounted_workspace_records_) error = ERROR_CRC;
    return error ? error : journal.mounted_workspace_->ObserveInventory(*journal.mount_, *journal.protection_,
      journal.workspace_, frozen_limits, frozen_guard, inventory);
  }, this, expected_anchor, expected_head, limits, guard, output, binding);
}
DWORD CellProvisioningJournal::CaptureMountedInventory(const CellProvisioningAnchor& expected_anchor,
  const CellFileSha256& expected_head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  const CellFootprintCellBinding& binding, CellDirectoryInventoryPins& pins, CellProvisioningInventory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto anchor = expected_anchor; const auto head = expected_head;
  const auto captured_limits = limits; const auto captured_guard = guard; const auto captured_binding = binding;
  *output = {};
  if (pins.Ready()) return ERROR_ALREADY_INITIALIZED;
  if (!captured_binding.authorize) return ERROR_INVALID_PARAMETER;
  struct Context final { CellProvisioningJournal& journal; CellDirectoryInventoryPins& pins; } context{*this, pins};
  auto error = ReadMountedInventory([](void* raw, const CellFootprintScanLimits& frozen_limits,
    const CellFootprintScanGuard& frozen_guard, CellDirectoryInventory* inventory) noexcept -> DWORD {
    auto& value = *static_cast<Context*>(raw); auto& journal = value.journal;
    if (!journal.mounted_workspace_ || !journal.mount_ || !journal.protection_) return ERROR_INVALID_STATE;
    std::vector<CellMountedWorkspaceCheckpoint> records;
    auto checked = journal.mounted_workspace_->RecordCheckpoints(&records);
    if (!checked && records != journal.mounted_workspace_records_) checked = ERROR_CRC;
    return checked ? checked : journal.mounted_workspace_->CaptureInventory(*journal.mount_, *journal.protection_,
      journal.workspace_, frozen_limits, frozen_guard, value.pins, inventory);
  }, &context, anchor, head, captured_limits, captured_guard, output, &captured_binding);
  if (!error) error = pins.Check();
  if (error) { *output = {}; pins.Close(); }
  return error;
}
DWORD CellProvisioningJournal::ObserveMountedFootprint(const CellProvisioningAnchor& expected_anchor,
  const CellFileSha256& expected_head, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellProvisioningFootprint* output) noexcept {
  return ReadMountedFootprint([](void* raw, const CellFootprintScanLimits& frozen_limits,
    const CellFootprintScanGuard& frozen_guard, CellDirectoryFootprint* footprint) noexcept -> DWORD {
    auto& journal = *static_cast<CellProvisioningJournal*>(raw);
    if (!journal.mounted_workspace_ || !journal.mount_ || !journal.protection_) return ERROR_INVALID_STATE;
    std::vector<CellMountedWorkspaceCheckpoint> records;
    auto error = journal.mounted_workspace_->RecordCheckpoints(&records);
    if (!error && records != journal.mounted_workspace_records_) error = ERROR_CRC;
    return error ? error : journal.mounted_workspace_->ObserveFootprint(*journal.mount_, *journal.protection_,
      journal.workspace_, frozen_limits, frozen_guard, footprint);
  }, this, expected_anchor, expected_head, limits, guard, output);
}
DWORD CellProvisioningJournal::ObserveBackingFootprint(const CellProvisioningAnchor& supplied_anchor,
  const CellFileSha256& supplied_head, DWORD wall_limit_ms, const CellFootprintScanGuard& supplied_guard,
  CellProvisioningBackingFootprint* output) noexcept {
  return ReadBackingFootprint(supplied_anchor, supplied_head, wall_limit_ms, supplied_guard, output, nullptr);
}
detail::CellProvisioningBackingObservation::CellProvisioningBackingObservation(
  const CellProvisioningBackingObserver& observer) noexcept : observer_(observer), bridge_{this,
    [](void* raw, const CellCapacityBorrowedFiles& files, const CellProvisioningBackingFootprint& footprint) noexcept -> DWORD {
      auto& self = *static_cast<CellProvisioningBackingObservation*>(raw);
      if (!self.Valid() || self.attempted_ || self.failed_) { self.failed_ = true; return ERROR_INVALID_STATE; }
      self.attempted_ = true;
      const auto guard = files.guard;
      auto error = guard.authorize ? guard.authorize(guard.context) : ERROR_INVALID_PARAMETER;
      if (!error) error = self.observer_.capture(self.observer_.context, files, footprint);
      if (!error) error = guard.authorize(guard.context);
      if (error) self.failed_ = true;
      return error ? error : self.failed_ ? ERROR_INVALID_STATE : ERROR_SUCCESS;
    }, [](void* raw) noexcept { static_cast<CellProvisioningBackingObservation*>(raw)->failed_ = true; }} {}
detail::CellProvisioningBackingObservation::~CellProvisioningBackingObservation() {
  if (attempted_ && (!complete_ || failed_) && observer_.discard) observer_.discard(observer_.context);
}
bool detail::CellProvisioningBackingObservation::Valid() const noexcept {
  return observer_.capture && observer_.discard;
}
DWORD CellProvisioningJournal::WithBackingCapacity(const CellProvisioningAnchor& anchor, const CellFileSha256& head,
  DWORD wall_ms, const CellFootprintScanGuard& guard, const CellProvisioningBackingObserver& observer,
  CellProvisioningBackingFootprint* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto retained_anchor = anchor; const auto retained_head = head;
  detail::CellProvisioningBackingObservation observation(observer);
  *output = {};
  if (!observation.Valid()) return ERROR_INVALID_PARAMETER;
  const auto error = ReadBackingFootprint(retained_anchor, retained_head, wall_ms, guard, output, nullptr, &observation.Bridge());
  if (!error) observation.Complete();
  return error;
}
DWORD CellProvisioningJournal::ObserveHostCapacity(const CellProvisioningAnchor& anchor, const CellFileSha256& head,
  CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
  const CellFootprintScanGuard& guard, CellProvisioningHostCapacity* output,
  const CellCapacityCaptureObserver* observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto expected_anchor = anchor; const auto expected_head = head;
  *output = {};
  detail::CellCapacityObservation observation(observer);
  if (!observation.Valid()) return ERROR_INVALID_PARAMETER;
  CellProvisioningHostCapacity result;
  const HostCapacityInput input{&layout, record, limits, &result.areas, observation.Bridge()};
  if (input.limits.max_entries < kCellCapacityAreaCount || input.limits.max_entries > 20000 || input.limits.max_depth > 64)
    return ERROR_INVALID_PARAMETER;
  const auto error = ReadBackingFootprint(expected_anchor, expected_head, input.limits.wall_limit_ms, guard, &result.backing, &input);
  if (!error) { *output = std::move(result); observation.Complete(); }
  return error;
}
DWORD CellProvisioningJournal::ObserveJoinedCapacity(const CellProvisioningAnchor& supplied_anchor, const CellFileSha256& supplied_head,
  CellCapacityLayout& layout, const CellCapacityLayoutRecord& supplied_record, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, const CellFootprintCellBinding& supplied_binding,
  CellProvisioningJoinedCapacity* output) noexcept {
  const JoinedCapacityReaders readers{this,
    [](void* raw, const CellProvisioningAnchor& anchor, const CellFileSha256& head, CellCapacityLayout& layout,
      const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
      CellProvisioningHostCapacity* output, const CellCapacityCaptureObserver* observer) noexcept -> DWORD {
      return static_cast<CellProvisioningJournal*>(raw)->ObserveHostCapacity(anchor, head, layout, record, limits, guard, output, observer);
    },
    [](void* raw, const CellProvisioningAnchor& anchor, const CellFileSha256& head, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& guard, const CellFootprintCellBinding& binding, CellDirectoryInventoryPins& pins,
      CellProvisioningInventory* output) noexcept -> DWORD {
      return static_cast<CellProvisioningJournal*>(raw)->CaptureMountedInventory(anchor, head, limits, guard, binding, pins, output);
    },
  };
  return ReadJoinedCapacity(supplied_anchor, supplied_head, layout, supplied_record, supplied_limits,
    supplied_guard, supplied_binding, readers, output);
}
DWORD CellProvisioningJournal::ReadJoinedCapacity(const CellProvisioningAnchor& supplied_anchor, const CellFileSha256& supplied_head,
  CellCapacityLayout& layout, const CellCapacityLayoutRecord& supplied_record, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, const CellFootprintCellBinding& supplied_binding,
  const JoinedCapacityReaders& supplied_readers, CellProvisioningJoinedCapacity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto anchor = supplied_anchor; const auto head = supplied_head; const auto record = supplied_record;
  const auto limits = supplied_limits; const auto guard = supplied_guard; const auto binding = supplied_binding;
  const auto readers = supplied_readers;
  *output = {};
  CapacityReadScope read_scope(*this);
  if (!read_scope.entered) return ERROR_INVALID_STATE;
  if (!readers.host || !readers.guest || !guard.authorize || !binding.authorize || !limits.wall_limit_ms || limits.wall_limit_ms > 60000 ||
      limits.max_entries < kCellCapacityAreaCount || limits.max_entries > 20000 || limits.max_depth > 64)
    return ERROR_INVALID_PARAMETER;
  try {
    struct Context final {
      CellProvisioningJournal& journal; CellProvisioningAnchor anchor; CellFileSha256 head;
      CellFootprintScanLimits limits; CellFootprintScanGuard guard; CellFootprintCellBinding binding;
      std::wstring name; JoinedCapacityReaders readers;
      ULONGLONG deadline; CellDirectoryInventoryPins pins; CellProvisioningInventory guest;
      bool captured = false;
      static DWORD Authorize(void* raw) noexcept {
        auto& self = *static_cast<Context*>(raw);
        auto error = VolumeControl(self.deadline, self.guard.cancellation);
        if (!error) error = self.guard.authorize(self.guard.context);
        if (!error && self.captured) {
          error = self.binding.authorize(self.binding.context, self.name,
            self.guest.workspace.directories[static_cast<std::size_t>(CellDirectory::work)]);
          if (!error) error = self.pins.Check();
        }
        return error ? error : VolumeControl(self.deadline, self.guard.cancellation);
      }
      static DWORD Capture(void* raw, const CellCapacityPinnedView& host) noexcept {
        auto& self = *static_cast<Context*>(raw);
        if (self.captured || self.pins.Ready()) return ERROR_ALREADY_INITIALIZED;
        auto error = host.Check(); if (error) return error;
        struct Guard final {
          Context& context; const CellCapacityPinnedView& host;
          static DWORD Check(void* raw) noexcept {
            auto& self = *static_cast<Guard*>(raw);
            auto error = self.host.Check();
            if (!error) error = Context::Authorize(&self.context);
            return error ? error : self.host.Check();
          }
        } guarded{self, host};
        auto remaining = self.limits; remaining.wall_limit_ms = Remaining(self.deadline);
        if (!remaining.wall_limit_ms) return ERROR_TIMEOUT;
        error = self.readers.guest(self.readers.context, self.anchor, self.head, remaining,
          {Guard::Check, &guarded, self.guard.cancellation}, self.binding, self.pins, &self.guest);
        if (!error) { self.captured = true; error = host.Check(); }
        return error;
      }
      static void Discard(void* raw) noexcept {
        auto& self = *static_cast<Context*>(raw); self.pins.Close(); self.guest = {}; self.captured = false;
      }
    } context{*this, anchor, head, limits, guard, binding, name_, readers, GetTickCount64() + limits.wall_limit_ms};
    CellProvisioningJoinedCapacity result;
    const CellCapacityCaptureObserver observer{&context, Context::Capture, Context::Discard};
    auto error = readers.host(readers.context, anchor, head, layout, record, limits,
      {Context::Authorize, &context, guard.cancellation}, &result.host, &observer);
    if (!error && !context.captured) error = ERROR_INVALID_STATE;
    if (!error) error = context.pins.Check();
    if (!error && (context.guest.anchor != anchor || context.guest.checkpoint_sha256 != head ||
        context.guest.assignment_binding != record.assignment_binding || context.guest.profile_sha256 != record.profile_sha256 ||
        result.host.backing.anchor != anchor || result.host.backing.checkpoint_sha256 != head ||
        result.host.backing.assignment_binding != record.assignment_binding || result.host.backing.profile_sha256 != record.profile_sha256))
      error = ERROR_FILE_INVALID;
    std::size_t entries = context.guest.inventory.entries.size();
    for (const auto& area : result.host.areas) entries += area.entries.size();
    if (!error && entries > limits.max_entries) error = ERROR_BUFFER_OVERFLOW;
    if (!error) error = VolumeControl(context.deadline, guard.cancellation);
    if (!error) { result.guest = std::move(context.guest); *output = std::move(result); }
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::ReadBackingFootprint(const CellProvisioningAnchor& supplied_anchor,
  const CellFileSha256& supplied_head, DWORD wall_limit_ms, const CellFootprintScanGuard& supplied_guard,
  CellProvisioningBackingFootprint* output, const HostCapacityInput* host, const CellProvisioningBackingObserver* observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto expected_anchor = supplied_anchor;
  const auto expected_head = supplied_head;
  const auto guard = supplied_guard;
  *output = {};
  CapacityReadScope read_scope(*this);
  if (!read_scope.entered) return ERROR_INVALID_STATE;
  if (!guard.authorize || !wall_limit_ms || wall_limit_ms > 60000 || !Nonzero(expected_head)) return ERROR_INVALID_PARAMETER;
  const auto deadline = GetTickCount64() + wall_limit_ms;
  auto error = VolumeControl(deadline, guard.cancellation);
  if (error) return error;
  if (!healthy_ || lifetime_revision_ == std::numeric_limits<std::uint64_t>::max()) return ERROR_INVALID_STATE;
  if (anchor_ != expected_anchor) return ERROR_FILE_INVALID;
  error = Verify();
  if (error) return error;
  if (phase_ != CellProvisioningPhase::disk_recorded ||
      !((records_.size() == core_bytes && volume_phase_ == CellVolumeProvisioningPhase::none) ||
        (records_.size() == maximum_bytes && mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::recorded)))
    return ERROR_IO_INCOMPLETE;
  if (!std::equal(expected_head.begin(), expected_head.end(), records_.end() - 32)) return ERROR_CRC;
  try {
    struct Context final {
      CellProvisioningJournal* owner;
      CellProvisioningPlan plan;
      CellProvisioningAnchor anchor;
      CellWorkspaceIdentities workspace;
      CellVirtualDiskRecord disk;
      std::vector<std::uint8_t> records, descriptor;
      std::wstring name, user, controller;
      HANDLE file;
      std::uint64_t lifetime;
      CellFootprintScanGuard guard;
      ULONGLONG deadline;
      bool Matches() const noexcept {
        const auto& value = *owner;
        return value.healthy_ && value.lifetime_revision_ == lifetime && value.file_ == file && value.anchor_ == anchor &&
          value.plan_.assignment_binding == plan.assignment_binding && value.plan_.profile_sha256 == plan.profile_sha256 &&
          IsEqualGUID(value.plan_.disk.identifier, plan.disk.identifier) && value.plan_.disk.virtual_bytes == plan.disk.virtual_bytes &&
          value.plan_.disk.reserved_file_bytes == plan.disk.reserved_file_bytes && value.workspace_record_ == workspace &&
          IsEqualGUID(value.disk_record_.spec.identifier, disk.spec.identifier) && value.disk_record_.spec.virtual_bytes == disk.spec.virtual_bytes &&
          value.disk_record_.spec.reserved_file_bytes == disk.spec.reserved_file_bytes && value.disk_record_.control == disk.control &&
          value.disk_record_.backing == disk.backing && value.records_ == records && value.descriptor_ == descriptor &&
          value.name_ == name && value.owner_ == user && value.controller_ == controller;
      }
      DWORD Verify() const noexcept {
        auto error = VolumeControl(deadline, guard.cancellation);
        if (error) return error;
        if (!Matches()) return ERROR_FILE_INVALID;
        error = owner->Verify();
        if (!error && !Matches()) error = ERROR_FILE_INVALID;
        return error ? error : VolumeControl(deadline, guard.cancellation);
      }
      static DWORD Authorize(void* raw) noexcept {
        const auto& value = *static_cast<Context*>(raw);
        auto error = value.Verify();
        if (!error) error = value.guard.authorize(value.guard.context);
        return error ? error : value.Verify();
      }
    } context{this, plan_, anchor_, workspace_record_, disk_record_, records_, descriptor_, name_, owner_, controller_,
      file_, lifetime_revision_, guard, deadline};
    if (host && (host->record.assignment_binding != context.plan.assignment_binding || host->record.profile_sha256 != context.plan.profile_sha256))
      return ERROR_FILE_INVALID;
    if (context.disk.backing == context.anchor.file || context.disk.backing.volume_serial != context.anchor.file.volume_serial ||
        context.workspace.parent.volume_serial != context.anchor.file.volume_serial) return ERROR_FILE_INVALID;
    error = Context::Authorize(&context);
    if (error) return error;
    FILE_STANDARD_INFO before{}, after{};
    FILE_BASIC_INFO stamp{}, final_stamp{};
    if (!GetFileInformationByHandleEx(file_, FileStandardInfo, &before, sizeof(before)) ||
        !GetFileInformationByHandleEx(file_, FileBasicInfo, &stamp, sizeof(stamp))) return Error();
    const auto remaining = Remaining(deadline);
    if (!remaining) return ERROR_TIMEOUT;
    const CellFootprintScanGuard guarded{Context::Authorize, &context, guard.cancellation};
    CellVirtualDiskCapacity backing;
    error = volume_phase_ == CellVolumeProvisioningPhase::none
      ? disk_.ObserveCapacity(workspace_, context.disk, remaining, guarded, &backing)
      : attachment_.ObserveCapacity(workspace_, context.disk, remaining, guarded, &backing);
    // Backing-only reads preserve the reader's final readback. A joined host
    // scan remeasures the exact borrowed files and withholds both on drift.
    if (!error) error = context.Verify();
    if (error) return error;
    CellCapacityAreaInventories host_areas;
    if (host || observer) {
      if (before.EndOfFile.QuadPart != static_cast<LONGLONG>(context.records.size()) || before.AllocationSize.QuadPart < before.EndOfFile.QuadPart ||
          before.AllocationSize.QuadPart > static_cast<LONGLONG>(kCellProvisioningJournalMaximumAllocatedBytes)) return ERROR_FILE_INVALID;
      const auto backing_file = volume_phase_ == CellVolumeProvisioningPhase::none ? disk_.file_ : attachment_.retained_.file_;
      const std::array<CellCapacityBorrowedFile, 2> files{{
        {file_, context.workspace.parent, context.anchor.file, static_cast<std::uint64_t>(before.EndOfFile.QuadPart), static_cast<std::uint64_t>(before.AllocationSize.QuadPart)},
        {backing_file, context.disk.control, context.disk.backing, backing.file_bytes, backing.allocated_bytes},
      }};
      const CellCapacityBorrowedFiles borrowed{files, guarded};
      const CellProvisioningBackingFootprint provisional{expected_anchor, context.plan.assignment_binding,
        context.plan.profile_sha256, expected_head, context.workspace, backing,
        static_cast<std::uint64_t>(before.EndOfFile.QuadPart), static_cast<std::uint64_t>(before.AllocationSize.QuadPart),
        backing.allocated_bytes + static_cast<std::uint64_t>(before.AllocationSize.QuadPart)};
      auto remaining_limits = host ? host->limits : CellFootprintScanLimits{}; remaining_limits.wall_limit_ms = Remaining(deadline);
      if (!remaining_limits.wall_limit_ms) return ERROR_TIMEOUT;
      if (mount_phase_ == CellMountProvisioningPhase::none) {
        error = observer ? observer->capture(observer->context, borrowed, provisional)
          : host->layout->Scan(host->record, remaining_limits, guarded, &host_areas, &borrowed, host->observer);
      } else {
        if (mount_phase_ != CellMountProvisioningPhase::mounted || !mount_ || !protection_) return ERROR_INVALID_STATE;
        std::vector<CellVolumeMountCheckpoint> mounted_records;
        error = mount_->RecordCheckpoints(&mounted_records);
        if (!error && mounted_records != mount_records_) error = ERROR_CRC;
        if (error) return error;
        struct MountCapture final {
          const HostCapacityInput* host; CellFootprintScanLimits limits; CellCapacityBorrowedFiles borrowed;
          CellFootprintScanGuard guard; CellFileIdentity parent; ULONGLONG deadline;
          CellCapacityAreaInventories& output;
          const CellProvisioningBackingObserver* observer;
          const CellProvisioningBackingFootprint& provisional;
          static DWORD Capture(void* raw, const CellCapacityMountLeaf& leaf) noexcept {
            auto& self = *static_cast<MountCapture*>(raw);
            if (leaf.Target().parent != self.parent) return ERROR_FILE_INVALID;
            const std::array<const CellCapacityMountLeaf*, 1> mounts{&leaf};
            auto borrowed = self.borrowed; borrowed.mounts = mounts;
            auto limits = self.limits; limits.wall_limit_ms = Remaining(self.deadline);
            if (!limits.wall_limit_ms) return ERROR_TIMEOUT;
            return self.observer ? self.observer->capture(self.observer->context, borrowed, self.provisional)
              : self.host->layout->Scan(self.host->record, limits, self.guard, &self.output, &borrowed, self.host->observer);
          }
          static void Discard(void* raw) noexcept {
            auto& self = *static_cast<MountCapture*>(raw); self.output = {};
            if (self.observer) self.observer->discard(self.observer->context);
          }
        } capture{host, remaining_limits, borrowed, guarded,
          context.workspace.directories[static_cast<std::size_t>(CellDirectory::root)], deadline, host_areas, observer, provisional};
        error = mount_->WithCapacityLeaf(*protection_, workspace_, remaining_limits.wall_limit_ms, guarded,
          {&capture, MountCapture::Capture, MountCapture::Discard});
      }
      if (!error) error = context.Verify();
      if (error) return error;
    }
    if (!GetFileInformationByHandleEx(file_, FileStandardInfo, &after, sizeof(after)) ||
        !GetFileInformationByHandleEx(file_, FileBasicInfo, &final_stamp, sizeof(final_stamp))) return Error();
    if (before.EndOfFile.QuadPart != after.EndOfFile.QuadPart || before.AllocationSize.QuadPart != after.AllocationSize.QuadPart ||
        after.EndOfFile.QuadPart != static_cast<LONGLONG>(context.records.size()) || after.AllocationSize.QuadPart < after.EndOfFile.QuadPart ||
        after.AllocationSize.QuadPart > static_cast<LONGLONG>(kCellProvisioningJournalMaximumAllocatedBytes) ||
        stamp.ChangeTime.QuadPart != final_stamp.ChangeTime.QuadPart || stamp.LastWriteTime.QuadPart != final_stamp.LastWriteTime.QuadPart ||
        stamp.FileAttributes != final_stamp.FileAttributes) return ERROR_FILE_INVALID;
    error = VolumeControl(deadline, guard.cancellation);
    if (!error) *output = {expected_anchor, context.plan.assignment_binding, context.plan.profile_sha256, expected_head,
      context.workspace, backing, static_cast<std::uint64_t>(after.EndOfFile.QuadPart), static_cast<std::uint64_t>(after.AllocationSize.QuadPart),
      backing.allocated_bytes + static_cast<std::uint64_t>(after.AllocationSize.QuadPart)};
    if (!error && host) *host->output = std::move(host_areas);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellProvisioningJournal::ReadMountedFootprint(DWORD (*read)(void*, const CellFootprintScanLimits&,
  const CellFootprintScanGuard&, CellDirectoryFootprint*) noexcept, void* read_context,
  const CellProvisioningAnchor& supplied_anchor, const CellFileSha256& supplied_head,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard,
  CellProvisioningFootprint* output) noexcept {
  return ReadMountedCapacity(read, read_context, supplied_anchor, supplied_head, supplied_limits, supplied_guard, output, 65536, nullptr);
}
DWORD CellProvisioningJournal::ReadMountedInventory(DWORD (*read)(void*, const CellFootprintScanLimits&,
  const CellFootprintScanGuard&, CellDirectoryInventory*) noexcept, void* read_context,
  const CellProvisioningAnchor& supplied_anchor, const CellFileSha256& supplied_head,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard,
  CellProvisioningInventory* output, const CellFootprintCellBinding* binding) noexcept {
  return ReadMountedCapacity(read, read_context, supplied_anchor, supplied_head, supplied_limits, supplied_guard, output, 20000, binding);
}
template <typename Observation, typename Output>
DWORD CellProvisioningJournal::ReadMountedCapacity(DWORD (*read)(void*, const CellFootprintScanLimits&,
  const CellFootprintScanGuard&, Observation*) noexcept, void* read_context,
  const CellProvisioningAnchor& supplied_anchor, const CellFileSha256& supplied_head,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard,
  Output* output, std::uint32_t maximum_entries, const CellFootprintCellBinding* supplied_binding) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto expected_anchor = supplied_anchor;
  const auto expected_head = supplied_head;
  const auto limits = supplied_limits;
  const auto guard = supplied_guard;
  const auto binding = supplied_binding ? *supplied_binding : CellFootprintCellBinding{};
  const auto deadline = GetTickCount64() + limits.wall_limit_ms;
  *output = {};
  CapacityReadScope read_scope(*this);
  if (!read_scope.entered) return ERROR_INVALID_STATE;
  if (supplied_binding && !binding.authorize) return ERROR_INVALID_PARAMETER;
  if (!read || !guard.authorize || !limits.max_entries || limits.max_entries > maximum_entries || limits.max_depth > 64 ||
      !limits.wall_limit_ms || limits.wall_limit_ms > 60000 || !Nonzero(expected_head)) return ERROR_INVALID_PARAMETER;
  auto error = VolumeControl(deadline, guard.cancellation);
  if (error) return error;
  if (!healthy_ || lifetime_revision_ == std::numeric_limits<std::uint64_t>::max()) return ERROR_INVALID_STATE;
  if (anchor_ != expected_anchor) return ERROR_FILE_INVALID;
  error = ReadJournal();
  if (error) return Refuse(error);
  if (records_.size() != maximum_bytes || mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded)
    return ERROR_IO_INCOMPLETE;
  if (!std::equal(expected_head.begin(), expected_head.end(), records_.end() - 32)) return ERROR_CRC;
  try {
    CellFileSha256 mount_base{};
    std::copy_n(records_.begin() + mount_end - 32, 32, mount_base.begin());
    std::vector<CellMountedWorkspaceCheckpoint> checkpoints;
    CellWorkspaceIdentities workspace;
    error = DecodeMountedWorkspace(std::span(records_).subspan(mount_end), plan_, anchor_.file, disk_record_, mount_base,
      name_, owner_, controller_, mount_records_, &checkpoints, &workspace);
    if (error) return Refuse(error);
    struct Context final {
      CellProvisioningJournal* journal;
      CellProvisioningPlan plan;
      CellProvisioningAnchor anchor;
      std::vector<std::uint8_t> records, descriptor;
      std::vector<CellMountedWorkspaceCheckpoint> checkpoints;
      std::wstring name, owner, controller;
      CellFileIdentity work;
      CellFootprintCellBinding binding;
      HANDLE file;
      CellMountedWorkspace* mounted;
      CellVolumeMount* mount;
      CellVolumeProtection* protection;
      bool creating;
      std::uint64_t lifetime_revision;
      CellFootprintScanGuard guard;
      ULONGLONG deadline;
      bool Matches() const noexcept {
        const auto& value = *journal;
        return value.healthy_ && value.lifetime_revision_ == lifetime_revision && value.creating_ == creating &&
          value.file_ == file && value.anchor_ == anchor &&
          value.phase_ == CellProvisioningPhase::disk_recorded && value.volume_phase_ == CellVolumeProvisioningPhase::partitioned &&
          value.format_phase_ == CellFormatProvisioningPhase::formatted && value.protection_phase_ == CellProtectionProvisioningPhase::protected_root &&
          value.mount_phase_ == CellMountProvisioningPhase::mounted && value.mounted_workspace_phase_ == CellMountedWorkspaceProvisioningPhase::recorded &&
          value.plan_.assignment_binding == plan.assignment_binding && value.plan_.profile_sha256 == plan.profile_sha256 &&
          IsEqualGUID(value.plan_.disk.identifier, plan.disk.identifier) && value.plan_.disk.virtual_bytes == plan.disk.virtual_bytes &&
          value.plan_.disk.reserved_file_bytes == plan.disk.reserved_file_bytes && value.name_ == name && value.owner_ == owner &&
          value.controller_ == controller && value.records_ == records && value.descriptor_ == descriptor &&
          value.mounted_workspace_records_ == checkpoints && value.mounted_workspace_.get() == mounted &&
          value.mount_.get() == mount && value.protection_.get() == protection;
      }
      DWORD Verify() const noexcept {
        auto error = VolumeControl(deadline, guard.cancellation);
        if (error) return error;
        if (!Matches()) return ERROR_FILE_INVALID;
        error = journal->ReadJournal();
        if (error) return journal->Refuse(error);
        if (!Matches()) return ERROR_FILE_INVALID;
        return VolumeControl(deadline, guard.cancellation);
      }
      static DWORD Authorize(void* raw) noexcept {
        const auto& value = *static_cast<Context*>(raw);
        auto error = value.Verify();
        if (!error) error = value.guard.authorize(value.guard.context);
        if (!error && value.binding.authorize) {
          error = value.Verify();
          if (!error) error = value.binding.authorize(value.binding.context, value.name, value.work);
        }
        return error ? error : value.Verify();
      }
    } context{this, plan_, expected_anchor, records_, descriptor_, checkpoints, name_, owner_, controller_,
      workspace.directories[static_cast<std::size_t>(CellDirectory::work)], binding, file_,
      mounted_workspace_.get(), mount_.get(), protection_.get(), creating_, lifetime_revision_, guard, deadline};
    error = Context::Authorize(&context);
    if (error) return error;
    auto remaining_limits = limits;
    remaining_limits.wall_limit_ms = Remaining(deadline);
    if (!remaining_limits.wall_limit_ms) return ERROR_TIMEOUT;
    Observation observation;
    error = read(read_context, remaining_limits, {Context::Authorize, &context, guard.cancellation}, &observation);
    // No caller code runs after the mounted reader's final tree readback. The
    // canonical owner must still recheck current authority when using this input.
    if (!error) error = context.Verify();
    if (error) return error;
    const CellDirectoryFootprint& footprint = [&]() -> const CellDirectoryFootprint& {
      if constexpr (std::is_same_v<Observation, CellDirectoryFootprint>) return observation;
      else return observation.footprint;
    }();
    if (footprint.root != workspace.directories[0] || footprint.directory_count < workspace.directories.size() ||
        static_cast<std::uint64_t>(footprint.file_count) + footprint.directory_count > limits.max_entries ||
        footprint.logical_file_bytes > 9007199254740991ULL || footprint.allocated_bytes > 9007199254740991ULL)
      return ERROR_INVALID_DATA;
    if constexpr (std::is_same_v<Observation, CellDirectoryInventory>) {
      if (observation.entries.size() != static_cast<std::uint64_t>(footprint.file_count) + footprint.directory_count)
        return ERROR_INVALID_DATA;
      std::uint64_t logical = 0, allocated = 0;
      std::uint32_t files = 0, directories = 0;
      std::array<bool, 4> roots{};
      const CellDirectoryInventoryEntry* previous = nullptr;
      for (const auto& entry : observation.entries) {
        if (!IdentityValid(entry.identity) || entry.identity.volume_serial != footprint.root.volume_serial ||
            (previous && !(previous->identity.file_id < entry.identity.file_id)) ||
            (entry.directory && entry.logical_file_bytes != 0) ||
            entry.logical_file_bytes > 9007199254740991ULL - logical || entry.allocated_bytes > 9007199254740991ULL - allocated)
          return ERROR_INVALID_DATA;
        logical += entry.logical_file_bytes; allocated += entry.allocated_bytes;
        if (entry.directory) {
          ++directories;
          for (std::size_t index = 0; index < workspace.directories.size(); ++index)
            if (entry.identity == workspace.directories[index]) roots[index] = true;
        } else ++files;
        previous = &entry;
      }
      if (files != footprint.file_count || directories != footprint.directory_count ||
          logical != footprint.logical_file_bytes || allocated != footprint.allocated_bytes ||
          !std::all_of(roots.begin(), roots.end(), [](bool present) { return present; })) return ERROR_INVALID_DATA;
    }
    error = VolumeControl(deadline, guard.cancellation);
    if (error) return error;
    *output = {expected_anchor, context.plan.assignment_binding, context.plan.profile_sha256, expected_head, workspace, std::move(observation)};
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
