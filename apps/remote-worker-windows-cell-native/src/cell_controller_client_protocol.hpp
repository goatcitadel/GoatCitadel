#pragma once
#include "cell_controller_protocol.hpp"

namespace goatcitadel::worker_cell {
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
};
// Borrowed, authenticated client pipe; no path/identity override or reconnection.
// The request gets a fresh per-connection nonce. Only exact ordered records and
// committed digests advance creation. Failure leaves uncertain evidence intact.
// A zero return means receipt transport completed, not provisioning success;
// the receipt's native error/phase/count remain authoritative to its consumer.
DWORD RunCellControllerClientSession(HANDLE pipe, HANDLE stop, ULONGLONG deadline,
  const CellControllerRequest& request, const CellControllerClientOwner& owner) noexcept;
}
