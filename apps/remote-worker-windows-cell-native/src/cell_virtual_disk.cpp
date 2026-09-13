#include "cell_virtual_disk.hpp"
#include "cell_security.hpp"
#include <initguid.h>
#include <virtdisk.h>
#include <aclapi.h>
#include <algorithm>
#include <cstring>
#include <string_view>
#pragma comment(lib, "virtdisk.lib")
#pragma comment(lib, "advapi32.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::uint64_t mib = 1024 * 1024, maximum_bytes = 1024 * 1024 * mib;
struct Event final { HANDLE value = nullptr; ~Event() { if (value) CloseHandle(value); } };
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
DWORD Control(HANDLE cancellation, ULONGLONG started, DWORD limit) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return state == WAIT_FAILED ? Error() : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() - started >= limit ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
void CancelAndJoin(HANDLE disk, OVERLAPPED& operation) noexcept {
  CancelIoEx(disk, &operation);
  DWORD ignored = 0;
  // ERROR_NOT_FOUND from cancellation can race successful completion.
  // OVERLAPPED and its event must remain alive until completion in either case.
  GetOverlappedResult(disk, &operation, &ignored, TRUE);
}
DWORD FinishDiskOperation(HANDLE disk, OVERLAPPED& operation, HANDLE cancellation,
                          ULONGLONG started, DWORD limit) noexcept {
  for (;;) {
    DWORD error = Control(cancellation, started, limit);
    if (error) { CancelAndJoin(disk, operation); return error; }
    VIRTUAL_DISK_PROGRESS progress{};
    error = GetVirtualDiskOperationProgress(disk, &operation, &progress);
    if (error) { CancelAndJoin(disk, operation); return error; }
    if (progress.OperationStatus != ERROR_IO_PENDING) return progress.OperationStatus;
    if (WaitForSingleObject(operation.hEvent, 10) == WAIT_FAILED) {
      error = Error(); CancelAndJoin(disk, operation); return error;
    }
  }
}
DWORD Query(HANDLE disk, GET_VIRTUAL_DISK_INFO_VERSION version, GET_VIRTUAL_DISK_INFO* info) noexcept {
  *info = {};
  info->Version = version;
  ULONG bytes = sizeof(*info), used = 0;
  return GetVirtualDiskInformation(disk, &bytes, info, &used);
}
bool Valid(const CellVirtualDiskSpec& spec, DWORD wall_limit_ms) noexcept {
  return IsValidCellVirtualDiskSpec(spec) && wall_limit_ms > 0 && wall_limit_ms <= 600000;
}
}
bool IsValidCellVirtualDiskSpec(const CellVirtualDiskSpec& spec) noexcept {
  const GUID empty{};
  return std::memcmp(&spec.identifier, &empty, sizeof(empty)) != 0 &&
    spec.virtual_bytes >= 16 * mib && spec.virtual_bytes <= maximum_bytes - 64 * mib &&
    spec.virtual_bytes % (2 * mib) == 0 &&
    spec.reserved_file_bytes >= spec.virtual_bytes + 64 * mib &&
    spec.reserved_file_bytes <= maximum_bytes;
}

CellVirtualDiskFile::~CellVirtualDiskFile() { Close(); }
DWORD CellVirtualDiskFile::Create(CellWorkspaceDirectories& workspace, const CellVirtualDiskSpec& spec,
                                 DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_ || disk_ || file_ != INVALID_HANDLE_VALUE) return ERROR_ALREADY_INITIALIZED;
  try {
    if (!Valid(spec, wall_limit_ms)) return ERROR_INVALID_PARAMETER;
    const ULONGLONG started = GetTickCount64();
    DWORD error = Control(cancellation, started, wall_limit_ms);
    if (!error) error = workspace.Verify();
    if (error) return error;
    spec_ = spec;
    control_identity_ = workspace.DirectoryIdentity(CellDirectory::control);
    path_ = workspace.DirectoryPath(CellDirectory::control) + L"\\cell.vhdx";
    if (!IsLiteralCellPath(path_) || path_.size() >= 2048) return ERROR_BAD_PATHNAME;
    // Copy the frozen controller descriptor, never promote a fresh filesystem
    // observation into authority for the new file.
    descriptor_ = workspace.descriptors_[static_cast<std::size_t>(CellDirectory::control)];
    error = MakeCellControlFileSecurity(descriptor_);
    if (error) return error;
    error = workspace.Verify();
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) return error;
    Event event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    if (!event.value) return Error();
    OVERLAPPED operation{};
    operation.hEvent = event.value;
    VIRTUAL_STORAGE_TYPE storage{VIRTUAL_STORAGE_TYPE_DEVICE_VHDX, VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT};
    CREATE_VIRTUAL_DISK_PARAMETERS parameters{};
    parameters.Version = CREATE_VIRTUAL_DISK_VERSION_2;
    parameters.Version2.UniqueId = spec.identifier;
    parameters.Version2.MaximumSize = spec.virtual_bytes;
    parameters.Version2.BlockSizeInBytes = 2 * static_cast<ULONG>(mib);
    parameters.Version2.SectorSizeInBytes = 512;
    parameters.Version2.PhysicalSectorSizeInBytes = 4096;
    HANDLE submitted = nullptr;
    attempted_ = true;
    error = CreateVirtualDisk(&storage, path_.c_str(), VIRTUAL_DISK_ACCESS_NONE, descriptor_.data(),
      CREATE_VIRTUAL_DISK_FLAG_FULL_PHYSICAL_ALLOCATION, 0, &parameters, &operation, &submitted);
    // The output handle is undefined for all other failures.
    if (error != ERROR_SUCCESS && error != ERROR_IO_PENDING) return error;
    disk_ = submitted;
    if (error == ERROR_IO_PENDING) error = FinishDiskOperation(disk_, operation, cancellation, started, wall_limit_ms);
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) return error;
    file_ = CreateFileW(path_.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) return Error();
    error = InspectBackingFile(&identity_);
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) return error;
    created_ = true;
    error = Verify(workspace);
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) { created_ = false; ready_ = false; }
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD CellVirtualDiskFile::OpenRecorded(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& record,
                                       DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  return OpenRecordedExpected(workspace, record, wall_limit_ms, cancellation, false);
}
DWORD CellVirtualDiskFile::OpenRecordedExpected(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& record,
                                               DWORD wall_limit_ms, HANDLE cancellation, bool attached) noexcept {
  if (attempted_ || disk_ || file_ != INVALID_HANDLE_VALUE) return ERROR_ALREADY_INITIALIZED;
  const auto reject = [&](DWORD error) { Close(); return error; };
  try {
    const auto nonzero = [](const CellFileIdentity& value) {
      return value.volume_serial && std::any_of(value.file_id.begin(), value.file_id.end(), [](auto byte) { return byte != 0; });
    };
    if (!Valid(record.spec, wall_limit_ms) || !nonzero(record.control) || !nonzero(record.backing) ||
        record.control == record.backing || record.control.volume_serial != record.backing.volume_serial)
      return ERROR_INVALID_PARAMETER;
    const ULONGLONG started = GetTickCount64();
    DWORD error = Control(cancellation, started, wall_limit_ms);
    if (!error) error = workspace.Verify();
    if (error) return error;
    if (workspace.DirectoryIdentity(CellDirectory::control) != record.control) return ERROR_FILE_INVALID;
    if (attached) {
      error = CheckCellVolumeManagementPrivilege();
      if (error) return error;
    }
    spec_ = record.spec;
    control_identity_ = record.control;
    identity_ = record.backing;
    path_ = workspace.DirectoryPath(CellDirectory::control) + L"\\cell.vhdx";
    if (!IsLiteralCellPath(path_) || path_.size() >= 2048) return reject(ERROR_BAD_PATHNAME);
    descriptor_ = workspace.descriptors_[static_cast<std::size_t>(CellDirectory::control)];
    error = MakeCellControlFileSecurity(descriptor_);
    if (error) return reject(error);
    // Verify and pin the exact file before giving its path to the virtual-disk
    // SDK. No delete sharing means it cannot be replaced while the SDK opens it.
    file_ = CreateFileW(path_.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) return reject(Error());
    CellFileIdentity actual{};
    error = InspectBackingFile(&actual);
    if (!error && actual != identity_) error = ERROR_FILE_INVALID;
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) return reject(error);
    VIRTUAL_STORAGE_TYPE storage{VIRTUAL_STORAGE_TYPE_DEVICE_VHDX, VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT};
    OPEN_VIRTUAL_DISK_PARAMETERS parameters{};
    parameters.Version = OPEN_VIRTUAL_DISK_VERSION_2;
    // Recovery of a permanent attachment needs the same V2 control-handle mode
    // as explicit detach. It remains private to the privileged attachment owner;
    // ordinary recorded-file inspection stays information-only and read-only.
    parameters.Version2.GetInfoOnly = attached ? FALSE : TRUE;
    parameters.Version2.ReadOnly = attached ? FALSE : TRUE;
    HANDLE opened = nullptr;
    // Do not traverse a differencing chain before refusing its provider subtype.
    // The synchronous SDK call still needs the outer service watchdog; a late
    // return is refused below and never reported as timely recovery.
    error = OpenVirtualDisk(&storage, path_.c_str(), VIRTUAL_DISK_ACCESS_NONE,
      OPEN_VIRTUAL_DISK_FLAG_NO_PARENTS, &parameters, &opened);
    if (error) return reject(error); // The output handle is undefined on failure.
    disk_ = opened;
    created_ = true;
    error = VerifyExpected(workspace, attached);
    if (!error && attached) error = CheckCellVolumeManagementPrivilege();
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    return error ? reject(error) : ERROR_SUCCESS;
  } catch (...) { return reject(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellVirtualDiskFile::RecordIdentity(CellWorkspaceDirectories& workspace, CellVirtualDiskRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const DWORD error = Verify(workspace);
  if (error) return error;
  *output = {spec_, control_identity_, identity_};
  return ERROR_SUCCESS;
}

DWORD CellVirtualDiskFile::InspectBackingFile(CellFileIdentity* identity) noexcept {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  FILE_STANDARD_INFO standard{};
  FILE_ID_INFO file{};
  if (!GetFileInformationByHandleEx(file_, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(file_, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(file_, FileIdInfo, &file, sizeof(file))) return Error();
  constexpr DWORD unsafe = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE |
    FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE |
    FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
  if ((attributes.FileAttributes & unsafe) || attributes.ReparseTag || standard.Directory ||
      standard.DeletePending || standard.NumberOfLinks != 1 || standard.EndOfFile.QuadPart <= 0 ||
      standard.AllocationSize.QuadPart < standard.EndOfFile.QuadPart) return ERROR_ACCESS_DENIED;
  physical_bytes_ = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  allocated_bytes_ = static_cast<std::uint64_t>(standard.AllocationSize.QuadPart);
  if (physical_bytes_ < spec_.virtual_bytes || allocated_bytes_ > spec_.reserved_file_bytes) return ERROR_DISK_FULL;
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> streams{};
  if (!GetFileInformationByHandleEx(file_, FileStreamInfo, streams.data(), static_cast<DWORD>(streams.size()))) return Error();
  const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(streams.data());
  constexpr std::wstring_view unnamed = L"::$DATA";
  if (stream->NextEntryOffset || stream->StreamNameLength != unnamed.size() * sizeof(wchar_t) ||
      std::wstring_view(stream->StreamName, unnamed.size()) != unnamed ||
      stream->StreamSize.QuadPart != standard.EndOfFile.QuadPart) return ERROR_ACCESS_DENIED;
  std::array<wchar_t, 2048> path{};
  const DWORD length = GetFinalPathNameByHandleW(file_, path.data(), static_cast<DWORD>(path.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!length) return Error();
  if (length >= path.size() || std::wstring_view(path.data(), length) != path_) return ERROR_FILE_INVALID;
  identity->volume_serial = file.VolumeSerialNumber;
  std::copy(std::begin(file.FileId.Identifier), std::end(file.FileId.Identifier), identity->file_id.begin());
  if (identity->volume_serial != control_identity_.volume_serial) return ERROR_FILE_INVALID;
  return VerifyCellSecurity(file_, descriptor_);
}
DWORD CellVirtualDiskFile::Verify(CellWorkspaceDirectories& workspace) noexcept {
  return VerifyExpected(workspace, false);
}
DWORD CellVirtualDiskFile::VerifyExpected(CellWorkspaceDirectories& workspace, bool attached) noexcept {
  ready_ = false;
  if (!created_ || !disk_ || file_ == INVALID_HANDLE_VALUE) return ERROR_INVALID_STATE;
  DWORD error = workspace.Verify();
  if (error) return error;
  if (workspace.DirectoryIdentity(CellDirectory::control) != control_identity_) return ERROR_FILE_INVALID;
  CellFileIdentity actual{};
  error = InspectBackingFile(&actual);
  if (error) return error;
  if (actual != identity_) return ERROR_FILE_INVALID;
  GET_VIRTUAL_DISK_INFO info{};
  error = Query(disk_, GET_VIRTUAL_DISK_INFO_IDENTIFIER, &info);
  if (error) return error;
  if (std::memcmp(&info.Identifier, &spec_.identifier, sizeof(GUID))) return ERROR_FILE_INVALID;
  error = Query(disk_, GET_VIRTUAL_DISK_INFO_VIRTUAL_STORAGE_TYPE, &info);
  if (error) return error;
  if (info.VirtualStorageType.DeviceId != VIRTUAL_STORAGE_TYPE_DEVICE_VHDX ||
      std::memcmp(&info.VirtualStorageType.VendorId, &VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT, sizeof(GUID)))
    return ERROR_NOT_SUPPORTED;
  error = Query(disk_, GET_VIRTUAL_DISK_INFO_PROVIDER_SUBTYPE, &info);
  if (error) return error;
  if (info.ProviderSubtype != 2) return ERROR_NOT_SUPPORTED; // Fixed, never dynamic/differencing.
  error = Query(disk_, GET_VIRTUAL_DISK_INFO_IS_LOADED, &info);
  if (error) return error;
  if ((info.IsLoaded != FALSE) != attached) return attached ? ERROR_NOT_READY : ERROR_BUSY;
  error = Query(disk_, GET_VIRTUAL_DISK_INFO_SIZE, &info);
  if (error) return error;
  if (info.Size.VirtualSize != spec_.virtual_bytes || info.Size.PhysicalSize != physical_bytes_ ||
      info.Size.SectorSize != 512) return ERROR_FILE_INVALID;
  ready_ = !attached;
  return ERROR_SUCCESS;
}
void CellVirtualDiskFile::Close() noexcept {
  ready_ = false;
  if (file_ != INVALID_HANDLE_VALUE) CloseHandle(file_);
  if (disk_) CloseHandle(disk_);
  file_ = INVALID_HANDLE_VALUE; disk_ = nullptr;
  attempted_ = false; created_ = false;
  spec_ = {}; control_identity_ = {}; identity_ = {};
  physical_bytes_ = 0; allocated_bytes_ = 0;
  path_.clear(); descriptor_.clear();
}

DWORD CheckCellVolumeManagementPrivilege() noexcept {
  HANDLE token = nullptr;
  if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) {
    const DWORD error = Error();
    if (error != ERROR_NO_TOKEN) return error;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return Error();
  }
  PRIVILEGE_SET required{};
  required.PrivilegeCount = 1;
  required.Control = PRIVILEGE_SET_ALL_NECESSARY;
  required.Privilege[0].Attributes = SE_PRIVILEGE_ENABLED;
  DWORD error = ERROR_SUCCESS;
  BOOL enabled = FALSE;
  if (!LookupPrivilegeValueW(nullptr, L"SeManageVolumePrivilege", &required.Privilege[0].Luid) ||
      !PrivilegeCheck(token, &required, &enabled)) error = Error();
  else if (!enabled) error = ERROR_PRIVILEGE_NOT_HELD;
  CloseHandle(token);
  return error;
}

CellVirtualDiskAttachment::~CellVirtualDiskAttachment() { Close(); }
DWORD CellVirtualDiskAttachment::Attach(CellVirtualDiskFile& source, CellWorkspaceDirectories& workspace,
                                       DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellAttachmentState::not_started || retained_.attempted_) return ERROR_ALREADY_INITIALIZED;
  try {
    if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
    const ULONGLONG started = GetTickCount64();
    DWORD error = Control(cancellation, started, wall_limit_ms);
    if (!error) error = source.Verify(workspace);
    if (!error) error = CheckCellVolumeManagementPrivilege();
    if (error) return error;
    // Retain the exact already-created file identity and frozen descriptor.
    // The retained no-delete-share handle prevents replacing its path while
    // opening the SDK handle with attachment access.
    retained_.spec_ = source.spec_;
    retained_.control_identity_ = source.control_identity_;
    retained_.identity_ = source.identity_;
    retained_.path_ = source.path_;
    retained_.descriptor_ = source.descriptor_;
    HANDLE duplicated = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), source.file_, GetCurrentProcess(), &duplicated,
        0, FALSE, DUPLICATE_SAME_ACCESS)) { error = Error(); Close(); return error; }
    retained_.file_ = duplicated;
    VIRTUAL_STORAGE_TYPE storage{VIRTUAL_STORAGE_TYPE_DEVICE_VHDX, VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT};
    OPEN_VIRTUAL_DISK_PARAMETERS parameters{};
    parameters.Version = OPEN_VIRTUAL_DISK_VERSION_2;
    parameters.Version2.GetInfoOnly = FALSE;
    parameters.Version2.ReadOnly = FALSE;
    HANDLE opened = nullptr;
    error = OpenVirtualDisk(&storage, retained_.path_.c_str(), VIRTUAL_DISK_ACCESS_NONE,
      OPEN_VIRTUAL_DISK_FLAG_NONE, &parameters, &opened);
    if (error) { Close(); return error; }
    retained_.disk_ = opened;
    retained_.attempted_ = true;
    retained_.created_ = true;
    error = retained_.Verify(workspace);
    if (!error) error = CheckCellVolumeManagementPrivilege();
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) { Close(); return error; }
    Event event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    if (!event.value) { error = Error(); Close(); return error; }
    OVERLAPPED operation{};
    operation.hEvent = event.value;
    ATTACH_VIRTUAL_DISK_PARAMETERS attach{};
    attach.Version = ATTACH_VIRTUAL_DISK_VERSION_1;
    source.ready_ = false;
    retained_.ready_ = false;
    state_ = CellAttachmentState::unknown;
    error = AttachVirtualDisk(retained_.disk_, retained_.descriptor_.data(),
      static_cast<ATTACH_VIRTUAL_DISK_FLAG>(
        ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER | ATTACH_VIRTUAL_DISK_FLAG_PERMANENT_LIFETIME),
      0, &attach, &operation);
    if (error == ERROR_IO_PENDING) error = FinishDiskOperation(retained_.disk_, operation, cancellation, started, wall_limit_ms);
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (!error) error = retained_.VerifyExpected(workspace, true);
    if (!error) error = ReadDevicePath(&device_path_);
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) return error;
    state_ = CellAttachmentState::attached;
    return ERROR_SUCCESS;
  } catch (...) {
    if (state_ == CellAttachmentState::not_started) Close();
    return ERROR_NOT_ENOUGH_MEMORY;
  }
}
DWORD CellVirtualDiskAttachment::OpenRecorded(CellWorkspaceDirectories& workspace, const CellVirtualDiskRecord& record,
                                             DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellAttachmentState::not_started || retained_.disk_ || retained_.file_ != INVALID_HANDLE_VALUE)
    return ERROR_ALREADY_INITIALIZED;
  // A failed observation of a previously recorded attachment says nothing about
  // whether it still exists or has workloads. Never turn failure into detached.
  state_ = CellAttachmentState::unknown;
  const auto reject = [&](DWORD error) { retained_.Close(); device_path_.clear(); return error; };
  try {
    const ULONGLONG started = GetTickCount64();
    DWORD error = retained_.OpenRecordedExpected(workspace, record, wall_limit_ms, cancellation, true);
    if (error) return reject(error);
    std::wstring observed, current;
    error = ReadDevicePath(&observed);
    if (!error) error = retained_.VerifyExpected(workspace, true);
    if (!error) error = ReadDevicePath(&current);
    if (!error && current != observed) error = ERROR_FILE_INVALID;
    if (!error) error = CheckCellVolumeManagementPrivilege();
    if (!error) error = Control(cancellation, started, wall_limit_ms);
    if (error) return reject(error);
    device_path_ = std::move(current);
    state_ = CellAttachmentState::attached;
    return ERROR_SUCCESS;
  } catch (...) { return reject(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellVirtualDiskAttachment::ReadDevicePath(std::wstring* path) {
  std::array<wchar_t, 128> buffer{};
  ULONG bytes = static_cast<ULONG>(sizeof(buffer));
  const DWORD error = GetVirtualDiskPhysicalPath(retained_.disk_, &bytes, buffer.data());
  if (error) return error;
  const auto end = std::find(buffer.begin(), buffer.end(), L'\0');
  if (end == buffer.end()) return ERROR_BAD_PATHNAME;
  const std::wstring_view value(buffer.data(), static_cast<std::size_t>(end - buffer.begin()));
  constexpr std::wstring_view prefix = L"\\\\.\\PhysicalDrive";
  if (value.size() <= prefix.size() || value.substr(0, prefix.size()) != prefix ||
      (value.size() > prefix.size() + 1 && value[prefix.size()] == L'0')) return ERROR_BAD_PATHNAME;
  for (std::size_t index = prefix.size(); index < value.size(); ++index)
    if (value[index] < L'0' || value[index] > L'9') return ERROR_BAD_PATHNAME;
  path->assign(value);
  return ERROR_SUCCESS;
}
DWORD CellVirtualDiskAttachment::Verify(CellWorkspaceDirectories& workspace) noexcept {
  if (state_ != CellAttachmentState::attached) return ERROR_INVALID_STATE;
  try {
    DWORD error = retained_.VerifyExpected(workspace, true);
    std::wstring actual;
    if (!error) error = ReadDevicePath(&actual);
    if (!error && actual != device_path_) error = ERROR_FILE_INVALID;
    if (error) state_ = CellAttachmentState::unknown;
    return error;
  } catch (...) { state_ = CellAttachmentState::unknown; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVirtualDiskAttachment::Detach(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellAttachmentState::attached) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  const ULONGLONG started = GetTickCount64();
  DWORD error = Control(cancellation, started, wall_limit_ms);
  if (!error) error = CheckCellVolumeManagementPrivilege();
  if (!error) error = Verify(workspace);
  if (!error) error = Control(cancellation, started, wall_limit_ms);
  if (error) return error;
  state_ = CellAttachmentState::unknown;
  // The Windows detach API is synchronous. A late return cannot report timely
  // completion; the outer service watchdog still owns a stalled driver.
  error = DetachVirtualDisk(retained_.disk_, DETACH_VIRTUAL_DISK_FLAG_NONE, 0);
  if (!error) error = Control(cancellation, started, wall_limit_ms);
  if (!error) error = retained_.Verify(workspace);
  if (!error) error = Control(cancellation, started, wall_limit_ms);
  if (error) return error;
  state_ = CellAttachmentState::detached;
  return ERROR_SUCCESS;
}
void CellVirtualDiskAttachment::Close() noexcept {
  retained_.Close();
  device_path_.clear();
  state_ = CellAttachmentState::not_started;
}
}
