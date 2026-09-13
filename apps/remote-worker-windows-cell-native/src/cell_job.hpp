#pragma once
#include "cell_filesystem.hpp"
#include "cell_job_stdio.hpp"
#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>

namespace goatcitadel::worker_cell {
// Internal resource-control primitive. This is not the complete native cell
// backend. Each launch requires its canonical AppContainer identity with zero
// capabilities. Do not infer untrusted-work readiness or backend availability.
// Backend composition still needs protected volume/ACL provisioning, complete
// runtime-bundle verification, quotas, network isolation, authority and recovery.
struct JobLimits final {
  DWORD process_limit = 1;
  std::uint64_t memory_bytes = 0;
  DWORD cpu_milli = 0;
  DWORD wall_ms = 0;
  std::uint64_t raw_output_bytes = 0;
  DWORD diagnostic_bytes = 0;
  // Zero permits only empty stdin. The internal hard ceiling is 1 MiB.
  DWORD input_bytes = 0;
};

struct JobCommand final {
  // The canonical platform jobName, gc-cell- followed by 32 lower-case hex digits.
  std::wstring job_name;
  // Provisioned by the owner: GoatCitadel.Worker. plus the same job suffix.
  // This primitive never creates, adopts or deletes a profile or changes ACLs.
  std::wstring app_container_name;
  std::wstring image;
  std::wstring command_line;
  std::wstring directory;
  // Frozen authority from admission, never inferred by the launcher from disk.
  CellFileSha256 expected_image_sha256{};
  CellFileIdentity expected_directory_identity{};
  // Explicit, double-NUL terminated block. Never inherit the host environment.
  std::vector<wchar_t> environment{L'\0', L'\0'};
  // Ephemeral request bytes from the admitted owner, never command-line input.
  // Must be empty when an interactive channel is supplied.
  std::vector<std::uint8_t> standard_input;
};

enum class JobEnd { exited, cancelled, wall_limit, output_limit, launch_failed, control_failed };

struct OutputCapture final {
  std::uint64_t raw_bytes = 0;
  // Ephemeral raw bytes. The Gateway diagnostics owner must sanitize/redact
  // these before persistence or display. The combined buffers are bounded.
  std::vector<std::uint8_t> prefix;
  std::vector<std::uint8_t> tail;
  bool truncated = false;
};

struct JobResult final {
  JobEnd end = JobEnd::launch_failed;
  DWORD error = ERROR_SUCCESS;
  DWORD process_exit_code = 0;
  DWORD process_id = 0;
  DWORD configured_cpu_rate = 0;
  // OS accounting can include process objects rejected during launch. These
  // counters are not the number of successful CreateProcess calls.
  DWORD total_processes = 0;
  DWORD sampled_peak_active_processes = 0;
  std::uint64_t peak_job_memory_bytes = 0;
  std::uint64_t cpu_time_100ns = 0;
  bool terminated_descendants = false;
  // True only after a successful query of the still-held exact job handle.
  bool zero_processes_verified = false;
  bool output_drained = false;
  bool app_container_verified = false;
  bool launch_files_verified = false;
  bool process_image_verified = false;
  // Pipe delivery is not tool acceptance or evidence that an effect completed.
  std::uint64_t standard_input_bytes_written = 0;
  bool standard_input_complete = false;
  OutputCapture standard_output;
  OutputCapture standard_error;
};

// Convert milli-cores to Windows' percentage-times-100 hard cap, rounding down.
// Zero means invalid/unrepresentable and must never become an unlimited job.
DWORD CpuRateForMilliCores(DWORD cpu_milli, DWORD active_processors) noexcept;

// Launch atomically into a fresh private job with only three owned stdio handles.
// The entry process starts suspended and is resumed only after limit/membership
// and actual AppContainer token and loaded-image checks. Bounded stdin is pumped without blocking
// output or cancellation; incomplete delivery cannot report a normal exit.
// The owner drains output and enforces
// cancellation/wall time; parent exit terminates remaining descendants. Existing names
// are refused, never attached to or altered. No named-job absence proves cleanup.
// An optional interactive channel replaces the static input. The same limits,
// AppContainer, launch-file pins and exact-job cleanup govern both paths. The
// cumulative input bound includes every frame; unread output fails at 64 KiB per
// stream. This primitive does not yet compose a destination MCP server owner.
JobResult RunBoundedJob(const JobCommand& command, const JobLimits& limits,
                        HANDLE cancellation = nullptr, JobStdioChannel* stdio = nullptr) noexcept;
}  // namespace goatcitadel::worker_cell
