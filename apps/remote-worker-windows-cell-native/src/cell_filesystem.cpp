#include "cell_filesystem.hpp"
#include "cell_runtime_bundle.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cwchar>
#include <map>
#include <set>
#include <string_view>
#include <utility>
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::uint64_t kMaximumImageBytes = 256ULL * 1024 * 1024;
constexpr DWORD kUnsafeAttributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
  FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
  FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Hash final {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE value = nullptr;
  std::vector<std::uint8_t> object;
  ~Hash() {
    if (value) BCryptDestroyHash(value);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  }
};
DWORD Error() noexcept { const DWORD value = GetLastError(); return value ? value : ERROR_GEN_FAILURE; }
bool SamePath(const std::wstring& a, const std::wstring& b) noexcept {
  return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}
bool LiteralComponent(std::wstring_view name) {
  if (name.empty() || name.size() > 255 || name.back() == L'.' || name.back() == L' ') return false;
  for (const wchar_t value : name)
    if (value < L' ' || value == 0x7f || std::wstring_view(L"/\\:*?\"<>|").find(value) != std::wstring_view::npos) return false;
  auto stem = std::wstring(name.substr(0, name.find(L'.')));
  for (auto& value : stem) if (value >= L'a' && value <= L'z') value -= L'a' - L'A';
  if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
      stem == L"CONIN$" || stem == L"CONOUT$" || stem == L"CLOCK$") return false;
  if (stem.size() == 4 && (stem.compare(0, 3, L"COM") == 0 || stem.compare(0, 3, L"LPT") == 0)) {
    const auto suffix = stem.back();
    if ((suffix >= L'1' && suffix <= L'9') || suffix == 0xb9 || suffix == 0xb2 || suffix == 0xb3) return false;
  }
  return true;
}
std::size_t LiteralRootLength(const std::wstring& path) {
  if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\' &&
      ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))) return 3;
  // Protected workspace handles expose this exact volume form. No generic NT,
  // UNC, extended drive-letter, device or GLOBALROOT namespace is accepted.
  if (path.size() < 49 || path.compare(0, 11, L"\\\\?\\Volume{") != 0 || path[47] != L'}' || path[48] != L'\\') return 0;
  for (std::size_t index = 11; index < 47; ++index) {
    if (index == 19 || index == 24 || index == 29 || index == 34) {
      if (path[index] != L'-') return 0;
    } else if (!((path[index] >= L'0' && path[index] <= L'9') ||
        (path[index] >= L'a' && path[index] <= L'f') || (path[index] >= L'A' && path[index] <= L'F'))) return 0;
  }
  return 49;
}
bool LiteralPath(const std::wstring& path) {
  const auto root_length = LiteralRootLength(path);
  if (!root_length || path.size() >= 2048) return false;
  unsigned depth = 0;
  for (std::size_t begin = root_length; begin < path.size();) {
    const auto end = path.find(L'\\', begin);
    if (++depth > 64 || !LiteralComponent(std::wstring_view(path).substr(begin,
        end == std::wstring::npos ? path.size() - begin : end - begin))) return false;
    if (end == std::wstring::npos) return true;
    begin = end + 1;
    if (begin == path.size()) return false;
  }
  return path.size() == root_length;
}
DWORD FinalPath(HANDLE object, DWORD kind, std::wstring* path) {
  std::array<wchar_t, 4096> buffer{};
  const DWORD length = GetFinalPathNameByHandleW(object, buffer.data(), static_cast<DWORD>(buffer.size()), kind);
  if (!length) return Error();
  if (length >= buffer.size()) return ERROR_BUFFER_OVERFLOW;
  path->assign(buffer.data(), length);
  return ERROR_SUCCESS;
}
DWORD Streams(HANDLE object, bool directory, std::uint64_t length) noexcept {
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> buffer{};
  if (!GetFileInformationByHandleEx(object, FileStreamInfo, buffer.data(), static_cast<DWORD>(buffer.size()))) {
    const DWORD error = Error();
    return directory && error == ERROR_HANDLE_EOF ? ERROR_SUCCESS : error;
  }
  const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(buffer.data());
  if (directory && stream->StreamNameLength == 0 && stream->NextEntryOffset == 0) return ERROR_SUCCESS;
  constexpr std::wstring_view unnamed = L"::$DATA";
  if (stream->NextEntryOffset != 0 || stream->StreamNameLength != unnamed.size() * sizeof(wchar_t) ||
      std::wstring_view(stream->StreamName, unnamed.size()) != unnamed || stream->StreamSize.QuadPart < 0 ||
      static_cast<std::uint64_t>(stream->StreamSize.QuadPart) != length || (directory && length != 0)) return ERROR_ACCESS_DENIED;
  return ERROR_SUCCESS;
}
DWORD Identity(HANDLE object, bool directory, CellFileIdentity* identity, std::uint64_t* bytes) noexcept {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO file{};
  if (GetFileType(object) != FILE_TYPE_DISK) return ERROR_ACCESS_DENIED;
  if (!GetFileInformationByHandleEx(object, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(object, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(object, FileIdInfo, &file, sizeof(file))) return Error();
  if ((attributes.FileAttributes & kUnsafeAttributes) || attributes.ReparseTag ||
      ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
      (standard.Directory != FALSE) != directory || standard.NumberOfLinks != 1 || standard.DeletePending ||
      standard.EndOfFile.QuadPart < 0 || standard.AllocationSize.QuadPart < 0) return ERROR_ACCESS_DENIED;
  *bytes = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  const DWORD streams = Streams(object, directory, *bytes);
  if (streams) return streams;
  identity->volume_serial = file.VolumeSerialNumber;
  std::copy(std::begin(file.FileId.Identifier), std::end(file.FileId.Identifier), identity->file_id.begin());
  return ERROR_SUCCESS;
}
DWORD ImageHash(HANDLE image, std::uint64_t size, CellFileSha256* digest, bool allow_empty = false, HANDLE cancellation = nullptr) {
  if ((!size && !allow_empty) || size > kMaximumImageBytes) return ERROR_FILE_TOO_LARGE;
  Hash hash;
  if (BCryptOpenAlgorithmProvider(&hash.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return ERROR_INVALID_DATA;
  ULONG length = 0, received = 0;
  if (BCryptGetProperty(hash.algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&length), sizeof(length), &received, 0) != 0 ||
      received != sizeof(length) || !length || length > 65536) return ERROR_INVALID_DATA;
  hash.object.resize(length);
  if (BCryptCreateHash(hash.algorithm, &hash.value, hash.object.data(), length, nullptr, 0, 0) != 0) return ERROR_INVALID_DATA;
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(image, start, nullptr, FILE_BEGIN)) return Error();
  std::array<std::uint8_t, 65536> buffer{};
  std::uint64_t total = 0;
  while (total < size) {
    if (cancellation && WaitForSingleObject(cancellation, 0) != WAIT_TIMEOUT) return ERROR_CANCELLED;
    DWORD count = 0;
    if (!ReadFile(image, buffer.data(), static_cast<DWORD>(std::min<std::uint64_t>(buffer.size(), size - total)), &count, nullptr)) return Error();
    if (!count || BCryptHashData(hash.value, buffer.data(), count, 0) != 0) return ERROR_INVALID_DATA;
    total += count;
  }
  DWORD remaining = 0;
  if (!ReadFile(image, buffer.data(), 1, &remaining, nullptr)) return Error();
  if (remaining || BCryptFinishHash(hash.value, digest->data(), static_cast<ULONG>(digest->size()), 0) != 0) return ERROR_INVALID_DATA;
  return ERROR_SUCCESS;
}

using BundleNodes = std::map<std::wstring, const CellRuntimeBundleFile*>;
DWORD BundleManifest(const std::vector<CellRuntimeBundleFile>& files, BundleNodes* nodes, std::vector<std::uint8_t>* bytes) {
  if (files.empty() || files.size() > 4096) return ERROR_INVALID_PARAMETER;
  constexpr char domain[] = "goatcitadel.worker-runtime-bundle.v1";
  bytes->insert(bytes->end(), domain, domain + sizeof(domain));
  const auto integer = [&](std::uint64_t value, unsigned width) {
    for (unsigned i = 0; i < width; ++i) bytes->push_back(static_cast<std::uint8_t>(value >> (8 * i)));
  };
  integer(files.size(), 4);
  std::map<std::wstring, std::wstring> spellings;
  std::wstring previous;
  std::uint64_t total = 0;
  unsigned directory_count = 0;
  for (const auto& file : files) {
    if (file.relative_path.empty() || file.relative_path.size() > 512 ||
        (!previous.empty() && previous >= file.relative_path) || file.bytes > kMaximumImageBytes ||
        total + file.bytes > 1024ULL * 1024 * 1024) return ERROR_INVALID_PARAMETER;
    previous = file.relative_path;
    total += file.bytes;
    for (const auto value : file.relative_path) if (value < L' ' || value > L'~' || value == L'\\') return ERROR_INVALID_PARAMETER;
    unsigned depth = 0;
    for (std::size_t begin = 0; begin < file.relative_path.size();) {
      const auto slash = file.relative_path.find(L'/', begin);
      const auto end = slash == std::wstring::npos ? file.relative_path.size() : slash;
      if (++depth > 64 || !LiteralComponent(std::wstring_view(file.relative_path).substr(begin, end - begin))) return ERROR_INVALID_PARAMETER;
      const auto prefix = file.relative_path.substr(0, end);
      auto lower = prefix;
      for (auto& value : lower) if (value >= L'A' && value <= L'Z') value += L'a' - L'A';
      const auto [spelling, fresh] = spellings.emplace(lower, prefix);
      if (!fresh && spelling->second != prefix) return ERROR_INVALID_PARAMETER;
      if (slash != std::wstring::npos) {
        const auto [node, created] = nodes->try_emplace(prefix, nullptr);
        if (node->second != nullptr || (created && ++directory_count > 4096)) return ERROR_INVALID_PARAMETER;
        begin = end + 1;
        if (begin == file.relative_path.size()) return ERROR_INVALID_PARAMETER;
      } else break;
    }
    if (!nodes->emplace(file.relative_path, &file).second) return ERROR_INVALID_PARAMETER;
    integer(file.relative_path.size(), 4);
    for (const auto value : file.relative_path) bytes->push_back(static_cast<std::uint8_t>(value));
    integer(file.bytes, 8);
    bytes->insert(bytes->end(), file.sha256.begin(), file.sha256.end());
  }
  if (nodes->size() - files.size() > 4096) return ERROR_INVALID_PARAMETER;
  // Refuse a file used as a parent even when its child sorted after it.
  for (const auto& [name, file] : *nodes) {
    for (auto slash = name.find(L'/'); slash != std::wstring::npos; slash = name.find(L'/', slash + 1))
      if (nodes->at(name.substr(0, slash)) != nullptr) return ERROR_INVALID_PARAMETER;
  }
  return ERROR_SUCCESS;
}
DWORD DigestBytes(const std::vector<std::uint8_t>& bytes, CellFileSha256* digest) {
  Hash hash;
  if (BCryptOpenAlgorithmProvider(&hash.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return ERROR_INVALID_DATA;
  if (BCryptHash(hash.algorithm, nullptr, 0, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()),
      digest->data(), static_cast<ULONG>(digest->size())) != 0) return ERROR_INVALID_DATA;
  return ERROR_SUCCESS;
}
struct Search final { HANDLE value = INVALID_HANDLE_VALUE; ~Search() { if (value != INVALID_HANDLE_VALUE) FindClose(value); } };
}

bool IsLiteralCellPath(const std::wstring& path) noexcept {
  try { return LiteralPath(path); } catch (...) { return false; }
}
PinnedCellLaunchFiles::~PinnedCellLaunchFiles() { Reset(); }
void PinnedCellLaunchFiles::Reset() noexcept {
  for (auto handle = handles_.rbegin(); handle != handles_.rend(); ++handle) CloseHandle(*handle);
  handles_.clear(); image_.clear(); process_image_.clear(); native_image_.clear(); directory_.clear();
}
DWORD PinnedCellLaunchFiles::PinPath(const std::wstring& path, bool directory, HANDLE* leaf, std::wstring* canonical) {
  const auto root_length = LiteralRootLength(path);
  if (!root_length) return ERROR_INVALID_PARAMETER;
  const auto drive = path.substr(0, root_length);
  if (GetDriveTypeW(drive.c_str()) != DRIVE_FIXED) return ERROR_NOT_SUPPORTED;
  std::wstring guid_root;
  CellFileIdentity root{};
  std::size_t end = root_length;
  for (;;) {
    const bool is_leaf = end == path.size();
    const bool is_directory = !is_leaf || directory;
    const auto current = end == root_length ? (root_length == 3 ? L"\\\\?\\" + drive : drive)
      : guid_root + path.substr(root_length, end - root_length);
    // Metadata-only handles do not participate in Windows' sharing protection.
    // Directory data access is required to keep rename/delete exclusion real.
    Handle opened{CreateFileW(current.c_str(), is_directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL : GENERIC_READ,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (is_directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)};
    if (opened.value == INVALID_HANDLE_VALUE) return Error();
    CellFileIdentity identity{};
    std::uint64_t bytes = 0;
    DWORD error = Identity(opened.value, is_directory, &identity, &bytes);
    if (error) return error;
    std::wstring actual;
    error = FinalPath(opened.value, VOLUME_NAME_GUID, &actual);
    if (error) return error;
    if (end == root_length) {
      std::wstring dos;
      if (root_length == 3) {
        error = FinalPath(opened.value, VOLUME_NAME_DOS, &dos);
        if (error) return error;
      }
      std::array<wchar_t, 16> filesystem{};
      if ((root_length == 3 ? !SamePath(dos, L"\\\\?\\" + drive) : !SamePath(actual, drive)) ||
          LiteralRootLength(actual) != actual.size() ||
          !GetVolumeInformationByHandleW(opened.value, nullptr, 0, nullptr, nullptr, nullptr,
            filesystem.data(), static_cast<DWORD>(filesystem.size())) || wcscmp(filesystem.data(), L"NTFS") != 0) return ERROR_NOT_SUPPORTED;
      guid_root = actual;
      root = identity;
    } else if (identity.volume_serial != root.volume_serial || !SamePath(actual, current)) return ERROR_ACCESS_DENIED;
    handles_.push_back(opened.value);
    *leaf = opened.value;
    opened.value = INVALID_HANDLE_VALUE;
    if (is_leaf) { *canonical = actual; return ERROR_SUCCESS; }
    end = path.find(L'\\', end == root_length ? root_length : end + 1);
    if (end == std::wstring::npos) end = path.size();
  }
}
DWORD PinnedCellLaunchFiles::PinDirectoryHandle(HANDLE admitted, const CellFileIdentity& expected,
                                               HANDLE* leaf, std::wstring* canonical) noexcept {
  if (!handles_.empty()) return ERROR_ALREADY_INITIALIZED;
  const auto reject = [&](DWORD error) { Reset(); return error; };
  try {
    if (!admitted || admitted == INVALID_HANDLE_VALUE || !leaf || !canonical) return ERROR_INVALID_HANDLE;
    CellFileIdentity identity{};
    std::uint64_t bytes = 0;
    DWORD error = Identity(admitted, true, &identity, &bytes);
    if (!error && identity != expected) error = ERROR_FILE_INVALID;
    std::wstring original, pinned;
    if (!error) error = FinalPath(admitted, VOLUME_NAME_GUID, &original);
    if (error) return error;
    if (!LiteralPath(original) || LiteralRootLength(original) != 49) return ERROR_BAD_PATHNAME;
    handles_.reserve(65);
    HANDLE opened = INVALID_HANDLE_VALUE;
    error = PinPath(original, true, &opened, &pinned);
    if (!error) error = Identity(opened, true, &identity, &bytes);
    if (!error && (identity != expected || !SamePath(original, pinned))) error = ERROR_FILE_INVALID;
    if (error) return reject(error);
    *canonical = std::move(pinned);
    *leaf = opened;
    return ERROR_SUCCESS;
  } catch (...) { return reject(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD PinnedCellLaunchFiles::Open(const std::wstring& image, const std::wstring& directory,
  const CellFileSha256& expected_image, const CellFileIdentity& expected_directory) noexcept {
  if (!handles_.empty()) return ERROR_ALREADY_INITIALIZED;
  try {
    if (!LiteralPath(image) || !LiteralPath(directory)) return ERROR_INVALID_PARAMETER;
    handles_.reserve(130);
    HANDLE root = INVALID_HANDLE_VALUE, executable = INVALID_HANDLE_VALUE;
    DWORD error = PinPath(directory, true, &root, &directory_);
    CellFileIdentity directory_identity{};
    std::uint64_t bytes = 0;
    if (!error) error = Identity(root, true, &directory_identity, &bytes);
    if (!error && directory_identity != expected_directory) error = ERROR_FILE_INVALID;
    if (!error) error = PinPath(image, false, &executable, &image_);
    CellFileIdentity image_identity{};
    if (!error) error = Identity(executable, false, &image_identity, &bytes);
    CellFileSha256 digest{};
    if (!error) error = ImageHash(executable, bytes, &digest);
    if (!error && digest != expected_image) error = ERROR_CRC;
    if (!error) error = FinalPath(executable, VOLUME_NAME_NT, &native_image_);
    if (!error) {
      process_image_ = image_;
      std::wstring dos;
      const DWORD mapped = FinalPath(executable, VOLUME_NAME_DOS, &dos);
      if (!mapped && dos.rfind(L"\\\\?\\", 0) == 0 && dos.size() > 7 && dos[5] == L':' && dos[6] == L'\\' &&
          LiteralPath(dos.substr(4))) process_image_ = dos;
    }
    if (error) Reset();
    return error;
  } catch (...) { Reset(); return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD PinnedCellLaunchFiles::VerifyProcessImage(HANDLE process) const noexcept {
  if (!process || process == INVALID_HANDLE_VALUE || native_image_.empty() || handles_.empty()) return ERROR_INVALID_HANDLE;
  std::array<wchar_t, 4096> actual{};
  DWORD length = static_cast<DWORD>(actual.size());
  // The native image name comes from the created process, not a fresh resolution
  // of its potentially remapped DOS launch locator. The admitted native path and
  // file cannot be replaced or renamed while their exclusive-sharing pins live.
  if (!QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE, actual.data(), &length)) return Error();
  if (length >= actual.size()) return ERROR_BUFFER_OVERFLOW;
  return CompareStringOrdinal(actual.data(), static_cast<int>(length), native_image_.data(),
    static_cast<int>(native_image_.size()), TRUE) == CSTR_EQUAL ? ERROR_SUCCESS : ERROR_FILE_INVALID;
}

DWORD PinnedCellToolDirectory::Open(const std::wstring& path, const CellFileIdentity* expected) noexcept {
  if (!path_.empty()) return ERROR_ALREADY_INITIALIZED;
  const auto reject = [&](DWORD error) { pins_.Reset(); path_.clear(); identity_ = {}; return error; };
  try {
    if (!LiteralPath(path) || path.size() == LiteralRootLength(path)) return ERROR_INVALID_PARAMETER;
    pins_.handles_.reserve(65);
    HANDLE directory = INVALID_HANDLE_VALUE;
    DWORD error = pins_.PinPath(path, true, &directory, &path_);
    std::uint64_t bytes = 0;
    if (!error) error = worker_cell::Identity(directory, true, &identity_, &bytes);
    if (!error && expected && identity_ != *expected) error = ERROR_FILE_INVALID;
    return error ? reject(error) : ERROR_SUCCESS;
  } catch (...) { return reject(ERROR_NOT_ENOUGH_MEMORY); }
}

DWORD PinnedCellToolDirectory::Write(const std::wstring& relative_path, const std::vector<std::uint8_t>& content,
    const std::optional<std::vector<std::uint8_t>>& expected_content, CellToolWriteResult* result) noexcept {
  if (!result) return ERROR_INVALID_PARAMETER;
  *result = {};
  try {
    constexpr std::size_t maximum_bytes = 32 * 1024;
    if (path_.empty() || relative_path.empty() || relative_path.size() > 1024 ||
        content.size() > maximum_bytes || (expected_content && expected_content->size() > maximum_bytes)) return ERROR_INVALID_PARAMETER;
    unsigned depth = 0;
    for (std::size_t start = 0; start < relative_path.size();) {
      const auto slash = relative_path.find(L'/', start);
      const auto end = slash == std::wstring::npos ? relative_path.size() : slash;
      if (++depth > 32 || !LiteralComponent(std::wstring_view(relative_path).substr(start, end - start))) return ERROR_BAD_PATHNAME;
      if (slash == std::wstring::npos) break;
      start = slash + 1;
      if (start == relative_path.size()) return ERROR_BAD_PATHNAME;
    }
    auto target = path_ + L"\\" + relative_path;
    std::replace(target.begin() + static_cast<std::ptrdiff_t>(path_.size()), target.end(), L'/', L'\\');
    if (!LiteralPath(target)) return ERROR_BAD_PATHNAME;
    PinnedCellLaunchFiles parents;
    parents.handles_.reserve(65);
    HANDLE parent = INVALID_HANDLE_VALUE;
    std::wstring canonical_parent;
    DWORD error = parents.PinPath(target.substr(0, target.rfind(L'\\')), true, &parent, &canonical_parent);
    if (error) return error;
    target = canonical_parent + target.substr(target.rfind(L'\\'));
    // OPEN_EXISTING never truncates. Zero sharing excludes competing readers,
    // writers, hard-link/rename operations and writable mappings during CAS.
    Handle file{CreateFileW(target.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
      expected_content ? OPEN_EXISTING : CREATE_NEW, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    if (file.value == INVALID_HANDLE_VALUE) return Error();
    result->created = !expected_content.has_value();
    result->effect_started = result->created;
    CellFileIdentity before{};
    std::uint64_t length = 0;
    error = worker_cell::Identity(file.value, false, &before, &length);
    std::wstring actual;
    if (!error) error = FinalPath(file.value, VOLUME_NAME_GUID, &actual);
    if (!error && (before.volume_serial != identity_.volume_serial || !SamePath(actual, target))) error = ERROR_FILE_INVALID;
    if (error) return error;
    if (expected_content) {
      if (length != expected_content->size()) return ERROR_REVISION_MISMATCH;
      std::vector<std::uint8_t> previous(static_cast<std::size_t>(length));
      DWORD count = 0;
      if (length && (!ReadFile(file.value, previous.data(), static_cast<DWORD>(length), &count, nullptr) || count != length))
        return ERROR_READ_FAULT;
      if (previous != *expected_content) return ERROR_REVISION_MISMATCH;
    }
    LARGE_INTEGER start{};
    if (!SetFilePointerEx(file.value, start, nullptr, FILE_BEGIN)) return Error();
    result->effect_started = true;
    DWORD written = 0;
    if (!content.empty() && (!WriteFile(file.value, content.data(), static_cast<DWORD>(content.size()), &written, nullptr) ||
        written != content.size())) return ERROR_WRITE_FAULT;
    if (!SetEndOfFile(file.value) || !FlushFileBuffers(file.value)) return Error();
    CellFileIdentity after{};
    error = worker_cell::Identity(file.value, false, &after, &length);
    if (!error && (after != before || length != content.size())) error = ERROR_FILE_INVALID;
    CellFileSha256 expected_sha256{};
    if (!error) error = DigestBytes(content, &expected_sha256);
    if (!error) error = ImageHash(file.value, length, &result->sha256, true);
    if (!error && result->sha256 != expected_sha256) error = ERROR_CRC;
    if (!error) result->bytes = length;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD PinnedCellToolDirectory::List(const std::wstring& relative_path, CellToolDirectoryResult* result) noexcept {
  if (!result) return ERROR_INVALID_PARAMETER;
  *result = {};
  try {
    if (path_.empty() || relative_path.size() > 1024) return ERROR_INVALID_PARAMETER;
    unsigned depth = 0;
    for (std::size_t start = 0; start < relative_path.size();) {
      const auto separator = relative_path.find(L'/', start);
      const auto end = separator == std::wstring::npos ? relative_path.size() : separator;
      if (++depth > 32 || !LiteralComponent(std::wstring_view(relative_path).substr(start, end - start))) return ERROR_BAD_PATHNAME;
      if (separator == std::wstring::npos) break;
      start = separator + 1;
      if (start == relative_path.size()) return ERROR_BAD_PATHNAME;
    }
    auto target = path_ + (relative_path.empty() ? L"" : L"\\" + relative_path);
    std::replace(target.begin() + static_cast<std::ptrdiff_t>(path_.size()), target.end(), L'/', L'\\');
    if (!LiteralPath(target)) return ERROR_BAD_PATHNAME;
    PinnedCellLaunchFiles directory_pins;
    directory_pins.handles_.reserve(65);
    HANDLE directory = INVALID_HANDLE_VALUE;
    std::wstring canonical;
    DWORD error = directory_pins.PinPath(target, true, &directory, &canonical);
    if (error) return error;
    CellFileIdentity directory_identity{};
    std::uint64_t bytes = 0;
    error = worker_cell::Identity(directory, true, &directory_identity, &bytes);
    if (error || directory_identity.volume_serial != identity_.volume_serial) return error ? error : ERROR_FILE_INVALID;
    // PinPath's data-access handles deny directory replacement. Enumeration uses
    // that canonical volume path and never opens an entry or follows a reparse point.
    WIN32_FIND_DATAW found{};
    Search search{FindFirstFileExW((canonical + L"\\*").c_str(), FindExInfoBasic, &found, FindExSearchNameMatch, nullptr, 0)};
    if (search.value == INVALID_HANDLE_VALUE) {
      error = Error();
      return error == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : error;
    }
    CellToolDirectoryResult listed;
    std::size_t payload_bytes = 0;
    for (;;) {
      const std::wstring name(found.cFileName);
      if (name != L"." && name != L"..") {
        if (!LiteralComponent(name)) return ERROR_BAD_PATHNAME;
        const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name.data(), static_cast<int>(name.size()), nullptr, 0, nullptr, nullptr);
        if (size <= 0 || size > 1024) return ERROR_NO_UNICODE_TRANSLATION;
        if (listed.entries.size() == kCellToolDirectoryEntries || payload_bytes + 8 + static_cast<std::size_t>(size) > kCellToolDirectoryPayloadBytes) {
          listed.truncated = true;
          break;
        }
        CellToolDirectoryEntry entry;
        entry.name.resize(static_cast<std::size_t>(size));
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name.data(), static_cast<int>(name.size()), entry.name.data(), size, nullptr, nullptr) != size)
          return ERROR_NO_UNICODE_TRANSLATION;
        entry.kind = (found.dwFileAttributes & (kUnsafeAttributes | FILE_ATTRIBUTE_DEVICE)) ? 3u
          : (found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 2u : 1u;
        payload_bytes += 8 + entry.name.size();
        listed.entries.push_back(std::move(entry));
      }
      if (!FindNextFileW(search.value, &found)) {
        error = Error();
        if (error != ERROR_NO_MORE_FILES) return error;
        break;
      }
    }
    *result = std::move(listed);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD HashRuntimeBundleManifest(const std::vector<CellRuntimeBundleFile>& files, CellFileSha256* digest) noexcept {
  if (!digest) return ERROR_INVALID_PARAMETER;
  *digest = {};
  try {
    BundleNodes nodes;
    std::vector<std::uint8_t> bytes;
    const DWORD error = BundleManifest(files, &nodes, &bytes);
    return error ? error : DigestBytes(bytes, digest);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
PinnedCellRuntimeBundle::~PinnedCellRuntimeBundle() { Reset(); }
void PinnedCellRuntimeBundle::Reset() noexcept {
  ready_ = false;
  for (auto handle = handles_.rbegin(); handle != handles_.rend(); ++handle) CloseHandle(*handle);
  handles_.clear(); roots_.Reset(); files_.clear(); file_handles_.clear(); root_input_.clear(); manifest_sha256_ = {};
}
bool PinnedCellRuntimeBundle::ContainsImage(const std::wstring& image, const CellFileSha256& expected_image) const noexcept {
  if (!ready_) return false;
  try {
    for (const auto& file : files_) {
      auto path = file.relative_path;
      std::replace(path.begin(), path.end(), L'/', L'\\');
      if (SamePath(image, root_input_ + L"\\" + path) && file.sha256 == expected_image) return true;
    }
  } catch (...) { return false; }
  return false;
}
DWORD PinnedCellRuntimeBundle::Open(const std::wstring& root, const CellFileIdentity& expected_root,
    const std::vector<CellRuntimeBundleFile>& input, const CellFileSha256& expected_manifest, HANDLE cancellation) noexcept {
  if (ready_ || !handles_.empty() || !root_input_.empty()) return ERROR_ALREADY_INITIALIZED;
  const auto reject = [&](DWORD error) { Reset(); return error; };
  try {
    if (!LiteralPath(root) || root.size() + 513 >= 2048 || input.empty() || input.size() > 4096) return ERROR_INVALID_PARAMETER;
    for (const auto& file : input) if (file.relative_path.empty() || file.relative_path.size() > 512) return ERROR_INVALID_PARAMETER;
    if (cancellation && WaitForSingleObject(cancellation, 0) != WAIT_TIMEOUT) return ERROR_CANCELLED;
    files_ = input;
    BundleNodes expected;
    std::vector<std::uint8_t> preimage;
    DWORD error = BundleManifest(files_, &expected, &preimage);
    CellFileSha256 digest{};
    if (!error) error = DigestBytes(preimage, &digest);
    if (!error && digest != expected_manifest) error = ERROR_CRC;
    if (error) return reject(error);
    HANDLE parent = INVALID_HANDLE_VALUE;
    std::wstring root_path;
    error = roots_.PinPath(root, true, &parent, &root_path);
    CellFileIdentity root_identity{};
    std::uint64_t bytes = 0;
    if (!error) error = Identity(parent, true, &root_identity, &bytes);
    if (!error && root_identity != expected_root) error = ERROR_FILE_INVALID;
    if (error) return reject(error);
    handles_.reserve(expected.size());
    std::vector<std::pair<std::wstring, std::wstring>> directories{{L"", root_path}};
    std::set<std::wstring> found;
    for (std::size_t index = 0; index < directories.size(); ++index) {
      // Copy before appending to the queue: reallocation must not invalidate the parent.
      const auto [relative, directory] = directories[index];
      WIN32_FIND_DATAW data{};
      Search search{FindFirstFileExW((directory + L"\\*").c_str(), FindExInfoBasic, &data, FindExSearchNameMatch, nullptr, 0)};
      if (search.value == INVALID_HANDLE_VALUE) return reject(Error());
      do {
        if (cancellation && WaitForSingleObject(cancellation, 0) != WAIT_TIMEOUT) return reject(ERROR_CANCELLED);
        if (wcscmp(data.cFileName, L".") == 0 || wcscmp(data.cFileName, L"..") == 0) continue;
        const std::wstring name = relative.empty() ? data.cFileName : relative + L"/" + data.cFileName;
        const auto entry = expected.find(name);
        if (entry == expected.end() || !found.insert(name).second || found.size() > expected.size()) return reject(ERROR_INVALID_DATA);
        const bool is_directory = entry->second == nullptr;
        const auto current = directory + L"\\" + data.cFileName;
        Handle opened{CreateFileW(current.c_str(), is_directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL : GENERIC_READ,
          FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (is_directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)};
        if (opened.value == INVALID_HANDLE_VALUE) return reject(Error());
        CellFileIdentity identity{};
        error = Identity(opened.value, is_directory, &identity, &bytes);
        std::wstring actual;
        if (!error) error = FinalPath(opened.value, VOLUME_NAME_GUID, &actual);
        if (!error && (identity.volume_serial != root_identity.volume_serial || !SamePath(actual, current))) error = ERROR_FILE_INVALID;
        if (!error && !is_directory) {
          if (bytes != entry->second->bytes) error = ERROR_FILE_INVALID;
          else {
            CellFileSha256 actual_digest{};
            error = ImageHash(opened.value, bytes, &actual_digest, true, cancellation);
            if (!error && actual_digest != entry->second->sha256) error = ERROR_CRC;
          }
        }
        if (error) return reject(error);
        if (!is_directory) file_handles_.emplace(name, opened.value);
        handles_.push_back(opened.value); opened.value = INVALID_HANDLE_VALUE;
        if (is_directory) directories.emplace_back(name, current);
      } while (FindNextFileW(search.value, &data));
      if (GetLastError() != ERROR_NO_MORE_FILES) return reject(Error());
    }
    if (found.size() != expected.size()) return reject(ERROR_FILE_NOT_FOUND);
    root_input_ = root;
    manifest_sha256_ = expected_manifest;
    ready_ = true;
    return ERROR_SUCCESS;
  } catch (...) { return reject(ERROR_NOT_ENOUGH_MEMORY); }
}
}  // namespace goatcitadel::worker_cell
