#include "cell_controller_runtime.hpp"
#include "cell_runtime_file_transfer.hpp"
#include <algorithm>
#include <limits>
#include <bcrypt.h>
#pragma comment(lib, "onecore.lib")
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
void Put32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (unsigned index = 0; index < 4; ++index) bytes[index] = static_cast<std::uint8_t>(value >> (index * 8));
}
CellControllerRuntimeChallenge Challenge(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
  std::uint32_t ordinal) noexcept {
  CellControllerRuntimeChallenge bytes{};
  std::copy(binding.nonce.begin(), binding.nonce.end(), bytes.begin());
  Put32(bytes.data() + 32, ordinal); Put32(bytes.data() + 36, 21);
  std::copy(head.begin(), head.end(), bytes.begin() + 40);
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), bytes.begin() + 72);
  return bytes;
}
bool Valid(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head) noexcept {
  const auto nonzero = [](const auto& bytes) { return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; }); };
  return nonzero(binding.nonce) && nonzero(binding.request_sha256) && nonzero(head);
}
DWORD Control(const CellFootprintScanGuard& peer, ULONGLONG deadline) noexcept {
  if (!peer.authorize || !peer.cancellation || peer.cancellation == INVALID_HANDLE_VALUE) return ERROR_INVALID_PARAMETER;
  const auto state = WaitForSingleObject(peer.cancellation, 0);
  if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
  const auto now = GetTickCount64();
  if (now >= deadline) return ERROR_TIMEOUT;
  return deadline - now > 86400000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
}
DWORD PeerGuard(const CellFootprintScanGuard& peer, ULONGLONG deadline) noexcept {
  auto error = Control(peer, deadline);
  if (!error) error = peer.authorize(peer.context);
  return error ? error : Control(peer, deadline);
}
}
DWORD CellControllerRuntimeAuthority::Peer() noexcept {
  if (failure_) return failure_;
  if (finished_) return ERROR_INVALID_STATE;
  const auto error = PeerGuard(peer_, deadline_);
  return failure_ ? failure_ : error;
}
DWORD CellControllerRuntimeAuthority::Check() noexcept {
  if (failure_) return failure_;
  if (busy_) return failure_ = ERROR_BUSY;
  busy_ = true;
  const auto error = [&]() noexcept -> DWORD {
    if (!Valid(expected_, head_) || checks_ == std::numeric_limits<std::uint32_t>::max()) return ERROR_INVALID_STATE;
    auto result = Peer(); if (result) return result;
    const auto challenge = Challenge(expected_, head_, ++checks_);
    const auto io_deadline = std::min(deadline_, GetTickCount64() + 5000);
    result = WriteCellControllerMessage(pipe_, CellControllerMessage::runtime_authority, challenge.data(),
      static_cast<DWORD>(challenge.size()), peer_.cancellation, io_deadline);
    CellControllerRuntimeChallenge reply{};
    if (!result && !input_.receive) result = ReadCellControllerMessage(pipe_, CellControllerMessage::runtime_authorized, reply.data(),
      static_cast<DWORD>(reply.size()), peer_.cancellation, io_deadline);
    else while (!result) {
      result = Peer();
      if (!result && GetTickCount64() >= io_deadline) result = ERROR_TIMEOUT;
      if (!result && input_.progress) result = input_.progress(input_.context, io_deadline);
      DWORD available = 0;
      if (!result && !PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) result = GetLastError();
      if (result) break;
      if (!available) { Sleep(1); continue; }
      CellControllerMessage kind{}; CellRuntimeStreamBytes bytes{};
      result = ReadCellControllerRuntimeEvent(pipe_, true, &kind, &bytes, peer_.cancellation, io_deadline);
      if (!result) result = Peer();
      if (result) break;
      if (kind == CellControllerMessage::runtime_authorized) {
        std::copy_n(bytes.begin(), reply.size(), reply.begin()); break;
      }
      result = input_.receive(input_.context, kind, bytes, io_deadline);
    }
    if (!result && reply != challenge) result = ERROR_INVALID_DATA;
    if (!result) result = Peer();
    if (!result && GetTickCount64() >= io_deadline) result = ERROR_TIMEOUT;
    return result;
  }();
  busy_ = false;
  if (error) failure_ = error;
  return error;
}
CellFootprintScanGuard CellControllerRuntimeAuthority::Guard() noexcept {
  return {[](void* raw) noexcept { return static_cast<CellControllerRuntimeAuthority*>(raw)->Check(); }, this, peer_.cancellation};
}
CellRuntimeDispatchResult CellControllerRuntimeAuthority::Run(CellProvisioningJournal& journal, JobStdioChannel* stdio) noexcept {
  CellRuntimeDispatchResult result;
  if (run_attempted_ || busy_ || finished_ || failure_) {
    result.execution.runtime.job.error = failure_ ? failure_ : ERROR_INVALID_STATE; return result;
  }
  run_attempted_ = true;
  CellRuntimeTransfer transfer(pipe_, std::min(deadline_, GetTickCount64() + 600000), expected_, peer_);
  std::vector<std::uint8_t> bytes;
  auto error = transfer.Read(&bytes);
  CellRuntimeDispatch decoded;
  if (!error) error = DecodeCellRuntimeDispatch(bytes, expected_, &decoded);
  if (!error && decoded.reference.checkpoint_sha256 != head_) error = ERROR_INVALID_DATA;
  if (!error) error = Check();
  if (!error) result = RunCellRuntimeDispatch(journal, bytes, expected_, Guard(), stdio);
  else result.execution.runtime.job.error = error;
  finished_ = true;
  if (error) failure_ = error;
  return result;
}
DWORD CellRuntimeParentAuthority::Fail(DWORD error) noexcept {
  if (error) { DWORD expected = ERROR_SUCCESS; failure_.compare_exchange_strong(expected, error); }
  return failure_.load();
}
DWORD CellRuntimeParentAuthority::Peer(ULONGLONG deadline) noexcept {
  if (failure_.load()) return failure_.load();
  const auto error = PeerGuard(peer_, deadline);
  return error ? Fail(error) : failure_.load();
}
CellControllerRuntimeClientOwner CellRuntimeParentAuthority::RuntimeOwner() noexcept {
  return {peer_, this, [](void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
    std::uint32_t ordinal) noexcept { return static_cast<CellRuntimeParentAuthority*>(raw)->CheckRuntime(binding, head, ordinal); }};
}
DWORD CellRuntimeParentAuthority::CheckRuntime(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
  std::uint32_t ordinal) noexcept { return Exchange(binding, head, ordinal, false, deadline_); }
DWORD CellRuntimeParentAuthority::CheckDelivery(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
  ULONGLONG deadline) noexcept { return Exchange(binding, head, 0, true, std::min(deadline_, deadline)); }
DWORD CellRuntimeParentAuthority::Exchange(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
  std::uint32_t ordinal, bool delivery, ULONGLONG deadline) noexcept {
  if (failure_.load()) return failure_.load();
  if (busy_.exchange(true)) return Fail(ERROR_BUSY);
  const auto error = [&]() noexcept -> DWORD {
    if (!Valid(binding_, head_) || binding.nonce != binding_.nonce || binding.request_sha256 != binding_.request_sha256 || head != head_)
      return ERROR_INVALID_DATA;
    auto& count = delivery ? delivery_checks_ : runtime_checks_;
    if (count == std::numeric_limits<std::uint32_t>::max() || (!delivery && ordinal != count + 1)) return ERROR_INVALID_DATA;
    if (!controller_ || controller_ == INVALID_HANDLE_VALUE || !parent_ || parent_ == INVALID_HANDLE_VALUE || controller_ == parent_ ||
      GetFileType(controller_) != FILE_TYPE_PIPE || GetFileType(parent_) != FILE_TYPE_PIPE || CompareObjectHandles(controller_, parent_))
      return ERROR_INVALID_HANDLE;
    auto result = Peer(deadline); if (result) return result;
    const auto challenge = Challenge(binding_, head_, ++count);
    const auto io_deadline = std::min(deadline, GetTickCount64() + 5000);
    result = WriteCellControllerMessage(parent_, delivery ? CellControllerMessage::runtime_delivery_authority : CellControllerMessage::runtime_authority,
      challenge.data(), static_cast<DWORD>(challenge.size()), peer_.cancellation, io_deadline);
    if (!result) result = Peer(io_deadline);
    CellControllerRuntimeChallenge reply{};
    if (!result) result = ReadCellControllerMessage(parent_, delivery ? CellControllerMessage::runtime_delivery_authorized : CellControllerMessage::runtime_authorized,
      reply.data(), static_cast<DWORD>(reply.size()), peer_.cancellation, io_deadline);
    if (!result && reply != challenge) result = ERROR_INVALID_DATA;
    if (!result) result = Peer(io_deadline);
    return result;
  }();
  const auto result = Fail(error);
  busy_.store(false);
  return result;
}
DWORD CellControllerRuntimeClient::Peer() noexcept {
  if (failure_) return failure_;
  const auto error = PeerGuard(owner_.peer, deadline_);
  return failure_ ? failure_ : error;
}
DWORD CellControllerRuntimeClient::Respond(const CellControllerRuntimeChallenge& supplied) noexcept {
  if (failure_) return failure_;
  if (busy_) return failure_ = ERROR_BUSY;
  const auto challenge = supplied;
  busy_ = true;
  const auto error = [&]() noexcept -> DWORD {
    if (!owner_.admit || !Valid(expected_, head_) || checks_ == std::numeric_limits<std::uint32_t>::max()) return ERROR_INVALID_STATE;
    if (challenge != Challenge(expected_, head_, checks_ + 1)) return ERROR_INVALID_DATA;
    auto result = Peer(); if (result) return result;
    const auto io_deadline = std::min(deadline_, GetTickCount64() + 5000);
    ++checks_;
    result = owner_.admit(owner_.context, expected_, head_, checks_);
    if (!result) result = Peer();
    if (!result && GetTickCount64() >= io_deadline) result = ERROR_TIMEOUT;
    if (!result) result = WriteCellControllerMessage(pipe_, CellControllerMessage::runtime_authorized,
      challenge.data(), static_cast<DWORD>(challenge.size()), owner_.peer.cancellation, io_deadline);
    if (!result) result = Peer();
    if (!result && GetTickCount64() >= io_deadline) result = ERROR_TIMEOUT;
    return result;
  }();
  busy_ = false;
  if (error) failure_ = error;
  return error;
}
DWORD CellControllerRuntimeChannel::Fail(DWORD error) noexcept {
  if (!error) return ERROR_SUCCESS;
  DWORD expected = ERROR_SUCCESS;
  failure_.compare_exchange_strong(expected, error);
  streams_.Abort(failure_.load()); return failure_.load();
}
DWORD CellControllerRuntimeChannel::Peer() noexcept {
  if (failure_.load()) return failure_.load();
  auto error = PeerGuard(owner_.peer, deadline_);
  if (!error && failure_.load()) error = failure_.load();
  return error;
}
DWORD CellControllerRuntimeChannel::PeerCallback(void* raw) noexcept { return static_cast<CellControllerRuntimeChannel*>(raw)->Peer(); }
DWORD CellControllerRuntimeChannel::PeerUntil(ULONGLONG deadline) noexcept {
  if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
  const auto error = Peer();
  return error ? error : GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
DWORD CellControllerRuntimeChannel::ReceiveCallback(void* raw, CellControllerMessage kind, const CellRuntimeStreamBytes& bytes, ULONGLONG deadline) noexcept {
  auto& self = *static_cast<CellControllerRuntimeChannel*>(raw);
  auto error = self.PeerUntil(deadline);
  if (!error && !self.owner_.input) error = ERROR_ACCESS_DENIED;
  if (!error) error = self.streams_.StageInput(kind, bytes);
  if (!error && !DecodeCellRuntimeStream(self.binding_, kind, bytes, &self.pending_)) error = ERROR_INVALID_DATA;
  if (!error) error = self.FlushInput(deadline);
  return error;
}
DWORD CellControllerRuntimeChannel::FlushInput(ULONGLONG deadline) noexcept {
  if (!streams_.InputPending()) return ERROR_SUCCESS;
  auto error = PeerUntil(deadline);
  if (!error && !owner_.input) error = ERROR_ACCESS_DENIED;
  if (!error) error = owner_.input(owner_.context, binding_, pending_, deadline);
  if (!error) error = PeerUntil(deadline);
  std::array<std::uint8_t, 80> acknowledgment{};
  if (!error) error = streams_.FlushInput(channel_, &acknowledgment);
  if (error == ERROR_RETRY) return ERROR_SUCCESS;
  if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::runtime_input_ack,
    acknowledgment.data(), static_cast<DWORD>(acknowledgment.size()), owner_.peer.cancellation, deadline);
  if (!error) { pending_ = {}; error = PeerUntil(deadline); }
  return error;
}
DWORD CellControllerRuntimeChannel::SendOutput(ULONGLONG deadline) noexcept {
  for (const auto stream : {JobOutputStream::standard_output, JobOutputStream::standard_error}) {
    auto error = PeerUntil(deadline); if (error) return error;
    CellControllerMessage kind{}; CellRuntimeStreamBytes bytes{};
    error = streams_.NextOutput(channel_, stream, &kind, &bytes);
    if (error == ERROR_NO_MORE_ITEMS) continue;
    if (!error) error = PeerUntil(deadline);
    if (!error) error = WriteCellControllerMessage(pipe_, kind, bytes.data(), static_cast<DWORD>(bytes.size()),
      owner_.peer.cancellation, deadline);
    if (!error) error = PeerUntil(deadline);
    if (error) return error;
  }
  return ERROR_SUCCESS;
}
DWORD CellControllerRuntimeChannel::ProgressCallback(void* raw, ULONGLONG deadline) noexcept {
  auto& self = *static_cast<CellControllerRuntimeChannel*>(raw);
  const auto error = self.FlushInput(deadline); return error ? error : self.SendOutput(deadline);
}
CellFootprintScanGuard CellControllerRuntimeChannel::Guard() noexcept {
  return {[](void* raw) noexcept { return static_cast<CellControllerRuntimeChannel*>(raw)->Check(); }, this, owner_.peer.cancellation};
}
DWORD CellControllerRuntimeChannel::Check() noexcept {
  try {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    if (failure_.load()) return failure_.load();
    if (in_io_) return Fail(ERROR_BUSY);
    in_io_ = true;
    const auto error = authority_.Check();
    in_io_ = false; return Fail(error);
  } catch (...) { failure_.store(ERROR_GEN_FAILURE); return ERROR_GEN_FAILURE; }
}
DWORD CellControllerRuntimeChannel::Pump() noexcept {
  try {
    std::unique_lock<std::recursive_mutex> lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return failure_.load() ? failure_.load() : ERROR_RETRY;
    if (failure_.load()) return failure_.load();
    if (in_io_) return Fail(ERROR_BUSY);
    in_io_ = true;
    const auto io_deadline = std::min(deadline_, GetTickCount64() + 5000);
    auto error = PeerUntil(io_deadline);
    if (!error && !streams_.InputPending()) {
      DWORD available = 0;
      if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) error = GetLastError();
      if (!error && available) {
        CellControllerMessage kind{}; CellRuntimeStreamBytes bytes{};
        error = ReadCellControllerRuntimeEvent(pipe_, true, &kind, &bytes, owner_.peer.cancellation, io_deadline);
        if (!error) error = ReceiveCallback(this, kind, bytes, io_deadline);
      }
    }
    if (!error) error = ProgressCallback(this, io_deadline);
    in_io_ = false; return Fail(error);
  } catch (...) { failure_.store(ERROR_GEN_FAILURE); return ERROR_GEN_FAILURE; }
}
bool CellControllerRuntimeChannel::OutputEnded() noexcept {
  try { std::lock_guard<std::recursive_mutex> lock(mutex_); return !failure_.load() && streams_.OutputEnded(); }
  catch (...) { failure_.store(ERROR_GEN_FAILURE); return false; }
}
std::uint32_t CellControllerRuntimeChannel::AuthorityChecks() noexcept {
  try { std::lock_guard<std::recursive_mutex> lock(mutex_); return authority_.Checks(); }
  catch (...) { failure_.store(ERROR_GEN_FAILURE); return 0; }
}
bool CellControllerRuntimeChannel::MatchesCompletedInputOutput(const JobResult& job) noexcept {
  try { std::lock_guard<std::recursive_mutex> lock(mutex_); return !failure_.load() && streams_.MatchesCompletedInputOutput(job); }
  catch (...) { failure_.store(ERROR_GEN_FAILURE); return false; }
}
void CellControllerRuntimeChannel::Abort(DWORD error) noexcept {
  try { std::lock_guard<std::recursive_mutex> lock(mutex_); Fail(error ? error : ERROR_OPERATION_ABORTED); }
  catch (...) { failure_.store(ERROR_GEN_FAILURE); }
}
DWORD CellRuntimeControlChannel::Fail(DWORD error) noexcept {
  if (error) { DWORD clear = ERROR_SUCCESS; failure_.compare_exchange_strong(clear, error); }
  return failure_.load();
}
DWORD CellRuntimeControlChannel::Peer(ULONGLONG deadline) noexcept {
  if (failure_.load()) return failure_.load();
  const auto error = PeerGuard(owner_.peer, deadline);
  return error ? Fail(error) : failure_.load();
}
DWORD CellRuntimeControlChannel::Begin(ULONGLONG deadline) noexcept {
  if (!Valid(binding_, head_) || input_limit_ > kMaximumCellJobInputBytes ||
      checks_ == std::numeric_limits<std::uint32_t>::max() ||
      (role_ != CellRuntimeControlRole::controller && role_ != CellRuntimeControlRole::protected_parent) ||
      (role_ == CellRuntimeControlRole::protected_parent && (!owner_.input || !owner_.deliver))) return ERROR_INVALID_PARAMETER;
  auto error = Control(owner_.peer, deadline_);
  if (error) return error;
  if (!runtime_ || runtime_ == INVALID_HANDLE_VALUE || !control_ || control_ == INVALID_HANDLE_VALUE ||
      runtime_ == control_ || GetFileType(runtime_) != FILE_TYPE_PIPE || GetFileType(control_) != FILE_TYPE_PIPE ||
      CompareObjectHandles(runtime_, control_)) return ERROR_INVALID_HANDLE;
  return Peer(deadline);
}
DWORD CellRuntimeControlChannel::End(DWORD error) noexcept {
  const auto result = Fail(error); busy_.store(false); return result;
}
DWORD CellRuntimeControlChannel::Validate(const Bytes& bytes, CellRuntimeStreamFrame* frame, bool* delivery, CellRuntimeFileSelection* file) noexcept {
  const auto get = [](const std::uint8_t* value) noexcept {
    std::uint32_t result = 0;
    for (unsigned i = 0; i < 4; ++i) result |= static_cast<std::uint32_t>(value[i]) << (8 * i);
    return result;
  };
  if (checks_ == std::numeric_limits<std::uint32_t>::max()) return ERROR_INVALID_STATE;
  const auto challenge = Challenge(binding_, head_, checks_ + 1);
  if (!std::equal(challenge.begin(), challenge.end(), bytes.begin())) return ERROR_INVALID_DATA;
  const auto action = get(bytes.data() + 104);
  *delivery = action == 2 || action == 3;
  if (action == 3) {
    if (!delivering_ || !last_input_.sequence || !last_input_.eof) return ERROR_INVALID_DATA;
    CellRuntimeFileAuthorizationBytes encoded{}; std::copy_n(bytes.begin() + 108, encoded.size(), encoded.begin());
    return DecodeCellRuntimeFileAuthorization(binding_, encoded, file);
  }
  if (*delivery) {
    if (!last_input_.sequence || !last_input_.eof ||
        std::any_of(bytes.begin() + 108, bytes.end(), [](auto b) { return b != 0; })) return ERROR_INVALID_DATA;
    return ERROR_SUCCESS;
  }
  const auto kind = static_cast<CellControllerMessage>(get(bytes.data() + 108));
  if (action != 1 || delivering_ ||
      (kind != CellControllerMessage::runtime_input && kind != CellControllerMessage::runtime_input_end)) return ERROR_INVALID_DATA;
  CellRuntimeStreamBytes wire{}; std::copy_n(bytes.begin() + 112, wire.size(), wire.begin());
  if (!DecodeCellRuntimeStream(binding_, kind, wire, frame)) return ERROR_INVALID_DATA;
  if (frame->total > input_limit_) return ERROR_NOT_ENOUGH_QUOTA;
  // Only an exact repeat of the last staged frame may receive a new grant for
  // another queue attempt. This does not itself queue or replay any bytes.
  if (last_input_.sequence && frame->sequence == last_input_.sequence)
    return wire == last_input_bytes_ && frame->eof == last_input_.eof ? ERROR_SUCCESS : ERROR_INVALID_DATA;
  if (last_input_.eof || last_input_.sequence == std::numeric_limits<std::uint32_t>::max() ||
      frame->sequence != last_input_.sequence + 1 || frame->total != last_input_.total + frame->count) return ERROR_INVALID_DATA;
  return ERROR_SUCCESS;
}
void CellRuntimeControlChannel::Accept(const Bytes& bytes, const CellRuntimeStreamFrame& frame, bool delivery) noexcept {
  ++checks_;
  if (delivery) delivering_ = true;
  else { last_input_ = frame; std::copy_n(bytes.begin() + 112, last_input_bytes_.size(), last_input_bytes_.begin()); }
}
DWORD CellRuntimeControlChannel::Input(const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame,
    ULONGLONG deadline) noexcept { return Exchange(binding, &frame, head_, deadline); }
DWORD CellRuntimeControlChannel::Deliver(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
    ULONGLONG deadline) noexcept { return Exchange(binding, nullptr, head, deadline); }
DWORD CellRuntimeControlChannel::File(const CellRuntimeFileSelection& file, ULONGLONG deadline) noexcept {
  return Exchange(file.expected.binding, nullptr, head_, deadline, &file);
}
DWORD CellRuntimeControlChannel::Exchange(const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame* supplied,
    const CellFileSha256& head, ULONGLONG deadline, const CellRuntimeFileSelection* file) noexcept {
  if (failure_.load()) return failure_.load();
  if (busy_.exchange(true)) return Fail(ERROR_BUSY);
  const auto error = [&]() noexcept -> DWORD {
    if (role_ != CellRuntimeControlRole::controller || binding.nonce != binding_.nonce ||
        binding.request_sha256 != binding_.request_sha256 || head != head_) return ERROR_INVALID_DATA;
    Bytes bytes{}, reply{};
    const auto challenge = Challenge(binding_, head_, checks_ + 1);
    std::copy(challenge.begin(), challenge.end(), bytes.begin());
    Put32(bytes.data() + 104, file ? 3 : supplied ? 1 : 2);
    if (file) {
      CellRuntimeFileAuthorizationBytes encoded{};
      const auto result = EncodeCellRuntimeFileAuthorization(*file, &encoded); if (result) return result;
      std::copy(encoded.begin(), encoded.end(), bytes.begin() + 108);
    }
    if (supplied) {
      const auto frozen = *supplied;
      CellControllerMessage kind{}; CellRuntimeStreamBytes wire{};
      if (frozen.stream != CellRuntimeStream::input || !EncodeCellRuntimeStream(binding_, frozen, &kind, &wire)) return ERROR_INVALID_DATA;
      Put32(bytes.data() + 108, static_cast<std::uint32_t>(kind));
      std::copy(wire.begin(), wire.end(), bytes.begin() + 112);
    }
    CellRuntimeStreamFrame frame; bool delivery = false; CellRuntimeFileSelection selected;
    auto result = Validate(bytes, &frame, &delivery, &selected); if (result) return result;
    const auto until = std::min({deadline_, deadline, GetTickCount64() + 5000});
    result = Begin(until);
    if (!result) result = WriteCellControllerMessage(control_, CellControllerMessage::runtime_control_authority,
      bytes.data(), static_cast<DWORD>(bytes.size()), owner_.peer.cancellation, until);
    if (!result) result = Peer(until);
    if (!result) result = ReadCellControllerMessage(control_, CellControllerMessage::runtime_control_authorized,
      reply.data(), static_cast<DWORD>(reply.size()), owner_.peer.cancellation, until);
    if (!result && reply != bytes) result = ERROR_INVALID_DATA;
    if (!result) result = Peer(until);
    if (!result) Accept(bytes, frame, delivery);
    return result;
  }();
  return End(error);
}
DWORD CellRuntimeControlChannel::Respond(ULONGLONG deadline) noexcept {
  if (failure_.load()) return failure_.load();
  if (busy_.exchange(true)) return Fail(ERROR_BUSY);
  const auto error = [&]() noexcept -> DWORD {
    if (role_ != CellRuntimeControlRole::protected_parent) return ERROR_INVALID_STATE;
    const auto until = std::min({deadline_, deadline, GetTickCount64() + 5000});
    auto result = Begin(until); if (result) return result;
    Bytes bytes{};
    result = ReadCellControllerMessage(control_, CellControllerMessage::runtime_control_authority,
      bytes.data(), static_cast<DWORD>(bytes.size()), owner_.peer.cancellation, until);
    CellRuntimeStreamFrame frame; bool delivery = false; CellRuntimeFileSelection selected;
    if (!result) result = Validate(bytes, &frame, &delivery, &selected);
    if (!result) result = Peer(until);
    if (!result) result = bytes[104] == 3 ? (owner_.file ? owner_.file(owner_.context, selected, until) : ERROR_ACCESS_DENIED) :
      delivery ? owner_.deliver(owner_.context, binding_, head_, until) : owner_.input(owner_.context, binding_, frame, until);
    if (!result) result = Peer(until);
    if (!result) result = WriteCellControllerMessage(control_, CellControllerMessage::runtime_control_authorized,
      bytes.data(), static_cast<DWORD>(bytes.size()), owner_.peer.cancellation, until);
    if (!result) result = Peer(until);
    if (!result) Accept(bytes, frame, delivery);
    return result;
  }();
  return End(error);
}
namespace {
std::wstring RuntimeControlPipeName(const CellControllerNonce& nonce) {
  if (std::none_of(nonce.begin(), nonce.end(), [](auto byte) { return byte != 0; })) return {};
  std::wstring name = L"\\\\.\\pipe\\LOCAL\\GoatCitadelRuntimeControl.v1.";
  constexpr wchar_t hex[] = L"0123456789abcdef";
  for (const auto byte : nonce) { name += hex[byte >> 4]; name += hex[byte & 15]; }
  return name;
}
}
DWORD CellRuntimeControlEndpoint::Fail(DWORD error) noexcept {
  if (error && !failure_) failure_ = error;
  return failure_;
}
void CellRuntimeControlEndpoint::Close() noexcept {
  open_ = admitted_ = false;
  client_.Close(); server_.Close();
  if (pipe_ != INVALID_HANDLE_VALUE && pipe_) CloseHandle(pipe_);
  pipe_ = INVALID_HANDLE_VALUE; runtime_ = nullptr;
}
DWORD CellRuntimeControlEndpoint::Peer(ULONGLONG deadline) noexcept {
  if (failure_) return failure_;
  if (!runtime_ || runtime_ == INVALID_HANDLE_VALUE) return ERROR_INVALID_STATE;
  const bool was_admitted = admitted_;
  auto error = Control(owner_.peer, deadline);
  if (!error) error = owner_.peer.authorize(owner_.peer.context);
  if (!error && admitted_) error = server_end_ ? owner_.client(owner_.context, client_) : owner_.server(owner_.context, server_);
  if (!error && (failure_ || !runtime_ || (was_admitted && !admitted_))) error = failure_ ? failure_ : ERROR_INVALID_STATE;
  if (!error) error = Control(owner_.peer, deadline);
  return error;
}
DWORD CellRuntimeControlEndpoint::Begin(HANDLE runtime, ULONGLONG deadline, const CellControllerRuntimeBinding& binding,
    const CellRuntimeControlEndpointOwner& owner, bool server) noexcept {
  if (failure_) return failure_;
  if (attempted_ || busy_) return Fail(ERROR_INVALID_STATE);
  attempted_ = busy_ = true; runtime_ = runtime; deadline_ = deadline; binding_ = binding; owner_ = owner; server_end_ = server;
  CellControllerRuntimeBindingBytes checked{}; DWORD flags = 0, handle_flags = 0;
  if ((server ? !owner_.client : !owner_.server) || !EncodeCellControllerRuntimeBinding(binding_.nonce, binding_, &checked)) return ERROR_INVALID_PARAMETER;
  if (!GetNamedPipeInfo(runtime_, &flags, nullptr, nullptr, nullptr) || ((flags & PIPE_SERVER_END) != 0) != server ||
      !GetHandleInformation(runtime_, &handle_flags) || (handle_flags & HANDLE_FLAG_INHERIT)) return ERROR_INVALID_HANDLE;
  return Peer(deadline_);
}
DWORD CellRuntimeControlEndpoint::OpenServer(HANDLE runtime, ULONGLONG deadline, const CellControllerRuntimeBinding& binding,
    const CellRuntimeControlEndpointOwner& owner) noexcept {
  if (failure_) return failure_;
  if (attempted_) return Fail(ERROR_INVALID_STATE);
  try {
    std::vector<std::uint8_t> descriptor;
    const auto error = BuildCellControllerPipeSecurity(&descriptor);
    if (error) { attempted_ = true; return Fail(error); }
    return OpenServerOwned(runtime, deadline, binding, owner, descriptor.data());
  } catch (...) { attempted_ = true; return Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeControlEndpoint::OpenServerOwned(HANDLE runtime, ULONGLONG deadline, const CellControllerRuntimeBinding& binding,
    const CellRuntimeControlEndpointOwner& owner, void* descriptor) noexcept {
  if (failure_) return failure_;
  if (attempted_) return Fail(ERROR_INVALID_STATE);
  auto error = Begin(runtime, deadline, binding, owner, true);
  if (error) { busy_ = false; Fail(error); Close(); return failure_; }
  try {
    const auto until = std::min(deadline_, GetTickCount64() + 5000);
    CellControllerNonce nonce{}; CellControllerRuntimeBindingBytes setup{}, reply{};
    if (BCryptGenRandom(nullptr, nonce.data(), static_cast<ULONG>(nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 ||
        !EncodeCellControllerRuntimeBinding(nonce, binding_, &setup)) error = ERROR_GEN_FAILURE;
    if (!error) {
      const auto name = RuntimeControlPipeName(nonce);
      SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
      pipe_ = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1,
        kCellControllerMaximumPipeBytes, kCellControllerMaximumPipeBytes, 0, &security);
      if (pipe_ == INVALID_HANDLE_VALUE) error = GetLastError();
    }
    if (!error) error = Peer(until);
    if (!error) error = WriteCellControllerMessage(runtime_, CellControllerMessage::runtime_control_setup,
      setup.data(), static_cast<DWORD>(setup.size()), owner_.peer.cancellation, until);
    if (!error) error = Peer(until);
    if (!error) error = ConnectCellPipe(pipe_, owner_.peer.cancellation, until);
    if (!error) error = ReadCellControllerMessage(pipe_, CellControllerMessage::runtime_control_hello,
      reply.data(), static_cast<DWORD>(reply.size()), owner_.peer.cancellation, until);
    if (!error && reply != setup) error = ERROR_INVALID_DATA;
    if (!error) error = client_.Open(pipe_);
    admitted_ = error == ERROR_SUCCESS;
    if (!error) error = Peer(until);
    if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::runtime_control_welcome,
      setup.data(), static_cast<DWORD>(setup.size()), owner_.peer.cancellation, until);
    if (!error) error = Peer(until);
    if (!error) open_ = true;
  } catch (...) { error = ERROR_NOT_ENOUGH_MEMORY; }
  busy_ = false; Fail(error); if (error) Close(); return failure_;
}
DWORD CellRuntimeControlEndpoint::OpenClient(HANDLE runtime, ULONGLONG deadline, const CellControllerRuntimeBinding& binding,
    const CellRuntimeControlEndpointOwner& owner) noexcept {
  if (failure_) return failure_;
  if (attempted_) return Fail(ERROR_INVALID_STATE);
  auto error = Begin(runtime, deadline, binding, owner, false);
  if (error) { busy_ = false; Fail(error); Close(); return failure_; }
  try {
    const auto until = std::min(deadline_, GetTickCount64() + 5000);
    CellControllerRuntimeBindingBytes setup{}, reply{}; CellControllerNonce nonce{}; CellControllerRuntimeBinding received;
    error = ReadCellControllerMessage(runtime_, CellControllerMessage::runtime_control_setup,
      setup.data(), static_cast<DWORD>(setup.size()), owner_.peer.cancellation, until);
    std::copy_n(setup.begin(), nonce.size(), nonce.begin());
    if (!error && (!DecodeCellControllerRuntimeBinding(nonce, setup, &received) || received != binding_)) error = ERROR_INVALID_DATA;
    if (!error) error = Peer(until);
    if (!error) {
      const auto name = RuntimeControlPipeName(nonce);
      pipe_ = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
      if (pipe_ == INVALID_HANDLE_VALUE) error = GetLastError();
    }
    if (!error) error = server_.Open(pipe_);
    admitted_ = error == ERROR_SUCCESS;
    if (!error) error = Peer(until);
    if (!error) error = WriteCellControllerMessage(pipe_, CellControllerMessage::runtime_control_hello,
      setup.data(), static_cast<DWORD>(setup.size()), owner_.peer.cancellation, until);
    if (!error) error = Peer(until);
    if (!error) error = ReadCellControllerMessage(pipe_, CellControllerMessage::runtime_control_welcome,
      reply.data(), static_cast<DWORD>(reply.size()), owner_.peer.cancellation, until);
    if (!error && reply != setup) error = ERROR_INVALID_DATA;
    if (!error) error = Peer(until);
    if (!error) open_ = true;
  } catch (...) { error = ERROR_NOT_ENOUGH_MEMORY; }
  busy_ = false; Fail(error); if (error) Close(); return failure_;
}
DWORD CellRuntimeControlEndpoint::Verify() noexcept {
  if (failure_) return failure_;
  if (busy_) return Fail(ERROR_BUSY);
  if (!open_) return Fail(ERROR_INVALID_STATE);
  busy_ = true;
  const auto error = Peer(deadline_);
  busy_ = false; return Fail(error);
}
CellFootprintScanGuard CellRuntimeControlEndpoint::Guard() noexcept {
  return {[](void* raw) noexcept { return static_cast<CellRuntimeControlEndpoint*>(raw)->Verify(); }, this, owner_.peer.cancellation};
}
}
