#include "availability_broker.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

static_assert(SERVICE_SID_TYPE_UNRESTRICTED == 1U,
              "The installer must use the Windows SDK unrestricted service SID value.");

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

gc::AvailabilityAce WorkerQueryAce() noexcept {
  constexpr std::array<std::uint32_t, 6U> kParts = {
      80U, UINT32_C(1804173726), UINT32_C(3601835665),
      UINT32_C(1843708740), UINT32_C(3959121232), UINT32_C(3866049905),
  };
  return {ACCESS_ALLOWED_ACE_TYPE, 0U,
      SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL,
      NtSid(kParts.data(), kParts.size())};
}

gc::AvailabilityServiceSnapshot Baseline(
    const gc::AvailabilityFixedPath& expected_path, bool signer = false) noexcept {
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
  if (signer) {
    snapshot.service_ace_count = 3U;
    snapshot.service_aces[2U] = WorkerQueryAce();
  }
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
  const auto baseline = Baseline(expected, true);
  Expect(
      gc::ValidateAvailabilityTargetSnapshot(baseline, expected),
      "baseline validates");
  auto changed = baseline;
  changed.configured_service_sid_type = 3U;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected),
         "restricted SID value from the old installer is rejected");
  changed = baseline;
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
  for (unsigned bit = 0U; bit < 32U; ++bit) {
    changed = baseline;
    changed.service_aces[2U].mask ^= UINT32_C(1) << bit;
    Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "worker query mask exact");
  }
  changed = baseline;
  changed.service_aces[2U].sid = AdministratorsSid();
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "worker query principal exact");
  changed = baseline;
  changed.service_aces[2U].flags = INHERITED_ACE;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "worker query inheritance refused");
  changed = baseline;
  changed.service_aces[2U].type = ACCESS_DENIED_ACE_TYPE;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "worker query deny ACE refused");
  changed = baseline;
  changed.service_ace_count = 2U;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "missing worker query ACE refused");
  changed.service_ace_count = 4U;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "extra target ACE refused");
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
  changed = baseline;
  changed.win32_exit_code = ERROR_SERVICE_NEVER_STARTED;
  Expect(gc::ValidateAvailabilityTargetSnapshot(changed, expected), "fresh stopped signer can start once");
  const auto never_started = changed;
  for (unsigned mutation = 0U; mutation < 8U; ++mutation) {
    changed = never_started;
    switch (mutation) {
      case 0U: changed.service_process_id = 9U; break;
      case 1U: changed.current_state = SERVICE_RUNNING; changed.service_process_id = 9U; break;
      case 2U: changed.current_state = SERVICE_START_PENDING; changed.checkpoint = 1U; changed.wait_hint = 1000U; break;
      case 3U: changed.current_state = SERVICE_STOP_PENDING; changed.checkpoint = 1U; changed.wait_hint = 1000U; break;
      case 4U: changed.service_specific_exit_code = 1U; break;
      case 5U: changed.checkpoint = 1U; break;
      case 6U: changed.wait_hint = 1000U; break;
      case 7U: changed.win32_exit_code = ERROR_ACCESS_DENIED; break;
    }
    Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "never-started exception cannot hide failure or an active process");
  }
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
  changed.configured_service_sid_type = 3U;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected),
         "broker rejects the old installer restricted SID value");
  changed = snapshot;
  changed.exact_service_main_arguments = false;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker args exact");
  changed = snapshot;
  changed.service_process_id = 92U;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker pid exact");
  changed = snapshot;
  changed.configured_start_type = SERVICE_AUTO_START;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker demand start exact");
  changed = snapshot;
  changed.service_ace_count = 3U;
  changed.service_aces[2U] = WorkerQueryAce();
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker does not grant worker query or start rights");
  changed = snapshot;
  changed.win32_exit_code = ERROR_SERVICE_NEVER_STARTED;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "running broker startup cannot claim never-started status");
  changed = snapshot;
  changed.current_state = SERVICE_RUNNING;
  changed.checkpoint = 0U;
  changed.wait_hint = 0U;
  Expect(gc::ValidateAvailabilityBrokerSnapshot(changed, expected, false) &&
             !gc::ValidateAvailabilityBrokerSnapshot(changed, expected, true),
         "broker supervision requires the exact RUNNING phase after startup");
  changed = snapshot;
  changed.checkpoint = 0U;
  changed.wait_hint = 2000U;
  Expect(!gc::ValidateAvailabilityBrokerSnapshot(changed, expected), "broker cannot substitute SCM bootstrap defaults for its own status");
  changed = Baseline(expected, true);
  changed.current_state = SERVICE_START_PENDING;
  changed.wait_hint = 2000U;
  Expect(gc::ValidateAvailabilityTargetSnapshot(changed, expected), "signer accepts exact SCM startup defaults");
  changed.wait_hint = 2001U;
  Expect(!gc::ValidateAvailabilityTargetSnapshot(changed, expected), "zero-checkpoint startup requires exact SCM wait hint");
}

struct SupervisorFixture final {
  bool running = false;
  bool stopped = false;
  bool fast_completion = false;
  bool stop_after_revalidation = false;
  unsigned fail_step = 0U;
  unsigned verifies = 0U;
  unsigned starts = 0U;
  unsigned completions = 0U;
  unsigned pauses = 0U;
  unsigned protocol_errors = 0U;

  gc::AvailabilitySupervisorPorts Ports() noexcept {
    gc::AvailabilitySupervisorPorts ports{};
    ports.context = this;
    ports.stop_requested = [](void* raw) noexcept {
      return static_cast<SupervisorFixture*>(raw)->stopped;
    };
    ports.verify_broker = [](void* raw, bool starting) noexcept {
      auto& fixture = *static_cast<SupervisorFixture*>(raw);
      ++fixture.verifies;
      if (starting == fixture.running) ++fixture.protocol_errors;
      if (!starting && fixture.stop_after_revalidation) fixture.stopped = true;
      return fixture.fail_step != (starting ? 1U : 3U);
    };
    ports.publish_running = [](void* raw) noexcept {
      auto& fixture = *static_cast<SupervisorFixture*>(raw);
      fixture.running = fixture.fail_step != 2U;
      return fixture.running;
    };
    ports.ensure_target = [](void* raw, bool* completed) noexcept {
      auto& fixture = *static_cast<SupervisorFixture*>(raw);
      if (!fixture.running || fixture.stopped) ++fixture.protocol_errors;
      ++fixture.starts;
      *completed = fixture.fast_completion;
      return fixture.fail_step == 4U ? gc::AvailabilityIdentityValidation::TargetStart
                                     : gc::AvailabilityIdentityValidation::Valid;
    };
    ports.await_target_completion = [](void* raw) noexcept {
      auto& fixture = *static_cast<SupervisorFixture*>(raw);
      ++fixture.completions;
      return fixture.fail_step == 5U ? gc::AvailabilityIdentityValidation::TargetIdentity
                                     : gc::AvailabilityIdentityValidation::Valid;
    };
    ports.pause_before_restart = [](void* raw) noexcept {
      auto& fixture = *static_cast<SupervisorFixture*>(raw);
      if (++fixture.pauses == 2U) fixture.stopped = true;
      return fixture.fail_step == 6U ? gc::AvailabilityIdentityValidation::ServiceIdentity
                                     : gc::AvailabilityIdentityValidation::Valid;
    };
    return ports;
  }
};

void TestRepeatedSupervision() noexcept {
  SupervisorFixture normal;
  Expect(gc::RunAvailabilitySupervisor(normal.Ports()) == gc::AvailabilityIdentityValidation::Valid,
         "administrator-owned supervision stops cleanly");
  Expect(normal.starts == 2U && normal.completions == 2U && normal.pauses == 2U &&
             normal.verifies == 3U && normal.protocol_errors == 0U,
         "successive requests start only after RUNNING and current broker verification");
  SupervisorFixture fast;
  fast.fast_completion = true;
  Expect(gc::RunAvailabilitySupervisor(fast.Ports()) == gc::AvailabilityIdentityValidation::Valid &&
             fast.starts == 2U && fast.completions == 0U && fast.pauses == 2U,
         "an already completed exchange permits another bounded cycle without pretending readiness");
  SupervisorFixture stopped;
  stopped.stopped = true;
  Expect(gc::RunAvailabilitySupervisor(stopped.Ports()) == gc::AvailabilityIdentityValidation::Valid &&
             stopped.verifies == 0U && stopped.starts == 0U && !stopped.running,
         "STOP before startup cannot publish RUNNING or start a signer");
  SupervisorFixture stopped_after_validation;
  stopped_after_validation.stop_after_revalidation = true;
  Expect(gc::RunAvailabilitySupervisor(stopped_after_validation.Ports()) == gc::AvailabilityIdentityValidation::Valid &&
             stopped_after_validation.starts == 0U,
         "STOP observed during broker revalidation wins before the next start");
  for (unsigned step = 1U; step <= 6U; ++step) {
    SupervisorFixture failed;
    failed.fail_step = step;
    Expect(gc::RunAvailabilitySupervisor(failed.Ports()) != gc::AvailabilityIdentityValidation::Valid &&
               failed.starts <= 1U && failed.protocol_errors == 0U,
           "identity, status, start, completion and wait failures never trigger a restart");
  }
  auto missing = normal.Ports();
  missing.ensure_target = nullptr;
  Expect(gc::RunAvailabilitySupervisor(missing) == gc::AvailabilityIdentityValidation::ServiceIdentity,
         "missing supervision owner refuses");
}

}  // namespace

int RunAvailabilityBrokerTests() noexcept {
  g_failures = 0;
  TestStateClassificationAndDeadline();
  TestExactTargetValidation();
  TestExactBrokerValidation();
  TestRepeatedSupervision();
  return g_failures;
}
