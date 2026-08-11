#include "availability_broker.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr DWORD kAdministratorServiceMask =
    SERVICE_START | SERVICE_STOP | SERVICE_QUERY_CONFIG |
    SERVICE_QUERY_STATUS | READ_CONTROL | SYNCHRONIZE;
constexpr std::array<std::uint32_t, 1U> kLocalSystemSidParts = {18U};
constexpr std::array<std::uint32_t, 2U> kAdministratorsSidParts = {32U, 544U};
constexpr wchar_t kLocalSystemAccount[] = L"LocalSystem";
constexpr wchar_t kRequiredPrivileges[] = L"SeChangeNotifyPrivilege\0";

bool BytesEqual(
    const std::uint8_t* left,
    const std::uint8_t* right,
    std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) {
    return false;
  }
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

AvailabilitySid MakeNtSid(
    const std::uint32_t* subauthorities,
    std::size_t count) noexcept {
  AvailabilitySid sid{};
  if (subauthorities == nullptr || count == 0U || count > 15U) {
    return sid;
  }
  sid.length = 8U + (count * 4U);
  sid.bytes[0U] = 1U;
  sid.bytes[1U] = static_cast<std::uint8_t>(count);
  sid.bytes[7U] = 5U;
  for (std::size_t index = 0U; index < count; ++index) {
    const std::uint32_t value = subauthorities[index];
    const std::size_t offset = 8U + (index * 4U);
    sid.bytes[offset] = static_cast<std::uint8_t>(value & 0xFFU);
    sid.bytes[offset + 1U] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
    sid.bytes[offset + 2U] = static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
    sid.bytes[offset + 3U] = static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
  }
  return sid;
}

bool EqualSidSnapshot(
    const AvailabilitySid& left,
    const AvailabilitySid& right) noexcept {
  return left.length == right.length && left.length != 0U &&
         left.length <= left.bytes.size() &&
         BytesEqual(left.bytes.data(), right.bytes.data(), left.length);
}

bool EqualPath(
    const AvailabilityFixedPath& left,
    const AvailabilityFixedPath& right) noexcept {
  if (left.length == 0U || left.length != right.length ||
      left.length >= left.value.size()) {
    return false;
  }
  for (std::size_t index = 0U; index <= left.length; ++index) {
    if (left.value[index] != right.value[index]) {
      return false;
    }
  }
  return true;
}

bool EqualLiteral(
    const AvailabilityFixedPath& value,
    const wchar_t* literal) noexcept {
  if (literal == nullptr || value.length >= value.value.size()) {
    return false;
  }
  std::size_t index = 0U;
  while (literal[index] != L'\0') {
    if (index >= value.length || value.value[index] != literal[index]) {
      return false;
    }
    ++index;
  }
  return index == value.length && value.value[index] == L'\0';
}

bool RequiredPrivilegesAreExact(
    const AvailabilityServiceSnapshot& snapshot) noexcept {
  constexpr std::size_t kExpectedCharacters =
      sizeof(kRequiredPrivileges) / sizeof(kRequiredPrivileges[0]);
  if (snapshot.required_privilege_characters != kExpectedCharacters ||
      snapshot.required_privilege_characters >
          snapshot.required_privileges.size()) {
    return false;
  }
  for (std::size_t index = 0U; index < kExpectedCharacters; ++index) {
    if (snapshot.required_privileges[index] != kRequiredPrivileges[index]) {
      return false;
    }
  }
  return true;
}

bool ValidateCommonServiceConfiguration(
    const AvailabilityServiceSnapshot& snapshot,
    const AvailabilityFixedPath& expected_binary_path,
    std::uint32_t expected_start_type) noexcept {
  if (snapshot.configured_service_type != SERVICE_WIN32_OWN_PROCESS ||
      snapshot.configured_start_type != expected_start_type ||
      snapshot.configured_error_control != SERVICE_ERROR_NORMAL ||
      !EqualPath(snapshot.configured_binary_path, expected_binary_path) ||
      !EqualLiteral(snapshot.configured_account_name, kLocalSystemAccount) ||
      !snapshot.load_order_group_empty || !snapshot.dependencies_empty ||
      !snapshot.triggers_empty || !snapshot.failure_actions_empty ||
      !snapshot.failure_actions_on_non_crash_disabled ||
      !snapshot.delayed_auto_start_disabled ||
      snapshot.configured_service_sid_type != SERVICE_SID_TYPE_UNRESTRICTED ||
      !RequiredPrivilegesAreExact(snapshot) || !snapshot.service_dacl_present ||
      snapshot.service_dacl_defaulted || !snapshot.service_dacl_protected ||
      !snapshot.service_dacl_non_inheriting ||
      snapshot.service_ace_count != 2U) {
    return false;
  }
  const AvailabilitySid system = MakeNtSid(
      kLocalSystemSidParts.data(), kLocalSystemSidParts.size());
  const AvailabilitySid administrators = MakeNtSid(
      kAdministratorsSidParts.data(), kAdministratorsSidParts.size());
  if (!EqualSidSnapshot(snapshot.service_object_owner, system)) {
    return false;
  }
  const AvailabilityAce& system_ace = snapshot.service_aces[0U];
  const AvailabilityAce& administrators_ace = snapshot.service_aces[1U];
  return system_ace.type == ACCESS_ALLOWED_ACE_TYPE &&
         system_ace.flags == 0U && system_ace.mask == SERVICE_ALL_ACCESS &&
         EqualSidSnapshot(system_ace.sid, system) &&
         administrators_ace.type == ACCESS_ALLOWED_ACE_TYPE &&
         administrators_ace.flags == 0U &&
         administrators_ace.mask == kAdministratorServiceMask &&
         EqualSidSnapshot(administrators_ace.sid, administrators);
}

bool StatusMetadataIsExact(
    const AvailabilityServiceSnapshot& snapshot) noexcept {
  if (snapshot.win32_exit_code != NO_ERROR ||
      snapshot.service_specific_exit_code != 0U) {
    return false;
  }
  if (snapshot.current_state == SERVICE_START_PENDING ||
      snapshot.current_state == SERVICE_STOP_PENDING) {
    return snapshot.checkpoint != 0U && snapshot.wait_hint != 0U &&
           snapshot.wait_hint <= 30000U;
  }
  return snapshot.checkpoint == 0U && snapshot.wait_hint == 0U;
}

}  // namespace

AvailabilityAction ClassifyAvailabilityAction(
    std::uint32_t current_state,
    std::uint32_t process_id,
    std::uint32_t service_flags) noexcept {
  if (service_flags != 0U) {
    return AvailabilityAction::Reject;
  }
  switch (current_state) {
    case SERVICE_RUNNING:
      return process_id == 0U ? AvailabilityAction::Reject
                              : AvailabilityAction::Ready;
    case SERVICE_STOPPED:
      return process_id == 0U ? AvailabilityAction::Start
                              : AvailabilityAction::Reject;
    case SERVICE_START_PENDING:
    case SERVICE_STOP_PENDING:
      return AvailabilityAction::Wait;
    default:
      return AvailabilityAction::Reject;
  }
}

std::uint32_t AvailabilityWaitMilliseconds(
    std::uint64_t now_ms,
    std::uint64_t deadline_ms) noexcept {
  if (deadline_ms == 0U || now_ms >= deadline_ms) {
    return 0U;
  }
  const std::uint64_t remaining = deadline_ms - now_ms;
  return static_cast<std::uint32_t>(std::min<std::uint64_t>(remaining, 250U));
}

bool ValidateAvailabilityBrokerSnapshot(
    const AvailabilityServiceSnapshot& snapshot,
    const AvailabilityFixedPath& expected_binary_path) noexcept {
  return snapshot.exact_service_main_arguments &&
         snapshot.current_process_id != 0U &&
         snapshot.current_process_id == snapshot.service_process_id &&
         snapshot.status_service_type == SERVICE_WIN32_OWN_PROCESS &&
         snapshot.current_state == SERVICE_START_PENDING &&
         snapshot.service_flags == 0U &&
         StatusMetadataIsExact(snapshot) &&
         ValidateCommonServiceConfiguration(
             snapshot, expected_binary_path, SERVICE_DEMAND_START);
}

bool ValidateAvailabilityTargetSnapshot(
    const AvailabilityServiceSnapshot& snapshot,
    const AvailabilityFixedPath& expected_binary_path) noexcept {
  return snapshot.status_service_type == SERVICE_WIN32_OWN_PROCESS &&
         StatusMetadataIsExact(snapshot) &&
         ValidateCommonServiceConfiguration(
             snapshot, expected_binary_path, SERVICE_DEMAND_START) &&
         ClassifyAvailabilityAction(
             snapshot.current_state,
             snapshot.service_process_id,
             snapshot.service_flags) != AvailabilityAction::Reject;
}

}  // namespace goatcitadel::remote_worker_provisioner
