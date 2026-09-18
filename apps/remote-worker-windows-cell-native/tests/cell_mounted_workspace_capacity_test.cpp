#include "cell_mounted_workspace.hpp"
#include "cell_capacity.hpp"
#include <sddl.h>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
struct CellMountedWorkspaceTestPeer final {
  static DWORD CreateOrdinaryContents(CellMountedWorkspace& owner, HANDLE parent, const CellFileIdentity& identity,
    const std::wstring& user, const std::wstring& name) {
    auto error = owner.contents_.Create(parent, identity, name, user, user);
    if (!error) error = owner.contents_.RecordIdentities(&owner.identities_);
    if (error) return error;
    owner.binding_.volume_root = identity; owner.binding_.cell_name = name;
    owner.binding_.mount_sha256.fill(0xa1); owner.binding_.security_sha256.fill(0xb2);
    owner.attempted_ = true; owner.state_ = CellMountedWorkspaceState::unknown;
    owner.committer_ = {
      [](void*, const CellMountedWorkspaceCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
        std::copy_n(record.begin() + 480, 32, acknowledged->begin()); return ERROR_SUCCESS;
      }, [](void*) noexcept -> DWORD { return ERROR_SUCCESS; }, nullptr,
    };
    const CellMountedWorkspace::Operations operations{
      [](void*) noexcept -> DWORD { return ERROR_SUCCESS; },
      [](void* raw, CellWorkspaceIdentities* output, DWORD (*guard)(void*) noexcept, void* context) noexcept -> DWORD {
        const auto error = guard(context);
        return error ? error : static_cast<CellMountedWorkspace*>(raw)->contents_.RecordIdentities(output);
      },
      [](void* raw, const CellWorkspaceIdentities& expected, bool) noexcept -> DWORD {
        CellWorkspaceIdentities actual;
        const auto error = static_cast<CellMountedWorkspace*>(raw)->contents_.RecordIdentities(&actual);
        return error ? error : actual == expected ? ERROR_SUCCESS : ERROR_FILE_INVALID;
      }, &owner,
    };
    return owner.Run(operations, GetTickCount64() + 10000, nullptr);
  }
  static DWORD Read(CellMountedWorkspace& owner, DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellDirectoryFootprint* output) {
    return owner.ReadFootprint(verify, context, limits, guard, output);
  }
  static DWORD Read(CellMountedWorkspace& owner, DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellDirectoryInventory* output) {
    return owner.ReadInventory(verify, context, limits, guard, output);
  }
  static DWORD VerifyContents(CellMountedWorkspace& owner) { return owner.contents_.Verify(); }
  static DWORD Capture(CellMountedWorkspace& owner, DWORD (*verify)(void*, DWORD, HANDLE) noexcept, void* context,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
    CellDirectoryInventoryPins& pins, CellDirectoryInventory* output) {
    return owner.ReadRetainedInventory(verify, context, limits, guard, pins, output);
  }
  static void Drift(CellMountedWorkspace& owner, unsigned kind) {
    if (kind == 1) owner.binding_.mount_sha256[0] ^= 1;
    if (kind == 2) owner.binding_.security_sha256[0] ^= 1;
    if (kind == 3) owner.binding_.volume_root.file_id[15] ^= 1;
    if (kind == 4) owner.binding_.cell_name.back() = L'f';
    if (kind == 5) owner.identities_.directories[3].file_id[15] ^= 1;
    if (kind == 6) owner.records_[1][511] ^= 1;
    if (kind == 7) owner.state_ = CellMountedWorkspaceState::unknown;
    if (kind == 8) owner.Close();
  }
};
}
using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* message) { ++checks; if (!condition) throw std::runtime_error(message); }
struct Handle final { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
std::wstring root;
constexpr wchar_t cell_name[] = L"gc-cell-0123456789abcdef0123456789abcdee";
std::wstring CurrentUser() {
  Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "Read fixture identity.");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> bytes{}; DWORD count = 0;
  Check(GetTokenInformation(token.value, TokenUser, bytes.data(), static_cast<DWORD>(bytes.size()), &count) != FALSE, "Read token SID.");
  LPWSTR text = nullptr;
  Check(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &text) != FALSE, "Encode SID.");
  const std::wstring result(text); LocalFree(text); return result;
}
CellFileIdentity Identity(HANDLE handle) {
  FILE_ID_INFO info{};
  Check(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)) != FALSE, "Read fixture file identity.");
  CellFileIdentity result; result.volume_serial = info.VolumeSerialNumber;
  std::memcpy(result.file_id.data(), info.FileId.Identifier, result.file_id.size()); return result;
}
void File(const std::wstring& path) {
  Check(path.rfind(root + L"\\", 0) == 0 && IsLiteralCellPath(path), "Write only in the fresh fixture tree.");
  Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  constexpr char text[] = "capacity evidence"; DWORD written = 0;
  Check(file.value != INVALID_HANDLE_VALUE && WriteFile(file.value, text, sizeof(text) - 1, &written, nullptr) &&
    written == sizeof(text) - 1 && FlushFileBuffers(file.value), "Create exact owned file contents.");
}
struct Fixture final {
  Handle parent;
  CellMountedWorkspace owner;
  std::wstring path;
  unsigned authorizations = 0, verifications = 0, fail_authorization = 0, fail_verification = 0, drift_at = 0, drift_kind = 0;
  CellFootprintScanLimits* change_limits = nullptr;
  HANDLE cancellation = nullptr;
  unsigned cancel_at = 0;
  explicit Fixture(const std::wstring& name, const std::wstring& user) : path(root + L"\\" + name) {
    Check(IsLiteralCellPath(path), "Literal exclusive fixture parent.");
    std::vector<std::uint8_t> descriptor;
    Check(BuildCellParentSecurity(user, user, &descriptor) == ERROR_SUCCESS, "Build fixture parent security.");
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.data(), FALSE};
    Check(CreateDirectoryW(path.c_str(), &attributes) != FALSE, "Create protected ordinary directory, never a volume root.");
    parent.value = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    Check(parent.value != INVALID_HANDLE_VALUE, "Open fixture parent.");
    Check(CellMountedWorkspaceTestPeer::CreateOrdinaryContents(owner, parent.value, Identity(parent.value), user, cell_name) == ERROR_SUCCESS,
      "Create the real protected directories beneath a controlled volume boundary.");
    File(path + L"\\" + cell_name + L"\\work\\result.txt");
  }
  static DWORD Authorize(void* raw) noexcept {
    auto& value = *static_cast<Fixture*>(raw); ++value.authorizations;
    if (value.authorizations == value.fail_authorization) return ERROR_ACCESS_DENIED;
    if (value.change_limits) value.change_limits->max_entries = 65536;
    if (value.authorizations == value.drift_at) CellMountedWorkspaceTestPeer::Drift(value.owner, value.drift_kind);
    if (value.authorizations == value.cancel_at && !SetEvent(value.cancellation)) return GetLastError();
    return ERROR_SUCCESS;
  }
  static DWORD Verify(void* raw, DWORD remaining, HANDLE cancellation) noexcept {
    auto& value = *static_cast<Fixture*>(raw); ++value.verifications;
    if (!remaining || (cancellation && WaitForSingleObject(cancellation, 0) != WAIT_TIMEOUT)) return ERROR_TIMEOUT;
    if (value.verifications == value.fail_verification) return ERROR_FILE_INVALID;
    return CellMountedWorkspaceTestPeer::VerifyContents(value.owner);
  }
  template <typename Output>
  DWORD Read(Output* output, const CellFootprintScanLimits& limits = {}) {
    return CellMountedWorkspaceTestPeer::Read(owner, Verify, this, limits, {Authorize, this, cancellation}, output);
  }
  DWORD Capture(CellDirectoryInventoryPins& pins, CellDirectoryInventory* output, const CellFootprintScanLimits& limits = {}) {
    return CellMountedWorkspaceTestPeer::Capture(owner, Verify, this, limits, {Authorize, this, cancellation}, pins, output);
  }
};
CellDirectoryFootprint Poison() { return {{1, {1}}, 9, 9, 9, 9}; }
const CellDirectoryFootprint& Footprint(const CellDirectoryFootprint& value) { return value; }
const CellDirectoryFootprint& Footprint(const CellDirectoryInventory& value) { return value.footprint; }
template <typename Output> Output PoisonObservation() {
  if constexpr (std::is_same_v<Output, CellDirectoryFootprint>) return Poison();
  else return {Poison(), {{{1, {1}}, false, 9, 9}}};
}
void RetainedTests(const std::wstring& user) {
  Fixture baseline(L"retained-baseline", user); CellDirectoryInventoryPins pins; CellDirectoryInventory output;
  std::vector<CellMountedWorkspaceCheckpoint> before, after;
  Check(!baseline.owner.RecordCheckpoints(&before), "Retain independent mounted history before pinned capture.");
  Check(!baseline.Capture(pins, &output) && pins.Ready() && !pins.Check() && output.entries.size() == 5,
    "Mounted capture retains every real root and file handle after returning.");
  const auto authorizations = baseline.authorizations, verifications = baseline.verifications;
  Check(!pins.Check() && baseline.authorizations == authorizations && baseline.verifications == verifications,
    "Retained readback never calls expired mounted verification or authority contexts.");
  Check(!baseline.owner.RecordCheckpoints(&after) && after == before, "Pinned capture preserves all mounted checkpoint bytes.");
  const auto data = baseline.path + L"\\" + cell_name + L"\\work\\result.txt";
  {
    Handle writer{CreateFileW(data.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, 0, nullptr)};
    Check(writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "Mounted output remains protected against writers during subsequent joined work.");
  }
  Check(baseline.Capture(pins, &output) == ERROR_ALREADY_INITIALIZED && output == CellDirectoryInventory{} && !pins.Check(),
    "A second capture cannot replace an already retained mounted inventory.");
  pins.Close();
  for (unsigned at = 1; at <= authorizations; ++at) {
    Fixture denied(L"retained-denied-" + std::to_wstring(at), user); denied.fail_authorization = at;
    output = PoisonObservation<CellDirectoryInventory>();
    Check(denied.Capture(pins, &output) == ERROR_ACCESS_DENIED && !pins.Ready() && output == CellDirectoryInventory{},
      "Revocation at every retained-capture boundary withholds output and closes pins.");
  }
  Fixture late(L"retained-late-verification", user); late.fail_verification = verifications;
  Check(late.Capture(pins, &output) == ERROR_FILE_INVALID && !pins.Ready() && output == CellDirectoryInventory{},
    "Final mounted verification failure discards a completed inner pinned capture.");
  {
    const auto late_data = late.path + L"\\" + cell_name + L"\\work\\result.txt";
    Handle writer{CreateFileW(late_data.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, 0, nullptr)};
    Check(writer.value != INVALID_HANDLE_VALUE, "A failed outer capture releases the inner file handles.");
  }
  for (unsigned kind = 1; kind <= 8; ++kind) {
    Fixture drift(L"retained-drift-" + std::to_wstring(kind), user); drift.drift_at = authorizations; drift.drift_kind = kind;
    Check(drift.Capture(pins, &output) != ERROR_SUCCESS && !pins.Ready() && output == CellDirectoryInventory{},
      "Last-callback mounted binding or owner drift cannot retain stale evidence.");
  }
  Fixture cancelled(L"retained-cancelled", user); Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(event.value != nullptr, "Create retained mounted cancellation fixture.");
  cancelled.cancellation = event.value; cancelled.cancel_at = authorizations;
  Check(cancelled.Capture(pins, &output) != ERROR_SUCCESS && !pins.Ready() && output == CellDirectoryInventory{},
    "Cancellation during retained mounted capture withholds all output.");
  CellMountedWorkspace absent; CellVolumeMount mount; CellVolumeProtection protection; CellWorkspaceDirectories host;
  Check(absent.CaptureInventory(mount, protection, host, {}, {Fixture::Authorize, &baseline}, pins, &output) != ERROR_SUCCESS &&
    !pins.Ready() && output == CellDirectoryInventory{}, "Production retained entry refuses absent mounted owners.");
}
template <typename Output>
void Tests(const std::wstring& user) {
  Fixture baseline(L"baseline", user); Output output;
  std::vector<CellMountedWorkspaceCheckpoint> before, after;
  Check(baseline.owner.RecordCheckpoints(&before) == ERROR_SUCCESS, "Retain mounted checkpoints before observation.");
  Check(baseline.Read(&output) == ERROR_SUCCESS && Footprint(output).logical_file_bytes == 17 && Footprint(output).file_count == 1 && Footprint(output).directory_count == 4,
    "Mounted owner returns the actual protected tree footprint.");
  if constexpr (std::is_same_v<Output, CellDirectoryInventory>) {
    Handle file{CreateFileW((baseline.path + L"\\" + cell_name + L"\\work\\result.txt").c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(file.value != INVALID_HANDLE_VALUE, "Independently open the known mounted fixture output.");
    const auto identity = Identity(file.value);
    Check(output.entries.size() == 5 && std::count_if(output.entries.begin(), output.entries.end(), [&](const auto& entry) {
      return entry.identity == identity && !entry.directory && entry.logical_file_bytes == 17;
    }) == 1, "Mounted inventory includes each protected root and the exact independently identified output file.");
  }
  const auto calls = baseline.authorizations;
  Check(calls > 2 && baseline.verifications >= calls, "Every authority read has a fresh mounted-boundary verification.");
  Check(baseline.owner.RecordCheckpoints(&after) == ERROR_SUCCESS && after == before && baseline.owner.State() == CellMountedWorkspaceState::recorded,
    "Observation preserves every existing checkpoint byte and provisioning state.");
  for (unsigned at = 1; at <= calls; ++at) {
    Fixture denied(L"deny-" + std::to_wstring(at), user); denied.fail_authorization = at;
    output = PoisonObservation<Output>();
    Check(denied.Read(&output) == ERROR_ACCESS_DENIED && denied.authorizations == at && output == Output{},
      "Revocation at every authority boundary withholds all capacity fields.");
  }
  for (unsigned kind = 1; kind <= 8; ++kind) {
    Fixture drift(L"drift-" + std::to_wstring(kind), user); drift.drift_at = calls; drift.drift_kind = kind;
    output = PoisonObservation<Output>();
    Check(drift.Read(&output) != ERROR_SUCCESS && drift.authorizations == calls && output == Output{},
      "Last-callback mount/security/root/name/workspace/checkpoint/state drift cannot publish old capacity.");
  }
  Fixture verification(L"verification-loss", user); verification.fail_verification = 2;
  output = PoisonObservation<Output>();
  Check(verification.Read(&output) == ERROR_FILE_INVALID && output == Output{},
    "Mounted-boundary failure propagates without a partial result or a retry.");
  Fixture bounded(L"bounds", user); CellFootprintScanLimits limits{4, 64, 10000}; bounded.change_limits = &limits;
  output = PoisonObservation<Output>();
  Check(bounded.Read(&output, limits) != ERROR_SUCCESS && output == Output{},
    "An authority callback cannot widen the frozen inventory bounds.");
  bounded.change_limits = nullptr;
  Check(bounded.Read(&output) == ERROR_SUCCESS, "A bounded refusal does not destroy recorded resources.");
  Fixture cancelled(L"cancelled", user); Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(event.value != nullptr, "Create owned cancellation event.");
  cancelled.cancellation = event.value; cancelled.cancel_at = calls; output = PoisonObservation<Output>();
  Check(cancelled.Read(&output) != ERROR_SUCCESS && cancelled.authorizations == calls && output == Output{},
    "Cancellation during the last authority callback cannot publish capacity.");
  CellMountedWorkspace absent; CellVolumeMount mount; CellVolumeProtection protection; CellWorkspaceDirectories host;
  output = PoisonObservation<Output>();
  DWORD absent_error;
  if constexpr (std::is_same_v<Output, CellDirectoryInventory>) {
    absent_error = absent.ObserveInventory(mount, protection, host, {}, {Fixture::Authorize, &baseline}, &output);
    auto oversized = PoisonObservation<Output>();
    const auto prior_authorizations = baseline.authorizations;
    Check(baseline.Read(&oversized, {20001, 64, 10000}) == ERROR_INVALID_PARAMETER && oversized == Output{} &&
      baseline.authorizations == prior_authorizations, "Oversized identity inventory is refused before any authority callback.");
  } else absent_error = absent.ObserveFootprint(mount, protection, host, {}, {Fixture::Authorize, &baseline}, &output);
  Check(absent_error != ERROR_SUCCESS && output == Output{},
    "Production entry refuses missing mounted resources without creating or recovering them.");
}
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 2 || !IsLiteralCellPath(argv[1])) return 2;
    root = argv[1];
    Check(CreateDirectoryW(root.c_str(), nullptr) != FALSE, "Create exclusive top-level fixture root.");
    const auto user = CurrentUser();
    Tests<CellDirectoryFootprint>(user);
    root += L"\\identity-inventory";
    Check(CreateDirectoryW(root.c_str(), nullptr) != FALSE, "Create isolated identity-inventory fixtures inside the owned test root.");
    Tests<CellDirectoryInventory>(user);
    RetainedTests(user);
    std::printf("{\"passed\":true,\"checks\":%u,\"physicalVolumeVerified\":false,\"volumeOperations\":false}\n", checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s (check %u)\n", error.what(), checks); return 1; }
}
