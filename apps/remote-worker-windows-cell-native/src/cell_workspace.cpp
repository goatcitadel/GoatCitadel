#include "cell_workspace.hpp"
#include "cell_security.hpp"
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <winternl.h>
#include <algorithm>
#include <cstring>
#include <cwchar>
#include <string_view>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

namespace goatcitadel::worker_cell {
namespace {
struct LocalMemory final {
  void* value = nullptr;
  ~LocalMemory() { if (value) LocalFree(value); }
};
DWORD Error() noexcept { const DWORD value = GetLastError(); return value ? value : ERROR_GEN_FAILURE; }
bool CellName(const std::wstring& name) noexcept {
  if (name.size() != 40 || name.compare(0, 8, L"gc-cell-") != 0) return false;
  for (std::size_t index = 8; index < name.size(); ++index)
    if (!((name[index] >= L'0' && name[index] <= L'9') || (name[index] >= L'a' && name[index] <= L'f'))) return false;
  return true;
}
bool Principal(const std::wstring& text, bool controller) {
  if (text.size() < 8 || text.size() > 184) return false;
  LocalMemory sid, canonical;
  if (!ConvertStringSidToSidW(text.c_str(), &sid.value) || !IsValidSid(sid.value) ||
      !ConvertSidToStringSidW(sid.value, reinterpret_cast<LPWSTR*>(&canonical.value)) ||
      text != static_cast<const wchar_t*>(canonical.value)) return false;
  const SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY;
  if (std::memcmp(GetSidIdentifierAuthority(sid.value), &nt, sizeof(nt)) != 0) return false;
  const UCHAR count = *GetSidSubAuthorityCount(sid.value);
  if (!count) return false;
  const DWORD first = *GetSidSubAuthority(sid.value, 0);
  return (count == 1 && first == SECURITY_LOCAL_SYSTEM_RID) ||
    (count == 5 && first == SECURITY_NT_NON_UNIQUE) ||
    (controller && count == 6 && first == SECURITY_SERVICE_ID_BASE_RID);
}
std::wstring Ace(const wchar_t* type, const wchar_t* inheritance, DWORD mask, const std::wstring& sid) {
  std::array<wchar_t, 16> hex{};
  swprintf_s(hex.data(), hex.size(), L"0x%08lx", mask);
  return L"(" + std::wstring(type) + L";" + inheritance + L";" + hex.data() + L";;;" + sid + L")";
}
DWORD Descriptor(CellDirectory kind, const std::wstring& owner, const std::wstring& controller,
                 const std::wstring& app, std::vector<std::uint8_t>* output) {
  const bool work = kind == CellDirectory::work;
  const bool visible = kind != CellDirectory::control;
  std::wstring sddl = L"O:" + owner + L"G:" + owner + L"D:P";
  if (visible) {
    // Explicit AppContainer denials also apply when its TokenUser is the owner
    // or the controller. Do not deny OWNER RIGHTS: that would deny the broker.
    sddl += Ace(L"D", L"OICI", WRITE_DAC | WRITE_OWNER, app);
    sddl += Ace(L"D", L"", DELETE | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA |
      (work ? 0 : FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD), app);
  }
  sddl += Ace(L"A", L"OICI", FILE_ALL_ACCESS, L"SY");
  if (controller != L"S-1-5-18") sddl += Ace(L"A", L"OICI", FILE_ALL_ACCESS, controller);
  // Suppress the owner's implicit WRITE_DAC on roots and ordinary inherited
  // work files. Root verification does not attest every child-created object's
  // descriptor; the volume/executor still treats the mutable subtree as untrusted.
  sddl += Ace(L"A", L"OICI", READ_CONTROL, L"OW");
  if (visible) {
    if (work) {
      sddl += Ace(L"A", L"", FILE_GENERIC_READ | FILE_TRAVERSE | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY, app);
      sddl += Ace(L"A", L"OICIIO", FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE, app);
    } else {
      sddl += Ace(L"A", kind == CellDirectory::runtime ? L"OICI" : L"",
        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, app);
    }
  }
  // Apply the label at creation without requesting audit-SACL protection or
  // changing token privileges. Trusted-parent label drift is caught by Verify.
  sddl += work ? L"S:(ML;OICI;NW;;;LW)" : L"S:(ML;OICI;NW;;;ME)";
  LocalMemory descriptor;
  ULONG size = 0;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor.value, &size))
    return Error();
  if (!size || size > 4096) return ERROR_INVALID_SECURITY_DESCR;
  const auto* bytes = static_cast<const std::uint8_t*>(descriptor.value);
  output->assign(bytes, bytes + size);
  return ERROR_SUCCESS;
}
DWORD InspectDirectory(HANDLE handle, CellFileIdentity* identity) noexcept {
  if (!handle || handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK) return ERROR_INVALID_HANDLE;
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO file{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &file, sizeof(file))) return Error();
  constexpr DWORD unsafe = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
    FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
  if ((attributes.FileAttributes & unsafe) || attributes.ReparseTag || !(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      !standard.Directory || standard.DeletePending || standard.NumberOfLinks != 1 ||
      standard.EndOfFile.QuadPart < 0 || standard.AllocationSize.QuadPart < 0) return ERROR_ACCESS_DENIED;
  // NTFS directory indexes acquire ordinary allocation/EOF as entries grow.
  // Alternate streams are rejected separately below; size is not stream proof.
  std::array<wchar_t, 16> filesystem{};
  DWORD flags = 0;
  if (!GetVolumeInformationByHandleW(handle, nullptr, 0, nullptr, nullptr, &flags, filesystem.data(),
        static_cast<DWORD>(filesystem.size()))) return Error();
  if (wcscmp(filesystem.data(), L"NTFS") != 0 || !(flags & FILE_PERSISTENT_ACLS)) return ERROR_NOT_SUPPORTED;
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> streams{};
  if (!GetFileInformationByHandleEx(handle, FileStreamInfo, streams.data(), static_cast<DWORD>(streams.size()))) {
    const DWORD error = Error();
    if (error != ERROR_HANDLE_EOF) return error;
  } else {
    const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(streams.data());
    if (stream->StreamNameLength || stream->NextEntryOffset) return ERROR_ACCESS_DENIED;
  }
  identity->volume_serial = file.VolumeSerialNumber;
  std::copy(std::begin(file.FileId.Identifier), std::end(file.FileId.Identifier), identity->file_id.begin());
  return ERROR_SUCCESS;
}
DWORD GuidPath(HANDLE handle, std::wstring* path) {
  std::array<wchar_t, 2048> buffer{};
  const DWORD length = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!length) return Error();
  if (length >= buffer.size()) return ERROR_FILENAME_EXCED_RANGE;
  path->assign(buffer.data(), length);
  if (path->compare(0, 11, L"\\\\?\\Volume{") != 0) return ERROR_BAD_PATHNAME;
  const auto end = path->find(L"}\\");
  if (end == std::wstring::npos || GetDriveTypeW(path->substr(0, end + 2).c_str()) != DRIVE_FIXED) return ERROR_NOT_SUPPORTED;
  return ERROR_SUCCESS;
}
DWORD DirectoryRelative(HANDLE parent, const std::wstring& component, const std::vector<std::uint8_t>& descriptor,
                        bool create_new, HANDLE* output, bool open_mount_point = false,
                        DWORD (*guard)(void*) noexcept = nullptr, void* context = nullptr) noexcept {
  // Resolve the documented user-mode entrypoints without loading from a path.
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
  name.Buffer = const_cast<wchar_t*>(component.c_str());
  name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &name;
  // OBJ_DONT_REPARSE is absent from some user-mode SDK headers.
  attributes.Attributes = OBJ_CASE_INSENSITIVE | (open_mount_point ? 0 : 0x00001000UL);
  attributes.SecurityDescriptor = create_new ? const_cast<std::uint8_t*>(descriptor.data()) : nullptr;
  IO_STATUS_BLOCK io{};
  HANDLE created = nullptr;
  if (guard) {
    const auto error = guard(context);
    if (error) return error;
  }
  const NTSTATUS status = create(&created, FILE_GENERIC_READ, &attributes, &io, nullptr, FILE_ATTRIBUTE_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE, create_new ? FILE_CREATE : FILE_OPEN,
    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
  if (status < 0) return convert(status);
  *output = created;
  // FILE_CREATED is 2, FILE_OPENED is 1. Neither operation silently substitutes
  // for the other. An unexpected disposition cannot authorize adoption/deletion.
  return io.Information == (create_new ? 2U : 1U) ? ERROR_SUCCESS : ERROR_INVALID_STATE;
}
}

DWORD BuildCellParentSecurity(const std::wstring& owner, const std::wstring& controller,
                             std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  try {
    if (!Principal(owner, false) || !Principal(controller, true)) return ERROR_INVALID_PARAMETER;
    return Descriptor(CellDirectory::control, owner, controller, L"", output);
  } catch (...) { output->clear(); return ERROR_NOT_ENOUGH_MEMORY; }
}
CellWorkspaceDirectories::~CellWorkspaceDirectories() { Close(); }
DWORD CellWorkspaceDirectories::OpenVolumeMountDirectory(bool create_new, HANDLE* output,
  DWORD (*guard)(void*) noexcept, void* context) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = nullptr;
  if (create_new && !guard) return ERROR_INVALID_PARAMETER;
  const DWORD error = Verify();
  // One literal component relative to the already pinned cell root. Recorded
  // recovery opens the leaf itself without following its reparse target.
  return error ? error : DirectoryRelative(handles_[0], L"volume", parent_descriptor_, create_new, output, !create_new, guard, context);
}
DWORD CellWorkspaceDirectories::Initialize(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& cell_name,
                                           const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (parent_) return ERROR_ALREADY_INITIALIZED;
  try {
    if (!CellName(cell_name) || !Principal(owner_sid, false) || !Principal(controller_sid, true)) return ERROR_INVALID_PARAMETER;
    CellFileIdentity actual_parent{};
    DWORD error = InspectDirectory(parent, &actual_parent);
    if (error) return error;
    if (actual_parent != expected_parent) return ERROR_FILE_INVALID;
    error = BuildCellParentSecurity(owner_sid, controller_sid, &parent_descriptor_);
    // Refuse the supplied object's security before walking its current path;
    // VerifyParent repeats this after all path components are retained.
    if (!error) error = VerifyCellSecurity(parent, parent_descriptor_);
    if (error) return error;
    const std::wstring profile = L"GoatCitadel.Worker." + cell_name.substr(8);
    // The SID is deterministic. Profile creation/enrollment belongs to the
    // canonical provisioning owner, not this filesystem primitive.
    PSID app_sid = nullptr;
    const HRESULT derived = DeriveAppContainerSidFromAppContainerName(profile.c_str(), &app_sid);
    if (FAILED(derived)) return HRESULT_FACILITY(derived) == FACILITY_WIN32 ? HRESULT_CODE(derived) : ERROR_INVALID_SID;
    LPWSTR app_text = nullptr;
    const bool converted = ConvertSidToStringSidW(app_sid, &app_text) != FALSE;
    FreeSid(app_sid);
    if (!converted) return Error();
    LocalMemory app_memory;
    app_memory.value = app_text;
    const std::wstring app(app_text);
    for (std::size_t index = 0; index < descriptors_.size(); ++index) {
      error = Descriptor(static_cast<CellDirectory>(index), owner_sid, controller_sid, app, &descriptors_[index]);
      if (error) return error;
    }
    // A duplicated metadata handle would preserve identity without establishing
    // rename/data-write exclusion. Reopen and pin every ancestor, then compare
    // the exact admitted object and protected parent descriptor before creation.
    error = parent_pins_.PinDirectoryHandle(parent, expected_parent, &parent_, &parent_path_);
    if (error) { Close(); return error; }
    parent_identity_ = expected_parent;
    error = VerifyParent();
    if (error) { Close(); return error; }
    return ERROR_SUCCESS;
  } catch (...) { Close(); return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellWorkspaceDirectories::Create(HANDLE parent, const CellFileIdentity& expected_parent, const std::wstring& cell_name,
                                       const std::wstring& owner_sid, const std::wstring& controller_sid,
                                       DWORD (*guard)(void*) noexcept, void* context) noexcept {
  try {
    DWORD error = Initialize(parent, expected_parent, cell_name, owner_sid, controller_sid);
    if (error) return error;
    const std::array<std::wstring, 4> names{cell_name, L"control", L"runtime", L"work"};
    struct GuardContext {
      CellWorkspaceDirectories* owner;
      DWORD (*authorize)(void*) noexcept;
      void* context;
      std::size_t created;
    } current{this, guard, context, 0};
    const auto verify_current = [](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<GuardContext*>(raw);
      const DWORD result = value.authorize ? value.authorize(value.context) : ERROR_SUCCESS;
      // The callback may block or change an admitted directory. Inspect again
      // before NtCreateFile, including roots created earlier in this attempt.
      return result ? result : value.owner->VerifyDirectories(value.created);
    };
    for (std::size_t index = 0; index < handles_.size(); ++index) {
      current.created = index;
      error = DirectoryRelative(index ? handles_[0] : parent_, names[index], descriptors_[index], true,
        &handles_[index], false, verify_current, &current);
      if (error) return error;
      error = InspectDirectory(handles_[index], &identities_[index]);
      if (error) return error;
      if (identities_[index].volume_serial != expected_parent.volume_serial) return ERROR_FILE_INVALID;
      error = VerifyCellSecurity(handles_[index], descriptors_[index]);
      if (error) return error;
      error = GuidPath(handles_[index], &paths_[index]);
      if (error) return error;
    }
    return Verify();
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellWorkspaceDirectories::OpenRecorded(HANDLE parent, const CellWorkspaceIdentities& recorded,
  const std::wstring& cell_name, const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (parent_) return ERROR_ALREADY_INITIALIZED;
  const auto reject = [&](DWORD error) { Close(); return error; };
  try {
    const auto nonzero = [](const CellFileIdentity& value) {
      return value.volume_serial && std::any_of(value.file_id.begin(), value.file_id.end(), [](auto byte) { return byte != 0; });
    };
    if (!nonzero(recorded.parent)) return ERROR_INVALID_PARAMETER;
    for (std::size_t index = 0; index < recorded.directories.size(); ++index) {
      const auto& identity = recorded.directories[index];
      if (!nonzero(identity) || identity.volume_serial != recorded.parent.volume_serial || identity == recorded.parent)
        return ERROR_INVALID_PARAMETER;
      for (std::size_t prior = 0; prior < index; ++prior)
        if (recorded.directories[prior] == identity) return ERROR_INVALID_PARAMETER;
    }
    DWORD error = Initialize(parent, recorded.parent, cell_name, owner_sid, controller_sid);
    if (error) return reject(error);
    const std::array<std::wstring, 4> names{cell_name, L"control", L"runtime", L"work"};
    for (std::size_t index = 0; index < handles_.size(); ++index) {
      error = VerifyParent();
      if (!error) error = DirectoryRelative(index ? handles_[0] : parent_, names[index], descriptors_[index], false, &handles_[index]);
      if (!error) error = InspectDirectory(handles_[index], &identities_[index]);
      if (error) return reject(error);
      if (identities_[index] != recorded.directories[index]) return reject(ERROR_FILE_INVALID);
      error = VerifyCellSecurity(handles_[index], descriptors_[index]);
      if (!error) error = GuidPath(handles_[index], &paths_[index]);
      if (error) return reject(error);
    }
    error = Verify();
    return error ? reject(error) : ERROR_SUCCESS;
  } catch (...) { return reject(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellWorkspaceDirectories::RecordIdentities(CellWorkspaceIdentities* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const DWORD error = Verify();
  if (error) return error;
  output->parent = parent_identity_;
  output->directories = identities_;
  return ERROR_SUCCESS;
}
DWORD CellWorkspaceDirectories::VerifyParent() noexcept {
  try {
    CellFileIdentity actual{};
    DWORD error = InspectDirectory(parent_, &actual);
    if (error) return error;
    if (actual != parent_identity_) return ERROR_FILE_INVALID;
    error = VerifyCellSecurity(parent_, parent_descriptor_);
    if (error) return error;
    std::wstring current_path;
    error = GuidPath(parent_, &current_path);
    if (error) return error;
    return current_path == parent_path_ ? ERROR_SUCCESS : ERROR_FILE_INVALID;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellWorkspaceDirectories::VerifyDirectories(std::size_t count) noexcept {
  try {
    DWORD error = VerifyParent();
    if (error) return error;
    CellFileIdentity actual{};
    for (std::size_t index = 0; index < count; ++index) {
      error = InspectDirectory(handles_[index], &actual);
      if (error) return error;
      if (actual != identities_[index]) return ERROR_FILE_INVALID;
      error = VerifyCellSecurity(handles_[index], descriptors_[index]);
      if (error) return error;
      std::wstring current_path;
      error = GuidPath(handles_[index], &current_path);
      if (error) return error;
      if (current_path != paths_[index]) return ERROR_FILE_INVALID;
    }
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellWorkspaceDirectories::Verify() noexcept {
  ready_ = false;
  const DWORD error = VerifyDirectories(handles_.size());
  if (!error) ready_ = true;
  return error;
}
void CellWorkspaceDirectories::Close() noexcept {
  ready_ = false;
  for (auto entry = handles_.rbegin(); entry != handles_.rend(); ++entry) { if (*entry) CloseHandle(*entry); *entry = nullptr; }
  parent_pins_.Reset();
  parent_ = nullptr;
  parent_identity_ = {};
  parent_path_.clear();
  parent_descriptor_.clear();
  identities_.fill({});
  for (auto& path : paths_) path.clear();
  for (auto& descriptor : descriptors_) descriptor.clear();
}
HANDLE CellWorkspaceDirectories::DirectoryHandle(CellDirectory directory) const noexcept {
  const auto index = static_cast<std::size_t>(directory);
  return index < handles_.size() ? handles_[index] : nullptr;
}
const std::wstring& CellWorkspaceDirectories::DirectoryPath(CellDirectory directory) const {
  return paths_.at(static_cast<std::size_t>(directory));
}
const CellFileIdentity& CellWorkspaceDirectories::DirectoryIdentity(CellDirectory directory) const {
  return identities_.at(static_cast<std::size_t>(directory));
}
}  // namespace goatcitadel::worker_cell
