#include "signer_inspection.hpp"

#include <cstring>

namespace goatcitadel::remote_worker_provisioner {
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
constexpr std::array<std::uint32_t, 6U> kSignerSidParts = {
    80U, UINT32_C(1765223994), UINT32_C(2719708455),
    UINT32_C(3112291649), UINT32_C(2938929260), UINT32_C(976374647),
};
alignas(DWORD) constexpr auto kSignerSid = MakeServiceSid(kSignerSidParts);
PSID SystemSid() noexcept { return const_cast<BYTE*>(kSystemSid.data()); }

struct Handle final {
  HANDLE value = nullptr;
  ~Handle() { if (value) CloseHandle(value); }
};
bool SidFits(const BYTE* bytes, std::size_t length) noexcept {
  if (!bytes || length < 8U || bytes[1] > SID_MAX_SUB_AUTHORITIES) return false;
  const std::size_t required = 8U + 4U * bytes[1];
  return required <= length && IsValidSid(const_cast<BYTE*>(bytes)) != FALSE;
}

bool HasSignerServiceSid(HANDLE token) noexcept {
  alignas(16) std::array<BYTE, 8192U> bytes{};
  DWORD returned = 0U;
  if (!GetTokenInformation(token, TokenGroups, bytes.data(), static_cast<DWORD>(bytes.size()), &returned) ||
      returned < sizeof(TOKEN_GROUPS) || returned > bytes.size()) return false;
  const auto groups = reinterpret_cast<const TOKEN_GROUPS*>(bytes.data());
  if (groups->GroupCount > (returned - offsetof(TOKEN_GROUPS, Groups)) / sizeof(SID_AND_ATTRIBUTES)) return false;
  unsigned signer_count = 0U;
  const auto first = reinterpret_cast<std::uintptr_t>(bytes.data());
  for (DWORD index = 0U; index < groups->GroupCount; ++index) {
    const auto& group = groups->Groups[index];
    const auto sid = reinterpret_cast<std::uintptr_t>(group.Sid);
    if (sid < first || sid - first > returned ||
        !SidFits(reinterpret_cast<const BYTE*>(group.Sid), returned - (sid - first))) return false;
    if (EqualSid(group.Sid, const_cast<BYTE*>(kSignerSid.data()))) {
      if (++signer_count != 1U || (group.Attributes & (SE_GROUP_ENABLED | SE_GROUP_OWNER)) !=
          (SE_GROUP_ENABLED | SE_GROUP_OWNER) || (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0U) return false;
    }
  }
  return signer_count == 1U;
}

}  // namespace

bool ComposeSignerInspectionAcl(PSID owner, PACL original,
    SignerInspectionObject object, SignerInspectionAcl* output) noexcept {
  return worker_host::ComposeWorkerInspectionAcl(owner, original, object, output);
}

bool GrantCurrentSignerInspectionAccess() noexcept {
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
      returned != sizeof(appcontainer) || appcontainer != 0U || !HasSignerServiceSid(token.value)) return false;
  return worker_host::GrantCurrentSystemWorkerInspectionAccess();
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)
bool ApplySignerInspectionAclForTest(HANDLE token, PSID expected_owner) noexcept {
  return worker_host::ApplyWorkerTokenInspectionForTest(token, expected_owner);
}
bool ApplySignerProcessInspectionForTest(PSID expected_owner) noexcept {
  return worker_host::ApplyWorkerProcessInspectionForTest(expected_owner);
}
#endif
}  // namespace goatcitadel::remote_worker_provisioner
