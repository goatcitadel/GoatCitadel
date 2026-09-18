#include "cell_runtime_session.hpp"
#include "cell_runtime_client_session.hpp"
#include "appcontainer_fixture.hpp"
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
using namespace goatcitadel::worker_cell_test;
std::vector<std::uint8_t> CellRuntimeDispatchGoldenBytes();
namespace goatcitadel::worker_cell {
// Only tests can replace dispatch. Production Run always enters the original
// native journal runner. Here the request/pipe/session and actual AppContainer
// job are real; journal/runtime-bundle dispatch admission is controlled.
struct CellRuntimeSessionTestPeer final {
  struct Native final {
    JobCommand command;
    unsigned calls = 0, mode = 0;
    unsigned prepares = 0, retains = 0;
    DWORD retained_error = 0;
    bool lose_cleanup_evidence = false;
    static CellRuntimeDispatchResult Dispatch(void* raw, const std::vector<std::uint8_t>& bytes,
      const CellRuntimeDispatchBinding& binding, const CellFootprintScanGuard& guard, JobStdioChannel* channel) noexcept {
      auto& self = *static_cast<Native*>(raw); ++self.calls;
      CellRuntimeDispatch request; CellRuntimeDispatchResult result;
      result.execution.runtime.job.error = DecodeCellRuntimeDispatch(bytes, binding, &request);
      if (result.execution.runtime.job.error) return result;
      result.binding = binding; result.binding_verified = true;
      struct Capture final {
        const CellFootprintScanGuard& guard;
        static DWORD Authorize(void* raw) noexcept { const auto& self = *static_cast<Capture*>(raw); return self.guard.authorize(self.guard.context); }
        static DWORD Observe(void*, const JobQuiescence& job) noexcept { return job.Check(); }
        static void Discard(void*) noexcept {}
      } capture{guard};
      const JobQuiescenceObserver observer{&capture, Capture::Authorize, Capture::Observe, Capture::Discard, 10000, Capture::Authorize};
      result.execution.runtime.job = RunBoundedJob(self.command, request.limits, guard.cancellation, channel, &observer);
      if (self.mode == 12) ++result.execution.runtime.job.standard_output.raw_bytes;
      if (self.mode == 6 || self.mode == 12) {
        CellRuntimeStagedFile file; file.bytes = {42};
        result.execution.staged_files.push_back(std::move(file));
      }
      if (self.mode >= 27) {
        // Real AppContainer job/streams; controlled captured inventory and file
        // bytes exercise session composition without mounting a fixture disk.
        auto& runtime = result.execution.runtime;
        runtime.runtime_bundle_verified = true; runtime.runtime_bundle_sha256 = request.command.expected_runtime_bundle;
        runtime.protected_workspace_verified = true;
        auto& inventory = result.execution.inventory;
        inventory.anchor = request.reference.anchor; inventory.workspace = request.command.protected_workspace->identities;
        inventory.checkpoint_sha256 = request.reference.checkpoint_sha256;
        inventory.assignment_binding.fill(0xee); inventory.profile_sha256.fill(0xff);
        inventory.inventory.footprint = {inventory.workspace.directories[0], 1, 5 * 4096, 1, 4};
        for (const auto& root : inventory.workspace.directories) inventory.inventory.entries.push_back({root, true, 0, 4096});
        auto identity = inventory.workspace.directories[3]; identity.file_id.fill(0x77);
        inventory.inventory.entries.push_back({identity, false, 1, 4096});
        CellRuntimeStagedFile file; file.entry = inventory.inventory.entries.back(); file.relative_path = L"file.txt"; file.bytes = {42};
        result.execution.staged_files.push_back(std::move(file)); result.execution.inventory_verified = true;
      }
      return result;
    }
  };
  static CellRuntimeSessionResult Run(CellRuntimeSession& session, Native& state) {
    return session.RunOwned({&state, Native::Dispatch,
      [](void* raw, const CellRuntimeDispatch&) noexcept -> DWORD {
        auto& self = *static_cast<Native*>(raw); ++self.prepares;
        return self.mode == 23 ? ERROR_DISK_FULL : ERROR_SUCCESS;
      }, [](void* raw, const CellRuntimeDispatchResult&, DWORD error) noexcept -> DWORD {
        auto& self = *static_cast<Native*>(raw); ++self.retains; self.retained_error = error;
        return self.mode == 24 ? ERROR_DISK_FULL : ERROR_SUCCESS;
      }});
  }
};
struct CellRuntimeControlEndpointTestPeer final {
  static DWORD Open(CellRuntimeControlEndpoint& endpoint, HANDLE pipe, ULONGLONG deadline,
      const CellControllerRuntimeBinding& binding, const CellRuntimeControlEndpointOwner& owner) noexcept {
    return endpoint.OpenServerOwned(pipe, deadline, binding, owner, nullptr);
  }
};
struct CellRuntimeControllerConnectionTestPeer final {
  static CellRuntimeSessionResult Run(CellRuntimeControllerConnection& connection, HANDLE pipe, ULONGLONG deadline,
      CellProvisioningJournal& journal, const CellControllerRuntimeBinding& binding, const CellRuntimeControlEndpointOwner& owner,
      CellRuntimeSessionTestPeer::Native& native) {
    return connection.RunOwned(pipe, deadline, journal, binding, owner, {&native,
      [](void*, CellRuntimeControlEndpoint& endpoint, HANDLE primary, ULONGLONG until, const CellControllerRuntimeBinding& expected,
          const CellRuntimeControlEndpointOwner& custody) noexcept { return CellRuntimeControlEndpointTestPeer::Open(endpoint, primary, until, expected, custody); },
      [](void* raw, CellRuntimeSession& session, CellProvisioningJournal& original) noexcept {
        auto& state = *static_cast<CellRuntimeSessionTestPeer::Native*>(raw);
        auto result = state.mode == 1 ? session.Run(original) : CellRuntimeSessionTestPeer::Run(session, state);
        // The real job is already drained; simulate loss of its final proof
        // without leaving a live process behind in the test environment.
        if (state.lose_cleanup_evidence) result.execution.execution.runtime.job.zero_processes_verified = false;
        return result;
      }});
  }
};
}
namespace {
unsigned checks = 0, pipes = 0, actual_jobs = 0;
void Check(bool passed, const char* message) { ++checks; if (!passed) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct Pair final {
  Handle external_stop, client_stop, server, client;
  ULONGLONG deadline = GetTickCount64() + 15000;
  Pair() {
    external_stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); client_stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.RuntimeSession.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++pipes);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(external_stop.value && client_stop.value && server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, client_stop.value, deadline), "Connect independent task-owned cancellation and session pipe handles");
  }
};
JobCommand Command(const std::wstring& image) {
  JobCommand command; wchar_t name[48]{};
  swprintf_s(name, L"gc-cell-%016llx%016llx", static_cast<unsigned long long>(GetCurrentProcessId()), static_cast<unsigned long long>(GetTickCount64()));
  command.job_name = name; command.image = image; command.command_line = L"\"" + image + L"\" duplex-echo";
  command.directory = image.substr(0, image.find_last_of(L'\\'));
  command.app_container_name = PrepareAppContainer(command.job_name, image); BindLaunchFixture(&command);
  wchar_t windows[MAX_PATH]{}; const auto length = GetWindowsDirectoryW(windows, MAX_PATH);
  Check(length && length < MAX_PATH, "Resolve explicit native child SystemRoot"); command.environment.clear();
  for (const auto& entry : {L"SystemRoot=" + std::wstring(windows), L"LOCALAPPDATA=" + command.directory, L"TEMP=" + command.directory, L"TMP=" + command.directory}) {
    command.environment.insert(command.environment.end(), entry.begin(), entry.end()); command.environment.push_back(L'\0');
  }
  command.environment.push_back(L'\0'); return command;
}
void Session(const std::wstring& image, unsigned mode, bool composed = false, bool lose_cleanup_evidence = false) {
  Pair pair;
  auto bytes = CellRuntimeDispatchGoldenBytes();
  if (mode >= 25) {
    bytes[7] = '2';
    const std::string magic = "GCFPLAN1", file = "file.txt";
    bytes.insert(bytes.end(), magic.begin(), magic.end());
    for (const unsigned value : {1u, 1024u, 1024u, 8u})
      for (unsigned index = 0; index < 4; ++index) bytes.push_back(static_cast<std::uint8_t>(value >> (8 * index)));
    bytes.insert(bytes.end(), file.begin(), file.end());
  }
  CellRuntimeDispatchBinding binding; binding.nonce.fill(0x99);
  Check(!HashCellRuntimeDispatch(bytes, &binding.request_sha256), "Retain independent golden request digest before supplying pipe bytes");
  CellRuntimeDispatch request;
  Check(!DecodeCellRuntimeDispatch(bytes, binding, &request), "Decode independent admitted fixture request");
  const auto expected_binding = binding; auto head = request.reference.checkpoint_sha256;
  CellRuntimeSessionTestPeer::Native native{Command(image), 0, mode};
  native.lose_cleanup_evidence = lose_cleanup_evidence;
  struct Owner final {
    Pair& pair;
    CellRuntimeDispatchBinding binding;
    CellFileSha256 head;
    unsigned mode = 0, peer_calls = 0, runtime_calls = 0, input_calls = 0, delivery_calls = 0;
    CellRuntimeSession* session = nullptr;
    CellRuntimeClientSession* client_session = nullptr;
    CellRuntimeClientSessionOwner* client_caller = nullptr;
    std::vector<std::uint8_t>* input = nullptr, *output = nullptr, *error_output = nullptr;
    std::size_t input_offset = 0;
    unsigned source_calls = 0, client_peer_calls = 0, commit_calls = 0;
    static DWORD Peer(void* raw) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.peer_calls;
      if (self.mode == 8) { CellProvisioningJournal unused; self.session->Run(unused); }
      return ERROR_SUCCESS;
    }
    static DWORD ClientPeer(void* raw) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.client_peer_calls;
      if (self.mode == 18) self.client_session->Run({});
      return ERROR_SUCCESS;
    }
    static DWORD Input(void* raw, const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame&, ULONGLONG deadline) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.input_calls;
      return binding.nonce == self.binding.nonce && binding.request_sha256 == self.binding.request_sha256 && GetTickCount64() < deadline ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
    }
    static DWORD Runtime(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, std::uint32_t ordinal) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.runtime_calls;
      if (binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || head != self.head || ordinal != self.runtime_calls) return ERROR_INVALID_DATA;
      // The first grant now precedes durable intent creation; retain the
      // original job-phase failures after that additional admission check.
      if (self.mode == 4 && ordinal == 3) SetEvent(self.pair.external_stop.value); // Test-owned external cancellation.
      if (self.mode == 5 && ordinal == 3) { self.pair.client.Close(); return ERROR_BROKEN_PIPE; }
      return (self.mode == 2 && ordinal == 3) || (self.mode == 3 && ordinal == 4) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Deliver(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, ULONGLONG deadline) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.delivery_calls;
      return self.mode == 6 || binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || head != self.head || GetTickCount64() >= deadline ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Next(void* raw, const CellRuntimeDispatchBinding& binding, CellRuntimeInputChunk* chunk, ULONGLONG deadline) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.source_calls;
      if (binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || GetTickCount64() >= deadline) return ERROR_ACCESS_DENIED;
      if (self.mode == 13) { chunk->count = 1; return ERROR_NO_MORE_ITEMS; }
      if (self.mode == 14) { chunk->count = static_cast<DWORD>(chunk->bytes.size()) + 1; return ERROR_SUCCESS; }
      // Keep the running-revocation fixture waiting for stdin until the next
      // explicit execution grant is denied; elapsed timing must not send EOF.
      if (self.mode == 3 || self.source_calls < 3) return ERROR_NO_MORE_ITEMS;
      Sleep(25);
      chunk->count = static_cast<DWORD>(std::min(chunk->bytes.size(), self.input->size() - self.input_offset)); chunk->eof = chunk->count == 0;
      std::copy_n(self.input->begin() + self.input_offset, chunk->count, chunk->bytes.begin()); self.input_offset += chunk->count;
      return ERROR_SUCCESS;
    }
    static DWORD Output(void* raw, const CellRuntimeDispatchBinding& binding, const CellRuntimeStreamFrame& frame, ULONGLONG deadline) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      if (self.mode == 15 || binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || GetTickCount64() >= deadline) return ERROR_ACCESS_DENIED;
      try {
        auto& target = frame.stream == CellRuntimeStream::output ? *self.output : *self.error_output;
        target.insert(target.end(), frame.data.begin(), frame.data.begin() + frame.count); return ERROR_SUCCESS;
      } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
    }
    static DWORD ClientDelivery(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head, ULONGLONG deadline) noexcept {
      const auto& self = *static_cast<Owner*>(raw);
      return self.mode == 21 || binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || head != self.head || GetTickCount64() >= deadline ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Commit(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
      const CellRuntimeDispatchResult& result, const CellFileSha256& digest, CellFileSha256* retained, ULONGLONG deadline) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.commit_calls;
      if (self.mode == 16 || binding.nonce != self.binding.nonce || binding.request_sha256 != self.binding.request_sha256 || head != self.head ||
          !result.binding_verified || !result.execution.runtime.job.zero_processes_verified || GetTickCount64() >= deadline) return ERROR_ACCESS_DENIED;
      *retained = digest;
      if (self.mode == 17) retained->back() ^= 1;
      if (self.mode == 20) { self.client_caller->retention.commit = nullptr; self.client_caller->deliver = nullptr; }
      if (self.mode == 22) SetEvent(self.pair.client_stop.value); // Cancellation after a possible commit remains ambiguous.
      return ERROR_SUCCESS;
    }
  } owner{pair, binding, head, mode};
  CellRuntimeSessionOwner supplied{{{Owner::Peer, &owner, pair.external_stop.value}, &owner, Owner::Input}, &owner, Owner::Deliver};
  if (mode >= 27) supplied.files = {&owner, [](void* raw, const CellRuntimeFileSelection&, ULONGLONG) noexcept -> DWORD {
    return static_cast<Owner*>(raw)->mode == 29 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }};
  if (mode == 10) head[0] ^= 1;
  if (mode == 11) supplied.channel.input = nullptr;
  const auto deadline = mode == 9 ? GetTickCount64() + 120 : pair.deadline;
  CellRuntimeSession session(pair.server.value, deadline, binding, head, supplied); owner.session = &session;
  if (mode == 7) { supplied.channel.input = nullptr; supplied.deliver = nullptr; supplied.channel.peer.authorize = nullptr; binding.nonce.fill(0); head.fill(0); }
  CellRuntimeSessionResult server_result;
  std::vector<std::uint8_t> input(2000), output, error_output;
  for (std::size_t i = 0; i < input.size(); ++i) input[i] = static_cast<std::uint8_t>(i * 17);
  owner.input = &input; owner.output = &output; owner.error_output = &error_output;
  CellRuntimeClientSessionOwner client_owner{{{Owner::ClientPeer, &owner, pair.client_stop.value}, &owner, Owner::Runtime},
    &owner, Owner::Next, Owner::Output, Owner::ClientDelivery, {&owner, Owner::Commit}};
  if (mode == 19) client_owner.retention.commit = nullptr;
  if (mode >= 26) client_owner.files = {&owner, [](void* raw, const CellRuntimeFileSelection&, ULONGLONG) noexcept -> DWORD {
    return static_cast<Owner*>(raw)->mode == 28 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }};
  CellRuntimeClientSession client_session(pair.client.value, pair.deadline, expected_binding, owner.head, client_owner);
  owner.client_session = &client_session; owner.client_caller = &client_owner;
  if (mode == 7) { client_owner.input = nullptr; client_owner.output = nullptr; client_owner.retention.commit = nullptr; }
  CellRuntimeControllerConnection controller;
  CellRuntimeControlEndpoint control_endpoint;
  CellPipeClientEvidence primary_client; CellPipeServerEvidence primary_server;
  struct Custody final {
    CellPipeClientEvidence* client = nullptr;
    CellPipeServerEvidence* server = nullptr;
    static DWORD Peer(void* raw) noexcept {
      auto& self = *static_cast<Custody*>(raw); return self.client ? self.client->Verify() : self.server->Verify();
    }
    static DWORD Client(void* raw, CellPipeClientEvidence& other) noexcept { return static_cast<Custody*>(raw)->client->VerifySameProcess(other); }
    static DWORD Server(void* raw, CellPipeServerEvidence& other) noexcept { return static_cast<Custody*>(raw)->server->VerifySameProcess(other); }
  } server_custody{&primary_client}, client_custody{nullptr, &primary_server};
  const CellControllerRuntimeBinding runtime_binding{expected_binding.nonce, expected_binding.request_sha256, owner.head};
  if (composed) {
    const std::uint8_t hello = 42; std::uint8_t read = 0;
    Check(!WriteCellPipe(pair.client.value, &hello, 1, pair.client_stop.value, pair.deadline) &&
      !ReadCellPipe(pair.server.value, &read, 1, pair.external_stop.value, pair.deadline) && read == hello &&
      !primary_client.Open(pair.server.value) && !primary_server.Open(pair.client.value), "Retain actual primary process/token evidence before controller setup");
  }
  DWORD outer_error = 0; bool endpoint_after_run = false;
  std::jthread server([&] {
    if (composed) {
      CellProvisioningJournal journal;
      server_result = CellRuntimeControllerConnectionTestPeer::Run(controller, pair.server.value, pair.deadline, journal, runtime_binding,
        {{Custody::Peer, &server_custody, pair.external_stop.value}, &server_custody, Custody::Client}, native);
      if (!server_result.error) {
        endpoint_after_run = controller.Verify() == ERROR_SUCCESS;
        // The real outer protocol validates a receipt and waits for finish.
        // This controlled marker tests the same endpoint lifetime boundary.
        outer_error = WriteCellPipe(pair.server.value, "OUTER001", 8, pair.external_stop.value, pair.deadline);
        std::array<std::uint8_t, 8> finish{};
        if (!outer_error) outer_error = ReadCellPipe(pair.server.value, finish.data(), static_cast<DWORD>(finish.size()), pair.external_stop.value, pair.deadline);
        if (!outer_error && !std::equal(finish.begin(), finish.end(), "FINISH01")) outer_error = ERROR_INVALID_DATA;
        if (!outer_error) outer_error = controller.Verify();
      }
    } else if (mode == 1) { CellProvisioningJournal journal; server_result = session.Run(journal); }
    else server_result = CellRuntimeSessionTestPeer::Run(session, native);
    pair.server.Close(); // Only after Run has joined all owned threads and pipe I/O.
  });
  std::unique_ptr<CellRuntimeControlChannel> control;
  std::atomic<bool> control_done{false}; DWORD control_error = 0;
  std::jthread responder;
  if (composed) {
    const auto opened = control_endpoint.OpenClient(pair.client.value, pair.deadline, runtime_binding,
      {{Custody::Peer, &client_custody, pair.client_stop.value}, &client_custody, nullptr, Custody::Server});
    if (opened) { pair.client.Close(); server.join(); Check(false, "Open independently bound controller secondary endpoint"); }
    control = std::make_unique<CellRuntimeControlChannel>(pair.client.value, control_endpoint.Pipe(), pair.deadline, expected_binding, owner.head,
      request.limits.input_bytes, CellRuntimeControlRole::protected_parent,
      CellRuntimeControlOwner{control_endpoint.Guard(), &owner, Owner::Input, Owner::Deliver});
    responder = std::jthread([&] {
      while (!control_done.load()) {
        DWORD available = 0;
        if (!PeekNamedPipe(control_endpoint.Pipe(), nullptr, 0, nullptr, &available, nullptr)) { control_error = GetLastError(); break; }
        if (available) { control_error = control->Respond(std::min(pair.deadline, GetTickCount64() + 5000)); if (control_error) break; }
        else Sleep(1);
      }
    });
  }
  const auto client_result = client_session.Run(bytes);
  const auto client_error = client_result.error; const auto& received = client_result.execution;
  const auto input_ended = client_result.input_ended, output_ended = client_result.output_ended;
  DWORD finish_error = 0;
  if (composed && !client_error) {
    std::array<std::uint8_t, 8> receipt{};
    finish_error = ReadCellPipe(pair.client.value, receipt.data(), static_cast<DWORD>(receipt.size()), pair.client_stop.value, pair.deadline);
    if (!finish_error && !std::equal(receipt.begin(), receipt.end(), "OUTER001")) finish_error = ERROR_INVALID_DATA;
    // All terminal checks are done before the receipt. Join the control reader
    // before releasing the controller through the outer finish acknowledgement.
    control_done.store(true); responder.join();
    if (!finish_error) finish_error = control_endpoint.Verify();
    if (!finish_error) finish_error = WriteCellPipe(pair.client.value, "FINISH01", 8, pair.client_stop.value, pair.deadline);
  }
  if (client_error) pair.client.Close();
  control_done.store(true); if (responder.joinable()) responder.join();
  server.join();
  if (composed && !client_error) Check(!outer_error && !finish_error && !control_error && endpoint_after_run,
    "Controller endpoint survives runtime return and remains authenticated until explicit outer finish");
  const auto& job = server_result.execution.execution.runtime.job;
  Check(native.prepares <= 1 && native.retains <= 1 && (!native.calls || native.prepares == 1), "Attempt is retained once before dispatch");
  if (native.calls) Check(native.retains == 1 && server_result.dispatch_joined && server_result.local_intent_retained &&
    server_result.local_outcome_retained == (mode != 24), "Every dispatched result is locally retained after join, including cancellation and delivery failure");
  if (mode == 23) Check(!native.calls && !native.retains && !server_result.local_intent_retained && server_result.error == ERROR_DISK_FULL,
    "Failed intent persistence prevents dispatch");
  if (mode == 24) Check(!owner.commit_calls && !server_result.result_acknowledged && server_result.error == ERROR_DISK_FULL,
    "Failed local outcome persistence withholds remote completion");
  if (job.process_id) ++actual_jobs;
  if (composed) Check(controller.RequiresControllerStop() == lose_cleanup_evidence,
    "Controller continuation requires cleanup proof even after successful terminal delivery");
  if (lose_cleanup_evidence) {
    Check(!server_result.error && !client_error && job.process_id && !job.zero_processes_verified &&
      client_result.retention_confirmed, "Lost cleanup evidence stops admission without erasing the delivered result");
    return;
  }
  Check(WaitForSingleObject(pair.external_stop.value, 0) == (mode == 4 ? WAIT_OBJECT_0 : WAIT_TIMEOUT), "Internal completion/failure never signals the caller's cancellation event");
  if (mode == 0 || mode == 7 || mode == 20 || mode == 27) {
    Check(MatchesCellControllerRuntimeResult(runtime_binding, server_result), "Actual completed session satisfies the outer settlement gate");
    auto missing_files = server_result; missing_files.file_selection_requested = true; missing_files.files_acknowledged = false;
    Check(!MatchesCellControllerRuntimeResult(runtime_binding, missing_files), "Terminal metadata cannot substitute for required file-batch receipt");
    auto unretained = server_result; unretained.local_outcome_retained = false;
    Check(!MatchesCellControllerRuntimeResult(runtime_binding, unretained), "Remote retention cannot substitute for local outcome persistence");
    unretained = server_result; unretained.local_intent_retained = false;
    Check(!MatchesCellControllerRuntimeResult(runtime_binding, unretained), "A result without its original durable attempt cannot settle");
    Check(!server_result.error && !client_error && server_result.request_received && server_result.dispatch_started && server_result.dispatch_joined &&
      server_result.output_ended && server_result.result_acknowledged && server_result.result_retention_acknowledged &&
      client_result.retention_confirmed && client_result.retention_receipt_sent && output_ended && input_ended, "Both session owners require exact retained-result receipt after streaming and join");
    const std::string ready = "ready\n"; std::vector<std::uint8_t> expected(ready.begin(), ready.end()); expected.insert(expected.end(), input.begin(), input.end());
    Check(output == expected && error_output == input && received.binding_verified && received.execution.inventory_verified == (mode == 27) &&
      received.execution.runtime.job.process_id == job.process_id && job.zero_processes_verified && job.output_drained && job.quiescent_capture_verified,
      "Actual AppContainer binary output and exact joined-job metadata survive the full session");
    Check(native.calls == 1 && owner.runtime_calls >= 4 && owner.input_calls >= 4 && owner.delivery_calls > 1 && owner.commit_calls == 1,
      "Single dispatch uses fresh runtime/input authority and independent current terminal permission");
  } else {
    Check(server_result.error && client_error && (mode >= 28 || !server_result.result_retention_acknowledged) && !received.binding_verified,
      "Failed session cannot expose partial completion; file refusal preserves separately committed terminal metadata");
    Check(server_result.execution.execution.staged_files.empty(), "Failed session discards provisional staged content after joining its job");
    if (mode == 1) Check(server_result.request_received && !server_result.dispatch_started && !server_result.local_intent_retained && !job.process_id && !native.calls,
      "Production entry refuses the absent original native journal before launching any process");
    if (mode == 2 || mode == 3 || mode == 4 || mode == 5) Check(server_result.dispatch_joined && job.process_id && job.zero_processes_verified && job.output_drained,
      "Approval revocation, caller cancellation or pipe loss cancels and joins only the session's actual job");
    if (mode == 2) Check(!job.standard_output.raw_bytes && !job.standard_error.raw_bytes, "Pre-resume refusal executes no entrypoint output");
    if (mode == 3) Check(!input_ended && job.standard_input_bytes_written < input.size(), "Running revocation precedes input EOF and capture");
    if (mode == 6 || mode == 12) Check(server_result.dispatch_joined && job.zero_processes_verified && job.output_drained &&
      owner.delivery_calls == (mode == 6 ? 1u : 0u), "Delivery refusal or mismatched stream totals cannot publish an otherwise joined job");
    if (mode == 8 || mode == 10 || mode == 11) Check(!server_result.dispatch_started && !native.calls, "Reentrant session, substituted head or missing owner refuses before dispatch");
    if (mode == 25 || mode == 26) Check(!server_result.dispatch_started && !native.calls && !owner.commit_calls && client_result.file_selection_requested,
      "Client or controller without explicit file-delivery ownership refuses a collection request before dispatch");
    if (mode >= 28) Check(server_result.result_retention_acknowledged && client_result.retention_confirmed && !server_result.files_acknowledged &&
      !client_result.files_received && owner.commit_calls == 1, "Per-file denial cannot erase committed terminal truth or expose file bytes");
    if (mode == 9) Check(!server_result.dispatch_started || server_result.dispatch_joined, "Overall deadline cannot release an unjoined dispatch");
    if (mode == 13 || mode == 14 || mode == 15 || mode == 18 || mode == 19 || mode == 21) Check(!owner.commit_calls,
      "Malformed input, refused output/delivery, reentrancy or missing retention never invokes the result committer");
    if (mode == 16 || mode == 17 || mode == 22) Check(server_result.result_acknowledged && client_result.result_received &&
      client_result.retention_attempted && !client_result.retention_receipt_sent && owner.commit_calls == 1,
      "Rejected, mismatched or ambiguously cancelled commit stays distinct from validated receipt and is attempted once");
  }
  if (mode == 27) Check(server_result.files_acknowledged && client_result.files_received && received.execution.staged_files.size() == 1 &&
    received.execution.staged_files[0].relative_path == L"file.txt" && received.execution.staged_files[0].bytes == std::vector<std::uint8_t>{42},
    "Joined native session delivers the approved file batch after terminal retention");
  const auto before = native.calls + owner.peer_calls + owner.delivery_calls;
  CellProvisioningJournal unused;
  const auto replay_error = composed ? controller.Run(INVALID_HANDLE_VALUE, 0, unused, {}, {}).error : session.Run(unused).error;
  Check(replay_error != 0 && before == native.calls + owner.peer_calls + owner.delivery_calls,
    "Completed or failed session cannot be reentered or replayed");
  const auto client_before = owner.client_peer_calls + owner.source_calls + owner.commit_calls;
  Check(client_session.Run(bytes).error != 0 && client_before == owner.client_peer_calls + owner.source_calls + owner.commit_calls,
    "Worker cannot replay a session or uncertain retention through the same owner");
}
}
int wmain(int argc, wchar_t** argv) {
  int result = 1;
  try {
    if (argc != 2) return 2;
    for (unsigned mode = 0; mode < 30; ++mode) Session(argv[1], mode);
    for (unsigned mode = 0; mode < 8; ++mode) Session(argv[1], mode, true);
    Session(argv[1], 0, true, true);
    std::printf("{\"passed\":true,\"checks\":%u,\"pipeFixtures\":%u,\"actualJobs\":%u,\"sessionAttempts\":39,\"controllerConnections\":9,\"installedService\":false,\"volumeAttached\":false}\n", checks, pipes, actual_jobs);
    result = 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); }
  if (!CleanupAppContainers()) return 97;
  return result;
}
