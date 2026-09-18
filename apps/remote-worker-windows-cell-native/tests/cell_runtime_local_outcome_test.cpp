#include "cell_runtime_result.hpp"
#include "cell_controller_protocol.hpp"
#include "cell_security.hpp"
#include <sddl.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellRuntimeLocalOutcomeTestPeer final {
  using Owner = CellRuntimeLocalOutcome::Owner;
  static DWORD Begin(CellRuntimeLocalOutcome& store, const Owner& owner, const CellRuntimeDispatch& request) {
    return store.BeginOwned(owner, request);
  }
  static DWORD Read(const Owner& owner, const CellRuntimeDispatch& request, CellRuntimeLocalOutcomeRecord* out) {
    return CellRuntimeLocalOutcome::ReadOwned(owner, request, out);
  }
  static DWORD Coverage(const Owner& owner, std::span<const CellRuntimeCleanupExpectation> requests, const CellFootprintScanGuard& guard, DWORD wall_ms = 10000) {
    return CellRuntimeLocalOutcome::VerifyCleanupCoverageOwned(owner, requests, guard, wall_ms);
  }
  static DWORD InstallationCoverage(const Owner& owner, std::span<const CellRuntimeInstallRequest> requests,
      const CellFootprintScanGuard& guard, DWORD wall_ms = 10000) {
    return CellRuntimeLocalOutcome::VerifyAttemptCoverageOwned(owner, {}, requests, true, guard, wall_ms);
  }
  static DWORD BeginInstall(CellRuntimeLocalOutcome& store, const Owner& owner, const CellRuntimeInstallRequest& request) {
    return store.BeginInstallOwned(owner, request);
  }
  static DWORD ReadInstall(const Owner& owner, const CellRuntimeInstallRequest& request, CellRuntimeInstallLocalRecord* out) {
    return CellRuntimeLocalOutcome::ReadInstallOwned(owner, request, out);
  }
};
struct CellRuntimeCleanupTransferTestPeer final {
  static DWORD Read(CellRuntimeCleanupTransfer& transfer, CellRuntimeCleanupSet* output, void* context,
      DWORD (*verify)(void*, const CellRuntimeCleanupSet&, const CellFootprintScanGuard&, DWORD) noexcept) {
    const CellRuntimeCleanupTransfer::CoverageOwner owner{context, verify};
    return transfer.ReadBound(output, nullptr, nullptr, nullptr, &owner);
  }
};
}
namespace {
unsigned checks = 0;
void Check(bool passed, const char* message) { ++checks; if (!passed) throw std::runtime_error(std::string(message) + " check=" + std::to_string(checks)); }
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
CellFileIdentity Identity(HANDLE file) {
  FILE_ID_INFO info{}; Check(GetFileInformationByHandleEx(file, FileIdInfo, &info, sizeof(info)), "Read exact fixture identity");
  CellFileIdentity result{info.VolumeSerialNumber}; std::memcpy(result.file_id.data(), info.FileId.Identifier, result.file_id.size()); return result;
}
std::wstring User() {
  Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "Open fixture token");
  DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size); std::vector<std::uint8_t> bytes(size);
  Check(size && GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size), "Read fixture SID");
  LPWSTR text = nullptr; Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &text), "Encode fixture SID");
  const std::wstring result(text); LocalFree(text); return result;
}
struct Fixture final {
  CellWorkspaceDirectories workspace;
  Handle parent;
  CellRuntimeLocalOutcomeTestPeer::Owner owner;
  DWORD refusal = 0;
  CellRuntimeLocalOutcome* reenter = nullptr;
  CellRuntimeDispatch request;
  explicit Fixture(const std::wstring& root) {
    const auto user = User(); std::vector<std::uint8_t> descriptor;
    Check(BuildCellParentSecurity(user, user, &descriptor) == 0, "Build protected fixture permissions");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
    Check(CreateDirectoryW(root.c_str(), &security), "Create exclusive protected temporary directory");
    parent.value = CreateFileW(root.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    Check(parent.value != INVALID_HANDLE_VALUE, "Open owned directory");
    Check(!workspace.Create(parent.value, Identity(parent.value), L"gc-cell-0123456789abcdef0123456789abcdef", user, user), "Create protected host workspace only");
    owner.directory = workspace.DirectoryHandle(CellDirectory::control); owner.directory_identity = workspace.DirectoryIdentity(CellDirectory::control);
    owner.anchor.file = owner.directory_identity; owner.anchor.file.file_id[0] ^= 0x80; owner.anchor.prepared_sha256.fill(0x11);
    owner.assignment.fill(0x22); owner.profile.fill(0x33); Check(!MakeCellControlFileSecurity(descriptor), "Use production file descriptor");
    owner.descriptor = descriptor; owner.context = this; owner.verify = [](void* raw) noexcept -> DWORD {
      auto& self = *static_cast<Fixture*>(raw);
      if (self.reenter) { auto* store = self.reenter; self.reenter = nullptr; return CellRuntimeLocalOutcomeTestPeer::Begin(*store, self.owner, self.request); }
      return self.refusal ? self.refusal : self.workspace.Verify();
    };
  }
  CellRuntimeDispatch Request(unsigned nonce) {
    CellRuntimeDispatch result; result.binding.nonce.fill(static_cast<std::uint8_t>(nonce)); result.binding.request_sha256.fill(0x44);
    result.reference.anchor = owner.anchor; result.reference.checkpoint_sha256.fill(0x55); result.limits.raw_output_bytes = 100;
    result.command.protected_workspace.emplace();
    return result;
  }
  std::wstring Path(const CellRuntimeDispatch& value) {
    constexpr wchar_t hex[] = L"0123456789abcdef"; auto result = workspace.DirectoryPath(CellDirectory::control) + L"\\";
    for (auto byte : value.binding.nonce) { result += hex[byte >> 4]; result += hex[byte & 15]; } return result + L".runtime";
  }
  DWORD Read(const CellRuntimeDispatch& value, CellRuntimeLocalOutcomeRecord* out) { return CellRuntimeLocalOutcomeTestPeer::Read(owner, value, out); }
};
CellRuntimeDispatchResult Result(const CellRuntimeDispatch& request) {
  CellRuntimeDispatchResult result; result.binding = request.binding; result.binding_verified = true;
  result.execution.runtime.job.error = ERROR_ACCESS_DENIED;
  result.execution.runtime.job.standard_output.prefix = {0x53, 0x45, 0x43, 0x52, 0x45, 0x54};
  return result;
}
CellFileIdentity InventoryIdentity(unsigned index) {
  CellFileIdentity value{1234};
  for (unsigned i = 0; i < 4; ++i) value.file_id[3 - i] = static_cast<std::uint8_t>(index >> (8 * i));
  return value;
}
CellRuntimeDispatchResult MaximumResult(CellRuntimeDispatch& request, const Fixture& fixture) {
  auto& roots = request.command.protected_workspace->identities;
  roots.parent = InventoryIdentity(21000); for (unsigned i = 0; i < 4; ++i) roots.directories[i] = InventoryIdentity(i + 1);
  request.command.expected_runtime_bundle.fill(0xdd);
  auto value = Result(request); auto& runtime = value.execution.runtime; auto& job = runtime.job;
  runtime.runtime_bundle_verified = runtime.protected_workspace_verified = true; runtime.runtime_bundle_sha256 = request.command.expected_runtime_bundle;
  job.end = JobEnd::exited; job.error = 0; job.process_exit_code = 23; job.process_id = 777;
  job.zero_processes_verified = job.output_drained = job.quiescent_capture_attempted = job.quiescent_capture_verified = true;
  job.app_container_verified = job.launch_files_verified = job.process_image_verified = true;
  value.execution.inventory_verified = true; auto& inventory = value.execution.inventory;
  value.execution.backing_verified = true; value.execution.backing = {1048576, 2097152, 21504, 24576};
  inventory.anchor = request.reference.anchor; inventory.workspace = roots; inventory.checkpoint_sha256 = request.reference.checkpoint_sha256;
  inventory.assignment_binding = fixture.owner.assignment; inventory.profile_sha256 = fixture.owner.profile;
  inventory.inventory.footprint = {roots.directories[0], 19996, 20000 * 4096ULL, 19996, 4};
  for (unsigned i = 1; i <= 20000; ++i) inventory.inventory.entries.push_back({InventoryIdentity(i), i <= 4, i <= 4 ? 0ULL : 1ULL, 4096});
  return value;
}
std::vector<std::uint8_t> Bytes(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  LARGE_INTEGER size{}; Check(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart <= 1100000, "Read bounded owned record");
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size.QuadPart)); DWORD read = 0;
  Check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size(), "Read entire saved record"); return bytes;
}
void Mutate(const std::wstring& path, unsigned offset, bool truncate) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(file.value != INVALID_HANDLE_VALUE, "Open exact closed fixture record for corruption"); LARGE_INTEGER position{}; position.QuadPart = offset;
  Check(SetFilePointerEx(file.value, position, nullptr, FILE_BEGIN), "Position exact corruption offset");
  DWORD written = 0; std::uint8_t changed = 0;
  if (!truncate) {
    Check(ReadFile(file.value, &changed, 1, &written, nullptr) && written == 1, "Read the original byte before guaranteed mutation");
    changed ^= 0x80; Check(SetFilePointerEx(file.value, position, nullptr, FILE_BEGIN), "Reposition for a guaranteed changed byte");
  }
  Check(truncate ? SetEndOfFile(file.value) : WriteFile(file.value, &changed, 1, &written, nullptr) && written == 1, "Create controlled partial or corrupt record");
  Check(FlushFileBuffers(file.value), "Flush controlled corruption");
}
void InstallationCoverage(const std::wstring& root) {
  Fixture fixture(root);
  std::vector<CellRuntimeInstallRequest> requests;
  const auto request = [&](unsigned nonce) {
    CellRuntimeInstallRequest value;
    value.binding.nonce.fill(static_cast<std::uint8_t>(nonce)); value.binding.request_sha256.fill(0x45);
    value.journal_identity = fixture.owner.anchor.file; value.prepared_sha256 = fixture.owner.anchor.prepared_sha256;
    value.checkpoint_sha256.fill(0x46); value.files = {{L"node.exe", 100, {}}, {L"worker-host-receipt.json", 20, {}}};
    return value;
  };
  struct Guard final {
    Fixture& fixture; std::vector<CellRuntimeInstallRequest>& requests; CellRuntimeInstallRequest addition;
    unsigned calls = 0; bool revoked = false, mutate = false, insert = false;
    static DWORD Check(void* raw) noexcept {
      auto& self = *static_cast<Guard*>(raw);
      if (self.revoked) return ERROR_ACCESS_DENIED;
      if (++self.calls == 1 && self.mutate) self.requests[0].binding.request_sha256[0] ^= 1;
      if (self.calls == 4 && self.insert) {
        CellRuntimeLocalOutcome store;
        return CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, self.fixture.owner, self.addition);
      }
      return ERROR_SUCCESS;
    }
  } guard{fixture, requests, request(3)};
  const CellFootprintScanGuard authority{Guard::Check, &guard, nullptr};
  const auto coverage = [&]() { return CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, requests, authority); };
  Check(!coverage(), "An empty installation namespace has empty historical coverage");
  for (unsigned i = 1; i <= 2; ++i) {
    requests.push_back(request(i));
    CellRuntimeLocalOutcome store; CellRuntimeInstallLocalRecord record;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, requests.back()), "Begin independently retained installation attempt");
    RuntimeBundleInstallResult result; result.files_created = i == 1 ? 2 : 1; result.bytes_written = i == 1 ? 120 : 40;
    result.verified = i == 1; result.error = i == 1 ? ERROR_SUCCESS : ERROR_CANCELLED;
    Check(!store.RetainInstall(result, &record) && record.outcome_retained, "Seal joined successful and failed installation outcomes");
  }
  Check(!coverage(), "Complete installation history includes joined failed copies without granting readiness");
  Check(CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, std::span(requests).first(1), authority) != 0,
    "Omitted installation attempt refuses coverage");
  auto changed = requests; changed.push_back(requests[0]);
  Check(CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, changed, authority) != 0, "Duplicate installation cannot cover an omitted attempt");
  changed = requests; changed[0].binding.request_sha256[0] ^= 1;
  Check(CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, changed, authority) != 0, "Installation coverage binds exact admitted request");
  changed = requests; changed[0].checkpoint_sha256[0] ^= 1;
  Check(CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, changed, authority) != 0, "Installation coverage binds checkpoint history");
  Check(CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, requests, authority, 0) == ERROR_INVALID_PARAMETER,
    "Unbounded installation coverage is refused");
  changed.assign(1001, requests[0]);
  Check(CellRuntimeLocalOutcomeTestPeer::InstallationCoverage(fixture.owner, changed, authority) == ERROR_INVALID_PARAMETER,
    "Installation coverage history is bounded before callbacks");
  guard.revoked = true; Check(coverage() == ERROR_ACCESS_DENIED, "Revoked authority prevents installation coverage"); guard.revoked = false;
  guard.mutate = true; guard.calls = 0;
  Check(!coverage(), "Installation expectations are frozen before authorization callbacks");
  requests[0].binding.request_sha256[0] ^= 1; guard.mutate = false;
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, fixture.Request(9)), "Create an unrelated runtime intent"); }
  Check(!coverage(), "Installation coverage does not claim to cover runtime writers");
  guard.insert = true; guard.calls = 0;
  Check(coverage() != 0, "An installation appearing during inspection refuses coverage"); guard.insert = false;
  requests.push_back(guard.addition);
  Check(coverage() == ERROR_IO_INCOMPLETE, "An interrupted installation intent never proves a joined writer");
  CellProvisioningJournal absent;
  Check(CellRuntimeLocalOutcome::VerifyInstallationCoverage(absent, {}, {}, {}, {}, 10000) == ERROR_INVALID_PARAMETER,
    "Missing installation coverage authority refuses before journal reads");
  Check(CellRuntimeLocalOutcome::VerifyInstallationCoverage(absent, {}, {}, {}, authority, 0) == ERROR_INVALID_PARAMETER,
    "Public installation coverage requires a bounded total lifetime");
  Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Check(cancelled.value && cancelled.value != INVALID_HANDLE_VALUE, "Create owned cancellation signal");
  const CellFootprintScanGuard stopped{Guard::Check, &guard, cancelled.value};
  Check(CellRuntimeLocalOutcome::VerifyInstallationCoverage(absent, {}, {}, {}, stopped, 10000) == ERROR_CANCELLED,
    "Cancellation precedes installation decoding and journal access");
  std::vector<CellRuntimeInstallationExpectation> oversized(1001);
  Check(CellRuntimeLocalOutcome::VerifyInstallationCoverage(absent, {}, {}, oversized, authority, 10000) == ERROR_INVALID_PARAMETER,
    "Public installation coverage bounds history before decoding");
  CellRuntimeCleanupBinding binding; binding.challenge.fill(1); binding.set_sha256.fill(2);
  CellControllerRequest controller_request;
  CellRuntimeCleanupSet received; received.expectations.resize(1);
  CellRuntimeCleanupTransfer bounded(INVALID_HANDLE_VALUE, GetTickCount64() + 10000, binding, authority);
  Check(bounded.ReadVerifiedForController(absent, controller_request, L"", L"", oversized, &received) == ERROR_INVALID_PARAMETER &&
    received.expectations.empty(), "Oversized independent installation history refuses before pipe I/O and clears output");
  Check(bounded.ReadForController(controller_request, L"", L"", &received) == ERROR_INVALID_STATE,
    "Rejected installation history cannot downgrade to an unchecked controller read");
  CellRuntimeCleanupTransfer cancelled_transfer(INVALID_HANDLE_VALUE, GetTickCount64() + 10000, binding, stopped);
  Check(cancelled_transfer.ReadVerifiedForController(absent, controller_request, L"", L"", {}, &received) == ERROR_OPERATION_ABORTED,
    "Combined historical read honors cancellation before pipe or journal access");
  CellRuntimeCleanupTransfer missing_output(INVALID_HANDLE_VALUE, GetTickCount64() + 10000, binding, authority);
  Check(missing_output.ReadVerifiedForController(absent, controller_request, L"", L"", {}, nullptr) == ERROR_INVALID_PARAMETER &&
    missing_output.Read(&received) == ERROR_INVALID_STATE, "Missing combined read output consumes the one-shot transfer");
  oversized.resize(1);
  Check(CellRuntimeLocalOutcome::VerifyInstallationCoverage(absent, {}, {}, oversized, authority, 10000) != 0,
    "Public installation coverage refuses unbound request bytes");
}
void Coverage(const std::wstring& root) {
  Fixture fixture(root); std::vector<CellRuntimeDispatch> admissions{fixture.Request(1), fixture.Request(2)};
  const auto metadata = [](const CellRuntimeDispatch& request) {
    CellRuntimeCleanupExpectation expected;
    expected.binding = request.binding; expected.anchor = request.reference.anchor;
    expected.checkpoint_sha256 = request.reference.checkpoint_sha256;
    expected.runtime_bundle_sha256 = request.command.expected_runtime_bundle;
    expected.workspace = request.command.protected_workspace->identities;
    expected.maximum_input_bytes = request.limits.input_bytes;
    expected.maximum_output_bytes = request.limits.raw_output_bytes;
    expected.maximum_inventory_entries = request.reference.inventory_limits.max_entries;
    return expected;
  };
  std::vector<CellRuntimeCleanupExpectation> requests;
  for (auto& request : admissions) {
    auto result = request.binding.nonce[0] == 2 ? MaximumResult(request, fixture) : Result(request);
    request.limits.input_bytes = 3;
    result.execution.runtime.job.standard_input_bytes_written = 2;
    result.execution.runtime.job.standard_output.raw_bytes = 5;
    CellRuntimeLocalOutcome store; CellRuntimeLocalOutcomeRecord record;
    Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request) && !store.Retain(result, 0, &record) && record.result_encoded, "Retain independent coverage attempt");
    requests.push_back(metadata(request));
  }
  admissions.clear(); // Cleanup retains no executable request content.
  struct Guard final {
    Fixture& fixture; unsigned calls = 0; bool insert = false; bool revoked = false;
    static DWORD Check(void* raw) noexcept {
      auto& self = *static_cast<Guard*>(raw);
      if (self.revoked) return ERROR_ACCESS_DENIED;
      if (++self.calls == 4 && self.insert) {
        CellRuntimeLocalOutcome store;
        return CellRuntimeLocalOutcomeTestPeer::Begin(store, self.fixture.owner, self.fixture.Request(3));
      }
      return ERROR_SUCCESS;
    }
  } guard{fixture};
  const CellFootprintScanGuard authority{Guard::Check, &guard, nullptr};
  Check(!CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, requests, authority), "Every retained attempt has exactly bound cleanup evidence");
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, std::span(requests).first(1), authority) != 0, "Omitted attempt prevents coverage");
  auto duplicate = requests; duplicate.push_back(requests[0]);
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, duplicate, authority) != 0, "Duplicate binding cannot cover a missing attempt");
  auto changed = requests; changed[0].binding.request_sha256[0] ^= 1;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Matching filename cannot replace independent request binding");
  changed = requests; changed[1].checkpoint_sha256[0] ^= 1;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Cleanup refuses substituted checkpoint");
  changed = requests; changed[1].runtime_bundle_sha256[0] ^= 1;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Cleanup refuses substituted runtime bundle");
  changed = requests; changed[1].workspace.parent.file_id[0] ^= 1;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Cleanup refuses substituted workspace history");
  changed = requests; changed[1].maximum_input_bytes = 1;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Cleanup enforces retained input limit");
  changed = requests; changed[1].maximum_output_bytes = 4;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Cleanup enforces retained output limit");
  changed = requests; changed[1].maximum_inventory_entries = 19999;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, changed, authority) != 0, "Cleanup enforces retained inventory limit");
  guard.revoked = true;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, requests, authority) == ERROR_ACCESS_DENIED, "Revocation prevents coverage");
  guard.revoked = false; guard.insert = true; guard.calls = 0;
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, requests, authority) != 0, "New attempt during authority callback invalidates directory coverage");
  guard.insert = false; requests.push_back(metadata(fixture.Request(3)));
  Check(CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, requests, authority) != 0, "Complete names with an interrupted intent still do not prove cleanup");
}
void Run(const std::wstring& root) {
  Coverage(root + L"-coverage");
  InstallationCoverage(root + L"-installation-coverage");
  Fixture fixture(root); CellRuntimeLocalOutcomeRecord record;
  auto request = fixture.Request(1);
  {
    CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Flush intent before any execution");
    CellRuntimeLocalOutcome duplicate; Check(CellRuntimeLocalOutcomeTestPeer::Begin(duplicate, fixture.owner, request) != 0, "Exclusive file prevents concurrent nonce reuse");
  }
  Check(!fixture.Read(request, &record) && record.intent_retained && !record.outcome_retained && !record.cleanup_verified, "Reopen an interrupted attempt without pretending it completed");
  const auto intent = Bytes(fixture.Path(request)); Check(intent.size() == 256, "Fixed durable intent length");
  { CellRuntimeLocalOutcome duplicate; Check(CellRuntimeLocalOutcomeTestPeer::Begin(duplicate, fixture.owner, request) != 0, "Never replay a closed uncertain attempt"); }
  Check(Bytes(fixture.Path(request)) == intent, "Duplicate request does not overwrite intent");
  request = fixture.Request(2);
  {
    CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin terminal result fixture");
    Check(!store.Retain(Result(request), ERROR_OPERATION_ABORTED, &record) && record.outcome_retained && record.result_encoded, "Retain native error even after remote cancellation");
    Check(record.execution_error == ERROR_OPERATION_ABORTED && record.execution.execution.runtime.job.error == ERROR_ACCESS_DENIED &&
      record.execution.execution.runtime.job.standard_output.prefix.empty(), "Separate session error and native error; omit raw output");
    Check(store.Retain(Result(request), 0, &record) != 0 && !record.outcome_retained, "Refuse duplicate terminal append and clear stale output");
  }
  Check(!fixture.Read(request, &record) && record.outcome_retained && record.result_encoded && record.cleanup_verified, "Durable pre-launch refusal reopens with no launched process");
  const auto complete = Bytes(fixture.Path(request)); const std::vector<std::uint8_t> secret{0x53,0x45,0x43,0x52,0x45,0x54};
  Check(std::search(complete.begin(), complete.end(), secret.begin(), secret.end()) == complete.end(), "Raw output is absent from disk");
  for (unsigned mode = 0; mode < 4; ++mode) {
    auto changed = request; auto owner = fixture.owner;
    if (mode == 0) changed.binding.request_sha256[0] ^= 1;
    if (mode == 1) changed.reference.checkpoint_sha256[0] ^= 1;
    if (mode == 2) owner.assignment[0] ^= 1;
    if (mode == 3) owner.profile[0] ^= 1;
    Check(CellRuntimeLocalOutcomeTestPeer::Read(owner, changed, &record) != 0 && !record.intent_retained && !record.cleanup_verified, "Different request or admission cannot recover this record");
  }
  Check(Bytes(fixture.Path(request)) == complete, "Refused recovery leaves saved bytes unchanged");
  for (unsigned mode = 0; mode < 4; ++mode) {
    request = fixture.Request(3 + mode);
    { CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin corruption fixture");
      Check(!store.Retain(Result(request), 0, &record), "Save corruption control"); }
    Mutate(fixture.Path(request), mode == 0 ? 260 : mode == 1 ? 639 : mode == 2 ? 270 : 12, mode == 2);
    const auto changed = Bytes(fixture.Path(request));
    Check(fixture.Read(request, &record) != 0 && !record.outcome_retained, "Reject changed terminal, seal, truncated append and wrong intent");
    Check(Bytes(fixture.Path(request)) == changed, "Recovery never repairs or erases uncertain evidence");
  }
  request = fixture.Request(8);
  { CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin invalid-result fixture");
    auto result = Result(request); result.binding.nonce[0] ^= 1;
    Check(!store.Retain(result, ERROR_INVALID_DATA, &record) && record.outcome_retained && !record.result_encoded && record.encoding_error,
      "Unencodable result retains diagnostic outcome without inventing canonical success"); }
  Check(!fixture.Read(request, &record) && record.outcome_retained && !record.result_encoded && !record.cleanup_verified, "Diagnostic-only outcome cannot prove cleanup");
  for (unsigned mode = 0; mode < 4; ++mode) {
    request = fixture.Request(40 + mode);
    auto result = Result(request); auto& job = result.execution.runtime.job;
    job.process_id = 777; job.zero_processes_verified = (mode & 1) != 0; job.output_drained = (mode & 2) != 0;
    { CellRuntimeLocalOutcome store;
      Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin cleanup evidence fixture");
      Check(!store.Retain(result, ERROR_OPERATION_ABORTED, &record) && record.outcome_retained && record.result_encoded,
        "Retain cleanup facts independently of cancelled delivery");
      Check(record.cleanup_verified == (mode == 3), "A launched job needs both zero-process and drained-output evidence");
    }
    Check(!fixture.Read(request, &record) && record.cleanup_verified == (mode == 3), "Reopened cleanup evidence preserves the exact retained facts");
  }
  request = fixture.Request(9);
  { CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin revoked host-custody fixture");
    fixture.refusal = ERROR_ACCESS_DENIED; Check(store.Retain(Result(request), 0, &record) == ERROR_ACCESS_DENIED && !record.outcome_retained, "Local host-custody loss prevents append"); }
  fixture.refusal = 0; Check(!fixture.Read(request, &record) && !record.outcome_retained, "Lost host custody preserves uncertain intent");
  request = fixture.Request(10);
  { CellRuntimeLocalOutcome store; fixture.request = request; fixture.reenter = &store;
    Check(CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request) != 0, "Reentrant begin fences creation"); }
  Check(GetFileAttributesW(fixture.Path(request).c_str()) == INVALID_FILE_ATTRIBUTES, "Reentrant callback cannot create a replay record");
  request = fixture.Request(11); const auto maximum = MaximumResult(request, fixture);
  { CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin maximum inventory result");
    Check(!store.Retain(maximum, 0, &record) && record.result_encoded && record.execution.execution.inventory == maximum.execution.inventory,
      "Persist every entry of the maximum supported native inventory"); }
  Check(!fixture.Read(request, &record) && record.execution.execution.inventory == maximum.execution.inventory && record.observed_process_id == 777 &&
    record.execution.execution.backing_verified && record.execution.execution.backing == maximum.execution.backing,
    "Reopen the complete maximum inventory, paired host counts and process outcome");
  Check(Bytes(fixture.Path(request)).size() == 256 + 96 + kMaximumCellRuntimeResultBytes + 32, "Maximum result stays inside the strict file ceiling");
  request.binding.nonce.fill(12); auto substituted = maximum; substituted.binding = request.binding; substituted.execution.inventory.assignment_binding[0] ^= 1;
  { CellRuntimeLocalOutcome store; Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request), "Begin wrong inventory admission fixture");
    Check(!store.Retain(substituted, ERROR_INVALID_DATA, &record) && record.outcome_retained && !record.result_encoded,
      "Wrong inventory admission is diagnostic evidence only"); }
  CellProvisioningJournal absent; CellRuntimeLocalOutcome production;
  CellRuntimeInstallRequest install;
  install.binding.nonce.fill(13); install.binding.request_sha256.fill(0x45);
  install.journal_identity = fixture.owner.anchor.file; install.prepared_sha256 = fixture.owner.anchor.prepared_sha256;
  install.checkpoint_sha256.fill(0x46);
  install.files = {{L"node.exe", 100, {}}, {L"worker-host-receipt.json", 20, {}}};
  CellRuntimeInstallLocalRecord installed;
  const auto read_install = [&]() { return CellRuntimeLocalOutcomeTestPeer::ReadInstall(fixture.owner, install, &installed); };
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, install), "Flush installation intent independently of workload records");
    CellRuntimeLocalOutcome duplicate;
    Check(CellRuntimeLocalOutcomeTestPeer::BeginInstall(duplicate, fixture.owner, install) != 0, "Refuse concurrent installation nonce"); }
  Check(!read_install() && installed.intent_retained && !installed.outcome_retained, "Recover installation intent after interruption without replay");
  { CellRuntimeLocalOutcome duplicate;
    Check(CellRuntimeLocalOutcomeTestPeer::BeginInstall(duplicate, fixture.owner, install) != 0, "Refuse closed uncertain installation replay"); }
  install.binding.nonce.fill(14);
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, install), "Begin partial installation");
    RuntimeBundleInstallResult partial; partial.error = ERROR_CANCELLED; partial.files_created = 1; partial.bytes_written = 40;
    Check(!store.RetainInstall(partial, &installed) && installed.outcome_retained && !installed.installation.verified && installed.installation.bytes_written == 40,
      "Retain cancelled installation partial counts without execution result"); }
  Check(!read_install() && installed.installation.error == ERROR_CANCELLED && installed.installation.bytes_written == 40, "Reopen cancelled installation outcome");
  install.binding.nonce.fill(15);
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, install), "Begin completed installation");
    RuntimeBundleInstallResult installed_complete; installed_complete.files_created = 2; installed_complete.bytes_written = 120; installed_complete.verified = true;
    Check(!store.RetainInstall(installed_complete, &installed) && installed.outcome_retained && installed.installation.verified, "Flush completed installation result");
    Check(store.RetainInstall(installed_complete, &installed) != 0 && !installed.outcome_retained, "Refuse duplicate terminal installation write"); }
  Check(!read_install() && installed.installation.verified, "Reopen completed installation");
  const auto install_path = fixture.Path(fixture.Request(15)) + L"-install";
  Check(Bytes(install_path).size() == 352, "Installation outcome has a fixed bounded size");
  install.binding.request_sha256[0] ^= 1;
  Check(read_install() != 0 && !installed.intent_retained, "Refuse installation request substitution on recovery");
  install.binding.request_sha256[0] ^= 1;
  Mutate(install_path, 351, false);
  Check(read_install() != 0 && !installed.outcome_retained, "Refuse corrupted installation seal");
  install.binding.nonce.fill(16);
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, install), "Begin invalid result fixture");
    RuntimeBundleInstallResult invalid; invalid.verified = true;
    Check(store.RetainInstall(invalid, &installed) != 0 && !installed.outcome_retained, "Reject false success before terminal write"); }
  Check(!read_install() && installed.intent_retained && !installed.outcome_retained, "Invalid terminal leaves the exclusive intent for reconciliation");
  install.binding.nonce.fill(17);
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, install), "Begin custody loss fixture");
    fixture.refusal = ERROR_ACCESS_DENIED;
    RuntimeBundleInstallResult partial; partial.error = ERROR_CANCELLED;
    Check(store.RetainInstall(partial, &installed) != 0 && !installed.outcome_retained, "Refuse retention when original local custody is lost"); }
  fixture.refusal = 0;
  Check(!read_install() && installed.intent_retained && !installed.outcome_retained, "Custody loss leaves intent for explicit recovery");
  Check(production.Begin(absent, request) != 0 && CellRuntimeLocalOutcome::Read(absent, request, &record) != 0 && !record.intent_retained,
    "Production entry refuses an absent original mounted journal without any disk operation");
}
}
void InstallationExchange(const std::wstring& root, const std::wstring& input) {
  const auto bytes = Bytes(input); Check(bytes.size() == 400, "Require independently bound installation fixture");
  CellRuntimeInstallBinding binding;
  std::copy_n(bytes.begin(), 32, binding.nonce.begin()); std::copy_n(bytes.begin() + 32, 32, binding.request_sha256.begin());
  CellRuntimeInstallRequest request;
  Check(!DecodeCellRuntimeInstall(std::span(bytes).subspan(64, 272), binding, &request), "Decode TypeScript installation request");
  Fixture fixture(root);
  fixture.owner.anchor = {request.journal_identity, request.prepared_sha256};
  std::copy_n(bytes.begin() + 336, 32, fixture.owner.assignment.begin()); std::copy_n(bytes.begin() + 368, 32, fixture.owner.profile.begin());
  const auto request_path = [&]() { auto named = fixture.Request(1); named.binding.nonce = binding.nonce; return fixture.Path(named) + L"-install"; }();
  CellRuntimeInstallLocalRecord record;
  { CellRuntimeLocalOutcome store;
    Check(!CellRuntimeLocalOutcomeTestPeer::BeginInstall(store, fixture.owner, request), "Flush cross-language installation intent");
    RuntimeBundleInstallResult installed; installed.files_created = 2; installed.verified = true;
    installed.bytes_written = request.files[0].bytes + request.files[1].bytes;
    Check(!store.RetainInstall(installed, &record) && record.outcome_retained, "Flush cross-language installation outcome");
  }
  Check(!CellRuntimeLocalOutcomeTestPeer::ReadInstall(fixture.owner, request, &record) && record.installation.verified,
    "Independently reopen cross-language installation outcome");
  const auto retained = Bytes(request_path); Check(retained.size() == 352, "Read exact native installation bytes");
  Check(record.bytes == retained, "Transport exposes the exact independently reopened record bytes");
  std::printf("{\"passed\":true,\"checks\":%u,\"installationHex\":\"", checks);
  for (const auto byte : retained) std::printf("%02x", static_cast<unsigned>(byte));
  std::printf("\",\"installedService\":false,\"volumeAttached\":false,\"workloadsRun\":0}\n");
}
struct CleanupPipePair final {
  Handle stop, server, client;
  ULONGLONG deadline = GetTickCount64() + 10000;
  CleanupPipePair() {
    static unsigned sequence = 0;
    stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    const auto name = L"\\\\.\\pipe\\LOCAL\\GoatCitadel.Cleanup.Test." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(++sequence);
    server.value = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, nullptr);
    client.value = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    Check(stop.value && server.value != INVALID_HANDLE_VALUE && client.value != INVALID_HANDLE_VALUE &&
      !ConnectCellPipe(server.value, stop.value, deadline), "Connect task-owned cleanup pipe");
  }
};
void CleanupPipe(const std::vector<std::uint8_t>& bytes, const CellRuntimeCleanupBinding& binding, std::size_t count) {
  for (unsigned mode = 0; mode < 8; ++mode) {
    CleanupPipePair pair; auto supplied = bytes; auto reader_binding = binding;
    struct Authority final {
      unsigned calls = 0, deny = 0; std::vector<std::uint8_t>* mutate = nullptr;
      static DWORD Check(void* raw) noexcept {
        auto& self = *static_cast<Authority*>(raw);
        if (++self.calls == 1 && self.mutate) (*self.mutate)[96] ^= 1;
        return self.deny && self.calls >= self.deny ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
      }
    } writer_authority, reader_authority;
    if (mode == 1) reader_binding.set_sha256[0] ^= 1;
    if (mode == 2) writer_authority.mutate = &supplied;
    if (mode == 3) reader_authority.deny = 4;
    if (mode == 7) reader_authority.deny = 4 + 2 * static_cast<unsigned>((bytes.size() + 4095) / 4096);
    if (mode == 4) SetEvent(pair.stop.value);
    const auto deadline = mode == 5 ? GetTickCount64() : pair.deadline;
    CellRuntimeCleanupTransfer writer(pair.server.value, deadline, binding, {Authority::Check, &writer_authority, pair.stop.value});
    CellRuntimeCleanupTransfer reader(pair.client.value, deadline, reader_binding, {mode == 6 ? nullptr : Authority::Check, &reader_authority, pair.stop.value});
    DWORD sent = ERROR_IO_INCOMPLETE;
    std::thread sender([&] { sent = writer.Write(supplied); if (sent) SetEvent(pair.stop.value); });
    CellRuntimeCleanupSet received; const auto error = reader.Read(&received);
    if (error) SetEvent(pair.stop.value);
    sender.join();
    if (mode == 0 || mode == 2) {
      Check(!error && !sent && received.expectations.size() == count && received.binding.set_sha256 == binding.set_sha256,
        "Transfer exact immutable complete metadata set");
    } else Check(error && (mode == 7 || sent) && received.expectations.empty() && received.binding.set_sha256 == CellFileSha256{}, "Refusal including after receipt withholds partial metadata");
    Check(writer.Write(bytes) == ERROR_INVALID_STATE && reader.Read(&received) == ERROR_INVALID_STATE, "Transfer instances cannot replay after success or failure");
  }
  // Independently authored malformed headers/chunks never produce a receipt.
  for (unsigned mode = 0; mode < 3; ++mode) {
    CleanupPipePair pair;
    const auto put = [](std::uint8_t* target, DWORD value) { for (unsigned i = 0; i < 4; ++i) target[i] = static_cast<std::uint8_t>(value >> (8 * i)); };
    std::array<std::uint8_t, 96> header{}; std::memcpy(header.data(), "GCCLX001", 8);
    std::copy(binding.challenge.begin(), binding.challenge.end(), header.begin() + 8); std::copy(binding.set_sha256.begin(), binding.set_sha256.end(), header.begin() + 40);
    put(header.data() + 72, mode == 0 ? static_cast<DWORD>(kMaximumCellRuntimeCleanupBytes + 1) : static_cast<DWORD>(bytes.size())); put(header.data() + 76, 4096);
    std::thread sender([&] {
      auto error = WriteCellPipe(pair.server.value, header.data(), mode == 2 ? 48 : 96, pair.stop.value, pair.deadline);
      if (!error && mode == 1) {
        std::array<std::uint8_t, 16> chunk{}; std::memcpy(chunk.data(), "GCCLD001", 8); put(chunk.data() + 8, 1); put(chunk.data() + 12, 1);
        error = WriteCellPipe(pair.server.value, chunk.data(), 16, pair.stop.value, pair.deadline);
      }
      if (mode == 2) DisconnectNamedPipe(pair.server.value);
      if (error) SetEvent(pair.stop.value);
    });
    CellRuntimeCleanupTransfer reader(pair.client.value, pair.deadline, binding, {[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, pair.stop.value});
    CellRuntimeCleanupSet received; const auto error = reader.Read(&received); SetEvent(pair.stop.value); sender.join();
    Check(error && received.expectations.empty() && received.binding.set_sha256 == CellFileSha256{}, "Malformed or disconnected transfer exposes no partial set");
  }
  for (unsigned mode = 0; mode < 2; ++mode) {
    CleanupPipePair pair;
    DWORD consumed = ERROR_IO_INCOMPLETE;
    std::thread receiver([&] {
      std::array<std::uint8_t, 96> header{};
      consumed = ReadCellPipe(pair.client.value, header.data(), 96, pair.stop.value, pair.deadline);
      for (std::size_t offset = 0; !consumed && offset < bytes.size();) {
        std::array<std::uint8_t, 16> chunk{}; std::array<std::uint8_t, 4096> payload{};
        const auto size = static_cast<DWORD>(std::min<std::size_t>(4096, bytes.size() - offset));
        consumed = ReadCellPipe(pair.client.value, chunk.data(), 16, pair.stop.value, pair.deadline);
        if (!consumed) consumed = ReadCellPipe(pair.client.value, payload.data(), size, pair.stop.value, pair.deadline);
        offset += size;
      }
      if (!consumed) {
        std::array<std::uint8_t, 80> ack{}; std::copy_n(header.begin(), 76, ack.begin()); std::memcpy(ack.data(), "GCCLA001", 8);
        if (mode == 0) ack[40] ^= 1;
        consumed = WriteCellPipe(pair.client.value, ack.data(), mode == 0 ? 80 : 40, pair.stop.value, pair.deadline);
      }
      if (mode == 1) { CloseHandle(pair.client.value); pair.client.value = INVALID_HANDLE_VALUE; }
      if (consumed) SetEvent(pair.stop.value);
    });
    CellRuntimeCleanupTransfer writer(pair.server.value, pair.deadline, binding, {[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, pair.stop.value});
    // Let the peer finish its final write before signalling cancellation;
    // receiving the ACK bytes can precede the peer's I/O completion callback.
    const auto error = writer.Write(bytes); receiver.join(); SetEvent(pair.stop.value);
    Check(error && !consumed, "Wrong or truncated receipt never confirms delivery");
  }
}
void VerifiedCleanupPipe(const CellRuntimeLocalOutcomeTestPeer::Owner& owner, const std::vector<std::uint8_t>& bytes,
    const CellRuntimeCleanupBinding& binding, bool expected_success) {
  CleanupPipePair pair;
  const CellFootprintScanGuard guard{[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, pair.stop.value};
  CellRuntimeCleanupTransfer writer(pair.server.value, pair.deadline, binding, guard), reader(pair.client.value, pair.deadline, binding, guard);
  DWORD written = ERROR_IO_PENDING;
  std::thread sending([&] { written = writer.Write(bytes); });
  struct Local { const CellRuntimeLocalOutcomeTestPeer::Owner* owner; bool checked = false; } local{&owner};
  CellRuntimeCleanupSet received;
  const auto error = CellRuntimeCleanupTransferTestPeer::Read(reader, &received, &local,
    [](void* raw, const CellRuntimeCleanupSet& set, const CellFootprintScanGuard& authority, DWORD wall_ms) noexcept -> DWORD {
      auto& self = *static_cast<Local*>(raw); self.checked = true;
      return CellRuntimeLocalOutcomeTestPeer::Coverage(*self.owner, set.expectations, authority, wall_ms);
    });
  if (error) SetEvent(pair.stop.value);
  sending.join();
  Check(local.checked, "Received metadata passes through the real sealed local coverage verifier");
  if (expected_success) Check(!error && !written && received.expectations.size() == 2, "Complete sealed local coverage permits receipt and metadata");
  else Check(error && written && received.expectations.empty(), "Missing or corrupt local evidence withholds receipt and metadata");
}
void CleanupExchange(const std::wstring& root, const std::wstring& input) {
  const auto material = Bytes(input); Check(material.size() >= 316, "Require separate cleanup binding and metadata");
  CellRuntimeCleanupBinding binding;
  std::copy_n(material.begin(), 32, binding.challenge.begin()); std::copy_n(material.begin() + 32, 32, binding.set_sha256.begin());
  const std::vector<std::uint8_t> bytes(material.begin() + 64, material.end());
  CellRuntimeCleanupSet decoded;
  Check(!DecodeCellRuntimeCleanup(bytes, binding, &decoded), "Decode independently bound TypeScript cleanup set");
  const auto count = decoded.expectations.size();
  CleanupPipe(bytes, binding, count);
  Check(count == 0 || count == 2 || count == 1000, "Exercise empty, ordinary and maximum sets");
  for (std::size_t index = 0; index < count; ++index) {
    const auto& item = decoded.expectations[index];
    Check(item.anchor == decoded.anchor && item.workspace == decoded.workspace && item.checkpoint_sha256 == decoded.checkpoint_sha256,
      "All expectations inherit the validated common journal and workspace");
    Check(item.maximum_input_bytes == index % 100 && item.maximum_output_bytes == 100000 + index && item.maximum_inventory_entries == 20000 - index,
      "Native limits exactly match independent TypeScript values");
  }
  if (count == 2) {
    Fixture fixture(root); fixture.owner.anchor = decoded.anchor;
    VerifiedCleanupPipe(fixture.owner, bytes, binding, false);
    for (const auto& item : decoded.expectations) {
      auto request = fixture.Request(1); request.binding = item.binding; request.reference.anchor = item.anchor;
      request.reference.checkpoint_sha256 = item.checkpoint_sha256; request.command.protected_workspace->identities = item.workspace;
      request.command.expected_runtime_bundle = item.runtime_bundle_sha256; request.limits.input_bytes = item.maximum_input_bytes;
      request.limits.raw_output_bytes = item.maximum_output_bytes; request.reference.inventory_limits.max_entries = item.maximum_inventory_entries;
      CellRuntimeLocalOutcome store; CellRuntimeLocalOutcomeRecord record;
      Check(!CellRuntimeLocalOutcomeTestPeer::Begin(store, fixture.owner, request) && !store.Retain(Result(request), 0, &record), "Retain decoded metadata-bound cleanup fixture");
    }
    CellFootprintScanGuard guard{[](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr, nullptr};
    Check(!CellRuntimeLocalOutcomeTestPeer::Coverage(fixture.owner, decoded.expectations, guard), "Decoded metadata reconciles the complete local set");
    VerifiedCleanupPipe(fixture.owner, bytes, binding, true);
    auto corrupt = fixture.Request(1); corrupt.binding = decoded.expectations.front().binding;
    Mutate(fixture.Path(corrupt), 32, false);
    VerifiedCleanupPipe(fixture.owner, bytes, binding, false);
  }
  auto changed_binding = binding; changed_binding.challenge[0] ^= 1;
  Check(DecodeCellRuntimeCleanup(bytes, changed_binding, &decoded) != 0 && decoded.expectations.empty(), "Refuse replayed challenge with no partial result");
  auto changed = bytes; changed[96] ^= 1;
  Check(DecodeCellRuntimeCleanup(changed, binding, &decoded) != 0, "Independent digest refuses substituted history");
  const auto invalid = [&](std::vector<std::uint8_t> value) {
    auto rebound = binding; Check(!HashCellRuntimeCleanup(value, &rebound.set_sha256), "Hash intentionally malformed fixture");
    Check(DecodeCellRuntimeCleanup(value, rebound, &decoded) != 0 && decoded.expectations.empty(), "Bound malformed set still refuses without partial output");
  };
  changed = bytes; changed.push_back(0); if (changed.size() <= kMaximumCellRuntimeCleanupBytes) invalid(changed);
  changed = bytes; changed[248] ^= 1; invalid(changed);
  changed = bytes; std::fill_n(changed.begin() + 40, 24, std::uint8_t{0}); invalid(changed);
  changed = bytes; std::copy_n(changed.begin() + 128, 24, changed.begin() + 152); invalid(changed);
  if (count) {
    changed = bytes; std::fill_n(changed.begin() + 252, 32, std::uint8_t{0}); invalid(changed);
    changed = bytes; std::fill_n(changed.begin() + 252 + 100, 4, std::uint8_t{0}); invalid(changed);
    changed = bytes; std::fill_n(changed.begin() + 252 + 104, 4, std::uint8_t{0xff}); invalid(changed);
    changed = bytes; std::copy_n(changed.begin() + 252, 108, changed.begin() + 360); invalid(changed);
  }
  std::printf("{\"passed\":true,\"checks\":%u,\"expectations\":%zu}\n", checks, count);
}
void CleanupParent(const std::wstring& input, const wchar_t* pipe_name, DWORD parent_pid) {
  const auto material = Bytes(input); Check(material.size() >= 316, "Require independent parent fixture binding");
  CellRuntimeCleanupBinding binding;
  std::copy_n(material.begin(), 32, binding.challenge.begin()); std::copy_n(material.begin() + 32, 32, binding.set_sha256.begin());
  Handle pipe{CreateFileW(pipe_name, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)};
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  struct Parent final {
    HANDLE pipe; DWORD pid;
    static DWORD Verify(void* raw) noexcept {
      const auto& self = *static_cast<Parent*>(raw); ULONG actual = 0;
      return GetNamedPipeServerProcessId(self.pipe, &actual) && actual == self.pid ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
    }
  } parent{pipe.value, parent_pid};
  const auto deadline = GetTickCount64() + 10000;
  CellRuntimeCleanupTransfer receiver(pipe.value, deadline, binding, {Parent::Verify, &parent, stop.value});
  CellRuntimeCleanupSet received; Check(!receiver.Read(&received), "Receive complete cleanup set from Node parent");
  // Keep the fixture peer alive through the sender's final authority check.
  std::uint8_t released = 0;
  Check(!ReadCellPipe(pipe.value, &released, 1, stop.value, deadline) && released == 1, "Join explicit parent fixture completion");
  std::printf("{\"passed\":true,\"checks\":%u,\"expectations\":%zu}\n", checks, received.expectations.size());
}
void CleanupAdmission(const std::wstring& input) {
  const auto bytes = Bytes(input);
  CellRuntimeCleanupAdmission decoded;
  Check(!DecodeCellRuntimeCleanupAdmission(bytes, &decoded), "Decode exact TypeScript primary admission");
  Check(decoded.installations.size() == (bytes.size() == 416 ? 1u : 0u), "Preserve complete zero-or-one installation set");
  Check(std::equal(decoded.binding.challenge.begin(), decoded.binding.challenge.end(), bytes.begin() + 8) &&
    std::equal(decoded.binding.set_sha256.begin(), decoded.binding.set_sha256.end(), bytes.begin() + 40), "Preserve the independent cleanup binding");
  const auto refuse = [&](const std::vector<std::uint8_t>& changed) {
    decoded.installations.resize(1); decoded.binding.challenge.fill(1);
    Check(DecodeCellRuntimeCleanupAdmission(changed, &decoded) != 0 && decoded.installations.empty() &&
      decoded.binding.challenge == CellFileSha256{} && decoded.binding.set_sha256 == CellFileSha256{}, "Refuse malformed admission without partial output");
  };
  for (const auto offset : {0u, 72u, 76u}) { auto changed = bytes; changed[offset] ^= 1; refuse(changed); }
  for (const auto offset : {8u, 40u}) { auto changed = bytes; std::fill_n(changed.begin() + offset, 32, std::uint8_t{0}); refuse(changed); }
  auto changed = bytes; changed.pop_back(); refuse(changed); changed = bytes; changed.push_back(0); refuse(changed);
  if (bytes.size() == 416) {
    for (const auto offset : {80u, 112u, 144u, 415u}) { changed = bytes; changed[offset] ^= 1; refuse(changed); }
    Check(!DecodeCellRuntimeCleanupAdmission(bytes, &decoded), "Valid installation admission still decodes after refusal");
    Check(std::equal(decoded.installations[0].bytes.begin(), decoded.installations[0].bytes.end(), bytes.begin() + 144),
      "Retain original installation bytes without reconstruction");
  }
  Check(DecodeCellRuntimeCleanupAdmission(bytes, nullptr) == ERROR_INVALID_PARAMETER, "Require an admission output owner");
  std::printf("{\"passed\":true,\"checks\":%u,\"bytes\":%zu}\n", checks, bytes.size());
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 3 && std::wstring_view(argv[1]) == L"--cleanup-admission") { CleanupAdmission(argv[2]); return 0; }
    if (argc == 5 && std::wstring_view(argv[1]) == L"--cleanup-parent") { CleanupParent(argv[2], argv[3], std::stoul(argv[4])); return 0; }
    if (argc == 4 && std::wstring_view(argv[1]) == L"--installation-exchange") { InstallationExchange(argv[2], argv[3]); return 0; }
    if (argc == 4 && std::wstring_view(argv[1]) == L"--cleanup-exchange") { CleanupExchange(argv[2], argv[3]); return 0; }
    Check(argc == 2, "Require an exclusive temporary fixture path"); Run(argv[1]);
    std::printf("{\"passed\":true,\"checks\":%u,\"installedService\":false,\"volumeAttached\":false,\"workloadsRun\":0}\n", checks); return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s win32=%lu\n", error.what(), GetLastError()); return 1; }
}
