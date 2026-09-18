#pragma once
#include "cell_install_capacity_challenge.hpp"
#include "cell_install_capacity.hpp"
#include "cell_controller_attestation.hpp"

namespace goatcitadel::worker_cell {
struct CellInstallCapacityPipeAuthority final {
  void* context = nullptr;
  // Current canonical reservation for this exact capture/request, not a stored
  // receipt or a volume/provisioning check. Must not wait for human approval.
  DWORD (*authorize)(void*, const CellInstallCapacityBinding&, std::uint32_t ordinal) noexcept = nullptr;
};
// Serialized borrowed authenticated pipe. The caller owns endpoint custody,
// writer exclusion and the absolute deadline. This channel never reconnects,
// retries an uncertain exchange or adopts a peer's counter/binding. A failure
// permanently poisons it. The client must validate the complete capture and
// establish canonical reservation ownership before constructing this channel.
class CellInstallCapacityPipe final {
 public:
  CellInstallCapacityPipe(HANDLE pipe, HANDLE stop, ULONGLONG deadline,
    const CellInstallCapacityBinding& binding, const CellFootprintScanGuard& local,
    CellControllerAttestationSigner* signer = nullptr) noexcept
    : pipe_(pipe), stop_(stop), deadline_(deadline), binding_(binding), local_(local), signer_(signer) {}
  CellInstallCapacityPipe(const CellInstallCapacityPipe&) = delete;
  CellInstallCapacityPipe& operator=(const CellInstallCapacityPipe&) = delete;
  DWORD Request() noexcept;
  DWORD Reply(const CellInstallCapacityPipeAuthority&) noexcept;
  // Shared controller dispatch has already consumed this exact frame. Freeze
  // and revalidate it here; it does not select a binding or advance an ordinal.
  DWORD ReplyReceived(const CellInstallCapacityPipeAuthority&, const CellInstallCapacityChallenge&) noexcept;
 private:
  DWORD Exchange(unsigned role, const CellInstallCapacityPipeAuthority&, const CellInstallCapacityChallenge* = nullptr) noexcept;
  DWORD Check() noexcept;
  const HANDLE pipe_, stop_;
  const ULONGLONG deadline_;
  const CellInstallCapacityBinding binding_;
  const CellFootprintScanGuard local_;
  CellControllerAttestationSigner* const signer_;
  std::uint32_t ordinal_ = 0;
  unsigned role_ = 0;
  bool active_ = false, failed_ = false;
};

// One capture-to-reservation handoff per authenticated connection. The peer
// must independently validate the complete capture and own the canonical
// reservation before replying to the first challenge. Local guards must not
// exchange protocol messages while the capture stream is being written.
// Retain this owner and its borrowed handles through reservation destruction;
// the peer's enclosing operation owns canonical reservation release.
class CellInstallCapacityPipeAdmission final {
 public:
  CellInstallCapacityPipeAdmission(HANDLE pipe, HANDLE stop, const CellControllerNonce& connection,
    const std::wstring& owner_sid, const std::wstring& controller_sid, const CellFootprintScanGuard& local,
    ControllerAttestationKey* key = nullptr)
    : pipe_(pipe), stop_(stop), connection_(connection), owner_sid_(owner_sid), controller_sid_(controller_sid), local_(local), key_(key) {}
  CellInstallCapacityPipeAdmission(const CellInstallCapacityPipeAdmission&) = delete;
  CellInstallCapacityPipeAdmission& operator=(const CellInstallCapacityPipeAdmission&) = delete;
  CellInstallCapacityAdmission Admission() noexcept { return {this, Reserve}; }
  DWORD Finish() noexcept;
 private:
  friend struct CellInstallCapacityPipeAdmissionTestPeer;
  static DWORD Current(void*) noexcept;
  static DWORD Reserve(void*, const CellControllerRequest&, const CellCapacityLayoutRecord&,
    const CellPoolJoinedCapacity&, ULONGLONG, std::unique_ptr<CellInstallCapacityReservation>*) noexcept;
  const HANDLE pipe_, stop_;
  const CellControllerNonce connection_;
  const std::wstring owner_sid_, controller_sid_;
  const CellFootprintScanGuard local_;
  ControllerAttestationKey* const key_;
  std::shared_ptr<CellControllerAttestationSigner> signer_;
  ULONGLONG deadline_ = 0;
  bool consumed_ = false, rejected_ = false;
};

struct CellInstallCapacityClientAdmission final {
  void* context = nullptr;
  // Independently decode and validate the complete pool/layout/history and
  // current reviewed installation before acquiring canonical reservation
  // ownership. The byte span lasts only for this callback. A retained receipt
  // alone is insufficient. Do not wait for human approval here.
  DWORD (*reserve)(void*, std::span<const std::uint8_t>, const CellInstallCapacityBinding&,
    ULONGLONG, std::unique_ptr<CellInstallCapacityReservation>*) noexcept = nullptr;
};
// Receives one complete capture on an already authenticated borrowed pipe.
// Owns reservation release on failure or destruction, and never reconnects.
// The enclosing client session must retain this owner until its verified final
// receipt (or failure) so a successful challenge cannot release authority early.
class CellInstallCapacityPipeClient final {
 public:
  CellInstallCapacityPipeClient(HANDLE pipe, HANDLE stop, ULONGLONG deadline, const CellControllerNonce& connection,
    const CellRuntimeInstallBinding& installation, const CellFootprintScanGuard& local) noexcept
    : pipe_(pipe), stop_(stop), deadline_(deadline), connection_(connection), installation_(installation), local_(local) {}
  CellInstallCapacityPipeClient(const CellInstallCapacityPipeClient&) = delete;
  CellInstallCapacityPipeClient& operator=(const CellInstallCapacityPipeClient&) = delete;
  DWORD Begin(const CellInstallCapacityClientAdmission&) noexcept;
  DWORD BeginReceived(const CellInstallCapacityClientAdmission&, const CellInstallCapacityChallenge&) noexcept;
  DWORD Reply() noexcept;
  DWORD ReplyReceived(const CellInstallCapacityChallenge&) noexcept;
 private:
  DWORD BeginCore(const CellInstallCapacityClientAdmission&, const CellInstallCapacityChallenge*) noexcept;
  DWORD ReplyCore(const CellInstallCapacityChallenge*) noexcept;
  static DWORD Current(void*) noexcept;
  static DWORD Verify(void*, const CellInstallCapacityBinding&, std::uint32_t) noexcept;
  DWORD Finish(DWORD) noexcept;
  const HANDLE pipe_, stop_;
  const ULONGLONG deadline_;
  const CellControllerNonce connection_;
  const CellRuntimeInstallBinding installation_;
  const CellFootprintScanGuard local_;
  bool consumed_ = false, active_ = false, failed_ = false;
  std::unique_ptr<CellInstallCapacityReservation> reservation_;
  std::unique_ptr<CellInstallCapacityPipe> channel_;
};
}
