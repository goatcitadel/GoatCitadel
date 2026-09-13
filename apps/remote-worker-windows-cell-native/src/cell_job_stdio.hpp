#pragma once
#include <windows.h>
#include <cstdint>
#include <memory>

namespace goatcitadel::worker_cell {
inline constexpr DWORD kMaximumCellJobInputBytes = 1024 * 1024;
inline constexpr DWORD kCellJobStdioQueueBytes = 65536;
enum class JobOutputStream { standard_output, standard_error };
struct JobStdioAccess;

// One owner-side interactive channel for one native job. This does not launch a
// process, grant authority or provide an MCP implementation. The owner must join
// RunBoundedJob before destroying this object. Calls never wait for child I/O.
class JobStdioChannel final {
 public:
  JobStdioChannel();
  ~JobStdioChannel();
  JobStdioChannel(const JobStdioChannel&) = delete;
  JobStdioChannel& operator=(const JobStdioChannel&) = delete;

  // Accept an entire chunk or none. ERROR_RETRY means the bounded queue is full;
  // it does not authorize retrying a tool effect. EOF is explicit and terminal.
  // Input may be queued before launch, but the admitted limit is checked again
  // before process creation and remains the cumulative limit across all chunks.
  DWORD WriteInput(const std::uint8_t* bytes, DWORD count, bool eof = false) noexcept;
  // Read at most capacity bytes. EOF is true only after the exact job has ended
  // and this queue is empty. Overflow is an error, never a truncated protocol.
  DWORD ReadOutput(JobOutputStream stream, std::uint8_t* bytes, DWORD capacity,
                   DWORD* count, bool* eof) noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
  friend struct JobStdioAccess;
};
}  // namespace goatcitadel::worker_cell
