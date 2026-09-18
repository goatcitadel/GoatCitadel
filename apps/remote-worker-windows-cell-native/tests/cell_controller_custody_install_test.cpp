#include "cell_controller_identity.hpp"
#include "cell_workspace.hpp"
#include <sddl.h>
#include <bcrypt.h>
#include <cstdio>
#include <cstring>
#include <utility>

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
  if (argc != 7) return 2;
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
  CellControllerRuntimeCustodyRecord runtime;
  if (!Read(argv[5], &bytes) || !DecodeCellControllerRuntimeCustody(bytes, &runtime) || !Directory(argv[6], runtime.source_directory)) return 6;
  std::vector<CellRuntimeBundleFile> files;
  for (const auto* name : {L"node.exe", L"worker-host-receipt.json"}) {
    std::vector<std::uint8_t> content; CellFileSha256 hash{};
    if (!Read((std::wstring(argv[6]) + L"\\" + name).c_str(), &content) ||
        BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, content.data(), static_cast<ULONG>(content.size()),
          hash.data(), static_cast<ULONG>(hash.size())) < 0) return 15;
    files.push_back({name, static_cast<std::uint64_t>(content.size()), hash});
  }
  PinnedCellRuntimeBundle bundle;
  CellControllerInstalledFiles unopened;
  CellControllerIdentity controller;
  if (unopened.OpenRuntimeBundle(files, bundle) != ERROR_INVALID_STATE || bundle.Ready() ||
      controller.OpenRuntimeBundle(files, bundle) != ERROR_INVALID_STATE || bundle.Ready()) return 16;
  if (bundle.Open(argv[6], runtime.source_directory, files, runtime.bundle_sha256) || !bundle.Ready()) return 17;
  if (unopened.OpenRuntimeBundle(files, bundle) != ERROR_ALREADY_INITIALIZED || !bundle.Ready()) return 18;
  PinnedCellRuntimeBundle altered;
  auto changed_files = files; ++changed_files[0].bytes;
  if (altered.Open(argv[6], runtime.source_directory, changed_files, runtime.bundle_sha256) != ERROR_CRC || altered.Ready()) return 19;
  auto foreign_hash = runtime.bundle_sha256; foreign_hash[0] ^= 1;
  if (altered.Open(argv[6], runtime.source_directory, files, foreign_hash) != ERROR_CRC || altered.Ready()) return 20;
  Handle record_handle{CreateFileW(argv[5], GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Handle source_handle{CreateFileW(argv[6], FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Handle foreign_handle{CreateFileW(argv[2], FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  const HANDLE runtime_record = record_handle.value, source = source_handle.value, foreign_source = foreign_handle.value;
  if (runtime_record == INVALID_HANDLE_VALUE || source == INVALID_HANDLE_VALUE || foreign_source == INVALID_HANDLE_VALUE) return 11;
  CellControllerRuntimeCustodyRecord reread;
  for (unsigned repeat = 0; repeat < 2; ++repeat) {
    if (ReadCellControllerRuntimeCustody(runtime_record, source, &reread) || reread.source_directory != runtime.source_directory ||
        reread.bundle_sha256 != runtime.bundle_sha256 || reread.package_sha256 != runtime.package_sha256) return 12;
  }
  if (ReadCellControllerRuntimeCustody(runtime_record, foreign_source, &reread) != ERROR_FILE_INVALID ||
      reread.source_directory != CellFileIdentity{} || reread.bundle_sha256 != CellFileSha256{} || reread.package_sha256 != CellFileSha256{}) return 13;
  if (ReadCellControllerRuntimeCustody(INVALID_HANDLE_VALUE, source, &reread) != ERROR_INVALID_DATA ||
      ReadCellControllerRuntimeCustody(runtime_record, runtime_record, &reread) != ERROR_FILE_INVALID ||
      ReadCellControllerRuntimeCustody(runtime_record, source, nullptr) != ERROR_INVALID_PARAMETER) return 14;
  if (DecodeCellControllerRuntimeCustody(bytes, nullptr)) return 7;
  for (std::size_t size = 0; size < bytes.size(); ++size) {
    auto truncated = bytes; truncated.resize(size); auto decoded = runtime;
    if (DecodeCellControllerRuntimeCustody(truncated, &decoded) || decoded.source_directory != CellFileIdentity{} ||
        decoded.bundle_sha256 != CellFileSha256{} || decoded.package_sha256 != CellFileSha256{}) return 8;
  }
  for (const auto span : {std::pair<std::size_t, std::size_t>{0, 8}, {8, 8}, {16, 16}, {32, 32}, {64, 32}}) {
    auto changed = bytes; std::memset(changed.data() + span.first, 0, span.second);
    if (DecodeCellControllerRuntimeCustody(changed, &runtime)) return 9;
  }
  bytes.push_back(0); if (DecodeCellControllerRuntimeCustody(bytes, &runtime)) return 10;
  std::puts("{\"passed\":true,\"directoryIdentities\":3,\"runtimeCustodyDecoded\":true,\"runtimeCustodyHandleRead\":true,\"runtimeDescriptorEqual\":true,\"installedService\":false}");
  return 0;
}
