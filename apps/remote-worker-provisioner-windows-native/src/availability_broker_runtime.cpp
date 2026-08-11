#include "availability_broker.hpp"

#include <aclapi.h>
#include <bcrypt.h>
#include <winsvc.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

#ifndef GOATCITADEL_EXPECTED_PROVISIONER_SHA256_HEX
#error GOATCITADEL_EXPECTED_PROVISIONER_SHA256_HEX is required.
#endif

#if defined(_M_ARM64)
extern "C" {
int __arm64_safe_unaligned_memory_access = 0;
}
#endif

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr wchar_t kTargetServiceName[] = L"GoatCitadelRemoteWorkerProvisioner";
constexpr wchar_t kTargetExecutableName[] =
    L"GoatCitadelRemoteWorkerProvisioner.exe";
constexpr wchar_t kProgramDataSuffix[] =
    L"\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\";
constexpr wchar_t kSystemRootObjectPath[] = L"\\\\?\\GLOBALROOT\\SystemRoot";
constexpr std::uint64_t kAvailabilityDeadlineMilliseconds = 30U * 1000U;
constexpr std::uint64_t kMaximumProtectedExecutableBytes = 64U * 1024U * 1024U;
constexpr std::size_t kConfigurationBufferBytes = 64U * 1024U;
constexpr std::size_t kTokenBufferBytes = 64U * 1024U;
constexpr std::size_t kHashObjectMaximumBytes = 1024U;
constexpr DWORD kProtectedReadMask = 0x001200A9U;
constexpr DWORD kProtectedFullMask = 0x001F01FFU;

constexpr std::array<std::uint32_t, 1U> kLocalSystemSidParts = {18U};
constexpr std::array<std::uint32_t, 1U> kServiceLogonSidParts = {6U};
constexpr std::array<std::uint32_t, 2U> kAdministratorsSidParts = {32U, 544U};
constexpr std::array<std::uint32_t, 6U> kTargetServiceSidParts = {
    80U,
    UINT32_C(1765223994),
    UINT32_C(2719708455),
    UINT32_C(3112291649),
    UINT32_C(2938929260),
    UINT32_C(976374647),
};
constexpr std::array<std::uint32_t, 6U> kBrokerServiceSidParts = {
    80U,
    UINT32_C(938203738),
    UINT32_C(3606080319),
    UINT32_C(1885328063),
    UINT32_C(149464327),
    UINT32_C(2394007130),
};

struct SidBuffer final {
  std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> bytes{};
  DWORD length = 0U;
};

struct InstalledPaths final {
  AvailabilityFixedPath target_extended{};
  AvailabilityFixedPath target_dos{};
  AvailabilityFixedPath target_quoted{};
  AvailabilityFixedPath broker_extended{};
  AvailabilityFixedPath broker_dos{};
  AvailabilityFixedPath broker_quoted{};
};

struct HeldImage final {
  HANDLE handle = nullptr;
  FILE_ID_INFO identity{};
  std::uint64_t size = 0U;
  AvailabilitySha256 sha256{};
  AvailabilityFixedPath extended_path{};
};

SERVICE_STATUS_HANDLE g_status_handle = nullptr;
SERVICE_STATUS g_status{};
HANDLE g_stop_event = nullptr;

constexpr int HexNibble(char value) noexcept {
  return value >= '0' && value <= '9'
             ? value - '0'
             : (value >= 'a' && value <= 'f'
                    ? value - 'a' + 10
                    : (value >= 'A' && value <= 'F' ? value - 'A' + 10 : -1));
}

template <std::size_t Size>
constexpr AvailabilitySha256 ParseSha256(const char (&hex)[Size]) noexcept {
  AvailabilitySha256 result{};
  if constexpr (Size != 65U) {
    return result;
  }
  for (std::size_t index = 0U; index < result.size(); ++index) {
    const int high = HexNibble(hex[index * 2U]);
    const int low = HexNibble(hex[index * 2U + 1U]);
    if (high < 0 || low < 0) {
      return AvailabilitySha256{};
    }
    result[index] = static_cast<std::uint8_t>((high << 4U) | low);
  }
  return result;
}

constexpr char kExpectedTargetSha256Hex[] =
    GOATCITADEL_EXPECTED_PROVISIONER_SHA256_HEX;
#pragma section(".rdata$gcb", read)
__declspec(allocate(".rdata$gcb")) const AvailabilitySha256
    kExpectedTargetSha256 = ParseSha256(kExpectedTargetSha256Hex);

bool IsAllZero(const std::uint8_t* bytes, std::size_t length) noexcept {
  if (bytes == nullptr) {
    return true;
  }
  std::uint8_t aggregate = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    aggregate = static_cast<std::uint8_t>(aggregate | bytes[index]);
  }
  return aggregate == 0U;
}

bool BytesEqual(
    const std::uint8_t* left,
    const std::uint8_t* right,
    std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) {
    return false;
  }
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    difference = static_cast<std::uint8_t>(
        difference | static_cast<std::uint8_t>(left[index] ^ right[index]));
  }
  return difference == 0U;
}

class ScopedHandle final {
 public:
  ScopedHandle() noexcept = default;
  explicit ScopedHandle(HANDLE handle) noexcept : handle_(handle) {}
  ~ScopedHandle() noexcept { Reset(); }
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  HANDLE get() const noexcept { return handle_; }
  HANDLE Release() noexcept {
    const HANDLE value = handle_;
    handle_ = nullptr;
    return value;
  }
  void Reset(HANDLE handle = nullptr) noexcept {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
    handle_ = handle;
  }

 private:
  HANDLE handle_ = nullptr;
};

class ScopedServiceHandle final {
 public:
  ScopedServiceHandle() noexcept = default;
  explicit ScopedServiceHandle(SC_HANDLE handle) noexcept : handle_(handle) {}
  ~ScopedServiceHandle() noexcept {
    if (handle_ != nullptr) {
      CloseServiceHandle(handle_);
    }
  }
  ScopedServiceHandle(const ScopedServiceHandle&) = delete;
  ScopedServiceHandle& operator=(const ScopedServiceHandle&) = delete;
  SC_HANDLE get() const noexcept { return handle_; }

 private:
  SC_HANDLE handle_ = nullptr;
};

class Sha256Hasher final {
 public:
  ~Sha256Hasher() noexcept {
    if (hash_ != nullptr) {
      BCryptDestroyHash(hash_);
    }
    if (algorithm_ != nullptr) {
      BCryptCloseAlgorithmProvider(algorithm_, 0U);
    }
    SecureZeroMemory(object_.data(), object_.size());
  }

  bool Open() noexcept {
    DWORD object_bytes = 0U;
    DWORD hash_bytes = 0U;
    ULONG returned = 0U;
    return BCryptOpenAlgorithmProvider(
               &algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0U) >= 0 &&
           BCryptGetProperty(
               algorithm_,
               BCRYPT_OBJECT_LENGTH,
               reinterpret_cast<PUCHAR>(&object_bytes),
               sizeof(object_bytes),
               &returned,
               0U) >= 0 &&
           returned == sizeof(object_bytes) && object_bytes != 0U &&
           object_bytes <= object_.size() &&
           BCryptGetProperty(
               algorithm_,
               BCRYPT_HASH_LENGTH,
               reinterpret_cast<PUCHAR>(&hash_bytes),
               sizeof(hash_bytes),
               &returned,
               0U) >= 0 &&
           returned == sizeof(hash_bytes) && hash_bytes == 32U &&
           BCryptCreateHash(
               algorithm_, &hash_, object_.data(), object_bytes, nullptr, 0U, 0U) >= 0;
  }

  bool Update(const std::uint8_t* bytes, std::size_t length) noexcept {
    return hash_ != nullptr && (length == 0U || bytes != nullptr) &&
           length <= std::numeric_limits<ULONG>::max() &&
           BCryptHashData(
               hash_, const_cast<PUCHAR>(bytes), static_cast<ULONG>(length), 0U) >= 0;
  }

  bool Finish(AvailabilitySha256* output) noexcept {
    return hash_ != nullptr && output != nullptr &&
           BCryptFinishHash(
               hash_, output->data(), static_cast<ULONG>(output->size()), 0U) >= 0;
  }

 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
  std::array<std::uint8_t, kHashObjectMaximumBytes> object_{};
};

bool AppendLiteral(
    AvailabilityFixedPath* path,
    const wchar_t* literal) noexcept {
  if (path == nullptr || literal == nullptr ||
      path->length >= path->value.size()) {
    return false;
  }
  for (std::size_t index = 0U; literal[index] != L'\0'; ++index) {
    if (path->length + 1U >= path->value.size()) {
      return false;
    }
    path->value[path->length++] = literal[index];
  }
  path->value[path->length] = L'\0';
  return true;
}

bool CopyPath(
    const AvailabilityFixedPath& source,
    AvailabilityFixedPath* destination) noexcept {
  if (destination == nullptr || source.length >= destination->value.size()) {
    return false;
  }
  *destination = source;
  destination->value[destination->length] = L'\0';
  return true;
}

bool BuildQuotedPath(
    const AvailabilityFixedPath& path,
    AvailabilityFixedPath* quoted) noexcept {
  return quoted != nullptr && AppendLiteral(quoted, L"\"") &&
         AppendLiteral(quoted, path.value.data()) && AppendLiteral(quoted, L"\"");
}

bool BuildInstalledPaths(InstalledPaths* paths) noexcept {
  if (paths == nullptr) {
    return false;
  }
  ScopedHandle system_root(CreateFileW(
      kSystemRootObjectPath,
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr));
  std::array<wchar_t, kAvailabilityMaximumPathCharacters> resolved{};
  const DWORD length =
      system_root.get() == INVALID_HANDLE_VALUE
          ? 0U
          : GetFinalPathNameByHandleW(
                system_root.get(),
                resolved.data(),
                static_cast<DWORD>(resolved.size()),
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length < 7U || length >= resolved.size() || resolved[0U] != L'\\' ||
      resolved[1U] != L'\\' || resolved[2U] != L'?' ||
      resolved[3U] != L'\\' || resolved[5U] != L':' ||
      resolved[6U] != L'\\') {
    return false;
  }
  wchar_t drive = resolved[4U];
  if (drive >= L'a' && drive <= L'z') {
    drive = static_cast<wchar_t>(drive - L'a' + L'A');
  }
  if (drive < L'A' || drive > L'Z') {
    return false;
  }

  AvailabilityFixedPath dos_root{};
  dos_root.value[0U] = drive;
  dos_root.value[1U] = L':';
  dos_root.length = 2U;
  AvailabilityFixedPath extended_root{};
  extended_root.value[0U] = L'\\';
  extended_root.value[1U] = L'\\';
  extended_root.value[2U] = L'?';
  extended_root.value[3U] = L'\\';
  extended_root.value[4U] = drive;
  extended_root.value[5U] = L':';
  extended_root.length = 6U;
  return CopyPath(dos_root, &paths->target_dos) &&
         AppendLiteral(&paths->target_dos, kProgramDataSuffix) &&
         AppendLiteral(&paths->target_dos, kTargetExecutableName) &&
         CopyPath(extended_root, &paths->target_extended) &&
         AppendLiteral(&paths->target_extended, kProgramDataSuffix) &&
         AppendLiteral(&paths->target_extended, kTargetExecutableName) &&
         CopyPath(dos_root, &paths->broker_dos) &&
         AppendLiteral(&paths->broker_dos, kProgramDataSuffix) &&
         AppendLiteral(&paths->broker_dos, kAvailabilityBrokerExecutableName) &&
         CopyPath(extended_root, &paths->broker_extended) &&
         AppendLiteral(&paths->broker_extended, kProgramDataSuffix) &&
         AppendLiteral(
             &paths->broker_extended, kAvailabilityBrokerExecutableName) &&
         BuildQuotedPath(paths->target_dos, &paths->target_quoted) &&
         BuildQuotedPath(paths->broker_dos, &paths->broker_quoted);
}

bool EqualOrdinalPath(const wchar_t* left, const wchar_t* right) noexcept {
  return left != nullptr && right != nullptr &&
         CompareStringOrdinal(left, -1, right, -1, TRUE) == CSTR_EQUAL;
}

bool MakeNtSid(
    const std::uint32_t* parts,
    std::size_t count,
    SidBuffer* output) noexcept {
  if (parts == nullptr || output == nullptr || count == 0U || count > 15U ||
      8U + (count * 4U) > output->bytes.size()) {
    return false;
  }
  output->bytes.fill(0U);
  output->bytes[0U] = SID_REVISION;
  output->bytes[1U] = static_cast<std::uint8_t>(count);
  output->bytes[7U] = 5U;
  for (std::size_t index = 0U; index < count; ++index) {
    const std::size_t offset = 8U + (index * 4U);
    const std::uint32_t value = parts[index];
    output->bytes[offset] = static_cast<std::uint8_t>(value & 0xFFU);
    output->bytes[offset + 1U] =
        static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
    output->bytes[offset + 2U] =
        static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
    output->bytes[offset + 3U] =
        static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
  }
  output->length = static_cast<DWORD>(8U + (count * 4U));
  return IsValidSid(output->bytes.data()) != FALSE &&
         GetLengthSid(output->bytes.data()) == output->length;
}

bool EqualSidBytes(PSID left, PSID right) noexcept {
  return left != nullptr && right != nullptr && IsValidSid(left) != FALSE &&
         IsValidSid(right) != FALSE && EqualSid(left, right) != FALSE;
}

bool ValidateExactProtectedDacl(HANDLE handle) noexcept {
  SidBuffer system{};
  SidBuffer service{};
  SidBuffer administrators{};
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!MakeNtSid(
          kLocalSystemSidParts.data(), kLocalSystemSidParts.size(), &system) ||
      !MakeNtSid(
          kTargetServiceSidParts.data(), kTargetServiceSidParts.size(), &service) ||
      !MakeNtSid(
          kAdministratorsSidParts.data(),
          kAdministratorsSidParts.size(),
          &administrators) ||
      GetSecurityInfo(
          handle,
          SE_FILE_OBJECT,
          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          &owner,
          nullptr,
          &dacl,
          nullptr,
          &descriptor) != ERROR_SUCCESS ||
      descriptor == nullptr || owner == nullptr || dacl == nullptr ||
      IsValidSecurityDescriptor(descriptor) == FALSE ||
      IsValidAcl(dacl) == FALSE) {
    if (descriptor != nullptr) {
      LocalFree(descriptor);
    }
    return false;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
  BOOL present = FALSE;
  BOOL defaulted = TRUE;
  PACL descriptor_dacl = nullptr;
  bool valid =
      GetSecurityDescriptorControl(descriptor, &control, &revision) != FALSE &&
      revision == SECURITY_DESCRIPTOR_REVISION &&
      GetSecurityDescriptorDacl(
          descriptor, &present, &descriptor_dacl, &defaulted) != FALSE &&
      present != FALSE && defaulted == FALSE && descriptor_dacl == dacl &&
      (control & SE_DACL_PROTECTED) != 0U && dacl->AceCount == 3U &&
      EqualSidBytes(owner, system.bytes.data());
  const std::array<PSID, 3U> expected_sids = {
      system.bytes.data(), service.bytes.data(), administrators.bytes.data()};
  const std::array<DWORD, 3U> expected_masks = {
      kProtectedFullMask, kProtectedReadMask, kProtectedReadMask};
  for (DWORD index = 0U; valid && index < 3U; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, index, &raw_ace) == FALSE || raw_ace == nullptr) {
      valid = false;
      break;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID sid = const_cast<DWORD*>(&ace->SidStart);
    valid = header->AceType == ACCESS_ALLOWED_ACE_TYPE &&
            header->AceFlags == 0U &&
            header->AceSize ==
                sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid) &&
            ace->Mask == expected_masks[index] &&
            EqualSidBytes(sid, expected_sids[index]);
  }
  LocalFree(descriptor);
  return valid;
}

bool ValidateOnlyUnnamedDataStream(const wchar_t* path) noexcept {
  WIN32_FIND_STREAM_DATA data{};
  HANDLE find = FindFirstStreamW(path, FindStreamInfoStandard, &data, 0U);
  if (find == INVALID_HANDLE_VALUE) {
    return false;
  }
  const bool first_is_default =
      CompareStringOrdinal(data.cStreamName, -1, L"::$DATA", -1, FALSE) ==
      CSTR_EQUAL;
  WIN32_FIND_STREAM_DATA second{};
  SetLastError(NO_ERROR);
  const BOOL has_second = FindNextStreamW(find, &second);
  const DWORD next_error = GetLastError();
  const BOOL closed = FindClose(find);
  return first_is_default && has_second == FALSE &&
         next_error == ERROR_HANDLE_EOF && closed != FALSE;
}

bool HashHeldFile(
    HANDLE handle,
    std::uint64_t expected_size,
    AvailabilitySha256* digest) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || digest == nullptr ||
      expected_size > kMaximumProtectedExecutableBytes) {
    return false;
  }
  LARGE_INTEGER zero{};
  if (SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN) == FALSE) {
    return false;
  }
  Sha256Hasher hash;
  if (!hash.Open()) {
    return false;
  }
  std::array<std::uint8_t, 64U * 1024U> buffer{};
  std::uint64_t remaining = expected_size;
  while (remaining != 0U) {
    const DWORD requested = remaining > buffer.size()
                                ? static_cast<DWORD>(buffer.size())
                                : static_cast<DWORD>(remaining);
    DWORD received = 0U;
    if (ReadFile(handle, buffer.data(), requested, &received, nullptr) == FALSE ||
        received == 0U || received > requested ||
        !hash.Update(buffer.data(), received)) {
      SecureZeroMemory(buffer.data(), buffer.size());
      return false;
    }
    remaining -= received;
  }
  std::uint8_t trailing = 0U;
  DWORD received = 0U;
  if (ReadFile(handle, &trailing, 1U, &received, nullptr) == FALSE ||
      received != 0U) {
    SecureZeroMemory(buffer.data(), buffer.size());
    return false;
  }
  SecureZeroMemory(buffer.data(), buffer.size());
  return hash.Finish(digest);
}

bool OpenProtectedImage(
    const AvailabilityFixedPath& extended_path,
    const AvailabilitySha256* expected_digest,
    HeldImage* image) noexcept {
  if (extended_path.length == 0U || expected_digest == nullptr || image == nullptr) {
    return false;
  }
  ScopedHandle handle(CreateFileW(
      extended_path.value.data(),
      GENERIC_READ | READ_CONTROL | SYNCHRONIZE,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO identity{};
  std::array<wchar_t, kAvailabilityMaximumPathCharacters> final_path{};
  const DWORD final_length =
      handle.get() == INVALID_HANDLE_VALUE
          ? 0U
          : GetFinalPathNameByHandleW(
                handle.get(),
                final_path.data(),
                static_cast<DWORD>(final_path.size()),
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (handle.get() == INVALID_HANDLE_VALUE ||
      GetFileInformationByHandleEx(
          handle.get(),
          FileAttributeTagInfo,
          &attributes,
          static_cast<DWORD>(sizeof(attributes))) == FALSE ||
      GetFileInformationByHandleEx(
          handle.get(),
          FileStandardInfo,
          &standard,
          static_cast<DWORD>(sizeof(standard))) == FALSE ||
      GetFileInformationByHandleEx(
          handle.get(),
          FileIdInfo,
          &identity,
          static_cast<DWORD>(sizeof(identity))) == FALSE ||
      (attributes.FileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
        FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
        FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
        FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN |
        FILE_ATTRIBUTE_DEVICE)) != 0U ||
      attributes.ReparseTag != 0U || standard.Directory != FALSE ||
      standard.NumberOfLinks != 1U || standard.EndOfFile.QuadPart <= 0 ||
      static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) >
          kMaximumProtectedExecutableBytes ||
      final_length == 0U || final_length >= final_path.size() ||
      !EqualOrdinalPath(final_path.data(), extended_path.value.data()) ||
      !ValidateExactProtectedDacl(handle.get()) ||
      !ValidateOnlyUnnamedDataStream(extended_path.value.data())) {
    return false;
  }
  AvailabilitySha256 digest{};
  if (!HashHeldFile(
          handle.get(),
          static_cast<std::uint64_t>(standard.EndOfFile.QuadPart),
          &digest) ||
      !BytesEqual(digest.data(), expected_digest->data(), digest.size())) {
    return false;
  }
  image->handle = handle.Release();
  image->identity = identity;
  image->size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  image->sha256 = digest;
  image->extended_path = extended_path;
  return true;
}

void CloseHeldImage(HeldImage* image) noexcept {
  if (image == nullptr) {
    return;
  }
  if (image->handle != nullptr && image->handle != INVALID_HANDLE_VALUE) {
    CloseHandle(image->handle);
  }
  *image = HeldImage{};
}

bool RevalidateHeldImage(const HeldImage& image) noexcept {
  FILE_ID_INFO identity{};
  FILE_STANDARD_INFO standard{};
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  std::array<wchar_t, kAvailabilityMaximumPathCharacters> final_path{};
  const DWORD final_length =
      image.handle == nullptr || image.handle == INVALID_HANDLE_VALUE
          ? 0U
          : GetFinalPathNameByHandleW(
                image.handle,
                final_path.data(),
                static_cast<DWORD>(final_path.size()),
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  return image.handle != nullptr && image.handle != INVALID_HANDLE_VALUE &&
         GetFileInformationByHandleEx(
             image.handle,
             FileIdInfo,
             &identity,
             static_cast<DWORD>(sizeof(identity))) != FALSE &&
         GetFileInformationByHandleEx(
             image.handle,
             FileStandardInfo,
             &standard,
             static_cast<DWORD>(sizeof(standard))) != FALSE &&
         GetFileInformationByHandleEx(
             image.handle,
             FileAttributeTagInfo,
             &attributes,
             static_cast<DWORD>(sizeof(attributes))) != FALSE &&
         identity.VolumeSerialNumber == image.identity.VolumeSerialNumber &&
         BytesEqual(
             identity.FileId.Identifier,
             image.identity.FileId.Identifier,
             sizeof(identity.FileId.Identifier)) &&
         standard.NumberOfLinks == 1U && standard.Directory == FALSE &&
         standard.EndOfFile.QuadPart >= 0 &&
         static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) == image.size &&
         (attributes.FileAttributes &
          (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT |
           FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
           FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
           FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN |
           FILE_ATTRIBUTE_DEVICE)) == 0U &&
         attributes.ReparseTag == 0U && final_length != 0U &&
         final_length < final_path.size() && image.extended_path.length != 0U &&
         EqualOrdinalPath(final_path.data(), image.extended_path.value.data()) &&
         ValidateExactProtectedDacl(image.handle) &&
         ValidateOnlyUnnamedDataStream(image.extended_path.value.data());
}

bool RehashHeldImage(const HeldImage& image) noexcept {
  AvailabilitySha256 digest{};
  return RevalidateHeldImage(image) &&
         HashHeldFile(image.handle, image.size, &digest) &&
         BytesEqual(digest.data(), image.sha256.data(), digest.size());
}

bool PointerRangeInsideBuffer(
    const void* pointer,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    std::size_t required_bytes) noexcept {
  if (pointer == nullptr || buffer == nullptr) {
    return false;
  }
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(buffer);
  const std::uintptr_t end = start + buffer_bytes;
  const std::uintptr_t address = reinterpret_cast<std::uintptr_t>(pointer);
  return end >= start && address >= start && address <= end &&
         required_bytes <= end - address;
}

bool CopyWideStringFromBuffer(
    const wchar_t* source,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    AvailabilityFixedPath* output) noexcept {
  if (source == nullptr || output == nullptr ||
      !PointerRangeInsideBuffer(source, buffer, buffer_bytes, sizeof(wchar_t))) {
    return false;
  }
  const std::uintptr_t end =
      reinterpret_cast<std::uintptr_t>(buffer) + buffer_bytes;
  for (std::size_t index = 0U; index < output->value.size(); ++index) {
    const wchar_t* current = source + index;
    if (reinterpret_cast<std::uintptr_t>(current) > end - sizeof(wchar_t)) {
      return false;
    }
    output->value[index] = *current;
    if (*current == L'\0') {
      output->length = index;
      return true;
    }
  }
  return false;
}

bool IsNullOrEmptyStringInBuffer(
    const wchar_t* source,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes) noexcept {
  return source == nullptr ||
         (PointerRangeInsideBuffer(
              source, buffer, buffer_bytes, sizeof(wchar_t)) &&
          *source == L'\0');
}

bool CopyRequiredPrivilegesFromBuffer(
    const wchar_t* source,
    const std::uint8_t* buffer,
    std::size_t buffer_bytes,
    AvailabilityServiceSnapshot* snapshot) noexcept {
  if (source == nullptr || snapshot == nullptr ||
      !PointerRangeInsideBuffer(
          source, buffer, buffer_bytes, 2U * sizeof(wchar_t))) {
    return false;
  }
  const std::uintptr_t end =
      reinterpret_cast<std::uintptr_t>(buffer) + buffer_bytes;
  bool previous_was_null = false;
  for (std::size_t index = 0U;
       index < snapshot->required_privileges.size();
       ++index) {
    const wchar_t* current = source + index;
    if (reinterpret_cast<std::uintptr_t>(current) > end - sizeof(wchar_t)) {
      return false;
    }
    const wchar_t value = *current;
    snapshot->required_privileges[index] = value;
    if (value == L'\0' && previous_was_null) {
      snapshot->required_privilege_characters = index + 1U;
      return true;
    }
    previous_was_null = value == L'\0';
  }
  return false;
}

bool QueryServiceConfig2IntoBuffer(
    SC_HANDLE service,
    DWORD level,
    std::array<std::uint8_t, kConfigurationBufferBytes>* buffer,
    DWORD minimum,
    DWORD* returned) noexcept {
  if (service == nullptr || buffer == nullptr || returned == nullptr) {
    return false;
  }
  buffer->fill(0U);
  DWORD required = 0U;
  if (QueryServiceConfig2W(
          service,
          level,
          buffer->data(),
          static_cast<DWORD>(buffer->size()),
          &required) == FALSE ||
      required < minimum || required > buffer->size()) {
    return false;
  }
  *returned = required;
  return true;
}

bool CopySidToSnapshot(PSID sid, AvailabilitySid* output) noexcept {
  if (sid == nullptr || output == nullptr || IsValidSid(sid) == FALSE) {
    return false;
  }
  const DWORD length = GetLengthSid(sid);
  if (length == 0U || length > output->bytes.size()) {
    return false;
  }
  output->bytes.fill(0U);
  std::memcpy(output->bytes.data(), sid, length);
  output->length = length;
  return true;
}

bool CollectServiceSnapshot(
    SC_HANDLE service,
    AvailabilityServiceSnapshot* snapshot) noexcept {
  if (service == nullptr || snapshot == nullptr) {
    return false;
  }
  AvailabilityServiceSnapshot collected{};
  SERVICE_STATUS_PROCESS status{};
  DWORD returned = 0U;
  if (QueryServiceStatusEx(
          service,
          SC_STATUS_PROCESS_INFO,
          reinterpret_cast<LPBYTE>(&status),
          sizeof(status),
          &returned) == FALSE ||
      returned != sizeof(status)) {
    return false;
  }
  collected.service_process_id = status.dwProcessId;
  collected.status_service_type = status.dwServiceType;
  collected.current_state = status.dwCurrentState;
  collected.service_flags = status.dwServiceFlags;
  collected.win32_exit_code = status.dwWin32ExitCode;
  collected.service_specific_exit_code = status.dwServiceSpecificExitCode;
  collected.checkpoint = status.dwCheckPoint;
  collected.wait_hint = status.dwWaitHint;

  alignas(16) std::array<std::uint8_t, kConfigurationBufferBytes> buffer{};
  DWORD required = 0U;
  if (QueryServiceConfigW(
          service,
          reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.data()),
          static_cast<DWORD>(buffer.size()),
          &required) == FALSE ||
      required < sizeof(QUERY_SERVICE_CONFIGW) || required > buffer.size()) {
    return false;
  }
  const auto* configuration =
      reinterpret_cast<const QUERY_SERVICE_CONFIGW*>(buffer.data());
  collected.configured_service_type = configuration->dwServiceType;
  collected.configured_start_type = configuration->dwStartType;
  collected.configured_error_control = configuration->dwErrorControl;
  if (!CopyWideStringFromBuffer(
          configuration->lpBinaryPathName,
          buffer.data(),
          required,
          &collected.configured_binary_path) ||
      !CopyWideStringFromBuffer(
          configuration->lpServiceStartName,
          buffer.data(),
          required,
          &collected.configured_account_name)) {
    return false;
  }
  collected.load_order_group_empty = IsNullOrEmptyStringInBuffer(
      configuration->lpLoadOrderGroup, buffer.data(), required);
  collected.dependencies_empty = IsNullOrEmptyStringInBuffer(
      configuration->lpDependencies, buffer.data(), required);

  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_TRIGGER_INFO,
          &buffer,
          sizeof(SERVICE_TRIGGER_INFO),
          &returned)) {
    return false;
  }
  const auto* triggers =
      reinterpret_cast<const SERVICE_TRIGGER_INFO*>(buffer.data());
  collected.triggers_empty = triggers->cTriggers == 0U &&
                             triggers->pTriggers == nullptr &&
                             triggers->pReserved == nullptr;
  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_FAILURE_ACTIONS,
          &buffer,
          sizeof(SERVICE_FAILURE_ACTIONSW),
          &returned)) {
    return false;
  }
  const auto* actions =
      reinterpret_cast<const SERVICE_FAILURE_ACTIONSW*>(buffer.data());
  collected.failure_actions_empty =
      actions->dwResetPeriod == 0U && actions->lpRebootMsg == nullptr &&
      actions->lpCommand == nullptr && actions->cActions == 0U &&
      actions->lpsaActions == nullptr;
  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_FAILURE_ACTIONS_FLAG,
          &buffer,
          sizeof(SERVICE_FAILURE_ACTIONS_FLAG),
          &returned)) {
    return false;
  }
  const auto* action_flag =
      reinterpret_cast<const SERVICE_FAILURE_ACTIONS_FLAG*>(buffer.data());
  collected.failure_actions_on_non_crash_disabled =
      action_flag->fFailureActionsOnNonCrashFailures == FALSE;
  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_DELAYED_AUTO_START_INFO,
          &buffer,
          sizeof(SERVICE_DELAYED_AUTO_START_INFO),
          &returned)) {
    return false;
  }
  const auto* delayed =
      reinterpret_cast<const SERVICE_DELAYED_AUTO_START_INFO*>(buffer.data());
  collected.delayed_auto_start_disabled = delayed->fDelayedAutostart == FALSE;
  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_SERVICE_SID_INFO,
          &buffer,
          sizeof(SERVICE_SID_INFO),
          &returned)) {
    return false;
  }
  collected.configured_service_sid_type =
      reinterpret_cast<const SERVICE_SID_INFO*>(buffer.data())->dwServiceSidType;
  if (!QueryServiceConfig2IntoBuffer(
          service,
          SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO,
          &buffer,
          sizeof(SERVICE_REQUIRED_PRIVILEGES_INFOW),
          &returned)) {
    return false;
  }
  const auto* privileges =
      reinterpret_cast<const SERVICE_REQUIRED_PRIVILEGES_INFOW*>(buffer.data());
  if (!CopyRequiredPrivilegesFromBuffer(
          privileges->pmszRequiredPrivileges,
          buffer.data(),
          returned,
          &collected)) {
    return false;
  }

  buffer.fill(0U);
  required = 0U;
  if (QueryServiceObjectSecurity(
          service,
          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
          reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.data()),
          static_cast<DWORD>(buffer.size()),
          &required) == FALSE ||
      required == 0U || required > buffer.size()) {
    return false;
  }
  auto* descriptor = reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.data());
  PSID owner = nullptr;
  BOOL owner_defaulted = TRUE;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
  PACL dacl = nullptr;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = TRUE;
  if (IsValidSecurityDescriptor(descriptor) == FALSE ||
      GetSecurityDescriptorOwner(descriptor, &owner, &owner_defaulted) == FALSE ||
      owner_defaulted != FALSE ||
      !CopySidToSnapshot(owner, &collected.service_object_owner) ||
      GetSecurityDescriptorControl(descriptor, &control, &revision) == FALSE ||
      GetSecurityDescriptorDacl(
          descriptor,
          &dacl_present,
          &dacl,
          &dacl_defaulted) == FALSE) {
    return false;
  }
  collected.service_dacl_protected = (control & SE_DACL_PROTECTED) != 0U;
  collected.service_dacl_non_inheriting =
      (control & (SE_DACL_AUTO_INHERIT_REQ | SE_DACL_AUTO_INHERITED)) == 0U;
  collected.service_dacl_present = dacl_present != FALSE && dacl != nullptr;
  collected.service_dacl_defaulted = dacl_defaulted != FALSE;
  if (!collected.service_dacl_present || IsValidAcl(dacl) == FALSE ||
      dacl->AceCount > collected.service_aces.size()) {
    return false;
  }
  collected.service_ace_count = dacl->AceCount;
  for (std::size_t index = 0U; index < collected.service_ace_count; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, static_cast<DWORD>(index), &raw_ace) == FALSE ||
        raw_ace == nullptr) {
      return false;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    AvailabilityAce& ace = collected.service_aces[index];
    ace.type = header->AceType;
    ace.flags = header->AceFlags;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
        header->AceSize < sizeof(ACCESS_ALLOWED_ACE)) {
      continue;
    }
    const auto* allowed = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    ace.mask = allowed->Mask;
    if (!CopySidToSnapshot(
            const_cast<DWORD*>(&allowed->SidStart), &ace.sid)) {
      return false;
    }
  }
  *snapshot = collected;
  return true;
}

bool QueryTokenScalar(
    HANDLE token,
    TOKEN_INFORMATION_CLASS level,
    void* output,
    DWORD output_bytes) noexcept {
  DWORD returned = 0U;
  return token != nullptr && output != nullptr &&
         GetTokenInformation(
             token, level, output, output_bytes, &returned) != FALSE &&
         returned == output_bytes;
}

bool IsSidInsideTokenBuffer(
    PSID sid,
    const std::uint8_t* buffer,
    std::size_t length) noexcept {
  if (sid == nullptr || buffer == nullptr || IsValidSid(sid) == FALSE) {
    return false;
  }
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(buffer);
  const std::uintptr_t end = start + length;
  const std::uintptr_t address = reinterpret_cast<std::uintptr_t>(sid);
  return end >= start && address >= start && address <= end &&
         GetLengthSid(sid) <= end - address;
}

bool ValidateServiceProcessToken(
    HANDLE token,
    const std::uint32_t* expected_sid_parts,
    std::size_t expected_sid_count) noexcept {
  TOKEN_TYPE type = TokenImpersonation;
  DWORD session_id = UINT32_MAX;
  DWORD appcontainer = 1U;
  if (token == nullptr || IsTokenRestricted(token) != FALSE ||
      !QueryTokenScalar(token, TokenType, &type, sizeof(type)) ||
      type != TokenPrimary ||
      !QueryTokenScalar(token, TokenSessionId, &session_id, sizeof(session_id)) ||
      session_id != 0U ||
      !QueryTokenScalar(
          token, TokenIsAppContainer, &appcontainer, sizeof(appcontainer)) ||
      appcontainer != 0U) {
    return false;
  }
  alignas(16) std::array<std::uint8_t, kTokenBufferBytes> buffer{};
  DWORD returned = 0U;
  SidBuffer system{};
  SidBuffer expected_service{};
  SidBuffer service_logon{};
  if (!MakeNtSid(
          kLocalSystemSidParts.data(), kLocalSystemSidParts.size(), &system) ||
      !MakeNtSid(expected_sid_parts, expected_sid_count, &expected_service) ||
      !MakeNtSid(
          kServiceLogonSidParts.data(),
          kServiceLogonSidParts.size(),
          &service_logon) ||
      GetTokenInformation(
          token,
          TokenUser,
          buffer.data(),
          static_cast<DWORD>(buffer.size()),
          &returned) == FALSE ||
      returned < sizeof(TOKEN_USER)) {
    return false;
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  if (!IsSidInsideTokenBuffer(user->User.Sid, buffer.data(), returned) ||
      !EqualSidBytes(user->User.Sid, system.bytes.data())) {
    return false;
  }
  buffer.fill(0U);
  if (GetTokenInformation(
          token,
          TokenGroups,
          buffer.data(),
          static_cast<DWORD>(buffer.size()),
          &returned) == FALSE ||
      returned < sizeof(TOKEN_GROUPS)) {
    return false;
  }
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  const std::size_t groups_header = offsetof(TOKEN_GROUPS, Groups);
  if (groups->GroupCount >
      (returned - groups_header) / sizeof(SID_AND_ATTRIBUTES)) {
    return false;
  }
  std::size_t service_count = 0U;
  std::size_t logon_count = 0U;
  for (DWORD index = 0U; index < groups->GroupCount; ++index) {
    const SID_AND_ATTRIBUTES& group = groups->Groups[index];
    if (!IsSidInsideTokenBuffer(group.Sid, buffer.data(), returned)) {
      return false;
    }
    if (EqualSidBytes(group.Sid, expected_service.bytes.data())) {
      ++service_count;
      if ((group.Attributes & (SE_GROUP_ENABLED | SE_GROUP_OWNER)) !=
              (SE_GROUP_ENABLED | SE_GROUP_OWNER) ||
          (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0U) {
        return false;
      }
    }
    if (EqualSidBytes(group.Sid, service_logon.bytes.data()) &&
        (group.Attributes & SE_GROUP_ENABLED) != 0U &&
        (group.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0U) {
      ++logon_count;
    }
  }
  buffer.fill(0U);
  if (GetTokenInformation(
          token,
          TokenPrivileges,
          buffer.data(),
          static_cast<DWORD>(buffer.size()),
          &returned) == FALSE ||
      returned < sizeof(TOKEN_PRIVILEGES)) {
    return false;
  }
  const auto* privileges =
      reinterpret_cast<const TOKEN_PRIVILEGES*>(buffer.data());
  LUID change_notify{};
  return service_count == 1U && logon_count == 1U &&
         privileges->PrivilegeCount == 1U &&
         LookupPrivilegeValueW(
             nullptr, SE_CHANGE_NOTIFY_NAME, &change_notify) != FALSE &&
         privileges->Privileges[0U].Luid.LowPart == change_notify.LowPart &&
         privileges->Privileges[0U].Luid.HighPart == change_notify.HighPart &&
         (privileges->Privileges[0U].Attributes & SE_PRIVILEGE_ENABLED) != 0U &&
         (privileges->Privileges[0U].Attributes & SE_PRIVILEGE_REMOVED) == 0U;
}

bool ValidateServiceProcess(
    std::uint32_t pid,
    const AvailabilityFixedPath& expected_path,
    const std::uint32_t* expected_sid_parts,
    std::size_t expected_sid_count) noexcept {
  if (pid == 0U || expected_path.length == 0U) {
    return false;
  }
  ScopedHandle process(OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  ScopedHandle token;
  HANDLE raw_token = nullptr;
  std::array<wchar_t, kAvailabilityMaximumPathCharacters> before{};
  std::array<wchar_t, kAvailabilityMaximumPathCharacters> after{};
  DWORD before_length = static_cast<DWORD>(before.size());
  DWORD after_length = static_cast<DWORD>(after.size());
  FILETIME creation{};
  FILETIME exit{};
  FILETIME kernel{};
  FILETIME user{};
  if (process.get() == nullptr ||
      WaitForSingleObject(process.get(), 0U) != WAIT_TIMEOUT ||
      QueryFullProcessImageNameW(
          process.get(), 0U, before.data(), &before_length) == FALSE ||
      !EqualOrdinalPath(before.data(), expected_path.value.data()) ||
      GetProcessTimes(
          process.get(), &creation, &exit, &kernel, &user) == FALSE ||
      (creation.dwHighDateTime == 0U && creation.dwLowDateTime == 0U) ||
      OpenProcessToken(process.get(), TOKEN_QUERY, &raw_token) == FALSE) {
    return false;
  }
  token.Reset(raw_token);
  return ValidateServiceProcessToken(
             token.get(), expected_sid_parts, expected_sid_count) &&
         QueryFullProcessImageNameW(
             process.get(), 0U, after.data(), &after_length) != FALSE &&
         before_length == after_length &&
         EqualOrdinalPath(before.data(), after.data()) &&
         EqualOrdinalPath(after.data(), expected_path.value.data()) &&
         WaitForSingleObject(process.get(), 0U) == WAIT_TIMEOUT;
}

bool PublishStatus(
    DWORD state,
    DWORD checkpoint,
    std::uint32_t service_specific_code) noexcept {
  if (g_status_handle == nullptr) {
    return false;
  }
  g_status = SERVICE_STATUS{};
  g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_status.dwCurrentState = state;
  g_status.dwControlsAccepted = 0U;
  g_status.dwCheckPoint = checkpoint;
  g_status.dwWaitHint = state == SERVICE_START_PENDING ? 30000U : 0U;
  if (state == SERVICE_STOPPED && service_specific_code != 0U) {
    g_status.dwWin32ExitCode = ERROR_SERVICE_SPECIFIC_ERROR;
    g_status.dwServiceSpecificExitCode = service_specific_code;
  } else {
    g_status.dwWin32ExitCode = NO_ERROR;
  }
  return SetServiceStatus(g_status_handle, &g_status) != FALSE;
}

DWORD WINAPI ControlHandler(
    DWORD control,
    DWORD,
    void*,
    void*) noexcept {
  if ((control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) &&
      g_stop_event != nullptr) {
    SetEvent(g_stop_event);
    return NO_ERROR;
  }
  return control == SERVICE_CONTROL_INTERROGATE ? NO_ERROR
                                                : ERROR_CALL_NOT_IMPLEMENTED;
}

bool ExactServiceMainArguments(DWORD count, wchar_t** arguments) noexcept {
  return count == 1U && arguments != nullptr && arguments[0U] != nullptr &&
         CompareStringOrdinal(
             arguments[0U],
             -1,
             kAvailabilityBrokerServiceName,
             -1,
             FALSE) == CSTR_EQUAL;
}

bool ProveNoAmbientThreadToken() noexcept {
  HANDLE token = nullptr;
  SetLastError(NO_ERROR);
  if (OpenThreadToken(
          GetCurrentThread(), TOKEN_QUERY, FALSE, &token) != FALSE) {
    CloseHandle(token);
    return false;
  }
  return GetLastError() == ERROR_NO_TOKEN;
}

AvailabilityIdentityValidation ValidateBrokerIdentity(
    DWORD argument_count,
    wchar_t** arguments,
    SC_HANDLE broker,
    const InstalledPaths& paths) noexcept {
  AvailabilityServiceSnapshot snapshot{};
  if (!CollectServiceSnapshot(broker, &snapshot)) {
    return AvailabilityIdentityValidation::ServiceIdentity;
  }
  snapshot.exact_service_main_arguments =
      ExactServiceMainArguments(argument_count, arguments);
  snapshot.current_process_id = GetCurrentProcessId();
  if (!ValidateAvailabilityBrokerSnapshot(snapshot, paths.broker_quoted) ||
      !ProveNoAmbientThreadToken() ||
      !ValidateServiceProcess(
          snapshot.current_process_id,
          paths.broker_dos,
          kBrokerServiceSidParts.data(),
          kBrokerServiceSidParts.size())) {
    return AvailabilityIdentityValidation::ServiceIdentity;
  }
  return AvailabilityIdentityValidation::Valid;
}

AvailabilityIdentityValidation EnsureTargetAvailable(
    SC_HANDLE target,
    const InstalledPaths& paths,
    HeldImage* held_image) noexcept {
  if (target == nullptr || held_image == nullptr ||
      IsAllZero(kExpectedTargetSha256.data(), kExpectedTargetSha256.size()) ||
      !OpenProtectedImage(
          paths.target_extended, &kExpectedTargetSha256, held_image)) {
    return AvailabilityIdentityValidation::TargetIdentity;
  }
  const std::uint64_t start = GetTickCount64();
  const std::uint64_t deadline =
      start > UINT64_MAX - kAvailabilityDeadlineMilliseconds
          ? UINT64_MAX
          : start + kAvailabilityDeadlineMilliseconds;
  bool start_issued = false;
  bool saw_start_pending = false;
  bool initial_stop_pending = false;
  DWORD checkpoint = 2U;

  while (true) {
    AvailabilityServiceSnapshot snapshot{};
    if (!CollectServiceSnapshot(target, &snapshot) ||
        !ValidateAvailabilityTargetSnapshot(snapshot, paths.target_quoted) ||
        !RevalidateHeldImage(*held_image)) {
      return AvailabilityIdentityValidation::TargetIdentity;
    }
    const AvailabilityAction action = ClassifyAvailabilityAction(
        snapshot.current_state,
        snapshot.service_process_id,
        snapshot.service_flags);
    if (action == AvailabilityAction::Ready) {
      if (!RehashHeldImage(*held_image) ||
          !ValidateServiceProcess(
              snapshot.service_process_id,
              paths.target_dos,
              kTargetServiceSidParts.data(),
              kTargetServiceSidParts.size())) {
        return AvailabilityIdentityValidation::TargetIdentity;
      }
      AvailabilityServiceSnapshot final_snapshot{};
      if (!CollectServiceSnapshot(target, &final_snapshot) ||
          !ValidateAvailabilityTargetSnapshot(
              final_snapshot, paths.target_quoted) ||
          final_snapshot.current_state != SERVICE_RUNNING ||
          final_snapshot.service_process_id != snapshot.service_process_id ||
          !RehashHeldImage(*held_image)) {
        return AvailabilityIdentityValidation::TargetIdentity;
      }
      return AvailabilityIdentityValidation::Valid;
    }
    if (action == AvailabilityAction::Reject) {
      return AvailabilityIdentityValidation::TargetIdentity;
    }
    if (action == AvailabilityAction::Start) {
      if (start_issued || saw_start_pending) {
        return AvailabilityIdentityValidation::TargetStart;
      }
      if (!RehashHeldImage(*held_image)) {
        return AvailabilityIdentityValidation::TargetIdentity;
      }
      SetLastError(NO_ERROR);
      const BOOL started = StartServiceW(target, 0U, nullptr);
      const DWORD error = GetLastError();
      if (started == FALSE && error != ERROR_SERVICE_ALREADY_RUNNING) {
        return AvailabilityIdentityValidation::TargetStart;
      }
      start_issued = true;
    } else if (snapshot.current_state == SERVICE_START_PENDING) {
      saw_start_pending = true;
    } else if (snapshot.current_state == SERVICE_STOP_PENDING) {
      if (start_issued || saw_start_pending) {
        return AvailabilityIdentityValidation::TargetStart;
      }
      initial_stop_pending = true;
    } else {
      return AvailabilityIdentityValidation::TargetIdentity;
    }

    const std::uint64_t now = GetTickCount64();
    const DWORD wait_ms = AvailabilityWaitMilliseconds(now, deadline);
    if (wait_ms == 0U) {
      return AvailabilityIdentityValidation::Deadline;
    }
    if (!PublishStatus(SERVICE_START_PENDING, checkpoint++, 0U)) {
      return AvailabilityIdentityValidation::ServiceIdentity;
    }
    const DWORD wait = WaitForSingleObject(g_stop_event, wait_ms);
    if (wait == WAIT_OBJECT_0) {
      return AvailabilityIdentityValidation::LaunchContext;
    }
    if (wait != WAIT_TIMEOUT) {
      return AvailabilityIdentityValidation::ServiceIdentity;
    }
    if (initial_stop_pending && start_issued) {
      initial_stop_pending = false;
    }
  }
}

void WINAPI BrokerServiceMain(DWORD argument_count, wchar_t** arguments) noexcept {
  g_status_handle = RegisterServiceCtrlHandlerExW(
      kAvailabilityBrokerServiceName, &ControlHandler, nullptr);
  if (g_status_handle == nullptr ||
      !PublishStatus(SERVICE_START_PENDING, 1U, 0U)) {
    return;
  }
  ScopedHandle stop_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  g_stop_event = stop_event.get();
  InstalledPaths paths{};
  AvailabilityIdentityValidation result = AvailabilityIdentityValidation::ServiceIdentity;
  HeldImage target_image{};
  const ScopedServiceHandle manager(
      OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT));
  const ScopedServiceHandle broker(
      manager.get() == nullptr
          ? nullptr
          : OpenServiceW(
                manager.get(),
                kAvailabilityBrokerServiceName,
                SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL));
  const ScopedServiceHandle target(
      manager.get() == nullptr
          ? nullptr
          : OpenServiceW(
                manager.get(),
                kTargetServiceName,
                SERVICE_START | SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS |
                    READ_CONTROL | SYNCHRONIZE));
  if (stop_event.get() != nullptr && manager.get() != nullptr &&
      broker.get() != nullptr && target.get() != nullptr &&
      BuildInstalledPaths(&paths)) {
    result = ValidateBrokerIdentity(
        argument_count, arguments, broker.get(), paths);
    if (result == AvailabilityIdentityValidation::Valid) {
      result = EnsureTargetAvailable(target.get(), paths, &target_image);
    }
  }
  CloseHeldImage(&target_image);
  g_stop_event = nullptr;
  if (result == AvailabilityIdentityValidation::Valid) {
    if (PublishStatus(SERVICE_RUNNING, 0U, 0U)) {
      PublishStatus(SERVICE_STOPPED, 0U, 0U);
    }
  } else {
    PublishStatus(
        SERVICE_STOPPED, 0U, static_cast<std::uint32_t>(result));
  }
}

}  // namespace

int RunAvailabilityBrokerDispatcher() noexcept {
  SERVICE_TABLE_ENTRYW table[] = {
      {const_cast<wchar_t*>(kAvailabilityBrokerServiceName), &BrokerServiceMain},
      {nullptr, nullptr},
  };
  return StartServiceCtrlDispatcherW(table) != FALSE ? 0 : 5;
}

}  // namespace goatcitadel::remote_worker_provisioner
