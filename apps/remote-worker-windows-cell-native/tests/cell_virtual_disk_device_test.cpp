#include "cell_virtual_disk_device.hpp"
#include <virtdisk.h>
#include <cstring>
#include <functional>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (device dependency check " + std::to_string(checks) + ")");
}
struct Fixture final {
  const std::wstring device = L"\\\\.\\PhysicalDrive17";
  const std::wstring host = L"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\";
  const std::wstring relative = L"\\ProgramData\\GoatCitadel\\RemoteWorker\\cells\\gc-cell-test\\control\\cell.vhdx";
  const std::wstring backing = host + relative.substr(1);
  std::vector<std::uint8_t> bytes = std::vector<std::uint8_t>(2048);
  std::size_t used = sizeof(STORAGE_DEPENDENCY_INFO);
  STORAGE_DEPENDENCY_INFO& Info() { return *reinterpret_cast<STORAGE_DEPENDENCY_INFO*>(bytes.data()); }
  STORAGE_DEPENDENCY_INFO_TYPE_2& Entry() { return Info().Version2Entries[0]; }
  wchar_t* String(const std::wstring& value) {
    const auto count = (value.size() + 1) * sizeof(wchar_t);
    if (used + count > bytes.size()) throw std::runtime_error("Dependency fixture overflow.");
    auto* result = reinterpret_cast<wchar_t*>(bytes.data() + used);
    std::memcpy(result, value.c_str(), count); used += count;
    return result;
  }
  Fixture() {
    Info().Version = STORAGE_DEPENDENCY_INFO_VERSION_2; Info().NumberEntries = 1;
    Entry().DependencyTypeFlags = static_cast<DEPENDENT_DISK_FLAG>(DEPENDENT_DISK_FLAG_FULLY_ALLOCATED |
      DEPENDENT_DISK_FLAG_NO_DRIVE_LETTER | DEPENDENT_DISK_FLAG_PERMANENT_LIFETIME);
    Entry().VirtualStorageType = {VIRTUAL_STORAGE_TYPE_DEVICE_VHDX, VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT};
    Entry().DependencyDeviceName = String(device); Entry().HostVolumeName = String(host);
    Entry().DependentVolumeRelativePath = String(relative);
  }
  bool Valid() { return MatchesCellVirtualDiskDependency(std::span(bytes).first(used), device, backing); }
};
}

unsigned RunCellVirtualDiskDeviceMetadataTests() {
  checks = 0;
  {
    Fixture f;
    Check(f.Valid(), "exact direct fixed Microsoft VHDX dependency matches its recorded backing locator");
    f.Entry().AncestorLevel = 1;
    Check(f.Valid(), "single immediate ancestor representation also requires the same exact backing");
    f.Entry().DependencyTypeFlags = static_cast<DEPENDENT_DISK_FLAG>(f.Entry().DependencyTypeFlags | DEPENDENT_DISK_FLAG_SYSTEM_VOLUME_PARENT);
    Check(f.Valid(), "a cell backing file may live on the host system volume without making the cell a system disk");
    f.Entry().DependentVolumeRelativePath = f.String(f.relative.substr(1));
    Check(f.Valid(), "relative dependency path may omit its first separator");
    f.Entry().DependentVolumeName = f.String(L"");
    Check(f.Valid(), "an unformatted attachment has no dependent volume name");
    f.Entry().DependentVolumeName = f.String(f.host);
    Check(f.Valid(), "a canonical dependent volume name is metadata rather than readiness");
  }
  const std::vector<std::pair<const char*, std::function<void(Fixture&)>>> malformed = {
    {"future version", [](auto& f) { f.Info().Version = static_cast<STORAGE_DEPENDENCY_INFO_VERSION>(3); }},
    {"no dependencies", [](auto& f) { f.Info().NumberEntries = 0; }},
    {"multiple dependencies", [](auto& f) { f.Info().NumberEntries = 2; }},
    {"unbounded count", [](auto& f) { f.Info().NumberEntries = MAXDWORD; }},
    {"provider flags", [](auto& f) { f.Entry().ProviderSpecificFlags = 1; }},
    {"nested ancestor", [](auto& f) { f.Entry().AncestorLevel = 2; }},
    {"wrong virtual format", [](auto& f) { f.Entry().VirtualStorageType.DeviceId = VIRTUAL_STORAGE_TYPE_DEVICE_VHD; }},
    {"foreign provider", [](auto& f) { f.Entry().VirtualStorageType.VendorId.Data1 ^= 1; }},
    {"dynamic allocation", [](auto& f) { f.Entry().DependencyTypeFlags = DEPENDENT_DISK_FLAG_NONE; }},
    {"drive-letter attachment", [](auto& f) { f.Entry().DependencyTypeFlags = static_cast<DEPENDENT_DISK_FLAG>(f.Entry().DependencyTypeFlags & ~DEPENDENT_DISK_FLAG_NO_DRIVE_LETTER); }},
    {"temporary attachment", [](auto& f) { f.Entry().DependencyTypeFlags = static_cast<DEPENDENT_DISK_FLAG>(f.Entry().DependencyTypeFlags & ~DEPENDENT_DISK_FLAG_PERMANENT_LIFETIME); }},
    {"missing device", [](auto& f) { f.Entry().DependencyDeviceName = nullptr; }},
    {"missing host", [](auto& f) { f.Entry().HostVolumeName = nullptr; }},
    {"missing relative path", [](auto& f) { f.Entry().DependentVolumeRelativePath = nullptr; }},
    {"pointer before buffer", [](auto& f) { f.Entry().HostVolumeName = reinterpret_cast<wchar_t*>(reinterpret_cast<std::uintptr_t>(f.bytes.data()) - 2); }},
    {"pointer after buffer", [](auto& f) { f.Entry().HostVolumeName = reinterpret_cast<wchar_t*>(f.bytes.data() + f.used); }},
    {"pointer in header", [](auto& f) { f.Entry().HostVolumeName = reinterpret_cast<wchar_t*>(f.bytes.data()); }},
    {"unaligned pointer", [](auto& f) { f.Entry().HostVolumeName = reinterpret_cast<wchar_t*>(reinterpret_cast<std::uint8_t*>(f.Entry().HostVolumeName) + 1); }},
    {"missing terminator", [](auto& f) { f.used -= sizeof(wchar_t); }},
    {"unterminated last byte", [](auto& f) { f.Entry().HostVolumeName = reinterpret_cast<wchar_t*>(f.bytes.data() + f.used - 1); }},
    {"different disk", [](auto& f) { f.Entry().DependencyDeviceName = f.String(L"\\\\.\\PhysicalDrive0"); }},
    {"device suffix", [](auto& f) { f.Entry().DependencyDeviceName = f.String(f.device + L" "); }},
    {"UNC host", [](auto& f) { f.Entry().HostVolumeName = f.String(L"\\\\host\\share\\"); }},
    {"drive-letter host", [](auto& f) { f.Entry().HostVolumeName = f.String(L"C:\\"); }},
    {"different host volume", [](auto& f) { auto host = f.host; host[11] = L'9'; f.Entry().HostVolumeName = f.String(host); }},
    {"different backing file", [](auto& f) { f.Entry().DependentVolumeRelativePath = f.String(f.relative + L".other"); }},
    {"traversal", [](auto& f) { f.Entry().DependentVolumeRelativePath = f.String(L"\\.." + f.relative); }},
    {"alternate stream", [](auto& f) { f.Entry().DependentVolumeRelativePath = f.String(f.relative + L":stream"); }},
    {"two separators", [](auto& f) { f.Entry().DependentVolumeRelativePath = f.String(L"\\" + f.relative); }},
    {"empty path", [](auto& f) { f.Entry().DependentVolumeRelativePath = f.String(L""); }},
    {"malformed volume name", [](auto& f) { f.Entry().DependentVolumeName = f.String(L"\\\\.\\PhysicalDrive17"); }},
  };
  for (const auto& [name, mutate] : malformed) { Fixture f; mutate(f); Check(!f.Valid(), name); }
  for (const ULONG flag : {1UL, 4UL, 8UL, 16UL, 64UL, 256UL, 512UL, 0x80000000UL}) {
    Fixture f;
    f.Entry().DependencyTypeFlags = static_cast<DEPENDENT_DISK_FLAG>(static_cast<ULONG>(f.Entry().DependencyTypeFlags) | flag);
    Check(!f.Valid(), "unknown, remote, differencing, system target, read-only or removable dependencies are refused");
  }
  for (const std::size_t size : {0ULL, 4ULL, 8ULL, sizeof(STORAGE_DEPENDENCY_INFO) - 1}) {
    Fixture f;
    Check(!MatchesCellVirtualDiskDependency(std::span(f.bytes).first(size), f.device, f.backing), "truncated metadata cannot be dereferenced");
  }
  {
    Fixture f;
    std::vector<std::uint8_t> oversized(65537);
    Check(!MatchesCellVirtualDiskDependency(oversized, f.device, f.backing), "oversized metadata is refused before reading any field");
    for (const auto* name : {L"17", L"\\\\.\\PhysicalDrive", L"\\\\.\\PhysicalDrive017", L"\\\\.\\PhysicalDrive4294967295",
      L"\\\\.\\PhysicalDrive42949672960", L"\\\\.\\PhysicalDrive-1", L"\\\\.\\PhysicalDrive17\\partition1"})
      Check(!MatchesCellVirtualDiskDependency(std::span(f.bytes).first(f.used), name, f.backing), "arbitrary, aliased or overflowing device locator is refused");
  }
  CellVirtualDiskDevice device;
  CellVirtualDiskAttachment absent;
  CellWorkspaceDirectories roots;
  Check(!device.Ready() && device.Verify(roots, 1000) == ERROR_INVALID_STATE, "a new device owner holds no authority");
  for (const DWORD limit : {0UL, 600001UL})
    Check(device.Open(absent, roots, limit) == ERROR_INVALID_PARAMETER && !device.Ready(), "invalid deadlines cannot open any device");
  Check(device.Open(absent, roots, 1000) == ERROR_INVALID_STATE && !device.Ready(), "missing attachment cannot open any disk locator");
  Check(device.Open(absent, roots, 1000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE, "invalid cancellation handle cannot open a device");
  HANDLE cancel = CreateEventW(nullptr, TRUE, TRUE, nullptr);
  Check(cancel != nullptr, "create owned cancellation event");
  const DWORD cancelled = device.Open(absent, roots, 1000, cancel);
  CloseHandle(cancel);
  Check(cancelled == ERROR_CANCELLED && !device.Ready(), "cancelled observation never opens a physical device");
  device.Close(); device.Close();
  Check(absent.State() == CellAttachmentState::not_started, "closing device observation does not alter source attachment state");
  return checks;
}
