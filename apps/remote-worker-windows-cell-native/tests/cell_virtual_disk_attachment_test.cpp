#include "cell_virtual_disk.hpp"
#include "cell_virtual_disk_device.hpp"
#include <cstdio>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
unsigned RunCellVirtualDiskDeviceMetadataTests();
namespace {
struct Handle final { HANDLE value = nullptr; ~Handle() { if (value) CloseHandle(value); } };
unsigned checks = 0;
bool recovery_verified = false;
bool device_binding_verified = false;
unsigned device_metadata_checks = 0;
void Check(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(message) + " (attachment check " + std::to_string(checks) + ")");
}
class ScopedVolumePrivilege final {
 public:
  explicit ScopedVolumePrivilege(bool enabled) {
    Handle process;
    HANDLE base = nullptr, original = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, TRUE, &original)) {
      original_.value = original;
      base = original;
    } else {
      if (GetLastError() != ERROR_NO_TOKEN ||
          !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &base))
        throw std::runtime_error("Read effective fixture token failed.");
      process.value = base;
    }
    HANDLE selected = nullptr;
    if (!DuplicateTokenEx(base, TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_ADJUST_PRIVILEGES, nullptr,
        SecurityImpersonation, TokenImpersonation, &selected))
      throw std::runtime_error("Duplicate fixture token failed.");
    selected_.value = selected;
    TOKEN_PRIVILEGES privileges{};
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Attributes = enabled ? SE_PRIVILEGE_ENABLED : 0;
    if (!LookupPrivilegeValueW(nullptr, L"SeManageVolumePrivilege", &privileges.Privileges[0].Luid))
      throw std::runtime_error("Resolve fixture volume privilege failed.");
    SetLastError(ERROR_SUCCESS);
    const BOOL adjusted = AdjustTokenPrivileges(selected_.value, FALSE, &privileges, 0, nullptr, nullptr);
    const DWORD error = GetLastError();
    if (!adjusted || (error != ERROR_SUCCESS && !(error == ERROR_NOT_ALL_ASSIGNED && !enabled)))
      throw std::runtime_error("Administrator-run attachment proof requires SeManageVolumePrivilege; no privilege was granted.");
    if (!SetThreadToken(nullptr, selected_.value)) throw std::runtime_error("Impersonate bounded fixture token failed.");
    active_ = true;
  }
  ~ScopedVolumePrivilege() {
    if (active_ && !(original_.value ? SetThreadToken(nullptr, original_.value) : RevertToSelf())) {
      std::fprintf(stderr, "Restore original fixture token failed.\n");
      std::terminate();
    }
  }
  ScopedVolumePrivilege(const ScopedVolumePrivilege&) = delete;
  ScopedVolumePrivilege& operator=(const ScopedVolumePrivilege&) = delete;
 private:
  Handle original_, selected_;
  bool active_ = false;
};
}

bool CellVirtualDiskAttachmentRecoveryVerified() { return recovery_verified; }
bool CellVirtualDiskDeviceBindingVerified() { return device_binding_verified; }
unsigned CellVirtualDiskDeviceMetadataChecks() { return device_metadata_checks; }
void RequireVolumeAttachmentPrivilege() {
  ScopedVolumePrivilege enabled(true);
  if (CheckCellVolumeManagementPrivilege() != ERROR_SUCCESS)
    throw std::runtime_error("The attachment fixture cannot obtain its existing volume-management privilege.");
}

unsigned RunCellVirtualDiskAttachmentTests(CellVirtualDiskFile& source, CellWorkspaceDirectories& roots, bool live) {
  checks = 0;
  recovery_verified = false;
  device_binding_verified = false;
  device_metadata_checks = RunCellVirtualDiskDeviceMetadataTests();
  checks += device_metadata_checks;
  CellVirtualDiskRecord record;
  Check(source.RecordIdentity(roots, &record) == ERROR_SUCCESS, "retain the exact disk record before any attachment");
  CellVirtualDiskAttachment attachment;
  Check(attachment.State() == CellAttachmentState::not_started && attachment.DevicePath().empty(),
    "new attachment has no device authority");
  Check(attachment.Verify(roots) == ERROR_INVALID_STATE && attachment.Detach(roots, 10000) == ERROR_INVALID_STATE,
    "unstarted owner cannot verify or detach anything");
  for (const DWORD limit : {0UL, 600001UL})
    Check(attachment.Attach(source, roots, limit) == ERROR_INVALID_PARAMETER &&
      attachment.State() == CellAttachmentState::not_started, "invalid attachment deadline cannot dispatch");
  Handle cancel{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
  Check(cancel.value && attachment.Attach(source, roots, 10000, cancel.value) == ERROR_CANCELLED &&
    attachment.State() == CellAttachmentState::not_started, "cancelled attachment cannot dispatch");
  Check(attachment.Attach(source, roots, 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE &&
    attachment.State() == CellAttachmentState::not_started, "invalid attachment cancellation handle cannot dispatch");
  CellVirtualDiskFile empty;
  Check(attachment.Attach(empty, roots, 10000) == ERROR_INVALID_STATE &&
    attachment.State() == CellAttachmentState::not_started, "arbitrary or uncreated backing file cannot be attached");
  CellWorkspaceDirectories wrong;
  Check(attachment.Attach(source, wrong, 10000) != ERROR_SUCCESS &&
    attachment.State() == CellAttachmentState::not_started, "missing workspace authority prevents attachment");
  CellVirtualDiskAttachment recovery;
  for (const DWORD limit : {0UL, 600001UL}) {
    Check(recovery.OpenRecorded(roots, record, limit) == ERROR_INVALID_PARAMETER &&
      recovery.State() == CellAttachmentState::unknown && recovery.DevicePath().empty(),
      "an invalid recovery deadline never implies the recorded volume is detached");
    recovery.Close();
  }
  Check(recovery.OpenRecorded(roots, {}, 10000) == ERROR_INVALID_PARAMETER && recovery.State() == CellAttachmentState::unknown,
    "a malformed retained record cannot recover attachment authority");
  Check(recovery.Verify(roots) == ERROR_INVALID_STATE && recovery.Detach(roots, 10000) == ERROR_INVALID_STATE,
    "failed recovery has no authority to verify or detach the uncertain attachment");
  Check(recovery.OpenRecorded(roots, record, 10000) == ERROR_ALREADY_INITIALIZED &&
    recovery.Attach(source, roots, 10000) == ERROR_ALREADY_INITIALIZED,
    "failed recovery cannot silently turn into a new open or attachment attempt");
  recovery.Close();
  Check(recovery.OpenRecorded(roots, record, 10000, cancel.value) == ERROR_CANCELLED &&
    recovery.State() == CellAttachmentState::unknown && recovery.DevicePath().empty(),
    "cancelled recovery cannot infer cleanup or adopt a device name");
  recovery.Close();
  Check(recovery.OpenRecorded(roots, record, 10000, INVALID_HANDLE_VALUE) == ERROR_INVALID_HANDLE &&
    recovery.State() == CellAttachmentState::unknown, "invalid recovery control handle is refused");
  recovery.Close();
  Check(recovery.OpenRecorded(wrong, record, 10000) != ERROR_SUCCESS &&
    recovery.State() == CellAttachmentState::unknown && recovery.DevicePath().empty(),
    "an unavailable recorded workspace cannot recover attachment authority");
  recovery.Close();
  const DWORD original_privilege = CheckCellVolumeManagementPrivilege();
  {
    ScopedVolumePrivilege denied(false);
    Check(CheckCellVolumeManagementPrivilege() == ERROR_PRIVILEGE_NOT_HELD, "effective thread token lacks volume authority");
    Check(attachment.Attach(source, roots, 10000) == ERROR_PRIVILEGE_NOT_HELD &&
      attachment.State() == CellAttachmentState::not_started && attachment.DevicePath().empty(),
      "effective thread privilege denial never falls back to process authority");
    Check(recovery.OpenRecorded(roots, record, 10000) == ERROR_PRIVILEGE_NOT_HELD &&
      recovery.State() == CellAttachmentState::unknown && recovery.DevicePath().empty(),
      "recorded attachment recovery also requires effective-thread volume authority");
    Check(recovery.Detach(roots, 10000) == ERROR_INVALID_STATE, "denied recovery cannot expose a detach handle");
    recovery.Close();
    Check(source.Verify(roots) == ERROR_SUCCESS, "denied attachment leaves the original file unattached and verified");
  }
  Check(CheckCellVolumeManagementPrivilege() == original_privilege, "fixture restores original thread authority");
  attachment.Close();
  Check(attachment.State() == CellAttachmentState::not_started && source.Verify(roots) == ERROR_SUCCESS,
    "closing an unstarted attachment preserves the source");
  if (live) {
    ScopedVolumePrivilege allowed(true);
    Check(CheckCellVolumeManagementPrivilege() == ERROR_SUCCESS, "explicit live fixture has volume-management privilege");
    const DWORD attached = attachment.Attach(source, roots, 10000);
    if (attached) std::fprintf(stderr, "Attachment error=%lu state=%d; retain owned image for reconciliation.\n",
      attached, static_cast<int>(attachment.State()));
    Check(attached == ERROR_SUCCESS && attachment.State() == CellAttachmentState::attached,
      "attach the actual owned VHDX without a drive letter");
    Check(!source.Ready(), "attachment invalidates the source's prior unattached readiness");
    Check(!attachment.DevicePath().empty() && attachment.Verify(roots) == ERROR_SUCCESS,
      "SDK confirms the attached original image and device path");
    Check(source.Verify(roots) == ERROR_BUSY, "attached file cannot masquerade as unattached preparation");
    CellVirtualDiskDevice device;
    const DWORD opened_device = device.Open(attachment, roots, 10000);
    if (opened_device) std::fprintf(stderr, "Bound device open error=%lu; retain the owned attachment for reconciliation.\n", opened_device);
    Check(opened_device == ERROR_SUCCESS && device.Ready(), "open the exact virtual disk through its independent host dependency");
    Check(device.Verify(roots, 10000) == ERROR_SUCCESS, "device length, number, backing identity and current attachment agree");
    Check(device.Open(attachment, roots, 10000) == ERROR_ALREADY_INITIALIZED, "an admitted device cannot adopt another attachment");
    Check(attachment.Attach(source, roots, 10000) == ERROR_ALREADY_INITIALIZED, "attachment is not repeated");
    Check(attachment.Detach(roots, 0) == ERROR_INVALID_PARAMETER && attachment.State() == CellAttachmentState::attached,
      "invalid detach deadline preserves the current attachment");
    Check(attachment.Detach(roots, 10000, cancel.value) == ERROR_CANCELLED &&
      attachment.State() == CellAttachmentState::attached && attachment.Verify(roots) == ERROR_SUCCESS,
      "cancelled detach cannot remove the current attachment");
    const auto original_device = attachment.DevicePath();
    attachment.Close();
    source.Close();
    Check(device.Verify(roots, 10000) == ERROR_SUCCESS, "device retains independent backing and attachment pins after source owners close");
    device.Close();
    auto wrong_record = record;
    wrong_record.backing.file_id[0] ^= 1;
    Check(recovery.OpenRecorded(roots, wrong_record, 10000) == ERROR_FILE_INVALID &&
      recovery.State() == CellAttachmentState::unknown && recovery.DevicePath().empty(),
      "a changed backing record cannot adopt the permanent attachment");
    Check(recovery.Detach(roots, 10000) == ERROR_INVALID_STATE,
      "a rejected record cannot detach the still-owned image");
    recovery.Close();
    const DWORD reopened = attachment.OpenRecorded(roots, record, 10000);
    if (reopened) std::fprintf(stderr, "Attachment recovery error=%lu; retain owned permanent image for reconciliation.\n", reopened);
    Check(reopened == ERROR_SUCCESS && attachment.State() == CellAttachmentState::attached &&
      attachment.DevicePath() == original_device && attachment.Verify(roots) == ERROR_SUCCESS,
      "recover the exact permanent attachment after closing all original disk handles");
    Check(attachment.OpenRecorded(roots, record, 10000) == ERROR_ALREADY_INITIALIZED,
      "a recovered attachment cannot be initialized again");
    Check(device.Open(attachment, roots, 10000) == ERROR_SUCCESS, "device identity is rediscovered from the exact recorded attachment");
    {
      ScopedVolumePrivilege denied(false);
      Check(device.Verify(roots, 10000) == ERROR_PRIVILEGE_NOT_HELD && !device.Ready(), "device verification rechecks effective volume privilege");
      Check(attachment.Detach(roots, 10000) == ERROR_PRIVILEGE_NOT_HELD &&
        attachment.State() == CellAttachmentState::attached, "recovered detach rechecks current effective privilege");
    }
    device.Close();
    // This fixture never formats a volume or starts a workload on the image.
    // A production caller must obtain canonical zero-workload authority first.
    const DWORD detached = attachment.Detach(roots, 10000);
    if (detached) std::fprintf(stderr, "Detach error=%lu; owned image remains pending reconciliation.\n", detached);
    Check(detached == ERROR_SUCCESS && attachment.State() == CellAttachmentState::detached,
      "detach the exact held image after the no-workload fixture");
    Check(source.OpenRecorded(roots, record, 10000) == ERROR_SUCCESS && source.Verify(roots) == ERROR_SUCCESS,
      "original recorded backing identity is verified unattached after recovered detach");
    Check(attachment.Verify(roots) == ERROR_INVALID_STATE && attachment.Detach(roots, 10000) == ERROR_INVALID_STATE,
      "a completed detach cannot be replayed as another mutation");
    attachment.Close();
    Check(source.Verify(roots) == ERROR_SUCCESS, "close after verified detach preserves backing file");
    Check(recovery.OpenRecorded(roots, record, 10000) == ERROR_NOT_READY &&
      recovery.State() == CellAttachmentState::unknown && recovery.DevicePath().empty(),
      "recovery never reattaches a disk that is already detached");
    Check(recovery.Detach(roots, 10000) == ERROR_INVALID_STATE && source.Verify(roots) == ERROR_SUCCESS,
      "failed recovery of a detached image leaves it unchanged");
    recovery_verified = true;
    device_binding_verified = true;
  }
  return checks;
}
