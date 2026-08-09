#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

enum class ServiceTransportResult : std::uint32_t;

constexpr std::size_t kMaximumServicePathCharacters = 512U;
constexpr std::size_t kMaximumRequiredPrivilegeCharacters = 64U;
constexpr std::size_t kMaximumSidBytes = 68U;
constexpr std::size_t kMaximumTokenGroups = 128U;
constexpr std::size_t kMaximumTokenPrivileges = 8U;
constexpr std::size_t kMaximumServiceAces = 8U;

enum class CommandDisposition : std::uint8_t {
  Service,
  InspectStdio,
  Invalid,
};

enum class ServiceIdentityValidation : std::uint32_t {
  Valid = 0U,
  LaunchContext = 1U,
  ServiceIdentity = 2U,
};

enum class ServiceStatusPhase : std::uint8_t {
  StartPending,
  Running,
  StopPending,
  Stopped,
};

enum class StartupStage : std::uint32_t {
  Initial = 0U,
  IdentityValidated = 1U,
  ImagesValidated = 2U,
  TransportArmed = 3U,
  RunningReported = 4U,
  RunningPidValidated = 5U,
};

enum class OwnedStartupWaitDisposition : std::uint8_t {
  Completed,
  Progress,
  Stop,
  Deadline,
  Failed,
};

enum class StopControlPublicationDisposition : std::uint8_t {
  FirstControl,
  RepeatPending,
  RepeatPublished,
};

enum class StartupGateDisposition : std::uint8_t {
  Continue,
  Stop,
  Deadline,
  Failed,
};

enum class RunningServiceStatusDisposition : std::uint8_t {
  Valid,
  Retry,
  Mismatch,
};

struct FixedWideString final {
  std::array<wchar_t, kMaximumServicePathCharacters> value{};
  std::size_t length = 0U;
};

struct SidSnapshot final {
  std::array<std::uint8_t, kMaximumSidBytes> bytes{};
  std::size_t length = 0U;
};

struct TokenGroupSnapshot final {
  SidSnapshot sid{};
  std::uint32_t attributes = 0U;
};

struct TokenPrivilegeSnapshot final {
  std::uint32_t luid_low_part = 0U;
  std::int32_t luid_high_part = 0;
  std::uint32_t attributes = 0U;
};

struct ServiceAceSnapshot final {
  std::uint8_t type = 0U;
  std::uint8_t flags = 0U;
  std::uint32_t mask = 0U;
  SidSnapshot sid{};
};

struct ServiceIdentitySnapshot final {
  bool exact_service_main_arguments = false;
  std::uint32_t current_process_id = 0U;
  std::uint32_t service_process_id = 0U;
  std::uint32_t status_service_type = 0U;
  std::uint32_t status_current_state = 0U;
  std::uint32_t status_service_flags = 0U;

  std::uint32_t configured_service_type = 0U;
  std::uint32_t configured_start_type = 0U;
  std::uint32_t configured_error_control = 0U;
  FixedWideString configured_binary_path{};
  FixedWideString configured_account_name{};
  bool load_order_group_empty = false;
  bool dependencies_empty = false;
  bool triggers_empty = false;
  bool failure_actions_empty = false;
  bool failure_actions_on_non_crash_disabled = false;
  bool delayed_auto_start_disabled = false;
  std::uint32_t configured_service_sid_type = 0U;
  std::array<wchar_t, kMaximumRequiredPrivilegeCharacters>
      required_privileges{};
  std::size_t required_privilege_characters = 0U;

  SidSnapshot token_user{};
  std::uint32_t token_type = 0U;
  std::uint32_t token_session_id = UINT32_MAX;
  bool token_unrestricted = false;
  bool token_non_appcontainer = false;
  bool current_thread_has_no_token = false;
  std::size_t restricted_sid_count = 0U;
  std::array<TokenGroupSnapshot, kMaximumTokenGroups> token_groups{};
  std::size_t token_group_count = 0U;
  std::array<TokenPrivilegeSnapshot, kMaximumTokenPrivileges>
      token_privileges{};
  std::size_t token_privilege_count = 0U;
  std::uint32_t change_notify_luid_low_part = 0U;
  std::int32_t change_notify_luid_high_part = 0;

  SidSnapshot service_object_owner{};
  bool service_dacl_present = false;
  bool service_dacl_defaulted = true;
  bool service_dacl_protected = false;
  bool service_dacl_non_inheriting = false;
  std::array<ServiceAceSnapshot, kMaximumServiceAces> service_aces{};
  std::size_t service_ace_count = 0U;
};

struct ServiceStatusSnapshot final {
  std::uint32_t service_type = 0U;
  std::uint32_t current_state = 0U;
  std::uint32_t controls_accepted = 0U;
  std::uint32_t win32_exit_code = 0U;
  std::uint32_t service_specific_exit_code = 0U;
  std::uint32_t checkpoint = 0U;
  std::uint32_t wait_hint = 0U;
};

struct RunningServiceStatusSnapshot final {
  std::uint32_t current_process_id = 0U;
  std::uint32_t service_process_id = 0U;
  std::uint32_t service_type = 0U;
  std::uint32_t current_state = 0U;
  std::uint32_t service_flags = 0U;
};

CommandDisposition DecideCommandDisposition(
    const wchar_t* command_line) noexcept;

ServiceIdentityValidation ValidateServiceIdentitySnapshot(
    const ServiceIdentitySnapshot& snapshot,
    const FixedWideString& expected_binary_path) noexcept;

ServiceStatusSnapshot BuildServiceStatusSnapshot(
    ServiceStatusPhase phase,
    std::uint32_t checkpoint,
    std::uint32_t final_service_specific_code) noexcept;

bool IsValidStartupStageTransition(
    StartupStage current,
    StartupStage next) noexcept;

OwnedStartupWaitDisposition ClassifyOwnedStartupWait(
    std::uint32_t wait_result) noexcept;

std::uint32_t BoundedDeadlineWaitMillisecondsAt(
    std::uint64_t now_ms,
    std::uint64_t deadline_ms) noexcept;

std::uint64_t SelectLifecycleCleanupDeadline(
    std::uint64_t existing_deadline_ms,
    std::uint64_t first_stop_deadline_ms,
    std::uint64_t now_ms) noexcept;

std::uint64_t SelectLifecycleWatchdogDeadline(
    std::uint64_t configured_deadline_ms,
    std::uint64_t first_stop_deadline_ms,
    bool cleanup_published) noexcept;

std::uint64_t SelectLifecycleWatchdogSnapshotDeadline(
    std::uint64_t configured_deadline_ms,
    std::uint64_t first_stop_deadline_ms,
    bool cleanup_published,
    std::uint64_t pending_cleanup_deadline_ms) noexcept;

StopControlPublicationDisposition ClassifyStopControlPublication(
    std::uint64_t previous_first_stop_deadline_ms,
    std::uint32_t published_stop_disposition) noexcept;

StartupGateDisposition ClassifyStartupGateWait(
    std::uint32_t wait_result,
    bool stop_observed,
    bool deadline_expired) noexcept;

StartupGateDisposition ClassifyPostCheckpointStartupState(
    bool deadline_expired,
    bool stop_observed) noexcept;

bool ShouldContinueStartupCoordination(
    std::uint32_t final_code,
    bool startup_thread_exists,
    bool startup_thread_completed,
    bool startup_ready,
    bool startup_stop_requested) noexcept;

bool ShouldRunServiceTransportAfterStartGate(
    std::uint32_t wait_result,
    bool stop_observed,
    bool deadline_expired) noexcept;

bool IsExactRunningServiceStatus(
    const RunningServiceStatusSnapshot& snapshot) noexcept;

RunningServiceStatusDisposition ClassifyRunningServiceStatus(
    const RunningServiceStatusSnapshot& snapshot) noexcept;

const std::array<std::uint8_t, 32U>& EmbeddedExpectedClientSha256() noexcept;

bool DecodeTokenHasRestrictions(
    const std::uint8_t* bytes,
    std::size_t returned_bytes,
    bool* token_unrestricted) noexcept;

const char* ServiceTransportResultLabel(
    ServiceTransportResult result) noexcept;

int RunServiceDispatcher() noexcept;

}  // namespace goatcitadel::remote_worker_provisioner
