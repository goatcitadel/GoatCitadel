#include "cell_runtime_client_session.hpp"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
std::vector<std::uint8_t> CellRuntimeDispatchGoldenBytes();
namespace goatcitadel::worker_cell {
struct CellRuntimeControlEndpointTestPeer final {
  static DWORD Open(CellRuntimeControlEndpoint& endpoint, HANDLE pipe, ULONGLONG deadline,
      const CellControllerRuntimeBinding& binding, const CellRuntimeControlEndpointOwner& owner) noexcept {
    // Controlled primary admission and test-user pipe ACL only. Production
    // helper composition, process continuity and all four pipe paths are real.
    return endpoint.OpenServerOwned(pipe, deadline, binding, owner, nullptr);
  }
};
}
namespace {
unsigned checks = 0, pipes = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct Pair final {
  Handle server, client;
  Pair(HANDLE stop, ULONGLONG deadline) {
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.HelperForwarding.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++pipes);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, stop, deadline), "Create exact-owned non-inheritable local pipe pair");
  }
};
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned size = 4) {
  for (unsigned i = 0; i < size; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
DWORD Number(const std::uint8_t* bytes) {
  DWORD value = 0; for (unsigned i = 0; i < 4; ++i) value |= static_cast<DWORD>(bytes[i]) << (8 * i); return value;
}
struct Owner final {
  CellPipeClientEvidence* primary_client = nullptr;
  CellPipeServerEvidence* primary_server = nullptr;
  CellRuntimeHelperForwardingSession* helper = nullptr;
  std::atomic<bool>* issued = nullptr;
  bool reenter = false;
  static DWORD Peer(void* raw) noexcept {
    auto& self = *static_cast<Owner*>(raw);
    if (self.reenter && self.issued->load()) self.helper->Verify();
    return self.primary_client ? self.primary_client->Verify() : self.primary_server->Verify();
  }
  static DWORD Client(void* raw, CellPipeClientEvidence& extra) noexcept { return static_cast<Owner*>(raw)->primary_client->VerifySameProcess(extra); }
  static DWORD Server(void* raw, CellPipeServerEvidence& extra) noexcept { return static_cast<Owner*>(raw)->primary_server->VerifySameProcess(extra); }
};
struct Parent final {
  CellRuntimeDispatch request;
  HANDLE stop;
  unsigned mode;
  std::mutex mutex;
  CellRuntimeStreamFrame issued_frame;
  std::atomic<bool> issued{false}, admitted{false}, output_ended{false}, error_ended{false}, retained{false}, finished{false};
  std::atomic<bool> forwarding_files{false};
  unsigned polls = 0;
  std::atomic<unsigned> input_checks{0}, delivery_checks{0}, commits{0}, file_checks{0};
  CellRuntimeDispatchResult retained_result;
  std::vector<CellRuntimeStagedFile> files;
  CellFileSha256 digest{};
  DWORD result_bytes = 0;
  static DWORD Peer(void* raw) noexcept {
    const auto state = WaitForSingleObject(static_cast<Parent*>(raw)->stop, 0);
    return state == WAIT_TIMEOUT ? ERROR_SUCCESS : ERROR_OPERATION_ABORTED;
  }
  static DWORD Input(void* raw, const CellRuntimeDispatchBinding&, const CellRuntimeStreamFrame& frame, ULONGLONG) noexcept {
    auto& self = *static_cast<Parent*>(raw); std::lock_guard<std::mutex> lock(self.mutex); ++self.input_checks;
    const auto& expected = self.issued_frame;
    if (!self.issued.load() || frame.sequence != expected.sequence || frame.count != expected.count ||
        frame.total != expected.total || frame.eof != expected.eof || frame.data != expected.data) return ERROR_INVALID_DATA;
    if (self.mode == 3) SetEvent(self.stop); // Explicit test-owned cancellation.
    return self.mode == 1 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Delivery(void* raw, const CellRuntimeDispatchBinding&, const CellFileSha256&, ULONGLONG until) noexcept {
    auto& self = *static_cast<Parent*>(raw); ++self.delivery_checks;
    while (!self.admitted.load() || !self.output_ended.load() || !self.error_ended.load()) {
      if (Peer(raw)) return ERROR_OPERATION_ABORTED;
      if (GetTickCount64() >= until) return ERROR_TIMEOUT;
      Sleep(1);
    }
    return self.mode == 2 && self.retained.load() ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Commit(void* raw, const CellRuntimeDispatchBinding&, const CellFileSha256&, const CellRuntimeDispatchResult& result,
      const CellFileSha256& digest, CellFileSha256* retained, ULONGLONG) noexcept {
    auto& self = *static_cast<Parent*>(raw); ++self.commits;
    std::vector<std::uint8_t> bytes;
    const auto error = EncodeCellRuntimeResult(self.request, result, &bytes); if (error) return error;
    self.digest = digest; self.result_bytes = static_cast<DWORD>(bytes.size());
    *retained = digest; self.retained.store(true); return ERROR_SUCCESS;
  }
  static DWORD File(void* raw, const CellRuntimeFileSelection& file, ULONGLONG until) noexcept {
    auto& self = *static_cast<Parent*>(raw); ++self.file_checks;
    if (!self.retained.load() || file.expected.binding.nonce != self.request.binding.nonce ||
        file.expected.binding.request_sha256 != self.request.binding.request_sha256 || file.expected.result_sha256 != self.digest ||
        file.expected.work != self.request.command.protected_workspace->identities.directories[3] ||
        file.relative_path != L"outputs/result.txt" || file.expected.maximum_bytes != 1024 || GetTickCount64() >= until) return ERROR_INVALID_DATA;
    return self.mode == 8 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD ReceiveFile(void* raw, const CellRuntimeFileSelection& file, ULONGLONG until) noexcept {
    // Refuse specifically at the destination, after first-hop receipt. A
    // global revocation could legitimately race the sender's final check.
    if (static_cast<Parent*>(raw)->mode == 10) return ERROR_ACCESS_DENIED;
    return File(raw, file, until);
  }
  DWORD Run(HANDLE pipe, ULONGLONG deadline) {
    for (;;) {
      std::array<std::uint8_t, 16> peek{}; DWORD read = 0;
      while (read < peek.size()) {
        if (WaitForSingleObject(stop, 0) != WAIT_TIMEOUT) return ERROR_OPERATION_ABORTED;
        if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
        if (!PeekNamedPipe(pipe, peek.data(), static_cast<DWORD>(peek.size()), &read, nullptr, nullptr)) return GetLastError();
        if (read < peek.size()) Sleep(1);
      }
      if (!std::memcmp(peek.data(), "GCRTS001", 8)) {
        CellRuntimeResultTransfer transfer(pipe, deadline, request, {Peer, this, stop});
        CellRuntimeDispatchResult result; auto error = transfer.Read(&result);
        if (!error) error = transfer.Retain(result, {this, Commit});
        if (!error) retained_result = std::move(result);
        if (error) return error; continue;
      }
      if (!std::memcmp(peek.data(), "GCFSL001", 8)) {
        if (!retained.load() || !request.file_staging || forwarding_files.exchange(true)) return ERROR_INVALID_STATE;
        CellRuntimeFileBatchTransfer batch(pipe, deadline, request, {Peer, this, stop}, {this, ReceiveFile});
        const auto error = batch.Read(retained_result, &files);
        if (error) return error;
        if (!batch.ValidatedReceipt() || files.size() != 1 || files[0].relative_path != L"outputs/result.txt" ||
            files[0].bytes != std::vector<std::uint8_t>{42}) return ERROR_INVALID_DATA;
        continue;
      }
      if (std::memcmp(peek.data(), "GCCELL01", 8) || Number(peek.data() + 12) > 1056) return ERROR_INVALID_DATA;
      const auto kind = static_cast<CellControllerMessage>(Number(peek.data() + 8));
      const auto count = Number(peek.data() + 12); CellRuntimeStreamBytes bytes{};
      auto error = ReadCellControllerMessage(pipe, kind, bytes.data(), count, stop, deadline); if (error) return error;
      if (kind == CellControllerMessage::runtime_parent_input_poll) {
        if (++polls > 2 || count != 88 || Number(bytes.data() + 64) != polls) return ERROR_INVALID_DATA;
        CellRuntimeParentInputReply reply{}; std::copy_n(bytes.begin(), 88, reply.begin());
        CellRuntimeStreamFrame frame; frame.sequence = polls; frame.total = 3; frame.eof = polls == 2;
        if (!frame.eof) { frame.count = 3; frame.data[0] = 0; frame.data[1] = 255; frame.data[2] = 42; }
        CellRuntimeStreamBytes wire{}; CellControllerMessage frame_kind{};
        if (!EncodeCellRuntimeStream(request.binding, frame, &frame_kind, &wire)) return ERROR_INVALID_DATA;
        { std::lock_guard<std::mutex> lock(mutex); issued_frame = frame; issued.store(true); }
        Put(reply.data() + 88, frame.eof ? 2 : 1); std::copy(wire.begin(), wire.end(), reply.begin() + 92);
        error = WriteCellControllerMessage(pipe, CellControllerMessage::runtime_parent_input_reply, reply.data(), static_cast<DWORD>(reply.size()), stop, deadline);
      } else if (kind == CellControllerMessage::runtime_authority || kind == CellControllerMessage::runtime_delivery_authority) {
        if (kind == CellControllerMessage::runtime_authority) admitted.store(true);
        const auto reply = kind == CellControllerMessage::runtime_authority ? CellControllerMessage::runtime_authorized : CellControllerMessage::runtime_delivery_authorized;
        error = WriteCellControllerMessage(pipe, reply, bytes.data(), count, stop, deadline);
      } else if (kind == CellControllerMessage::runtime_output || kind == CellControllerMessage::runtime_output_end ||
                 kind == CellControllerMessage::runtime_error || kind == CellControllerMessage::runtime_error_end) {
        CellRuntimeStreamFrame frame;
        if (!DecodeCellRuntimeStream(request.binding, kind, bytes, &frame)) return ERROR_INVALID_DATA;
        if (frame.eof) (frame.stream == CellRuntimeStream::output ? output_ended : error_ended).store(true);
        CellRuntimeParentOutputReceipt reply{}; Put(reply.data(), static_cast<std::uint32_t>(kind)); std::copy_n(bytes.begin(), 80, reply.begin() + 4);
        error = WriteCellControllerMessage(pipe, CellControllerMessage::runtime_parent_output_received, reply.data(), static_cast<DWORD>(reply.size()), stop, deadline);
      } else if (kind == CellControllerMessage::runtime_parent_finish) {
        if (!retained.load() || (request.file_staging && files.size() != 1) || count != 100 ||
            !std::equal(digest.begin(), digest.end(), bytes.begin() + 64) || Number(bytes.data() + 96) != result_bytes)
          return ERROR_INVALID_DATA;
        error = WriteCellControllerMessage(pipe, CellControllerMessage::runtime_parent_finished, bytes.data(), count, stop, deadline);
        if (!error) finished.store(true); return error;
      } else return ERROR_INVALID_DATA;
      if (error) return error;
    }
  }
};
void Exchange(unsigned mode) {
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, helper_returned{CreateEventW(nullptr, TRUE, FALSE, nullptr)}, controller_done{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  const auto deadline = GetTickCount64() + (mode == 6 ? 86400000 : 10000);
  const auto io_deadline = GetTickCount64() + 10000;
  Pair runtime(stop.value, io_deadline), parent_runtime(stop.value, io_deadline), parent_control(stop.value, io_deadline);
  auto bytes = CellRuntimeDispatchGoldenBytes();
  if (mode >= 9) {
    bytes[7] = '2';
    const std::string magic = "GCFPLAN1", file = "outputs/result.txt";
    bytes.insert(bytes.end(), magic.begin(), magic.end());
    for (const unsigned value : {1u, 1024u, 1024u, static_cast<unsigned>(file.size())})
      for (unsigned index = 0; index < 4; ++index) bytes.push_back(static_cast<std::uint8_t>(value >> (8 * index)));
    bytes.insert(bytes.end(), file.begin(), file.end());
  }
  CellRuntimeDispatchBinding binding; binding.nonce.fill(0x99);
  Check(!HashCellRuntimeDispatch(bytes, &binding.request_sha256), "Independent helper request hash");
  CellRuntimeDispatch request; Check(!DecodeCellRuntimeDispatch(bytes, binding, &request), "Decode real bounded request fixture");
  const CellControllerRuntimeBinding expected{binding.nonce, binding.request_sha256, request.reference.checkpoint_sha256};
  const std::uint8_t hello = 42; std::uint8_t received = 0;
  Check(!WriteCellPipe(runtime.client.value, &hello, 1, stop.value, io_deadline) && !ReadCellPipe(runtime.server.value, &received, 1, stop.value, io_deadline),
    "Read actual primary identification before retaining client evidence");
  CellPipeClientEvidence primary_client; CellPipeServerEvidence primary_server;
  Check(!primary_client.Open(runtime.server.value) && !primary_server.Open(runtime.client.value), "Retain primary OS process evidence");
  Parent parent{request, stop.value, mode};
  Owner server_owner{&primary_client}, client_owner{nullptr, &primary_server, nullptr, &parent.issued, mode == 7};
  CellRuntimeControlEndpoint control_endpoint;
  CellRuntimeHelperForwardingSession helper; client_owner.helper = &helper;
  DWORD server_error = ERROR_SUCCESS, parent_error = ERROR_SUCCESS, control_error = ERROR_SUCCESS;
  unsigned post_return_checks = 0;
  std::thread parent_task([&] { parent_error = parent.Run(parent_runtime.server.value, io_deadline); if (parent_error) SetEvent(stop.value); });
  std::thread parent_control_task([&] {
    CellRuntimeControlChannel responder(parent_runtime.server.value, parent_control.server.value, deadline, binding,
      expected.checkpoint_sha256, request.limits.input_bytes, CellRuntimeControlRole::protected_parent,
      {{Parent::Peer, &parent, stop.value}, &parent, Parent::Input, Parent::Delivery, Parent::File});
    while (WaitForSingleObject(controller_done.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT) {
      DWORD available = 0;
      if (!PeekNamedPipe(parent_control.server.value, nullptr, 0, nullptr, &available, nullptr)) { control_error = GetLastError(); break; }
      if (!available) { Sleep(1); continue; }
      if (mode == 4) {
        std::array<std::uint8_t, 1168> challenge{};
        control_error = ReadCellControllerMessage(parent_control.server.value, CellControllerMessage::runtime_control_authority,
          challenge.data(), static_cast<DWORD>(challenge.size()), stop.value, io_deadline);
        challenge[32] ^= 1;
        if (!control_error) control_error = WriteCellControllerMessage(parent_control.server.value, CellControllerMessage::runtime_control_authorized,
          challenge.data(), static_cast<DWORD>(challenge.size()), stop.value, io_deadline);
        break;
      }
      control_error = responder.Respond(io_deadline);
      if (control_error) break;
      if (mode == 5) { parent_control.server.Close(); break; }
    }
    if (control_error) SetEvent(stop.value);
  });
  std::thread controller_task([&] {
    server_error = CellRuntimeControlEndpointTestPeer::Open(control_endpoint, runtime.server.value, deadline, expected,
      {{Owner::Peer, &server_owner, stop.value}, &server_owner, Owner::Client});
    CellRuntimeControlChannel control(runtime.server.value, control_endpoint.Pipe(), deadline, binding, expected.checkpoint_sha256,
      request.limits.input_bytes, CellRuntimeControlRole::controller, {control_endpoint.Guard()});
    CellRuntimeTransfer transfer(runtime.server.value, io_deadline, binding, {Owner::Peer, &server_owner, stop.value});
    std::vector<std::uint8_t> transferred;
    if (!server_error) server_error = transfer.Read(&transferred);
    if (!server_error && transferred != bytes) server_error = ERROR_INVALID_DATA;
    for (unsigned sequence = 1; sequence <= 2 && !server_error; ++sequence) {
      const auto kind = sequence == 1 ? CellControllerMessage::runtime_input : CellControllerMessage::runtime_input_end;
      CellRuntimeStreamBytes wire{}; CellRuntimeStreamFrame frame;
      server_error = ReadCellControllerMessage(runtime.server.value, kind, wire.data(), static_cast<DWORD>(wire.size()), stop.value, io_deadline);
      if (!server_error && !DecodeCellRuntimeStream(binding, kind, wire, &frame)) server_error = ERROR_INVALID_DATA;
      if (!server_error) server_error = control.Input(binding, frame, io_deadline);
      if (!server_error && sequence == 1) server_error = control.Input(binding, frame, io_deadline); // Fresh grant for an exact repeated queue attempt.
      if (!server_error) server_error = WriteCellControllerMessage(runtime.server.value, CellControllerMessage::runtime_input_ack, wire.data(), 80, stop.value, io_deadline);
    }
    CellControllerRuntimeAuthority authority(runtime.server.value, deadline, binding, expected.checkpoint_sha256, control_endpoint.Guard());
    if (!server_error) server_error = authority.Check();
    for (const auto stream : {CellRuntimeStream::output, CellRuntimeStream::error}) for (unsigned sequence = 1; sequence <= 2 && !server_error; ++sequence) {
      CellRuntimeStreamFrame frame; frame.stream = stream; frame.sequence = sequence; frame.eof = sequence == 2;
      frame.total = stream == CellRuntimeStream::output ? 3 : 1; frame.count = frame.eof ? 0 : static_cast<DWORD>(frame.total); frame.data[0] = frame.eof ? 0 : 42;
      CellRuntimeStreamBytes wire{}; CellControllerMessage kind{};
      if (!EncodeCellRuntimeStream(binding, frame, &kind, &wire)) server_error = ERROR_INVALID_DATA;
      if (!server_error) server_error = WriteCellControllerMessage(runtime.server.value, kind, wire.data(), static_cast<DWORD>(wire.size()), stop.value, io_deadline);
    }
    struct Delivery final {
      CellRuntimeControlChannel& control; const CellControllerRuntimeBinding& binding; ULONGLONG deadline;
      static DWORD Check(void* raw) noexcept { auto& self = *static_cast<Delivery*>(raw);
        return self.control.Deliver({self.binding.nonce, self.binding.request_sha256}, self.binding.checkpoint_sha256, self.deadline); }
    } delivery{control, expected, io_deadline};
    // Controlled metadata, never an OS job or installed execution claim.
    CellRuntimeDispatchResult value; value.binding = binding; value.binding_verified = true;
    auto& job = value.execution.runtime.job;
    job.end = JobEnd::exited; job.process_id = 777; job.standard_input_complete = true;
    job.zero_processes_verified = job.output_drained = true;
    job.standard_input_bytes_written = 3; job.standard_output.raw_bytes = 3; job.standard_error.raw_bytes = 1;
    if (mode >= 9) {
      // Controlled terminal evidence must satisfy the real inventory codec's
      // prerequisite flags. This fixture does not execute a job or scan files.
      job.app_container_verified = job.launch_files_verified = job.process_image_verified = true;
      job.quiescent_capture_attempted = job.quiescent_capture_verified = true;
      auto& result_runtime = value.execution.runtime;
      result_runtime.runtime_bundle_verified = result_runtime.protected_workspace_verified = true;
      result_runtime.runtime_bundle_sha256 = request.command.expected_runtime_bundle;
      auto& inventory = value.execution.inventory;
      inventory.anchor = request.reference.anchor; inventory.workspace = request.command.protected_workspace->identities;
      inventory.checkpoint_sha256 = request.reference.checkpoint_sha256;
      inventory.assignment_binding.fill(0xee); inventory.profile_sha256.fill(0xff);
      inventory.inventory.footprint = {inventory.workspace.directories[0], 1, 5 * 4096, 1, 4};
      for (const auto& root : inventory.workspace.directories) inventory.inventory.entries.push_back({root, true, 0, 4096});
      auto identity = inventory.workspace.directories[3]; identity.file_id.fill(0x77);
      inventory.inventory.entries.push_back({identity, false, 1, 4096});
      CellRuntimeStagedFile file; file.entry = inventory.inventory.entries.back(); file.relative_path = L"outputs/result.txt"; file.bytes = {42};
      value.execution.staged_files.push_back(std::move(file)); value.execution.inventory_verified = true;
    }
    CellRuntimeResultTransfer terminal(runtime.server.value, io_deadline, request, {Delivery::Check, &delivery, stop.value});
    if (!server_error) server_error = terminal.Write(value, true);
    if (!server_error && request.file_staging) {
      CellRuntimeFileBatchTransfer batch(runtime.server.value, io_deadline, request, {Delivery::Check, &delivery, stop.value},
        {&control, [](void* raw, const CellRuntimeFileSelection& file, ULONGLONG until) noexcept {
          return static_cast<CellRuntimeControlChannel*>(raw)->File(file, until);
        }});
      server_error = batch.Write(value);
      if (!server_error && !batch.ValidatedReceipt()) server_error = ERROR_INVALID_STATE;
    }
    if (!server_error && WaitForSingleObject(helper_returned.value, 3000) != WAIT_OBJECT_0) server_error = ERROR_TIMEOUT;
    if (!server_error) { ++post_return_checks; server_error = Delivery::Check(&delivery); }
    if (!server_error && (mode == 0 || mode == 6 || mode == 8)) {
      CellRuntimeFileSelection file; file.relative_path = L"outputs/result.txt"; file.expected.binding = request.binding;
      file.expected.work = request.command.protected_workspace->identities.directories[3]; file.expected.file.identity = file.expected.work;
      file.expected.file.identity.file_id.fill(0x77); file.expected.file.allocated_bytes = 4096; file.expected.maximum_bytes = 1024;
      std::vector<std::uint8_t> record; server_error = EncodeCellRuntimeResult(request, value, &record);
      if (!server_error) server_error = HashCellRuntimeResult(record, &file.expected.result_sha256);
      if (!server_error) server_error = control.File(file, io_deadline);
    }
    // This controlled outer marker is emitted only after the final control
    // exchange. The production outer protocol separately validates its receipt.
    if (!server_error) server_error = WriteCellPipe(runtime.server.value, "OUTER001", 8, stop.value, io_deadline);
    SetEvent(controller_done.value);
    if (server_error) SetEvent(stop.value);
  });
  auto result = helper.Run(runtime.client.value, parent_runtime.client.value, parent_control.client.value, deadline, expected, bytes,
    {{Owner::Peer, &client_owner, stop.value}, &client_owner, nullptr, Owner::Server});
  SetEvent(helper_returned.value);
  DWORD finish_error = result.error;
  if (!finish_error) {
    std::array<char, 8> outer{};
    finish_error = ReadCellPipe(runtime.client.value, outer.data(), static_cast<DWORD>(outer.size()), stop.value, io_deadline);
    if (!finish_error && std::memcmp(outer.data(), "OUTER001", 8)) finish_error = ERROR_INVALID_DATA;
    if (!finish_error) finish_error = helper.Finish();
  }
  if (finish_error) { helper.Cancel(finish_error); SetEvent(stop.value); }
  controller_task.join(); parent_task.join(); parent_control_task.join();
  if (mode == 0 || mode == 6 || mode == 9) {
    if (result.error || finish_error || server_error || parent_error || control_error || !parent.finished.load())
      std::fprintf(stderr, "mode=%u result=%lu finish=%lu server=%lu parent=%lu control=%lu retained=%u files=%u\n",
        mode, result.error, finish_error, server_error, parent_error, control_error, parent.retained.load() ? 1u : 0u,
        static_cast<unsigned>(parent.files.size()));
    Check(!result.error && !finish_error && !server_error && !parent_error && !control_error && parent.finished.load(), "Four-pipe helper completes runtime and separate control before parent finish");
    Check(result.retention_confirmed && result.retention_receipt_sent && parent.commits == 1 && post_return_checks == 1,
      "Forwarding remains live after Run returns and through the controller's final authorization");
    Check(parent.polls == 2 && parent.input_checks == 3 && parent.delivery_checks >= 5,
      "Repeated input queue checks receive fresh grants without re-reading or replaying source bytes");
    Check(mode == 9 ? parent.file_checks > 2 : parent.file_checks == 1,
      "Helper forwards independent file permissions for both authenticated content hops");
    if (mode == 9) Check(result.files_received && parent.files.size() == 1 && parent.files[0].bytes == std::vector<std::uint8_t>{42},
      "Protected parent receives exact complete content before outer completion");
    Check(WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT, "Successful lifecycle does not signal its borrowed stop event");
  } else {
    Check(finish_error && !parent.finished.load(), "Revocation, changed replies, lost control, cancellation and reentry refuse completion");
    if (mode == 2 || mode == 8 || mode == 10) Check(parent.retained.load() && parent.commits == 1, "Control failure after retention preserves uncertainty without a second commit");
    if (mode == 10) {
      if (!(result.error && result.files_received && result.execution.execution.staged_files.empty() && parent.files.empty()))
        std::fprintf(stderr, "denial result=%lu finish=%lu server=%lu parent=%lu control=%lu received=%u staged=%u parentfiles=%u forwarding=%u\n",
          result.error, finish_error, server_error, parent_error, control_error, result.files_received ? 1u : 0u,
          static_cast<unsigned>(result.execution.execution.staged_files.size()), static_cast<unsigned>(parent.files.size()),
          parent.forwarding_files.load() ? 1u : 0u);
      Check(result.error && result.files_received && result.execution.execution.staged_files.empty() && parent.files.empty(),
        "Second-hop refusal wipes helper content and withholds all parent files after successful first-hop receipt");
    }
    if (mode == 1 || mode == 4 || mode == 5 || mode == 7) Check(parent.commits == 0, "Early control failure cannot reach result retention");
  }
  Check(helper.Run(nullptr, nullptr, nullptr, deadline, expected, bytes, {}).error && parent.commits <= 1,
    "Finished or failed forwarding cannot restart or replay execution");
}
}
int wmain() {
  try {
    for (unsigned mode = 0; mode < 11; ++mode) Exchange(mode);
    std::printf("{\"passed\":true,\"checks\":%u,\"pipePairs\":%u,\"forwardingSessions\":11,\"installedService\":false,\"workloadsRun\":0}\n", checks, pipes);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); return 1; }
}
