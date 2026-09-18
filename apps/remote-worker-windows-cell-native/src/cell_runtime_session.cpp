#include "cell_runtime_session.hpp"
#include <algorithm>
#include <thread>

namespace goatcitadel::worker_cell {
namespace {
struct Event final {
  HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  ~Event() { if (value) CloseHandle(value); }
};
// Always signal the private event before joining during error unwinding. All
// borrowed callback/channel state is declared before this lifetime and survives
// until the owned thread has stopped. No unrelated process or event is touched.
struct Join final {
  HANDLE stop;
  std::jthread& thread;
  ~Join() { SetEvent(stop); if (thread.joinable()) thread.join(); }
};
bool Nonzero(const CellFileSha256& value) noexcept { return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; }); }
}
DWORD CellRuntimeSession::Fail(DWORD error) noexcept {
  DWORD expected = ERROR_SUCCESS;
  if (error) failure_.compare_exchange_strong(expected, error);
  return failure_.load();
}
CellRuntimeSessionResult CellRuntimeSession::Run(CellProvisioningJournal& journal, const CellRuntimeFileStaging* staging) noexcept {
  struct Native final {
    CellProvisioningJournal& journal;
    CellRuntimeLocalOutcome outcome;
    CellRuntimeFileStaging staging;
    bool stage;
  } native{journal, {}, staging ? *staging : CellRuntimeFileStaging{}, staging != nullptr};
  const Operations operations{&native, [](void* raw, const std::vector<std::uint8_t>& bytes,
      const CellRuntimeDispatchBinding& binding, const CellFootprintScanGuard& guard, JobStdioChannel* channel) noexcept {
    auto& self = *static_cast<Native*>(raw);
    return RunCellRuntimeDispatch(self.journal, bytes, binding, guard, channel, self.stage ? &self.staging : nullptr);
  }, [](void* raw, const CellRuntimeDispatch& request) noexcept {
    auto& self = *static_cast<Native*>(raw); return self.outcome.Begin(self.journal, request);
  }, [](void* raw, const CellRuntimeDispatchResult& execution, DWORD error) noexcept {
    CellRuntimeLocalOutcomeRecord record; return static_cast<Native*>(raw)->outcome.Retain(execution, error, &record);
  }};
  return RunOwned(operations);
}
CellRuntimeSessionResult CellRuntimeSession::RunOwned(const Operations& supplied) noexcept {
  CellRuntimeSessionResult result;
  bool idle = false;
  if (!attempted_.compare_exchange_strong(idle, true)) { result.error = Fail(ERROR_INVALID_STATE); return result; }
  const auto operations = supplied;
  bool retention_attempted = false;
  try {
    const auto now = GetTickCount64();
    if (!operations.dispatch || (bool(operations.prepare) != bool(operations.retain)) || !owner_.channel.peer.authorize || !owner_.channel.input || !owner_.deliver ||
        !owner_.channel.peer.cancellation || owner_.channel.peer.cancellation == INVALID_HANDLE_VALUE ||
        !Nonzero(expected_.nonce) || !Nonzero(expected_.request_sha256) || !Nonzero(head_) || deadline_ <= now || deadline_ - now > 86400000) {
      result.error = Fail(ERROR_INVALID_PARAMETER); return result;
    }
    Event job_stop, monitor_stop;
    if (!job_stop.value || !monitor_stop.value) { result.error = Fail(ERROR_NOT_ENOUGH_MEMORY); return result; }
    struct Control final {
      CellRuntimeSession& session;
      HANDLE job_stop;
      ULONGLONG delivery_deadline = 0;
      std::atomic<DWORD> cancellation{ERROR_SUCCESS};
      DWORD Check() noexcept {
        if (session.failure_.load()) return session.failure_.load();
        if (cancellation.load()) return cancellation.load();
        const auto state = WaitForSingleObject(session.owner_.channel.peer.cancellation, 0);
        if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
        return GetTickCount64() >= session.deadline_ ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Peer(void* raw) noexcept {
        auto& self = *static_cast<Control*>(raw); auto error = self.Check();
        if (!error) error = self.session.owner_.channel.peer.authorize(self.session.owner_.channel.peer.context);
        return error ? error : self.Check();
      }
      static DWORD Delivery(void* raw) noexcept {
        auto& self = *static_cast<Control*>(raw); auto error = Peer(raw);
        if (!error) error = self.session.owner_.deliver(self.session.owner_.context, self.session.expected_, self.session.head_, self.delivery_deadline);
        return error ? error : Peer(raw);
      }
      void Cancel(DWORD error) noexcept {
        DWORD clear = ERROR_SUCCESS; cancellation.compare_exchange_strong(clear, error ? error : ERROR_OPERATION_ABORTED); SetEvent(job_stop);
      }
    } control{*this, job_stop.value};
    std::jthread monitor([&] {
      const std::array<HANDLE, 2> events{monitor_stop.value, owner_.channel.peer.cancellation};
      const auto current = GetTickCount64();
      const auto wait = WaitForMultipleObjects(static_cast<DWORD>(events.size()), events.data(), FALSE,
        current >= deadline_ ? 0 : static_cast<DWORD>(deadline_ - current));
      if (wait != WAIT_OBJECT_0) control.Cancel(wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : wait == WAIT_OBJECT_0 + 1 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE);
    });
    Join monitor_lifetime{monitor_stop.value, monitor};
    const CellFootprintScanGuard peer{Control::Peer, &control, job_stop.value};
    CellRuntimeTransfer transfer(pipe_, std::min(deadline_, GetTickCount64() + 600000), expected_, peer);
    std::vector<std::uint8_t> bytes;
    result.error = transfer.Read(&bytes);
    if (result.error) { result.error = Fail(result.error); return result; }
    result.request_received = true;
    CellRuntimeDispatch request;
    result.error = DecodeCellRuntimeDispatch(bytes, expected_, &request);
    if (!result.error && request.reference.checkpoint_sha256 != head_) result.error = ERROR_INVALID_DATA;
    result.file_selection_requested = request.file_staging.has_value();
    if (!result.error && result.file_selection_requested && !owner_.files.authorize) result.error = ERROR_ACCESS_DENIED;
    if (result.error) { result.error = Fail(result.error); return result; }
    JobStdioChannel channel;
    auto owner = owner_.channel; owner.peer = peer;
    CellControllerRuntimeChannel bridge(pipe_, deadline_, expected_, head_, request.limits.input_bytes, request.limits.raw_output_bytes, channel, owner);
    if (operations.prepare) {
      const auto guard = bridge.Guard(); result.error = guard.authorize(guard.context);
      if (!result.error) result.error = operations.prepare(operations.context, request);
      if (result.error) { result.error = Fail(result.error); return result; }
      result.local_intent_retained = true;
    }
    std::atomic<bool> done{false};
    std::jthread dispatch([&] {
      result.execution = operations.dispatch(operations.context, bytes, expected_, bridge.Guard(), &channel);
      done.store(true);
    });
    Join dispatch_lifetime{job_stop.value, dispatch};
    result.dispatch_started = true;
    while (!result.error) {
      result.error = control.Check(); if (result.error) break;
      if (done.load() && !result.execution.execution.runtime.job.process_id) {
        result.error = result.execution.execution.runtime.job.error;
        if (!result.error) result.error = ERROR_PROCESS_ABORTED;
        break;
      }
      result.output_ended = bridge.OutputEnded();
      if (done.load() && result.output_ended) break;
      if (!result.output_ended) {
        result.error = bridge.Pump(); if (result.error == ERROR_RETRY) result.error = ERROR_SUCCESS;
      }
      if (!result.error) Sleep(1);
    }
    if (result.error) control.Cancel(result.error);
    dispatch.join(); result.dispatch_joined = true;
    if (!result.error && !bridge.MatchesCompletedInputOutput(result.execution.execution.runtime.job)) result.error = ERROR_INVALID_DATA;
    if (operations.retain) {
      retention_attempted = true;
      const auto retention_error = operations.retain(operations.context, result.execution, result.error);
      result.local_outcome_retained = !retention_error;
      if (retention_error) result.error = retention_error;
    }
    if (!result.error) {
      control.delivery_deadline = std::min(deadline_, GetTickCount64() + 600000);
      CellRuntimeResultTransfer terminal(pipe_, control.delivery_deadline, request,
        {Control::Delivery, &control, job_stop.value});
      result.error = terminal.Write(result.execution, true);
      result.result_acknowledged = terminal.ValidatedReceipt();
      result.result_retention_acknowledged = terminal.RetentionConfirmed();
      if (!result.error && request.file_staging) {
        CellRuntimeFileBatchTransfer files(pipe_, control.delivery_deadline, request,
          {Control::Delivery, &control, job_stop.value}, owner_.files);
        result.error = files.Write(result.execution);
        result.files_acknowledged = files.ValidatedReceipt();
        if (!result.error && !result.files_acknowledged) result.error = ERROR_INVALID_STATE;
      }
    }
    if (result.error) {
      control.Cancel(result.error); bridge.Abort(result.error);
      result.execution.execution.staged_files.clear();
    }
    result.error = Fail(result.error); return result;
  } catch (...) {
    result.error = ERROR_NOT_ENOUGH_MEMORY;
    // Thread lifetimes have joined before this handler. A failed allocation
    // must not discard an already-started native execution outcome.
    if (result.dispatch_started) result.dispatch_joined = true;
    if (result.local_intent_retained && !retention_attempted) {
      const auto error = operations.retain(operations.context, result.execution, result.error);
      result.local_outcome_retained = !error;
      if (error) result.error = error;
    }
    result.execution.execution.staged_files.clear();
    result.error = Fail(result.error); return result;
  }
}

struct CellRuntimeControllerConnection::State final {
  CellRuntimeControllerConnection& connection;
  std::recursive_mutex mutex;
  CellRuntimeControlEndpoint endpoint;
  std::unique_ptr<CellRuntimeControlChannel> control;
  explicit State(CellRuntimeControllerConnection& source) : connection(source) {}
  static DWORD Peer(void* raw) noexcept { return static_cast<State*>(raw)->connection.Verify(); }
  static DWORD Input(void* raw, const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame, ULONGLONG deadline) noexcept {
    return static_cast<State*>(raw)->control->Input(binding, frame, deadline);
  }
  static DWORD Deliver(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, ULONGLONG deadline) noexcept {
    return static_cast<State*>(raw)->control->Deliver(binding, head, deadline);
  }
  static DWORD File(void* raw, const CellRuntimeFileSelection& file, ULONGLONG deadline) noexcept {
    return static_cast<State*>(raw)->control->File(file, deadline);
  }
};
CellRuntimeControllerConnection::CellRuntimeControllerConnection() = default;
CellRuntimeControllerConnection::~CellRuntimeControllerConnection() = default;
DWORD CellRuntimeControllerConnection::Fail(DWORD error) noexcept {
  DWORD clear = ERROR_SUCCESS; if (error) failure_.compare_exchange_strong(clear, error); return failure_.load();
}
DWORD CellRuntimeControllerConnection::Verify() noexcept {
  if (failure_.load()) return failure_.load();
  if (!state_) return Fail(ERROR_INVALID_STATE);
  try { std::lock_guard<std::recursive_mutex> lock(state_->mutex); return Fail(state_->endpoint.Verify()); }
  catch (...) { return Fail(ERROR_GEN_FAILURE); }
}
CellRuntimeSessionResult CellRuntimeControllerConnection::Run(HANDLE pipe, ULONGLONG deadline, CellProvisioningJournal& journal,
    const CellControllerRuntimeBinding& binding, const CellRuntimeControlEndpointOwner& owner) noexcept {
  return RunOwned(pipe, deadline, journal, binding, owner, {nullptr,
    [](void*, CellRuntimeControlEndpoint& endpoint, HANDLE runtime, ULONGLONG until, const CellControllerRuntimeBinding& expected,
        const CellRuntimeControlEndpointOwner& custody) noexcept { return endpoint.OpenServer(runtime, until, expected, custody); },
    [](void*, CellRuntimeSession& session, CellProvisioningJournal& original) noexcept { return session.Run(original); }});
}
CellRuntimeSessionResult CellRuntimeControllerConnection::RunOwned(HANDLE pipe, ULONGLONG deadline, CellProvisioningJournal& journal,
    const CellControllerRuntimeBinding& supplied_binding, const CellRuntimeControlEndpointOwner& supplied_owner, const Operations& supplied_operations) noexcept {
  CellRuntimeSessionResult result;
  if (attempted_.exchange(true)) { result.error = Fail(ERROR_INVALID_STATE); return result; }
  try {
    const auto binding = supplied_binding; const auto owner = supplied_owner; const auto operations = supplied_operations;
    if (failure_.load()) { result.error = failure_.load(); return result; }
    if (!operations.open || !operations.run || !owner.peer.authorize || !owner.client || !owner.peer.cancellation ||
        owner.peer.cancellation == INVALID_HANDLE_VALUE) { result.error = Fail(ERROR_INVALID_PARAMETER); return result; }
    state_ = std::make_unique<State>(*this);
    result.error = operations.open(operations.context, state_->endpoint, pipe, deadline, binding, owner);
    if (!result.error) result.error = Verify();
    if (result.error) { result.error = Fail(result.error); return result; }
    const CellRuntimeDispatchBinding expected{binding.nonce, binding.request_sha256};
    const CellFootprintScanGuard custody{State::Peer, state_.get(), owner.peer.cancellation};
    // The decoded session enforces the admitted request's tighter input limit.
    // This independent transport also enforces the native protocol hard ceiling.
    state_->control = std::make_unique<CellRuntimeControlChannel>(pipe, state_->endpoint.Pipe(), deadline, expected,
      binding.checkpoint_sha256, kMaximumCellJobInputBytes, CellRuntimeControlRole::controller, CellRuntimeControlOwner{custody});
    const CellRuntimeSessionOwner session_owner{{custody, state_.get(), State::Input}, state_.get(), State::Deliver, {state_.get(), State::File}};
    CellRuntimeSession session(pipe, deadline, expected, binding.checkpoint_sha256, session_owner);
    requires_stop_.store(true);
    result = operations.run(operations.context, session, journal);
    const auto& job = result.execution.execution.runtime.job;
    if ((!result.dispatch_started || result.dispatch_joined) &&
        (!job.process_id || (job.zero_processes_verified && job.output_drained))) requires_stop_.store(false);
    // A session/permission failure is distinct from endpoint custody: the outer
    // protocol can still report that failure through its authenticated receipt.
    if (!result.error) result.error = Verify();
    return result;
  } catch (...) { result.error = Fail(ERROR_NOT_ENOUGH_MEMORY); return result; }
}
}
