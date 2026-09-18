#pragma once
#include "cell_capacity_wire.hpp"
#include "cell_controller_protocol.hpp"

namespace goatcitadel::worker_cell {
struct CellPoolJoinedCapacity;
struct CellJoinedCapacityMemberBytes final {
  CellControllerCapacityBytes guest{};
  std::vector<CellControllerInventoryChunkBytes> guest_chunks;
  CellControllerBackingCapacityBytes backing{};
};
struct CellPoolJoinedCapacityBytes final {
  CellFileSha256 pool_sha256{};
  CellCapacityLayoutBytes layout{};
  std::vector<std::uint8_t> host;
  std::vector<CellJoinedCapacityMemberBytes> members;
};
// GCPRESP1: 88-byte version/count/size/nonce/pool header, one 384-byte
// layout, one host capture, then ordered (index, chunk-count, guest, backing,
// chunks) members. Bounds derive from 64 members and 20,000 total objects.
inline constexpr std::size_t kCellPoolCapacityResponseMaximumBytes =
  88 + 384 + kCellCapacityCaptureMaximumBytes + 64 * (8 + 352 + 424) + 1063 * 1000;
DWORD EncodeCellPoolCapacityResponse(const CellControllerRequest& retained,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellCapacityLayoutRecord&, const CellFileSha256& capture_nonce,
  const CellPoolJoinedCapacity&, std::vector<std::uint8_t>*) noexcept;
// Bounded transport on an already authenticated, borrowed pipe. Every I/O
// rechecks the retained current-authority guard; no reconnect or deadline
// extension. Read returns complete untrusted bytes only: the caller must still
// validate independent capture bindings and the outer terminal receipt.
DWORD WriteCellPoolCapacityResponse(HANDLE pipe, ULONGLONG deadline,
  const CellControllerNonce&, const CellFootprintScanGuard&, std::span<const std::uint8_t>) noexcept;
DWORD ReadCellPoolCapacityResponse(HANDLE pipe, ULONGLONG deadline,
  const CellControllerNonce&, const CellFootprintScanGuard&, std::vector<std::uint8_t>*) noexcept;
// One host capture and every ordered member from the independently admitted
// pool. The combined 20,000-entry bound applies across host and all guests.
// This encodes completed evidence only; it grants no collection authority.
DWORD EncodeCellPoolJoinedCapacity(const CellControllerRequest& retained,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellCapacityLayoutRecord&, const CellFileSha256& capture_nonce,
  const CellPoolJoinedCapacity&, CellPoolJoinedCapacityBytes*) noexcept;
struct CellJoinedCapacityBytes final {
  CellCapacityLayoutBytes layout{};
  std::vector<std::uint8_t> host;
  CellControllerCapacityBytes guest{};
  std::vector<CellControllerInventoryChunkBytes> guest_chunks;
  CellControllerBackingCapacityBytes backing{};
};

// Data-only handoff of a completed joined observation. The caller independently
// retains the full inventory request/history, local principals, layout and
// capture window; these bytes grant no execution or capture authority. Collection
// still requires current authority, global writer quiescence and complete pool
// coverage. Shared-artifact reference ownership is supplied separately.
// Host bytes use capture_nonce; guest/backing frames preserve retained.nonce.
// No protocol operation is dispatched. Any error clears the entire output.
DWORD EncodeCellJoinedCapacity(const CellControllerRequest& retained,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellCapacityLayoutRecord& layout, const CellFileSha256& capture_nonce,
  const CellProvisioningJoinedCapacity& observation, CellJoinedCapacityBytes* output) noexcept;

struct CellJoinedCapacityReference final {
  CellControllerRequest history;
  std::wstring owner_sid, controller_sid;
  CellCapacityLayoutRecord layout;
  CellFileSha256 capture_nonce{};
  CellFootprintScanLimits limits;
};

// Synchronous native collection through the original live journal/layout. All
// reference data and callback descriptors are frozen before external callbacks.
// The caller retains both owners, the cancellation handle, current canonical
// authority, complete pool coverage and global writer quiescence through return.
// Serialize calls and provide an outer watchdog for blocking native operations.
// This neither creates storage nor enables an installed controller operation.
class CellJoinedCapacityCollector final {
 public:
  static DWORD Capture(CellProvisioningJournal& journal, CellCapacityLayout& layout,
    const CellJoinedCapacityReference& reference, const CellFootprintScanGuard& authority,
    const CellFootprintCellBinding& binding, CellJoinedCapacityBytes* output) noexcept;
 private:
  friend struct CellJoinedCapacityCollectorTestPeer;
  struct Operations final {
    void* context = nullptr;
    DWORD (*matches)(void*, const CellJoinedCapacityReference&) noexcept = nullptr;
    DWORD (*verify)(void*, const CellJoinedCapacityReference&) noexcept = nullptr;
    DWORD (*capture)(void*, const CellJoinedCapacityReference&, const CellFootprintScanLimits&,
      const CellFootprintScanGuard&, const CellFootprintCellBinding&, CellProvisioningJoinedCapacity*) noexcept = nullptr;
  };
  struct NativeContext;
  static DWORD RunOwned(const Operations&, const CellJoinedCapacityReference&,
    const CellFootprintScanGuard&, const CellFootprintCellBinding&, CellJoinedCapacityBytes*) noexcept;
};
}
