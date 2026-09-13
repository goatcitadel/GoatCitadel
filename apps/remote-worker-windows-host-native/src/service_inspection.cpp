#include "service_inspection.hpp"
#include <cstring>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_host {
namespace {
alignas(DWORD) constexpr std::array<BYTE, 12U> kSystemSid = {
    1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
constexpr auto MakeServiceSid(const std::array<std::uint32_t, 6U>& parts) noexcept {
  std::array<BYTE, 32U> result{};
  result[0] = 1U;
  result[1] = 6U;
  result[7] = 5U;
  for (std::size_t index = 0U; index < parts.size(); ++index) {
    for (unsigned byte = 0U; byte < 4U; ++byte) {
      result[8U + index * 4U + byte] =
          static_cast<BYTE>(parts[index] >> (byte * 8U));
    }
  }
  return result;
}
alignas(DWORD) constexpr auto kWorkerSid = MakeServiceSid({80U, UINT32_C(1804173726), UINT32_C(3601835665), UINT32_C(1843708740), UINT32_C(3959121232), UINT32_C(3866049905)});
PSID SystemSid() noexcept { return const_cast<BYTE*>(kSystemSid.data()); }
PSID WorkerSid() noexcept { return const_cast<BYTE*>(kWorkerSid.data()); }

struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { if (value) CloseHandle(value); }
};
struct KernelSecurity final {
  alignas(SECURITY_DESCRIPTOR_RELATIVE) std::array<BYTE, 8192U> bytes{};
  PSID owner = nullptr;
  PACL dacl = nullptr;
  bool protected_dacl = false;
};
struct PreparedGrant final { KernelSecurity before{}; WorkerInspectionAcl acl{}; };

bool SidFits(const BYTE* bytes, std::size_t length) noexcept {
  if (!bytes || length < 8U || bytes[1] > SID_MAX_SUB_AUTHORITIES) return false;
  const std::size_t required = 8U + 4U * bytes[1];
  return required <= length && IsValidSid(const_cast<BYTE*>(bytes)) != FALSE;
}

bool ReadKernelSecurity(HANDLE handle, KernelSecurity* output) noexcept {
  // GetCurrentProcess() is the valid -1 kernel pseudo-handle.
  if (!handle || !output) return false;
  DWORD returned = 0U;
  if (!GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          output->bytes.data(), static_cast<DWORD>(output->bytes.size()), &returned) ||
      returned < sizeof(SECURITY_DESCRIPTOR_RELATIVE) || returned > output->bytes.size()) return false;
  const auto relative = reinterpret_cast<const SECURITY_DESCRIPTOR_RELATIVE*>(output->bytes.data());
  if ((relative->Control & SE_SELF_RELATIVE) == 0U ||
      relative->Owner < sizeof(SECURITY_DESCRIPTOR_RELATIVE) || relative->Owner > returned ||
      !SidFits(output->bytes.data() + relative->Owner, returned - relative->Owner) ||
      relative->Dacl < sizeof(SECURITY_DESCRIPTOR_RELATIVE) || relative->Dacl > returned ||
      returned - relative->Dacl < sizeof(ACL)) return false;
  const auto acl = reinterpret_cast<const ACL*>(output->bytes.data() + relative->Dacl);
  if (acl->AclSize < sizeof(ACL) || acl->AclSize > returned - relative->Dacl ||
      acl->AclSize > kWorkerInspectionAclBytes || !IsValidAcl(const_cast<PACL>(acl))) return false;
  BOOL present = FALSE, defaulted = FALSE;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
  if (!GetSecurityDescriptorOwner(output->bytes.data(), &output->owner, &defaulted) ||
      output->owner != output->bytes.data() + relative->Owner ||
      !GetSecurityDescriptorDacl(output->bytes.data(), &present, &output->dacl, &defaulted) ||
      !present || output->dacl != acl ||
      !GetSecurityDescriptorControl(output->bytes.data(), &control, &revision) ||
      revision != SECURITY_DESCRIPTOR_REVISION) return false;
  output->protected_dacl = (control & SE_DACL_PROTECTED) != 0U;
  return true;
}

bool ComposeAcl(PSID owner, PACL original, PSID expected_owner,
    WorkerInspectionObject object, WorkerInspectionAcl* output) noexcept {
  const DWORD mask = object == WorkerInspectionObject::Process
      ? PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
      : object == WorkerInspectionObject::Token ? TOKEN_QUERY : 0U;
  if (!output || !owner || !expected_owner || !mask || !original ||
      !IsValidSid(owner) || !IsValidSid(expected_owner) || !EqualSid(owner, expected_owner) ||
      original->AclSize < sizeof(ACL) || original->AclSize > kWorkerInspectionAclBytes ||
      original->AceCount > 64U ||
      (original->AclRevision != ACL_REVISION && original->AclRevision != ACL_REVISION_DS) ||
      !IsValidAcl(original)) return false;
  std::size_t bytes = sizeof(ACL);
  unsigned worker_aces = 0U;
  for (DWORD index = 0U; index < original->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(original, index, &raw) || !raw) return false;
    const auto first = reinterpret_cast<std::uintptr_t>(original);
    const auto address = reinterpret_cast<std::uintptr_t>(raw);
    if (address < first || address - first > original->AclSize ||
        original->AclSize - (address - first) < sizeof(ACCESS_ALLOWED_ACE)) return false;
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    const std::size_t ace_length = ace->Header.AceSize;
    constexpr std::size_t sid_offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
    if (ace_length > original->AclSize - (address - first) || ace_length < sid_offset + 8U ||
        (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceType != ACCESS_DENIED_ACE_TYPE) ||
        (ace->Header.AceFlags & ~INHERITED_ACE) != 0U ||
        !SidFits(reinterpret_cast<const BYTE*>(&ace->SidStart), ace_length - sid_offset)) return false;
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (ace_length != sid_offset + GetLengthSid(sid)) return false;
    if (EqualSid(sid, WorkerSid())) {
      if (++worker_aces != 1U || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
          ace->Header.AceFlags != 0U || ace->Mask != mask) return false;
    }
    bytes += ace_length;
  }
  if (worker_aces == 0U) bytes += offsetof(ACCESS_ALLOWED_ACE, SidStart) + kWorkerSid.size();
  if (bytes > kWorkerInspectionAclBytes) return false;
  WorkerInspectionAcl candidate;
  auto result = reinterpret_cast<PACL>(candidate.bytes.data());
  if (!InitializeAcl(result, static_cast<DWORD>(bytes), original->AclRevision)) return false;
  for (DWORD index = 0U; index < original->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(original, index, &raw) || !raw ||
        !AddAce(result, original->AclRevision, MAXDWORD, raw, static_cast<ACE_HEADER*>(raw)->AceSize)) return false;
  }
  // Appending preserves the order and bytes of every prior deny/allow ACE.
  if (worker_aces == 0U &&
      !AddAccessAllowedAceEx(result, original->AclRevision, 0U, mask, WorkerSid())) return false;
  if (!IsValidAcl(result)) return false;
  *output = candidate;
  return true;
}

bool SameAcl(PACL expected, PACL actual) noexcept {
  if (!expected || !actual || expected->AclRevision != actual->AclRevision ||
      expected->AceCount != actual->AceCount) return false;
  for (DWORD index = 0U; index < expected->AceCount; ++index) {
    void* left = nullptr;
    void* right = nullptr;
    if (!GetAce(expected, index, &left) || !GetAce(actual, index, &right) || !left || !right) return false;
    const WORD length = static_cast<ACE_HEADER*>(left)->AceSize;
    if (static_cast<ACE_HEADER*>(right)->AceSize != length || std::memcmp(left, right, length)) return false;
  }
  return true;
}

bool PrepareGrant(HANDLE handle, PSID owner, WorkerInspectionObject object,
    PreparedGrant* output) noexcept {
  return output && ReadKernelSecurity(handle, &output->before) &&
      ComposeAcl(output->before.owner, output->before.dacl, owner, object, &output->acl);
}

bool ApplyGrant(HANDLE handle, PreparedGrant* grant) noexcept {
  auto desired = reinterpret_cast<PACL>(grant->acl.bytes.data());
  KernelSecurity current;
  if (!ReadKernelSecurity(handle, &current) || !EqualSid(current.owner, grant->before.owner) ||
      current.protected_dacl != grant->before.protected_dacl ||
      !SameAcl(current.dacl, grant->before.dacl)) return false;
  if (SameAcl(desired, grant->before.dacl)) return true;
  SECURITY_DESCRIPTOR descriptor{};
  if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, desired, FALSE)) return false;
  const SECURITY_INFORMATION protection = grant->before.protected_dacl
      ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION;
  if (!SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION | protection, &descriptor)) return false;
  KernelSecurity after;
  return ReadKernelSecurity(handle, &after) && EqualSid(after.owner, grant->before.owner) &&
      after.protected_dacl == grant->before.protected_dacl && SameAcl(desired, after.dacl);
}
}  // namespace

bool ComposeWorkerInspectionAcl(PSID owner, PACL original,
    WorkerInspectionObject object, WorkerInspectionAcl* output) noexcept {
  return ComposeAcl(owner, original, SystemSid(), object, output);
}

bool GrantCurrentSystemWorkerInspectionAccess() noexcept {
  Handle ambient;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, FALSE, &ambient.value) ||
      GetLastError() != ERROR_NO_TOKEN) return false;
  Handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | READ_CONTROL | WRITE_DAC, &token.value)) return false;
  alignas(16) std::array<BYTE, 128U> bytes{};
  DWORD returned = 0U, session = UINT32_MAX, appcontainer = 1U;
  TOKEN_TYPE type = TokenImpersonation;
  if (!GetTokenInformation(token.value, TokenUser, bytes.data(), static_cast<DWORD>(bytes.size()), &returned) ||
      returned < sizeof(TOKEN_USER) || returned > bytes.size()) return false;
  const auto user = reinterpret_cast<TOKEN_USER*>(bytes.data());
  const auto first = reinterpret_cast<std::uintptr_t>(bytes.data());
  const auto sid = reinterpret_cast<std::uintptr_t>(user->User.Sid);
  if (sid < first || sid - first > returned ||
      !SidFits(reinterpret_cast<const BYTE*>(user->User.Sid), returned - (sid - first)) ||
      !EqualSid(user->User.Sid, SystemSid()) ||
      !GetTokenInformation(token.value, TokenType, &type, sizeof(type), &returned) ||
      returned != sizeof(type) || type != TokenPrimary ||
      !GetTokenInformation(token.value, TokenSessionId, &session, sizeof(session), &returned) ||
      returned != sizeof(session) || session != 0U || IsTokenRestricted(token.value) ||
      !GetTokenInformation(token.value, TokenIsAppContainer, &appcontainer, sizeof(appcontainer), &returned) ||
      returned != sizeof(appcontainer) || appcontainer != 0U) return false;
  PreparedGrant process_grant, token_grant;
  // Validate both original descriptors before either DACL is changed.
  return PrepareGrant(GetCurrentProcess(), SystemSid(), WorkerInspectionObject::Process, &process_grant) &&
      PrepareGrant(token.value, SystemSid(), WorkerInspectionObject::Token, &token_grant) &&
      ApplyGrant(token.value, &token_grant) && ApplyGrant(GetCurrentProcess(), &process_grant);
}

#if defined(GOATCITADEL_PROVISIONER_TESTING) || defined(GOATCITADEL_SERVICE_INSPECTION_TESTING)
bool ApplyWorkerTokenInspectionForTest(HANDLE token, PSID expected_owner) noexcept {
  TOKEN_TYPE type = TokenImpersonation;
  DWORD returned = 0U;
  if (!GetTokenInformation(token, TokenType, &type, sizeof(type), &returned) || type != TokenPrimary) return false;
  PreparedGrant grant;
  return PrepareGrant(token, expected_owner, WorkerInspectionObject::Token, &grant) && ApplyGrant(token, &grant);
}
bool ApplyWorkerProcessInspectionForTest(PSID expected_owner) noexcept {
  PreparedGrant grant;
  return PrepareGrant(GetCurrentProcess(), expected_owner, WorkerInspectionObject::Process, &grant) &&
      ApplyGrant(GetCurrentProcess(), &grant);
}
#endif
}  // namespace goatcitadel::worker_host
