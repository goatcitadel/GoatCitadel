#include "cell_security.hpp"
#include <aclapi.h>
#include <cstring>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
namespace {
struct LocalMemory final { void* value = nullptr; ~LocalMemory() { if (value) LocalFree(value); } };
bool SameAcl(PACL left, PACL right) noexcept {
  if (!left || !right || !IsValidAcl(left) || !IsValidAcl(right) || left->AceCount != right->AceCount) return false;
  for (DWORD index = 0; index < left->AceCount; ++index) {
    void *a = nullptr, *b = nullptr;
    if (!GetAce(left, index, &a) || !GetAce(right, index, &b)) return false;
    const auto size = static_cast<const ACE_HEADER*>(a)->AceSize;
    if (size != static_cast<const ACE_HEADER*>(b)->AceSize || std::memcmp(a, b, size) != 0) return false;
  }
  return true;
}
}
DWORD MakeCellControlFileSecurity(std::vector<std::uint8_t>& descriptor) noexcept {
  if (descriptor.empty() || !IsValidSecurityDescriptor(descriptor.data())) return ERROR_INVALID_SECURITY_DESCR;
  PACL label = nullptr, dacl = nullptr;
  BOOL present = FALSE, ignored = FALSE;
  if (!GetSecurityDescriptorSacl(descriptor.data(), &present, &label, &ignored) ||
      !present || !label || !IsValidAcl(label) || label->AceCount != 1 ||
      !GetSecurityDescriptorDacl(descriptor.data(), &present, &dacl, &ignored) ||
      !present || !dacl || !IsValidAcl(dacl) || !dacl->AceCount)
    return ERROR_INVALID_SECURITY_DESCR;
  for (const auto acl : {dacl, label}) {
    for (DWORD index = 0; index < acl->AceCount; ++index) {
      void* entry = nullptr;
      if (!GetAce(acl, index, &entry)) return ERROR_INVALID_SECURITY_DESCR;
      auto* header = static_cast<ACE_HEADER*>(entry);
      const auto type = acl == label ? SYSTEM_MANDATORY_LABEL_ACE_TYPE : ACCESS_ALLOWED_ACE_TYPE;
      if (header->AceType != type || header->AceFlags != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE))
        return ERROR_INVALID_SECURITY_DESCR;
      header->AceFlags = 0;
    }
  }
  return ERROR_SUCCESS;
}
DWORD VerifyCellSecurity(HANDLE handle, const std::vector<std::uint8_t>& bytes) noexcept {
  if (bytes.empty()) return ERROR_INVALID_SECURITY_DESCR;
  LocalMemory actual;
  constexpr SECURITY_INFORMATION selection = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
    DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
  const DWORD read = GetSecurityInfo(handle, SE_FILE_OBJECT, selection, nullptr, nullptr, nullptr, nullptr, &actual.value);
  if (read) return read;
  void* expected = const_cast<std::uint8_t*>(bytes.data());
  PSID actual_owner = nullptr, expected_owner = nullptr, actual_group = nullptr, expected_group = nullptr;
  PACL actual_dacl = nullptr, expected_dacl = nullptr, actual_sacl = nullptr, expected_sacl = nullptr;
  BOOL ignored = FALSE, actual_present = FALSE, expected_present = FALSE;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!IsValidSecurityDescriptor(actual.value) || !IsValidSecurityDescriptor(expected) ||
      !GetSecurityDescriptorControl(actual.value, &control, &revision) || !(control & SE_DACL_PROTECTED) ||
      !GetSecurityDescriptorOwner(actual.value, &actual_owner, &ignored) ||
      !GetSecurityDescriptorOwner(expected, &expected_owner, &ignored) ||
      !GetSecurityDescriptorGroup(actual.value, &actual_group, &ignored) ||
      !GetSecurityDescriptorGroup(expected, &expected_group, &ignored) ||
      !actual_owner || !expected_owner || !actual_group || !expected_group ||
      !EqualSid(actual_owner, expected_owner) || !EqualSid(actual_group, expected_group) ||
      !GetSecurityDescriptorDacl(actual.value, &actual_present, &actual_dacl, &ignored) ||
      !GetSecurityDescriptorDacl(expected, &expected_present, &expected_dacl, &ignored) ||
      !actual_present || !expected_present || !SameAcl(actual_dacl, expected_dacl) ||
      !GetSecurityDescriptorSacl(actual.value, &actual_present, &actual_sacl, &ignored) ||
      !GetSecurityDescriptorSacl(expected, &expected_present, &expected_sacl, &ignored) ||
      !actual_present || !expected_present || !SameAcl(actual_sacl, expected_sacl)) return ERROR_INVALID_SECURITY_DESCR;
  return ERROR_SUCCESS;
}
}
