#pragma once
#include "cell_job.hpp"
#include "cell_workspace.hpp"
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace goatcitadel::worker_cell {
class CellWorkspaceDirectories;
struct RuntimeBundleInstallResult final {
  DWORD error = ERROR_SUCCESS;
  std::uint32_t files_created = 0;
  std::uint32_t directories_created = 0;
  std::uint64_t bytes_written = 0;
  bool verified = false;
};
struct CellRuntimeBundleFile final {
  // Canonical printable ASCII, slash-separated relative path; ordered by bytes.
  // Windows aliases, case collisions and file/directory collisions are refused.
  std::wstring relative_path;
  std::uint64_t bytes = 0;
  CellFileSha256 sha256{};
};

// v1 digest: ASCII domain "goatcitadel.worker-runtime-bundle.v1" plus NUL,
// LE32 file count, then each file's LE32 path length, ASCII path, LE64 size and
// 32 digest bytes. At most 4096 files/implicit directories, 512 path characters,
// 256 MiB per file and 1 GiB total. The admitted owner supplies this metadata;
// this function does not derive or approve a manifest from current disk state.
DWORD HashRuntimeBundleManifest(const std::vector<CellRuntimeBundleFile>& files,
                               CellFileSha256* digest) noexcept;

// Exact-tree content verification inside an already protected runtime root.
// Existing files and directories stay pinned until Reset. Protected volume/ACL
// custody must also prevent additions by an untrusted writer; these handles do
// not replace that custody, OS quotas, installed package trust or admission.
class PinnedCellRuntimeBundle final {
 public:
  ~PinnedCellRuntimeBundle();
  PinnedCellRuntimeBundle() = default;
  PinnedCellRuntimeBundle(const PinnedCellRuntimeBundle&) = delete;
  PinnedCellRuntimeBundle& operator=(const PinnedCellRuntimeBundle&) = delete;
  DWORD Open(const std::wstring& root, const CellFileIdentity& expected_root,
             const std::vector<CellRuntimeBundleFile>& files, const CellFileSha256& expected_manifest,
             HANDLE cancellation = nullptr) noexcept;
  // Serialized broker operation. Copy from retained source handles into an
  // empty, freshly verified protected runtime. Every name is created exclusively
  // relative to its held parent with the runtime's explicit security descriptor.
  // Files are flushed and the complete destination is verified/pinned in output.
  // Failures retain all partial disk state and counters; never adopt or delete it.
  // This is not bundle approval, atomic publication, OS quotas or recovery authority.
  RuntimeBundleInstallResult InstallTo(CellWorkspaceDirectories& destination,
                                      PinnedCellRuntimeBundle& output,
                                      HANDLE cancellation = nullptr) noexcept;
  void Reset() noexcept;
  bool ContainsImage(const std::wstring& image, const CellFileSha256& expected_image) const noexcept;
  bool Ready() const noexcept { return ready_; }
 private:
  PinnedCellLaunchFiles roots_;
  std::vector<HANDLE> handles_;
  std::vector<CellRuntimeBundleFile> files_;
  std::map<std::wstring, HANDLE> file_handles_; // borrowed from handles_
  CellFileSha256 manifest_sha256_{};
  std::wstring root_input_;
  bool ready_ = false;
};

// Frozen local record from workspace provisioning. This does not grant execution
// or create profiles/roots. The launch owner only reopens these exact objects.
struct RuntimeWorkspaceReference final {
  std::wstring parent_path;
  CellWorkspaceIdentities identities;
  std::wstring owner_sid;
  std::wstring controller_sid;
};
struct RuntimeJobCommand final {
  JobCommand launch;
  std::wstring runtime_root;
  CellFileIdentity expected_runtime_root{};
  CellFileSha256 expected_runtime_bundle{};
  std::vector<CellRuntimeBundleFile> runtime_files;
  std::optional<RuntimeWorkspaceReference> protected_workspace{};
};
struct RuntimeJobResult final {
  JobResult job;
  bool runtime_bundle_verified = false;
  CellFileSha256 runtime_bundle_sha256{};
  // True only when the recorded protected roots were held through execution and
  // their identities, metadata and exact descriptors also passed the final check.
  bool protected_workspace_verified = false;
};

// Pin the entire admitted runtime while the AppContainer/job owner launches,
// drains and joins its child. A protected workspace reference additionally pins
// its recorded roots for that lifetime and requires exact security before/after.
// No fallback to the executable-only primitive on missing/mismatched metadata.
RuntimeJobResult RunVerifiedRuntimeJob(const RuntimeJobCommand& command, const JobLimits& limits,
                                     HANDLE cancellation = nullptr, JobStdioChannel* stdio = nullptr) noexcept;
}  // namespace goatcitadel::worker_cell
