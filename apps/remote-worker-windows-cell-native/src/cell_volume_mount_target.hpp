#pragma once
#include "cell_filesystem.hpp"
#include <span>
#include <string_view>

namespace goatcitadel::worker_cell {
// Independently retained identities, not discovered names or write authority.
// The host parent/leaf are on one volume; the protected VHDX root is on another.
struct CellVolumeMountTarget final {
  GUID volume_id{};
  CellFileIdentity parent{}, directory{}, volume_root{};
};
bool IsValidCellVolumeMountTarget(const CellVolumeMountTarget& target) noexcept;

// Bounded decoders for FSCTL_GET_REPARSE_POINT and
// GetVolumePathNamesForVolumeNameW. An empty expected folder means no aliases;
// otherwise exactly that one mounted folder must be present, without a drive
// letter or second alias. Reparse print names never select the target.
DWORD InspectCellMountPointReparse(std::span<const std::uint8_t> bytes, const GUID& volume_id) noexcept;
DWORD InspectCellVolumeMountNames(std::span<const wchar_t> names, DWORD used,
  std::wstring_view expected_folder) noexcept;

// Read-only facts for a future governed mount owner. All handles are borrowed,
// local NTFS directory handles. The leaf must have been opened no-follow and
// must be the literal "volume" child of the independently pinned parent.
// The resolved-root probe must be called separately on the handle opened by
// following that exact folder. These checks do not create/mount/format, change
// permissions, establish canonical authority or attest the retained handles'
// sharing mode. The caller still owns pins, exact ACLs, full VHDX/protection
// history, freshness, an outer watchdog and durable acknowledgements.
DWORD ReadCellMountHostDirectory(HANDLE parent, HANDLE directory,
  const CellVolumeMountTarget& expected, bool mounted) noexcept;
DWORD ReadCellMountVolumeRoot(HANDLE root, const CellVolumeMountTarget& expected) noexcept;
}
