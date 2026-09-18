#include "cell_runtime_streams.hpp"
#include "cell_controller_runtime.hpp"
#include "cell_runtime_result.hpp"
#include "cell_job_stdio_internal.hpp"
#include "appcontainer_fixture.hpp"
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
using namespace goatcitadel::worker_cell_test;
namespace {
unsigned checks = 0, pipes = 0, actual_jobs = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct Pair final {
  Handle stop, server, client;
  ULONGLONG deadline = GetTickCount64() + 15000;
  Pair() {
    stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.RuntimeStreams.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++pipes);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(stop.value && server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, stop.value, deadline), "Connect exclusive task-owned runtime stream pipe");
  }
};
CellRuntimeDispatchBinding Binding() {
  CellRuntimeDispatchBinding value; value.nonce.fill(0x99); value.request_sha256.fill(0xaa); return value;
}
struct Wire final { CellControllerMessage kind{}; CellRuntimeStreamBytes bytes{}; };
Wire Frame(const CellRuntimeDispatchBinding& binding, CellRuntimeStream stream, std::uint32_t sequence,
  std::uint64_t total, std::span<const std::uint8_t> bytes, bool eof = false) {
  CellRuntimeStreamFrame frame; frame.stream = stream; frame.sequence = sequence; frame.total = total;
  frame.count = static_cast<std::uint32_t>(bytes.size()); frame.eof = eof;
  if (bytes.size() > frame.data.size()) throw std::runtime_error("Fixture payload size");
  std::copy(bytes.begin(), bytes.end(), frame.data.begin());
  Wire wire;
  if (!EncodeCellRuntimeStream(binding, frame, &wire.kind, &wire.bytes)) throw std::runtime_error("Fixture frame encoding");
  return wire;
}
void Codec() {
  auto binding = Binding(); const auto original = binding;
  const std::array<std::uint8_t, 3> data{0, 0xff, 0x80};
  const auto wire = Frame(binding, CellRuntimeStream::output, 1, 3, data);
  CellRuntimeStreamFrame decoded;
  Check(DecodeCellRuntimeStream(binding, wire.kind, wire.bytes, &decoded) && decoded.count == 3 && decoded.sequence == 1 &&
    std::equal(data.begin(), data.end(), decoded.data.begin()), "Binary output preserves NUL and non-UTF8 bytes");
  for (const auto index : {0u, 32u, 64u, 68u, 72u, 1055u}) {
    auto changed = wire.bytes; changed[index] ^= 1;
    CellRuntimeStreamSequence sequence(binding, 100, 100, false);
    Check(sequence.Accept(wire.kind, changed, &decoded) != 0 && !decoded.count && !decoded.sequence, "Corrupt binding, counter, total or padding clears output");
    Check(sequence.Accept(wire.kind, wire.bytes, &decoded) != 0 && !decoded.count, "Malformed stream cannot be revived by valid bytes");
  }
  CellRuntimeStreamSequence sequence(binding, 100, 100, false); binding.nonce.back() ^= 1;
  Check(!sequence.Accept(wire.kind, wire.bytes, &decoded), "Stream sequence retains original caller binding");
  const auto output_end = Frame(original, CellRuntimeStream::output, 2, 3, {}, true);
  const auto error_end = Frame(original, CellRuntimeStream::error, 1, 0, {}, true);
  Check(!sequence.OutputEnded() && !sequence.Accept(output_end.kind, output_end.bytes, &decoded) && !sequence.OutputEnded(), "One EOF is insufficient for complete output");
  Check(!sequence.Accept(error_end.kind, error_end.bytes, &decoded) && sequence.OutputEnded(), "Separate ordered EOF is required for stdout and stderr");
  Check(sequence.Accept(error_end.kind, error_end.bytes, &decoded) != 0 && !sequence.OutputEnded(), "Duplicate EOF fences even a previously ended stream");
  for (unsigned mode = 0; mode < 5; ++mode) {
    CellRuntimeStreamSequence receiver(original, mode == 4 ? 0 : 100, mode == 3 ? 4 : 100, mode == 4);
    auto next = Frame(original, mode == 4 ? CellRuntimeStream::input : CellRuntimeStream::output, mode == 0 ? 2 : 1, mode == 1 ? 4 : 3, data);
    if (mode == 2) next = Frame(original, CellRuntimeStream::input, 1, 3, data);
    if (mode == 3) {
      Check(!receiver.Accept(next.kind, next.bytes, &decoded), "First output fits combined budget");
      next = Frame(original, CellRuntimeStream::error, 1, 3, data);
    }
    Check(receiver.Accept(next.kind, next.bytes, &decoded) != 0 && !decoded.count, "Order, totals, direction and combined output/input limits are enforced");
  }
}
void Backpressure() {
  const auto binding = Binding(); JobStdioChannel channel;
  Check(!JobStdioAccess::Begin(channel, kMaximumCellJobInputBytes), "Begin private input channel");
  CellRuntimeStreamBridge bridge(binding, kMaximumCellJobInputBytes, 1000000);
  std::vector<std::uint8_t> expected(kCellJobStdioQueueBytes + 3);
  for (std::size_t index = 0; index < expected.size(); ++index) expected[index] = static_cast<std::uint8_t>(index);
  std::uint32_t sequence = 0; std::size_t offset = 0;
  std::array<std::uint8_t, 80> ack{};
  while (offset < kCellJobStdioQueueBytes) {
    const auto count = std::min<std::size_t>(kCellRuntimeStreamPayloadBytes, kCellJobStdioQueueBytes - offset);
    const auto wire = Frame(binding, CellRuntimeStream::input, ++sequence, offset + count, std::span(expected).subspan(offset, count));
    Check(!bridge.StageInput(wire.kind, wire.bytes) && !bridge.FlushInput(channel, &ack) &&
      std::equal(ack.begin(), ack.end(), wire.bytes.begin()), "ACK binds only exact bytes accepted into the native channel");
    offset += count;
  }
  const auto staged = Frame(binding, CellRuntimeStream::input, ++sequence, expected.size(), std::span(expected).last(3));
  Check(!bridge.StageInput(staged.kind, staged.bytes), "Stage one bounded input frame while queue is full");
  ack.fill(0xff);
  Check(bridge.FlushInput(channel, &ack) == ERROR_RETRY && bridge.InputPending() && ack == std::array<std::uint8_t, 80>{},
    "Full queue preserves pending input and withholds acknowledgment");
  std::vector<std::uint8_t> actual; std::array<std::uint8_t, 4096> bytes{}; DWORD count = 0; bool eof = false;
  Check(!JobStdioAccess::TakeInput(channel, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &eof) && !eof, "Consume earlier channel data to restore capacity");
  actual.insert(actual.end(), bytes.begin(), bytes.begin() + count);
  Check(!bridge.FlushInput(channel, &ack) && !bridge.InputPending() && std::equal(ack.begin(), ack.end(), staged.bytes.begin()), "Previously staged input is acknowledged exactly once after capacity returns");
  Check(bridge.FlushInput(channel, &ack) == ERROR_NO_MORE_ITEMS && ack == std::array<std::uint8_t, 80>{}, "Flush cannot replay accepted bytes");
  const auto end = Frame(binding, CellRuntimeStream::input, ++sequence, expected.size(), {}, true);
  Check(!bridge.StageInput(end.kind, end.bytes) && !bridge.FlushInput(channel, &ack), "Explicit ordered input EOF enters the same channel");
  while (!eof) {
    Check(!JobStdioAccess::TakeInput(channel, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &eof), "Drain native accepted input");
    actual.insert(actual.end(), bytes.begin(), bytes.begin() + count);
  }
  Check(actual == expected && bridge.StageInput(staged.kind, staged.bytes) != 0, "Backpressure preserves every byte without replay or input after EOF");
  JobStdioChannel failed; Check(!JobStdioAccess::Begin(failed, 0), "Begin failing output fixture");
  JobStdioAccess::Finish(failed, false);
  CellRuntimeStreamBridge output(binding, 0, 100); Wire wire;
  Check(output.NextOutput(failed, JobOutputStream::standard_output, &wire.kind, &wire.bytes) == ERROR_PROCESS_ABORTED && !output.OutputEnded(),
    "Uncertain native job cleanup cannot generate successful stream EOF");
}
void WireFailures() {
  for (unsigned mode = 0; mode < 4; ++mode) {
    Pair pair;
    std::jthread sender([&] {
      const auto wire = Frame(Binding(), mode == 0 ? CellRuntimeStream::output : CellRuntimeStream::input, 1, 0, {}, true);
      if (mode == 0) WriteCellControllerMessage(pair.client.value, wire.kind, wire.bytes.data(), static_cast<DWORD>(wire.bytes.size()), pair.stop.value, pair.deadline);
      else {
        std::array<std::uint8_t, 16> header{}; std::memcpy(header.data(), "GCCELL01", 8);
        header[8] = static_cast<std::uint8_t>(CellControllerMessage::runtime_input_end);
        if (mode == 1) header[8] = static_cast<std::uint8_t>(CellControllerMessage::checkpoint);
        header[12] = 0x20; header[13] = 4;
        if (mode == 2) std::fill(header.begin() + 12, header.end(), std::uint8_t{0xff});
        WriteCellPipe(pair.client.value, header.data(), static_cast<DWORD>(header.size()), pair.stop.value, pair.deadline);
        if (mode == 3) { WriteCellPipe(pair.client.value, wire.bytes.data(), 40, pair.stop.value, pair.deadline); pair.client.Close(); }
      }
    });
    Wire result; result.bytes.fill(0xff);
    const auto error = ReadCellControllerRuntimeEvent(pair.server.value, true, &result.kind, &result.bytes, pair.stop.value, pair.deadline);
    SetEvent(pair.stop.value); sender.join();
    Check(error != 0 && result.bytes == CellRuntimeStreamBytes{}, "Wrong direction/kind, oversized frame and truncation refuse before publishing partial stream bytes");
  }
}
void AdmissionBoundaries() {
  for (unsigned mode = 0; mode < 2; ++mode) {
    Pair pair; const auto binding = Binding(); CellFileSha256 head{}; head.fill(0xbb);
    JobStdioChannel channel;
    Check(!JobStdioAccess::Begin(channel, 100), "Begin isolated admission deadline channel");
    unsigned input_calls = 0;
    CellControllerRuntimeChannelOwner owner{{[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, pair.stop.value},
      &input_calls, [](void* raw, const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept -> DWORD {
        ++*static_cast<unsigned*>(raw);
        while (GetTickCount64() <= deadline) Sleep(1);
        return ERROR_SUCCESS;
      }};
    CellControllerRuntimeChannel bridge(pair.server.value, pair.deadline, binding, head, 100, 100, channel, owner);
    const std::array<std::uint8_t, 1> input{0x42};
    const auto frame = Frame(binding, CellRuntimeStream::input, 1, 1, input);
    CellControllerRuntimeChallenge unsolicited{};
    const auto kind = mode ? CellControllerMessage::runtime_authorized : frame.kind;
    const auto* bytes = mode ? unsolicited.data() : frame.bytes.data();
    const auto size = static_cast<DWORD>(mode ? unsolicited.size() : frame.bytes.size());
    Check(!WriteCellControllerMessage(pair.client.value, kind, bytes, size, pair.stop.value, pair.deadline), "Queue exact private admission fixture frame");
    const auto expected = mode ? DWORD{ERROR_INVALID_DATA} : DWORD{ERROR_TIMEOUT};
    Check(bridge.Pump() == expected && input_calls == (mode ? 0u : 1u), "Expired input admission and unsolicited authority ACK fail before publication");
    std::array<std::uint8_t, 2> received{}; DWORD count = 0, available = 0; bool eof = false;
    Check(!JobStdioAccess::TakeInput(channel, received.data(), static_cast<DWORD>(received.size()), &count, &eof) && !count && !eof,
      "A late callback cannot queue bytes after the fixed exchange deadline");
    Check(PeekNamedPipe(pair.client.value, nullptr, 0, nullptr, &available, nullptr) && !available,
      "Refused input produces no acknowledgment or output frame");
    Check(bridge.Check() == expected && bridge.Pump() == expected && WaitForSingleObject(pair.stop.value, 0) == WAIT_TIMEOUT,
      "Failure remains latched without signalling the borrowed owner cancellation event");
  }
}
JobCommand Command(const std::wstring& image) {
  JobCommand command;
  wchar_t name[48]{};
  swprintf_s(name, L"gc-cell-%016llx%016llx", static_cast<unsigned long long>(GetCurrentProcessId()), static_cast<unsigned long long>(GetTickCount64()));
  command.job_name = name; command.image = image; command.command_line = L"\"" + image + L"\" duplex-echo";
  command.directory = image.substr(0, image.find_last_of(L'\\'));
  command.app_container_name = PrepareAppContainer(command.job_name, image); BindLaunchFixture(&command);
  wchar_t windows[MAX_PATH]{}; const auto length = GetWindowsDirectoryW(windows, MAX_PATH);
  Check(length && length < MAX_PATH, "Resolve explicit fixture SystemRoot");
  command.environment.clear();
  for (const auto& entry : {L"SystemRoot=" + std::wstring(windows), L"LOCALAPPDATA=" + command.directory, L"TEMP=" + command.directory, L"TMP=" + command.directory}) {
    command.environment.insert(command.environment.end(), entry.begin(), entry.end()); command.environment.push_back(L'\0');
  }
  command.environment.push_back(L'\0'); return command;
}
void ActualJob(const std::wstring& image, unsigned mode) {
  Pair pair; const auto binding = Binding(); const auto command = Command(image);
  JobLimits limits{3, 64ULL * 1024 * 1024, 1000, 10000, 1024 * 1024, 1024, kMaximumCellJobInputBytes};
  CellFileSha256 head{}; head.fill(0xbb);
  // The admission/journal side is controlled in this pipe fixture. The returned
  // native job fields below come from the actual child; no inventory is claimed.
  CellRuntimeDispatch runtime_request; runtime_request.binding = binding; runtime_request.reference.checkpoint_sha256 = head;
  runtime_request.command.protected_workspace.emplace(); runtime_request.limits = limits;
  CellRuntimeDispatchResult delivered;
  struct Owner final {
    CellRuntimeDispatchBinding binding;
    CellFileSha256 head;
    unsigned mode = 0, runtime_calls = 0, input_calls = 0;
    ULONGLONG pause_input_until = 0;
    CellControllerRuntimeChannel* bridge = nullptr;
    CellControllerRuntimeChannelOwner* caller = nullptr;
    static DWORD Peer(void*) noexcept { return ERROR_SUCCESS; }
    static DWORD Runtime(void* raw, const CellRuntimeDispatchBinding& expected, const CellFileSha256& head, std::uint32_t ordinal) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.runtime_calls;
      if (expected.nonce != self.binding.nonce || expected.request_sha256 != self.binding.request_sha256 || head != self.head || ordinal != self.runtime_calls)
        return ERROR_INVALID_DATA;
      if (self.mode == 3 && ordinal == 2) self.pause_input_until = GetTickCount64() + 400;
      return (self.mode == 1 && ordinal == 2) || (self.mode == 3 && ordinal == 3) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Input(void* raw, const CellRuntimeDispatchBinding& expected, const CellRuntimeStreamFrame& frame, ULONGLONG) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.input_calls;
      if (self.mode == 2) return ERROR_ACCESS_DENIED;
      if (self.mode == 5) self.bridge->Check(); // Ignoring nested failure must not revive the outer write.
      if (self.mode == 6) { self.caller->input = nullptr; self.caller->peer.authorize = nullptr; }
      if (expected.nonce != self.binding.nonce || expected.request_sha256 != self.binding.request_sha256) return ERROR_INVALID_DATA;
      for (std::uint32_t index = 0; index < frame.count; ++index)
        if (frame.data[index] != static_cast<std::uint8_t>((frame.total - frame.count + index) * 17)) return ERROR_INVALID_DATA;
      return ERROR_SUCCESS;
    }
    static DWORD Authorize(void* raw) noexcept { return static_cast<Owner*>(raw)->bridge->Check(); }
    static DWORD Capture(void*, const JobQuiescence& job) noexcept { return job.Check(); }
    static void Discard(void*) noexcept {}
  } owner{binding, head, mode};
  JobStdioChannel channel;
  CellControllerRuntimeChannelOwner supplied{{Owner::Peer, nullptr, pair.stop.value}, &owner, Owner::Input};
  CellControllerRuntimeChannel bridge(pair.server.value, pair.deadline, binding, head, limits.input_bytes, limits.raw_output_bytes, channel, supplied);
  owner.bridge = &bridge; owner.caller = &supplied;
  JobQuiescenceObserver observer{&owner, Owner::Authorize, Owner::Capture, Owner::Discard, 10000, Owner::Authorize};
  std::atomic<bool> done{false}; JobResult result;
  std::vector<std::uint8_t> input(73728), output, error_output;
  for (std::size_t index = 0; index < input.size(); ++index) input[index] = static_cast<std::uint8_t>(index * 17);
  DWORD client_error = 0, server_error = 0; bool client_ended = false, input_ended = false;
  std::jthread job([&] { result = RunBoundedJob(command, limits, pair.stop.value, &channel, &observer); done.store(true); });
  std::jthread client([&] {
    try {
      CellRuntimeStreamSequence received(binding, limits.input_bytes, limits.raw_output_bytes, false);
      CellControllerRuntimeClient authority(pair.client.value, pair.deadline, binding, head,
        {{Owner::Peer, nullptr, pair.stop.value}, &owner, Owner::Runtime});
      std::size_t offset = 0; std::uint32_t sequence = 0; bool pending = false; Wire sent;
      while (!client_error && !received.OutputEnded()) {
        if (!pending && !input_ended && GetTickCount64() >= owner.pause_input_until) {
          Sleep(4); // Bounded fixture latency forces periodic authority during active streaming.
          const auto count = std::min(kCellRuntimeStreamPayloadBytes, input.size() - offset);
          sent = Frame(binding, CellRuntimeStream::input, ++sequence, offset + count, std::span(input).subspan(offset, count), count == 0);
          client_error = WriteCellControllerMessage(pair.client.value, sent.kind, sent.bytes.data(), static_cast<DWORD>(sent.bytes.size()), pair.stop.value, pair.deadline);
          pending = !client_error;
        }
        Wire next;
        if (!client_error) client_error = ReadCellControllerRuntimeEvent(pair.client.value, false, &next.kind, &next.bytes, pair.stop.value, pair.deadline);
        if (client_error) break;
        if (next.kind == CellControllerMessage::runtime_authority) {
          CellControllerRuntimeChallenge challenge{}; std::copy_n(next.bytes.begin(), challenge.size(), challenge.begin());
          if (mode == 4) challenge[40] ^= 1;
          client_error = authority.Respond(challenge);
        } else if (next.kind == CellControllerMessage::runtime_input_ack) {
          if (!pending || !std::equal(sent.bytes.begin(), sent.bytes.begin() + 80, next.bytes.begin())) { client_error = ERROR_INVALID_DATA; break; }
          CellRuntimeStreamFrame accepted;
          if (!DecodeCellRuntimeStream(binding, sent.kind, sent.bytes, &accepted)) { client_error = ERROR_INVALID_DATA; break; }
          offset += accepted.count; input_ended = accepted.eof; pending = false;
        } else {
          CellRuntimeStreamFrame frame; client_error = received.Accept(next.kind, next.bytes, &frame);
          if (!client_error && frame.count) {
            auto& target = frame.stream == CellRuntimeStream::output ? output : error_output;
            target.insert(target.end(), frame.data.begin(), frame.data.begin() + frame.count);
          }
        }
      }
      client_ended = received.OutputEnded();
      if (!client_error && client_ended) {
        CellRuntimeResultTransfer terminal(pair.client.value, pair.deadline, runtime_request, {Owner::Peer, nullptr, pair.stop.value});
        client_error = terminal.Read(&delivered);
      }
    } catch (...) { client_error = ERROR_GEN_FAILURE; }
    if (client_error) SetEvent(pair.stop.value);
  });
  while (!server_error && !bridge.OutputEnded()) {
    if (GetTickCount64() >= pair.deadline) { server_error = ERROR_TIMEOUT; break; }
    server_error = bridge.Pump(); if (server_error == ERROR_RETRY) server_error = 0;
    if (done.load() && !result.process_id) { server_error = result.error ? result.error : ERROR_PROCESS_ABORTED; break; }
    Sleep(1);
  }
  if (server_error) { bridge.Abort(server_error); SetEvent(pair.stop.value); }
  job.join();
  if (!server_error && bridge.OutputEnded()) {
    CellRuntimeDispatchResult completed; completed.binding = binding; completed.binding_verified = true;
    completed.execution.runtime.job = result;
    CellRuntimeResultTransfer terminal(pair.server.value, pair.deadline, runtime_request, {Owner::Peer, nullptr, pair.stop.value});
    server_error = terminal.Write(completed);
    if (server_error) SetEvent(pair.stop.value);
  }
  client.join(); SetEvent(pair.stop.value);
  if (result.process_id) ++actual_jobs;
  if (mode > 0 && mode < 6) {
    Check(server_error && !bridge.OutputEnded() && !result.quiescent_capture_verified, "Protocol, runtime or input revocation withholds completion and capture");
    if (mode == 1 || mode == 3) Check(client_error == ERROR_ACCESS_DENIED && result.process_id && result.zero_processes_verified && result.output_drained,
      "Canonical revocation stops and joins only the exact job before resume or during streaming");
    if (mode == 1) Check(!result.standard_output.raw_bytes && !result.standard_error.raw_bytes, "Pre-resume refusal cannot execute the output-producing entrypoint");
    if (mode == 3) Check(!input_ended && result.standard_input_bytes_written < input.size(), "Periodic revocation occurs while the child still awaits input, before its EOF or capture");
    if (mode == 2 || mode == 4 || mode == 5) Check(!result.process_id && !result.standard_input_bytes_written, "Denied stdin, wrong approval or reentrant input never launches or writes to a child");
    if (mode == 2) Check(owner.input_calls == 1, "Input requires independent current admission before entering the native queue");
    if (mode == 4) Check(!owner.runtime_calls && client_error == ERROR_INVALID_DATA, "Wrong journal head cannot invoke canonical runtime admission");
    if (mode == 5) Check(server_error == ERROR_BUSY, "Nested input callback cannot reenter I/O or ignore the resulting failure");
    const auto previous = owner.runtime_calls;
    Check(bridge.Check() != 0 && owner.runtime_calls == previous, "Failed multiplexed connection cannot regain authority or retry execution");
    return;
  }
  Check(!server_error && !client_error && client_ended && input_ended && bridge.OutputEnded(), "Actual AppContainer input/output crosses bounded duplex pipe frames through EOF");
  Check(!result.error && !result.process_exit_code && result.zero_processes_verified && result.output_drained && result.app_container_verified && result.process_image_verified,
    "Exact native child and job are verified, joined and drained");
  const std::string ready = "ready\n"; std::vector<std::uint8_t> expected(ready.begin(), ready.end()); expected.insert(expected.end(), input.begin(), input.end());
  Check(output == expected && error_output == input && result.standard_input_bytes_written == input.size() && result.standard_input_complete,
    "Both output streams preserve all 73728 binary input bytes and their independent ordering");
  Check(owner.runtime_calls >= 5 && bridge.AuthorityChecks() == owner.runtime_calls && owner.input_calls >= 77 && result.quiescent_capture_verified,
    "One I/O owner multiplexes fresh runtime checks, separately admitted input, output and final quiescence without losing frames");
  const auto& received_job = delivered.execution.runtime.job;
  Check(delivered.binding_verified && !delivered.execution.inventory_verified && received_job.process_id == result.process_id &&
    received_job.process_exit_code == result.process_exit_code && received_job.quiescent_capture_verified && received_job.zero_processes_verified &&
    received_job.output_drained && received_job.standard_input_bytes_written == input.size() && received_job.standard_output.raw_bytes == output.size() &&
    received_job.standard_error.raw_bytes == error_output.size() && received_job.standard_output.prefix.empty() && received_job.standard_error.tail.empty(),
    "After both EOFs and join, exact actual job metadata crosses the same pipe separately from stream completion");
}
}
int wmain(int argc, wchar_t** argv) {
  int result = 1;
  try {
    if (argc != 2) return 2;
    Codec(); Backpressure(); WireFailures(); AdmissionBoundaries();
    for (unsigned mode = 0; mode < 7; ++mode) ActualJob(argv[1], mode);
    std::printf("{\"passed\":true,\"checks\":%u,\"pipeFixtures\":%u,\"actualJobs\":%u,\"jobAttempts\":7,\"inputBytes\":73728,\"installedService\":false,\"volumeAttached\":false}\n", checks, pipes, actual_jobs);
    result = 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); }
  if (!CleanupAppContainers()) return 97;
  return result;
}
