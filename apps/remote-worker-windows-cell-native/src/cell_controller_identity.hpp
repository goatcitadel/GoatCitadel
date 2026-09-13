#pragma once
#include "cell_filesystem.hpp"
#include "service_identity.hpp"

namespace goatcitadel::worker_cell {
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
  const std::wstring& ParentPath() const noexcept { return parent_path_; }
  const std::wstring& QuotedImagePath() const noexcept { return quoted_image_; }
  const std::wstring& ProvisioningProcessPath() const noexcept { return helper_.ProcessImagePath(); }
  const CellFileIdentity& ParentIdentity() const noexcept { return custody_.parent; }
  const CellControllerCustodyRecord& Custody() const noexcept { return custody_; }
  void Close() noexcept;
 private:
  DWORD OpenFiles() noexcept;
  HANDLE record_ = nullptr;
  std::array<HANDLE, 9> directory_handles_{};
  PinnedCellLaunchFiles directories_, configuration_, image_, helper_;
  CellControllerCustodyRecord custody_;
  std::wstring root_, image_path_, quoted_image_, parent_path_;
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
  DWORD VerifyProvisioningProcess(HANDLE process) const noexcept;
  const std::wstring& ParentPath() const noexcept { return installed_.ParentPath(); }
  const CellFileIdentity& ParentIdentity() const noexcept { return installed_.ParentIdentity(); }
  const std::wstring& ProvisioningProcessPath() const noexcept { return installed_.ProvisioningProcessPath(); }
  void Close() noexcept;
 private:
  DWORD VerifyFiles() noexcept;
  bool CurrentService(DWORD expected_state) noexcept;
  HANDLE token_ = nullptr, parent_ = nullptr;
  SC_HANDLE manager_ = nullptr, service_ = nullptr;
  CellControllerInstalledFiles installed_;
  PinnedCellLaunchFiles parent_pins_;
  CellControllerToken initial_token_;
  std::vector<std::uint8_t> parent_security_;
  bool open_ = false;
};
}
