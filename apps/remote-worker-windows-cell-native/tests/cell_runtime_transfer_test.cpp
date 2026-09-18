#include "cell_runtime_transfer.hpp"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
std::vector<std::uint8_t> CellRuntimeDispatchGoldenBytes();
unsigned RunCellRuntimeDispatchTests();
unsigned RunCellControllerRuntimeTests();
unsigned CellControllerRuntimeTestPipeCount();
unsigned RunCellRuntimeParentStreamsTests();
unsigned CellRuntimeParentStreamsTestPipeCount();
int RunCellRuntimeParentStreamsInterop(const wchar_t*, DWORD);
namespace {
using Bytes = std::vector<std::uint8_t>;
unsigned checks = 0, fixtures = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { Close(); }
  void Close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct Pair final {
  Handle stop, server, client;
  ULONGLONG deadline = GetTickCount64() + 10000;
  Pair() {
    stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Check(stop.value != nullptr, "Create private transfer cancellation event failed");
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.RuntimeTransfer.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++fixtures);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    Check(server.value != INVALID_HANDLE_VALUE, "Create exclusive task-owned transfer pipe failed");
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(client.value != INVALID_HANDLE_VALUE && ConnectCellPipe(server.value, stop.value, deadline) == 0, "Connect owned transfer pair failed");
  }
};
DWORD U32(const std::uint8_t* bytes) {
  DWORD value = 0; for (unsigned index = 0; index < 4; ++index) value |= static_cast<DWORD>(bytes[index]) << (8 * index); return value;
}
void Put32(std::uint8_t* bytes, DWORD value) {
  for (unsigned index = 0; index < 4; ++index) bytes[index] = static_cast<std::uint8_t>(value >> (8 * index));
}
void Integer(Bytes& bytes, std::uint64_t value, unsigned size = 4) {
  for (unsigned index = 0; index < size; ++index) bytes.push_back(static_cast<std::uint8_t>(value >> (8 * index)));
}
CellRuntimeDispatchBinding Binding(const Bytes& bytes) {
  CellRuntimeDispatchBinding value; value.nonce.fill(0x99);
  Check(HashCellRuntimeDispatch(bytes, &value.request_sha256) == 0, "Hash transfer binding failed"); return value;
}
Bytes Large() {
  auto bytes = CellRuntimeDispatchGoldenBytes();
  std::size_t offset = 156;
  for (unsigned index = 0; index < 6; ++index) offset += 4 + U32(bytes.data() + offset);
  const auto manifest_offset = offset + 32 + 24 + 24;
  offset += 112 + 36;
  const auto environment = U32(bytes.data() + offset); offset += 4;
  for (DWORD index = 0; index < environment; ++index) offset += 4 + U32(bytes.data() + offset);
  const auto count_offset = offset; offset += 4;
  const auto entries_offset = offset;
  offset += 4 + U32(bytes.data() + offset) + 8 + 32;
  Bytes metadata; Integer(metadata, 3001);
  metadata.insert(metadata.end(), bytes.begin() + entries_offset, bytes.begin() + offset);
  CellFileSha256 content{}; content.fill(0xaa);
  std::vector<CellRuntimeBundleFile> files{{L"entry.exe", 3, content}};
  for (unsigned index = 0; index < 3000; ++index) {
    const auto number = std::to_string(index);
    const auto name = "file" + std::string(4 - number.size(), '0') + number + "_" + std::string(114, 'x') + ".dat";
    Integer(metadata, name.size()); metadata.insert(metadata.end(), name.begin(), name.end()); Integer(metadata, 3, 8);
    metadata.insert(metadata.end(), content.begin(), content.end());
    files.push_back({std::wstring(name.begin(), name.end()), 3, content});
  }
  Bytes result(bytes.begin(), bytes.begin() + count_offset);
  result.insert(result.end(), metadata.begin(), metadata.end()); result.insert(result.end(), bytes.begin() + offset, bytes.end());
  CellFileSha256 manifest{};
  Check(HashRuntimeBundleManifest(files, &manifest) == 0, "Large transfer uses an actual valid ordered runtime manifest");
  std::copy(manifest.begin(), manifest.end(), result.begin() + manifest_offset);
  Put32(result.data() + 140, static_cast<DWORD>(result.size() - 144)); Put32(result.data() + 152, static_cast<DWORD>(result.size() - 156));
  Check(result.size() == 513935, "Large transfer must exercise near-limit configuration across 126 chunks");
  return result;
}
struct Authority final {
  unsigned calls = 0, deny_at = 0;
  Bytes* mutate_bytes = nullptr;
  CellRuntimeDispatchBinding* mutate_binding = nullptr;
  static DWORD Check(void* raw) noexcept {
    auto& self = *static_cast<Authority*>(raw); ++self.calls;
    if (self.calls == 1 && self.mutate_bytes) (*self.mutate_bytes)[0] ^= 1;
    if (self.calls == 1 && self.mutate_binding) self.mutate_binding->nonce.back() ^= 1;
    return self.calls == self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
};
void RoundTrip(const Bytes& original, unsigned mode) {
  Pair pair; auto bytes = original; auto expected = Binding(bytes);
  Authority sender, receiver;
  if (mode == 1) sender.mutate_bytes = &bytes;
  if (mode == 2) receiver.mutate_binding = &expected;
  if (mode >= 3 && mode <= 5) receiver.deny_at = mode == 3 ? 1 : mode == 4 ? 4 : 5;
  CellRuntimeTransfer writer(pair.client.value, pair.deadline, expected, {Authority::Check, &sender, pair.stop.value});
  CellRuntimeTransfer reader(pair.server.value, pair.deadline, expected, {Authority::Check, &receiver, pair.stop.value});
  DWORD written = ERROR_INVALID_STATE;
  std::thread client([&] { written = writer.Write(bytes); });
  Bytes received{1, 2, 3};
  CellRuntimeDispatchResult executed;
  DWORD error = 0;
  if (mode == 6) { CellProvisioningJournal empty; executed = reader.Run(empty); error = executed.binding_verified ? 0 : executed.execution.runtime.job.error; }
  else error = reader.Read(&received);
  if (error) SetEvent(pair.stop.value);
  client.join(); SetEvent(pair.stop.value);
  if (mode >= 3 && mode <= 5) Check(error == ERROR_ACCESS_DENIED && received.empty(), "Revocation at transfer boundaries must withhold the complete request");
  else {
    Check(!error && !written, "Bound configuration must cross the actual pipe and validate its transfer ACK");
    if (mode == 6) Check(executed.execution.runtime.job.error == ERROR_INVALID_STATE && !executed.execution.runtime.job.process_id &&
      !executed.execution.inventory_verified, "A transfer ACK cannot stand in for native journal admission or execution completion");
    else Check(received == original, "Transfer must publish exact frozen bytes only after its final checks");
  }
  const auto calls = receiver.calls;
  Check(reader.Read(&received) == ERROR_INVALID_STATE && received.empty() && receiver.calls == calls, "Consumed receiver cannot replay or reauthorize a connection");
  Check(writer.Write(original) == ERROR_INVALID_STATE, "Consumed writer never retries a completed or uncertain transfer");
}
std::array<std::uint8_t, 96> Header(const Bytes& bytes, const CellRuntimeDispatchBinding& binding) {
  std::array<std::uint8_t, 96> header{}; std::memcpy(header.data(), "GCRTX001", 8);
  std::copy(binding.nonce.begin(), binding.nonce.end(), header.begin() + 8);
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), header.begin() + 40);
  Put32(header.data() + 72, static_cast<DWORD>(bytes.size())); Put32(header.data() + 76, 4096); return header;
}
void Malformed(unsigned mode) {
  Pair pair; const auto original = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(original);
  Authority authority; CellRuntimeTransfer reader(pair.server.value, pair.deadline, binding, {Authority::Check, &authority, pair.stop.value});
  std::thread client([&] {
    auto bytes = original; auto header = Header(bytes, binding);
    if (mode == 0) header[8] ^= 1;
    if (mode == 1) header[40] ^= 1;
    if (mode == 2) Put32(header.data() + 72, static_cast<DWORD>(kMaximumRuntimeDispatchBytes + 1));
    if (mode == 3) Put32(header.data() + 76, 8192);
    if (mode == 4) header[80] = 1;
    auto error = WriteCellPipe(pair.client.value, header.data(), static_cast<DWORD>(header.size()), pair.stop.value, pair.deadline);
    std::array<std::uint8_t, 16> chunk{}; std::memcpy(chunk.data(), "GCRTD001", 8); Put32(chunk.data() + 12, static_cast<DWORD>(bytes.size()));
    if (mode == 5) Put32(chunk.data() + 8, 1);
    if (mode == 6) Put32(chunk.data() + 12, static_cast<DWORD>(bytes.size() - 1));
    if (mode == 7) chunk[0] = 'X';
    if (mode == 8) bytes.back() ^= 1;
    if (!error) error = WriteCellPipe(pair.client.value, chunk.data(), static_cast<DWORD>(chunk.size()), pair.stop.value, pair.deadline);
    if (!error) WriteCellPipe(pair.client.value, bytes.data(), static_cast<DWORD>(mode == 9 ? bytes.size() / 2 : bytes.size()), pair.stop.value, pair.deadline);
    if (mode == 9) pair.client.Close();
  });
  Bytes output{1}; const auto error = reader.Read(&output);
  SetEvent(pair.stop.value); client.join();
  Check(error != 0 && output.empty(), "Wrong nonce, digest, bounds, reserved bytes, order, data or truncation cannot publish a request");
}
void BadAck() {
  Pair pair; auto bytes = CellRuntimeDispatchGoldenBytes(); const auto binding = Binding(bytes);
  Authority authority; CellRuntimeTransfer writer(pair.client.value, pair.deadline, binding, {Authority::Check, &authority, pair.stop.value});
  std::thread server([&] {
    Bytes received(bytes.size());
    std::array<std::uint8_t, 96> header{}; std::array<std::uint8_t, 16> chunk{};
    auto error = ReadCellPipe(pair.server.value, header.data(), static_cast<DWORD>(header.size()), pair.stop.value, pair.deadline);
    if (!error) error = ReadCellPipe(pair.server.value, chunk.data(), static_cast<DWORD>(chunk.size()), pair.stop.value, pair.deadline);
    if (!error) error = ReadCellPipe(pair.server.value, received.data(), static_cast<DWORD>(received.size()), pair.stop.value, pair.deadline);
    std::array<std::uint8_t, 80> ack{}; std::copy_n(header.begin(), 80, ack.begin()); std::memcpy(ack.data(), "GCRTA001", 8);
    Put32(ack.data() + 76, 0); ack[40] ^= 1;
    if (!error) WriteCellPipe(pair.server.value, ack.data(), static_cast<DWORD>(ack.size()), pair.stop.value, pair.deadline);
  });
  const auto error = writer.Write(bytes); SetEvent(pair.stop.value); server.join();
  Check(error == ERROR_INVALID_DATA, "Sender refuses an ACK for another bound request");
}
}
int wmain(int argc, wchar_t* argv[]) {
  try {
    if (argc == 4 && std::wstring(argv[1]) == L"--parent-streams") {
      wchar_t* end = nullptr; const auto pid = wcstoul(argv[3], &end, 10);
      if (!pid || !end || *end) return 2;
      return RunCellRuntimeParentStreamsInterop(argv[2], pid);
    }
    if (argc != 1) return 2;
    const auto dispatch_checks = RunCellRuntimeDispatchTests();
    const auto runtime_authority_checks = RunCellControllerRuntimeTests();
    const auto parent_stream_checks = RunCellRuntimeParentStreamsTests();
    const auto small = CellRuntimeDispatchGoldenBytes(); const auto large = Large();
    for (unsigned mode = 0; mode <= 6; ++mode) RoundTrip(small, mode);
    RoundTrip(large, 0); RoundTrip(large, 4);
    for (unsigned mode = 0; mode < 10; ++mode) Malformed(mode);
    BadAck();
    Handle stop{CreateEventW(nullptr, TRUE, TRUE, nullptr)}; Authority authority; const auto binding = Binding(small);
    CellRuntimeTransfer cancelled(INVALID_HANDLE_VALUE, GetTickCount64() + 10000, binding, {Authority::Check, &authority, stop.value});
    Bytes output{1}; Check(cancelled.Read(&output) == ERROR_OPERATION_ABORTED && output.empty() && !authority.calls, "Pre-cancelled transfer refuses before callbacks or I/O");
    ResetEvent(stop.value);
    CellRuntimeTransfer expired(INVALID_HANDLE_VALUE, GetTickCount64(), binding, {Authority::Check, &authority, stop.value});
    Check(expired.Read(&output) == ERROR_TIMEOUT && !authority.calls, "Expired transfer refuses before callbacks or I/O");
    std::printf("{\"passed\":true,\"checks\":%u,\"dispatchChecks\":%u,\"runtimeAuthorityChecks\":%u,\"parentStreamChecks\":%u,\"pipeFixtures\":%u,\"runtimeAuthorityPipeFixtures\":%u,\"parentStreamPipeFixtures\":%u,\"largeBytes\":%zu,\"installedService\":false,\"volumeAttached\":false}\n", checks, dispatch_checks, runtime_authority_checks, parent_stream_checks, fixtures, CellControllerRuntimeTestPipeCount(), CellRuntimeParentStreamsTestPipeCount(), large.size());
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); return 1; }
}
