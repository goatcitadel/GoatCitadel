#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

constexpr wchar_t kAvailabilityBrokerServiceName[] =
    L"GoatCitadelRemoteWorkerProvisionerAvailability";
constexpr wchar_t kAvailabilityBrokerExecutableName[] =
    L"GoatCitadelRemoteWorkerProvisionerAvailability.exe";

constexpr std::size_t kAvailabilityMaximumPathCharacters = 512U;
constexpr std::size_t kAvailabilityMaximumSidBytes = 68U;
constexpr std::size_t kAvailabilityMaximumServiceAces = 8U;

using AvailabilitySha256 = std::array<std::uint8_t, 32U>;

enum class AvailabilityAction : std::uint8_t {
  Ready,
  Start,
  Wait,
  Reject,
};

enum class AvailabilityIdentityValidation : std::uint32_t {
  Valid = 0U,
  LaunchContext = 1U,
  ServiceIdentity = 2U,
  TargetIdentity = 3U,
  TargetStart = 4U,
  Deadline = 5U,
};

struct AvailabilityFixedPath final {
  std::array<wchar_t, kAvailabilityMaximumPathCharacters> value{};
  std::size_t length = 0U;
};

struct AvailabilitySid final {
  std::array<std::uint8_t, kAvailabilityMaximumSidBytes> bytes{};
  std::size_t length = 0U;
};

struct AvailabilityAce final {
  std::uint8_t type = 0U;
  std::uint8_t flags = 0U;
  std::uint32_t mask = 0U;
  AvailabilitySid sid{};
};

struct AvailabilityServiceSnapshot final {
  bool exact_service_main_arguments = false;
  std::uint32_t current_process_id = 0U;
  std::uint32_t service_process_id = 0U;
  std::uint32_t status_service_type = 0U;
  std::uint32_t current_state = 0U;
  std::uint32_t service_flags = 0U;
  std::uint32_t win32_exit_code = 0U;
  std::uint32_t service_specific_exit_code = 0U;
  std::uint32_t checkpoint = 0U;
  std::uint32_t wait_hint = 0U;

  std::uint32_t configured_service_type = 0U;
  std::uint32_t configured_start_type = 0U;
  std::uint32_t configured_error_control = 0U;
  AvailabilityFixedPath configured_binary_path{};
  AvailabilityFixedPath configured_account_name{};
  bool load_order_group_empty = false;
  bool dependencies_empty = false;
  bool triggers_empty = false;
  bool failure_actions_empty = false;
  bool failure_actions_on_non_crash_disabled = false;
  bool delayed_auto_start_disabled = false;
  std::uint32_t configured_service_sid_type = 0U;
  std::array<wchar_t, 64U> required_privileges{};
  std::size_t required_privilege_characters = 0U;

  AvailabilitySid service_object_owner{};
  bool service_dacl_present = false;
  bool service_dacl_defaulted = true;
  bool service_dacl_protected = false;
  bool service_dacl_non_inheriting = false;
  std::array<AvailabilityAce, kAvailabilityMaximumServiceAces> service_aces{};
  std::size_t service_ace_count = 0U;
};

AvailabilityAction ClassifyAvailabilityAction(
    std::uint32_t current_state,
    std::uint32_t process_id,
    std::uint32_t service_flags) noexcept;

std::uint32_t AvailabilityWaitMilliseconds(
    std::uint64_t now_ms,
    std::uint64_t deadline_ms) noexcept;

bool ValidateAvailabilityBrokerSnapshot(
    const AvailabilityServiceSnapshot& snapshot,
    const AvailabilityFixedPath& expected_binary_path) noexcept;

bool ValidateAvailabilityTargetSnapshot(
    const AvailabilityServiceSnapshot& snapshot,
    const AvailabilityFixedPath& expected_binary_path) noexcept;

int RunAvailabilityBrokerDispatcher() noexcept;

}  // namespace goatcitadel::remote_worker_provisioner
