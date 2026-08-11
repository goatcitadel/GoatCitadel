#include <windows.h>
#include <winsvc.h>

#include "service_runtime.hpp"

#include "ed25519_runtime.hpp"
#include "local_transport.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <type_traits>

#ifndef GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX
#error GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX must be a 64-hex string literal.
#endif

namespace goatcitadel::remote_worker_provisioner {

namespace {

constexpr wchar_t kInspectArgument[] = L"--inspect-stdio";
constexpr wchar_t kRuntimeServiceName[] =
    L"GoatCitadelRemoteWorkerProvisioner";
constexpr wchar_t kLocalSystemAccount[] = L"LocalSystem";
constexpr std::uint64_t kStartupMilliseconds = UINT64_C(15000);
constexpr std::uint64_t kRunningMilliseconds = UINT64_C(90000);
constexpr DWORD kCleanupMilliseconds = 5000U;
constexpr DWORD kRunningStatusPollMilliseconds = 1U;
constexpr DWORD kLifecycleWatchdogPollMilliseconds = 50U;
constexpr std::size_t kConfigurationBufferBytes = 8192U;
constexpr std::size_t kTokenBufferBytes = 16384U;
constexpr std::uint32_t kAdministratorServiceMask =
    SERVICE_START | SERVICE_STOP | SERVICE_QUERY_CONFIG |
    SERVICE_QUERY_STATUS | READ_CONTROL | SYNCHRONIZE;

constexpr std::array<std::uint32_t, 1U> kLocalSystemSidParts = {18U};
constexpr std::array<std::uint32_t, 2U> kAdministratorsSidParts = {
    32U,
    544U,
};
constexpr std::array<std::uint32_t, 1U> kServiceLogonSidParts = {6U};
constexpr std::array<std::uint32_t, 5U> kProhibitedLogonSidRids = {
    2U,
    3U,
    4U,
    7U,
    14U,
};
constexpr std::array<std::uint32_t, 6U> kProvisionerServiceSidParts = {
    80U,
    UINT32_C(1765223994),
    UINT32_C(2719708455),
    UINT32_C(3112291649),
    UINT32_C(2938929260),
    UINT32_C(976374647),
};
constexpr wchar_t kExactRequiredPrivileges[] =
    L"SeChangeNotifyPrivilege\0";

template <std::size_t Size>
constexpr bool IsDigestLiteralValid(const char (&value)[Size]) noexcept {
  if (Size != 65U || value[64] != '\0') {
    return false;
  }
  for (std::size_t index = 0U; index < 64U; ++index) {
    const char character = value[index];
    const bool decimal = character >= '0' && character <= '9';
    const bool lower = character >= 'a' && character <= 'f';
    const bool upper = character >= 'A' && character <= 'F';
    if (!decimal && !lower && !upper) {
      return false;
    }
  }
  return true;
}

constexpr std::uint8_t HexNibble(char value) noexcept {
  return value >= '0' && value <= '9'
             ? static_cast<std::uint8_t>(value - '0')
         : value >= 'a' && value <= 'f'
             ? static_cast<std::uint8_t>(value - 'a' + 10)
             : static_cast<std::uint8_t>(value - 'A' + 10);
}

template <std::size_t Size>
constexpr std::uint8_t HexByte(
    const char (&value)[Size],
    std::size_t byte_index) noexcept {
  return static_cast<std::uint8_t>(
      static_cast<std::uint8_t>(HexNibble(value[byte_index * 2U]) << 4U) |
      HexNibble(value[(byte_index * 2U) + 1U]));
}

static_assert(
    IsDigestLiteralValid(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX),
    "GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX must contain exactly 64 hex digits.");

alignas(32) const std::array<std::uint8_t, 32U> kExpectedClientSha256 = {{
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 0U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 1U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 2U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 3U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 4U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 5U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 6U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 7U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 8U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 9U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 10U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 11U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 12U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 13U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 14U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 15U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 16U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 17U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 18U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 19U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 20U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 21U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 22U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 23U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 24U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 25U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 26U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 27U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 28U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 29U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 30U),
    HexByte(GOATCITADEL_EXPECTED_CLIENT_SHA256_HEX, 31U),
}};

static SERVICE_STATUS_HANDLE g_status_handle = nullptr;
static volatile LONG g_stop_disposition = 0;
static volatile LONG g_handler_signal_failure = 0;
static volatile LONG g_handler_inflight = 0;
alignas(8) static volatile LONG64 g_first_stop_deadline = 0;
alignas(8) static volatile LONG64 g_lifecycle_watchdog_deadline = 0;
alignas(8) static volatile LONG64 g_pending_cleanup_deadline = 0;
static volatile LONG g_lifecycle_watchdog_disarmed = 0;
static volatile LONG g_lifecycle_cleanup_publication = 0;
static PVOID volatile g_stop_event = nullptr;
static ServiceTransportState g_transport_state{};

struct WorkerContext final {
  HANDLE completion_event = nullptr;
  HANDLE stop_event = nullptr;
  HANDLE start_event = nullptr;
  HANDLE start_ack_event = nullptr;
  std::uint64_t startup_deadline = 0U;
  volatile LONG result =
      static_cast<LONG>(ServiceTransportResult::CancellationOrReversion);
};

static WorkerContext g_worker_context{};

struct StartupWorkerContext final {
  HANDLE stop_event = nullptr;
  HANDLE progress_event = nullptr;
  HANDLE continue_event = nullptr;
  HANDLE cleanup_event = nullptr;
  std::uint64_t startup_deadline = 0U;
  DWORD argument_count = 0U;
  wchar_t** arguments = nullptr;
  alignas(8) volatile LONG64 running_deadline = 0;
  alignas(8) volatile LONG64 cleanup_deadline = 0;
  alignas(8) volatile LONG64 owner_deadline = 0;
  volatile LONG stage = static_cast<LONG>(StartupStage::Initial);
  volatile LONG result =
      static_cast<LONG>(ServiceTransportResult::CancellationOrReversion);
  volatile LONG transport_touched = 0;
};

class StartupTransportCleanup final {
 public:
  explicit StartupTransportCleanup(StartupWorkerContext* context) noexcept
      : context_(context) {}
  ~StartupTransportCleanup() noexcept {
    if (context_ != nullptr &&
        InterlockedCompareExchange(&context_->transport_touched, 0, 0) != 0 &&
        CloseServiceTransport(&g_transport_state) !=
            ServiceTransportResult::Success) {
      InterlockedExchange(
          &context_->result,
          static_cast<LONG>(
              ServiceTransportResult::CancellationOrReversion));
    }
  }
  StartupTransportCleanup(const StartupTransportCleanup&) = delete;
  StartupTransportCleanup& operator=(const StartupTransportCleanup&) = delete;

 private:
  StartupWorkerContext* context_ = nullptr;
};

class ScopedHandle final {
 public:
  ScopedHandle() noexcept = default;
  explicit ScopedHandle(HANDLE handle) noexcept : handle_(handle) {}
  ~ScopedHandle() noexcept {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
  }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;
  HANDLE get() const noexcept { return handle_; }

 private:
  HANDLE handle_ = nullptr;
};

class ScopedServiceHandle final {
 public:
  ScopedServiceHandle() noexcept = default;
  explicit ScopedServiceHandle(SC_HANDLE handle) noexcept : handle_(handle) {}
  ~ScopedServiceHandle() noexcept {
    if (handle_ != nullptr) {
      CloseServiceHandle(handle_);
    }
  }
  ScopedServiceHandle(const ScopedServiceHandle&) = delete;
  ScopedServiceHandle& operator=(const ScopedServiceHandle&) = delete;
  SC_HANDLE get() const noexcept { return handle_; }

 private:
  SC_HANDLE handle_ = nullptr;
};

bool IsCommandLineWhitespace(wchar_t value) noexcept {
  return value == L' ' || value == L'\t';
}

bool EqualFixedWideString(
    const FixedWideString& left,
    const FixedWideString& right) noexcept {
  if (left.length != right.length || left.length > left.value.size() ||
      right.length > right.value.size()) {
    return false;
  }
  for (std::size_t index = 0U; index < left.length; ++index) {
    if (left.value[index] != right.value[index]) {
      return false;
    }
  }
  return true;
}

bool EqualLiteral(
    const FixedWideString& value,
    const wchar_t* literal) noexcept {
  if (literal == nullptr || value.length > value.value.size()) {
    return false;
  }
  std::size_t index = 0U;
  while (index < value.length && literal[index] != L'\0') {
    if (value.value[index] != literal[index]) {
      return false;
    }
    ++index;
  }
  return index == value.length && literal[index] == L'\0';
}

bool EqualWideLiteral(
    const wchar_t* value,
    const wchar_t* literal) noexcept {
  if (value == nullptr || literal == nullptr) {
    return false;
  }
  std::size_t index = 0U;
  while (value[index] != L'\0' && literal[index] != L'\0') {
    if (value[index] != literal[index]) {
      return false;
    }
    ++index;
  }
  return value[index] == L'\0' && literal[index] == L'\0';
}

bool IsBoundedQuotedDosImagePath(
    const FixedWideString& path) noexcept {
  if (path.length < 7U || path.length >= path.value.size() ||
      path.value[0] != L'"' || path.value[path.length - 1U] != L'"' ||
      path.value[path.length] != L'\0' || path.value[2] != L':' ||
      path.value[3] != L'\\') {
    return false;
  }
  const wchar_t drive = path.value[1];
  if (!((drive >= L'A' && drive <= L'Z') ||
        (drive >= L'a' && drive <= L'z'))) {
    return false;
  }
  for (std::size_t index = 1U; index + 1U < path.length; ++index) {
    if (path.value[index] == L'\0' || path.value[index] == L'"') {
      return false;
    }
  }
  return true;
}

SidSnapshot MakeNtSidSnapshot(
    const std::uint32_t* subauthorities,
    std::size_t count) noexcept {
  SidSnapshot sid{};
  if (subauthorities == nullptr || count == 0U || count > 15U ||
      8U + (count * 4U) > sid.bytes.size()) {
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

bool EqualSidSnapshot(
    const SidSnapshot& left,
    const SidSnapshot& right) noexcept {
  if (left.length == 0U || left.length != right.length ||
      left.length > left.bytes.size() || right.length > right.bytes.size()) {
    return false;
  }
  for (std::size_t index = 0U; index < left.length; ++index) {
    if (left.bytes[index] != right.bytes[index]) {
      return false;
    }
  }
  return true;
}

bool IsRequiredPrivilegeListExact(
    const ServiceIdentitySnapshot& snapshot) noexcept {
  constexpr std::size_t kRequiredCharacters =
      sizeof(kExactRequiredPrivileges) / sizeof(kExactRequiredPrivileges[0]);
  if (snapshot.required_privilege_characters != kRequiredCharacters ||
      kRequiredCharacters > snapshot.required_privileges.size()) {
    return false;
  }
  for (std::size_t index = 0U; index < kRequiredCharacters; ++index) {
    if (snapshot.required_privileges[index] !=
        kExactRequiredPrivileges[index]) {
      return false;
    }
  }
  return true;
}

bool IsDeadlineExpired(std::uint64_t deadline_ms) noexcept {
  return GetTickCount64() >= deadline_ms;
}

DWORD RemainingDeadlineMilliseconds(std::uint64_t deadline_ms) noexcept {
  return BoundedDeadlineWaitMillisecondsAt(GetTickCount64(), deadline_ms);
}

std::uint64_t AddDeadline(
    std::uint64_t start_ms,
    std::uint64_t duration_ms) noexcept {
  return start_ms > UINT64_MAX - duration_ms
             ? UINT64_MAX
             : start_ms + duration_ms;
}

std::uint64_t LoadFirstStopDeadline() noexcept {
  return static_cast<std::uint64_t>(
      InterlockedCompareExchange64(&g_first_stop_deadline, 0, 0));
}

bool StopControlWon() noexcept {
  return LoadFirstStopDeadline() != 0U;
}

void WakeLifecycleWatchdog(HANDLE update_event) noexcept {
  if (update_event != nullptr && SetEvent(update_event) == FALSE) {
    InterlockedExchange(&g_handler_signal_failure, 1);
  }
}

void PublishLifecycleWatchdogDeadline(
    std::uint64_t deadline,
    HANDLE update_event) noexcept {
  if (deadline == 0U) {
    return;
  }
  const LONG publication = InterlockedCompareExchange(
      &g_lifecycle_cleanup_publication, 0, 0);
  if (publication == 0) {
    InterlockedExchange64(
        &g_pending_cleanup_deadline,
        static_cast<LONG64>(deadline));
    InterlockedExchange64(
        &g_lifecycle_watchdog_deadline,
        static_cast<LONG64>(deadline));
    InterlockedExchange(&g_lifecycle_cleanup_publication, 1);
    InterlockedExchange64(&g_pending_cleanup_deadline, 0);
    WakeLifecycleWatchdog(update_event);
    return;
  }
  for (;;) {
    const LONG64 current = InterlockedCompareExchange64(
        &g_lifecycle_watchdog_deadline, 0, 0);
    if (current != 0 &&
        static_cast<std::uint64_t>(current) <= deadline) {
      break;
    }
    if (InterlockedCompareExchange64(
            &g_lifecycle_watchdog_deadline,
            static_cast<LONG64>(deadline),
            current) == current) {
      break;
    }
  }
  WakeLifecycleWatchdog(update_event);
}

void SuspendLifecycleWatchdogAfterStartup(
    std::uint64_t startup_deadline,
    HANDLE update_event) noexcept {
  if (InterlockedCompareExchange(
          &g_lifecycle_cleanup_publication, 0, 0) == 0) {
    InterlockedCompareExchange64(
        &g_lifecycle_watchdog_deadline,
        0,
        static_cast<LONG64>(startup_deadline));
  }
  WakeLifecycleWatchdog(update_event);
}

std::uint64_t LoadEffectiveLifecycleWatchdogDeadline() noexcept {
  for (;;) {
    const LONG publication_before = InterlockedCompareExchange(
        &g_lifecycle_cleanup_publication, 0, 0);
    const std::uint64_t pending_cleanup_deadline =
        static_cast<std::uint64_t>(InterlockedCompareExchange64(
            &g_pending_cleanup_deadline, 0, 0));
    const std::uint64_t configured_deadline =
        static_cast<std::uint64_t>(InterlockedCompareExchange64(
            &g_lifecycle_watchdog_deadline, 0, 0));
    const std::uint64_t first_stop_deadline = LoadFirstStopDeadline();
    const LONG publication_after = InterlockedCompareExchange(
        &g_lifecycle_cleanup_publication, 0, 0);
    if (publication_before != publication_after) {
      continue;
    }
    return SelectLifecycleWatchdogSnapshotDeadline(
        configured_deadline,
        first_stop_deadline,
        publication_after != 0,
        pending_cleanup_deadline);
  }
}

std::uint64_t EnsureLifecycleCleanupDeadline(
    std::uint64_t existing_deadline) noexcept {
  return SelectLifecycleCleanupDeadline(
      existing_deadline, LoadFirstStopDeadline(), GetTickCount64());
}

void PublishLifecycleCleanupDeadline(
    StartupWorkerContext* context,
    std::uint64_t deadline,
    HANDLE watchdog_update_event) noexcept {
  if (context != nullptr && deadline != 0U) {
    InterlockedCompareExchange64(
        &context->cleanup_deadline,
        static_cast<LONG64>(deadline),
        0);
  }
  PublishLifecycleWatchdogDeadline(deadline, watchdog_update_event);
}

bool CopySidToSnapshot(PSID sid, SidSnapshot* output) noexcept {
  if (sid == nullptr || output == nullptr || IsValidSid(sid) == FALSE) {
    return false;
  }
  const DWORD length = GetLengthSid(sid);
  if (length == 0U ||
      static_cast<std::size_t>(length) > output->bytes.size()) {
    return false;
  }
  output->length = static_cast<std::size_t>(length);
  const auto* source = static_cast<const std::uint8_t*>(sid);
  for (std::size_t index = 0U; index < output->length; ++index) {
    output->bytes[index] = source[index];
  }
  return true;
}

bool PointerRangeInsideBuffer(
    const void* pointer,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    std::size_t required_bytes) noexcept {
  if (pointer == nullptr || buffer == nullptr || required_bytes > buffer_bytes) {
    return false;
  }
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(buffer);
  const std::uintptr_t end = start + buffer_bytes;
  const std::uintptr_t value = reinterpret_cast<std::uintptr_t>(pointer);
  return end >= start && value >= start && value <= end - required_bytes;
}

bool CopyWideStringFromBuffer(
    const wchar_t* source,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    FixedWideString* output) noexcept {
  if (source == nullptr || output == nullptr ||
      !PointerRangeInsideBuffer(source, buffer, buffer_bytes, sizeof(wchar_t))) {
    return false;
  }
  const std::uintptr_t end = reinterpret_cast<std::uintptr_t>(buffer) +
                             buffer_bytes;
  std::size_t length = 0U;
  while (length < output->value.size()) {
    const wchar_t* current = source + length;
    const std::uintptr_t current_address =
        reinterpret_cast<std::uintptr_t>(current);
    if (current_address > end - sizeof(wchar_t)) {
      return false;
    }
    if (*current == L'\0') {
      output->length = length;
      return true;
    }
    output->value[length] = *current;
    ++length;
  }
  return false;
}

bool IsNullOrEmptyStringInBuffer(
    const wchar_t* source,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes) noexcept {
  return source == nullptr ||
         (PointerRangeInsideBuffer(
              source,
              buffer,
              buffer_bytes,
              sizeof(wchar_t)) &&
          *source == L'\0');
}

bool CopyRequiredPrivilegesFromBuffer(
    const wchar_t* source,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    ServiceIdentitySnapshot* snapshot) noexcept {
  if (source == nullptr || snapshot == nullptr ||
      !PointerRangeInsideBuffer(source, buffer, buffer_bytes, 2U * sizeof(wchar_t))) {
    return false;
  }
  const std::uintptr_t end = reinterpret_cast<std::uintptr_t>(buffer) +
                             buffer_bytes;
  bool previous_was_null = false;
  for (std::size_t index = 0U;
       index < snapshot->required_privileges.size();
       ++index) {
    const wchar_t* current = source + index;
    const std::uintptr_t current_address =
        reinterpret_cast<std::uintptr_t>(current);
    if (current_address > end - sizeof(wchar_t)) {
      return false;
    }
    const wchar_t value = *current;
    snapshot->required_privileges[index] = value;
    if (value == L'\0' && previous_was_null) {
      snapshot->required_privilege_characters = index + 1U;
      return true;
    }
    previous_was_null = value == L'\0';
  }
  return false;
}

bool QueryServiceConfig2IntoBuffer(
    SC_HANDLE service,
    DWORD information_level,
    std::array<std::uint8_t, kConfigurationBufferBytes>* buffer,
    DWORD minimum_bytes,
    DWORD* returned_bytes) noexcept {
  if (service == nullptr || buffer == nullptr || returned_bytes == nullptr) {
    return false;
  }
  buffer->fill(0U);
  DWORD required = 0U;
  if (QueryServiceConfig2W(
          service,
          information_level,
          buffer->data(),
          static_cast<DWORD>(buffer->size()),
          &required) == FALSE ||
      required < minimum_bytes || required > buffer->size()) {
    return false;
  }
  *returned_bytes = required;
  return true;
}

bool CollectConfiguredService(
    SC_HANDLE service,
    ServiceIdentitySnapshot* snapshot) noexcept {
  if (service == nullptr || snapshot == nullptr) {
    return false;
  }
  alignas(16) std::array<std::uint8_t, kConfigurationBufferBytes> buffer{};
  DWORD required = 0U;
  if (QueryServiceConfigW(
          service,
          reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.data()),
          static_cast<DWORD>(buffer.size()),
          &required) == FALSE ||
      required < sizeof(QUERY_SERVICE_CONFIGW) || required > buffer.size()) {
    return false;
  }
  const auto* configuration =
      reinterpret_cast<const QUERY_SERVICE_CONFIGW*>(buffer.data());
  snapshot->configured_service_type = configuration->dwServiceType;
  snapshot->configured_start_type = configuration->dwStartType;
  snapshot->configured_error_control = configuration->dwErrorControl;
  if (!CopyWideStringFromBuffer(
          configuration->lpBinaryPathName,
          buffer.data(),
          required,
          &snapshot->configured_binary_path) ||
      !CopyWideStringFromBuffer(
          configuration->lpServiceStartName,
          buffer.data(),
          required,
          &snapshot->configured_account_name)) {
    return false;
  }
  snapshot->load_order_group_empty = IsNullOrEmptyStringInBuffer(
      configuration->lpLoadOrderGroup, buffer.data(), required);
  snapshot->dependencies_empty = IsNullOrEmptyStringInBuffer(
      configuration->lpDependencies, buffer.data(), required);

  DWORD returned = 0U;
  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_TRIGGER_INFO,
          &buffer,
          sizeof(SERVICE_TRIGGER_INFO),
          &returned)) {
    return false;
  }
  const auto* trigger_info =
      reinterpret_cast<const SERVICE_TRIGGER_INFO*>(buffer.data());
  snapshot->triggers_empty =
      trigger_info->cTriggers == 0U && trigger_info->pTriggers == nullptr &&
      trigger_info->pReserved == nullptr;

  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_FAILURE_ACTIONS,
          &buffer,
          sizeof(SERVICE_FAILURE_ACTIONSW),
          &returned)) {
    return false;
  }
  const auto* failure_actions =
      reinterpret_cast<const SERVICE_FAILURE_ACTIONSW*>(buffer.data());
  snapshot->failure_actions_empty =
      failure_actions->dwResetPeriod == 0U &&
      failure_actions->lpRebootMsg == nullptr &&
      failure_actions->lpCommand == nullptr &&
      failure_actions->cActions == 0U &&
      failure_actions->lpsaActions == nullptr;

  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_FAILURE_ACTIONS_FLAG,
          &buffer,
          sizeof(SERVICE_FAILURE_ACTIONS_FLAG),
          &returned)) {
    return false;
  }
  const auto* failure_flag =
      reinterpret_cast<const SERVICE_FAILURE_ACTIONS_FLAG*>(buffer.data());
  snapshot->failure_actions_on_non_crash_disabled =
      failure_flag->fFailureActionsOnNonCrashFailures == FALSE;

  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_DELAYED_AUTO_START_INFO,
          &buffer,
          sizeof(SERVICE_DELAYED_AUTO_START_INFO),
          &returned)) {
    return false;
  }
  const auto* delayed =
      reinterpret_cast<const SERVICE_DELAYED_AUTO_START_INFO*>(buffer.data());
  snapshot->delayed_auto_start_disabled = delayed->fDelayedAutostart == FALSE;

  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_SERVICE_SID_INFO,
          &buffer,
          sizeof(SERVICE_SID_INFO),
          &returned)) {
    return false;
  }
  const auto* sid_info =
      reinterpret_cast<const SERVICE_SID_INFO*>(buffer.data());
  snapshot->configured_service_sid_type = sid_info->dwServiceSidType;

  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO,
          &buffer,
          sizeof(SERVICE_REQUIRED_PRIVILEGES_INFOW),
          &returned)) {
    return false;
  }
  const auto* privileges =
      reinterpret_cast<const SERVICE_REQUIRED_PRIVILEGES_INFOW*>(buffer.data());
  return CopyRequiredPrivilegesFromBuffer(
      privileges->pmszRequiredPrivileges,
      buffer.data(),
      returned,
      snapshot);
}

bool CollectServiceObjectSecurity(
    SC_HANDLE service,
    ServiceIdentitySnapshot* snapshot) noexcept {
  if (service == nullptr || snapshot == nullptr) {
    return false;
  }
  alignas(16) std::array<std::uint8_t, kConfigurationBufferBytes> buffer{};
  DWORD required = 0U;
  if (QueryServiceObjectSecurity(
          service,
          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.data()),
          static_cast<DWORD>(buffer.size()),
          &required) == FALSE ||
      required == 0U || required > buffer.size()) {
    return false;
  }
  auto* descriptor = reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.data());
  if (IsValidSecurityDescriptor(descriptor) == FALSE) {
    return false;
  }
  PSID owner = nullptr;
  BOOL owner_defaulted = TRUE;
  if (GetSecurityDescriptorOwner(descriptor, &owner, &owner_defaulted) == FALSE ||
      owner_defaulted != FALSE ||
      !CopySidToSnapshot(owner, &snapshot->service_object_owner)) {
    return false;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
  if (GetSecurityDescriptorControl(descriptor, &control, &revision) == FALSE) {
    return false;
  }
  snapshot->service_dacl_protected = (control & SE_DACL_PROTECTED) != 0U;
  snapshot->service_dacl_non_inheriting =
      (control & (SE_DACL_AUTO_INHERIT_REQ | SE_DACL_AUTO_INHERITED)) == 0U;

  PACL dacl = nullptr;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = TRUE;
  if (GetSecurityDescriptorDacl(
          descriptor,
          &dacl_present,
          &dacl,
          &dacl_defaulted) == FALSE) {
    return false;
  }
  snapshot->service_dacl_present = dacl_present != FALSE && dacl != nullptr;
  snapshot->service_dacl_defaulted = dacl_defaulted != FALSE;
  if (!snapshot->service_dacl_present || IsValidAcl(dacl) == FALSE ||
      dacl->AceCount > snapshot->service_aces.size()) {
    return false;
  }
  snapshot->service_ace_count = dacl->AceCount;
  for (std::size_t index = 0U; index < snapshot->service_ace_count; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, static_cast<DWORD>(index), &raw_ace) == FALSE ||
        raw_ace == nullptr) {
      return false;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    auto& ace = snapshot->service_aces[index];
    ace.type = header->AceType;
    ace.flags = header->AceFlags;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
        header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) {
      continue;
    }
    const auto* allowed = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    ace.mask = allowed->Mask;
    if (!CopySidToSnapshot(
            const_cast<DWORD*>(&allowed->SidStart),
            &ace.sid)) {
      return false;
    }
  }
  return true;
}

bool QueryTokenInformationFixed(
    HANDLE token,
    TOKEN_INFORMATION_CLASS information_class,
    std::array<std::uint8_t, kTokenBufferBytes>* buffer,
    DWORD minimum_bytes,
    DWORD* returned_bytes) noexcept {
  if (token == nullptr || buffer == nullptr || returned_bytes == nullptr) {
    return false;
  }
  buffer->fill(0U);
  DWORD required = 0U;
  if (GetTokenInformation(
          token,
          information_class,
          buffer->data(),
          static_cast<DWORD>(buffer->size()),
          &required) == FALSE ||
      required < minimum_bytes || required > buffer->size()) {
    return false;
  }
  *returned_bytes = required;
  return true;
}

bool CollectProcessToken(ServiceIdentitySnapshot* snapshot) noexcept {
  if (snapshot == nullptr) {
    return false;
  }
  HANDLE raw_token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token) == FALSE) {
    return false;
  }
  const ScopedHandle token(raw_token);
  alignas(16) std::array<std::uint8_t, kTokenBufferBytes> buffer{};
  DWORD returned = 0U;

  if (!QueryTokenInformationFixed(
          token.get(), TokenUser, &buffer, sizeof(TOKEN_USER), &returned)) {
    return false;
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  if (!CopySidToSnapshot(user->User.Sid, &snapshot->token_user)) {
    return false;
  }

  if (!QueryTokenInformationFixed(
          token.get(), TokenType, &buffer, sizeof(TOKEN_TYPE), &returned)) {
    return false;
  }
  snapshot->token_type = static_cast<std::uint32_t>(
      *reinterpret_cast<const TOKEN_TYPE*>(buffer.data()));

  if (!QueryTokenInformationFixed(
          token.get(), TokenSessionId, &buffer, sizeof(DWORD), &returned)) {
    return false;
  }
  snapshot->token_session_id =
      *reinterpret_cast<const DWORD*>(buffer.data());

  if (!QueryTokenInformationFixed(
          token.get(), TokenHasRestrictions, &buffer, sizeof(BOOLEAN), &returned) ||
      !DecodeTokenHasRestrictions(
          buffer.data(), returned, &snapshot->token_unrestricted)) {
    return false;
  }

  if (!QueryTokenInformationFixed(
          token.get(), TokenIsAppContainer, &buffer, sizeof(DWORD), &returned)) {
    return false;
  }
  snapshot->token_non_appcontainer =
      *reinterpret_cast<const DWORD*>(buffer.data()) == 0U;

  if (!QueryTokenInformationFixed(
          token.get(),
          TokenRestrictedSids,
          &buffer,
          static_cast<DWORD>(offsetof(TOKEN_GROUPS, Groups)),
          &returned)) {
    return false;
  }
  const auto* restricted =
      reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  snapshot->restricted_sid_count = restricted->GroupCount;

  if (!QueryTokenInformationFixed(
          token.get(), TokenGroups, &buffer, sizeof(TOKEN_GROUPS), &returned)) {
    return false;
  }
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  if (groups->GroupCount > snapshot->token_groups.size()) {
    return false;
  }
  const std::size_t required_group_bytes =
      offsetof(TOKEN_GROUPS, Groups) +
      (static_cast<std::size_t>(groups->GroupCount) * sizeof(SID_AND_ATTRIBUTES));
  if (required_group_bytes > returned) {
    return false;
  }
  snapshot->token_group_count = groups->GroupCount;
  for (std::size_t index = 0U; index < snapshot->token_group_count; ++index) {
    snapshot->token_groups[index].attributes = groups->Groups[index].Attributes;
    if (!CopySidToSnapshot(
            groups->Groups[index].Sid,
            &snapshot->token_groups[index].sid)) {
      return false;
    }
  }

  if (!QueryTokenInformationFixed(
          token.get(),
          TokenPrivileges,
          &buffer,
          sizeof(TOKEN_PRIVILEGES),
          &returned)) {
    return false;
  }
  const auto* privileges =
      reinterpret_cast<const TOKEN_PRIVILEGES*>(buffer.data());
  if (privileges->PrivilegeCount > snapshot->token_privileges.size()) {
    return false;
  }
  const std::size_t required_privilege_bytes =
      offsetof(TOKEN_PRIVILEGES, Privileges) +
      (static_cast<std::size_t>(privileges->PrivilegeCount) *
       sizeof(LUID_AND_ATTRIBUTES));
  if (required_privilege_bytes > returned) {
    return false;
  }
  snapshot->token_privilege_count = privileges->PrivilegeCount;
  for (std::size_t index = 0U;
       index < snapshot->token_privilege_count;
       ++index) {
    snapshot->token_privileges[index] = {
        privileges->Privileges[index].Luid.LowPart,
        privileges->Privileges[index].Luid.HighPart,
        privileges->Privileges[index].Attributes,
    };
  }

  LUID change_notify{};
  if (LookupPrivilegeValueW(nullptr, SE_CHANGE_NOTIFY_NAME, &change_notify) == FALSE) {
    return false;
  }
  snapshot->change_notify_luid_low_part = change_notify.LowPart;
  snapshot->change_notify_luid_high_part = change_notify.HighPart;

  HANDLE thread_token = nullptr;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(
          GetCurrentThread(),
          TOKEN_QUERY,
          FALSE,
          &thread_token) != FALSE) {
    CloseHandle(thread_token);
    snapshot->current_thread_has_no_token = false;
  } else if (GetLastError() == ERROR_NO_TOKEN) {
    snapshot->current_thread_has_no_token = true;
  } else {
    return false;
  }
  return true;
}

bool CollectServiceIdentitySnapshot(
    DWORD argument_count,
    wchar_t** arguments,
    SC_HANDLE service,
    ServiceIdentitySnapshot* snapshot) noexcept {
  if (service == nullptr || snapshot == nullptr) {
    return false;
  }
  snapshot->exact_service_main_arguments =
      argument_count == 1U && arguments != nullptr &&
      arguments[0] != nullptr &&
      EqualWideLiteral(arguments[0], kRuntimeServiceName);
  snapshot->current_process_id = GetCurrentProcessId();
  return CollectConfiguredService(service, snapshot) &&
         CollectServiceObjectSecurity(service, snapshot) &&
         CollectProcessToken(snapshot);
}

SERVICE_STATUS ToNativeStatus(const ServiceStatusSnapshot& snapshot) noexcept {
  SERVICE_STATUS status{};
  status.dwServiceType = snapshot.service_type;
  status.dwCurrentState = snapshot.current_state;
  status.dwControlsAccepted = snapshot.controls_accepted;
  status.dwWin32ExitCode = snapshot.win32_exit_code;
  status.dwServiceSpecificExitCode = snapshot.service_specific_exit_code;
  status.dwCheckPoint = snapshot.checkpoint;
  status.dwWaitHint = snapshot.wait_hint;
  return status;
}

bool ReportServiceStatus(
    ServiceStatusPhase phase,
    std::uint32_t checkpoint,
    std::uint32_t final_code) noexcept {
  if (g_status_handle == nullptr) {
    return false;
  }
  SERVICE_STATUS status = ToNativeStatus(
      BuildServiceStatusSnapshot(phase, checkpoint, final_code));
  return SetServiceStatus(g_status_handle, &status) != FALSE;
}

__declspec(noreturn) void FailFastServiceProcess() noexcept {
  TerminateProcess(
      GetCurrentProcess(),
      static_cast<UINT>(ServiceTransportResult::CancellationOrReversion));
  for (;;) {
  }
}

DWORD WINAPI LifecycleWatchdogWorker(void* raw_update_event) noexcept {
  HANDLE update_event = static_cast<HANDLE>(raw_update_event);
  if (update_event == nullptr) {
    FailFastServiceProcess();
  }
  for (;;) {
    if (InterlockedCompareExchange(
            &g_lifecycle_watchdog_disarmed, 0, 0) != 0) {
      return 0U;
    }
    const std::uint64_t effective_deadline =
        LoadEffectiveLifecycleWatchdogDeadline();
    DWORD wait_milliseconds = kLifecycleWatchdogPollMilliseconds;
    if (effective_deadline != 0U) {
      const DWORD remaining =
          RemainingDeadlineMilliseconds(effective_deadline);
      if (remaining == 0U) {
        if (InterlockedCompareExchange(
                &g_lifecycle_watchdog_disarmed, 0, 0) != 0) {
          return 0U;
        }
        const std::uint64_t refreshed_deadline =
            LoadEffectiveLifecycleWatchdogDeadline();
        if (refreshed_deadline != 0U &&
            IsDeadlineExpired(refreshed_deadline)) {
          FailFastServiceProcess();
        }
        continue;
      }
      if (remaining < wait_milliseconds) {
        wait_milliseconds = remaining;
      }
    }
    const DWORD wait_result =
        WaitForSingleObject(update_event, wait_milliseconds);
    if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_TIMEOUT) {
      FailFastServiceProcess();
    }
  }
}

DWORD WINAPI ServiceControlHandler(
    DWORD control,
    DWORD,
    void*,
    void*) noexcept {
  InterlockedIncrement(&g_handler_inflight);
  DWORD result = ERROR_CALL_NOT_IMPLEMENTED;
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
    const std::uint64_t candidate_deadline = AddDeadline(
        GetTickCount64(), kCleanupMilliseconds);
    const LONG64 previous_deadline = InterlockedCompareExchange64(
        &g_first_stop_deadline,
        static_cast<LONG64>(candidate_deadline),
        0);
    const StopControlPublicationDisposition publication =
        ClassifyStopControlPublication(
            static_cast<std::uint64_t>(previous_deadline),
            static_cast<std::uint32_t>(InterlockedCompareExchange(
                &g_stop_disposition, 0, 0)));
    if (publication == StopControlPublicationDisposition::FirstControl) {
      InterlockedExchange(
          &g_stop_disposition, static_cast<LONG>(control));
    }
    if (publication != StopControlPublicationDisposition::RepeatPending) {
      HANDLE stop_event = static_cast<HANDLE>(
          InterlockedCompareExchangePointer(&g_stop_event, nullptr, nullptr));
      if (stop_event != nullptr && SetEvent(stop_event) == FALSE) {
        InterlockedExchange(&g_handler_signal_failure, 1);
      }
    }
    result = NO_ERROR;
  } else if (control == SERVICE_CONTROL_INTERROGATE) {
    result = NO_ERROR;
  }
  InterlockedDecrement(&g_handler_inflight);
  return result;
}

DWORD WINAPI ServiceTransportWorker(void*) noexcept {
  ServiceTransportResult result =
      ServiceTransportResult::CancellationOrReversion;
  if (g_worker_context.stop_event != nullptr &&
      g_worker_context.start_event != nullptr &&
      g_worker_context.start_ack_event != nullptr &&
      g_worker_context.startup_deadline != 0U) {
    const std::array<HANDLE, 2U> waits = {
        g_worker_context.stop_event,
        g_worker_context.start_event,
    };
    const DWORD remaining = RemainingDeadlineMilliseconds(
        g_worker_context.startup_deadline);
    const DWORD wait_result = WaitForMultipleObjects(
        static_cast<DWORD>(waits.size()),
        waits.data(),
        FALSE,
        remaining);
    if (wait_result == WAIT_OBJECT_0 + 1U &&
        SetEvent(g_worker_context.start_ack_event) == FALSE) {
      result = ServiceTransportResult::CancellationOrReversion;
    } else {
      const bool stop_observed =
          StopControlWon() ||
          WaitForSingleObject(g_worker_context.stop_event, 0U) ==
              WAIT_OBJECT_0;
      const bool deadline_expired =
          IsDeadlineExpired(g_worker_context.startup_deadline);
      if (ShouldRunServiceTransportAfterStartGate(
              wait_result, stop_observed, deadline_expired)) {
        result = RunServiceTransport(&g_transport_state);
      } else if (stop_observed || wait_result == WAIT_OBJECT_0) {
        result = ServiceTransportResult::Success;
      } else if (deadline_expired || wait_result == WAIT_TIMEOUT) {
        result = ServiceTransportResult::Deadline;
      }
    }
  }
  InterlockedExchange(&g_worker_context.result, static_cast<LONG>(result));
  if (g_worker_context.completion_event == nullptr ||
      SetEvent(g_worker_context.completion_event) == FALSE) {
    InterlockedExchange(
        &g_worker_context.result,
        static_cast<LONG>(ServiceTransportResult::CancellationOrReversion));
  }
  return 0U;
}

std::uint32_t TransportResultCode(ServiceTransportResult result) noexcept {
  return static_cast<std::uint32_t>(result);
}

enum class RunningStatusResult : std::uint8_t {
  Valid,
  Stop,
  Deadline,
  IdentityMismatch,
  Failed,
};

StartupStage LoadStartupStage(const StartupWorkerContext& context) noexcept {
  return static_cast<StartupStage>(InterlockedCompareExchange(
      const_cast<volatile LONG*>(&context.stage), 0, 0));
}

bool AdvanceStartupStage(
    StartupWorkerContext* context,
    StartupStage current,
    StartupStage next,
    bool signal_progress) noexcept {
  if (context == nullptr || !IsValidStartupStageTransition(current, next) ||
      InterlockedCompareExchange(
          &context->stage,
          static_cast<LONG>(next),
          static_cast<LONG>(current)) != static_cast<LONG>(current)) {
    return false;
  }
  return !signal_progress ||
         (context->progress_event != nullptr &&
          SetEvent(context->progress_event) != FALSE);
}

DWORD FinishStartupWorker(
    StartupWorkerContext* context,
    std::uint32_t result) noexcept {
  if (context != nullptr) {
    InterlockedExchange(&context->result, static_cast<LONG>(result));
  }
  return 0U;
}

void WaitForLifecycleCleanupSignal(
    const StartupWorkerContext& context,
    std::uint64_t deadline) noexcept {
  const DWORD remaining = BoundedDeadlineWaitMillisecondsAt(
      GetTickCount64(), deadline);
  if (deadline == 0U || remaining == 0U ||
      WaitForSingleObject(context.cleanup_event, remaining) != WAIT_OBJECT_0) {
    FailFastServiceProcess();
  }
}

DWORD FinishStoppedStartupWorker(
    StartupWorkerContext* context) noexcept {
  if (context == nullptr) {
    FailFastServiceProcess();
  }
  InterlockedExchange(&context->result, 0);
  std::uint64_t cleanup_deadline = static_cast<std::uint64_t>(
      InterlockedCompareExchange64(&context->cleanup_deadline, 0, 0));
  if (cleanup_deadline == 0U) {
    cleanup_deadline = LoadFirstStopDeadline();
  }
  if (cleanup_deadline == 0U) {
    cleanup_deadline = context->startup_deadline;
  }
  WaitForLifecycleCleanupSignal(*context, cleanup_deadline);
  return 0U;
}

StartupGateDisposition WaitForStartupContinue(
    const StartupWorkerContext& context) noexcept {
  if (StopControlWon() ||
      WaitForSingleObject(context.stop_event, 0U) == WAIT_OBJECT_0) {
    return StartupGateDisposition::Stop;
  }
  const DWORD remaining = RemainingDeadlineMilliseconds(
      context.startup_deadline);
  if (remaining == 0U) {
    return StartupGateDisposition::Deadline;
  }
  const std::array<HANDLE, 2U> waits = {
      context.stop_event,
      context.continue_event,
  };
  const DWORD wait_result = WaitForMultipleObjects(
      static_cast<DWORD>(waits.size()),
      waits.data(),
      FALSE,
      remaining);
  const bool stop_observed =
      StopControlWon() ||
      WaitForSingleObject(context.stop_event, 0U) == WAIT_OBJECT_0;
  return ClassifyStartupGateWait(
      wait_result,
      stop_observed,
      IsDeadlineExpired(context.startup_deadline));
}

RunningStatusResult WaitForExactRunningServiceStatus(
    SC_HANDLE service,
    HANDLE stop_event,
    std::uint64_t startup_deadline) noexcept {
  if (service == nullptr || stop_event == nullptr) {
    return RunningStatusResult::Failed;
  }
  for (;;) {
    if (WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
      return RunningStatusResult::Stop;
    }
    if (IsDeadlineExpired(startup_deadline)) {
      return RunningStatusResult::Deadline;
    }
    SERVICE_STATUS_PROCESS status{};
    DWORD returned = 0U;
    if (QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            reinterpret_cast<LPBYTE>(&status),
            sizeof(status),
            &returned) == FALSE ||
        returned != sizeof(status)) {
      return RunningStatusResult::IdentityMismatch;
    }
    const RunningServiceStatusSnapshot snapshot = {
        GetCurrentProcessId(),
        status.dwProcessId,
        status.dwServiceType,
        status.dwCurrentState,
        status.dwServiceFlags,
    };
    const RunningServiceStatusDisposition disposition =
        ClassifyRunningServiceStatus(snapshot);
    if (disposition == RunningServiceStatusDisposition::Valid) {
      return RunningStatusResult::Valid;
    }
    if (disposition == RunningServiceStatusDisposition::Mismatch) {
      return RunningStatusResult::IdentityMismatch;
    }
    const DWORD remaining = RemainingDeadlineMilliseconds(startup_deadline);
    if (remaining == 0U) {
      return RunningStatusResult::Deadline;
    }
    const DWORD poll = remaining < kRunningStatusPollMilliseconds
                           ? remaining
                           : kRunningStatusPollMilliseconds;
    const DWORD wait_result = WaitForSingleObject(stop_event, poll);
    if (wait_result == WAIT_OBJECT_0) {
      return RunningStatusResult::Stop;
    }
    if (wait_result != WAIT_TIMEOUT) {
      return RunningStatusResult::Failed;
    }
  }
}

DWORD WINAPI ServiceStartupWorker(void* raw_context) noexcept {
  auto* context = static_cast<StartupWorkerContext*>(raw_context);
  StartupTransportCleanup cleanup(context);
  if (context == nullptr || context->stop_event == nullptr ||
      context->progress_event == nullptr || context->continue_event == nullptr ||
      context->cleanup_event == nullptr ||
      context->startup_deadline == 0U) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }
  if (WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0) {
    return FinishStoppedStartupWorker(context);
  }

  const ScopedServiceHandle manager(
      OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT));
  if (manager.get() == nullptr) {
    return FinishStartupWorker(
        context,
        static_cast<std::uint32_t>(
            ServiceIdentityValidation::ServiceIdentity));
  }
  const ScopedServiceHandle service(OpenServiceW(
      manager.get(),
      kRuntimeServiceName,
      SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL));
  if (service.get() == nullptr) {
    return FinishStartupWorker(
        context,
        static_cast<std::uint32_t>(
            ServiceIdentityValidation::ServiceIdentity));
  }

  InterlockedExchange(&context->transport_touched, 1);
  FixedWideString expected_binary_path{};
  std::size_t resolved_path_length = 0U;
  const ServiceTransportResult resolve_result = ResolveProtectedServiceBinaryPath(
      &g_transport_state,
      expected_binary_path.value.data(),
      expected_binary_path.value.size(),
      &resolved_path_length);
  if (resolve_result != ServiceTransportResult::Success) {
    return FinishStartupWorker(context, TransportResultCode(resolve_result));
  }
  expected_binary_path.length = resolved_path_length;
  if (IsDeadlineExpired(context->startup_deadline)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::Deadline));
  }
  if (WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0) {
    return FinishStoppedStartupWorker(context);
  }
  if (!IsBoundedQuotedDosImagePath(expected_binary_path)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::ProtectedImage));
  }

  ServiceIdentitySnapshot identity{};
  if (!CollectServiceIdentitySnapshot(
          context->argument_count,
          context->arguments,
          service.get(),
          &identity)) {
    return FinishStartupWorker(
        context,
        static_cast<std::uint32_t>(
            ServiceIdentityValidation::ServiceIdentity));
  }
  const ServiceIdentityValidation validation =
      ValidateServiceIdentitySnapshot(identity, expected_binary_path);
  if (validation != ServiceIdentityValidation::Valid) {
    return FinishStartupWorker(
        context, static_cast<std::uint32_t>(validation));
  }
  if (IsDeadlineExpired(context->startup_deadline)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::Deadline));
  }
  if (WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0) {
    return FinishStoppedStartupWorker(context);
  }
  if (!AdvanceStartupStage(
          context,
          StartupStage::Initial,
          StartupStage::IdentityValidated,
          true)) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }
  StartupGateDisposition gate = WaitForStartupContinue(*context);
  if (gate != StartupGateDisposition::Continue) {
    if (gate == StartupGateDisposition::Stop) {
      return FinishStoppedStartupWorker(context);
    }
    return FinishStartupWorker(
        context,
        gate == StartupGateDisposition::Deadline
            ? TransportResultCode(ServiceTransportResult::Deadline)
            : TransportResultCode(
                  ServiceTransportResult::CancellationOrReversion));
  }

  Byte32 service_start_nonce{};
  if (!GenerateRandom32(&service_start_nonce)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::PipeReadiness));
  }
  const ServiceTransportContext transport_context = {
      context->stop_event,
      0U,
      &service_start_nonce,
      &kExpectedClientSha256,
  };
  const ServiceTransportResult image_result =
      ValidateServiceTransportImages(transport_context, &g_transport_state);
  if (image_result != ServiceTransportResult::Success) {
    return FinishStartupWorker(context, TransportResultCode(image_result));
  }
  if (IsDeadlineExpired(context->startup_deadline)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::Deadline));
  }
  if (WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0) {
    return FinishStoppedStartupWorker(context);
  }
  if (!AdvanceStartupStage(
          context,
          StartupStage::IdentityValidated,
          StartupStage::ImagesValidated,
          true)) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }
  gate = WaitForStartupContinue(*context);
  if (gate != StartupGateDisposition::Continue) {
    if (gate == StartupGateDisposition::Stop) {
      return FinishStoppedStartupWorker(context);
    }
    return FinishStartupWorker(
        context,
        gate == StartupGateDisposition::Deadline
            ? TransportResultCode(ServiceTransportResult::Deadline)
            : TransportResultCode(
                  ServiceTransportResult::CancellationOrReversion));
  }
  if (LoadStartupStage(*context) != StartupStage::ImagesValidated) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }
  StartupGateDisposition self_test_state =
      ClassifyPostCheckpointStartupState(
          IsDeadlineExpired(context->startup_deadline),
          StopControlWon() ||
              WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0);
  if (self_test_state == StartupGateDisposition::Stop) {
    return FinishStoppedStartupWorker(context);
  }
  if (self_test_state != StartupGateDisposition::Continue) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::Deadline));
  }
  const bool ed25519_self_test_passed = RunKnownAnswerSelfTest();
  self_test_state = ClassifyPostCheckpointStartupState(
      IsDeadlineExpired(context->startup_deadline),
      StopControlWon() ||
          WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0);
  if (self_test_state == StartupGateDisposition::Stop) {
    return FinishStoppedStartupWorker(context);
  }
  if (self_test_state != StartupGateDisposition::Continue) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::Deadline));
  }
  if (!ed25519_self_test_passed) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::ProtectedImage));
  }
  const ServiceTransportResult recovery_result = RecoverProtectedServiceState(
      &g_transport_state, context->startup_deadline);
  if (recovery_result != ServiceTransportResult::Success) {
    return FinishStartupWorker(context, TransportResultCode(recovery_result));
  }
  const ServiceTransportResult arm_result =
      ArmServiceTransport(&g_transport_state);
  if (arm_result != ServiceTransportResult::Success) {
    return FinishStartupWorker(context, TransportResultCode(arm_result));
  }
  if (IsDeadlineExpired(context->startup_deadline)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::Deadline));
  }
  if (WaitForSingleObject(context->stop_event, 0U) == WAIT_OBJECT_0) {
    return FinishStoppedStartupWorker(context);
  }
  if (!AdvanceStartupStage(
          context,
          StartupStage::ImagesValidated,
          StartupStage::TransportArmed,
          true)) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }
  gate = WaitForStartupContinue(*context);
  if (gate != StartupGateDisposition::Continue) {
    if (gate == StartupGateDisposition::Stop) {
      return FinishStoppedStartupWorker(context);
    }
    return FinishStartupWorker(
        context,
        gate == StartupGateDisposition::Deadline
            ? TransportResultCode(ServiceTransportResult::Deadline)
            : TransportResultCode(
                  ServiceTransportResult::CancellationOrReversion));
  }
  if (LoadStartupStage(*context) != StartupStage::RunningReported) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }

  const RunningStatusResult running_status = WaitForExactRunningServiceStatus(
      service.get(), context->stop_event, context->startup_deadline);
  if (running_status != RunningStatusResult::Valid) {
    if (running_status == RunningStatusResult::Stop) {
      return FinishStoppedStartupWorker(context);
    }
    return FinishStartupWorker(
        context,
        running_status == RunningStatusResult::Deadline
            ? TransportResultCode(ServiceTransportResult::Deadline)
            : running_status == RunningStatusResult::IdentityMismatch
                  ? static_cast<std::uint32_t>(
                        ServiceIdentityValidation::ServiceIdentity)
                  : TransportResultCode(
                        ServiceTransportResult::CancellationOrReversion));
  }
  const std::uint64_t running_deadline = static_cast<std::uint64_t>(
      InterlockedCompareExchange64(&context->running_deadline, 0, 0));
  if (running_deadline == 0U ||
      !SetServiceTransportRunningDeadline(
          &g_transport_state, running_deadline)) {
    return FinishStartupWorker(
        context, TransportResultCode(ServiceTransportResult::PipeReadiness));
  }
  InterlockedExchange(&context->result, 0);
  if (!AdvanceStartupStage(
          context,
          StartupStage::RunningReported,
          StartupStage::RunningPidValidated,
          true)) {
    return FinishStartupWorker(
        context,
        TransportResultCode(ServiceTransportResult::CancellationOrReversion));
  }
  const std::uint64_t owner_deadline = static_cast<std::uint64_t>(
      InterlockedCompareExchange64(&context->owner_deadline, 0, 0));
  const DWORD owner_wait = BoundedDeadlineWaitMillisecondsAt(
      GetTickCount64(), owner_deadline);
  const std::array<HANDLE, 2U> lifecycle_waits = {
      context->cleanup_event,
      context->stop_event,
  };
  if (owner_deadline == 0U || owner_wait == 0U) {
    FailFastServiceProcess();
  }
  const DWORD lifecycle_wait_result = WaitForMultipleObjects(
      static_cast<DWORD>(lifecycle_waits.size()),
      lifecycle_waits.data(),
      FALSE,
      owner_wait);
  if (lifecycle_wait_result == WAIT_OBJECT_0) {
    return FinishStartupWorker(context, 0U);
  }
  if (lifecycle_wait_result == WAIT_OBJECT_0 + 1U) {
    std::uint64_t stop_deadline = static_cast<std::uint64_t>(
        InterlockedCompareExchange64(&context->cleanup_deadline, 0, 0));
    if (stop_deadline == 0U) {
      stop_deadline = LoadFirstStopDeadline();
    }
    const DWORD stop_wait = BoundedDeadlineWaitMillisecondsAt(
        GetTickCount64(), stop_deadline);
    if (stop_deadline != 0U && stop_wait != 0U &&
        WaitForSingleObject(context->cleanup_event, stop_wait) ==
            WAIT_OBJECT_0) {
      return FinishStartupWorker(context, 0U);
    }
  }
  FailFastServiceProcess();
}

bool ClosePublishedStopEvent(
    HANDLE stop_event,
    std::uint64_t cleanup_deadline) noexcept {
  InterlockedExchangePointer(&g_stop_event, nullptr);
  while (InterlockedCompareExchange(&g_handler_inflight, 0, 0) != 0) {
    if (IsDeadlineExpired(cleanup_deadline)) {
      return false;
    }
    Sleep(1U);
  }
  return stop_event == nullptr || CloseHandle(stop_event) != FALSE;
}

StartupGateDisposition WaitForWorkerStartAcknowledgement(
    HANDLE stop_event,
    HANDLE start_ack_event,
    HANDLE completion_event,
    std::uint64_t startup_deadline) noexcept {
  if (stop_event == nullptr || start_ack_event == nullptr ||
      completion_event == nullptr || startup_deadline == 0U) {
    return StartupGateDisposition::Failed;
  }
  const std::array<HANDLE, 3U> waits = {
      stop_event,
      start_ack_event,
      completion_event,
  };
  for (;;) {
    const bool stop_observed =
        StopControlWon() ||
        WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0;
    if (stop_observed) {
      return StartupGateDisposition::Stop;
    }
    const std::uint64_t effective_deadline =
        SelectLifecycleWatchdogDeadline(
            startup_deadline, LoadFirstStopDeadline(), true);
    const DWORD remaining =
        RemainingDeadlineMilliseconds(effective_deadline);
    if (remaining == 0U) {
      return StopControlWon() ? StartupGateDisposition::Stop
                              : StartupGateDisposition::Deadline;
    }
    const DWORD wait_milliseconds =
        remaining < kLifecycleWatchdogPollMilliseconds
            ? remaining
            : kLifecycleWatchdogPollMilliseconds;
    const DWORD wait_result = WaitForMultipleObjects(
        static_cast<DWORD>(waits.size()),
        waits.data(),
        FALSE,
        wait_milliseconds);
    if (wait_result == WAIT_OBJECT_0) {
      return StartupGateDisposition::Stop;
    }
    if (wait_result == WAIT_OBJECT_0 + 1U) {
      return ClassifyPostCheckpointStartupState(
          IsDeadlineExpired(startup_deadline),
          StopControlWon() ||
              WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0);
    }
    if (wait_result == WAIT_OBJECT_0 + 2U) {
      if (StopControlWon()) {
        return StartupGateDisposition::Stop;
      }
      const std::uint32_t worker_result =
          static_cast<std::uint32_t>(InterlockedCompareExchange(
              &g_worker_context.result, 0, 0));
      return worker_result ==
                     TransportResultCode(ServiceTransportResult::Deadline)
                 ? StartupGateDisposition::Deadline
                 : StartupGateDisposition::Failed;
    }
    if (wait_result != WAIT_TIMEOUT) {
      return StartupGateDisposition::Failed;
    }
  }
}

void WINAPI ProvisionerServiceMain(
    DWORD argument_count,
    wchar_t** arguments) noexcept {
  const std::uint64_t startup_deadline =
      AddDeadline(GetTickCount64(), kStartupMilliseconds);
  InterlockedExchange(&g_stop_disposition, 0);
  InterlockedExchange(&g_handler_signal_failure, 0);
  InterlockedExchange(&g_handler_inflight, 0);
  InterlockedExchange64(&g_first_stop_deadline, 0);
  InterlockedExchange64(
      &g_lifecycle_watchdog_deadline,
      static_cast<LONG64>(startup_deadline));
  InterlockedExchange64(&g_pending_cleanup_deadline, 0);
  InterlockedExchange(&g_lifecycle_watchdog_disarmed, 0);
  InterlockedExchange(&g_lifecycle_cleanup_publication, 0);
  InterlockedExchangePointer(&g_stop_event, nullptr);

  HANDLE lifecycle_watchdog_event =
      CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (lifecycle_watchdog_event == nullptr) {
    FailFastServiceProcess();
  }
  HANDLE lifecycle_watchdog_thread = CreateThread(
      nullptr,
      0U,
      LifecycleWatchdogWorker,
      lifecycle_watchdog_event,
      0U,
      nullptr);
  if (lifecycle_watchdog_thread == nullptr) {
    FailFastServiceProcess();
  }

  g_status_handle = RegisterServiceCtrlHandlerExW(
      kRuntimeServiceName, ServiceControlHandler, nullptr);
  if (g_status_handle == nullptr ||
      !ReportServiceStatus(ServiceStatusPhase::StartPending, 1U, 0U)) {
    FailFastServiceProcess();
  }

  HANDLE stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (stop_event == nullptr) {
    const std::uint64_t allocation_cleanup_deadline =
        EnsureLifecycleCleanupDeadline(0U);
    PublishLifecycleWatchdogDeadline(
        allocation_cleanup_deadline, lifecycle_watchdog_event);
    const bool allocation_stop_pending_reported = ReportServiceStatus(
        ServiceStatusPhase::StopPending, 1U, 0U);
    if (!ClosePublishedStopEvent(nullptr, allocation_cleanup_deadline)) {
      FailFastServiceProcess();
    }
    InterlockedExchange(&g_lifecycle_watchdog_disarmed, 1);
    if (SetEvent(lifecycle_watchdog_event) == FALSE ||
        WaitForSingleObject(
            lifecycle_watchdog_thread,
            RemainingDeadlineMilliseconds(allocation_cleanup_deadline)) !=
            WAIT_OBJECT_0) {
      FailFastServiceProcess();
    }
    CloseHandle(lifecycle_watchdog_thread);
    CloseHandle(lifecycle_watchdog_event);
    if (!allocation_stop_pending_reported) {
      FailFastServiceProcess();
    }
    if (!ReportServiceStatus(
            ServiceStatusPhase::Stopped,
            0U,
            TransportResultCode(
                ServiceTransportResult::CancellationOrReversion))) {
      FailFastServiceProcess();
    }
    return;
  }
  InterlockedExchangePointer(&g_stop_event, stop_event);
  if (StopControlWon()) {
    if (SetEvent(stop_event) == FALSE) {
      InterlockedExchange(&g_handler_signal_failure, 1);
    }
  }

  std::uint32_t final_code = 0U;
  HANDLE completion_event = nullptr;
  HANDLE worker_start_event = nullptr;
  HANDLE worker_start_ack_event = nullptr;
  HANDLE worker_thread = nullptr;
  bool hard_terminate = false;
  bool stop_pending_reported = false;
  std::uint64_t cleanup_deadline = 0U;
  std::uint64_t running_started = 0U;
  std::uint64_t running_deadline = 0U;

  HANDLE startup_progress_event = nullptr;
  HANDLE startup_continue_event = nullptr;
  HANDLE startup_cleanup_event = nullptr;
  HANDLE startup_thread = nullptr;
  bool startup_thread_completed = false;
  bool startup_ready = false;
  bool startup_stop_requested = false;
  StartupWorkerContext startup_context{};

  if (InterlockedExchange(&g_handler_signal_failure, 0) != 0) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
    if (SetEvent(stop_event) == FALSE) {
      hard_terminate = true;
    }
    stop_pending_reported = ReportServiceStatus(
        ServiceStatusPhase::StopPending, 1U, 0U);
    if (!stop_pending_reported) {
      hard_terminate = true;
    }
  } else {
    startup_progress_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    startup_continue_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    startup_cleanup_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    startup_context.stop_event = stop_event;
    startup_context.progress_event = startup_progress_event;
    startup_context.continue_event = startup_continue_event;
    startup_context.cleanup_event = startup_cleanup_event;
    startup_context.startup_deadline = startup_deadline;
    startup_context.argument_count = argument_count;
    startup_context.arguments = arguments;
    if (startup_progress_event == nullptr || startup_continue_event == nullptr ||
        startup_cleanup_event == nullptr) {
      final_code = TransportResultCode(
          ServiceTransportResult::CancellationOrReversion);
    } else {
      startup_thread = CreateThread(
          nullptr,
          0U,
          ServiceStartupWorker,
          &startup_context,
          0U,
          nullptr);
      if (startup_thread == nullptr) {
        final_code = TransportResultCode(
            ServiceTransportResult::CancellationOrReversion);
      }
    }
  }

  while (ShouldContinueStartupCoordination(
      final_code,
      startup_thread != nullptr,
      startup_thread_completed,
      startup_ready,
      startup_stop_requested)) {
    const DWORD remaining = RemainingDeadlineMilliseconds(startup_deadline);
    if (remaining == 0U) {
      const StartupGateDisposition terminal_state =
          ClassifyPostCheckpointStartupState(
              true,
              StopControlWon() ||
                  WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0);
      if (terminal_state == StartupGateDisposition::Stop) {
        cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
        PublishLifecycleCleanupDeadline(
            &startup_context,
            cleanup_deadline,
            lifecycle_watchdog_event);
        startup_stop_requested = true;
        final_code = 0U;
        break;
      }
      SetEvent(stop_event);
      SetEvent(startup_continue_event);
      FailFastServiceProcess();
    }
    const std::array<HANDLE, 3U> waits = {
        startup_thread,
        startup_progress_event,
        stop_event,
    };
    const DWORD wait_result = WaitForMultipleObjects(
        static_cast<DWORD>(waits.size()),
        waits.data(),
        FALSE,
        remaining);
    if (IsDeadlineExpired(startup_deadline) &&
        !StopControlWon()) {
      SetEvent(stop_event);
      SetEvent(startup_continue_event);
      FailFastServiceProcess();
    }
    switch (ClassifyOwnedStartupWait(wait_result)) {
      case OwnedStartupWaitDisposition::Completed: {
        startup_thread_completed = true;
        const std::uint32_t startup_code =
            static_cast<std::uint32_t>(InterlockedCompareExchange(
                &startup_context.result, 0, 0));
        const bool stop_disposition_won = StopControlWon();
        final_code = stop_disposition_won &&
                             (startup_code == 0U ||
                              startup_code == TransportResultCode(
                                                  ServiceTransportResult::Deadline))
                         ? 0U
                         : startup_code;
        break;
      }
      case OwnedStartupWaitDisposition::Progress: {
        const StartupStage stage = LoadStartupStage(startup_context);
        const StartupGateDisposition progress_state =
            ClassifyPostCheckpointStartupState(
                IsDeadlineExpired(startup_deadline),
                StopControlWon() ||
                    WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0);
        if (progress_state == StartupGateDisposition::Stop) {
          cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
          PublishLifecycleCleanupDeadline(
              &startup_context,
              cleanup_deadline,
              lifecycle_watchdog_event);
          startup_stop_requested = true;
          final_code = 0U;
          break;
        }
        if (progress_state == StartupGateDisposition::Deadline) {
          final_code = TransportResultCode(ServiceTransportResult::Deadline);
        } else if (stage == StartupStage::IdentityValidated) {
          if (!ReportServiceStatus(
                         ServiceStatusPhase::StartPending, 2U, 0U) ||
                     SetEvent(startup_continue_event) == FALSE) {
            final_code = TransportResultCode(
                ServiceTransportResult::CancellationOrReversion);
            hard_terminate = true;
          }
        } else if (stage == StartupStage::ImagesValidated) {
          if (!ReportServiceStatus(
                         ServiceStatusPhase::StartPending, 3U, 0U) ||
                     SetEvent(startup_continue_event) == FALSE) {
            final_code = TransportResultCode(
                ServiceTransportResult::CancellationOrReversion);
            hard_terminate = true;
          }
        } else if (stage == StartupStage::TransportArmed) {
          if (!ReportServiceStatus(
                         ServiceStatusPhase::StartPending, 4U, 0U)) {
            final_code = TransportResultCode(
                ServiceTransportResult::CancellationOrReversion);
            hard_terminate = true;
          } else {
            const StartupGateDisposition post_checkpoint =
                ClassifyPostCheckpointStartupState(
                    IsDeadlineExpired(startup_deadline),
                    StopControlWon() ||
                        WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0);
            if (post_checkpoint == StartupGateDisposition::Deadline) {
              final_code =
                  TransportResultCode(ServiceTransportResult::Deadline);
            } else if (post_checkpoint == StartupGateDisposition::Stop) {
              cleanup_deadline =
                  EnsureLifecycleCleanupDeadline(cleanup_deadline);
              PublishLifecycleCleanupDeadline(
                  &startup_context,
                  cleanup_deadline,
                  lifecycle_watchdog_event);
              startup_stop_requested = true;
              final_code = 0U;
            } else if (!ReportServiceStatus(
                           ServiceStatusPhase::Running, 0U, 0U)) {
              final_code = TransportResultCode(
                  ServiceTransportResult::CancellationOrReversion);
              hard_terminate = true;
            } else {
              running_started = GetTickCount64();
              running_deadline = AddDeadline(
                  running_started, kRunningMilliseconds);
              const std::uint64_t owner_deadline = AddDeadline(
                  running_deadline, kCleanupMilliseconds);
              InterlockedExchange64(
                  &startup_context.running_deadline,
                  static_cast<LONG64>(running_deadline));
              InterlockedExchange64(
                  &startup_context.owner_deadline,
                  static_cast<LONG64>(owner_deadline));
              const StartupGateDisposition post_running =
                  ClassifyPostCheckpointStartupState(
                      IsDeadlineExpired(startup_deadline),
                      StopControlWon() ||
                          WaitForSingleObject(stop_event, 0U) ==
                              WAIT_OBJECT_0);
              if (post_running == StartupGateDisposition::Stop) {
                cleanup_deadline =
                    EnsureLifecycleCleanupDeadline(cleanup_deadline);
                PublishLifecycleCleanupDeadline(
                    &startup_context,
                    cleanup_deadline,
                    lifecycle_watchdog_event);
                startup_stop_requested = true;
                final_code = 0U;
              } else if (post_running == StartupGateDisposition::Deadline) {
                final_code =
                    TransportResultCode(ServiceTransportResult::Deadline);
              } else if (!AdvanceStartupStage(
                      &startup_context,
                      StartupStage::TransportArmed,
                      StartupStage::RunningReported,
                      false) ||
                  SetEvent(startup_continue_event) == FALSE) {
                final_code = TransportResultCode(
                    ServiceTransportResult::CancellationOrReversion);
                hard_terminate = true;
              }
            }
          }
        } else if (stage == StartupStage::RunningPidValidated) {
          if (running_started == 0U || running_deadline == 0U) {
            final_code = TransportResultCode(ServiceTransportResult::Deadline);
          } else {
            startup_ready = true;
          }
        } else {
          final_code = TransportResultCode(
              ServiceTransportResult::CancellationOrReversion);
          hard_terminate = true;
        }
        break;
      }
      case OwnedStartupWaitDisposition::Stop:
        cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
        PublishLifecycleCleanupDeadline(
            &startup_context,
            cleanup_deadline,
            lifecycle_watchdog_event);
        startup_stop_requested = true;
        final_code = 0U;
        break;
      case OwnedStartupWaitDisposition::Deadline:
        if (StopControlWon() ||
            WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0) {
          cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
          PublishLifecycleCleanupDeadline(
              &startup_context,
              cleanup_deadline,
              lifecycle_watchdog_event);
          startup_stop_requested = true;
          final_code = 0U;
          break;
        }
        SetEvent(stop_event);
        SetEvent(startup_continue_event);
        FailFastServiceProcess();
      case OwnedStartupWaitDisposition::Failed:
        final_code = TransportResultCode(
            ServiceTransportResult::CancellationOrReversion);
        hard_terminate = true;
        break;
    }
  }

  if (final_code == TransportResultCode(ServiceTransportResult::Deadline) &&
      IsDeadlineExpired(startup_deadline) &&
      !StopControlWon()) {
    SetEvent(stop_event);
    if (startup_continue_event != nullptr) {
      SetEvent(startup_continue_event);
    }
    FailFastServiceProcess();
  }

  if (!startup_ready && startup_thread != nullptr && !startup_thread_completed) {
    if (cleanup_deadline == 0U) {
      cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
      PublishLifecycleCleanupDeadline(
          &startup_context,
          cleanup_deadline,
          lifecycle_watchdog_event);
    }
    if (SetEvent(stop_event) == FALSE ||
        SetEvent(startup_continue_event) == FALSE) {
      final_code = TransportResultCode(
          ServiceTransportResult::CancellationOrReversion);
      hard_terminate = true;
    }
    if (!stop_pending_reported) {
      stop_pending_reported = ReportServiceStatus(
          ServiceStatusPhase::StopPending, 1U, 0U);
      if (!stop_pending_reported) {
        final_code = TransportResultCode(
            ServiceTransportResult::CancellationOrReversion);
        hard_terminate = true;
      }
    }
    if (SetEvent(startup_cleanup_event) == FALSE) {
      final_code = TransportResultCode(
          ServiceTransportResult::CancellationOrReversion);
      hard_terminate = true;
    }
    const DWORD join_result = WaitForSingleObject(
        startup_thread, RemainingDeadlineMilliseconds(cleanup_deadline));
    if (join_result != WAIT_OBJECT_0) {
      FailFastServiceProcess();
    }
    startup_thread_completed = true;
    const std::uint32_t startup_code =
        static_cast<std::uint32_t>(InterlockedCompareExchange(
            &startup_context.result, 0, 0));
    const bool stop_disposition_won = StopControlWon();
    if (final_code == 0U &&
        !(stop_disposition_won &&
          (startup_code == 0U ||
           startup_code ==
               TransportResultCode(ServiceTransportResult::Deadline)))) {
      final_code = startup_code;
    }
  }

  if (startup_ready && final_code == 0U &&
      !StopControlWon() &&
      LoadStartupStage(startup_context) !=
          StartupStage::RunningPidValidated) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
  }
  if (final_code == 0U && !hard_terminate && !StopControlWon() &&
      WaitForSingleObject(stop_event, 0U) != WAIT_OBJECT_0) {
    completion_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    worker_start_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    worker_start_ack_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    g_worker_context.completion_event = completion_event;
    g_worker_context.stop_event = stop_event;
    g_worker_context.start_event = worker_start_event;
    g_worker_context.start_ack_event = worker_start_ack_event;
    g_worker_context.startup_deadline = startup_deadline;
    InterlockedExchange(
        &g_worker_context.result,
        static_cast<LONG>(
            ServiceTransportResult::CancellationOrReversion));
    if (completion_event == nullptr || worker_start_event == nullptr ||
        worker_start_ack_event == nullptr) {
      final_code = TransportResultCode(
          ServiceTransportResult::CancellationOrReversion);
    } else {
      worker_thread = CreateThread(
          nullptr,
          0U,
          ServiceTransportWorker,
          nullptr,
          0U,
          nullptr);
      if (worker_thread == nullptr) {
        final_code = TransportResultCode(
            ServiceTransportResult::CancellationOrReversion);
      } else {
        StartupGateDisposition worker_start_state =
            ClassifyPostCheckpointStartupState(
                IsDeadlineExpired(startup_deadline),
                StopControlWon() ||
                    WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0);
        if (worker_start_state == StartupGateDisposition::Continue) {
          if (SetEvent(worker_start_event) == FALSE) {
            worker_start_state = StartupGateDisposition::Failed;
          } else {
            worker_start_state = WaitForWorkerStartAcknowledgement(
                stop_event,
                worker_start_ack_event,
                completion_event,
                startup_deadline);
            if (worker_start_state == StartupGateDisposition::Continue) {
              worker_start_state = ClassifyPostCheckpointStartupState(
                  IsDeadlineExpired(startup_deadline),
                  StopControlWon() ||
                      WaitForSingleObject(stop_event, 0U) == WAIT_OBJECT_0);
              if (worker_start_state == StartupGateDisposition::Continue) {
                SuspendLifecycleWatchdogAfterStartup(
                    startup_deadline, lifecycle_watchdog_event);
              }
            }
          }
        }
        if (worker_start_state == StartupGateDisposition::Stop) {
          cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
          PublishLifecycleCleanupDeadline(
              &startup_context,
              cleanup_deadline,
              lifecycle_watchdog_event);
          if (SetEvent(stop_event) == FALSE) {
            final_code = TransportResultCode(
                ServiceTransportResult::CancellationOrReversion);
          }
        } else if (worker_start_state ==
                   StartupGateDisposition::Deadline) {
          final_code = TransportResultCode(ServiceTransportResult::Deadline);
          SetEvent(stop_event);
        } else if (worker_start_state == StartupGateDisposition::Failed) {
          final_code = TransportResultCode(
              ServiceTransportResult::CancellationOrReversion);
          SetEvent(stop_event);
        }
      }
    }
  }

  if (final_code == 0U && worker_thread != nullptr) {
    const std::array<HANDLE, 2U> waits = {completion_event, stop_event};
    for (;;) {
      if (StopControlWon()) {
        cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
        PublishLifecycleCleanupDeadline(
            &startup_context,
            cleanup_deadline,
            lifecycle_watchdog_event);
        final_code = 0U;
        if (SetEvent(stop_event) == FALSE) {
          final_code = TransportResultCode(
              ServiceTransportResult::CancellationOrReversion);
        }
        break;
      }
      const std::uint64_t coordination_deadline =
          SelectLifecycleWatchdogDeadline(
              running_deadline, LoadFirstStopDeadline(), true);
      const DWORD remaining =
          RemainingDeadlineMilliseconds(coordination_deadline);
      if (remaining == 0U) {
        cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
        PublishLifecycleCleanupDeadline(
            &startup_context,
            cleanup_deadline,
            lifecycle_watchdog_event);
        final_code = 0U;
        if (SetEvent(stop_event) == FALSE) {
          final_code = TransportResultCode(
              ServiceTransportResult::CancellationOrReversion);
        }
        break;
      }
      const DWORD wait_milliseconds =
          remaining < kLifecycleWatchdogPollMilliseconds
              ? remaining
              : kLifecycleWatchdogPollMilliseconds;
      const DWORD wait_result = WaitForMultipleObjects(
          static_cast<DWORD>(waits.size()),
          waits.data(),
          FALSE,
          wait_milliseconds);
      if (wait_result == WAIT_OBJECT_0) {
        const std::uint32_t worker_code =
            static_cast<std::uint32_t>(InterlockedCompareExchange(
                &g_worker_context.result, 0, 0));
        const bool stop_disposition_won = StopControlWon();
        if (stop_disposition_won &&
            (worker_code ==
                 TransportResultCode(ServiceTransportResult::Success) ||
             worker_code ==
                 TransportResultCode(ServiceTransportResult::Deadline))) {
          final_code = 0U;
        } else {
          final_code = worker_code;
        }
        break;
      }
      if (wait_result == WAIT_OBJECT_0 + 1U) {
        cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
        PublishLifecycleCleanupDeadline(
            &startup_context,
            cleanup_deadline,
            lifecycle_watchdog_event);
        final_code = 0U;
        break;
      }
      if (wait_result != WAIT_TIMEOUT) {
        final_code = TransportResultCode(
            ServiceTransportResult::CancellationOrReversion);
        SetEvent(stop_event);
        break;
      }
    }
  }

  cleanup_deadline = EnsureLifecycleCleanupDeadline(cleanup_deadline);
  PublishLifecycleCleanupDeadline(
      &startup_context,
      cleanup_deadline,
      lifecycle_watchdog_event);
  if (SetEvent(stop_event) == FALSE) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
  }
  if (!stop_pending_reported) {
    stop_pending_reported = ReportServiceStatus(
        ServiceStatusPhase::StopPending, 1U, 0U);
    if (!stop_pending_reported) {
      hard_terminate = true;
      final_code = TransportResultCode(
          ServiceTransportResult::CancellationOrReversion);
    }
  }

  if (worker_thread != nullptr) {
    const DWORD join_result = WaitForSingleObject(
        worker_thread, RemainingDeadlineMilliseconds(cleanup_deadline));
    if (join_result != WAIT_OBJECT_0) {
      FailFastServiceProcess();
    } else {
      const std::uint32_t worker_code =
          static_cast<std::uint32_t>(InterlockedCompareExchange(
              &g_worker_context.result, 0, 0));
      if (worker_code == TransportResultCode(
                             ServiceTransportResult::CancellationOrReversion)) {
        final_code = worker_code;
      } else if (final_code == 0U &&
                 worker_code !=
                     TransportResultCode(ServiceTransportResult::Success) &&
                 worker_code !=
                     TransportResultCode(ServiceTransportResult::Deadline)) {
        final_code = worker_code;
      }
    }
  }

  if (InterlockedCompareExchange(&g_handler_signal_failure, 0, 0) != 0) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
    hard_terminate = true;
  }

  if (startup_thread != nullptr && !startup_thread_completed) {
    if (startup_cleanup_event == nullptr ||
        SetEvent(startup_cleanup_event) == FALSE) {
      final_code = TransportResultCode(
          ServiceTransportResult::CancellationOrReversion);
      hard_terminate = true;
    }
    const DWORD owner_join_result = WaitForSingleObject(
        startup_thread, RemainingDeadlineMilliseconds(cleanup_deadline));
    if (owner_join_result != WAIT_OBJECT_0) {
      FailFastServiceProcess();
    }
    startup_thread_completed = true;
  }
  if (startup_thread_completed) {
    const std::uint32_t owner_code =
        static_cast<std::uint32_t>(InterlockedCompareExchange(
            &startup_context.result, 0, 0));
    if (owner_code == TransportResultCode(
                          ServiceTransportResult::CancellationOrReversion)) {
      final_code = owner_code;
      hard_terminate = true;
    } else if (final_code == 0U &&
               owner_code !=
                   TransportResultCode(ServiceTransportResult::Success) &&
               owner_code !=
                   TransportResultCode(ServiceTransportResult::Deadline)) {
      final_code = owner_code;
    }
  }
  if (IsDeadlineExpired(cleanup_deadline)) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
    hard_terminate = true;
  }
  if (worker_thread != nullptr) {
    CloseHandle(worker_thread);
  }
  g_worker_context.completion_event = nullptr;
  g_worker_context.stop_event = nullptr;
  g_worker_context.start_event = nullptr;
  g_worker_context.start_ack_event = nullptr;
  g_worker_context.startup_deadline = 0U;
  if (completion_event != nullptr) {
    CloseHandle(completion_event);
  }
  if (worker_start_event != nullptr) {
    CloseHandle(worker_start_event);
  }
  if (worker_start_ack_event != nullptr) {
    CloseHandle(worker_start_ack_event);
  }
  if (startup_thread != nullptr) {
    CloseHandle(startup_thread);
  }
  if (startup_cleanup_event != nullptr) {
    CloseHandle(startup_cleanup_event);
  }
  if (startup_continue_event != nullptr) {
    CloseHandle(startup_continue_event);
  }
  if (startup_progress_event != nullptr) {
    CloseHandle(startup_progress_event);
  }
  if (!ClosePublishedStopEvent(stop_event, cleanup_deadline)) {
    FailFastServiceProcess();
  }
  if (InterlockedCompareExchange(&g_handler_signal_failure, 0, 0) != 0) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
    hard_terminate = true;
  }

  HANDLE ambient_token = nullptr;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(
          GetCurrentThread(), TOKEN_QUERY, FALSE, &ambient_token) != FALSE) {
    CloseHandle(ambient_token);
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
    hard_terminate = true;
  } else if (GetLastError() != ERROR_NO_TOKEN) {
    final_code = TransportResultCode(
        ServiceTransportResult::CancellationOrReversion);
    hard_terminate = true;
  }

  InterlockedExchange(&g_lifecycle_watchdog_disarmed, 1);
  if (SetEvent(lifecycle_watchdog_event) == FALSE ||
      WaitForSingleObject(
          lifecycle_watchdog_thread,
          RemainingDeadlineMilliseconds(cleanup_deadline)) != WAIT_OBJECT_0) {
    FailFastServiceProcess();
  }
  CloseHandle(lifecycle_watchdog_thread);
  CloseHandle(lifecycle_watchdog_event);
  if (hard_terminate) {
    FailFastServiceProcess();
  }
  if (!ReportServiceStatus(
          ServiceStatusPhase::Stopped, 0U, final_code)) {
    FailFastServiceProcess();
  }
}

}  // namespace

const char* ServiceTransportResultLabel(
    ServiceTransportResult result) noexcept {
  switch (result) {
    case ServiceTransportResult::Success:
      return "success";
    case ServiceTransportResult::ProtectedImage:
      return "protected_image";
    case ServiceTransportResult::PipeReadiness:
      return "pipe_readiness";
    case ServiceTransportResult::CallerAuthentication:
      return "caller_authentication";
    case ServiceTransportResult::ProtocolInvalid:
      return "protocol_invalid";
    case ServiceTransportResult::Deadline:
      return "deadline";
    case ServiceTransportResult::CancellationOrReversion:
      return "cancellation_or_reversion";
    case ServiceTransportResult::CustodyOrJournal:
      return "custody_or_journal";
  }
  return "custody_or_journal";
}

bool DecodeTokenHasRestrictions(
    const std::uint8_t* bytes,
    std::size_t returned_bytes,
    bool* token_unrestricted) noexcept {
  if (bytes == nullptr || token_unrestricted == nullptr ||
      returned_bytes != sizeof(BOOLEAN) || bytes[0] > 1U) {
    return false;
  }
  *token_unrestricted = bytes[0] == 0U;
  return true;
}

CommandDisposition DecideCommandDisposition(
    const wchar_t* command_line) noexcept {
  if (command_line == nullptr || *command_line == L'\0') {
    return CommandDisposition::Invalid;
  }
  const wchar_t* cursor = command_line;
  if (*cursor == L'"') {
    ++cursor;
    if (*cursor == L'"' || *cursor == L'\0') {
      return CommandDisposition::Invalid;
    }
    while (*cursor != L'\0' && *cursor != L'"') {
      ++cursor;
    }
    if (*cursor != L'"') {
      return CommandDisposition::Invalid;
    }
    ++cursor;
  } else {
    while (*cursor != L'\0' && !IsCommandLineWhitespace(*cursor)) {
      ++cursor;
    }
  }
  if (*cursor == L'\0') {
    return CommandDisposition::Service;
  }
  if (!IsCommandLineWhitespace(*cursor)) {
    return CommandDisposition::Invalid;
  }
  while (IsCommandLineWhitespace(*cursor)) {
    ++cursor;
  }
  if (*cursor == L'\0') {
    return CommandDisposition::Service;
  }
  for (std::size_t index = 0U;; ++index) {
    if (cursor[index] != kInspectArgument[index]) {
      return CommandDisposition::Invalid;
    }
    if (kInspectArgument[index] == L'\0') {
      cursor += index;
      break;
    }
  }
  while (IsCommandLineWhitespace(*cursor)) {
    ++cursor;
  }
  return *cursor == L'\0' ? CommandDisposition::InspectStdio
                           : CommandDisposition::Invalid;
}

ServiceIdentityValidation ValidateServiceIdentitySnapshot(
    const ServiceIdentitySnapshot& snapshot,
    const FixedWideString& expected_binary_path) noexcept {
  if (!snapshot.exact_service_main_arguments) {
    return ServiceIdentityValidation::LaunchContext;
  }
  if (snapshot.current_process_id == 0U ||
      snapshot.configured_service_type != SERVICE_WIN32_OWN_PROCESS ||
      snapshot.configured_start_type != SERVICE_DEMAND_START ||
      snapshot.configured_error_control != SERVICE_ERROR_NORMAL ||
      !EqualFixedWideString(
          snapshot.configured_binary_path, expected_binary_path) ||
      !EqualLiteral(snapshot.configured_account_name, kLocalSystemAccount) ||
      !snapshot.load_order_group_empty || !snapshot.dependencies_empty ||
      !snapshot.triggers_empty || !snapshot.failure_actions_empty ||
      !snapshot.failure_actions_on_non_crash_disabled ||
      !snapshot.delayed_auto_start_disabled ||
      snapshot.configured_service_sid_type != SERVICE_SID_TYPE_UNRESTRICTED ||
      !IsRequiredPrivilegeListExact(snapshot) ||
      snapshot.token_type != static_cast<std::uint32_t>(TokenPrimary) ||
      snapshot.token_session_id != 0U || !snapshot.token_unrestricted ||
      !snapshot.token_non_appcontainer ||
      !snapshot.current_thread_has_no_token ||
      snapshot.restricted_sid_count != 0U ||
      snapshot.token_group_count > snapshot.token_groups.size() ||
      snapshot.token_privilege_count > snapshot.token_privileges.size() ||
      !snapshot.service_dacl_present || snapshot.service_dacl_defaulted ||
      !snapshot.service_dacl_protected ||
      !snapshot.service_dacl_non_inheriting ||
      snapshot.service_ace_count > snapshot.service_aces.size()) {
    return ServiceIdentityValidation::ServiceIdentity;
  }

  const SidSnapshot local_system = MakeNtSidSnapshot(
      kLocalSystemSidParts.data(), kLocalSystemSidParts.size());
  const SidSnapshot administrators = MakeNtSidSnapshot(
      kAdministratorsSidParts.data(), kAdministratorsSidParts.size());
  const SidSnapshot service_logon = MakeNtSidSnapshot(
      kServiceLogonSidParts.data(), kServiceLogonSidParts.size());
  const SidSnapshot provisioner_service = MakeNtSidSnapshot(
      kProvisionerServiceSidParts.data(), kProvisionerServiceSidParts.size());
  if (!EqualSidSnapshot(snapshot.token_user, local_system) ||
      !EqualSidSnapshot(snapshot.service_object_owner, local_system)) {
    return ServiceIdentityValidation::ServiceIdentity;
  }

  std::size_t provisioner_service_count = 0U;
  std::size_t enabled_service_logon_count = 0U;
  for (std::size_t index = 0U; index < snapshot.token_group_count; ++index) {
    const TokenGroupSnapshot& group = snapshot.token_groups[index];
    if (EqualSidSnapshot(group.sid, provisioner_service)) {
      ++provisioner_service_count;
      if ((group.attributes & (SE_GROUP_ENABLED | SE_GROUP_OWNER)) !=
              (SE_GROUP_ENABLED | SE_GROUP_OWNER) ||
          (group.attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0U) {
        return ServiceIdentityValidation::ServiceIdentity;
      }
    }
    if (EqualSidSnapshot(group.sid, service_logon) &&
        (group.attributes & SE_GROUP_ENABLED) != 0U &&
        (group.attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0U) {
      ++enabled_service_logon_count;
    }
    if ((group.attributes & SE_GROUP_ENABLED) != 0U) {
      for (const std::uint32_t rid : kProhibitedLogonSidRids) {
        const SidSnapshot prohibited = MakeNtSidSnapshot(&rid, 1U);
        if (EqualSidSnapshot(group.sid, prohibited)) {
          return ServiceIdentityValidation::ServiceIdentity;
        }
      }
    }
  }
  if (provisioner_service_count != 1U ||
      enabled_service_logon_count != 1U ||
      snapshot.token_privilege_count != 1U) {
    return ServiceIdentityValidation::ServiceIdentity;
  }
  const TokenPrivilegeSnapshot& privilege = snapshot.token_privileges[0];
  if (privilege.luid_low_part != snapshot.change_notify_luid_low_part ||
      privilege.luid_high_part != snapshot.change_notify_luid_high_part ||
      (privilege.attributes & SE_PRIVILEGE_ENABLED) == 0U ||
      (privilege.attributes & SE_PRIVILEGE_REMOVED) != 0U) {
    return ServiceIdentityValidation::ServiceIdentity;
  }

  if (snapshot.service_ace_count != 2U) {
    return ServiceIdentityValidation::ServiceIdentity;
  }
  const ServiceAceSnapshot& system_ace = snapshot.service_aces[0];
  const ServiceAceSnapshot& administrators_ace = snapshot.service_aces[1];
  if (system_ace.type != ACCESS_ALLOWED_ACE_TYPE || system_ace.flags != 0U ||
      system_ace.mask != SERVICE_ALL_ACCESS ||
      !EqualSidSnapshot(system_ace.sid, local_system) ||
      administrators_ace.type != ACCESS_ALLOWED_ACE_TYPE ||
      administrators_ace.flags != 0U ||
      administrators_ace.mask != kAdministratorServiceMask ||
      !EqualSidSnapshot(administrators_ace.sid, administrators)) {
    return ServiceIdentityValidation::ServiceIdentity;
  }
  return ServiceIdentityValidation::Valid;
}

bool IsValidStartupStageTransition(
    StartupStage current,
    StartupStage next) noexcept {
  switch (current) {
    case StartupStage::Initial:
      return next == StartupStage::IdentityValidated;
    case StartupStage::IdentityValidated:
      return next == StartupStage::ImagesValidated;
    case StartupStage::ImagesValidated:
      return next == StartupStage::TransportArmed;
    case StartupStage::TransportArmed:
      return next == StartupStage::RunningReported;
    case StartupStage::RunningReported:
      return next == StartupStage::RunningPidValidated;
    case StartupStage::RunningPidValidated:
      return false;
  }
  return false;
}

OwnedStartupWaitDisposition ClassifyOwnedStartupWait(
    std::uint32_t wait_result) noexcept {
  if (wait_result == WAIT_OBJECT_0) {
    return OwnedStartupWaitDisposition::Completed;
  }
  if (wait_result == WAIT_OBJECT_0 + 1U) {
    return OwnedStartupWaitDisposition::Progress;
  }
  if (wait_result == WAIT_OBJECT_0 + 2U) {
    return OwnedStartupWaitDisposition::Stop;
  }
  if (wait_result == WAIT_TIMEOUT) {
    return OwnedStartupWaitDisposition::Deadline;
  }
  return OwnedStartupWaitDisposition::Failed;
}

std::uint32_t BoundedDeadlineWaitMillisecondsAt(
    std::uint64_t now_ms,
    std::uint64_t deadline_ms) noexcept {
  if (now_ms >= deadline_ms) {
    return 0U;
  }
  const std::uint64_t remaining = deadline_ms - now_ms;
  return remaining > MAXDWORD ? MAXDWORD
                              : static_cast<std::uint32_t>(remaining);
}

std::uint64_t SelectLifecycleCleanupDeadline(
    std::uint64_t existing_deadline_ms,
    std::uint64_t first_stop_deadline_ms,
    std::uint64_t now_ms) noexcept {
  if (existing_deadline_ms != 0U) {
    return existing_deadline_ms;
  }
  if (first_stop_deadline_ms != 0U) {
    return first_stop_deadline_ms;
  }
  return now_ms > UINT64_MAX - kCleanupMilliseconds
             ? UINT64_MAX
             : now_ms + kCleanupMilliseconds;
}

std::uint64_t SelectLifecycleWatchdogDeadline(
    std::uint64_t configured_deadline_ms,
    std::uint64_t first_stop_deadline_ms,
    bool cleanup_published) noexcept {
  if (first_stop_deadline_ms != 0U && !cleanup_published) {
    return first_stop_deadline_ms;
  }
  if (configured_deadline_ms == 0U) {
    return first_stop_deadline_ms;
  }
  if (first_stop_deadline_ms == 0U) {
    return configured_deadline_ms;
  }
  return configured_deadline_ms < first_stop_deadline_ms
             ? configured_deadline_ms
             : first_stop_deadline_ms;
}

std::uint64_t SelectLifecycleWatchdogSnapshotDeadline(
    std::uint64_t configured_deadline_ms,
    std::uint64_t first_stop_deadline_ms,
    bool cleanup_published,
    std::uint64_t pending_cleanup_deadline_ms) noexcept {
  if (pending_cleanup_deadline_ms != 0U) {
    return SelectLifecycleWatchdogDeadline(
        pending_cleanup_deadline_ms,
        first_stop_deadline_ms,
        true);
  }
  return SelectLifecycleWatchdogDeadline(
      configured_deadline_ms,
      first_stop_deadline_ms,
      cleanup_published);
}

StopControlPublicationDisposition ClassifyStopControlPublication(
    std::uint64_t previous_first_stop_deadline_ms,
    std::uint32_t published_stop_disposition) noexcept {
  if (previous_first_stop_deadline_ms == 0U) {
    return StopControlPublicationDisposition::FirstControl;
  }
  return published_stop_disposition == 0U
             ? StopControlPublicationDisposition::RepeatPending
             : StopControlPublicationDisposition::RepeatPublished;
}

StartupGateDisposition ClassifyStartupGateWait(
    std::uint32_t wait_result,
    bool stop_observed,
    bool deadline_expired) noexcept {
  if (stop_observed || wait_result == WAIT_OBJECT_0) {
    return StartupGateDisposition::Stop;
  }
  if (deadline_expired || wait_result == WAIT_TIMEOUT) {
    return StartupGateDisposition::Deadline;
  }
  if (wait_result == WAIT_OBJECT_0 + 1U) {
    return StartupGateDisposition::Continue;
  }
  return StartupGateDisposition::Failed;
}

StartupGateDisposition ClassifyPostCheckpointStartupState(
    bool deadline_expired,
    bool stop_observed) noexcept {
  if (stop_observed) {
    return StartupGateDisposition::Stop;
  }
  return deadline_expired ? StartupGateDisposition::Deadline
                          : StartupGateDisposition::Continue;
}

bool ShouldContinueStartupCoordination(
    std::uint32_t final_code,
    bool startup_thread_exists,
    bool startup_thread_completed,
    bool startup_ready,
    bool startup_stop_requested) noexcept {
  return final_code == 0U && startup_thread_exists &&
         !startup_thread_completed && !startup_ready &&
         !startup_stop_requested;
}

bool ShouldRunServiceTransportAfterStartGate(
    std::uint32_t wait_result,
    bool stop_observed,
    bool deadline_expired) noexcept {
  return ClassifyStartupGateWait(
             wait_result, stop_observed, deadline_expired) ==
         StartupGateDisposition::Continue;
}

bool IsExactRunningServiceStatus(
    const RunningServiceStatusSnapshot& snapshot) noexcept {
  return ClassifyRunningServiceStatus(snapshot) ==
         RunningServiceStatusDisposition::Valid;
}

RunningServiceStatusDisposition ClassifyRunningServiceStatus(
    const RunningServiceStatusSnapshot& snapshot) noexcept {
  if (snapshot.current_process_id == 0U ||
      snapshot.service_type != SERVICE_WIN32_OWN_PROCESS ||
      snapshot.service_flags != 0U) {
    return RunningServiceStatusDisposition::Mismatch;
  }
  if (snapshot.current_state == SERVICE_START_PENDING) {
    return RunningServiceStatusDisposition::Retry;
  }
  if (snapshot.current_state != SERVICE_RUNNING) {
    return RunningServiceStatusDisposition::Mismatch;
  }
  if (snapshot.service_process_id == 0U) {
    return RunningServiceStatusDisposition::Retry;
  }
  return snapshot.service_process_id == snapshot.current_process_id
             ? RunningServiceStatusDisposition::Valid
             : RunningServiceStatusDisposition::Mismatch;
}

ServiceStatusSnapshot BuildServiceStatusSnapshot(
    ServiceStatusPhase phase,
    std::uint32_t checkpoint,
    std::uint32_t final_service_specific_code) noexcept {
  ServiceStatusSnapshot status{};
  status.service_type = SERVICE_WIN32_OWN_PROCESS;
  switch (phase) {
    case ServiceStatusPhase::StartPending:
      status.current_state = SERVICE_START_PENDING;
      status.checkpoint = checkpoint;
      status.wait_hint = 15000U;
      break;
    case ServiceStatusPhase::Running:
      status.current_state = SERVICE_RUNNING;
      status.controls_accepted =
          SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
      break;
    case ServiceStatusPhase::StopPending:
      status.current_state = SERVICE_STOP_PENDING;
      status.checkpoint = 1U;
      status.wait_hint = 5000U;
      break;
    case ServiceStatusPhase::Stopped:
      status.current_state = SERVICE_STOPPED;
      if (final_service_specific_code != 0U) {
        status.win32_exit_code = ERROR_SERVICE_SPECIFIC_ERROR;
        status.service_specific_exit_code = final_service_specific_code;
      }
      break;
  }
  return status;
}

__declspec(noinline) const std::array<std::uint8_t, 32U>&
EmbeddedExpectedClientSha256() noexcept {
  return kExpectedClientSha256;
}

int RunServiceDispatcher() noexcept {
  SERVICE_TABLE_ENTRYW table[] = {
      {
          const_cast<wchar_t*>(kRuntimeServiceName),
          ProvisionerServiceMain,
      },
      {nullptr, nullptr},
  };
  return StartServiceCtrlDispatcherW(table) != FALSE ? 0 : 5;
}

}  // namespace goatcitadel::remote_worker_provisioner
