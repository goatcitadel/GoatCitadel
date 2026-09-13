#include "cell_job.hpp"
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* description) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(description) + " (input check " + std::to_string(checks) + ")");
}
std::string Text(const OutputCapture& output) {
  return std::string(output.prefix.begin(), output.prefix.end()) + std::string(output.tail.begin(), output.tail.end());
}
std::vector<std::uint8_t> Payload(std::size_t size) {
  std::vector<std::uint8_t> value(size);
  for (std::size_t index = 0; index < value.size(); ++index) value[index] = static_cast<std::uint8_t>((index * 17 + index / 251) % 256);
  return value;
}
void Delivered(const JobResult& result, const std::vector<std::uint8_t>& input) {
  if (result.error || result.end != JobEnd::exited || result.process_exit_code)
    std::fprintf(stderr, "Input result: error=%lu end=%u exit=%lu sent=%llu complete=%d output=%s\n",
      result.error, static_cast<unsigned>(result.end), result.process_exit_code,
      static_cast<unsigned long long>(result.standard_input_bytes_written), result.standard_input_complete,
      Text(result.standard_output).c_str());
  Check(result.end == JobEnd::exited && result.error == ERROR_SUCCESS && result.process_exit_code == 0,
    "input consumer exits normally");
  Check(result.zero_processes_verified && result.output_drained && result.app_container_verified && result.launch_files_verified,
    "input delivery preserves token, file, output and exact job cleanup evidence");
  Check(result.standard_input_complete && result.standard_input_bytes_written == input.size(), "bounded input delivery is retained");
  std::uint64_t hash = 14695981039346656037ULL;
  for (const auto value : input) { hash ^= value; hash *= 1099511628211ULL; }
  const std::string expected = "input_bytes=" + std::to_string(input.size()) + " input_hash=" + std::to_string(hash) + " eof=1 readonly=1";
  Check(Text(result.standard_output).find(expected) != std::string::npos,
    "AppContainer consumes exact binary bytes through a read-only handle and observes EOF");
}
void Stopped(const JobResult& result, JobEnd expected, ULONGLONG started, std::size_t bytes) {
  Check(result.end == expected && result.error == ERROR_SUCCESS, "non-reading child preserves the requested stop disposition");
  Check(result.zero_processes_verified && result.output_drained, "pending input does not block exact-job termination or output draining");
  Check(!result.standard_input_complete && result.standard_input_bytes_written < bytes, "partial input is never reported complete");
  Check(GetTickCount64() - started < 5000, "pending input cancellation completes within the bounded controller window");
}
}

unsigned RunCellJobInputTests(const std::wstring& image,
  JobCommand (*command)(const std::wstring&, const std::wstring&), JobLimits limits) {
  limits.wall_ms = 10000;
  limits.input_bytes = 1024 * 1024;
  auto request = command(image, L"input");
  auto result = RunBoundedJob(request, limits);
  Delivered(result, request.standard_input);
  for (const std::size_t count : {std::size_t{1}, std::size_t{4096}, std::size_t{1024 * 1024}}) {
    request = command(image, L"input");
    request.standard_input = Payload(count);
    result = RunBoundedJob(request, limits);
    Delivered(result, request.standard_input);
  }
  request = command(image, L"input-pressure");
  request.standard_input = Payload(257 * 1024 + 31);
  auto pressure = limits;
  pressure.raw_output_bytes = 8 * 1024 * 1024;
  result = RunBoundedJob(request, pressure);
  Delivered(result, request.standard_input);
  Check(result.standard_output.raw_bytes > 4096 && result.standard_error.raw_bytes > 4096,
    "input progresses while both output pipes exceed their kernel buffers");
  Check(result.standard_output.truncated && result.standard_error.truncated,
    "input delivery preserves bounded diagnostic capture under output pressure");

  request = command(image, L"input-close");
  request.standard_input = Payload(limits.input_bytes);
  result = RunBoundedJob(request, limits);
  Check(result.end == JobEnd::control_failed && (result.error == ERROR_BROKEN_PIPE || result.error == ERROR_NO_DATA),
    "early stdin closure cannot report a successful request delivery");
  Check(result.zero_processes_verified && result.output_drained && !result.standard_input_complete,
    "early stdin closure cancels and drains the exact child job");

  request = command(image, L"sleep");
  request.standard_input = Payload(limits.input_bytes);
  auto wall = limits;
  wall.wall_ms = 120;
  auto started = GetTickCount64();
  result = RunBoundedJob(request, wall);
  Stopped(result, JobEnd::wall_limit, started, request.standard_input.size());

  HANDLE cancellation = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Check(cancellation != nullptr, "input cancellation fixture owns its event");
  started = GetTickCount64();
  std::thread cancel([&] { Sleep(120); SetEvent(cancellation); });
  result = RunBoundedJob(request, limits, cancellation);
  cancel.join();
  CloseHandle(cancellation);
  Stopped(result, JobEnd::cancelled, started, request.standard_input.size());

  request = command(image, L"flood");
  request.standard_input = Payload(limits.input_bytes);
  started = GetTickCount64();
  result = RunBoundedJob(request, limits);
  Stopped(result, JobEnd::output_limit, started, request.standard_input.size());

  request = command(image, L"input");
  request.standard_input = {0};
  auto empty_only = limits;
  empty_only.input_bytes = 0;
  result = RunBoundedJob(request, empty_only);
  Check(result.process_id == 0 && result.error == ERROR_INVALID_PARAMETER, "zero input allowance rejects nonempty input before launch");
  request.standard_input = Payload(limits.input_bytes + 1);
  result = RunBoundedJob(request, limits);
  Check(result.process_id == 0 && result.error == ERROR_INVALID_PARAMETER, "oversized request bytes never launch");
  request.standard_input.clear();
  ++limits.input_bytes;
  result = RunBoundedJob(request, limits);
  Check(result.process_id == 0 && result.error == ERROR_INVALID_PARAMETER, "declared input allowance cannot exceed the internal ceiling");
  return checks;
}
