#include "cell_stdio_protocol.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <stdexcept>
#include <thread>

namespace {
using namespace goatcitadel::worker_cell;
DWORD Integer(const std::uint8_t* bytes) {
  return static_cast<DWORD>(bytes[0]) | (static_cast<DWORD>(bytes[1]) << 8) |
    (static_cast<DWORD>(bytes[2]) << 16) | (static_cast<DWORD>(bytes[3]) << 24);
}
bool ReadExact(void* output, DWORD size) {
  auto* bytes = static_cast<std::uint8_t*>(output);
  for (DWORD offset = 0; offset < size;) {
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes + offset, size - offset, &count, nullptr) || !count) return false;
    offset += count;
  }
  return true;
}
bool WriteExact(const void* input, DWORD size) {
  const auto* bytes = static_cast<const std::uint8_t*>(input);
  for (DWORD offset = 0; offset < size;) {
    DWORD count = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes + offset, size - offset, &count, nullptr) || !count) return false;
    offset += count;
  }
  return true;
}
bool Frame(std::uint8_t kind, const std::uint8_t* bytes, DWORD size) {
  std::array<std::uint8_t, 5> header{kind, static_cast<std::uint8_t>(size), static_cast<std::uint8_t>(size >> 8),
    static_cast<std::uint8_t>(size >> 16), static_cast<std::uint8_t>(size >> 24)};
  return size <= kMaximumStdioFrameBytes && WriteExact(header.data(), static_cast<DWORD>(header.size())) && WriteExact(bytes, size);
}
bool Completion(const RuntimeJobResult& result, DWORD error) {
  const auto value = WorkerStdioCompletion(result, error);
  return Frame(3, reinterpret_cast<const std::uint8_t*>(value.data()), static_cast<DWORD>(value.size()));
}
class JobOwner final {
 public:
  JobOwner(const RuntimeJobCommand& command, const JobLimits& limits) {
    cancellation_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!cancellation_) throw std::runtime_error("event");
    try {
      thread_ = std::thread([this, command, limits] {
        result_ = RunVerifiedRuntimeJob(command, limits, cancellation_, &channel);
        done_.store(true);
      });
    } catch (...) { CloseHandle(cancellation_); throw; }
  }
  ~JobOwner() { Cancel(); Join(); CloseHandle(cancellation_); }
  void Cancel() noexcept { SetEvent(cancellation_); }
  void Join() noexcept { if (thread_.joinable()) thread_.join(); }
  bool Done() const noexcept { return done_.load(); }
  const RuntimeJobResult& Result() const noexcept { return result_; }
  JobStdioChannel channel;
 private:
  HANDLE cancellation_ = nullptr;
  std::thread thread_;
  std::atomic<bool> done_{false};
  RuntimeJobResult result_;
};
int Execute() {
  std::array<std::uint8_t, 12> header{};
  RuntimeJobCommand command;
  JobLimits limits;
  DWORD error = ERROR_INVALID_PARAMETER;
  if (!ReadExact(header.data(), static_cast<DWORD>(header.size()))) return Completion({}, error) ? 0 : 3;
  const bool protected_workspace = std::memcmp(header.data(), kWorkerProtectedStdioMagic, 8) == 0;
  if (!protected_workspace && std::memcmp(header.data(), kWorkerStdioMagic, 8)) return Completion({}, error) ? 0 : 3;
  const DWORD size = Integer(header.data() + 8);
  if (!size || size > kMaximumStdioConfigurationBytes) return Completion({}, error) ? 0 : 3;
  std::vector<std::uint8_t> configuration(size);
  if (!ReadExact(configuration.data(), size)) return Completion({}, error) ? 0 : 3;
  error = DecodeWorkerStdioConfiguration(configuration, &command, &limits, protected_workspace);
  if (error) return Completion({}, error) ? 0 : 3;
  // Only this local owner reads parent handles. The child inherits three new
  // job-owned handles. The Node owner imposes an overall helper deadline, also
  // covering a parent that stalls configuration or stops draining this pipe.
  JobOwner owner(command, limits);
  std::vector<std::uint8_t> control;
  control.reserve(kMaximumStdioFrameBytes + 5);
  bool output_eof = false, error_eof = false;
  error = ERROR_SUCCESS;
  for (;;) {
    for (const auto stream : {JobOutputStream::standard_output, JobOutputStream::standard_error}) {
      std::array<std::uint8_t, 4096> bytes{};
      DWORD count = 0; bool eof = false;
      error = owner.channel.ReadOutput(stream, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &eof);
      if (error) break;
      if (count && !Frame(stream == JobOutputStream::standard_output ? 1 : 2, bytes.data(), count)) { error = ERROR_BROKEN_PIPE; break; }
      (stream == JobOutputStream::standard_output ? output_eof : error_eof) = eof;
    }
    if (error || (owner.Done() && (output_eof && error_eof))) break;
    // A prelaunch refusal does not begin the channel. It still has a final job
    // result and must not leave this bridge waiting for channel EOF indefinitely.
    if (owner.Done()) { owner.Join(); if (!owner.Result().job.process_id) break; }
    DWORD available = 0;
    if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) { error = ERROR_BROKEN_PIPE; break; }
    if (available && control.size() < kMaximumStdioFrameBytes + 5) {
      const DWORD count = static_cast<DWORD>(std::min<std::size_t>({4096, available, kMaximumStdioFrameBytes + 5 - control.size()}));
      const auto offset = control.size(); control.resize(offset + count);
      if (!ReadExact(control.data() + offset, count)) { error = ERROR_BROKEN_PIPE; break; }
    }
    if (control.size() >= 5) {
      const DWORD length = Integer(control.data() + 1);
      const auto kind = control[0];
      if (length > kMaximumStdioFrameBytes || kind < 1 || kind > 3 ||
          (kind == 1 ? !length : length != 0)) { error = ERROR_INVALID_PARAMETER; break; }
      if (control.size() >= length + 5) {
        if (kind == 3) owner.Cancel();
        else {
          error = owner.channel.WriteInput(length ? control.data() + 5 : nullptr, length, kind == 2);
          if (error != ERROR_SUCCESS && error != ERROR_RETRY) break;
        }
        if (error != ERROR_RETRY) control.erase(control.begin(), control.begin() + length + 5);
        error = ERROR_SUCCESS;
      }
    }
    Sleep(1);
  }
  if (error) owner.Cancel();
  owner.Join();
  return Completion(owner.Result(), error) ? 0 : 3;
}
}
int wmain(int argc, wchar_t**) {
  if (argc != 1 || GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE ||
      GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE) return 2;
  try { return Execute(); }
  catch (...) { return Completion({}, ERROR_NOT_ENOUGH_MEMORY) ? 0 : 3; }
}
