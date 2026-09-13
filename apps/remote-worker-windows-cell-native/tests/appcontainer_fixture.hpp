#pragma once
#include "cell_job.hpp"
#include <windows.h>
#include <string>
#include <vector>

namespace goatcitadel::worker_cell_test {
std::wstring PrepareAppContainer(const std::wstring& job_name, const std::wstring& image,
  const std::vector<std::wstring>& read_files = {});
void BindLaunchFixture(goatcitadel::worker_cell::JobCommand* command, DWORD maximum_image_bytes = 16 * 1024 * 1024);
bool CleanupAppContainers() noexcept;
bool CleanupKnownAppContainer(const std::wstring& name) noexcept;
void WritePrivateFixture(const std::wstring& path);
void ReportOwnedProfile(const std::wstring& profile, const std::wstring& path);
void ReportOwnedJobProcess(const std::wstring& job_name, const std::wstring& profile, const std::wstring& path);
}  // namespace goatcitadel::worker_cell_test
