#include "cell_volume_mount_target.hpp"
#include <winioctl.h>
#include <objbase.h>
#include <algorithm>
#include <cstring>
#pragma comment(lib, "ole32.lib")

namespace goatcitadel::worker_cell {
namespace {
DWORD Error() noexcept { const auto error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
bool Identity(const CellFileIdentity& value) noexcept {
  return value.volume_serial && std::any_of(value.file_id.begin(), value.file_id.end(), [](auto byte) { return byte != 0; });
}
std::uint16_t U16(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint16_t>(bytes[0] | static_cast<std::uint16_t>(bytes[1]) << 8);
}
std::uint32_t U32(const std::uint8_t* bytes) noexcept {
  return U16(bytes) | static_cast<std::uint32_t>(U16(bytes + 2)) << 16;
}
bool Same(std::wstring_view left, std::wstring_view right) noexcept {
  return left.size() == right.size() && left.size() < 4096 && CompareStringOrdinal(left.data(),
    static_cast<int>(left.size()), right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}
std::wstring VolumePath(const GUID& volume, bool nt) {
  std::array<wchar_t, 39> guid{};
  if (IsEqualGUID(volume, GUID{}) || StringFromGUID2(volume, guid.data(), static_cast<int>(guid.size())) != 39) return {};
  return std::wstring(nt ? L"\\??\\Volume" : L"\\\\?\\Volume") + guid.data() + L"\\";
}
DWORD DirectoryPath(HANDLE handle, std::wstring* path) {
  std::array<wchar_t, 2048> bytes{};
  const auto used = GetFinalPathNameByHandleW(handle, bytes.data(), static_cast<DWORD>(bytes.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!used) return Error();
  if (used >= bytes.size()) return ERROR_BUFFER_OVERFLOW;
  path->assign(bytes.data(), used);
  return IsLiteralCellPath(*path) && path->starts_with(L"\\\\?\\Volume{") ? ERROR_SUCCESS : ERROR_BAD_PATHNAME;
}
DWORD Directory(HANDLE handle, const CellFileIdentity& expected, bool mounted) noexcept {
  if (!handle || handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK) return ERROR_INVALID_HANDLE;
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO file{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &file, sizeof(file))) return Error();
  constexpr DWORD unsafe = FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED |
    FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
  if ((attributes.FileAttributes & unsafe) || !(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      bool(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != mounted ||
      attributes.ReparseTag != (mounted ? IO_REPARSE_TAG_MOUNT_POINT : 0) ||
      !standard.Directory || standard.DeletePending || standard.NumberOfLinks != 1 ||
      standard.EndOfFile.QuadPart < 0 || standard.AllocationSize.QuadPart < 0 ||
      file.VolumeSerialNumber != expected.volume_serial ||
      !std::equal(expected.file_id.begin(), expected.file_id.end(), std::begin(file.FileId.Identifier))) return ERROR_FILE_INVALID;
  std::array<wchar_t, 16> filesystem{}; DWORD flags = 0;
  if (!GetVolumeInformationByHandleW(handle, nullptr, 0, nullptr, nullptr, &flags,
      filesystem.data(), static_cast<DWORD>(filesystem.size()))) return Error();
  if (wcscmp(filesystem.data(), L"NTFS") || !(flags & FILE_PERSISTENT_ACLS)) return ERROR_NOT_SUPPORTED;
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> streams{};
  if (!GetFileInformationByHandleEx(handle, FileStreamInfo, streams.data(), static_cast<DWORD>(streams.size()))) {
    const auto error = Error(); if (error != ERROR_HANDLE_EOF) return error;
  } else {
    const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(streams.data());
    if (stream->StreamNameLength || stream->NextEntryOffset) return ERROR_ACCESS_DENIED;
  }
  return ERROR_SUCCESS;
}
}
bool IsValidCellVolumeMountTarget(const CellVolumeMountTarget& target) noexcept {
  return !IsEqualGUID(target.volume_id, GUID{}) && Identity(target.parent) && Identity(target.directory) && Identity(target.volume_root) &&
    target.parent.volume_serial == target.directory.volume_serial && target.parent != target.directory &&
    target.volume_root.volume_serial != target.parent.volume_serial;
}
DWORD InspectCellMountPointReparse(std::span<const std::uint8_t> bytes, const GUID& volume_id) noexcept {
  if (IsEqualGUID(volume_id, GUID{})) return ERROR_INVALID_PARAMETER;
  if (bytes.size() < 16 || bytes.size() > 2048 || U32(bytes.data()) != IO_REPARSE_TAG_MOUNT_POINT ||
      U16(bytes.data() + 4) != bytes.size() - 8 || U16(bytes.data() + 6)) return ERROR_INVALID_DATA;
  const auto names = bytes.subspan(16);
  const std::size_t substitute = U16(bytes.data() + 8), length = U16(bytes.data() + 10);
  const std::size_t print = U16(bytes.data() + 12), print_length = U16(bytes.data() + 14);
  if ((substitute | length | print | print_length | names.size()) & 1u || length != 98 || print_length > 1024 ||
      substitute > names.size() || length > names.size() - substitute || print > names.size() || print_length > names.size() - print ||
      (print_length && substitute < print + print_length && print < substitute + length)) return ERROR_INVALID_DATA;
  try {
    std::array<wchar_t, 49> actual{};
    for (std::size_t index = 0; index < actual.size(); ++index) actual[index] = static_cast<wchar_t>(U16(names.data() + substitute + index * 2));
    if (!Same(std::wstring_view(actual.data(), actual.size()), VolumePath(volume_id, true))) return ERROR_FILE_INVALID;
    // Display text is bounded and unused as authority. Reject embedded control
    // characters and malformed UTF-16 rather than rendering or resolving it.
    for (std::size_t index = print; index < print + print_length; index += 2) {
      const auto value = U16(names.data() + index);
      if (value < 0x20 || value == 0x7f || (value >= 0xdc00 && value <= 0xdfff)) return ERROR_INVALID_DATA;
      if (value >= 0xd800 && value <= 0xdbff) {
        if (index + 2 >= print + print_length) return ERROR_INVALID_DATA;
        const auto low = U16(names.data() + index + 2);
        if (low < 0xdc00 || low > 0xdfff) return ERROR_INVALID_DATA;
        index += 2;
      }
    }
    for (std::size_t index = 0; index < names.size(); ++index)
      if (!(index >= substitute && index < substitute + length) && !(index >= print && index < print + print_length) && names[index])
        return ERROR_INVALID_DATA;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD InspectCellVolumeMountNames(std::span<const wchar_t> names, DWORD used, std::wstring_view expected) noexcept {
  if (names.size() > 4096 || used < 1 || used > names.size()) return ERROR_INVALID_DATA;
  if (expected.empty()) return used <= 2 && std::all_of(names.begin(), names.begin() + used, [](auto value) { return value == 0; })
    ? ERROR_SUCCESS : ERROR_ALREADY_EXISTS;
  try {
    if (expected.size() >= 2048 || expected.back() != L'\\' ||
        !IsLiteralCellPath(std::wstring(expected.substr(0, expected.size() - 1))) ||
        expected.size() <= (expected.starts_with(L"\\\\?\\Volume{") ? 50u : 4u)) return ERROR_INVALID_PARAMETER;
    if (used != expected.size() + 2 || names[used - 1] || names[used - 2] ||
        !Same(std::wstring_view(names.data(), used - 2), expected)) return ERROR_FILE_INVALID;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ReadCellMountHostDirectory(HANDLE parent, HANDLE directory, const CellVolumeMountTarget& expected, bool mounted) noexcept {
  if (!IsValidCellVolumeMountTarget(expected)) return ERROR_INVALID_PARAMETER;
  try {
    DWORD error = Directory(parent, expected.parent, false);
    if (!error) error = Directory(directory, expected.directory, mounted);
    std::wstring parent_path, leaf_path;
    if (!error) error = DirectoryPath(parent, &parent_path);
    if (!error) error = DirectoryPath(directory, &leaf_path);
    // A volume root parent is deliberately refused: the mount owner must use
    // its independently recorded cell root below installed custody.
    if (!error && (parent_path.size() <= 49 || !Same(leaf_path, parent_path + L"\\volume"))) error = ERROR_FILE_INVALID;
    if (!error && mounted) {
      std::array<std::uint8_t, 2048> bytes{}; DWORD used = 0;
      if (!DeviceIoControl(directory, FSCTL_GET_REPARSE_POINT, nullptr, 0, bytes.data(), static_cast<DWORD>(bytes.size()), &used, nullptr)) error = Error();
      if (!error) error = used > bytes.size() ? ERROR_INVALID_DATA : InspectCellMountPointReparse(std::span(bytes).first(used), expected.volume_id);
    }
    if (!error) error = Directory(parent, expected.parent, false);
    if (!error) error = Directory(directory, expected.directory, mounted);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ReadCellMountVolumeRoot(HANDLE root, const CellVolumeMountTarget& expected) noexcept {
  if (!IsValidCellVolumeMountTarget(expected)) return ERROR_INVALID_PARAMETER;
  try {
    DWORD error = Directory(root, expected.volume_root, false);
    std::wstring actual;
    if (!error) error = DirectoryPath(root, &actual);
    if (!error && !Same(actual, VolumePath(expected.volume_id, false))) error = ERROR_FILE_INVALID;
    if (!error) error = Directory(root, expected.volume_root, false);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
