#pragma once
#include "cell_controller_runtime.hpp"
#include "cell_runtime_result.hpp"
#include "cell_runtime_file_transfer.hpp"

namespace goatcitadel::worker_cell {
struct CellRuntimeSessionOwner final {
  // Its cancellation event is borrowed. The session never signals it, even on
  // internal failure: it forwards cancellation to its own private job event.
  CellControllerRuntimeChannelOwner channel;
  void* context = nullptr;
  // Current permission to deliver the result for this exact admitted request.
  // Called around terminal transfer I/O after the job has joined. It must not
  // use the runtime pipe (the peer has transitioned to terminal receipt).
  DWORD (*deliver)(void*, const CellRuntimeDispatchBinding&, const CellFileSha256& head, ULONGLONG deadline) noexcept = nullptr;
  CellRuntimeFileDeliveryOwner files;
};
struct CellRuntimeSessionResult final {
  DWORD error = ERROR_SUCCESS;
  bool request_received = false, dispatch_started = false, dispatch_joined = false;
  bool output_ended = false, result_acknowledged = false;
  bool result_retention_acknowledged = false;
  bool file_selection_requested = false, files_acknowledged = false;
  bool local_intent_retained = false, local_outcome_retained = false;
  // Local native outcome, retained even on failed remote delivery. Raw output
  // remains ephemeral and requires Gateway sanitization before persistence.
  CellRuntimeDispatchResult execution;
};
// One already-authenticated connection and independently retained request
// binding/head. Owns the private cancellation/monitor/thread/channel lifetime;
// borrows the pipe, current peer owner and original native journal. The owner
// must retain those until Run returns and close the connection on any error.
// The outer process watchdog remains required for blocking native callbacks.
// This does not provision, repair, attach, mount or activate an installed service.
class CellRuntimeSession final {
 public:
  CellRuntimeSession(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatchBinding& expected,
    const CellFileSha256& head, const CellRuntimeSessionOwner& owner) noexcept
    : pipe_(pipe), deadline_(deadline), expected_(expected), head_(head), owner_(owner) {}
  CellRuntimeSession(const CellRuntimeSession&) = delete;
  CellRuntimeSession& operator=(const CellRuntimeSession&) = delete;
  // Snapshot the trusted staging policy before any peer callback. Its context
  // remains borrowed until Run joins. This does not negotiate or disclose files.
  CellRuntimeSessionResult Run(CellProvisioningJournal& journal, const CellRuntimeFileStaging* staging = nullptr) noexcept;
 private:
  friend struct CellRuntimeSessionTestPeer;
  struct Operations final {
    void* context = nullptr;
    CellRuntimeDispatchResult (*dispatch)(void*, const std::vector<std::uint8_t>&,
      const CellRuntimeDispatchBinding&, const CellFootprintScanGuard&, JobStdioChannel*) noexcept = nullptr;
    DWORD (*prepare)(void*, const CellRuntimeDispatch&) noexcept = nullptr;
    DWORD (*retain)(void*, const CellRuntimeDispatchResult&, DWORD) noexcept = nullptr;
  };
  CellRuntimeSessionResult RunOwned(const Operations& operations) noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding expected_;
  CellFileSha256 head_;
  CellRuntimeSessionOwner owner_;
  std::atomic<bool> attempted_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
};

// Controller listener composition for one authenticated runtime handoff.
// Retains the secondary endpoint after Run returns, through the outer receipt
// and its finish acknowledgement. The caller must keep primary custody and
// cancellation alive and destroy this object before those borrowed owners.
// Run owns and joins its session threads; no service or disk provisioning is done.
// Serialize public calls; internal session custody callbacks are synchronized.
class CellRuntimeControllerConnection final {
 public:
  CellRuntimeControllerConnection();
  ~CellRuntimeControllerConnection();
  CellRuntimeControllerConnection(const CellRuntimeControllerConnection&) = delete;
  CellRuntimeControllerConnection& operator=(const CellRuntimeControllerConnection&) = delete;
  CellRuntimeSessionResult Run(HANDLE pipe, ULONGLONG deadline, CellProvisioningJournal&,
    const CellControllerRuntimeBinding&, const CellRuntimeControlEndpointOwner&) noexcept;
  bool Attempted() const noexcept { return attempted_.load(); }
  // A failed cleanup proof forbids a later controller session. This is separate
  // from permission/receipt failure, which may follow an already drained job.
  bool RequiresControllerStop() const noexcept { return requires_stop_.load(); }
  DWORD Verify() noexcept;
 private:
  friend struct CellRuntimeControllerConnectionTestPeer;
  struct Operations final {
    void* context = nullptr;
    DWORD (*open)(void*, CellRuntimeControlEndpoint&, HANDLE, ULONGLONG, const CellControllerRuntimeBinding&,
      const CellRuntimeControlEndpointOwner&) noexcept = nullptr;
    CellRuntimeSessionResult (*run)(void*, CellRuntimeSession&, CellProvisioningJournal&) noexcept = nullptr;
  };
  struct State;
  CellRuntimeSessionResult RunOwned(HANDLE, ULONGLONG, CellProvisioningJournal&, const CellControllerRuntimeBinding&,
    const CellRuntimeControlEndpointOwner&, const Operations&) noexcept;
  DWORD Fail(DWORD) noexcept;
  std::unique_ptr<State> state_;
  std::atomic<bool> attempted_{false};
  std::atomic<bool> requires_stop_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
};
}
