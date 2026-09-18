#include "cell_capacity.hpp"
#include "cell_workspace.hpp"
#include "cell_security.hpp"
#include "cell_volume_mount.hpp"
#include <winternl.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <memory>
#include <map>
#include <set>
#include <string_view>
#include <utility>

namespace goatcitadel::worker_cell {
namespace {
constexpr std::uint64_t kMaximumBytes = 9007199254740991ULL;
constexpr DWORD kUnsafeAttributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE |
  FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
DWORD Error() noexcept { const auto value = GetLastError(); return value ? value : ERROR_GEN_FAILURE; }
struct Guard final {
  CellFootprintScanGuard owner;
  ULONGLONG deadline;
  DWORD Check(bool authorize = true) const noexcept {
    const auto stopped = [&]() -> DWORD {
      if (owner.cancellation) {
        const auto status = WaitForSingleObject(owner.cancellation, 0);
        if (status != WAIT_TIMEOUT) return status == WAIT_FAILED ? Error() : ERROR_CANCELLED;
      }
      return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
    };
    DWORD error = stopped();
    if (!error && authorize) error = owner.authorize(owner.context);
    return error ? error : stopped();
  }
};
struct Metadata final {
  CellFileIdentity identity;
  std::uint64_t logical_bytes = 0, allocated_bytes = 0;
  LONGLONG change_time = 0, write_time = 0;
  DWORD attributes = 0;
  bool directory = false;
  bool operator==(const Metadata&) const = default;
};
struct Entry final {
  std::wstring name;
  std::array<std::uint8_t, 16> file_id{};
  bool directory = false;
  bool mount = false;
  bool operator==(const Entry&) const = default;
};
struct Node final {
  Handle handle;
  Metadata metadata;
  std::uint32_t depth = 0;
  std::vector<Entry> entries;
  const CellCapacityMountLeaf* mount = nullptr;
};
using FileKey = std::pair<std::uint64_t, std::array<std::uint8_t, 16>>;
bool FilePathParts(const std::wstring& path, std::vector<std::wstring_view>* parts) {
  if (path.empty() || path.size() > 512) return false;
  const auto bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path.data(), static_cast<int>(path.size()), nullptr, 0, nullptr, nullptr);
  if (!bytes || bytes > 512) return false;
  for (const auto value : path)
    if (value < L' ' || (value >= 0x7f && value <= 0x9f) || std::wstring_view(L"\\:*?\"<>|").find(value) != std::wstring_view::npos) return false;
  for (std::size_t begin = 0; begin < path.size();) {
    const auto slash = path.find(L'/', begin), end = slash == std::wstring::npos ? path.size() : slash;
    const auto part = std::wstring_view(path).substr(begin, end - begin);
    if (parts->size() == 32 || part.empty() || part == L"." || part == L".." || part.front() == L' ' || part.back() == L' ' || part.back() == L'.') return false;
    const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, part.data(), static_cast<int>(part.size()), nullptr, 0, nullptr, nullptr);
    if (!size || size > 128) return false;
    std::wstring base(part.substr(0, part.find(L'.')));
    for (auto& value : base) if (value >= L'A' && value <= L'Z') value = static_cast<wchar_t>(value + L'a' - L'A');
    if (base == L"con" || base == L"prn" || base == L"aux" || base == L"nul" || base == L"conin$" || base == L"conout$" ||
        (base.size() == 4 && (base.starts_with(L"com") || base.starts_with(L"lpt")) && base[3] >= L'1' && base[3] <= L'9')) return false;
    parts->push_back(part);
    if (end == path.size()) break;
    begin = end + 1; if (begin == path.size()) return false;
  }
  return !parts->empty();
}
struct Borrowed final {
  std::map<FileKey, CellCapacityBorrowedFile> files;
  std::set<FileKey> seen;
  Guard primary, retained;
  std::map<FileKey, const CellCapacityMountLeaf*> mounts;
  std::set<FileKey> mounts_seen;
  static DWORD Authorize(void* raw) noexcept {
    const auto& self = *static_cast<Borrowed*>(raw);
    const bool has_borrowed = !self.files.empty() || !self.mounts.empty();
    auto error = has_borrowed ? self.retained.Check() : ERROR_SUCCESS;
    // Recheck canonical/layout authority after the borrowed owner callback.
    if (!error) error = self.primary.Check();
    if (!error && has_borrowed) error = self.retained.Check(false);
    for (const auto& [identity, mount] : self.mounts) {
      if (!error) error = mount->Check();
    }
    return error;
  }
};
DWORD Inspect(HANDLE object, Metadata* output, const CellCapacityMountLeaf* mount = nullptr) noexcept {
  if (mount) { const auto error = mount->Check(); if (error) return error; }
  if (GetFileType(object) != FILE_TYPE_DISK) return ERROR_ACCESS_DENIED;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_BASIC_INFO basic{};
  FILE_ID_INFO identity{};
  if (!GetFileInformationByHandleEx(object, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(object, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(object, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(object, FileIdInfo, &identity, sizeof(identity))) return Error();
  const bool directory = standard.Directory != FALSE;
  const auto unsafe = mount ? kUnsafeAttributes & ~FILE_ATTRIBUTE_REPARSE_POINT : kUnsafeAttributes;
  if ((attributes.FileAttributes & unsafe) ||
      (mount ? (!directory || !(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || attributes.ReparseTag != IO_REPARSE_TAG_MOUNT_POINT)
             : attributes.ReparseTag != 0) || standard.DeletePending ||
      standard.NumberOfLinks != 1 || standard.EndOfFile.QuadPart < 0 || standard.AllocationSize.QuadPart < 0 ||
      ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
      basic.FileAttributes != attributes.FileAttributes) return ERROR_ACCESS_DENIED;
  Metadata result;
  result.identity.volume_serial = identity.VolumeSerialNumber;
  std::copy(std::begin(identity.FileId.Identifier), std::end(identity.FileId.Identifier), result.identity.file_id.begin());
  if (mount && result.identity != mount->Target().directory) return ERROR_FILE_INVALID;
  if (result.identity.file_id == std::array<std::uint8_t, 16>{}) return ERROR_INVALID_DATA;
  result.directory = directory;
  result.attributes = attributes.FileAttributes;
  result.logical_bytes = directory ? 0 : static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  result.allocated_bytes = static_cast<std::uint64_t>(standard.AllocationSize.QuadPart);
  result.change_time = basic.ChangeTime.QuadPart;
  result.write_time = basic.LastWriteTime.QuadPart;
  // Stream enumeration comes from the same handle. A named stream, including an
  // empty stream or a directory ADS, invalidates the entire observation.
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> buffer{};
  if (!GetFileInformationByHandleEx(object, FileStreamInfo, buffer.data(), static_cast<DWORD>(buffer.size()))) {
    const auto error = Error();
    if (!directory || error != ERROR_HANDLE_EOF) return error;
  } else {
    const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(buffer.data());
    constexpr std::wstring_view unnamed = L"::$DATA";
    if (!(directory && !stream->NextEntryOffset && !stream->StreamNameLength)) {
      if (stream->NextEntryOffset || stream->StreamNameLength != unnamed.size() * sizeof(wchar_t) ||
          std::wstring_view(stream->StreamName, unnamed.size()) != unnamed || stream->StreamSize.QuadPart != standard.EndOfFile.QuadPart ||
          stream->StreamAllocationSize.QuadPart < 0 || (directory && stream->StreamSize.QuadPart != 0)) return ERROR_ACCESS_DENIED;
    }
  }
  if (!directory && (attributes.FileAttributes & (FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED))) {
    // Compression info reports actual storage for sparse/compressed data. EOF
    // remains the independent logical charge; neither is inferred from the other.
    FILE_COMPRESSION_INFO compression{};
    if (!GetFileInformationByHandleEx(object, FileCompressionInfo, &compression, sizeof(compression))) return Error();
    if (compression.CompressedFileSize.QuadPart < 0) return ERROR_INVALID_DATA;
    result.allocated_bytes = static_cast<std::uint64_t>(compression.CompressedFileSize.QuadPart);
  }
  if (result.logical_bytes > kMaximumBytes || result.allocated_bytes > kMaximumBytes) return ERROR_ARITHMETIC_OVERFLOW;
  *output = result;
  return ERROR_SUCCESS;
}
DWORD OpenChild(HANDLE parent, const Entry& entry, HANDLE* output) noexcept {
  const HMODULE module = GetModuleHandleW(L"ntdll.dll");
  const FARPROC create_address = module ? GetProcAddress(module, "NtCreateFile") : nullptr;
  const FARPROC convert_address = module ? GetProcAddress(module, "RtlNtStatusToDosError") : nullptr;
  if (!create_address || !convert_address) return ERROR_PROC_NOT_FOUND;
  decltype(&NtCreateFile) create = nullptr;
  decltype(&RtlNtStatusToDosError) convert = nullptr;
  static_assert(sizeof(create) == sizeof(create_address) && sizeof(convert) == sizeof(convert_address));
  std::memcpy(&create, &create_address, sizeof(create));
  std::memcpy(&convert, &convert_address, sizeof(convert));
  UNICODE_STRING name{};
  name.Buffer = const_cast<wchar_t*>(entry.name.data());
  name.Length = static_cast<USHORT>(entry.name.size() * sizeof(wchar_t)); name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent; attributes.ObjectName = &name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE | 0x00001000UL;  // OBJ_DONT_REPARSE
  IO_STATUS_BLOCK io{};
  HANDLE opened = nullptr;
  const auto status = create(&opened, FILE_GENERIC_READ, &attributes, &io, nullptr, 0, FILE_SHARE_READ, FILE_OPEN,
    (entry.directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE) | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    nullptr, 0);
  if (status < 0) return convert(status);
  *output = opened;
  return io.Information == 1 ? ERROR_SUCCESS : ERROR_INVALID_STATE;  // FILE_OPENED
}
DWORD Enumerate(HANDLE directory, std::uint32_t max_entries, const Guard& guard, bool authorize,
                std::vector<Entry>* output, const Borrowed* borrowed = nullptr, const CellFileIdentity* parent = nullptr) {
  alignas(FILE_ID_EXTD_DIR_INFO) std::array<std::uint8_t, 65536> buffer{};
  bool restart = true;
  for (;;) {
    auto error = guard.Check(authorize);
    if (error) return error;
    buffer.fill(0);
    if (!GetFileInformationByHandleEx(directory, restart ? FileIdExtdDirectoryRestartInfo : FileIdExtdDirectoryInfo,
        buffer.data(), static_cast<DWORD>(buffer.size()))) {
      error = Error();
      if (error != ERROR_NO_MORE_FILES) return error;
      break;
    }
    restart = false;
    std::size_t offset = 0;
    for (;;) {
      constexpr auto header = offsetof(FILE_ID_EXTD_DIR_INFO, FileName);
      if (offset > buffer.size() - header) return ERROR_INVALID_DATA;
      const auto* found = reinterpret_cast<const FILE_ID_EXTD_DIR_INFO*>(buffer.data() + offset);
      const auto bytes = found->FileNameLength;
      if (!bytes || bytes % sizeof(wchar_t) || bytes > 510 || bytes > buffer.size() - offset - header ||
          (found->NextEntryOffset && (found->NextEntryOffset % 8 || found->NextEntryOffset < header + bytes ||
            found->NextEntryOffset > buffer.size() - offset - header))) return ERROR_INVALID_DATA;
      Entry entry;
      entry.name.assign(found->FileName, bytes / sizeof(wchar_t));
      if (entry.name != L"." && entry.name != L"..") {
        if (!IsLiteralCellPath(L"C:\\" + entry.name)) return ERROR_BAD_PATHNAME;
        if (output->size() >= max_entries) return ERROR_BUFFER_OVERFLOW;
        entry.directory = (found->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        std::copy(std::begin(found->FileId.Identifier), std::end(found->FileId.Identifier), entry.file_id.begin());
        if (found->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
          if (!borrowed || !parent || entry.name != L"volume" || !entry.directory ||
              found->ReparsePointTag != IO_REPARSE_TAG_MOUNT_POINT) return ERROR_ACCESS_DENIED;
          const auto held = borrowed->mounts.find({parent->volume_serial, entry.file_id});
          if (held == borrowed->mounts.end() || held->second->Target().parent != *parent) return ERROR_ACCESS_DENIED;
          error = held->second->Check(); if (error) return error;
          entry.mount = true;
        }
        if (found->FileAttributes & (entry.mount ? kUnsafeAttributes & ~FILE_ATTRIBUTE_REPARSE_POINT : kUnsafeAttributes))
          return ERROR_ACCESS_DENIED;
        output->push_back(std::move(entry));
      }
      if (!found->NextEntryOffset) break;
      offset += found->NextEntryOffset;
    }
  }
  std::sort(output->begin(), output->end(), [](const Entry& a, const Entry& b) { return a.name < b.name; });
  for (std::size_t i = 1; i < output->size(); ++i)
    if ((*output)[i - 1].name == (*output)[i].name) return ERROR_INVALID_DATA;
  return guard.Check(false);
}
DWORD Add(std::uint64_t bytes, std::uint64_t* total) noexcept {
  if (bytes > kMaximumBytes - *total) return ERROR_ARITHMETIC_OVERFLOW;
  *total += bytes;
  return ERROR_SUCCESS;
}
DWORD CheckPinnedNodes(const std::vector<std::unique_ptr<Node>>& nodes, const Guard& guard,
  std::uint32_t maximum_entries, const Borrowed* borrowed = nullptr) noexcept {
  try {
    std::set<FileKey> identities;
    for (const auto& node : nodes) {
      auto error = guard.Check(false); if (error) return error;
      Metadata current; error = Inspect(node->handle.value, &current, node->mount); if (error) return error;
      if (current != node->metadata) return ERROR_FILE_INVALID;
      if (!identities.emplace(current.identity.volume_serial, current.identity.file_id).second) return ERROR_ACCESS_DENIED;
      if (current.directory && !node->mount) {
        std::vector<Entry> entries;
        error = Enumerate(node->handle.value, maximum_entries, guard, false, &entries, borrowed, &current.identity); if (error) return error;
        if (entries != node->entries) return ERROR_FILE_INVALID;
      }
    }
    return guard.Check(false);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ScanDirectory(HANDLE admitted_root, const CellFileIdentity& expected_root,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard,
  CellDirectoryFootprint* output, std::vector<CellDirectoryInventoryEntry>* output_entries,
  std::vector<std::unique_ptr<Node>>* retained_nodes = nullptr, Borrowed* borrowed = nullptr) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto expected = expected_root;
  const auto limits = supplied_limits;
  const auto owner_guard = supplied_guard;
  *output = {};
  if (output_entries) output_entries->clear();
  try {
    if (owner_guard.cancellation == INVALID_HANDLE_VALUE || owner_guard.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    if (!admitted_root || admitted_root == INVALID_HANDLE_VALUE || expected == CellFileIdentity{} ||
        !owner_guard.authorize || !limits.max_entries || limits.max_entries > (output_entries ? 20000U : 65536U) || limits.max_depth > 64 ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
    const Guard guard{owner_guard, GetTickCount64() + limits.wall_limit_ms};
    auto error = guard.Check();
    if (error) return error;
    auto root = std::make_unique<Node>();
    Metadata admitted;
    error = Inspect(admitted_root, &admitted);
    if (error) return error;
    if (!admitted.directory || admitted.identity != expected) return ERROR_FILE_INVALID;
    FILE_ID_DESCRIPTOR descriptor{};
    descriptor.dwSize = sizeof(descriptor); descriptor.Type = ExtendedFileIdType;
    std::copy(expected.file_id.begin(), expected.file_id.end(), std::begin(descriptor.ExtendedFileId.Identifier));
    root->handle.value = OpenFileById(admitted_root, &descriptor, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ, nullptr, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    if (root->handle.value == INVALID_HANDLE_VALUE) return Error();
    error = Inspect(root->handle.value, &root->metadata);
    if (error) return error;
    if (!root->metadata.directory || root->metadata.identity != expected) return ERROR_FILE_INVALID;
    std::array<wchar_t, 16> filesystem{};
    if (!GetVolumeInformationByHandleW(root->handle.value, nullptr, 0, nullptr, nullptr, nullptr,
        filesystem.data(), static_cast<DWORD>(filesystem.size()))) return Error();
    if (std::wstring_view(filesystem.data()) != L"NTFS") return ERROR_NOT_SUPPORTED;
    std::vector<std::unique_ptr<Node>> nodes;
    nodes.push_back(std::move(root));
    std::set<std::pair<std::uint64_t, std::array<std::uint8_t, 16>>> identities;
    identities.emplace(expected.volume_serial, expected.file_id);
    for (std::size_t index = 0; index < nodes.size(); ++index) {
      auto& node = *nodes[index];
      if (!node.metadata.directory || node.mount) continue;
      error = Enumerate(node.handle.value, limits.max_entries - static_cast<std::uint32_t>(nodes.size()), guard, true, &node.entries,
        borrowed, &node.metadata.identity);
      if (error) return error;
      if (!node.entries.empty() && node.depth == limits.max_depth) return ERROR_BUFFER_OVERFLOW;
      for (const auto& entry : node.entries) {
        error = guard.Check();
        if (error) return error;
        auto child = std::make_unique<Node>();
        const FileKey enumerated{expected.volume_serial, entry.file_id};
        const CellCapacityBorrowedFile* held = nullptr;
        if (borrowed) {
          const auto found = borrowed->files.find(enumerated);
          if (found != borrowed->files.end()) held = &found->second;
        }
        if (entry.mount) {
          if (!borrowed || held) return ERROR_FILE_INVALID;
          const auto found = borrowed->mounts.find(enumerated);
          if (found == borrowed->mounts.end() || found->second->Target().parent != node.metadata.identity ||
              !borrowed->mounts_seen.insert(enumerated).second) return ERROR_FILE_INVALID;
          child->mount = found->second;
          error = child->mount->Check(); if (error) return error;
          if (!DuplicateHandle(GetCurrentProcess(), child->mount->DirectoryHandle(), GetCurrentProcess(), &child->handle.value,
              0, FALSE, DUPLICATE_SAME_ACCESS)) return Error();
        } else if (held) {
          if (entry.directory || held->parent != node.metadata.identity || !borrowed->seen.insert(enumerated).second)
            return ERROR_FILE_INVALID;
          if (!DuplicateHandle(GetCurrentProcess(), held->handle, GetCurrentProcess(), &child->handle.value, 0, FALSE, DUPLICATE_SAME_ACCESS))
            return Error();
        } else error = OpenChild(node.handle.value, entry, &child->handle.value);
        if (!error) error = Inspect(child->handle.value, &child->metadata, child->mount);
        if (error) return error;
        if (held && (child->metadata.identity != held->identity || child->metadata.logical_bytes != held->logical_bytes ||
            child->metadata.allocated_bytes != held->allocated_bytes)) return ERROR_FILE_INVALID;
        const auto& identity = child->metadata.identity;
        if (identity.volume_serial != expected.volume_serial || identity.file_id != entry.file_id ||
            child->metadata.directory != entry.directory) return ERROR_FILE_INVALID;
        if (!identities.emplace(identity.volume_serial, identity.file_id).second) return ERROR_ACCESS_DENIED;
        child->depth = node.depth + 1;
        nodes.push_back(std::move(child));
      }
    }
    // No owner callback runs after this point: final readback must observe any
    // changes made while authority was being checked. Time/cancellation checks
    // continue, and every original handle remains held through all readbacks.
    error = guard.Check();
    if (error) return error;
    CellDirectoryFootprint result; result.root = expected;
    std::vector<CellDirectoryInventoryEntry> inventory;
    if (output_entries) inventory.reserve(nodes.size());
    for (const auto& node : nodes) {
      error = guard.Check(false);
      if (error) return error;
      Metadata current;
      error = Inspect(node->handle.value, &current, node->mount);
      if (error) return error;
      if (current != node->metadata) return ERROR_FILE_INVALID;
      if (current.directory) {
        if (!node->mount) {
          std::vector<Entry> current_entries;
          error = Enumerate(node->handle.value, limits.max_entries, guard, false, &current_entries, borrowed, &current.identity);
          if (error) return error;
          if (current_entries != node->entries) return ERROR_FILE_INVALID;
        }
        ++result.directory_count;
      } else ++result.file_count;
      error = Add(current.logical_bytes, &result.logical_file_bytes);
      if (!error) error = Add(current.allocated_bytes, &result.allocated_bytes);
      if (error) return error;
      if (output_entries) inventory.push_back({current.identity, current.directory, current.logical_bytes, current.allocated_bytes});
    }
    if (output_entries) std::sort(inventory.begin(), inventory.end(), [](const auto& a, const auto& b) {
      return a.identity.volume_serial != b.identity.volume_serial ? a.identity.volume_serial < b.identity.volume_serial :
        a.identity.file_id < b.identity.file_id;
    });
    error = guard.Check(false);
    if (error) return error;
    if (retained_nodes) {
      retained_nodes->reserve(retained_nodes->size() + nodes.size());
      for (auto& node : nodes) retained_nodes->push_back(std::move(node));
    }
    *output = result;
    if (output_entries) output_entries->swap(inventory);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

template <typename Output, typename Scan>
DWORD ScanWorkspace(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& owner_guard,
  Output* output, Scan scan) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const auto scan_limits = limits;
  if (!owner_guard.authorize || !scan_limits.wall_limit_ms || scan_limits.wall_limit_ms > 60000 ||
      !scan_limits.max_entries || scan_limits.max_entries > 65536 || scan_limits.max_depth > 64) return ERROR_INVALID_PARAMETER;
  if (owner_guard.cancellation == INVALID_HANDLE_VALUE || owner_guard.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
  struct Context final {
    CellWorkspaceDirectories* workspace;
    CellWorkspaceIdentities recorded;
    CellFootprintScanGuard guard;
    ULONGLONG deadline;
    DWORD Verify() const noexcept {
      const auto error = Guard{guard, deadline}.Check(false);
      if (error) return error;
      CellWorkspaceIdentities actual;
      const auto verified = workspace->RecordIdentities(&actual);
      if (verified) return verified;
      if (actual != recorded) return ERROR_FILE_INVALID;
      return Guard{guard, deadline}.Check(false);
    }
    static DWORD Authorize(void* raw) noexcept {
      const auto& context = *static_cast<Context*>(raw);
      const auto error = Guard{context.guard, context.deadline}.Check();
      return error ? error : context.Verify();
    }
  } context{&workspace, recorded, owner_guard, GetTickCount64() + scan_limits.wall_limit_ms};
  auto error = Context::Authorize(&context);
  if (error) return error;
  Output result;
  const CellFootprintScanGuard guarded{Context::Authorize, &context, context.guard.cancellation};
  const auto now = GetTickCount64(); if (now >= context.deadline) return ERROR_TIMEOUT;
  auto remaining = scan_limits; remaining.wall_limit_ms = static_cast<DWORD>(context.deadline - now);
  error = scan(workspace.DirectoryHandle(CellDirectory::root), context.recorded.directories[0], remaining, guarded, &result);
  if (!error) error = context.Verify();
  if (!error) *output = std::move(result);
  return error;
}
}

bool IsCellRuntimeFileSelectionPath(std::wstring_view path) noexcept {
  try { std::vector<std::wstring_view> parts; return FilePathParts(std::wstring(path), &parts); }
  catch (...) { return false; }
}

DWORD ScanCellDirectoryFootprint(HANDLE admitted_root, const CellFileIdentity& expected_root,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryFootprint* output) noexcept {
  return ScanDirectory(admitted_root, expected_root, limits, guard, output, nullptr);
}

DWORD ScanCellDirectoryInventory(HANDLE admitted_root, const CellFileIdentity& expected_root,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  return ScanDirectory(admitted_root, expected_root, limits, guard, &output->footprint, &output->entries);
}

DWORD ScanCellWorkspaceFootprint(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryFootprint* output) noexcept {
  return ScanWorkspace(workspace, recorded, limits, guard, output, ScanCellDirectoryFootprint);
}

DWORD ScanCellWorkspaceInventory(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (limits.max_entries > 20000) return ERROR_INVALID_PARAMETER;
  return ScanWorkspace(workspace, recorded, limits, guard, output, ScanCellDirectoryInventory);
}

struct CellDirectoryInventoryPins::State final {
  std::vector<std::unique_ptr<Node>> nodes;
  Guard guard;
  std::uint32_t maximum_entries;
};

DWORD CaptureCellWorkspaceInventory(CellWorkspaceDirectories& workspace, const CellWorkspaceIdentities& recorded,
  const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard,
  CellDirectoryInventoryPins& pins, CellDirectoryInventory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (pins.Ready()) return ERROR_ALREADY_INITIALIZED;
  auto error = ScanWorkspace(workspace, recorded, limits, guard, output,
    [&pins](HANDLE root, const CellFileIdentity& expected, const CellFootprintScanLimits& bound,
      const CellFootprintScanGuard& authority, CellDirectoryInventory* inventory) noexcept {
      return pins.Capture(root, expected, bound, authority, inventory);
    });
  if (!error) error = pins.Check();
  if (error) { *output = {}; pins.Close(); }
  return error;
}
CellDirectoryInventoryPins::CellDirectoryInventoryPins() noexcept = default;
CellDirectoryInventoryPins::~CellDirectoryInventoryPins() = default;
bool CellDirectoryInventoryPins::Ready() const noexcept { return state_ && !capturing_ && !interrupted_; }
void CellDirectoryInventoryPins::Close() noexcept {
  if (capturing_) interrupted_ = true;
  state_.reset();
}
DWORD CellDirectoryInventoryPins::Check() const noexcept {
  if (!Ready()) return ERROR_INVALID_STATE;
  return CheckPinnedNodes(state_->nodes, state_->guard, state_->maximum_entries);
}
DWORD CellDirectoryInventoryPins::ResolveFile(const CellFileIdentity& supplied_directory, std::wstring_view supplied_path,
  const CellFootprintScanGuard& supplied_authority, CellDirectoryInventoryEntry* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto directory = supplied_directory; const auto authority = supplied_authority;
  *output = {};
  if (capturing_) { interrupted_ = true; return ERROR_BUSY; }
  if (!Ready()) return ERROR_INVALID_STATE;
  if (!authority.authorize || supplied_path.size() > 512) return ERROR_INVALID_PARAMETER;
  if (authority.cancellation == INVALID_HANDLE_VALUE || authority.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
  try {
    const std::wstring path(supplied_path); // Freeze caller input before authority callbacks.
    std::vector<std::wstring_view> parts;
    if (!FilePathParts(path, &parts)) return ERROR_BAD_PATHNAME;
    auto retained = std::move(state_);
    capturing_ = true; interrupted_ = false;
    struct Finish final { bool& active; ~Finish() { active = false; } } finish{capturing_};
    const Guard fresh{authority, retained->guard.deadline};
    const auto check = [&]() -> DWORD {
      if (interrupted_) return ERROR_INVALID_STATE;
      auto error = retained->guard.Check(false);
      if (!error) error = fresh.Check();
      if (!error && interrupted_) error = ERROR_INVALID_STATE;
      if (!error) error = CheckPinnedNodes(retained->nodes, retained->guard, retained->maximum_entries);
      if (!error) error = fresh.Check(false);
      return error;
    };
    auto error = check(); if (error) return error;
    std::map<FileKey, const Node*> indexed;
    for (const auto& node : retained->nodes)
      if (!indexed.emplace(FileKey{node->metadata.identity.volume_serial, node->metadata.identity.file_id}, node.get()).second) return ERROR_FILE_INVALID;
    const auto root = indexed.find({directory.volume_serial, directory.file_id});
    if (root == indexed.end() || !root->second->metadata.directory || root->second->mount) return ERROR_FILE_INVALID;
    const Node* node = root->second;
    for (const auto part : parts) {
      if (!node->metadata.directory || node->mount) return ERROR_FILE_INVALID;
      const Entry* match = nullptr;
      for (const auto& entry : node->entries) {
        if (CompareStringOrdinal(entry.name.data(), static_cast<int>(entry.name.size()), part.data(), static_cast<int>(part.size()), TRUE) != CSTR_EQUAL) continue;
        if (match) return ERROR_DUP_NAME; // Case-sensitive NTFS directories may contain ambiguous names.
        match = &entry;
      }
      if (!match) return ERROR_FILE_NOT_FOUND;
      const auto child = indexed.find({node->metadata.identity.volume_serial, match->file_id});
      if (child == indexed.end() || match->mount || child->second->mount || child->second->metadata.directory != match->directory) return ERROR_FILE_INVALID;
      node = child->second;
      error = check(); if (error) return error;
    }
    if (node->metadata.directory) return ERROR_FILE_INVALID;
    const CellDirectoryInventoryEntry selected{node->metadata.identity, false, node->metadata.logical_bytes, node->metadata.allocated_bytes};
    state_ = std::move(retained); *output = selected;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellDirectoryInventoryPins::ReadFileContent(const CellFileIdentity& supplied_directory, const CellDirectoryInventoryEntry& supplied_expected,
  std::uint32_t maximum_bytes, const CellFootprintScanGuard& supplied_authority,
  std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  if (capturing_) { interrupted_ = true; return ERROR_BUSY; }
  if (!Ready()) return ERROR_INVALID_STATE;
  const auto expected = supplied_expected; const auto authority = supplied_authority; const auto admitted_directory = supplied_directory;
  if (!authority.authorize || !maximum_bytes || maximum_bytes > 1048576 || expected.directory ||
      expected.logical_file_bytes > maximum_bytes) return ERROR_INVALID_PARAMETER;
  if (authority.cancellation == INVALID_HANDLE_VALUE || authority.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
  // Keep custody local across callbacks. Close/reentry invalidates the operation
  // without destroying handles or buffers while this frame still uses them.
  auto retained = std::move(state_);
  capturing_ = true; interrupted_ = false;
  struct Finish final { bool& active; ~Finish() { active = false; } } finish{capturing_};
  try {
    const Guard fresh{authority, retained->guard.deadline};
    const auto check = [&]() -> DWORD {
      if (interrupted_) return ERROR_INVALID_STATE;
      auto error = retained->guard.Check(false);
      if (!error) error = fresh.Check();
      if (!error && interrupted_) error = ERROR_INVALID_STATE;
      if (!error) error = CheckPinnedNodes(retained->nodes, retained->guard, retained->maximum_entries);
      if (!error) error = fresh.Check(false);
      return error;
    };
    auto error = check(); if (error) return error;
    std::map<FileKey, const Node*> indexed;
    const auto key = [](const CellFileIdentity& identity) { return FileKey{identity.volume_serial, identity.file_id}; };
    for (const auto& node : retained->nodes) indexed.emplace(key(node->metadata.identity), node.get());
    const auto root = indexed.find(key(admitted_directory));
    if (root == indexed.end() || !root->second->metadata.directory || root->second->mount) return ERROR_FILE_INVALID;
    std::vector<const Node*> pending{root->second};
    std::set<FileKey> visited;
    HANDLE file = INVALID_HANDLE_VALUE;
    while (!pending.empty()) {
      error = fresh.Check(false); if (!error) error = retained->guard.Check(false); if (error) return error;
      const auto* node = pending.back(); pending.pop_back();
      if (!visited.insert(key(node->metadata.identity)).second) return ERROR_FILE_INVALID;
      for (const auto& child : node->entries) {
        const auto found = indexed.find({node->metadata.identity.volume_serial, child.file_id});
        if (found == indexed.end() || found->second->mount || found->second->metadata.directory != child.directory) return ERROR_FILE_INVALID;
        const auto* selected = found->second;
        if (child.directory) pending.push_back(selected);
        else if (selected->metadata.identity == expected.identity) {
          if (selected->metadata.logical_bytes != expected.logical_file_bytes || selected->metadata.allocated_bytes != expected.allocated_bytes)
            return ERROR_FILE_INVALID;
          file = selected->handle.value;
        }
      }
    }
    if (file == INVALID_HANDLE_VALUE) return ERROR_FILE_INVALID;
    LARGE_INTEGER start{};
    if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) return Error();
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(expected.logical_file_bytes));
    struct Wipe final { std::vector<std::uint8_t>& bytes; ~Wipe() { if (!bytes.empty()) SecureZeroMemory(bytes.data(), bytes.size()); } } wipe{bytes};
    std::size_t offset = 0;
    while (offset < bytes.size()) {
      error = check(); if (error) return error;
      const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(65536, bytes.size() - offset));
      DWORD received = 0;
      if (!ReadFile(file, bytes.data() + offset, requested, &received, nullptr)) return Error();
      if (received != requested) return ERROR_HANDLE_EOF;
      offset += received;
    }
    error = check(); if (error) return error;
    // A successful empty file is distinct from missing or unavailable content.
    state_ = std::move(retained); output->swap(bytes);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellDirectoryInventoryPins::Capture(HANDLE root, const CellFileIdentity& supplied_expected,
  const CellFootprintScanLimits& supplied_limits, const CellFootprintScanGuard& supplied_guard,
  CellDirectoryInventory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (capturing_) { interrupted_ = true; return ERROR_BUSY; }
  if (state_) return ERROR_ALREADY_INITIALIZED;
  const auto expected = supplied_expected; const auto limits = supplied_limits; const auto guard = supplied_guard;
  if (!guard.authorize || !limits.max_entries || limits.max_entries > 20000 || limits.max_depth > 64 ||
      !limits.wall_limit_ms || limits.wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
  if (guard.cancellation == INVALID_HANDLE_VALUE || guard.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
  interrupted_ = false; capturing_ = true;
  struct Finish final { bool& active; ~Finish() { active = false; } } finish{capturing_};
  try {
    const auto deadline = GetTickCount64() + limits.wall_limit_ms;
    struct Context final {
      CellDirectoryInventoryPins& owner; Guard authority;
      static DWORD Authorize(void* raw) noexcept {
        auto& self = *static_cast<Context*>(raw);
        if (self.owner.interrupted_) return ERROR_INVALID_STATE;
        auto error = self.authority.Check();
        return error ? error : self.owner.interrupted_ ? ERROR_INVALID_STATE : ERROR_SUCCESS;
      }
    } context{*this, {guard, deadline}};
    auto retained = std::make_unique<State>();
    // Do not retain the borrowed authority callback or its stack context.
    retained->guard = {{nullptr, nullptr, guard.cancellation}, deadline};
    retained->maximum_entries = limits.max_entries;
    CellDirectoryInventory inventory;
    auto error = ScanDirectory(root, expected, limits, {Context::Authorize, &context, guard.cancellation},
      &inventory.footprint, &inventory.entries, &retained->nodes);
    if (!error) error = Context::Authorize(&context);
    if (!error) error = CheckPinnedNodes(retained->nodes, retained->guard, retained->maximum_entries);
    if (error) return error;
    state_ = std::move(retained); *output = std::move(inventory);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

detail::CellCapacityObservation::CellCapacityObservation(const CellCapacityCaptureObserver* observer) noexcept
    : observer_(observer ? *observer : CellCapacityCaptureObserver{}), present_(observer != nullptr) {
  bridge_ = {this,
    [](void* raw, const CellCapacityPinnedView& view) noexcept { return static_cast<CellCapacityObservation*>(raw)->Capture(view); },
    [](void* raw) noexcept { static_cast<CellCapacityObservation*>(raw)->Discard(); }};
}
detail::CellCapacityObservation::~CellCapacityObservation() { if (!complete_) Discard(); }
bool detail::CellCapacityObservation::Valid() const noexcept { return !present_ || (observer_.capture && observer_.discard); }
DWORD detail::CellCapacityObservation::Capture(const CellCapacityPinnedView& view) noexcept {
  if (!Valid() || attempted_) return ERROR_INVALID_STATE;
  if (!present_) return ERROR_SUCCESS;
  attempted_ = true;
  return observer_.capture(observer_.context, view);
}
void detail::CellCapacityObservation::Discard() noexcept {
  if (attempted_ && !discarded_) { discarded_ = true; observer_.discard(observer_.context); }
}

DWORD ScanCellCapacityAreas(const CellCapacityAreaRoots& supplied_roots, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, CellCapacityAreaInventories* output,
  const CellCapacityBorrowedFiles* supplied_borrowed, const CellCapacityCaptureObserver* observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  detail::CellCapacityObservation observation(observer);
  if (!observation.Valid()) return ERROR_INVALID_PARAMETER;
  try {
    const auto roots = supplied_roots; const auto limits = supplied_limits; const auto owner = supplied_guard;
    if (owner.cancellation == INVALID_HANDLE_VALUE || owner.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    if (!owner.authorize || limits.max_entries < roots.size() || limits.max_entries > 20000 || limits.max_depth > 64 ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
    std::set<std::pair<std::uint64_t, std::array<std::uint8_t, 16>>> identities;
    for (const auto& root : roots) {
      if (!root.handle || root.handle == INVALID_HANDLE_VALUE || root.identity == CellFileIdentity{} ||
          !identities.emplace(root.identity.volume_serial, root.identity.file_id).second) return ERROR_INVALID_PARAMETER;
    }
    const auto deadline = GetTickCount64() + limits.wall_limit_ms;
    Borrowed borrowed; borrowed.primary = {owner, deadline}; borrowed.retained = {{}, deadline};
    if (supplied_borrowed) {
      const auto input = *supplied_borrowed;
      if ((input.files.empty() && input.mounts.empty()) || input.files.size() > limits.max_entries ||
          input.mounts.size() > limits.max_entries - input.files.size() || !input.guard.authorize) return ERROR_INVALID_PARAMETER;
      if (input.guard.cancellation == INVALID_HANDLE_VALUE || input.guard.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
      borrowed.retained.owner = input.guard;
      for (const auto& file : input.files) {
        if (!file.handle || file.handle == INVALID_HANDLE_VALUE || file.identity.file_id == std::array<std::uint8_t, 16>{} ||
            file.parent.file_id == std::array<std::uint8_t, 16>{} || file.parent.volume_serial != file.identity.volume_serial ||
            file.logical_bytes > kMaximumBytes || file.allocated_bytes > kMaximumBytes ||
            !borrowed.files.emplace(FileKey{file.identity.volume_serial, file.identity.file_id}, file).second) return ERROR_INVALID_PARAMETER;
      }
      for (const auto* mount : input.mounts) {
        if (!mount) return ERROR_INVALID_PARAMETER;
        const auto& target = mount->Target();
        const FileKey key{target.directory.volume_serial, target.directory.file_id};
        if (borrowed.files.contains(key) || !borrowed.mounts.emplace(key, mount).second) return ERROR_INVALID_PARAMETER;
      }
    }
    const CellFootprintScanGuard combined{Borrowed::Authorize, &borrowed, owner.cancellation};
    const Guard guard{combined, deadline};
    std::vector<std::unique_ptr<Node>> nodes;
    CellCapacityAreaInventories result;
    for (std::size_t area = 0; area < roots.size(); ++area) {
      auto error = guard.Check(); if (error) return error;
      const auto now = GetTickCount64(); if (now >= guard.deadline) return ERROR_TIMEOUT;
      if (nodes.size() >= limits.max_entries) return ERROR_BUFFER_OVERFLOW;
      const CellFootprintScanLimits remaining{limits.max_entries - static_cast<std::uint32_t>(nodes.size()),
        limits.max_depth, static_cast<DWORD>(guard.deadline - now)};
      auto& inventory = result[area];
      error = ScanDirectory(roots[area].handle, roots[area].identity, remaining, combined,
        &inventory.footprint, &inventory.entries, &nodes, &borrowed);
      if (error) return error;
    }
    auto error = guard.Check(); if (error) return error;
    if (borrowed.seen.size() != borrowed.files.size()) return ERROR_FILE_NOT_FOUND;
    if (borrowed.mounts_seen.size() != borrowed.mounts.size()) return ERROR_FILE_NOT_FOUND;
    struct Pinned final {
      const std::vector<std::unique_ptr<Node>>& nodes;
      const Guard& guard; const Borrowed& borrowed; const CellFootprintScanLimits& limits;
      static DWORD Check(void* raw) noexcept {
        const auto& self = *static_cast<Pinned*>(raw);
        auto error = CheckPinnedNodes(self.nodes, self.guard, self.limits.max_entries, &self.borrowed); if (error) return error;
        return self.borrowed.files.empty() && self.borrowed.mounts.empty() ? ERROR_SUCCESS : self.borrowed.retained.Check(false);
      }
      static DWORD Children(void* raw, const CellFileIdentity& supplied_directory, std::span<const CellCapacityChild> supplied) noexcept {
        const auto& self = *static_cast<Pinned*>(raw);
        if (supplied.size() > self.limits.max_entries) return ERROR_BUFFER_OVERFLOW;
        try {
          const auto directory = supplied_directory;
          auto expected = std::vector<CellCapacityChild>(supplied.begin(), supplied.end());
          auto error = Check(raw); if (error) return error;
          const Node* root = nullptr;
          for (const auto& node : self.nodes) if (node->metadata.identity == directory) { root = node.get(); break; }
          if (!root || !root->metadata.directory || root->mount || root->entries.size() != expected.size()) return ERROR_FILE_INVALID;
          std::sort(expected.begin(), expected.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
          for (std::size_t i = 0; i < expected.size(); ++i) {
            const auto& value = expected[i]; const auto& actual = root->entries[i];
            if (value.name.empty() || value.name == L"." || value.name == L".." || value.name.find_first_of(L"\\/:") != std::wstring::npos ||
                (i && value.name == expected[i - 1].name) || value.name != actual.name || value.identity.volume_serial != directory.volume_serial ||
                value.identity.file_id != actual.file_id || value.directory != actual.directory || actual.mount) return ERROR_FILE_INVALID;
          }
          return Check(raw);
        } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      }
    } pinned{nodes, guard, borrowed, limits};
    const CellCapacityPinnedView view(&pinned, Pinned::Check, Pinned::Children);
    if (observer) {
      error = view.Check(); if (error) return error;
      error = observation.Capture(view); if (error) return error;
      error = guard.Check(); if (error) return error;
    }
    // Revalidate every area after the observer and final authority callback.
    error = view.Check(); if (error) return error;
    *output = std::move(result); observation.Complete(); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

void CellCapacityLayout::Close() noexcept {
  if (scanning_ || verifying_) interrupted_ = true;
  open_ = false;
  // A policy callback cannot invalidate the handle it is currently inspecting.
  if (verifying_) return;
  roots_ = {}; record_ = {}; descriptor_.clear(); security_ = {};
  for (auto& pin : pins_) pin.reset();
}
DWORD CellCapacityLayout::VerifyRetainedSecurity(const std::wstring& owner,
  const std::wstring& controller, const CellCapacityRootSecurity& security,
  const std::vector<std::uint8_t>& descriptor) noexcept {
  const auto matches = [&]() {
    return security_.context == security.context && security_.verify == security.verify &&
      descriptor_ == descriptor;
  };
  if (!matches()) return ERROR_INVALID_SECURITY_DESCR;
  if (!security.verify) {
    std::vector<std::uint8_t> expected;
    const auto error = BuildCellParentSecurity(owner, controller, &expected);
    if (error) return error;
    if (expected != descriptor) return ERROR_INVALID_SECURITY_DESCR;
  } else if (!descriptor.empty()) return ERROR_INVALID_SECURITY_DESCR;
  const auto error = Verify();
  return error ? error : matches() ? ERROR_SUCCESS : ERROR_INVALID_SECURITY_DESCR;
}

DWORD CellCapacityLayout::Verify() noexcept {
  if (verifying_) { interrupted_ = true; return ERROR_BUSY; }
  if (!open_ || interrupted_) return ERROR_INVALID_STATE;
  verifying_ = true;
  struct Finish final { bool& active; ~Finish() { active = false; } } finish{verifying_};
  for (std::size_t i = 0; i < roots_.size(); ++i) {
    Metadata value; auto error = Inspect(roots_[i].handle, &value);
    if (!error && (!value.directory || value.identity != record_.roots[i])) error = ERROR_FILE_INVALID;
    if (!error) error = security_.verify
      ? security_.verify(security_.context, static_cast<CellCapacityArea>(i), roots_[i].handle, record_.roots[i])
      : VerifyCellSecurity(roots_[i].handle, descriptor_);
    if (!open_ || interrupted_) return ERROR_INVALID_STATE;
    if (error) return error;
  }
  return ERROR_SUCCESS;
}
DWORD CellCapacityLayout::OpenRecorded(const CellCapacityLayoutRecord& supplied_record, const CellCapacityAreaRoots& supplied_roots,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (scanning_ || verifying_) { interrupted_ = true; return ERROR_BUSY; }
  const auto record = supplied_record; const auto roots = supplied_roots;
  Close(); interrupted_ = false;
  const auto error = BuildCellParentSecurity(owner_sid, controller_sid, &descriptor_);
  return error ? error : OpenRoots(record, roots);
}
DWORD CellCapacityLayout::OpenRecordedWithSecurity(const CellCapacityLayoutRecord& supplied_record,
  const CellCapacityAreaRoots& supplied_roots, const CellCapacityRootSecurity& supplied_security) noexcept {
  if (scanning_ || verifying_) { interrupted_ = true; return ERROR_BUSY; }
  const auto record = supplied_record; const auto roots = supplied_roots; const auto security = supplied_security;
  Close(); interrupted_ = false;
  if (!security.verify) return ERROR_INVALID_PARAMETER;
  security_ = security;
  return OpenRoots(record, roots);
}
DWORD CellCapacityLayout::OpenRoots(const CellCapacityLayoutRecord& record, const CellCapacityAreaRoots& roots) noexcept {
  try {
    const auto nonzero = [](const CellFileSha256& hash) { return std::any_of(hash.begin(), hash.end(), [](auto b) { return b != 0; }); };
    if (!nonzero(record.assignment_binding) || !nonzero(record.profile_sha256)) return ERROR_INVALID_PARAMETER;
    std::set<std::pair<std::uint64_t, std::array<std::uint8_t, 16>>> identities;
    for (std::size_t i = 0; i < roots.size(); ++i) {
      if (!roots[i].handle || roots[i].handle == INVALID_HANDLE_VALUE || roots[i].identity != record.roots[i] ||
          record.roots[i] == CellFileIdentity{} || !identities.emplace(record.roots[i].volume_serial, record.roots[i].file_id).second)
        return ERROR_INVALID_PARAMETER;
    }
    DWORD error = ERROR_SUCCESS;
    for (std::size_t i = 0; !error && i < roots.size(); ++i) {
      pins_[i] = std::make_unique<PinnedCellLaunchFiles>(); std::wstring canonical;
      error = pins_[i]->PinDirectoryHandle(roots[i].handle, record.roots[i], &roots_[i].handle, &canonical);
      roots_[i].identity = record.roots[i];
    }
    if (!error) { record_ = record; open_ = true; error = Verify(); }
    if (error) Close(); return error;
  } catch (...) { Close(); return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellCapacityLayout::Scan(const CellCapacityLayoutRecord& supplied_record, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, CellCapacityAreaInventories* output,
  const CellCapacityBorrowedFiles* borrowed, const CellCapacityCaptureObserver* observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  detail::CellCapacityObservation observation(observer);
  if (!observation.Valid()) return ERROR_INVALID_PARAMETER;
  if (scanning_ || verifying_) { interrupted_ = true; return ERROR_BUSY; }
  if (supplied_record != record_ || !supplied_guard.authorize) return ERROR_INVALID_PARAMETER;
  const auto limits = supplied_limits; const auto guard = supplied_guard;
  if (guard.cancellation == INVALID_HANDLE_VALUE || guard.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
  if (!limits.wall_limit_ms || limits.wall_limit_ms > 60000 || limits.max_entries < kCellCapacityAreaCount ||
      limits.max_entries > 20000 || limits.max_depth > 64) return ERROR_INVALID_PARAMETER;
  const Guard bound{guard, GetTickCount64() + limits.wall_limit_ms};
  auto error = bound.Check(false);
  if (!error) error = Verify();
  if (!error) error = bound.Check(false);
  if (error) return error;
  scanning_ = true;
  struct Finish final { bool& active; ~Finish() { active = false; } } finish{scanning_};
  struct Context final {
    CellCapacityLayout* layout; Guard bound;
    static DWORD Authorize(void* raw) noexcept {
      auto& self = *static_cast<Context*>(raw);
      auto error = self.bound.Check(false);
      if (!error) error = self.layout->Verify();
      if (!error) error = self.bound.Check();
      if (!error) error = self.layout->Verify();
      return error ? error : self.bound.Check(false);
    }
  } context{this, bound};
  CellCapacityAreaInventories result;
  const auto now = GetTickCount64(); if (now >= bound.deadline) return ERROR_TIMEOUT;
  auto remaining = limits; remaining.wall_limit_ms = static_cast<DWORD>(bound.deadline - now);
  error = ScanCellCapacityAreas(roots_, remaining, {Context::Authorize, &context, guard.cancellation}, &result, borrowed, observation.Bridge());
  if (!error) error = Verify();
  if (!error) error = bound.Check(false);
  if (!error) { *output = std::move(result); observation.Complete(); }
  return error;
}
}
