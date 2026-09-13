#pragma once
#include <windows.h>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace goatcitadel::worker_cell {
struct CellFileIdentity final {
  std::uint64_t volume_serial = 0;
  std::array<std::uint8_t, 16> file_id{};
  bool operator==(const CellFileIdentity&) const = default;
};
using CellFileSha256 = std::array<std::uint8_t, 32>;
// Shared syntax gate for fixed-drive paths and canonical volume-GUID paths.
// Syntax is not authority: Open still verifies NTFS, every ancestor and the
// expected object identities/content before any execution.
bool IsLiteralCellPath(const std::wstring& path) noexcept;

// Read-only launch verification. Expected identity/hash come from the admitted
// owner; this class never blesses current disk bytes as their own authority.
// Retained handles exclude data writes/renames on the launch path components.
// Mutable work and controller outputs require separate broker-owned directories.
// This is not an assignment-volume provisioner, quota enforcer or bundle verifier.
class PinnedCellLaunchFiles final {
 public:
  PinnedCellLaunchFiles() = default;
  ~PinnedCellLaunchFiles();
  PinnedCellLaunchFiles(const PinnedCellLaunchFiles&) = delete;
  PinnedCellLaunchFiles& operator=(const PinnedCellLaunchFiles&) = delete;
  DWORD Open(const std::wstring& image, const std::wstring& directory,
             const CellFileSha256& expected_image, const CellFileIdentity& expected_directory) noexcept;
  void Reset() noexcept;
  const std::wstring& ImagePath() const noexcept { return image_; }
  // Some manifest-bearing images cannot be created through a volume-GUID name.
  // A DOS name is only a launch locator; VerifyProcessImage is mandatory before
  // resuming the suspended process, while the original file/ancestry pins remain.
  const std::wstring& ProcessImagePath() const noexcept { return process_image_; }
  DWORD VerifyProcessImage(HANDLE process) const noexcept;
  const std::wstring& DirectoryPath() const noexcept { return directory_; }
 private:
  friend class PinnedCellRuntimeBundle;
  friend class CellWorkspaceDirectories;
  friend class PinnedCellToolDirectory;
  friend class CellControllerIdentity;
  friend class CellControllerInstalledFiles;
  DWORD PinPath(const std::wstring& path, bool directory, HANDLE* leaf, std::wstring* canonical);
  DWORD PinDirectoryHandle(HANDLE admitted, const CellFileIdentity& expected,
                           HANDLE* leaf, std::wstring* canonical) noexcept;
  std::vector<HANDLE> handles_;
  std::wstring image_;
  std::wstring process_image_;
  std::wstring native_image_;
  std::wstring directory_;
};

struct CellToolWriteResult final {
  // Once true, an error means an uncertain effect. Never retry it automatically.
  bool effect_started = false;
  bool created = false;
  std::uint64_t bytes = 0;
  CellFileSha256 sha256{};
};

// An operator-selected local NTFS directory, not an execution sandbox. Ancestor
// handles exclude replacement while a tool uses canonical volume-GUID paths.
// The caller retains the first identity and supplies it on subsequent opens.
class PinnedCellToolDirectory final {
 public:
  DWORD Open(const std::wstring& path, const CellFileIdentity* expected = nullptr) noexcept;
  const CellFileIdentity& Identity() const noexcept { return identity_; }
  DWORD Write(const std::wstring& relative_path, const std::vector<std::uint8_t>& content,
              const std::optional<std::vector<std::uint8_t>>& expected_content,
              CellToolWriteResult* result) noexcept;
 private:
  PinnedCellLaunchFiles pins_;
  std::wstring path_;
  CellFileIdentity identity_{};
};
}  // namespace goatcitadel::worker_cell
