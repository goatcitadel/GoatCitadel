#pragma once
#include <windows.h>
#include <string>
#include <vector>

namespace goatcitadel::worker_host {
class InstalledWorkerFiles final {
 public:
  InstalledWorkerFiles() = default;
  ~InstalledWorkerFiles();
  InstalledWorkerFiles(const InstalledWorkerFiles&) = delete;
  InstalledWorkerFiles& operator=(const InstalledWorkerFiles&) = delete;
  bool Load(const std::wstring& package_root) noexcept;
  bool BeginHostRun() noexcept;
  bool FinishHostRun(HANDLE job) noexcept;
  const std::vector<wchar_t>& Environment() const noexcept { return environment_; }
 private:
  HANDLE Pin(const std::wstring& path, bool directory, int security_kind, bool writable = false);
  bool Walk(const std::wstring& directory, unsigned depth);
  bool LoadMeshRegistry(const std::wstring& root);
  std::vector<HANDLE> held_;
  std::vector<wchar_t> environment_;
  unsigned files_ = 0, directories_ = 0;
  ULONGLONG bytes_ = 0;
  HANDLE host_run_ = INVALID_HANDLE_VALUE;
};
// Caller retains exclusive write custody of a precreated, fixed-size marker.
// Begin flushes before process creation; finish requires this process's marker
// and an independently observed empty job. Uncertain history is never reset.
bool BeginWorkerHostRun(HANDLE marker) noexcept;
bool FinishWorkerHostRun(HANDLE marker, HANDLE job) noexcept;
bool ValidateInstalledEnvironment(const std::vector<wchar_t>& block, const std::wstring& install_root, bool* capacity_layout = nullptr) noexcept;
bool AddInstalledMeshRegistryEnvironment(const std::vector<char>& selection, const std::wstring& install_root,
  std::vector<wchar_t>& environment) noexcept;
}  // namespace goatcitadel::worker_host
