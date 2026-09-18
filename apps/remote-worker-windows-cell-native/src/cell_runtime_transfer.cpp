#include "cell_runtime_transfer.hpp"
#include <algorithm>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
void Put32(std::uint8_t* bytes, DWORD value) noexcept {
  for (unsigned index = 0; index < 4; ++index) bytes[index] = static_cast<std::uint8_t>(value >> (index * 8));
}
DWORD U32(const std::uint8_t* bytes) noexcept {
  return static_cast<DWORD>(bytes[0]) | (static_cast<DWORD>(bytes[1]) << 8) |
    (static_cast<DWORD>(bytes[2]) << 16) | (static_cast<DWORD>(bytes[3]) << 24);
}
template <std::size_t Size>
std::array<std::uint8_t, Size> Header(const char* magic, const CellRuntimeDispatchBinding& binding, DWORD size) noexcept {
  std::array<std::uint8_t, Size> bytes{};
  std::memcpy(bytes.data(), magic, 8);
  std::copy(binding.nonce.begin(), binding.nonce.end(), bytes.begin() + 8);
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), bytes.begin() + 40);
  Put32(bytes.data() + 72, size);
  return bytes;
}
}
DWORD CellRuntimeTransfer::Check() const noexcept {
  const auto control = [&]() noexcept -> DWORD {
    if (!authority_.cancellation || authority_.cancellation == INVALID_HANDLE_VALUE) return ERROR_INVALID_HANDLE;
    const auto state = WaitForSingleObject(authority_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    if (now >= deadline_) return ERROR_TIMEOUT;
    return deadline_ - now > 600000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = control();
  if (!error) error = authority_.authorize(authority_.context);
  return error ? error : control();
}
DWORD CellRuntimeTransfer::Begin() noexcept {
  if (attempted_) return ERROR_INVALID_STATE;
  attempted_ = true;
  if (!authority_.authorize || !std::any_of(expected_.nonce.begin(), expected_.nonce.end(), [](auto byte) { return byte != 0; }) ||
      !std::any_of(expected_.request_sha256.begin(), expected_.request_sha256.end(), [](auto byte) { return byte != 0; })) return ERROR_INVALID_PARAMETER;
  return Check();
}
DWORD CellRuntimeTransfer::Read(std::vector<std::uint8_t>* output) noexcept {
  if (!output) {
    if (attempted_) return ERROR_INVALID_STATE;
    attempted_ = true; return ERROR_INVALID_PARAMETER;
  }
  if (output) output->clear();
  auto error = Begin();
  if (error) return error;
  try {
    std::array<std::uint8_t, 96> header{};
    error = ReadCellPipe(pipe_, header.data(), static_cast<DWORD>(header.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (error) return error;
    const auto size = U32(header.data() + 72);
    if (size <= 156 || size > kMaximumRuntimeDispatchBytes) return ERROR_INVALID_PARAMETER;
    auto expected_header = Header<96>("GCRTX001", expected_, size);
    Put32(expected_header.data() + 76, kRuntimeTransferChunkBytes);
    if (header != expected_header) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes(size);
    for (DWORD offset = 0; offset < size;) {
      error = Check(); if (error) return error;
      std::array<std::uint8_t, 16> chunk{};
      error = ReadCellPipe(pipe_, chunk.data(), static_cast<DWORD>(chunk.size()), authority_.cancellation, deadline_);
      if (error) return error;
      const DWORD count = std::min(kRuntimeTransferChunkBytes, size - offset);
      if (std::memcmp(chunk.data(), "GCRTD001", 8) || U32(chunk.data() + 8) != offset || U32(chunk.data() + 12) != count)
        return ERROR_INVALID_DATA;
      error = ReadCellPipe(pipe_, bytes.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check();
      if (error) return error;
      offset += count;
    }
    CellRuntimeDispatch decoded;
    error = DecodeCellRuntimeDispatch(bytes, expected_, &decoded);
    if (!error) error = Check();
    if (error) return error;
    const auto ack = Header<80>("GCRTA001", expected_, size);
    error = WriteCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error) *output = std::move(bytes);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeTransfer::Write(const std::vector<std::uint8_t>& supplied_bytes) noexcept {
  // Copy before the first external callback, including Begin's authority check.
  if (attempted_) return ERROR_INVALID_STATE;
  if (supplied_bytes.size() <= 156 || supplied_bytes.size() > kMaximumRuntimeDispatchBytes) { attempted_ = true; return ERROR_INVALID_PARAMETER; }
  try {
    const auto bytes = supplied_bytes;
    auto error = Begin(); if (error) return error;
    CellRuntimeDispatch decoded;
    error = DecodeCellRuntimeDispatch(bytes, expected_, &decoded);
    if (error) return error;
    const auto size = static_cast<DWORD>(bytes.size());
    auto header = Header<96>("GCRTX001", expected_, size);
    Put32(header.data() + 76, kRuntimeTransferChunkBytes);
    error = WriteCellPipe(pipe_, header.data(), static_cast<DWORD>(header.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (error) return error;
    for (DWORD offset = 0; offset < size;) {
      error = Check(); if (error) return error;
      const DWORD count = std::min(kRuntimeTransferChunkBytes, size - offset);
      std::array<std::uint8_t, 16> chunk{};
      std::memcpy(chunk.data(), "GCRTD001", 8); Put32(chunk.data() + 8, offset); Put32(chunk.data() + 12, count);
      error = WriteCellPipe(pipe_, chunk.data(), static_cast<DWORD>(chunk.size()), authority_.cancellation, deadline_);
      if (!error) error = WriteCellPipe(pipe_, bytes.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check();
      if (error) return error;
      offset += count;
    }
    std::array<std::uint8_t, 80> ack{};
    error = ReadCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error && ack != Header<80>("GCRTA001", expected_, size)) error = ERROR_INVALID_DATA;
    return error;
  } catch (...) { attempted_ = true; return ERROR_NOT_ENOUGH_MEMORY; }
}
CellRuntimeDispatchResult CellRuntimeTransfer::Run(CellProvisioningJournal& journal, JobStdioChannel* stdio) noexcept {
  std::vector<std::uint8_t> bytes;
  CellRuntimeDispatchResult result;
  result.execution.runtime.job.error = Read(&bytes);
  if (result.execution.runtime.job.error) return result;
  return RunCellRuntimeDispatch(journal, bytes, expected_, authority_, stdio);
}
}
