#include "cell_controller_identity.hpp"
#include "cell_workspace.hpp"
#include <sddl.h>
#include <cstdio>
#include <cstring>

using namespace goatcitadel::worker_cell;
namespace {
struct Handle final { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
bool Read(const wchar_t* path, std::vector<std::uint8_t>* bytes) {
  Handle file{CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  LARGE_INTEGER size{};
  if (file.value == INVALID_HANDLE_VALUE || !GetFileSizeEx(file.value, &size) || size.QuadPart <= 0 || size.QuadPart > 4096) return false;
  bytes->resize(static_cast<std::size_t>(size.QuadPart));
  DWORD count = 0;
  return ReadFile(file.value, bytes->data(), static_cast<DWORD>(bytes->size()), &count, nullptr) && count == bytes->size();
}
bool Directory(const wchar_t* path, const CellFileIdentity& expected) {
  Handle directory{CreateFileW(path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  FILE_ID_INFO identity{};
  return directory.value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(directory.value, FileIdInfo, &identity, sizeof(identity)) &&
    identity.VolumeSerialNumber == expected.volume_serial && std::memcmp(identity.FileId.Identifier, expected.file_id.data(), 16) == 0;
}
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 5) return 2;
  std::vector<std::uint8_t> bytes, descriptor_text, expected;
  CellControllerCustodyRecord record;
  if (!Read(argv[1], &bytes) || !DecodeCellControllerCustody(bytes, &record) || !Directory(argv[2], record.native_directory) ||
      !Directory(argv[3], record.parent) || !Read(argv[4], &descriptor_text) ||
      BuildCellParentSecurity(L"S-1-5-18", kCellControllerServiceSid, &expected)) return 3;
  std::wstring sddl(descriptor_text.begin(), descriptor_text.end());
  void* descriptor = nullptr;
  ULONG length = 0;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, &length)) return 4;
  const bool equal = length == expected.size() && std::memcmp(descriptor, expected.data(), length) == 0;
  LocalFree(descriptor);
  if (!equal) return 5;
  std::puts("{\"passed\":true,\"directoryIdentities\":2,\"runtimeDescriptorEqual\":true,\"installedService\":false}");
  return 0;
}
