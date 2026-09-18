#pragma once
#include "cell_filesystem.hpp"
#include "cell_capacity.hpp"
#include "cell_runtime_bundle.hpp"
#include "service_identity.hpp"

namespace goatcitadel::worker_cell {
enum class CellCapacityArea : unsigned;
struct CellCapacityRootSecurity;
constexpr wchar_t kCellControllerServiceName[] = L"GoatCitadelRemoteWorkerCellController";
constexpr wchar_t kCellControllerServiceSid[] = L"S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721";
constexpr wchar_t kCellControllerImageName[] = L"GoatCitadelRemoteWorkerCellController.exe";

struct CellControllerToken final {
  std::wstring user, integrity;
  TOKEN_TYPE type = TokenImpersonation;
  DWORD session = MAXDWORD;
  LUID token_id{}, authentication_id{}, change_notify{}, manage_volume{};
  bool no_thread_token = false, restricted = true, appcontainer = true;
  std::vector<worker_host::GroupIdentity> groups;
  std::vector<LUID_AND_ATTRIBUTES> privileges;
};
// Fixed administrator-installed binary record, outside mutable worker state.
// Magic GCCUST01, image SHA32, helper SHA32, native-directory ID24, parent ID24.
struct CellControllerCustodyRecord final {
  CellFileSha256 image_sha256{}, provisioning_sha256{};
  CellFileIdentity native_directory{}, parent{};
};
bool DecodeCellControllerCustody(const std::vector<std::uint8_t>& bytes, CellControllerCustodyRecord* output) noexcept;
// Separate installer-authored runtime binding. GCRTCS01, source ID24, exact
// runtime-bundle SHA32, independently verified package-manifest SHA32. Decoding
// alone grants no authority: the installed reader must also pin path and ACLs.
struct CellControllerRuntimeCustodyRecord final {
  CellFileIdentity source_directory{};
  CellFileSha256 bundle_sha256{}, package_sha256{};
};
bool DecodeCellControllerRuntimeCustody(const std::vector<std::uint8_t>& bytes, CellControllerRuntimeCustodyRecord* output) noexcept;
// Installer-owned GCCAPS01: thirteen distinct NTFS directory identities, in
// CellCapacityArea order. Independent of assignment/profile layout records.
// Parsing confers no path, ACL, installed-file or measurement authority.
struct CellControllerCapacityCustodyRecord final {
  std::array<CellFileIdentity, 13> roots{};
  bool operator==(const CellControllerCapacityCustodyRecord&) const = default;
};
bool DecodeCellControllerCapacityCustody(const std::vector<std::uint8_t>& bytes, CellControllerCapacityCustodyRecord* output) noexcept;
// Read from a caller-pinned installer record and match all caller-held roots,
// including the independently admitted cells parent in slot zero. Caller retains
// no-follow path/ACL custody and serializes the record handle through return.
DWORD ReadCellControllerCapacityCustody(HANDLE record, const std::array<HANDLE, 13>& roots,
  const CellFileIdentity& cells_parent, CellControllerCapacityCustodyRecord* output) noexcept;
// Reads an exact record and matches its directory identity. The installed owner
// must separately retain no-follow handles and validate both security descriptors.
DWORD ReadCellControllerRuntimeCustody(HANDLE record, HANDLE source_directory, CellControllerRuntimeCustodyRecord* output) noexcept;
bool ValidateCellControllerToken(const CellControllerToken& token, bool require_volume_privilege) noexcept;
bool ValidateCellControllerConfiguration(const worker_host::ServiceConfiguration& configuration,
  const std::wstring& quoted_image, DWORD expected_state) noexcept;
bool CollectCellControllerToken(HANDLE token, CellControllerToken* output) noexcept;

// Shared read-only installation custody. The privileged controller and the
// restricted worker pin the same administrator-owned record and images. This
// owner never opens the protected cells parent and never grants runtime identity.
// Callers independently validate their tokens, SCM state and loaded processes.
class CellControllerInstalledFiles final {
 public:
  ~CellControllerInstalledFiles();
  CellControllerInstalledFiles() = default;
  CellControllerInstalledFiles(const CellControllerInstalledFiles&) = delete;
  CellControllerInstalledFiles& operator=(const CellControllerInstalledFiles&) = delete;
  DWORD Open() noexcept;
  DWORD Verify() noexcept;
  DWORD VerifyControllerProcess(HANDLE process) const noexcept;
  DWORD VerifyProvisioningProcess(HANDLE process) const noexcept;
  // Fixed installed Node source only. Manifest bytes must match the independent
  // installer binding; current contents cannot establish their own approval.
  // Retain this owner and recheck Verify through the installation authority
  // callback while using the returned pins; Ready is not permission to copy.
  DWORD OpenRuntimeBundle(const std::vector<CellRuntimeBundleFile>& files,
    PinnedCellRuntimeBundle& output, HANDLE cancellation = nullptr) noexcept;
  const std::wstring& InstallationRoot() const noexcept { return root_; }
  const std::wstring& ParentPath() const noexcept { return parent_path_; }
  const std::wstring& QuotedImagePath() const noexcept { return quoted_image_; }
  const std::wstring& ProvisioningProcessPath() const noexcept { return helper_.ProcessImagePath(); }
  const CellFileIdentity& ParentIdentity() const noexcept { return custody_.parent; }
  const CellControllerCustodyRecord& Custody() const noexcept { return custody_; }
  const CellControllerRuntimeCustodyRecord& RuntimeCustody() const noexcept { return runtime_custody_; }
  const std::wstring& RuntimePath() const noexcept { return runtime_path_; }
  void Close() noexcept;
 private:
  DWORD OpenFiles() noexcept;
  HANDLE record_ = nullptr, runtime_record_ = nullptr;
  std::array<HANDLE, 10> directory_handles_{};
  std::array<HANDLE, 2> runtime_files_{};
  PinnedCellLaunchFiles directories_, configuration_, image_, helper_, runtime_pins_;
  CellControllerCustodyRecord custody_;
  CellControllerRuntimeCustodyRecord runtime_custody_;
  std::wstring root_, image_path_, quoted_image_, parent_path_, runtime_path_;
  bool open_ = false;
};

// Read-only installed custody and current service admission. The SCM service PID,
// dedicated SYSTEM/service-SID token, exact two privileges, protected service DACL,
// fixed layout, independently installed image/parent record and NTFS pins must agree.
// Nothing is inferred from model/registry JSON, an arbitrary path or a missing PID.
// Open does not create resources or enable privileges. Only an admitted instance
// can enable the already-present volume privilege in its own exact process token.
// The caller supplies a lifecycle watchdog around synchronous OS inspection.
// This is not service installation, authenticated IPC, quota or backend readiness.
class CellControllerIdentity final {
 public:
  ~CellControllerIdentity();
  CellControllerIdentity() = default;
  CellControllerIdentity(const CellControllerIdentity&) = delete;
  CellControllerIdentity& operator=(const CellControllerIdentity&) = delete;
  DWORD Open(DWORD argument_count, wchar_t** arguments) noexcept;
  DWORD Verify(DWORD expected_state, bool require_volume_privilege = true) noexcept;
  DWORD EnableVolumeManagement() noexcept;
  // Rechecks the running controller token/SCM identity before and after the
  // read-only source pin. Installation still needs its own current authority.
  DWORD OpenRuntimeBundle(const std::vector<CellRuntimeBundleFile>& files,
    PinnedCellRuntimeBundle& output, HANDLE cancellation = nullptr) noexcept;
  DWORD VerifyProvisioningProcess(HANDLE process) const noexcept;
  // Require the helper's live service logon and creation time to agree with the
  // current running worker host and its retained pre-launch marker. This is not
  // a workload-quiescence assertion or assignment permission.
  DWORD VerifyWorkerHostProcess(HANDLE helper) noexcept;
  const std::wstring& ParentPath() const noexcept { return installed_.ParentPath(); }
  const CellFileIdentity& ParentIdentity() const noexcept { return installed_.ParentIdentity(); }
  const CellControllerRuntimeCustodyRecord& RuntimeCustody() const noexcept { return installed_.RuntimeCustody(); }
  const std::wstring& ProvisioningProcessPath() const noexcept { return installed_.ProvisioningProcessPath(); }
  // Fixed installed ACL policy for the trusted capacity-layout owner. The
  // mutable root is the original controller cells parent; other recorded areas
  // must match the installed capacity record and exact worker-state ACL.
  // This does not establish writer quiescence. Retain this
  // identity for the entire layout lifetime; every check repeats SCM custody.
  CellCapacityRootSecurity CapacityRootSecurity() noexcept;
  // Borrow the thirteen installed roots only after current running-service and
  // retained record/ACL verification. Retain this identity until all borrowers
  // close; this does not confer assignment authority or writer quiescence.
  DWORD ReadCapacityRoots(CellCapacityAreaRoots& output) noexcept;
  DWORD AcquireMeasurementGate(worker_host::WorkerStateGateLock&) noexcept;
  void Close() noexcept;
 private:
  DWORD VerifyCapacityRoot(CellCapacityArea, HANDLE, const CellFileIdentity&) noexcept;
  DWORD VerifyFiles() noexcept;
  DWORD OpenCapacityFiles() noexcept;
  DWORD VerifyCapacityFiles() noexcept;
  bool CurrentService(DWORD expected_state) noexcept;
  HANDLE token_ = nullptr, parent_ = nullptr;
  SC_HANDLE manager_ = nullptr, service_ = nullptr;
  CellControllerInstalledFiles installed_;
  PinnedCellLaunchFiles parent_pins_, capacity_pins_;
  HANDLE capacity_record_ = nullptr, state_parent_ = nullptr, state_writer_gate_ = nullptr;
  std::array<HANDLE, kCellCapacityAreaCount> capacity_roots_{};
  CellControllerCapacityCustodyRecord capacity_custody_;
  CellControllerToken initial_token_;
  std::vector<std::uint8_t> parent_security_;
  bool open_ = false;
};
}
