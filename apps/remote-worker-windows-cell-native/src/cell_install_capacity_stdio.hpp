#pragma once
#include "cell_install_capacity_pipe.hpp"
#include <algorithm>

namespace goatcitadel::worker_cell {
// Helper-parent transport only. The parent owns canonical reservation lifetime;
// these echoes are never persisted or reused as assignment authority. Blocking
// stdio is covered by the helper's existing absolute process watchdog.
struct CellInstallCapacityStdioTransport final {
  void* context = nullptr;
  DWORD (*frame)(void*, std::uint8_t, std::span<const std::uint8_t>) noexcept = nullptr;
  DWORD (*read)(void*, std::span<std::uint8_t>) noexcept = nullptr;
  DWORD (*attest)(void*, std::span<const std::uint8_t>, std::span<std::uint8_t>) noexcept = nullptr;
};
class CellInstallCapacityStdio final {
 public:
  CellInstallCapacityStdio(const CellControllerNonce& connection, const CellRuntimeInstallBinding& installation,
    ULONGLONG deadline, const CellFootprintScanGuard& local, const CellInstallCapacityStdioTransport& transport) noexcept
    : connection_(connection), installation_(installation), deadline_(deadline), local_(local), transport_(transport) {}
  CellInstallCapacityStdio(const CellInstallCapacityStdio&) = delete;
  CellInstallCapacityStdio& operator=(const CellInstallCapacityStdio&) = delete;
  CellInstallCapacityClientAdmission Admission() noexcept { return {this, Reserve}; }
 private:
  class Reservation final : public CellInstallCapacityReservation {
   public:
    explicit Reservation(CellInstallCapacityStdio& owner) : owner_(owner) {}
    DWORD Verify() noexcept override { return owner_.Verify(); }
   private:
    CellInstallCapacityStdio& owner_;
  };
  DWORD Current() noexcept {
    if (failed_) return ERROR_INVALID_STATE;
    if (!local_.authorize || !transport_.frame || !transport_.read) return ERROR_INVALID_PARAMETER;
    if (local_.cancellation && WaitForSingleObject(local_.cancellation, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
    if (GetTickCount64() >= deadline_) return ERROR_TIMEOUT;
    const auto error = local_.authorize(local_.context);
    if (error) return error;
    if (failed_) return ERROR_INVALID_STATE;
    if (local_.cancellation && WaitForSingleObject(local_.cancellation, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
    return GetTickCount64() >= deadline_ ? ERROR_TIMEOUT : ERROR_SUCCESS;
  }
  DWORD Finish(DWORD error) noexcept { active_ = false; if (error) failed_ = true; return error; }
  static DWORD Reserve(void* raw, std::span<const std::uint8_t> bytes, const CellInstallCapacityBinding& supplied,
    ULONGLONG deadline, std::unique_ptr<CellInstallCapacityReservation>* output) noexcept {
    if (!raw) return ERROR_INVALID_PARAMETER;
    auto& self = *static_cast<CellInstallCapacityStdio*>(raw);
    if (self.consumed_ || self.active_ || self.failed_) { self.failed_ = true; return ERROR_INVALID_STATE; }
    self.consumed_ = self.active_ = true;
    if (!output || *output) return self.Finish(ERROR_INVALID_PARAMETER);
    try {
      const auto binding = supplied;
      if (binding.connection != self.connection_ || binding.installation.nonce != self.installation_.nonce ||
          binding.installation.request_sha256 != self.installation_.request_sha256 || deadline != self.deadline_ ||
          binding.byte_length != bytes.size() || bytes.size() < 1312 || bytes.size() > kCellPoolCapacityResponseMaximumBytes)
        return self.Finish(ERROR_INVALID_DATA);
      CellFileSha256 hash{}; auto error = HashCellInstallCapacityCapture(bytes, &hash);
      CellInstallCapacityChallenge header{};
      if (!error && (hash != binding.capture_sha256 || !EncodeCellInstallCapacityChallenge(binding, 1, &header))) error = ERROR_INVALID_DATA;
      if (error) return self.Finish(error);
      // Snapshot caller bytes before local callbacks or parent I/O.
      const std::vector<std::uint8_t> captured(bytes.begin(), bytes.end());
      if (!error) error = self.Current();
      if (!error) error = self.transport_.frame(self.transport_.context, 16, header);
      if (!error) error = self.Current();
      if (!error) error = self.transport_.frame(self.transport_.context, 17, captured);
      if (!error) error = self.Current();
      if (!error) {
        self.binding_ = binding;
        *output = std::make_unique<Reservation>(self);
      }
      return self.Finish(error);
    } catch (...) { return self.Finish(ERROR_NOT_ENOUGH_MEMORY); }
  }
  DWORD Verify() noexcept {
    if (active_ || failed_ || !consumed_ || ordinal_ >= kCellInstallCapacityMaximumChecks) {
      failed_ = true; return ERROR_INVALID_STATE;
    }
    active_ = true;
    CellInstallCapacityChallenge challenge{};
    auto error = Current();
    if (!error && !EncodeCellInstallCapacityChallenge(binding_, ++ordinal_, &challenge)) error = ERROR_INVALID_DATA;
    if (!error) error = transport_.frame(transport_.context, 18, challenge);
    if (!error) error = Current();
    bool acknowledged = false;
    while (!error && !acknowledged) {
      std::array<std::uint8_t, 5> header{};
      error = transport_.read(transport_.context, header);
      if (!error) error = Current();
      if (!error && header[0] == 19 && header[1] == 144 && !header[2] && !header[3] && !header[4]) {
        CellInstallCapacityChallenge reply{};
        error = transport_.read(transport_.context, reply);
        if (!error && reply != challenge) error = ERROR_INVALID_DATA;
        acknowledged = !error;
      } else if (!error && header[0] == 20 && header[1] == 36 && !header[2] && !header[3] && !header[4] &&
          transport_.attest && attestation_checks_ < 65536) {
        ++attestation_checks_;
        std::array<std::uint8_t, 36> request{}; std::array<std::uint8_t, 460> proof{};
        error = transport_.read(transport_.context, request);
        if (!error) error = Current();
        if (!error) error = transport_.attest(transport_.context, request, proof);
        if (!error) error = Current();
        if (!error) error = transport_.frame(transport_.context, 21, proof);
      } else if (!error) error = ERROR_INVALID_DATA;
      if (!error) error = Current();
    }
    return Finish(error);
  }
  const CellControllerNonce connection_;
  const CellRuntimeInstallBinding installation_;
  const ULONGLONG deadline_;
  const CellFootprintScanGuard local_;
  const CellInstallCapacityStdioTransport transport_;
  CellInstallCapacityBinding binding_{};
  std::uint32_t ordinal_ = 0;
  std::uint32_t attestation_checks_ = 0;
  bool consumed_ = false, active_ = false, failed_ = false;
};
}
