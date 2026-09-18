#pragma once
#include "cell_controller_protocol.hpp"
#include "cell_runtime_transfer.hpp"
#include "cell_runtime_streams.hpp"
#include <atomic>
#include <mutex>

namespace goatcitadel::worker_cell {
struct CellRuntimeFileSelection;
inline constexpr std::size_t kCellControllerRuntimeAuthorityBytes = 104;
using CellControllerRuntimeChallenge = std::array<std::uint8_t, kCellControllerRuntimeAuthorityBytes>;
struct CellControllerRuntimeInputPump final {
  void* context = nullptr;
  DWORD (*receive)(void*, CellControllerMessage, const CellRuntimeStreamBytes&, ULONGLONG deadline) noexcept = nullptr;
  DWORD (*progress)(void*, ULONGLONG deadline) noexcept = nullptr;
};
// Borrowed authenticated pipe and independently retained request binding/head.
// The peer guard rechecks installed endpoint custody, not canonical workload
// admission. Every Check obtains a fresh digest-bound reply from that admission
// owner. I/O has a five-second bound within the caller's overall deadline and
// needs the host's outer watchdog for blocking callbacks. Serialize all calls.
// Do not share this pipe with another reader/writer during a Check.
class CellControllerRuntimeAuthority final {
 public:
  CellControllerRuntimeAuthority(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatchBinding& expected,
    const CellFileSha256& head, const CellFootprintScanGuard& peer, const CellControllerRuntimeInputPump& input = {}) noexcept
    : pipe_(pipe), deadline_(deadline), expected_(expected), head_(head), peer_(peer), input_(input) {}
  CellControllerRuntimeAuthority(const CellControllerRuntimeAuthority&) = delete;
  CellControllerRuntimeAuthority& operator=(const CellControllerRuntimeAuthority&) = delete;
  DWORD Check() noexcept;
  CellFootprintScanGuard Guard() noexcept;
  // One transfer followed by fresh admission and the actual native dispatch
  // owner. The byte-transfer ACK remains distinct from execution completion.
  // The caller must transport the returned streams/result/inventory separately.
  CellRuntimeDispatchResult Run(CellProvisioningJournal& journal, JobStdioChannel* stdio = nullptr) noexcept;
  std::uint32_t Checks() const noexcept { return checks_; }
 private:
  DWORD Peer() noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding expected_;
  CellFileSha256 head_;
  CellFootprintScanGuard peer_;
  CellControllerRuntimeInputPump input_;
  std::uint32_t checks_ = 0;
  DWORD failure_ = ERROR_SUCCESS;
  bool busy_ = false, run_attempted_ = false, finished_ = false;
};
struct CellControllerRuntimeClientOwner final {
  CellFootprintScanGuard peer;
  void* context = nullptr;
  // Must consult the current canonical protected assignment/lease/grant for
  // these exact admitted bytes and journal head. A generic volume or transport
  // check cannot supply this callback. No result is cached across challenges.
  DWORD (*admit)(void*, const CellRuntimeDispatchBinding&, const CellFileSha256&, std::uint32_t ordinal) noexcept = nullptr;
};
// Borrows a distinct authenticated protected-parent pipe. The parent must
// independently retain the admitted binding/head and consult canonical current
// authority for each challenge; endpoint custody alone is not permission.
// The outer owner serializes this pipe with input/output/retention traffic and
// keeps both handles and cancellation alive until every callback has joined.
class CellRuntimeParentAuthority final {
 public:
  CellRuntimeParentAuthority(HANDLE controller, HANDLE parent, ULONGLONG deadline,
    const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, const CellFootprintScanGuard& peer) noexcept
    : controller_(controller), parent_(parent), deadline_(deadline), binding_(binding), head_(head), peer_(peer) {}
  CellRuntimeParentAuthority(const CellRuntimeParentAuthority&) = delete;
  CellRuntimeParentAuthority& operator=(const CellRuntimeParentAuthority&) = delete;
  CellControllerRuntimeClientOwner RuntimeOwner() noexcept;
  DWORD CheckRuntime(const CellRuntimeDispatchBinding&, const CellFileSha256&, std::uint32_t ordinal) noexcept;
  // Delivery uses a separate action and ordinal sequence. It never reads or
  // writes the controller's runtime pipe, including after its stream phase.
  DWORD CheckDelivery(const CellRuntimeDispatchBinding&, const CellFileSha256&, ULONGLONG deadline) noexcept;
 private:
  DWORD Exchange(const CellRuntimeDispatchBinding&, const CellFileSha256&, std::uint32_t ordinal,
    bool delivery, ULONGLONG deadline) noexcept;
  DWORD Fail(DWORD error) noexcept;
  DWORD Peer(ULONGLONG deadline) noexcept;
  HANDLE controller_, parent_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding binding_;
  CellFileSha256 head_;
  CellFootprintScanGuard peer_;
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
  std::atomic<bool> busy_{false};
  std::uint32_t runtime_checks_ = 0, delivery_checks_ = 0;
};
class CellControllerRuntimeClient final {
 public:
  CellControllerRuntimeClient(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatchBinding& expected,
    const CellFileSha256& head, const CellControllerRuntimeClientOwner& owner) noexcept
    : pipe_(pipe), deadline_(deadline), expected_(expected), head_(head), owner_(owner) {}
  CellControllerRuntimeClient(const CellControllerRuntimeClient&) = delete;
  CellControllerRuntimeClient& operator=(const CellControllerRuntimeClient&) = delete;
  // Called only for a runtime_authority frame read by the owning protocol loop.
  // Rejects unknown/repeated sequence, nonce, digest, head and checkpoint count
  // before canonical admission. Any failure permanently fences this instance.
  DWORD Respond(const CellControllerRuntimeChallenge& challenge) noexcept;
  std::uint32_t Checks() const noexcept { return checks_; }
 private:
  DWORD Peer() noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding expected_;
  CellFileSha256 head_;
  CellControllerRuntimeClientOwner owner_;
  std::uint32_t checks_ = 0;
  DWORD failure_ = ERROR_SUCCESS;
  bool busy_ = false;
};
struct CellControllerRuntimeChannelOwner final {
  // Borrowed per-job stop event; the surrounding owner cancels and joins its
  // exact job. This class never signals a service-wide cancellation event.
  CellFootprintScanGuard peer;
  void* context = nullptr;
  // Check current authority for these exact staged stdin bytes before every
  // queue attempt. Stream admission does not replace per-tool effect approval.
  DWORD (*input)(void*, const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept = nullptr;
};
struct CellRuntimeControlOwner final {
  CellFootprintScanGuard peer;
  void* context = nullptr;
  // Consult the current canonical owner for the exact previously issued input.
  // Repeated queue attempts require fresh permission, even for identical bytes.
  DWORD (*input)(void*, const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept = nullptr;
  DWORD (*deliver)(void*, const CellRuntimeDispatchBinding&, const CellFileSha256&, ULONGLONG deadline) noexcept = nullptr;
  DWORD (*file)(void*, const CellRuntimeFileSelection&, ULONGLONG deadline) noexcept = nullptr;
};
enum class CellRuntimeControlRole { controller, protected_parent };
struct CellRuntimeControlEndpointOwner final {
  // Authenticates the retained primary runtime pipe, including installed
  // custody. The additional-pipe callback must bind its actual peer to that
  // same retained primary process, using VerifyBoundPipe on the installed owner.
  CellFootprintScanGuard peer;
  void* context = nullptr;
  DWORD (*client)(void*, CellPipeClientEvidence&) noexcept = nullptr;
  DWORD (*server)(void*, CellPipeServerEvidence&) noexcept = nullptr;
};
// Owns one secondary controller/helper pipe and its retained OS peer evidence.
// The primary pipe, cancellation and installed owners remain borrowed. Setup
// is one attempt, bounded to five seconds within the runtime deadline, and
// carries only a random locator plus the independently retained request/head.
// No workload, filesystem cell, service or disk operation is performed here.
// Serialize member calls. A failed Verify fences access but retains the owned
// handle until the outer owner cancels/joins borrowed I/O and calls Close.
class CellRuntimeControlEndpoint final {
 public:
  ~CellRuntimeControlEndpoint() { Close(); }
  CellRuntimeControlEndpoint() = default;
  CellRuntimeControlEndpoint(const CellRuntimeControlEndpoint&) = delete;
  CellRuntimeControlEndpoint& operator=(const CellRuntimeControlEndpoint&) = delete;
  DWORD OpenServer(HANDLE runtime, ULONGLONG deadline, const CellControllerRuntimeBinding& binding,
    const CellRuntimeControlEndpointOwner& owner) noexcept;
  DWORD OpenClient(HANDLE runtime, ULONGLONG deadline, const CellControllerRuntimeBinding& binding,
    const CellRuntimeControlEndpointOwner& owner) noexcept;
  DWORD Verify() noexcept;
  CellFootprintScanGuard Guard() noexcept;
  HANDLE Pipe() const noexcept { return open_ && !failure_ ? pipe_ : nullptr; }
  void Close() noexcept;
 private:
  friend struct CellRuntimeControlEndpointTestPeer;
  DWORD OpenServerOwned(HANDLE, ULONGLONG, const CellControllerRuntimeBinding&, const CellRuntimeControlEndpointOwner&, void* descriptor) noexcept;
  DWORD Begin(HANDLE, ULONGLONG, const CellControllerRuntimeBinding&, const CellRuntimeControlEndpointOwner&, bool server) noexcept;
  DWORD Peer(ULONGLONG deadline) noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE runtime_ = nullptr, pipe_ = INVALID_HANDLE_VALUE;
  ULONGLONG deadline_ = 0;
  CellControllerRuntimeBinding binding_;
  CellRuntimeControlEndpointOwner owner_;
  CellPipeClientEvidence client_;
  CellPipeServerEvidence server_;
  DWORD failure_ = ERROR_SUCCESS;
  bool attempted_ = false, busy_ = false, server_end_ = false, admitted_ = false, open_ = false;
};
// Dedicated authenticated control pipe, distinct from the runtime stream.
// The outer owner must authenticate and retain BOTH endpoints and serialize
// calls. This adapter opens no endpoints and supplies no canonical permission.
// Only the protected-parent role invokes the exact-input/delivery callbacks;
// only the controller role sends challenges. Each exchange has a fresh ordinal
// and a five-second I/O bound within the admitted lifetime. Failure is sticky.
// Delivery never consumes runtime frames, so terminal transfer and an in-flight
// runtime admission reply cannot be mistaken for a control response.
class CellRuntimeControlChannel final {
 public:
  CellRuntimeControlChannel(HANDLE runtime, HANDLE control, ULONGLONG deadline,
    const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, DWORD input_limit,
    CellRuntimeControlRole role, const CellRuntimeControlOwner& owner) noexcept
    : runtime_(runtime), control_(control), deadline_(deadline), binding_(binding), head_(head),
      input_limit_(input_limit), role_(role), owner_(owner) {}
  CellRuntimeControlChannel(const CellRuntimeControlChannel&) = delete;
  CellRuntimeControlChannel& operator=(const CellRuntimeControlChannel&) = delete;
  DWORD Input(const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept;
  DWORD Deliver(const CellRuntimeDispatchBinding&, const CellFileSha256&, ULONGLONG deadline) noexcept;
  DWORD File(const CellRuntimeFileSelection&, ULONGLONG deadline) noexcept;
  // One bounded request. The outer owner owns idle waits, cancellation and join.
  DWORD Respond(ULONGLONG deadline) noexcept;
 private:
  using Bytes = std::array<std::uint8_t, 1168>;
  DWORD Exchange(const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame*, const CellFileSha256&, ULONGLONG,
    const CellRuntimeFileSelection* = nullptr) noexcept;
  DWORD Validate(const Bytes&, CellRuntimeStreamFrame*, bool* delivery, CellRuntimeFileSelection*) noexcept;
  DWORD Peer(ULONGLONG deadline) noexcept;
  DWORD Begin(ULONGLONG deadline) noexcept;
  DWORD End(DWORD error) noexcept;
  DWORD Fail(DWORD error) noexcept;
  void Accept(const Bytes&, const CellRuntimeStreamFrame&, bool delivery) noexcept;
  HANDLE runtime_, control_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding binding_;
  CellFileSha256 head_;
  DWORD input_limit_;
  CellRuntimeControlRole role_;
  CellRuntimeControlOwner owner_;
  std::atomic<bool> busy_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
  std::uint32_t checks_ = 0;
  bool delivering_ = false;
  CellRuntimeStreamFrame last_input_;
  CellRuntimeStreamBytes last_input_bytes_{};
};
// Serializes runtime authority and stream I/O on one authenticated pipe. A job
// thread borrows Guard(); the host thread calls Pump(). Both must finish before
// this object or the borrowed channel/pipe/stop event are destroyed. Never run a
// second reader/writer on this pipe. Blocking callbacks need the outer watchdog.
class CellControllerRuntimeChannel final {
 public:
  CellControllerRuntimeChannel(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatchBinding& binding,
    const CellFileSha256& head, DWORD input_limit, std::uint64_t output_limit, JobStdioChannel& channel,
    const CellControllerRuntimeChannelOwner& owner)
    : pipe_(pipe), deadline_(deadline), binding_(binding), channel_(channel), owner_(owner),
      streams_(binding, input_limit, output_limit), authority_(pipe, deadline, binding, head,
        {PeerCallback, this, owner.peer.cancellation}, {this, ReceiveCallback, ProgressCallback}) {}
  CellControllerRuntimeChannel(const CellControllerRuntimeChannel&) = delete;
  CellControllerRuntimeChannel& operator=(const CellControllerRuntimeChannel&) = delete;
  CellFootprintScanGuard Guard() noexcept;
  DWORD Check() noexcept;
  // ERROR_RETRY means the job's current authority exchange owns the I/O lock.
  // That exchange also pumps permitted input and queued output while waiting.
  DWORD Pump() noexcept;
  bool OutputEnded() noexcept;
  bool MatchesCompletedInputOutput(const JobResult& job) noexcept;
  std::uint32_t AuthorityChecks() noexcept;
  void Abort(DWORD error) noexcept;
 private:
  static DWORD PeerCallback(void*) noexcept;
  static DWORD ReceiveCallback(void*, CellControllerMessage, const CellRuntimeStreamBytes&, ULONGLONG deadline) noexcept;
  static DWORD ProgressCallback(void*, ULONGLONG deadline) noexcept;
  DWORD Peer() noexcept;
  DWORD PeerUntil(ULONGLONG deadline) noexcept;
  DWORD FlushInput(ULONGLONG deadline) noexcept;
  DWORD SendOutput(ULONGLONG deadline) noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding binding_;
  JobStdioChannel& channel_;
  CellControllerRuntimeChannelOwner owner_;
  std::recursive_mutex mutex_;
  bool in_io_ = false;
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
  CellRuntimeStreamFrame pending_;
  CellRuntimeStreamBridge streams_;
  CellControllerRuntimeAuthority authority_;
};
}
