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
  const std::vector<wchar_t>& Environment() const noexcept { return environment_; }
 private:
  HANDLE Pin(const std::wstring& path, bool directory, int security_kind);
  bool Walk(const std::wstring& directory, unsigned depth);
  bool LoadMeshRegistry(const std::wstring& root);
  std::vector<HANDLE> held_;
  std::vector<wchar_t> environment_;
  unsigned files_ = 0, directories_ = 0;
  ULONGLONG bytes_ = 0;
};
bool ValidateInstalledEnvironment(const std::vector<wchar_t>& block, const std::wstring& install_root) noexcept;
bool AddInstalledMeshRegistryEnvironment(const std::vector<char>& selection, const std::wstring& install_root,
  std::vector<wchar_t>& environment) noexcept;
}  // namespace goatcitadel::worker_host
