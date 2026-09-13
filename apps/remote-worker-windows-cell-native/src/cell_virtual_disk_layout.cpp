#include "cell_virtual_disk_layout.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::uint64_t mib = 1024 * 1024;
constexpr std::size_t header_bytes = offsetof(DRIVE_LAYOUT_INFORMATION_EX, PartitionEntry);
constexpr std::size_t digest_offset = 480, maximum_layout_bytes = 65536;
// Documented in ntdddisk.h; including that driver header alongside winioctl.h
// redeclares disk types. The public control code has no input/output buffer.
constexpr DWORD volumes_ready = CTL_CODE(IOCTL_DISK_BASE, 0x0087, METHOD_BUFFERED, FILE_READ_ACCESS);
constexpr GUID reserved_type{0xe3c9e316, 0x0b5c, 0x4db8, {0x81, 0x7d, 0xf9, 0x2d, 0xf0, 0x02, 0x15, 0xae}};
constexpr GUID data_type{0xebd0a0a2, 0xb9e5, 0x4433, {0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7}};
constexpr wchar_t data_name[] = L"GoatCitadel cell";
DWORD Error() noexcept { const DWORD value = GetLastError(); return value ? value : ERROR_GEN_FAILURE; }
DWORD Control(ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return state == WAIT_FAILED ? Error() : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
DWORD Remaining(ULONGLONG deadline) noexcept {
  const auto now = GetTickCount64();
  return now >= deadline ? 0 : static_cast<DWORD>(std::min<ULONGLONG>(600000, deadline - now));
}
bool Nonzero(const GUID& id) noexcept { return !IsEqualGUID(id, GUID{}); }
bool IdentityValid(const CellFileIdentity& id) noexcept {
  return id.volume_serial && std::any_of(id.file_id.begin(), id.file_id.end(), [](auto value) { return value != 0; });
}
bool SameDisk(const CellVirtualDiskRecord& a, const CellVirtualDiskRecord& b) noexcept {
  return a.control == b.control && a.backing == b.backing && IsEqualGUID(a.spec.identifier, b.spec.identifier) &&
    a.spec.virtual_bytes == b.spec.virtual_bytes && a.spec.reserved_file_bytes == b.spec.reserved_file_bytes;
}
bool SameSnapshot(const CellDiskLayoutSnapshot& a, const CellDiskLayoutSnapshot& b) noexcept {
  return a.usable_start == b.usable_start && a.usable_length == b.usable_length && IsEqualGUID(a.reserved_id, b.reserved_id) &&
    a.reserved_start == b.reserved_start && a.reserved_length == b.reserved_length &&
    a.reserved_attributes == b.reserved_attributes && a.reserved_name == b.reserved_name &&
    a.data_start == b.data_start && a.data_length == b.data_length;
}
bool ValidSnapshot(const CellDiskLayoutPlan& plan, const CellDiskLayoutSnapshot& value) noexcept {
  // VHDX creation fixes 512-byte logical sectors. Exactly 128 GPT entries occupy
  // 32 sectors, with primary/backup headers plus the protective MBR.
  if (value.usable_start != 34 * 512 || value.usable_length != plan.disk.spec.virtual_bytes - 67 * 512 ||
      !Nonzero(value.reserved_id) || IsEqualGUID(value.reserved_id, plan.gpt_disk_id) ||
      IsEqualGUID(value.reserved_id, plan.data_partition_id) || value.reserved_start < value.usable_start ||
      value.reserved_start > mib || value.reserved_start % 512 ||
      (value.reserved_length != 16 * mib && value.reserved_length != 32 * mib && value.reserved_length != 128 * mib) ||
      (value.reserved_attributes & ~GPT_ATTRIBUTE_PLATFORM_REQUIRED) != 0) return false;
  bool terminated = false;
  for (const auto letter : value.reserved_name) {
    if (!letter) terminated = true;
    else if (terminated || letter < L' ' || letter == 0x7f) return false;
  }
  if (!terminated) return false;
  const auto end = value.usable_start + value.usable_length;
  const auto data_start = (value.reserved_start + value.reserved_length + mib - 1) / mib * mib;
  if (data_start >= end || end - data_start < 16 * mib) return false;
  return value.data_start == data_start && value.data_length == (end - data_start) / mib * mib;
}
template<typename T> void Put(CellDiskLayoutCheckpoint& bytes, std::size_t offset, const T& value) noexcept {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}
template<typename T> void Get(const CellDiskLayoutCheckpoint& bytes, std::size_t offset, T* value) noexcept {
  std::memcpy(value, bytes.data() + offset, sizeof(*value));
}
DWORD Encode(CellDiskLayoutPhase phase, const CellDiskLayoutPlan& plan, const CellDiskLayoutSnapshot& value,
             const CellFileSha256& previous, CellDiskLayoutCheckpoint* output) noexcept {
  output->fill(0);
  auto& bytes = *output;
  std::memcpy(bytes.data(), "GCCGPT01", 8);
  Put(bytes, 8, static_cast<std::uint32_t>(phase)); Put(bytes, 16, previous);
  Put(bytes, 48, plan.disk.spec.identifier); Put(bytes, 64, plan.disk.spec.virtual_bytes);
  Put(bytes, 72, plan.disk.spec.reserved_file_bytes); Put(bytes, 80, plan.disk.control.volume_serial);
  Put(bytes, 88, plan.disk.control.file_id); Put(bytes, 104, plan.disk.backing.volume_serial);
  Put(bytes, 112, plan.disk.backing.file_id); Put(bytes, 128, plan.gpt_disk_id); Put(bytes, 144, plan.data_partition_id);
  if (phase != CellDiskLayoutPhase::initialize_intent) {
    if (!ValidSnapshot(plan, value)) return ERROR_INVALID_DATA;
    Put(bytes, 160, value.usable_start); Put(bytes, 168, value.usable_length); Put(bytes, 176, std::uint32_t{128});
    Put(bytes, 180, value.reserved_id); Put(bytes, 196, value.reserved_start); Put(bytes, 204, value.reserved_length);
    Put(bytes, 212, value.reserved_attributes); Put(bytes, 220, value.reserved_name);
    Put(bytes, 292, value.data_start); Put(bytes, 300, value.data_length);
    Put(bytes, 308, std::uint64_t{GPT_BASIC_DATA_ATTRIBUTE_NO_DRIVE_LETTER});
    std::memcpy(bytes.data() + 316, data_name, sizeof(data_name));
  }
  Put(bytes, 388, std::uint32_t{512});
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(digest_offset),
    bytes.data() + digest_offset, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status < 0 ? ERROR_GEN_FAILURE : ERROR_SUCCESS;
}
bool RawLayout(std::span<const std::uint8_t> bytes) noexcept {
  if (bytes.size() < header_bytes || bytes.size() > sizeof(DRIVE_LAYOUT_INFORMATION_EX)) return false;
  PARTITION_STYLE style{}; DWORD count = 0;
  std::memcpy(&style, bytes.data(), sizeof(style)); std::memcpy(&count, bytes.data() + 4, sizeof(count));
  // MBR/GPT union fields and the unused array slot have no defined RAW meaning.
  // Disk authority comes from the bound device and canonical fresh-create grant.
  return style == PARTITION_STYLE_RAW && count == 0;
}
std::vector<std::uint8_t> PartitionRequest(const CellDiskLayoutPlan& plan, const CellDiskLayoutSnapshot& value) {
  DRIVE_LAYOUT_INFORMATION_EX header{};
  header.PartitionStyle = PARTITION_STYLE_GPT; header.PartitionCount = 2;
  header.Gpt.DiskId = plan.gpt_disk_id; header.Gpt.MaxPartitionCount = 128;
  header.Gpt.StartingUsableOffset.QuadPart = static_cast<LONGLONG>(value.usable_start);
  header.Gpt.UsableLength.QuadPart = static_cast<LONGLONG>(value.usable_length);
  std::array<PARTITION_INFORMATION_EX, 2> parts{};
  auto& reserved = parts[0]; auto& data = parts[1];
  reserved.PartitionStyle = data.PartitionStyle = PARTITION_STYLE_GPT;
  reserved.PartitionNumber = 1; data.PartitionNumber = 2;
  // The SDK requires RewritePartition for layout updates. Preserve every
  // observed on-disk MSR field while writing the new data entry beside it.
  reserved.RewritePartition = data.RewritePartition = TRUE;
  reserved.StartingOffset.QuadPart = static_cast<LONGLONG>(value.reserved_start);
  reserved.PartitionLength.QuadPart = static_cast<LONGLONG>(value.reserved_length);
  reserved.Gpt.PartitionType = reserved_type; reserved.Gpt.PartitionId = value.reserved_id;
  reserved.Gpt.Attributes = value.reserved_attributes;
  std::copy(value.reserved_name.begin(), value.reserved_name.end(), reserved.Gpt.Name);
  data.StartingOffset.QuadPart = static_cast<LONGLONG>(value.data_start);
  data.PartitionLength.QuadPart = static_cast<LONGLONG>(value.data_length);
  data.Gpt.PartitionType = data_type; data.Gpt.PartitionId = plan.data_partition_id;
  data.Gpt.Attributes = GPT_BASIC_DATA_ATTRIBUTE_NO_DRIVE_LETTER;
  std::copy(std::begin(data_name), std::end(data_name), data.Gpt.Name);
  std::vector<std::uint8_t> bytes(header_bytes + sizeof(parts));
  std::memcpy(bytes.data(), &header, header_bytes); std::memcpy(bytes.data() + header_bytes, parts.data(), sizeof(parts));
  return bytes;
}
}

bool IsValidCellDiskLayoutPlan(const CellDiskLayoutPlan& plan) noexcept {
  return IsValidCellVirtualDiskSpec(plan.disk.spec) && plan.disk.spec.virtual_bytes >= 64 * mib &&
    IdentityValid(plan.disk.control) && IdentityValid(plan.disk.backing) && plan.disk.control != plan.disk.backing &&
    plan.disk.control.volume_serial == plan.disk.backing.volume_serial &&
    Nonzero(plan.gpt_disk_id) && Nonzero(plan.data_partition_id) && !IsEqualGUID(plan.gpt_disk_id, plan.data_partition_id) &&
    !IsEqualGUID(plan.gpt_disk_id, plan.disk.spec.identifier) && !IsEqualGUID(plan.data_partition_id, plan.disk.spec.identifier);
}
DWORD DeriveCellDiskLayoutPlan(const CellVirtualDiskRecord& disk, const CellFileSha256& assignment_binding,
                              const CellFileSha256& profile, CellDiskLayoutPlan* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!std::any_of(assignment_binding.begin(), assignment_binding.end(), [](auto byte) { return byte != 0; }) ||
      !std::any_of(profile.begin(), profile.end(), [](auto byte) { return byte != 0; })) return ERROR_INVALID_PARAMETER;
  constexpr char prefix[] = "goatcitadel.native-cell-gpt.v1";
  std::array<std::uint8_t, sizeof(prefix) + 81> bytes{};
  std::memcpy(bytes.data(), prefix, sizeof(prefix));
  std::copy(assignment_binding.begin(), assignment_binding.end(), bytes.begin() + sizeof(prefix));
  std::copy(profile.begin(), profile.end(), bytes.begin() + sizeof(prefix) + 32);
  std::memcpy(bytes.data() + sizeof(prefix) + 64, &disk.spec.identifier, sizeof(GUID));
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  CellDiskLayoutPlan value; value.disk = disk;
  DWORD error = ERROR_SUCCESS;
  for (std::uint8_t role = 1; role <= 2; ++role) {
    bytes.back() = role;
    CellFileSha256 digest{};
    if (BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest.data(), 32) < 0) {
      error = ERROR_GEN_FAILURE; break;
    }
    digest[7] = static_cast<std::uint8_t>((digest[7] & 0x0f) | 0x80);
    digest[8] = static_cast<std::uint8_t>((digest[8] & 0x3f) | 0x80);
    std::memcpy(role == 1 ? &value.gpt_disk_id : &value.data_partition_id, digest.data(), sizeof(GUID));
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!error && !IsValidCellDiskLayoutPlan(value)) error = ERROR_INVALID_PARAMETER;
  if (!error) *output = value;
  return error;
}
DWORD InspectCellDiskLayout(std::span<const std::uint8_t> bytes, const CellDiskLayoutPlan& plan,
                           bool partitioned, CellDiskLayoutSnapshot* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!IsValidCellDiskLayoutPlan(plan)) return ERROR_INVALID_PARAMETER;
  const DWORD count = partitioned ? 2 : 1;
  if (bytes.size() != header_bytes + count * sizeof(PARTITION_INFORMATION_EX)) return ERROR_INVALID_DATA;
  DRIVE_LAYOUT_INFORMATION_EX header{}; std::memcpy(&header, bytes.data(), header_bytes);
  if (header.PartitionStyle != PARTITION_STYLE_GPT || header.PartitionCount != count ||
      !IsEqualGUID(header.Gpt.DiskId, plan.gpt_disk_id) || header.Gpt.MaxPartitionCount != 128 ||
      header.Gpt.StartingUsableOffset.QuadPart < 0 || header.Gpt.UsableLength.QuadPart < 0) return ERROR_FILE_INVALID;
  PARTITION_INFORMATION_EX reserved{};
  std::memcpy(&reserved, bytes.data() + header_bytes, sizeof(reserved));
  if (reserved.PartitionStyle != PARTITION_STYLE_GPT || reserved.PartitionNumber != 1 ||
      !IsEqualGUID(reserved.Gpt.PartitionType, reserved_type) || reserved.StartingOffset.QuadPart < 0 ||
      reserved.PartitionLength.QuadPart < 0) return ERROR_FILE_INVALID;
  CellDiskLayoutSnapshot value;
  value.usable_start = static_cast<std::uint64_t>(header.Gpt.StartingUsableOffset.QuadPart);
  value.usable_length = static_cast<std::uint64_t>(header.Gpt.UsableLength.QuadPart);
  value.reserved_id = reserved.Gpt.PartitionId;
  value.reserved_start = static_cast<std::uint64_t>(reserved.StartingOffset.QuadPart);
  value.reserved_length = static_cast<std::uint64_t>(reserved.PartitionLength.QuadPart);
  value.reserved_attributes = reserved.Gpt.Attributes;
  std::copy(std::begin(reserved.Gpt.Name), std::end(reserved.Gpt.Name), value.reserved_name.begin());
  // Validate all OS-controlled arithmetic before computing the planned extent.
  if (value.reserved_start > mib || value.reserved_length > 128 * mib ||
      value.usable_start != 34 * 512 || value.usable_length != plan.disk.spec.virtual_bytes - 67 * 512)
    return ERROR_FILE_INVALID;
  value.data_start = (value.reserved_start + value.reserved_length + mib - 1) / mib * mib;
  const auto end = value.usable_start + value.usable_length;
  if (value.data_start >= end) return ERROR_DISK_FULL;
  value.data_length = (end - value.data_start) / mib * mib;
  if (!ValidSnapshot(plan, value)) return ERROR_FILE_INVALID;
  if (partitioned) {
    PARTITION_INFORMATION_EX data{}; std::memcpy(&data, bytes.data() + header_bytes + sizeof(reserved), sizeof(data));
    std::array<wchar_t, 36> expected_name{}; std::copy(std::begin(data_name), std::end(data_name), expected_name.begin());
    if (data.PartitionStyle != PARTITION_STYLE_GPT || data.PartitionNumber != 2 ||
        data.StartingOffset.QuadPart != static_cast<LONGLONG>(value.data_start) ||
        data.PartitionLength.QuadPart != static_cast<LONGLONG>(value.data_length) ||
        !IsEqualGUID(data.Gpt.PartitionType, data_type) || !IsEqualGUID(data.Gpt.PartitionId, plan.data_partition_id) ||
        data.Gpt.Attributes != GPT_BASIC_DATA_ATTRIBUTE_NO_DRIVE_LETTER ||
        !std::equal(expected_name.begin(), expected_name.end(), data.Gpt.Name)) return ERROR_FILE_INVALID;
  }
  *output = value;
  return ERROR_SUCCESS;
}
DWORD DecodeCellDiskLayoutCheckpoints(const CellDiskLayoutPlan& plan,
  std::span<const CellDiskLayoutCheckpoint> records, CellDiskLayoutSnapshot* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!IsValidCellDiskLayoutPlan(plan)) return ERROR_INVALID_PARAMETER;
  if (records.size() < 4) return ERROR_IO_INCOMPLETE;
  return ValidateCellDiskLayoutCheckpointPrefix(plan, records, output);
}
DWORD ValidateCellDiskLayoutCheckpointPrefix(const CellDiskLayoutPlan& plan,
  std::span<const CellDiskLayoutCheckpoint> records, CellDiskLayoutSnapshot* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!IsValidCellDiskLayoutPlan(plan)) return ERROR_INVALID_PARAMETER;
  if (records.empty() || records.size() > 4) return ERROR_INVALID_DATA;
  CellDiskLayoutSnapshot value;
  if (records.size() >= 2) {
    const auto& initialized = records[1];
    Get(initialized, 160, &value.usable_start); Get(initialized, 168, &value.usable_length);
    Get(initialized, 180, &value.reserved_id); Get(initialized, 196, &value.reserved_start);
    Get(initialized, 204, &value.reserved_length); Get(initialized, 212, &value.reserved_attributes);
    Get(initialized, 220, &value.reserved_name); Get(initialized, 292, &value.data_start); Get(initialized, 300, &value.data_length);
  }
  CellFileSha256 previous{};
  for (std::size_t index = 0; index < records.size(); ++index) {
    CellDiskLayoutCheckpoint expected{};
    const DWORD error = Encode(static_cast<CellDiskLayoutPhase>(index + 1), plan, value, previous, &expected);
    if (error) return error;
    if (expected != records[index]) return ERROR_INVALID_DATA;
    Get(expected, digest_offset, &previous);
  }
  *output = value;
  return ERROR_SUCCESS;
}

struct CellVirtualDiskLayout::NativeContext final {
  CellVirtualDiskLayout* owner;
  CellWorkspaceDirectories* workspace;
  ULONGLONG deadline;
  HANDLE cancellation;
};
CellVirtualDiskLayout::Operations CellVirtualDiskLayout::NativeOperations(NativeContext& context) noexcept {
  return {
    [](void* pointer) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(pointer);
      const DWORD error = Control(value.deadline, value.cancellation);
      if (error) return error;
      const DWORD remaining = Remaining(value.deadline);
      return remaining ? value.owner->device_.Verify(*value.workspace, remaining, value.cancellation) : ERROR_TIMEOUT;
    },
    [](void* pointer, DWORD code, std::span<const std::uint8_t> input, std::span<std::uint8_t> output, DWORD* used) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(pointer);
      return value.owner->device_.Io(code, input, output, used, value.deadline, value.cancellation);
    }, &context,
  };
}
DWORD CellVirtualDiskLayout::Bind(CellVirtualDiskDevice& source, CellWorkspaceDirectories& workspace,
  const CellDiskLayoutPlan& plan, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error && !SameDisk(source.record_, plan.disk)) error = ERROR_FILE_INVALID;
  const DWORD first_budget = Remaining(deadline);
  if (!error) error = first_budget ? source.Verify(workspace, first_budget, cancellation) : ERROR_TIMEOUT;
  if (!error) error = Control(deadline, cancellation);
  const DWORD second_budget = Remaining(deadline);
  if (!error) error = second_budget ? device_.Open(source.attachment_, workspace, second_budget, cancellation) : ERROR_TIMEOUT;
  return error;
}
DWORD CellVirtualDiskLayout::Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error) error = operations.verify(operations.context);
  if (!error) error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  return error;
}
DWORD CellVirtualDiskLayout::Commit(CellDiskLayoutPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error) error = committer_.authorize(committer_.context);
  if (error) return error;
  CellFileSha256 previous{}, acknowledged{}, expected{};
  if (!records_.empty()) Get(records_.back(), digest_offset, &previous);
  CellDiskLayoutCheckpoint record{};
  error = Encode(phase, plan_, snapshot_, previous, &record);
  if (!error) error = Control(deadline, cancellation);
  if (error) return error;
  // Reserve all four entries before any side effect. Retain submitted bytes even
  // if their independent durable acknowledgement is lost or mismatched.
  records_.push_back(record);
  Get(record, digest_offset, &expected);
  error = committer_.commit(committer_.context, record, &acknowledged);
  if (!error && acknowledged != expected) error = ERROR_INVALID_DATA;
  if (!error) error = Control(deadline, cancellation);
  return error;
}
DWORD CellVirtualDiskLayout::Inspect(const Operations& operations, bool partitioned, CellDiskLayoutSnapshot* output) noexcept {
  std::array<std::uint8_t, maximum_layout_bytes> bytes{}; DWORD used = 0;
  const DWORD error = operations.io(operations.context, IOCTL_DISK_GET_DRIVE_LAYOUT_EX, {}, bytes, &used);
  if (error) return error;
  if (used > bytes.size()) return ERROR_INVALID_DATA;
  return InspectCellDiskLayout(std::span(bytes).first(used), plan_, partitioned, output);
}
DWORD CellVirtualDiskLayout::Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  try {
    DWORD error = Check(operations, deadline, cancellation), used = 0;
    std::array<std::uint8_t, maximum_layout_bytes> raw{};
    if (!error) error = operations.io(operations.context, IOCTL_DISK_GET_DRIVE_LAYOUT_EX, {}, raw, &used);
    if (!error && (used > raw.size() || !RawLayout(std::span(raw).first(used)))) error = ERROR_ALREADY_EXISTS;
    if (!error) error = Commit(CellDiskLayoutPhase::initialize_intent, deadline, cancellation);
    if (!error) error = Check(operations, deadline, cancellation);
    // Durable acknowledgement may take time: RAW is rechecked immediately before
    // initialization. A foreign or changed layout is never overwritten.
    raw.fill(0); used = 0;
    if (!error) error = operations.io(operations.context, IOCTL_DISK_GET_DRIVE_LAYOUT_EX, {}, raw, &used);
    if (!error && (used > raw.size() || !RawLayout(std::span(raw).first(used)))) error = ERROR_ALREADY_EXISTS;
    CREATE_DISK create{}; create.PartitionStyle = PARTITION_STYLE_GPT;
    create.Gpt.DiskId = plan_.gpt_disk_id; create.Gpt.MaxPartitionCount = 128;
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) error = operations.io(operations.context, IOCTL_DISK_CREATE_DISK,
      {reinterpret_cast<const std::uint8_t*>(&create), sizeof(create)}, {}, &used);
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) error = operations.io(operations.context, IOCTL_DISK_UPDATE_PROPERTIES, {}, {}, &used);
    if (!error) error = operations.io(operations.context, volumes_ready, {}, {}, &used);
    if (!error) error = Inspect(operations, false, &snapshot_);
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) error = Commit(CellDiskLayoutPhase::initialized, deadline, cancellation);
    if (!error) error = Commit(CellDiskLayoutPhase::partition_intent, deadline, cancellation);
    if (!error) error = Check(operations, deadline, cancellation);
    CellDiskLayoutSnapshot before{};
    if (!error) error = Inspect(operations, false, &before);
    if (!error && !SameSnapshot(before, snapshot_)) error = ERROR_FILE_INVALID;
    if (error) return error;
    const auto request = PartitionRequest(plan_, snapshot_);
    // The driver contract can return updated partition numbers. Accept its
    // bounded response buffer, but authority comes from a separate exact GET.
    std::vector<std::uint8_t> driver_response(request.size());
    error = Check(operations, deadline, cancellation);
    if (!error) error = operations.io(operations.context, IOCTL_DISK_SET_DRIVE_LAYOUT_EX, request, driver_response, &used);
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) error = operations.io(operations.context, IOCTL_DISK_UPDATE_PROPERTIES, {}, {}, &used);
    if (!error) error = operations.io(operations.context, volumes_ready, {}, {}, &used);
    CellDiskLayoutSnapshot after{};
    if (!error) error = Inspect(operations, true, &after);
    if (!error && !SameSnapshot(after, snapshot_)) error = ERROR_FILE_INVALID;
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) error = Commit(CellDiskLayoutPhase::partitioned, deadline, cancellation);
    // Do not expose readiness if current authority or disk identity changed while
    // the final checkpoint was being retained.
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) error = Inspect(operations, true, &after);
    if (!error && !SameSnapshot(after, snapshot_)) error = ERROR_FILE_INVALID;
    if (!error) error = Check(operations, deadline, cancellation);
    if (!error) state_ = CellDiskLayoutState::partitioned;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVirtualDiskLayout::Create(CellVirtualDiskDevice& source, CellWorkspaceDirectories& workspace,
  const CellDiskLayoutPlan& plan, const CellDiskLayoutCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!IsValidCellDiskLayoutPlan(plan) || !committer.commit || !committer.authorize || !wall_limit_ms || wall_limit_ms > 600000)
    return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  attempted_ = true; state_ = CellDiskLayoutState::unknown; plan_ = plan; committer_ = committer;
  try { records_.reserve(4); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  error = committer_.authorize(committer_.context);
  if (!error) error = Bind(source, workspace, plan_, deadline, cancellation);
  NativeContext context{this, &workspace, deadline, cancellation};
  if (!error) error = Run(NativeOperations(context), deadline, cancellation);
  return error;
}
DWORD CellVirtualDiskLayout::OpenRecorded(CellVirtualDiskDevice& source, CellWorkspaceDirectories& workspace,
  const CellDiskLayoutPlan& plan, std::span<const CellDiskLayoutCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  attempted_ = true; state_ = CellDiskLayoutState::unknown; plan_ = plan;
  DWORD error = Control(deadline, cancellation);
  if (!error) error = DecodeCellDiskLayoutCheckpoints(plan_, records, &snapshot_);
  if (error) return error;
  try { records_.assign(records.begin(), records.end()); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  error = Bind(source, workspace, plan_, deadline, cancellation);
  NativeContext context{this, &workspace, deadline, cancellation};
  const auto operations = NativeOperations(context);
  CellDiskLayoutSnapshot observed{};
  if (!error) error = Inspect(operations, true, &observed);
  if (!error && !SameSnapshot(observed, snapshot_)) error = ERROR_FILE_INVALID;
  if (!error) error = operations.verify(operations.context);
  if (!error) error = Control(deadline, cancellation);
  if (!error) state_ = CellDiskLayoutState::partitioned;
  return error;
}
DWORD CellVirtualDiskLayout::Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellDiskLayoutState::partitioned) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  NativeContext context{this, &workspace, deadline, cancellation};
  const auto operations = NativeOperations(context);
  DWORD error = operations.verify(operations.context);
  CellDiskLayoutSnapshot observed{};
  if (!error) error = Inspect(operations, true, &observed);
  if (!error && !SameSnapshot(observed, snapshot_)) error = ERROR_FILE_INVALID;
  if (!error) error = operations.verify(operations.context);
  if (!error) error = Control(deadline, cancellation);
  if (error) state_ = CellDiskLayoutState::unknown;
  return error;
}
DWORD CellVirtualDiskLayout::RecordCheckpoints(std::vector<CellDiskLayoutCheckpoint>* output) const noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  try { *output = records_; return ERROR_SUCCESS; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
void CellVirtualDiskLayout::Close() noexcept {
  device_.Close(); plan_ = {}; snapshot_ = {}; committer_ = {}; records_.clear();
  attempted_ = false; state_ = CellDiskLayoutState::not_started;
}
}
