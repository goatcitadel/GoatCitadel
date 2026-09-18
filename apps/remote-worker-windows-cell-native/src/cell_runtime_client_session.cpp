#include "cell_runtime_client_session.hpp"
#include <algorithm>
#include <thread>
#include <limits>
#include <cstring>
#include <chrono>
#pragma comment(lib, "onecore.lib")

namespace goatcitadel::worker_cell {
namespace {
struct Event final {
  HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  ~Event() { if (value) CloseHandle(value); }
};
struct MonitorLifetime final {
  HANDLE stop;
  std::jthread& monitor;
  ~MonitorLifetime() { SetEvent(stop); if (monitor.joinable()) monitor.join(); }
};
void PutParent(std::uint8_t* bytes, std::uint64_t value, unsigned size) noexcept {
  for (unsigned i = 0; i < size; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
DWORD Parent32(const std::uint8_t* bytes) noexcept {
  DWORD value = 0; for (unsigned i = 0; i < 4; ++i) value |= static_cast<DWORD>(bytes[i]) << (8 * i); return value;
}
}

struct CellRuntimeHelperForwardingSession::State final {
  HANDLE controller, parent, parent_control;
  HANDLE controller_control = INVALID_HANDLE_VALUE;
  ULONGLONG deadline;
  CellRuntimeDispatch expected;
  CellRuntimeControlEndpointOwner endpoint_owner;
  Event cancel, monitor_done, control_finish;
  CellRuntimeControlEndpoint endpoint;
  std::recursive_mutex peer_mutex;
  std::recursive_timed_mutex upstream_mutex;
  bool checking_peer = false, runtime_complete = false;
  std::atomic<bool> finishing{false};
  std::atomic<DWORD> failure{ERROR_SUCCESS};
  std::unique_ptr<CellRuntimeParentConnection> connection;
  std::unique_ptr<CellRuntimeControlChannel> upstream, downstream;
  CellRuntimeClientSessionResult result;
  std::jthread monitor, forwarder;
  State(HANDLE controller_pipe, HANDLE parent_pipe, HANDLE parent_control_pipe, ULONGLONG until,
      CellRuntimeDispatch request, const CellRuntimeControlEndpointOwner& owner)
    : controller(controller_pipe), parent(parent_pipe), parent_control(parent_control_pipe), deadline(until),
      expected(std::move(request)), endpoint_owner(owner) {}
  ~State() {
    Fail(ERROR_OPERATION_ABORTED);
    if (monitor_done.value) SetEvent(monitor_done.value);
    if (forwarder.joinable()) forwarder.join();
    if (monitor.joinable()) monitor.join();
  }
  DWORD Fail(DWORD error) noexcept {
    if (error) { DWORD clear = ERROR_SUCCESS; failure.compare_exchange_strong(clear, error); }
    if (failure.load() && cancel.value) SetEvent(cancel.value);
    return failure.load();
  }
  DWORD Check() noexcept {
    if (failure.load()) return failure.load();
    if (!endpoint_owner.peer.authorize || !endpoint_owner.peer.cancellation ||
        endpoint_owner.peer.cancellation == INVALID_HANDLE_VALUE) return Fail(ERROR_INVALID_PARAMETER);
    const auto stopped = WaitForSingleObject(endpoint_owner.peer.cancellation, 0);
    if (stopped != WAIT_TIMEOUT) return Fail(stopped == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE);
    const auto now = GetTickCount64();
    return now >= deadline ? Fail(ERROR_TIMEOUT) : deadline - now > 86400000 ? Fail(ERROR_INVALID_PARAMETER) : ERROR_SUCCESS;
  }
  static DWORD Peer(void* raw) noexcept {
    auto& self = *static_cast<State*>(raw);
    try {
      std::lock_guard<std::recursive_mutex> lock(self.peer_mutex);
      if (self.checking_peer) return self.Fail(ERROR_BUSY);
      auto error = self.Check(); if (error) return error;
      self.checking_peer = true;
      error = self.endpoint.Verify();
      self.checking_peer = false;
      if (!error) error = self.Check();
      return self.Fail(error);
    } catch (...) { return self.Fail(ERROR_GEN_FAILURE); }
  }
  CellFootprintScanGuard Guard() noexcept { return {Peer, this, cancel.value}; }
  template<class Operation> DWORD Upstream(ULONGLONG deadline, Operation operation) noexcept {
    try {
      const auto until = std::min(deadline, GetTickCount64() + 5000);
      std::unique_lock<std::recursive_timed_mutex> lock(upstream_mutex, std::defer_lock);
      for (;;) {
        auto error = Check(); if (error) return error;
        if (GetTickCount64() >= until) return Fail(ERROR_TIMEOUT);
        if (lock.try_lock_for(std::chrono::milliseconds(1))) break;
      }
      auto error = Check();
      if (!error) error = operation(until);
      if (!error) error = Check();
      return Fail(error);
    } catch (...) { return Fail(ERROR_GEN_FAILURE); }
  }
  static DWORD Input(void* raw, const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame, ULONGLONG until) noexcept {
    auto& self = *static_cast<State*>(raw);
    return self.Upstream(until, [&](ULONGLONG deadline) { return self.upstream->Input(binding, frame, deadline); });
  }
  static DWORD Deliver(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, ULONGLONG until) noexcept {
    auto& self = *static_cast<State*>(raw);
    return self.Upstream(until, [&](ULONGLONG deadline) { return self.upstream->Deliver(binding, head, deadline); });
  }
  static DWORD File(void* raw, const CellRuntimeFileSelection& file, ULONGLONG until) noexcept {
    auto& self = *static_cast<State*>(raw);
    return self.Upstream(until, [&](ULONGLONG deadline) { return self.upstream->File(file, deadline); });
  }
  void Forward() noexcept {
    const std::array<HANDLE, 2> events{cancel.value, control_finish.value};
    while (!Check()) {
      // Local file receipt uses the same upstream channel as forwarded
      // controller checks. Inspect replies only while owning that channel.
      std::unique_lock<std::recursive_timed_mutex> upstream_lock(upstream_mutex, std::defer_lock);
      if (!upstream_lock.try_lock_for(std::chrono::milliseconds(1))) continue;
      DWORD pending = 0, unsolicited = 0;
      if (!PeekNamedPipe(controller_control, nullptr, 0, nullptr, &pending, nullptr) ||
          !PeekNamedPipe(parent_control, nullptr, 0, nullptr, &unsolicited, nullptr)) { Fail(GetLastError()); break; }
      if (WaitForSingleObject(control_finish.value, 0) == WAIT_OBJECT_0) {
        // A validated outer receipt follows the controller's last completed
        // exchange. No queued request/reply can be silently discarded here.
        if (pending || unsolicited) Fail(ERROR_INVALID_DATA);
        break;
      }
      if (unsolicited) { Fail(ERROR_INVALID_DATA); break; }
      if (pending) { if (Fail(downstream->Respond(deadline))) break; }
      else {
        upstream_lock.unlock();
        const auto wait = WaitForMultipleObjects(static_cast<DWORD>(events.size()), events.data(), FALSE, 10);
        if (wait == WAIT_FAILED) { Fail(ERROR_INVALID_HANDLE); break; }
      }
    }
  }
  DWORD Start(const CellControllerRuntimeBinding& binding) {
    if (!cancel.value || !monitor_done.value || !control_finish.value) return Fail(ERROR_NOT_ENOUGH_MEMORY);
    auto error = Check(); if (error) return error;
    const std::array<HANDLE, 3> pipes{controller, parent, parent_control};
    for (std::size_t i = 0; i < pipes.size(); ++i) {
      DWORD flags = 0, handle_flags = 0;
      if (!GetNamedPipeInfo(pipes[i], &flags, nullptr, nullptr, nullptr) || (flags & PIPE_SERVER_END) ||
          !GetHandleInformation(pipes[i], &handle_flags) || (handle_flags & HANDLE_FLAG_INHERIT)) return Fail(ERROR_INVALID_HANDLE);
      for (std::size_t j = 0; j < i; ++j)
        if (pipes[i] == pipes[j] || CompareObjectHandles(pipes[i], pipes[j])) return Fail(ERROR_INVALID_HANDLE);
    }
    error = endpoint.OpenClient(controller, deadline, binding, endpoint_owner);
    if (error) return Fail(error);
    controller_control = endpoint.Pipe();
    connection = std::make_unique<CellRuntimeParentConnection>(controller, parent, deadline, expected, Guard(), CellRuntimeFileDeliveryOwner{this, File});
    upstream = std::make_unique<CellRuntimeControlChannel>(parent, parent_control, deadline, expected.binding,
      expected.reference.checkpoint_sha256, expected.limits.input_bytes, CellRuntimeControlRole::controller, CellRuntimeControlOwner{Guard()});
    downstream = std::make_unique<CellRuntimeControlChannel>(controller, controller_control, deadline, expected.binding,
      expected.reference.checkpoint_sha256, expected.limits.input_bytes, CellRuntimeControlRole::protected_parent,
      CellRuntimeControlOwner{Guard(), this, Input, Deliver, File});
    monitor = std::jthread([this] {
      const std::array<HANDLE, 2> events{monitor_done.value, endpoint_owner.peer.cancellation};
      const auto now = GetTickCount64();
      const auto wait = WaitForMultipleObjects(static_cast<DWORD>(events.size()), events.data(), FALSE,
        now >= deadline ? 0 : static_cast<DWORD>(deadline - now));
      if (wait != WAIT_OBJECT_0) Fail(wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : wait == WAIT_OBJECT_0 + 1 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE);
    });
    forwarder = std::jthread([this] { Forward(); });
    return Peer(this);
  }
  DWORD Finish() noexcept {
    if (!runtime_complete || !connection) return Fail(ERROR_INVALID_STATE);
    if (finishing.exchange(true)) return Fail(ERROR_INVALID_STATE);
    try {
      {
        std::lock_guard<std::recursive_mutex> lock(peer_mutex);
        if (checking_peer || forwarder.get_id() == std::this_thread::get_id()) return Fail(ERROR_BUSY);
      }
      SetEvent(control_finish.value);
      if (forwarder.joinable()) forwarder.join();
      auto error = Peer(this);
      // Parent finish can close its control endpoint. Send it only after the
      // forwarding thread has completed its final post-reply custody check.
      if (!error) error = connection->Finish(result);
      if (!error) error = Check();
      SetEvent(monitor_done.value);
      if (monitor.joinable()) monitor.join();
      return Fail(error);
    } catch (...) { return Fail(ERROR_GEN_FAILURE); }
  }
};
CellRuntimeHelperForwardingSession::CellRuntimeHelperForwardingSession() = default;
CellRuntimeHelperForwardingSession::~CellRuntimeHelperForwardingSession() = default;
DWORD CellRuntimeHelperForwardingSession::Verify() noexcept { return state_ ? State::Peer(state_.get()) : ERROR_INVALID_STATE; }
DWORD CellRuntimeHelperForwardingSession::Finish() noexcept { return state_ ? state_->Finish() : ERROR_INVALID_STATE; }
void CellRuntimeHelperForwardingSession::Cancel(DWORD error) noexcept { if (state_) state_->Fail(error ? error : ERROR_OPERATION_ABORTED); }
CellRuntimeClientSessionResult CellRuntimeHelperForwardingSession::Run(HANDLE controller, HANDLE parent, HANDLE parent_control,
    ULONGLONG deadline, const CellControllerRuntimeBinding& supplied_binding, const std::vector<std::uint8_t>& supplied_bytes,
    const CellRuntimeControlEndpointOwner& supplied_owner) noexcept {
  CellRuntimeClientSessionResult result;
  if (attempted_) { result.error = ERROR_INVALID_STATE; Cancel(result.error); return result; }
  attempted_ = true;
  try {
    const auto binding = supplied_binding;
    const auto owner = supplied_owner;
    const auto bytes = supplied_bytes;
    CellRuntimeDispatch request;
    result.error = DecodeCellRuntimeDispatch(bytes, {binding.nonce, binding.request_sha256}, &request);
    if (!result.error && request.reference.checkpoint_sha256 != binding.checkpoint_sha256) result.error = ERROR_INVALID_DATA;
    if (result.error) return result;
    state_ = std::make_unique<State>(controller, parent, parent_control, deadline, std::move(request), owner);
    result.error = state_->Start(binding);
    if (!result.error) {
      CellRuntimeClientSession session(controller, deadline, state_->expected.binding, binding.checkpoint_sha256, state_->connection->Owner());
      result = session.Run(bytes);
      if (!result.error && result.file_selection_requested) result.error = state_->connection->ForwardFiles(result);
    }
    if (!result.error) result.error = State::Peer(state_.get());
    if (!result.error) { state_->result = result; state_->runtime_complete = true; }
    else { result.execution.execution.staged_files.clear(); Cancel(result.error); }
  } catch (...) { result.execution.execution.staged_files.clear(); result.error = ERROR_NOT_ENOUGH_MEMORY; Cancel(result.error); }
  return result;
}
DWORD DecodeCellRuntimeHelperBootstrap(const CellRuntimeHelperBootstrapBytes& bytes, CellRuntimeHelperBootstrap* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (std::memcmp(bytes.data(), "GCRHP001", 8) || Parent32(bytes.data() + 172)) return ERROR_INVALID_DATA;
  CellRuntimeHelperBootstrap value;
  std::copy_n(bytes.begin() + 8, 32, value.pipe_nonce.begin());
  std::copy_n(bytes.begin() + 40, 32, value.secret.begin());
  std::copy_n(bytes.begin() + 72, 32, value.binding.nonce.begin());
  std::copy_n(bytes.begin() + 104, 32, value.binding.request_sha256.begin());
  std::copy_n(bytes.begin() + 136, 32, value.binding.checkpoint_sha256.begin());
  value.request_bytes = Parent32(bytes.data() + 168);
  CellControllerRuntimeBindingBytes checked{};
  if (value.request_bytes <= 156 || value.request_bytes > kMaximumRuntimeDispatchBytes ||
      !EncodeCellControllerRuntimeBinding(value.pipe_nonce, value.binding, &checked) ||
      value.secret == CellFileSha256{} || value.secret == value.pipe_nonce || value.secret == value.binding.nonce ||
      value.secret == value.binding.request_sha256 || value.secret == value.binding.checkpoint_sha256) return ERROR_INVALID_DATA;
  *output = value;
  return ERROR_SUCCESS;
}
std::wstring CellRuntimeHelperPipeName(const CellFileSha256& nonce, bool control) {
  if (nonce == CellFileSha256{}) return {};
  std::wstring name = L"\\\\.\\pipe\\LOCAL\\GoatCitadelRuntimeParent.v1.";
  constexpr wchar_t hex[] = L"0123456789abcdef";
  for (const auto byte : nonce) { name += hex[byte >> 4]; name += hex[byte & 15]; }
  if (control) name += L".control";
  return name;
}
DWORD AuthenticateCellRuntimeHelperParent(CellPipeParentEvidence& parent, CellRuntimeHelperBootstrap& bootstrap,
    const CellFootprintScanGuard& custody, ULONGLONG deadline, bool control_channel) noexcept {
  struct Hello final {
    std::array<std::uint8_t, 136> bytes{};
    ~Hello() { SecureZeroMemory(bytes.data(), bytes.size()); }
  } hello, reply;
  std::memcpy(hello.bytes.data(), control_channel ? "GCRPC001" : "GCRPA001", 8);
  std::copy(bootstrap.secret.begin(), bootstrap.secret.end(), hello.bytes.begin() + 8);
  std::copy(bootstrap.binding.nonce.begin(), bootstrap.binding.nonce.end(), hello.bytes.begin() + 40);
  std::copy(bootstrap.binding.request_sha256.begin(), bootstrap.binding.request_sha256.end(), hello.bytes.begin() + 72);
  std::copy(bootstrap.binding.checkpoint_sha256.begin(), bootstrap.binding.checkpoint_sha256.end(), hello.bytes.begin() + 104);
  const bool secret_valid = bootstrap.secret != CellFileSha256{} && bootstrap.secret != bootstrap.pipe_nonce &&
    bootstrap.secret != bootstrap.binding.nonce && bootstrap.secret != bootstrap.binding.request_sha256 &&
    bootstrap.secret != bootstrap.binding.checkpoint_sha256;
  SecureZeroMemory(bootstrap.secret.data(), bootstrap.secret.size());
  CellControllerRuntimeBindingBytes checked{};
  DWORD error = secret_valid && custody.authorize &&
    EncodeCellControllerRuntimeBinding(bootstrap.pipe_nonce, bootstrap.binding, &checked) ? ERROR_SUCCESS : ERROR_INVALID_DATA;
  const auto until = std::min<ULONGLONG>(deadline, GetTickCount64() + 5000);
  const auto control = [&]() noexcept -> DWORD {
    const auto now = GetTickCount64();
    if (deadline <= now || until <= now) return ERROR_TIMEOUT;
    if (deadline - now > 86400000) return ERROR_INVALID_PARAMETER;
    const DWORD state = WaitForSingleObject(custody.cancellation, 0);
    return state == WAIT_TIMEOUT ? ERROR_SUCCESS : state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
  };
  if (!error) error = control();
  if (!error) error = parent.Verify();
  if (!error) error = custody.authorize(custody.context);
  if (!error) error = control();
  if (!error) error = parent.Verify();
  if (!error) error = WriteCellPipe(parent.RuntimePipe(), hello.bytes.data(), static_cast<DWORD>(hello.bytes.size()), custody.cancellation, until);
  if (!error) error = ReadCellPipe(parent.RuntimePipe(), reply.bytes.data(), static_cast<DWORD>(reply.bytes.size()), custody.cancellation, until);
  hello.bytes[7] = '2';
  if (!error && reply.bytes != hello.bytes) error = ERROR_ACCESS_DENIED;
  if (!error) error = parent.Verify();
  if (!error) error = custody.authorize(custody.context);
  if (!error) error = control();
  if (!error) error = parent.Verify();
  return error;
}
DWORD CellRuntimeParentStreams::Fail(DWORD error) noexcept {
  if (error) { DWORD clear = ERROR_SUCCESS; failure_.compare_exchange_strong(clear, error); }
  return failure_.load();
}
DWORD CellRuntimeParentStreams::Peer(ULONGLONG deadline) noexcept {
  if (failure_.load()) return failure_.load();
  const auto control = [&]() noexcept -> DWORD {
    if (!peer_.authorize || !peer_.cancellation || peer_.cancellation == INVALID_HANDLE_VALUE) return ERROR_INVALID_PARAMETER;
    const auto state = WaitForSingleObject(peer_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    return now >= deadline ? ERROR_TIMEOUT : deadline_ - now > 86400000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = control(); if (!error) error = peer_.authorize(peer_.context);
  if (!error) error = control(); return error ? Fail(error) : failure_.load();
}
DWORD CellRuntimeParentStreams::Begin(const CellRuntimeDispatchBinding& binding, ULONGLONG deadline) noexcept {
  if (binding.nonce != binding_.nonce || binding.request_sha256 != binding_.request_sha256 ||
      std::none_of(binding_.nonce.begin(), binding_.nonce.end(), [](auto b) { return b != 0; }) ||
      std::none_of(binding_.request_sha256.begin(), binding_.request_sha256.end(), [](auto b) { return b != 0; })) return ERROR_INVALID_DATA;
  if (!controller_ || controller_ == INVALID_HANDLE_VALUE || !parent_ || parent_ == INVALID_HANDLE_VALUE || controller_ == parent_ ||
      GetFileType(controller_) != FILE_TYPE_PIPE || GetFileType(parent_) != FILE_TYPE_PIPE || CompareObjectHandles(controller_, parent_)) return ERROR_INVALID_HANDLE;
  return Peer(deadline);
}
DWORD CellRuntimeParentStreams::End(DWORD error) noexcept {
  const auto result = Fail(error); busy_.store(false); return result;
}
DWORD CellRuntimeParentStreams::Input(const CellRuntimeDispatchBinding& binding, CellRuntimeInputChunk* chunk, ULONGLONG deadline) noexcept {
  if (chunk) *chunk = {};
  if (failure_.load()) return failure_.load();
  if (busy_.exchange(true)) return Fail(ERROR_BUSY);
  const auto until = std::min({deadline_, deadline, GetTickCount64() + 5000});
  CellRuntimeInputChunk received; bool idle = false;
  const auto error = [&]() noexcept -> DWORD {
    if (!chunk || input_.InputEnded() || polls_ == std::numeric_limits<std::uint32_t>::max() || input_sequence_ == std::numeric_limits<std::uint32_t>::max())
      return ERROR_INVALID_STATE;
    auto result = Begin(binding, until); if (result) return result;
    CellRuntimeParentInputPoll poll{};
    std::copy(binding_.nonce.begin(), binding_.nonce.end(), poll.begin());
    std::copy(binding_.request_sha256.begin(), binding_.request_sha256.end(), poll.begin() + 32);
    PutParent(poll.data() + 64, input_sequence_ + 1, 4); PutParent(poll.data() + 72, input_.Total(CellRuntimeStream::input), 8);
    PutParent(poll.data() + 80, ++polls_, 4);
    result = WriteCellControllerMessage(parent_, CellControllerMessage::runtime_parent_input_poll, poll.data(), static_cast<DWORD>(poll.size()), peer_.cancellation, until);
    if (!result) result = Peer(until);
    CellRuntimeParentInputReply reply{};
    if (!result) result = ReadCellControllerMessage(parent_, CellControllerMessage::runtime_parent_input_reply, reply.data(), static_cast<DWORD>(reply.size()), peer_.cancellation, until);
    if (!result && !std::equal(poll.begin(), poll.end(), reply.begin())) result = ERROR_INVALID_DATA;
    const auto state = Parent32(reply.data() + 88); CellRuntimeStreamBytes frame{};
    std::copy_n(reply.begin() + 92, frame.size(), frame.begin());
    if (!result && state == 0) {
      if (std::any_of(frame.begin(), frame.end(), [](auto b) { return b != 0; })) result = ERROR_INVALID_DATA;
      else idle = true;
    } else if (!result) {
      if (state > 2) result = ERROR_INVALID_DATA;
      CellRuntimeStreamFrame parsed;
      if (!result) result = input_.Accept(state == 1 ? CellControllerMessage::runtime_input : CellControllerMessage::runtime_input_end, frame, &parsed);
      if (!result) { received.bytes = parsed.data; received.count = parsed.count; received.eof = parsed.eof; ++input_sequence_; }
    }
    if (!result) result = Peer(until); return result;
  }();
  const auto result = End(error);
  if (result) return result;
  *chunk = received; return idle ? ERROR_NO_MORE_ITEMS : ERROR_SUCCESS;
}
DWORD CellRuntimeParentStreams::Output(const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& supplied, ULONGLONG deadline) noexcept {
  if (failure_.load()) return failure_.load();
  if (busy_.exchange(true)) return Fail(ERROR_BUSY);
  const auto until = std::min({deadline_, deadline, GetTickCount64() + 5000});
  const auto frame = supplied;
  const auto error = [&]() noexcept -> DWORD {
    CellControllerMessage kind{}; CellRuntimeStreamBytes wire{}; CellRuntimeStreamFrame parsed;
    if (!EncodeCellRuntimeStream(binding_, frame, &kind, &wire)) return ERROR_INVALID_DATA;
    auto result = output_.Accept(kind, wire, &parsed); if (result) return result;
    result = Begin(binding, until); if (result) return result;
    CellRuntimeParentOutputReceipt wanted{}, reply{};
    PutParent(wanted.data(), static_cast<std::uint32_t>(kind), 4); std::copy_n(wire.begin(), 80, wanted.begin() + 4);
    result = WriteCellControllerMessage(parent_, kind, wire.data(), static_cast<DWORD>(wire.size()), peer_.cancellation, until);
    if (!result) result = Peer(until);
    if (!result) result = ReadCellControllerMessage(parent_, CellControllerMessage::runtime_parent_output_received, reply.data(), static_cast<DWORD>(reply.size()), peer_.cancellation, until);
    if (!result && reply != wanted) result = ERROR_INVALID_DATA;
    if (!result) result = Peer(until); return result;
  }();
  return End(error);
}
DWORD CellRuntimeClientSession::Fail(DWORD error) noexcept {
  DWORD expected = ERROR_SUCCESS;
  if (error) failure_.compare_exchange_strong(expected, error);
  return failure_.load();
}
DWORD CellRuntimeParentConnection::Fail(DWORD error) noexcept {
  if (error) { DWORD clear = ERROR_SUCCESS; failure_.compare_exchange_strong(clear, error); }
  return failure_.load();
}
DWORD CellRuntimeParentConnection::Peer(void* raw) noexcept {
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw);
  if (self.failure_.load()) return self.failure_.load();
  if (self.finished_.load()) return self.Fail(ERROR_INVALID_STATE);
  if (self.checking_peer_.exchange(true)) return self.Fail(ERROR_BUSY);
  const auto control = [&]() noexcept -> DWORD {
    if (!self.peer_.authorize || !self.peer_.cancellation || self.peer_.cancellation == INVALID_HANDLE_VALUE) return ERROR_INVALID_PARAMETER;
    const auto state = WaitForSingleObject(self.peer_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    return now >= self.deadline_ ? ERROR_TIMEOUT : self.deadline_ - now > 86400000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = control(); if (!error) error = self.peer_.authorize(self.peer_.context);
  if (!error) error = control(); error = self.Fail(error); self.checking_peer_.store(false); return error;
}
DWORD CellRuntimeParentConnection::Enter() noexcept {
  if (failure_.load()) return failure_.load();
  if (finished_.load()) return Fail(ERROR_INVALID_STATE);
  if (busy_.exchange(true)) return Fail(ERROR_BUSY);
  return ERROR_SUCCESS;
}
DWORD CellRuntimeParentConnection::Leave(DWORD error) noexcept { const auto result = Fail(error); busy_.store(false); return result; }
CellRuntimeClientSessionOwner CellRuntimeParentConnection::Owner() noexcept {
  return {{{Peer, this, peer_.cancellation}, this, Admit}, this, Input, Output, Deliver, {this, Commit},
    files_.authorize ? CellRuntimeFileDeliveryOwner{this, File} : CellRuntimeFileDeliveryOwner{}};
}
DWORD CellRuntimeParentConnection::Admit(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, std::uint32_t ordinal) noexcept {
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw); auto error = self.Enter(); if (error) return error;
  error = self.delivering_ ? ERROR_INVALID_STATE : self.authority_.CheckRuntime(binding, head, ordinal);
  if (!error) self.runtime_admitted_ = true; return self.Leave(error);
}
DWORD CellRuntimeParentConnection::Input(void* raw, const CellRuntimeDispatchBinding& binding, CellRuntimeInputChunk* chunk, ULONGLONG deadline) noexcept {
  if (chunk) *chunk = {};
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw); auto error = self.Enter(); if (error) return error;
  error = self.delivering_ ? ERROR_INVALID_STATE : self.streams_.Input(binding, chunk, deadline);
  if (!error && chunk && chunk->eof) self.input_ended_ = true;
  const bool idle = error == ERROR_NO_MORE_ITEMS;
  error = self.Leave(idle ? ERROR_SUCCESS : error);
  if (error && chunk) *chunk = {};
  return error ? error : idle ? ERROR_NO_MORE_ITEMS : ERROR_SUCCESS;
}
DWORD CellRuntimeParentConnection::Output(void* raw, const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame, ULONGLONG deadline) noexcept {
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw); auto error = self.Enter(); if (error) return error;
  const auto frozen = frame;
  error = self.delivering_ || !self.runtime_admitted_ ? ERROR_INVALID_STATE : self.streams_.Output(binding, frozen, deadline);
  if (!error && frozen.eof) {
    if (frozen.stream == CellRuntimeStream::output) self.output_ended_ = true;
    else if (frozen.stream == CellRuntimeStream::error) self.error_ended_ = true;
  }
  return self.Leave(error);
}
DWORD CellRuntimeParentConnection::Deliver(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, ULONGLONG deadline) noexcept {
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw); auto error = self.Enter(); if (error) return error;
  error = !self.runtime_admitted_ || !self.input_ended_ || !self.output_ended_ || !self.error_ended_ ? ERROR_INVALID_STATE :
    self.authority_.CheckDelivery(binding, head, deadline);
  if (!error) self.delivering_ = true; return self.Leave(error);
}
DWORD CellRuntimeParentConnection::Commit(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
  const CellRuntimeDispatchResult& result, const CellFileSha256& digest, CellFileSha256* retained, ULONGLONG deadline) noexcept {
  if (retained) *retained = {};
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw); auto error = self.Enter(); if (error) return error;
  const auto owner = self.committer_.Owner();
  error = !self.delivering_ || self.committed_ ? ERROR_INVALID_STATE : owner.commit(owner.context, binding, head, result, digest, retained, deadline);
  if (!error) { self.committed_ = true; self.retained_digest_ = *retained; }
  return self.Leave(error);
}
DWORD CellRuntimeParentConnection::CheckFile(const CellRuntimeFileSelection& supplied, ULONGLONG until) noexcept {
  try {
    const auto file = supplied;
    if (!committed_ || !expected_.file_staging || !files_.authorize || GetTickCount64() >= until ||
        file.expected.binding.nonce != expected_.binding.nonce || file.expected.binding.request_sha256 != expected_.binding.request_sha256 ||
        file.expected.result_sha256 != retained_digest_ || file.expected.maximum_bytes != expected_.file_staging->maximum_file_bytes ||
        std::find(expected_.file_staging->paths.begin(), expected_.file_staging->paths.end(), file.relative_path) == expected_.file_staging->paths.end())
      return ERROR_ACCESS_DENIED;
    auto error = Peer(this);
    if (!error) error = files_.authorize(files_.context, file, until);
    if (!error) error = Peer(this);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeParentConnection::File(void* raw, const CellRuntimeFileSelection& file, ULONGLONG until) noexcept {
  auto& self = *static_cast<CellRuntimeParentConnection*>(raw); auto error = self.Enter(); if (error) return error;
  return self.Leave(self.CheckFile(file, until));
}
DWORD CellRuntimeParentConnection::ValidateRetained(const CellRuntimeClientSessionResult& result,
    std::vector<std::uint8_t>* bytes, CellFileSha256* digest) noexcept {
  try {
    if (!committed_ || result.error || !result.request_acknowledged || !result.input_ended || !result.output_ended || !result.result_received ||
        !result.retention_attempted || !result.retention_confirmed || !result.retention_receipt_sent ||
        result.file_selection_requested != expected_.file_staging.has_value() ||
        (result.file_selection_requested && !result.files_received)) return ERROR_INVALID_STATE;
    auto error = EncodeCellRuntimeResult(expected_, result.execution, bytes);
    if (!error) error = HashCellRuntimeResult(*bytes, digest);
    if (!error && *digest != retained_digest_) error = ERROR_INVALID_DATA;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeParentConnection::ForwardFiles(const CellRuntimeClientSessionResult& result) noexcept {
  auto error = Enter(); if (error) return error;
  try {
    if (files_attempted_ || !expected_.file_staging || !files_.authorize) return Leave(ERROR_INVALID_STATE);
    files_attempted_ = true;
    std::vector<std::uint8_t> bytes; CellFileSha256 digest{};
    error = ValidateRetained(result, &bytes, &digest);
    if (!error) {
      CellRuntimeFileBatchTransfer batch(parent_, std::min(deadline_, GetTickCount64() + 600000), expected_,
        {Peer, this, peer_.cancellation}, {this, [](void* raw, const CellRuntimeFileSelection& file, ULONGLONG until) noexcept {
          return static_cast<CellRuntimeParentConnection*>(raw)->CheckFile(file, until);
        }});
      error = batch.Write(result.execution);
      if (!error && !batch.ValidatedReceipt()) error = ERROR_INVALID_STATE;
      if (!error) files_forwarded_ = true;
    }
    return Leave(error);
  } catch (...) { return Leave(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeParentConnection::Finish(const CellRuntimeClientSessionResult& result) noexcept {
  auto error = Enter(); if (error) return error;
  try {
    if (expected_.file_staging && !files_forwarded_) return Leave(ERROR_INVALID_STATE);
    std::vector<std::uint8_t> bytes; CellFileSha256 digest{};
    error = ValidateRetained(result, &bytes, &digest);
    std::array<std::uint8_t, 100> finish{}, reply{};
    std::copy(expected_.binding.nonce.begin(), expected_.binding.nonce.end(), finish.begin());
    std::copy(expected_.binding.request_sha256.begin(), expected_.binding.request_sha256.end(), finish.begin() + 32);
    std::copy(digest.begin(), digest.end(), finish.begin() + 64); PutParent(finish.data() + 96, bytes.size(), 4);
    const auto deadline = std::min(deadline_, GetTickCount64() + 5000);
    if (!error) error = Peer(this);
    if (!error) error = WriteCellControllerMessage(parent_, CellControllerMessage::runtime_parent_finish, finish.data(), static_cast<DWORD>(finish.size()), peer_.cancellation, deadline);
    if (!error) error = Peer(this);
    if (!error) error = ReadCellControllerMessage(parent_, CellControllerMessage::runtime_parent_finished, reply.data(), static_cast<DWORD>(reply.size()), peer_.cancellation, deadline);
    if (!error && reply != finish) error = ERROR_INVALID_DATA;
    if (!error) error = Peer(this);
    if (!error && GetTickCount64() >= deadline) error = ERROR_TIMEOUT;
    if (!error) finished_.store(true); return Leave(error);
  } catch (...) { return Leave(ERROR_NOT_ENOUGH_MEMORY); }
}
CellRuntimeClientSessionResult CellRuntimeClientSession::Run(const std::vector<std::uint8_t>& supplied) noexcept {
  CellRuntimeClientSessionResult result; bool idle = false;
  if (!attempted_.compare_exchange_strong(idle, true)) { result.error = Fail(ERROR_INVALID_STATE); return result; }
  try {
    const auto now = GetTickCount64();
    if (!owner_.runtime.peer.authorize || !owner_.runtime.peer.cancellation || owner_.runtime.peer.cancellation == INVALID_HANDLE_VALUE ||
        !owner_.runtime.admit || !owner_.input || !owner_.output || !owner_.deliver || !owner_.retention.commit ||
        now >= deadline_ || deadline_ - now > 86400000 || supplied.size() > kMaximumRuntimeDispatchBytes) {
      result.error = Fail(ERROR_INVALID_PARAMETER); return result;
    }
    const auto bytes = supplied; CellRuntimeDispatch request;
    result.error = DecodeCellRuntimeDispatch(bytes, expected_, &request);
    result.file_selection_requested = request.file_staging.has_value();
    if (!result.error && result.file_selection_requested && !owner_.files.authorize) result.error = ERROR_ACCESS_DENIED;
    if (!result.error && request.reference.checkpoint_sha256 != head_) result.error = ERROR_INVALID_DATA;
    if (result.error) { result.error = Fail(result.error); return result; }
    Event io_stop, monitor_stop;
    if (!io_stop.value || !monitor_stop.value) { result.error = Fail(ERROR_NOT_ENOUGH_MEMORY); return result; }
    struct Control final {
      CellRuntimeClientSession& session;
      HANDLE io_stop;
      ULONGLONG delivery_deadline = 0;
      std::atomic<DWORD> cancellation{ERROR_SUCCESS};
      DWORD Check() noexcept {
        if (session.failure_.load()) return session.failure_.load();
        if (cancellation.load()) return cancellation.load();
        const auto state = WaitForSingleObject(session.owner_.runtime.peer.cancellation, 0);
        if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
        return GetTickCount64() >= session.deadline_ ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Peer(void* raw) noexcept {
        auto& self = *static_cast<Control*>(raw); auto error = self.Check();
        if (!error) error = self.session.owner_.runtime.peer.authorize(self.session.owner_.runtime.peer.context);
        return error ? error : self.Check();
      }
      DWORD Until(ULONGLONG deadline) noexcept {
        if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
        const auto error = Peer(this); return error ? error : GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Delivery(void* raw) noexcept {
        auto& self = *static_cast<Control*>(raw); auto error = self.Until(self.delivery_deadline);
        if (!error) error = self.session.owner_.deliver(self.session.owner_.context, self.session.expected_, self.session.head_, self.delivery_deadline);
        return error ? error : self.Until(self.delivery_deadline);
      }
      void Cancel(DWORD error) noexcept {
        DWORD clear = ERROR_SUCCESS; cancellation.compare_exchange_strong(clear, error ? error : ERROR_OPERATION_ABORTED); SetEvent(io_stop);
      }
    } control{*this, io_stop.value};
    std::jthread monitor([&] {
      const std::array<HANDLE, 2> events{monitor_stop.value, owner_.runtime.peer.cancellation};
      const auto current = GetTickCount64();
      const auto wait = WaitForMultipleObjects(static_cast<DWORD>(events.size()), events.data(), FALSE,
        current >= deadline_ ? 0 : static_cast<DWORD>(deadline_ - current));
      if (wait != WAIT_OBJECT_0) control.Cancel(wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : wait == WAIT_OBJECT_0 + 1 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE);
    });
    MonitorLifetime lifetime{monitor_stop.value, monitor};
    const CellFootprintScanGuard peer{Control::Peer, &control, io_stop.value};
    CellRuntimeTransfer transfer(pipe_, std::min(deadline_, GetTickCount64() + 600000), expected_, peer);
    result.error = transfer.Write(bytes);
    if (result.error) { control.Cancel(result.error); result.error = Fail(result.error); return result; }
    result.request_acknowledged = true;
    auto runtime_owner = owner_.runtime; runtime_owner.peer = peer;
    CellControllerRuntimeClient authority(pipe_, deadline_, expected_, head_, runtime_owner);
    CellRuntimeStreamSequence streams(expected_, request.limits.input_bytes, request.limits.raw_output_bytes, false);
    std::uint32_t sequence = 0; std::uint64_t input_total = 0;
    bool pending = false; CellRuntimeStreamFrame staged; CellRuntimeStreamBytes sent{};
    while (!result.error && !streams.OutputEnded()) {
      const auto io_deadline = std::min(deadline_, GetTickCount64() + 5000);
      result.error = control.Check();
      if (!result.error && !pending && !result.input_ended) {
        CellRuntimeInputChunk chunk;
        result.error = control.Until(io_deadline);
        if (!result.error) result.error = owner_.input(owner_.context, expected_, &chunk, io_deadline);
        const bool waiting = result.error == ERROR_NO_MORE_ITEMS;
        if (waiting) result.error = chunk.count || chunk.eof || std::any_of(chunk.bytes.begin(), chunk.bytes.end(), [](auto byte) { return byte != 0; }) ? ERROR_INVALID_DATA : ERROR_SUCCESS;
        if (!result.error) result.error = control.Until(io_deadline);
        if (!result.error && !waiting) {
          staged = {}; staged.stream = CellRuntimeStream::input; staged.sequence = ++sequence;
          staged.count = chunk.count; staged.eof = chunk.eof; staged.total = input_total + chunk.count; staged.data = chunk.bytes;
          CellControllerMessage kind{};
          if (staged.total > request.limits.input_bytes) result.error = ERROR_NOT_ENOUGH_QUOTA;
          else if (!EncodeCellRuntimeStream(expected_, staged, &kind, &sent)) result.error = ERROR_INVALID_DATA;
          if (!result.error) result.error = WriteCellControllerMessage(pipe_, kind, sent.data(), static_cast<DWORD>(sent.size()), io_stop.value, io_deadline);
          if (!result.error) result.error = control.Until(io_deadline);
          pending = result.error == ERROR_SUCCESS;
        }
      }
      DWORD available = 0;
      if (!result.error && !PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) result.error = GetLastError();
      if (result.error) break;
      if (!available) { Sleep(5); continue; }
      CellControllerMessage kind{}; CellRuntimeStreamBytes wire{};
      result.error = ReadCellControllerRuntimeEvent(pipe_, false, &kind, &wire, io_stop.value, io_deadline);
      if (!result.error) result.error = control.Until(io_deadline);
      if (result.error) break;
      if (kind == CellControllerMessage::runtime_authority) {
        CellControllerRuntimeChallenge challenge{}; std::copy_n(wire.begin(), challenge.size(), challenge.begin());
        result.error = authority.Respond(challenge);
      } else if (kind == CellControllerMessage::runtime_input_ack) {
        if (!pending || !std::equal(sent.begin(), sent.begin() + 80, wire.begin())) result.error = ERROR_INVALID_DATA;
        else { input_total = staged.total; result.input_ended = staged.eof; pending = false; }
      } else {
        CellRuntimeStreamFrame frame; result.error = streams.Accept(kind, wire, &frame);
        if (!result.error) result.error = owner_.output(owner_.context, expected_, frame, io_deadline);
        if (!result.error) result.error = control.Until(io_deadline);
      }
    }
    result.output_ended = streams.OutputEnded();
    if (!result.error && (pending || !result.input_ended)) result.error = ERROR_INVALID_DATA;
    if (!result.error) {
      control.delivery_deadline = std::min(deadline_, GetTickCount64() + 600000);
      CellRuntimeResultTransfer terminal(pipe_, control.delivery_deadline, request, {Control::Delivery, &control, io_stop.value});
      CellRuntimeDispatchResult received;
      result.error = terminal.Read(&received); result.result_received = result.error == ERROR_SUCCESS;
      const auto& job = received.execution.runtime.job;
      if (!result.error && (!job.standard_input_complete || job.standard_input_bytes_written != input_total ||
          job.standard_output.raw_bytes != streams.Total(CellRuntimeStream::output) || job.standard_error.raw_bytes != streams.Total(CellRuntimeStream::error))) result.error = ERROR_INVALID_DATA;
      if (!result.error) {
        result.retention_attempted = true; result.error = terminal.Retain(received, owner_.retention);
        result.retention_confirmed = terminal.RetentionConfirmed(); result.retention_receipt_sent = terminal.RetentionReceiptSent();
        if (!result.error && request.file_staging) {
          CellRuntimeFileBatchTransfer files(pipe_, control.delivery_deadline, request,
            {Control::Delivery, &control, io_stop.value}, owner_.files);
          result.error = files.Read(received, &received.execution.staged_files);
          result.files_received = files.ValidatedReceipt();
          if (!result.error && !result.files_received) result.error = ERROR_INVALID_STATE;
        }
        if (!result.error) result.execution = std::move(received);
      }
    }
    if (result.error) control.Cancel(result.error);
    result.error = Fail(result.error); return result;
  } catch (...) { result.error = Fail(ERROR_NOT_ENOUGH_MEMORY); return result; }
}
}
