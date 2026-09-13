#include "signer_inspection.hpp"

#include <sddl.h>
#include <array>
#include <cstdio>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;
namespace {
int failures = 0;
unsigned checks = 0;
void Check(bool value, const char* message) noexcept {
  ++checks;
  if (!value) { ++failures; std::fprintf(stderr, "FAIL signer inspection: %s\n", message); }
}
struct Handle final { HANDLE value = nullptr; ~Handle() { if (value) CloseHandle(value); } };
struct Local final { void* value = nullptr; ~Local() { if (value) LocalFree(value); } };
constexpr wchar_t kWorker[] = L"S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905";

bool Allowed(PSECURITY_DESCRIPTOR descriptor, HANDLE token, DWORD access) noexcept {
  GENERIC_MAPPING mapping{};
  alignas(16) std::array<BYTE, 1024U> privilege_bytes{};
  DWORD privilege_length = static_cast<DWORD>(privilege_bytes.size());
  DWORD granted = 0U;
  BOOL allowed = FALSE;
  const bool checked = AccessCheck(descriptor, token, access, &mapping,
      reinterpret_cast<PRIVILEGE_SET*>(privilege_bytes.data()), &privilege_length,
      &granted, &allowed) != FALSE;
  Check(checked, "Windows evaluates the requested access");
  return checked && allowed && (granted & access) == access;
}

void TestDescriptorComposition() noexcept {
  Local descriptor;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"O:SYG:SYD:P(D;;0x00040000;;;WD)(A;;0x001fffff;;;SY)(A;;0x00020000;;;BA)",
      SDDL_REVISION_1, &descriptor.value, nullptr) != FALSE, "input descriptor parses");
  if (!descriptor.value) return;
  PSID owner = nullptr;
  PACL dacl = nullptr;
  BOOL defaulted = TRUE, present = FALSE;
  Check(GetSecurityDescriptorOwner(descriptor.value, &owner, &defaulted) != FALSE &&
      GetSecurityDescriptorDacl(descriptor.value, &present, &dacl, &defaulted) != FALSE && present,
      "input descriptor exposes owner and ACL");
  Local worker;
  Check(ConvertStringSidToSidW(kWorker, &worker.value) != FALSE, "worker SID parses");
  if (!dacl || !owner || !worker.value) return;
  for (const auto kind : {gc::SignerInspectionObject::Process, gc::SignerInspectionObject::Token}) {
    gc::SignerInspectionAcl output;
    const DWORD expected = kind == gc::SignerInspectionObject::Process
        ? PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE : TOKEN_QUERY;
    Check(gc::ComposeSignerInspectionAcl(owner, dacl, kind, &output), "worker query grant composes");
    const auto result = reinterpret_cast<PACL>(output.bytes.data());
    Check(result->AceCount == dacl->AceCount + 1U, "one new ACE only");
    for (DWORD index = 0U; index < dacl->AceCount; ++index) {
      void* before = nullptr;
      void* after = nullptr;
      Check(GetAce(dacl, index, &before) && GetAce(result, index, &after) &&
          std::memcmp(before, after, static_cast<ACE_HEADER*>(before)->AceSize) == 0,
          "existing allows and denies remain byte-identical and ordered");
    }
    void* raw = nullptr;
    Check(GetAce(result, result->AceCount - 1U, &raw) != FALSE, "worker ACE is last");
    if (raw) {
      const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      Check(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == 0U &&
          ace->Mask == expected && EqualSid(&ace->SidStart, worker.value), "exact worker inspection mask");
      gc::SignerInspectionAcl replay;
      Check(gc::ComposeSignerInspectionAcl(owner, result, kind, &replay) &&
          std::memcmp(output.bytes.data(), replay.bytes.data(), result->AclSize) == 0,
          "composition is idempotent");
      ace->Mask |= WRITE_DAC;
      Check(!gc::ComposeSignerInspectionAcl(owner, result, kind, &replay), "overprivileged worker ACE refused");
      ace->Mask = expected;
      ace->Header.AceType = ACCESS_DENIED_ACE_TYPE;
      Check(!gc::ComposeSignerInspectionAcl(owner, result, kind, &replay), "direct worker deny is never replaced");
    }
  }
  gc::SignerInspectionAcl output;
  Check(!gc::ComposeSignerInspectionAcl(worker.value, dacl, gc::SignerInspectionObject::Process, &output), "wrong owner refused");
  Check(!gc::ComposeSignerInspectionAcl(owner, nullptr, gc::SignerInspectionObject::Process, &output), "NULL DACL refused");
  Check(!gc::ComposeSignerInspectionAcl(owner, dacl, static_cast<gc::SignerInspectionObject>(255), &output), "unknown object refused");
}

void TestWindowsAccessAndOwnedToken() noexcept {
  Handle primary, restricted, impersonation, duplicate;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &primary.value) != FALSE, "test token opens");
  Local worker;
  Check(ConvertStringSidToSidW(kWorker, &worker.value) != FALSE, "restricted SID parses");
  if (!primary.value || !worker.value) return;
  SID_AND_ATTRIBUTES restriction{worker.value, 0U};
  Check(CreateRestrictedToken(primary.value, DISABLE_MAX_PRIVILEGE, 0U, nullptr, 0U, nullptr,
      1U, &restriction, &restricted.value) != FALSE, "new restricted test token creates");
  if (!restricted.value) return;
  Check(DuplicateTokenEx(restricted.value, TOKEN_QUERY, nullptr, SecurityImpersonation,
      TokenImpersonation, &impersonation.value) != FALSE, "new test impersonation token creates");
  alignas(16) std::array<BYTE, 512U> user_bytes{};
  DWORD returned = 0U;
  Check(GetTokenInformation(primary.value, TokenUser, user_bytes.data(),
      static_cast<DWORD>(user_bytes.size()), &returned) != FALSE, "test owner reads");
  const auto user = reinterpret_cast<TOKEN_USER*>(user_bytes.data());
  if (!user->User.Sid || !impersonation.value) return;
  Local system;
  Check(ConvertStringSidToSidW(L"S-1-5-18", &system.value) != FALSE, "SYSTEM SID parses");
  Local everyone;
  Check(ConvertStringSidToSidW(L"S-1-1-0", &everyone.value) != FALSE, "Everyone SID parses");
  if (!system.value || !everyone.value) return;
  for (const auto kind : {gc::SignerInspectionObject::Process, gc::SignerInspectionObject::Token}) {
    alignas(16) std::array<BYTE, 512U> input{};
    auto acl = reinterpret_cast<PACL>(input.data());
    Check(InitializeAcl(acl, static_cast<DWORD>(input.size()), ACL_REVISION) &&
        AddAccessAllowedAceEx(acl, ACL_REVISION, 0U, 0x001fffffU, user->User.Sid), "base test ACL builds");
    gc::SignerInspectionAcl output;
    Check(gc::ComposeSignerInspectionAcl(system.value, acl, kind, &output), "Windows access fixture composes");
    SECURITY_DESCRIPTOR descriptor{};
    Check(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
        SetSecurityDescriptorOwner(&descriptor, system.value, FALSE) &&
        SetSecurityDescriptorGroup(&descriptor, system.value, FALSE) &&
        SetSecurityDescriptorDacl(&descriptor, TRUE, reinterpret_cast<PACL>(output.bytes.data()), FALSE), "Windows access descriptor builds");
    const DWORD expected = kind == gc::SignerInspectionObject::Process
        ? PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE : TOKEN_QUERY;
    const DWORD valid = kind == gc::SignerInspectionObject::Process ? PROCESS_ALL_ACCESS : TOKEN_ALL_ACCESS;
    for (unsigned bit = 0U; bit < 24U; ++bit) {
      const DWORD access = 1UL << bit;
      if ((valid & access) == 0U) continue;
      Check(Allowed(&descriptor, impersonation.value, access) == ((expected & access) != 0U),
          "Windows grants only query/wait and denies mutation, memory access and token duplication");
    }
    Check(InitializeAcl(acl, static_cast<DWORD>(input.size()), ACL_REVISION) &&
        AddAccessDeniedAceEx(acl, ACL_REVISION, 0U, expected, everyone.value) &&
        AddAccessAllowedAceEx(acl, ACL_REVISION, 0U, 0x001fffffU, user->User.Sid), "explicit-deny fixture builds");
    Check(gc::ComposeSignerInspectionAcl(system.value, acl, kind, &output), "existing deny remains composable");
    Check(!Allowed(&descriptor, impersonation.value, expected), "Windows still enforces a prior deny after the worker grant");
  }
  Check(DuplicateTokenEx(primary.value, TOKEN_QUERY | READ_CONTROL | WRITE_DAC, nullptr,
      SecurityImpersonation, TokenPrimary, &duplicate.value) != FALSE, "unassigned token clone creates");
  if (duplicate.value) {
    Check(gc::ApplySignerInspectionAclForTest(duplicate.value, user->User.Sid), "owned token descriptor applies and reads back");
    Check(gc::ApplySignerInspectionAclForTest(duplicate.value, user->User.Sid), "owned token repeat retains exact ACL");
  }
  Check(gc::ApplySignerProcessInspectionForTest(user->User.Sid), "owned test process descriptor applies through its pseudo-handle");
  Check(gc::ApplySignerProcessInspectionForTest(user->User.Sid), "owned test process descriptor is idempotent");
  Check(!gc::GrantCurrentSignerInspectionAccess(), "interactive test process cannot grant production access");
}
}  // namespace

int RunSignerInspectionTests() noexcept {
  const int before = failures;
  TestDescriptorComposition();
  TestWindowsAccessAndOwnedToken();
#if defined(GOATCITADEL_SIGNER_INSPECTION_STANDALONE)
  std::printf("{\"signerInspectionChecks\":%u,\"failures\":%d,\"installedService\":false}\n", checks, failures - before);
#endif
  return failures - before;
}

#if defined(GOATCITADEL_SIGNER_INSPECTION_STANDALONE)
#pragma comment(lib, "advapi32.lib")
int main() { return RunSignerInspectionTests(); }
#endif
