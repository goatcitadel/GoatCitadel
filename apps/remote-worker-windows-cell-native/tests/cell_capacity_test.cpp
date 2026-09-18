#include "cell_capacity.hpp"
#include "cell_capacity_wire.hpp"
#include "cell_workspace.hpp"
#include "cell_security.hpp"
#include "cell_volume_mount.hpp"
#include <sddl.h>
#include <aclapi.h>
#include <winioctl.h>
#include <array>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
struct CellCapacityLayoutTestPeer final {
  static DWORD VerifyLayout(CellCapacityLayout& layout, const std::wstring& user,
    const CellCapacityRootSecurity& policy, const std::vector<std::uint8_t>& descriptor) {
    return layout.VerifyRetainedSecurity(user, user, policy, descriptor);
  }
};
struct CellCapacityMountLeafTestPeer final {
  // Controlled volume-owner verification only. The scanner below still uses
  // real no-follow directory handles and junction metadata; no volume is mounted.
  static std::unique_ptr<CellCapacityMountLeaf> Make(const CellVolumeMountTarget& target, HANDLE directory,
    void* context, DWORD (*check)(void*) noexcept) {
    return std::unique_ptr<CellCapacityMountLeaf>(new CellCapacityMountLeaf(target, directory, context, check));
  }
};
}

using namespace goatcitadel::worker_cell;
namespace {
unsigned checks = 0;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(message);
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::wstring fixture_root;
std::wstring Child(const std::wstring& parent, const std::wstring& name) {
  const auto path = parent + L"\\" + name;
  std::array<wchar_t, 4096> actual{};
  const DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(actual.size()), actual.data(), nullptr);
  Check(length && length < actual.size() && path == actual.data() && path.rfind(fixture_root + L"\\", 0) == 0,
    "Fixture operation must stay inside the exclusively created directory.");
  return path;
}
std::wstring Directory(const std::wstring& parent, const std::wstring& name) {
  const auto path = Child(parent, name);
  Check(CreateDirectoryW(path.c_str(), nullptr) != FALSE, "Create exclusive fixture directory.");
  return path;
}
void File(const std::wstring& path, std::size_t bytes = 8193) {
  Handle file{CreateFileW((L"\\\\?\\" + path).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Check(file.value != INVALID_HANDLE_VALUE, "Create exclusive fixture file.");
  std::vector<std::uint8_t> content(bytes, 0x61);
  DWORD written = 0;
  Check(WriteFile(file.value, content.data(), static_cast<DWORD>(content.size()), &written, nullptr) && written == bytes &&
    FlushFileBuffers(file.value), "Write exact fixture bytes.");
}
CellFileIdentity Identity(HANDLE handle) {
  FILE_ID_INFO info{};
  Check(GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)) != FALSE, "Read independent fixture identity.");
  CellFileIdentity result; result.volume_serial = info.VolumeSerialNumber;
  std::memcpy(result.file_id.data(), info.FileId.Identifier, result.file_id.size());
  return result;
}
std::uint64_t Allocated(const std::wstring& path) {
  const auto attributes = GetFileAttributesW(path.c_str());
  Check(attributes != INVALID_FILE_ATTRIBUTES, "Read independent fixture allocation attributes.");
  if (!(attributes & (FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED))) {
    Handle file{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    FILE_STANDARD_INFO allocation{};
    Check(file.value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(file.value, FileStandardInfo, &allocation, sizeof(allocation)) &&
      allocation.AllocationSize.QuadPart >= 0, "Read independent ordinary-file NTFS allocation, including preallocation.");
    return static_cast<std::uint64_t>(allocation.AllocationSize.QuadPart);
  }
  DWORD high = 0;
  SetLastError(ERROR_SUCCESS);
  const DWORD low = GetCompressedFileSizeW(path.c_str(), &high);
  Check(low != INVALID_FILE_SIZE || GetLastError() == ERROR_SUCCESS, "Independent path-based allocated-size control.");
  return (static_cast<std::uint64_t>(high) << 32) | low;
}
std::uint64_t DirectoryAllocated(const std::wstring& path) {
  Handle directory{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  FILE_STANDARD_INFO info{};
  Check(directory.value != INVALID_HANDLE_VALUE && GetFileInformationByHandleEx(directory.value, FileStandardInfo, &info, sizeof(info)) &&
    info.AllocationSize.QuadPart >= 0, "Independent directory-allocation control.");
  return static_cast<std::uint64_t>(info.AllocationSize.QuadPart);
}
void ExtraStream(const std::wstring& parent, const std::wstring& path) {
  Check(path.rfind(parent + L"\\", 0) == 0, "Stream fixture stays in its owned root.");
  File(path + L":fixture-stream", 23);
}
void Sparse(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  DWORD returned = 0;
  Check(file.value != INVALID_HANDLE_VALUE && DeviceIoControl(file.value, FSCTL_SET_SPARSE, nullptr, 0, nullptr, 0, &returned, nullptr),
    "Make the owned file sparse.");
  LARGE_INTEGER end{}; end.QuadPart = 1048576;
  Check(SetFilePointerEx(file.value, end, nullptr, FILE_BEGIN) && SetEndOfFile(file.value) && FlushFileBuffers(file.value),
    "Extend sparse logical length without authoring its hole.");
}
void Compress(const std::wstring& path) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  USHORT format = COMPRESSION_FORMAT_DEFAULT; DWORD returned = 0;
  Check(file.value != INVALID_HANDLE_VALUE && DeviceIoControl(file.value, FSCTL_SET_COMPRESSION,
    &format, sizeof(format), nullptr, 0, &returned, nullptr) && FlushFileBuffers(file.value), "Compress the owned file.");
}
void Junction(const std::wstring& path, const std::wstring& target) {
  struct Buffer final {
    DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
    USHORT length = 0, reserved = 0, substitute_offset = 0, substitute_length = 0, print_offset = 0, print_length = 0;
    wchar_t paths[2048]{};
  } buffer;
  const std::wstring substitute = L"\\??\\" + target;
  Check(substitute.size() + target.size() + 2 < std::size(buffer.paths), "Bound fixture junction bytes.");
  buffer.substitute_length = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  buffer.print_offset = static_cast<USHORT>(buffer.substitute_length + sizeof(wchar_t));
  buffer.print_length = static_cast<USHORT>(target.size() * sizeof(wchar_t));
  std::memcpy(buffer.paths, substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
  std::memcpy(reinterpret_cast<std::uint8_t*>(buffer.paths) + buffer.print_offset, target.c_str(), (target.size() + 1) * sizeof(wchar_t));
  buffer.length = static_cast<USHORT>(8 + buffer.print_offset + buffer.print_length + sizeof(wchar_t));
  Handle directory{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
  DWORD returned = 0;
  Check(directory.value != INVALID_HANDLE_VALUE && DeviceIoControl(directory.value, FSCTL_SET_REPARSE_POINT,
    &buffer, 8 + buffer.length, nullptr, 0, &returned, nullptr), "Create owned junction fixture.");
}
DWORD Allow(void*) noexcept { return ERROR_SUCCESS; }
struct Fixture final {
  std::wstring path;
  Handle handle;
  CellFileIdentity identity;
  explicit Fixture(const std::wstring& name) : path(Directory(fixture_root, name)) {
    handle.value = CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    Check(handle.value != INVALID_HANDLE_VALUE, "Open admitted fixture directory.");
    identity = Identity(handle.value);
  }
  DWORD Scan(CellDirectoryFootprint* result, CellFootprintScanLimits limits = {}, CellFootprintScanGuard guard = {Allow}) {
    return ScanCellDirectoryFootprint(handle.value, identity, limits, guard, result);
  }
  DWORD Inventory(CellDirectoryInventory* result, CellFootprintScanLimits limits = {}, CellFootprintScanGuard guard = {Allow}) {
    return ScanCellDirectoryInventory(handle.value, identity, limits, guard, result);
  }
};
CellDirectoryFootprint Poison() { return {{1, {1}}, 99, 99, 99, 99}; }
CellDirectoryInventory PoisonInventory() { return {Poison(), {{{1, {1}}, false, 99, 99}}}; }
void InventoryRefused(Fixture& fixture, CellFootprintScanLimits limits = {}, CellFootprintScanGuard guard = {Allow}) {
  auto output = PoisonInventory();
  Check(fixture.Inventory(&output, limits, guard) != ERROR_SUCCESS && output == CellDirectoryInventory{},
    "A refused identity inventory clears every entry and all previous totals.");
}
void Refused(Fixture& fixture, CellFootprintScanLimits limits = {}, CellFootprintScanGuard guard = {Allow}) {
  auto output = Poison();
  Check(fixture.Scan(&output, limits, guard) != ERROR_SUCCESS && output == CellDirectoryFootprint{},
    "A refused scan must not publish a partial or previous footprint.");
}
struct Mutation final {
  unsigned calls = 0, at = 0;
  bool deny = false, create = false, replace = false, replaced = false, check_pins = false, move = false, moved = false, fired = false, pins_held = false;
  DWORD write_error = 0;
  std::wstring path;
  HANDLE cancellation = nullptr;
  static DWORD Current(void* raw) noexcept {
    auto& state = *static_cast<Mutation*>(raw);
    if (++state.calls != state.at) return ERROR_SUCCESS;
    state.fired = true;
    if (state.deny) return ERROR_ACCESS_DENIED;
    if (state.cancellation) return SetEvent(state.cancellation) ? ERROR_SUCCESS : GetLastError();
    try {
      if (state.create) File(Child(state.path, L"late"), 11);
      if (state.replace) {
        state.replaced = MoveFileW(Child(state.path, L"data").c_str(),
          Child(fixture_root, L"replaced-data-" + std::to_wstring(state.at)).c_str()) != FALSE;
        if (state.replaced) File(Child(state.path, L"data"), 31);
      }
      if (state.check_pins) {
        Handle writer{CreateFileW(Child(state.path, L"data").c_str(), GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
        state.write_error = GetLastError();
        state.pins_held = writer.value == INVALID_HANDLE_VALUE && state.write_error == ERROR_SHARING_VIOLATION;
      }
      if (state.move) state.moved = MoveFileW(state.path.c_str(), Child(fixture_root, L"moved-during-scan").c_str()) != FALSE;
      return ERROR_SUCCESS;
    } catch (...) { return ERROR_GEN_FAILURE; }
  }
};
struct CapacityObserver final {
  std::wstring file, added;
  unsigned calls = 0, discards = 0;
  DWORD failure = ERROR_SUCCESS;
  HANDLE cancellation = nullptr;
  CellCapacityLayout* close_layout = nullptr;
  bool pinned = false, checked = false;
  static DWORD Capture(void* raw, const CellCapacityPinnedView& view) noexcept {
    auto& self = *static_cast<CapacityObserver*>(raw); ++self.calls;
    self.checked = view.Check() == ERROR_SUCCESS;
    if (!self.checked) return ERROR_FILE_INVALID;
    if (!self.file.empty()) {
      Handle writer{CreateFileW(self.file.c_str(), GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr)};
      self.pinned = writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION;
      if (!self.pinned) return ERROR_INVALID_STATE;
    }
    if (!self.added.empty()) {
      Handle added{CreateFileW(self.added.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
      if (added.value == INVALID_HANDLE_VALUE) return GetLastError();
    }
    if (self.cancellation && !SetEvent(self.cancellation)) return GetLastError();
    if (self.close_layout) self.close_layout->Close();
    return self.failure;
  }
  static void Discard(void* raw) noexcept { ++static_cast<CapacityObserver*>(raw)->discards; }
  CellCapacityCaptureObserver Descriptor() { return {this, Capture, Discard}; }
};
void MountLeafAreaTests() {
  std::array<std::unique_ptr<Fixture>, kCellCapacityAreaCount> areas;
  CellCapacityAreaRoots roots;
  for (std::size_t i = 0; i < areas.size(); ++i) {
    areas[i] = std::make_unique<Fixture>(L"mount-leaf-area-" + std::to_wstring(i));
    roots[i] = {areas[i]->handle.value, areas[i]->identity};
  }
  Fixture guest(L"mount-leaf-guest");
  const auto guest_file = Child(guest.path, L"guest-only"); File(guest_file, 23456);
  ExtraStream(guest.path, guest_file); // Traversal would fail, even if bytes were omitted.
  const auto mount_path = Directory(areas[0]->path, L"volume"); Junction(mount_path, guest.path);
  Handle mounted{CreateFileW(mount_path.c_str(), FILE_GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(mounted.value != INVALID_HANDLE_VALUE, "hold the actual junction without following it");
  CellVolumeMountTarget target; target.parent = roots[0].identity; target.directory = Identity(mounted.value);
  target.volume_root = guest.identity; target.volume_id = {0x12345678, 0x9abc, 0x4def, {0x81, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef}};
  struct Owner final {
    unsigned checks = 0, deny_at = 0;
    bool denied = false;
    static DWORD Check(void* raw) noexcept {
      auto& owner = *static_cast<Owner*>(raw);
      return ++owner.checks == owner.deny_at || owner.denied ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
  } owner;
  auto leaf = CellCapacityMountLeafTestPeer::Make(target, mounted.value, &owner, Owner::Check);
  std::array<const CellCapacityMountLeaf*, 1> mounts{leaf.get()};
  CellCapacityBorrowedFiles borrowed{{}, {Allow}, mounts};
  CellCapacityAreaInventories output;
  Check(ScanCellCapacityAreas(roots, {}, {Allow}, &output, &borrowed) == 0,
    "controlled owner capability admits exact host mount leaf without traversing its guest");
  const auto expected = output; const auto checks_before = owner.checks;
  Check(output[0].footprint.file_count == 0 && output[0].footprint.directory_count == 2 && output[0].entries.size() == 2 &&
    output[0].footprint.logical_file_bytes == 0 && output[0].footprint.allocated_bytes ==
      DirectoryAllocated(areas[0]->path) + DirectoryAllocated(mount_path),
    "host charges real mount-directory allocation once and excludes all guest bytes and streams");
  Check(std::any_of(output[0].entries.begin(), output[0].entries.end(), [&](const auto& entry) {
    return entry.identity == target.directory && entry.directory;
  }), "host inventory retains the no-follow leaf identity");
  for (unsigned at : {1U, checks_before}) {
    owner.checks = 0; owner.deny_at = at; output = expected;
    Check(ScanCellCapacityAreas(roots, {}, {Allow}, &output, &borrowed) == ERROR_ACCESS_DENIED &&
      output == CellCapacityAreaInventories{}, "early or final native mount-owner denial clears all areas");
  }
  owner.deny_at = 0;
  for (unsigned kind = 0; kind < 6; ++kind) {
    auto changed = target;
    if (kind == 1) changed.parent = roots[1].identity;
    if (kind == 2) changed.directory.file_id[0] ^= 1;
    auto wrong = CellCapacityMountLeafTestPeer::Make(changed, kind == 3 ? guest.handle.value : mounted.value, &owner, Owner::Check);
    std::array<const CellCapacityMountLeaf*, 2> candidates{kind == 4 ? nullptr : wrong.get(), wrong.get()};
    auto input = borrowed; input.mounts = kind == 0 ? std::span<const CellCapacityMountLeaf* const>{} :
      std::span<const CellCapacityMountLeaf* const>(candidates.data(), kind == 5 ? 2 : 1);
    output = expected;
    Check(ScanCellCapacityAreas(roots, {}, {Allow}, &output, &input) != 0 && output == CellCapacityAreaInventories{},
      "missing, foreign-parent, wrong-identity, following-handle, null and duplicate capabilities are refused");
  }
  output = expected;
  Check(ScanCellCapacityAreas(roots, {}, {Allow}, &output) != 0 && output == CellCapacityAreaInventories{},
    "generic host scans still reject the same junction without an admitted native owner");
  CellDirectoryInventory ordinary;
  Check(areas[0]->Inventory(&ordinary) != 0 && ordinary == CellDirectoryInventory{},
    "single-tree inventory never adopts a mount capability or follows a junction");
  struct Observer final {
    Owner& owner; unsigned calls = 0, discarded = 0;
    static DWORD Read(void* raw, const CellCapacityPinnedView& view) noexcept {
      auto& self = *static_cast<Observer*>(raw); ++self.calls;
      const auto error = view.Check(); self.owner.denied = true; return error;
    }
    static void Discard(void* raw) noexcept { ++static_cast<Observer*>(raw)->discarded; }
  } observer{owner};
  const CellCapacityCaptureObserver descriptor{&observer, Observer::Read, Observer::Discard}; output = expected;
  Check(ScanCellCapacityAreas(roots, {}, {Allow}, &output, &borrowed, &descriptor) == ERROR_ACCESS_DENIED &&
    observer.calls == 1 && observer.discarded == 1 && output == CellCapacityAreaInventories{},
    "post-observer mount revocation discards guest evidence and clears the held host inventory");
  owner.denied = false;
  auto wrong_name = Directory(areas[1]->path, L"alias"); Junction(wrong_name, guest.path); output = expected;
  Check(ScanCellCapacityAreas(roots, {}, {Allow}, &output, &borrowed) != 0 && output == CellCapacityAreaInventories{},
    "an admitted leaf cannot whitelist another junction in another area");
}
void AreaTests() {
  std::array<std::unique_ptr<Fixture>, kCellCapacityAreaCount> areas;
  CellCapacityAreaRoots roots;
  for (std::size_t i = 0; i < areas.size(); ++i) {
    areas[i] = std::make_unique<Fixture>(L"area-" + std::to_wstring(i));
    if (i != 12) File(Child(areas[i]->path, L"data"), i + 1);
    roots[i] = {areas[i]->handle.value, areas[i]->identity};
  }
  CellCapacityAreaInventories result;
  Mutation counter;
  Check(!ScanCellCapacityAreas(roots, {}, {Mutation::Current, &counter}, &result),
    "Read all thirteen real roots in one bounded capture, including an empty area");
  for (std::size_t i = 0; i < areas.size(); ++i) {
    Check(result[i].footprint.root == roots[i].identity && result[i].footprint.directory_count == 1 &&
      result[i].footprint.file_count == (i == 12 ? 0U : 1U) && result[i].footprint.logical_file_bytes == (i == 12 ? 0U : i + 1) &&
      result[i].entries.size() == (i == 12 ? 1U : 2U), "Each area retains independent identity, counts and explicit empty-root coverage");
  }
  const auto original = result;
  for (unsigned mode = 0; mode < 5; ++mode) {
    CapacityObserver observer; observer.file = Child(areas[0]->path, L"data");
    Handle cancellation{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    Check(cancellation.value && cancellation.value != INVALID_HANDLE_VALUE, "Create observer cancellation fixture");
    if (mode == 1) observer.failure = ERROR_ACCESS_DENIED;
    if (mode == 2) observer.added = Child(areas[0]->path, L"observer-added");
    if (mode == 3) observer.cancellation = cancellation.value;
    auto descriptor = observer.Descriptor();
    if (mode == 4) descriptor.discard = nullptr;
    result = original;
    const auto error = ScanCellCapacityAreas(roots, {}, {Allow, nullptr, cancellation.value}, &result, nullptr, &descriptor);
    Check(mode == 0 ? error == ERROR_SUCCESS && result == original : error != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
      "Observer success publishes all areas; callback error, membership drift, cancellation and incomplete observer withhold output");
    Check(observer.calls == (mode == 4 ? 0U : 1U) && observer.discards == (mode == 0 || mode == 4 ? 0U : 1U),
      "Provisional related evidence is discarded exactly once after attempted failed capture");
    if (mode != 4) Check(observer.checked && observer.pinned, "Observer checks the complete host view while a competing writer is refused");
    if (!observer.added.empty()) Check(DeleteFileW(observer.added.c_str()) != FALSE, "Remove only the owned observer mutation fixture");
  }
  for (unsigned mode = 0; mode < 6; ++mode) {
    auto changed = roots; auto limits = CellFootprintScanLimits{};
    if (mode == 0) changed[12] = {};
    if (mode == 1) changed[12] = changed[0];
    if (mode == 2) changed[12].identity.file_id[0] ^= 1;
    if (mode == 3) limits.max_entries = 24;
    if (mode == 4) limits.max_entries = 20001;
    if (mode == 5) limits.wall_limit_ms = 0;
    result = original;
    Check(ScanCellCapacityAreas(changed, limits, {Allow}, &result) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
      "Missing, duplicate, mismatched or over-budget area coverage clears the entire capture");
  }
  Mutation pins; pins.at = counter.calls; pins.check_pins = true; pins.path = areas[0]->path;
  Check(!ScanCellCapacityAreas(roots, {}, {Mutation::Current, &pins}, &result) && pins.fired && pins.pins_held && result == original,
    "The first area's file remains pinned against writers through the final area authority callback");
  Mutation denied; denied.at = counter.calls; denied.deny = true; result = original;
  Check(ScanCellCapacityAreas(roots, {}, {Mutation::Current, &denied}, &result) == ERROR_ACCESS_DENIED && result == CellCapacityAreaInventories{},
    "Late global authority denial withholds every provisional area");
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(stop.value != nullptr && stop.value != INVALID_HANDLE_VALUE, "Create owned area-capture cancellation event");
  Mutation cancelled; cancelled.at = counter.calls; cancelled.cancellation = stop.value; result = original;
  Check(ScanCellCapacityAreas(roots, {}, {Mutation::Current, &cancelled, stop.value}, &result) == ERROR_CANCELLED &&
    cancelled.fired && result == CellCapacityAreaInventories{}, "Late cancellation clears every area before joint publication");
  Mutation invalid_stop; result = original;
  Check(ScanCellCapacityAreas(roots, {}, {Mutation::Current, &invalid_stop, INVALID_HANDLE_VALUE}, &result) == ERROR_INVALID_HANDLE &&
    !invalid_stop.calls && result == CellCapacityAreaInventories{}, "Invalid cancellation handles refuse before invoking the owner");
  Mutation changed; changed.at = counter.calls; changed.create = true; changed.path = areas[0]->path; result = original;
  Check(ScanCellCapacityAreas(roots, {}, {Mutation::Current, &changed}, &result) != ERROR_SUCCESS && changed.fired && result == CellCapacityAreaInventories{},
    "A final callback adding an object to the first area cannot escape the joint membership readback");
  const auto nested = Directory(areas[0]->path, L"nested");
  Handle nested_handle{CreateFileW(nested.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
  auto overlapping = roots; overlapping[12] = {nested_handle.value, Identity(nested_handle.value)}; result = original;
  Check(ScanCellCapacityAreas(overlapping, {}, {Allow}, &result) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
    "Nested area roots cannot charge one physical directory twice");
}

void RetainedInventoryTests() {
  Fixture tree(L"retained-inventory");
  const auto file = Child(tree.path, L"data"); File(file, 7);
  CellDirectoryInventoryPins pins; CellDirectoryInventory inventory;
  Check(!pins.Ready() && pins.Check() == ERROR_INVALID_STATE, "Unopened retained inventory is not evidence");
  Mutation authority;
  Check(!pins.Capture(tree.handle.value, tree.identity, {}, {Mutation::Current, &authority}, &inventory) && pins.Ready(),
    "Capture retains the actual tree handles after returning the inventory");
  const auto calls = authority.calls; const auto original = inventory;
  authority.deny = true; authority.at = authority.calls + 1;
  Check(!pins.Check() && authority.calls == calls,
    "Post-capture readback never calls the expired borrowed authority context");
  {
    Handle writer{CreateFileW(file.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, 0, nullptr)};
    Check(writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "File writes remain excluded after inventory capture returns");
  }
  Check(pins.Capture(tree.handle.value, tree.identity, {}, {Allow}, &inventory) == ERROR_ALREADY_INITIALIZED &&
    inventory == CellDirectoryInventory{} && !pins.Check(), "Reusing an open owner refuses without losing the original pins");
  const auto added = Child(tree.path, L"added"); File(added, 0);
  Check(pins.Check() == ERROR_FILE_INVALID, "A new child invalidates retained directory membership");
  pins.Close(); Check(!pins.Ready() && pins.Check() == ERROR_INVALID_STATE, "Close withdraws inventory custody");
  Check(DeleteFileW(added.c_str()) != FALSE, "Remove only the owned membership mutation fixture");
  {
    Handle writer{CreateFileW(file.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, 0, nullptr)};
    Check(writer.value != INVALID_HANDLE_VALUE, "Close releases retained file handles");
  }
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(stop.value && stop.value != INVALID_HANDLE_VALUE, "Create owned retained-inventory cancellation event");
  Check(!pins.Capture(tree.handle.value, tree.identity, {}, {Allow, nullptr, stop.value}, &inventory) && inventory == original,
    "A closed owner can capture a fresh complete inventory");
  Check(SetEvent(stop.value) && pins.Check() == ERROR_CANCELLED, "Retained readback observes cancellation after capture");
  pins.Close();
  for (unsigned mode = 0; mode < 2; ++mode) {
    struct Reentry final {
      CellDirectoryInventoryPins& pins; Fixture& tree; unsigned mode;
      static DWORD Authorize(void* raw) noexcept {
        auto& self = *static_cast<Reentry*>(raw);
        if (!self.mode) self.pins.Close();
        else { CellDirectoryInventory discarded;
          self.pins.Capture(self.tree.handle.value, self.tree.identity, {}, {Allow}, &discarded); }
        return ERROR_SUCCESS;
      }
    } context{pins, tree, mode};
    inventory = original;
    Check(pins.Capture(tree.handle.value, tree.identity, {}, {Reentry::Authorize, &context}, &inventory) == ERROR_INVALID_STATE &&
      inventory == CellDirectoryInventory{} && !pins.Ready(), "Callback close or reentry withholds provisional inventory and handles");
  }
  auto bad = tree.identity; bad.file_id[0] ^= 1;
  Check(pins.Capture(tree.handle.value, bad, {}, {Allow}, &inventory) == ERROR_FILE_INVALID && !pins.Ready(),
    "Retained inventory still requires the independently admitted root identity");
}

void PinnedFileSelectionTests() {
  Fixture tree(L"pinned-file-selection");
  const auto allowed = Directory(tree.path, L"outputs"), nested = Directory(allowed, L"nested");
  const auto private_directory = Directory(tree.path, L"private");
  File(Child(nested, L"result.bin"), 12); File(Child(private_directory, L"private.bin"), 13);
  File(Child(allowed, L"r\u00e9sum\u00e9.txt"), 14);
  CellFileIdentity root;
  {
    Handle directory{CreateFileW(allowed.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(directory.value != INVALID_HANDLE_VALUE, "Open independent selection root"); root = Identity(directory.value);
  }
  CellDirectoryInventoryPins pins; CellDirectoryInventory inventory;
  const auto capture = [&]() {
    pins.Close(); Check(!pins.Capture(tree.handle.value, tree.identity, {}, {Allow}, &inventory), "Capture selection inventory");
  };
  capture();
  const auto selected = *std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& item) { return item.logical_file_bytes == 12; });
  CellDirectoryInventoryEntry resolved;
  Check(!pins.ResolveFile(root, L"nested/result.bin", {Allow}, &resolved) && resolved == selected && pins.Ready(), "Resolve only captured membership beneath the supplied root");
  Check(!pins.ResolveFile(root, L"NESTED/RESULT.BIN", {Allow}, &resolved) && resolved == selected, "Unambiguous Windows case matching preserves the exact identity");
  Check(!pins.ResolveFile(root, L"r\u00e9sum\u00e9.txt", {Allow}, &resolved) && resolved.logical_file_bytes == 14, "Resolve literal Unicode names without path normalization");
  resolved.identity = root;
  Check(!pins.ResolveFile(resolved.identity, L"nested/result.bin", {Allow}, &resolved) && resolved == selected, "Snapshot aliased root identity before clearing output");
  for (const auto& path : std::vector<std::wstring>{L"", L"/nested/result.bin", L"nested/", L"nested//result.bin", L"./nested/result.bin",
      L"nested/../result.bin", L"nested\\result.bin", L"C:/private.bin", L"//host/share", L"nested/result.bin:stream", L"nested/result.bin.",
      L"nested/result.bin ", L" nested/result.bin", L"CON.txt", L"nested/AUX", L"LPT9.dat", L"conin$", L"out?.bin", L"out*.bin",
      L"out<.bin", L"out|.bin", std::wstring(1, static_cast<wchar_t>(0xd800)), std::wstring(129, L'a'), std::wstring(513, L'a'),
      std::wstring(L"nested/") + wchar_t{0x7f} + L"result.bin", std::wstring(L"nested/") + wchar_t{0x80} + L"result.bin"}) {
    resolved = selected;
    Check(pins.ResolveFile(root, path, {Allow}, &resolved) != 0 && resolved == CellDirectoryInventoryEntry{} && pins.Ready(),
      "Malformed or ambiguous path refuses before consuming retained custody");
  }
  for (const auto path : {L"private/private.bin", L"missing.bin", L"nested", L"nested/result.bin/child"}) {
    capture(); resolved = selected;
    Check(pins.ResolveFile(root, path, {Allow}, &resolved) != 0 && resolved == CellDirectoryInventoryEntry{} && !pins.Ready(),
      "Missing, sibling, directory and file-as-parent paths withhold selection");
  }
  for (const auto directory : {selected.identity, CellFileIdentity{}}) {
    capture(); Check(pins.ResolveFile(directory, L"nested/result.bin", {Allow}, &resolved) == ERROR_FILE_INVALID && resolved == CellDirectoryInventoryEntry{},
      "A file or foreign identity cannot become the selection root");
  }
  capture(); auto mutable_root = root; std::wstring mutable_path = L"nested/result.bin";
  struct Mutation final { CellFileIdentity& root; CellFileIdentity broader; std::wstring& path;
    static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<Mutation*>(raw); self.root = self.broader; self.path = L"private/private.bin"; return ERROR_SUCCESS; }
  } mutation{mutable_root, tree.identity, mutable_path};
  Check(!pins.ResolveFile(mutable_root, mutable_path, {Mutation::Authorize, &mutation}, &resolved) && resolved == selected,
    "Callbacks cannot replace the copied root or relative path");
  for (unsigned at = 1; at <= 3; ++at) {
    capture(); struct Revocation final { unsigned calls = 0, at;
      static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<Revocation*>(raw); return ++self.calls == self.at ? ERROR_CANCELLED : ERROR_SUCCESS; }
    } revoke{0, at};
    Check(pins.ResolveFile(root, L"nested/result.bin", {Revocation::Authorize, &revoke}, &resolved) == ERROR_CANCELLED &&
      resolved == CellDirectoryInventoryEntry{} && !pins.Ready(), "Revocation at every traversal boundary withholds the selected identity");
  }
  for (unsigned mode = 0; mode < 2; ++mode) {
    capture(); struct Reentry final { CellDirectoryInventoryPins& pins; CellFileIdentity root; unsigned mode;
      static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<Reentry*>(raw);
        if (!self.mode) self.pins.Close(); else { CellDirectoryInventoryEntry discarded; self.pins.ResolveFile(self.root, L"nested/result.bin", {Allow}, &discarded); }
        return ERROR_SUCCESS;
      }
    } reentry{pins, root, mode};
    Check(pins.ResolveFile(root, L"nested/result.bin", {Reentry::Authorize, &reentry}, &resolved) == ERROR_INVALID_STATE &&
      resolved == CellDirectoryInventoryEntry{} && !pins.Ready(), "Close or reentry cannot release active selection handles or publish stale metadata");
  }
  capture();
  const auto changed = Child(tree.path, L"changed-selection-membership"); File(changed, 0);
  Check(pins.ResolveFile(root, L"nested/result.bin", {Allow}, &resolved) == ERROR_FILE_INVALID && resolved == CellDirectoryInventoryEntry{},
    "Changed membership anywhere in the retained inventory invalidates selection");
  Check(DeleteFileW(changed.c_str()) != FALSE, "Remove only the owned selection mutation fixture");
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(stop.value && !pins.Capture(tree.handle.value, tree.identity, {}, {Allow, nullptr, stop.value}, &inventory), "Capture cancellable selection lifetime");
  Check(SetEvent(stop.value) != FALSE, "Cancel original selection lifetime");
  Check(pins.ResolveFile(root, L"nested/result.bin", {Allow}, &resolved) == ERROR_CANCELLED && resolved == CellDirectoryInventoryEntry{},
    "New selection authority cannot discard retained cancellation");
  Check(!pins.Capture(tree.handle.value, tree.identity, {20000, 64, 1000}, {Allow}, &inventory), "Capture short selection lifetime");
  Sleep(1001);
  Check(pins.ResolveFile(root, L"nested/result.bin", {Allow}, &resolved) == ERROR_TIMEOUT && resolved == CellDirectoryInventoryEntry{},
    "Selection cannot extend the original capture deadline");
}

void PinnedFileReadTests() {
  Fixture tree(L"pinned-file-export");
  const auto file = Child(tree.path, L"output.bin"); File(file, 131073);
  File(Child(tree.path, L"empty.bin"), 0);
  const auto allowed = Directory(tree.path, L"allowed-artifacts"), nested = Directory(allowed, L"nested");
  const auto private_directory = Directory(tree.path, L"private-control");
  File(Child(nested, L"selected.bin"), 12); File(Child(private_directory, L"private.bin"), 13);
  CellFileIdentity allowed_identity;
  {
    Handle directory{CreateFileW(allowed.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(directory.value != INVALID_HANDLE_VALUE, "Independently open the approved artifact directory");
    allowed_identity = Identity(directory.value);
  }
  CellDirectoryInventoryPins pins; CellDirectoryInventory inventory;
  const auto capture = [&]() {
    pins.Close();
    Check(!pins.Capture(tree.handle.value, tree.identity, {}, {Allow}, &inventory), "Capture exact export inventory");
  };
  capture();
  const auto full = *std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& item) { return item.logical_file_bytes == 131073; });
  const auto empty = *std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& item) { return !item.directory && !item.logical_file_bytes; });
  std::vector<std::uint8_t> bytes;
  const auto selected = *std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& item) { return item.logical_file_bytes == 12; });
  const auto excluded = *std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& item) { return item.logical_file_bytes == 13; });
  Check(!pins.ReadFileContent(allowed_identity, selected, 12, {Allow}, &bytes) && bytes == std::vector<std::uint8_t>(12, 0x61),
    "Pinned ancestry admits a nested output under the approved directory");
  Check(pins.ReadFileContent(allowed_identity, excluded, 13, {Allow}, &bytes) == ERROR_FILE_INVALID && bytes.empty(),
    "Same-volume retained files in a sibling private directory are not exportable");
  capture();
  Check(pins.ReadFileContent(selected.identity, selected, 12, {Allow}, &bytes) == ERROR_FILE_INVALID && bytes.empty(),
    "A file identity cannot impersonate an approved directory");
  capture(); auto foreign_directory = allowed_identity; foreign_directory.volume_serial ^= 1;
  Check(pins.ReadFileContent(foreign_directory, selected, 12, {Allow}, &bytes) == ERROR_FILE_INVALID && bytes.empty(),
    "An unretained directory cannot select a retained file");
  capture(); auto mutable_directory = allowed_identity;
  struct ScopeMutation final { CellFileIdentity& supplied; CellFileIdentity broader;
    static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<ScopeMutation*>(raw); self.supplied = self.broader; return ERROR_SUCCESS; }
  } scope_mutation{mutable_directory, tree.identity};
  Check(pins.ReadFileContent(mutable_directory, excluded, 13, {ScopeMutation::Authorize, &scope_mutation}, &bytes) == ERROR_FILE_INVALID && bytes.empty(),
    "Authority callbacks cannot broaden the snapshotted directory to a parent");
  capture();
  for (unsigned repeat = 0; repeat < 2; ++repeat) {
    Check(!pins.ReadFileContent(tree.identity, full, 131073, {Allow}, &bytes) && bytes == std::vector<std::uint8_t>(131073, 0x61),
      "Pinned reads return exact full content and reset the file position on a later authorized read");
    Check(!pins.Check(), "Successful export retains original inventory custody");
  }
  Check(!pins.ReadFileContent(tree.identity, empty, 1, {Allow}, &bytes) && bytes.empty(), "A retained empty file is a successful empty export");
  for (const auto maximum : {0U, 1048577U, 131072U}) {
    bytes = {0x61};
    Check(pins.ReadFileContent(tree.identity, full, maximum, {Allow}, &bytes) == ERROR_INVALID_PARAMETER && bytes.empty(), "Reject invalid or insufficient export bound");
  }
  auto changed = full; changed.identity.file_id[0] ^= 1;
  Check(pins.ReadFileContent(tree.identity, changed, 131073, {Allow}, &bytes) == ERROR_FILE_INVALID && bytes.empty() && !pins.Ready(),
    "A foreign file identity cannot select another object or retain failed custody");
  capture(); changed = full; changed.allocated_bytes += 1;
  Check(pins.ReadFileContent(tree.identity, changed, 131073, {Allow}, &bytes) == ERROR_FILE_INVALID && bytes.empty(), "Reject changed inventory accounting");
  for (unsigned at = 1; at <= 5; ++at) {
    capture();
    struct Revocation final { unsigned calls = 0, at;
      static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<Revocation*>(raw); return ++self.calls == self.at ? ERROR_CANCELLED : ERROR_SUCCESS; }
    } revoke{0, at};
    bytes = {0x61};
    Check(pins.ReadFileContent(tree.identity, full, 131073, {Revocation::Authorize, &revoke}, &bytes) == ERROR_CANCELLED &&
      bytes.empty() && !pins.Ready(), "Revocation before, between or after chunks withholds all content");
  }
  for (unsigned mode = 0; mode < 2; ++mode) {
    capture();
    struct Reentry final { CellDirectoryInventoryPins& pins; CellDirectoryInventoryEntry expected; unsigned mode;
      static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<Reentry*>(raw);
        if (!self.mode) self.pins.Close();
        else { std::vector<std::uint8_t> discarded; self.pins.ReadFileContent(self.expected.identity, self.expected, 131073, {Allow}, &discarded); }
        return ERROR_SUCCESS;
      }
    } reentry{pins, full, mode};
    Check(pins.ReadFileContent(tree.identity, full, 131073, {Reentry::Authorize, &reentry}, &bytes) == ERROR_INVALID_STATE && bytes.empty() && !pins.Ready(),
      "Close or recursive read from authority cannot publish content or destroy live stack custody");
  }
  capture();
  const auto added = Child(tree.path, L"changed-membership"); File(added, 0);
  Check(pins.ReadFileContent(tree.identity, full, 131073, {Allow}, &bytes) == ERROR_FILE_INVALID && bytes.empty(), "Changed directory membership invalidates export");
  Check(DeleteFileW(added.c_str()) != FALSE, "Remove only this test's changed-membership file");
  capture();
  struct MidReadMutation final { std::wstring path; unsigned calls = 0;
    static DWORD Authorize(void* raw) noexcept { auto& self = *static_cast<MidReadMutation*>(raw);
      if (++self.calls != 3) return ERROR_SUCCESS;
      const HANDLE created = CreateFileW(self.path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (created == INVALID_HANDLE_VALUE) return GetLastError();
      return CloseHandle(created) ? ERROR_SUCCESS : GetLastError();
    }
  } mutation{Child(tree.path, L"mid-read-membership")};
  Check(pins.ReadFileContent(tree.identity, full, 131073, {MidReadMutation::Authorize, &mutation}, &bytes) == ERROR_FILE_INVALID &&
    mutation.calls == 3 && bytes.empty() && !pins.Ready(), "Membership change after a content chunk discards the partial read");
  Check(DeleteFileW(mutation.path.c_str()) != FALSE, "Remove only this test's mid-read membership fixture");
  Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(stop.value && stop.value != INVALID_HANDLE_VALUE, "Create export cancellation fixture");
  Check(!pins.Capture(tree.handle.value, tree.identity, {}, {Allow, nullptr, stop.value}, &inventory), "Capture with retained cancellation");
  Check(SetEvent(stop.value) != FALSE, "Cancel original inventory lifetime");
  Check(pins.ReadFileContent(tree.identity, full, 131073, {Allow}, &bytes) == ERROR_CANCELLED && bytes.empty(), "Fresh authority cannot discard capture cancellation");
  Check(!pins.Capture(tree.handle.value, tree.identity, {20000, 64, 1000}, {Allow}, &inventory), "Capture a bounded export lifetime");
  Sleep(1001);
  Check(pins.ReadFileContent(tree.identity, full, 131073, {Allow}, &bytes) == ERROR_TIMEOUT && bytes.empty(), "Export cannot extend the original inventory deadline");
}

void InventoryTests() {
  Fixture tree(L"identity-inventory");
  const auto sub = Directory(tree.path, L"sub"), normal = Child(tree.path, L"plain"),
    zero = Child(sub, L"empty"), sparse = Child(sub, L"sparse"), compressed = Child(sub, L"compressed");
  File(normal, 8193); File(zero, 0); File(sparse, 0); Sparse(sparse); File(compressed, 131072); Compress(compressed);
  Check(Allocated(normal) > 8193, "An ordinary non-aligned file charges allocated clusters rather than only its logical EOF.");
  std::vector<CellDirectoryInventoryEntry> expected;
  const auto record = [&](const std::wstring& path, bool directory, std::uint64_t logical) {
    Handle object{CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    Check(object.value != INVALID_HANDLE_VALUE, "Independently open a known inventory fixture object.");
    expected.push_back({Identity(object.value), directory, logical, directory ? DirectoryAllocated(path) : Allocated(path)});
  };
  record(tree.path, true, 0); record(sub, true, 0); record(normal, false, 8193);
  record(zero, false, 0); record(sparse, false, 1048576); record(compressed, false, 131072);
  std::sort(expected.begin(), expected.end(), [](const auto& a, const auto& b) {
    return a.identity.volume_serial != b.identity.volume_serial ? a.identity.volume_serial < b.identity.volume_serial :
      a.identity.file_id < b.identity.file_id;
  });
  CellDirectoryInventory inventory;
  const auto inventory_error = tree.Inventory(&inventory, {6, 2, 10000});
  if (inventory_error) std::fprintf(stderr, "Identity inventory Win32 error: %lu\n", inventory_error);
  Check(inventory_error == ERROR_SUCCESS, "Read complete identity inventory through admitted handles.");
  Check(inventory.entries == expected, "Every returned identity, kind and byte count matches an independently opened file or directory.");
  CellDirectoryFootprint footprint;
  Check(tree.Scan(&footprint, {6, 2, 10000}) == ERROR_SUCCESS && inventory.footprint == footprint,
    "Identity inventory totals preserve the existing aggregate observation contract.");
  std::uint64_t allocated = 0;
  for (const auto& entry : expected) allocated += entry.allocated_bytes;
  Check(footprint.file_count == 4 && footprint.directory_count == 2 && footprint.logical_file_bytes == 1187841 &&
    footprint.allocated_bytes == allocated, "Identity inventory includes sparse, compressed and zero-byte files and directory allocation exactly once.");
  const auto first = inventory;
  Check(tree.Inventory(&inventory) == ERROR_SUCCESS && inventory == first, "Unchanged identity inventory is deterministic.");
  Check(ScanCellDirectoryInventory(tree.handle.value, inventory.footprint.root, {}, {Allow}, &inventory) == ERROR_SUCCESS && inventory == first,
    "Snapshot a retained root identity before clearing the caller's reused inventory output.");
  Check(ScanCellDirectoryFootprint(tree.handle.value, footprint.root, {}, {Allow}, &footprint) == ERROR_SUCCESS && footprint == first.footprint,
    "Aggregate scans also snapshot a root identity stored in the reused output.");
  InventoryRefused(tree, {5, 2, 10000}); InventoryRefused(tree, {6, 1, 10000});
  InventoryRefused(tree, {20001, 64, 10000}); InventoryRefused(tree, {}, {});
  auto wrong = tree.identity; wrong.file_id[15] ^= 1;
  inventory = first;
  Check(ScanCellDirectoryInventory(tree.handle.value, wrong, {}, {Allow}, &inventory) == ERROR_FILE_INVALID &&
    inventory == CellDirectoryInventory{}, "A changed admitted root clears the identity inventory.");
  Check(ScanCellDirectoryInventory(tree.handle.value, tree.identity, {}, {Allow}, nullptr) == ERROR_INVALID_PARAMETER,
    "Identity inventory requires an output owner.");
  Mutation counter;
  Check(tree.Inventory(&inventory, {}, {Mutation::Current, &counter}) == ERROR_SUCCESS && counter.calls > 3,
    "Find actual identity-inventory authority boundaries.");
  for (unsigned at = 1; at <= counter.calls; ++at) {
    Mutation denied; denied.at = at; denied.deny = true;
    InventoryRefused(tree, {}, {Mutation::Current, &denied});
    Check(denied.fired && denied.calls == at, "Inventory revocation stops at its exact authority boundary.");
  }
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(event.value != nullptr, "Create identity-inventory cancellation event.");
  Mutation cancelled; cancelled.at = counter.calls; cancelled.cancellation = event.value;
  InventoryRefused(tree, {}, {Mutation::Current, &cancelled, event.value});
  Check(cancelled.fired, "Cancellation after the last authority callback withholds identity records.");
}
void RaceTests() {
  Fixture baseline(L"race-baseline"); File(Child(baseline.path, L"data"), 7);
  Mutation counter; CellDirectoryFootprint result;
  Check(baseline.Scan(&result, {}, {Mutation::Current, &counter}) == ERROR_SUCCESS && counter.calls > 3,
    "Measure the actual authority boundaries of one complete read.");
  for (unsigned at = 1; at <= counter.calls; ++at) {
    Fixture addition(L"addition-" + std::to_wstring(at)); File(Child(addition.path, L"data"), 7);
    Mutation mutate; mutate.at = at; mutate.create = true; mutate.path = addition.path;
    result = Poison(); const auto error = addition.Scan(&result, {}, {Mutation::Current, &mutate});
    Check(mutate.fired && (error ? result == CellDirectoryFootprint{} :
      result.file_count == 2 && result.logical_file_bytes == 18),
      "An authority-time child addition is either counted completely or invalidates the observation.");
    Mutation denied; denied.at = at; denied.deny = true;
    Refused(baseline, {}, {Mutation::Current, &denied});
    Check(denied.fired && denied.calls == at, "Authority revocation stops at the exact read boundary.");
    Fixture replacement(L"replacement-" + std::to_wstring(at)); File(Child(replacement.path, L"data"), 7);
    Mutation replace; replace.at = at; replace.replace = true; replace.path = replacement.path;
    result = Poison(); const auto replaced_error = replacement.Scan(&result, {}, {Mutation::Current, &replace});
    Check(replace.fired && (replaced_error ? result == CellDirectoryFootprint{} :
      result.file_count == 1 && result.logical_file_bytes == (replace.replaced ? 31U : 7U)),
      "A changed entry cannot inherit an enumerated file identity or return a stale byte count.");
  }
  Mutation pin; pin.at = counter.calls; pin.check_pins = true; pin.path = baseline.path;
  const auto pin_error = baseline.Scan(&result, {}, {Mutation::Current, &pin});
  if (pin_error || !pin.pins_held) std::fprintf(stderr, "pin scan=%lu writer=%lu held=%d\n", pin_error, pin.write_error, pin.pins_held);
  Check(pin_error == ERROR_SUCCESS && pin.fired && pin.pins_held,
    "Child data writes are excluded until the final readback.");
  Fixture renamed(L"renamed-during-scan"); File(Child(renamed.path, L"data"), 7);
  Mutation rename; rename.at = counter.calls; rename.move = true; rename.path = renamed.path;
  result = Poison(); const auto rename_error = renamed.Scan(&result, {}, {Mutation::Current, &rename});
  Check(rename.fired && (rename.moved ? rename_error != ERROR_SUCCESS && result == CellDirectoryFootprint{} :
    rename_error == ERROR_SUCCESS && result.file_count == 1 && result.logical_file_bytes == 7),
    "A root rename is either prevented by the OS or invalidates the final inventory; an ID handle is not a name lease.");
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(event.value != nullptr, "Create cancellation-during-authority event.");
  Mutation cancelled; cancelled.at = counter.calls; cancelled.cancellation = event.value;
  Refused(baseline, {}, {Mutation::Current, &cancelled, event.value});
  Check(cancelled.fired, "Cancellation after the final authority callback is observed before success.");
  Handle timeout_event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  Check(timeout_event.value != nullptr, "Create an owned event for the cooperative deadline check.");
  const CellFootprintScanGuard delayed{[](void* raw) noexcept -> DWORD {
    return WaitForSingleObject(static_cast<HANDLE>(raw), 50) == WAIT_TIMEOUT ? ERROR_SUCCESS : ERROR_GEN_FAILURE;
  }, timeout_event.value};
  result = Poison();
  Check(baseline.Scan(&result, {20, 64, 10}, delayed) == ERROR_TIMEOUT && result == CellDirectoryFootprint{},
    "Time spent inside the authority callback cannot extend the scanner's fixed deadline.");
  Fixture moved(L"moved"); File(Child(moved.path, L"original"), 19);
  const auto retained = Child(fixture_root, L"retained-original");
  Check(MoveFileW(moved.path.c_str(), retained.c_str()) && CreateDirectoryW(moved.path.c_str(), nullptr),
    "Create an owned same-path replacement while retaining the original admitted handle.");
  File(Child(moved.path, L"replacement"), 777);
  Check(moved.Scan(&result) == ERROR_SUCCESS && result.root == moved.identity && result.logical_file_bytes == 19 && result.file_count == 1,
    "An admitted handle never adopts the object currently occupying its old path.");
}
std::wstring CurrentUser() {
  Handle token; Check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != FALSE, "Open fixture token for its own SID.");
  alignas(TOKEN_USER) std::array<std::uint8_t, 4096> bytes{}; DWORD returned = 0;
  Check(GetTokenInformation(token.value, TokenUser, bytes.data(), static_cast<DWORD>(bytes.size()), &returned) != FALSE,
    "Read fixture token user.");
  LPWSTR sid = nullptr;
  Check(ConvertSidToStringSidW(reinterpret_cast<const TOKEN_USER*>(bytes.data())->User.Sid, &sid) != FALSE, "Encode fixture SID.");
  const std::wstring user(sid); LocalFree(sid); return user;
}
struct SecurityDrift final {
  unsigned calls = 0, at = 0;
  std::wstring path, user;
  static DWORD Current(void* raw) noexcept {
    auto& state = *static_cast<SecurityDrift*>(raw);
    if (++state.calls != state.at) return ERROR_SUCCESS;
    try {
      PSECURITY_DESCRIPTOR descriptor = nullptr;
      const auto sddl = L"D:P(A;OICI;FA;;;" + state.user + L")";
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return GetLastError();
      PACL dacl = nullptr; BOOL present = FALSE, defaulted = FALSE;
      DWORD error = GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) ? ERROR_SUCCESS : GetLastError();
      Handle directory{CreateFileW(state.path.c_str(), READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
      if (!error && directory.value == INVALID_HANDLE_VALUE) error = GetLastError();
      if (!error) error = SetSecurityInfo(directory.value, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, dacl, nullptr);
      LocalFree(descriptor); return error;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
};
void LayoutTests() {
  const auto user = CurrentUser(); std::vector<std::uint8_t> descriptor;
  Check(!BuildCellParentSecurity(user, user, &descriptor), "Build protected layout fixture security");
  SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
  std::array<Handle, kCellCapacityAreaCount> handles;
  std::array<std::wstring, kCellCapacityAreaCount> paths;
  CellCapacityAreaRoots roots; CellCapacityLayoutRecord record;
  record.assignment_binding.fill(0x11); record.profile_sha256.fill(0x22);
  for (std::size_t i = 0; i < roots.size(); ++i) {
    paths[i] = Child(fixture_root, L"layout-" + std::to_wstring(i));
    Check(CreateDirectoryW(paths[i].c_str(), &security) != FALSE, "Exclusively create a protected layout fixture root");
    handles[i].value = CreateFileW(paths[i].c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    record.roots[i] = Identity(handles[i].value); roots[i] = {handles[i].value, record.roots[i]};
    File(Child(paths[i], L"data"), i + 1);
  }
  CellCapacityLayout layout; CellCapacityAreaInventories result;
  Check(!layout.OpenRecorded(record, roots, user, user), "Open thirteen protected roots against separately retained layout identities");
  Mutation counter;
  Check(!layout.Scan(record, {}, {Mutation::Current, &counter}, &result) && result[12].footprint.logical_file_bytes == 13,
    "Protected layout owner composes real multi-area collection with current security checks");
  const auto original = result;
  Check(!CellCapacityLayoutTestPeer::VerifyLayout(layout, user, {}, descriptor),
    "Joined collector preserves exact legacy root security");
  {
    struct Membership final {
      CellFileIdentity root, file;
      unsigned mode = 0, calls = 0;
      static DWORD Capture(void* raw, const CellCapacityPinnedView& view) noexcept {
        auto& self = *static_cast<Membership*>(raw); ++self.calls;
        try {
          auto root = self.root;
          std::vector<CellCapacityChild> expected{{L"data", self.file, false}};
          if (self.mode == 1) expected.clear();
          if (self.mode == 2) expected[0].identity.file_id[0] ^= 1;
          if (self.mode == 3) expected[0].name = L"DATA";
          if (self.mode == 4) expected[0].directory = true;
          if (self.mode == 5) expected.push_back({L"other", self.file, false});
          if (self.mode == 6) root = self.file;
          if (self.mode == 7) expected[0].identity.volume_serial ^= 1;
          const auto error = view.VerifyChildren(root, expected);
          return (self.mode == 0) == (error == ERROR_SUCCESS) ? ERROR_SUCCESS : ERROR_INVALID_DATA;
        } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      }
      static void Discard(void*) noexcept {}
    } membership{record.roots[0]};
    const auto file = std::find_if(original[0].entries.begin(), original[0].entries.end(), [](const auto& entry) { return !entry.directory; });
    Check(file != original[0].entries.end(), "retain the independently observed child identity for membership tests");
    membership.file = file->identity;
    const CellCapacityCaptureObserver observer{&membership, Membership::Capture, Membership::Discard};
    for (unsigned mode = 0; mode < 8; ++mode) {
      membership.mode = mode; membership.calls = 0;
      Check(!layout.Scan(record, {}, {Allow}, &result, nullptr, &observer) && membership.calls == 1 && result == original,
        "pinned membership requires exact names, identities, types and complete child coverage");
    }
  }
  {
    struct SecurityOwner final {
      const CellCapacityLayoutRecord& record;
      const std::vector<std::uint8_t>& descriptor;
      CellCapacityLayout& layout;
      const std::vector<std::uint8_t>* alternate = nullptr;
      unsigned calls = 0;
      bool deny = false, close = false;
      static DWORD Verify(void* raw, CellCapacityArea area, HANDLE handle, const CellFileIdentity& identity) noexcept {
        auto& self = *static_cast<SecurityOwner*>(raw); ++self.calls;
        const auto index = static_cast<unsigned>(area);
        if (index >= kCellCapacityAreaCount || identity != self.record.roots[index]) return ERROR_FILE_INVALID;
        if (self.close) self.layout.Close();
        if (self.deny) return ERROR_ACCESS_DENIED;
        return VerifyCellSecurity(handle, index == 1 && self.alternate ? *self.alternate : self.descriptor);
      }
    } owner{record, descriptor, layout};
    Check(layout.OpenRecordedWithSecurity(record, roots, {}) == ERROR_INVALID_PARAMETER,
      "Mixed-root security requires an explicit trusted owner");
    CellCapacityRootSecurity policy{&owner, SecurityOwner::Verify};
    Check(!layout.OpenRecordedWithSecurity(record, roots, policy) && owner.calls == kCellCapacityAreaCount,
      "Trusted policy checks every pinned root against its independently retained area identity");
    policy.verify = nullptr;
    Check(CellCapacityLayoutTestPeer::VerifyLayout(layout, user, policy, {}) == ERROR_INVALID_SECURITY_DESCR,
      "Joined collector refuses substitution of the retained security callback");
    Check(!CellCapacityLayoutTestPeer::VerifyLayout(layout, user, {&owner, SecurityOwner::Verify}, {}),
      "Joined collector accepts the retained explicit root policy");
    Check(!layout.Scan(record, {}, {Allow}, &result) && result == original && owner.calls > kCellCapacityAreaCount,
      "Policy descriptor is snapshotted and checked throughout complete collection");
    owner.deny = true; result = original;
    Check(CellCapacityLayoutTestPeer::VerifyLayout(layout, user, {&owner, SecurityOwner::Verify}, {}) == ERROR_ACCESS_DENIED,
      "Joined collector rechecks current root policy revocation");
    Check(layout.Scan(record, {}, {Allow}, &result) == ERROR_ACCESS_DENIED && result == CellCapacityAreaInventories{},
      "A revoked root policy clears all collected observations");
    owner.deny = false; owner.close = true;
    Check(layout.OpenRecordedWithSecurity(record, roots, {&owner, SecurityOwner::Verify}) != ERROR_SUCCESS,
      "Closing during security inspection invalidates admission without closing the borrowed callback handle early");
    owner.close = false;
    auto alternate = descriptor;
    PACL alternate_dacl = nullptr; PSID fixture_owner = nullptr; BOOL present = FALSE, ignored = FALSE;
    Check(GetSecurityDescriptorDacl(alternate.data(), &present, &alternate_dacl, &ignored) && present &&
      GetSecurityDescriptorOwner(alternate.data(), &fixture_owner, &ignored), "Read a distinct fixture policy");
    bool narrowed = false;
    for (DWORD index = 0; index < alternate_dacl->AceCount; ++index) {
      void* raw = nullptr; Check(GetAce(alternate_dacl, index, &raw) != FALSE, "Read fixture permission");
      auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Mask == FILE_ALL_ACCESS && EqualSid(&ace->SidStart, fixture_owner)) {
        ace->Mask &= ~WRITE_OWNER; narrowed = true;
      }
    }
    Check(narrowed, "Narrow fixture owner permissions without granting another principal access");
    const auto set_acl = [&](const std::vector<std::uint8_t>& expected) {
      PACL dacl = nullptr; BOOL present = FALSE, ignored = FALSE;
      Check(GetSecurityDescriptorDacl(const_cast<std::uint8_t*>(expected.data()), &present, &dacl, &ignored) && present,
        "Read the exact fixture policy ACL");
      Handle writable{CreateFileW(paths[1].c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
      const auto error = writable.value == INVALID_HANDLE_VALUE ? GetLastError() : SetSecurityInfo(writable.value, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr);
      if (error) std::fprintf(stderr, "Owned fixture ACL change error: %lu\n", error);
      Check(!error, "Change only the owned ordinary fixture directory ACL");
    };
    set_acl(alternate);
    Check(layout.OpenRecorded(record, roots, user, user) != ERROR_SUCCESS,
      "Legacy controller-only admission refuses the different root policy");
    owner.alternate = &alternate;
    Check(!layout.OpenRecordedWithSecurity(record, roots, {&owner, SecurityOwner::Verify}) &&
      !layout.Scan(record, {}, {Allow}, &result) && result == original,
      "Explicit per-area verification admits mixed exact ACLs without changing inventory");
    Check(!CellCapacityLayoutTestPeer::VerifyLayout(layout, user, {&owner, SecurityOwner::Verify}, {}),
      "Joined collector admits real mixed ACL roots through their retained exact policy");
    layout.Close(); set_acl(descriptor); owner.alternate = nullptr;
    Check(!layout.OpenRecorded(record, roots, user, user), "Legacy controller security remains independently usable");
  }
  std::vector<std::uint8_t> borrowed_frame;
  {
    Handle writer{CreateFileW(Child(paths[0], L"data").c_str(), GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    Check(writer.value != INVALID_HANDLE_VALUE, "Keep an owned writer handle open to model journal/backing custody");
    const auto file = std::find_if(original[0].entries.begin(), original[0].entries.end(), [](const auto& entry) { return !entry.directory; });
    Check(file != original[0].entries.end(), "Locate independent ordinary-file counts before borrowing");
    CellCapacityBorrowedFile held{writer.value, record.roots[0], file->identity, file->logical_file_bytes, file->allocated_bytes};
    CellCapacityBorrowedFiles borrowed{{&held, 1}, {Allow}};
    result = original;
    Check(layout.Scan(record, {}, {Allow}, &result) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
      "Ordinary scans still refuse an open writer rather than broadening file sharing");
    Check(!layout.Scan(record, {}, {Allow}, &result, &borrowed) && result == original,
      "Exact retained writer handle is counted once in its independently recorded parent");
    CellFileSha256 capture_nonce; capture_nonce.fill(0x33);
    Check(!layout.Capture(record, capture_nonce, {}, {Allow}, &borrowed_frame, &borrowed),
      "Borrowed-file capture reaches the same bounded wire encoder under retained layout custody");
    {
      struct RevokePrimary final {
        bool revoked = false;
        static DWORD Borrow(void* raw) noexcept { static_cast<RevokePrimary*>(raw)->revoked = true; return ERROR_SUCCESS; }
        static DWORD Primary(void* raw) noexcept { return static_cast<RevokePrimary*>(raw)->revoked ? ERROR_ACCESS_DENIED : ERROR_SUCCESS; }
      } revocation;
      auto selected = borrowed; selected.guard = {RevokePrimary::Borrow, &revocation};
      Check(layout.Scan(record, {}, {RevokePrimary::Primary, &revocation}, &result, &selected) == ERROR_ACCESS_DENIED &&
        result == CellCapacityAreaInventories{}, "Canonical authority is checked after the borrowed-file owner callback");
      Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
      Check(cancelled.value != nullptr, "Create a task-owned borrowed-owner cancellation event");
      selected = borrowed; selected.guard.cancellation = cancelled.value;
      std::vector<std::uint8_t> rejected{1, 2, 3};
      Check(layout.Capture(record, capture_nonce, {}, {Allow}, &rejected, &selected) == ERROR_CANCELLED && rejected.empty(),
        "Borrowed-owner cancellation clears encoded capture evidence");
    }
    {
      Handle other_writer{CreateFileW(Child(paths[1], L"data").c_str(), GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
      Check(other_writer.value != INVALID_HANDLE_VALUE, "Hold a second ordinary fixture writer outside the borrowed set");
      Check(layout.Scan(record, {}, {Allow}, &result, &borrowed) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
        "Borrowing one exact file does not permit other open writers");
    }
    {
      Fixture outside(L"layout-borrowed-outside"); const auto path = Child(outside.path, L"data"); File(path, 9);
      const auto allocation = Allocated(path);
      Handle file_handle{CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
      Check(file_handle.value != INVALID_HANDLE_VALUE, "Retain an independently owned file outside all admitted areas");
      std::array<CellCapacityBorrowedFile, 2> files{held, {file_handle.value, outside.identity, Identity(file_handle.value), 9, allocation}};
      const CellCapacityBorrowedFiles missing{files, {Allow}};
      Check(layout.Scan(record, {}, {Allow}, &result, &missing) == ERROR_FILE_NOT_FOUND && result == CellCapacityAreaInventories{},
        "A borrowed file missing from complete area enumeration cannot be silently omitted");
    }
    for (unsigned mode = 0; mode < 7; ++mode) {
      auto changed = held; auto selected = borrowed;
      selected.files = {&changed, 1};
      if (mode == 0) changed.parent = record.roots[1];
      if (mode == 1) changed.identity.file_id[0] ^= 1;
      if (mode == 2) changed.logical_bytes++;
      if (mode == 3) changed.allocated_bytes++;
      if (mode == 4) changed.handle = handles[0].value;
      if (mode == 5) selected.guard.authorize = nullptr;
      if (mode == 6) selected.guard.cancellation = INVALID_HANDLE_VALUE;
      result = original;
      Check(layout.Scan(record, {}, {Allow}, &result, &selected) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
        "Borrowing refuses substituted parent/identity/handle/counts and absent or invalid custody guard");
    }
    std::array<CellCapacityBorrowedFile, 2> repeated{held, held}; auto duplicates = borrowed; duplicates.files = repeated;
    Check(layout.Scan(record, {}, {Allow}, &result, &duplicates) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
      "Duplicate borrowed physical identities are rejected before collection");
    struct HeldMutation final {
      HANDLE file; unsigned calls = 0, at = 0; bool deny = false;
      static DWORD Current(void* raw) noexcept {
        auto& self = *static_cast<HeldMutation*>(raw);
        if (++self.calls != self.at) return ERROR_SUCCESS;
        if (self.deny) return ERROR_ACCESS_DENIED;
        LARGE_INTEGER zero{}; DWORD written = 0; const std::array<std::uint8_t, 2> bytes{1, 2};
        if (!SetFilePointerEx(self.file, zero, nullptr, FILE_BEGIN) || !WriteFile(self.file, bytes.data(), 2, &written, nullptr) ||
            written != 2 || !SetEndOfFile(self.file) || !FlushFileBuffers(self.file)) return GetLastError();
        return ERROR_SUCCESS;
      }
    } count{writer.value};
    borrowed.guard = {HeldMutation::Current, &count};
    Check(!layout.Scan(record, {}, {Allow}, &result, &borrowed) && count.calls > 13, "Measure borrowed-owner custody checks across all areas");
    for (const auto at : {1U, count.calls / 2, count.calls}) {
      HeldMutation mutation{writer.value, 0, at}; borrowed.guard = {HeldMutation::Current, &mutation};
      result = original;
      Check(layout.Scan(record, {}, {Allow}, &result, &borrowed) != ERROR_SUCCESS && result == CellCapacityAreaInventories{} && mutation.calls >= at,
        "Early, middle and final-owner writes invalidate the entire borrowed inventory");
      LARGE_INTEGER end{}; end.QuadPart = 1;
      Check(SetFilePointerEx(writer.value, end, nullptr, FILE_BEGIN) && SetEndOfFile(writer.value) && FlushFileBuffers(writer.value),
        "Restore only the owned one-byte mutation fixture");
      HeldMutation denied{writer.value, 0, at, true}; borrowed.guard = {HeldMutation::Current, &denied};
      result = original;
      Check(layout.Scan(record, {}, {Allow}, &result, &borrowed) == ERROR_ACCESS_DENIED && result == CellCapacityAreaInventories{},
        "Revoked borrowed-file custody cannot leave partial area evidence");
    }
  }
  const auto save = [&](const std::wstring& name, const std::uint8_t* bytes, DWORD count) {
    const auto path = Child(fixture_root, name);
    Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
    DWORD written = 0;
    Check(file.value != INVALID_HANDLE_VALUE && WriteFile(file.value, bytes, count, &written, nullptr) && written == count && FlushFileBuffers(file.value),
      "Retain exact task-owned native capture evidence");
  };
  save(L"borrowed-capture.bin", borrowed_frame.data(), static_cast<DWORD>(borrowed_frame.size()));
  CellCapacityLayoutBytes retained_layout{};
  Check(!EncodeCellCapacityLayout(record, &retained_layout), "Encode independently retained layout before starting capture");
  save(L"expected-layout.bin", retained_layout.data(), static_cast<DWORD>(retained_layout.size()));
  CellCapacityLayoutRecord decoded{};
  Check(!DecodeCellCapacityLayout(retained_layout, &decoded) && decoded == record,
    "Retained binary layout restores exact assignment, profile and raw root identities");
  for (unsigned mode = 0; mode < 6; ++mode) {
    auto changed = retained_layout;
    if (mode == 0) changed[0] ^= 1;
    if (mode == 1) std::fill_n(changed.begin() + 8, 32, std::uint8_t{0});
    if (mode == 2) std::fill_n(changed.begin() + 40, 32, std::uint8_t{0});
    if (mode == 3) std::fill_n(changed.begin() + 80, 16, std::uint8_t{0});
    if (mode == 4) std::copy_n(changed.begin() + 72, 24, changed.begin() + 96);
    decoded = record;
    const auto input = std::span<const std::uint8_t>(changed.data(), changed.size() - (mode == 5 ? 1 : 0));
    Check(DecodeCellCapacityLayout(input, &decoded) != ERROR_SUCCESS && decoded == CellCapacityLayoutRecord{},
      "Malformed retained layout clears stale decoded authority");
  }
  std::vector<std::uint8_t> extended(retained_layout.begin(), retained_layout.end()); extended.push_back(0);
  decoded = record;
  Check(DecodeCellCapacityLayout(extended, &decoded) != ERROR_SUCCESS && decoded == CellCapacityLayoutRecord{},
    "Retained layout refuses trailing bytes");
  CellCapacityLayoutBytes recovered_bytes{};
  {
    Handle saved{CreateFileW(Child(fixture_root, L"expected-layout.bin").c_str(), GENERIC_READ, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    LARGE_INTEGER size{}; DWORD read = 0;
    Check(saved.value != INVALID_HANDLE_VALUE && GetFileSizeEx(saved.value, &size) && size.QuadPart == static_cast<LONGLONG>(recovered_bytes.size()) &&
      ReadFile(saved.value, recovered_bytes.data(), static_cast<DWORD>(recovered_bytes.size()), &read, nullptr) && read == recovered_bytes.size() &&
      recovered_bytes == retained_layout, "Read back exact saved layout bytes from the owned fixture file");
  }
  layout.Close();
  Check(!layout.OpenRecordedBytes(recovered_bytes, record.assignment_binding, record.profile_sha256, roots, user, user),
    "Recover protected host roots from independently retained binary layout without creating or repairing them");
  for (unsigned mode = 0; mode < 3; ++mode) {
    auto binding = record.assignment_binding; auto profile = record.profile_sha256; auto changed = retained_layout;
    if (mode == 0) binding[0] ^= 1;
    if (mode == 1) profile[0] ^= 1;
    if (mode == 2) changed[80] ^= 1;
    Check(layout.OpenRecordedBytes(changed, binding, profile, roots, user, user) != ERROR_SUCCESS,
      "Recovered layout cannot substitute current assignment, profile or original host root");
    result = original;
    Check(layout.Scan(record, {}, {Allow}, &result) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
      "Failed recovery invalidates prior open layout rather than retaining stale capture authority");
    Check(!layout.OpenRecordedBytes(retained_layout, record.assignment_binding, record.profile_sha256, roots, user, user),
      "Exact retained layout can be reopened after failed recovery");
  }
  CellFileSha256 nonce; nonce.fill(0x33); std::vector<std::uint8_t> captured;
  Check(!layout.Capture(record, nonce, {}, {Allow}, &captured) && captured.size() == 840 + 48 * 26,
    "Real protected layout capture produces one complete bounded native frame");
  save(L"layout-capture.bin", captured.data(), static_cast<DWORD>(captured.size()));
  std::vector<std::uint8_t> encoded;
  Check(!EncodeCellCapacityCapture(record, nonce, original, &encoded) && encoded == captured,
    "Native frame preserves exact independent scan counts and category order");
  for (unsigned mode = 0; mode < 5; ++mode) {
    auto changed = original; auto changed_nonce = nonce; auto changed_record = record;
    if (mode == 0) changed[0].footprint.logical_file_bytes++;
    if (mode == 1) std::reverse(changed[0].entries.begin(), changed[0].entries.end());
    if (mode == 2) changed[12].entries.clear();
    if (mode == 3) changed_nonce.fill(0);
    if (mode == 4) changed_record.roots[12] = changed_record.roots[0];
    encoded = captured;
    Check(EncodeCellCapacityCapture(changed_record, changed_nonce, changed, &encoded) != ERROR_SUCCESS && encoded.empty(),
      "Malformed, unbound or partial native capture cannot leave encoded evidence");
  }
  for (unsigned mode = 0; mode < 2; ++mode) {
    CapacityObserver observer; if (mode) observer.failure = ERROR_ACCESS_DENIED;
    auto observation_descriptor = observer.Descriptor(); encoded = captured;
    const auto error = layout.Capture(record, nonce, {}, {Allow}, &encoded, nullptr, &observation_descriptor);
    Check(mode ? error == ERROR_ACCESS_DENIED && encoded.empty() : !error && encoded == captured,
      "Layout capture carries provisional observation through scan and wire publication");
    Check(observer.calls == 1 && observer.checked && observer.discards == mode,
      "Nested capture and layout wrappers discard the original observer exactly once");
  }
  Handle layout_stop{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Check(layout_stop.value != nullptr && layout_stop.value != INVALID_HANDLE_VALUE, "Create owned pre-cancelled layout event");
  Check(layout.Scan(record, {}, {Allow, nullptr, layout_stop.value}, &result) == ERROR_CANCELLED && result == CellCapacityAreaInventories{},
    "Pre-cancelled layout collection refuses before inspecting or authorizing a new capture");
  for (unsigned mode = 0; mode < 3; ++mode) {
    auto changed = record;
    if (mode == 0) changed.assignment_binding[0] ^= 1;
    if (mode == 1) changed.profile_sha256[0] ^= 1;
    if (mode == 2) std::swap(changed.roots[0], changed.roots[1]);
    result = original;
    Check(layout.Scan(changed, {}, {Allow}, &result) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
      "Assignment, profile and area relabeling cannot reuse the held layout");
  }
  auto changed_roots = roots; std::swap(changed_roots[0], changed_roots[1]);
  Check(layout.OpenRecorded(record, changed_roots, user, user) != ERROR_SUCCESS,
    "Swapped caller roots cannot replace the independently retained layout");
  Check(!layout.OpenRecorded(record, roots, user, user), "Reopen unchanged protected roots without adopting replacements");
  struct Reenter final {
    CellCapacityLayout* layout; const CellCapacityLayoutRecord* record; bool close; DWORD inner = 0;
    static DWORD Current(void* raw) noexcept {
      auto& self = *static_cast<Reenter*>(raw);
      if (self.close) self.layout->Close();
      else { CellCapacityAreaInventories ignored; self.inner = self.layout->Scan(*self.record, {}, {Allow}, &ignored); }
      return ERROR_SUCCESS;
    }
  } reenter{&layout, &record, false};
  result = original;
  Check(layout.Scan(record, {}, {Reenter::Current, &reenter}, &result) != ERROR_SUCCESS && reenter.inner == ERROR_BUSY && result == CellCapacityAreaInventories{},
    "Ignored reentrant capture failure also withholds the outer layout result");
  Check(!layout.OpenRecorded(record, roots, user, user), "Restore a separate valid layout lifetime after reentrancy refusal");
  reenter.close = true; result = original;
  Check(layout.Scan(record, {}, {Reenter::Current, &reenter}, &result) != ERROR_SUCCESS && result == CellCapacityAreaInventories{},
    "Closing the layout during authorization cannot preserve its earlier capture authority");
  Check(!layout.OpenRecorded(record, roots, user, user), "Open protected roots for last-boundary ACL drift proof");
  SecurityDrift drift; drift.at = counter.calls; drift.path = paths[0]; drift.user = user; result = original;
  Check(layout.Scan(record, {}, {SecurityDrift::Current, &drift}, &result) != ERROR_SUCCESS && drift.calls == drift.at && result == CellCapacityAreaInventories{},
    "Final authority callback weakening an early root ACL invalidates all area observations");
  Check(layout.OpenRecorded(record, roots, user, user) != ERROR_SUCCESS,
    "An insecure root cannot be reopened or repaired by the read-only layout owner");
}

void WorkspaceTests() {
  const auto user = CurrentUser(), parent_path = Child(fixture_root, L"protected-parent");
  std::vector<std::uint8_t> descriptor;
  Check(BuildCellParentSecurity(user, user, &descriptor) == ERROR_SUCCESS, "Build ordinary protected-parent fixture descriptor.");
  SECURITY_ATTRIBUTES security{sizeof(security), descriptor.data(), FALSE};
  Check(CreateDirectoryW(parent_path.c_str(), &security) != FALSE, "Create protected fixture directory; no drive root is changed.");
  Handle parent{CreateFileW(parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
  Check(parent.value != INVALID_HANDLE_VALUE, "Open protected fixture parent.");
  const std::wstring cell_name = L"gc-cell-0123456789abcdef0123456789abcdef";
  CellWorkspaceDirectories owner;
  Check(owner.Create(parent.value, Identity(parent.value), cell_name, user, user) == ERROR_SUCCESS,
    "Create the real workspace owner with its four protected roots.");
  CellWorkspaceIdentities recorded;
  Check(owner.RecordIdentities(&recorded) == ERROR_SUCCESS, "Retain complete independent workspace identity record.");
  const auto cell = Child(parent_path, cell_name);
  File(Child(cell + L"\\control", L"control.bin"), 5);
  File(Child(cell + L"\\runtime", L"runtime.bin"), 17);
  File(Child(cell + L"\\work", L"output.bin"), 27);
  CellDirectoryFootprint result;
  Check(ScanCellWorkspaceFootprint(owner, recorded, {}, {Allow}, &result) == ERROR_SUCCESS &&
    result.root == recorded.directories[0] && result.file_count == 3 && result.directory_count == 4 && result.logical_file_bytes == 49,
    "Existing protected-workspace owner supplies one complete, nonoverlapping inventory.");
  CellDirectoryInventory inventory;
  Check(ScanCellWorkspaceInventory(owner, recorded, {}, {Allow}, &inventory) == ERROR_SUCCESS &&
    inventory.footprint == result && inventory.entries.size() == 7,
    "Protected workspace inventory uses the same complete recorded roots and retains all seven identities.");
  CellDirectoryInventoryPins retained; const auto expected_inventory = inventory;
  Check(!CaptureCellWorkspaceInventory(owner, recorded, {}, {Allow}, retained, &inventory) &&
    inventory == expected_inventory && retained.Ready() && !retained.Check(),
    "Workspace capture retains all seven identities under the recorded native owner");
  {
    const auto work_file = Child(cell + L"\\work", L"output.bin");
    Handle writer{CreateFileW(work_file.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, 0, nullptr)};
    Check(writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION,
      "Workspace file handles remain held after the workspace capture returns");
  }
  retained.Close();
  auto changed = recorded; changed.directories[3].file_id[15] ^= 1;
  result = Poison();
  Check(ScanCellWorkspaceFootprint(owner, changed, {}, {Allow}, &result) == ERROR_FILE_INVALID && result == CellDirectoryFootprint{},
    "Every recorded workspace identity is required, including a changed work-directory identity.");
  inventory = PoisonInventory();
  Check(ScanCellWorkspaceInventory(owner, changed, {}, {Allow}, &inventory) == ERROR_FILE_INVALID && inventory == CellDirectoryInventory{},
    "Mismatched protected roots cannot publish per-object identity records.");
  Check(CaptureCellWorkspaceInventory(owner, changed, {}, {Allow}, retained, &inventory) == ERROR_FILE_INVALID &&
    inventory == CellDirectoryInventory{} && !retained.Ready(),
    "Retained workspace capture also refuses mismatched roots without leaving pins");
  result = Poison();
  Check(ScanCellWorkspaceFootprint(owner, recorded, {6, 64, 10000}, {Allow}, &result) != ERROR_SUCCESS &&
    result == CellDirectoryFootprint{} && owner.Ready(), "Incomplete inventory preserves the actual workspace owner and withholds totals.");
  Check(ScanCellWorkspaceFootprint(owner, recorded, {}, {Allow}, &result) == ERROR_SUCCESS,
    "The unchanged workspace can be scanned after an earlier bounded refusal.");
  CellFootprintScanLimits frozen{6, 64, 10000};
  const CellFootprintScanGuard widen{[](void* raw) noexcept -> DWORD {
    static_cast<CellFootprintScanLimits*>(raw)->max_entries = 65536; return ERROR_SUCCESS;
  }, &frozen};
  result = Poison();
  Check(ScanCellWorkspaceFootprint(owner, recorded, frozen, widen, &result) != ERROR_SUCCESS && result == CellDirectoryFootprint{},
    "Authority callbacks cannot widen scan limits already frozen by the workspace owner.");
  Mutation counter;
  Check(ScanCellWorkspaceFootprint(owner, recorded, {}, {Mutation::Current, &counter}, &result) == ERROR_SUCCESS,
    "Record the last authority boundary before workspace capacity readback.");
  SecurityDrift drift; drift.at = counter.calls; drift.path = Child(cell, L"work"); drift.user = user;
  result = Poison();
  Check(ScanCellWorkspaceFootprint(owner, recorded, {}, {SecurityDrift::Current, &drift}, &result) != ERROR_SUCCESS &&
    drift.calls == drift.at && result == CellDirectoryFootprint{} && !owner.Ready(),
    "Root security drift in the last authority callback invalidates the protected workspace observation.");
  inventory = PoisonInventory();
  Check(ScanCellWorkspaceInventory(owner, recorded, {}, {Allow}, &inventory) != ERROR_SUCCESS && inventory == CellDirectoryInventory{},
    "Security-invalidated workspace cannot publish identity inventory.");
  owner.Close(); result = Poison();
  Check(ScanCellWorkspaceFootprint(owner, recorded, {}, {Allow}, &result) != ERROR_SUCCESS && result == CellDirectoryFootprint{},
    "Closed workspace state cannot produce a new capacity observation.");
}
void Tests() {
  Fixture empty(L"empty");
  CellDirectoryFootprint result;
  const auto empty_error = empty.Scan(&result, {1, 0, 10000});
  if (empty_error) std::fprintf(stderr, "Empty-tree Win32 error: %lu\n", empty_error);
  Check(empty_error == ERROR_SUCCESS && result.root == empty.identity &&
    result.file_count == 0 && result.directory_count == 1 && result.logical_file_bytes == 0,
    "A complete empty-tree observation includes its independently admitted root.");
  const auto clean = result;
  auto wrong = empty.identity; wrong.file_id[15] ^= 1;
  result = Poison();
  Check(ScanCellDirectoryFootprint(empty.handle.value, wrong, {}, {Allow}, &result) == ERROR_FILE_INVALID &&
    result == CellDirectoryFootprint{}, "Full 128-bit root identity mismatch is refused.");
  wrong = empty.identity; wrong.volume_serial ^= (1ULL << 60);
  Check(ScanCellDirectoryFootprint(empty.handle.value, wrong, {}, {Allow}, &result) == ERROR_FILE_INVALID,
    "Full 64-bit volume mismatch is refused.");
  Refused(empty, {0, 64, 10000}); Refused(empty, {65537, 64, 10000});
  Refused(empty, {20, 65, 10000}); Refused(empty, {20, 64, 0}); Refused(empty, {20, 64, 60001});
  Refused(empty, {}, {});
  Refused(empty, {}, {Allow, nullptr, INVALID_HANDLE_VALUE});
  Refused(empty, {}, {Allow, nullptr, GetCurrentThread()});
  Refused(empty, {}, {[](void*) noexcept -> DWORD { return ERROR_ACCESS_DENIED; }});
  Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Check(cancelled.value != nullptr, "Create owned cancellation event.");
  Refused(empty, {}, {Allow, nullptr, cancelled.value});
  Check(empty.Scan(&result) == ERROR_SUCCESS && result == clean, "Failures do not poison the next independent observation.");

  Fixture tree(L"tree");
  const auto sub = Directory(tree.path, L"sub"), empty_sub = Directory(sub, L"empty");
  const auto normal = Child(tree.path, L"normal.txt"), tiny = Child(sub, L"\u03b4-\u732b.txt"), zero = Child(sub, L"zero");
  File(normal); File(tiny, 3); File(zero, 0);
  Check(tree.Scan(&result, {6, 2, 10000}) == ERROR_SUCCESS && result.file_count == 3 && result.directory_count == 3 &&
    result.logical_file_bytes == 8196 && result.allocated_bytes == Allocated(normal) + Allocated(tiny) + Allocated(zero) +
      DirectoryAllocated(tree.path) + DirectoryAllocated(sub) + DirectoryAllocated(empty_sub),
    "Nested and Unicode names are counted exactly; directories and zero-byte files remain visible.");
  Refused(tree, {5, 2, 10000}); Refused(tree, {6, 1, 10000});
  Fixture encodings(L"encodings");
  const auto sparse = Child(encodings.path, L"sparse"), compressed = Child(encodings.path, L"compressed");
  File(sparse, 0); Sparse(sparse); File(compressed, 131072); Compress(compressed);
  Check(encodings.Scan(&result) == ERROR_SUCCESS && result.file_count == 2 && result.logical_file_bytes == 1179648 &&
    result.allocated_bytes == Allocated(sparse) + Allocated(compressed) + DirectoryAllocated(encodings.path) &&
    result.allocated_bytes < result.logical_file_bytes,
    "Sparse/compressed storage never hides logical bytes or gets charged as full logical allocation.");

  Fixture linked(L"linked"); const auto original = Child(linked.path, L"original"); File(original);
  Check(CreateHardLinkW(Child(linked.path, L"alias").c_str(), original.c_str(), nullptr) != FALSE, "Create two owned hard-link names.");
  Refused(linked); InventoryRefused(linked);
  Fixture streams(L"streams"); const auto stream_file = Child(streams.path, L"file"); File(stream_file);
  ExtraStream(streams.path, stream_file); Refused(streams); InventoryRefused(streams);
  Fixture directory_stream(L"directory-stream"); const auto ads_dir = Directory(directory_stream.path, L"ads");
  ExtraStream(directory_stream.path, ads_dir); Refused(directory_stream); InventoryRefused(directory_stream);
  Fixture junction(L"junction"); const auto alias = Directory(junction.path, L"alias");
  Junction(alias, tree.path); Refused(junction); InventoryRefused(junction);
  Fixture writer(L"writer"); const auto writing = Child(writer.path, L"writing"); File(writing);
  {
    Handle writing_handle{CreateFileW(writing.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    Check(writing_handle.value != INVALID_HANDLE_VALUE, "Hold a live writer during observation.");
    Refused(writer); InventoryRefused(writer);
  }
  Check(writer.Scan(&result) == ERROR_SUCCESS && result.file_count == 1, "Scan succeeds after the competing writer closes.");
  Fixture many(L"multi-buffer");
  for (unsigned i = 0; i < 300; ++i) File(Child(many.path, std::to_wstring(i) + std::wstring(190, L'x')), i % 5);
  Check(many.Scan(&result, {301, 1, 10000}) == ERROR_SUCCESS && result.file_count == 300 && result.directory_count == 1 &&
    result.logical_file_bytes == 600, "Multiple directory enumeration buffers yield one complete inventory.");
  Refused(many, {300, 1, 10000});
}
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 2 || !IsLiteralCellPath(argv[1])) return 2;
    fixture_root = argv[1];
    Check(CreateDirectoryW(fixture_root.c_str(), nullptr) != FALSE, "Create exclusive top-level fixture root.");
    Tests();
    InventoryTests();
    RetainedInventoryTests();
    const auto before_file_selection = checks;
    PinnedFileSelectionTests();
    const auto file_selection_checks = checks - before_file_selection;
    const auto before_file_reads = checks;
    PinnedFileReadTests();
    const auto file_read_checks = checks - before_file_reads;
    RaceTests();
    WorkspaceTests();
    AreaTests();
    MountLeafAreaTests();
    LayoutTests();
    std::printf("{\"passed\":true,\"checks\":%u,\"pinnedFileReadChecks\":%u,\"pinnedFileSelectionChecks\":%u,\"volumeOperations\":false,\"quotaEnforced\":false}\n", checks, file_read_checks, file_selection_checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s (check %u)\n", error.what(), checks); return 1; }
}
