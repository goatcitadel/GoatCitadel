#pragma once
#include "cell_job_stdio.hpp"

namespace goatcitadel::worker_cell {
// Only the native job owner uses this side of the channel. No callback, process
// handle, named pipe or mutable launch configuration crosses the public side.
struct JobStdioAccess final {
  static DWORD Begin(JobStdioChannel& channel, DWORD input_limit) noexcept;
  static DWORD TakeInput(JobStdioChannel& channel, std::uint8_t* bytes, DWORD capacity,
                         DWORD* count, bool* eof) noexcept;
  static DWORD PublishOutput(JobStdioChannel& channel, JobOutputStream stream,
                             const std::uint8_t* bytes, DWORD count) noexcept;
  static void Finish(JobStdioChannel& channel, bool cleanup_confirmed) noexcept;
};
}  // namespace goatcitadel::worker_cell
