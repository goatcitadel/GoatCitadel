#include "appcontainer_fixture.hpp"
#include "cell_runtime_bundle.hpp"
#include <sddl.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
using namespace goatcitadel::worker_cell_test;
namespace {
void Require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::string Hex(const std::uint8_t* bytes, std::size_t count) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result;
  for (std::size_t index = 0; index < count; ++index) { result += hex[bytes[index] >> 4]; result += hex[bytes[index] & 15]; }
  return result;
}
std::string IdentityHex(const CellFileIdentity& value) {
  std::array<std::uint8_t, 24> bytes{};
  for (unsigned index = 0; index < 8; ++index) bytes[index] = static_cast<std::uint8_t>(value.volume_serial >> (index * 8));
  std::copy(value.file_id.begin(), value.file_id.end(), bytes.begin() + 8);
  return Hex(bytes.data(), bytes.size());
}
std::wstring CurrentUser() {
  Handle token;
  Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "Open protected fixture user failed.");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> data{};
  DWORD size = 0;
  Require(GetTokenInformation(token.value, TokenUser, data.data(), static_cast<DWORD>(data.size()), &size), "Read protected fixture user failed.");
  LPWSTR text = nullptr;
  Require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &text), "Convert protected fixture user failed.");
  const std::wstring user(text);
  LocalFree(text);
  return user;
}
RuntimeWorkspaceReference ProtectFixture(JobCommand& command, const std::vector<std::wstring>& files) {
  const auto source_path = command.directory;
  const auto user = CurrentUser();
  const auto parent_path = source_path.substr(0, source_path.find_last_of(L'\\')) + L"\\cells";
  const auto sddl = L"O:" + user + L"G:" + user + L"D:P(A;OICI;FA;;;SY)" +
    (user == L"S-1-5-18" ? L"" : L"(A;OICI;FA;;;" + user + L")") + L"(A;OICI;RC;;;OW)S:(ML;OICI;NW;;;ME)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr), "Build protected parent descriptor failed.");
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor, FALSE};
  const bool created = CreateDirectoryW(parent_path.c_str(), &attributes) != FALSE;
  LocalFree(descriptor);
  Require(created, "Create exclusive protected fixture parent failed.");
  Handle parent{CreateFileW(parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  FILE_ID_INFO info{};
  Require(parent.value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(parent.value, FileIdInfo, &info, sizeof(info)),
    "Read protected parent identity failed.");
  CellFileIdentity parent_identity;
  parent_identity.volume_serial = info.VolumeSerialNumber;
  std::copy(std::begin(info.FileId.Identifier), std::end(info.FileId.Identifier), parent_identity.file_id.begin());
  CellWorkspaceDirectories workspace;
  Require(workspace.Create(parent.value, parent_identity, command.job_name, user, user) == ERROR_SUCCESS, "Create protected fixture workspace failed.");
  auto source_files = files;
  source_files.insert(source_files.begin(), command.image);
  std::vector<CellRuntimeBundleFile> manifest;
  for (const auto& file : source_files) {
    auto probe = command;
    probe.image = file;
    BindLaunchFixture(&probe, 256 * 1024 * 1024);
    Handle source{CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    LARGE_INTEGER size{};
    Require(source.value != INVALID_HANDLE_VALUE && GetFileSizeEx(source.value, &size) && size.QuadPart > 0, "Read protected source file size failed.");
    manifest.push_back({file.substr(file.find_last_of(L'\\') + 1), static_cast<std::uint64_t>(size.QuadPart), probe.expected_image_sha256});
  }
  std::sort(manifest.begin(), manifest.end(), [](const auto& left, const auto& right) { return left.relative_path < right.relative_path; });
  CellFileSha256 digest;
  Require(HashRuntimeBundleManifest(manifest, &digest) == ERROR_SUCCESS, "Hash protected source inventory failed.");
  PinnedCellRuntimeBundle source, installed;
  Require(source.Open(source_path, command.expected_directory_identity, manifest, digest) == ERROR_SUCCESS, "Pin protected source inventory failed.");
  const auto install = source.InstallTo(workspace, installed);
  Require(!install.error && install.verified, "Install protected fixture inventory failed.");
  RuntimeWorkspaceReference reference{parent_path, {}, user, user};
  Require(workspace.RecordIdentities(&reference.identities) == ERROR_SUCCESS, "Capture protected fixture record failed.");
  command.image = workspace.DirectoryPath(CellDirectory::runtime) + L"\\entry.exe";
  command.directory = workspace.DirectoryPath(CellDirectory::work);
  // Returning releases all provisioning pins. The stdio execution owner must
  // reopen the record itself; this keeper retains only its created profile.
  return reference;
}
int Main(int argc, wchar_t** argv) {
  if (argc == 3 && wcscmp(argv[1], L"--cleanup-profile") == 0) return CleanupKnownAppContainer(argv[2]) ? 0 : 2;
  const bool protected_workspace = (argc == 4 || argc == 6) && wcscmp(argv[argc - 1], L"--protected") == 0;
  if (argc != 3 && argc != 5 && !protected_workspace) return 2;
  const bool mcp = argc == 5 || argc == 6;
  std::array<wchar_t, 48> name{};
  swprintf_s(name.data(), name.size(), L"gc-cell-%016llx%016llx", static_cast<unsigned long long>(GetCurrentProcessId()),
    static_cast<unsigned long long>(GetTickCount64()));
  JobCommand command;
  command.job_name = name.data(); command.image = argv[1];
  command.directory = command.image.substr(0, command.image.find_last_of(L'\\'));
  const std::vector<std::wstring> files = mcp ? std::vector<std::wstring>{argv[3], argv[4]} : std::vector<std::wstring>{};
  command.app_container_name = PrepareAppContainer(command.job_name, command.image, files);
  ReportOwnedProfile(command.app_container_name, std::wstring(argv[2]) + L".profile");
  BindLaunchFixture(&command, mcp ? 256 * 1024 * 1024 : 16 * 1024 * 1024);
  std::optional<RuntimeWorkspaceReference> workspace;
  if (protected_workspace) {
    workspace = ProtectFixture(command, files);
    BindLaunchFixture(&command, mcp ? 256 * 1024 * 1024 : 16 * 1024 * 1024);
  }
  const auto ascii = [](const std::wstring& value) { std::string output; for (const auto byte : value) output += static_cast<char>(byte); return output; };
  std::string body = "{\"jobName\":\"" + ascii(command.job_name) + "\",\"appContainerName\":\"" + ascii(command.app_container_name) +
    "\",\"imageSha256\":\"" + Hex(command.expected_image_sha256.data(), command.expected_image_sha256.size()) +
    "\",\"directoryIdentity\":\"" + IdentityHex(command.expected_directory_identity) + "\"";
  if (workspace) {
    const auto& record = workspace->identities;
    body += ",\"runtimeRootIdentity\":\"" + IdentityHex(record.directories[2]) + "\",\"protectedWorkspace\":{\"parentIdentity\":\"" +
      IdentityHex(record.parent) + "\",\"rootIdentity\":\"" + IdentityHex(record.directories[0]) + "\",\"controlIdentity\":\"" +
      IdentityHex(record.directories[1]) + "\",\"runtimeIdentity\":\"" + IdentityHex(record.directories[2]) + "\",\"workIdentity\":\"" +
      IdentityHex(record.directories[3]) + "\",\"ownerSid\":\"" + ascii(workspace->owner_sid) + "\",\"controllerSid\":\"" +
      ascii(workspace->controller_sid) + "\"}";
  }
  body += "}";
  HANDLE file = CreateFileW(argv[2], GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 3;
  DWORD written = 0;
  const bool saved = WriteFile(file, body.data(), static_cast<DWORD>(body.size()), &written, nullptr) && written == body.size() && FlushFileBuffers(file);
  CloseHandle(file);
  if (!saved) return 4;
  if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "ready\n", 6, &written, nullptr) || written != 6) return 5;
  std::array<char, 64> bytes{};
  DWORD count = 0;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count) {}
  return 0;
}
}
int wmain(int argc, wchar_t** argv) {
  int result = 1;
  try { result = Main(argc, argv); }
  catch (const std::exception& error) { std::fprintf(stderr, "Native stdio fixture setup failed: %s\n", error.what()); }
  catch (...) { std::fprintf(stderr, "Native stdio fixture setup failed.\n"); }
  return CleanupAppContainers() ? result : 97;
}
