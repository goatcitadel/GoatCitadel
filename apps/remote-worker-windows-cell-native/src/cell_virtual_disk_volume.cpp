#include "cell_virtual_disk_volume.hpp"
#include <algorithm>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
constexpr GUID data_type{0xebd0a0a2, 0xb9e5, 0x4433, {0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7}};
constexpr std::size_t maximum_volumes = 4096;
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
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
struct File final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~File() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Enumeration final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Enumeration() { if (value != INVALID_HANDLE_VALUE) FindVolumeClose(value); }
};
bool ValidExtent(const CellDiskLayoutSnapshot& layout) noexcept {
  constexpr std::uint64_t mib = 1024 * 1024;
  return layout.data_start >= mib && layout.data_start % mib == 0 &&
    layout.data_length >= mib && layout.data_length % mib == 0 &&
    layout.data_length <= static_cast<std::uint64_t>(MAXLONGLONG) &&
    layout.data_start <= static_cast<std::uint64_t>(MAXLONGLONG) - layout.data_length;
}
DWORD Query(HANDLE handle, DWORD code, std::span<std::uint8_t> output, DWORD* used,
            ULONGLONG deadline, HANDLE cancellation) noexcept {
  *used = 0;
  if (handle == INVALID_HANDLE_VALUE || output.size() > MAXDWORD) return ERROR_INVALID_PARAMETER;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  File event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!event.value) return Error();
  OVERLAPPED operation{}; operation.hEvent = event.value;
  DWORD count = 0;
  if (!DeviceIoControl(handle, code, nullptr, 0, output.data(), static_cast<DWORD>(output.size()), &count, &operation)) {
    error = Error();
    if (error != ERROR_IO_PENDING) return error;
    for (;;) {
      error = Control(deadline, cancellation);
      if (error) break;
      if (GetOverlappedResult(handle, &operation, &count, FALSE)) break;
      error = Error();
      if (error != ERROR_IO_INCOMPLETE) return error;
      error = ERROR_SUCCESS;
      if (WaitForSingleObject(event.value, 10) == WAIT_FAILED) { error = Error(); break; }
    }
    if (error) {
      CancelIoEx(handle, &operation);
      DWORD ignored = 0; GetOverlappedResult(handle, &operation, &ignored, TRUE);
      return error;
    }
  }
  error = Control(deadline, cancellation);
  if (!error && count > output.size()) error = ERROR_INVALID_DATA;
  if (!error) *used = count;
  return error;
}
HANDLE OpenVolume(const std::wstring& path) noexcept {
  // Remove exactly the GUID root's trailing separator: CreateFile must address
  // the volume device, not its filesystem root. Never accept other path syntax.
  if (!IsCellVolumeGuidPath(path)) { SetLastError(ERROR_INVALID_NAME); return INVALID_HANDLE_VALUE; }
  try {
    return CreateFileW(path.substr(0, path.size() - 1).c_str(), 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
  } catch (...) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return INVALID_HANDLE_VALUE; }
}
}

bool IsCellVolumeGuidPath(std::wstring_view path) noexcept {
  if (path.size() != 49 || path.substr(0, 11) != L"\\\\?\\Volume{" || path.substr(47) != L"}\\") return false;
  bool nonzero = false;
  for (std::size_t index = 11; index < 47; ++index) {
    const auto character = path[index];
    if (index == 19 || index == 24 || index == 29 || index == 34) {
      if (character != L'-') return false;
    } else {
      if (!((character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f') ||
            (character >= L'A' && character <= L'F'))) return false;
      nonzero = nonzero || character != L'0';
    }
  }
  return nonzero;
}
DWORD InspectCellVolumeExtent(std::span<const std::uint8_t> bytes, DWORD disk_number,
                             const CellDiskLayoutSnapshot& layout) noexcept {
  if (disk_number == MAXDWORD || !ValidExtent(layout)) return ERROR_INVALID_PARAMETER;
  if (bytes.size() != sizeof(VOLUME_DISK_EXTENTS)) return ERROR_INVALID_DATA;
  VOLUME_DISK_EXTENTS value{}; std::memcpy(&value, bytes.data(), sizeof(value));
  const auto& extent = value.Extents[0];
  if (value.NumberOfDiskExtents != 1 || extent.DiskNumber != disk_number ||
      extent.StartingOffset.QuadPart != static_cast<LONGLONG>(layout.data_start) ||
      extent.ExtentLength.QuadPart != static_cast<LONGLONG>(layout.data_length)) return ERROR_FILE_INVALID;
  return ERROR_SUCCESS;
}
DWORD InspectCellVolumePartition(std::span<const std::uint8_t> bytes,
  const CellDiskLayoutPlan& plan, const CellDiskLayoutSnapshot& layout) noexcept {
  if (!IsValidCellDiskLayoutPlan(plan) || !ValidExtent(layout) ||
      layout.data_start + layout.data_length >= plan.disk.spec.virtual_bytes) return ERROR_INVALID_PARAMETER;
  if (bytes.size() != sizeof(PARTITION_INFORMATION_EX)) return ERROR_INVALID_DATA;
  PARTITION_INFORMATION_EX value{}; std::memcpy(&value, bytes.data(), sizeof(value));
  std::array<wchar_t, 36> name{};
  constexpr wchar_t expected_name[] = L"GoatCitadel cell";
  std::copy(std::begin(expected_name), std::end(expected_name), name.begin());
  if (value.PartitionStyle != PARTITION_STYLE_GPT || value.PartitionNumber != 2 ||
      value.StartingOffset.QuadPart != static_cast<LONGLONG>(layout.data_start) ||
      value.PartitionLength.QuadPart != static_cast<LONGLONG>(layout.data_length) ||
      !IsEqualGUID(value.Gpt.PartitionType, data_type) || !IsEqualGUID(value.Gpt.PartitionId, plan.data_partition_id) ||
      value.Gpt.Attributes != GPT_BASIC_DATA_ATTRIBUTE_NO_DRIVE_LETTER ||
      !std::equal(name.begin(), name.end(), value.Gpt.Name)) return ERROR_FILE_INVALID;
  return ERROR_SUCCESS;
}

struct CellVirtualDiskVolume::NativeContext final {
  CellVirtualDiskVolume* owner;
  CellWorkspaceDirectories* workspace;
  ULONGLONG deadline;
  HANDLE cancellation;
  Enumeration enumeration;
};
CellVirtualDiskVolume::Operations CellVirtualDiskVolume::NativeOperations(NativeContext& context) noexcept {
  return {
    [](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw);
      const DWORD remaining = Remaining(value.deadline);
      return remaining ? value.owner->layout_.Verify(*value.workspace, remaining, value.cancellation) : ERROR_TIMEOUT;
    },
    [](void* raw, HANDLE handle, DWORD code, std::span<std::uint8_t> output, DWORD* used) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw);
      return Query(handle, code, output, used, value.deadline, value.cancellation);
    },
    [](void* raw, bool first, std::wstring* output) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw);
      std::array<wchar_t, 50> name{};
      if (first) {
        value.enumeration.value = FindFirstVolumeW(name.data(), static_cast<DWORD>(name.size()));
        if (value.enumeration.value == INVALID_HANDLE_VALUE) return Error();
      } else if (!FindNextVolumeW(value.enumeration.value, name.data(), static_cast<DWORD>(name.size()))) return Error();
      if (name.back() != L'\0') return ERROR_BUFFER_OVERFLOW;
      try { *output = name.data(); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      return ERROR_SUCCESS;
    },
    [](void*, const std::wstring& path) noexcept -> HANDLE { return OpenVolume(path); }, &context,
  };
}
DWORD CellVirtualDiskVolume::Inspect(const Operations& operations, HANDLE handle,
                                   ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation), used = 0;
  if (!error) error = operations.verify(operations.context);
  std::array<std::uint8_t, sizeof(STORAGE_DEVICE_NUMBER)> number{};
  if (!error) error = operations.query(operations.context, handle, IOCTL_STORAGE_GET_DEVICE_NUMBER, number, &used);
  STORAGE_DEVICE_NUMBER observed{};
  if (!error && used != sizeof(observed)) error = ERROR_INVALID_DATA;
  if (!error) {
    std::memcpy(&observed, number.data(), sizeof(observed));
    if (observed.DeviceType != FILE_DEVICE_DISK || observed.DeviceNumber != disk_number_ || observed.PartitionNumber != 2)
      error = ERROR_FILE_INVALID;
  }
  std::array<std::uint8_t, sizeof(VOLUME_DISK_EXTENTS)> extents{};
  if (!error) error = operations.query(operations.context, handle, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, extents, &used);
  if (!error && used > extents.size()) error = ERROR_INVALID_DATA;
  if (!error) error = InspectCellVolumeExtent(std::span(extents).first(used), disk_number_, layout_.snapshot_);
  std::array<std::uint8_t, sizeof(PARTITION_INFORMATION_EX)> partition{};
  if (!error) error = operations.query(operations.context, handle, IOCTL_DISK_GET_PARTITION_INFO_EX, partition, &used);
  if (!error && used > partition.size()) error = ERROR_INVALID_DATA;
  if (!error) error = InspectCellVolumePartition(std::span(partition).first(used), layout_.plan_, layout_.snapshot_);
  if (!error) error = operations.verify(operations.context);
  if (!error) error = Control(deadline, cancellation);
  return error;
}
DWORD CellVirtualDiskVolume::Discover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  try {
    for (std::size_t count = 0; ; ++count) {
      DWORD error = Control(deadline, cancellation);
      if (error) return error;
      std::wstring path;
      error = operations.next(operations.context, count == 0, &path);
      if (error == ERROR_NO_MORE_FILES) return volume_ == INVALID_HANDLE_VALUE ? ERROR_NOT_FOUND : ERROR_SUCCESS;
      if (error) return error;
      if (count >= maximum_volumes) return ERROR_BUFFER_OVERFLOW;
      if (!IsCellVolumeGuidPath(path)) return ERROR_INVALID_NAME;
      File candidate{operations.open(operations.context, path)};
      if (candidate.value != INVALID_HANDLE_VALUE) {
        // Foreign, inaccessible and multi-extent volumes are never selected.
        // Once an exact extent matches, any further identity error is terminal.
        std::array<std::uint8_t, sizeof(VOLUME_DISK_EXTENTS)> extents{}; DWORD used = 0;
        error = operations.query(operations.context, candidate.value, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, extents, &used);
        if (!error && used <= extents.size() &&
            InspectCellVolumeExtent(std::span(extents).first(used), disk_number_, layout_.snapshot_) == ERROR_SUCCESS) {
          if (volume_ != INVALID_HANDLE_VALUE) return ERROR_DUP_NAME;
          error = Inspect(operations, candidate.value, deadline, cancellation);
          if (error) return error;
          path_ = path; volume_ = candidate.value; candidate.value = INVALID_HANDLE_VALUE;
        }
      }
      error = Control(deadline, cancellation);
      if (error) return error;
    }
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
CellVirtualDiskVolume::~CellVirtualDiskVolume() { Close(); }
DWORD CellVirtualDiskVolume::Open(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
                                 DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (!error) error = source.Verify(workspace, wall_limit_ms, cancellation);
  if (error) return error;
  attempted_ = true;
  const DWORD remaining = Remaining(deadline);
  error = remaining ? layout_.OpenRecorded(source.device_, workspace, source.plan_, source.records_, remaining, cancellation) : ERROR_TIMEOUT;
  STORAGE_DEVICE_NUMBER number{}; DWORD used = 0;
  if (!error) error = layout_.device_.Io(IOCTL_STORAGE_GET_DEVICE_NUMBER, {},
    {reinterpret_cast<std::uint8_t*>(&number), sizeof(number)}, &used, deadline, cancellation);
  if (!error && (used != sizeof(number) || number.DeviceType != FILE_DEVICE_DISK || number.DeviceNumber == MAXDWORD ||
      (number.PartitionNumber != 0 && number.PartitionNumber != MAXDWORD))) error = ERROR_FILE_INVALID;
  if (!error) disk_number_ = number.DeviceNumber;
  NativeContext context{this, &workspace, deadline, cancellation, {}};
  const auto operations = NativeOperations(context);
  if (!error) error = Discover(operations, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation);
  if (!error) bound_ = true;
  return error;
}
DWORD CellVirtualDiskVolume::Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Inspect(operations, volume_, deadline, cancellation);
  if (!error) {
    File named{operations.open(operations.context, path_)};
    error = named.value == INVALID_HANDLE_VALUE ? Error() : Inspect(operations, named.value, deadline, cancellation);
  }
  return error;
}
DWORD CellVirtualDiskVolume::Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!bound_) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  NativeContext context{this, &workspace, deadline, cancellation, {}};
  const DWORD error = Check(NativeOperations(context), deadline, cancellation);
  if (error) bound_ = false;
  return error;
}
DWORD CellVirtualDiskVolume::ReadNtfs(std::span<std::uint8_t> output, DWORD* used, ULONGLONG deadline, HANDLE cancellation) noexcept {
  *used = 0;
  if (!bound_) return ERROR_INVALID_STATE;
  if (!IsCellVolumeGuidPath(path_)) return ERROR_INVALID_NAME;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  // A zero-access DASD handle bypasses the filesystem and does not service NTFS
  // FSCTLs. Open the exact GUID root with attribute access, preserving the final
  // separator and refusing filesystem reparse points. This performs no data write.
  File named{CreateFileW(path_.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED, nullptr)};
  if (named.value == INVALID_HANDLE_VALUE) return Error();
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(named.value, FileAttributeTagInfo, &attributes, sizeof(attributes))) return Error();
  if (!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || attributes.ReparseTag) return ERROR_FILE_INVALID;
  return Query(named.value, FSCTL_GET_NTFS_VOLUME_DATA, output, used, deadline, cancellation);
}
void CellVirtualDiskVolume::Close() noexcept {
  bound_ = false;
  if (volume_ != INVALID_HANDLE_VALUE) CloseHandle(volume_);
  volume_ = INVALID_HANDLE_VALUE; path_.clear(); disk_number_ = MAXDWORD;
  layout_.Close();
}
}
