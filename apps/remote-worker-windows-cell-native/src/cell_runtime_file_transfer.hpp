#pragma once
#include "cell_runtime_result.hpp"

namespace goatcitadel::worker_cell {
struct CellRuntimeFileExpectation final {
  CellRuntimeDispatchBinding binding;
  CellFileSha256 result_sha256{};
  CellFileIdentity work;
  CellDirectoryInventoryEntry file;
  DWORD maximum_bytes = 0;
};
// Derive from independently retained, verified terminal metadata, not a sender
// header. The owner separately admits this selection and its byte ceiling.
DWORD MakeCellRuntimeFileExpectation(const CellRuntimeDispatch&, const CellRuntimeDispatchResult&,
  const CellFileIdentity&, DWORD maximum_bytes, CellRuntimeFileExpectation*) noexcept;

struct CellRuntimeFileSelection final {
  std::wstring relative_path;
  CellRuntimeFileExpectation expected;
};
using CellRuntimeFileAuthorizationBytes = std::array<std::uint8_t, 1060>;
// Control action 3 body: result hash[32], work/file identities[24 each],
// logical/allocated LE64, maximum LE32, path length LE32, UTF-8 path <=512,
// then zero padding. Request binding and fresh ordinal live in the challenge.
DWORD EncodeCellRuntimeFileAuthorization(const CellRuntimeFileSelection&, CellRuntimeFileAuthorizationBytes*) noexcept;
DWORD DecodeCellRuntimeFileAuthorization(const CellRuntimeDispatchBinding&, const CellRuntimeFileAuthorizationBytes&,
  CellRuntimeFileSelection*) noexcept;
// GCFSL001: magic, nonce, request hash, canonical result hash, LE32 count,
// then count 24-byte identities in approved path order (108 + 24 * count).
// The sender must own native staged content. Decode requires independently
// retained request/result metadata; it grants no disclosure or origin proof.
// The transport must preserve authenticated native custody and authorize each
// decoded selection before invoking CellRuntimeFileTransfer.
DWORD EncodeCellRuntimeFileSelections(const CellRuntimeDispatch&, const CellRuntimeDispatchResult&,
  std::vector<std::uint8_t>*) noexcept;
DWORD DecodeCellRuntimeFileSelections(const CellRuntimeDispatch&, const CellRuntimeDispatchResult&,
  std::span<const std::uint8_t>, std::vector<CellRuntimeFileSelection>*) noexcept;

// One serialized exchange on an already authenticated, exclusive local pipe.
// The owner retains pipe/peer custody and checks current permission to deliver
// this exact file/result in authority. No listener, retry, durable receipt or
// publication is created. ACK means complete integrity-checked receipt only.
class CellRuntimeFileTransfer final {
 public:
  CellRuntimeFileTransfer(HANDLE pipe, ULONGLONG deadline, const CellRuntimeFileExpectation& expected,
    const CellFootprintScanGuard& authority) noexcept
    : pipe_(pipe), deadline_(deadline), expected_(expected), authority_(authority) {}
  CellRuntimeFileTransfer(const CellRuntimeFileTransfer&) = delete;
  CellRuntimeFileTransfer& operator=(const CellRuntimeFileTransfer&) = delete;
  DWORD Write(std::span<const std::uint8_t> native_record) noexcept;
  DWORD Read(std::vector<std::uint8_t>* native_record) noexcept;
  bool ValidatedReceipt() const noexcept { return validated_; }
 private:
  DWORD Begin() noexcept;
  DWORD Check() noexcept;
  DWORD Fail(DWORD) noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeFileExpectation expected_;
  CellFootprintScanGuard authority_;
  bool attempted_ = false, validated_ = false;
  DWORD failure_ = ERROR_SUCCESS;
};

struct CellRuntimeFileDeliveryOwner final {
  void* context = nullptr;
  // Current permission for this exact path, identity, result and byte ceiling.
  // Must not use the data pipe. Collection approval alone is insufficient.
  DWORD (*authorize)(void*, const CellRuntimeFileSelection&, ULONGLONG deadline) noexcept = nullptr;
};
// One serialized batch on an authenticated exclusive pipe after terminal-result
// retention. GCFSA001 and GCFSD001 echo SHA256(selection record), acknowledging
// selection and complete integrity-checked receipt, never artifact publication.
// Partial content is wiped on failure. Close the connection; never retry it.
class CellRuntimeFileBatchTransfer final {
 public:
  CellRuntimeFileBatchTransfer(HANDLE pipe, ULONGLONG deadline, const CellRuntimeDispatch& request,
    const CellFootprintScanGuard& authority, const CellRuntimeFileDeliveryOwner& owner)
    : pipe_(pipe), deadline_(deadline), request_(request), authority_(authority), owner_(owner) {}
  CellRuntimeFileBatchTransfer(const CellRuntimeFileBatchTransfer&) = delete;
  CellRuntimeFileBatchTransfer& operator=(const CellRuntimeFileBatchTransfer&) = delete;
  DWORD Write(const CellRuntimeDispatchResult&) noexcept;
  DWORD Read(const CellRuntimeDispatchResult&, std::vector<CellRuntimeStagedFile>*) noexcept;
  bool ValidatedReceipt() const noexcept { return validated_; }
 private:
  struct SelectionGuard;
  DWORD Check() noexcept;
  DWORD Fail(DWORD) noexcept;
  HANDLE pipe_;
  ULONGLONG deadline_;
  CellRuntimeDispatch request_;
  CellFootprintScanGuard authority_;
  CellRuntimeFileDeliveryOwner owner_;
  bool attempted_ = false, validated_ = false;
  DWORD failure_ = ERROR_SUCCESS;
};
}
