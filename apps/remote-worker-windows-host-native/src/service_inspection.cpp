#include "service_inspection.hpp"
#include <cstring>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_host {
namespace {
alignas(DWORD) constexpr std::array<BYTE, 12U> kSystemSid = {
    1U, 1U, 0U, 0U, 0U, 0U, 0U, 5U, 18U, 0U, 0U, 0U};
alignas(DWORD) constexpr std::array<BYTE, 16U> kAdministratorsSid = {
    1U, 2U, 0U, 0U, 0U, 0U, 0U, 5U, 32U, 0U, 0U, 0U, 32U, 2U, 0U, 0U};
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
alignas(DWORD) constexpr auto kProvisionerSid = MakeServiceSid({80U, UINT32_C(1765223994), UINT32_C(2719708455), UINT32_C(3112291649), UINT32_C(2938929260), UINT32_C(976374647)});
alignas(DWORD) constexpr auto kControllerSid = MakeServiceSid({80U, UINT32_C(1810587747), UINT32_C(2867442932), UINT32_C(4204439414), UINT32_C(1143594691), UINT32_C(3479143721)});
alignas(DWORD) constexpr auto kBrokerSid = MakeServiceSid({80U, UINT32_C(938203738), UINT32_C(3606080319), UINT32_C(1885328063), UINT32_C(149464327), UINT32_C(2394007130)});
PSID SystemSid() noexcept { return const_cast<BYTE*>(kSystemSid.data()); }
PSID WorkerSid() noexcept { return const_cast<BYTE*>(kWorkerSid.data()); }
PSID ServiceSid(WorkerInspectionService service) noexcept {
  switch (service) {
    case WorkerInspectionService::Provisioner: return const_cast<BYTE*>(kProvisionerSid.data());
    case WorkerInspectionService::CellController: return const_cast<BYTE*>(kControllerSid.data());
    default: return nullptr;
  }
}

bool MatchesServiceGroup(WorkerInspectionService service, PSID sid, DWORD attributes) noexcept {
  PSID expected = ServiceSid(service);
  return expected && sid && IsValidSid(sid) && EqualSid(sid, expected) &&
      (attributes & (SE_GROUP_ENABLED | SE_GROUP_OWNER)) == (SE_GROUP_ENABLED | SE_GROUP_OWNER) &&
      (attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0U;
}

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
struct InspectionOwnerIdentity final {
  // S-1-5-5-X-Y has exactly three subauthorities, hence twenty bytes.
  alignas(DWORD) std::array<BYTE, 20U> logon_sid{};
  DWORD logon_attributes = 0U;
  bool has_logon = false;
};

bool Refuse(WorkerInspectionDiagnostic* diagnostic, WorkerInspectionStage stage,
    WorkerInspectionFailure failure, DWORD error = ERROR_SUCCESS) noexcept {
  if (diagnostic) *diagnostic = {stage, failure, error};
  return false;
}

bool SidFits(const BYTE* bytes, std::size_t length) noexcept {
  if (!bytes || length < 8U || bytes[1] > SID_MAX_SUB_AUTHORITIES) return false;
  const std::size_t required = 8U + 4U * bytes[1];
  return required <= length && IsValidSid(const_cast<BYTE*>(bytes)) != FALSE;
}

bool IsLogonSid(PSID sid) noexcept {
  if (!sid || !IsValidSid(sid)) return false;
  const auto bytes = static_cast<const BYTE*>(sid);
  DWORD first = 0U;
  if (bytes[1] != 3U || std::memcmp(bytes + 2U, kSystemSid.data() + 2U, 6U)) return false;
  std::memcpy(&first, bytes + 8U, sizeof(first));
  return first == SECURITY_LOGON_IDS_RID;
}

bool CollectInspectionOwnerGroups(WorkerInspectionService service,
    const BYTE* bytes, std::size_t length, InspectionOwnerIdentity* output) noexcept {
  PSID expected = ServiceSid(service);
  if (!expected || !bytes || !output || length < offsetof(TOKEN_GROUPS, Groups) || length > 8192U ||
      reinterpret_cast<std::uintptr_t>(bytes) % alignof(TOKEN_GROUPS) != 0U) return false;
  const auto groups = reinterpret_cast<const TOKEN_GROUPS*>(bytes);
  if (groups->GroupCount > (length - offsetof(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) return false;
  const auto first = reinterpret_cast<std::uintptr_t>(bytes);
  const std::size_t records_end = offsetof(TOKEN_GROUPS, Groups) + groups->GroupCount * sizeof(SID_AND_ATTRIBUTES);
  InspectionOwnerIdentity candidate;
  unsigned matches = 0U, logons = 0U;
  for (DWORD index = 0U; index < groups->GroupCount; ++index) {
    const auto& group = groups->Groups[index];
    const auto sid = reinterpret_cast<std::uintptr_t>(group.Sid);
    if (sid < first || sid - first < records_end || sid - first > length || sid % alignof(DWORD) != 0U ||
        !SidFits(static_cast<const BYTE*>(group.Sid), length - (sid - first))) return false;
    if (EqualSid(group.Sid, expected) &&
        (++matches != 1U || !MatchesServiceGroup(service, group.Sid, group.Attributes))) return false;
    const bool logon_form = IsLogonSid(group.Sid);
    if (logon_form || (group.Attributes & SE_GROUP_LOGON_ID) != 0U) {
      if (++logons != 1U || !logon_form || (group.Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) return false;
      std::memcpy(candidate.logon_sid.data(), group.Sid, candidate.logon_sid.size());
      candidate.logon_attributes = group.Attributes;
      candidate.has_logon = true;
    }
  }
  if (matches != 1U) return false;
  *output = candidate;
  return true;
}

bool HasInspectionServiceSid(HANDLE token, WorkerInspectionService service,
    InspectionOwnerIdentity* output) noexcept {
  alignas(16) std::array<BYTE, 8192U> bytes{};
  DWORD returned = 0U;
  return GetTokenInformation(token, TokenGroups, bytes.data(), static_cast<DWORD>(bytes.size()), &returned) &&
      returned <= bytes.size() && CollectInspectionOwnerGroups(service, bytes.data(), returned, output);
}

bool ReadKernelSecurity(HANDLE handle, KernelSecurity* output,
    WorkerInspectionDiagnostic* diagnostic, WorkerInspectionStage stage) noexcept {
  // GetCurrentProcess() is the valid -1 kernel pseudo-handle.
  if (!handle || !output) return Refuse(diagnostic, stage, WorkerInspectionFailure::InvalidInput);
  DWORD returned = 0U;
  if (!GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          output->bytes.data(), static_cast<DWORD>(output->bytes.size()), &returned)) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  if (returned < sizeof(SECURITY_DESCRIPTOR_RELATIVE) || returned > output->bytes.size()) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::MalformedDescriptor);
  }
  const auto relative = reinterpret_cast<const SECURITY_DESCRIPTOR_RELATIVE*>(output->bytes.data());
  if ((relative->Control & SE_SELF_RELATIVE) == 0U ||
      relative->Owner < sizeof(SECURITY_DESCRIPTOR_RELATIVE) || relative->Owner > returned ||
      !SidFits(output->bytes.data() + relative->Owner, returned - relative->Owner) ||
      relative->Dacl < sizeof(SECURITY_DESCRIPTOR_RELATIVE) || relative->Dacl > returned ||
      returned - relative->Dacl < sizeof(ACL)) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::MalformedDescriptor);
  }
  const auto acl = reinterpret_cast<const ACL*>(output->bytes.data() + relative->Dacl);
  if (acl->AclSize < sizeof(ACL) || acl->AclSize > returned - relative->Dacl ||
      acl->AclSize > kWorkerInspectionAclBytes || !IsValidAcl(const_cast<PACL>(acl))) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::MalformedDescriptor);
  }
  BOOL present = FALSE, defaulted = FALSE;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
  if (!GetSecurityDescriptorOwner(output->bytes.data(), &output->owner, &defaulted) ||
      output->owner != output->bytes.data() + relative->Owner ||
      !GetSecurityDescriptorDacl(output->bytes.data(), &present, &output->dacl, &defaulted) ||
      !present || output->dacl != acl ||
      !GetSecurityDescriptorControl(output->bytes.data(), &control, &revision) ||
      revision != SECURITY_DESCRIPTOR_REVISION) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::MalformedDescriptor);
  }
  output->protected_dacl = (control & SE_DACL_PROTECTED) != 0U;
  return true;
}

bool ComposeAcl(PSID owner, PACL original, PSID expected_owner,
    WorkerInspectionObject object, WorkerInspectionAcl* output,
    WorkerInspectionDiagnostic* diagnostic, WorkerInspectionStage stage,
    bool grant_broker = false) noexcept {
  const DWORD mask = object == WorkerInspectionObject::Process
      ? PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
      : object == WorkerInspectionObject::Token ? TOKEN_QUERY : 0U;
  if (!output || !owner || !expected_owner || !mask || !original ||
      !IsValidSid(owner) || !IsValidSid(expected_owner)) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::InvalidInput);
  }
  if (!EqualSid(owner, expected_owner)) {
    // Classify this well-known SID without accepting it or emitting SID data.
    return Refuse(diagnostic, stage, EqualSid(owner, const_cast<BYTE*>(kAdministratorsSid.data()))
        ? WorkerInspectionFailure::AdministratorsOwner : WorkerInspectionFailure::UnexpectedOwner);
  }
  if (original->AclSize < sizeof(ACL) || original->AclSize > kWorkerInspectionAclBytes ||
      original->AceCount > 64U ||
      (original->AclRevision != ACL_REVISION && original->AclRevision != ACL_REVISION_DS) ||
      !IsValidAcl(original)) return Refuse(diagnostic, stage, WorkerInspectionFailure::UnsupportedAcl);
  std::size_t bytes = sizeof(ACL);
  unsigned worker_aces = 0U;
  unsigned broker_aces = 0U;
  for (DWORD index = 0U; index < original->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(original, index, &raw)) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::WindowsApi, GetLastError());
    }
    if (!raw) return Refuse(diagnostic, stage, WorkerInspectionFailure::AclBounds);
    const auto first = reinterpret_cast<std::uintptr_t>(original);
    const auto address = reinterpret_cast<std::uintptr_t>(raw);
    if (address < first || address - first > original->AclSize ||
        original->AclSize - (address - first) < sizeof(ACCESS_ALLOWED_ACE)) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::AclBounds);
    }
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    const std::size_t ace_length = ace->Header.AceSize;
    constexpr std::size_t sid_offset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
    if (ace_length > original->AclSize - (address - first) || ace_length < sid_offset + 8U ||
        !SidFits(reinterpret_cast<const BYTE*>(&ace->SidStart), ace_length - sid_offset)) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::AclBounds);
    }
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceType != ACCESS_DENIED_ACE_TYPE) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::UnsupportedAce);
    }
    if ((ace->Header.AceFlags & ~INHERITED_ACE) != 0U) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::UnsupportedAceFlags);
    }
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    if (ace_length != sid_offset + GetLengthSid(sid)) return Refuse(diagnostic, stage, WorkerInspectionFailure::AclBounds);
    if (EqualSid(sid, WorkerSid())) {
      if (++worker_aces != 1U || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
          ace->Header.AceFlags != 0U || ace->Mask != mask) {
        return Refuse(diagnostic, stage, WorkerInspectionFailure::WorkerGrant);
      }
    }
    if (grant_broker && EqualSid(sid, const_cast<BYTE*>(kBrokerSid.data()))) {
      if (++broker_aces != 1U || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
          ace->Header.AceFlags != 0U || ace->Mask != mask) {
        return Refuse(diagnostic, stage, WorkerInspectionFailure::UnsupportedAcl);
      }
    }
    bytes += ace_length;
  }
  if (worker_aces == 0U) bytes += offsetof(ACCESS_ALLOWED_ACE, SidStart) + kWorkerSid.size();
  if (grant_broker && broker_aces == 0U) bytes += offsetof(ACCESS_ALLOWED_ACE, SidStart) + kBrokerSid.size();
  if (bytes > kWorkerInspectionAclBytes) return Refuse(diagnostic, stage, WorkerInspectionFailure::AclBounds);
  WorkerInspectionAcl candidate;
  auto result = reinterpret_cast<PACL>(candidate.bytes.data());
  if (!InitializeAcl(result, static_cast<DWORD>(bytes), original->AclRevision)) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  for (DWORD index = 0U; index < original->AceCount; ++index) {
    void* raw = nullptr;
    if (!GetAce(original, index, &raw) || !raw ||
        !AddAce(result, original->AclRevision, MAXDWORD, raw, static_cast<ACE_HEADER*>(raw)->AceSize)) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::WindowsApi, GetLastError());
    }
  }
  // Appending preserves the order and bytes of every prior deny/allow ACE.
  if (worker_aces == 0U &&
      !AddAccessAllowedAceEx(result, original->AclRevision, 0U, mask, WorkerSid())) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  // Separate service logon SIDs do not inherit each other's process rights.
  // Only the provisioner publishes this fixed read-only grant to its broker.
  if (grant_broker && broker_aces == 0U &&
      !AddAccessAllowedAceEx(result, original->AclRevision, 0U, mask, const_cast<BYTE*>(kBrokerSid.data()))) {
    return Refuse(diagnostic, stage, WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  if (!IsValidAcl(result)) return Refuse(diagnostic, stage, WorkerInspectionFailure::UnsupportedAcl);
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

bool ComposeForInspectionIdentity(PSID service_sid, const InspectionOwnerIdentity* identity,
    PSID owner, PACL original, WorkerInspectionObject object, WorkerInspectionAcl* output,
    WorkerInspectionDiagnostic* diagnostic, WorkerInspectionStage stage) noexcept {
  if (!service_sid) return Refuse(diagnostic, stage, WorkerInspectionFailure::InvalidInput);
  PSID expected = service_sid;
  if (owner && IsValidSid(owner) && EqualSid(owner, SystemSid())) expected = SystemSid();
  else if (IsLogonSid(owner)) {
    if (!identity || !identity->has_logon ||
        !EqualSid(owner, const_cast<BYTE*>(identity->logon_sid.data()))) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::LogonOwnerMismatch);
    }
    constexpr DWORD required = SE_GROUP_LOGON_ID | SE_GROUP_ENABLED | SE_GROUP_OWNER;
    constexpr DWORD allowed = required | SE_GROUP_MANDATORY | SE_GROUP_ENABLED_BY_DEFAULT;
    if ((identity->logon_attributes & required) != required ||
        (identity->logon_attributes & ~allowed) != 0U) {
      return Refuse(diagnostic, stage, WorkerInspectionFailure::LogonOwnerAttributes);
    }
    expected = const_cast<BYTE*>(identity->logon_sid.data());
  }
  return ComposeAcl(owner, original, expected, object, output, diagnostic, stage,
      EqualSid(service_sid, const_cast<BYTE*>(kProvisionerSid.data())) != FALSE);
}

bool PrepareGrant(HANDLE handle, PSID owner, WorkerInspectionObject object,
    PreparedGrant* output, WorkerInspectionDiagnostic* diagnostic,
    const InspectionOwnerIdentity* identity = nullptr) noexcept {
  const bool process = object == WorkerInspectionObject::Process;
  const auto read = process ? WorkerInspectionStage::ProcessRead : WorkerInspectionStage::TokenRead;
  const auto compose = process ? WorkerInspectionStage::ProcessCompose : WorkerInspectionStage::TokenCompose;
  if (!output || !ReadKernelSecurity(handle, &output->before, diagnostic, read)) return false;
  if (identity) return ComposeForInspectionIdentity(owner, identity, output->before.owner,
      output->before.dacl, object, &output->acl, diagnostic, compose);
  return ComposeAcl(output->before.owner, output->before.dacl, owner, object, &output->acl, diagnostic, compose);
}

bool ApplyGrant(HANDLE handle, PreparedGrant* grant, WorkerInspectionObject object,
    WorkerInspectionDiagnostic* diagnostic) noexcept {
  const auto first = object == WorkerInspectionObject::Process
      ? WorkerInspectionStage::ProcessBeforeRead : WorkerInspectionStage::TokenBeforeRead;
  const auto stage = [first](unsigned offset) noexcept {
    return static_cast<WorkerInspectionStage>(static_cast<unsigned>(first) + offset);
  };
  auto desired = reinterpret_cast<PACL>(grant->acl.bytes.data());
  KernelSecurity current;
  if (!ReadKernelSecurity(handle, &current, diagnostic, stage(0U))) return false;
  if (!EqualSid(current.owner, grant->before.owner) ||
      current.protected_dacl != grant->before.protected_dacl ||
      !SameAcl(current.dacl, grant->before.dacl)) {
    return Refuse(diagnostic, stage(1U), WorkerInspectionFailure::DescriptorChanged);
  }
  if (SameAcl(desired, grant->before.dacl)) return true;
  SECURITY_DESCRIPTOR descriptor{};
  if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, desired, FALSE)) {
    return Refuse(diagnostic, stage(2U), WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  const SECURITY_INFORMATION protection = grant->before.protected_dacl
      ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION;
  if (!SetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION | protection, &descriptor)) {
    return Refuse(diagnostic, stage(3U), WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  KernelSecurity after;
  if (!ReadKernelSecurity(handle, &after, diagnostic, stage(4U))) return false;
  if (!EqualSid(after.owner, grant->before.owner) ||
      after.protected_dacl != grant->before.protected_dacl || !SameAcl(desired, after.dacl)) {
    return Refuse(diagnostic, stage(5U), WorkerInspectionFailure::DescriptorChanged);
  }
  return true;
}
}  // namespace

bool ComposeWorkerInspectionAcl(WorkerInspectionService service, PSID owner, PACL original,
    WorkerInspectionObject object, WorkerInspectionAcl* output,
    WorkerInspectionDiagnostic* diagnostic) noexcept {
  if (diagnostic) *diagnostic = {};
  const auto stage = object == WorkerInspectionObject::Process
      ? WorkerInspectionStage::ProcessCompose : WorkerInspectionStage::TokenCompose;
  return ComposeForInspectionIdentity(ServiceSid(service), nullptr, owner, original, object, output, diagnostic, stage);
}

bool GrantCurrentSystemWorkerInspectionAccess(WorkerInspectionService service,
    WorkerInspectionDiagnostic* diagnostic) noexcept {
  if (diagnostic) *diagnostic = {};
  PSID service_sid = ServiceSid(service);
  if (!service_sid) return Refuse(diagnostic, WorkerInspectionStage::SignerServiceSid, WorkerInspectionFailure::InvalidInput);
  Handle ambient;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, FALSE, &ambient.value) ||
      GetLastError() != ERROR_NO_TOKEN) {
    return Refuse(diagnostic, WorkerInspectionStage::AmbientToken, WorkerInspectionFailure::Identity);
  }
  Handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | READ_CONTROL | WRITE_DAC, &token.value)) {
    return Refuse(diagnostic, WorkerInspectionStage::TokenOpen, WorkerInspectionFailure::WindowsApi, GetLastError());
  }
  alignas(16) std::array<BYTE, 128U> bytes{};
  DWORD returned = 0U, session = UINT32_MAX, appcontainer = 1U;
  TOKEN_TYPE type = TokenImpersonation;
  if (!GetTokenInformation(token.value, TokenUser, bytes.data(), static_cast<DWORD>(bytes.size()), &returned) ||
      returned < sizeof(TOKEN_USER) || returned > bytes.size()) {
    return Refuse(diagnostic, WorkerInspectionStage::TokenIdentity, WorkerInspectionFailure::Identity);
  }
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
      returned != sizeof(appcontainer) || appcontainer != 0U) {
    return Refuse(diagnostic, WorkerInspectionStage::TokenIdentity, WorkerInspectionFailure::Identity);
  }
  // Bind any logon owner to this same validated primary token. Do not accept
  // a caller, broker, previous logon, or arbitrary S-1-5-5-X-Y identity.
  InspectionOwnerIdentity owner_identity;
  if (!HasInspectionServiceSid(token.value, service, &owner_identity)) {
    return Refuse(diagnostic, WorkerInspectionStage::SignerServiceSid, WorkerInspectionFailure::Identity);
  }
  PreparedGrant process_grant, token_grant;
  // Validate both original descriptors before either DACL is changed.
  // Each owner must be SYSTEM, this service SID, or its own eligible logon SID.
  return PrepareGrant(GetCurrentProcess(), service_sid, WorkerInspectionObject::Process, &process_grant, diagnostic, &owner_identity) &&
      PrepareGrant(token.value, service_sid, WorkerInspectionObject::Token, &token_grant, diagnostic, &owner_identity) &&
      ApplyGrant(token.value, &token_grant, WorkerInspectionObject::Token, diagnostic) &&
      ApplyGrant(GetCurrentProcess(), &process_grant, WorkerInspectionObject::Process, diagnostic);
}

#if defined(GOATCITADEL_PROVISIONER_TESTING) || defined(GOATCITADEL_SERVICE_INSPECTION_TESTING)
bool MatchesInspectionServiceGroupForTest(WorkerInspectionService service, PSID sid, DWORD attributes) noexcept {
  return MatchesServiceGroup(service, sid, attributes);
}
bool ComposeWorkerInspectionAclWithGroupsForTest(WorkerInspectionService service,
    const BYTE* groups, std::size_t length, PSID owner, PACL original,
    WorkerInspectionObject object, WorkerInspectionAcl* output,
    WorkerInspectionDiagnostic* diagnostic) noexcept {
  if (diagnostic) *diagnostic = {};
  InspectionOwnerIdentity identity;
  if (!CollectInspectionOwnerGroups(service, groups, length, &identity)) {
    return Refuse(diagnostic, WorkerInspectionStage::SignerServiceSid, WorkerInspectionFailure::Identity);
  }
  const auto stage = object == WorkerInspectionObject::Process
      ? WorkerInspectionStage::ProcessCompose : WorkerInspectionStage::TokenCompose;
  return ComposeForInspectionIdentity(ServiceSid(service), &identity, owner, original, object, output, diagnostic, stage);
}
bool ApplyWorkerTokenInspectionForTest(HANDLE token, PSID expected_owner,
    WorkerInspectionDiagnostic* diagnostic) noexcept {
  if (diagnostic) *diagnostic = {};
  TOKEN_TYPE type = TokenImpersonation;
  DWORD returned = 0U;
  if (!GetTokenInformation(token, TokenType, &type, sizeof(type), &returned) || type != TokenPrimary) {
    return Refuse(diagnostic, WorkerInspectionStage::TokenIdentity, WorkerInspectionFailure::Identity);
  }
  PreparedGrant grant;
  return PrepareGrant(token, expected_owner, WorkerInspectionObject::Token, &grant, diagnostic) &&
      ApplyGrant(token, &grant, WorkerInspectionObject::Token, diagnostic);
}
bool ApplyWorkerProcessInspectionForTest(PSID expected_owner, WorkerInspectionDiagnostic* diagnostic) noexcept {
  if (diagnostic) *diagnostic = {};
  PreparedGrant grant;
  return PrepareGrant(GetCurrentProcess(), expected_owner, WorkerInspectionObject::Process, &grant, diagnostic) &&
      ApplyGrant(GetCurrentProcess(), &grant, WorkerInspectionObject::Process, diagnostic);
}
#endif
}  // namespace goatcitadel::worker_host
