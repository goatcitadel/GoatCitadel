#include "cell_job.hpp"
#include "cell_runtime_bundle.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <functional>
#include <stdexcept>
#include <string>
#include <thread>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* description) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(description) + " (stdio check " + std::to_string(checks) + ")");
}
void Require(bool condition, const char* description) {
  if (!condition) throw std::runtime_error(description);
}
DWORD Write(JobStdioChannel& channel, const std::string& text, bool eof = false) {
  return channel.WriteInput(reinterpret_cast<const std::uint8_t*>(text.data()), static_cast<DWORD>(text.size()), eof);
}
class RunningJob final {
 public:
  RunningJob(const JobCommand& command, const JobLimits& limits, JobStdioChannel& channel) {
    cancellation_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Require(cancellation_ != nullptr, "Create stdio cancellation event failed.");
    try {
      thread_ = std::thread([this, command, limits, &channel] {
        result_ = RunBoundedJob(command, limits, cancellation_, &channel);
        done_.store(true);
      });
    } catch (...) { CloseHandle(cancellation_); throw; }
  }
  ~RunningJob() { if (thread_.joinable()) { SetEvent(cancellation_); thread_.join(); } CloseHandle(cancellation_); }
  void Cancel() { Require(SetEvent(cancellation_) != FALSE, "Cancel stdio fixture failed."); }
  bool Done() const { return done_.load(); }
  const JobResult& Join() { if (thread_.joinable()) thread_.join(); return result_; }
 private:
  HANDLE cancellation_ = nullptr;
  std::thread thread_;
  std::atomic<bool> done_{false};
  JobResult result_;
};
std::string Line(JobStdioChannel& channel, JobOutputStream stream, std::string& pending) {
  const ULONGLONG deadline = GetTickCount64() + 5000;
  for (;;) {
    const auto newline = pending.find('\n');
    if (newline != std::string::npos) {
      const auto result = pending.substr(0, newline);
      pending.erase(0, newline + 1);
      return result;
    }
    Require(GetTickCount64() < deadline, "Interactive output did not reach the expected line.");
    std::array<std::uint8_t, 4096> bytes{};
    DWORD count = 0; bool eof = false;
    Require(channel.ReadOutput(stream, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &eof) == ERROR_SUCCESS,
      "Read interactive output failed.");
    pending.append(reinterpret_cast<const char*>(bytes.data()), count);
    Require(pending.size() <= 8192 && !(eof && pending.find('\n') == std::string::npos), "Incomplete interactive output line.");
    if (!count) Sleep(1);
  }
}
void Clean(const JobResult& result) {
  Check(result.zero_processes_verified && result.output_drained, "interactive owner joins the exact job and drains both pipes");
  Check(result.app_container_verified && result.launch_files_verified, "interactive execution retains AppContainer and exact launch-file checks");
}
}

unsigned RunCellJobStdioTests(const std::wstring& image,
  JobCommand (*command)(const std::wstring&, const std::wstring&), JobLimits limits) {
  limits.wall_ms = 10000;
  limits.input_bytes = kMaximumCellJobInputBytes;
  limits.raw_output_bytes = 4 * 1024 * 1024;
  {
    JobStdioChannel channel;
    RunningJob job(command(image, L"duplex"), limits, channel);
    std::string pending;
    const auto challenge = Line(channel, JobOutputStream::standard_output, pending);
    Check(challenge.rfind("challenge:", 0) == 0 && challenge.size() > 10, "the native child supplies a fresh interactive challenge");
    auto duplicate = RunBoundedJob(command(image, L"exit"), limits, nullptr, &channel);
    Check(duplicate.process_id == 0 && duplicate.error == ERROR_ALREADY_EXISTS, "a second job cannot attach to the live channel");
    const auto response = "answer:" + challenge.substr(10) + "\n";
    Check(Write(channel, response) == ERROR_SUCCESS, "input depends on observed child output");
    Check(Line(channel, JobOutputStream::standard_output, pending) == "accepted", "child validates the response before the second request");
    Check(Write(channel, "finish\n", true) == ERROR_SUCCESS, "the owner closes stdin explicitly after a later request");
    Check(Line(channel, JobOutputStream::standard_output, pending) == "complete", "child observes final request and EOF");
    std::string diagnostic;
    Check(Line(channel, JobOutputStream::standard_error, diagnostic) == "diagnostic", "stderr stays separate from protocol output");
    const auto& result = job.Join();
    Check(result.end == JobEnd::exited && !result.error && result.process_exit_code == 0, "interactive conversation exits successfully");
    Check(result.standard_input_complete && result.standard_input_bytes_written == response.size() + 7, "all interactive input is accounted exactly");
    Clean(result);
    Check(Write(channel, "late") == ERROR_BROKEN_PIPE, "completed channels refuse later input");
    duplicate = RunBoundedJob(command(image, L"exit"), limits, nullptr, &channel);
    Check(duplicate.process_id == 0 && duplicate.error == ERROR_ALREADY_EXISTS, "completed channels cannot be reused for another launch");
  }
  {
    JobStdioChannel channel;
    std::vector<std::uint8_t> payload(128 * 1024 + 37);
    for (std::size_t index = 0; index < payload.size(); ++index) payload[index] = static_cast<std::uint8_t>((index * 17 + index / 251) % 256);
    auto exact = limits; exact.input_bytes = static_cast<DWORD>(payload.size());
    RunningJob job(command(image, L"duplex-echo"), exact, channel);
    std::string pending;
    Check(Line(channel, JobOutputStream::standard_output, pending) == "ready" && pending.empty(), "binary protocol begins with an observed readiness frame");
    std::vector<std::uint8_t> output, error;
    std::size_t sent = 0;
    bool input_closed = false, output_closed = false, error_closed = false, checked_quota = false;
    const ULONGLONG deadline = GetTickCount64() + 9000;
    while (!job.Done() || !output_closed || !error_closed) {
      Require(GetTickCount64() < deadline, "Duplex binary pressure did not finish.");
      if (sent < payload.size()) {
        const DWORD count = static_cast<DWORD>(std::min<std::size_t>(4093, payload.size() - sent));
        const DWORD status = channel.WriteInput(payload.data() + sent, count);
        Require(status == ERROR_SUCCESS || status == ERROR_RETRY, "Interactive binary input was refused.");
        if (!status) sent += count;
      } else if (!input_closed) {
        const std::uint8_t extra = 99;
        Check(channel.WriteInput(&extra, 1) == ERROR_NOT_ENOUGH_QUOTA, "cumulative input limit does not reset after earlier chunks drain");
        checked_quota = true;
        Require(channel.WriteInput(nullptr, 0, true) == ERROR_SUCCESS, "Interactive EOF was refused.");
        input_closed = true;
      }
      for (const auto stream : {JobOutputStream::standard_output, JobOutputStream::standard_error}) {
        std::array<std::uint8_t, 4096> bytes{};
        DWORD count = 0; bool eof = false;
        Require(channel.ReadOutput(stream, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &eof) == ERROR_SUCCESS,
          "Interactive binary output was refused.");
        auto& collected = stream == JobOutputStream::standard_output ? output : error;
        Require(collected.size() + count <= payload.size(), "Interactive output exceeded its exact payload.");
        collected.insert(collected.end(), bytes.begin(), bytes.begin() + count);
        (stream == JobOutputStream::standard_output ? output_closed : error_closed) = eof;
      }
      Sleep(1);
    }
    const auto& result = job.Join();
    Check(checked_quota && input_closed && sent == payload.size(), "pressure sends the entire admitted input and explicit EOF");
    Check(output == payload && error == payload, "both output streams preserve every binary byte across queue wrapping");
    Check(result.end == JobEnd::exited && !result.error && result.process_exit_code == 0, "duplex pressure exits successfully");
    Check(result.standard_input_complete && result.standard_input_bytes_written == payload.size(), "interactive pressure retains exact input accounting");
    Check(result.standard_output.truncated && result.standard_error.truncated, "bounded diagnostics do not truncate the independently consumed protocol");
    Clean(result);
  }
  for (const bool pending_input : {false, true}) {
    JobStdioChannel channel;
    if (pending_input) {
      std::vector<std::uint8_t> bytes(kCellJobStdioQueueBytes, 42);
      Check(channel.WriteInput(bytes.data(), static_cast<DWORD>(bytes.size()), true) == ERROR_SUCCESS, "pending-write fixture queues a bounded input chunk");
    }
    RunningJob job(command(image, L"sleep"), limits, channel);
    const auto started = GetTickCount64();
    Sleep(120); job.Cancel();
    const auto& result = job.Join();
    Check(result.end == JobEnd::cancelled && !result.error, "cancellation works with an idle or backpressured interactive input");
    Check(!result.standard_input_complete && result.standard_input_bytes_written < kCellJobStdioQueueBytes, "cancellation does not invent input delivery");
    Check(GetTickCount64() - started < 5000, "interactive cancellation remains bounded");
    Clean(result);
  }
  {
    JobStdioChannel channel;
    auto short_run = limits; short_run.wall_ms = 120;
    const auto result = RunBoundedJob(command(image, L"sleep"), short_run, nullptr, &channel);
    Check(result.end == JobEnd::wall_limit && !result.error && !result.standard_input_complete, "wall deadline closes an idle interactive session");
    Clean(result);
  }
  for (const auto stream : {JobOutputStream::standard_output, JobOutputStream::standard_error}) {
    JobStdioChannel channel;
    Check(channel.WriteInput(nullptr, 0, true) == ERROR_SUCCESS, "overflow fixture closes input without payload");
    const auto result = RunBoundedJob(command(image, stream == JobOutputStream::standard_output ? L"duplex-flood" : L"duplex-flood-error"),
      limits, nullptr, &channel);
    Check(result.end == JobEnd::output_limit && result.error == ERROR_NOT_ENOUGH_QUOTA, "unread protocol output fails at its fixed queue bound");
    std::array<std::uint8_t, 1> bytes{}; DWORD count = 123; bool eof = true;
    Check(channel.ReadOutput(stream, bytes.data(), 1, &count, &eof) == ERROR_NOT_ENOUGH_QUOTA && !count && !eof,
      "overflow cannot be mistaken for a truncated but completed protocol");
    Clean(result);
  }
  {
    JobStdioChannel channel;
    const auto result = RunBoundedJob(command(image, L"exit"), limits, nullptr, &channel);
    Check(result.end == JobEnd::control_failed && result.error == ERROR_BROKEN_PIPE && !result.standard_input_complete,
      "an exiting child cannot implicitly acknowledge a still-open input stream");
    Clean(result);
  }
  {
    JobStdioChannel channel;
    auto request = command(image, L"input"); request.standard_input = {1};
    auto result = RunBoundedJob(request, limits, nullptr, &channel);
    Check(!result.process_id && result.error == ERROR_INVALID_PARAMETER, "static and interactive input cannot be mixed");
    Check(Write(channel, "abc") == ERROR_SUCCESS, "owner may queue initial input before admission");
    request.standard_input.clear(); auto small = limits; small.input_bytes = 2;
    result = RunBoundedJob(request, small, nullptr, &channel);
    Check(!result.process_id && result.error == ERROR_INVALID_PARAMETER, "prequeued input must fit the admitted bound before launch");
  }
  {
    JobStdioChannel channel;
    std::vector<std::uint8_t> bytes(kCellJobStdioQueueBytes, 42);
    Check(channel.WriteInput(nullptr, 1) == ERROR_INVALID_PARAMETER && channel.WriteInput(nullptr, 0) == ERROR_INVALID_PARAMETER,
      "invalid input pointers and empty non-EOF frames are rejected");
    Check(channel.WriteInput(bytes.data(), static_cast<DWORD>(bytes.size())) == ERROR_SUCCESS, "input queue has a fixed capacity");
    Check(channel.WriteInput(bytes.data(), 1, true) == ERROR_RETRY, "a full queue accepts none of a later chunk or its EOF");
    Check(channel.WriteInput(nullptr, 0, true) == ERROR_SUCCESS && channel.WriteInput(bytes.data(), 1) == ERROR_BROKEN_PIPE,
      "explicit EOF is terminal even before launch");
    DWORD count = 9; bool eof = true;
    Check(channel.ReadOutput(static_cast<JobOutputStream>(99), bytes.data(), 1, &count, &eof) == ERROR_INVALID_PARAMETER && !count && !eof,
      "unknown output channels cannot select a protocol stream");
  }
  return checks;
}

unsigned RunCellRuntimeStdioTests(RuntimeJobCommand request, const std::function<void()>& after_start) {
  const unsigned before = checks;
  request.launch.command_line = L"\"" + request.launch.image + L"\" duplex";
  request.launch.standard_input.clear();
  JobStdioChannel channel;
  RuntimeJobResult result;
  HANDLE cancellation = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Require(cancellation != nullptr, "Create bundle stdio cancellation event failed.");
  std::thread owner;
  const auto close = [&] {
    SetEvent(cancellation);
    if (owner.joinable()) owner.join();
    CloseHandle(cancellation);
  };
  try {
    owner = std::thread([&] {
      result = RunVerifiedRuntimeJob(request, {3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 1024, 4096}, cancellation, &channel);
    });
    std::string pending;
    const auto challenge = Line(channel, JobOutputStream::standard_output, pending);
    Check(challenge.rfind("challenge:", 0) == 0, "verified bundle starts an interactive exchange");
    if (after_start) after_start();
    Require(Write(channel, "answer:" + challenge.substr(10) + "\n") == ERROR_SUCCESS, "Write verified bundle challenge response failed.");
    Check(Line(channel, JobOutputStream::standard_output, pending) == "accepted", "verified bundle receives output-dependent input");
    Require(Write(channel, "finish\n", true) == ERROR_SUCCESS, "Write verified bundle EOF failed.");
    Check(Line(channel, JobOutputStream::standard_output, pending) == "complete", "verified bundle completes its interactive protocol");
    owner.join();
    Check(result.runtime_bundle_verified && result.runtime_bundle_sha256 == request.expected_runtime_bundle,
      "interactive launch retains the complete admitted runtime bundle");
    if (after_start) {
      Check(request.protected_workspace && result.job.end == JobEnd::control_failed && result.job.error == ERROR_INVALID_SECURITY_DESCR &&
        !result.protected_workspace_verified && result.job.process_id && result.job.process_exit_code == 0 && result.job.standard_input_complete,
        "root drift after verified launch refuses success despite a complete zero-exit child");
    } else {
      Check(result.job.end == JobEnd::exited && !result.job.error && result.job.process_exit_code == 0 && result.job.standard_input_complete,
        "verified bundle finishes successfully with explicit input completion");
      Check(result.protected_workspace_verified == request.protected_workspace.has_value(),
        "protected workspace proof requires the recorded roots for the complete exchange");
    }
    Clean(result.job);
  } catch (...) { close(); throw; }
  close();
  return checks - before;
}
