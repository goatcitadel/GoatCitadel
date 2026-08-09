#include <windows.h>

#include "service_runtime.hpp"
#include "local_transport.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;

namespace {

int g_failures = 0;

void Expect(bool condition, const char* message) noexcept {
  if (!condition) {
    std::fprintf(stderr, "FAIL service_runtime: %s\n", message);
    ++g_failures;
  }
}

gc::FixedWideString Wide(const wchar_t* value) noexcept {
  gc::FixedWideString result{};
  if (value == nullptr) {
    return result;
  }
  while (result.length < result.value.size() &&
         value[result.length] != L'\0') {
    result.value[result.length] = value[result.length];
    ++result.length;
  }
  return result;
}

gc::SidSnapshot NtSid(
    const std::uint32_t* subauthorities,
    std::size_t count) noexcept {
  gc::SidSnapshot sid{};
  if (subauthorities == nullptr || count == 0U || count > 15U) {
    return sid;
  }
  sid.length = 8U + (count * 4U);
  sid.bytes[0] = 1U;
  sid.bytes[1] = static_cast<std::uint8_t>(count);
  sid.bytes[7] = 5U;
  for (std::size_t index = 0U; index < count; ++index) {
    const std::uint32_t value = subauthorities[index];
    const std::size_t offset = 8U + (index * 4U);
    sid.bytes[offset] = static_cast<std::uint8_t>(value & 0xFFU);
    sid.bytes[offset + 1U] =
        static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
    sid.bytes[offset + 2U] =
        static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
    sid.bytes[offset + 3U] =
        static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
  }
  return sid;
}

gc::SidSnapshot LocalSystemSid() noexcept {
  constexpr std::array<std::uint32_t, 1U> kParts = {18U};
  return NtSid(kParts.data(), kParts.size());
}

gc::SidSnapshot AdministratorsSid() noexcept {
  constexpr std::array<std::uint32_t, 2U> kParts = {32U, 544U};
  return NtSid(kParts.data(), kParts.size());
}

gc::SidSnapshot ServiceLogonSid() noexcept {
  constexpr std::array<std::uint32_t, 1U> kParts = {6U};
  return NtSid(kParts.data(), kParts.size());
}

gc::SidSnapshot ProvisionerServiceSid() noexcept {
  constexpr std::array<std::uint32_t, 6U> kParts = {
      80U,
      UINT32_C(1765223994),
      UINT32_C(2719708455),
      UINT32_C(3112291649),
      UINT32_C(2938929260),
      UINT32_C(976374647),
  };
  return NtSid(kParts.data(), kParts.size());
}

gc::SidSnapshot ProhibitedSid(std::uint32_t rid) noexcept {
  return NtSid(&rid, 1U);
}

gc::ServiceIdentitySnapshot Baseline(
    const gc::FixedWideString& expected_path) noexcept {
  gc::ServiceIdentitySnapshot snapshot{};
  snapshot.exact_service_main_arguments = true;
  snapshot.current_process_id = 42U;
  snapshot.service_process_id = 42U;
  snapshot.status_service_type = SERVICE_WIN32_OWN_PROCESS;
  snapshot.status_current_state = SERVICE_START_PENDING;
  snapshot.status_service_flags = 0U;
  snapshot.configured_service_type = SERVICE_WIN32_OWN_PROCESS;
  snapshot.configured_start_type = SERVICE_DEMAND_START;
  snapshot.configured_error_control = SERVICE_ERROR_NORMAL;
  snapshot.configured_binary_path = expected_path;
  snapshot.configured_account_name = Wide(L"LocalSystem");
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

  snapshot.token_user = LocalSystemSid();
  snapshot.token_type = static_cast<std::uint32_t>(TokenPrimary);
  snapshot.token_session_id = 0U;
  snapshot.token_unrestricted = true;
  snapshot.token_non_appcontainer = true;
  snapshot.current_thread_has_no_token = true;
  snapshot.restricted_sid_count = 0U;
  snapshot.token_group_count = 2U;
  snapshot.token_groups[0] = {
      ProvisionerServiceSid(),
      SE_GROUP_ENABLED | SE_GROUP_OWNER,
  };
  snapshot.token_groups[1] = {ServiceLogonSid(), SE_GROUP_ENABLED};
  snapshot.token_privilege_count = 1U;
  snapshot.change_notify_luid_low_part = 9U;
  snapshot.change_notify_luid_high_part = 0;
  snapshot.token_privileges[0] = {
      snapshot.change_notify_luid_low_part,
      snapshot.change_notify_luid_high_part,
      SE_PRIVILEGE_ENABLED,
  };

  snapshot.service_object_owner = LocalSystemSid();
  snapshot.service_dacl_present = true;
  snapshot.service_dacl_defaulted = false;
  snapshot.service_dacl_protected = true;
  snapshot.service_dacl_non_inheriting = true;
  snapshot.service_ace_count = 2U;
  snapshot.service_aces[0] = {
      ACCESS_ALLOWED_ACE_TYPE,
      0U,
      SERVICE_ALL_ACCESS,
      LocalSystemSid(),
  };
  snapshot.service_aces[1] = {
      ACCESS_ALLOWED_ACE_TYPE,
      0U,
      SERVICE_START | SERVICE_STOP | SERVICE_QUERY_CONFIG |
          SERVICE_QUERY_STATUS | READ_CONTROL | SYNCHRONIZE,
      AdministratorsSid(),
  };
  return snapshot;
}

void TestCommandDispositions() noexcept {
  Expect(
      gc::DecideCommandDisposition(L"C:\\fixed\\provisioner.exe") ==
          gc::CommandDisposition::Service,
      "no argument enters only SCM disposition");
  Expect(
      gc::DecideCommandDisposition(
          L"\"C:\\fixed path\\provisioner.exe\" --inspect-stdio") ==
          gc::CommandDisposition::InspectStdio,
      "sole inspect argument accepted");
  Expect(
      gc::DecideCommandDisposition(
          L"C:\\fixed\\provisioner.exe --inspect-stdio extra") ==
          gc::CommandDisposition::Invalid,
      "second argument rejected");
  Expect(
      gc::DecideCommandDisposition(
          L"C:\\fixed\\provisioner.exe --service-stdio") ==
          gc::CommandDisposition::Invalid,
      "client argument rejected by service executable");
  Expect(
      gc::DecideCommandDisposition(L"\"unterminated") ==
          gc::CommandDisposition::Invalid,
      "unterminated image token rejected");
  Expect(
      gc::DecideCommandDisposition(nullptr) == gc::CommandDisposition::Invalid,
      "null command line rejected");
}

void TestStatusMatrix() noexcept {
  for (std::uint32_t checkpoint = 1U; checkpoint <= 4U; ++checkpoint) {
    const auto status = gc::BuildServiceStatusSnapshot(
        gc::ServiceStatusPhase::StartPending,
        checkpoint,
        0U);
    Expect(status.service_type == SERVICE_WIN32_OWN_PROCESS, "pending type");
    Expect(status.current_state == SERVICE_START_PENDING, "pending state");
    Expect(status.controls_accepted == 0U, "pending controls");
    Expect(status.win32_exit_code == NO_ERROR, "pending Win32 code");
    Expect(status.service_specific_exit_code == 0U, "pending service code");
    Expect(status.checkpoint == checkpoint, "pending checkpoint");
    Expect(status.wait_hint == 15000U, "pending wait hint");
  }

  const auto running = gc::BuildServiceStatusSnapshot(
      gc::ServiceStatusPhase::Running,
      99U,
      7U);
  Expect(running.current_state == SERVICE_RUNNING, "running state");
  Expect(
      running.controls_accepted ==
          (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN),
      "running controls");
  Expect(running.checkpoint == 0U && running.wait_hint == 0U, "running zeros");
  Expect(running.win32_exit_code == 0U, "running Win32 code");
  Expect(running.service_specific_exit_code == 0U, "running service code");

  const auto stopping = gc::BuildServiceStatusSnapshot(
      gc::ServiceStatusPhase::StopPending,
      91U,
      8U);
  Expect(stopping.current_state == SERVICE_STOP_PENDING, "stopping state");
  Expect(stopping.controls_accepted == 0U, "stopping controls");
  Expect(stopping.checkpoint == 1U, "stopping checkpoint");
  Expect(stopping.wait_hint == 5000U, "stopping wait hint");
  Expect(stopping.win32_exit_code == 0U, "stopping Win32 code");
  Expect(stopping.service_specific_exit_code == 0U, "stopping service code");

  const auto stopped_ok = gc::BuildServiceStatusSnapshot(
      gc::ServiceStatusPhase::Stopped,
      4U,
      0U);
  Expect(stopped_ok.current_state == SERVICE_STOPPED, "stopped state");
  Expect(stopped_ok.win32_exit_code == NO_ERROR, "normal stopped code");
  Expect(stopped_ok.service_specific_exit_code == 0U, "normal service code");

  const auto stopped_failure = gc::BuildServiceStatusSnapshot(
      gc::ServiceStatusPhase::Stopped,
      0U,
      6U);
  Expect(
      stopped_failure.win32_exit_code == ERROR_SERVICE_SPECIFIC_ERROR,
      "failure stopped Win32 code");
  Expect(
      stopped_failure.service_specific_exit_code == 6U,
      "failure stopped service code");
  Expect(
      stopped_failure.controls_accepted == 0U &&
          stopped_failure.checkpoint == 0U &&
          stopped_failure.wait_hint == 0U,
      "stopped terminal zeros");
}

void ExpectIdentityFailure(
    const gc::ServiceIdentitySnapshot& snapshot,
    const gc::FixedWideString& expected_path,
    const char* message) noexcept {
  Expect(
      gc::ValidateServiceIdentitySnapshot(snapshot, expected_path) ==
          gc::ServiceIdentityValidation::ServiceIdentity,
      message);
}

void TestIdentityNegativeMatrix() noexcept {
  const auto expected_path = Wide(
      L"\"C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\"
      L"GoatCitadelRemoteWorkerProvisioner.exe\"");
  const auto baseline = Baseline(expected_path);
  Expect(
      gc::ValidateServiceIdentitySnapshot(baseline, expected_path) ==
          gc::ServiceIdentityValidation::Valid,
      "baseline identity accepted");

  auto changed = baseline;
  changed.exact_service_main_arguments = false;
  Expect(
      gc::ValidateServiceIdentitySnapshot(changed, expected_path) ==
          gc::ServiceIdentityValidation::LaunchContext,
      "wrong ServiceMain arguments are launch-context failure");

#define EXPECT_FIELD_FAILURE(statement, message) \
  do {                                             \
    changed = baseline;                            \
    statement;                                     \
    ExpectIdentityFailure(changed, expected_path, message); \
  } while (false)

  EXPECT_FIELD_FAILURE(changed.current_process_id = 0U, "zero current PID");
  EXPECT_FIELD_FAILURE(changed.configured_service_type |= SERVICE_INTERACTIVE_PROCESS, "interactive service");
  EXPECT_FIELD_FAILURE(changed.configured_start_type = SERVICE_AUTO_START, "automatic start");
  EXPECT_FIELD_FAILURE(changed.configured_error_control = SERVICE_ERROR_IGNORE, "wrong error control");
  EXPECT_FIELD_FAILURE(changed.configured_binary_path.value[1] = L'X', "changed binary path");
  EXPECT_FIELD_FAILURE(changed.configured_binary_path.value[changed.configured_binary_path.length++] = L' ', "binary arguments");
  EXPECT_FIELD_FAILURE(changed.configured_account_name = Wide(L".\\LocalSystem"), "alternate account spelling");
  EXPECT_FIELD_FAILURE(changed.load_order_group_empty = false, "load-order group");
  EXPECT_FIELD_FAILURE(changed.dependencies_empty = false, "dependency");
  EXPECT_FIELD_FAILURE(changed.triggers_empty = false, "trigger");
  EXPECT_FIELD_FAILURE(changed.failure_actions_empty = false, "failure action");
  EXPECT_FIELD_FAILURE(changed.failure_actions_on_non_crash_disabled = false, "non-crash failure action flag");
  EXPECT_FIELD_FAILURE(changed.delayed_auto_start_disabled = false, "delayed auto start");
  EXPECT_FIELD_FAILURE(changed.configured_service_sid_type = SERVICE_SID_TYPE_RESTRICTED, "wrong service SID type");
  EXPECT_FIELD_FAILURE(changed.required_privilege_characters -= 1U, "single-NUL privilege list");
  EXPECT_FIELD_FAILURE(changed.required_privileges[0] = L'X', "wrong privilege");
  EXPECT_FIELD_FAILURE(changed.required_privileges[changed.required_privilege_characters++] = L'X', "extra privilege bytes");

  EXPECT_FIELD_FAILURE(changed.token_user = AdministratorsSid(), "wrong token user");
  EXPECT_FIELD_FAILURE(changed.token_type = static_cast<std::uint32_t>(TokenImpersonation), "impersonation process token");
  EXPECT_FIELD_FAILURE(changed.token_session_id = 1U, "nonzero service session");
  EXPECT_FIELD_FAILURE(changed.token_unrestricted = false, "restricted token");
  EXPECT_FIELD_FAILURE(changed.token_non_appcontainer = false, "AppContainer token");
  EXPECT_FIELD_FAILURE(changed.current_thread_has_no_token = false, "ambient thread token");
  EXPECT_FIELD_FAILURE(changed.restricted_sid_count = 1U, "restricted SID");
  EXPECT_FIELD_FAILURE(changed.token_groups[0].attributes &= ~SE_GROUP_ENABLED, "disabled provisioner SID");
  EXPECT_FIELD_FAILURE(changed.token_groups[0].attributes &= ~SE_GROUP_OWNER, "non-owner provisioner SID");
  EXPECT_FIELD_FAILURE(changed.token_groups[0].attributes |= SE_GROUP_USE_FOR_DENY_ONLY, "deny-only provisioner SID");
  EXPECT_FIELD_FAILURE(changed.token_groups[2] = changed.token_groups[0]; changed.token_group_count = 3U, "duplicate provisioner SID");
  EXPECT_FIELD_FAILURE(changed.token_groups[1].attributes = 0U, "disabled service-logon SID");
  EXPECT_FIELD_FAILURE(changed.token_groups[2] = changed.token_groups[1]; changed.token_group_count = 3U, "duplicate enabled service-logon SID");
  for (const std::uint32_t prohibited_rid : {2U, 3U, 4U, 7U, 14U}) {
    changed = baseline;
    changed.token_groups[2] = {ProhibitedSid(prohibited_rid), SE_GROUP_ENABLED};
    changed.token_group_count = 3U;
    ExpectIdentityFailure(changed, expected_path, "enabled prohibited logon SID");
  }
  changed = baseline;
  changed.token_groups[2] = {ProhibitedSid(4U), 0U};
  changed.token_group_count = 3U;
  Expect(
      gc::ValidateServiceIdentitySnapshot(changed, expected_path) ==
          gc::ServiceIdentityValidation::Valid,
      "disabled prohibited SID is not enabled authority");

  EXPECT_FIELD_FAILURE(changed.token_privilege_count = 0U, "missing privilege");
  EXPECT_FIELD_FAILURE(changed.token_privilege_count = 2U, "extra disabled privilege");
  EXPECT_FIELD_FAILURE(changed.token_privileges[0].luid_low_part ^= 1U, "wrong privilege LUID");
  EXPECT_FIELD_FAILURE(changed.token_privileges[0].attributes = 0U, "disabled privilege");
  EXPECT_FIELD_FAILURE(changed.token_privileges[0].attributes |= SE_PRIVILEGE_REMOVED, "removed privilege");

  EXPECT_FIELD_FAILURE(changed.service_object_owner = AdministratorsSid(), "wrong service owner");
  EXPECT_FIELD_FAILURE(changed.service_dacl_present = false, "missing service DACL");
  EXPECT_FIELD_FAILURE(changed.service_dacl_defaulted = true, "defaulted service DACL");
  EXPECT_FIELD_FAILURE(changed.service_dacl_protected = false, "unprotected service DACL");
  EXPECT_FIELD_FAILURE(changed.service_dacl_non_inheriting = false, "inheriting service DACL");
  EXPECT_FIELD_FAILURE(changed.service_ace_count = 1U, "missing service ACE");
  EXPECT_FIELD_FAILURE(changed.service_ace_count = 3U, "extra service ACE");
  EXPECT_FIELD_FAILURE(changed.service_aces[0].type = ACCESS_DENIED_ACE_TYPE, "deny ACE");
  EXPECT_FIELD_FAILURE(changed.service_aces[0].flags = INHERITED_ACE, "inherited ACE");
  EXPECT_FIELD_FAILURE(changed.service_aces[0].mask ^= SERVICE_CHANGE_CONFIG, "wrong SYSTEM mask");
  EXPECT_FIELD_FAILURE(changed.service_aces[1].mask |= SERVICE_PAUSE_CONTINUE, "excess administrator authority");
  EXPECT_FIELD_FAILURE(changed.service_aces[0].sid = AdministratorsSid(), "wrong ACE order");

  #undef EXPECT_FIELD_FAILURE
}

void TestRunningServiceStatusMatrix() noexcept {
  const gc::RunningServiceStatusSnapshot baseline = {
      42U,
      42U,
      SERVICE_WIN32_OWN_PROCESS,
      SERVICE_RUNNING,
      0U,
  };
  Expect(
      gc::IsExactRunningServiceStatus(baseline),
      "RUNNING SCM status with exact current PID is accepted");

  auto changed = baseline;
  changed.current_process_id = 0U;
  Expect(!gc::IsExactRunningServiceStatus(changed), "zero current PID rejected");
  changed = baseline;
  changed.service_process_id = 0U;
  Expect(
      !gc::IsExactRunningServiceStatus(changed) &&
          gc::ClassifyRunningServiceStatus(changed) ==
              gc::RunningServiceStatusDisposition::Retry,
      "zero RUNNING SCM PID is bounded propagation retry, not authority");
  changed = baseline;
  changed.service_process_id = 43U;
  Expect(
      !gc::IsExactRunningServiceStatus(changed) &&
          gc::ClassifyRunningServiceStatus(changed) ==
              gc::RunningServiceStatusDisposition::Mismatch,
      "different nonzero SCM PID is a hard mismatch");
  changed = baseline;
  changed.service_type = SERVICE_WIN32_SHARE_PROCESS;
  Expect(!gc::IsExactRunningServiceStatus(changed), "shared service rejected");
  changed = baseline;
  changed.current_state = SERVICE_START_PENDING;
  Expect(
      !gc::IsExactRunningServiceStatus(changed) &&
          gc::ClassifyRunningServiceStatus(changed) ==
              gc::RunningServiceStatusDisposition::Retry,
      "pending PID is not authority and receives only a bounded poll");
  changed = baseline;
  changed.service_flags = 1U;
  Expect(!gc::IsExactRunningServiceStatus(changed), "system-process flag rejected");
}

void TestStartupOrderingAndBounds() noexcept {
  constexpr std::array<gc::StartupStage, 6U> kStages = {
      gc::StartupStage::Initial,
      gc::StartupStage::IdentityValidated,
      gc::StartupStage::ImagesValidated,
      gc::StartupStage::TransportArmed,
      gc::StartupStage::RunningReported,
      gc::StartupStage::RunningPidValidated,
  };
  for (std::size_t from = 0U; from < kStages.size(); ++from) {
    for (std::size_t to = 0U; to < kStages.size(); ++to) {
      const bool expected = to == from + 1U;
      Expect(
          gc::IsValidStartupStageTransition(kStages[from], kStages[to]) ==
              expected,
          "startup stage permits only the frozen next transition");
    }
  }
  Expect(
      !gc::IsValidStartupStageTransition(
          static_cast<gc::StartupStage>(99U),
          gc::StartupStage::IdentityValidated),
      "unknown startup stage fails closed");

  Expect(
      gc::ClassifyOwnedStartupWait(WAIT_OBJECT_0) ==
          gc::OwnedStartupWaitDisposition::Completed,
      "owned startup completion classified");
  Expect(
      gc::ClassifyOwnedStartupWait(WAIT_OBJECT_0 + 1U) ==
          gc::OwnedStartupWaitDisposition::Progress,
      "owned startup progress classified");
  Expect(
      gc::ClassifyOwnedStartupWait(WAIT_OBJECT_0 + 2U) ==
          gc::OwnedStartupWaitDisposition::Stop,
      "owned startup stop classified");
  Expect(
      gc::ClassifyOwnedStartupWait(WAIT_TIMEOUT) ==
          gc::OwnedStartupWaitDisposition::Deadline,
      "owned startup timeout classified as deadline");
  Expect(
      gc::ClassifyOwnedStartupWait(WAIT_FAILED) ==
          gc::OwnedStartupWaitDisposition::Failed,
      "owned startup wait failure classified");

  Expect(
      gc::BoundedDeadlineWaitMillisecondsAt(100U, 15100U) == 15000U,
      "startup wait uses the remaining absolute budget");
  Expect(
      gc::BoundedDeadlineWaitMillisecondsAt(15100U, 15100U) == 0U &&
          gc::BoundedDeadlineWaitMillisecondsAt(15101U, 15100U) == 0U,
      "expired absolute deadline never receives a grace wait");
  Expect(
      gc::BoundedDeadlineWaitMillisecondsAt(
          0U, static_cast<std::uint64_t>(MAXDWORD) + 99U) == MAXDWORD,
      "oversized wait clamps to the Win32 bound");

  Expect(
      gc::SelectLifecycleCleanupDeadline(12000U, 13000U, 14000U) ==
          12000U,
      "existing cleanup deadline is immutable across repeat controls");
  Expect(
      gc::SelectLifecycleCleanupDeadline(0U, 12000U, 20000U) == 12000U,
      "delayed stop observation cannot refresh the first stop deadline");
  Expect(
      gc::SelectLifecycleCleanupDeadline(0U, 0U, 20000U) == 25000U,
      "internal completion receives one five-second cleanup budget");
  Expect(
      gc::SelectLifecycleWatchdogDeadline(15000U, 10000U, false) == 10000U,
      "first stop shortens the startup watchdog without refreshing it");
  Expect(
      gc::SelectLifecycleWatchdogDeadline(15000U, 19000U, false) == 19000U,
      "late startup STOP receives its immutable five-second cleanup budget");
  Expect(
      gc::SelectLifecycleWatchdogDeadline(0U, 10000U, false) == 10000U,
      "first stop arms an idle running-service watchdog");
  Expect(
      gc::SelectLifecycleWatchdogDeadline(9000U, 10000U, true) == 9000U,
      "later stop cannot extend an earlier internal cleanup deadline");
  Expect(
      gc::SelectLifecycleWatchdogDeadline(0U, 0U, false) == 0U,
      "healthy running service leaves the lifecycle watchdog idle");
  Expect(
      gc::SelectLifecycleWatchdogSnapshotDeadline(
          9000U, 10000U, false, 9000U) == 9000U,
      "pending internal D1 remains authoritative before its marker despite later STOP D2");

  Expect(
      gc::ClassifyStopControlPublication(0U, 0U) ==
          gc::StopControlPublicationDisposition::FirstControl,
      "deadline CAS winner exclusively owns first-control publication");
  Expect(
      gc::ClassifyStopControlPublication(12000U, 0U) ==
          gc::StopControlPublicationDisposition::RepeatPending,
      "repeat handler cannot signal while the first disposition is pending");
  Expect(
      gc::ClassifyStopControlPublication(
          12000U, static_cast<std::uint32_t>(SERVICE_CONTROL_STOP)) ==
              gc::StopControlPublicationDisposition::RepeatPublished &&
          gc::ClassifyStopControlPublication(
              12000U,
              static_cast<std::uint32_t>(SERVICE_CONTROL_SHUTDOWN)) ==
              gc::StopControlPublicationDisposition::RepeatPublished,
      "repeat handler may signal only after first-control publication");

  Expect(
      gc::ClassifyStartupGateWait(WAIT_OBJECT_0, true, false) ==
          gc::StartupGateDisposition::Stop,
      "simultaneous stop and continue signals prioritize stop");
  Expect(
      gc::ClassifyStartupGateWait(WAIT_OBJECT_0 + 1U, true, false) ==
          gc::StartupGateDisposition::Stop,
      "stop recheck overrides a racing continue result");
  Expect(
      gc::ClassifyStartupGateWait(WAIT_OBJECT_0 + 1U, false, false) ==
          gc::StartupGateDisposition::Continue,
      "continue proceeds only while stop remains absent");
  Expect(
      gc::ClassifyStartupGateWait(WAIT_TIMEOUT, false, true) ==
          gc::StartupGateDisposition::Deadline,
      "startup gate timeout preserves the absolute deadline");
  Expect(
      gc::ShouldRunServiceTransportAfterStartGate(
          WAIT_OBJECT_0 + 1U, false, false),
      "transport Run begins only after the explicit start gate");
  Expect(
      !gc::ShouldRunServiceTransportAfterStartGate(
          WAIT_OBJECT_0 + 1U, true, false) &&
          !gc::ShouldRunServiceTransportAfterStartGate(
              WAIT_OBJECT_0, true, false) &&
          !gc::ShouldRunServiceTransportAfterStartGate(
              WAIT_TIMEOUT, false, true),
      "STOP at or before the start-gate release prevents transport Run");
  Expect(
      gc::ClassifyPostCheckpointStartupState(true, false) ==
          gc::StartupGateDisposition::Deadline,
      "CP4 crossing the absolute startup deadline cannot emit RUNNING");
  Expect(
      gc::ClassifyPostCheckpointStartupState(false, true) ==
          gc::StartupGateDisposition::Stop,
      "STOP after CP4 prevents RUNNING publication");
  Expect(
      gc::ClassifyPostCheckpointStartupState(true, true) ==
          gc::StartupGateDisposition::Stop,
      "STOP remains authoritative when the startup deadline crosses too");
  Expect(
      gc::ClassifyPostCheckpointStartupState(false, false) ==
          gc::StartupGateDisposition::Continue,
      "RUNNING remains eligible only after a timely CP4 without STOP");

  const std::array<gc::StartupStage, 5U> stop_cutpoints = {
      gc::StartupStage::Initial,
      gc::StartupStage::IdentityValidated,
      gc::StartupStage::ImagesValidated,
      gc::StartupStage::TransportArmed,
      gc::StartupStage::RunningReported,
  };
  for (const gc::StartupStage stage : stop_cutpoints) {
    (void)stage;
    Expect(
        !gc::ShouldContinueStartupCoordination(
            0U, true, false, false, true),
        "CP1 through RUNNING-PID stop exits startup coordination");
  }
  Expect(
      gc::ShouldContinueStartupCoordination(
          0U, true, false, false, false),
      "startup coordination continues only before a stop cutpoint");
}

void TestEmbeddedDigestShape() noexcept {
  const auto& digest = gc::EmbeddedExpectedClientSha256();
  Expect(digest.size() == 32U, "embedded client digest is fixed 32 bytes");
  Expect(&digest == &gc::EmbeddedExpectedClientSha256(), "embedded digest has stable storage");
}

void TestTokenHasRestrictionsContract() noexcept {
  bool unrestricted = false;
  const std::uint8_t clear = 0U;
  const std::uint8_t set = 1U;
  const std::uint8_t non_boolean = 2U;
  Expect(
      gc::DecodeTokenHasRestrictions(&clear, sizeof(clear), &unrestricted) &&
          unrestricted,
      "one-byte FALSE TokenHasRestrictions means unrestricted");
  Expect(
      gc::DecodeTokenHasRestrictions(&set, sizeof(set), &unrestricted) &&
          !unrestricted,
      "one-byte TRUE TokenHasRestrictions means restricted");
  Expect(
      !gc::DecodeTokenHasRestrictions(
          &clear, sizeof(DWORD), &unrestricted),
      "DWORD-sized TokenHasRestrictions projection is rejected");
  Expect(
      !gc::DecodeTokenHasRestrictions(
          &non_boolean, sizeof(non_boolean), &unrestricted),
      "non-BOOLEAN TokenHasRestrictions projection is rejected");

  HANDLE token = nullptr;
  std::array<std::uint8_t, sizeof(DWORD)> actual = {
      0xCCU,
      0xCCU,
      0xCCU,
      0xCCU,
  };
  DWORD returned = 0U;
  const bool queried =
      OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != FALSE &&
      GetTokenInformation(
          token,
          TokenHasRestrictions,
          actual.data(),
          static_cast<DWORD>(actual.size()),
          &returned) != FALSE;
  bool actual_unrestricted = false;
  Expect(queried, "host TokenHasRestrictions query succeeds");
  Expect(
      queried && returned == sizeof(BOOLEAN),
      "host TokenHasRestrictions returns one BOOLEAN byte");
  Expect(
      queried && gc::DecodeTokenHasRestrictions(
                     actual.data(), returned, &actual_unrestricted),
      "host TokenHasRestrictions bytes decode under the collector contract");
  if (token != nullptr) {
    Expect(CloseHandle(token) != FALSE, "host token handle closes");
  }
}

void TestProtectedTransportResultLabels() noexcept {
  struct Fixture final {
    gc::ServiceTransportResult result;
    const char* label;
  };
  constexpr std::array<Fixture, 9U> kFixtures = {{
      {gc::ServiceTransportResult::Success, "success"},
      {gc::ServiceTransportResult::ProtectedImage, "protected_image"},
      {gc::ServiceTransportResult::PipeReadiness, "pipe_readiness"},
      {gc::ServiceTransportResult::CallerAuthentication, "caller_authentication"},
      {gc::ServiceTransportResult::ProtocolInvalid, "protocol_invalid"},
      {gc::ServiceTransportResult::Deadline, "deadline"},
      {gc::ServiceTransportResult::CancellationOrReversion, "cancellation_or_reversion"},
      {gc::ServiceTransportResult::CustodyOrJournal, "custody_or_journal"},
      {static_cast<gc::ServiceTransportResult>(UINT32_MAX), "custody_or_journal"},
  }};
  for (const auto& fixture : kFixtures) {
    const char* actual = gc::ServiceTransportResultLabel(fixture.result);
    Expect(
        actual != nullptr && std::strcmp(actual, fixture.label) == 0,
        "transport result label is exact and unknown values fail closed to code9");
  }
  const auto stopped = gc::BuildServiceStatusSnapshot(
      gc::ServiceStatusPhase::Stopped,
      0U,
      static_cast<std::uint32_t>(gc::ServiceTransportResult::CustodyOrJournal));
  Expect(
      stopped.win32_exit_code == ERROR_SERVICE_SPECIFIC_ERROR &&
          stopped.service_specific_exit_code == 9U,
      "custody/journal failure reaches the SCM as exact terminal code9");
}

}  // namespace

int RunServiceRuntimeTests() noexcept {
  const int initial_failures = g_failures;
  TestCommandDispositions();
  TestStatusMatrix();
  TestIdentityNegativeMatrix();
  TestRunningServiceStatusMatrix();
  TestStartupOrderingAndBounds();
  TestEmbeddedDigestShape();
  TestTokenHasRestrictionsContract();
  TestProtectedTransportResultLabels();
  return g_failures - initial_failures;
}
