#include "cell_filesystem.hpp"
#include "appcontainer_fixture.hpp"
#include <winioctl.h>
#include <array>
#include <cstddef>
#include <cstring>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace {
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
JobCommand IdentityFor(const std::wstring& image, const std::wstring& directory) {
  JobCommand command;
  command.image = image;
  command.directory = directory;
  goatcitadel::worker_cell_test::BindLaunchFixture(&command);
  return command;
}
DWORD Pin(PinnedCellLaunchFiles* files, const JobCommand& command) {
  return files->Open(command.image, command.directory, command.expected_image_sha256, command.expected_directory_identity);
}
bool OwnedPath(const std::wstring& root, const std::wstring& path) {
  std::array<wchar_t, 4096> canonical{};
  const DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(canonical.size()), canonical.data(), nullptr);
  return length && length < canonical.size() && path.rfind(root + L"\\", 0) == 0 &&
    CompareStringOrdinal(path.c_str(), -1, canonical.data(), -1, TRUE) == CSTR_EQUAL;
}
bool MoveOwned(const std::wstring& root, const std::wstring& from, const std::wstring& to) {
  Require(OwnedPath(root, from) && OwnedPath(root, to), "Filesystem fixture rename escaped its newly-created root.");
  return MoveFileW(from.c_str(), to.c_str()) != FALSE;
}
void Stream(const std::wstring& path) {
  Handle file{CreateFileW((path + L":fixture-stream").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Require(file.value != INVALID_HANDLE_VALUE, "Create task-owned alternate stream failed.");
  DWORD written = 0;
  constexpr char data[] = "fixture";
  Require(WriteFile(file.value, data, sizeof(data) - 1, &written, nullptr) && written == sizeof(data) - 1,
    "Write task-owned alternate stream failed.");
}
void Sparse(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  DWORD returned = 0;
  Require(file.value != INVALID_HANDLE_VALUE && DeviceIoControl(file.value, FSCTL_SET_SPARSE,
    nullptr, 0, nullptr, 0, &returned, nullptr), "Mark task-owned fixture sparse failed.");
}
void Compress(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  USHORT format = COMPRESSION_FORMAT_DEFAULT;
  DWORD returned = 0;
  Require(file.value != INVALID_HANDLE_VALUE && DeviceIoControl(file.value, FSCTL_SET_COMPRESSION,
    &format, sizeof(format), nullptr, 0, &returned, nullptr), "Compress task-owned fixture failed.");
}
void Junction(const std::wstring& path, const std::wstring& target) {
  struct Buffer final {
    DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
    USHORT length = 0, reserved = 0, substitute_offset = 0, substitute_length = 0, print_offset = 0, print_length = 0;
    wchar_t paths[2048]{};
  } buffer;
  const std::wstring substitute = L"\\??\\" + target;
  Require(substitute.size() + target.size() + 2 < std::size(buffer.paths), "Junction fixture exceeds its bound.");
  buffer.substitute_length = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  buffer.print_offset = static_cast<USHORT>(buffer.substitute_length + sizeof(wchar_t));
  buffer.print_length = static_cast<USHORT>(target.size() * sizeof(wchar_t));
  std::memcpy(buffer.paths, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
  std::memcpy(reinterpret_cast<std::uint8_t*>(buffer.paths) + buffer.print_offset, target.c_str(), (target.size() + 1) * sizeof(wchar_t));
  buffer.length = static_cast<USHORT>(8 + buffer.print_offset + buffer.print_length + sizeof(wchar_t));
  Handle directory{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
  DWORD returned = 0;
  Require(directory.value != INVALID_HANDLE_VALUE && DeviceIoControl(directory.value, FSCTL_SET_REPARSE_POINT,
    &buffer, 8 + buffer.length, nullptr, 0, &returned, nullptr), "Create task-owned junction fixture failed.");
}
}

unsigned RunCellFilesystemTests(const std::wstring& source_image) {
  unsigned checks = 0;
  const auto check = [&](bool condition, const char* message) { ++checks; Require(condition, message); };
  const auto parent = source_image.substr(0, source_image.find_last_of(L'\\'));
  const auto root = parent + L"\\filesystem-" + std::to_wstring(GetCurrentProcessId());
  check(CreateDirectoryW(root.c_str(), nullptr) != FALSE, "Create exclusive filesystem fixture root failed.");
  const auto directory = [&](const wchar_t* name) {
    const auto path = root + L"\\" + name;
    Require(OwnedPath(root, path) && CreateDirectoryW(path.c_str(), nullptr), "Create exclusive fixture directory failed.");
    return path;
  };
  const auto image = [&](const wchar_t* name) {
    const auto path = root + L"\\" + name;
    Require(OwnedPath(root, path) && CopyFileW(source_image.c_str(), path.c_str(), TRUE), "Copy exclusive fixture image failed.");
    return path;
  };
  const auto writable = directory(L"work");
  const auto executable = image(L"entry.exe");
  const auto admitted = IdentityFor(executable, writable);
  PinnedCellLaunchFiles files;
  check(Pin(&files, admitted) == ERROR_SUCCESS, "Pin actual NTFS image and admitted root failed.");
  HANDLE current_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, GetCurrentProcessId());
  check(current_process != nullptr, "Open the distinct fixture controller for loaded-image verification.");
  const DWORD different_image = files.VerifyProcessImage(current_process);
  if (current_process) CloseHandle(current_process);
  check(different_image == ERROR_FILE_INVALID, "A different actual process image must not satisfy the pinned launch image.");
  check(files.ImagePath().rfind(L"\\\\?\\Volume{", 0) == 0 && files.DirectoryPath().rfind(L"\\\\?\\Volume{", 0) == 0,
    "Pinned launch paths must use volume GUIDs rather than a mutable drive mapping.");
  check(Pin(&files, admitted) == ERROR_ALREADY_INITIALIZED, "An occupied pin cannot silently replace its retained objects.");
  auto guid_admitted = admitted;
  guid_admitted.image = files.ImagePath(); guid_admitted.directory = files.DirectoryPath();
  PinnedCellLaunchFiles guid_files;
  check(Pin(&guid_files, guid_admitted) == ERROR_SUCCESS && guid_files.ImagePath() == files.ImagePath() &&
    guid_files.DirectoryPath() == files.DirectoryPath(), "volume GUID paths retain the same actual NTFS objects");
  guid_files.Reset();
  Handle writer{CreateFileW(executable.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  const DWORD write_error = GetLastError();
  check(writer.value == INVALID_HANDLE_VALUE && write_error == ERROR_SHARING_VIOLATION, "Pinned executable must refuse write access.");
  check(!MoveOwned(root, executable, root + L"\\renamed-entry.exe"), "Pinned executable must refuse rename.");
  check(!MoveOwned(root, writable, root + L"\\renamed-work"), "Pinned root must refuse rename.");
  files.Reset();
  check(files.ImagePath().empty() && files.DirectoryPath().empty(), "Released pins must clear their path projection.");
  Handle released{CreateFileW(executable.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  check(released.value != INVALID_HANDLE_VALUE, "Write control must succeed after the image pin is released.");
  check(Pin(&files, admitted) == ERROR_SHARING_VIOLATION, "An existing writer must block the image pin.");
  CloseHandle(released.value); released.value = INVALID_HANDLE_VALUE;
  check(Pin(&files, admitted) == ERROR_SUCCESS, "Pin can recover after a competing writer closes.");
  files.Reset();

  auto changed = admitted;
  changed.expected_image_sha256[0] ^= 1;
  check(Pin(&files, changed) == ERROR_CRC && files.ImagePath().empty(), "Wrong expected image hash must fail and release pins.");
  changed = admitted; changed.expected_directory_identity.file_id[0] ^= 1;
  check(Pin(&files, changed) == ERROR_FILE_INVALID, "Wrong directory file ID must be refused.");
  changed = admitted; changed.expected_directory_identity.volume_serial ^= 1;
  check(Pin(&files, changed) == ERROR_FILE_INVALID, "Wrong directory volume serial must be refused.");
  check(MoveOwned(root, writable, root + L"\\original-work"), "Unpinned task-owned root rename failed.");
  check(CreateDirectoryW(writable.c_str(), nullptr) != FALSE, "Create swapped-root fixture failed.");
  check(Pin(&files, admitted) == ERROR_FILE_INVALID, "A same-path replacement must not inherit the admitted directory identity.");

  const auto tampered = image(L"tampered.exe");
  const auto before_change = IdentityFor(tampered, root);
  {
    Handle file{CreateFileW(tampered.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    LARGE_INTEGER offset{};
    offset.QuadPart = 64;
    std::uint8_t byte = 0;
    DWORD count = 0;
    Require(file.value != INVALID_HANDLE_VALUE && SetFilePointerEx(file.value, offset, nullptr, FILE_BEGIN) &&
      ReadFile(file.value, &byte, 1, &count, nullptr) && count == 1, "Read owned image mutation fixture failed.");
    byte ^= 1;
    Require(SetFilePointerEx(file.value, offset, nullptr, FILE_BEGIN) && WriteFile(file.value, &byte, 1, &count, nullptr) &&
      count == 1 && FlushFileBuffers(file.value), "Write owned image mutation fixture failed.");
  }
  check(IdentityFor(tampered, root).expected_image_sha256 != before_change.expected_image_sha256,
    "Control hash must observe the real executable byte change.");
  check(Pin(&files, before_change) == ERROR_CRC, "Actual executable byte drift must invalidate its prior admission hash.");

  const auto linked = image(L"linked.exe");
  check(CreateHardLinkW((root + L"\\second-name.exe").c_str(), linked.c_str(), nullptr) != FALSE, "Create actual hard-link fixture failed.");
  check(Pin(&files, IdentityFor(linked, root)) == ERROR_ACCESS_DENIED, "Image with a second hard link must be refused.");
  const auto stream_image = image(L"stream.exe");
  Stream(stream_image);
  check(Pin(&files, IdentityFor(stream_image, root)) == ERROR_ACCESS_DENIED, "Executable alternate data stream must be refused.");
  const auto stream_directory = directory(L"stream-directory");
  Stream(stream_directory);
  check(Pin(&files, IdentityFor(executable, stream_directory)) == ERROR_ACCESS_DENIED, "Directory alternate data stream must be refused.");
  const auto sparse = image(L"sparse.exe");
  Sparse(sparse);
  check(Pin(&files, IdentityFor(sparse, root)) == ERROR_ACCESS_DENIED, "Actual sparse executable must be refused.");
  const auto compressed = image(L"compressed.exe");
  Compress(compressed);
  check(Pin(&files, IdentityFor(compressed, root)) == ERROR_ACCESS_DENIED, "Actual compressed executable must be refused.");

  const auto target = directory(L"junction-target");
  check(CopyFileW(source_image.c_str(), (target + L"\\entry.exe").c_str(), TRUE) != FALSE, "Create junction target image failed.");
  const auto alias = directory(L"junction-alias");
  Junction(alias, target);
  changed = IdentityFor(executable, target); changed.directory = alias;
  check(Pin(&files, changed) == ERROR_ACCESS_DENIED, "Junction working-directory alias must be refused before following it.");
  changed = IdentityFor(target + L"\\entry.exe", root); changed.image = alias + L"\\entry.exe";
  check(Pin(&files, changed) == ERROR_ACCESS_DENIED, "Junction ancestor of an executable must be refused before following it.");

  const auto base = IdentityFor(executable, root);
  for (const auto& path : {L"relative.exe", L"C:relative.exe", L"\\\\server\\share\\entry.exe", L"\\\\.\\C:\\entry.exe",
      L"\\\\?\\C:\\entry.exe", L"C:\\..\\entry.exe", L"C:\\entry.exe:stream", L"C:\\NUL", L"C:\\COM1.exe",
      L"C:\\entry.exe.", L"C:\\entry.exe ", L"C:\\double\\\\entry.exe"}) {
    changed = base; changed.image = path;
    check(Pin(&files, changed) == ERROR_INVALID_PARAMETER, "Invalid native path spelling must be refused before opening it.");
  }
  changed = base; changed.directory.push_back(L'\0');
  check(Pin(&files, changed) == ERROR_INVALID_PARAMETER, "Embedded NUL in root must be refused.");
  const auto guid_root = guid_admitted.image.substr(0, 49);
  for (const auto& invalid : {std::wstring(L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\entry.exe"),
      std::wstring(L"\\\\?\\Volume{invalid}\\entry.exe"), guid_root + L"..\\entry.exe", guid_root + L"entry.exe:stream",
      guid_root + L"NUL.txt", guid_root + L"dir\\\\entry.exe", guid_root + L"dir/entry.exe",
      guid_root.substr(0, 48) + L"entry.exe", guid_root + L"entry.exe "}) {
    changed = base; changed.image = invalid;
    check(!IsLiteralCellPath(invalid) && Pin(&files, changed) == ERROR_INVALID_PARAMETER,
      "malformed volume paths and device namespaces are refused before filesystem access");
  }
  return checks;
}
