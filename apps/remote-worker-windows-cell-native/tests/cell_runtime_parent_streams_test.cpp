#include "cell_runtime_client_session.hpp"
#include <algorithm>
#include <stdexcept>
#include <thread>
#include <cstdio>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0, pipes = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Handle final { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct Pair final {
  Handle stop, server, client; ULONGLONG deadline = GetTickCount64() + 10000;
  Pair() {
    stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.ParentStreams.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++pipes);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(stop.value && server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, stop.value, deadline), "Create exclusive task-owned parent stream pair");
  }
};
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned size = 4) {
  for (unsigned i = 0; i < size; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
CellRuntimeDispatchBinding Binding() { CellRuntimeDispatchBinding b; b.nonce.fill(0x31); b.request_sha256.fill(0x72); return b; }
CellRuntimeParentInputPoll Poll(unsigned ordinal, unsigned sequence, std::uint64_t total) {
  CellRuntimeParentInputPoll bytes{}; const auto b = Binding();
  std::copy(b.nonce.begin(), b.nonce.end(), bytes.begin()); std::copy(b.request_sha256.begin(), b.request_sha256.end(), bytes.begin() + 32);
  Put(bytes.data() + 64, sequence); Put(bytes.data() + 72, total, 8); Put(bytes.data() + 80, ordinal); return bytes;
}
struct Peer final {
  unsigned calls = 0, deny_at = 0; CellRuntimeParentStreams* reenter = nullptr;
  static DWORD Verify(void* raw) noexcept {
    auto& self = *static_cast<Peer*>(raw); ++self.calls;
    if (self.calls == self.deny_at) {
      if (self.reenter) { CellRuntimeInputChunk unused; self.reenter->Input(Binding(), &unused, GetTickCount64() + 1000); return ERROR_SUCCESS; }
      return ERROR_ACCESS_DENIED;
    }
    return ERROR_SUCCESS;
  }
};
DWORD SendInput(Pair& parent, const CellRuntimeParentInputPoll& expected, unsigned state, const CellRuntimeStreamFrame& frame, unsigned corrupt = 0) {
  CellRuntimeParentInputPoll poll{};
  auto error = ReadCellControllerMessage(parent.server.value, CellControllerMessage::runtime_parent_input_poll, poll.data(), static_cast<DWORD>(poll.size()), parent.stop.value, parent.deadline);
  if (!error && poll != expected) error = ERROR_INVALID_DATA;
  CellRuntimeParentInputReply reply{}; std::copy(poll.begin(), poll.end(), reply.begin()); Put(reply.data() + 88, state);
  if (!error && state) {
    CellControllerMessage kind{}; CellRuntimeStreamBytes wire{};
    if (!EncodeCellRuntimeStream(Binding(), frame, &kind, &wire)) error = ERROR_INVALID_DATA;
    else std::copy(wire.begin(), wire.end(), reply.begin() + 92);
  }
  if (corrupt == 1) reply[80] ^= 1;
  if (corrupt == 2) reply.back() = 1;
  if (corrupt == 3) Put(reply.data() + 88, 3);
  if (corrupt == 4) reply[92] ^= 1;
  if (corrupt == 5) reply[92 + 64] ^= 3;
  if (corrupt == 6) reply[92 + 72] ^= 1;
  if (!error) error = WriteCellControllerMessage(parent.server.value, CellControllerMessage::runtime_parent_input_reply,
    reply.data(), static_cast<DWORD>(reply.size()), parent.stop.value, parent.deadline);
  return error;
}
DWORD ReceiveOutput(Pair& parent, const CellRuntimeStreamFrame& frame, unsigned corrupt = 0) {
  CellControllerMessage kind{}; CellRuntimeStreamBytes expected{}, supplied{};
  if (!EncodeCellRuntimeStream(Binding(), frame, &kind, &expected)) return ERROR_INVALID_DATA;
  auto error = ReadCellControllerMessage(parent.server.value, kind, supplied.data(), static_cast<DWORD>(supplied.size()), parent.stop.value, parent.deadline);
  if (!error && supplied != expected) error = ERROR_INVALID_DATA;
  CellRuntimeParentOutputReceipt receipt{}; Put(receipt.data(), static_cast<std::uint32_t>(kind)); std::copy_n(supplied.begin(), 80, receipt.begin() + 4);
  if (corrupt == 1) receipt[0] ^= 2;
  if (corrupt == 2) receipt[4 + 32] ^= 1;
  if (corrupt == 3) receipt[4 + 64] ^= 1;
  if (!error) error = WriteCellControllerMessage(parent.server.value, CellControllerMessage::runtime_parent_output_received,
    receipt.data(), static_cast<DWORD>(receipt.size()), parent.stop.value, parent.deadline);
  return error;
}
CellRuntimeStreamFrame Frame(CellRuntimeStream stream, unsigned sequence = 1, bool eof = false) {
  CellRuntimeStreamFrame frame; frame.stream = stream; frame.sequence = sequence; frame.eof = eof;
  frame.count = eof ? 0 : 976; frame.total = eof ? 976 : sequence * 976;
  for (unsigned i = 0; i < frame.count; ++i) frame.data[i] = static_cast<std::uint8_t>(i); return frame;
}
void RoundTrip() {
  Pair controller, parent; Peer peer; const auto binding = Binding();
  CellRuntimeParentStreams streams(controller.client.value, parent.client.value, parent.deadline, binding, 976, 1952, {Peer::Verify, &peer, parent.stop.value});
  auto input = Frame(CellRuntimeStream::input), output = Frame(CellRuntimeStream::output), error_output = Frame(CellRuntimeStream::error);
  auto input_end = Frame(CellRuntimeStream::input, 2, true), output_end = Frame(CellRuntimeStream::output, 2, true), error_end = Frame(CellRuntimeStream::error, 2, true);
  DWORD parent_error = 0;
  std::thread server([&] {
    parent_error = SendInput(parent, Poll(1, 1, 0), 0, {});
    if (!parent_error) parent_error = SendInput(parent, Poll(2, 1, 0), 1, input);
    if (!parent_error) parent_error = ReceiveOutput(parent, output);
    if (!parent_error) parent_error = ReceiveOutput(parent, error_output);
    if (!parent_error) parent_error = SendInput(parent, Poll(3, 2, 976), 2, input_end);
    if (!parent_error) parent_error = ReceiveOutput(parent, error_end);
    if (!parent_error) parent_error = ReceiveOutput(parent, output_end);
    if (parent_error) SetEvent(parent.stop.value);
  });
  CellRuntimeInputChunk chunk; chunk.count = 9; chunk.eof = true; chunk.bytes.fill(9);
  auto result = streams.Input(binding, &chunk, parent.deadline);
  const bool idle = result == ERROR_NO_MORE_ITEMS && !chunk.count && !chunk.eof && std::all_of(chunk.bytes.begin(), chunk.bytes.end(), [](auto b) { return b == 0; });
  if (result == ERROR_NO_MORE_ITEMS) result = streams.Input(binding, &chunk, parent.deadline);
  const bool input_matches = !result && chunk.count == input.count && !chunk.eof && chunk.bytes == input.data;
  if (!result) result = streams.Output(binding, output, parent.deadline);
  if (!result) result = streams.Output(binding, error_output, parent.deadline);
  if (!result) result = streams.Input(binding, &chunk, parent.deadline);
  const bool eof = !result && chunk.eof && !chunk.count;
  if (!result) result = streams.Output(binding, error_end, parent.deadline);
  if (!result) result = streams.Output(binding, output_end, parent.deadline);
  if (result) SetEvent(parent.stop.value); server.join();
  Check(!result && !parent_error && idle && input_matches && eof, "Parent source idle, binary input and both independent output streams preserve bytes and EOF");
  Check(peer.calls == 21, "Every successful stream exchange rechecks current custody around both directions");
  Check(WaitForSingleObject(parent.stop.value, 0) == WAIT_TIMEOUT, "Successful stream forwarding never signals borrowed cancellation");
  Check(streams.Input(binding, &chunk, parent.deadline) == ERROR_INVALID_STATE && !chunk.count && !chunk.eof,
    "Input after EOF is refused without another source poll");
  DWORD available = 0;
  Check(PeekNamedPipe(controller.server.value, nullptr, 0, nullptr, &available, nullptr) && !available, "Parent forwarding never writes the controller pipe");
}
void Refusal(unsigned mode, bool output) {
  Pair controller, parent; Peer peer; const auto binding = Binding();
  CellRuntimeParentStreams streams(controller.client.value, parent.client.value, parent.deadline, binding, 976, 1952, {Peer::Verify, &peer, parent.stop.value});
  if (mode == 7 || mode == 8) peer.deny_at = 3;
  if (mode == 8) peer.reenter = &streams;
  const auto frame = Frame(output ? CellRuntimeStream::output : CellRuntimeStream::input);
  DWORD parent_error = 0;
  std::thread server([&] {
    parent_error = output ? ReceiveOutput(parent, frame, mode <= 3 ? mode : 0) :
      SendInput(parent, Poll(1, 1, 0), mode == 2 ? 0 : 1, frame, mode <= 6 ? mode : 0);
    if (parent_error) SetEvent(parent.stop.value);
  });
  CellRuntimeInputChunk chunk;
  const auto result = output ? streams.Output(binding, frame, parent.deadline) : streams.Input(binding, &chunk, parent.deadline);
  if (result) SetEvent(parent.stop.value); server.join();
  Check(result != 0, "Changed stream receipt/frame, custody revocation and reentry refuse forwarding");
  if (!output) Check(!chunk.count && !chunk.eof && std::all_of(chunk.bytes.begin(), chunk.bytes.end(), [](auto b) { return b == 0; }), "Failed input never releases partial bytes");
  if (mode == 7) Check(result == ERROR_ACCESS_DENIED, "Stream custody is rechecked after the parent reply");
  if (mode == 8) Check(result == ERROR_BUSY, "Reentrant source request fences the outer stream callback");
  const auto calls = peer.calls;
  Check(streams.Output(binding, frame, parent.deadline) == result && peer.calls == calls, "Failed stream owner cannot replay across callback kinds");
}
void LocalRefusals() {
  Pair controller, parent; const auto binding = Binding(); Handle alias;
  Check(DuplicateHandle(GetCurrentProcess(), controller.client.value, GetCurrentProcess(), &alias.value, 0, FALSE, DUPLICATE_SAME_ACCESS), "Create duplicate stream controller handle");
  for (unsigned mode = 0; mode < 9; ++mode) {
    Peer peer; auto pipe = parent.client.value; auto supplied = binding; auto deadline = parent.deadline;
    if (mode == 0) pipe = controller.client.value;
    if (mode == 1) pipe = alias.value;
    if (mode == 2) pipe = INVALID_HANDLE_VALUE;
    if (mode == 3) supplied.request_sha256.back() ^= 1;
    if (mode == 4) deadline = GetTickCount64();
    if (mode == 5) SetEvent(parent.stop.value);
    CellRuntimeParentStreams streams(controller.client.value, pipe, deadline, binding, mode == 7 ? 0 : 976, mode == 8 ? 1 : 1952,
      {mode == 6 ? nullptr : Peer::Verify, &peer, parent.stop.value});
    CellRuntimeInputChunk chunk; auto frame = Frame(CellRuntimeStream::output);
    if (mode == 7) frame.stream = CellRuntimeStream::input;
    const auto result = streams.Output(supplied, frame, deadline);
    Check(result != 0 && !peer.calls, "Invalid stream pipe, binding, deadline, direction or quota refuses before I/O");
    Check(streams.Input(binding, &chunk, deadline) == result && !peer.calls, "Local stream refusal stays fenced");
    ResetEvent(parent.stop.value);
  }
}
}
unsigned RunCellRuntimeParentStreamsTests() {
  RoundTrip(); for (unsigned mode = 1; mode <= 8; ++mode) Refusal(mode, false);
  for (unsigned mode : {1u, 2u, 3u, 7u, 8u}) Refusal(mode, true);
  LocalRefusals(); Check(pipes == 30, "Parent stream fixtures use thirty private pipe pairs"); return checks;
}
unsigned CellRuntimeParentStreamsTestPipeCount() { return pipes; }
// Test-only native/Node connection. It accepts only this lane's private pipe
// namespace and rechecks the separately supplied parent PID at every boundary.
int RunCellRuntimeParentStreamsInterop(const wchar_t* endpoint, DWORD parent_pid) {
  if (!endpoint || !parent_pid || std::wstring(endpoint).rfind(L"\\\\.\\pipe\\GoatCitadel.NativeStreams.Proof.", 0) != 0) return 2;
  Pair controller;
  Handle parent{CreateFileW(endpoint, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  if (parent.value == INVALID_HANDLE_VALUE) return 3;
  struct Custody final {
    HANDLE pipe; DWORD pid;
    static DWORD CheckPeer(void* raw) noexcept {
      const auto& self = *static_cast<Custody*>(raw); ULONG actual = 0;
      return GetNamedPipeServerProcessId(self.pipe, &actual) && actual == self.pid ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
    }
  } custody{parent.value, parent_pid};
  const auto binding = Binding();
  CellRuntimeParentStreams streams(controller.client.value, parent.value, controller.deadline, binding, 976, 1952,
    {Custody::CheckPeer, &custody, controller.stop.value});
  CellRuntimeInputChunk chunk;
  auto error = streams.Input(binding, &chunk, controller.deadline);
  if (error == ERROR_NO_MORE_ITEMS && !chunk.count && !chunk.eof) error = streams.Input(binding, &chunk, controller.deadline);
  else if (!error) error = ERROR_INVALID_DATA;
  const auto expected = Frame(CellRuntimeStream::input);
  if (!error && (chunk.count != expected.count || chunk.bytes != expected.data || chunk.eof)) error = ERROR_INVALID_DATA;
  if (!error) error = streams.Output(binding, Frame(CellRuntimeStream::output), controller.deadline);
  if (!error) error = streams.Output(binding, Frame(CellRuntimeStream::error), controller.deadline);
  if (!error) error = streams.Input(binding, &chunk, controller.deadline);
  if (!error && (!chunk.eof || chunk.count)) error = ERROR_INVALID_DATA;
  if (!error) error = streams.Output(binding, Frame(CellRuntimeStream::error, 2, true), controller.deadline);
  if (!error) error = streams.Output(binding, Frame(CellRuntimeStream::output, 2, true), controller.deadline);
  DWORD available = 0;
  Check(PeekNamedPipe(controller.server.value, nullptr, 0, nullptr, &available, nullptr) && !available, "Interop leaves controller pipe unused");
  Check(WaitForSingleObject(controller.stop.value, 0) == WAIT_TIMEOUT, "Interop preserves borrowed cancellation");
  std::printf("{\"completed\":%s,\"error\":%lu,\"installedService\":false,\"volumeAttached\":false}\n", error ? "false" : "true", error);
  return 0;
}
