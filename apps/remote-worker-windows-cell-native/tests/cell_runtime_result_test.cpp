#include "cell_runtime_result.hpp"
#include "cell_runtime_file_transfer.hpp"
#include "cell_runtime_client_session.hpp"
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <cstdlib>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0, pipes = 0;
std::string staged_file_hex, staged_result_sha256;
std::string Hex(std::span<const std::uint8_t> bytes) {
  constexpr char digits[] = "0123456789abcdef"; std::string result; result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); }
  return result;
}
void Check(bool passed, const char* message) { ++checks; if (!passed) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct Pair final {
  Handle stop, server, client;
  ULONGLONG deadline = GetTickCount64() + 15000;
  Pair() {
    stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.RuntimeResult.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++pipes);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(stop.value && server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, stop.value, deadline), "Connect task-owned terminal result pipe");
  }
};
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned count = 4) {
  for (unsigned i = 0; i < count; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
CellFileIdentity Identity(unsigned index) {
  CellFileIdentity value; value.volume_serial = 0x77;
  for (unsigned i = 0; i < 4; ++i) value.file_id[3 - i] = static_cast<std::uint8_t>(index >> (8 * i));
  return value;
}
CellRuntimeDispatch Request() {
  CellRuntimeDispatch value; value.binding.nonce.fill(0x99); value.binding.request_sha256.fill(0xaa);
  value.reference.checkpoint_sha256.fill(0xbb); value.reference.anchor.file = Identity(22000);
  value.reference.anchor.prepared_sha256.fill(0xcc); value.command.expected_runtime_bundle.fill(0xdd);
  value.command.protected_workspace.emplace(); auto& roots = value.command.protected_workspace->identities;
  roots.parent = Identity(21000); for (unsigned i = 0; i < 4; ++i) roots.directories[i] = Identity(i + 1);
  value.limits.input_bytes = 100; value.limits.raw_output_bytes = 100000; return value;
}
CellRuntimeDispatchResult Result(const CellRuntimeDispatch& request, unsigned count = 61) {
  CellRuntimeDispatchResult value; value.binding = request.binding; value.binding_verified = true;
  auto& runtime = value.execution.runtime; auto& job = runtime.job;
  runtime.runtime_bundle_verified = true; runtime.runtime_bundle_sha256 = request.command.expected_runtime_bundle; runtime.protected_workspace_verified = true;
  job.end = JobEnd::exited; job.process_exit_code = 23; job.process_id = 777;
  job.zero_processes_verified = job.output_drained = job.quiescent_capture_attempted = job.quiescent_capture_verified = true;
  job.app_container_verified = job.launch_files_verified = job.process_image_verified = job.standard_input_complete = true;
  job.standard_input_bytes_written = 3; job.standard_output.raw_bytes = 3; job.standard_error.raw_bytes = 1;
  job.standard_output.prefix = {0x53, 0x45, 0x43, 0x52, 0x45, 0x54}; job.standard_error.tail = job.standard_output.prefix;
  job.peak_job_memory_bytes = 100000; job.cpu_time_100ns = 23456; job.total_processes = 2; job.sampled_peak_active_processes = 2;
  value.execution.inventory_verified = true; auto& inventory = value.execution.inventory;
  inventory.anchor = request.reference.anchor; inventory.workspace = request.command.protected_workspace->identities;
  inventory.checkpoint_sha256 = request.reference.checkpoint_sha256; inventory.assignment_binding.fill(0xee); inventory.profile_sha256.fill(0xff);
  inventory.inventory.footprint = {inventory.workspace.directories[0], count - 4, count * 4096ULL, count - 4, 4};
  for (unsigned i = 1; i <= count; ++i) inventory.inventory.entries.push_back({Identity(i), i <= 4, i <= 4 ? 0ULL : 1ULL, 4096});
  return value;
}
void StagedFiles() {
  const auto request = Request(); auto value = Result(request);
  CellRuntimeStagedFile file; file.entry = value.execution.inventory.inventory.entries[4]; file.bytes = {42};
  value.execution.staged_files.push_back(std::move(file));
  const auto identity = value.execution.staged_files.front().entry.identity;
  auto copied = value;
  copied.execution.staged_files.front().bytes[0] = 99;
  Check(value.execution.staged_files.front().bytes[0] == 42, "Result copies independently own staged bytes");
  copied = value; copied = copied;
  Check(copied.execution.staged_files.front().bytes[0] == 42, "Result replacement and self-copy preserve exact staged bytes");
  std::vector<std::uint8_t> encoded, terminal;
  Check(!EncodeCellRuntimeStagedFile(request, value, identity, &encoded) && encoded.size() == 201 && encoded.back() == 42 &&
    !std::memcmp(encoded.data(), "GCRFA001", 8), "Encode exact staged content with bounded versioned header");
  Check(!EncodeCellRuntimeResult(request, value, &terminal), "Staged bytes do not alter the canonical metadata encoding");
  CellFileSha256 digest{}; Check(!HashCellRuntimeResult(terminal, &digest) &&
    std::equal(digest.begin(), digest.end(), encoded.begin() + 72), "File envelope binds independently encoded terminal result hash");
  staged_file_hex = Hex(encoded); staged_result_sha256 = Hex(digest);
  Check(std::equal(request.binding.nonce.begin(), request.binding.nonce.end(), encoded.begin() + 8) &&
    std::equal(request.binding.request_sha256.begin(), request.binding.request_sha256.end(), encoded.begin() + 40), "File envelope binds exact native request");
  for (unsigned mode = 0; mode < 7; ++mode) {
    auto altered = value; auto selected = identity;
    if (mode == 0) altered.execution.staged_files.clear();
    if (mode == 1) altered.execution.staged_files.push_back(altered.execution.staged_files.front());
    if (mode == 2) altered.execution.staged_files.front().bytes.push_back(2);
    if (mode == 3) ++altered.execution.staged_files.front().entry.allocated_bytes;
    if (mode == 4) selected.volume_serial ^= 1;
    if (mode == 5) altered.execution.runtime.job.quiescent_capture_verified = false;
    if (mode == 6) altered.binding.request_sha256.back() ^= 1;
    Check(EncodeCellRuntimeStagedFile(request, altered, selected, &encoded) && encoded.empty(),
      "Missing, duplicate, changed or unverified staged content cannot enter file delivery");
  }
  for (const auto size : {0u, 1048576u}) {
    auto bounded = value;
    auto& entry = bounded.execution.inventory.inventory.entries[4]; entry.logical_file_bytes = size;
    bounded.execution.inventory.inventory.footprint.logical_file_bytes += size;
    --bounded.execution.inventory.inventory.footprint.logical_file_bytes;
    auto& staged = bounded.execution.staged_files.front(); staged.entry = entry; staged.bytes.assign(size, 42);
    Check(!EncodeCellRuntimeStagedFile(request, bounded, identity, &encoded) && encoded.size() == 200 + size,
      "Native file encoding includes empty and maximum-size staged content");
    if (!size) Check(Hex(std::span(encoded).subspan(168, 32)) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "Empty native payload has the standard raw SHA256 digest");
  }
}
void FileSelections() {
  auto request = Request(); request.file_staging = CellRuntimeFilePlan{{L"report.txt", L"nested/result.json"}, 1024, 2048};
  auto value = Result(request);
  for (unsigned index = 0; index < 2; ++index) {
    CellRuntimeStagedFile file; file.entry = value.execution.inventory.inventory.entries[4 + index];
    file.bytes = {42}; file.relative_path = request.file_staging->paths[index];
    value.execution.staged_files.push_back(std::move(file));
  }
  std::vector<std::uint8_t> bytes;
  Check(!EncodeCellRuntimeFileSelections(request, value, &bytes) && bytes.size() == 156,
    "Native collection identities encode in exact approved path order");
  auto metadata = value; metadata.execution.staged_files.clear();
  std::vector<CellRuntimeFileSelection> selected;
  Check(!DecodeCellRuntimeFileSelections(request, metadata, bytes, &selected) && selected.size() == 2 &&
    selected[0].relative_path == L"report.txt" && selected[1].relative_path == L"nested/result.json" &&
    selected[0].expected.file.identity == Identity(5) && selected[1].expected.file.identity == Identity(6) &&
    selected[0].expected.maximum_bytes == 1024 && selected[0].expected.result_sha256 == selected[1].expected.result_sha256,
    "Receiver derives exact per-file expectations from separately retained terminal metadata");
  CellRuntimeFileAuthorizationBytes authorization{};
  CellRuntimeFileSelection decoded;
  Check(!EncodeCellRuntimeFileAuthorization(selected.front(), &authorization) &&
    !DecodeCellRuntimeFileAuthorization(request.binding, authorization, &decoded) && decoded.relative_path == selected.front().relative_path &&
    decoded.expected.file.identity == selected.front().expected.file.identity && decoded.expected.maximum_bytes == 1024,
    "Exact file authorization payload round-trips its bounded path, accounting and identities");
  for (unsigned mode = 0; mode < 10; ++mode) {
    auto changed = authorization;
    if (mode == 0) changed.back() = 1;
    if (mode == 1) Put(changed.data() + 100, 0);
    if (mode == 2) Put(changed.data() + 100, 513);
    if (mode == 3) changed[104] = 255;
    if (mode == 4) changed[104] = '/';
    if (mode == 5) Put(changed.data() + 96, 0);
    if (mode == 6) std::fill(changed.begin(), changed.begin() + 32, std::uint8_t{});
    if (mode == 7) std::fill(changed.begin() + 32, changed.begin() + 40, std::uint8_t{});
    if (mode == 8) std::fill(changed.begin() + 80, changed.begin() + 88, std::uint8_t{255});
    if (mode == 9) std::fill(changed.begin() + 88, changed.begin() + 96, std::uint8_t{255});
    Check(DecodeCellRuntimeFileAuthorization(request.binding, changed, &decoded) && decoded.relative_path.empty(),
      "Malformed or unbounded file control payload releases no stale selection");
  }
  for (std::size_t index = 0; index < 108; ++index) {
    auto changed = bytes; changed[index] ^= 1;
    Check(DecodeCellRuntimeFileSelections(request, metadata, changed, &selected) && selected.empty(),
      "Changed selection header cannot replace the independently retained request or result");
  }
  for (unsigned mode = 0; mode < 10; ++mode) {
    auto changed = bytes; auto supplied = request; auto result = metadata;
    if (mode == 0) changed.pop_back();
    if (mode == 1) changed.push_back(0);
    if (mode == 2) std::copy_n(changed.begin() + 108, 24, changed.begin() + 132);
    if (mode == 3) std::fill(changed.begin() + 108, changed.begin() + 132, std::uint8_t{});
    if (mode == 4) supplied.file_staging.reset();
    if (mode == 5) supplied.file_staging->maximum_total_bytes = 1;
    if (mode == 6) supplied.file_staging->maximum_file_bytes = 0;
    if (mode == 7) supplied.file_staging->paths[1] = L"REPORT.TXT";
    if (mode == 8) supplied.file_staging->paths[0] = L"../report.txt";
    if (mode == 9) result.execution.inventory_verified = false;
    Check(DecodeCellRuntimeFileSelections(supplied, result, changed, &selected) && selected.empty(),
      "Malformed, duplicate, unscoped or over-budget selections withhold all expectations");
  }
  for (unsigned mode = 0; mode < 6; ++mode) {
    auto result = value; auto supplied = request;
    if (mode == 0) result.execution.staged_files[0].relative_path = L"other.txt";
    if (mode == 1) std::swap(result.execution.staged_files[0], result.execution.staged_files[1]);
    if (mode == 2) result.execution.staged_files.pop_back();
    if (mode == 3) result.execution.staged_files[1].entry = result.execution.staged_files[0].entry;
    if (mode == 4) result.execution.staged_files[0].bytes.clear();
    if (mode == 5) supplied.file_staging->maximum_total_bytes = 1;
    Check(EncodeCellRuntimeFileSelections(supplied, result, &bytes) && bytes.empty(),
      "Sender cannot label missing, changed, reordered or unapproved native content");
  }
}
void FileTransfer(unsigned mode) {
  Pair pair; const auto request = Request(); auto value = Result(request);
  const unsigned size = mode == 1 ? 1048576 : mode == 2 ? 0 : 1;
  auto& entry = value.execution.inventory.inventory.entries[4]; entry.logical_file_bytes = size;
  value.execution.inventory.inventory.footprint.logical_file_bytes += size;
  --value.execution.inventory.inventory.footprint.logical_file_bytes;
  CellRuntimeStagedFile staged; staged.entry = entry; staged.bytes.assign(size, 42); value.execution.staged_files.push_back(std::move(staged));
  std::vector<std::uint8_t> encoded; Check(!EncodeCellRuntimeStagedFile(request, value, entry.identity, &encoded), "Encode selected transfer fixture");
  const auto exact = encoded;
  CellRuntimeFileExpectation expected;
  Check(!MakeCellRuntimeFileExpectation(request, value, entry.identity, 1048576, &expected), "Derive native file expectation from retained result metadata");
  auto receive = expected; if (mode == 4) receive.result_sha256.back() ^= 1;
  struct Guard final {
    unsigned mode, calls = 0; std::vector<std::uint8_t>* bytes = nullptr;
    static DWORD Authorize(void* raw) noexcept {
      auto& self = *static_cast<Guard*>(raw); ++self.calls;
      if (self.mode == 7 && self.calls == 1) self.bytes->back() ^= 1;
      return self.mode == 3 && self.calls >= 3 ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  } writer_guard{mode == 7 ? 7u : 0u, 0, &encoded}, reader_guard{mode == 3 ? 3u : 0u};
  CellRuntimeFileTransfer writer(pair.client.value, pair.deadline, expected, {Guard::Authorize, &writer_guard, pair.stop.value});
  CellRuntimeFileTransfer reader(pair.server.value, mode == 5 ? GetTickCount64() - 1 : pair.deadline, receive,
    {Guard::Authorize, &reader_guard, pair.stop.value});
  if (mode == 6) encoded.back() ^= 1;
  DWORD sent = ERROR_GEN_FAILURE;
  std::thread sender([&] { sent = writer.Write(encoded); if (sent) SetEvent(pair.stop.value); });
  std::vector<std::uint8_t> received{99}; const auto error = reader.Read(&received);
  if (error) SetEvent(pair.stop.value); sender.join();
  if (mode <= 2 || mode == 7) {
    Check(!error && !sent && received == exact && reader.ValidatedReceipt() && writer.ValidatedReceipt(),
      "Actual private pipe delivers only exact complete file bytes, including empty/max-size and frozen callback input");
  } else Check(error && sent && received.empty() && !reader.ValidatedReceipt() && !writer.ValidatedReceipt(),
    "Revocation, expired authority, substituted result or corrupt payload withholds all file bytes and receipt");
  Check(reader.Read(&received) && received.empty() && writer.Write(exact), "Native file transfer is one-attempt and never silently replays");
}
void FileBatch(unsigned mode) {
  Pair pair; auto request = Request();
  request.file_staging = CellRuntimeFilePlan{{L"report.txt", L"nested/result.json"}, 1048576, 1048576};
  auto value = Result(request);
  for (unsigned index = 0; index < 2; ++index) {
    auto& entry = value.execution.inventory.inventory.entries[4 + index];
    const auto size = mode == 10 ? (index ? 1048576u : 0u) : 1u;
    --value.execution.inventory.inventory.footprint.logical_file_bytes;
    value.execution.inventory.inventory.footprint.logical_file_bytes += size; entry.logical_file_bytes = size;
    CellRuntimeStagedFile file; file.entry = entry; file.bytes.assign(size, 42); file.relative_path = request.file_staging->paths[index];
    value.execution.staged_files.push_back(std::move(file));
  }
  auto metadata = value; metadata.execution.staged_files.clear();
  struct Owner final {
    unsigned mode = 0, second = 0, calls = 0;
    CellRuntimeDispatchResult* mutate = nullptr;
    CellRuntimeFileBatchTransfer* reenter = nullptr;
    static DWORD Peer(void* raw) noexcept {
      auto& self = *static_cast<Owner*>(raw);
      if (self.mode == 4 && self.mutate) {
        self.mutate->execution.inventory_verified = false;
        for (auto& file : self.mutate->execution.staged_files) if (!file.bytes.empty()) file.bytes[0] = 88;
        self.mutate = nullptr;
      }
      return ERROR_SUCCESS;
    }
    static DWORD File(void* raw, const CellRuntimeFileSelection& file, ULONGLONG) noexcept {
      auto& self = *static_cast<Owner*>(raw); ++self.calls;
      if (file.relative_path == L"nested/result.json") ++self.second;
      if (self.mode == 8 && self.reenter) {
        std::vector<CellRuntimeStagedFile> out; self.reenter->Read(*self.mutate, &out); self.reenter = nullptr;
      }
      return self.mode == 2 || self.mode == 3 || (self.mode == 1 && self.second > 1) ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  } sender_owner{mode == 3 || mode == 4 ? mode : 0, 0, 0, &value}, receiver_owner{mode, 0, 0, &metadata};
  if (mode == 9) request.file_staging->maximum_total_bytes = 1;
  CellRuntimeFileBatchTransfer writer(pair.client.value, pair.deadline, request,
    {Owner::Peer, &sender_owner, pair.stop.value}, {&sender_owner, Owner::File});
  CellRuntimeFileBatchTransfer reader(pair.server.value, mode == 6 ? GetTickCount64() - 1 : pair.deadline, request,
    {Owner::Peer, &receiver_owner, pair.stop.value}, {&receiver_owner, mode == 5 ? nullptr : Owner::File});
  if (mode == 8) receiver_owner.reenter = &reader;
  if (mode == 7) SetEvent(pair.stop.value);
  DWORD sent = ERROR_GEN_FAILURE;
  std::thread sender([&] { sent = writer.Write(value); if (sent) SetEvent(pair.stop.value); });
  std::vector<CellRuntimeStagedFile> received(1); received.front().bytes = {99};
  const auto error = reader.Read(metadata, &received);
  if (error) SetEvent(pair.stop.value); sender.join();
  if (mode == 0 || mode == 4 || mode == 10) {
    Check(!error && !sent && reader.ValidatedReceipt() && writer.ValidatedReceipt() && received.size() == 2 &&
      received[0].relative_path == L"report.txt" && received[1].relative_path == L"nested/result.json" &&
      received[0].bytes.size() == (mode == 10 ? 0u : 1u) && received[1].bytes.size() == (mode == 10 ? 1048576u : 1u) &&
      received[1].bytes.front() == 42, "Private pipe delivers the complete approved batch with frozen metadata and content");
  } else Check(error && sent && received.empty() && !reader.ValidatedReceipt() && !writer.ValidatedReceipt(),
    "Batch denial, cancellation, expiry, reentry and missing ownership release no partial content");
  if (mode == 1) Check(receiver_owner.second > 1, "Second-file revocation occurs after first-file receipt and still clears the batch");
  Check(reader.Read(metadata, &received) && received.empty() && writer.Write(value), "File batches never replay an attempted transfer");
}
void MalformedFileTransfer(unsigned mode) {
  Pair pair; const auto request = Request(); const auto result = Result(request);
  CellRuntimeFileExpectation expected; Check(!MakeCellRuntimeFileExpectation(request, result,
    result.execution.inventory.inventory.entries[4].identity, 1024, &expected), "Admit malformed-transfer fixture independently");
  CellRuntimeFileTransfer reader(pair.server.value, pair.deadline, expected,
    {[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, pair.stop.value});
  std::array<std::uint8_t, 112> header{}; std::memcpy(header.data(), "GCFHS001", 8);
  std::copy(expected.binding.nonce.begin(), expected.binding.nonce.end(), header.begin() + 8);
  std::copy(expected.binding.request_sha256.begin(), expected.binding.request_sha256.end(), header.begin() + 40);
  std::fill(header.begin() + 72, header.begin() + 104, std::uint8_t{1}); Put(header.data() + 104, mode == 3 ? 202 : 201); Put(header.data() + 108, 4096);
  std::array<std::uint8_t, 16> chunk{}; std::memcpy(chunk.data(), "GCFHC001", 8); Put(chunk.data() + 8, mode == 0 ? 1 : 0);
  Put(chunk.data() + 12, mode == 1 ? 200 : 201);
  std::thread sender([&] {
    WriteCellPipe(pair.client.value, header.data(), 112, pair.stop.value, pair.deadline);
    WriteCellPipe(pair.client.value, chunk.data(), 16, pair.stop.value, pair.deadline);
    if (mode == 2) { std::array<std::uint8_t, 100> partial{}; WriteCellPipe(pair.client.value, partial.data(), 100, pair.stop.value, pair.deadline); }
    pair.client.Close();
  });
  std::vector<std::uint8_t> output{99}; const auto error = reader.Read(&output);
  SetEvent(pair.stop.value); sender.join();
  Check(error && output.empty() && !reader.ValidatedReceipt(), "Wrong offsets, counts, partial payload and oversized declaration cannot produce a file receipt");
}
void Codec() {
  const auto request = Request(); const auto original = Result(request); std::vector<std::uint8_t> encoded;
  Check(!EncodeCellRuntimeResult(request, original, &encoded), "Encode declared terminal inventory independently of nonzero workload exit");
  Check(encoded.size() == 4608, "Inventory beyond one chunk has the bounded canonical size");
  CellRuntimeDispatchResult decoded;
  Check(!DecodeCellRuntimeResult(request, encoded, &decoded) && decoded.execution.inventory == original.execution.inventory &&
    decoded.execution.runtime.job.process_exit_code == 23 && decoded.execution.runtime.job.standard_output.raw_bytes == 3 &&
    decoded.execution.runtime.job.standard_output.prefix.empty() && decoded.execution.runtime.job.standard_error.tail.empty(),
    "Accounting, failed workload exit and raw stream counters remain separate; raw secret buffers are excluded");
  for (const auto index : {0u, 8u, 40u, 72u, 107u, 108u, 140u, 184u, 216u, 220u, 255u, 256u, 608u, 640u, 660u, 4607u}) {
    auto changed = encoded; changed[index] ^= 0x80; decoded = original;
    Check(DecodeCellRuntimeResult(request, changed, &decoded) != 0 && !decoded.binding_verified && decoded.execution.inventory.inventory.entries.empty(),
      "Substituted binding/head, status, padding, inventory order or identity clears the entire terminal result");
  }
  for (unsigned mode = 0; mode < 8; ++mode) {
    auto value = original; auto expected = request;
    if (mode == 0) value.execution.runtime.job.quiescent_capture_verified = false;
    if (mode == 1) value.execution.runtime.protected_workspace_verified = false;
    if (mode == 2) value.execution.runtime.job.zero_processes_verified = false;
    if (mode == 3) value.execution.runtime.job.quiescent_capture_error = ERROR_ACCESS_DENIED;
    if (mode == 4) value.execution.inventory_verified = false;
    if (mode == 5) expected.reference.inventory_limits.max_entries = 60;
    if (mode == 6) expected.limits.raw_output_bytes = 3;
    if (mode == 7) value.execution.inventory.inventory.entries.back() = value.execution.inventory.inventory.entries.front();
    std::vector<std::uint8_t> refused{1};
    Check(EncodeCellRuntimeResult(expected, value, &refused) != 0 && refused.empty(), "Unverified, over-budget or inconsistent inventory cannot enter result delivery");
  }
  auto failed = original; failed.execution.inventory = {}; failed.execution.inventory_verified = false;
  failed.execution.runtime.job.quiescent_capture_verified = false; failed.execution.runtime.job.quiescent_capture_error = ERROR_ACCESS_DENIED;
  failed.execution.runtime.job.error = ERROR_ACCESS_DENIED; failed.execution.runtime.job.end = JobEnd::control_failed;
  Check(!EncodeCellRuntimeResult(request, failed, &encoded) && encoded.size() == 256 && !DecodeCellRuntimeResult(request, encoded, &decoded) &&
    decoded.execution.runtime.job.error == ERROR_ACCESS_DENIED && !decoded.execution.inventory_verified, "Capture refusal retains failure metadata without inventing inventory");
  auto paired = original; paired.execution.backing_verified = true;
  paired.execution.backing = {1048576, 2097152, 21504, 24576};
  Check(!EncodeCellRuntimeResult(request, paired, &encoded) && encoded.size() == 4608 &&
    !DecodeCellRuntimeResult(request, encoded, &decoded) && decoded.execution.backing_verified &&
    decoded.execution.backing == paired.execution.backing && decoded.execution.runtime.job.process_exit_code == 23,
    "Paired host counts survive canonical encoding with their original inventory and nonzero exit");
  for (unsigned mode = 0; mode < 8; ++mode) {
    auto changed = encoded;
    if (mode == 0) changed[105] &= 0x7f;
    if (mode == 1) changed[104] &= 0xf7;
    if (mode == 2) Put(changed.data() + 220, 0, 8);
    if (mode == 3) Put(changed.data() + 228, 1048575, 8);
    if (mode == 4) Put(changed.data() + 236, 20480, 8);
    if (mode == 5) Put(changed.data() + 244, 65537, 8);
    if (mode == 6) Put(changed.data() + 228, 9007199254740991ULL, 8);
    if (mode == 7) changed[252] = 1;
    decoded = paired;
    Check(DecodeCellRuntimeResult(request, changed, &decoded) != 0 && !decoded.execution.backing_verified &&
      decoded.execution.backing == CellRuntimeBackingCounts{}, "Invalid paired counts or capture flags clear the entire result");
  }
}
struct Authority final {
  unsigned calls = 0, deny_at = 0;
  CellRuntimeDispatchResult* mutate = nullptr;
  CellRuntimeResultTransfer* reenter = nullptr;
  ULONGLONG late = 0;
  static DWORD Check(void* raw) noexcept {
    auto& self = *static_cast<Authority*>(raw); ++self.calls;
    if (self.mutate) { self.mutate->binding.nonce.fill(0); self.mutate->execution.inventory.inventory.entries.clear(); }
    if (self.reenter) { CellRuntimeDispatchResult result; self.reenter->Read(&result); }
    if (self.late) while (GetTickCount64() <= self.late) Sleep(1);
    return self.deny_at && self.calls >= self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
};
void Transfer(unsigned mode) {
  Pair pair; auto request = Request(); auto value = Result(request, mode == 0 ? 20000 : 61);
  value.execution.backing_verified = true; value.execution.backing = {1048576, 2097152, 21504, 24576};
  const auto original = value;
  Authority writer_authority, reader_authority;
  if (mode == 1) reader_authority.deny_at = 1;
  if (mode == 2) reader_authority.deny_at = 5;
  if (mode == 4) writer_authority.mutate = &value;
  auto reader_request = request; if (mode == 3) reader_request.binding.nonce[0] ^= 1;
  auto deadline = pair.deadline;
  if (mode == 5) { deadline = GetTickCount64() + 50; reader_authority.late = deadline; }
  CellFootprintScanGuard writer_guard{Authority::Check, &writer_authority, pair.stop.value};
  CellRuntimeResultTransfer writer(pair.server.value, pair.deadline, request, writer_guard);
  CellRuntimeResultTransfer reader(pair.client.value, deadline, reader_request, {Authority::Check, &reader_authority, pair.stop.value});
  if (mode == 6) reader_authority.reenter = &reader;
  if (mode == 7) { request.binding.nonce.fill(0); reader_request.binding.nonce.fill(0); writer_guard.authorize = nullptr; }
  DWORD sent = 0; CellRuntimeDispatchResult received = original;
  std::jthread sender([&] { sent = writer.Write(value); if (sent) SetEvent(pair.stop.value); });
  const auto error = reader.Read(&received); if (error) SetEvent(pair.stop.value); sender.join();
  if (mode == 0 || mode == 4 || mode == 7) {
    Check(!sent && !error && received.execution.inventory == original.execution.inventory && received.execution.runtime.job.process_exit_code == 23 &&
      received.execution.backing_verified && received.execution.backing == original.execution.backing,
      "Complete inventory and paired host counts cross real private pipes with frozen expected request, owner and result bytes");
    const auto previous = writer_authority.calls + reader_authority.calls;
    Check(writer.Write(value) != 0 && reader.Read(&received) != 0 && writer_authority.calls + reader_authority.calls == previous && !received.binding_verified,
      "Acknowledged result cannot be replayed on the same owner");
  } else {
    Check(error && sent && !received.binding_verified && received.execution.inventory.inventory.entries.empty(), "Authority denial, late callback or binding mismatch withholds all partial result data");
    if (mode == 5) Check(error == ERROR_TIMEOUT, "Late result authority cannot extend its deadline");
    if (mode == 6) Check(error == ERROR_INVALID_STATE && reader_authority.calls == 1, "Ignored reentrant failure fences outer result delivery");
  }
}
void Malformed(unsigned mode) {
  Pair pair; const auto request = Request(); const auto value = Result(request);
  std::vector<std::uint8_t> payload; Check(!EncodeCellRuntimeResult(request, value, &payload), "Prepare malformed result fixture from valid bytes");
  CellFileSha256 digest{}; Check(!HashCellRuntimeResult(payload, &digest), "Hash full terminal fixture");
  std::array<std::uint8_t, 112> header{}; std::memcpy(header.data(), "GCRTS001", 8);
  std::copy(request.binding.nonce.begin(), request.binding.nonce.end(), header.begin() + 8);
  std::copy(request.binding.request_sha256.begin(), request.binding.request_sha256.end(), header.begin() + 40);
  std::copy(digest.begin(), digest.end(), header.begin() + 72); Put(header.data() + 104, payload.size()); Put(header.data() + 108, 4096);
  if (mode == 0) header[72] ^= 1;
  if (mode == 1) Put(header.data() + 104, kMaximumCellRuntimeResultBytes + 1);
  if (mode == 4) header[108] ^= 1;
  std::jthread sender([&] {
    auto error = WriteCellPipe(pair.server.value, header.data(), static_cast<DWORD>(header.size()), pair.stop.value, pair.deadline);
    for (DWORD offset = 0; !error && offset < payload.size();) {
      const auto count = std::min(DWORD{4096}, static_cast<DWORD>(payload.size()) - offset); std::array<std::uint8_t, 16> chunk{};
      std::memcpy(chunk.data(), "GCRTC001", 8); Put(chunk.data() + 8, mode == 2 ? offset + 1 : offset); Put(chunk.data() + 12, count);
      error = WriteCellPipe(pair.server.value, chunk.data(), static_cast<DWORD>(chunk.size()), pair.stop.value, pair.deadline);
      if (!error) error = WriteCellPipe(pair.server.value, payload.data() + offset, mode == 3 ? 1 : count, pair.stop.value, pair.deadline);
      if (mode == 3) { pair.server.Close(); break; } offset += count;
    }
  });
  Authority authority; CellRuntimeResultTransfer reader(pair.client.value, pair.deadline, request, {Authority::Check, &authority, pair.stop.value});
  CellRuntimeDispatchResult received = value; const auto error = reader.Read(&received);
  Check(error && !received.binding_verified && received.execution.inventory.inventory.entries.empty(), "Bad digest, oversized header, chunk offset, truncation or framing never publish a partial result");
  SetEvent(pair.stop.value); sender.join();
}
void RejectAcknowledgment(unsigned mode) {
  Pair pair; const auto request = Request(); const auto value = Result(request);
  Authority authority; CellRuntimeResultTransfer writer(pair.server.value, pair.deadline, request, {Authority::Check, &authority, pair.stop.value});
  DWORD sent = 0;
  std::jthread sender([&] { sent = writer.Write(value); });
  std::array<std::uint8_t, 112> header{};
  auto error = ReadCellPipe(pair.client.value, header.data(), static_cast<DWORD>(header.size()), pair.stop.value, pair.deadline);
  for (DWORD offset = 0; !error && offset < 4608;) {
    std::array<std::uint8_t, 16> chunk{}; std::array<std::uint8_t, 4096> bytes{};
    error = ReadCellPipe(pair.client.value, chunk.data(), static_cast<DWORD>(chunk.size()), pair.stop.value, pair.deadline);
    const auto count = std::min(DWORD{4096}, DWORD{4608} - offset);
    if (!error) error = ReadCellPipe(pair.client.value, bytes.data(), count, pair.stop.value, pair.deadline);
    offset += count;
  }
  std::memcpy(header.data(), "GCRTA002", 8);
  if (mode == 0) header[72] ^= 1;
  if (!error) error = WriteCellPipe(pair.client.value, header.data(), mode ? 17 : static_cast<DWORD>(header.size()), pair.stop.value, pair.deadline);
  if (mode) pair.client.Close();
  if (error) SetEvent(pair.stop.value);
  sender.join();
  Check(!error && sent != 0 && writer.Write(value) != 0, "Wrong terminal digest or truncated receipt cannot acknowledge or replay result delivery");
}
void Retention(unsigned mode) {
  Pair pair; const auto request = Request(); const auto value = Result(request, mode == 0 ? 20000 : 61);
  Authority writer_authority, reader_authority;
  const auto deadline = mode == 3 ? GetTickCount64() + 150 : pair.deadline;
  CellRuntimeResultTransfer writer(pair.server.value, pair.deadline, request, {Authority::Check, &writer_authority, pair.stop.value});
  CellRuntimeResultTransfer reader(pair.client.value, deadline, request, {Authority::Check, &reader_authority, pair.stop.value});
  struct Commit final {
    unsigned calls = 0, mode = 0;
    static DWORD Save(void* raw, const CellRuntimeDispatchBinding&, const CellFileSha256&, const CellRuntimeDispatchResult&,
      const CellFileSha256& digest, CellFileSha256* retained, ULONGLONG deadline) noexcept {
      auto& self = *static_cast<Commit*>(raw); ++self.calls;
      if (self.mode == 3) while (GetTickCount64() <= deadline) Sleep(1);
      *retained = digest; return ERROR_SUCCESS;
    }
  } commit{0, mode};
  DWORD sent = 0; std::jthread sender([&] { sent = writer.Write(value, true); });
  CellRuntimeDispatchResult received; auto error = reader.Read(&received);
  const bool validated = !error && reader.ValidatedReceipt() && !reader.RetentionConfirmed();
  if (!error && mode == 1) ++received.execution.runtime.job.process_id;
  if (!error && mode == 2) {
    std::vector<std::uint8_t> bytes; CellFileSha256 digest{};
    error = EncodeCellRuntimeResult(request, received, &bytes);
    if (!error) error = HashCellRuntimeResult(bytes, &digest);
    std::array<std::uint8_t, 112> ack{}; std::memcpy(ack.data(), "GCRTA003", 8);
    std::copy(request.binding.nonce.begin(), request.binding.nonce.end(), ack.begin() + 8);
    std::copy(request.binding.request_sha256.begin(), request.binding.request_sha256.end(), ack.begin() + 40);
    std::copy(digest.begin(), digest.end(), ack.begin() + 72); ack[72] ^= 1;
    Put(ack.data() + 104, bytes.size()); Put(ack.data() + 108, 4096);
    if (!error) error = WriteCellPipe(pair.client.value, ack.data(), static_cast<DWORD>(ack.size()), pair.stop.value, pair.deadline);
  } else if (!error) error = reader.Retain(received, {&commit, Commit::Save});
  if (error) SetEvent(pair.stop.value);
  sender.join();
  Check(validated, "Receiver validation does not imply protected retention or sender observation before cancellation");
  if (mode == 0) Check(!error && !sent && writer.ValidatedReceipt() && reader.RetentionConfirmed() && reader.RetentionReceiptSent() && writer.RetentionConfirmed() && commit.calls == 1,
    "Complete maximum inventory receives a distinct exact retained-result acknowledgment");
  else {
    Check(sent && !writer.RetentionConfirmed() && !reader.RetentionReceiptSent(), "Changed result, forged retention digest or late commit cannot confirm retention");
    if (mode == 1) Check(commit.calls == 0, "Mutation after validated receipt refuses before any retention callback");
    if (mode == 3) Check(error == ERROR_TIMEOUT && commit.calls == 1, "Late commit remains ambiguous and cannot extend retention deadline");
  }
  const auto calls = commit.calls;
  if (mode != 2) Check(reader.Retain(received, {&commit, Commit::Save}) != 0 && commit.calls == calls, "Successful or uncertain retention cannot be replayed");
}
void ParentBridge(unsigned mode) {
  Pair controller, parent; const auto request = Request(); const auto value = Result(request, 20000);
  std::vector<std::uint8_t> bytes; CellFileSha256 digest{};
  Check(!EncodeCellRuntimeResult(request, value, &bytes) && !HashCellRuntimeResult(bytes, &digest), "Prepare canonical bridge metadata");
  Authority peer; if (mode == 4) peer.deny_at = 1;
  Handle alias;
  if (mode == 3) Check(DuplicateHandle(GetCurrentProcess(), controller.server.value, GetCurrentProcess(), &alias.value, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE,
    "Prepare exact controller-pipe alias for refusal");
  CellRuntimeResultPipeCommitter bridge(controller.server.value, mode == 3 ? alias.value : parent.server.value, request,
    {Authority::Check, &peer, parent.stop.value});
  const auto owner = bridge.Owner(); CellFileSha256 retained{};
  auto proposed = digest; auto head = request.reference.checkpoint_sha256;
  if (mode == 2) proposed[0] ^= 1; if (mode == 5) head[0] ^= 1;
  DWORD error = ERROR_SUCCESS;
  if (mode >= 2) {
    error = owner.commit(owner.context, request.binding, head, value, proposed, &retained, parent.deadline);
    Check(error && retained == CellFileSha256{}, "Wrong digest/head, alias or revoked parent cannot attest retention");
    DWORD available = 0; Check(PeekNamedPipe(parent.client.value, nullptr, 0, nullptr, &available, nullptr) && !available, "Refused parent bridge sends no bytes");
  } else {
    DWORD sent = ERROR_SUCCESS;
    std::thread sender([&] { sent = owner.commit(owner.context, request.binding, head, value, proposed, &retained, parent.deadline); });
    Authority authority; CellRuntimeResultTransfer reader(parent.client.value, parent.deadline, request, {Authority::Check, &authority, parent.stop.value});
    CellRuntimeDispatchResult received; error = reader.Read(&received);
    struct Save final {
      bool wrong = false; unsigned calls = 0;
      static DWORD Commit(void* raw, const CellRuntimeDispatchBinding&, const CellFileSha256&, const CellRuntimeDispatchResult&,
        const CellFileSha256& hash, CellFileSha256* output, ULONGLONG) noexcept {
        auto& self = *static_cast<Save*>(raw); ++self.calls; *output = hash; if (self.wrong) (*output)[0] ^= 1; return ERROR_SUCCESS;
      }
    } save{mode == 1};
    if (!error) error = reader.Retain(received, {&save, Save::Commit});
    if (error) SetEvent(parent.stop.value); sender.join();
    Check(save.calls == 1, "Parent bridge has one retention attempt");
    Check(mode == 0 ? !error && !sent && retained == digest : error && sent && retained == CellFileSha256{},
      "Only the exact distinct retained acknowledgment releases a digest to the controller callback");
  }
  DWORD controller_bytes = 0;
  Check(PeekNamedPipe(controller.client.value, nullptr, 0, nullptr, &controller_bytes, nullptr) && !controller_bytes, "Nested retention never uses the controller pipe");
  const auto calls = peer.calls;
  Check(owner.commit(owner.context, request.binding, head, value, proposed, &retained, parent.deadline) != 0 && peer.calls == calls && retained == CellFileSha256{},
    "Parent bridge cannot replay successful or uncertain retention");
}

std::vector<std::uint8_t> FixtureFile(const wchar_t* path, std::size_t maximum) {
  FILE* file = nullptr; if (_wfopen_s(&file, path, L"rb") || !file) throw std::runtime_error("Open owned bridge fixture");
  std::vector<std::uint8_t> bytes(maximum + 1); const auto count = std::fread(bytes.data(), 1, bytes.size(), file);
  const bool valid = !std::ferror(file) && count <= maximum; std::fclose(file);
  if (!valid) throw std::runtime_error("Bound owned bridge fixture"); bytes.resize(count); return bytes;
}
int ParentBridgeProcess(const wchar_t* pipe_name, const wchar_t* expected_path, const wchar_t* result_path, const wchar_t* parent_pid,
  bool session = false, bool close_after_receipt = false) {
  // Test-only independent admission material and canonical result fixture.
  // No installed custody, service, controller dispatch or OS workload is used.
  const auto material = FixtureFile(expected_path, 324), bytes = FixtureFile(result_path, kMaximumCellRuntimeResultBytes);
  Check(material.size() == 324 && !std::memcmp(material.data(), "GCRBF001", 8), "Read separate bounded bridge expectation");
  auto request = Request(); const auto copy_hash = [&](std::size_t offset, CellFileSha256& out) { std::copy_n(material.begin() + offset, 32, out.begin()); };
  const auto identity = [&](std::size_t offset) {
    CellFileIdentity out{}; for (unsigned i = 0; i < 8; ++i) out.volume_serial |= static_cast<std::uint64_t>(material[offset + i]) << (8 * i);
    std::copy_n(material.begin() + offset + 8, 16, out.file_id.begin()); return out;
  };
  const auto number = [&](std::size_t offset) { DWORD out = 0; for (unsigned i = 0; i < 4; ++i) out |= static_cast<DWORD>(material[offset + i]) << (8 * i); return out; };
  copy_hash(8, request.binding.nonce); copy_hash(40, request.binding.request_sha256); copy_hash(72, request.reference.checkpoint_sha256);
  copy_hash(104, request.command.expected_runtime_bundle); request.reference.anchor.file = identity(136); copy_hash(160, request.reference.anchor.prepared_sha256);
  request.command.protected_workspace->identities.parent = identity(192);
  for (unsigned i = 0; i < 4; ++i) request.command.protected_workspace->identities.directories[i] = identity(216 + i * 24);
  request.limits.input_bytes = number(312); request.limits.raw_output_bytes = number(316); request.reference.inventory_limits.max_entries = number(320);
  CellRuntimeDispatchResult value; CellFileSha256 digest{}, retained{};
  Check(!DecodeCellRuntimeResult(request, bytes, &value) && !HashCellRuntimeResult(bytes, &digest), "Decode independent native bridge fixture");
  Pair controller; Handle parent;
  parent.value = CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
  struct Parent final {
    HANDLE pipe; ULONG process;
    static DWORD Check(void* raw) noexcept { const auto& self = *static_cast<Parent*>(raw); ULONG actual = 0;
      return GetNamedPipeServerProcessId(self.pipe, &actual) && actual == self.process ? ERROR_SUCCESS : ERROR_ACCESS_DENIED; }
  } owner{parent.value, static_cast<ULONG>(_wcstoui64(parent_pid, nullptr, 10))};
  const auto join_parent = [&] {
    // The fixture owns both endpoints until both callback owners finish. A
    // received receipt alone does not join the Node owner's final checks.
    // Node closes its endpoint after its run settles; no protocol byte or
    // production authorization is added by this test-only lifetime barrier.
    std::uint8_t extra = 0;
    const auto closed = ReadCellPipe(parent.value, &extra, 1, controller.stop.value, GetTickCount64() + 15000);
    Check(closed == ERROR_BROKEN_PIPE || closed == ERROR_NO_DATA || closed == ERROR_PIPE_NOT_CONNECTED,
      "Keep the owned fixture endpoint alive until the Node callback owner has settled");
  };
  if (session) {
    CellRuntimeParentConnection connection(controller.server.value, parent.value, GetTickCount64() + 15000, request, {Parent::Check, &owner, controller.stop.value});
    const auto callbacks = connection.Owner(); CellRuntimeInputChunk chunk;
    auto error = callbacks.input(callbacks.context, request.binding, &chunk, controller.deadline);
    if (!error && (!chunk.eof || chunk.count)) error = ERROR_INVALID_DATA;
    if (!error) error = callbacks.runtime.admit(callbacks.runtime.context, request.binding, request.reference.checkpoint_sha256, 1);
    for (const auto stream : {CellRuntimeStream::output, CellRuntimeStream::error}) {
      CellRuntimeStreamFrame frame; frame.stream = stream; frame.eof = true; frame.sequence = 1;
      if (!error) error = callbacks.output(callbacks.context, request.binding, frame, controller.deadline);
    }
    if (!error) error = callbacks.deliver(callbacks.context, request.binding, request.reference.checkpoint_sha256, controller.deadline);
    if (!error) error = callbacks.retention.commit(callbacks.retention.context, request.binding, request.reference.checkpoint_sha256, value, digest, &retained, controller.deadline);
    const bool confirmed = !error && retained == digest;
    if (!error) error = callbacks.deliver(callbacks.context, request.binding, request.reference.checkpoint_sha256, controller.deadline);
    if (!error) {
      CellRuntimeClientSessionResult result;
      result.request_acknowledged = result.input_ended = result.output_ended = result.result_received = true;
      result.retention_attempted = result.retention_confirmed = result.retention_receipt_sent = true; result.execution = value;
      error = connection.Finish(result);
    }
    std::printf("{\"error\":%lu,\"retained\":%s,\"finished\":%s,\"installedService\":false,\"volumeAttached\":false}\n", error, confirmed ? "true" : "false", !error ? "true" : "false");
    std::fflush(stdout); if (!error) join_parent();
    return 0;
  }
  CellRuntimeResultPipeCommitter bridge(controller.server.value, parent.value, request, {Parent::Check, &owner, controller.stop.value});
  const auto retention = bridge.Owner();
  const DWORD error = retention.commit(retention.context, request.binding, request.reference.checkpoint_sha256, value, digest, &retained, GetTickCount64() + 15000);
  const bool confirmed = !error && retained == digest;
  std::printf("{\"error\":%lu,\"retained\":%s,\"installedService\":false,\"volumeAttached\":false}\n", error, confirmed ? "true" : "false");
  std::fflush(stdout); if (confirmed && !close_after_receipt) join_parent();
  return 0;
}
void ParentConnectionRefusals() {
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  const auto request = Request();
  for (unsigned mode = 0; mode < 6; ++mode) {
    struct Guard final {
      unsigned calls = 0; CellRuntimeParentConnection* reenter = nullptr;
      static DWORD Peer(void* raw) noexcept {
        auto& self = *static_cast<Guard*>(raw); ++self.calls;
        if (self.reenter) { const auto owner = self.reenter->Owner(); owner.runtime.peer.authorize(owner.runtime.peer.context); }
        return ERROR_SUCCESS;
      }
    } guard;
    CellRuntimeParentConnection connection(INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE, GetTickCount64() + 10000, request, {Guard::Peer, &guard, stop.value});
    const auto owner = connection.Owner(); CellRuntimeStreamFrame frame; CellRuntimeClientSessionResult result; CellFileSha256 retained{};
    DWORD error = 0;
    if (mode == 0) error = owner.output(owner.context, request.binding, frame, GetTickCount64() + 1000);
    if (mode == 1) error = owner.deliver(owner.context, request.binding, request.reference.checkpoint_sha256, GetTickCount64() + 1000);
    if (mode == 2) error = owner.retention.commit(owner.retention.context, request.binding, request.reference.checkpoint_sha256, {}, {}, &retained, GetTickCount64() + 1000);
    if (mode == 3) error = connection.Finish(result);
    if (mode == 4) error = owner.runtime.admit(owner.runtime.context, request.binding, request.reference.checkpoint_sha256, 1);
    if (mode == 5) { guard.reenter = &connection; error = owner.runtime.peer.authorize(owner.runtime.peer.context); }
    Check(error != 0 && (mode == 5 ? guard.calls == 1 && error == ERROR_BUSY : guard.calls == 0), "Composed owner refuses premature phases, invalid endpoints and reentrant custody");
    const auto calls = guard.calls;
    Check(owner.runtime.peer.authorize(owner.runtime.peer.context) == error && guard.calls == calls, "Any callback failure fences the entire native parent connection");
    Check(WaitForSingleObject(stop.value, 0) == WAIT_TIMEOUT, "Native parent composition never signals borrowed cancellation");
  }
}
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 6 && !std::wcscmp(argv[1], L"--parent-bridge")) return ParentBridgeProcess(argv[2], argv[3], argv[4], argv[5]);
    if (argc == 6 && !std::wcscmp(argv[1], L"--parent-bridge-close")) return ParentBridgeProcess(argv[2], argv[3], argv[4], argv[5], false, true);
    if (argc == 6 && !std::wcscmp(argv[1], L"--parent-session")) return ParentBridgeProcess(argv[2], argv[3], argv[4], argv[5], true);
    if (argc != 1) throw std::runtime_error("Unknown fixture invocation");
    Codec(); StagedFiles(); FileSelections();
    for (unsigned mode = 0; mode < 8; ++mode) FileTransfer(mode);
    for (unsigned mode = 0; mode < 4; ++mode) MalformedFileTransfer(mode);
    for (unsigned mode = 0; mode < 11; ++mode) FileBatch(mode);
    for (unsigned mode = 0; mode < 8; ++mode) Transfer(mode);
    for (unsigned mode = 0; mode < 5; ++mode) Malformed(mode);
    for (unsigned mode = 0; mode < 2; ++mode) RejectAcknowledgment(mode);
    for (unsigned mode = 0; mode < 4; ++mode) Retention(mode);
    for (unsigned mode = 0; mode < 6; ++mode) ParentBridge(mode);
    ParentConnectionRefusals();
    std::printf("{\"passed\":true,\"checks\":%u,\"pipeFixtures\":%u,\"maximumInventoryEntries\":20000,\"installedService\":false,\"volumeAttached\":false,\"stagedFileHex\":\"%s\",\"stagedResultSha256\":\"%s\"}\n",
      checks, pipes, staged_file_hex.c_str(), staged_result_sha256.c_str());
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); return 1; }
}
