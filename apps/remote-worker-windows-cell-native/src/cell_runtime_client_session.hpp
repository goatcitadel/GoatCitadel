#pragma once
#include "cell_runtime_session.hpp"
#include <memory>

namespace goatcitadel::worker_cell {
// Private helper bootstrap, sent only through its inherited input. The public
// pipe locator and one-use authentication secret are distinct random values.
// This supplies an independent request binding, never an execution grant.
using CellRuntimeHelperBootstrapBytes = std::array<std::uint8_t, 176>;
struct CellRuntimeHelperBootstrap final {
  CellFileSha256 pipe_nonce{}, secret{};
  CellControllerRuntimeBinding binding;
  DWORD request_bytes = 0;
  ~CellRuntimeHelperBootstrap() { SecureZeroMemory(secret.data(), secret.size()); }
};
DWORD DecodeCellRuntimeHelperBootstrap(const CellRuntimeHelperBootstrapBytes&, CellRuntimeHelperBootstrap*) noexcept;
std::wstring CellRuntimeHelperPipeName(const CellFileSha256& nonce, bool control = false);
// The caller has opened parent evidence and independently admits its custody.
// Authenticate only once; the private bootstrap secret is erased on return.
DWORD AuthenticateCellRuntimeHelperParent(CellPipeParentEvidence& parent, CellRuntimeHelperBootstrap& bootstrap,
  const CellFootprintScanGuard& custody, ULONGLONG deadline, bool control = false) noexcept;

struct CellRuntimeInputChunk final {
  std::array<std::uint8_t, kCellRuntimeStreamPayloadBytes> bytes{};
  DWORD count = 0;
  bool eof = false;
};
// Parent polls name the next input sequence, current total and fresh poll
// ordinal. A reply echoes all 88 bytes, followed by state (idle/data/EOF) and a
// complete stream frame. Idle has a zero frame; it neither advances nor ends
// input. Output receipts include the original stream kind and 80-byte header.
using CellRuntimeParentInputPoll = std::array<std::uint8_t, 88>;
using CellRuntimeParentInputReply = std::array<std::uint8_t, 1148>;
using CellRuntimeParentOutputReceipt = std::array<std::uint8_t, 84>;
class CellRuntimeParentStreams final {
 public:
  CellRuntimeParentStreams(HANDLE controller, HANDLE parent, ULONGLONG deadline,
    const CellRuntimeDispatchBinding& binding, DWORD input_limit, std::uint64_t output_limit, const CellFootprintScanGuard& peer) noexcept
    : controller_(controller), parent_(parent), deadline_(deadline), binding_(binding), peer_(peer),
      input_(binding, input_limit, output_limit, true), output_(binding, input_limit, output_limit, false) {}
  CellRuntimeParentStreams(const CellRuntimeParentStreams&) = delete;
  CellRuntimeParentStreams& operator=(const CellRuntimeParentStreams&) = delete;
  // The parent must poll its source immediately, returning idle if unavailable.
  // Only the IPC exchange waits, bounded by the supplied deadline and five
  // seconds. No next poll occurs until the runtime client accepts this chunk.
  DWORD Input(const CellRuntimeDispatchBinding&, CellRuntimeInputChunk*, ULONGLONG deadline) noexcept;
  DWORD Output(const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept;
 private:
  DWORD Begin(const CellRuntimeDispatchBinding&, ULONGLONG deadline) noexcept;
  DWORD Peer(ULONGLONG deadline) noexcept;
  DWORD End(DWORD error) noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE controller_, parent_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding binding_;
  CellFootprintScanGuard peer_;
  CellRuntimeStreamSequence input_, output_;
  std::uint32_t polls_ = 0, input_sequence_ = 0;
  std::atomic<bool> busy_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
};
// All parent adapters borrow one authenticated pipe. The surrounding session
// must serialize stream, authority and retention callbacks and close the pipe
// after any error. These callbacks never signal borrowed cancellation events.
struct CellRuntimeClientSessionOwner final {
  CellControllerRuntimeClientOwner runtime;
  void* context = nullptr;
  // Nonblocking source. ERROR_NO_MORE_ITEMS means no input is ready yet (all
  // fields must stay zero). EOF is a separate empty chunk. The session assigns
  // sequence/totals and asks for no further chunk until exact acknowledgment.
  DWORD (*input)(void*, const CellRuntimeDispatchBinding&, CellRuntimeInputChunk*, ULONGLONG deadline) noexcept = nullptr;
  // Validated ephemeral frames, including distinct stdout/stderr EOFs. The
  // consumer must apply normal sanitization before diagnostic persistence.
  DWORD (*output)(void*, const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept = nullptr;
  DWORD (*deliver)(void*, const CellRuntimeDispatchBinding&, const CellFileSha256& head, ULONGLONG deadline) noexcept = nullptr;
  CellRuntimeResultRetention retention;
  CellRuntimeFileDeliveryOwner files;
};
struct CellRuntimeClientSessionResult final {
  DWORD error = ERROR_SUCCESS;
  bool request_acknowledged = false, input_ended = false, output_ended = false, result_received = false;
  bool retention_attempted = false, retention_confirmed = false, retention_receipt_sent = false;
  bool file_selection_requested = false, files_received = false;
  // Released only after current authority, exact stream totals and retention
  // have passed. A failed retention attempt may already have committed remotely;
  // its caller must resolve that exact binding instead of replaying execution.
  CellRuntimeDispatchResult execution;
};
// Serialized worker-side session for an already authenticated retained pipe.
// The owner supplies protected runtime/input/output/delivery/retention owners.
// This class never opens an endpoint or grants authority from request bytes.
// It owns only its cancellation monitor; close the borrowed pipe after errors.
// Blocking callbacks require the caller's outer process watchdog.
class CellRuntimeClientSession final {
 public:
  CellRuntimeClientSession(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatchBinding& expected,
    const CellFileSha256& head, const CellRuntimeClientSessionOwner& owner) noexcept
    : pipe_(pipe), deadline_(deadline), expected_(expected), head_(head), owner_(owner) {}
  CellRuntimeClientSession(const CellRuntimeClientSession&) = delete;
  CellRuntimeClientSession& operator=(const CellRuntimeClientSession&) = delete;
  CellRuntimeClientSessionResult Run(const std::vector<std::uint8_t>& bytes) noexcept;
 private:
  DWORD Fail(DWORD error) noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatchBinding expected_;
  CellFileSha256 head_;
  CellRuntimeClientSessionOwner owner_;
  std::atomic<bool> attempted_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
};
// Composes all callbacks for one decoded, independently admitted request. The
// helper supplies Owner() to CellRuntimeClientSession and calls Finish only
// after that session returns successful retained-result evidence. This owns no
// endpoints and grants no permission from configuration alone. Both borrowed
// pipes and current local custody guard must survive the complete session.
class CellRuntimeParentConnection final {
 public:
  CellRuntimeParentConnection(HANDLE controller, HANDLE parent, ULONGLONG deadline, const CellRuntimeDispatch& expected,
    const CellFootprintScanGuard& peer, const CellRuntimeFileDeliveryOwner& files = {})
    : parent_(parent), deadline_(deadline), expected_(expected), peer_(peer), files_(files),
      authority_(controller, parent, deadline, expected.binding, expected.reference.checkpoint_sha256, {Peer, this, peer.cancellation}),
      streams_(controller, parent, deadline, expected.binding, expected.limits.input_bytes, expected.limits.raw_output_bytes, {Peer, this, peer.cancellation}),
      committer_(controller, parent, expected, {Peer, this, peer.cancellation}) {}
  CellRuntimeParentConnection(const CellRuntimeParentConnection&) = delete;
  CellRuntimeParentConnection& operator=(const CellRuntimeParentConnection&) = delete;
  CellRuntimeClientSessionOwner Owner() noexcept;
  DWORD ForwardFiles(const CellRuntimeClientSessionResult& result) noexcept;
  DWORD Finish(const CellRuntimeClientSessionResult& result) noexcept;
 private:
  static DWORD Peer(void*) noexcept;
  static DWORD Admit(void*, const CellRuntimeDispatchBinding&, const CellFileSha256&, std::uint32_t) noexcept;
  static DWORD Input(void*, const CellRuntimeDispatchBinding&, CellRuntimeInputChunk*, ULONGLONG) noexcept;
  static DWORD Output(void*, const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame&, ULONGLONG) noexcept;
  static DWORD Deliver(void*, const CellRuntimeDispatchBinding&, const CellFileSha256&, ULONGLONG) noexcept;
  static DWORD Commit(void*, const CellRuntimeDispatchBinding&, const CellFileSha256&, const CellRuntimeDispatchResult&,
    const CellFileSha256&, CellFileSha256*, ULONGLONG) noexcept;
  static DWORD File(void*, const CellRuntimeFileSelection&, ULONGLONG) noexcept;
  DWORD CheckFile(const CellRuntimeFileSelection&, ULONGLONG) noexcept;
  DWORD ValidateRetained(const CellRuntimeClientSessionResult&, std::vector<std::uint8_t>*, CellFileSha256*) noexcept;
  DWORD Enter() noexcept;
  DWORD Leave(DWORD error) noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE parent_;
  ULONGLONG deadline_;
  CellRuntimeDispatch expected_;
  CellFootprintScanGuard peer_;
  CellRuntimeFileDeliveryOwner files_;
  CellRuntimeParentAuthority authority_;
  CellRuntimeParentStreams streams_;
  CellRuntimeResultPipeCommitter committer_;
  std::atomic<bool> busy_{false}, checking_peer_{false}, finished_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
  bool runtime_admitted_ = false, input_ended_ = false, output_ended_ = false, error_ended_ = false, delivering_ = false, committed_ = false;
  bool files_attempted_ = false, files_forwarded_ = false;
  CellFileSha256 retained_digest_{};
};
// Restricted helper composition. Opens the secondary controller endpoint,
// forwards control to the separately authenticated parent control pipe, and
// runs the existing primary runtime/retention session. All three supplied pipes,
// the installed endpoint owner and its stop event are borrowed. No grant is
// inferred from their identity or from decoded request bytes.
// Run returns after result retention; forwarding remains active until Finish,
// which the outer owner calls only after validating the controller's receipt.
// Serialize Run/Finish/destruction. Verify may run concurrently with forwarding.
// Destruction cancels and joins only the owned threads before closing its pipe.
// Blocking custody callbacks still require the helper's process watchdog.
class CellRuntimeHelperForwardingSession final {
 public:
  CellRuntimeHelperForwardingSession();
  ~CellRuntimeHelperForwardingSession();
  CellRuntimeHelperForwardingSession(const CellRuntimeHelperForwardingSession&) = delete;
  CellRuntimeHelperForwardingSession& operator=(const CellRuntimeHelperForwardingSession&) = delete;
  CellRuntimeClientSessionResult Run(HANDLE controller, HANDLE parent, HANDLE parent_control, ULONGLONG deadline,
    const CellControllerRuntimeBinding&, const std::vector<std::uint8_t>&, const CellRuntimeControlEndpointOwner&) noexcept;
  DWORD Verify() noexcept;
  DWORD Finish() noexcept;
  void Cancel(DWORD error) noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
  bool attempted_ = false;
};
}
