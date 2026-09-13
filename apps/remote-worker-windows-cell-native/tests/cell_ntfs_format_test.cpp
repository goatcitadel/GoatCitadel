#include "cell_ntfs_format.hpp"
#include "cell_ntfs_format_wmi.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellNtfsFormatTestPeer final {
  static DWORD ReadNativeRoot(const std::wstring& path, std::span<std::uint8_t> bytes, DWORD* used) {
    // Exercise only the production query subroutine. This does not establish
    // protected cell binding for the Windows system volume or permit a write.
    CellVirtualDiskVolume volume; volume.bound_ = true; volume.path_ = path;
    return volume.ReadNtfs(bytes, used, GetTickCount64() + 10000, nullptr);
  }
  static DWORD Run(CellNtfsFormat& owner, const CellNtfsFormatBinding& binding, const CellNtfsFormatCommitter& committer,
    DWORD (*verify)(void*) noexcept, DWORD (*probe)(void*, bool*, CellNtfsIdentity*) noexcept,
    DWORD (*format)(void*, DWORD (*)(void*) noexcept, void*) noexcept, void* context,
    ULONGLONG deadline, HANDLE cancellation) {
    if (owner.attempted_) return ERROR_ALREADY_INITIALIZED;
    owner.attempted_ = true; owner.state_ = CellNtfsFormatState::unknown; owner.binding_ = binding;
    owner.committer_ = committer; owner.records_.reserve(2);
    return owner.Run({verify, probe, format, context}, deadline, cancellation);
  }
  static DWORD Recover(CellNtfsFormat& owner, const CellNtfsFormatBinding& binding,
    const std::vector<CellNtfsFormatCheckpoint>& records, DWORD (*verify)(void*) noexcept,
    DWORD (*probe)(void*, bool*, CellNtfsIdentity*) noexcept, void* context) {
    owner.attempted_ = true; owner.state_ = CellNtfsFormatState::unknown; owner.binding_ = binding; owner.records_ = records;
    return owner.Recover({verify, probe, nullptr, context}, GetTickCount64() + 10000, nullptr);
  }
};
struct CellNtfsFormatWmiTestPeer final {
  static DWORD Parameters(IWbemClassObject* signature, IWbemClassObject** output) { return CellNtfsFormatWmi::Parameters(signature, output); }
  static DWORD Read(const std::wstring& path) {
    CellNtfsTargetFilesystem filesystem{};
    return CellNtfsFormatWmi::Read(path, &filesystem, GetTickCount64() + 10000, nullptr);
  }
  static DWORD RefusedFormat(const std::wstring& path, ULONGLONG deadline, HANDLE cancellation = nullptr) {
    return CellNtfsFormatWmi::Format(path, [](void*) noexcept -> DWORD { return ERROR_ACCESS_DENIED; }, nullptr, deadline, cancellation);
  }
};
}
namespace {
unsigned checks = 0;
constexpr std::uint64_t mib = 1024 * 1024, partition_bytes = 238 * mib;
std::vector<CellNtfsFormatCheckpoint> golden;
void Check(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(std::string(message) + " (format check " + std::to_string(checks) + ")");
}
CellNtfsFormatBinding Binding() {
  CellNtfsFormatBinding value;
  value.layout_sha256.fill(0xa1); value.partition_bytes = partition_bytes;
  value.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
  return value;
}
CellNtfsIdentity Identity() { return {0xfedcba9876543210ULL, partition_bytes / 512 - 1, (partition_bytes / 512 - 1) / 8}; }
NTFS_VOLUME_DATA_BUFFER Kernel() {
  NTFS_VOLUME_DATA_BUFFER value{};
  value.VolumeSerialNumber.QuadPart = static_cast<LONGLONG>(Identity().serial);
  value.NumberSectors.QuadPart = static_cast<LONGLONG>(Identity().sectors);
  value.TotalClusters.QuadPart = static_cast<LONGLONG>(Identity().clusters);
  value.FreeClusters.QuadPart = value.TotalClusters.QuadPart / 2;
  value.BytesPerSector = 512; value.BytesPerCluster = 4096;
  value.BytesPerFileRecordSegment = 1024;
  return value;
}
template<typename T> std::vector<std::uint8_t> Bytes(const T& value) {
  const auto* start = reinterpret_cast<const std::uint8_t*>(&value); return {start, start + sizeof(value)};
}
void Rehash(CellNtfsFormatCheckpoint& bytes) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  Check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "fixture SHA opened");
  const auto result = BCryptHash(algorithm, nullptr, 0, bytes.data(), 480, bytes.data() + 480, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0); Check(result >= 0, "fixture SHA computed");
}
struct Fixture final {
  CellNtfsFormat owner;
  unsigned verifies = 0, probes = 0, authorizations = 0, prepares = 0, writes = 0;
  unsigned fail_verify = 0, fail_probe = 0, fail_authorize = 0, fail_commit = 0, bad_ack = 0;
  DWORD submission_error = 0;
  bool raw = true, authorized = true;
  CellNtfsIdentity identity = Identity();
  std::vector<CellNtfsFormatCheckpoint> retained;
  std::function<void()> preparing, submitted;
  std::function<void(unsigned)> committing, authorizing;
  static DWORD Verify(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw); return ++f.verifies == f.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Authorize(void* raw) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.authorizations;
    try { if (f.authorizing) f.authorizing(f.authorizations); } catch (...) { return ERROR_GEN_FAILURE; }
    return f.authorizations == f.fail_authorize || !f.authorized ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static DWORD Probe(void* raw, bool* is_raw, CellNtfsIdentity* output) noexcept {
    auto& f = *static_cast<Fixture*>(raw); *is_raw = f.raw; *output = f.raw ? CellNtfsIdentity{} : f.identity;
    return ++f.probes == f.fail_probe ? ERROR_IO_DEVICE : ERROR_SUCCESS;
  }
  static DWORD Commit(void* raw, const CellNtfsFormatCheckpoint& record, CellFileSha256* acknowledged) noexcept {
    auto& f = *static_cast<Fixture*>(raw);
    try {
      f.retained.push_back(record); const auto count = static_cast<unsigned>(f.retained.size());
      if (f.committing) f.committing(count);
      if (count == f.fail_commit) return ERROR_TIMEOUT;
      std::copy_n(record.begin() + 480, 32, acknowledged->begin());
      if (count == f.bad_ack) (*acknowledged)[0] ^= 1;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Format(void* raw, DWORD (*guard)(void*) noexcept, void* context) noexcept {
    auto& f = *static_cast<Fixture*>(raw); ++f.prepares;
    try {
      if (f.preparing) f.preparing();
      const DWORD error = guard(context);
      if (error) return error;
      if (f.retained.size() != 1) return ERROR_INVALID_DATA;
      ++f.writes; f.raw = false;
      if (f.submitted) f.submitted();
      return f.submission_error;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  DWORD Run(ULONGLONG deadline = GetTickCount64() + 10000, HANDLE cancellation = nullptr) {
    return CellNtfsFormatTestPeer::Run(owner, Binding(), {Commit, Authorize, this}, Verify, Probe, Format, this, deadline, cancellation);
  }
  DWORD Recover(const std::vector<CellNtfsFormatCheckpoint>& records) {
    return CellNtfsFormatTestPeer::Recover(owner, Binding(), records, Verify, Probe, this);
  }
};
void Metadata() {
  Check(IsValidCellNtfsFormatBinding(Binding()), "complete layout/volume binding accepted");
  for (unsigned field = 0; field < 4; ++field) {
    auto value = Binding();
    if (field == 0) value.layout_sha256.fill(0);
    if (field == 1) value.volume_id = GUID{};
    if (field == 2) value.partition_bytes = 0;
    if (field == 3) ++value.partition_bytes;
    Check(!IsValidCellNtfsFormatBinding(value), "incomplete or unaligned binding rejected");
  }
  const auto bytes = Bytes(Kernel()); CellNtfsIdentity identity{};
  Check(InspectCellNtfsVolume(bytes, partition_bytes, &identity) == 0 && identity == Identity(), "kernel identity decoded including unsigned serial");
  for (std::size_t size = 0; size < bytes.size(); ++size) {
    identity = Identity();
    Check(InspectCellNtfsVolume(std::span(bytes).first(size), partition_bytes, &identity) == ERROR_INVALID_DATA && identity == CellNtfsIdentity{}, "truncated NTFS data rejected and output cleared");
  }
  auto extra = bytes; extra.push_back(0);
  Check(InspectCellNtfsVolume(extra, partition_bytes, &identity) == ERROR_INVALID_DATA, "unknown NTFS suffix rejected");
  for (const auto mutate : std::vector<std::function<void(NTFS_VOLUME_DATA_BUFFER&)>>{
    [](auto& v) { v.VolumeSerialNumber.QuadPart = 0; }, [](auto& v) { v.NumberSectors.QuadPart = -1; },
    [](auto& v) { v.TotalClusters.QuadPart = -1; }, [](auto& v) { v.FreeClusters.QuadPart = -1; },
    [](auto& v) { v.FreeClusters.QuadPart = v.TotalClusters.QuadPart + 1; }, [](auto& v) { v.BytesPerSector = 4096; },
    [](auto& v) { v.BytesPerCluster = 65536; }, [](auto& v) { v.NumberSectors.QuadPart -= 8; },
    [](auto& v) { v.NumberSectors.QuadPart += 2; }, [](auto& v) { --v.TotalClusters.QuadPart; },
  }) { auto value = Kernel(); mutate(value); Check(InspectCellNtfsVolume(Bytes(value), partition_bytes, &identity) == ERROR_FILE_INVALID, "wrong geometry or filesystem identity rejected"); }
  Check(InspectCellNtfsVolume(bytes, UINT64_MAX, &identity) == ERROR_INVALID_PARAMETER, "overflowing partition rejected");
  Check(InspectCellNtfsVolume(bytes, partition_bytes, nullptr) == ERROR_INVALID_PARAMETER, "null output rejected");
}
void Sequence() {
  Fixture success;
  Check(success.Run() == 0, "intent, provider submission, readback and acknowledgement succeed");
  Check(success.writes == 1 && success.retained.size() == 2 && success.owner.State() == CellNtfsFormatState::formatted, "completion has exactly one format and two checkpoints");
  Check(success.probes == 9 && success.authorizations >= 10, "provider send and final acknowledgement recheck NTFS after authority");
  golden = success.retained;
  Check(success.Run() == ERROR_ALREADY_INITIALIZED && success.writes == 1, "same owner never retries");
  { Fixture f; f.raw = false; Check(f.Run() == ERROR_ALREADY_EXISTS && f.retained.empty() && f.writes == 0, "existing NTFS is never reformatted"); }
  for (unsigned point = 1; point <= 2; ++point) {
    for (bool corrupt : {false, true}) {
      Fixture f; if (corrupt) f.bad_ack = point; else f.fail_commit = point;
      const DWORD expected_error = corrupt ? ERROR_INVALID_DATA : ERROR_TIMEOUT;
      Check(f.Run() == expected_error, "lost or different acknowledgement rejected");
      Check(f.writes == (point == 1 ? 0u : 1u) && f.retained.size() == point && f.owner.State() == CellNtfsFormatState::unknown, "uncertain records preserved without completion");
      std::vector<CellNtfsFormatCheckpoint> records;
      Check(f.owner.RecordCheckpoints(&records) == 0 && records == f.retained, "exact submitted bytes remain inspectable");
    }
  }
  for (unsigned point = 1; point <= success.verifies; ++point) {
    Fixture f; f.fail_verify = point; Check(f.Run() == ERROR_FILE_INVALID && f.owner.State() == CellNtfsFormatState::unknown, "identity failure never reports formatted");
    Check(f.verifies == point && f.writes <= 1, "verification failure stops at exact boundary");
  }
  for (unsigned point = 1; point <= success.authorizations; ++point) {
    Fixture f; f.fail_authorize = point; Check(f.Run() == ERROR_ACCESS_DENIED && f.owner.State() == CellNtfsFormatState::unknown, "authority loss never reports formatted");
    Check(f.authorizations == point && f.writes <= 1, "authority loss never retries a write");
  }
  for (unsigned point = 1; point <= success.probes; ++point) {
    Fixture f; f.fail_probe = point; Check(f.Run() == ERROR_IO_DEVICE && f.owner.State() == CellNtfsFormatState::unknown, "RAW or NTFS read uncertainty remains unknown");
  }
  { Fixture f; f.preparing = [&] { f.authorized = false; }; Check(f.Run() == ERROR_ACCESS_DENIED && f.prepares == 1 && f.writes == 0, "authority renewed after provider preparation"); }
  { Fixture f; f.preparing = [&] { f.raw = false; }; Check(f.Run() == ERROR_ALREADY_EXISTS && f.writes == 0, "RAW rechecked immediately before provider send"); }
  { Fixture f; f.preparing = [&] {
      const auto last_send_authorization = f.authorizations + 2;
      f.authorizing = [&, last_send_authorization](unsigned count) { if (count == last_send_authorization) f.raw = false; };
    };
    Check(f.Run() == ERROR_ALREADY_EXISTS && f.writes == 0 && f.retained.size() == 1,
      "filesystem created during the last send authorization must never be formatted"); }
  { Fixture f; f.authorizing = [&](unsigned count) { if (count == success.authorizations) ++f.identity.serial; };
    Check(f.Run() == ERROR_FILE_INVALID && f.owner.State() == CellNtfsFormatState::unknown,
      "filesystem identity changed during final authority cannot be certified"); }
  { Fixture f; f.authorizing = [&](unsigned count) { if (count == success.authorizations) f.fail_verify = f.verifies + 1; };
    Check(f.Run() == ERROR_FILE_INVALID && f.owner.State() == CellNtfsFormatState::unknown,
      "binding changed during final authority cannot be certified"); }
  { Fixture f; f.committing = [&](unsigned phase) { if (phase == 1) f.raw = false; }; Check(f.Run() == ERROR_ALREADY_EXISTS && f.prepares == 0, "checkpoint wait cannot permit overwrite"); }
  { Fixture f; f.submission_error = ERROR_TIMEOUT; Check(f.Run() == ERROR_TIMEOUT && f.writes == 1 && f.retained.size() == 1, "provider timeout preserves uncertain intent without retry"); }
  { Fixture f; f.submitted = [&] { f.identity.serial = 0; }; Check(f.Run() == ERROR_FILE_INVALID && f.retained.size() == 1, "invalid filesystem readback never completes"); }
  { Fixture f; f.committing = [&](unsigned phase) { if (phase == 2) ++f.identity.serial; }; Check(f.Run() == ERROR_FILE_INVALID && f.retained.size() == 2 && f.owner.State() == CellNtfsFormatState::unknown, "changed post-ack filesystem cannot report success"); }
  { Fixture f; Check(f.Run(GetTickCount64()) == ERROR_TIMEOUT && f.writes == 0 && f.retained.empty(), "expired operation stops before intent"); }
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr); Check(event != nullptr, "cancellation event created");
  { Fixture f; f.preparing = [&] { SetEvent(event); }; Check(f.Run(GetTickCount64() + 10000, event) == ERROR_CANCELLED && f.writes == 0, "cancelled preparation never submits format"); }
  ResetEvent(event);
  { Fixture f; f.submitted = [&] { SetEvent(event); }; Check(f.Run(GetTickCount64() + 10000, event) == ERROR_CANCELLED && f.retained.size() == 1, "cancellation after submission remains uncertain"); }
  CloseHandle(event);
  { Fixture f; f.raw = false; Check(f.Recover(golden) == 0 && f.writes == 0 && f.retained.empty() && f.authorizations == 0, "recorded completion verified without a write/commit/authorization callback"); }
  { Fixture f; Check(f.Recover({golden[0]}) == ERROR_IO_INCOMPLETE && f.probes == 0 && f.writes == 0, "partial intent is never resumed"); }
  { Fixture f; Check(f.Recover(golden) == ERROR_FILE_INVALID && f.writes == 0, "RAW disk cannot satisfy recorded completion"); }
  { Fixture f; f.raw = false; ++f.identity.serial; Check(f.Recover(golden) == ERROR_FILE_INVALID && f.writes == 0, "reformatted volume cannot satisfy old completion"); }
  CellVirtualDiskLayout layout; CellWorkspaceDirectories workspace; CellNtfsFormat cold;
  CellNtfsFormatCommitter none{};
  Check(cold.Create(layout, workspace, none, 1000) == ERROR_INVALID_PARAMETER, "missing canonical committer refused");
  Fixture f; none = {Fixture::Commit, Fixture::Authorize, &f};
  Check(cold.Create(layout, workspace, none, 1000) == ERROR_INVALID_STATE && f.writes == 0, "unbound layout cannot enter native formatter");
  Check(cold.Create(layout, workspace, none, 1000) == ERROR_ALREADY_INITIALIZED, "failed native owner is one-shot");
  Check(cold.Verify(workspace, 1000) == ERROR_INVALID_STATE, "failed owner cannot claim readiness");
}
void Records() {
  CellNtfsIdentity identity{};
  Check(DecodeCellNtfsFormatCheckpoints(Binding(), golden, &identity) == 0 && identity == Identity(), "complete chain decoded");
  Check(ValidateCellNtfsFormatCheckpointPrefix(Binding(), std::span(golden).first(1), &identity) == 0 && identity == CellNtfsIdentity{}, "intent prefix has no completed identity");
  for (std::size_t record = 0; record < 2; ++record) for (std::size_t offset = 0; offset < 512; ++offset) {
    auto changed = golden; changed[record][offset] ^= 1;
    Check(DecodeCellNtfsFormatCheckpoints(Binding(), changed, &identity) != 0, "every changed record byte rejected");
  }
  for (std::size_t offset : {8u, 12u, 48u, 80u, 96u, 104u, 108u, 112u, 180u, 208u, 479u}) {
    auto changed = golden; changed[1][offset] ^= 1; Rehash(changed[1]);
    Check(DecodeCellNtfsFormatCheckpoints(Binding(), changed, &identity) != 0, "rehashed wrong phase/binding/settings/padding rejected");
  }
  auto reordered = golden; std::reverse(reordered.begin(), reordered.end());
  Check(DecodeCellNtfsFormatCheckpoints(Binding(), reordered, &identity) != 0, "reordered records rejected");
  reordered = golden; reordered.push_back(golden.back());
  Check(DecodeCellNtfsFormatCheckpoints(Binding(), reordered, &identity) != 0, "extra records rejected");
  auto other = Binding(); ++other.volume_id.Data1;
  Check(DecodeCellNtfsFormatCheckpoints(other, golden, &identity) != 0, "different current volume rejected");
  other = Binding(); other.layout_sha256[0] ^= 1;
  Check(DecodeCellNtfsFormatCheckpoints(other, golden, &identity) != 0, "different canonical layout rejected");
}
}
unsigned RunCellNtfsFormatTests() { Metadata(); Sequence(); Records(); return checks; }
DWORD RunCellNtfsFormatJournalFixture(const CellNtfsFormatBinding& binding, const CellNtfsFormatCommitter& sink,
  unsigned* submissions, DWORD submission_error) noexcept {
  if (!submissions) return ERROR_INVALID_PARAMETER;
  *submissions = 0;
  try {
    Fixture fixture;
    fixture.identity = {0xfedcba9876543210ULL, binding.partition_bytes / 512 - 1, (binding.partition_bytes / 512 - 1) / 8};
    fixture.submission_error = submission_error;
    struct Bridge final { Fixture* fixture; const CellNtfsFormatCommitter* sink; } context{&fixture, &sink};
    const CellNtfsFormatCommitter committer{
      [](void* raw, const CellNtfsFormatCheckpoint& record, CellFileSha256* acknowledged) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw);
        try { value.fixture->retained.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
        return value.sink->commit(value.sink->context, record, acknowledged);
      },
      [](void* raw) noexcept -> DWORD {
        auto& value = *static_cast<Bridge*>(raw); return value.sink->authorize(value.sink->context);
      }, &context,
    };
    const DWORD error = CellNtfsFormatTestPeer::Run(fixture.owner, binding, committer, Fixture::Verify, Fixture::Probe,
      Fixture::Format, &fixture, GetTickCount64() + 10000, nullptr);
    *submissions = fixture.writes;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
std::string CellNtfsFormatCheckpointRecordsJson() {
  std::string output = "[";
  for (const auto& record : golden) {
    if (output.size() > 1) output += ','; output += '"';
    for (const auto byte : record) { char hex[3]{}; sprintf_s(hex, "%02x", byte); output += hex; }
    output += '"';
  }
  return output + ']';
}
#ifdef GOATCITADEL_CELL_FORMAT_STANDALONE
namespace {
template<typename T> struct ComTest final { T* value = nullptr; ~ComTest() { if (value) value->Release(); } };
struct TestApartment final { HRESULT status = CoInitializeEx(nullptr, COINIT_MULTITHREADED); ~TestApartment() { if (SUCCEEDED(status)) CoUninitialize(); } };
void WmiSchema() {
  // Read class metadata only. No real volume is selected and ExecMethod is never
  // called. Inspect the production parameter object against the installed schema.
  TestApartment apartment; Check(SUCCEEDED(apartment.status), "WMI test apartment initialized");
  ComTest<IWbemLocator> locator; ComTest<IWbemServices> services;
  ComTest<IWbemClassObject> definition, signature, parameters;
  Check(SUCCEEDED(CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_IWbemLocator,
    reinterpret_cast<void**>(&locator.value))), "local WMI locator created");
  BSTR space = SysAllocString(L"ROOT\\Microsoft\\Windows\\Storage");
  const auto connected = locator.value->ConnectServer(space, nullptr, nullptr, nullptr, WBEM_FLAG_CONNECT_USE_MAX_WAIT, nullptr, nullptr, &services.value);
  SysFreeString(space); Check(SUCCEEDED(connected), "local storage schema connected");
  BSTR name = SysAllocString(L"MSFT_Volume");
  const auto loaded = services.value->GetObject(name, 0, nullptr, &definition.value, nullptr);
  SysFreeString(name); Check(SUCCEEDED(loaded), "installed MSFT_Volume schema loaded");
  std::array<wchar_t, MAX_PATH + 1> windows{}, root{}; std::array<wchar_t, 50> volume{};
  const UINT length = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  Check(length > 0 && length < windows.size(), "Windows path read for metadata-only probe");
  Check(GetVolumePathNameW(windows.data(), root.data(), static_cast<DWORD>(root.size())) != FALSE, "Windows volume root read");
  Check(GetVolumeNameForVolumeMountPointW(root.data(), volume.data(), static_cast<DWORD>(volume.size())) != FALSE, "Windows volume name read");
  Check(CellNtfsFormatWmiTestPeer::Read(volume.data()) == ERROR_SUCCESS, "production WMI query matches a real volume without formatting");
  std::array<std::uint8_t, sizeof(NTFS_VOLUME_DATA_BUFFER)> kernel{}; DWORD used = 0;
  Check(CellNtfsFormatTestPeer::ReadNativeRoot(volume.data(), kernel, &used) == ERROR_SUCCESS && used == kernel.size(), "production NTFS query reads a real filesystem root with attribute access");
  NTFS_VOLUME_DATA_BUFFER observed{}; std::memcpy(&observed, kernel.data(), sizeof(observed));
  Check(observed.VolumeSerialNumber.QuadPart != 0 && observed.NumberSectors.QuadPart > 0 && observed.TotalClusters.QuadPart > 0, "actual kernel reply contains filesystem identity and geometry");
  Check(CellNtfsFormatTestPeer::ReadNativeRoot(L"C:\\", kernel, &used) == ERROR_INVALID_NAME && used == 0, "root probe rejects unbound path syntax");
  Check(SUCCEEDED(definition.value->GetMethod(L"Format", 0, &signature.value, nullptr)), "installed format signature loaded");
  Check(CellNtfsFormatWmiTestPeer::Parameters(signature.value, &parameters.value) == 0, "production format parameters accepted by Windows schema");
  for (const auto* key : {L"Full", L"Force", L"Compress", L"ShortFileNameSupport", L"UseLargeFRS", L"DisableHeatGathering"}) {
    VARIANT value{}; CIMTYPE type = 0;
    const auto result = parameters.value->Get(key, 0, &value, &type, nullptr);
    const bool valid = SUCCEEDED(result) && type == CIM_BOOLEAN && value.vt == VT_BOOL && value.boolVal == VARIANT_FALSE;
    VariantClear(&value); Check(valid, "force and optional filesystem mutations disabled");
  }
  for (const auto& pair : {std::pair{L"FileSystem", L"NTFS"}, std::pair{L"FileSystemLabel", L"GoatCitadel cell"}}) {
    VARIANT value{}; CIMTYPE type = 0;
    const auto result = parameters.value->Get(pair.first, 0, &value, &type, nullptr);
    const bool valid = SUCCEEDED(result) && type == CIM_STRING && value.vt == VT_BSTR && value.bstrVal && wcscmp(value.bstrVal, pair.second) == 0;
    VariantClear(&value); Check(valid, "fixed filesystem/label parameters");
  }
  VARIANT cluster{}; CIMTYPE type = 0;
  const auto result = parameters.value->Get(L"AllocationUnitSize", 0, &cluster, &type, nullptr);
  const bool valid = SUCCEEDED(result) && type == CIM_UINT32 && cluster.vt == VT_I4 && cluster.lVal == 4096;
  VariantClear(&cluster); Check(valid, "fixed allocation unit parameter");
  Check(CellNtfsFormatWmiTestPeer::RefusedFormat(L"C:\\", GetTickCount64() + 1000) == ERROR_INVALID_NAME, "drive-letter format rejected before COM");
  Check(CellNtfsFormatWmiTestPeer::RefusedFormat(L"\\\\?\\Volume{12345678-9abc-4def-8123-456789abcdef}\\", GetTickCount64()) == ERROR_TIMEOUT, "expired format rejected before COM");
}
}
int wmain() {
  try {
    RunCellNtfsFormatTests(); const auto component_checks = checks;
    WmiSchema();
    std::printf("{\"componentChecks\":%u,\"wmiSchemaChecks\":%u,\"physicalFormattingExercised\":false,\"records\":%s}\n",
      component_checks, checks - component_checks, CellNtfsFormatCheckpointRecordsJson().c_str());
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
#endif
