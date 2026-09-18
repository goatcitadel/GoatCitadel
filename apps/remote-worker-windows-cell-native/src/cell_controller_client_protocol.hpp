#pragma once
#include "cell_controller_protocol.hpp"
#include "cell_install_capacity_pipe.hpp"

namespace goatcitadel::worker_cell {
struct CellRuntimeClientSessionResult;
struct CellControllerClientOwner final {
  void* context = nullptr;
  // Validate both live endpoints and installed custody. This is not canonical
  // assignment/lease authority; the Gateway bridge must validate that separately.
  DWORD (*authorize)(void*) noexcept = nullptr;
  // Independently validate every record against canonical state. For creation,
  // commit the exact bytes before returning their digest. Recovery never ACKs or
  // resumes effects. Blocking callbacks require the helper's outer watchdog.
  DWORD (*checkpoint)(void*, const CellProvisioningRecord&, bool acknowledge, CellFileSha256*) noexcept = nullptr;
  DWORD (*receipt)(void*, const std::array<std::uint8_t, 16>&) noexcept = nullptr;
  // Recheck the exact current canonical claim and retained chain through the
  // protected Gateway owner before approving this numbered volume/format check.
  DWORD (*volume_authority)(void*, std::uint32_t ordinal, std::uint32_t checkpoint_count,
    const CellFileSha256& retained_head) noexcept = nullptr;
  // Fixed local custody for protection operations, never supplied by the pipe
  // peer. The actual service checks its own independently resolved principals.
  std::wstring owner_sid{}, controller_sid{};
  // Invoked once only after the entire history, capacity frame and successful
  // terminal receipt are validated. A consumer must retain the terminal receipt
  // with this observation and recheck canonical authority before using it.
  DWORD (*capacity)(void*, const CellControllerNonce&, const CellProvisioningFootprint&) noexcept = nullptr;
  DWORD (*backing_capacity)(void*, const CellControllerNonce&, const CellProvisioningBackingFootprint&) noexcept = nullptr;
  DWORD (*inventory)(void*, const CellControllerNonce&, const CellProvisioningInventory&) noexcept = nullptr;
  // Complete response after a successful terminal receipt and final canonical
  // reauthorization. The consumer must decode against its retained pool/layout/
  // window; raw bytes alone are neither accounting nor readiness evidence.
  DWORD (*pool_capacity)(void*, const CellControllerNonce&, std::span<const std::uint8_t>) noexcept = nullptr;
  // Supplies the actual worker session with independently retained dispatch,
  // current Gateway admission, input/output and protected retention owners.
  // Called once after the full journal and exact runtime-ready binding pass.
  CellRuntimeClientSessionResult (*run_runtime)(void*, HANDLE pipe, HANDLE stop, ULONGLONG deadline,
    const CellControllerRuntimeBinding&) noexcept = nullptr;
  // Installation-specific current canonical admission and complete-pool owner.
  // A volume callback cannot approve these effects. The frozen decoded request
  // must remain bound to the exact admitted package, journal and assignment.
  DWORD (*installation_authority)(void*, const CellRuntimeInstallRequest&, std::uint32_t ordinal) noexcept = nullptr;
  // Validate exact retained local bytes against independently admitted request
  // and history before acknowledging receipt. This is not Gateway retention.
  DWORD (*installation_outcome)(void*, const std::array<std::uint8_t, 352>&) noexcept = nullptr;
  // Trusted caller selects capture admission before connecting. When supplied,
  // copying cannot succeed without it; retain the reservation through finish.
  // Recovery is read-only and cannot acquire a copy reservation.
  CellInstallCapacityClientAdmission installation_capacity{};
  // Actual authenticated handshake nonce, before request dispatch or evidence.
  // Combined installation requires this independent endpoint registration.
  DWORD (*connection)(void*, const CellControllerNonce&) noexcept = nullptr;
};
// Borrowed, authenticated client pipe; no path/identity override or reconnection.
// The request gets a fresh per-connection nonce. Only exact ordered records and
// committed digests advance creation. Failure leaves uncertain evidence intact.
// A zero return means receipt transport completed, not provisioning success;
// the receipt's native error/phase/count remain authoritative to its consumer.
DWORD RunCellControllerClientSession(HANDLE pipe, HANDLE stop, ULONGLONG deadline,
  const CellControllerRequest& request, const CellControllerClientOwner& owner) noexcept;
}
