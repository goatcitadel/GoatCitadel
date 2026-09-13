#include "cell_provisioning_journal.hpp"
#include "cell_controller_client_identity.hpp"
#include "cell_controller_client_protocol.hpp"
#include <algorithm>
#include <atomic>
#include <cstring>

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
struct ControllerSink final {
  ControllerConnection& connection;
  Sink sink;
  static DWORD Authorize(void* context) noexcept {
    return static_cast<ControllerSink*>(context)->connection.identity.Verify();
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
    if (!Frame(2, receipt.data(), static_cast<DWORD>(receipt.size()))) return ERROR_BROKEN_PIPE;
    // Volume stages still perform current-authority checks after the final
    // checkpoint. The parent closes input only after seeing this receipt.
    return owner.sink.maximum > 5 && !End() ? ERROR_INVALID_DATA : ERROR_SUCCESS;
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
  if (operation < 1 || operation > 12 || (IsCellControllerVolume(operation) && !use_controller) ||
      wall < 100 || wall > 600000 || !path_bytes || path_bytes > 8192) return 2;
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
    if (!End()) return 2;
  }
  if (use_controller) {
    // Paths/principals are fixed installation custody, never configurable
    // service requests. The restricted helper does not open the cells parent.
    if (CompareStringOrdinal(path.c_str(), -1, connection.identity.ParentPath().c_str(), -1, TRUE) != CSTR_EQUAL ||
        parent_identity != connection.identity.ParentIdentity() || owner != L"S-1-5-18" || controller != kCellControllerServiceSid) return 2;
    DWORD error = ConnectController(connection, deadline);
    if (error) return static_cast<int>(error);
    CellControllerRequest request;
    request.operation = operation; request.wall_ms = wall; request.cell_name = name;
    request.plan = plan; request.parent = parent_identity; request.anchor = anchor; request.volume_records = volume_history;
    request.format_records = format_history;
    request.protection_records = protection_history;
    request.creation_records = creation_history; request.mount_records = mount_history;
    request.mounted_workspace_records = workspace_history;
    ControllerSink context{connection, {}};
    context.sink.maximum = CellControllerCheckpointLimit(operation);
    CellControllerClientOwner client{&context, ControllerSink::Authorize, ControllerSink::Checkpoint, ControllerSink::Receipt, ControllerSink::VolumeAuthority};
    client.owner_sid = owner; client.controller_sid = controller;
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
