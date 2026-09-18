#include "cell_controller_runtime.hpp"
#include "cell_runtime_file_transfer.hpp"
#include <algorithm>
#include <stdexcept>
#include <thread>

namespace goatcitadel::worker_cell {
struct CellRuntimeControlEndpointTestPeer final {
  static DWORD Open(CellRuntimeControlEndpoint& endpoint, HANDLE runtime, ULONGLONG deadline,
      const CellControllerRuntimeBinding& binding, const CellRuntimeControlEndpointOwner& owner) noexcept {
    // Only this fixture replaces the installed pipe ACL with the test user's
    // default ACL. Production OpenServer always builds the fixed service ACL.
    return endpoint.OpenServerOwned(runtime, deadline, binding, owner, nullptr);
  }
};
}
using namespace goatcitadel::worker_cell;
std::vector<std::uint8_t> CellRuntimeDispatchGoldenBytes();
namespace {
unsigned checks = 0, fixtures = 0, endpoint_pipes = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Pair final {
  Handle stop, server, client;
  ULONGLONG deadline = GetTickCount64() + 10000;
  Pair() {
    stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Check(stop.value != nullptr, "Runtime authority cancellation event");
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.RuntimeAuthority.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++fixtures);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, stop.value, deadline), "Connect exclusive runtime authority fixture pipe");
  }
};
CellRuntimeDispatchBinding Binding(const std::vector<std::uint8_t>& bytes) {
  CellRuntimeDispatchBinding value; std::copy_n(bytes.begin() + 8, 32, value.nonce.begin());
  Check(!HashCellRuntimeDispatch(bytes, &value.request_sha256), "Runtime authority uses exact dispatch hash"); return value;
}
CellFileSha256 Head(const std::vector<std::uint8_t>& bytes) {
  CellFileSha256 head{}; std::copy_n(bytes.begin() + 96, 32, head.begin()); return head;
}
CellControllerRuntimeChallenge Challenge(const CellRuntimeDispatchBinding& binding, const CellFileSha256& head) {
  CellControllerRuntimeChallenge value{}; std::copy(binding.nonce.begin(), binding.nonce.end(), value.begin());
  value[32] = 1; value[36] = 21; std::copy(head.begin(), head.end(), value.begin() + 40);
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), value.begin() + 72); return value;
}
struct Peer final {
  unsigned calls = 0, deny_at = 0;
  CellRuntimeDispatchBinding* mutate_binding = nullptr;
  CellFileSha256* mutate_head = nullptr;
  CellControllerRuntimeClientOwner* mutate_owner = nullptr;
  CellRuntimeStreamFrame* mutate_frame = nullptr;
  static DWORD Verify(void* raw) noexcept {
    auto& self = *static_cast<Peer*>(raw); ++self.calls;
    if (self.calls == 1) {
      if (self.mutate_binding) self.mutate_binding->nonce.back() ^= 1;
      if (self.mutate_head) self.mutate_head->back() ^= 1;
      if (self.mutate_owner) self.mutate_owner->admit = nullptr;
      if (self.mutate_frame) self.mutate_frame->data[0] ^= 1;
    }
    return self.calls == self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
};
struct Admission final {
  CellRuntimeDispatchBinding expected;
  CellFileSha256 head;
  unsigned calls = 0, deny_at = 0;
  CellControllerRuntimeChallenge* mutate = nullptr;
  CellControllerRuntimeClient* reenter = nullptr;
  static DWORD Admit(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, std::uint32_t ordinal) noexcept {
    auto& self = *static_cast<Admission*>(raw); ++self.calls;
    if (binding.nonce != self.expected.nonce || binding.request_sha256 != self.expected.request_sha256 || head != self.head || ordinal != self.calls)
      return ERROR_INVALID_DATA;
    if (self.reenter && self.mutate) self.reenter->Respond(*self.mutate);
    if (self.mutate) self.mutate->back() ^= 1;
    return self.calls == self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
};
DWORD ReadChallenge(Pair& pair, CellControllerRuntimeChallenge* challenge) {
  CellControllerMessage kind{}; std::array<std::uint8_t, 1056> bytes{};
  const auto error = ReadCellControllerReply(pair.client.value, &kind, &bytes, pair.stop.value, pair.deadline);
  if (error) return error;
  if (kind != CellControllerMessage::runtime_authority) return ERROR_INVALID_DATA;
  std::copy_n(bytes.begin(), challenge->size(), challenge->begin()); return ERROR_SUCCESS;
}
void Exchange(unsigned mode) {
  Pair pair; const auto bytes = CellRuntimeDispatchGoldenBytes(); auto binding = Binding(bytes); auto head = Head(bytes);
  Peer server_peer, client_peer; Admission admission{binding, head};
  CellControllerRuntimeClientOwner owner{{Peer::Verify, &client_peer, pair.stop.value}, &admission, Admission::Admit};
  if (mode == 1) admission.deny_at = 2;
  if (mode == 2) client_peer.deny_at = 2;
  if (mode == 3) { client_peer.mutate_binding = &binding; client_peer.mutate_head = &head; client_peer.mutate_owner = &owner; }
  if (mode == 6) server_peer.deny_at = 2;
  CellControllerRuntimeAuthority server(pair.server.value, pair.deadline, binding, head, {Peer::Verify, &server_peer, pair.stop.value});
  CellControllerRuntimeClient client(pair.client.value, pair.deadline, binding, head, owner);
  CellControllerRuntimeChallenge challenge{};
  if (mode == 4 || mode == 5) admission.mutate = &challenge;
  if (mode == 5) admission.reenter = &client;
  DWORD client_error = 0;
  const unsigned total = mode == 0 || mode == 1 || mode == 3 || mode == 4 ? 3 : 1;
  std::thread responder([&] {
    for (unsigned index = 0; index < total; ++index) {
      client_error = ReadChallenge(pair, &challenge);
      if (!client_error && mode == 7) {
        challenge[72] ^= 1;
        client_error = WriteCellControllerMessage(pair.client.value, CellControllerMessage::runtime_authorized, challenge.data(),
          static_cast<DWORD>(challenge.size()), pair.stop.value, pair.deadline);
      } else if (!client_error && mode == 8) {
        client_error = WriteCellControllerMessage(pair.client.value, CellControllerMessage::volume_authorized, challenge.data(), 72, pair.stop.value, pair.deadline);
      } else if (!client_error) {
        if (mode == 9) challenge[32] = 2;
        client_error = client.Respond(challenge);
      }
      if (client_error) { SetEvent(pair.stop.value); break; }
    }
  });
  DWORD server_error = 0;
  for (unsigned index = 0; index < total && !server_error; ++index) server_error = server.Check();
  if (server_error) SetEvent(pair.stop.value);
  responder.join();
  if (mode == 0 || mode == 3 || mode == 4) {
    Check(!server_error && !client_error && admission.calls == 3 && client.Checks() == 3 && server.Checks() == 3,
      "Every real pipe challenge obtains fresh admission for frozen request/head/callbacks");
    const auto calls = admission.calls;
    const auto repeated = Challenge(admission.expected, admission.head);
    Check(client.Respond(repeated) == ERROR_INVALID_DATA && admission.calls == calls, "Previously approved ordinal cannot be replayed");
  } else {
    Check(server_error != 0, "Failed current workload authority never passes its server guard");
    if (mode == 1 || mode == 2) Check(client_error == ERROR_ACCESS_DENIED, "Canonical denial or endpoint revocation refuses the ACK");
    if (mode == 5) Check(client_error == ERROR_BUSY, "Reentrant admission permanently fences both nested and outer response");
    if (mode == 6) Check(server_error == ERROR_ACCESS_DENIED, "Server reattests current endpoint custody after the reply");
    if (mode == 7 || mode == 8 || mode == 9) Check((mode == 9 ? client_error : server_error) == ERROR_INVALID_DATA,
      "Changed request, old volume approval and out-of-order runtime reply refuse");
    if (mode == 9) Check(!admission.calls, "Invalid challenge never reaches canonical admission");
    const auto calls = server_peer.calls;
    Check(server.Check() == server_error && server_peer.calls == calls, "Failed guard cannot reconnect, retry or regain authority");
  }
  SetEvent(pair.stop.value);
  const auto calls = admission.calls;
  Check(client.Respond(Challenge(admission.expected, admission.head)) != 0 && admission.calls == calls,
    "Cancelled or failed connection cannot authorize another workload step");
}
void Malformed() {
  const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes); const auto head = Head(bytes);
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(stop.value != nullptr, "Malformed authority fixture event");
  for (unsigned mode = 0; mode < 12; ++mode) {
    Peer peer; Admission admission{binding, head};
    CellControllerRuntimeClientOwner owner{{Peer::Verify, &peer, stop.value}, &admission, Admission::Admit};
    auto challenge = Challenge(binding, head), wrong = challenge;
    auto expected = binding; auto expected_head = head; auto deadline = GetTickCount64() + 10000;
    if (mode < 5) wrong[std::array<std::size_t, 5>{0, 32, 36, 40, 72}[mode]] ^= 1;
    if (mode == 5) wrong[32] = 2;
    if (mode == 6) owner.admit = nullptr;
    if (mode == 7) expected.nonce = {};
    if (mode == 8) expected.request_sha256 = {};
    if (mode == 9) expected_head = {};
    if (mode == 10) SetEvent(stop.value);
    if (mode == 11) deadline = GetTickCount64();
    CellControllerRuntimeClient client(INVALID_HANDLE_VALUE, deadline, expected, expected_head, owner);
    Check(client.Respond(wrong) != 0 && !admission.calls && !peer.calls, "Unbound, stale or malformed runtime authority refuses before callbacks and pipe I/O");
    Check(client.Respond(challenge) != 0 && !admission.calls, "Correct bytes cannot revive a failed authority instance");
    ResetEvent(stop.value);
  }
}
void Composed(unsigned mode) {
  Pair pair; const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes); const auto head = Head(bytes);
  Peer server_peer, client_peer; Admission admission{binding, head};
  if (mode == 1) admission.deny_at = 1;
  auto retained_head = head; if (mode == 2) retained_head.back() ^= 1;
  CellControllerRuntimeAuthority server(pair.server.value, pair.deadline, binding, retained_head, {Peer::Verify, &server_peer, pair.stop.value});
  CellControllerRuntimeClient client(pair.client.value, pair.deadline, binding, head,
    {{Peer::Verify, &client_peer, pair.stop.value}, &admission, Admission::Admit});
  Handle transferred{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(transferred.value != nullptr, "Composed transfer completion event");
  DWORD client_error = 0, transfer_error = ERROR_INVALID_STATE;
  std::thread responder([&] {
    CellRuntimeTransfer writer(pair.client.value, pair.deadline, binding, {Peer::Verify, &client_peer, pair.stop.value});
    transfer_error = writer.Write(bytes); client_error = transfer_error;
    SetEvent(transferred.value);
    CellControllerRuntimeChallenge challenge{};
    if (!client_error) client_error = ReadChallenge(pair, &challenge);
    if (!client_error) client_error = client.Respond(challenge);
    if (client_error) SetEvent(pair.stop.value);
  });
  CellProvisioningJournal journal;
  const auto result = server.Run(journal);
  const auto transfer_state = WaitForSingleObject(transferred.value, 10000);
  // Successful responder has no further read; failed peer must be released.
  if (mode) SetEvent(pair.stop.value);
  responder.join(); SetEvent(pair.stop.value);
  Check(transfer_state == WAIT_OBJECT_0 && !transfer_error && !result.execution.runtime.job.process_id && !result.execution.inventory_verified,
    "Byte transfer never stands in for authorized native execution or inventory");
  if (!mode) Check(!client_error && result.binding_verified && result.execution.runtime.job.error == ERROR_INVALID_STATE && admission.calls == 1,
    "Composed transfer obtains exact workload approval then refuses the absent native journal");
  if (mode == 1) Check(client_error == ERROR_ACCESS_DENIED && !result.binding_verified && admission.calls == 1,
    "Canonical denial prevents entry to native dispatch");
  if (mode == 2) Check(result.execution.runtime.job.error == ERROR_INVALID_DATA && !admission.calls,
    "Separately retained journal head must match the complete dispatch before requesting authority");
  const auto count = server.Checks();
  Check(server.Run(journal).execution.runtime.job.error != 0 && server.Check() != 0 && server.Checks() == count,
    "Composed completion/failure consumes the execution owner without implicit replay");
}
struct ParentPeer final {
  unsigned calls = 0, deny_at = 0;
  HANDLE cancel = nullptr;
  CellRuntimeParentAuthority* reenter = nullptr;
  CellRuntimeDispatchBinding* mutate = nullptr;
  CellRuntimeDispatchBinding expected;
  CellFileSha256 head;
  static DWORD Verify(void* raw) noexcept {
    auto& self = *static_cast<ParentPeer*>(raw); ++self.calls;
    if (self.calls == 1 && self.mutate) self.mutate->request_sha256.back() ^= 1;
    if (self.calls == self.deny_at) {
      if (self.cancel) { SetEvent(self.cancel); return ERROR_SUCCESS; }
      if (self.reenter) { self.reenter->CheckDelivery(self.expected, self.head, GetTickCount64() + 1000); return ERROR_SUCCESS; }
      return ERROR_ACCESS_DENIED;
    }
    return ERROR_SUCCESS;
  }
};
void ParentExchange(unsigned mode) {
  Pair controller, parent;
  const auto bytes = CellRuntimeDispatchGoldenBytes(); auto binding = Binding(bytes); const auto expected = binding;
  const auto head = Head(bytes); ParentPeer peer;
  peer.expected = expected; peer.head = head;
  CellRuntimeParentAuthority bridge(controller.client.value, parent.client.value, parent.deadline, binding, head,
    {ParentPeer::Verify, &peer, parent.stop.value});
  if (mode == 3 || mode == 4 || mode == 5) peer.deny_at = 3;
  if (mode == 4) peer.cancel = parent.stop.value;
  if (mode == 5) peer.reenter = &bridge;
  if (mode == 6) peer.mutate = &binding;
  const bool success = mode == 0 || mode == 6;
  const unsigned total = success ? 5u : 1u;
  DWORD parent_error = ERROR_SUCCESS;
  std::thread responder([&] {
    for (unsigned index = 0; index < total && !parent_error; ++index) {
      const bool delivery = index % 2 == 1;
      const auto request = delivery ? CellControllerMessage::runtime_delivery_authority : CellControllerMessage::runtime_authority;
      auto reply_kind = delivery ? CellControllerMessage::runtime_delivery_authorized : CellControllerMessage::runtime_authorized;
      CellControllerRuntimeChallenge supplied{};
      parent_error = ReadCellControllerMessage(parent.server.value, request, supplied.data(), static_cast<DWORD>(supplied.size()), parent.stop.value, parent.deadline);
      auto wanted = Challenge(expected, head); wanted[32] = static_cast<std::uint8_t>(index / 2 + 1);
      if (!parent_error && supplied != wanted) parent_error = ERROR_INVALID_DATA;
      if (!parent_error) {
        if (mode == 1) supplied.back() ^= 1;
        if (mode == 2) reply_kind = CellControllerMessage::runtime_delivery_authorized;
        if (mode == 7) supplied[32] = 2;
        if (mode == 8) supplied[40] ^= 1;
        parent_error = WriteCellControllerMessage(parent.server.value, reply_kind, supplied.data(), static_cast<DWORD>(supplied.size()), parent.stop.value, parent.deadline);
      }
    }
  });
  const auto owner = bridge.RuntimeOwner();
  DWORD result = ERROR_SUCCESS;
  for (unsigned index = 0; index < total && !result; ++index) {
    result = index % 2 == 1 ? bridge.CheckDelivery(expected, head, parent.deadline) :
      owner.admit(owner.context, expected, head, index / 2 + 1);
  }
  if (result) SetEvent(parent.stop.value);
  responder.join();
  if (success) {
    Check(!result && !parent_error && peer.calls == total * 3, "Parent obtains fresh separately sequenced runtime and delivery authority");
    Check(bridge.CheckRuntime(expected, head, 3) == ERROR_INVALID_DATA, "Runtime admission replay fences the parent bridge");
    result = ERROR_INVALID_DATA;
  } else {
    Check(result != 0, "Forged reply, wrong action, revocation, cancellation and reentry refuse parent authority");
    if (mode == 3) Check(result == ERROR_ACCESS_DENIED, "Parent custody rechecked after authorization reply");
    if (mode == 4) Check(result == ERROR_OPERATION_ABORTED, "Parent callback cancellation fences outer grant");
    if (mode == 5) Check(result == ERROR_BUSY, "Reentrant delivery cannot revive or overwrite a failed bridge");
  }
  const auto calls = peer.calls;
  Check(bridge.CheckDelivery(expected, head, parent.deadline) == result && peer.calls == calls, "Failure stays fenced across action kinds without callbacks or retry");
  DWORD available = 0;
  Check(PeekNamedPipe(controller.server.value, nullptr, 0, nullptr, &available, nullptr) && !available,
    "Parent bridge never writes the controller runtime pipe");
  Check(WaitForSingleObject(controller.stop.value, 0) == WAIT_TIMEOUT, "Parent bridge never signals controller cancellation");
  if (success) Check(WaitForSingleObject(parent.stop.value, 0) == WAIT_TIMEOUT, "Successful bridge leaves borrowed parent cancellation untouched");
}
void ParentMalformed() {
  Pair controller, parent;
  const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes); const auto head = Head(bytes);
  Handle alias;
  Check(DuplicateHandle(GetCurrentProcess(), controller.client.value, GetCurrentProcess(), &alias.value, 0, FALSE, DUPLICATE_SAME_ACCESS),
    "Create owned duplicate controller handle for alias refusal");
  for (unsigned mode = 0; mode < 12; ++mode) {
    ParentPeer peer; auto supplied = binding; auto supplied_head = head; auto expected = binding;
    auto pipe = parent.client.value; auto deadline = parent.deadline; std::uint32_t ordinal = 1;
    if (mode == 0) pipe = controller.client.value;
    if (mode == 1) pipe = alias.value;
    if (mode == 2) pipe = parent.stop.value;
    if (mode == 3) pipe = INVALID_HANDLE_VALUE;
    if (mode == 4) supplied.nonce.back() ^= 1;
    if (mode == 5) supplied.request_sha256.back() ^= 1;
    if (mode == 6) supplied_head.back() ^= 1;
    if (mode == 7) ordinal = 0;
    if (mode == 8) ordinal = 2;
    if (mode == 9) expected.nonce = {};
    if (mode == 10) deadline = GetTickCount64();
    CellRuntimeParentAuthority bridge(controller.client.value, pipe, deadline, expected, head,
      {mode == 11 ? nullptr : ParentPeer::Verify, &peer, parent.stop.value});
    const auto error = bridge.CheckRuntime(supplied, supplied_head, ordinal);
    Check(error != 0 && !peer.calls, "Invalid pipe alias, binding, order, deadline or missing custody refuses before I/O");
    Check(bridge.CheckDelivery(binding, head, parent.deadline) == error && !peer.calls, "Malformed bridge cannot recover through another action");
  }
  for (auto* pair : {&parent, &controller}) {
    DWORD available = 0;
    Check(PeekNamedPipe(pair->server.value, nullptr, 0, nullptr, &available, nullptr) && !available,
      "Refused bridge writes neither borrowed pipe");
    Check(WaitForSingleObject(pair->stop.value, 0) == WAIT_TIMEOUT, "Refused bridge does not signal borrowed cancellation");
  }
}
}
namespace {
struct ControlAdmission final {
  CellRuntimeDispatchBinding binding;
  CellFileSha256 head;
  unsigned inputs = 0, deliveries = 0, deny_input = 0, deny_delivery = 0;
  HANDLE cancel = nullptr;
  CellRuntimeControlChannel* reenter = nullptr;
  unsigned files = 0;
  CellRuntimeFileSelection selected_file;
  static DWORD Input(void* raw, const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame, ULONGLONG deadline) noexcept {
    auto& self = *static_cast<ControlAdmission*>(raw); ++self.inputs;
    if (binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || frame.stream != CellRuntimeStream::input ||
        (frame.eof ? frame.sequence != 2 || frame.count : frame.sequence != 1 || frame.count != 3 || frame.data[0] != 0x41 || frame.data[1] || frame.data[2] != 0xff) ||
        frame.total != 3 || GetTickCount64() >= deadline) return ERROR_INVALID_DATA;
    if (self.cancel) SetEvent(self.cancel);
    if (self.reenter) self.reenter->Respond(deadline);
    return self.inputs == self.deny_input ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Deliver(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, ULONGLONG deadline) noexcept {
    auto& self = *static_cast<ControlAdmission*>(raw); ++self.deliveries;
    if (binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || head != self.head ||
        self.inputs != 3 || GetTickCount64() >= deadline) return ERROR_INVALID_DATA;
    return self.deliveries == self.deny_delivery ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD File(void* raw, const CellRuntimeFileSelection& file, ULONGLONG deadline) noexcept {
    auto& self = *static_cast<ControlAdmission*>(raw); ++self.files;
    CellRuntimeFileAuthorizationBytes expected{}, received{};
    if (EncodeCellRuntimeFileAuthorization(self.selected_file, &expected) || EncodeCellRuntimeFileAuthorization(file, &received) ||
        expected != received || file.expected.binding.nonce != self.binding.nonce || file.expected.binding.request_sha256 != self.binding.request_sha256 ||
        self.deliveries != 2 || GetTickCount64() >= deadline) return ERROR_INVALID_DATA;
    return self.files == 3 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
};
CellRuntimeStreamFrame ControlInput() {
  CellRuntimeStreamFrame frame; frame.sequence = 1; frame.count = 3; frame.total = 3;
  frame.data[0] = 0x41; frame.data[2] = 0xff; return frame;
}
void ControlExchange(unsigned mode) {
  Pair runtime, control;
  const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes); const auto head = Head(bytes);
  Peer sender_peer, responder_peer; ControlAdmission admission{binding, head};
  auto frame = ControlInput();
  const auto deadline = mode == 13 ? GetTickCount64() + 86400000 : control.deadline;
  if (mode == 14) sender_peer.mutate_frame = &frame;
  CellRuntimeControlOwner sender_owner{{Peer::Verify, &sender_peer, control.stop.value}};
  CellRuntimeControlOwner responder_owner{{Peer::Verify, &responder_peer, control.stop.value}, &admission, ControlAdmission::Input, ControlAdmission::Deliver, ControlAdmission::File};
  CellRuntimeControlChannel sender(runtime.server.value, control.server.value, deadline, binding, head, 3,
    CellRuntimeControlRole::controller, sender_owner);
  CellRuntimeControlChannel responder(runtime.client.value, control.client.value, deadline, binding, head, 3,
    CellRuntimeControlRole::protected_parent, responder_owner);
  if (mode == 1) admission.deny_input = 2;
  if (mode == 2) admission.deny_delivery = 1;
  if (mode == 3) sender_peer.deny_at = 3;
  if (mode == 4) responder_peer.deny_at = 3;
  if (mode == 5) admission.cancel = control.stop.value;
  if (mode == 6) admission.reenter = &responder;
  if (mode == 7) admission.deny_delivery = 2;
  // Both runtime directions already contain traffic: control exchanges must
  // leave it byte-for-byte intact, including during delivery authorization.
  std::array<std::uint8_t, 16> pending_reply{}, pending_terminal{};
  pending_reply[0] = 20; pending_reply[15] = 99; pending_terminal[0] = 'G'; pending_terminal[15] = 100;
  Check(!WriteCellPipe(runtime.client.value, pending_reply.data(), 16, runtime.stop.value, runtime.deadline) &&
    !WriteCellPipe(runtime.server.value, pending_terminal.data(), 16, runtime.stop.value, runtime.deadline), "Stage independent runtime traffic before control admission");
  DWORD responder_error = ERROR_SUCCESS;
  std::thread task([&] {
    for (unsigned index = 0; index < 5 && !responder_error; ++index) {
      if (mode >= 8 && mode <= 12) {
        std::array<std::uint8_t, 1168> request{};
        responder_error = ReadCellControllerMessage(control.client.value, CellControllerMessage::runtime_control_authority,
          request.data(), static_cast<DWORD>(request.size()), control.stop.value, control.deadline);
        if (!responder_error) {
          request[mode == 8 ? 32 : mode == 9 ? 0 : mode == 10 ? 40 : mode == 11 ? 72 : 112 + 80] ^= 1;
          responder_error = WriteCellControllerMessage(control.client.value, CellControllerMessage::runtime_control_authorized,
            request.data(), static_cast<DWORD>(request.size()), control.stop.value, control.deadline);
        }
        break;
      }
      responder_error = responder.Respond(deadline);
    }
    if (responder_error) SetEvent(control.stop.value);
  });
  DWORD error = ERROR_SUCCESS;
  for (unsigned index = 0; index < 5 && !error; ++index) {
    if (index == 1 && mode == 14) frame = ControlInput();
    if (index == 1 && mode == 15) frame.data[0] ^= 1;
    if (index == 1 && mode == 16) frame.sequence = 3;
    if (index == 2) { frame = {}; frame.sequence = 2; frame.total = 3; frame.eof = true; }
    error = index < 3 ? sender.Input(binding, frame, deadline) : sender.Deliver(binding, head, deadline);
  }
  if (error) SetEvent(control.stop.value);
  task.join();
  if (!mode || mode == 13 || mode == 14) {
    Check(!error && !responder_error && admission.inputs == 3 && admission.deliveries == 2,
      "Every repeated input and delivery check reaches fresh protected authority");
    Check(sender_peer.calls == 15 && responder_peer.calls == 20, "Both endpoint owners recheck custody around each exchange");
    Check(WaitForSingleObject(control.stop.value, 0) == WAIT_TIMEOUT, "Control success leaves borrowed cancellation untouched");
    if (!mode) {
      CellRuntimeDispatch decoded; Check(!DecodeCellRuntimeDispatch(bytes, binding, &decoded), "Decode independent file-control roots");
      auto& file = admission.selected_file; file.relative_path = L"outputs/result.txt"; file.expected.binding = binding;
      file.expected.result_sha256.fill(0xee); file.expected.work = decoded.command.protected_workspace->identities.directories[3];
      file.expected.file.identity = file.expected.work; file.expected.file.identity.file_id.fill(0x77);
      file.expected.file.logical_file_bytes = 5; file.expected.file.allocated_bytes = 4096; file.expected.maximum_bytes = 1024;
      std::thread files([&] { for (unsigned i = 0; i < 3 && !responder_error; ++i) responder_error = responder.Respond(control.deadline);
        if (responder_error) SetEvent(control.stop.value); });
      for (unsigned i = 0; i < 3 && !error; ++i) error = sender.File(file, control.deadline);
      if (error) SetEvent(control.stop.value); files.join();
      Check(error && responder_error == ERROR_ACCESS_DENIED && admission.files == 3 && admission.deliveries == 2,
        "Exact file challenges require fresh independent permission; repeated file grants can be revoked without becoming delivery grants");
    } else {
      error = sender.Input(binding, frame, control.deadline);
      Check(error == ERROR_INVALID_DATA, "Delivery permanently ends further input permission");
    }
  } else {
    Check(error != 0, "Revoked permission, changed reply, cancellation and reentry fence control admission");
    if (mode == 1) Check(admission.inputs == 2 && !admission.deliveries && responder_error == ERROR_ACCESS_DENIED,
      "Identical staged bytes require a new grant and may be revoked before another queue attempt");
    if (mode == 2 || mode == 7) Check(admission.inputs == 3 && admission.deliveries == (mode == 2 ? 1u : 2u) &&
      responder_error == ERROR_ACCESS_DENIED, "Delivery grants are independently refreshed and revocable");
    if (mode == 6) Check(responder_error == ERROR_BUSY, "Reentrant canonical callback cannot recover control authority");
    if (mode == 15 || mode == 16) Check(error == ERROR_INVALID_DATA && admission.inputs == 1,
      "Changed repeated input and skipped sequences refuse without obtaining another grant");
  }
  const auto sender_calls = sender_peer.calls, input_calls = admission.inputs, delivery_calls = admission.deliveries;
  Check(sender.Deliver(binding, head, control.deadline) == error && sender_peer.calls == sender_calls &&
    admission.inputs == input_calls && admission.deliveries == delivery_calls, "Failed control channel never retries I/O or canonical callbacks");
  std::array<std::uint8_t, 16> received_reply{}, received_terminal{};
  Check(!ReadCellPipe(runtime.server.value, received_reply.data(), 16, runtime.stop.value, runtime.deadline) && received_reply == pending_reply &&
    !ReadCellPipe(runtime.client.value, received_terminal.data(), 16, runtime.stop.value, runtime.deadline) && received_terminal == pending_terminal,
    "Control traffic cannot consume an outstanding runtime reply or terminal bytes");
  Check(WaitForSingleObject(runtime.stop.value, 0) == WAIT_TIMEOUT, "Control failures do not signal the runtime's borrowed cancellation");
}
void MalformedControl(unsigned mode) {
  Pair runtime, control;
  const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes); const auto head = Head(bytes);
  Peer peer; ControlAdmission admission{binding, head};
  CellRuntimeControlChannel responder(runtime.client.value, control.client.value, control.deadline, binding, head, 3,
    CellRuntimeControlRole::protected_parent, {{Peer::Verify, &peer, control.stop.value}, &admission, ControlAdmission::Input, ControlAdmission::Deliver});
  std::array<std::uint8_t, 1168> request{}; const auto challenge = Challenge(binding, head);
  std::copy(challenge.begin(), challenge.end(), request.begin()); request[104] = 1; request[108] = 21;
  auto frame = ControlInput(); CellControllerMessage kind{}; CellRuntimeStreamBytes wire{};
  Check(EncodeCellRuntimeStream(binding, frame, &kind, &wire), "Construct exact binary input control request");
  std::copy(wire.begin(), wire.end(), request.begin() + 112);
  constexpr std::array<std::size_t, 13> changes{0, 32, 36, 40, 72, 104, 108, 112, 144, 176, 180, 184, 195};
  if (mode < changes.size()) request[changes[mode]] ^= 1;
  else if (mode == 13) { request[104] = 2; std::fill(request.begin() + 108, request.end(), std::uint8_t{0}); }
  else { request[108] = 24; }
  Check(!WriteCellControllerMessage(control.server.value, CellControllerMessage::runtime_control_authority, request.data(),
    static_cast<DWORD>(request.size()), control.stop.value, control.deadline), "Send malformed control request over owned pipe");
  const auto error = responder.Respond(control.deadline);
  Check(error && !admission.inputs && !admission.deliveries, "Malformed binding, replay, action, frame, quota or early delivery refuses before canonical callbacks");
  const auto calls = peer.calls;
  Check(responder.Respond(control.deadline) == error && peer.calls == calls, "Malformed control channel remains fenced");
  DWORD available = 0;
  Check(PeekNamedPipe(control.server.value, nullptr, 0, nullptr, &available, nullptr) && !available,
    "Malformed control request receives no grant");
  Check(WaitForSingleObject(control.stop.value, 0) == WAIT_TIMEOUT, "Malformed control does not cancel its borrowed owner");
}
void ControlEndpoints() {
  Pair runtime, control;
  const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes); const auto head = Head(bytes);
  Handle alias;
  Check(DuplicateHandle(GetCurrentProcess(), runtime.server.value, GetCurrentProcess(), &alias.value, 0, FALSE, DUPLICATE_SAME_ACCESS),
    "Retain an owned runtime alias for control endpoint refusal");
  for (unsigned mode = 0; mode < 8; ++mode) {
    Peer peer; auto endpoint = control.server.value; auto deadline = control.deadline;
    if (mode == 0) endpoint = runtime.server.value;
    if (mode == 1) endpoint = alias.value;
    if (mode == 2) endpoint = control.stop.value;
    if (mode == 3) endpoint = INVALID_HANDLE_VALUE;
    if (mode == 4) deadline = GetTickCount64();
    if (mode == 5) deadline = GetTickCount64() + 86400100;
    const auto role = mode == 7 ? CellRuntimeControlRole::protected_parent : CellRuntimeControlRole::controller;
    CellRuntimeControlChannel channel(runtime.server.value, endpoint, deadline, binding, head, 3, role,
      {{mode == 6 ? nullptr : Peer::Verify, &peer, control.stop.value}});
    const auto error = channel.Input(binding, ControlInput(), deadline);
    Check(error && !peer.calls, "Alias, non-pipe, invalid lifetime, missing custody or wrong role refuses before I/O");
    Check(channel.Deliver(binding, head, deadline) == error && !peer.calls, "Invalid control endpoint stays fenced");
  }
}
struct EndpointOwner final {
  CellPipeClientEvidence* primary_client = nullptr;
  CellPipeServerEvidence* primary_server = nullptr;
  unsigned peers = 0, admissions = 0, deny = 0;
  CellRuntimeControlEndpoint* reenter = nullptr;
  CellControllerRuntimeBinding* mutate = nullptr;
  HANDLE cancel = nullptr;
  static DWORD Peer(void* raw) noexcept {
    auto& self = *static_cast<EndpointOwner*>(raw); ++self.peers;
    if (self.mutate && self.peers == 1) self.mutate->nonce.back() ^= 1;
    if (self.reenter && self.peers == 2) self.reenter->Verify();
    return self.primary_client ? self.primary_client->Verify() : self.primary_server->Verify();
  }
  static DWORD Client(void* raw, CellPipeClientEvidence& additional) noexcept {
    auto& self = *static_cast<EndpointOwner*>(raw); ++self.admissions;
    if (self.cancel) SetEvent(self.cancel);
    if (self.admissions == self.deny) return ERROR_ACCESS_DENIED;
    return self.primary_client->VerifySameProcess(additional);
  }
  static DWORD Server(void* raw, CellPipeServerEvidence& additional) noexcept {
    auto& self = *static_cast<EndpointOwner*>(raw); ++self.admissions;
    if (self.admissions == self.deny) return ERROR_ACCESS_DENIED;
    return self.primary_server->VerifySameProcess(additional);
  }
};
void EndpointExchange(unsigned mode) {
  Pair runtime;
  const auto bytes = CellRuntimeDispatchGoldenBytes(); const auto dispatch_binding = Binding(bytes); const auto head = Head(bytes);
  CellControllerRuntimeBinding binding{dispatch_binding.nonce, dispatch_binding.request_sha256, head}, client_binding = binding;
  CellPipeClientEvidence primary_client; CellPipeServerEvidence primary_server;
  const std::uint8_t hello = 42; std::uint8_t received = 0;
  Check(!WriteCellPipe(runtime.client.value, &hello, 1, runtime.stop.value, runtime.deadline) &&
    !ReadCellPipe(runtime.server.value, &received, 1, runtime.stop.value, runtime.deadline) && received == hello,
    "Primary endpoint has an independently observed client identification message");
  Check(!primary_client.Open(runtime.server.value) && !primary_server.Open(runtime.client.value), "Retain actual primary process and token evidence in both directions");
  CellRuntimeControlEndpoint server, client;
  EndpointOwner server_owner{&primary_client}, client_owner{nullptr, &primary_server};
  if (mode == 1) server_owner.deny = 1;
  if (mode == 2) client_owner.deny = 1;
  if (mode == 3) client_binding.request_sha256.back() ^= 1;
  if (mode == 4) server_owner.reenter = &server;
  if (mode == 5) client_owner.reenter = &client;
  if (mode == 6) server_owner.cancel = runtime.stop.value;
  if (mode == 7) server_owner.mutate = &binding;
  const auto deadline = mode == 8 ? GetTickCount64() + 86400000 : runtime.deadline;
  DWORD server_error = ERROR_SUCCESS; ++endpoint_pipes;
  std::thread task([&] {
    server_error = CellRuntimeControlEndpointTestPeer::Open(server, runtime.server.value, deadline, binding,
      {{EndpointOwner::Peer, &server_owner, runtime.stop.value}, &server_owner, EndpointOwner::Client});
    if (server_error) SetEvent(runtime.stop.value);
  });
  DWORD client_error = ERROR_SUCCESS; Handle malformed_client;
  if (mode < 9) client_error = client.OpenClient(runtime.client.value, deadline, client_binding,
    {{EndpointOwner::Peer, &client_owner, runtime.stop.value}, &client_owner, nullptr, EndpointOwner::Server});
  else {
    CellControllerRuntimeBindingBytes setup{}, welcome{};
    client_error = ReadCellControllerMessage(runtime.client.value, CellControllerMessage::runtime_control_setup,
      setup.data(), static_cast<DWORD>(setup.size()), runtime.stop.value, runtime.deadline);
    if (!client_error) {
      std::wstring name = L"\\\\.\\pipe\\LOCAL\\GoatCitadelRuntimeControl.v1."; constexpr wchar_t hex[] = L"0123456789abcdef";
      for (std::size_t i = 0; i < 32; ++i) { name += hex[setup[i] >> 4]; name += hex[setup[i] & 15]; }
      malformed_client.value = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
      if (malformed_client.value == INVALID_HANDLE_VALUE) client_error = GetLastError();
    }
    if (mode == 9) setup[64] ^= 1;
    if (!client_error) client_error = WriteCellControllerMessage(malformed_client.value,
      mode == 10 ? CellControllerMessage::runtime_control_welcome : CellControllerMessage::runtime_control_hello,
      setup.data(), static_cast<DWORD>(setup.size()), runtime.stop.value, runtime.deadline);
    if (!client_error) client_error = ReadCellControllerMessage(malformed_client.value, CellControllerMessage::runtime_control_welcome,
      welcome.data(), static_cast<DWORD>(welcome.size()), runtime.stop.value, runtime.deadline);
  }
  if (client_error) SetEvent(runtime.stop.value);
  task.join();
  if (mode == 0 || mode == 7 || mode == 8) {
    Check(!server_error && !client_error && server.Pipe() && client.Pipe() && !server.Verify() && !client.Verify(),
      "Secondary pipe authenticates to the retained primary process with frozen request binding and bounded long lifetime");
    Check(server_owner.admissions >= 3 && client_owner.admissions >= 4, "Both installed-owner composition ports repeatedly check secondary process continuity");
    ControlAdmission admission{dispatch_binding, head};
    CellRuntimeControlChannel sender(runtime.server.value, server.Pipe(), deadline, dispatch_binding, head, 3,
      CellRuntimeControlRole::controller, {server.Guard()});
    CellRuntimeControlChannel responder(runtime.client.value, client.Pipe(), deadline, dispatch_binding, head, 3,
      CellRuntimeControlRole::protected_parent, {client.Guard(), &admission, ControlAdmission::Input, ControlAdmission::Deliver});
    DWORD response = ERROR_SUCCESS;
    std::thread answer([&] { response = responder.Respond(runtime.deadline); });
    const auto grant = sender.Input(dispatch_binding, ControlInput(), runtime.deadline);
    if (grant) SetEvent(runtime.stop.value); answer.join();
    Check(!grant && !response && admission.inputs == 1, "New authenticated endpoint carries actual exact-input control exchange");
    Check(WaitForSingleObject(runtime.stop.value, 0) == WAIT_TIMEOUT, "Handshake and control do not signal the borrowed stop event");
    const auto borrowed = client.Pipe(); DWORD flags = 0;
    client_owner.deny = client_owner.admissions + 1;
    const auto fenced = mode == 7 ? client.OpenClient(runtime.client.value, deadline, client_binding, {}) : client.Verify();
    const DWORD expected_failure = mode == 7 ? ERROR_INVALID_STATE : ERROR_ACCESS_DENIED;
    Check(fenced == expected_failure && !client.Pipe() && GetHandleInformation(borrowed, &flags),
      "Failed custody or repeated setup fences future access while retaining the handle for cancellation and join of borrowed I/O");
    Check(client.OpenClient(runtime.client.value, deadline, client_binding, {}) == fenced && GetHandleInformation(borrowed, &flags),
      "Repeated failed setup cannot close a previously exposed handle before its owner joins borrowed I/O");
    const auto server_borrowed = server.Pipe();
    Check(CellRuntimeControlEndpointTestPeer::Open(server, runtime.server.value, deadline, binding, {}) == ERROR_INVALID_STATE &&
      GetHandleInformation(server_borrowed, &flags), "Repeated server setup also retains the borrowed endpoint until explicit close");
    server.Close(); client.Close();
    Check(!GetHandleInformation(borrowed, &flags) && GetLastError() == ERROR_INVALID_HANDLE,
      "Only the explicit joined-owner close releases a failed endpoint handle");
    received = 0;
    Check(!WriteCellPipe(runtime.client.value, &hello, 1, runtime.stop.value, runtime.deadline) &&
      !ReadCellPipe(runtime.server.value, &received, 1, runtime.stop.value, runtime.deadline) && received == hello,
      "Closing secondary endpoints preserves the original runtime pipe");
  } else {
    Check(server_error && client_error && !server.Pipe() && !client.Pipe(), "Wrong binding, rejected process, reentry and cancellation cannot expose an authenticated pipe");
    const auto calls = client_owner.peers;
    Check(mode >= 9 || client.OpenClient(runtime.client.value, deadline, client_binding, {}) == client_error && client_owner.peers == calls,
      "An uncertain setup failure cannot reconnect or invoke another owner");
    if (mode >= 9) Check(server_owner.admissions == 0, "Malformed secondary hello never reaches the additional-peer admission callback");
  }
  Check(!server.Pipe() && !client.Pipe(), "Closed or failed control endpoints expose no owned handle");
}
void EndpointServerProcessMismatch() {
  Pair runtime; Handle output;
  Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &output.value, 0, FALSE, DUPLICATE_SAME_ACCESS),
    "Retain a non-inheritable duplicate of the real test parent's stdout pipe");
  CellPipeServerEvidence parent, local;
  Check(!parent.Open(output.value) && !local.Open(runtime.client.value), "Observe the real test parent and this native fixture as different pipe servers");
  Check(parent.ProcessId() != local.ProcessId() && parent.VerifySameProcess(local) == ERROR_ACCESS_DENIED && local.VerifySameProcess(parent) == ERROR_ACCESS_DENIED,
    "Same-process admission rejects a live different server process rather than comparing token text");
  Check(!parent.Verify() && !local.Verify(), "Rejected comparison preserves independently retained evidence");
}
}
unsigned RunCellControllerRuntimeTests() {
  for (unsigned mode = 0; mode < 10; ++mode) Exchange(mode);
  Malformed();
  for (unsigned mode = 0; mode < 3; ++mode) Composed(mode);
  Check(fixtures == 13, "Runtime authority uses thirteen actual owned pipe fixtures");
  for (unsigned mode = 0; mode < 9; ++mode) ParentExchange(mode);
  ParentMalformed();
  Check(fixtures == 33, "Parent authority adds twenty actual owned pipe fixtures");
  for (unsigned mode = 0; mode < 17; ++mode) ControlExchange(mode);
  for (unsigned mode = 0; mode < 15; ++mode) MalformedControl(mode);
  ControlEndpoints();
  Check(fixtures == 99, "Dedicated control checks add sixty-six actual owned pipe fixtures");
  for (unsigned mode = 0; mode < 11; ++mode) EndpointExchange(mode);
  EndpointServerProcessMismatch();
  Check(fixtures == 111 && endpoint_pipes == 11, "Endpoint proof uses twelve primary/comparison pipes and eleven separately created control pipes");
  return checks;
}
unsigned CellControllerRuntimeTestPipeCount() { return fixtures + endpoint_pipes; }
