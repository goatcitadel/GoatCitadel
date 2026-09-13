#pragma once
#include "cell_filesystem.hpp"
#include <array>
#include <string>
#include <vector>

namespace goatcitadel::worker_cell {
enum class CellDirectory : std::size_t { root, control, runtime, work };

// Shared exact parent descriptor for installer/controller custody inspection.
// Building bytes is not authority to change an existing object's security.
DWORD BuildCellParentSecurity(const std::wstring& owner_sid, const std::wstring& controller_sid,
                             std::vector<std::uint8_t>* output) noexcept;

// Persist with the canonical cell name and frozen owner/controller identities.
// This value records objects; it is not admission, execution or recovery authority.
struct CellWorkspaceIdentities final {
  CellFileIdentity parent;
  std::array<CellFileIdentity, 4> directories{};
  bool operator==(const CellWorkspaceIdentities&) const = default;
};

// Internal broker primitive, not an admission or quota authority. The caller
// supplies an admitted parent handle/identity and frozen owner/controller SIDs.
// The parent must already have the exact protected controller descriptor:
// owner/group = owner SID; SYSTEM and controller inheritable full control;
// OWNER RIGHTS inheritable READ_CONTROL; medium no-write-up integrity label.
// The helper verifies it, pins its NTFS ancestry and identity, and refuses
// existing data-write/delete handles. It never repairs an unprotected parent.
// Creation is exclusive and relative to the pinned handle, with ACLs applied by the
// kernel at creation. OpenRecorded only reopens independently recorded identities;
// it never creates missing objects, repairs security or adopts current names.
// Close only releases handles: partial creations remain for canonical recovery
// and capacity accounting. Do not infer clean/dead from a missing handle.
// ACL verification covers these broker-created roots, not every mutable child.
// It does not enforce disk/file-count quotas or confine AppContainer profile
// storage. Those capabilities and installed-service composition remain separate.
class CellWorkspaceDirectories final {
 public:
  CellWorkspaceDirectories() = default;
  ~CellWorkspaceDirectories();
  CellWorkspaceDirectories(const CellWorkspaceDirectories&) = delete;
  CellWorkspaceDirectories& operator=(const CellWorkspaceDirectories&) = delete;
  // The optional guard runs immediately before each exclusive directory create.
  // Parent and existing directory identities/security are rechecked after it.
  DWORD Create(HANDLE parent, const CellFileIdentity& expected_parent,
               const std::wstring& cell_name, const std::wstring& owner_sid,
               const std::wstring& controller_sid, DWORD (*guard)(void*) noexcept = nullptr,
               void* context = nullptr) noexcept;
  DWORD OpenRecorded(HANDLE parent, const CellWorkspaceIdentities& recorded,
                     const std::wstring& cell_name, const std::wstring& owner_sid,
                     const std::wstring& controller_sid) noexcept;
  // Only a complete, freshly verified owner can produce a record. Failed reads
  // clear output so partial state cannot accidentally become execution evidence.
  DWORD RecordIdentities(CellWorkspaceIdentities* output) noexcept;
  // Rechecks retained identities and exact parent/root ACLs. Ready is only the result
  // of the latest verification, never a substitute for admission-time recheck.
  DWORD Verify() noexcept;
  void Close() noexcept;
  bool Ready() const noexcept { return ready_; }
  HANDLE DirectoryHandle(CellDirectory directory) const noexcept;
  const std::wstring& DirectoryPath(CellDirectory directory) const;
  const CellFileIdentity& DirectoryIdentity(CellDirectory directory) const;

 private:
  friend class CellVirtualDiskFile;
  friend class CellProvisioningJournal;
  friend class CellVolumeProtection;
  friend class CellVolumeMount;
  DWORD OpenVolumeMountDirectory(bool create_new, HANDLE* output,
    DWORD (*guard)(void*) noexcept = nullptr, void* context = nullptr) noexcept;
  DWORD Initialize(HANDLE parent, const CellFileIdentity& expected_parent,
                   const std::wstring& cell_name, const std::wstring& owner_sid,
                   const std::wstring& controller_sid) noexcept;
  DWORD VerifyParent() noexcept;
  DWORD VerifyDirectories(std::size_t count) noexcept;
  PinnedCellLaunchFiles parent_pins_;
  // Borrowed from parent_pins_; Close releases the pins after the children.
  HANDLE parent_ = nullptr;
  CellFileIdentity parent_identity_{};
  std::wstring parent_path_;
  std::vector<std::uint8_t> parent_descriptor_;
  std::array<HANDLE, 4> handles_{};
  std::array<CellFileIdentity, 4> identities_{};
  std::array<std::wstring, 4> paths_{};
  std::array<std::vector<std::uint8_t>, 4> descriptors_{};
  bool ready_ = false;
};
}  // namespace goatcitadel::worker_cell
