#include "cell_install_capacity_pipe.hpp"
#include <algorithm>
#include <cstring>

namespace goatcitadel::worker_cell {
DWORD CellInstallCapacityPipe::Check() noexcept {
  if (failed_) return ERROR_INVALID_STATE;
  const auto control = [&]() noexcept -> DWORD {
    if (!pipe_ || pipe_ == INVALID_HANDLE_VALUE || !stop_ || !local_.authorize ||
        (local_.cancellation && local_.cancellation != stop_)) return ERROR_INVALID_PARAMETER;
    const auto status = WaitForSingleObject(stop_, 0);
    if (status != WAIT_TIMEOUT) return status == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    return deadline_ <= now || deadline_ - now > 60000 ? ERROR_TIMEOUT : ERROR_SUCCESS;
  };
  auto error = control();
  if (!error) error = local_.authorize(local_.context);
  if (!error && failed_) error = ERROR_INVALID_STATE;
  return error ? error : control();
}
DWORD CellInstallCapacityPipe::Request() noexcept { return Exchange(1, {}); }
DWORD CellInstallCapacityPipe::Reply(const CellInstallCapacityPipeAuthority& authority) noexcept { return Exchange(2, authority); }
DWORD CellInstallCapacityPipe::ReplyReceived(const CellInstallCapacityPipeAuthority& authority, const CellInstallCapacityChallenge& received) noexcept {
  return Exchange(2, authority, &received);
}
DWORD CellInstallCapacityPipe::Exchange(unsigned role, const CellInstallCapacityPipeAuthority& supplied, const CellInstallCapacityChallenge* routed) noexcept {
  if (failed_ || active_ || (role_ && role_ != role) || ordinal_ >= kCellInstallCapacityMaximumChecks) {
    failed_ = true; return ERROR_INVALID_STATE;
  }
  active_ = true; role_ = role;
  const auto authority = supplied;
  CellInstallCapacityChallenge expected{}, received = routed ? *routed : CellInstallCapacityChallenge{};
  DWORD error = !EncodeCellInstallCapacityChallenge(binding_, ++ordinal_, &expected) || (role == 2 && !authority.authorize)
    ? ERROR_INVALID_PARAMETER : Check();
  if (role == 1) {
    if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::install_capacity_authority,
      expected.data(), static_cast<DWORD>(expected.size()), stop_, deadline_);
    if (!error) error = Check();
    // The Gateway can ask for fresh native proof while its reservation check
    // is pending. Only the retained signer can answer; no peer-selected state
    // enters this exchange. The original capacity acknowledgement is still
    // required after all challenges, under the same absolute deadline.
    bool acknowledged = false;
    while (!error && !acknowledged) {
      std::array<std::uint8_t, 16> header{};
      error = ReadCellPipe(pipe_, header.data(), 16, stop_, deadline_);
      const auto u32 = [](const std::uint8_t* bytes) {
        std::uint32_t value = 0;
        for (unsigned i = 0; i < 4; ++i) value |= std::uint32_t(bytes[i]) << (8 * i);
        return value;
      };
      const auto kind = static_cast<CellControllerMessage>(u32(header.data() + 8));
      const auto size = u32(header.data() + 12);
      if (!error && std::memcmp(header.data(), "GCCELL01", 8)) error = ERROR_INVALID_DATA;
      if (!error) error = Check();
      if (!error && kind == CellControllerMessage::install_capacity_authorized && size == received.size()) {
        error = ReadCellPipe(pipe_, received.data(), static_cast<DWORD>(received.size()), stop_, deadline_);
        acknowledged = !error;
      } else if (!error && kind == CellControllerMessage::controller_attestation_challenge && size == 36 && signer_) {
        std::array<std::uint8_t, 36> request{};
        error = ReadCellPipe(pipe_, request.data(), 36, stop_, deadline_);
        if (!error) error = Check();
        ControllerDigest nonce{}; std::copy_n(request.begin(), 32, nonce.begin());
        ControllerStatement statement{}; ControllerSignature signature{};
        if (!error) error = signer_->Sign(nonce, u32(request.data() + 32), &statement, &signature);
        if (!error) error = Check();
        std::array<std::uint8_t, 460> proof{};
        std::copy(statement.begin(), statement.end(), proof.begin());
        std::copy(signature.begin(), signature.end(), proof.begin() + statement.size());
        if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::controller_attestation_proof,
          proof.data(), static_cast<DWORD>(proof.size()), stop_, deadline_);
      } else if (!error) error = ERROR_INVALID_DATA;
      if (!error) error = Check();
    }
    if (!error && received != expected) error = ERROR_INVALID_DATA;
  } else {
    if (!error && !routed) error = ReadCellControllerMessage(pipe_, CellControllerMessage::install_capacity_authority,
      received.data(), static_cast<DWORD>(received.size()), stop_, deadline_);
    if (!error && received != expected) error = ERROR_INVALID_DATA;
    if (!error) error = Check();
    if (!error) error = authority.authorize(authority.context, binding_, ordinal_);
    if (!error) error = Check();
    if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::install_capacity_authorized,
      expected.data(), static_cast<DWORD>(expected.size()), stop_, deadline_);
  }
  if (!error) error = Check();
  active_ = false;
  if (error) failed_ = true;
  return error;
}
DWORD CellInstallCapacityPipeAdmission::Current(void* raw) noexcept {
  auto& self = *static_cast<CellInstallCapacityPipeAdmission*>(raw);
  if (self.rejected_) return ERROR_INVALID_STATE;
  if (!self.pipe_ || self.pipe_ == INVALID_HANDLE_VALUE || !self.stop_ || !self.local_.authorize ||
      (self.local_.cancellation && self.local_.cancellation != self.stop_)) return ERROR_INVALID_PARAMETER;
  if (WaitForSingleObject(self.stop_, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
  auto error = self.local_.authorize(self.local_.context);
  if (!error && self.key_) error = self.key_->Verify();
  if (!error && self.rejected_) error = ERROR_INVALID_STATE;
  if (!error && WaitForSingleObject(self.stop_, 0) != WAIT_TIMEOUT) error = ERROR_OPERATION_ABORTED;
  return error;
}
DWORD CellInstallCapacityPipeAdmission::Reserve(void* raw, const CellControllerRequest& supplied,
    const CellCapacityLayoutRecord& layout, const CellPoolJoinedCapacity& captured, ULONGLONG deadline,
    std::unique_ptr<CellInstallCapacityReservation>* output) noexcept {
  if (!raw) return ERROR_INVALID_PARAMETER;
  auto& self = *static_cast<CellInstallCapacityPipeAdmission*>(raw);
  if (self.consumed_) { self.rejected_ = true; return ERROR_INVALID_STATE; }
  self.consumed_ = true;
  // Never replace an existing owner or reset its live reservation.
  if (!output || *output) { self.rejected_ = true; return ERROR_INVALID_PARAMETER; }
  DWORD error = ERROR_SUCCESS;
  try {
    const auto request = supplied;
    auto installation = request; installation.operation = kCellControllerInstallOperation;
    const auto now = GetTickCount64();
    if (!IsCellControllerPoolCapacity(request.operation) || request.nonce != self.connection_ ||
        !ValidateCellControllerInstallRequest(installation) || deadline <= now || deadline - now > 60000)
      error = ERROR_INVALID_PARAMETER;
    // Encode/freeze complete evidence before invoking any external callback.
    std::vector<std::uint8_t> bytes;
    auto capture_request = request;
    capture_request.operation = kCellControllerPoolCapacityOperation;
    capture_request.installation = {}; capture_request.installation_bytes = {};
    if (!error) error = EncodeCellPoolCapacityResponse(capture_request, self.owner_sid_, self.controller_sid_, layout,
      request.capture_nonce, captured, &bytes);
    CellInstallCapacityBinding binding{self.connection_, {request.installation.nonce, request.installation.request_sha256}, {},
      static_cast<std::uint32_t>(bytes.size())};
    if (!error) error = HashCellInstallCapacityCapture(bytes, &binding.capture_sha256);
    CellInstallCapacityChallenge ready;
    if (!error && !EncodeCellInstallCapacityChallenge(binding, 1, &ready)) error = ERROR_INVALID_DATA;
    if (!error) error = Current(&self);
    const CellFootprintScanGuard local{Current, &self, self.stop_};
    std::shared_ptr<CellControllerAttestationSigner> signer;
    if (!error && self.key_) {
      ControllerAttestationState state;
      state.key_sha256 = self.key_->Fingerprint(); state.instance = self.key_->Instance();
      state.authority = request.plan.assignment_binding;
      state.installation_nonce = request.installation.nonce; state.request_sha256 = request.installation.request_sha256;
      error = DeriveControllerAttestationWindow(bytes, request.references_sha256, &state.window);
      if (!error && (state.window[0] != request.capture_nonce || state.window[1] != self.connection_)) error = ERROR_INVALID_DATA;
      if (!error) signer = std::make_shared<CellControllerAttestationSigner>(self.key_->Handle(), state,
        ControllerAttestationGuard{&self, Current, self.stop_, deadline});
    }
    if (!error) error = WriteCellControllerMessage(self.pipe_, CellControllerMessage::install_capacity_capture,
      ready.data(), static_cast<DWORD>(ready.size()), self.stop_, deadline);
    if (!error) error = WriteCellPoolCapacityResponse(self.pipe_, deadline, self.connection_, local, bytes);
    struct Reservation final : CellInstallCapacityReservation {
      std::shared_ptr<CellControllerAttestationSigner> signer;
      CellInstallCapacityPipe channel;
      Reservation(HANDLE pipe, HANDLE stop, ULONGLONG deadline, const CellInstallCapacityBinding& binding,
          const CellFootprintScanGuard& local, std::shared_ptr<CellControllerAttestationSigner> proof)
          : signer(std::move(proof)), channel(pipe, stop, deadline, binding, local, signer.get()) {}
      DWORD Verify() noexcept override { return channel.Request(); }
    };
    if (!error) {
      self.deadline_ = deadline;
      self.signer_ = signer;
      auto reservation = std::make_unique<Reservation>(self.pipe_, self.stop_, deadline, binding, local, std::move(signer));
      error = reservation->Verify();
      if (!error) *output = std::move(reservation);
    }
  } catch (...) { error = ERROR_NOT_ENOUGH_MEMORY; }
  if (error) self.rejected_ = true;
  return error;
}
DWORD CellInstallCapacityPipeAdmission::Finish() noexcept {
  if (!consumed_ || rejected_ || !signer_ || !deadline_) return ERROR_INVALID_STATE;
  DWORD error = Current(this);
  bool finished = false;
  while (!error && !finished) {
    std::array<std::uint8_t, 16> header{};
    error = ReadCellPipe(pipe_, header.data(), 16, stop_, deadline_);
    const auto u32 = [](const std::uint8_t* bytes) { std::uint32_t value = 0;
      for (unsigned i = 0; i < 4; ++i) value |= std::uint32_t(bytes[i]) << (8 * i); return value; };
    if (!error && std::memcmp(header.data(), "GCCELL01", 8)) error = ERROR_INVALID_DATA;
    if (!error) error = Current(this);
    const auto kind = static_cast<CellControllerMessage>(u32(header.data() + 8));
    const auto size = u32(header.data() + 12);
    if (!error && kind == CellControllerMessage::finish && size == 32) {
      CellControllerNonce nonce{};
      error = ReadCellPipe(pipe_, nonce.data(), 32, stop_, deadline_);
      if (!error && nonce != connection_) error = ERROR_INVALID_DATA;
      finished = !error;
    } else if (!error && kind == CellControllerMessage::controller_attestation_challenge && size == 36) {
      std::array<std::uint8_t, 36> request{};
      error = ReadCellPipe(pipe_, request.data(), 36, stop_, deadline_);
      ControllerDigest nonce{}; std::copy_n(request.begin(), 32, nonce.begin());
      ControllerStatement statement{}; ControllerSignature signature{};
      if (!error) error = signer_->Sign(nonce, u32(request.data() + 32), &statement, &signature);
      if (!error) error = Current(this);
      std::array<std::uint8_t, 460> proof{};
      std::copy(statement.begin(), statement.end(), proof.begin());
      std::copy(signature.begin(), signature.end(), proof.begin() + statement.size());
      if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::controller_attestation_proof,
        proof.data(), 460, stop_, deadline_);
    } else if (!error) error = ERROR_INVALID_DATA;
    if (!error) error = Current(this);
  }
  rejected_ = true; signer_.reset();
  return error;
}
DWORD CellInstallCapacityPipeClient::Current(void* raw) noexcept {
  auto& self = *static_cast<CellInstallCapacityPipeClient*>(raw);
  const auto control = [&]() noexcept -> DWORD {
    if (self.failed_) return ERROR_INVALID_STATE;
    if (!self.pipe_ || self.pipe_ == INVALID_HANDLE_VALUE || !self.stop_ || !self.local_.authorize ||
        (self.local_.cancellation && self.local_.cancellation != self.stop_)) return ERROR_INVALID_PARAMETER;
    if (WaitForSingleObject(self.stop_, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
    const auto now = GetTickCount64();
    return self.deadline_ <= now || self.deadline_ - now > 60000 ? ERROR_TIMEOUT : ERROR_SUCCESS;
  };
  auto error = control();
  if (!error) error = self.local_.authorize(self.local_.context);
  return error ? error : control();
}
DWORD CellInstallCapacityPipeClient::Verify(void* raw, const CellInstallCapacityBinding&, std::uint32_t) noexcept {
  auto& self = *static_cast<CellInstallCapacityPipeClient*>(raw);
  auto error = Current(&self);
  if (!error) error = self.reservation_ ? self.reservation_->Verify() : ERROR_INVALID_STATE;
  return error ? error : Current(&self);
}
DWORD CellInstallCapacityPipeClient::Finish(DWORD error) noexcept {
  active_ = false;
  if (!error && failed_) error = ERROR_INVALID_STATE;
  if (error) { failed_ = true; channel_.reset(); reservation_.reset(); }
  return error;
}
DWORD CellInstallCapacityPipeClient::Begin(const CellInstallCapacityClientAdmission& supplied) noexcept {
  return BeginCore(supplied, nullptr);
}
DWORD CellInstallCapacityPipeClient::BeginReceived(const CellInstallCapacityClientAdmission& supplied, const CellInstallCapacityChallenge& ready) noexcept {
  return BeginCore(supplied, &ready);
}
DWORD CellInstallCapacityPipeClient::BeginCore(const CellInstallCapacityClientAdmission& supplied, const CellInstallCapacityChallenge* routed) noexcept {
  if (consumed_ || active_ || failed_) {
    failed_ = true;
    // A reentrant callback must not destroy the owner currently executing it.
    return active_ ? ERROR_INVALID_STATE : Finish(ERROR_INVALID_STATE);
  }
  consumed_ = active_ = true;
  const auto admission = supplied;
  try {
    CellInstallCapacityBinding binding{connection_, installation_, {}, 1}; binding.capture_sha256.fill(1);
    CellInstallCapacityChallenge expected{}, ready = routed ? *routed : CellInstallCapacityChallenge{};
    auto error = !admission.reserve || !EncodeCellInstallCapacityChallenge(binding, 1, &expected)
      ? ERROR_INVALID_PARAMETER : Current(this);
    if (!error && !routed) error = ReadCellControllerMessage(pipe_, CellControllerMessage::install_capacity_capture,
      ready.data(), static_cast<DWORD>(ready.size()), stop_, deadline_);
    if (!error) error = Current(this);
    // Connection and reviewed request are retained locally, not learned from
    // the incoming header. Capture hash/length are derived from received bytes.
    if (!error && !std::equal(expected.begin(), expected.begin() + 96, ready.begin())) error = ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes;
    const CellFootprintScanGuard local{Current, this, stop_};
    if (!error) error = ReadCellPoolCapacityResponse(pipe_, deadline_, connection_, local, &bytes);
    binding.byte_length = static_cast<std::uint32_t>(bytes.size());
    if (!error) error = HashCellInstallCapacityCapture(bytes, &binding.capture_sha256);
    if (!error && !MatchCellInstallCapacityChallenge(ready, binding, 1)) error = ERROR_INVALID_DATA;
    if (!error) error = Current(this);
    if (!error) error = admission.reserve(admission.context, bytes, binding, deadline_, &reservation_);
    if (!error && !reservation_) error = ERROR_INVALID_STATE;
    if (!error) error = Current(this);
    if (!error) {
      channel_ = std::make_unique<CellInstallCapacityPipe>(pipe_, stop_, deadline_, binding, local);
      error = channel_->Reply({this, Verify});
    }
    return Finish(error);
  } catch (...) { return Finish(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellInstallCapacityPipeClient::Reply() noexcept {
  return ReplyCore(nullptr);
}
DWORD CellInstallCapacityPipeClient::ReplyReceived(const CellInstallCapacityChallenge& received) noexcept {
  return ReplyCore(&received);
}
DWORD CellInstallCapacityPipeClient::ReplyCore(const CellInstallCapacityChallenge* routed) noexcept {
  if (active_ || failed_ || !consumed_ || !channel_ || !reservation_) {
    failed_ = true;
    return active_ ? ERROR_INVALID_STATE : Finish(ERROR_INVALID_STATE);
  }
  active_ = true;
  return Finish(routed ? channel_->ReplyReceived({this, Verify}, *routed) : channel_->Reply({this, Verify}));
}
}
