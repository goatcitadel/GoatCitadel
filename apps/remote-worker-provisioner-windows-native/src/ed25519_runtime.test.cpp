#include <windows.h>

#if defined(GOATCITADEL_VENDOR_PREFLIGHT)

#include <bcrypt.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <utility>

namespace {

constexpr std::size_t kMaximumPathCharacters = 32768U;
constexpr std::size_t kSha256Bytes = 32U;
constexpr std::size_t kFileCount = 6U;
constexpr std::size_t kDirectoryCount = 3U;
constexpr std::size_t kCopyBufferBytes = 16384U;

constexpr char kPreflightPrefix[] =
    "GCPW_VENDOR_PREFLIGHT schema=goatcitadel.monocypher-preflight.v1 "
    "files=6 identity_sha256=";
constexpr char kPostflightPrefix[] =
    "GCPW_VENDOR_POSTFLIGHT schema=goatcitadel.monocypher-postflight.v1 "
    "files=6 identity_sha256=";

struct ExpectedFile {
  const wchar_t* relative_path;
  std::uint64_t byte_length;
  const char* sha256;
};

constexpr std::array<ExpectedFile, kFileCount> kExpectedFiles = {{
    {L"src\\monocypher.c", 102580U,
     "57eb914fc88136119bd41655cccb8c250048bf54d470540625186f8ab16f64be"},
    {L"src\\monocypher.h", 12175U,
     "c494da712122da7ff679fdcf318a5317e84972b6c950fe9d896212947797facd"},
    {L"src\\optional\\monocypher-ed25519.c", 16524U,
     "60fce3578fb00b00da96490653d993c4cb427b1e1be38183285c66e04d22cc18"},
    {L"src\\optional\\monocypher-ed25519.h", 5449U,
     "abc4fad381879f5c29176ebe014b9189956b3dfe0a3e36459b6990bc57212380"},
    {L"LICENCE.md", 9085U,
     "5f8360e4c06ddcc584bdb4b210c6af824c4bb301e6a9a521869b6d90795ca4b3"},
    {L"GOATCITADEL_SOURCE_RECEIPT.json", 1748U,
     "e07bac847ae9c6b0dc4c7f4b0e7e2370b040f0dbd24e14d528f87f8f101ffeba"},
}};

class Handle final {
 public:
  Handle() noexcept = default;
  explicit Handle(HANDLE value) noexcept : value_(value) {}
  ~Handle() noexcept {
    Reset();
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.Release()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) {
      Reset(other.Release());
    }
    return *this;
  }
  HANDLE Get() const noexcept {
    return value_;
  }
  bool Valid() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE Release() noexcept {
    const HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }
  void Reset(HANDLE value = INVALID_HANDLE_VALUE) noexcept {
    if (Valid()) {
      CloseHandle(value_);
    }
    value_ = value;
  }

 private:
  HANDLE value_ = INVALID_HANDLE_VALUE;
};

class Sha256 final {
 public:
  Sha256() noexcept = default;
  ~Sha256() noexcept {
    if (hash_ != nullptr) {
      BCryptDestroyHash(hash_);
    }
    if (algorithm_ != nullptr) {
      BCryptCloseAlgorithmProvider(algorithm_, 0U);
    }
    SecureZeroMemory(object_.data(), object_.size());
  }
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;

  bool Initialize() noexcept {
    if (algorithm_ != nullptr || hash_ != nullptr) {
      return false;
    }
    if (BCryptOpenAlgorithmProvider(
            &algorithm_,
            BCRYPT_SHA256_ALGORITHM,
            nullptr,
            0U) != 0) {
      return false;
    }
    DWORD object_bytes = 0U;
    DWORD returned = 0U;
    if (BCryptGetProperty(
            algorithm_,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&object_bytes),
            sizeof(object_bytes),
            &returned,
            0U) != 0 ||
        returned != sizeof(object_bytes) || object_bytes == 0U ||
        object_bytes > object_.size()) {
      return false;
    }
    return BCryptCreateHash(
               algorithm_,
               &hash_,
               object_.data(),
               object_bytes,
               nullptr,
               0U,
               0U) == 0;
  }

  bool Update(const void* bytes, std::size_t size) noexcept {
    if (hash_ == nullptr || (bytes == nullptr && size != 0U) ||
        size > static_cast<std::size_t>(UINT32_MAX)) {
      return false;
    }
    if (size == 0U) {
      return true;
    }
    return BCryptHashData(
               hash_,
               reinterpret_cast<PUCHAR>(const_cast<void*>(bytes)),
               static_cast<ULONG>(size),
               0U) == 0;
  }

  bool Finish(std::array<std::uint8_t, kSha256Bytes>* digest) noexcept {
    if (hash_ == nullptr || digest == nullptr) {
      return false;
    }
    const bool success = BCryptFinishHash(
                             hash_,
                             digest->data(),
                             static_cast<ULONG>(digest->size()),
                             0U) == 0;
    BCryptDestroyHash(hash_);
    hash_ = nullptr;
    return success;
  }

 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
  std::array<std::uint8_t, 512U> object_{};
};

struct PathIdentity {
  std::uint64_t volume_serial = 0U;
  std::array<std::uint8_t, 16U> file_id{};
  std::uint64_t byte_length = 0U;
};

struct DirectoryState {
  Handle handle{};
  PathIdentity identity{};
};

struct FileState {
  Handle handle{};
  PathIdentity identity{};
  std::array<std::uint8_t, kSha256Bytes> sha256{};
};

struct ValidatedTree {
  std::array<DirectoryState, kDirectoryCount> directories{};
  std::array<FileState, kFileCount> files{};
  std::array<std::uint8_t, kSha256Bytes> identity_digest{};
};

bool EqualWide(const wchar_t* left, const wchar_t* right) noexcept {
  return left != nullptr && right != nullptr &&
         CompareStringOrdinal(left, -1, right, -1, TRUE) == CSTR_EQUAL;
}

bool EqualBytes(
    const std::uint8_t* left,
    const std::uint8_t* right,
    std::size_t size) noexcept {
  if ((left == nullptr || right == nullptr) && size != 0U) {
    return false;
  }
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

std::uint8_t HexNibble(char value) noexcept {
  if (value >= '0' && value <= '9') {
    return static_cast<std::uint8_t>(value - '0');
  }
  if (value >= 'a' && value <= 'f') {
    return static_cast<std::uint8_t>(value - 'a' + 10);
  }
  return 0xFFU;
}

bool ParseSha256(
    const char* value,
    std::array<std::uint8_t, kSha256Bytes>* digest) noexcept {
  if (value == nullptr || digest == nullptr || value[64] != '\0') {
    return false;
  }
  for (std::size_t index = 0U; index < digest->size(); ++index) {
    const std::uint8_t high = HexNibble(value[index * 2U]);
    const std::uint8_t low = HexNibble(value[index * 2U + 1U]);
    if (high > 0x0FU || low > 0x0FU) {
      return false;
    }
    (*digest)[index] = static_cast<std::uint8_t>((high << 4U) | low);
  }
  return true;
}

char HexDigit(std::uint8_t value) noexcept {
  return value < 10U ? static_cast<char>('0' + value)
                     : static_cast<char>('a' + value - 10U);
}

void DigestHex(
    const std::array<std::uint8_t, kSha256Bytes>& digest,
    std::array<char, 65U>* output) noexcept {
  for (std::size_t index = 0U; index < digest.size(); ++index) {
    (*output)[index * 2U] = HexDigit(digest[index] >> 4U);
    (*output)[index * 2U + 1U] = HexDigit(digest[index] & 0x0FU);
  }
  (*output)[64U] = '\0';
}

bool NormalizePath(
    const wchar_t* input,
    std::array<wchar_t, kMaximumPathCharacters>* output) noexcept {
  if (input == nullptr || output == nullptr || input[0] == L'\0' ||
      (input[0] == L'\\' && input[1] == L'\\')) {
    return false;
  }
  const DWORD length = GetFullPathNameW(
      input,
      static_cast<DWORD>(output->size()),
      output->data(),
      nullptr);
  if (length < 3U || length >= output->size() ||
      (*output)[1] != L':' || (*output)[2] != L'\\') {
    return false;
  }
  std::size_t trimmed = length;
  while (trimmed > 3U && (*output)[trimmed - 1U] == L'\\') {
    (*output)[--trimmed] = L'\0';
  }
  return true;
}

bool JoinPath(
    const wchar_t* root,
    const wchar_t* relative,
    std::array<wchar_t, kMaximumPathCharacters>* output) noexcept {
  if (root == nullptr || relative == nullptr || output == nullptr) {
    return false;
  }
  const int written = swprintf_s(
      output->data(),
      output->size(),
      L"%ls\\%ls",
      root,
      relative);
  return written > 0 && static_cast<std::size_t>(written) < output->size();
}

bool FinalPathMatches(HANDLE handle, const wchar_t* expected) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || expected == nullptr) {
    return false;
  }
  std::array<wchar_t, kMaximumPathCharacters> final_path{};
  const DWORD length = GetFinalPathNameByHandleW(
      handle,
      final_path.data(),
      static_cast<DWORD>(final_path.size()),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0U || length >= final_path.size()) {
    return false;
  }
  const wchar_t* comparable = final_path.data();
  if (length >= 4U && final_path[0] == L'\\' && final_path[1] == L'\\' &&
      final_path[2] == L'?' && final_path[3] == L'\\') {
    comparable += 4U;
  }
  return EqualWide(comparable, expected);
}

bool ValidateStreams(
    const wchar_t* path,
    bool directory,
    std::uint64_t expected_bytes) noexcept {
  WIN32_FIND_STREAM_DATA stream{};
  HANDLE find = FindFirstStreamW(path, FindStreamInfoStandard, &stream, 0U);
  if (find == INVALID_HANDLE_VALUE) {
    return directory && GetLastError() == ERROR_HANDLE_EOF;
  }
  const bool exact_unnamed =
      std::wcscmp(stream.cStreamName, L"::$DATA") == 0 &&
      (directory ||
       static_cast<std::uint64_t>(stream.StreamSize.QuadPart) ==
           expected_bytes);
  WIN32_FIND_STREAM_DATA extra{};
  const BOOL has_extra = FindNextStreamW(find, &extra);
  const DWORD final_error = GetLastError();
  FindClose(find);
  return exact_unnamed && has_extra == FALSE &&
         final_error == ERROR_HANDLE_EOF;
}

bool QueryIdentity(
    HANDLE handle,
    bool directory,
    std::uint64_t expected_bytes,
    PathIdentity* identity) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || identity == nullptr) {
    return false;
  }
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO id{};
  if (GetFileInformationByHandleEx(
          handle, FileAttributeTagInfo, &tag, sizeof(tag)) == FALSE ||
      GetFileInformationByHandleEx(
          handle, FileStandardInfo, &standard, sizeof(standard)) == FALSE ||
      GetFileInformationByHandleEx(
          handle, FileIdInfo, &id, sizeof(id)) == FALSE) {
    return false;
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U ||
      tag.ReparseTag != 0U || standard.Directory != (directory ? TRUE : FALSE) ||
      standard.NumberOfLinks != 1U || standard.DeletePending != FALSE ||
      standard.EndOfFile.QuadPart < 0 ||
      (!directory &&
       static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) !=
           expected_bytes)) {
    return false;
  }
  identity->volume_serial = id.VolumeSerialNumber;
  for (std::size_t index = 0U; index < identity->file_id.size(); ++index) {
    identity->file_id[index] = id.FileId.Identifier[index];
  }
  identity->byte_length =
      static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  return true;
}

bool HashOpenFile(
    HANDLE handle,
    std::array<std::uint8_t, kSha256Bytes>* digest) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || digest == nullptr) {
    return false;
  }
  LARGE_INTEGER zero{};
  if (SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) == FALSE) {
    return false;
  }
  Sha256 hash;
  if (!hash.Initialize()) {
    return false;
  }
  std::array<std::uint8_t, kCopyBufferBytes> buffer{};
  for (;;) {
    DWORD read = 0U;
    if (ReadFile(
            handle,
            buffer.data(),
            static_cast<DWORD>(buffer.size()),
            &read,
            nullptr) == FALSE) {
      SecureZeroMemory(buffer.data(), buffer.size());
      return false;
    }
    if (read == 0U) {
      break;
    }
    if (!hash.Update(buffer.data(), read)) {
      SecureZeroMemory(buffer.data(), buffer.size());
      return false;
    }
  }
  SecureZeroMemory(buffer.data(), buffer.size());
  if (!hash.Finish(digest)) {
    return false;
  }
  return SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) != FALSE;
}

bool UpdateU64(Sha256* hash, std::uint64_t value) noexcept {
  std::array<std::uint8_t, 8U> encoded{};
  for (std::size_t index = 0U; index < encoded.size(); ++index) {
    encoded[index] = static_cast<std::uint8_t>(value >> (index * 8U));
  }
  return hash != nullptr && hash->Update(encoded.data(), encoded.size());
}

bool UpdateIdentity(
    Sha256* hash,
    std::uint8_t kind,
    std::size_t index,
    const PathIdentity& identity,
    const std::array<std::uint8_t, kSha256Bytes>* content_hash) noexcept {
  return hash != nullptr && hash->Update(&kind, sizeof(kind)) &&
         UpdateU64(hash, index) &&
         UpdateU64(hash, identity.volume_serial) &&
         hash->Update(identity.file_id.data(), identity.file_id.size()) &&
         UpdateU64(hash, identity.byte_length) &&
         (content_hash == nullptr ||
          hash->Update(content_hash->data(), content_hash->size()));
}

bool ValidateDirectory(
    const wchar_t* path,
    DirectoryState* state) noexcept {
  if (path == nullptr || state == nullptr) {
    return false;
  }
  Handle handle(CreateFileW(
      path,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!handle.Valid() || !FinalPathMatches(handle.Get(), path) ||
      !QueryIdentity(handle.Get(), true, 0U, &state->identity) ||
      !ValidateStreams(path, true, 0U)) {
    return false;
  }
  state->handle = std::move(handle);
  return true;
}

bool ValidateFile(
    const wchar_t* path,
    const ExpectedFile& expected,
    FileState* state) noexcept {
  if (path == nullptr || state == nullptr) {
    return false;
  }
  Handle handle(CreateFileW(
      path,
      GENERIC_READ | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_SEQUENTIAL_SCAN,
      nullptr));
  if (!handle.Valid() || !FinalPathMatches(handle.Get(), path) ||
      !QueryIdentity(
          handle.Get(), false, expected.byte_length, &state->identity) ||
      !ValidateStreams(path, false, expected.byte_length) ||
      !HashOpenFile(handle.Get(), &state->sha256)) {
    return false;
  }
  std::array<std::uint8_t, kSha256Bytes> expected_sha{};
  if (!ParseSha256(expected.sha256, &expected_sha) ||
      !EqualBytes(
          state->sha256.data(), expected_sha.data(), expected_sha.size())) {
    return false;
  }
  state->handle = std::move(handle);
  return true;
}

bool NameIsOneOf(
    const wchar_t* name,
    const wchar_t* const* expected,
    std::size_t expected_count,
    std::size_t* matched_index) noexcept {
  if (name == nullptr || expected == nullptr || matched_index == nullptr) {
    return false;
  }
  for (std::size_t index = 0U; index < expected_count; ++index) {
    if (std::wcscmp(name, expected[index]) == 0) {
      *matched_index = index;
      return true;
    }
  }
  return false;
}

bool ValidateClosure(
    const wchar_t* directory,
    const wchar_t* const* expected_names,
    const bool* expected_directories,
    std::size_t expected_count) noexcept {
  std::array<wchar_t, kMaximumPathCharacters> wildcard{};
  if (!JoinPath(directory, L"*", &wildcard)) {
    return false;
  }
  WIN32_FIND_DATAW found{};
  HANDLE find = FindFirstFileW(wildcard.data(), &found);
  if (find == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::array<bool, 8U> seen{};
  std::size_t count = 0U;
  bool valid = expected_count <= seen.size();
  do {
    if (std::wcscmp(found.cFileName, L".") == 0 ||
        std::wcscmp(found.cFileName, L"..") == 0) {
      continue;
    }
    std::size_t matched = 0U;
    if (!valid ||
        !NameIsOneOf(
            found.cFileName, expected_names, expected_count, &matched) ||
        seen[matched] ||
        ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) !=
            expected_directories[matched] ||
        (found.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0U) {
      valid = false;
      break;
    }
    seen[matched] = true;
    ++count;
  } while (FindNextFileW(find, &found) != FALSE);
  const DWORD final_error = GetLastError();
  FindClose(find);
  if (!valid || final_error != ERROR_NO_MORE_FILES || count != expected_count) {
    return false;
  }
  for (std::size_t index = 0U; index < expected_count; ++index) {
    if (!seen[index]) {
      return false;
    }
  }
  return true;
}

bool ValidateTree(const wchar_t* root, ValidatedTree* tree) noexcept {
  if (root == nullptr || tree == nullptr) {
    return false;
  }
  constexpr const wchar_t* kRootNames[] = {
      L"src", L"LICENCE.md", L"GOATCITADEL_SOURCE_RECEIPT.json"};
  constexpr bool kRootKinds[] = {true, false, false};
  constexpr const wchar_t* kSrcNames[] = {
      L"optional", L"monocypher.c", L"monocypher.h"};
  constexpr bool kSrcKinds[] = {true, false, false};
  constexpr const wchar_t* kOptionalNames[] = {
      L"monocypher-ed25519.c", L"monocypher-ed25519.h"};
  constexpr bool kOptionalKinds[] = {false, false};

  std::array<wchar_t, kMaximumPathCharacters> src{};
  std::array<wchar_t, kMaximumPathCharacters> optional{};
  if (!JoinPath(root, L"src", &src) ||
      !JoinPath(root, L"src\\optional", &optional) ||
      !ValidateDirectory(root, &tree->directories[0U]) ||
      !ValidateDirectory(src.data(), &tree->directories[1U]) ||
      !ValidateDirectory(optional.data(), &tree->directories[2U]) ||
      !ValidateClosure(root, kRootNames, kRootKinds, 3U) ||
      !ValidateClosure(src.data(), kSrcNames, kSrcKinds, 3U) ||
      !ValidateClosure(optional.data(), kOptionalNames, kOptionalKinds, 2U)) {
    return false;
  }

  for (std::size_t index = 0U; index < kExpectedFiles.size(); ++index) {
    std::array<wchar_t, kMaximumPathCharacters> path{};
    if (!JoinPath(root, kExpectedFiles[index].relative_path, &path) ||
        !ValidateFile(path.data(), kExpectedFiles[index], &tree->files[index])) {
      return false;
    }
  }

  Sha256 identity;
  if (!identity.Initialize()) {
    return false;
  }
  for (std::size_t index = 0U; index < tree->directories.size(); ++index) {
    if (!UpdateIdentity(
            &identity, 0x44U, index, tree->directories[index].identity, nullptr)) {
      return false;
    }
  }
  for (std::size_t index = 0U; index < tree->files.size(); ++index) {
    if (!UpdateIdentity(
            &identity,
            0x46U,
            index,
            tree->files[index].identity,
            &tree->files[index].sha256)) {
      return false;
    }
  }
  return identity.Finish(&tree->identity_digest);
}

bool CreateSnapshotDirectories(const wchar_t* root) noexcept {
  if (CreateDirectoryW(root, nullptr) == FALSE) {
    return false;
  }
  std::array<wchar_t, kMaximumPathCharacters> src{};
  std::array<wchar_t, kMaximumPathCharacters> optional{};
  return JoinPath(root, L"src", &src) &&
         JoinPath(root, L"src\\optional", &optional) &&
         CreateDirectoryW(src.data(), nullptr) != FALSE &&
         CreateDirectoryW(optional.data(), nullptr) != FALSE;
}

bool CopyOpenFile(
    HANDLE source,
    std::uint64_t expected_bytes,
    const wchar_t* destination) noexcept {
  if (source == nullptr || source == INVALID_HANDLE_VALUE ||
      destination == nullptr) {
    return false;
  }
  LARGE_INTEGER zero{};
  if (SetFilePointerEx(source, zero, nullptr, FILE_BEGIN) == FALSE) {
    return false;
  }
  Handle output(CreateFileW(
      destination,
      GENERIC_WRITE | FILE_READ_ATTRIBUTES,
      0U,
      nullptr,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
      nullptr));
  if (!output.Valid()) {
    return false;
  }
  std::array<std::uint8_t, kCopyBufferBytes> buffer{};
  std::uint64_t total = 0U;
  for (;;) {
    DWORD read = 0U;
    if (ReadFile(
            source,
            buffer.data(),
            static_cast<DWORD>(buffer.size()),
            &read,
            nullptr) == FALSE) {
      SecureZeroMemory(buffer.data(), buffer.size());
      return false;
    }
    if (read == 0U) {
      break;
    }
    DWORD offset = 0U;
    while (offset < read) {
      DWORD written = 0U;
      if (WriteFile(
              output.Get(),
              buffer.data() + offset,
              read - offset,
              &written,
              nullptr) == FALSE ||
          written == 0U) {
        SecureZeroMemory(buffer.data(), buffer.size());
        return false;
      }
      offset += written;
    }
    total += read;
    if (total > expected_bytes) {
      SecureZeroMemory(buffer.data(), buffer.size());
      return false;
    }
  }
  SecureZeroMemory(buffer.data(), buffer.size());
  return total == expected_bytes && FlushFileBuffers(output.Get()) != FALSE &&
         SetFilePointerEx(source, zero, nullptr, FILE_BEGIN) != FALSE;
}

bool CopyTree(
    const ValidatedTree& source,
    const wchar_t* snapshot_root) noexcept {
  if (!CreateSnapshotDirectories(snapshot_root)) {
    return false;
  }
  for (std::size_t index = 0U; index < kExpectedFiles.size(); ++index) {
    std::array<wchar_t, kMaximumPathCharacters> destination{};
    if (!JoinPath(
            snapshot_root,
            kExpectedFiles[index].relative_path,
            &destination) ||
        !CopyOpenFile(
            source.files[index].handle.Get(),
            kExpectedFiles[index].byte_length,
            destination.data())) {
      return false;
    }
    PathIdentity after_identity{};
    std::array<std::uint8_t, kSha256Bytes> after_sha256{};
    if (!QueryIdentity(
            source.files[index].handle.Get(),
            false,
            kExpectedFiles[index].byte_length,
            &after_identity) ||
        !HashOpenFile(
            source.files[index].handle.Get(),
            &after_sha256) ||
        after_identity.volume_serial !=
            source.files[index].identity.volume_serial ||
        after_identity.byte_length !=
            source.files[index].identity.byte_length ||
        !EqualBytes(
            after_identity.file_id.data(),
            source.files[index].identity.file_id.data(),
            after_identity.file_id.size()) ||
        !EqualBytes(
            after_sha256.data(),
            source.files[index].sha256.data(),
            after_sha256.size())) {
      return false;
    }
  }
  return true;
}

bool WriteStdHandle(DWORD identifier, const char* bytes, std::size_t size) noexcept {
  if (bytes == nullptr || size > static_cast<std::size_t>(UINT32_MAX)) {
    return false;
  }
  const HANDLE output = GetStdHandle(identifier);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::size_t offset = 0U;
  while (offset < size) {
    DWORD written = 0U;
    if (WriteFile(
            output,
            bytes + offset,
            static_cast<DWORD>(size - offset),
            &written,
            nullptr) == FALSE ||
        written == 0U) {
      return false;
    }
    offset += written;
  }
  return true;
}

bool FormatReceipt(
    const char* prefix,
    const std::array<std::uint8_t, kSha256Bytes>& digest,
    std::array<char, 256U>* receipt,
    std::size_t* receipt_size) noexcept {
  if (prefix == nullptr || receipt == nullptr || receipt_size == nullptr) {
    return false;
  }
  std::array<char, 65U> hex{};
  DigestHex(digest, &hex);
  const int written = sprintf_s(
      receipt->data(), receipt->size(), "%s%s\n", prefix, hex.data());
  if (written <= 0 || static_cast<std::size_t>(written) >= receipt->size()) {
    return false;
  }
  *receipt_size = static_cast<std::size_t>(written);
  return true;
}

bool ReadExactStdin(
    std::array<char, 256U>* input,
    std::size_t* input_size) noexcept {
  if (input == nullptr || input_size == nullptr) {
    return false;
  }
  const HANDLE stream = GetStdHandle(STD_INPUT_HANDLE);
  if (stream == nullptr || stream == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::size_t total = 0U;
  for (;;) {
    if (total == input->size()) {
      return false;
    }
    DWORD read = 0U;
    const BOOL success = ReadFile(
        stream,
        input->data() + total,
        static_cast<DWORD>(input->size() - total),
        &read,
        nullptr);
    if (success == FALSE) {
      if (GetLastError() == ERROR_BROKEN_PIPE) {
        break;
      }
      return false;
    }
    if (read == 0U) {
      break;
    }
    total += read;
  }
  *input_size = total;
  return true;
}

bool ParseBaselineReceipt(
    const std::array<char, 256U>& input,
    std::size_t input_size,
    std::array<std::uint8_t, kSha256Bytes>* digest) noexcept {
  constexpr std::size_t prefix_size = sizeof(kPreflightPrefix) - 1U;
  constexpr std::size_t exact_size = prefix_size + 64U + 1U;
  if (digest == nullptr || input_size != exact_size ||
      input[exact_size - 1U] != '\n' ||
      std::memcmp(input.data(), kPreflightPrefix, prefix_size) != 0) {
    return false;
  }
  std::array<char, 65U> hex{};
  for (std::size_t index = 0U; index < 64U; ++index) {
    hex[index] = input[prefix_size + index];
  }
  return ParseSha256(hex.data(), digest);
}

int Fail() noexcept {
  constexpr char kFailure[] = "GCPW vendor source validation failed\n";
  WriteStdHandle(STD_ERROR_HANDLE, kFailure, sizeof(kFailure) - 1U);
  return 1;
}

}  // namespace

int wmain(int argument_count, wchar_t* arguments[]) {
  if (arguments == nullptr) {
    return 2;
  }
  const bool preflight =
      argument_count == 4 &&
      std::wcscmp(arguments[1], L"--vendor-preflight") == 0;
  const bool postflight =
      argument_count == 3 &&
      std::wcscmp(arguments[1], L"--vendor-postflight") == 0;
  if (!preflight && !postflight) {
    return 2;
  }

  std::array<wchar_t, kMaximumPathCharacters> workspace_root{};
  if (!NormalizePath(arguments[2], &workspace_root)) {
    return Fail();
  }
  ValidatedTree workspace{};
  if (!ValidateTree(workspace_root.data(), &workspace)) {
    return Fail();
  }

  if (preflight) {
    std::array<wchar_t, kMaximumPathCharacters> snapshot_root{};
    if (!NormalizePath(arguments[3], &snapshot_root) ||
        GetFileAttributesW(snapshot_root.data()) != INVALID_FILE_ATTRIBUTES ||
        !CopyTree(workspace, snapshot_root.data())) {
      return Fail();
    }
    ValidatedTree snapshot{};
    if (!ValidateTree(snapshot_root.data(), &snapshot)) {
      return Fail();
    }
    std::array<char, 256U> receipt{};
    std::size_t receipt_size = 0U;
    if (!FormatReceipt(
            kPreflightPrefix,
            workspace.identity_digest,
            &receipt,
            &receipt_size) ||
        !WriteStdHandle(STD_OUTPUT_HANDLE, receipt.data(), receipt_size)) {
      return Fail();
    }
    return 0;
  }

  std::array<char, 256U> baseline_input{};
  std::size_t baseline_size = 0U;
  std::array<std::uint8_t, kSha256Bytes> baseline_digest{};
  if (!ReadExactStdin(&baseline_input, &baseline_size) ||
      !ParseBaselineReceipt(
          baseline_input, baseline_size, &baseline_digest) ||
      !EqualBytes(
          baseline_digest.data(),
          workspace.identity_digest.data(),
          baseline_digest.size())) {
    return Fail();
  }
  std::array<char, 256U> receipt{};
  std::size_t receipt_size = 0U;
  if (!FormatReceipt(
          kPostflightPrefix,
          workspace.identity_digest,
          &receipt,
          &receipt_size) ||
      !WriteStdHandle(STD_OUTPUT_HANDLE, receipt.data(), receipt_size)) {
    return Fail();
  }
  return 0;
}

#else

#include "ed25519_runtime.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace gc = goatcitadel::remote_worker_provisioner;

int RunProtectedArtifactSigningTests() noexcept;

namespace {

int g_failures = 0;
std::array<std::size_t, 15U> g_wipe_counts{};
bool g_wipe_bytes_zero = true;
bool g_wipe_sizes_exact = true;

constexpr std::array<std::uint8_t, 32U> kTest1Seed = {
    0x9dU, 0x61U, 0xb1U, 0x9dU, 0xefU, 0xfdU, 0x5aU, 0x60U,
    0xbaU, 0x84U, 0x4aU, 0xf4U, 0x92U, 0xecU, 0x2cU, 0xc4U,
    0x44U, 0x49U, 0xc5U, 0x69U, 0x7bU, 0x32U, 0x69U, 0x19U,
    0x70U, 0x3bU, 0xacU, 0x03U, 0x1cU, 0xaeU, 0x7fU, 0x60U,
};
constexpr std::array<std::uint8_t, 32U> kTest1Public = {
    0xd7U, 0x5aU, 0x98U, 0x01U, 0x82U, 0xb1U, 0x0aU, 0xb7U,
    0xd5U, 0x4bU, 0xfeU, 0xd3U, 0xc9U, 0x64U, 0x07U, 0x3aU,
    0x0eU, 0xe1U, 0x72U, 0xf3U, 0xdaU, 0xa6U, 0x23U, 0x25U,
    0xafU, 0x02U, 0x1aU, 0x68U, 0xf7U, 0x07U, 0x51U, 0x1aU,
};
constexpr std::array<std::uint8_t, 64U> kTest1Signature = {
    0xe5U, 0x56U, 0x43U, 0x00U, 0xc3U, 0x60U, 0xacU, 0x72U,
    0x90U, 0x86U, 0xe2U, 0xccU, 0x80U, 0x6eU, 0x82U, 0x8aU,
    0x84U, 0x87U, 0x7fU, 0x1eU, 0xb8U, 0xe5U, 0xd9U, 0x74U,
    0xd8U, 0x73U, 0xe0U, 0x65U, 0x22U, 0x49U, 0x01U, 0x55U,
    0x5fU, 0xb8U, 0x82U, 0x15U, 0x90U, 0xa3U, 0x3bU, 0xacU,
    0xc6U, 0x1eU, 0x39U, 0x70U, 0x1cU, 0xf9U, 0xb4U, 0x6bU,
    0xd2U, 0x5bU, 0xf5U, 0xf0U, 0x59U, 0x5bU, 0xbeU, 0x24U,
    0x65U, 0x51U, 0x41U, 0x43U, 0x8eU, 0x7aU, 0x10U, 0x0bU,
};
constexpr std::array<std::uint8_t, 32U> kTest2Seed = {
    0x4cU, 0xcdU, 0x08U, 0x9bU, 0x28U, 0xffU, 0x96U, 0xdaU,
    0x9dU, 0xb6U, 0xc3U, 0x46U, 0xecU, 0x11U, 0x4eU, 0x0fU,
    0x5bU, 0x8aU, 0x31U, 0x9fU, 0x35U, 0xabU, 0xa6U, 0x24U,
    0xdaU, 0x8cU, 0xf6U, 0xedU, 0x4fU, 0xb8U, 0xa6U, 0xfbU,
};
constexpr std::array<std::uint8_t, 32U> kTest2Public = {
    0x3dU, 0x40U, 0x17U, 0xc3U, 0xe8U, 0x43U, 0x89U, 0x5aU,
    0x92U, 0xb7U, 0x0aU, 0xa7U, 0x4dU, 0x1bU, 0x7eU, 0xbcU,
    0x9cU, 0x98U, 0x2cU, 0xcfU, 0x2eU, 0xc4U, 0x96U, 0x8cU,
    0xc0U, 0xcdU, 0x55U, 0xf1U, 0x2aU, 0xf4U, 0x66U, 0x0cU,
};
constexpr std::array<std::uint8_t, 64U> kTest2Signature = {
    0x92U, 0xa0U, 0x09U, 0xa9U, 0xf0U, 0xd4U, 0xcaU, 0xb8U,
    0x72U, 0x0eU, 0x82U, 0x0bU, 0x5fU, 0x64U, 0x25U, 0x40U,
    0xa2U, 0xb2U, 0x7bU, 0x54U, 0x16U, 0x50U, 0x3fU, 0x8fU,
    0xb3U, 0x76U, 0x22U, 0x23U, 0xebU, 0xdbU, 0x69U, 0xdaU,
    0x08U, 0x5aU, 0xc1U, 0xe4U, 0x3eU, 0x15U, 0x99U, 0x6eU,
    0x45U, 0x8fU, 0x36U, 0x13U, 0xd0U, 0xf1U, 0x1dU, 0x8cU,
    0x38U, 0x7bU, 0x2eU, 0xaeU, 0xb4U, 0x30U, 0x2aU, 0xeeU,
    0xb0U, 0x0dU, 0x29U, 0x16U, 0x12U, 0xbbU, 0x0cU, 0x00U,
};
constexpr std::array<std::uint8_t, 16U> kPkcs8Prefix = {
    0x30U, 0x2eU, 0x02U, 0x01U, 0x00U, 0x30U, 0x05U, 0x06U,
    0x03U, 0x2bU, 0x65U, 0x70U, 0x04U, 0x22U, 0x04U, 0x20U,
};
constexpr std::array<std::uint8_t, 12U> kSpkiPrefix = {
    0x30U, 0x2aU, 0x30U, 0x05U, 0x06U, 0x03U,
    0x2bU, 0x65U, 0x70U, 0x03U, 0x21U, 0x00U,
};

void Expect(bool condition, const char* message) noexcept {
  if (!condition) {
    std::fprintf(stderr, "FAIL ed25519_runtime: %s\n", message);
    ++g_failures;
  }
}

template <std::size_t Size>
bool Equal(
    const std::array<std::uint8_t, Size>& left,
    const std::array<std::uint8_t, Size>& right) noexcept {
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < Size; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

bool AllZero(const void* bytes, std::size_t size) noexcept {
  if (bytes == nullptr) {
    return false;
  }
  const auto* current = static_cast<const std::uint8_t*>(bytes);
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < size; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | current[index]);
  }
  return aggregate == 0U;
}

std::size_t ExpectedWipeSize(gc::Ed25519WipeLabelForTest label) noexcept {
  switch (label) {
    case gc::Ed25519WipeLabelForTest::SeedCopy:
    case gc::Ed25519WipeLabelForTest::ParsedSeed:
    case gc::Ed25519WipeLabelForTest::NonceScalar:
    case gc::Ed25519WipeLabelForTest::CanonicalR:
    case gc::Ed25519WipeLabelForTest::ChallengeScalar:
    case gc::Ed25519WipeLabelForTest::FailedPublicKey:
      return 32U;
    case gc::Ed25519WipeLabelForTest::SecretKey:
    case gc::Ed25519WipeLabelForTest::ExpandedScalarPrefix:
    case gc::Ed25519WipeLabelForTest::NonceDigest:
    case gc::Ed25519WipeLabelForTest::ChallengeDigest:
    case gc::Ed25519WipeLabelForTest::PartialSignature:
      return 64U;
    case gc::Ed25519WipeLabelForTest::FailedPkcs8:
      return 48U;
    case gc::Ed25519WipeLabelForTest::FailedSpki:
      return 44U;
    case gc::Ed25519WipeLabelForTest::KnownAnswerArtifacts:
      return 188U;
  }
  return 0U;
}

void ObserveWipe(
    gc::Ed25519WipeLabelForTest label,
    const std::uint8_t* bytes,
    std::size_t size) noexcept {
  const std::size_t index = static_cast<std::size_t>(label);
  if (index >= g_wipe_counts.size()) {
    g_wipe_sizes_exact = false;
    return;
  }
  ++g_wipe_counts[index];
  g_wipe_bytes_zero = g_wipe_bytes_zero && AllZero(bytes, size);
  g_wipe_sizes_exact =
      g_wipe_sizes_exact && size == ExpectedWipeSize(label);
}

void ExpectCanonicalEncodings(
    const gc::Ed25519VectorResultForTest& result,
    const std::array<std::uint8_t, 32U>& seed,
    const std::array<std::uint8_t, 32U>& public_key,
    const char* label) noexcept {
  bool pkcs8 = true;
  bool spki = true;
  for (std::size_t index = 0U; index < kPkcs8Prefix.size(); ++index) {
    pkcs8 = pkcs8 && result.pkcs8[index] == kPkcs8Prefix[index];
  }
  for (std::size_t index = 0U; index < seed.size(); ++index) {
    pkcs8 = pkcs8 && result.pkcs8[kPkcs8Prefix.size() + index] == seed[index];
  }
  for (std::size_t index = 0U; index < kSpkiPrefix.size(); ++index) {
    spki = spki && result.spki[index] == kSpkiPrefix[index];
  }
  for (std::size_t index = 0U; index < public_key.size(); ++index) {
    spki = spki && result.spki[kSpkiPrefix.size() + index] == public_key[index];
  }
  Expect(pkcs8, label);
  Expect(spki, label);
}

void TestPublishedVectors() noexcept {
  gc::Ed25519VectorResultForTest first{};
  Expect(
      gc::RunEd25519VectorForTest(
          kTest1Seed.data(), kTest1Seed.size(), nullptr, 0U, &first),
      "RFC 8032 test 1 executes");
  Expect(Equal(first.public_key, kTest1Public), "RFC 8032 test 1 public key");
  Expect(Equal(first.signature, kTest1Signature), "RFC 8032 test 1 signature");
  ExpectCanonicalEncodings(first, kTest1Seed, kTest1Public, "RFC 8410 test 1 encoding");

  constexpr std::array<std::uint8_t, 1U> kMessage = {0x72U};
  gc::Ed25519VectorResultForTest second{};
  Expect(
      gc::RunEd25519VectorForTest(
          kTest2Seed.data(),
          kTest2Seed.size(),
          kMessage.data(),
          kMessage.size(),
          &second),
      "RFC 8032 test 2 executes");
  Expect(Equal(second.public_key, kTest2Public), "RFC 8032 test 2 public key");
  Expect(Equal(second.signature, kTest2Signature), "RFC 8032 test 2 signature");
  ExpectCanonicalEncodings(second, kTest2Seed, kTest2Public, "RFC 8410 test 2 encoding");

  gc::Ed25519VectorResultForTest repeated{};
  Expect(
      gc::RunEd25519VectorForTest(
          kTest2Seed.data(),
          kTest2Seed.size(),
          kMessage.data(),
          kMessage.size(),
          &repeated) &&
          Equal(second.signature, repeated.signature),
      "pure Ed25519 signing is deterministic");
  Expect(gc::RunKnownAnswerSelfTest(), "production known-answer self-test");
}

void TestCanonicalPkcs8Parser() noexcept {
  std::array<std::uint8_t, 48U> canonical{};
  for (std::size_t index = 0U; index < kPkcs8Prefix.size(); ++index) {
    canonical[index] = kPkcs8Prefix[index];
  }
  for (std::size_t index = 0U; index < kTest1Seed.size(); ++index) {
    canonical[kPkcs8Prefix.size() + index] = kTest1Seed[index];
  }
  std::array<std::uint8_t, 32U> parsed{};
  Expect(
      gc::ParseCanonicalPkcs8ForTest(
          canonical.data(), canonical.size(), &parsed) &&
          Equal(parsed, kTest1Seed),
      "canonical PKCS#8 parses");
  for (std::size_t length = 0U; length < canonical.size(); ++length) {
    parsed.fill(0xA5U);
    Expect(
        !gc::ParseCanonicalPkcs8ForTest(
            canonical.data(), length, &parsed) &&
            AllZero(parsed.data(), parsed.size()),
        "PKCS#8 length mutation rejected and cleared");
  }
  std::array<std::uint8_t, 49U> trailing{};
  std::memcpy(trailing.data(), canonical.data(), canonical.size());
  trailing.back() = 0U;
  Expect(
      !gc::ParseCanonicalPkcs8ForTest(
          trailing.data(), trailing.size(), &parsed),
      "PKCS#8 trailing byte rejected");
  for (std::size_t index = 0U; index < kPkcs8Prefix.size(); ++index) {
    auto mutated = canonical;
    mutated[index] ^= 0x01U;
    Expect(
        !gc::ParseCanonicalPkcs8ForTest(
            mutated.data(), mutated.size(), &parsed),
        "PKCS#8 prefix mutation rejected");
  }
  Expect(
      !gc::ParseCanonicalPkcs8ForTest(nullptr, canonical.size(), &parsed) &&
          !gc::ParseCanonicalPkcs8ForTest(
              canonical.data(), canonical.size(), nullptr),
      "PKCS#8 null boundaries rejected");
}

void TestAdapterBoundaries() noexcept {
  gc::Ed25519VectorResultForTest result{};
  for (std::size_t seed_size = 0U; seed_size <= 64U; ++seed_size) {
    if (seed_size == kTest1Seed.size()) {
      continue;
    }
    result.public_key.fill(0xA5U);
    result.signature.fill(0xA5U);
    result.pkcs8.fill(0xA5U);
    result.spki.fill(0xA5U);
    Expect(
        !gc::RunEd25519VectorForTest(
            kTest1Seed.data(), seed_size, nullptr, 0U, &result) &&
            AllZero(&result, sizeof(result)),
        "non-32-byte seed rejected and outputs cleared");
  }
  Expect(
      !gc::RunEd25519VectorForTest(
          nullptr, kTest1Seed.size(), nullptr, 0U, &result) &&
          !gc::RunEd25519VectorForTest(
              kTest1Seed.data(),
              kTest1Seed.size(),
              nullptr,
              1U,
              &result) &&
          !gc::RunEd25519VectorForTest(
              kTest1Seed.data(),
              kTest1Seed.size(),
              kTest1Seed.data(),
              1025U,
              &result) &&
          !gc::RunEd25519VectorForTest(
              kTest1Seed.data(),
              kTest1Seed.size(),
              nullptr,
              0U,
              nullptr),
      "adapter null and message bounds rejected");

  constexpr std::array<std::uint8_t, 1U> kTamperedMessage = {0x73U};
  Expect(
      gc::RunEd25519VectorForTest(
          kTest2Seed.data(),
          kTest2Seed.size(),
          kTamperedMessage.data(),
          kTamperedMessage.size(),
          &result) &&
          !Equal(result.signature, kTest2Signature),
      "tampered message cannot reproduce the published signature");
}

void TestWipesAndFailureCutpoints() noexcept {
  g_wipe_counts.fill(0U);
  g_wipe_bytes_zero = true;
  g_wipe_sizes_exact = true;
  gc::ResetEd25519TestState();
  gc::SetEd25519WipeObserverForTest(&ObserveWipe);
  gc::Ed25519VectorResultForTest result{};
  Expect(
      gc::RunEd25519VectorForTest(
          kTest1Seed.data(), kTest1Seed.size(), nullptr, 0U, &result),
      "normal wipe-observed signing succeeds");
  Expect(g_wipe_bytes_zero, "all observed adapter wipes contain only zero bytes");
  Expect(g_wipe_sizes_exact, "all observed adapter wipe lengths are exact");
  Expect(
      g_wipe_counts[static_cast<std::size_t>(
          gc::Ed25519WipeLabelForTest::SeedCopy)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::SecretKey)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::ExpandedScalarPrefix)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::NonceDigest)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::ChallengeDigest)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::NonceScalar)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::ChallengeScalar)] >= 1U &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::CanonicalR)] >= 1U,
      "normal signing observes every secret intermediate wipe");
  Expect(
      gc::WasLastSha512ContextWipedForTest(),
      "SHA-512 contexts are zero immediately after finalization");

  constexpr std::array<gc::Ed25519FailurePointForTest, 9U> kCutpoints = {
      gc::Ed25519FailurePointForTest::AfterKeyPair,
      gc::Ed25519FailurePointForTest::AfterPkcs8,
      gc::Ed25519FailurePointForTest::AfterSpki,
      gc::Ed25519FailurePointForTest::AfterScalarExpansion,
      gc::Ed25519FailurePointForTest::AfterNonceReduction,
      gc::Ed25519FailurePointForTest::AfterScalarBase,
      gc::Ed25519FailurePointForTest::AfterChallengeReduction,
      gc::Ed25519FailurePointForTest::AfterMulAdd,
      gc::Ed25519FailurePointForTest::AfterVerification,
  };
  for (const auto cutpoint : kCutpoints) {
    result.public_key.fill(0xA5U);
    result.signature.fill(0xA5U);
    result.pkcs8.fill(0xA5U);
    result.spki.fill(0xA5U);
    gc::SetEd25519FailurePointForTest(cutpoint);
    Expect(
        !gc::RunEd25519VectorForTest(
            kTest1Seed.data(),
            kTest1Seed.size(),
            nullptr,
            0U,
            &result) &&
            AllZero(&result, sizeof(result)),
        "injected failure clears every output");
    Expect(
        !gc::RunKnownAnswerSelfTest(),
        "injected failure fails the production known-answer self-test");
  }
  Expect(g_wipe_bytes_zero, "failure-path wipes contain only zero bytes");
  Expect(g_wipe_sizes_exact, "failure-path wipe lengths remain exact");
  Expect(
      g_wipe_counts[static_cast<std::size_t>(
          gc::Ed25519WipeLabelForTest::PartialSignature)] >=
              kCutpoints.size() &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::FailedPublicKey)] >=
              kCutpoints.size() &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::FailedPkcs8)] >=
              kCutpoints.size() &&
          g_wipe_counts[static_cast<std::size_t>(
              gc::Ed25519WipeLabelForTest::FailedSpki)] >=
              kCutpoints.size(),
      "every injected failure wipes all partial outputs");
  gc::ResetEd25519TestState();
}

bool ParseInteropFrame(
    const std::uint8_t* frame,
    std::size_t frame_size,
    std::array<std::uint8_t, 64U>* signature) noexcept {
  constexpr std::array<std::uint8_t, 8U> kHeader = {
      0x47U, 0x43U, 0x45U, 0x49U, 0x01U, 0x00U, 0x40U, 0x00U};
  if (frame == nullptr || signature == nullptr || frame_size != 72U) {
    return false;
  }
  for (std::size_t index = 0U; index < kHeader.size(); ++index) {
    if (frame[index] != kHeader[index]) {
      return false;
    }
  }
  for (std::size_t index = 0U; index < signature->size(); ++index) {
    (*signature)[index] = frame[kHeader.size() + index];
  }
  return true;
}

bool ReadInteropFrame(std::array<std::uint8_t, 72U>* frame) noexcept {
  if (frame == nullptr) {
    return false;
  }
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    return false;
  }
  std::array<std::uint8_t, 73U> bounded{};
  std::size_t total = 0U;
  for (;;) {
    if (total == bounded.size()) {
      return false;
    }
    DWORD read = 0U;
    const BOOL success = ReadFile(
        input,
        bounded.data() + total,
        static_cast<DWORD>(bounded.size() - total),
        &read,
        nullptr);
    if (success == FALSE) {
      if (GetLastError() == ERROR_BROKEN_PIPE) {
        break;
      }
      return false;
    }
    if (read == 0U) {
      break;
    }
    total += read;
  }
  if (total != frame->size()) {
    return false;
  }
  for (std::size_t index = 0U; index < frame->size(); ++index) {
    (*frame)[index] = bounded[index];
  }
  return true;
}

bool WriteInteropReceipt() noexcept {
  constexpr char kReceipt[] =
      "GCPW_ED25519_INTEROP "
      "public=d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a "
      "signature=e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555"
      "fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b\n";
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) {
    return false;
  }
  DWORD written = 0U;
  return WriteFile(
             output,
             kReceipt,
             static_cast<DWORD>(sizeof(kReceipt) - 1U),
             &written,
             nullptr) != FALSE &&
         written == static_cast<DWORD>(sizeof(kReceipt) - 1U);
}

void TestFixedInterop() noexcept {
  std::array<std::uint8_t, 72U> canonical_frame{};
  constexpr std::array<std::uint8_t, 8U> kHeader = {
      0x47U, 0x43U, 0x45U, 0x49U, 0x01U, 0x00U, 0x40U, 0x00U};
  for (std::size_t index = 0U; index < kHeader.size(); ++index) {
    canonical_frame[index] = kHeader[index];
  }
  for (std::size_t index = 0U; index < kTest1Signature.size(); ++index) {
    canonical_frame[kHeader.size() + index] = kTest1Signature[index];
  }
  std::array<std::uint8_t, 64U> parsed{};
  Expect(
      ParseInteropFrame(canonical_frame.data(), canonical_frame.size(), &parsed) &&
          Equal(parsed, kTest1Signature),
      "canonical interoperability frame parses");
  for (std::size_t length = 0U; length < canonical_frame.size(); ++length) {
    Expect(
        !ParseInteropFrame(canonical_frame.data(), length, &parsed),
        "truncated interoperability frame rejected");
  }
  std::array<std::uint8_t, 73U> trailing{};
  std::memcpy(trailing.data(), canonical_frame.data(), canonical_frame.size());
  Expect(
      !ParseInteropFrame(trailing.data(), trailing.size(), &parsed),
      "trailing interoperability byte rejected");
  for (std::size_t index = 0U; index < kHeader.size(); ++index) {
    auto mutated = canonical_frame;
    mutated[index] ^= 0x01U;
    Expect(
        !ParseInteropFrame(mutated.data(), mutated.size(), &parsed),
        "interoperability header mutation rejected");
  }
  auto mutated_signature = kTest1Signature;
  mutated_signature[0U] ^= 0x01U;
  std::array<std::uint8_t, 32U> public_key{};
  std::array<std::uint8_t, 64U> native_signature{};
  Expect(
      !gc::RunFixedInteropForTest(
          mutated_signature.data(),
          mutated_signature.size(),
          &public_key,
          &native_signature) &&
          !gc::RunFixedInteropForTest(
              kTest1Signature.data(),
              kTest1Signature.size() - 1U,
              &public_key,
              &native_signature),
      "fixed interop rejects alternate signatures and lengths");

  std::array<std::uint8_t, 72U> frame{};
  Expect(ReadInteropFrame(&frame), "fixed interoperability stdin frame");
  if (!ParseInteropFrame(frame.data(), frame.size(), &parsed)) {
    Expect(false, "stdin interoperability frame schema");
    return;
  }
  Expect(
      gc::RunFixedInteropForTest(
          parsed.data(),
          parsed.size(),
          &public_key,
          &native_signature) &&
          Equal(public_key, kTest1Public) &&
          Equal(native_signature, kTest1Signature),
      "Node signature verifies and native signature is canonical");
  if (g_failures == 0) {
    Expect(WriteInteropReceipt(), "interop receipt write");
  }
}

void TestCustodyKeyMaterialDerivation() noexcept {
  std::array<std::uint8_t, 48U> expected_pkcs8{};
  std::array<std::uint8_t, 44U> expected_spki{};
  std::memcpy(expected_pkcs8.data(), kPkcs8Prefix.data(), kPkcs8Prefix.size());
  std::memcpy(
      expected_pkcs8.data() + kPkcs8Prefix.size(),
      kTest1Seed.data(),
      kTest1Seed.size());
  std::memcpy(expected_spki.data(), kSpkiPrefix.data(), kSpkiPrefix.size());
  std::memcpy(
      expected_spki.data() + kSpkiPrefix.size(),
      kTest1Public.data(),
      kTest1Public.size());
  gc::Ed25519DerivedKeyMaterial material{};
  const bool derived = gc::DeriveEd25519KeyMaterial(
      kTest1Seed.data(), kTest1Seed.size(), &material);
  Expect(derived, "custody derivation succeeds");
  Expect(Equal(material.public_key, kTest1Public), "custody public key canonical");
  Expect(Equal(material.pkcs8, expected_pkcs8), "custody PKCS8 canonical");
  Expect(Equal(material.spki, expected_spki), "custody SPKI canonical");

  material.public_key.fill(0xffU);
  std::array<std::uint8_t, 32U> zero_seed{};
  Expect(
      !gc::DeriveEd25519KeyMaterial(
          zero_seed.data(), zero_seed.size(), &material) &&
          AllZero(&material, sizeof(material)),
      "custody derivation rejects an all-zero seed and zeros output");
  material.public_key.fill(0xffU);
  Expect(
      !gc::DeriveEd25519KeyMaterial(
          kTest1Seed.data(), kTest1Seed.size() - 1U, &material) &&
          AllZero(&material, sizeof(material)),
      "custody derivation rejects noncanonical seed length and zeros output");
}

}  // namespace

int RunEd25519RuntimeTests() noexcept {
  const int initial_failures = g_failures;
  gc::ResetEd25519TestState();
  TestPublishedVectors();
  TestCanonicalPkcs8Parser();
  TestAdapterBoundaries();
  TestWipesAndFailureCutpoints();
  TestCustodyKeyMaterialDerivation();
  TestFixedInterop();
  const int protected_artifact_signing_failures =
      RunProtectedArtifactSigningTests();
  gc::ResetEd25519TestState();
  return (g_failures - initial_failures) + protected_artifact_signing_failures;
}

#endif
