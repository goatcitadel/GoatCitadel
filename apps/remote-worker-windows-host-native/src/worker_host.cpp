#include "worker_host.hpp"
#include "worker_host_pins.hpp"
#include "installed_worker_files.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cwchar>
#include <string>
#include <utility>
#include <vector>

namespace goatcitadel::worker_host {
namespace {
constexpr std::size_t kMaximumPath = 2048;
constexpr std::size_t kMaximumEnvironment = 32767;

class Handle final {
 public:
  explicit Handle(HANDLE value = nullptr) noexcept : value_(value) {}
  ~Handle() { Reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
  HANDLE Get() const noexcept { return value_; }
  bool Valid() const noexcept { return value_ && value_ != INVALID_HANDLE_VALUE; }
  void Reset(HANDLE value = nullptr) noexcept {
    if (Valid()) CloseHandle(value_);
    value_ = value;
  }
 private:
  HANDLE value_;
};

struct Attributes final {
  std::vector<std::uint8_t> bytes;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
  bool Initialize(HANDLE* inherited, std::size_t count, HANDLE* job) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    if (!size || size > 65536) return false;
    bytes.resize(size);
    auto* candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
    if (!InitializeProcThreadAttributeList(candidate, 2, 0, &size)) return false;
    list = candidate;
    return UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, count * sizeof(HANDLE), nullptr, nullptr) &&
      // Atomic assignment closes the crash window between creation and AssignProcessToJobObject.
      UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        job, sizeof(HANDLE), nullptr, nullptr);
  }
};

bool EqualPath(const wchar_t* a, const wchar_t* b) noexcept {
  return CompareStringOrdinal(a, -1, b, -1, TRUE) == CSTR_EQUAL;
}

bool CanonicalDrivePath(const std::wstring& path) noexcept {
  if (path.size() < 3 || path.size() >= kMaximumPath || path[1] != L':' || path[2] != L'\\' ||
      !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')))
    return false;
  for (std::size_t begin = 3; begin < path.size();) {
    const auto end = path.find(L'\\', begin);
    const auto length = (end == std::wstring::npos ? path.size() : end) - begin;
    if (!length || length > 255 || path[begin + length - 1] == L'.' || path[begin + length - 1] == L' ')
      return false;
    for (std::size_t index = begin; index < begin + length; ++index)
      if (path[index] < L' ' || wcschr(L"/:*?\"<>|", path[index])) return false;
    if (end == std::wstring::npos) break;
    begin = end + 1;
    if (begin == path.size()) return false;
  }
  return true;
}

bool MatchesHandlePath(HANDLE file, const std::wstring& expected) noexcept {
  std::array<wchar_t, kMaximumPath + 4> actual{};
  const DWORD length = GetFinalPathNameByHandleW(file, actual.data(), static_cast<DWORD>(actual.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  return length > 4 && length < actual.size() && wcsncmp(actual.data(), L"\\\\?\\", 4) == 0 &&
    EqualPath(actual.data() + 4, expected.c_str());
}

bool PinDirectory(const std::wstring& path, std::vector<Handle>* held) {
  Handle directory(CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!directory.Valid() || !GetFileInformationByHandleEx(directory.Get(), FileAttributeTagInfo, &info, sizeof(info)) ||
      !(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !MatchesHandlePath(directory.Get(), path)) return false;
  held->push_back(std::move(directory));
  return true;
}

bool PinAncestors(const std::wstring& path, std::vector<Handle>* held) {
  if (!CanonicalDrivePath(path) || GetDriveTypeW(path.substr(0, 3).c_str()) != DRIVE_FIXED ||
      !PinDirectory(path.substr(0, 3), held)) return false;
  for (std::size_t offset = 3; offset < path.size();) {
    const auto next = path.find(L'\\', offset);
    if (next == std::wstring::npos) break;
    if (!PinDirectory(path.substr(0, next), held)) return false;
    offset = next + 1;
  }
  return true;
}

bool HashFile(HANDLE file, const std::array<std::uint8_t, 32>& expected, DWORD maximum) noexcept {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file, &info) || GetFileType(file) != FILE_TYPE_DISK ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      info.nNumberOfLinks != 1 || info.nFileSizeHigh || !info.nFileSizeLow || info.nFileSizeLow > maximum) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  BCRYPT_HASH_HANDLE hash = nullptr;
  bool valid = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0;
  std::array<std::uint8_t, 65536> buffer{};
  DWORD remaining = info.nFileSizeLow;
  while (valid && remaining) {
    DWORD count = 0;
    valid = ReadFile(file, buffer.data(), std::min<DWORD>(remaining, static_cast<DWORD>(buffer.size())), &count, nullptr) &&
      count > 0 && count <= remaining && BCryptHashData(hash, buffer.data(), count, 0) >= 0;
    if (valid) remaining -= count;
  }
  std::array<std::uint8_t, 32> actual{};
  DWORD extra = 0;
  valid = valid && ReadFile(file, buffer.data(), 1, &extra, nullptr) && extra == 0 &&
    BCryptFinishHash(hash, actual.data(), static_cast<ULONG>(actual.size()), 0) >= 0 && actual == expected;
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return valid;
}

bool PinImage(const std::wstring& path, const std::array<std::uint8_t, 32>& expected,
    DWORD maximum, std::vector<Handle>* held) {
  if (!PinAncestors(path, held)) return false;
  Handle image(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!image.Valid() || !MatchesHandlePath(image.Get(), path) || !HashFile(image.Get(), expected, maximum)) return false;
  held->push_back(std::move(image));
  return true;
}

struct Layout final { std::wstring root, node, entrypoint; std::vector<Handle> held; };

bool ResolveLayout(Layout* layout) {
  std::array<wchar_t, kMaximumPath> image{};
  const DWORD length = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
  if (!length || length >= image.size()) return false;
  const std::wstring self(image.data(), length);
  constexpr wchar_t suffix[] = L"\\bin\\GoatCitadelRemoteWorkerHost.exe";
  if (self.size() <= std::size(suffix) - 1 || !EqualPath(self.c_str() + self.size() - (std::size(suffix) - 1), suffix))
    return false;
  layout->root = self.substr(0, self.size() - (std::size(suffix) - 1));
  layout->node = layout->root + L"\\app\\runtime\\node.exe";
  layout->entrypoint = layout->root + L"\\app\\worker\\dist\\main.js";
  return PinAncestors(self, &layout->held) &&
    PinImage(layout->node, kNodeSha256, 256U * 1024 * 1024, &layout->held) &&
    PinImage(layout->entrypoint, kEntrypointSha256, 4U * 1024 * 1024, &layout->held);
}

bool BuildEnvironment(std::vector<wchar_t>* output, const std::vector<wchar_t>* installed) {
  std::array<wchar_t, MAX_PATH + 1> windows{};
  const UINT length = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  if (!length || length >= windows.size()) return false;
  std::vector<std::wstring> entries{std::wstring(L"SystemRoot=") + windows.data(), kHostControlEntry};
  LPWCH ambient = installed ? nullptr : GetEnvironmentStringsW();
  const wchar_t* raw = installed ? installed->data() : ambient;
  const std::size_t maximum = installed ? installed->size() : kMaximumEnvironment;
  if (!raw) return false;
  bool valid = true, protected_key = false;
  std::size_t offset = 0;
  while (valid && offset < maximum && raw[offset]) {
    const std::size_t count = wcsnlen_s(raw + offset, maximum - offset);
    if (!count || count == maximum - offset) { valid = false; break; }
    const std::wstring entry(raw + offset, count);
    offset += count + 1;
    constexpr wchar_t prefix[] = L"GOATCITADEL_CONNECTED_WORKER_";
    if (entry.size() < std::size(prefix) - 1 || CompareStringOrdinal(entry.c_str(), std::size(prefix) - 1,
        prefix, std::size(prefix) - 1, TRUE) != CSTR_EQUAL) { if (installed) valid = false; continue; }
    const auto delimiter = entry.find(L'=');
    const auto name = entry.substr(0, delimiter);
    bool known = false;
    for (const auto* allowed : kForwardedEnvironment) if (name == allowed) known = true;
    if (!known || delimiter == std::wstring::npos || delimiter + 1 == entry.size() || entry.size() > 8192) {
      valid = false; break;
    }
    for (const auto& existing : entries)
      if (existing.substr(0, existing.find(L'=')) == name) valid = false;
    if (name == L"GOATCITADEL_CONNECTED_WORKER_PROTECTED_KEY_FILE") protected_key = true;
    entries.push_back(entry);
  }
  if (offset >= maximum || (installed && offset + 1 != maximum)) valid = false;
  if (ambient) FreeEnvironmentStringsW(ambient);
  if (!valid || !protected_key) return false;
  std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) {
    return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_LESS_THAN;
  });
  for (const auto& entry : entries) {
    if (output->size() + entry.size() + 2 > kMaximumEnvironment) return false;
    output->insert(output->end(), entry.begin(), entry.end());
    output->push_back(L'\0');
  }
  output->push_back(L'\0');
  return true;
}

bool InputRequestsStop() noexcept {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE || GetFileType(input) != FILE_TYPE_PIPE) return false;
  DWORD available = 0;
  if (PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) return available != 0;
  // Any failed pipe observation requests shutdown; it cannot convey a command.
  return true;
}

bool JobCount(HANDLE job, DWORD* active) noexcept {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr)) return false;
  *active = info.ActiveProcesses;
  return true;
}

struct Child final {
  Handle job, process, thread, input_writer;
  ~Child() {
    // The unnamed job is never inherited. Closing its last handle kills descendants even on host death.
    job.Reset();
    if (process.Valid()) WaitForSingleObject(process.Get(), kTerminationMs);
  }
};
}  // namespace

Result Run(HANDLE stop_event, bool watch_standard_input, Observer observer, void* context) noexcept {
  Result result;
  Layout layout;
  InstalledWorkerFiles installed;
  Child child; // Child cleanup runs before the layout releases executable/path leases.
  try {
    std::vector<wchar_t> environment;
    if (!stop_event || !ResolveLayout(&layout) || (!watch_standard_input && !installed.Load(layout.root)) ||
        !BuildEnvironment(&environment, watch_standard_input ? nullptr : &installed.Environment())) {
      result.error = ERROR_INVALID_DATA; return result;
    }
    if (WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0) {
      result.stop_requested = true; return result;
    }
    child.job.Reset(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = kMaximumProcesses;
    limits.JobMemoryLimit = kMaximumJobMemory;
    if (!child.job.Valid() || !SetInformationJobObject(child.job.Get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
      result.error = ERROR_NOT_SUPPORTED; return result;
    }
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE read = nullptr, write = nullptr;
    if (!CreatePipe(&read, &write, &security, 4096)) { result.error = GetLastError(); return result; }
    Handle input_read(read);
    child.input_writer.Reset(write);
    if (!SetHandleInformation(child.input_writer.Get(), HANDLE_FLAG_INHERIT, 0)) {
      result.error = GetLastError(); return result;
    }
    Handle output(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
    HANDLE inherited[] = {input_read.Get(), output.Get()};
    HANDLE job = child.job.Get();
    Attributes attributes;
    if (!output.Valid() || !attributes.Initialize(inherited, std::size(inherited), &job)) {
      result.error = ERROR_NOT_SUPPORTED; return result;
    }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = input_read.Get();
    startup.StartupInfo.hStdOutput = output.Get();
    startup.StartupInfo.hStdError = output.Get();
    startup.lpAttributeList = attributes.list;
    std::wstring command = L"\"" + layout.node + L"\" \"" + layout.entrypoint + L"\"";
    PROCESS_INFORMATION process{};
    if (!watch_standard_input && !installed.BeginHostRun()) {
      result.error = ERROR_INVALID_STATE; return result;
    }
    if (!CreateProcessW(layout.node.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
        environment.data(), layout.root.c_str(), &startup.StartupInfo, &process)) {
      result.error = GetLastError();
      if (!watch_standard_input && !installed.FinishHostRun(child.job.Get())) result.error = ERROR_INVALID_STATE;
      return result;
    }
    child.process.Reset(process.hProcess);
    child.thread.Reset(process.hThread);
    input_read.Reset();
    output.Reset();
    result.job_empty = false;
    BOOL in_job = FALSE;
    if (!IsProcessInJob(child.process.Get(), child.job.Get(), &in_job) || !in_job ||
        ResumeThread(child.thread.Get()) == static_cast<DWORD>(-1)) result.error = ERROR_PROCESS_ABORTED;
    child.thread.Reset();
    if (!result.error && observer && !observer(SERVICE_RUNNING, context)) result.error = ERROR_GEN_FAILURE;
    ULONGLONG stop_deadline = 0;
    while (!result.error) {
      if ((watch_standard_input && InputRequestsStop()) || WaitForSingleObject(stop_event, 0) == WAIT_OBJECT_0) {
        if (!result.stop_requested) {
          result.stop_requested = true;
          child.input_writer.Reset();
          stop_deadline = GetTickCount64() + kGracefulStopMs;
          if (observer && !observer(SERVICE_STOP_PENDING, context)) { result.error = ERROR_GEN_FAILURE; break; }
        }
      }
      const DWORD waited = WaitForSingleObject(child.process.Get(), 25);
      if (waited == WAIT_OBJECT_0) break;
      if (waited != WAIT_TIMEOUT) { result.error = ERROR_INVALID_HANDLE; break; }
      if (stop_deadline && GetTickCount64() >= stop_deadline) { result.error = ERROR_TIMEOUT; break; }
    }
    DWORD active = 0;
    // A signaled process handle can precede the job's exit accounting. Allow that
    // accounting (and normally exiting descendants) to settle before forced cleanup.
    const ULONGLONG drain_deadline = GetTickCount64() + kExitedChildDrainMs;
    while (!result.error && JobCount(child.job.Get(), &active) && active && GetTickCount64() < drain_deadline)
      Sleep(10);
    if (!JobCount(child.job.Get(), &active)) result.error = ERROR_INVALID_HANDLE;
    if (active || result.error) {
      result.forced = true;
      if (!result.error) result.error = ERROR_PROCESS_ABORTED;
      if (!TerminateJobObject(child.job.Get(), result.error)) result.error = ERROR_PROCESS_ABORTED;
    }
    const ULONGLONG deadline = GetTickCount64() + kTerminationMs;
    do {
      if (!JobCount(child.job.Get(), &active)) break;
      if (active == 0) { result.job_empty = true; break; }
      Sleep(10);
    } while (GetTickCount64() < deadline);
    if (!result.job_empty) result.error = ERROR_TIMEOUT;
    if (!GetExitCodeProcess(child.process.Get(), &result.child_exit_code) || result.child_exit_code == STILL_ACTIVE)
      result.error = ERROR_PROCESS_ABORTED;
    if (!watch_standard_input && result.job_empty && !installed.FinishHostRun(child.job.Get())) result.error = ERROR_INVALID_STATE;
  } catch (...) {
    result.error = ERROR_NOT_ENOUGH_MEMORY;
    result.job_empty = !child.process.Valid();
  }
  return result;
}
}  // namespace goatcitadel::worker_host
