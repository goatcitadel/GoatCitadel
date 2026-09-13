#include "cell_volume_mount_target.hpp"
#include <winioctl.h>
#include <objbase.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0, native_checks = 0;
void Check(bool value, const char* message) {
  ++checks; if (!value) throw std::runtime_error(std::string(message) + " (Win32 " + std::to_string(GetLastError()) + ")");
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
const GUID volume = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
const std::wstring substitute = L"\\??\\Volume{12345678-9abc-4def-8123-456789abcdef}\\";
CellVolumeMountTarget Binding() {
  CellVolumeMountTarget result;
  result.volume_id = volume;
  result.parent.volume_serial = result.directory.volume_serial = 0x1234;
  result.parent.file_id.fill(0x11); result.directory.file_id.fill(0x22);
  result.volume_root.volume_serial = 0xabcd; result.volume_root.file_id.fill(0x33);
  return result;
}
void Put16(std::vector<std::uint8_t>& bytes, std::size_t offset, std::size_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value); bytes[offset + 1] = static_cast<std::uint8_t>(value >> 8);
}
std::vector<std::uint8_t> Reparse(std::wstring print = {}, bool print_first = false) {
  const auto substitute_bytes = substitute.size() * 2, print_bytes = print.size() * 2;
  const auto sub_offset = print_first ? print_bytes + 2 : 0, print_offset = print_first ? 0 : substitute_bytes + 2;
  std::vector<std::uint8_t> bytes(16 + substitute_bytes + print_bytes + 4);
  bytes[0] = 3; bytes[3] = 0xa0;
  Put16(bytes, 4, bytes.size() - 8); Put16(bytes, 8, sub_offset); Put16(bytes, 10, substitute_bytes);
  Put16(bytes, 12, print_offset); Put16(bytes, 14, print_bytes);
  for (std::size_t index = 0; index < substitute.size(); ++index) Put16(bytes, 16 + sub_offset + index * 2, substitute[index]);
  for (std::size_t index = 0; index < print.size(); ++index) Put16(bytes, 16 + print_offset + index * 2, print[index]);
  return bytes;
}
void Decode() {
  const auto good = Reparse();
  Check(InspectCellMountPointReparse(good, volume) == 0, "exact volume-GUID substitute accepted");
  for (const bool first : {false, true}) for (const auto& print : {std::wstring{}, std::wstring(L"GoatCitadel cell"), std::wstring(L"\U0001f410")})
    Check(InspectCellMountPointReparse(Reparse(print, first), volume) == 0, "bounded display names in either SDK order do not select the target");
  for (std::size_t length = 0; length < good.size(); ++length)
    Check(InspectCellMountPointReparse(std::span(good).first(length), volume) != 0, "every truncated response is refused");
  for (std::size_t offset = 0; offset < good.size(); ++offset) {
    auto bad = good; bad[offset] ^= 1;
    Check(InspectCellMountPointReparse(bad, volume) != 0, "malformed metadata, target or padding is refused");
  }
  auto foreign = volume; foreign.Data1 ^= 1;
  Check(InspectCellMountPointReparse(good, foreign) == ERROR_FILE_INVALID, "another recorded volume cannot be substituted");
  Check(InspectCellMountPointReparse(good, {}) == ERROR_INVALID_PARAMETER, "zero target is not authority");
  auto uppercase = good;
  for (std::size_t index = 16; index < 16 + 98; index += 2)
    if (uppercase[index] >= 'a' && uppercase[index] <= 'z') uppercase[index] -= 'a' - 'A';
  Check(InspectCellMountPointReparse(uppercase, volume) == 0, "Windows case-insensitive GUID naming remains valid");
  for (const std::wstring print : {std::wstring(1, L'\0'), std::wstring(1, L'\n'), std::wstring(1, 0xd800),
      std::wstring(1, 0xdc00), std::wstring{0xd800, L'x'}, std::wstring(513, L'x')})
    Check(InspectCellMountPointReparse(Reparse(print), volume) != 0, "malformed or oversized display text is refused");
  auto overlap = Reparse(L"display"); Put16(overlap, 12, 0);
  Check(InspectCellMountPointReparse(overlap, volume) != 0, "overlapping names are refused");
  auto overflow = good; Put16(overflow, 8, 65534);
  Check(InspectCellMountPointReparse(overflow, volume) != 0, "overflowing offsets are refused before decoding");
  auto oversized = good; oversized.resize(2050); Put16(oversized, 4, oversized.size() - 8);
  Check(InspectCellMountPointReparse(oversized, volume) != 0, "bounded response allocation");
  auto odd = good; odd.push_back(0); Put16(odd, 4, odd.size() - 8);
  Check(InspectCellMountPointReparse(odd, volume) != 0, "odd UTF-16 payload refused");

  const std::wstring folder = L"C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells\\cell\\volume\\";
  std::vector<wchar_t> names(folder.begin(), folder.end()); names.push_back(0); names.push_back(0);
  const auto used = static_cast<DWORD>(names.size());
  Check(InspectCellVolumeMountNames(names, used, folder) == 0, "one exact mounted folder accepted");
  auto folded = names; folded[0] = L'c';
  Check(InspectCellVolumeMountNames(folded, used, folder) == 0, "mount names use Windows ordinal case comparison");
  for (DWORD length = 0; length < used; ++length)
    Check(InspectCellVolumeMountNames(names, length, folder) != 0, "partial multi-string name list refused");
  Check(InspectCellVolumeMountNames(names, used + 1, folder) != 0, "reported length cannot exceed buffer");
  auto duplicate = names; duplicate.insert(duplicate.end() - 1, names.begin(), names.end() - 1);
  Check(InspectCellVolumeMountNames(duplicate, static_cast<DWORD>(duplicate.size()), folder) != 0, "second alias refused");
  const std::array<wchar_t, 2> empty{};
  Check(InspectCellVolumeMountNames(empty, 1, {}) == 0 && InspectCellVolumeMountNames(empty, 2, {}) == 0, "both Windows empty-list lengths accepted");
  Check(InspectCellVolumeMountNames(names, used, {}) == ERROR_ALREADY_EXISTS, "pre-mount check refuses an existing alias");
  Check(InspectCellVolumeMountNames(empty, 2, folder) != 0, "missing mounted folder is not success");
  for (const std::wstring candidate : {L"C:\\", L"C:\\folder", L"C:\\folder.\\", L"C:\\folder \\", L"C:\\folder\\..\\volume\\",
      L"\\\\server\\share\\volume\\", L"\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\", L"C:\\folder:stream\\"})
    Check(InspectCellVolumeMountNames(names, used, candidate) != 0, "drive roots and ambiguous/foreign path forms refused");
  auto drive = std::vector<wchar_t>{L'C', L':', L'\\', 0, 0};
  Check(InspectCellVolumeMountNames(drive, static_cast<DWORD>(drive.size()), folder) != 0, "drive-letter assignment cannot replace the expected folder");
  Check(InspectCellVolumeMountNames(std::vector<wchar_t>(4097), 2, {}) != 0, "mount-name decoder remains bounded");

  Check(IsValidCellVolumeMountTarget(Binding()), "independent host and volume identities required");
  for (const auto& mutate : std::vector<std::function<void(CellVolumeMountTarget&)>>{
      [](auto& b) { b.volume_id = {}; }, [](auto& b) { b.parent.volume_serial = 0; },
      [](auto& b) { b.directory.file_id.fill(0); }, [](auto& b) { b.volume_root.file_id.fill(0); },
      [](auto& b) { b.directory.volume_serial ^= 1; }, [](auto& b) { b.directory = b.parent; },
      [](auto& b) { b.volume_root.volume_serial = b.parent.volume_serial; }}) {
    auto bad = Binding(); mutate(bad);
    Check(!IsValidCellVolumeMountTarget(bad) && ReadCellMountHostDirectory(nullptr, nullptr, bad, false) == ERROR_INVALID_PARAMETER &&
      ReadCellMountVolumeRoot(nullptr, bad) == ERROR_INVALID_PARAMETER, "invalid identity binding refused before any OS probe");
  }
}
CellFileIdentity IdentityOf(HANDLE handle) {
  FILE_ID_INFO info{};
  Check(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)), "fixture identity query");
  CellFileIdentity identity; identity.volume_serial = info.VolumeSerialNumber;
  std::copy(std::begin(info.FileId.Identifier), std::end(info.FileId.Identifier), identity.file_id.begin());
  return identity;
}
HANDLE Open(const std::wstring& path) {
  return CreateFileW(path.c_str(), FILE_GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}
void Native(const std::wstring& root) {
  const auto before = checks;
  Check(CreateDirectoryW(root.c_str(), nullptr), "exclusive task-owned directory");
  Check(CreateDirectoryW((root + L"\\volume").c_str(), nullptr), "new ordinary mount-target fixture directory");
  Check(CreateDirectoryW((root + L"\\sibling").c_str(), nullptr), "new sibling fixture directory");
  Handle parent{Open(root)}, directory{Open(root + L"\\volume")}, sibling{Open(root + L"\\sibling")};
  Check(parent.value != INVALID_HANDLE_VALUE && directory.value != INVALID_HANDLE_VALUE && sibling.value != INVALID_HANDLE_VALUE,
    "fixture handles opened without changing security");
  auto binding = Binding(); binding.parent = IdentityOf(parent.value); binding.directory = IdentityOf(directory.value);
  binding.volume_root.volume_serial = binding.parent.volume_serial ^ 0x2abc;
  Check(ReadCellMountHostDirectory(parent.value, directory.value, binding, false) == 0, "real unmounted host directory identities and name match");
  Check(ReadCellMountHostDirectory(parent.value, directory.value, binding, true) != 0, "ordinary directory cannot masquerade as a mounted volume");
  Check(ReadCellMountHostDirectory(parent.value, sibling.value, binding, false) != 0, "sibling identity is not adopted");
  auto renamed = binding; renamed.directory = IdentityOf(sibling.value);
  Check(ReadCellMountHostDirectory(parent.value, sibling.value, renamed, false) != 0, "matching identity at the wrong component is refused");
  auto changed = binding; changed.parent.file_id[0] ^= 1;
  Check(ReadCellMountHostDirectory(parent.value, directory.value, changed, false) != 0, "changed recorded parent refused");
  Check(ReadCellMountHostDirectory(nullptr, directory.value, binding, false) != 0, "missing parent refused");
  Check(ReadCellMountVolumeRoot(directory.value, binding) != 0, "host directory cannot substitute for protected VHDX root");
  // Give the root probe the fixture's actual identity but a separate fake host
  // volume. Its literal path must still refuse a directory below a volume root.
  auto false_root = Binding(); false_root.volume_root = binding.directory;
  false_root.parent.volume_serial = false_root.directory.volume_serial = binding.parent.volume_serial ^ 0x2abc;
  Check(ReadCellMountVolumeRoot(directory.value, false_root) != 0, "matching file identity below the root is insufficient");
  Handle stream{CreateFileW((root + L"\\volume:unexpected").c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Check(stream.value != INVALID_HANDLE_VALUE, "task-owned directory stream fixture created");
  Check(ReadCellMountHostDirectory(parent.value, directory.value, binding, false) != 0, "alternate directory stream refused");
  native_checks = checks - before;
}
}
int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 2, "fresh task-owned output required"); Decode(); Native(argv[1]);
    std::printf("{\"passed\":true,\"checks\":%u,\"nativeDirectoryChecks\":%u,\"volumeMounted\":false,\"volumeAttached\":false,\"ntfsFormatted\":false,\"rootPermissionsChanged\":false}\n", checks, native_checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
