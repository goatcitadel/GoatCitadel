#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

#include "local_transport.hpp"
#include "protocol.hpp"

namespace {

namespace gc = goatcitadel::remote_worker_provisioner;

constexpr wchar_t kServiceArgument[] = L"--service-stdio";
constexpr std::size_t kGcpwErrorFrameBytes =
    gc::kHeaderBytes + gc::kErrorPayloadBytes;
constexpr std::size_t kProtectedMaximumResponseBytes =
    gc::kHeaderBytes + gc::kProtectedInspectPayloadBytes;
alignas(64) std::array<std::uint8_t, gc::kOrdinaryMaximumBytes>
    g_request_body{};

enum class StreamReadResult : std::uint8_t {
  Success,
  Eof,
  Failure,
};

bool IsWhitespace(wchar_t value) noexcept {
  return value == L' ' || value == L'\t';
}

bool IsExactServiceCommandLine(const wchar_t* command_line) noexcept {
  if (command_line == nullptr || *command_line == L'\0') {
    return false;
  }
  const wchar_t* cursor = command_line;
  if (*cursor == L'"') {
    ++cursor;
    if (*cursor == L'"' || *cursor == L'\0') {
      return false;
    }
    while (*cursor != L'\0' && *cursor != L'"') {
      ++cursor;
    }
    if (*cursor != L'"') {
      return false;
    }
    ++cursor;
  } else {
    while (*cursor != L'\0' && !IsWhitespace(*cursor)) {
      ++cursor;
    }
  }
  if (!IsWhitespace(*cursor)) {
    return false;
  }
  while (IsWhitespace(*cursor)) {
    ++cursor;
  }
  for (std::size_t index = 0U;; ++index) {
    if (cursor[index] != kServiceArgument[index]) {
      return false;
    }
    if (kServiceArgument[index] == L'\0') {
      cursor += index;
      break;
    }
  }
  while (IsWhitespace(*cursor)) {
    ++cursor;
  }
  return *cursor == L'\0';
}

bool IsUsableStandardHandle(HANDLE handle) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE) {
    return false;
  }
  SetLastError(NO_ERROR);
  const DWORD type = GetFileType(handle);
  return type != FILE_TYPE_UNKNOWN || GetLastError() == NO_ERROR;
}

StreamReadResult ReadExact(
    HANDLE input,
    std::uint8_t* destination,
    std::size_t length) noexcept {
  if (destination == nullptr && length != 0U) {
    return StreamReadResult::Failure;
  }
  std::size_t offset = 0U;
  while (offset < length) {
    const std::size_t remaining = length - offset;
    const DWORD requested = remaining > MAXDWORD
                                ? MAXDWORD
                                : static_cast<DWORD>(remaining);
    DWORD received = 0U;
    SetLastError(NO_ERROR);
    if (ReadFile(
            input, destination + offset, requested, &received, nullptr) == FALSE) {
      return GetLastError() == ERROR_BROKEN_PIPE ? StreamReadResult::Eof
                                                  : StreamReadResult::Failure;
    }
    if (received == 0U) {
      return StreamReadResult::Eof;
    }
    if (received > requested) {
      return StreamReadResult::Failure;
    }
    offset += received;
  }
  return StreamReadResult::Success;
}

StreamReadResult RequireExactEof(HANDLE input, bool* exact_eof) noexcept {
  if (exact_eof == nullptr) {
    return StreamReadResult::Failure;
  }
  *exact_eof = false;
  std::uint8_t trailing = 0U;
  DWORD received = 0U;
  SetLastError(NO_ERROR);
  if (ReadFile(input, &trailing, 1U, &received, nullptr) == FALSE) {
    if (GetLastError() == ERROR_BROKEN_PIPE) {
      *exact_eof = true;
      return StreamReadResult::Success;
    }
    return StreamReadResult::Failure;
  }
  *exact_eof = received == 0U;
  return StreamReadResult::Success;
}

bool WriteExact(
    HANDLE output,
    const std::uint8_t* bytes,
    std::size_t length) noexcept {
  if (bytes == nullptr || length == 0U) {
    return false;
  }
  std::size_t offset = 0U;
  while (offset < length) {
    const std::size_t remaining = length - offset;
    const DWORD requested = remaining > MAXDWORD
                                ? MAXDWORD
                                : static_cast<DWORD>(remaining);
    DWORD written = 0U;
    if (WriteFile(
            output, bytes + offset, requested, &written, nullptr) == FALSE ||
        written == 0U || written > requested) {
      return false;
    }
    offset += written;
  }
  return true;
}

void WriteU16(std::uint8_t* bytes, std::uint16_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xFFU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
}

void WriteU32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  bytes[0] = static_cast<std::uint8_t>(value & 0xFFU);
  bytes[1] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
  bytes[2] = static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
  bytes[3] = static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
}

void WriteGcpwHeader(
    std::uint8_t* output,
    std::uint8_t opcode,
    std::uint32_t payload_length) noexcept {
  output[0] = 'G';
  output[1] = 'C';
  output[2] = 'P';
  output[3] = 'W';
  WriteU16(output + 4U, gc::kProtocolVersion);
  output[6] = opcode;
  output[7] = 0U;
  WriteU32(output + 8U, gc::kRequestId);
  WriteU32(output + 12U, payload_length);
}

std::size_t BuildGcpwError(
    gc::ErrorCode error_code,
    std::array<std::uint8_t, kProtectedMaximumResponseBytes>* output) noexcept {
  if (output == nullptr) {
    return 0U;
  }
  output->fill(0U);
  WriteGcpwHeader(
      output->data(),
      0x7FU,
      static_cast<std::uint32_t>(gc::kErrorPayloadBytes));
  WriteU32(
      output->data() + gc::kHeaderBytes,
      static_cast<std::uint32_t>(error_code));
  return kGcpwErrorFrameBytes;
}

std::size_t BuildGcpwSuccess(
    std::uint8_t request_opcode,
    const gc::ClientExchangeResponse& exchange,
    std::array<std::uint8_t, kProtectedMaximumResponseBytes>* output) noexcept {
  const std::uint32_t expected_length =
      request_opcode == static_cast<std::uint8_t>(gc::Opcode::Inspect)
          ? static_cast<std::uint32_t>(gc::kProtectedInspectPayloadBytes)
      : request_opcode == static_cast<std::uint8_t>(gc::Opcode::CreateKeyset)
          ? static_cast<std::uint32_t>(gc::kCreateKeysetResultBytes)
      : request_opcode == static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset)
          ? static_cast<std::uint32_t>(gc::kRevokeKeysetResultBytes)
      : request_opcode == static_cast<std::uint8_t>(gc::Opcode::SignAdmissionEvidence)
          ? static_cast<std::uint32_t>(gc::kSignAdmissionEvidenceResultBytes)
          : 0U;
  if (output == nullptr || exchange.result_length != expected_length) {
    return 0U;
  }
  output->fill(0U);
  WriteGcpwHeader(
      output->data(),
      static_cast<std::uint8_t>(request_opcode | 0x80U),
      expected_length);
  for (std::size_t index = 0U; index < exchange.result_length; ++index) {
    (*output)[gc::kHeaderBytes + index] = exchange.result[index];
  }
  return gc::kHeaderBytes + exchange.result_length;
}

int EmitLocalProtocolInvalid(HANDLE output) noexcept {
  std::array<std::uint8_t, kProtectedMaximumResponseBytes> response{};
  const std::size_t length =
      BuildGcpwError(gc::ErrorCode::ProtocolInvalid, &response);
  return length != 0U && WriteExact(output, response.data(), length)
             ? static_cast<int>(gc::ExitCode::ProtocolInvalid)
             : static_cast<int>(gc::ExitCode::IoFailed);
}

int RunServiceStdio() noexcept {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!IsUsableStandardHandle(input) || !IsUsableStandardHandle(output)) {
    return static_cast<int>(gc::ExitCode::IoFailed);
  }

  std::array<std::uint8_t, gc::kHeaderBytes> header_bytes{};
  const StreamReadResult header_read =
      ReadExact(input, header_bytes.data(), header_bytes.size());
  if (header_read == StreamReadResult::Failure) {
    return static_cast<int>(gc::ExitCode::IoFailed);
  }
  if (header_read == StreamReadResult::Eof) {
    return EmitLocalProtocolInvalid(output);
  }
  gc::RequestHeader header{};
  const gc::HeaderStatus header_status =
      gc::ParseHeader(header_bytes.data(), header_bytes.size(), &header);
  if (header_status == gc::HeaderStatus::PayloadTooLarge ||
      header.payload_length > g_request_body.size()) {
    return EmitLocalProtocolInvalid(output);
  }
  const StreamReadResult body_read =
      ReadExact(input, g_request_body.data(), header.payload_length);
  if (body_read == StreamReadResult::Failure) {
    return static_cast<int>(gc::ExitCode::IoFailed);
  }
  if (body_read == StreamReadResult::Eof) {
    return EmitLocalProtocolInvalid(output);
  }
  bool exact_eof = false;
  if (RequireExactEof(input, &exact_eof) == StreamReadResult::Failure) {
    return static_cast<int>(gc::ExitCode::IoFailed);
  }
  gc::CreateKeysetRequest create_request{};
  gc::RevokeKeysetRequest revoke_request{};
  gc::SignAdmissionEvidenceRequest sign_request{};
  const bool body_valid =
      (header.opcode == static_cast<std::uint8_t>(gc::Opcode::Inspect) &&
       header.payload_length == 0U) ||
      (header.opcode == static_cast<std::uint8_t>(gc::Opcode::CreateKeyset) &&
       gc::DecodeCreateKeysetRequest(
           g_request_body.data(), header.payload_length, &create_request)) ||
      (header.opcode == static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset) &&
       gc::DecodeRevokeKeysetRequest(
           g_request_body.data(), header.payload_length, &revoke_request)) ||
      (header.opcode == static_cast<std::uint8_t>(gc::Opcode::SignAdmissionEvidence) &&
       gc::DecodeSignAdmissionEvidenceRequest(
           g_request_body.data(), header.payload_length, &sign_request)) ||
      (header.opcode != static_cast<std::uint8_t>(gc::Opcode::Inspect) &&
       header.opcode != static_cast<std::uint8_t>(gc::Opcode::CreateKeyset) &&
       header.opcode != static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset) &&
       header.opcode != static_cast<std::uint8_t>(gc::Opcode::SignAdmissionEvidence));
  const bool locally_valid =
      exact_eof && header_status == gc::HeaderStatus::Valid &&
      gc::IsRecognizedOpcode(header.opcode) && body_valid;
  if (!locally_valid) {
    return EmitLocalProtocolInvalid(output);
  }

  gc::ClientExchangeRequest request{};
  request.opcode = header.opcode;
  request.body = header.payload_length == 0U ? nullptr : g_request_body.data();
  request.body_length = header.payload_length;
  if (header.opcode == static_cast<std::uint8_t>(gc::Opcode::CreateKeyset)) {
    request.operation_id = create_request.operation_id;
    request.expected_state_sha256 = create_request.expected_state_sha256;
  } else if (header.opcode == static_cast<std::uint8_t>(gc::Opcode::RevokeLocalKeyset)) {
    request.operation_id = revoke_request.operation_id;
    request.expected_state_sha256 = revoke_request.expected_state_sha256;
  } else if (
      header.opcode == static_cast<std::uint8_t>(gc::Opcode::SignAdmissionEvidence)) {
    request.operation_id = sign_request.operation_id;
    request.expected_state_sha256 = sign_request.expected_state_sha256;
  }
  gc::ClientExchangeResponse exchange{};
  const gc::ClientExchangeDisposition disposition =
      gc::RunProtectedClientExchange(request, &exchange);
  std::array<std::uint8_t, kProtectedMaximumResponseBytes> response{};
  std::size_t response_length = 0U;
  int exit_code = static_cast<int>(gc::ExitCode::IoFailed);
  switch (disposition) {
    case gc::ClientExchangeDisposition::Success:
      response_length = BuildGcpwSuccess(header.opcode, exchange, &response);
      exit_code = static_cast<int>(gc::ExitCode::Success);
      break;
    case gc::ClientExchangeDisposition::ProtocolInvalid:
      response_length = BuildGcpwError(gc::ErrorCode::ProtocolInvalid, &response);
      exit_code = static_cast<int>(gc::ExitCode::ProtocolInvalid);
      break;
    case gc::ClientExchangeDisposition::OperationUnavailable:
      response_length =
          BuildGcpwError(gc::ErrorCode::OperationUnavailable, &response);
      exit_code = static_cast<int>(gc::ExitCode::OperationUnavailable);
      break;
    case gc::ClientExchangeDisposition::IoFailed:
      response_length = BuildGcpwError(gc::ErrorCode::IoFailed, &response);
      exit_code = static_cast<int>(gc::ExitCode::IoFailed);
      break;
    case gc::ClientExchangeDisposition::TransportFailure:
      return static_cast<int>(gc::ExitCode::IoFailed);
  }
  if (response_length == 0U ||
      !WriteExact(output, response.data(), response_length)) {
    return static_cast<int>(gc::ExitCode::IoFailed);
  }
  return exit_code;
}

}  // namespace

extern "C" __declspec(noreturn) void WINAPI ProvisionerClientEntryPoint() noexcept {
  __security_init_cookie();
  int exit_code = static_cast<int>(gc::ExitCode::Usage);
  if (IsExactServiceCommandLine(GetCommandLineW())) {
    exit_code = RunServiceStdio();
  }
  SecureZeroMemory(g_request_body.data(), g_request_body.size());
  ExitProcess(static_cast<UINT>(exit_code));
}
