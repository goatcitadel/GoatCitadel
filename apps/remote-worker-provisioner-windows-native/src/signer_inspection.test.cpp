#include "signer_inspection.hpp"

#include <sddl.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <initializer_list>

namespace gc = goatcitadel::remote_worker_provisioner;
namespace inspection = goatcitadel::worker_host;
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
constexpr wchar_t kSigner[] = L"S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647";
constexpr wchar_t kController[] = L"S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721";
constexpr wchar_t kBroker[] = L"S-1-5-80-938203738-3606080319-1885328063-149464327-2394007130";

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
    Check(result->AceCount == dacl->AceCount + 2U, "only worker and broker query ACEs are added");
    for (DWORD index = 0U; index < dacl->AceCount; ++index) {
      void* before = nullptr;
      void* after = nullptr;
      Check(GetAce(dacl, index, &before) && GetAce(result, index, &after) &&
          std::memcmp(before, after, static_cast<ACE_HEADER*>(before)->AceSize) == 0,
          "existing allows and denies remain byte-identical and ordered");
    }
    void* raw = nullptr;
    Check(GetAce(result, dacl->AceCount, &raw) != FALSE, "worker ACE follows every original ACE");
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
  Local signer, controller;
  Check(ConvertStringSidToSidW(kSigner, &signer.value) && ConvertStringSidToSidW(kController, &controller.value),
      "service owner SIDs parse for Windows access checks");
  if (!system.value || !everyone.value || !signer.value || !controller.value) return;
  using Service = inspection::WorkerInspectionService;
  for (const auto service : {Service::Provisioner, Service::CellController}) {
    for (const auto object_owner : {system.value, service == Service::Provisioner ? signer.value : controller.value}) {
      for (const auto kind : {gc::SignerInspectionObject::Process, gc::SignerInspectionObject::Token}) {
        alignas(16) std::array<BYTE, 512U> input{};
        auto acl = reinterpret_cast<PACL>(input.data());
        Check(InitializeAcl(acl, static_cast<DWORD>(input.size()), ACL_REVISION) &&
            AddAccessAllowedAceEx(acl, ACL_REVISION, 0U, 0x001fffffU, user->User.Sid), "base test ACL builds");
        gc::SignerInspectionAcl output;
        Check(inspection::ComposeWorkerInspectionAcl(service, object_owner, acl, kind, &output), "Windows access fixture composes");
        SECURITY_DESCRIPTOR descriptor{};
        Check(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
            SetSecurityDescriptorOwner(&descriptor, object_owner, FALSE) &&
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
        Check(inspection::ComposeWorkerInspectionAcl(service, object_owner, acl, kind, &output), "existing deny remains composable");
        Check(!Allowed(&descriptor, impersonation.value, expected), "Windows still enforces a prior deny after the worker grant");
      }
    }
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

void TestFailureDiagnostics() noexcept {
  using Stage = inspection::WorkerInspectionStage;
  using Failure = inspection::WorkerInspectionFailure;
  constexpr auto service = inspection::WorkerInspectionService::Provisioner;
  inspection::WorkerInspectionDiagnostic diagnostic;
  Check(inspection::WorkerInspectionServiceExitCode(diagnostic) == 2060U,
      "absent diagnostic retains the legacy refusal code");
  diagnostic = {Stage::TokenRead, Failure::WindowsApi, ERROR_ACCESS_DENIED};
  Check(inspection::WorkerInspectionServiceExitCode(diagnostic) == UINT32_C(0x47010005),
      "SCM code preserves the failing stage and Windows access-denied error");
  diagnostic.win32_error = UINT32_C(0x80070005);
  Check((inspection::WorkerInspectionServiceExitCode(diagnostic) & UINT32_C(0xffff)) == UINT32_C(0xffff),
      "oversized error is explicitly unavailable rather than truncated");
  diagnostic.stage = static_cast<Stage>(255U);
  Check(inspection::WorkerInspectionServiceExitCode(diagnostic) == 2060U, "invalid stage cannot forge encoded fields");

  Local descriptor;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"O:BAG:SYD:P(A;;0x001fffff;;;SY)", SDDL_REVISION_1, &descriptor.value, nullptr) != FALSE,
      "administrators-owned descriptor fixture parses");
  if (!descriptor.value) return;
  PSID owner = nullptr;
  PACL acl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  Check(GetSecurityDescriptorOwner(descriptor.value, &owner, &defaulted) &&
      GetSecurityDescriptorDacl(descriptor.value, &present, &acl, &defaulted) && present,
      "diagnostic descriptor fixture reads");
  if (!owner || !acl) return;
  inspection::WorkerInspectionAcl output;
  output.bytes.fill(0xa5U);
  const auto unchanged = output;
  Check(!inspection::ComposeWorkerInspectionAcl(service, owner, acl, inspection::WorkerInspectionObject::Process, &output, &diagnostic) &&
      diagnostic.stage == Stage::ProcessCompose && diagnostic.failure == Failure::AdministratorsOwner &&
      diagnostic.win32_error == ERROR_SUCCESS &&
      inspection::WorkerInspectionServiceExitCode(diagnostic) == UINT32_C(0x46050000),
      "known unexpected owner is identified but still refused");
  Check(output.bytes == unchanged.bytes, "refused composition never publishes an ACL");
  Local system;
  Check(ConvertStringSidToSidW(L"S-1-5-18", &system.value) != FALSE, "diagnostic SYSTEM SID parses");
  if (!system.value) return;
  void* raw = nullptr;
  Check(GetAce(acl, 0U, &raw) != FALSE && raw, "diagnostic ACE fixture reads");
  if (!raw) return;
  auto header = static_cast<ACE_HEADER*>(raw);
  header->AceFlags = CONTAINER_INHERIT_ACE;
  Check(!inspection::ComposeWorkerInspectionAcl(service, system.value, acl, inspection::WorkerInspectionObject::Token, &output, &diagnostic) &&
      diagnostic.stage == Stage::TokenCompose && diagnostic.failure == Failure::UnsupportedAceFlags,
      "unsupported flags are separately identified and still refused");
  header->AceFlags = 0U;
  Check(inspection::ComposeWorkerInspectionAcl(service, system.value, acl, inspection::WorkerInspectionObject::Token, &output, &diagnostic) &&
      diagnostic.stage == Stage::None && diagnostic.failure == Failure::None && diagnostic.win32_error == ERROR_SUCCESS,
      "successful composition clears a prior refusal");

  Handle primary;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &primary.value) != FALSE,
      "diagnostic test token opens");
  if (!primary.value) return;
  alignas(16) std::array<BYTE, 512U> user_bytes{};
  DWORD returned = 0U;
  if (!GetTokenInformation(primary.value, TokenUser, user_bytes.data(), static_cast<DWORD>(user_bytes.size()), &returned)) {
    Check(false, "diagnostic test owner reads");
    return;
  }
  const auto user = reinterpret_cast<const TOKEN_USER*>(user_bytes.data());
  for (const DWORD access : {DWORD(TOKEN_QUERY), DWORD(TOKEN_QUERY | READ_CONTROL)}) {
    Handle duplicate;
    Check(DuplicateTokenEx(primary.value, access, nullptr, SecurityImpersonation, TokenPrimary, &duplicate.value) != FALSE,
        "unassigned token with deliberately limited handle rights creates");
    if (!duplicate.value) continue;
    alignas(16) std::array<BYTE, 8192U> before{}, after{};
    DWORD before_length = 0U, after_length = 0U;
    if (access & READ_CONTROL) {
      const bool read = GetKernelObjectSecurity(duplicate.value, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          before.data(), static_cast<DWORD>(before.size()), &before_length) != FALSE && before_length <= before.size();
      Check(read, "unassigned token descriptor reads before the deliberate write refusal");
      if (!read) continue;
    }
    SetLastError(ERROR_INVALID_DATA);
    Check(!inspection::ApplyWorkerTokenInspectionForTest(duplicate.value, user->User.Sid, &diagnostic) &&
        diagnostic.stage == ((access & READ_CONTROL) ? Stage::TokenWrite : Stage::TokenRead) &&
        diagnostic.failure == Failure::WindowsApi && diagnostic.win32_error == ERROR_ACCESS_DENIED,
        "real Windows handle denial identifies read versus write and captures its error immediately");
    if (access & READ_CONTROL) {
      Check(GetKernelObjectSecurity(duplicate.value, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          after.data(), static_cast<DWORD>(after.size()), &after_length) && before_length == after_length &&
          std::memcmp(before.data(), after.data(), before_length) == 0,
          "denied write leaves the unassigned token descriptor unchanged");
    }
  }
  Check(!gc::GrantCurrentSignerInspectionAccess(&diagnostic) && diagnostic.stage != Stage::None &&
      diagnostic.failure != Failure::None, "production interactive refusal carries a diagnostic");
}

void TestServiceOwnerPolicy() noexcept {
  using Service = inspection::WorkerInspectionService;
  using Object = inspection::WorkerInspectionObject;
  Local system, signer, controller, worker, administrators, other;
  Check(ConvertStringSidToSidW(L"S-1-5-18", &system.value) &&
      ConvertStringSidToSidW(kSigner, &signer.value) && ConvertStringSidToSidW(kController, &controller.value) &&
      ConvertStringSidToSidW(kWorker, &worker.value) && ConvertStringSidToSidW(L"S-1-5-32-544", &administrators.value) &&
      ConvertStringSidToSidW(L"S-1-5-21-1-2-3-1001", &other.value), "service owner policy fixture SIDs parse");
  if (!system.value || !signer.value || !controller.value || !worker.value || !administrators.value || !other.value) return;
  alignas(16) std::array<BYTE, 512U> bytes{};
  auto acl = reinterpret_cast<PACL>(bytes.data());
  Check(InitializeAcl(acl, static_cast<DWORD>(bytes.size()), ACL_REVISION) &&
      AddAccessDeniedAceEx(acl, ACL_REVISION, 0U, WRITE_DAC, other.value) &&
      AddAccessAllowedAceEx(acl, ACL_REVISION, 0U, 0x001fffffU, system.value), "service owner policy ACL builds");
  const auto before = bytes;
  for (const auto service : {Service::Provisioner, Service::CellController}) {
    PSID service_sid = service == Service::Provisioner ? signer.value : controller.value;
    PSID other_service = service == Service::Provisioner ? controller.value : signer.value;
    for (const auto kind : {Object::Process, Object::Token}) {
      inspection::WorkerInspectionAcl system_owned, service_owned;
      Check(inspection::ComposeWorkerInspectionAcl(service, system.value, acl, kind, &system_owned) &&
          inspection::ComposeWorkerInspectionAcl(service, service_sid, acl, kind, &service_owned),
          "SYSTEM and only the exact selected service may own each kernel object");
      Check(system_owned.bytes == service_owned.bytes && bytes == before,
          "service ownership preserves exactly the SYSTEM-case ACL and never changes its input");
      for (const auto forbidden : {other_service, worker.value, administrators.value, other.value}) {
        inspection::WorkerInspectionAcl output;
        output.bytes.fill(0xa5U);
        const auto unchanged = output;
        Check(!inspection::ComposeWorkerInspectionAcl(service, forbidden, acl, kind, &output) && output.bytes == unchanged.bytes,
            "another service, worker, Administrators or arbitrary owner is refused without publishing a grant");
      }
      inspection::WorkerInspectionAcl output;
      Check(!inspection::ComposeWorkerInspectionAcl(static_cast<Service>(0U), system.value, acl, kind, &output),
          "unknown service cannot accept even a SYSTEM-owned object");
    }
    const DWORD valid = SE_GROUP_ENABLED | SE_GROUP_OWNER;
    Check(inspection::MatchesInspectionServiceGroupForTest(service, service_sid, valid),
        "exact enabled owner-eligible service group is required");
    for (const DWORD invalid : {DWORD(0U), DWORD(SE_GROUP_ENABLED), DWORD(SE_GROUP_OWNER), DWORD(valid | SE_GROUP_USE_FOR_DENY_ONLY)}) {
      Check(!inspection::MatchesInspectionServiceGroupForTest(service, service_sid, invalid),
          "disabled, non-owner and deny-only service groups remain refused");
    }
    Check(!inspection::MatchesInspectionServiceGroupForTest(service, other_service, valid) &&
        !inspection::MatchesInspectionServiceGroupForTest(service, worker.value, valid) &&
        !inspection::MatchesInspectionServiceGroupForTest(service, system.value, valid) &&
        !inspection::MatchesInspectionServiceGroupForTest(static_cast<Service>(0U), service_sid, valid),
        "ownership eligibility never substitutes a different service or account identity");
  }
}

struct GroupFixture final {
  alignas(16) std::array<BYTE, 1024U> bytes{};
  std::size_t length = 0U;
  TOKEN_GROUPS* groups() noexcept { return reinterpret_cast<TOKEN_GROUPS*>(bytes.data()); }
  bool Set(std::initializer_list<SID_AND_ATTRIBUTES> entries) noexcept {
    bytes.fill(0U);
    length = offsetof(TOKEN_GROUPS, Groups) + entries.size() * sizeof(SID_AND_ATTRIBUTES);
    if (length > bytes.size()) return false;
    groups()->GroupCount = static_cast<DWORD>(entries.size());
    unsigned index = 0U;
    for (const auto& entry : entries) {
      const DWORD size = GetLengthSid(entry.Sid);
      if (size > bytes.size() - length) return false;
      groups()->Groups[index++] = {bytes.data() + length, entry.Attributes};
      std::memcpy(bytes.data() + length, entry.Sid, size);
      length += size;
    }
    return true;
  }
};

void TestBrokerInspectionAccess() noexcept {
  using Service = inspection::WorkerInspectionService;
  using Object = inspection::WorkerInspectionObject;
  Local captured, broker, signer, logon, system;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
      L"O:S-1-5-5-0-360873258G:SYD:(A;;0x1fffff;;;S-1-5-5-0-360873258)(A;;0x1400;;;BA)"
      L"(A;;0x101000;;;S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905)",
      SDDL_REVISION_1, &captured.value, nullptr) &&
      ConvertStringSidToSidW(kBroker, &broker.value) && ConvertStringSidToSidW(kSigner, &signer.value) &&
      ConvertStringSidToSidW(L"S-1-5-5-0-360873258", &logon.value) &&
      ConvertStringSidToSidW(L"S-1-5-18", &system.value), "GOATBOX process permission evidence parses");
  if (!captured.value || !broker.value || !signer.value || !logon.value || !system.value) return;
  Handle primary, stripped, plain, restricted, bounded;
  Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &primary.value) &&
      CreateRestrictedToken(primary.value, DISABLE_MAX_PRIVILEGE, 0U, nullptr, 0U, nullptr, 0U, nullptr, &stripped.value) &&
      DuplicateTokenEx(stripped.value, TOKEN_QUERY, nullptr, SecurityImpersonation, TokenImpersonation, &plain.value),
      "ordinary test token has no debug privilege to bypass the captured DACL");
  if (!plain.value) return;
  Check(!Allowed(captured.value, plain.value, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE),
      "captured signer process DACL denies the broker's combined query/wait request");
  SID_AND_ATTRIBUTES restriction{broker.value, 0U};
  Check(CreateRestrictedToken(primary.value, DISABLE_MAX_PRIVILEGE, 0U, nullptr, 0U, nullptr,
      1U, &restriction, &restricted.value) &&
      DuplicateTokenEx(restricted.value, TOKEN_QUERY, nullptr, SecurityImpersonation, TokenImpersonation, &bounded.value),
      "unassigned token constrains Windows access checks to the broker SID");
  if (!bounded.value) return;
  alignas(16) std::array<BYTE, 512U> user_bytes{};
  DWORD returned = 0U;
  if (!GetTokenInformation(primary.value, TokenUser, user_bytes.data(), static_cast<DWORD>(user_bytes.size()), &returned)) {
    Check(false, "broker access fixture reads current test user"); return;
  }
  const auto user = reinterpret_cast<const TOKEN_USER*>(user_bytes.data());
  GroupFixture groups;
  Check(groups.Set({{signer.value, SE_GROUP_ENABLED | SE_GROUP_OWNER},
      {logon.value, SE_GROUP_LOGON_ID | SE_GROUP_ENABLED | SE_GROUP_OWNER}}), "bound signer/logon identity builds");
  for (const auto object : {Object::Process, Object::Token}) {
    alignas(16) std::array<BYTE, 1024U> storage{};
    auto original = reinterpret_cast<PACL>(storage.data());
    // The ordinary access pass uses the test user; the independent restricting
    // SID pass enforces the exact broker grant, without impersonating a service.
    Check(InitializeAcl(original, static_cast<DWORD>(storage.size()), ACL_REVISION) &&
        AddAccessAllowedAceEx(original, ACL_REVISION, 0U, 0x001fffffU, user->User.Sid), "ordinary test access initializes");
    inspection::WorkerInspectionAcl output;
    const auto compose = [&]() noexcept {
      return inspection::ComposeWorkerInspectionAclWithGroupsForTest(Service::Provisioner,
          groups.bytes.data(), groups.length, logon.value, original, object, &output);
    };
    SECURITY_DESCRIPTOR descriptor{};
    Check(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
        SetSecurityDescriptorOwner(&descriptor, system.value, FALSE) &&
        SetSecurityDescriptorGroup(&descriptor, system.value, FALSE) &&
        SetSecurityDescriptorDacl(&descriptor, TRUE, original, FALSE), "broker access descriptor initializes");
    const DWORD expected = object == Object::Process ? PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE : TOKEN_QUERY;
    Check(!Allowed(&descriptor, bounded.value, expected), "missing broker inspection grant denies access");
    Check(compose(), "signer composes broker inspection grant");
    Check(SetSecurityDescriptorDacl(&descriptor, TRUE, reinterpret_cast<PACL>(output.bytes.data()), FALSE) != FALSE,
        "composed broker descriptor installs in fixture");
    const DWORD valid = object == Object::Process ? PROCESS_ALL_ACCESS : TOKEN_ALL_ACCESS;
    for (unsigned bit = 0U; bit < 24U; ++bit) {
      const DWORD access = 1UL << bit;
      if ((valid & access) == 0U) continue;
      Check(Allowed(&descriptor, bounded.value, access) == ((expected & access) != 0U),
          "broker gets only query/wait, never memory, control, duplicate, assign or ACL mutation access");
    }
    Check(inspection::ComposeWorkerInspectionAcl(Service::CellController, system.value, original, object, &output) &&
        !Allowed(&descriptor, bounded.value, expected), "controller does not publish a broker grant");
    Check(AddAccessDeniedAceEx(original, ACL_REVISION, 0U, expected, broker.value) != FALSE, "explicit broker deny fixture builds");
    output.bytes.fill(0xa5U);
    const auto before = output;
    Check(!compose() && output.bytes == before.bytes, "an explicit broker deny refuses without replacement");
    original->AceCount = 1U;
    Check(AddAccessAllowedAceEx(original, ACL_REVISION, 0U, expected | WRITE_DAC, broker.value) != FALSE,
        "overprivileged broker fixture builds");
    Check(!compose() && output.bytes == before.bytes, "an excessive broker grant refuses without weakening it");
  }
}

void TestTokenBoundLogonOwner() noexcept {
  using Service = inspection::WorkerInspectionService;
  using Object = inspection::WorkerInspectionObject;
  using Failure = inspection::WorkerInspectionFailure;
  Local system, signer, controller, worker, administrators, user, logon, another_logon, wrong_authority, wrong_count;
  Check(ConvertStringSidToSidW(L"S-1-5-18", &system.value) &&
      ConvertStringSidToSidW(kSigner, &signer.value) && ConvertStringSidToSidW(kController, &controller.value) &&
      ConvertStringSidToSidW(kWorker, &worker.value) && ConvertStringSidToSidW(L"S-1-5-32-544", &administrators.value) &&
      ConvertStringSidToSidW(L"S-1-5-21-1-2-3-1001", &user.value) &&
      ConvertStringSidToSidW(L"S-1-5-5-0-1234", &logon.value) &&
      ConvertStringSidToSidW(L"S-1-5-5-0-5678", &another_logon.value) &&
      ConvertStringSidToSidW(L"S-1-6-5-0-1234", &wrong_authority.value) &&
      ConvertStringSidToSidW(L"S-1-5-5-0-1234-1", &wrong_count.value), "logon owner fixture SIDs parse");
  if (!system.value || !signer.value || !controller.value || !worker.value || !administrators.value ||
      !user.value || !logon.value || !another_logon.value || !wrong_authority.value || !wrong_count.value) return;
  alignas(16) std::array<BYTE, 512U> acl_bytes{};
  auto acl = reinterpret_cast<PACL>(acl_bytes.data());
  Check(InitializeAcl(acl, static_cast<DWORD>(acl_bytes.size()), ACL_REVISION) &&
      AddAccessDeniedAceEx(acl, ACL_REVISION, 0U, WRITE_DAC, user.value) &&
      AddAccessAllowedAceEx(acl, ACL_REVISION, 0U, 0x001fffffU, system.value), "logon owner fixture ACL builds");
  const auto original_acl = acl_bytes;
  constexpr DWORD service_flags = SE_GROUP_ENABLED | SE_GROUP_OWNER;
  constexpr DWORD logon_flags = SE_GROUP_LOGON_ID | SE_GROUP_MANDATORY | SE_GROUP_ENABLED_BY_DEFAULT | SE_GROUP_ENABLED | SE_GROUP_OWNER;
  for (const auto service : {Service::Provisioner, Service::CellController}) {
    PSID service_sid = service == Service::Provisioner ? signer.value : controller.value;
    PSID other_service = service == Service::Provisioner ? controller.value : signer.value;
    for (const auto object : {Object::Process, Object::Token}) {
      GroupFixture fixture;
      Check(fixture.Set({{service_sid, service_flags}, {logon.value, logon_flags}}), "bound logon group packet builds");
      const auto original_groups = fixture.bytes;
      inspection::WorkerInspectionAcl reference, output;
      inspection::WorkerInspectionDiagnostic diagnostic;
      const auto compose = [&](PSID owner) noexcept {
        return inspection::ComposeWorkerInspectionAclWithGroupsForTest(service,
            fixture.bytes.data(), fixture.length, owner, acl, object, &output, &diagnostic);
      };
      Check(inspection::ComposeWorkerInspectionAcl(service, system.value, acl, object, &reference) && compose(logon.value),
          "a matching owner-eligible logon from the same service token is accepted");
      Check(output.bytes == reference.bytes && acl_bytes == original_acl && fixture.bytes == original_groups,
          "logon ownership preserves exact original ACEs and identical least-privilege worker grant");
      Check(compose(system.value) && output.bytes == reference.bytes &&
          compose(service_sid) && output.bytes == reference.bytes, "SYSTEM and fixed service ownership remain valid");
      output.bytes.fill(0xa5U);
      const auto untouched = output;
      Check(!inspection::ComposeWorkerInspectionAcl(service, logon.value, acl, object, &output, &diagnostic) &&
          diagnostic.failure == Failure::LogonOwnerMismatch && output.bytes == untouched.bytes,
          "a caller-supplied logon SID alone cannot authorize an inspection grant");
      for (const auto forbidden : {another_logon.value, other_service, worker.value, administrators.value, user.value}) {
        output = untouched;
        Check(!compose(forbidden) && output.bytes == untouched.bytes,
            "another logon, another service, worker, administrators and arbitrary user remain refused");
      }
      output = untouched;
      Check(!compose(another_logon.value) && diagnostic.failure == Failure::LogonOwnerMismatch &&
          inspection::WorkerInspectionServiceExitCode(diagnostic) ==
              (object == Object::Process ? UINT32_C(0x460d0000) : UINT32_C(0x480d0000)),
          "different logon identity has an explicit fail-closed diagnostic");
      for (const DWORD flags : {DWORD(logon_flags & ~SE_GROUP_OWNER), DWORD(logon_flags & ~SE_GROUP_ENABLED),
          DWORD(SE_GROUP_LOGON_ID), DWORD(logon_flags | SE_GROUP_USE_FOR_DENY_ONLY),
          DWORD(logon_flags | SE_GROUP_RESOURCE), DWORD(logon_flags | SE_GROUP_INTEGRITY), DWORD(logon_flags | 0x80U)}) {
        Check(fixture.Set({{service_sid, service_flags}, {logon.value, flags}}), "ineligible logon packet builds");
        output = untouched;
        Check(!compose(logon.value) && diagnostic.failure == Failure::LogonOwnerAttributes && output.bytes == untouched.bytes,
            "disabled, non-owner, deny-only and unexpected logon attributes cannot grant access");
      }
      Check(fixture.Set({{service_sid, service_flags}}), "service token without logon SID builds");
      output = untouched;
      Check(!compose(logon.value) && output.bytes == untouched.bytes && compose(system.value) && compose(service_sid),
          "absent logon cannot match an owner and does not break legacy SYSTEM/service owners");
      const auto refuse_packet = [&]() noexcept {
        output = untouched;
        Check(!compose(logon.value) && output.bytes == untouched.bytes,
            "malformed, missing or ambiguous token identity refuses without publishing an ACL");
      };
      Check(fixture.Set({{logon.value, logon_flags}}), "packet without required service builds"); refuse_packet();
      Check(fixture.Set({{other_service, service_flags}, {logon.value, logon_flags}}), "wrong service packet builds"); refuse_packet();
      Check(fixture.Set({{service_sid, SE_GROUP_ENABLED}, {logon.value, logon_flags}}), "ineligible service packet builds"); refuse_packet();
      Check(fixture.Set({{service_sid, service_flags}, {service_sid, service_flags}, {logon.value, logon_flags}}), "duplicate service packet builds"); refuse_packet();
      for (const auto second : {logon.value, another_logon.value}) {
        Check(fixture.Set({{service_sid, service_flags}, {logon.value, logon_flags}, {second, logon_flags}}), "duplicate logon packet builds"); refuse_packet();
      }
      for (const auto invalid_sid : {system.value, wrong_authority.value, wrong_count.value}) {
        Check(fixture.Set({{service_sid, service_flags}, {invalid_sid, logon_flags}}), "wrong logon SID form builds"); refuse_packet();
      }
      for (const DWORD flags : {DWORD(service_flags), DWORD(logon_flags & ~0x80000000U), DWORD(logon_flags & ~0x40000000U)}) {
        Check(fixture.Set({{service_sid, service_flags}, {logon.value, flags}}), "missing logon marker packet builds"); refuse_packet();
      }
      for (unsigned malformed = 0U; malformed < 6U; ++malformed) {
        Check(fixture.Set({{service_sid, service_flags}, {logon.value, logon_flags}}), "bounded parser packet resets");
        switch (malformed) {
          case 0U: fixture.length = 0U; break;
          case 1U: --fixture.length; break;
          case 2U: fixture.groups()->GroupCount = MAXDWORD; break;
          case 3U: fixture.groups()->Groups[1].Sid = fixture.bytes.data(); break;
          case 4U: fixture.groups()->Groups[1].Sid = fixture.bytes.data() + fixture.length + 4U; break;
          case 5U: fixture.groups()->Groups[1].Sid = static_cast<BYTE*>(fixture.groups()->Groups[1].Sid) + 1U; break;
        }
        refuse_packet();
      }
      Check(fixture.Set({{service_sid, service_flags}, {logon.value, logon_flags}}), "valid packet restores");
      output = untouched;
      Check(!inspection::ComposeWorkerInspectionAclWithGroupsForTest(service, fixture.bytes.data() + 1U,
          fixture.length - 1U, logon.value, acl, object, &output) && output.bytes == untouched.bytes,
          "unaligned group header is rejected before native structure access");
      Check(!inspection::ComposeWorkerInspectionAclWithGroupsForTest(static_cast<Service>(0U), fixture.bytes.data(),
          fixture.length, logon.value, acl, object, &output), "unknown service cannot use a matching logon");
    }
  }
}
}  // namespace

int RunSignerInspectionTests() noexcept {
  const int before = failures;
  TestDescriptorComposition();
  TestWindowsAccessAndOwnedToken();
  TestFailureDiagnostics();
  TestServiceOwnerPolicy();
  TestTokenBoundLogonOwner();
  TestBrokerInspectionAccess();
#if defined(GOATCITADEL_SIGNER_INSPECTION_STANDALONE)
  std::printf("{\"signerInspectionChecks\":%u,\"failures\":%d,\"installedService\":false}\n", checks, failures - before);
#endif
  return failures - before;
}

#if defined(GOATCITADEL_SIGNER_INSPECTION_STANDALONE)
#pragma comment(lib, "advapi32.lib")
int main() { return RunSignerInspectionTests(); }
#endif
