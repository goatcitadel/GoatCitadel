#include "cell_virtual_disk_device.hpp"
#include <virtdisk.h>
#include <winioctl.h>
#include <algorithm>
#include <cstring>
#include <limits>
#include <string_view>
#pragma comment(lib, "virtdisk.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::size_t maximum_dependency_bytes = 65536;
constexpr auto entries_offset = offsetof(STORAGE_DEPENDENCY_INFO, Version2Entries);
constexpr auto strings_offset = entries_offset + sizeof(STORAGE_DEPENDENCY_INFO_TYPE_2);
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
struct Event final { HANDLE value = nullptr; ~Event() { if (value) CloseHandle(value); } };
DWORD Control(HANDLE cancellation, ULONGLONG deadline) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return state == WAIT_FAILED ? Error() : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
bool Same(const std::wstring& left, const std::wstring& right) noexcept {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}
bool DeviceNumber(const std::wstring& path, DWORD* output) noexcept {
  constexpr std::wstring_view prefix = L"\\\\.\\PhysicalDrive";
  if (path.size() <= prefix.size() || path.compare(0, prefix.size(), prefix) != 0 ||
      (path.size() > prefix.size() + 1 && path[prefix.size()] == L'0')) return false;
  DWORD number = 0;
  for (std::size_t index = prefix.size(); index < path.size(); ++index) {
    const auto value = path[index];
    if (value < L'0' || value > L'9') return false;
    const DWORD digit = static_cast<DWORD>(value - L'0');
    if (number > (std::numeric_limits<DWORD>::max() - 1 - digit) / 10) return false;
    number = number * 10 + digit;
  }
  *output = number;
  return true;
}
bool VolumeRoot(const std::wstring& path) noexcept {
  return path.size() == 49 && path.compare(0, 11, L"\\\\?\\Volume{") == 0 && IsLiteralCellPath(path);
}
bool ReadString(std::span<const std::uint8_t> bytes, const wchar_t* pointer,
                bool optional, std::wstring* output) {
  output->clear();
  if (!pointer) return optional;
  const auto address = reinterpret_cast<std::uintptr_t>(pointer), base = reinterpret_cast<std::uintptr_t>(bytes.data());
  if (address < base || address - base < strings_offset || address - base >= bytes.size() ||
      address % alignof(wchar_t) != 0) return false;
  const auto offset = static_cast<std::size_t>(address - base);
  for (std::size_t cursor = offset; cursor <= bytes.size() - sizeof(wchar_t); cursor += sizeof(wchar_t)) {
    wchar_t value = 0;
    std::memcpy(&value, bytes.data() + cursor, sizeof(value));
    if (!value) return optional || !output->empty();
    if (output->size() >= 2048 || value < L' ' || value == 0x7f) return false;
    output->push_back(value);
  }
  return false;
}
DWORD DiskIo(HANDLE device, DWORD code, std::span<const std::uint8_t> input, std::span<std::uint8_t> output,
             DWORD* count, ULONGLONG deadline, HANDLE cancellation) noexcept {
  *count = 0;
  if (input.size() > MAXDWORD || output.size() > MAXDWORD) return ERROR_INVALID_PARAMETER;
  DWORD error = Control(cancellation, deadline);
  if (error) return error;
  Event event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!event.value) return Error();
  OVERLAPPED operation{}; operation.hEvent = event.value;
  DWORD transferred = 0;
  if (!DeviceIoControl(device, code, const_cast<std::uint8_t*>(input.data()), static_cast<DWORD>(input.size()),
      output.data(), static_cast<DWORD>(output.size()), &transferred, &operation)) {
    error = Error();
    if (error != ERROR_IO_PENDING) return error;
    for (;;) {
      error = Control(cancellation, deadline);
      if (error) break;
      if (GetOverlappedResult(device, &operation, &transferred, FALSE)) break;
      error = Error();
      if (error != ERROR_IO_INCOMPLETE) return error;
      error = ERROR_SUCCESS;
      if (WaitForSingleObject(event.value, 10) == WAIT_FAILED) { error = Error(); break; }
    }
    if (error) {
      // Cancellation can race normal completion. Keep output/event/OVERLAPPED
      // alive and join this exact query before releasing any of them.
      CancelIoEx(device, &operation);
      DWORD ignored = 0; GetOverlappedResult(device, &operation, &ignored, TRUE);
      return error;
    }
  }
  error = Control(cancellation, deadline);
  if (!error && transferred > output.size()) error = ERROR_INVALID_DATA;
  if (!error) *count = transferred;
  return error;
}
DWORD Query(HANDLE device, DWORD code, void* output, DWORD size,
            ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD count = 0;
  const DWORD error = DiskIo(device, code, {}, {static_cast<std::uint8_t*>(output), size}, &count, deadline, cancellation);
  return error ? error : count == size ? ERROR_SUCCESS : ERROR_INVALID_DATA;
}
}

bool MatchesCellVirtualDiskDependency(std::span<const std::uint8_t> bytes,
  const std::wstring& expected_device, const std::wstring& expected_backing) noexcept {
  try {
    DWORD number = 0;
    if (!bytes.data() || bytes.size() < strings_offset || bytes.size() > maximum_dependency_bytes ||
        !DeviceNumber(expected_device, &number) || expected_backing.size() <= 49 ||
        !VolumeRoot(expected_backing.substr(0, 49)) || !IsLiteralCellPath(expected_backing)) return false;
    STORAGE_DEPENDENCY_INFO_VERSION version{}; ULONG count = 0;
    std::memcpy(&version, bytes.data(), sizeof(version));
    std::memcpy(&count, bytes.data() + offsetof(STORAGE_DEPENDENCY_INFO, NumberEntries), sizeof(count));
    if (version != STORAGE_DEPENDENCY_INFO_VERSION_2 || count != 1) return false;
    STORAGE_DEPENDENCY_INFO_TYPE_2 entry{};
    std::memcpy(&entry, bytes.data() + entries_offset, sizeof(entry));
    // One fixed, local, directly backed Microsoft VHDX. Refuse differencing,
    // nested, remote, system-target and unknown provider/dependency shapes.
    constexpr ULONG required = DEPENDENT_DISK_FLAG_FULLY_ALLOCATED |
      DEPENDENT_DISK_FLAG_NO_DRIVE_LETTER | DEPENDENT_DISK_FLAG_PERMANENT_LIFETIME;
    constexpr ULONG allowed = required | DEPENDENT_DISK_FLAG_SYSTEM_VOLUME_PARENT;
    const auto flags = static_cast<ULONG>(entry.DependencyTypeFlags);
    if ((flags & ~allowed) != 0 || (flags & required) != required ||
        entry.ProviderSpecificFlags != 0 || entry.AncestorLevel > 1 ||
        entry.VirtualStorageType.DeviceId != VIRTUAL_STORAGE_TYPE_DEVICE_VHDX ||
        !IsEqualGUID(entry.VirtualStorageType.VendorId, VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT)) return false;
    std::wstring device, host, volume, relative;
    if (!ReadString(bytes, entry.DependencyDeviceName, false, &device) ||
        !ReadString(bytes, entry.HostVolumeName, false, &host) ||
        !ReadString(bytes, entry.DependentVolumeName, true, &volume) ||
        !ReadString(bytes, entry.DependentVolumeRelativePath, false, &relative) ||
        !Same(device, expected_device) || !VolumeRoot(host) || (!volume.empty() && !VolumeRoot(volume))) return false;
    // Windows returns a volume-relative path. Normalize at most its one leading
    // separator; the existing literal-path gate rejects traversal and aliases.
    const std::wstring backing = host + (relative.front() == L'\\' ? relative.substr(1) : relative);
    return IsLiteralCellPath(backing) && Same(backing, expected_backing);
  } catch (...) { return false; }
}

CellVirtualDiskDevice::~CellVirtualDiskDevice() { Close(); }
DWORD CellVirtualDiskDevice::Open(CellVirtualDiskAttachment& source, CellWorkspaceDirectories& workspace,
                                 DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(cancellation, deadline);
  if (!error) error = source.Verify(workspace);
  if (!error) error = CheckCellVolumeManagementPrivilege();
  if (error) return error;
  attempted_ = true;
  try {
    // Own an independent attachment/backing pin. Closing the source owner must
    // not invalidate this object's file custody or silently detach its device.
    const auto& retained = source.retained_;
    const CellVirtualDiskRecord record{retained.spec_, retained.control_identity_, retained.identity_};
    record_ = record;
    error = attachment_.OpenRecorded(workspace, record, wall_limit_ms, cancellation);
    if (!error) error = Control(cancellation, deadline);
    if (!error) {
      device_ = CreateFileW(attachment_.DevicePath().c_str(), GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
      if (device_ == INVALID_HANDLE_VALUE) error = Error();
    }
    if (!error) error = Inspect(deadline, cancellation);
    if (!error) error = attachment_.Verify(workspace);
    if (!error) error = CheckCellVolumeManagementPrivilege();
    if (!error) error = Control(cancellation, deadline);
    if (!error) ready_ = true;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVirtualDiskDevice::Inspect(ULONGLONG deadline, HANDLE cancellation) noexcept {
  try {
    DWORD number = 0;
    if (device_ == INVALID_HANDLE_VALUE || !DeviceNumber(attachment_.DevicePath(), &number)) return ERROR_INVALID_STATE;
    STORAGE_DEVICE_NUMBER observed{};
    DWORD error = Query(device_, IOCTL_STORAGE_GET_DEVICE_NUMBER, &observed, sizeof(observed), deadline, cancellation);
    if (!error && (observed.DeviceType != FILE_DEVICE_DISK || observed.DeviceNumber != number ||
        (observed.PartitionNumber != 0 && observed.PartitionNumber != MAXDWORD))) error = ERROR_FILE_INVALID;
    GET_LENGTH_INFORMATION length{};
    if (!error) error = Query(device_, IOCTL_DISK_GET_LENGTH_INFO, &length, sizeof(length), deadline, cancellation);
    if (!error && (length.Length.QuadPart <= 0 ||
        static_cast<std::uint64_t>(length.Length.QuadPart) != attachment_.retained_.spec_.virtual_bytes)) error = ERROR_FILE_INVALID;
    if (error) return error;
    std::vector<std::uint8_t> bytes(maximum_dependency_bytes);
    auto* dependencies = reinterpret_cast<STORAGE_DEPENDENCY_INFO*>(bytes.data());
    dependencies->Version = STORAGE_DEPENDENCY_INFO_VERSION_2;
    ULONG used = 0;
    error = GetStorageDependencyInformation(device_, static_cast<GET_STORAGE_DEPENDENCY_FLAG>(
      GET_STORAGE_DEPENDENCY_FLAG_HOST_VOLUMES | GET_STORAGE_DEPENDENCY_FLAG_DISK_HANDLE),
      static_cast<ULONG>(bytes.size()), dependencies, &used);
    if (error) return error;  // API output is undefined on failure.
    if (used > bytes.size() || !MatchesCellVirtualDiskDependency(std::span(bytes).first(used),
        attachment_.DevicePath(), attachment_.retained_.path_)) return ERROR_FILE_INVALID;
    return Control(cancellation, deadline);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVirtualDiskDevice::Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!ready_) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(cancellation, deadline);
  if (!error) error = CheckCellVolumeManagementPrivilege();
  if (!error) error = attachment_.Verify(workspace);
  if (!error) error = Inspect(deadline, cancellation);
  if (!error) error = attachment_.Verify(workspace);
  if (!error) error = CheckCellVolumeManagementPrivilege();
  if (!error) error = Control(cancellation, deadline);
  if (error) ready_ = false;
  return error;
}
void CellVirtualDiskDevice::Close() noexcept {
  if (device_ != INVALID_HANDLE_VALUE) CloseHandle(device_);
  device_ = INVALID_HANDLE_VALUE;
  attachment_.Close(); record_ = {}; attempted_ = false; ready_ = false;
}
DWORD CellVirtualDiskDevice::Io(DWORD code, std::span<const std::uint8_t> input, std::span<std::uint8_t> output,
                               DWORD* transferred, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!transferred) return ERROR_INVALID_PARAMETER;
  *transferred = 0;
  if (!ready_ || device_ == INVALID_HANDLE_VALUE) return ERROR_INVALID_STATE;
  DWORD error = DiskIo(device_, code, input, output, transferred, deadline, cancellation);
  if (!error && (code == IOCTL_DISK_CREATE_DISK || code == IOCTL_DISK_SET_DRIVE_LAYOUT_EX)) {
    // Persist the partition-table write before any completion record. This
    // synchronous driver flush remains covered by the controller watchdog.
    if (!FlushFileBuffers(device_)) error = Error();
    if (!error) error = Control(cancellation, deadline);
  }
  return error;
}
}
