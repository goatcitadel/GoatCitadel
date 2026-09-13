#include "cell_virtual_disk_volume.hpp"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellVirtualDiskVolumeTestPeer final {
  static void Bind(CellVirtualDiskVolume& owner, const CellDiskLayoutPlan& plan, const CellDiskLayoutSnapshot& snapshot) {
    owner.layout_.plan_ = plan; owner.layout_.snapshot_ = snapshot; owner.disk_number_ = 37;
  }
  static DWORD Inspect(CellVirtualDiskVolume& owner, DWORD (*verify)(void*) noexcept,
    DWORD (*query)(void*, HANDLE, DWORD, std::span<std::uint8_t>, DWORD*) noexcept,
    void* context, ULONGLONG deadline, HANDLE cancellation = nullptr) {
    return owner.Inspect({verify, query, nullptr, nullptr, context}, nullptr, deadline, cancellation);
  }
  static DWORD Discover(CellVirtualDiskVolume& owner, DWORD (*verify)(void*) noexcept,
    DWORD (*query)(void*, HANDLE, DWORD, std::span<std::uint8_t>, DWORD*) noexcept,
    DWORD (*next)(void*, bool, std::wstring*) noexcept, HANDLE (*open)(void*, const std::wstring&) noexcept,
    void* context, ULONGLONG deadline, HANDLE cancellation = nullptr) {
    return owner.Discover({verify, query, next, open, context}, deadline, cancellation);
  }
  static std::wstring Selected(const CellVirtualDiskVolume& owner) { return owner.path_; }
  static DWORD Check(CellVirtualDiskVolume& owner, DWORD (*verify)(void*) noexcept,
    DWORD (*query)(void*, HANDLE, DWORD, std::span<std::uint8_t>, DWORD*) noexcept,
    HANDLE (*open)(void*, const std::wstring&) noexcept, void* context) {
    return owner.Check({verify, query, nullptr, open, context}, GetTickCount64() + 10000, nullptr);
  }
};
}
namespace {
unsigned checks = 0;
constexpr std::uint64_t mib = 1024 * 1024;
const std::wstring volume_name = L"\\\\?\\Volume{abcdef01-2345-4678-89ab-cdef01234567}\\";
void Check(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(std::string(message) + " (volume check " + std::to_string(checks) + ")");
}
CellDiskLayoutPlan Plan() {
  CellDiskLayoutPlan value;
  value.disk.spec = {{0x11111111, 0x2222, 0x4333, {0x84, 5, 6, 7, 8, 9, 10, 11}}, 256 * mib, 384 * mib};
  value.disk.control.volume_serial = value.disk.backing.volume_serial = 101;
  value.disk.control.file_id.fill(0x21); value.disk.backing.file_id.fill(0x42);
  value.gpt_disk_id = {0x44444444, 0x5555, 0x4666, {0x87, 8, 9, 10, 11, 12, 13, 14}};
  value.data_partition_id = {0x77777777, 0x8888, 0x4999, {0x8a, 11, 12, 13, 14, 15, 16, 17}};
  return value;
}
CellDiskLayoutSnapshot Snapshot() {
  CellDiskLayoutSnapshot value;
  value.usable_start = 17408; value.usable_length = 256 * mib - 34304;
  value.data_start = 17 * mib; value.data_length = 238 * mib;
  return value;
}
template<typename T> std::vector<std::uint8_t> Bytes(const T& value) {
  const auto* start = reinterpret_cast<const std::uint8_t*>(&value);
  return {start, start + sizeof(value)};
}
VOLUME_DISK_EXTENTS Extents() {
  VOLUME_DISK_EXTENTS value{};
  value.NumberOfDiskExtents = 1; value.Extents[0].DiskNumber = 37;
  value.Extents[0].StartingOffset.QuadPart = 17 * mib; value.Extents[0].ExtentLength.QuadPart = 238 * mib;
  return value;
}
PARTITION_INFORMATION_EX Partition() {
  PARTITION_INFORMATION_EX value{};
  value.PartitionStyle = PARTITION_STYLE_GPT; value.PartitionNumber = 2;
  value.StartingOffset.QuadPart = 17 * mib; value.PartitionLength.QuadPart = 238 * mib;
  value.Gpt.PartitionType = {0xebd0a0a2, 0xb9e5, 0x4433, {0x87, 0xc0, 0x68, 0xb6, 0xb7, 0x26, 0x99, 0xc7}};
  value.Gpt.PartitionId = Plan().data_partition_id; value.Gpt.Attributes = 0x8000000000000000ULL;
  constexpr wchar_t name[] = L"GoatCitadel cell";
  std::copy(std::begin(name), std::end(name), value.Gpt.Name);
  return value;
}
struct Fixture final {
  CellVirtualDiskVolume owner;
  unsigned verifies = 0, queries = 0, opens = 0, next_calls = 0;
  unsigned fail_verify = 0, fail_query = 0, fail_open = 0;
  DWORD fail_next = 0;
  std::size_t current = 0;
  std::vector<std::wstring> names{volume_name};
  std::function<void(DWORD, std::vector<std::uint8_t>&)> change;
  HANDLE last_open = nullptr;
  Fixture() { CellVirtualDiskVolumeTestPeer::Bind(owner, Plan(), Snapshot()); }
  static DWORD Verify(void* raw) noexcept {
    auto& fixture = *static_cast<Fixture*>(raw);
    return ++fixture.verifies == fixture.fail_verify ? ERROR_FILE_INVALID : ERROR_SUCCESS;
  }
  static DWORD Query(void* raw, HANDLE, DWORD code, std::span<std::uint8_t> output, DWORD* used) noexcept {
    auto& fixture = *static_cast<Fixture*>(raw); *used = 0;
    if (++fixture.queries == fixture.fail_query) return ERROR_ACCESS_DENIED;
    try {
      std::vector<std::uint8_t> bytes;
      if (code == IOCTL_STORAGE_GET_DEVICE_NUMBER) bytes = Bytes(STORAGE_DEVICE_NUMBER{FILE_DEVICE_DISK, 37, 2});
      else if (code == IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS) bytes = Bytes(Extents());
      else if (code == IOCTL_DISK_GET_PARTITION_INFO_EX) bytes = Bytes(Partition());
      else return ERROR_INVALID_FUNCTION; // No write/control IOCTL is accepted.
      if (fixture.change) fixture.change(code, bytes);
      *used = static_cast<DWORD>(bytes.size());
      std::copy_n(bytes.begin(), std::min(bytes.size(), output.size()), output.begin());
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
  static DWORD Next(void* raw, bool first, std::wstring* path) noexcept {
    auto& fixture = *static_cast<Fixture*>(raw); ++fixture.next_calls;
    if (fixture.fail_next) return fixture.fail_next;
    fixture.current = first ? 0 : fixture.current + 1;
    if (fixture.current >= fixture.names.size()) return ERROR_NO_MORE_FILES;
    try { *path = fixture.names[fixture.current]; return ERROR_SUCCESS; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static HANDLE Open(void* raw, const std::wstring&) noexcept {
    auto& fixture = *static_cast<Fixture*>(raw);
    if (++fixture.opens == fixture.fail_open) { SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE; }
    fixture.last_open = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    return fixture.last_open ? fixture.last_open : INVALID_HANDLE_VALUE;
  }
  DWORD Inspect(ULONGLONG deadline = GetTickCount64() + 10000, HANDLE cancellation = nullptr) {
    return CellVirtualDiskVolumeTestPeer::Inspect(owner, Verify, Query, this, deadline, cancellation);
  }
  DWORD Discover(ULONGLONG deadline = GetTickCount64() + 10000, HANDLE cancellation = nullptr) {
    return CellVirtualDiskVolumeTestPeer::Discover(owner, Verify, Query, Next, Open, this, deadline, cancellation);
  }
  DWORD CheckBound() { return CellVirtualDiskVolumeTestPeer::Check(owner, Verify, Query, Open, this); }
};
void Metadata() {
  Check(IsCellVolumeGuidPath(volume_name), "literal volume GUID accepted");
  auto upper = volume_name; std::transform(upper.begin() + 11, upper.begin() + 47, upper.begin() + 11, towupper);
  Check(IsCellVolumeGuidPath(upper), "uppercase GUID accepted");
  for (std::size_t size = 0; size < volume_name.size(); ++size)
    Check(!IsCellVolumeGuidPath(std::wstring_view(volume_name).substr(0, size)), "truncated GUID path rejected");
  for (std::size_t index = 0; index < volume_name.size(); ++index) {
    auto changed = volume_name; changed[index] = L'/';
    Check(!IsCellVolumeGuidPath(changed), "GUID path slash/alias rejected");
  }
  for (const auto& bad : {L"C:\\", L"\\\\.\\PhysicalDrive37", L"\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\",
                         L"\\\\?\\Volume{abcdef01-2345-4678-89ab-cdef01234567}\\..\\", L"\\\\server\\share\\"})
    Check(!IsCellVolumeGuidPath(bad), "caller paths and zero GUID rejected");
  auto path = volume_name; path[20] = L'\0'; Check(!IsCellVolumeGuidPath(path), "embedded null rejected");
  const auto extent = Bytes(Extents()), partition = Bytes(Partition());
  Check(InspectCellVolumeExtent(extent, 37, Snapshot()) == 0, "exact extent accepted");
  Check(InspectCellVolumePartition(partition, Plan(), Snapshot()) == 0, "exact retained partition accepted");
  for (std::size_t size = 0; size < extent.size(); ++size)
    Check(InspectCellVolumeExtent(std::span(extent).first(size), 37, Snapshot()) != 0, "truncated extent rejected");
  for (std::size_t size = 0; size < partition.size(); ++size)
    Check(InspectCellVolumePartition(std::span(partition).first(size), Plan(), Snapshot()) != 0, "truncated partition rejected");
  auto extra = extent; extra.push_back(0); Check(InspectCellVolumeExtent(extra, 37, Snapshot()) != 0, "extent suffix rejected");
  extra = partition; extra.push_back(0); Check(InspectCellVolumePartition(extra, Plan(), Snapshot()) != 0, "partition suffix rejected");
  for (const auto mutate : std::vector<std::function<void(VOLUME_DISK_EXTENTS&)>>{
    [](auto& v) { v.NumberOfDiskExtents = 0; }, [](auto& v) { v.NumberOfDiskExtents = 2; },
    [](auto& v) { v.Extents[0].DiskNumber = 38; }, [](auto& v) { v.Extents[0].StartingOffset.QuadPart = -1; },
    [](auto& v) { ++v.Extents[0].StartingOffset.QuadPart; }, [](auto& v) { v.Extents[0].ExtentLength.QuadPart = -1; },
    [](auto& v) { --v.Extents[0].ExtentLength.QuadPart; },
  }) { auto value = Extents(); mutate(value); Check(InspectCellVolumeExtent(Bytes(value), 37, Snapshot()) != 0, "foreign/spanned/shifted extent rejected"); }
  for (const auto mutate : std::vector<std::function<void(PARTITION_INFORMATION_EX&)>>{
    [](auto& v) { v.PartitionStyle = PARTITION_STYLE_MBR; }, [](auto& v) { v.PartitionNumber = 1; },
    [](auto& v) { ++v.StartingOffset.QuadPart; }, [](auto& v) { --v.PartitionLength.QuadPart; },
    [](auto& v) { v.Gpt.PartitionType = GUID{}; }, [](auto& v) { ++v.Gpt.PartitionId.Data1; },
    [](auto& v) { v.Gpt.Attributes = 0; }, [](auto& v) { v.Gpt.Attributes |= 1; },
    [](auto& v) { v.Gpt.Name[35] = L'x'; }, [](auto& v) { v.Gpt.Name[0] = L'x'; },
  }) { auto value = Partition(); mutate(value); Check(InspectCellVolumePartition(Bytes(value), Plan(), Snapshot()) != 0, "changed GPT identity rejected"); }
  auto snapshot = Snapshot(); snapshot.data_length = UINT64_MAX;
  Check(InspectCellVolumeExtent(extent, 37, snapshot) == ERROR_INVALID_PARAMETER, "overflowing expected extent rejected");
  snapshot.data_length = std::uint64_t{1} << 63;
  Check(InspectCellVolumeExtent(extent, 37, snapshot) == ERROR_INVALID_PARAMETER, "aligned signed-length overflow rejected");
  snapshot = Snapshot(); snapshot.data_start = 0;
  Check(InspectCellVolumeExtent(extent, 37, snapshot) == ERROR_INVALID_PARAMETER, "disk header cannot be selected");
  Check(InspectCellVolumeExtent(extent, MAXDWORD, Snapshot()) == ERROR_INVALID_PARAMETER, "unbound disk number rejected");
}
void Sequencing() {
  { Fixture f; Check(f.Inspect() == 0 && f.verifies == 2 && f.queries == 3, "identity bracketed by layout verification"); }
  { Fixture f; Check(f.CheckBound() == 0 && f.verifies == 4 && f.queries == 6 && f.opens == 1, "held handle and current name verified independently"); }
  { Fixture f; f.fail_open = 1; Check(f.CheckBound() == ERROR_ACCESS_DENIED && f.queries == 3, "lost volume name rejected despite valid held handle"); }
  { Fixture f; f.change = [&](DWORD code, auto& bytes) {
      if (f.opens == 1 && code == IOCTL_DISK_GET_PARTITION_INFO_EX) { auto value = Partition(); ++value.Gpt.PartitionId.Data1; bytes = Bytes(value); }
    };
    Check(f.CheckBound() == ERROR_FILE_INVALID && f.queries == 6, "rebound name rejected despite valid held handle"); }
  for (unsigned point = 1; point <= 2; ++point) {
    Fixture f; f.fail_verify = point; Check(f.Inspect() == ERROR_FILE_INVALID, "layout drift fails closed");
    Check(f.queries == (point == 1 ? 0u : 3u), "no query after initial identity failure");
  }
  for (unsigned point = 1; point <= 3; ++point) {
    Fixture f; f.fail_query = point; Check(f.Inspect() == ERROR_ACCESS_DENIED && f.queries == point, "query failure stops read chain");
    for (const auto size : {0u, 65536u}) {
      Fixture changed; changed.change = [&](DWORD, auto& bytes) { if (changed.queries == point) bytes.resize(size); };
      Check(changed.Inspect() == ERROR_INVALID_DATA && changed.queries == point, "invalid driver byte count rejected");
    }
  }
  for (const auto mutate : std::vector<std::function<void(STORAGE_DEVICE_NUMBER&)>>{
    [](auto& v) { v.DeviceType = FILE_DEVICE_CD_ROM; }, [](auto& v) { ++v.DeviceNumber; }, [](auto& v) { v.PartitionNumber = MAXDWORD; },
  }) {
    Fixture f; f.change = [&](DWORD code, auto& bytes) {
      if (code == IOCTL_STORAGE_GET_DEVICE_NUMBER) { STORAGE_DEVICE_NUMBER value{}; std::memcpy(&value, bytes.data(), sizeof(value)); mutate(value); bytes = Bytes(value); }
    };
    Check(f.Inspect() == ERROR_FILE_INVALID && f.queries == 1, "foreign storage device rejected first");
  }
  { Fixture f; Check(f.Inspect(GetTickCount64()) == ERROR_TIMEOUT && f.queries == 0, "expired read does not query"); }
  HANDLE event = CreateEventW(nullptr, TRUE, TRUE, nullptr); Check(event != nullptr, "cancellation fixture created");
  { Fixture f; Check(f.Inspect(GetTickCount64() + 10000, event) == ERROR_CANCELLED && f.queries == 0, "cancelled read does not query"); }
  CloseHandle(event);
  { Fixture f; Check(f.Inspect(GetTickCount64() + 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE, "invalid cancellation rejected"); }
  { Fixture f; Check(f.Discover() == 0 && f.opens == 1 && f.queries == 4, "unique matching volume selected");
    Check(CellVirtualDiskVolumeTestPeer::Selected(f.owner) == volume_name, "only inspected name retained");
    f.owner.Close(); DWORD flags = 0; Check(!GetHandleInformation(f.last_open, &flags), "selected handle closed by owner"); }
  { Fixture f; f.names.push_back(volume_name); Check(f.Discover() == ERROR_DUP_NAME && f.opens == 2, "duplicate extent names rejected"); }
  { Fixture f; f.names.clear(); Check(f.Discover() == ERROR_NOT_FOUND && f.opens == 0, "absence never binds"); }
  { Fixture f; f.fail_open = 1; Check(f.Discover() == ERROR_NOT_FOUND && f.queries == 0, "inaccessible volume cannot bind"); }
  { Fixture f; f.fail_next = ERROR_ACCESS_DENIED; Check(f.Discover() == ERROR_ACCESS_DENIED && f.opens == 0, "enumeration failure stops selection"); }
  { Fixture f; f.names[0] = L"C:\\"; Check(f.Discover() == ERROR_INVALID_NAME && f.opens == 0, "enumerator aliases never opened"); }
  { Fixture f; f.fail_query = 1; Check(f.Discover() == ERROR_NOT_FOUND, "failed extent query cannot select"); }
  { Fixture f; f.fail_query = 3; Check(f.Discover() == ERROR_ACCESS_DENIED, "matched volume identity failure cannot be skipped"); }
  { Fixture f; f.names.push_back(volume_name); f.names[0][11] = L'1';
    f.change = [&](DWORD code, auto& bytes) { if (f.current == 0 && code == IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS) { auto value = Extents(); value.Extents[0].DiskNumber = 99; bytes = Bytes(value); } };
    Check(f.Discover() == 0 && f.opens == 2 && CellVirtualDiskVolumeTestPeer::Selected(f.owner) == volume_name, "foreign volume skipped before exact match"); }
  { Fixture f; f.names.assign(4097, volume_name); f.change = [](DWORD, auto& bytes) { bytes.clear(); };
    Check(f.Discover(GetTickCount64() + 30000) == ERROR_BUFFER_OVERFLOW && f.opens == 4096, "enumeration is bounded"); }
  { Fixture f; Check(f.Discover(GetTickCount64()) == ERROR_TIMEOUT && f.opens == 0, "expired discovery never opens"); }
  CellVirtualDiskVolume unbound; CellVirtualDiskLayout layout; CellWorkspaceDirectories workspace;
  Check(unbound.Open(layout, workspace, 1000) == ERROR_INVALID_STATE && !unbound.Bound(), "unadmitted source cannot enumerate real devices");
  Check(unbound.Verify(workspace, 1000) == ERROR_INVALID_STATE, "unbound verification rejected");
  Check(unbound.Open(layout, workspace, 0) == ERROR_INVALID_PARAMETER, "zero budget rejected");
  Check(unbound.Open(layout, workspace, 600001) == ERROR_INVALID_PARAMETER, "oversized budget rejected");
}
}
unsigned RunCellVirtualDiskVolumeTests() { Metadata(); Sequencing(); return checks; }
#ifdef GOATCITADEL_CELL_VOLUME_STANDALONE
int wmain() {
  try {
    const unsigned count = RunCellVirtualDiskVolumeTests();
    std::printf("{\"componentChecks\":%u,\"actualVolumeBindingExercised\":false,\"formattingExercised\":false}\n", count);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
#endif
