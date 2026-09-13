#include <windows.h>
#include <sddl.h>
#include <array>
#include <cstdio>
#include <cstdint>
#include <string>
#pragma comment(lib, "advapi32.lib")

// Creates one new test-owned parent. Never changes an existing directory, token
// privilege or ACL. The production provisioning helper independently admits it.
namespace {
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::string Hex(const std::uint8_t* bytes, std::size_t count) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  for (std::size_t i = 0; i < count; ++i) { result += digits[bytes[i] >> 4]; result += digits[bytes[i] & 15]; }
  return result;
}
int Run(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  Handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) return 3;
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> data{};
  DWORD size = 0;
  if (!GetTokenInformation(token.value, TokenUser, data.data(), static_cast<DWORD>(data.size()), &size)) return 3;
  LPWSTR text = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &text)) return 3;
  const std::wstring user(text);
  LocalFree(text);
  const auto sddl = L"O:" + user + L"G:" + user + L"D:P(A;OICI;FA;;;SY)" +
    (user == L"S-1-5-18" ? L"" : L"(A;OICI;FA;;;" + user + L")") + L"(A;OICI;RC;;;OW)S:(ML;OICI;NW;;;ME)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return 3;
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor, FALSE};
  const bool created = CreateDirectoryW(argv[1], &attributes) != FALSE;
  LocalFree(descriptor);
  if (!created) return 4;
  Handle parent{CreateFileW(argv[1], FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  FILE_ID_INFO info{};
  if (parent.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandleEx(parent.value, FileIdInfo, &info, sizeof(info))) return 5;
  std::array<std::uint8_t, 24> identity{};
  for (unsigned i = 0; i < 8; ++i) identity[i] = static_cast<std::uint8_t>(info.VolumeSerialNumber >> (8 * i));
  for (unsigned i = 0; i < 16; ++i) identity[i + 8] = info.FileId.Identifier[i];
  std::string sid;
  for (const auto value : user) sid += static_cast<char>(value);
  std::printf("{\"parentIdentityHex\":\"%s\",\"ownerSid\":\"%s\",\"controllerSid\":\"%s\"}\n",
    Hex(identity.data(), identity.size()).c_str(), sid.c_str(), sid.c_str());
  return 0;
}
}
int wmain(int argc, wchar_t** argv) {
  try { return Run(argc, argv); } catch (...) { return 6; }
}
