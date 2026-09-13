#include "cell_runtime_bundle.hpp"
#include "cell_workspace.hpp"
#include <aclapi.h>
#include <winternl.h>
#include <algorithm>
#include <array>
#include <cstring>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
namespace {
struct Handle final { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct Descriptor final { PSECURITY_DESCRIPTOR value = nullptr; ~Descriptor() { if (value) LocalFree(value); } };
struct Directories final {
  std::map<std::wstring, HANDLE> values;
  ~Directories() { for (auto item = values.rbegin(); item != values.rend(); ++item) CloseHandle(item->second); }
};
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
bool Cancelled(HANDLE cancellation) noexcept {
  return cancellation && WaitForSingleObject(cancellation, 0) != WAIT_TIMEOUT;
}
DWORD Empty(HANDLE directory) noexcept {
  alignas(FILE_ID_BOTH_DIR_INFO) std::array<std::uint8_t, 65536> bytes{};
  bool restart = true;
  for (;;) {
    if (!GetFileInformationByHandleEx(directory, restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
        bytes.data(), static_cast<DWORD>(bytes.size()))) {
      const DWORD error = Error();
      return error == ERROR_NO_MORE_FILES ? ERROR_SUCCESS : error;
    }
    restart = false;
    std::size_t offset = 0;
    for (;;) {
      if (offset > bytes.size() - offsetof(FILE_ID_BOTH_DIR_INFO, FileName)) return ERROR_INVALID_DATA;
      const auto* entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(bytes.data() + offset);
      if (entry->FileNameLength > bytes.size() - offset - offsetof(FILE_ID_BOTH_DIR_INFO, FileName) ||
          entry->FileNameLength % sizeof(wchar_t)) return ERROR_INVALID_DATA;
      const auto length = entry->FileNameLength / sizeof(wchar_t);
      if (!(length == 1 && entry->FileName[0] == L'.') &&
          !(length == 2 && entry->FileName[0] == L'.' && entry->FileName[1] == L'.')) return ERROR_DIR_NOT_EMPTY;
      if (!entry->NextEntryOffset) break;
      if (entry->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) ||
          entry->NextEntryOffset > bytes.size() - offset) return ERROR_INVALID_DATA;
      offset += entry->NextEntryOffset;
    }
  }
}
DWORD Create(HANDLE parent, const std::wstring& component, bool directory,
             PSECURITY_DESCRIPTOR descriptor, HANDLE* result) noexcept {
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  const FARPROC address = module ? GetProcAddress(module, "NtCreateFile") : nullptr;
  const FARPROC convert_address = module ? GetProcAddress(module, "RtlNtStatusToDosError") : nullptr;
  if (!address || !convert_address) return ERROR_PROC_NOT_FOUND;
  decltype(&NtCreateFile) create = nullptr;
  decltype(&RtlNtStatusToDosError) convert = nullptr;
  static_assert(sizeof(create) == sizeof(address) && sizeof(convert) == sizeof(convert_address));
  std::memcpy(&create, &address, sizeof(create));
  std::memcpy(&convert, &convert_address, sizeof(convert));
  UNICODE_STRING name{};
  name.Buffer = const_cast<wchar_t*>(component.c_str());
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t)); name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent; attributes.ObjectName = &name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE | 0x00001000UL; // OBJ_DONT_REPARSE
  attributes.SecurityDescriptor = descriptor;
  IO_STATUS_BLOCK io{};
  HANDLE created = nullptr;
  const NTSTATUS status = create(&created, FILE_GENERIC_READ | (directory ? 0 : FILE_GENERIC_WRITE), &attributes,
    &io, nullptr, directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_CREATE,
    FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE), nullptr, 0);
  if (status < 0) return convert(status);
  *result = created;
  return io.Information == 2 ? ERROR_SUCCESS : ERROR_INVALID_STATE; // FILE_CREATED only
}
DWORD Copy(HANDLE source, HANDLE destination, std::uint64_t bytes, std::uint64_t* written, HANDLE cancellation) noexcept {
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(source, beginning, nullptr, FILE_BEGIN)) return Error();
  std::array<std::uint8_t, 65536> buffer{};
  for (std::uint64_t offset = 0; offset < bytes;) {
    if (Cancelled(cancellation)) return ERROR_CANCELLED;
    const DWORD want = static_cast<DWORD>(std::min<std::uint64_t>(buffer.size(), bytes - offset));
    DWORD read = 0;
    if (!ReadFile(source, buffer.data(), want, &read, nullptr)) return Error();
    if (read != want) return ERROR_HANDLE_EOF;
    DWORD consumed = 0;
    while (consumed < read) {
      if (Cancelled(cancellation)) return ERROR_CANCELLED;
      DWORD count = 0;
      if (!WriteFile(destination, buffer.data() + consumed, read - consumed, &count, nullptr)) return Error();
      if (!count) return ERROR_WRITE_FAULT;
      consumed += count; *written += count;
    }
    offset += read;
  }
  return FlushFileBuffers(destination) ? ERROR_SUCCESS : Error();
}
}  // namespace

RuntimeBundleInstallResult PinnedCellRuntimeBundle::InstallTo(CellWorkspaceDirectories& destination,
    PinnedCellRuntimeBundle& output, HANDLE cancellation) noexcept {
  RuntimeBundleInstallResult result;
  try {
    if (this == &output || !ready_ || output.ready_ || !output.handles_.empty() || !output.root_input_.empty() ||
        file_handles_.size() != files_.size()) { result.error = ERROR_INVALID_STATE; return result; }
    if (Cancelled(cancellation)) { result.error = ERROR_CANCELLED; return result; }
    result.error = destination.Verify();
    if (result.error) return result;
    if (destination.DirectoryPath(CellDirectory::runtime).size() + 513 >= 2048) {
      result.error = ERROR_INVALID_PARAMETER; return result;
    }
    const HANDLE root = destination.DirectoryHandle(CellDirectory::runtime);
    result.error = Empty(root);
    if (result.error) return result;
    Descriptor descriptor;
    result.error = GetSecurityInfo(root, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
      DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor.value);
    if (result.error) return result;
    Directories directories;
    for (const auto& file : files_) {
      if (Cancelled(cancellation)) { result.error = ERROR_CANCELLED; return result; }
      result.error = destination.Verify();
      if (result.error) return result;
      HANDLE parent = root;
      std::size_t start = 0, slash = file.relative_path.find(L'/');
      while (slash != std::wstring::npos) {
        const auto key = file.relative_path.substr(0, slash);
        const auto found = directories.values.find(key);
        if (found != directories.values.end()) parent = found->second;
        else {
          Handle directory;
          result.error = Create(parent, file.relative_path.substr(start, slash - start), true, descriptor.value, &directory.value);
          if (directory.value != INVALID_HANDLE_VALUE && directory.value != nullptr) ++result.directories_created;
          if (result.error) return result;
          parent = directory.value;
          directories.values.emplace(key, parent); directory.value = INVALID_HANDLE_VALUE;
        }
        start = slash + 1; slash = file.relative_path.find(L'/', start);
      }
      Handle created;
      result.error = Create(parent, file.relative_path.substr(start), false, descriptor.value, &created.value);
      if (created.value != INVALID_HANDLE_VALUE && created.value != nullptr) ++result.files_created;
      if (result.error) return result;
      result.error = Copy(file_handles_.at(file.relative_path), created.value, file.bytes, &result.bytes_written, cancellation);
      if (result.error) return result;
    }
    result.error = destination.Verify();
    if (!result.error) result.error = output.Open(destination.DirectoryPath(CellDirectory::runtime),
      destination.DirectoryIdentity(CellDirectory::runtime), files_, manifest_sha256_, cancellation);
    result.verified = result.error == ERROR_SUCCESS && output.Ready();
    return result;
  } catch (...) { result.error = ERROR_NOT_ENOUGH_MEMORY; return result; }
}
}  // namespace goatcitadel::worker_cell
