#pragma once
#include "cell_controller_protocol.hpp"
#include "cell_runtime_dispatch.hpp"

namespace goatcitadel::worker_cell {
inline constexpr std::size_t kCellRuntimeStreamPayloadBytes = 976;
using CellRuntimeStreamBytes = std::array<std::uint8_t, 1056>;
enum class CellRuntimeStream { input, output, error };
struct CellRuntimeStreamFrame final {
  CellRuntimeStream stream = CellRuntimeStream::input;
  bool eof = false;
  std::uint32_t sequence = 0, count = 0;
  std::uint64_t total = 0;
  std::array<std::uint8_t, kCellRuntimeStreamPayloadBytes> data{};
};
bool EncodeCellRuntimeStream(const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame,
  CellControllerMessage* kind, CellRuntimeStreamBytes* output) noexcept;
bool DecodeCellRuntimeStream(const CellRuntimeDispatchBinding& binding, CellControllerMessage kind,
  const CellRuntimeStreamBytes& bytes, CellRuntimeStreamFrame* output) noexcept;
// Ordered stream evidence only. This does not authorize input/tool effects or
// establish job completion. Each direction uses its own instance. Failure is
// terminal; EOF cannot be undone and all three counters are bounded.
class CellRuntimeStreamSequence final {
 public:
  CellRuntimeStreamSequence(const CellRuntimeDispatchBinding& binding, DWORD input_limit,
    std::uint64_t output_limit, bool receiving_input) noexcept
    : binding_(binding), input_limit_(input_limit), output_limit_(output_limit), receiving_input_(receiving_input) {}
  DWORD Accept(CellControllerMessage kind, const CellRuntimeStreamBytes& bytes, CellRuntimeStreamFrame* output) noexcept;
  bool OutputEnded() const noexcept { return !failure_ && ended_[1] && ended_[2]; }
  bool InputEnded() const noexcept { return !failure_ && ended_[0]; }
  std::uint64_t Total(CellRuntimeStream stream) const noexcept;
 private:
  CellRuntimeDispatchBinding binding_;
  DWORD input_limit_;
  std::uint64_t output_limit_;
  bool receiving_input_;
  std::array<std::uint32_t, 3> sequences_{};
  std::array<std::uint64_t, 3> totals_{};
  std::array<bool, 3> ended_{};
  DWORD failure_ = ERROR_SUCCESS;
};
// Trusted native channel adapter. The surrounding single I/O owner serializes
// authority/control frames with these frames, checks current authority, handles
// cancellation and joins the job on any permanent error. Raw bytes are ephemeral
// and require the Gateway's normal sanitization before diagnostics persistence.
class CellRuntimeStreamBridge final {
 public:
  CellRuntimeStreamBridge(const CellRuntimeDispatchBinding& binding, DWORD input_limit, std::uint64_t output_limit) noexcept
    : binding_(binding), input_(binding, input_limit, output_limit, true), output_(binding, input_limit, output_limit, false) {}
  CellRuntimeStreamBridge(const CellRuntimeStreamBridge&) = delete;
  CellRuntimeStreamBridge& operator=(const CellRuntimeStreamBridge&) = delete;
  // Keep at most one staged input frame. Flush returns ERROR_RETRY only while
  // the existing native queue is full; retry that staged frame without receiving
  // or replaying another frame. The 80-byte ACK names accepted channel bytes,
  // never child consumption, tool success, or permission to retry an effect.
  DWORD StageInput(CellControllerMessage kind, const CellRuntimeStreamBytes& bytes) noexcept;
  DWORD FlushInput(JobStdioChannel& channel, std::array<std::uint8_t, 80>* acknowledgment) noexcept;
  bool InputPending() const noexcept { return pending_; }
  // ERROR_NO_MORE_ITEMS means no output is available now (or this stream has
  // already emitted EOF). Success consumes one exact frame; a failed transport
  // must abort this bridge/connection rather than calling again as a retry.
  DWORD NextOutput(JobStdioChannel& channel, JobOutputStream stream,
    CellControllerMessage* kind, CellRuntimeStreamBytes* output) noexcept;
  bool OutputEnded() const noexcept { return !failure_ && output_.OutputEnded(); }
  bool MatchesCompletedInputOutput(const JobResult& job) const noexcept {
    return !failure_ && !pending_ && input_.InputEnded() && output_.OutputEnded() && job.standard_input_complete &&
      input_.Total(CellRuntimeStream::input) == job.standard_input_bytes_written &&
      output_.Total(CellRuntimeStream::output) == job.standard_output.raw_bytes &&
      output_.Total(CellRuntimeStream::error) == job.standard_error.raw_bytes;
  }
  void Abort(DWORD error) noexcept { if (!failure_) failure_ = error ? error : ERROR_OPERATION_ABORTED; }
 private:
  CellRuntimeDispatchBinding binding_;
  CellRuntimeStreamSequence input_, output_;
  CellRuntimeStreamFrame staged_;
  std::array<std::uint8_t, 80> acknowledgment_{};
  std::array<std::uint32_t, 2> output_sequences_{};
  std::array<std::uint64_t, 2> output_totals_{};
  std::array<bool, 2> output_ended_{};
  bool pending_ = false;
  DWORD failure_ = ERROR_SUCCESS;
};
// Runtime incoming frames only: input/EOF, input ACK, output/error/EOF or a
// runtime authority frame/reply. Existing provisioning loops still refuse them.
// The role flag rejects frames from the wrong direction before reading a body.
DWORD ReadCellControllerRuntimeEvent(HANDLE pipe, bool from_worker, CellControllerMessage* kind,
  CellRuntimeStreamBytes* bytes, HANDLE stop, ULONGLONG deadline) noexcept;
}
