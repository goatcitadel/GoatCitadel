#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

#include "protocol.hpp"
#include "service_runtime.hpp"

namespace {

using goatcitadel::remote_worker_provisioner::DecideRequest;
using goatcitadel::remote_worker_provisioner::DecideCommandDisposition;
using goatcitadel::remote_worker_provisioner::CommandDisposition;
using goatcitadel::remote_worker_provisioner::ExitCode;
using goatcitadel::remote_worker_provisioner::HeaderStatus;
using goatcitadel::remote_worker_provisioner::ParseHeader;
using goatcitadel::remote_worker_provisioner::RequestHeader;
using goatcitadel::remote_worker_provisioner::Response;
using goatcitadel::remote_worker_provisioner::RunServiceDispatcher;
using goatcitadel::remote_worker_provisioner::kHeaderBytes;

constexpr std::size_t kDrainBytes = 4096U;
std::array<std::uint8_t, kDrainBytes> g_drain_buffer{};

#if defined(_M_X64)
constexpr std::uint16_t kPeMachine = goatcitadel::remote_worker_provisioner::kMachineX64;
#elif defined(_M_ARM64)
constexpr std::uint16_t kPeMachine = goatcitadel::remote_worker_provisioner::kMachineArm64;
#else
#error Unsupported provisioner architecture.
#endif

bool IsUsableStandardHandle(HANDLE handle) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE) {
    return false;
  }
  const DWORD type = GetFileType(handle);
  return type != FILE_TYPE_UNKNOWN || GetLastError() == NO_ERROR;
}

bool ReadExact(HANDLE input, std::uint8_t* destination, std::size_t length) noexcept {
  std::size_t offset = 0U;
  while (offset < length) {
    const std::size_t remaining = length - offset;
    const DWORD requested =
        remaining > static_cast<std::size_t>(MAXDWORD)
            ? MAXDWORD
            : static_cast<DWORD>(remaining);
    DWORD received = 0U;
    if (ReadFile(input, destination + offset, requested, &received, nullptr) == FALSE ||
        received == 0U) {
      return false;
    }
    offset += static_cast<std::size_t>(received);
  }
  return true;
}

bool DrainPayload(HANDLE input, std::uint32_t payload_length) noexcept {
  std::uint32_t remaining = payload_length;
  while (remaining > 0U) {
    const DWORD requested =
        remaining > static_cast<std::uint32_t>(g_drain_buffer.size())
            ? static_cast<DWORD>(g_drain_buffer.size())
            : static_cast<DWORD>(remaining);
    DWORD received = 0U;
    if (ReadFile(input, g_drain_buffer.data(), requested, &received, nullptr) == FALSE ||
        received == 0U) {
      return false;
    }
    remaining -= received;
  }
  return true;
}

bool RequireExactEof(HANDLE input, bool* exact_eof) noexcept {
  if (exact_eof == nullptr) {
    return false;
  }
  std::uint8_t trailing = 0U;
  DWORD received = 0U;
  if (ReadFile(input, &trailing, 1U, &received, nullptr) == FALSE) {
    if (GetLastError() == ERROR_BROKEN_PIPE) {
      *exact_eof = true;
      return true;
    }
    return false;
  }
  *exact_eof = received == 0U;
  return true;
}

bool WriteExact(HANDLE output, const std::uint8_t* bytes, std::size_t length) noexcept {
  std::size_t offset = 0U;
  while (offset < length) {
    const std::size_t remaining = length - offset;
    const DWORD requested =
        remaining > static_cast<std::size_t>(MAXDWORD)
            ? MAXDWORD
            : static_cast<DWORD>(remaining);
    DWORD written = 0U;
    if (WriteFile(output, bytes + offset, requested, &written, nullptr) == FALSE ||
        written == 0U) {
      return false;
    }
    offset += static_cast<std::size_t>(written);
  }
  return true;
}

int RunInspectStdio() noexcept {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!IsUsableStandardHandle(input) || !IsUsableStandardHandle(output)) {
    return static_cast<int>(ExitCode::IoFailed);
  }

  std::array<std::uint8_t, kHeaderBytes> header_bytes{};
  if (!ReadExact(input, header_bytes.data(), header_bytes.size())) {
    return static_cast<int>(ExitCode::ProtocolInvalid);
  }

  RequestHeader header{};
  const HeaderStatus header_status =
      ParseHeader(header_bytes.data(), header_bytes.size(), &header);
  if (header_status == HeaderStatus::PayloadTooLarge ||
      header_status == HeaderStatus::Truncated) {
    return static_cast<int>(ExitCode::ProtocolInvalid);
  }
  if (!DrainPayload(input, header.payload_length)) {
    return static_cast<int>(ExitCode::ProtocolInvalid);
  }

  bool exact_eof = false;
  if (!RequireExactEof(input, &exact_eof)) {
    return static_cast<int>(ExitCode::IoFailed);
  }
  const Response response =
      DecideRequest(header_status, header, true, exact_eof, kPeMachine);
  if (response.size == 0U) {
    return static_cast<int>(response.exit_code);
  }
  if (!WriteExact(output, response.bytes.data(), response.size)) {
    return static_cast<int>(ExitCode::IoFailed);
  }
  return static_cast<int>(response.exit_code);
}

}  // namespace

extern "C" __declspec(noreturn) void WINAPI ProvisionerEntryPoint() noexcept {
  __security_init_cookie();
  int exit_code = static_cast<int>(ExitCode::Usage);
  switch (DecideCommandDisposition(GetCommandLineW())) {
    case CommandDisposition::InspectStdio:
      exit_code = RunInspectStdio();
      break;
    case CommandDisposition::Service:
      exit_code = RunServiceDispatcher();
      break;
    case CommandDisposition::Invalid:
      break;
  }
  ExitProcess(static_cast<UINT>(exit_code));
}
