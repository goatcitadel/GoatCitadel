#include "availability_broker.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

int g_failures = 0;

void Expect(bool condition, const char* message) noexcept {
  if (!condition) {
    std::fprintf(stderr, "FAIL availability_broker: %s\n", message);
    ++g_failures;
  }
}

gc::AvailabilityFixedPath Path(const wchar_t* value) noexcept {
  gc::AvailabilityFixedPath result{};
  if (value == nullptr) {
    return result;
  }
  while (result.length + 1U < result.value.size() &&
         value[result.length] != L'\0') {
    result.value[result.length] = value[result.length];
    ++result.length;
  }
  result.value[result.length] = L'\0';
  return result;
}

gc::AvailabilitySid NtSid(
    const std::uint32_t* parts,
    std::size_t count) noexcept {
  gc::AvailabilitySid sid{};
  if (parts == nullptr || count == 0U || count > 15U) {
    return sid;
  }
  sid.length = 8U + (count * 4U);
  sid.bytes[0U] = 1U;
  sid.bytes[1U] = static_cast<std::uint8_t>(count);
  sid.bytes[7U] = 5U;
  for (std::size_t index = 0U; index < count; ++index) {
    const std::size_t offset = 8U + (index * 4U);
    sid.bytes[offset] = static_cast<std::uint8_t>(parts[index] & 0xFFU);
    sid.bytes[offset + 1U] =
        static_cast<std::uint8_t>((parts[index] >> 8U) & 0xFFU);
    sid.bytes[offset + 2U] =
        static_cast<std::uint8_t>((parts[index] >> 16U) & 0xFFU);
    sid.bytes[offset + 3U] =
        static_cast<std::uint8_t>((parts[index] >> 24U) & 0xFFU);
  }
  return sid;
}

gc::AvailabilitySid LocalSystemSid() noexcept {
  constexpr std::array<std::uint32_t, 1U> kParts = {18U};
  return NtSid(kParts.data(), kParts.size());
}

gc::AvailabilitySid AdministratorsSid() noexcept {
  constexpr std::array<std::uint32_t, 2U> kParts = {32U, 544U};
  return NtSid(kParts.data(), kParts.size());
}

gc::AvailabilityServiceSnapshot Baseline(
    const gc::AvailabilityFixedPath& expected_path) noexcept {
  gc::AvailabilityServiceSnapshot snapshot{};
  snapshot.configured_service_type = SERVICE_WIN32_OWN_PROCESS;
  snapshot.configured_start_type = SERVICE_DEMAND_START;
  snapshot.configured_error_control = SERVICE_ERROR_NORMAL;
  snapshot.configured_binary_path = expected_path;
  snapshot.configured_account_name = Path(L"LocalSystem");
  snapshot.load_order_group_empty = true;
  snapshot.dependencies_empty = true;
  snapshot.triggers_empty = true;
  snapshot.failure_actions_empty = true;
  snapshot.failure_actions_on_non_crash_disabled = true;
  snapshot.delayed_auto_start_disabled = true;
  snapshot.configured_service_sid_type = SERVICE_SID_TYPE_UNRESTRICTED;
  constexpr wchar_t kPrivileges[] = L"SeChangeNotifyPrivilege\0";
  snapshot.required_privilege_characters =
      sizeof(kPrivileges) / sizeof(kPrivileges[0]);
  for (std::size_t index = 0U;
       index < snapshot.required_privilege_characters;
       ++index) {
    snapshot.required_privileges[index] = kPrivileges[index];
  }
  snapshot.service_object_owner = LocalSystemSid();
  snapshot.service_dacl_present = true;
  snapshot.service_dacl_defaulted = false;
  snapshot.service_dacl_protected = true;
  snapshot.service_dacl_non_inheriting = true;
  snapshot.service_ace_count = 2U;
  snapshot.service_aces[0U] = {
      ACCESS_ALLOWED_ACE_TYPE,
      0U,
      SERVICE_ALL_ACCESS,
      LocalSystemSid(),
  };
  snapshot.service_aces[1U] = {
      ACCESS_ALLOWED_ACE_TYPE,
      0U,
      SERVICE_START | SERVICE_STOP | SERVICE_QUERY_CONFIG |
          SERVICE_QUERY_STATUS | READ_CONTROL | SYNCHRONIZE,
      AdministratorsSid(),
  };
  snapshot.current_state = SERVICE_STOPPED;
  snapshot.status_service_type = SERVICE_WIN32_OWN_PROCESS;
  snapshot.win32_exit_code = NO_ERROR;
  snapshot.service_specific_exit_code = 0U;
  snapshot.checkpoint = 0U;
  snapshot.wait_hint = 0U;
  snapshot.service_process_id = 0U;
  snapshot.service_flags = 0U;
  return snapshot;
}

void TestStateClassificationAndDeadline() noexcept {
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_STOPPED, 0U, 0U) ==
          gc::AvailabilityAction::Start,
      "stopped starts");
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_RUNNING, 55U, 0U) ==
          gc::AvailabilityAction::Ready,
      "running ready");
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_START_PENDING, 0U, 0U) ==
          gc::AvailabilityAction::Wait,
      "start pending waits");
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_STOP_PENDING, 55U, 0U) ==
          gc::AvailabilityAction::Wait,
      "stop pending waits");
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_PAUSED, 55U, 0U) ==
          gc::AvailabilityAction::Reject,
      "paused rejects");
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_RUNNING, 0U, 0U) ==
          gc::AvailabilityAction::Reject,
      "running without pid rejects");
  Expect(
      gc::ClassifyAvailabilityAction(SERVICE_STOPPED, 0U, 1U) ==
          gc::AvailabilityAction::Reject,
      "service flags reject");
  Expect(gc::AvailabilityWaitMilliseconds(100U, 100U) == 0U, "expired wait");
  Expect(gc::AvailabilityWaitMilliseconds(100U, 101U) == 1U, "one ms wait");
  Expect(gc::AvailabilityWaitMilliseconds(100U, 1000U) == 250U, "wait bounded");
}

void TestExactTargetValidation() noexcept {
  const auto expected = Path(
      L"\"C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\"
      L"GoatCitadelRemoteWorkerProvisioner.exe\"");
  const auto baseline = Baseline(expected);
  Expect(
      gc::ValidateAvailabilityTargetSnapshot(baseline, expected),
      "baseline validates");
  auto changed = baseline;
  changed.configured_start_type = SERVICE_AUTO_START;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "start type exact");
  changed = baseline;
  changed.configured_binary_path = Path(L"\"C:\\other.exe\"");
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "path exact");
  changed = baseline;
  changed.triggers_empty = false;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "triggers reject");
  changed = baseline;
  changed.failure_actions_empty = false;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "failure actions reject");
  changed = baseline;
  changed.required_privileges[0U] = L'X';
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "privileges exact");
  changed = baseline;
  changed.service_aces[1U].mask |= SERVICE_CHANGE_CONFIG;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "acl mask exact");
  changed = baseline;
  changed.current_state = SERVICE_PAUSED;
  changed.service_process_id = 9U;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "state exact");
  changed = baseline;
  changed.current_state = SERVICE_RUNNING;
  changed.service_process_id = 9U;
  Expect(gc::ValidateAvailabilityTargetSnapshot(changed, expected), "running exact");
  changed = baseline;
  changed.current_state = SERVICE_STOP_PENDING;
  changed.service_process_id = 9U;
  changed.checkpoint = 2U;
  changed.wait_hint = 5000U;
  Expect(gc::ValidateAvailabilityTargetSnapshot(changed, expected), "stop pending exact");
  changed = baseline;
  changed.win32_exit_code = ERROR_SERVICE_SPECIFIC_ERROR;
  changed.service_specific_exit_code = 9U;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "prior failure not masked");
}

void TestExactBrokerValidation() noexcept {
  const auto expected = Path(
      L"\"C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\"
      L"GoatCitadelRemoteWorkerProvisionerAvailability.exe\"");
  auto snapshot = Baseline(expected);
  snapshot.exact_service_main_arguments = true;
  snapshot.current_process_id = 91U;
  snapshot.service_process_id = 91U;
  snapshot.status_service_type = SERVICE_WIN32_OWN_PROCESS;
  snapshot.current_state = SERVICE_START_PENDING;
  snapshot.checkpoint = 1U;
  snapshot.wait_hint = 30000U;
  Expect(
      gc::ValidateAvailabilityBrokerSnapshot(snapshot, expected),
      "broker baseline validates");
  auto changed = snapshot;
  changed.exact_service_main_arguments = false;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker args exact");
  changed = snapshot;
  changed.service_process_id = 92U;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker pid exact");
  changed = snapshot;
  changed.configured_start_type = SERVICE_AUTO_START;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker demand start exact");
}

}  // namespace

int RunAvailabilityBrokerTests() noexcept {
  g_failures = 0;
  TestStateClassificationAndDeadline();
  TestExactTargetValidation();
  TestExactBrokerValidation();
  return g_failures;
}
