#include "cell_provisioning_journal.hpp"
#include "cell_controller_client_identity.hpp"
#include "cell_controller_client_protocol.hpp"
#include "cell_runtime_client_session.hpp"
#include "cell_runtime_result.hpp"
#include "cell_joined_capacity_wire.hpp"
#include "cell_install_capacity_stdio.hpp"
#include <algorithm>
#include <atomic>
#include <cstring>
#include <mutex>

using namespace goatcitadel::worker_cell;
namespace {
// Direct component mode only creates an unattached backing file. Volume
// operations are forwarded only to the independently installed controller;
// this restricted helper never grants privileges or performs disk operations.
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Deadline final {
  HANDLE finished;
  std::atomic<ULONGLONG> until{GetTickCount64() + 10000};
};
DWORD WINAPI Watch(void* context) noexcept {
  const auto& deadline = *static_cast<Deadline*>(context);
  while (WaitForSingleObject(deadline.finished, 50) == WAIT_TIMEOUT) {
    if (GetTickCount64() >= deadline.until.load()) {
      // A lost parent/blocked pipe or driver is an uncertain outcome. Only this
      // helper is terminated; OS resources and the journal remain for recovery.
      TerminateProcess(GetCurrentProcess(), ERROR_TIMEOUT);
      return ERROR_TIMEOUT;
    }
  }
  return 0;
}
bool Read(void* output, DWORD size) noexcept {
  auto bytes = static_cast<std::uint8_t*>(output);
  while (size) {
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, size, &count, nullptr) || !count) return false;
    bytes += count; size -= count;
  }
  return true;
}
bool Write(const void* input, DWORD size) noexcept {
  auto bytes = static_cast<const std::uint8_t*>(input);
  while (size) {
    DWORD count = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, size, &count, nullptr) || !count) return false;
    bytes += count; size -= count;
  }
  return true;
}
bool End() noexcept {
  std::uint8_t extra = 0;
  DWORD count = 0;
  const bool read = ReadFile(GetStdHandle(STD_INPUT_HANDLE), &extra, 1, &count, nullptr) != FALSE;
  return (read && !count) || (!read && GetLastError() == ERROR_BROKEN_PIPE);
}
std::uint32_t U32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0;
  for (unsigned i = 0; i < 4; ++i) value |= static_cast<std::uint32_t>(bytes[i]) << (8 * i);
  return value;
}
std::uint64_t U64(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0;
  for (unsigned i = 0; i < 8; ++i) value |= static_cast<std::uint64_t>(bytes[i]) << (8 * i);
  return value;
}
void Put32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (unsigned i = 0; i < 4; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
CellFileIdentity Identity(const std::uint8_t* bytes) noexcept {
  CellFileIdentity output{};
  output.volume_serial = U64(bytes);
  std::copy_n(bytes + 8, output.file_id.size(), output.file_id.begin());
  return output;
}
std::wstring Ascii(const std::uint8_t* bytes, std::size_t size) {
  std::wstring output;
  bool padding = false;
  for (std::size_t i = 0; i < size; ++i) {
    if (!bytes[i]) padding = true;
    else if (padding || bytes[i] > 127) return {};
    else output += static_cast<wchar_t>(bytes[i]);
  }
  return output;
}
bool Frame(std::uint8_t kind, const std::uint8_t* bytes, DWORD size) noexcept {
  std::array<std::uint8_t, 5> header{};
  header[0] = kind; Put32(header.data() + 1, size);
  return Write(header.data(), static_cast<DWORD>(header.size())) && Write(bytes, size);
}
struct Sink final { std::uint32_t count = 0, maximum = 5, volume_checks = 0; };
DWORD Commit(void* context, const CellProvisioningRecord& record, CellFileSha256* digest) noexcept {
  auto& sink = *static_cast<Sink*>(context);
  const bool volume = sink.count >= 5;
  const bool format = sink.count >= 11;
  const bool protection = sink.count >= 13;
  const bool mount = sink.count >= 15;
  const bool workspace = sink.count >= 19;
  if (sink.count >= sink.maximum || std::memcmp(record.data(), workspace ? "GCCMWP01" : mount ? "GCCMNV01" : protection ? "GCCPRV01" : format ? "GCCFMT01" : volume ? "GCCVOL01" : "GCCELLP1", 8) ||
      U32(record.data() + 8) != (workspace ? sink.count - 18 : mount ? sink.count - 14 : protection ? sink.count - 12 : format ? sink.count - 10 : volume ? sink.count - 4 : sink.count + 1)) return ERROR_INVALID_DATA;
  if (!Frame(1, record.data(), static_cast<DWORD>(record.size()))) return ERROR_BROKEN_PIPE;
  ++sink.count;
  std::array<std::uint8_t, 41> ack{};
  if (!Read(ack.data(), static_cast<DWORD>(ack.size()))) return ERROR_BROKEN_PIPE;
  if (ack[0] != 3 || U32(ack.data() + 1) != 36 || U32(ack.data() + 5) != sink.count ||
      !std::equal(record.begin() + 992, record.end(), ack.begin() + 9)) return ERROR_INVALID_DATA;
  std::copy_n(ack.begin() + 9, digest->size(), digest->begin());
  return ERROR_SUCCESS;
}
struct ControllerConnection final {
  // Members close in reverse order: borrowed pipe evidence closes first.
  Handle pipe;
  CellControllerServerIdentity identity;
};
DWORD ConnectController(ControllerConnection& connection, Deadline& deadline) noexcept {
  for (;;) {
    const auto now = GetTickCount64(), until = deadline.until.load();
    if (now >= until) return ERROR_TIMEOUT;
    connection.pipe.value = CreateFileW(kCellControllerPipeName, kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (connection.pipe.value != INVALID_HANDLE_VALUE) return connection.identity.Open(connection.pipe.value);
    DWORD error = GetLastError();
    if (error != ERROR_PIPE_BUSY) return error;
    // Connection admission may wait; a request or uncertain write is never
    // retried. The helper's independent watchdog still owns the total budget.
    if (!WaitNamedPipeW(kCellControllerPipeName, static_cast<DWORD>(std::min<ULONGLONG>(100, until - now)))) {
      error = GetLastError();
      if (error != ERROR_SEM_TIMEOUT && error != ERROR_PIPE_BUSY) return error;
    }
  }
}
struct RuntimeHelper final {
  CellRuntimeHelperBootstrap bootstrap;
  std::vector<std::uint8_t> request;
  CellRuntimeDispatch dispatch;
  Handle endpoint;
  Handle control_endpoint;
  CellPipeParentEvidence parent;
  CellPipeParentEvidence control_parent;
  std::mutex custody_mutex;
  ControllerConnection* controller = nullptr;
  bool attempted = false, control_open = false, control_authenticated = false;
  // Declared last so forwarding joins before any borrowed custody/pipe owner
  // is destroyed, including an outer protocol failure after runtime retention.
  CellRuntimeHelperForwardingSession forwarding;
  static DWORD Peer(void* context) noexcept {
    auto& self = *static_cast<RuntimeHelper*>(context);
    try {
      std::lock_guard<std::mutex> lock(self.custody_mutex);
      if (!self.controller) return ERROR_INVALID_STATE;
      DWORD error = self.controller->identity.Verify();
      if (!error) error = self.parent.Verify();
      if (!error && self.control_open) error = self.control_parent.Verify();
      if (!error && self.control_open && (!CompareObjectHandles(self.parent.Process(), self.control_parent.Process()) ||
          CompareObjectHandles(self.parent.RuntimePipe(), self.control_parent.RuntimePipe()))) error = ERROR_ACCESS_DENIED;
      return error;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  static DWORD ControllerControlPeer(void* context, CellPipeServerEvidence& additional) noexcept {
    auto& self = *static_cast<RuntimeHelper*>(context);
    try {
      std::lock_guard<std::mutex> lock(self.custody_mutex);
      return self.controller ? self.controller->identity.VerifyBoundPipe(additional) : ERROR_INVALID_STATE;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  DWORD Verify() noexcept { return attempted ? forwarding.Verify() : Peer(this); }
  DWORD ReadRequest(DWORD wall) {
    CellRuntimeHelperBootstrapBytes bytes{};
    const bool read = Read(bytes.data(), static_cast<DWORD>(bytes.size()));
    DWORD error = read ? DecodeCellRuntimeHelperBootstrap(bytes, &bootstrap) : ERROR_BROKEN_PIPE;
    SecureZeroMemory(bytes.data(), bytes.size());
    if (error) return error;
    request.resize(bootstrap.request_bytes);
    if (!Read(request.data(), static_cast<DWORD>(request.size()))) {
      SecureZeroMemory(bootstrap.secret.data(), bootstrap.secret.size()); return ERROR_BROKEN_PIPE;
    }
    error = DecodeCellRuntimeDispatch(request, {bootstrap.binding.nonce, bootstrap.binding.request_sha256}, &dispatch);
    if (!error && (dispatch.reference.checkpoint_sha256 != bootstrap.binding.checkpoint_sha256 || dispatch.limits.wall_ms > wall))
      error = ERROR_INVALID_DATA;
    if (error) SecureZeroMemory(bootstrap.secret.data(), bootstrap.secret.size());
    return error;
  }
  DWORD ConnectParent(ControllerConnection& connection, HANDLE stop, ULONGLONG deadline) {
    controller = &connection;
    // Each role authenticates once. Keep a separate wiped copy because the
    // first exchange erases its bootstrap secret before performing I/O.
    auto control_bootstrap = bootstrap;
    const auto name = CellRuntimeHelperPipeName(bootstrap.pipe_nonce);
    if (name.empty()) return ERROR_INVALID_DATA;
    endpoint.value = CreateFileW(name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    DWORD error = endpoint.value == INVALID_HANDLE_VALUE ? GetLastError() :
      parent.Open(GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), endpoint.value);
    if (!error) error = AuthenticateCellRuntimeHelperParent(parent, bootstrap, {Peer, this, stop}, deadline);
    else SecureZeroMemory(bootstrap.secret.data(), bootstrap.secret.size());
    if (!error) {
      const auto control_name = CellRuntimeHelperPipeName(bootstrap.pipe_nonce, true);
      control_endpoint.value = CreateFileW(control_name.c_str(), kCellControllerPipeClientAccess, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
      error = control_endpoint.value == INVALID_HANDLE_VALUE ? GetLastError() :
        control_parent.Open(GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), control_endpoint.value);
      control_open = error == ERROR_SUCCESS;
      if (!error) error = AuthenticateCellRuntimeHelperParent(control_parent, control_bootstrap, {Peer, this, stop}, deadline, true);
      control_authenticated = error == ERROR_SUCCESS;
    }
    return error;
  }
  CellRuntimeClientSessionResult Run(HANDLE pipe, HANDLE stop, ULONGLONG deadline, const CellControllerRuntimeBinding& binding) noexcept {
    CellRuntimeClientSessionResult result;
    if (attempted || !control_authenticated || binding != bootstrap.binding || !controller || pipe != controller->pipe.value) {
      result.error = ERROR_INVALID_STATE; return result;
    }
    attempted = true;
    try {
      result.error = Peer(this);
      if (result.error) return result;
      result = forwarding.Run(pipe, parent.RuntimePipe(), control_parent.RuntimePipe(), deadline, binding, request,
        {{Peer, this, stop}, this, nullptr, ControllerControlPeer});
    } catch (...) { result.error = ERROR_NOT_ENOUGH_MEMORY; }
    return result;
  }
};
struct ControllerSink final {
  ControllerConnection& connection;
  Sink sink;
  RuntimeHelper* runtime = nullptr;
  CellRuntimeInstallBinding installation;
  std::uint32_t installation_checks = 0;
  ULONGLONG installation_deadline = 0;
  HANDLE installation_stop = nullptr;
  std::unique_ptr<CellInstallCapacityStdio> installation_capacity;
  static DWORD Attest(void* raw, std::span<const std::uint8_t> request, std::span<std::uint8_t> proof) noexcept {
    auto& sink = *static_cast<ControllerSink*>(raw);
    if (request.size() != 36 || proof.size() != 460) return ERROR_INVALID_PARAMETER;
    auto error = Authorize(raw);
    if (!error) error = WriteCellControllerMessage(sink.connection.pipe.value,
      CellControllerMessage::controller_attestation_challenge, request.data(), 36, sink.installation_stop, sink.installation_deadline);
    if (!error) error = Authorize(raw);
    if (!error) error = ReadCellControllerMessage(sink.connection.pipe.value,
      CellControllerMessage::controller_attestation_proof, proof.data(), 460, sink.installation_stop, sink.installation_deadline);
    return error ? error : Authorize(raw);
  }
  static DWORD Connected(void* context, const CellControllerNonce& nonce) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if (owner.installation_capacity || owner.sink.count || owner.installation_checks) return ERROR_INVALID_STATE;
    try {
      owner.installation_capacity = std::make_unique<CellInstallCapacityStdio>(nonce, owner.installation,
        owner.installation_deadline, CellFootprintScanGuard{Authorize, context, owner.installation_stop},
        CellInstallCapacityStdioTransport{context,
          [](void*, std::uint8_t kind, std::span<const std::uint8_t> bytes) noexcept -> DWORD {
            return Frame(kind, bytes.data(), static_cast<DWORD>(bytes.size())) ? ERROR_SUCCESS : ERROR_BROKEN_PIPE;
          },
          [](void*, std::span<std::uint8_t> bytes) noexcept -> DWORD {
            return Read(bytes.data(), static_cast<DWORD>(bytes.size())) ? ERROR_SUCCESS : ERROR_BROKEN_PIPE;
          },
          Attest});
      return Frame(15, nonce.data(), static_cast<DWORD>(nonce.size())) ? Authorize(context) : ERROR_BROKEN_PIPE;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD ReserveInstallation(void* context, std::span<const std::uint8_t> bytes, const CellInstallCapacityBinding& binding,
    ULONGLONG deadline, std::unique_ptr<CellInstallCapacityReservation>* output) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if (!owner.installation_capacity || owner.sink.count != 21 || !owner.installation_checks) return ERROR_INVALID_STATE;
    const auto admission = owner.installation_capacity->Admission();
    return admission.reserve(admission.context, bytes, binding, deadline, output);
  }
  static DWORD Authorize(void* context) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    return owner.runtime ? owner.runtime->Verify() : owner.connection.identity.Verify();
  }
  static CellRuntimeClientSessionResult Runtime(void* context, HANDLE pipe, HANDLE stop, ULONGLONG deadline,
      const CellControllerRuntimeBinding& binding) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if (owner.runtime) return owner.runtime->Run(pipe, stop, deadline, binding);
    CellRuntimeClientSessionResult result; result.error = ERROR_INVALID_STATE; return result;
  }
  static DWORD Checkpoint(void* context, const CellProvisioningRecord& record, bool acknowledge, CellFileSha256* digest) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if (acknowledge) {
      DWORD error = Commit(&owner.sink, record, digest);
      if (!error && owner.sink.maximum == 5 && owner.sink.count == 5 && !End()) error = ERROR_INVALID_DATA;
      return error;
    }
    if (!Frame(1, record.data(), static_cast<DWORD>(record.size()))) return ERROR_BROKEN_PIPE;
    ++owner.sink.count; return ERROR_SUCCESS;
  }
  static DWORD VolumeAuthority(void* context, std::uint32_t ordinal, std::uint32_t count, const CellFileSha256& head) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if ((owner.sink.maximum != 11 && owner.sink.maximum != 13 && owner.sink.maximum != 15 && owner.sink.maximum != 19 && owner.sink.maximum != 21) ||
        count < 5 || count > owner.sink.maximum || count != owner.sink.count || ordinal != owner.sink.volume_checks + 1 ||
        ordinal > kCellControllerMaximumVolumeChecks) return ERROR_INVALID_DATA;
    std::array<std::uint8_t, 40> challenge{}; Put32(challenge.data(), ordinal); Put32(challenge.data() + 4, count);
    std::copy(head.begin(), head.end(), challenge.begin() + 8);
    if (!Frame(4, challenge.data(), static_cast<DWORD>(challenge.size()))) return ERROR_BROKEN_PIPE;
    std::array<std::uint8_t, 45> reply{};
    if (!Read(reply.data(), static_cast<DWORD>(reply.size()))) return ERROR_BROKEN_PIPE;
    if (reply[0] != 5 || U32(reply.data() + 1) != challenge.size() || !std::equal(challenge.begin(), challenge.end(), reply.begin() + 5)) return ERROR_INVALID_DATA;
    ++owner.sink.volume_checks; return ERROR_SUCCESS;
  }
  static DWORD Receipt(void* context, const std::array<std::uint8_t, 16>& receipt) noexcept {
    const auto& owner = *static_cast<ControllerSink*>(context);
    if (owner.runtime && owner.runtime->attempted) {
      const auto native_error = U32(receipt.data());
      if (native_error) owner.runtime->forwarding.Cancel(native_error);
      else {
        const auto error = owner.runtime->forwarding.Finish();
        if (error) return error;
      }
    }
    if (!Frame(2, receipt.data(), static_cast<DWORD>(receipt.size()))) return ERROR_BROKEN_PIPE;
    // Volume stages still perform current-authority checks after the final
    // checkpoint. The parent closes input only after seeing this receipt.
    if (owner.installation_capacity && !U32(receipt.data())) {
      for (std::uint32_t count = 0; count < 65536; ++count) {
        std::array<std::uint8_t, 5> header{}; DWORD read = 0;
        const bool ok = ReadFile(GetStdHandle(STD_INPUT_HANDLE), header.data(), 1, &read, nullptr) != FALSE;
        if ((ok && !read) || (!ok && GetLastError() == ERROR_BROKEN_PIPE)) return Authorize(context);
        if (!ok || read != 1 || !Read(header.data() + 1, 4) || header[0] != 20 || U32(header.data() + 1) != 36) return ERROR_INVALID_DATA;
        std::array<std::uint8_t, 36> challenge{}; std::array<std::uint8_t, 460> proof{};
        if (!Read(challenge.data(), 36)) return ERROR_BROKEN_PIPE;
        const auto error = Attest(context, challenge, proof);
        if (error) return error;
        if (!Frame(21, proof.data(), 460)) return ERROR_BROKEN_PIPE;
      }
      return ERROR_INVALID_DATA;
    }
    return owner.sink.maximum > 5 && !End() ? ERROR_INVALID_DATA : ERROR_SUCCESS;
  }
  static DWORD Installation(void* context, const CellRuntimeInstallRequest& request, std::uint32_t ordinal) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if (owner.sink.maximum != 21 || owner.sink.count != 21 || ordinal != owner.installation_checks + 1 || ordinal > 65536 ||
        request.binding.nonce != owner.installation.nonce || request.binding.request_sha256 != owner.installation.request_sha256) return ERROR_INVALID_DATA;
    std::array<std::uint8_t, 100> challenge{};
    std::copy(request.binding.nonce.begin(), request.binding.nonce.end(), challenge.begin());
    std::copy(request.binding.request_sha256.begin(), request.binding.request_sha256.end(), challenge.begin() + 32);
    std::copy(request.checkpoint_sha256.begin(), request.checkpoint_sha256.end(), challenge.begin() + 64);
    Put32(challenge.data() + 96, ordinal);
    if (!Frame(10, challenge.data(), static_cast<DWORD>(challenge.size()))) return ERROR_BROKEN_PIPE;
    std::array<std::uint8_t, 105> reply{};
    if (!Read(reply.data(), static_cast<DWORD>(reply.size()))) return ERROR_BROKEN_PIPE;
    if (reply[0] != 11 || U32(reply.data() + 1) != challenge.size() || !std::equal(challenge.begin(), challenge.end(), reply.begin() + 5)) return ERROR_INVALID_DATA;
    ++owner.installation_checks; return Authorize(context);
  }
  static DWORD InstallationOutcome(void* context, const std::array<std::uint8_t, 352>& bytes) noexcept {
    auto& owner = *static_cast<ControllerSink*>(context);
    if (owner.sink.count != 21 || owner.installation_checks < 2) return ERROR_INVALID_STATE;
    if (!Frame(12, bytes.data(), static_cast<DWORD>(bytes.size()))) return ERROR_BROKEN_PIPE;
    std::array<std::uint8_t, 37> reply{};
    if (!Read(reply.data(), static_cast<DWORD>(reply.size()))) return ERROR_BROKEN_PIPE;
    if (reply[0] != 13 || U32(reply.data() + 1) != 32 || !std::equal(bytes.begin() + 320, bytes.end(), reply.begin() + 5)) return ERROR_INVALID_DATA;
    return Authorize(context);
  }
  static DWORD Capacity(void*, const CellControllerNonce& nonce, const CellProvisioningFootprint& observation) noexcept {
    CellControllerCapacityBytes bytes{};
    if (!EncodeCellControllerCapacity(nonce, observation, &bytes)) return ERROR_INVALID_DATA;
    // The parent must retain this frame with the following successful receipt
    // and helper completion; a partial stream never publishes capacity.
    return Frame(6, bytes.data(), static_cast<DWORD>(bytes.size())) ? ERROR_SUCCESS : ERROR_BROKEN_PIPE;
  }
  static DWORD BackingCapacity(void*, const CellControllerNonce& nonce, const CellProvisioningBackingFootprint& observation) noexcept {
    CellControllerBackingCapacityBytes bytes{};
    if (!EncodeCellControllerBackingCapacity(nonce, observation, &bytes)) return ERROR_INVALID_DATA;
    return Frame(7, bytes.data(), static_cast<DWORD>(bytes.size())) ? ERROR_SUCCESS : ERROR_BROKEN_PIPE;
  }
  static DWORD PoolCapacity(void*, const CellControllerNonce& nonce, std::span<const std::uint8_t> bytes) noexcept {
    if (bytes.size() < 1312 || bytes.size() > kCellPoolCapacityResponseMaximumBytes ||
        !std::equal(nonce.begin(), nonce.end(), bytes.begin() + 24)) return ERROR_INVALID_DATA;
    // Released by the native client only after its successful terminal receipt.
    // The parent still requires this frame, its own receipt and helper exit.
    return Frame(14, bytes.data(), static_cast<DWORD>(bytes.size())) ? ERROR_SUCCESS : ERROR_BROKEN_PIPE;
  }
  static DWORD Inventory(void*, const CellControllerNonce& nonce, const CellProvisioningInventory& observation) noexcept {
    if (!ValidateCellControllerInventory(observation)) return ERROR_INVALID_DATA;
    CellControllerCapacityBytes summary{};
    if (!EncodeCellControllerCapacity(nonce, {observation.anchor, observation.assignment_binding, observation.profile_sha256,
        observation.checkpoint_sha256, observation.workspace, observation.inventory.footprint}, &summary)) return ERROR_INVALID_DATA;
    if (!Frame(8, summary.data(), static_cast<DWORD>(summary.size()))) return ERROR_BROKEN_PIPE;
    for (std::size_t start = 0; start < observation.inventory.entries.size(); start += kCellControllerInventoryChunkEntries) {
      CellControllerInventoryChunkBytes chunk{};
      if (!EncodeCellControllerInventoryChunk(nonce, static_cast<std::uint32_t>(start), std::span(observation.inventory.entries).subspan(start,
          std::min(kCellControllerInventoryChunkEntries, observation.inventory.entries.size() - start)), &chunk)) return ERROR_INVALID_DATA;
      if (!Frame(9, chunk.data(), static_cast<DWORD>(chunk.size()))) return ERROR_BROKEN_PIPE;
    }
    return ERROR_SUCCESS;
  }
};
int Run(Deadline& deadline, bool use_controller, bool read_custody) {
  ControllerConnection connection;
  if (use_controller) {
    const DWORD error = connection.identity.Prepare();
    if (error) return static_cast<int>(error);
  }
  if (read_custody) {
    if (!End()) return 2;
    std::vector<std::uint8_t> snapshot;
    const DWORD error = connection.identity.ReadCustodySnapshot(&snapshot);
    if (error) return static_cast<int>(error);
    return Write(snapshot.data(), static_cast<DWORD>(snapshot.size())) ? 0 : 3;
  }
  std::array<std::uint8_t, 20> header{};
  if (!Read(header.data(), static_cast<DWORD>(header.size())) || std::memcmp(header.data(), "GCPROV01", 8)) return 2;
  const auto operation = U32(header.data() + 8), wall = U32(header.data() + 12), path_bytes = U32(header.data() + 16);
  if (!IsCellControllerOperation(operation) || (IsCellControllerVolume(operation) && !use_controller) ||
      (IsCellControllerRuntime(operation) && !use_controller) ||
      wall < 100 || wall > (IsCellControllerRuntime(operation) ? 86400000u : (IsCellControllerCapacity(operation) || IsCellControllerInstall(operation)) ? 60000u : 600000u) || !path_bytes || path_bytes > 8192) return 2;
  deadline.until.store(GetTickCount64() + wall);
  std::array<std::uint8_t, 528> bytes{};
  std::vector<char> encoded(path_bytes);
  if (!Read(bytes.data(), static_cast<DWORD>(bytes.size())) || !Read(encoded.data(), path_bytes) ||
      std::find(encoded.begin(), encoded.end(), '\0') != encoded.end()) return 2;
  const int characters = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, encoded.data(), static_cast<int>(path_bytes), nullptr, 0);
  if (!characters) return 2;
  std::wstring path(static_cast<std::size_t>(characters), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, encoded.data(), static_cast<int>(path_bytes), path.data(), characters) != characters ||
      !IsLiteralCellPath(path)) return 2;
  CellProvisioningPlan plan{};
  std::copy_n(bytes.begin(), 32, plan.assignment_binding.begin());
  std::copy_n(bytes.begin() + 32, 32, plan.profile_sha256.begin());
  std::memcpy(&plan.disk.identifier, bytes.data() + 64, sizeof(plan.disk.identifier));
  plan.disk.virtual_bytes = U64(bytes.data() + 80); plan.disk.reserved_file_bytes = U64(bytes.data() + 88);
  const auto parent_identity = Identity(bytes.data() + 96);
  const auto name = Ascii(bytes.data() + 120, 40), owner = Ascii(bytes.data() + 160, 184), controller = Ascii(bytes.data() + 344, 184);
  if (name.empty() || owner.empty() || controller.empty()) return 2;
  CellProvisioningAnchor anchor{};
  std::array<CellVolumeProvisioningRecord, 6> volume_history{};
  std::array<CellFormatProvisioningRecord, 2> format_history{};
  std::array<CellProtectionProvisioningRecord, 2> protection_history{};
  std::array<CellProvisioningRecord, 5> creation_history{};
  std::array<CellMountProvisioningRecord, 4> mount_history{};
  std::array<CellMountedWorkspaceProvisioningRecord, 2> workspace_history{};
  if (!IsCellControllerCreation(operation)) {
    std::array<std::uint8_t, 56> value{};
    if (!Read(value.data(), static_cast<DWORD>(value.size()))) return 2;
    anchor.file = Identity(value.data());
    std::copy_n(value.begin() + 24, 32, anchor.prepared_sha256.begin());
    if (IsCellControllerVolume(operation) && !Read(volume_history.data(), static_cast<DWORD>(sizeof(volume_history)))) return 2;
    if (IsCellControllerFormat(operation) && !Read(format_history.data(), static_cast<DWORD>(sizeof(format_history)))) return 2;
    if (IsCellControllerProtection(operation) && !Read(protection_history.data(), static_cast<DWORD>(sizeof(protection_history)))) return 2;
    if (IsCellControllerMount(operation) && (!Read(creation_history.data(), static_cast<DWORD>(sizeof(creation_history))) ||
        !Read(mount_history.data(), static_cast<DWORD>(sizeof(mount_history))))) return 2;
    if (IsCellControllerMountedWorkspace(operation) && !Read(workspace_history.data(), static_cast<DWORD>(sizeof(workspace_history)))) return 2;
    if (!IsCellControllerCapacity(operation) && !IsCellControllerRuntime(operation) && !IsCellControllerInstall(operation) && !End()) return 2;
  }
  std::array<std::uint8_t, 416> cleanup_admission{};
  std::vector<std::uint8_t> cleanup_bytes;
  std::vector<std::uint8_t> pool_history;
  std::vector<std::uint8_t> pool_cleanup;
  CellFileSha256 capture_nonce{};
  CellFileSha256 references_sha256{};
  if (IsCellControllerCapacity(operation)) {
    if (!Read(cleanup_admission.data(), 80)) return 2;
    const auto installations = U32(cleanup_admission.data() + 72);
    if (installations > 1 || (installations && !Read(cleanup_admission.data() + 80, 336))) return 2;
    CellRuntimeCleanupAdmission decoded;
    if (DecodeCellRuntimeCleanupAdmission(std::span(cleanup_admission).first(80 + installations * 336), &decoded)) return 2;
    cleanup_bytes.resize(252);
    if (!Read(cleanup_bytes.data(), 252)) return 2;
    const auto count = U32(cleanup_bytes.data() + 248);
    if (count > 1000) return 2;
    cleanup_bytes.resize(252 + count * 108);
    if (count && !Read(cleanup_bytes.data() + 252, count * 108)) return 2;
    CellRuntimeCleanupSet cleanup;
    if (DecodeCellRuntimeCleanup(cleanup_bytes, decoded.binding, &cleanup)) return 2;
    pool_history.resize(kCellControllerPoolHeaderBytes);
    if (!Read(pool_history.data(), static_cast<DWORD>(pool_history.size())) || std::memcmp(pool_history.data(), "GCPPOOL1", 8) ||
        U32(pool_history.data() + 12) != 1) return 2;
    const auto members = U32(pool_history.data() + 8);
    if (!members || members > 64) return 2;
    pool_history.resize(kCellControllerPoolHeaderBytes + members * kCellControllerPoolMemberBytes);
    if (!Read(pool_history.data() + kCellControllerPoolHeaderBytes, members * kCellControllerPoolMemberBytes)) return 2;
    std::array<std::uint8_t, 4> cleanup_size{};
    if (!Read(cleanup_size.data(), static_cast<DWORD>(cleanup_size.size()))) return 2;
    const auto pool_cleanup_bytes = U32(cleanup_size.data());
    if (pool_cleanup_bytes < kCellRuntimePoolCleanupHeaderBytes || pool_cleanup_bytes > kMaximumCellRuntimePoolCleanupBytes) return 2;
    pool_cleanup.resize(pool_cleanup_bytes);
    if (!Read(pool_cleanup.data(), pool_cleanup_bytes)) return 2;
    if (IsCellControllerPoolCapacity(operation) && (!Read(capture_nonce.data(), 32) ||
        std::none_of(capture_nonce.begin(), capture_nonce.end(), [](auto byte) { return byte != 0; }))) return 2;
    if (IsCellControllerInstallCapacity(operation) && (!Read(references_sha256.data(), 32) ||
        std::none_of(references_sha256.begin(), references_sha256.end(), [](auto byte) { return byte != 0; }))) return 2;
  }
  CellRuntimeInstallBinding installation_binding;
  std::array<std::uint8_t, kCellRuntimeInstallBytes> installation_bytes{};
  CellRuntimeInstallRequest installation;
  if (IsCellControllerInstall(operation)) {
    if (!Read(installation_binding.nonce.data(), 32) || !Read(installation_binding.request_sha256.data(), 32) ||
        !Read(installation_bytes.data(), static_cast<DWORD>(installation_bytes.size())) ||
        DecodeCellRuntimeInstall(installation_bytes, installation_binding, &installation) ||
        installation.journal_identity != anchor.file || installation.prepared_sha256 != anchor.prepared_sha256 ||
        !std::equal(installation.checkpoint_sha256.begin(), installation.checkpoint_sha256.end(), workspace_history.back().begin() + 992)) return 2;
  }
  RuntimeHelper runtime;
  if (IsCellControllerRuntime(operation) && runtime.ReadRequest(wall)) return 2;
  if (use_controller) {
    // Paths/principals are fixed installation custody, never configurable
    // service requests. The restricted helper does not open the cells parent.
    if (CompareStringOrdinal(path.c_str(), -1, connection.identity.ParentPath().c_str(), -1, TRUE) != CSTR_EQUAL ||
        parent_identity != connection.identity.ParentIdentity() || owner != L"S-1-5-18" || controller != kCellControllerServiceSid) return 2;
    DWORD error = ConnectController(connection, deadline);
    if (error) return static_cast<int>(error);
    if (IsCellControllerRuntime(operation)) {
      error = runtime.ConnectParent(connection, deadline.finished, deadline.until.load());
      if (error) return static_cast<int>(error);
    }
    CellControllerRequest request;
    request.operation = operation; request.wall_ms = wall; request.cell_name = name;
    request.plan = plan; request.parent = parent_identity; request.anchor = anchor; request.volume_records = volume_history;
    request.format_records = format_history;
    request.protection_records = protection_history;
    request.creation_records = creation_history; request.mount_records = mount_history;
    request.mounted_workspace_records = workspace_history;
    request.cleanup_admission = cleanup_admission;
    request.cleanup_bytes = std::move(cleanup_bytes);
    request.pool_history = std::move(pool_history);
    request.pool_cleanup = std::move(pool_cleanup);
    request.capture_nonce = capture_nonce;
    request.references_sha256 = references_sha256;
    if (IsCellControllerRuntime(operation)) request.runtime = runtime.bootstrap.binding;
    if (IsCellControllerInstall(operation)) {
      request.installation = {installation_binding.nonce, installation_binding.request_sha256, installation.checkpoint_sha256};
      request.installation_bytes = installation_bytes;
    }
    ControllerSink context{connection, {}};
    if (IsCellControllerRuntime(operation)) context.runtime = &runtime;
    if (IsCellControllerInstall(operation)) context.installation = installation_binding;
    context.sink.maximum = CellControllerCheckpointLimit(operation);
    CellControllerClientOwner client{&context, ControllerSink::Authorize, ControllerSink::Checkpoint, ControllerSink::Receipt, ControllerSink::VolumeAuthority};
    client.owner_sid = owner; client.controller_sid = controller;
    client.capacity = ControllerSink::Capacity;
    client.backing_capacity = ControllerSink::BackingCapacity;
    client.inventory = ControllerSink::Inventory;
    client.pool_capacity = ControllerSink::PoolCapacity;
    if (IsCellControllerRuntime(operation)) client.run_runtime = ControllerSink::Runtime;
    if (IsCellControllerInstall(operation)) {
      client.installation_authority = ControllerSink::Installation;
      client.installation_outcome = ControllerSink::InstallationOutcome;
    }
    if (IsCellControllerInstallCapacity(operation)) {
      context.installation_deadline = deadline.until.load(); context.installation_stop = deadline.finished;
      client.connection = ControllerSink::Connected;
      client.installation_capacity = {&context, ControllerSink::ReserveInstallation};
    }
    error = RunCellControllerClientSession(connection.pipe.value, deadline.finished, deadline.until.load(), request, client);
    return error ? 3 : 0;
  }
  Handle parent{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  DWORD error = parent.value == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  CellProvisioningJournal journal;
  Sink sink;
  bool attempted = false;
  if (!error && operation == 1) {
    CellProvisioningCommitter committer{Commit, &sink};
    attempted = true;
    error = journal.Create(parent.value, parent_identity, name, owner, controller, plan, &anchor, &committer);
    if (!error) error = journal.ProvisionWorkspace(anchor);
    if (!error) error = journal.ProvisionDisk(anchor, wall);
    if (!error && !End()) error = ERROR_INVALID_DATA;
  } else if (!error) {
    error = journal.OpenRecorded(parent.value, parent_identity, name, owner, controller, plan, anchor);
    std::vector<CellProvisioningRecord> records;
    if (!error) error = journal.RecordCheckpoints(&records);
    if (!error) for (const auto& record : records) {
      if (!Frame(1, record.data(), static_cast<DWORD>(record.size()))) { error = ERROR_BROKEN_PIPE; break; }
      ++sink.count;
    }
  }
  std::array<std::uint8_t, 16> receipt{};
  Put32(receipt.data(), error); Put32(receipt.data() + 4, static_cast<unsigned>(journal.Phase()));
  Put32(receipt.data() + 8, attempted ? 1 : 0); Put32(receipt.data() + 12, sink.count);
  return Frame(2, receipt.data(), static_cast<DWORD>(receipt.size())) ? 0 : 3;
}
}
int wmain(int argc, wchar_t** arguments) {
  const bool read_custody = argc == 2 && !wcscmp(arguments[1], L"--controller-custody");
  const bool use_controller = read_custody || (argc == 2 && !wcscmp(arguments[1], L"--controller"));
  if (argc != 1 && !use_controller) return 2;
  Handle finished{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!finished.value) return 3;
  Deadline deadline{finished.value};
  Handle watchdog{CreateThread(nullptr, 0, Watch, &deadline, 0, nullptr)};
  if (!watchdog.value) return 3;
  int result = 3;
  try { result = Run(deadline, use_controller, read_custody); } catch (...) { /* Never emit unframed diagnostics or secrets. */ }
  SetEvent(finished.value);
  WaitForSingleObject(watchdog.value, INFINITE);
  return result;
}
