#pragma once
#include "cell_runtime_dispatch.hpp"
#include "cell_runtime_install.hpp"
#include "cell_controller_transport.hpp"
#include <atomic>
#include <memory>

namespace goatcitadel::worker_cell {
struct CellControllerRequest;
inline constexpr std::size_t kMaximumCellRuntimeResultBytes = 256 + 352 + 1000 * 1000;
// GCRRS001: a 256-byte job/result header, then (only for verified inventory)
// the existing 352-byte capacity summary and ordered 1000-byte object chunks.
// Raw output prefixes/tails never enter this terminal metadata encoding.
// Optional bit 15 retains four host backing u64 counts at bytes 220..251;
// without it those bytes remain zero, preserving historical result digests.
DWORD EncodeCellRuntimeResult(const CellRuntimeDispatch& expected, const CellRuntimeDispatchResult& result,
  std::vector<std::uint8_t>* output) noexcept;
DWORD DecodeCellRuntimeResult(const CellRuntimeDispatch& expected, const std::vector<std::uint8_t>& bytes,
  CellRuntimeDispatchResult* output) noexcept;
DWORD HashCellRuntimeResult(std::span<const std::uint8_t> bytes, CellFileSha256* output) noexcept;
// GCRFA001: 200-byte header followed by exact staged bytes (at most 1 MiB).
// Header: magic, nonce, request hash, canonical result hash, work identity,
// file identity, logical/allocated u64 counts, raw-content SHA256. This is a
// local encoding, not publication authority or a replacement for current
// delivery authorization. The receiving owner must preserve protected custody.
DWORD EncodeCellRuntimeStagedFile(const CellRuntimeDispatch& expected, const CellRuntimeDispatchResult& result,
  const CellFileIdentity& file, std::vector<std::uint8_t>* output) noexcept;
struct CellRuntimeLocalOutcomeRecord final {
  CellFileIdentity file;
  CellFileSha256 intent_sha256{}, outcome_sha256{};
  bool intent_retained = false, outcome_retained = false, result_encoded = false;
  // Derived only from a sealed, exactly bound decoded result. This is historical
  // job cleanup evidence, not current quiescence or permission to measure/run.
  bool cleanup_verified = false;
  DWORD execution_error = ERROR_SUCCESS, encoding_error = ERROR_SUCCESS;
  DWORD observed_job_error = ERROR_SUCCESS, observed_process_id = 0;
  CellRuntimeDispatchResult execution;
};
// Independently retained admission metadata plus validated journal history.
// Contains no executable, arguments, environment, stdin or staging selectors.
// This binds historical result reads only and cannot authorize another run.
struct CellRuntimeCleanupExpectation final {
  CellRuntimeDispatchBinding binding;
  CellProvisioningAnchor anchor;
  CellFileSha256 checkpoint_sha256{}, runtime_bundle_sha256{};
  CellWorkspaceIdentities workspace;
  DWORD maximum_input_bytes = 0, maximum_inventory_entries = 0;
  std::uint64_t maximum_output_bytes = 0;
};
// Exact independently retained installation request bytes and binding. Used for
// historical writer coverage only; never a request to copy or execute again.
struct CellRuntimeInstallationExpectation final {
  std::array<std::uint8_t, kCellRuntimeInstallBytes> bytes{};
  CellRuntimeInstallBinding binding;
};
struct CellRuntimeCleanupBinding final { CellFileSha256 challenge{}, set_sha256{}; };
struct CellRuntimeCleanupAdmission final {
  CellRuntimeCleanupBinding binding;
  std::vector<CellRuntimeInstallationExpectation> installations;
};
// GCCADM01: 80-byte header and zero or one 336-byte installation admission.
// Receive only through authenticated primary admission custody, independently
// of the cleanup data stream. Decoding grants no journal or writer authority.
DWORD DecodeCellRuntimeCleanupAdmission(std::span<const std::uint8_t>, CellRuntimeCleanupAdmission*) noexcept;
struct CellRuntimeCleanupSet final {
  CellRuntimeCleanupBinding binding;
  CellProvisioningAnchor anchor;
  CellFileSha256 checkpoint_sha256{};
  CellWorkspaceIdentities workspace;
  std::vector<CellRuntimeCleanupExpectation> expectations;
};
inline constexpr std::size_t kMaximumCellRuntimeCleanupBytes = 252 + 108 * 1000;
inline constexpr std::size_t kCellRuntimePoolCleanupHeaderBytes = 80;
inline constexpr std::size_t kCellRuntimePoolCleanupMemberHeaderBytes = 40;
inline constexpr std::size_t kMaximumCellRuntimePoolCleanupBytes = 80 + 64 * (40 + 416 + 252) + 108 * 1000;
struct CellRuntimePoolCleanupSet final {
  CellFileSha256 snapshot_sha256{};
  std::vector<CellRuntimeCleanupAdmission> admissions;
  std::vector<CellRuntimeCleanupSet> members;
};
// Data-only complete-set decoder. The current primary admission independently
// supplies the challenge and exact current set. Every other member must match
// its admitted pool history. Fingerprints are provenance, not authority; this
// neither opens journals nor proves process cleanup or writer exclusion.
DWORD DecodeCellRuntimePoolCleanup(std::span<const std::uint8_t>, const CellControllerRequest&,
  const std::wstring& owner_sid, const std::wstring& controller_sid, CellRuntimePoolCleanupSet*) noexcept;
// GCCLEAN1: 252-byte common header and 108-byte ordered expectation records.
// Expected challenge/digest must arrive independently through protected custody.
// These functions neither open a pipe nor establish current measurement authority.
DWORD HashCellRuntimeCleanup(std::span<const std::uint8_t>, CellFileSha256*) noexcept;
DWORD DecodeCellRuntimeCleanup(std::span<const std::uint8_t>, const CellRuntimeCleanupBinding&, CellRuntimeCleanupSet*) noexcept;
// Single-use metadata exchange on an already authenticated, retained,
// overlapped pipe. Owners serialize calls, retain the pipe/cancellation event
// through completion and discard uncertain connections. Authority verifies
// current peer and exact-set permission; callbacks need an outer watchdog.
// The ACK proves receipt only, never cleanup, execution or measurement authority.
class CellRuntimeCleanupTransfer final {
 public:
  CellRuntimeCleanupTransfer(HANDLE pipe, ULONGLONG deadline, const CellRuntimeCleanupBinding& binding,
    const CellFootprintScanGuard& authority) noexcept : pipe_(pipe), deadline_(deadline), binding_(binding), authority_(authority) {}
  CellRuntimeCleanupTransfer(const CellRuntimeCleanupTransfer&) = delete;
  CellRuntimeCleanupTransfer& operator=(const CellRuntimeCleanupTransfer&) = delete;
  DWORD Read(CellRuntimeCleanupSet*) noexcept;
  // Snapshot the independently admitted controller request/principals before
  // callbacks and require their full history binding before writing the ACK.
  DWORD ReadForController(const CellControllerRequest&, const std::wstring& owner_sid,
    const std::wstring& controller_sid, CellRuntimeCleanupSet*) noexcept;
  // Additionally reconcile runtime AND installation attempts against the
  // original journal before ACK. Installation expectations arrive independently
  // through protected admission, never from the cleanup stream. An empty set
  // asserts no installation attempts; it does not skip the namespace check.
  // Caller retains journal and exclusive writer custody throughout both checks;
  // historical coverage alone never establishes present quiescence.
  DWORD ReadVerifiedForController(CellProvisioningJournal&, const CellControllerRequest&, const std::wstring& owner_sid,
    const std::wstring& controller_sid, std::span<const CellRuntimeInstallationExpectation>, CellRuntimeCleanupSet*) noexcept;
  DWORD Write(std::span<const std::uint8_t>) noexcept;
 private:
  friend struct CellRuntimeCleanupTransferTestPeer;
  struct CoverageOwner final {
    void* context;
    DWORD (*verify)(void*, const CellRuntimeCleanupSet&, const CellFootprintScanGuard&, DWORD) noexcept;
  };
  DWORD ReadController(const CellControllerRequest&, const std::wstring&, const std::wstring&, CellRuntimeCleanupSet*, const CoverageOwner*) noexcept;
  DWORD ReadBound(CellRuntimeCleanupSet*, const CellControllerRequest*, const std::wstring*, const std::wstring*, const CoverageOwner* = nullptr) noexcept;
  DWORD Begin() noexcept;
  DWORD Check() const noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeCleanupBinding binding_;
  CellFootprintScanGuard authority_;
  bool attempted_ = false;
};
struct CellRuntimeInstallLocalRecord final {
  CellFileIdentity file;
  CellFileSha256 intent_sha256{}, outcome_sha256{};
  bool intent_retained = false, outcome_retained = false;
  RuntimeBundleInstallResult installation;
  // Exact bytes read back under original local custody, never reconstructed
  // from counters. Intent-only records contain 256 bytes; sealed outcomes 352.
  std::vector<std::uint8_t> bytes;
};
// Exclusive controller-local attempt and outcome in the original journal's
// protected host control directory. Begin flushes an intent before dispatch;
// the same nonce is never reopened for writing, including after a crash.
// Retain flushes canonical metadata without raw output before remote delivery.
// A revoked worker/lease cannot suppress this local record: only the original
// journal and host-directory custody is consulted. Partial files remain for
// explicit read-only recovery; none of these methods resumes execution.
// Serialize calls and retain the original journal until this object closes.
class CellRuntimeLocalOutcome final {
 public:
  CellRuntimeLocalOutcome();
  ~CellRuntimeLocalOutcome();
  CellRuntimeLocalOutcome(const CellRuntimeLocalOutcome&) = delete;
  CellRuntimeLocalOutcome& operator=(const CellRuntimeLocalOutcome&) = delete;
  DWORD Begin(CellProvisioningJournal&, const CellRuntimeDispatch&) noexcept;
  DWORD Retain(const CellRuntimeDispatchResult&, DWORD execution_error, CellRuntimeLocalOutcomeRecord*) noexcept;
  static DWORD Read(CellProvisioningJournal&, const CellRuntimeDispatch&, CellRuntimeLocalOutcomeRecord*) noexcept;
  // Caller serializes control-directory writers. Require an independently
  // retained expectation for every runtime attempt, then verify each
  // sealed cleanup result. This does not cover installation/host writers.
  static DWORD VerifyCleanupCoverage(CellProvisioningJournal&, const CellProvisioningAnchor&, const CellFileSha256&,
    std::span<const CellRuntimeCleanupExpectation>, const CellFootprintScanGuard&, DWORD wall_ms) noexcept;
  // Require a sealed outcome for every installation attempt in this journal.
  // A failed but joined copy may qualify; success/readiness is not inferred.
  // Caller still owns current writer exclusion and complete multi-cell coverage.
  static DWORD VerifyInstallationCoverage(CellProvisioningJournal&, const CellProvisioningAnchor&, const CellFileSha256&,
    std::span<const CellRuntimeInstallationExpectation>, const CellFootprintScanGuard&, DWORD wall_ms) noexcept;
  // Separate installation namespace/magic/hash domains; never an execution
  // record. Exclusive intent is flushed before copying; retention requires
  // original local custody, not a still-live remote installation grant.
  DWORD BeginInstall(CellProvisioningJournal&, std::span<const std::uint8_t>, const CellRuntimeInstallBinding&) noexcept;
  DWORD RetainInstall(const RuntimeBundleInstallResult&, CellRuntimeInstallLocalRecord*) noexcept;
  static DWORD ReadInstall(CellProvisioningJournal&, std::span<const std::uint8_t>, const CellRuntimeInstallBinding&, CellRuntimeInstallLocalRecord*) noexcept;
 private:
  friend struct CellRuntimeLocalOutcomeTestPeer;
  struct Owner final {
    HANDLE directory = INVALID_HANDLE_VALUE;
    CellFileIdentity directory_identity;
    CellProvisioningAnchor anchor;
    CellFileSha256 assignment{}, profile{};
    std::vector<std::uint8_t> descriptor;
    void* context = nullptr;
    DWORD (*verify)(void*) noexcept = nullptr;
  };
  struct State;
  DWORD BeginOwned(const Owner&, const CellRuntimeDispatch&) noexcept;
  static DWORD ReadOwned(const Owner&, const CellRuntimeDispatch&, CellRuntimeLocalOutcomeRecord*) noexcept;
  static DWORD VerifyCleanupCoverageOwned(const Owner&, std::span<const CellRuntimeCleanupExpectation>, const CellFootprintScanGuard&, DWORD) noexcept;
  static DWORD VerifyAttemptCoverageOwned(const Owner&, std::span<const CellRuntimeCleanupExpectation>,
    std::span<const CellRuntimeInstallRequest>, bool installation, const CellFootprintScanGuard&, DWORD) noexcept;
  DWORD BeginInstallOwned(const Owner&, const CellRuntimeInstallRequest&) noexcept;
  static DWORD ReadInstallOwned(const Owner&, const CellRuntimeInstallRequest&, CellRuntimeInstallLocalRecord*) noexcept;
  std::unique_ptr<State> state_;
  bool attempted_ = false;
};
struct CellRuntimeResultRetention final {
  void* context = nullptr;
  // Commit the exact canonical result through the protected retention owner;
  // return its retained digest only after durable success. This callback must
  // not use this pipe. Failure/uncertainty requires recovery lookup, not replay.
  DWORD (*commit)(void*, const CellRuntimeDispatchBinding&, const CellFileSha256& head,
    const CellRuntimeDispatchResult&, const CellFileSha256& digest, CellFileSha256* retained, ULONGLONG deadline) noexcept = nullptr;
};

// Adapter for CellRuntimeClientSessionOwner::retention. The trusted parent
// owns a separate authenticated pipe and bridges its canonical bytes to the
// Gateway. Both validation and durable-retention receipts are required. No
// endpoint is opened here, and the controller pipe (including an alias handle)
// cannot be used for this nested exchange. Owners retain both pipes until join.
class CellRuntimeResultPipeCommitter final {
 public:
  CellRuntimeResultPipeCommitter(HANDLE controller_pipe, HANDLE parent_pipe, const CellRuntimeDispatch& expected,
    const CellFootprintScanGuard& parent_authority)
    : controller_pipe_(controller_pipe), parent_pipe_(parent_pipe), expected_(expected), authority_(parent_authority) {}
  CellRuntimeResultPipeCommitter(const CellRuntimeResultPipeCommitter&) = delete;
  CellRuntimeResultPipeCommitter& operator=(const CellRuntimeResultPipeCommitter&) = delete;
  CellRuntimeResultRetention Owner() noexcept { return {this, Commit}; }
 private:
  static DWORD Commit(void*, const CellRuntimeDispatchBinding&, const CellFileSha256&, const CellRuntimeDispatchResult&,
    const CellFileSha256&, CellFileSha256*, ULONGLONG) noexcept;
  static DWORD Authorize(void*) noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE controller_pipe_, parent_pipe_;
  CellRuntimeDispatch expected_;
  CellFootprintScanGuard authority_;
  std::atomic<bool> attempted_{false};
  std::atomic<DWORD> failure_{ERROR_SUCCESS};
};

// One terminal exchange after the stream owner has ended both output streams
// and joined the native dispatch. No concurrent readers/writers on this pipe.
// The copied expected dispatch comes from independently retained admission.
// Authority must check current peer custody and permission to deliver this exact
// result. Blocking callbacks require an outer watchdog. This never signals stop.
// The first ACK proves complete validated receipt only. An optional second,
// distinct ACK attests exact result retention through the protected callback.
// Neither proves tool/effect success, replay permission, quotas or installed custody.
class CellRuntimeResultTransfer final {
 public:
  CellRuntimeResultTransfer(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatch& expected,
    const CellFootprintScanGuard& authority)
    : pipe_(pipe), deadline_(deadline), expected_(expected), authority_(authority) {}
  CellRuntimeResultTransfer(const CellRuntimeResultTransfer&) = delete;
  CellRuntimeResultTransfer& operator=(const CellRuntimeResultTransfer&) = delete;
  DWORD Write(const CellRuntimeDispatchResult& result, bool await_retention = false) noexcept;
  DWORD Read(CellRuntimeDispatchResult* output) noexcept;
  DWORD Retain(const CellRuntimeDispatchResult& result, const CellRuntimeResultRetention& owner) noexcept;
  bool ValidatedReceipt() const noexcept { return validated_; }
  bool RetentionConfirmed() const noexcept { return retained_; }
  bool RetentionReceiptSent() const noexcept { return retention_sent_; }
 private:
  DWORD Begin() noexcept;
  DWORD Check() noexcept;
  DWORD Fail(DWORD error) noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatch expected_;
  CellFootprintScanGuard authority_;
  bool attempted_ = false;
  bool read_complete_ = false, retention_attempted_ = false, validated_ = false, retained_ = false, retention_sent_ = false;
  CellFileSha256 received_digest_{};
  DWORD received_size_ = 0;
  DWORD failure_ = ERROR_SUCCESS;
};
}
