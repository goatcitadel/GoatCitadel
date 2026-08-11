#pragma once

#include <windows.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::remote_worker_provisioner {

constexpr std::size_t kProtectedPathCharacters = 512U;
constexpr std::size_t kProtectedEntryNameCharacters = 80U;
constexpr std::size_t kMaximumProtectedDirectoryEntries = 288U;

struct ProtectedPath final {
  std::array<wchar_t, kProtectedPathCharacters> value{};
  std::size_t length = 0U;
};

struct ProtectedObjectIdentity final {
  std::uint64_t volume_serial_number = 0U;
  std::array<std::uint8_t, 16U> file_id{};
};

struct ProtectedDirectoryEntry final {
  std::array<wchar_t, kProtectedEntryNameCharacters> name{};
  std::size_t name_length = 0U;
  std::uint64_t byte_length = 0U;
  std::uint32_t attributes = 0U;
};

struct ProtectedFilesystemState final {
  HANDLE state_root = nullptr;
  HANDLE journal = nullptr;
  HANDLE keysets = nullptr;
  HANDLE controls = nullptr;
  HANDLE quarantine = nullptr;
  ProtectedPath state_root_path{};
  ProtectedPath journal_path{};
  ProtectedPath keysets_path{};
  ProtectedPath controls_path{};
  ProtectedPath quarantine_path{};
  ProtectedObjectIdentity state_root_identity{};
  ProtectedObjectIdentity journal_identity{};
  ProtectedObjectIdentity keysets_identity{};
  ProtectedObjectIdentity controls_identity{};
  ProtectedObjectIdentity quarantine_identity{};
  std::array<std::uint8_t, 96U> security_projection{};
  std::array<std::uint8_t, 512U> security_descriptor{};
  std::uint32_t security_descriptor_length = 0U;
  std::uint64_t recovery_deadline_ms = 0U;
  HANDLE recovery_stop_event = nullptr;
  bool ready = false;
};

bool OpenProtectedFilesystem(
    const wchar_t* extended_volume_root,
    std::size_t extended_volume_root_length,
    ProtectedFilesystemState* state) noexcept;
void CloseProtectedFilesystem(ProtectedFilesystemState* state) noexcept;
void ConfigureProtectedFilesystemRecoveryGuard(
    ProtectedFilesystemState* state,
    std::uint64_t absolute_deadline_ms,
    HANDLE stop_event) noexcept;
bool ProtectedFilesystemRecoveryCheckpoint(
    const ProtectedFilesystemState& state) noexcept;
bool ComposeProtectedChildPath(
    const ProtectedPath& parent,
    const wchar_t* literal_component,
    ProtectedPath* output) noexcept;

bool CreateProtectedDirectory(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    HANDLE* directory) noexcept;
bool CreateProtectedFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    bool retained_across_parent_rename,
    HANDLE* file) noexcept;
// Creates a non-publishable staging file whose directory entry is owned by the
// returned handle from the instant CreateFileW succeeds. Closing the last
// handle removes the entry, including after an abrupt process termination.
bool CreateProtectedDeleteOnCloseFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    HANDLE* file) noexcept;
bool FlushAndRenameProtectedFile(
    HANDLE file,
    const ProtectedPath& final_path) noexcept;
bool FlushAndRenameProtectedFile(
    const ProtectedFilesystemState& state,
    HANDLE file,
    const ProtectedPath& final_path) noexcept;
bool RenameProtectedDirectory(
    HANDLE directory,
    const ProtectedPath& final_path) noexcept;
bool RenameProtectedDirectory(
    const ProtectedFilesystemState& state,
    HANDLE directory,
    const ProtectedPath& final_path) noexcept;
bool CaptureProtectedObjectIdentity(
    HANDLE object,
    ProtectedObjectIdentity* identity) noexcept;
bool CaptureProtectedObjectIdentity(
    const ProtectedFilesystemState& state,
    HANDLE object,
    ProtectedObjectIdentity* identity) noexcept;
bool ProtectedDirectoryIsEmpty(HANDLE directory) noexcept;
bool ProtectedDirectoryIsEmptyGuarded(
    const ProtectedFilesystemState& state,
    HANDLE directory) noexcept;
bool EnumerateProtectedDirectory(
    HANDLE directory,
    std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>* entries,
    std::size_t* count) noexcept;
bool EnumerateProtectedDirectory(
    const ProtectedFilesystemState& state,
    HANDLE directory,
    std::array<ProtectedDirectoryEntry, kMaximumProtectedDirectoryEntries>* entries,
    std::size_t* count) noexcept;
bool OpenProtectedExistingDirectory(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    bool rename_capable,
    HANDLE* directory,
    ProtectedObjectIdentity* identity) noexcept;
bool ReadProtectedExistingFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint8_t* bytes,
    std::size_t capacity,
    std::size_t* length,
    ProtectedObjectIdentity* identity) noexcept;
bool OpenProtectedExistingFileForParentRename(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint64_t maximum_length,
    HANDLE* file,
    std::uint64_t* length,
    ProtectedObjectIdentity* identity) noexcept;
bool OpenProtectedExistingFileForRename(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint64_t maximum_length,
    HANDLE* file,
    std::uint64_t* length,
    ProtectedObjectIdentity* identity) noexcept;
bool ReadProtectedOpenFile(
    const ProtectedFilesystemState& state,
    HANDLE file,
    std::uint8_t* bytes,
    std::size_t capacity,
    std::size_t* length,
    ProtectedObjectIdentity* identity) noexcept;
bool FlushProtectedOpenFileForParentRename(
    const ProtectedFilesystemState& state,
    HANDLE file,
    bool after_parent_rename) noexcept;
bool ProtectedPathIsAbsentGuarded(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path) noexcept;
bool ReadProtectedFinalFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& absolute_path,
    std::uint8_t* bytes,
    std::size_t capacity,
    std::size_t* length,
    ProtectedObjectIdentity* identity) noexcept;
bool PromoteProtectedExistingFile(
    const ProtectedFilesystemState& state,
    const ProtectedPath& pending_path,
    const ProtectedPath& final_path,
    bool retained_across_parent_rename,
    ProtectedObjectIdentity* identity) noexcept;
bool MoveProtectedExistingDirectory(
    const ProtectedFilesystemState& state,
    const ProtectedPath& source_path,
    const ProtectedPath& final_path,
    ProtectedObjectIdentity* identity) noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING)
enum class ProtectedFilesystemTestCutpoint : std::uint8_t {
  CreateDirectory = 1U,
  CreateFile = 2U,
  Write = 3U,
  FirstFlush = 4U,
  Rename = 5U,
  SecondFlush = 6U,
  Reopen = 7U,
};
void SetProtectedFilesystemFailureForTest(
    ProtectedFilesystemTestCutpoint cutpoint,
    std::uint32_t fail_on_call) noexcept;
void ResetProtectedFilesystemFailuresForTest() noexcept;
std::uint32_t ProtectedFilesystemCallCountForTest(
    ProtectedFilesystemTestCutpoint cutpoint) noexcept;
bool PermitProtectedFilesystemStepForTest(
    ProtectedFilesystemTestCutpoint cutpoint) noexcept;
bool SetProtectedFilesystemIsolatedRootForTest(
    const wchar_t* extended_root,
    std::size_t extended_root_length) noexcept;
void ResetProtectedFilesystemIsolatedRootForTest() noexcept;
#endif

}  // namespace goatcitadel::remote_worker_provisioner
