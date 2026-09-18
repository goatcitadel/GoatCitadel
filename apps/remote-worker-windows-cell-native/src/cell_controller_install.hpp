#pragma once
#include "cell_controller_identity.hpp"
#include "cell_runtime_install.hpp"
#include "cell_provisioning_journal.hpp"

namespace goatcitadel::worker_cell {
// Serialized installed-controller composition. Decodes independently admitted
// metadata, checks its package/bundle against installer custody, pins the fixed
// source, and copies through the recorded journal guard. The required external
// authority must own current admission and complete-pool reservation/quiescence
// for the entire call. A separate local installation intent is flushed before
// copying and its outcome before success; remote revocation does not suppress
// local retention. This does not supply remote admission/result persistence,
// publish readiness, or authorize workload execution.
// Partial files/counters survive refusal for explicit reconciliation.
RuntimeBundleInstallResult InstallCellControllerRuntime(
  CellControllerIdentity& identity, CellProvisioningJournal& journal,
  std::span<const std::uint8_t> bytes, const CellRuntimeInstallBinding& expected,
  PinnedCellRuntimeBundle& output, DWORD wall_ms,
  const CellFootprintScanGuard& authority) noexcept;
}  // namespace goatcitadel::worker_cell
