#include "installed_worker_files.hpp"
#include "service_identity.hpp"
#include <array>
#include <cwchar>
#include <map>
#include <utility>

namespace goatcitadel::worker_host {
namespace {
bool EqualPath(const std::wstring& a, const std::wstring& b) noexcept {
  return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}
struct Handle final { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct Search final { HANDLE value = INVALID_HANDLE_VALUE; ~Search() { if (value != INVALID_HANDLE_VALUE) FindClose(value); } };
}
InstalledWorkerFiles::~InstalledWorkerFiles() { for (const auto handle : held_) CloseHandle(handle); }
HANDLE InstalledWorkerFiles::Pin(const std::wstring& path, bool directory, int kind) {
  Handle file{CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL,
    directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr)};
  BY_HANDLE_FILE_INFORMATION info{};
  std::array<wchar_t, 2052> final{};
  if (file.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(file.value, &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      static_cast<bool>(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
      GetFileType(file.value) != FILE_TYPE_DISK) return INVALID_HANDLE_VALUE;
  const DWORD length = GetFinalPathNameByHandleW(file.value, final.data(), static_cast<DWORD>(final.size()), 0);
  if (!length || length >= final.size() || !EqualPath(final.data(), L"\\\\?\\" + path)) return INVALID_HANDLE_VALUE;
  const bool trusted = kind < 2 ? VerifyWorkerAncestorHandle(file.value, kind == 1) : VerifyWorkerFileHandle(file.value, kind == 3);
  if (!trusted) return INVALID_HANDLE_VALUE;
  if (directory) { if (++directories_ > 10000) return INVALID_HANDLE_VALUE; }
  else {
    const ULONGLONG size = (static_cast<ULONGLONG>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
    if (++files_ > 10016 || info.nNumberOfLinks != 1 || size > 268435456 || bytes_ + size > 536870912)
      return INVALID_HANDLE_VALUE;
    bytes_ += size;
  }
  held_.push_back(file.value);
  const HANDLE result = file.value;
  file.value = INVALID_HANDLE_VALUE;
  return result;
}
bool InstalledWorkerFiles::Walk(const std::wstring& directory, unsigned depth) {
  if (depth > 32) return false;
  WIN32_FIND_DATAW entry{};
  Search search{FindFirstFileW((directory + L"\\*").c_str(), &entry)};
  if (search.value == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  do {
    if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
    const std::wstring path = directory + L"\\" + entry.cFileName;
    const bool child_directory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (Pin(path, child_directory, 2) == INVALID_HANDLE_VALUE || (child_directory && !Walk(path, depth + 1))) return false;
  } while (FindNextFileW(search.value, &entry));
  return GetLastError() == ERROR_NO_MORE_FILES;
}
bool ValidateInstalledEnvironment(const std::vector<wchar_t>& block, const std::wstring& root) noexcept {
  try {
    if (block.size() < 2 || block.size() > 32767 || block.back() || block[block.size() - 2]) return false;
    std::map<std::wstring, std::wstring> settings;
    std::size_t offset = 0;
    while (offset + 1 < block.size()) {
      const auto count = wcsnlen_s(block.data() + offset, block.size() - offset);
      if (!count || count > 8192 || count == block.size() - offset) return false;
      const std::wstring entry(block.data() + offset, count);
      const auto delimiter = entry.find(L'=');
      constexpr wchar_t prefix[] = L"GOATCITADEL_CONNECTED_WORKER_";
      if (entry.rfind(prefix, 0) != 0 || delimiter == std::wstring::npos || delimiter + 1 == entry.size()) return false;
      const auto key = entry.substr(std::size(prefix) - 1, delimiter - (std::size(prefix) - 1));
      if (!settings.emplace(key, entry.substr(delimiter + 1)).second) return false;
      offset += count + 1;
    }
    if (offset + 1 != block.size() || settings.size() != 12 || !settings.count(L"HOST") || !settings.count(L"PORT") ||
        !settings.count(L"RUN_ID") || settings[L"HOST"].size() > 253 || settings[L"RUN_ID"].size() > 80 ||
        settings[L"RUN_MODE"] != L"continuous" || settings[L"EXECUTION_MODE"] != L"gateway_inference" ||
        settings[L"STOP_AFTER"] != L"complete") return false;
    for (const auto& item : settings) for (const wchar_t value : item.second) if (value < L' ' || value == 0x7f) return false;
    wchar_t* end = nullptr;
    const auto port = wcstoul(settings[L"PORT"].c_str(), &end, 10);
    if (!end || *end || port < 1 || port > 65535 || settings[L"PORT"].find_first_not_of(L"0123456789") != std::wstring::npos)
      return false;
    const std::pair<const wchar_t*, const wchar_t*> paths[] = {
      {L"CLIENT_CERT_FILE", L"\\configuration\\client-cert.pem"}, {L"CA_FILE", L"\\configuration\\ca.pem"},
      {L"TICKET_FILE", L"\\configuration\\ticket.json"}, {L"PROTECTED_KEY_FILE", L"\\configuration\\protected-key.json"},
      {L"STATE_DIR", L"\\state"}, {L"REPORT_FILE", L"\\state\\service-report.json"},
    };
    for (const auto& item : paths) if (!EqualPath(settings[item.first], root + item.second)) return false;
    return settings.size() == 12;
  } catch (...) { return false; }
}
bool AddInstalledMeshRegistryEnvironment(const std::vector<char>& selection, const std::wstring& root,
    std::vector<wchar_t>& environment) noexcept {
  try {
    if (!ValidateInstalledEnvironment(environment, root)) return false;
    const std::string value(selection.begin(), selection.end());
    if (value == "disabled") return true;
    if (value.size() != 64 || value.find_first_not_of("0123456789abcdef") != std::string::npos) return false;
    const std::wstring digest(value.begin(), value.end());
    auto result = environment;
    result.pop_back();
    for (const auto& entry : {
        L"GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE=" + root + L"\\configuration\\mesh-registry-" + digest + L".json",
        L"GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256=" + digest}) {
      result.insert(result.end(), entry.begin(), entry.end()); result.push_back(0);
    }
    result.push_back(0);
    if (result.size() > 32767) return false;
    environment = std::move(result);
    return true;
  } catch (...) { return false; }
}
bool InstalledWorkerFiles::LoadMeshRegistry(const std::wstring& root) {
  const auto selection_path = root + L"\\configuration\\mesh-registry.sha256";
  if (GetFileAttributesW(selection_path.c_str()) == INVALID_FILE_ATTRIBUTES) return GetLastError() == ERROR_FILE_NOT_FOUND;
  const HANDLE selection_file = Pin(selection_path, false, 2);
  LARGE_INTEGER size{};
  if (selection_file == INVALID_HANDLE_VALUE || !GetFileSizeEx(selection_file, &size) ||
      (size.QuadPart != 8 && size.QuadPart != 64)) return false;
  std::vector<char> selection(static_cast<std::size_t>(size.QuadPart));
  DWORD count = 0;
  if (!ReadFile(selection_file, selection.data(), static_cast<DWORD>(selection.size()), &count, nullptr) ||
      count != selection.size() || !AddInstalledMeshRegistryEnvironment(selection, root, environment_)) return false;
  if (selection.size() == 8) return true;
  const std::wstring digest(selection.begin(), selection.end());
  const HANDLE registry = Pin(root + L"\\configuration\\mesh-registry-" + digest + L".json", false, 2);
  // Retain both immutable inputs while Node checks the exact registry digest,
  // workspace/node identity and native adapter contracts before polling.
  return registry != INVALID_HANDLE_VALUE && GetFileSizeEx(registry, &size) && size.QuadPart > 0 && size.QuadPart <= 524288;
}
bool InstalledWorkerFiles::Load(const std::wstring& package_root) noexcept {
  try {
    if (!held_.empty() || !environment_.empty()) return false;
    std::array<wchar_t, MAX_PATH + 1> windows{};
    const UINT length = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
    if (length < 3 || length >= windows.size() || windows[1] != L':' || windows[2] != L'\\') return false;
    const std::wstring drive(windows.data(), 3);
    const std::wstring program_data = drive + L"ProgramData";
    const std::wstring shared = program_data + L"\\GoatCitadel";
    const std::wstring root = shared + L"\\RemoteWorker";
    if (!EqualPath(package_root, root + L"\\payload") || Pin(drive, true, 0) == INVALID_HANDLE_VALUE ||
        Pin(program_data, true, 0) == INVALID_HANDLE_VALUE || Pin(shared, true, 1) == INVALID_HANDLE_VALUE ||
        Pin(root, true, 2) == INVALID_HANDLE_VALUE || Pin(package_root, true, 2) == INVALID_HANDLE_VALUE ||
        Pin(root + L"\\configuration", true, 2) == INVALID_HANDLE_VALUE || Pin(root + L"\\state", true, 3) == INVALID_HANDLE_VALUE ||
        !Walk(package_root, 0)) return false;
    for (const auto* name : {L"client-cert.pem", L"ca.pem", L"ticket.json", L"protected-key.json", L"install-receipt.json"})
      if (Pin(root + L"\\configuration\\" + name, false, 2) == INVALID_HANDLE_VALUE) return false;
    HANDLE settings = Pin(root + L"\\configuration\\worker.environment", false, 2);
    LARGE_INTEGER size{};
    if (settings == INVALID_HANDLE_VALUE || !GetFileSizeEx(settings, &size) || size.QuadPart < 4 ||
        size.QuadPart > 65534 || size.QuadPart % sizeof(wchar_t)) return false;
    environment_.resize(static_cast<std::size_t>(size.QuadPart / sizeof(wchar_t)));
    DWORD count = 0;
    if (!ReadFile(settings, environment_.data(), static_cast<DWORD>(size.QuadPart), &count, nullptr) || count != size.QuadPart ||
        !ValidateInstalledEnvironment(environment_, root) || !LoadMeshRegistry(root)) { environment_.clear(); return false; }
    return true;
  } catch (...) { environment_.clear(); return false; }
}
}  // namespace goatcitadel::worker_host
