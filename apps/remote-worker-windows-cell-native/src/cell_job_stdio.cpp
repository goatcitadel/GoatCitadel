#include "cell_job_stdio_internal.hpp"
#include <algorithm>
#include <array>
#include <mutex>

namespace goatcitadel::worker_cell {
namespace {
struct Queue final {
  std::array<std::uint8_t, kCellJobStdioQueueBytes> bytes{};
  DWORD start = 0, size = 0;
  void Put(const std::uint8_t* input, DWORD count) noexcept {
    for (DWORD index = 0; index < count; ++index) bytes[(start + size + index) % bytes.size()] = input[index];
    size += count;
  }
  DWORD Take(std::uint8_t* output, DWORD capacity) noexcept {
    const DWORD count = std::min(capacity, size);
    for (DWORD index = 0; index < count; ++index) output[index] = bytes[(start + index) % bytes.size()];
    start = (start + count) % static_cast<DWORD>(bytes.size());
    size -= count;
    return count;
  }
};
bool ValidStream(JobOutputStream stream) noexcept {
  return stream == JobOutputStream::standard_output || stream == JobOutputStream::standard_error;
}
}
struct JobStdioChannel::State final {
  std::mutex mutex;
  Queue input, output, error;
  DWORD input_limit = kMaximumCellJobInputBytes, accepted = 0, output_error = ERROR_SUCCESS;
  bool begun = false, finished = false, input_eof = false;
};
JobStdioChannel::JobStdioChannel() : state_(std::make_unique<State>()) {}
JobStdioChannel::~JobStdioChannel() = default;

DWORD JobStdioChannel::WriteInput(const std::uint8_t* bytes, DWORD count, bool eof) noexcept {
  if ((count && !bytes) || (!count && !eof) || count > kCellJobStdioQueueBytes) return ERROR_INVALID_PARAMETER;
  try {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->finished || state_->input_eof) return ERROR_BROKEN_PIPE;
    if (count > state_->input_limit - state_->accepted) return ERROR_NOT_ENOUGH_QUOTA;
    if (count > kCellJobStdioQueueBytes - state_->input.size) return ERROR_RETRY;
    state_->input.Put(bytes, count);
    state_->accepted += count;
    state_->input_eof = eof;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_GEN_FAILURE; }
}
DWORD JobStdioChannel::ReadOutput(JobOutputStream stream, std::uint8_t* bytes, DWORD capacity,
                                 DWORD* count, bool* eof) noexcept {
  if (!count || !eof) return ERROR_INVALID_PARAMETER;
  *count = 0; *eof = false;
  if (!ValidStream(stream) || !bytes || !capacity || capacity > kCellJobStdioQueueBytes) return ERROR_INVALID_PARAMETER;
  try {
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->output_error) return state_->output_error;
    auto& queue = stream == JobOutputStream::standard_output ? state_->output : state_->error;
    *count = queue.Take(bytes, capacity);
    *eof = state_->finished && !queue.size;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_GEN_FAILURE; }
}
DWORD JobStdioAccess::Begin(JobStdioChannel& channel, DWORD input_limit) noexcept {
  try {
    auto& state = *channel.state_;
    std::lock_guard<std::mutex> lock(state.mutex);
    if (state.begun || state.finished) return ERROR_ALREADY_EXISTS;
    if (input_limit > kMaximumCellJobInputBytes || state.accepted > input_limit) return ERROR_INVALID_PARAMETER;
    state.input_limit = input_limit;
    state.begun = true;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_GEN_FAILURE; }
}
DWORD JobStdioAccess::TakeInput(JobStdioChannel& channel, std::uint8_t* bytes, DWORD capacity,
                               DWORD* count, bool* eof) noexcept {
  try {
    auto& state = *channel.state_;
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.begun || state.finished) return ERROR_BROKEN_PIPE;
    *count = state.input.Take(bytes, capacity);
    *eof = state.input_eof && !state.input.size;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_GEN_FAILURE; }
}
DWORD JobStdioAccess::PublishOutput(JobStdioChannel& channel, JobOutputStream stream,
                                   const std::uint8_t* bytes, DWORD count) noexcept {
  try {
    auto& state = *channel.state_;
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!state.begun || state.finished || !ValidStream(stream)) return ERROR_INVALID_STATE;
    if (state.output_error) return state.output_error;
    auto& queue = stream == JobOutputStream::standard_output ? state.output : state.error;
    if (count > kCellJobStdioQueueBytes - queue.size) {
      state.output_error = ERROR_NOT_ENOUGH_QUOTA;
      return state.output_error;
    }
    queue.Put(bytes, count);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_GEN_FAILURE; }
}
void JobStdioAccess::Finish(JobStdioChannel& channel, bool cleanup_confirmed) noexcept {
  try {
    auto& state = *channel.state_;
    std::lock_guard<std::mutex> lock(state.mutex);
    if (!cleanup_confirmed && !state.output_error) state.output_error = ERROR_PROCESS_ABORTED;
    state.finished = true;
  } catch (...) { /* No liveness or protocol success is inferred from this signal. */ }
}
}  // namespace goatcitadel::worker_cell
