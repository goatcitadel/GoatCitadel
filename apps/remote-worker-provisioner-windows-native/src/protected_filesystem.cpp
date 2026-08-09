#include "protected_filesystem.hpp"

#include <aclapi.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace goatcitadel::remote_worker_provisioner {
namespace {

constexpr wchar_t kProgramData[] = L"ProgramData";
constexpr wchar_t kGoatCitadel[] = L"GoatCitadel";
constexpr wchar_t kProvisioner[] = L"RemoteWorkerProvisioner";
constexpr wchar_t kState[] = L"state-v1";
constexpr wchar_t kJournal[] = L"journal";
constexpr wchar_t kKeysets[] = L"keysets";
constexpr wchar_t kControls[] = L"controls";
constexpr wchar_t kQuarantine[] = L"quarantine";
constexpr std::array<std::uint8_t, 12U> kSystemSid = {
    0x01U, 0x01U, 0x00U, 0x00U, 0x00U, 0x00U,
    0x00U, 0x05U, 0x12U, 0x00U, 0x00U, 0x00U};
constexpr std::array<std::uint8_t, 32U> kServiceSid = {
    0x01U, 0x06U, 0x00U, 0x00U, 0x00U, 0x00U, 0x00U, 0x05U,
    0x50U, 0x00U, 0x00U, 0x00U, 0x3aU, 0x2eU, 0x37U, 0x69U,
    0x27U, 0x75U, 0x1bU, 0xa2U, 0x41U, 0xcdU, 0x81U, 0xb9U,
    0x6cU, 0x80U, 0x2cU, 0xafU, 0x77U, 0x4bU, 0x32U, 0x3aU};
alignas(64) std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>
    g_fixed_root_entries{};
#if defined(GOATCITADEL_PROVISIONER_TESTING)
std::array<std::uint32_t, 8U> g_test_call_counts{};
ProtectedFilesystemTestCutpoint g_test_failure_cutpoint =
    ProtectedFilesystemTestCutpoint::CreateDirectory;
std::uint32_t g_test_fail_on_call = 0U;
bool g_test_isolated_root_active = false;
ProtectedPath g_test_isolated_root{};
std::array<std::uint8_t, 512U> g_test_file_security_descriptor{};
std::uint32_t g_test_file_security_descriptor_length = 0U;
std::array<std::uint8_t, 512U> g_test_dynamic_directory_security_descriptor{};
std::uint32_t g_test_dynamic_directory_security_descriptor_length = 0U;
#endif

bool Append(ProtectedPath* path, const wchar_t* component) noexcept {
  if (path == nullptr || component == nullptr || path->length == 0U ||
      path->length >= path->value.size()) {
    return false;
  }
  if (path->value[path->length - 1U] != L'\\') {
    if (path->length + 1U >= path->value.size()) return false;
    path->value[path->length++] = L'\\';
  }
  for (std::size_t index = 0U; component[index] != L'\0'; ++index) {
    if (path->length + 1U >= path->value.size()) return false;
    path->value[path->length++] = component[index];
  }
  path->value[path->length] = L'\0';
  return true;
}

bool CopyRoot(
    const wchar_t* root,
    std::size_t root_length,
    ProtectedPath* output) noexcept {
  if (root == nullptr || output == nullptr || root_length < 7U ||
      root_length + 1U >= output->value.size() || root[root_length] != L'\0') {
    return false;
  }
  *output = ProtectedPath{};
  for (std::size_t index = 0U; index < root_length; ++index) {
    output->value[index] = root[index];
  }
  output->length = root_length;
  output->value[root_length] = L'\0';
  return true;
}

bool EqualBytes(
    const void* left,
    const void* right,
    std::size_t length) noexcept {
  if (left == nullptr || right == nullptr) return false;
  const auto* a = static_cast<const std::uint8_t*>(left);
  const auto* b = static_cast<const std::uint8_t*>(right);
  std::uint8_t difference = 0U;
  for (std::size_t index = 0U; index < length; ++index) {
    difference = static_cast<std::uint8_t>(difference | (a[index] ^ b[index]));
  }
  return difference == 0U;
}

bool ExactAcl(HANDLE handle, ProtectedFilesystemState* state) noexcept {
  PSID owner = nullptr;
  PSID group = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD status = GetSecurityInfo(
      handle,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
          DACL_SECURITY_INFORMATION,
      &owner,
      &group,
      &dacl,
      nullptr,
      &descriptor);
  if (status != ERROR_SUCCESS || descriptor == nullptr || owner == nullptr ||
      group == nullptr || dacl == nullptr) {
    if (descriptor != nullptr) LocalFree(descriptor);
    return false;
  }
  BOOL owner_defaulted = TRUE;
  BOOL group_defaulted = TRUE;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = TRUE;
  PSID queried_owner = nullptr;
  PSID queried_group = nullptr;
  PACL queried_dacl = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control = 0U;
  DWORD revision = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (g_test_isolated_root_active) {
    bool valid = GetSecurityDescriptorOwner(
                     descriptor, &queried_owner, &owner_defaulted) != FALSE &&
        GetSecurityDescriptorGroup(
            descriptor, &queried_group, &group_defaulted) != FALSE &&
        GetSecurityDescriptorDacl(
            descriptor, &dacl_present, &queried_dacl, &dacl_defaulted) != FALSE &&
        GetSecurityDescriptorControl(descriptor, &control, &revision) != FALSE &&
        queried_owner != nullptr && queried_group != nullptr &&
        dacl_present != FALSE && queried_dacl != nullptr &&
        IsValidSid(queried_owner) != FALSE &&
        IsValidSid(queried_group) != FALSE &&
        IsValidAcl(queried_dacl) != FALSE;
    if (valid && state != nullptr && state->security_descriptor_length == 0U) {
      const DWORD descriptor_length = GetSecurityDescriptorLength(descriptor);
      valid = descriptor_length != 0U &&
          descriptor_length <= state->security_descriptor.size();
      if (valid) {
        state->security_descriptor.fill(0U);
        std::memcpy(
            state->security_descriptor.data(), descriptor, descriptor_length);
        state->security_descriptor_length = descriptor_length;
        state->security_projection.fill(0U);
        state->security_projection[0] = 0xfeU;
        state->security_projection[1] = 1U;
        state->security_projection[2] =
            static_cast<std::uint8_t>(descriptor_length & 0xffU);
        state->security_projection[3] =
            static_cast<std::uint8_t>((descriptor_length >> 8U) & 0xffU);
        for (DWORD index = 0U; index < descriptor_length; ++index) {
          state->security_projection[4U + index % 92U] =
              static_cast<std::uint8_t>(
                  state->security_projection[4U + index % 92U] ^
                  state->security_descriptor[index]);
        }
      }
    } else if (valid && state != nullptr) {
      FILE_ATTRIBUTE_TAG_INFO attributes{};
      valid = GetFileInformationByHandleEx(
                  handle,
                  FileAttributeTagInfo,
                  &attributes,
                  sizeof(attributes)) != FALSE;
      const bool directory = valid &&
          (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U;
      const bool capture_file = valid && !directory &&
          g_test_file_security_descriptor_length == 0U;
      const bool capture_dynamic_directory = valid && directory &&
          state->ready &&
          g_test_dynamic_directory_security_descriptor_length == 0U;
      if (capture_file || capture_dynamic_directory) {
        const DWORD descriptor_length =
            GetSecurityDescriptorLength(descriptor);
        auto& captured_descriptor = capture_file
            ? g_test_file_security_descriptor
            : g_test_dynamic_directory_security_descriptor;
        valid = descriptor_length != 0U &&
            descriptor_length <= captured_descriptor.size();
        if (valid) {
          captured_descriptor.fill(0U);
          std::memcpy(
              captured_descriptor.data(),
              descriptor,
              descriptor_length);
          if (capture_file) {
            g_test_file_security_descriptor_length = descriptor_length;
          } else {
            g_test_dynamic_directory_security_descriptor_length =
                descriptor_length;
          }
        }
        LocalFree(descriptor);
        return valid;
      }
      auto* expected_descriptor = reinterpret_cast<PSECURITY_DESCRIPTOR>(
          directory && state->ready
              ? g_test_dynamic_directory_security_descriptor.data()
              : directory
              ? state->security_descriptor.data()
              : g_test_file_security_descriptor.data());
      PSID expected_owner = nullptr;
      PSID expected_group = nullptr;
      PACL expected_dacl = nullptr;
      BOOL expected_owner_defaulted = TRUE;
      BOOL expected_group_defaulted = TRUE;
      BOOL expected_dacl_present = FALSE;
      BOOL expected_dacl_defaulted = TRUE;
      SECURITY_DESCRIPTOR_CONTROL expected_control = 0U;
      DWORD expected_revision = 0U;
      valid = IsValidSecurityDescriptor(expected_descriptor) != FALSE &&
          GetSecurityDescriptorOwner(
              expected_descriptor,
              &expected_owner,
              &expected_owner_defaulted) != FALSE &&
          GetSecurityDescriptorGroup(
              expected_descriptor,
              &expected_group,
              &expected_group_defaulted) != FALSE &&
          GetSecurityDescriptorDacl(
              expected_descriptor,
              &expected_dacl_present,
              &expected_dacl,
              &expected_dacl_defaulted) != FALSE &&
          GetSecurityDescriptorControl(
              expected_descriptor,
              &expected_control,
              &expected_revision) != FALSE &&
          expected_owner != nullptr && expected_group != nullptr &&
          expected_dacl_present != FALSE && expected_dacl != nullptr &&
          owner_defaulted == expected_owner_defaulted &&
          group_defaulted == expected_group_defaulted &&
          dacl_defaulted == expected_dacl_defaulted &&
          control == expected_control && revision == expected_revision &&
          GetLengthSid(queried_owner) == GetLengthSid(expected_owner) &&
          GetLengthSid(queried_group) == GetLengthSid(expected_group) &&
          EqualBytes(
              queried_owner,
              expected_owner,
              GetLengthSid(expected_owner)) &&
          EqualBytes(
              queried_group,
              expected_group,
              GetLengthSid(expected_group)) &&
          queried_dacl->AclSize == expected_dacl->AclSize &&
          EqualBytes(
              queried_dacl, expected_dacl, expected_dacl->AclSize);
    }
    LocalFree(descriptor);
    return valid;
  }
#endif
  bool valid = GetSecurityDescriptorOwner(
                   descriptor, &queried_owner, &owner_defaulted) != FALSE &&
               GetSecurityDescriptorGroup(
                   descriptor, &queried_group, &group_defaulted) != FALSE &&
               GetSecurityDescriptorDacl(
                   descriptor, &dacl_present, &queried_dacl, &dacl_defaulted) != FALSE &&
               GetSecurityDescriptorControl(descriptor, &control, &revision) != FALSE &&
               owner_defaulted == FALSE && group_defaulted == FALSE &&
               dacl_present != FALSE && dacl_defaulted == FALSE &&
               (control & SE_DACL_PROTECTED) != 0U &&
               (control & (SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ)) == 0U &&
               GetLengthSid(queried_owner) == kSystemSid.size() &&
               GetLengthSid(queried_group) == kSystemSid.size() &&
               EqualBytes(queried_owner, kSystemSid.data(), kSystemSid.size()) &&
               EqualBytes(queried_group, kSystemSid.data(), kSystemSid.size()) &&
               queried_dacl != nullptr && queried_dacl->AceCount == 2U;
  for (DWORD index = 0U; valid && index < 2U; ++index) {
    void* raw_ace = nullptr;
    valid = GetAce(queried_dacl, index, &raw_ace) != FALSE && raw_ace != nullptr;
    if (!valid) break;
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    const PSID sid = const_cast<DWORD*>(&ace->SidStart);
    const std::uint8_t* expected =
        index == 0U ? kSystemSid.data() : kServiceSid.data();
    const std::size_t expected_length =
        index == 0U ? kSystemSid.size() : kServiceSid.size();
    valid = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE &&
            ace->Header.AceFlags == 0U && ace->Mask == 0x001F01FFU &&
            GetLengthSid(sid) == expected_length &&
            EqualBytes(sid, expected, expected_length);
  }
  if (valid && state != nullptr && state->security_descriptor_length == 0U) {
    constexpr std::size_t kAclOffset = 64U;
    valid = queried_dacl->AclSize <=
            state->security_descriptor.size() - kAclOffset;
    if (valid) {
      state->security_descriptor.fill(0U);
      auto* creation_descriptor =
          reinterpret_cast<SECURITY_DESCRIPTOR*>(
              state->security_descriptor.data());
      auto* creation_dacl = reinterpret_cast<ACL*>(
          state->security_descriptor.data() + kAclOffset);
      std::memcpy(creation_dacl, queried_dacl, queried_dacl->AclSize);
      valid = InitializeSecurityDescriptor(
                  creation_descriptor, SECURITY_DESCRIPTOR_REVISION) != FALSE &&
              SetSecurityDescriptorOwner(
                  creation_descriptor,
                  const_cast<std::uint8_t*>(kSystemSid.data()),
                  FALSE) != FALSE &&
              SetSecurityDescriptorGroup(
                  creation_descriptor,
                  const_cast<std::uint8_t*>(kSystemSid.data()),
                  FALSE) != FALSE &&
              SetSecurityDescriptorDacl(
                  creation_descriptor, TRUE, creation_dacl, FALSE) != FALSE &&
              SetSecurityDescriptorControl(
                  creation_descriptor,
                  SE_DACL_PROTECTED,
                  SE_DACL_PROTECTED) != FALSE;
      state->security_descriptor_length = valid ? 1U : 0U;
      auto& projection = state->security_projection;
      projection.fill(0U);
      projection[0] = 1U;
      projection[2] = 3U;
      projection[4] = 12U;
      std::memcpy(projection.data() + 6U, kSystemSid.data(), kSystemSid.size());
      projection[18] = 12U;
      std::memcpy(projection.data() + 20U, kSystemSid.data(), kSystemSid.size());
      projection[32] = 2U;
      projection[38] = 0xffU;
      projection[39] = 0x01U;
      projection[40] = 0x1fU;
      projection[42] = 12U;
      std::memcpy(projection.data() + 44U, kSystemSid.data(), kSystemSid.size());
      projection[58] = 0xffU;
      projection[59] = 0x01U;
      projection[60] = 0x1fU;
      projection[62] = 32U;
      std::memcpy(projection.data() + 64U, kServiceSid.data(), kServiceSid.size());
    }
  }
  LocalFree(descriptor);
  return valid;
}

bool ExactUnnamedDataStream(HANDLE handle, std::uint64_t expected_length) noexcept {
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 2048U> buffer{};
  if (GetFileInformationByHandleEx(
          handle,
          FileStreamInfo,
          buffer.data(),
          static_cast<DWORD>(buffer.size())) == FALSE) return false;
  const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(buffer.data());
  constexpr wchar_t kUnnamed[] = L"::$DATA";
  constexpr std::size_t kUnnamedCharacters = 7U;
  if (stream->NextEntryOffset != 0U ||
      stream->StreamNameLength != kUnnamedCharacters * sizeof(wchar_t) ||
      stream->StreamSize.QuadPart < 0 ||
      static_cast<std::uint64_t>(stream->StreamSize.QuadPart) != expected_length) {
    return false;
  }
  for (std::size_t index = 0U; index < kUnnamedCharacters; ++index) {
    if (stream->StreamName[index] != kUnnamed[index]) return false;
  }
  return true;
}

bool ExactObject(
    HANDLE handle,
    std::uint64_t expected_volume,
    bool directory,
    ProtectedFilesystemState* state,
    ProtectedObjectIdentity* identity) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || identity == nullptr) {
    return false;
  }
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO file_id{};
  wchar_t filesystem[16]{};
  if (GetFileInformationByHandleEx(
          handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) == FALSE ||
      GetFileInformationByHandleEx(
          handle, FileStandardInfo, &standard, sizeof(standard)) == FALSE ||
      GetFileInformationByHandleEx(handle, FileIdInfo, &file_id, sizeof(file_id)) == FALSE ||
      GetVolumeInformationByHandleW(
          handle, nullptr, 0U, nullptr, nullptr, nullptr, filesystem,
          static_cast<DWORD>(std::size(filesystem))) == FALSE ||
      filesystem[0] != L'N' || filesystem[1] != L'T' ||
      filesystem[2] != L'F' || filesystem[3] != L'S' ||
      filesystem[4] != L'\0' ||
      file_id.VolumeSerialNumber != expected_volume || standard.DeletePending != FALSE ||
      standard.NumberOfLinks != 1U ||
      ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U) != directory ||
      (attributes.FileAttributes &
       (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
        FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED |
        FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS |
        FILE_ATTRIBUTE_RECALL_ON_OPEN)) != 0U ||
      !ExactAcl(handle, state)) {
    return false;
  }
  if (!directory &&
      (standard.EndOfFile.QuadPart < 0 ||
       !ExactUnnamedDataStream(
           handle,
           static_cast<std::uint64_t>(standard.EndOfFile.QuadPart)))) return false;
  identity->volume_serial_number = file_id.VolumeSerialNumber;
  std::memcpy(identity->file_id.data(), file_id.FileId.Identifier, 16U);
  return true;
}

bool OpenFixed(
    const ProtectedPath& path,
    std::uint64_t volume,
    ProtectedFilesystemState* state,
    HANDLE* output,
    ProtectedObjectIdentity* identity) noexcept {
  if (output == nullptr) return false;
  *output = nullptr;
  HANDLE handle = CreateFileW(
      path.value.data(),
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE ||
      !ExactObject(handle, volume, true, state, identity)) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return false;
  }
  *output = handle;
  return true;
}

bool RenameNoReplace(HANDLE handle, const ProtectedPath& final_path) noexcept {
  if (handle == nullptr || handle == INVALID_HANDLE_VALUE || final_path.length == 0U) {
    return false;
  }
  alignas(FILE_RENAME_INFO) std::array<std::uint8_t,
      sizeof(FILE_RENAME_INFO) + kProtectedPathCharacters * sizeof(wchar_t)> storage{};
  auto* info = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  info->ReplaceIfExists = FALSE;
  info->RootDirectory = nullptr;
  info->FileNameLength = static_cast<DWORD>(final_path.length * sizeof(wchar_t));
  std::memcpy(info->FileName, final_path.value.data(), info->FileNameLength);
  return SetFileInformationByHandle(
             handle,
             FileRenameInfo,
             info,
             static_cast<DWORD>(offsetof(FILE_RENAME_INFO, FileName) + info->FileNameLength)) != FALSE;
}

bool ProtectedPathIsAbsent(const ProtectedPath& path) noexcept {
  HANDLE object = CreateFileW(
      path.value.data(),
      0U,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (object != INVALID_HANDLE_VALUE) {
    CloseHandle(object);
    return false;
  }
  const DWORD error = GetLastError();
  return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
}

}  // namespace

bool CaptureProtectedObjectIdentity(
    HANDLE object,
    ProtectedObjectIdentity* identity) noexcept {
  if (object == nullptr || object == INVALID_HANDLE_VALUE || identity == nullptr) return false;
  FILE_ID_INFO file_id{};
  if (GetFileInformationByHandleEx(object, FileIdInfo, &file_id, sizeof(file_id)) == FALSE) return false;
  identity->volume_serial_number = file_id.VolumeSerialNumber;
  std::memcpy(identity->file_id.data(), file_id.FileId.Identifier, 16U);
  return true;
}

bool CaptureProtectedObjectIdentity(
    const ProtectedFilesystemState& state,
    HANDLE object,
    ProtectedObjectIdentity* identity) noexcept {
  return ProtectedFilesystemRecoveryCheckpoint(state) &&
         CaptureProtectedObjectIdentity(object, identity) &&
         ProtectedFilesystemRecoveryCheckpoint(state);
}

bool ProtectedDirectoryIsEmpty(HANDLE directory) noexcept {
  if (directory == nullptr || directory == INVALID_HANDLE_VALUE) return false;
  alignas(FILE_ID_BOTH_DIR_INFO) std::array<std::uint8_t, 4096U> storage{};
  SetLastError(NO_ERROR);
  if (GetFileInformationByHandleEx(
          directory,
          FileIdBothDirectoryRestartInfo,
          storage.data(),
          static_cast<DWORD>(storage.size())) != FALSE) {
    return false;
  }
  return GetLastError() == ERROR_NO_MORE_FILES;
}

bool ProtectedDirectoryIsEmptyGuarded(
    const ProtectedFilesystemState& state,
    HANDLE directory) noexcept {
  return ProtectedFilesystemRecoveryCheckpoint(state) &&
         ProtectedDirectoryIsEmpty(directory) &&
         ProtectedFilesystemRecoveryCheckpoint(state);
}

bool EnumerateProtectedDirectoryGuarded(
    const ProtectedFilesystemState* state,
    HANDLE directory,
    std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>* entries,
    std::size_t* count) noexcept {
  if ((state != nullptr && !ProtectedFilesystemRecoveryCheckpoint(*state)) ||
      directory == nullptr || directory == INVALID_HANDLE_VALUE ||
      entries == nullptr || count == nullptr) return false;
  entries->fill(ProtectedDirectoryEntry{});
  *count = 0U;
  bool restart = true;
  for (;;) {
    alignas(FILE_ID_BOTH_DIR_INFO) std::array<std::uint8_t, 4096U> buffer{};
    const FILE_INFO_BY_HANDLE_CLASS information_class = restart
        ? FileIdBothDirectoryRestartInfo
        : FileIdBothDirectoryInfo;
    if ((state != nullptr && !ProtectedFilesystemRecoveryCheckpoint(*state)) ||
        GetFileInformationByHandleEx(
            directory,
            information_class,
            buffer.data(),
            static_cast<DWORD>(buffer.size())) == FALSE) {
      return GetLastError() == ERROR_NO_MORE_FILES;
    }
    if (state != nullptr && !ProtectedFilesystemRecoveryCheckpoint(*state)) {
      return false;
    }
    restart = false;
    std::size_t offset = 0U;
    for (;;) {
      if (offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) > buffer.size()) return false;
      const auto* information =
          reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      if ((information->FileNameLength % sizeof(wchar_t)) != 0U) return false;
      const std::size_t name_length = information->FileNameLength / sizeof(wchar_t);
      if (name_length == 0U || name_length >= kProtectedEntryNameCharacters ||
          offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + information->FileNameLength >
              buffer.size()) return false;
      const bool dot = name_length == 1U && information->FileName[0] == L'.';
      const bool dot_dot = name_length == 2U && information->FileName[0] == L'.' &&
                           information->FileName[1] == L'.';
      if (!dot && !dot_dot) {
        if (*count >= entries->size() || information->EndOfFile.QuadPart < 0) return false;
        auto& entry = (*entries)[(*count)++];
        entry.name_length = name_length;
        for (std::size_t index = 0U; index < name_length; ++index) {
          entry.name[index] = information->FileName[index];
        }
        entry.name[name_length] = L'\0';
        entry.byte_length = static_cast<std::uint64_t>(information->EndOfFile.QuadPart);
        entry.attributes = information->FileAttributes;
      }
      if (information->NextEntryOffset == 0U) break;
      if (information->NextEntryOffset < offsetof(FILE_ID_BOTH_DIR_INFO, FileName) ||
          offset + information->NextEntryOffset >= buffer.size()) return false;
      offset += information->NextEntryOffset;
    }
  }
}

bool EnumerateProtectedDirectory(
    HANDLE directory,
    std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>* entries,
    std::size_t* count) noexcept {
  return EnumerateProtectedDirectoryGuarded(nullptr, directory, entries, count);
}

bool EnumerateProtectedDirectory(
    const ProtectedFilesystemState& state,
    HANDLE directory,
    std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>* entries,
    std::size_t* count) noexcept {
  return EnumerateProtectedDirectoryGuarded(&state, directory, entries, count);
}

bool OpenProtectedExistingDirectory(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    bool rename_capable,
    HANDLE* directory,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      absolute_path.length == 0U || directory == nullptr || identity == nullptr) {
    return false;
  }
  *directory = nullptr;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Reopen)) return false;
#endif
  HANDLE handle = CreateFileW(
      absolute_path.value.data(),
      GENERIC_READ | (rename_capable ? DELETE : 0U),
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT |
          (rename_capable ? FILE_FLAG_WRITE_THROUGH : 0U),
      nullptr);
  auto* mutable_state = const_cast<ProtectedFilesystemState*>(&state);
  if (handle == INVALID_HANDLE_VALUE ||
      !ExactObject(
          handle,
          state.state_root_identity.volume_serial_number,
          true,
          mutable_state,
          identity)) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return false;
  }
  if (!ProtectedFilesystemRecoveryCheckpoint(state)) {
    CloseHandle(handle);
    return false;
  }
  *directory = handle;
  return true;
}

bool ReadProtectedExistingFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint8_t* bytes,
    std::size_t capacity,
    std::size_t* length,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      absolute_path.length == 0U || bytes == nullptr ||
      capacity == 0U || capacity > MAXDWORD || length == nullptr || identity == nullptr) {
    return false;
  }
  *length = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Reopen)) return false;
#endif
  HANDLE file = CreateFileW(
      absolute_path.value.data(),
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  auto* mutable_state = const_cast<ProtectedFilesystemState*>(&state);
  FILE_STANDARD_INFO standard{};
  if (file == INVALID_HANDLE_VALUE ||
      !ExactObject(
          file,
          state.state_root_identity.volume_serial_number,
          false,
          mutable_state,
          identity) ||
      GetFileInformationByHandleEx(
          file, FileStandardInfo, &standard, sizeof(standard)) == FALSE ||
      standard.EndOfFile.QuadPart < 0 ||
      static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) > capacity) {
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return false;
  }
  const DWORD expected = static_cast<DWORD>(standard.EndOfFile.QuadPart);
  DWORD received = 0U;
  const bool read = expected == 0U ||
      (ReadFile(file, bytes, expected, &received, nullptr) != FALSE && received == expected);
  CloseHandle(file);
  if (!read || !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  *length = expected;
  return true;
}

static bool OpenProtectedExistingFileForRenameMode(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint64_t maximum_length,
    DWORD share_mode,
    HANDLE* file,
    std::uint64_t* length,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      absolute_path.length == 0U || file == nullptr || length == nullptr ||
      identity == nullptr) return false;
  *file = nullptr;
  *length = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Reopen)) return false;
#endif
  HANDLE handle = CreateFileW(
      absolute_path.value.data(),
      GENERIC_READ | GENERIC_WRITE | DELETE,
      share_mode,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_WRITE_THROUGH,
      nullptr);
  auto* mutable_state = const_cast<ProtectedFilesystemState*>(&state);
  FILE_STANDARD_INFO standard{};
  if (handle == INVALID_HANDLE_VALUE ||
      !ExactObject(
          handle,
          state.state_root_identity.volume_serial_number,
          false,
          mutable_state,
          identity) ||
      GetFileInformationByHandleEx(
          handle, FileStandardInfo, &standard, sizeof(standard)) == FALSE ||
      standard.EndOfFile.QuadPart < 0 ||
      static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) > maximum_length ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return false;
  }
  *length = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  *file = handle;
  return true;
}

bool OpenProtectedExistingFileForParentRename(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint64_t maximum_length,
    HANDLE* file,
    std::uint64_t* length,
    ProtectedObjectIdentity* identity) noexcept {
  return OpenProtectedExistingFileForRenameMode(
      state,
      absolute_path,
      maximum_length,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      file,
      length,
      identity);
}

bool OpenProtectedExistingFileForRename(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint64_t maximum_length,
    HANDLE* file,
    std::uint64_t* length,
    ProtectedObjectIdentity* identity) noexcept {
  return OpenProtectedExistingFileForRenameMode(
      state,
      absolute_path,
      maximum_length,
      0U,
      file,
      length,
      identity);
}

bool ReadProtectedOpenFile(
    const ProtectedFilesystemState& state,
    HANDLE file,
    std::uint8_t* bytes,
    std::size_t capacity,
    std::size_t* length,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      file == nullptr || file == INVALID_HANDLE_VALUE || bytes == nullptr ||
      capacity == 0U || capacity > MAXDWORD || length == nullptr ||
      identity == nullptr) return false;
  *length = 0U;
  auto* mutable_state = const_cast<ProtectedFilesystemState*>(&state);
  FILE_STANDARD_INFO standard{};
  LARGE_INTEGER zero{};
  if (!ExactObject(
          file,
          state.state_root_identity.volume_serial_number,
          false,
          mutable_state,
          identity) ||
      GetFileInformationByHandleEx(
          file, FileStandardInfo, &standard, sizeof(standard)) == FALSE ||
      standard.EndOfFile.QuadPart < 0 ||
      static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) > capacity ||
      SetFilePointerEx(file, zero, nullptr, FILE_BEGIN) == FALSE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  const DWORD expected = static_cast<DWORD>(standard.EndOfFile.QuadPart);
  DWORD received = 0U;
  if (expected != 0U &&
      (ReadFile(file, bytes, expected, &received, nullptr) == FALSE ||
       received != expected)) return false;
  if (!ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  *length = expected;
  return true;
}

bool FlushProtectedOpenFileForParentRename(
    const ProtectedFilesystemState& state,
    HANDLE file,
    bool after_parent_rename) noexcept {
  if (!state.ready || file == nullptr || file == INVALID_HANDLE_VALUE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          after_parent_rename
              ? ProtectedFilesystemTestCutpoint::SecondFlush
              : ProtectedFilesystemTestCutpoint::FirstFlush)) return false;
#else
  (void)after_parent_rename;
#endif
  return ProtectedFilesystemRecoveryCheckpoint(state) &&
         FlushFileBuffers(file) != FALSE &&
         ProtectedFilesystemRecoveryCheckpoint(state);
}

bool ProtectedPathIsAbsentGuarded(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path) noexcept {
  return state.ready && ProtectedFilesystemRecoveryCheckpoint(state) &&
         absolute_path.length != 0U && ProtectedPathIsAbsent(absolute_path) &&
         ProtectedFilesystemRecoveryCheckpoint(state);
}

bool ReadProtectedFinalFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint8_t* bytes,
    std::size_t capacity,
    std::size_t* length,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      absolute_path.length == 0U || bytes == nullptr ||
      capacity == 0U || capacity > MAXDWORD || length == nullptr ||
      identity == nullptr) {
    return false;
  }
  *length = 0U;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Reopen)) return false;
#endif
  HANDLE file = CreateFileW(
      absolute_path.value.data(),
      GENERIC_READ,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  auto* mutable_state = const_cast<ProtectedFilesystemState*>(&state);
  FILE_STANDARD_INFO standard{};
  if (file == INVALID_HANDLE_VALUE ||
      !ExactObject(
          file,
          state.state_root_identity.volume_serial_number,
          false,
          mutable_state,
          identity) ||
      GetFileInformationByHandleEx(
          file, FileStandardInfo, &standard, sizeof(standard)) == FALSE ||
      standard.EndOfFile.QuadPart < 0 ||
      static_cast<std::uint64_t>(standard.EndOfFile.QuadPart) > capacity) {
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return false;
  }
  const DWORD expected = static_cast<DWORD>(standard.EndOfFile.QuadPart);
  DWORD received = 0U;
  const bool read = expected == 0U ||
      (ReadFile(file, bytes, expected, &received, nullptr) != FALSE &&
       received == expected);
  CloseHandle(file);
  if (!read || !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  *length = expected;
  return true;
}

bool PromoteProtectedExistingFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& pending_path,
    const ProtectedPath& final_path,
    bool retained_across_parent_rename,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      pending_path.length == 0U || final_path.length == 0U ||
      identity == nullptr) return false;
  const DWORD share = retained_across_parent_rename
      ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
      : 0U;
  HANDLE file = CreateFileW(
      pending_path.value.data(),
      GENERIC_READ | GENERIC_WRITE | DELETE,
      share,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_WRITE_THROUGH,
      nullptr);
  auto* mutable_state = const_cast<ProtectedFilesystemState*>(&state);
  ProtectedObjectIdentity before{};
  if (file == INVALID_HANDLE_VALUE ||
      !ExactObject(
          file,
          state.state_root_identity.volume_serial_number,
          false,
          mutable_state,
          &before) ||
      !ProtectedFilesystemRecoveryCheckpoint(state) ||
      !FlushAndRenameProtectedFile(state, file, final_path)) {
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return false;
  }
  CloseHandle(file);
  HANDLE reopened = CreateFileW(
      final_path.value.data(),
      GENERIC_READ,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  ProtectedObjectIdentity after{};
  const bool valid = reopened != INVALID_HANDLE_VALUE &&
      ExactObject(
          reopened,
          state.state_root_identity.volume_serial_number,
          false,
          mutable_state,
          &after) &&
      before.volume_serial_number == after.volume_serial_number &&
      EqualBytes(
          before.file_id.data(), after.file_id.data(), before.file_id.size());
  if (reopened != INVALID_HANDLE_VALUE) CloseHandle(reopened);
  if (!valid || !ProtectedPathIsAbsent(pending_path) ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  *identity = after;
  return true;
}

bool MoveProtectedExistingDirectory(
    const ProtectedFilesystemState& state,
    const ProtectedPath& source_path,
    const ProtectedPath& final_path,
    ProtectedObjectIdentity* identity) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      source_path.length == 0U || final_path.length == 0U ||
      identity == nullptr) return false;
  HANDLE directory = nullptr;
  ProtectedObjectIdentity before{};
  if (!OpenProtectedExistingDirectory(
          state, source_path, true, &directory, &before) ||
      !ProtectedFilesystemRecoveryCheckpoint(state) ||
      !RenameProtectedDirectory(state, directory, final_path)) {
    if (directory != nullptr && directory != INVALID_HANDLE_VALUE) {
      CloseHandle(directory);
    }
    return false;
  }
  CloseHandle(directory);
  HANDLE reopened = nullptr;
  ProtectedObjectIdentity after{};
  if (!OpenProtectedExistingDirectory(
          state, final_path, false, &reopened, &after)) return false;
  CloseHandle(reopened);
  if (before.volume_serial_number != after.volume_serial_number ||
      !EqualBytes(
          before.file_id.data(), after.file_id.data(), before.file_id.size()) ||
      !ProtectedPathIsAbsent(source_path) ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  *identity = after;
  return true;
}

void CloseProtectedFilesystem(ProtectedFilesystemState* state) noexcept {
  if (state == nullptr) return;
  HANDLE* handles[] = {
      &state->quarantine, &state->controls, &state->keysets,
      &state->journal, &state->state_root};
  for (HANDLE* handle : handles) {
    if (*handle != nullptr && *handle != INVALID_HANDLE_VALUE) CloseHandle(*handle);
    *handle = nullptr;
  }
  SecureZeroMemory(state, sizeof(*state));
}

void ConfigureProtectedFilesystemRecoveryGuard(
    ProtectedFilesystemState* state,
    std::uint64_t absolute_deadline_ms,
    HANDLE stop_event) noexcept {
  if (state == nullptr) return;
  state->recovery_deadline_ms = absolute_deadline_ms;
  state->recovery_stop_event = absolute_deadline_ms == 0U ? nullptr : stop_event;
}

bool ProtectedFilesystemRecoveryCheckpoint(
    const ProtectedFilesystemState& state) noexcept {
  if (state.recovery_deadline_ms == 0U) return true;
  return state.recovery_stop_event != nullptr &&
         state.recovery_stop_event != INVALID_HANDLE_VALUE &&
         WaitForSingleObject(state.recovery_stop_event, 0U) == WAIT_TIMEOUT &&
         GetTickCount64() < state.recovery_deadline_ms;
}

bool ComposeProtectedChildPath(
    const ProtectedPath& parent,
    const wchar_t* literal_component,
    ProtectedPath* output) noexcept {
  if (output == nullptr || parent.length == 0U) return false;
  *output = parent;
  return Append(output, literal_component);
}

bool OpenProtectedFilesystem(
    const wchar_t* extended_volume_root,
    std::size_t extended_volume_root_length,
    ProtectedFilesystemState* state) noexcept {
  if (state == nullptr) return false;
  CloseProtectedFilesystem(state);
  ProtectedPath root{};
  if (!CopyRoot(extended_volume_root, extended_volume_root_length, &root)) {
    return false;
  }
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  const bool isolated_test_root = g_test_isolated_root_active;
  if (isolated_test_root) root = g_test_isolated_root;
#else
  constexpr bool isolated_test_root = false;
#endif
  if ((!isolated_test_root &&
       (!Append(&root, kProgramData) || !Append(&root, kGoatCitadel) ||
        !Append(&root, kProvisioner) || !Append(&root, kState)))) {
    return false;
  }
  state->state_root_path = root;
  state->journal_path = root;
  state->keysets_path = root;
  state->controls_path = root;
  state->quarantine_path = root;
  if (!Append(&state->journal_path, kJournal) ||
      !Append(&state->keysets_path, kKeysets) ||
      !Append(&state->controls_path, kControls) ||
      !Append(&state->quarantine_path, kQuarantine)) {
    CloseProtectedFilesystem(state);
    return false;
  }
  HANDLE volume_handle = CreateFileW(
      isolated_test_root ? root.value.data() : extended_volume_root,
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  FILE_ID_INFO volume_id{};
  if (volume_handle == INVALID_HANDLE_VALUE ||
      GetFileInformationByHandleEx(
          volume_handle, FileIdInfo, &volume_id, sizeof(volume_id)) == FALSE) {
    if (volume_handle != INVALID_HANDLE_VALUE) CloseHandle(volume_handle);
    CloseProtectedFilesystem(state);
    return false;
  }
  CloseHandle(volume_handle);
  const std::uint64_t volume = volume_id.VolumeSerialNumber;
  if (!OpenFixed(root, volume, state, &state->state_root, &state->state_root_identity) ||
      !OpenFixed(state->journal_path, volume, state, &state->journal, &state->journal_identity) ||
      !OpenFixed(state->keysets_path, volume, state, &state->keysets, &state->keysets_identity) ||
      !OpenFixed(state->controls_path, volume, state, &state->controls, &state->controls_identity) ||
      !OpenFixed(state->quarantine_path, volume, state, &state->quarantine, &state->quarantine_identity)) {
    CloseProtectedFilesystem(state);
    return false;
  }
  std::size_t fixed_child_count = 0U;
  if (!EnumerateProtectedDirectory(
          state->state_root, &g_fixed_root_entries, &fixed_child_count) ||
      fixed_child_count != 4U) {
    CloseProtectedFilesystem(state);
    return false;
  }
  constexpr std::array<const wchar_t*, 4U> kFixedChildren = {
      kJournal, kKeysets, kControls, kQuarantine};
  std::array<bool, 4U> found{};
  for (std::size_t entry_index = 0U; entry_index < fixed_child_count; ++entry_index) {
    const ProtectedDirectoryEntry& entry = g_fixed_root_entries[entry_index];
    if ((entry.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0U ||
        (entry.attributes & ~FILE_ATTRIBUTE_DIRECTORY) != 0U) {
      CloseProtectedFilesystem(state);
      return false;
    }
    std::size_t matched = kFixedChildren.size();
    for (std::size_t name_index = 0U; name_index < kFixedChildren.size(); ++name_index) {
      std::size_t literal_length = 0U;
      while (kFixedChildren[name_index][literal_length] != L'\0') ++literal_length;
      bool equal = literal_length == entry.name_length;
      for (std::size_t index = 0U; equal && index < literal_length; ++index) {
        equal = entry.name[index] == kFixedChildren[name_index][index];
      }
      if (equal) {
        matched = name_index;
        break;
      }
    }
    if (matched == kFixedChildren.size() || found[matched]) {
      CloseProtectedFilesystem(state);
      return false;
    }
    found[matched] = true;
  }
  state->ready = true;
  return true;
}

bool CreateProtectedDirectory(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    HANDLE* directory) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      directory == nullptr || state.security_descriptor_length == 0U) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::CreateDirectory)) return false;
#endif
  *directory = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = const_cast<std::uint8_t*>(state.security_descriptor.data());
  if (!ProtectedFilesystemRecoveryCheckpoint(state) ||
      CreateDirectoryW(absolute_path.value.data(), &attributes) == FALSE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  HANDLE handle = CreateFileW(
      absolute_path.value.data(),
      GENERIC_READ | DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_WRITE_THROUGH,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return false;
  }
  *directory = handle;
  return true;
}

bool CreateProtectedFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    bool retained_across_parent_rename,
    HANDLE* file) noexcept {
  if (!state.ready || !ProtectedFilesystemRecoveryCheckpoint(state) ||
      file == nullptr || state.security_descriptor_length == 0U) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::CreateFile)) return false;
#endif
  *file = nullptr;
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = const_cast<std::uint8_t*>(state.security_descriptor.data());
  const DWORD share = retained_across_parent_rename
                          ? FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
                          : 0U;
  if (!ProtectedFilesystemRecoveryCheckpoint(state)) return false;
  HANDLE handle = CreateFileW(
      absolute_path.value.data(),
      GENERIC_READ | GENERIC_WRITE | DELETE,
      share,
      &attributes,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT |
          FILE_FLAG_WRITE_THROUGH,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    return false;
  }
  *file = handle;
  return true;
}

bool FlushAndRenameProtectedFile(
    HANDLE file,
    const ProtectedPath& final_path) noexcept {
  if (file == nullptr || file == INVALID_HANDLE_VALUE) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::FirstFlush)) return false;
#endif
  if (FlushFileBuffers(file) == FALSE) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Rename)) return false;
#endif
  if (!RenameNoReplace(file, final_path)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::SecondFlush)) return false;
#endif
  return FlushFileBuffers(file) != FALSE;
}

bool FlushAndRenameProtectedFile(
    const ProtectedFilesystemState& state,
    HANDLE file,
    const ProtectedPath& final_path) noexcept {
  if (file == nullptr || file == INVALID_HANDLE_VALUE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::FirstFlush)) return false;
#endif
  if (FlushFileBuffers(file) == FALSE ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Rename)) return false;
#endif
  if (!ProtectedFilesystemRecoveryCheckpoint(state) ||
      !RenameNoReplace(file, final_path) ||
      !ProtectedFilesystemRecoveryCheckpoint(state)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::SecondFlush)) return false;
#endif
  return ProtectedFilesystemRecoveryCheckpoint(state) &&
         FlushFileBuffers(file) != FALSE &&
         ProtectedFilesystemRecoveryCheckpoint(state);
}

bool RenameProtectedDirectory(
    HANDLE directory,
    const ProtectedPath& final_path) noexcept {
  #if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Rename)) return false;
  #endif
  return RenameNoReplace(directory, final_path);
}

bool RenameProtectedDirectory(
    const ProtectedFilesystemState& state,
    HANDLE directory,
    const ProtectedPath& final_path) noexcept {
  if (!ProtectedFilesystemRecoveryCheckpoint(state)) return false;
#if defined(GOATCITADEL_PROVISIONER_TESTING)
  if (!PermitProtectedFilesystemStepForTest(
          ProtectedFilesystemTestCutpoint::Rename)) return false;
#endif
  return ProtectedFilesystemRecoveryCheckpoint(state) &&
         RenameNoReplace(directory, final_path) &&
         ProtectedFilesystemRecoveryCheckpoint(state);
}

#if defined(GOATCITADEL_PROVISIONER_TESTING)
void SetProtectedFilesystemFailureForTest(
    ProtectedFilesystemTestCutpoint cutpoint,
    std::uint32_t fail_on_call) noexcept {
  g_test_failure_cutpoint = cutpoint;
  g_test_fail_on_call = fail_on_call;
  g_test_call_counts.fill(0U);
}

void ResetProtectedFilesystemFailuresForTest() noexcept {
  g_test_call_counts.fill(0U);
  g_test_failure_cutpoint = ProtectedFilesystemTestCutpoint::CreateDirectory;
  g_test_fail_on_call = 0U;
}

std::uint32_t ProtectedFilesystemCallCountForTest(
    ProtectedFilesystemTestCutpoint cutpoint) noexcept {
  const std::size_t index = static_cast<std::size_t>(cutpoint);
  return index < g_test_call_counts.size() ? g_test_call_counts[index] : 0U;
}

bool PermitProtectedFilesystemStepForTest(
    ProtectedFilesystemTestCutpoint cutpoint) noexcept {
  const std::size_t index = static_cast<std::size_t>(cutpoint);
  if (index == 0U || index >= g_test_call_counts.size()) return false;
  const std::uint32_t current = ++g_test_call_counts[index];
  return g_test_fail_on_call == 0U || cutpoint != g_test_failure_cutpoint ||
         current != g_test_fail_on_call;
}

bool SetProtectedFilesystemIsolatedRootForTest(
    const wchar_t* extended_root,
    std::size_t extended_root_length) noexcept {
  if (g_test_isolated_root_active) return false;
  ProtectedPath candidate{};
  if (!CopyRoot(extended_root, extended_root_length, &candidate)) return false;
  HANDLE directory = CreateFileW(
      candidate.value.data(),
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  const bool valid = directory != INVALID_HANDLE_VALUE &&
      GetFileInformationByHandleEx(
          directory,
          FileAttributeTagInfo,
          &attributes,
          sizeof(attributes)) != FALSE &&
      (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0U &&
      (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0U &&
      attributes.ReparseTag == 0U;
  if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  if (!valid) return false;
  g_test_file_security_descriptor.fill(0U);
  g_test_file_security_descriptor_length = 0U;
  g_test_dynamic_directory_security_descriptor.fill(0U);
  g_test_dynamic_directory_security_descriptor_length = 0U;
  g_test_isolated_root = candidate;
  g_test_isolated_root_active = true;
  return true;
}

void ResetProtectedFilesystemIsolatedRootForTest() noexcept {
  g_test_isolated_root_active = false;
  SecureZeroMemory(&g_test_isolated_root, sizeof(g_test_isolated_root));
  SecureZeroMemory(
      g_test_file_security_descriptor.data(),
      g_test_file_security_descriptor.size());
  g_test_file_security_descriptor_length = 0U;
  SecureZeroMemory(
      g_test_dynamic_directory_security_descriptor.data(),
      g_test_dynamic_directory_security_descriptor.size());
  g_test_dynamic_directory_security_descriptor_length = 0U;
}
#endif

}  // namespace goatcitadel::remote_worker_provisioner
