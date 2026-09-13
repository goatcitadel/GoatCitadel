#include "tls_key.hpp"
#include <bcrypt.h>
#include <cwchar>
#include <cstring>
#include <new>

namespace goatcitadel::worker_tls {
namespace {
class Handle {
 public:
  Handle() noexcept = default;
  explicit Handle(HANDLE value) noexcept : value_(value) {}
  ~Handle() { Reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE Get() const noexcept { return value_; }
  bool Valid() const noexcept { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  void Reset(HANDLE value = nullptr) noexcept {
    if (Valid()) CloseHandle(value_);
    value_ = value;
  }
  HANDLE Release() noexcept { const HANDLE value = value_; value_ = nullptr; return value; }
 private:
  HANDLE value_ = nullptr;
};

struct PinnedPath {
  // Retain every directory without delete sharing until the owned child exits.
  std::array<Handle, kMaximumHelperPathCharacters / 2 + 1> directories;
  Handle image;
};

bool IsDiskObject(HANDLE handle, bool directory) noexcept {
  FILE_ATTRIBUTE_TAG_INFO info{};
  return GetFileType(handle) == FILE_TYPE_DISK &&
      GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)) &&
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
      ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory;
}

bool PinPath(const KeyAuthority& authority, PinnedPath* output) noexcept {
  const auto& path = authority.helper_path;
  const std::size_t length = wcsnlen_s(path.data(), path.size());
  if (length < 4 || length > kMaximumHelperPathCharacters || path[1] != L':' || path[2] != L'\\') return false;
  std::array<wchar_t, kMaximumHelperPathCharacters + 1> component{};
  std::memcpy(component.data(), path.data(), 3 * sizeof(wchar_t));
  if (GetDriveTypeW(component.data()) != DRIVE_FIXED) return false;
  std::size_t directory_count = 0;
  for (std::size_t i = 3; i <= length; ++i) {
    if (i != 3 && (i == length || path[i] != L'\\')) continue;
    std::memcpy(component.data(), path.data(), i * sizeof(wchar_t));
    component[i] = L'\0';
    auto& directory = output->directories[directory_count++];
    directory.Reset(CreateFileW(component.data(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!directory.Valid() || !IsDiskObject(directory.Get(), true)) return false;
  }
  output->image.Reset(CreateFileW(path.data(), GENERIC_READ, FILE_SHARE_READ, nullptr,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (!output->image.Valid() || !IsDiskObject(output->image.Get(), false)) return false;
  std::array<wchar_t, kMaximumHelperPathCharacters + 5> final_path{};
  const DWORD final_length = GetFinalPathNameByHandleW(output->image.Get(), final_path.data(),
      static_cast<DWORD>(final_path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  return final_length == length + 4 && std::memcmp(final_path.data(), L"\\\\?\\", 4 * sizeof(wchar_t)) == 0 &&
      CompareStringOrdinal(final_path.data() + 4, static_cast<int>(length), path.data(),
          static_cast<int>(length), TRUE) == CSTR_EQUAL;
}

bool SameFile(HANDLE a, HANDLE b) noexcept {
  FILE_ID_INFO first{}, second{};
  return GetFileInformationByHandleEx(a, FileIdInfo, &first, sizeof(first)) &&
      GetFileInformationByHandleEx(b, FileIdInfo, &second, sizeof(second)) &&
      first.VolumeSerialNumber == second.VolumeSerialNumber &&
      std::memcmp(&first.FileId, &second.FileId, sizeof(first.FileId)) == 0;
}

bool VerifyImage(HANDLE image, const std::array<std::uint8_t, 32>& expected) noexcept {
  LARGE_INTEGER size{}, start{};
  if (!GetFileSizeEx(image, &size) || size.QuadPart <= 0 || size.QuadPart > 8 * 1024 * 1024 ||
      !SetFilePointerEx(image, start, nullptr, FILE_BEGIN)) return false;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &hash, nullptr, 0, nullptr, 0, 0) < 0) return false;
  std::array<std::uint8_t, 65536> buffer{};
  std::uint64_t total = 0;
  bool ok = true;
  while (total < static_cast<std::uint64_t>(size.QuadPart)) {
    DWORD read = 0;
    if (!ReadFile(image, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) || read == 0 ||
        BCryptHashData(hash, buffer.data(), read, 0) < 0) { ok = false; break; }
    total += read;
  }
  std::array<std::uint8_t, 32> observed{};
  ok = ok && total == static_cast<std::uint64_t>(size.QuadPart) &&
      BCryptFinishHash(hash, observed.data(), static_cast<ULONG>(observed.size()), 0) >= 0 && observed == expected;
  BCryptDestroyHash(hash);
  return ok;
}

bool Pipe(Handle* read, Handle* write, bool parent_reads) noexcept {
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  HANDLE a = nullptr, b = nullptr;
  if (!CreatePipe(&a, &b, &security, 4096)) return false;
  read->Reset(a); write->Reset(b);
  return SetHandleInformation(parent_reads ? a : b, HANDLE_FLAG_INHERIT, 0) != FALSE;
}

class Attributes {
 public:
  ~Attributes() {
    if (initialized_) DeleteProcThreadAttributeList(list_);
    if (list_) HeapFree(GetProcessHeap(), 0, list_);
  }
  bool Initialize(HANDLE* handles, std::size_t count) noexcept {
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    if (!bytes) return false;
    list_ = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
    if (!list_) return false;
    initialized_ = InitializeProcThreadAttributeList(list_, 1, 0, &bytes) != FALSE;
    return initialized_ && UpdateProcThreadAttribute(list_, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles, count * sizeof(HANDLE), nullptr, nullptr) != FALSE;
  }
  LPPROC_THREAD_ATTRIBUTE_LIST Get() const noexcept { return list_; }
 private:
  LPPROC_THREAD_ATTRIBUTE_LIST list_ = nullptr;
  bool initialized_ = false;
};

class OwnedChild {
 public:
  Handle process, thread, job;
  ~OwnedChild() { Stop(); }
  bool Stop() noexcept {
    if (!process.Valid()) return true;
    if (WaitForSingleObject(process.Get(), 0) != WAIT_OBJECT_0) {
      if (job.Valid()) TerminateJobObject(job.Get(), ERROR_OPERATION_ABORTED);
      // Assignment to the job can fail while the new process is still suspended.
      TerminateProcess(process.Get(), ERROR_OPERATION_ABORTED);
    }
    const bool stopped = WaitForSingleObject(process.Get(), kTerminationTimeoutMs) == WAIT_OBJECT_0;
    return stopped;
  }
};

bool Drain(HANDLE pipe, std::uint8_t* output, std::size_t capacity,
    std::size_t* used, bool* eof) noexcept {
  if (*eof) return true;
  DWORD available = 0;
  if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
    *eof = GetLastError() == ERROR_BROKEN_PIPE;
    return *eof;
  }
  if (available > capacity - *used) return false;
  if (!available) return true;
  DWORD read = 0;
  if (!ReadFile(pipe, output + *used, available, &read, nullptr) || read != available) return false;
  *used += read;
  return true;
}
}  // namespace

struct PinnedImageLease final { PinnedPath path; };

PinnedImageLease* RetainPinnedImage(const KeyAuthority& authority) noexcept {
  auto* lease = new (std::nothrow) PinnedImageLease;
  if (!lease) return nullptr;
  if (!PinPath(authority, &lease->path) || !VerifyImage(lease->path.image.Get(), authority.helper_sha256)) {
    delete lease;
    return nullptr;
  }
  return lease;
}

void ReleasePinnedImage(PinnedImageLease* lease) noexcept { delete lease; }

HANDLE OpenPinnedHelper(const KeyAuthority& authority) noexcept {
  PinnedPath pinned;
  if (!PinPath(authority, &pinned) || !VerifyImage(pinned.image.Get(), authority.helper_sha256)) return INVALID_HANDLE_VALUE;
  return pinned.image.Release();
}

bool SignWithPinnedHelper(const KeyAuthority& authority, HANDLE pinned_image,
    const std::uint8_t* preimage, std::size_t length, std::array<std::uint8_t, 64>* signature) noexcept {
  if (!signature) return false;
  signature->fill(0);
  const ULONGLONG deadline = GetTickCount64() + kOperationTimeoutMs;
  std::array<std::uint8_t, kRequestBytes> request{};
  PinnedPath pinned;
  if (!BuildRequest(authority, preimage, length, &request) || !PinPath(authority, &pinned) ||
      !SameFile(pinned_image, pinned.image.Get()) || !VerifyImage(pinned.image.Get(), authority.helper_sha256) ||
      GetTickCount64() >= deadline) return false;
  Handle stdin_read, stdin_write, stdout_read, stdout_write, stderr_read, stderr_write;
  if (!Pipe(&stdin_read, &stdin_write, false) || !Pipe(&stdout_read, &stdout_write, true) ||
      !Pipe(&stderr_read, &stderr_write, true)) return false;
  HANDLE inherited[] = {stdin_read.Get(), stdout_write.Get(), stderr_write.Get()};
  Attributes attributes;
  if (!attributes.Initialize(inherited, 3)) return false;
  OwnedChild child;
  child.job.Reset(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  if (!child.job.Valid() || !SetInformationJobObject(child.job.Get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return false;
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = stdin_read.Get();
  startup.StartupInfo.hStdOutput = stdout_write.Get();
  startup.StartupInfo.hStdError = stderr_write.Get();
  startup.lpAttributeList = attributes.Get();
  std::array<wchar_t, kMaximumHelperPathCharacters + 32> command{};
  if (swprintf_s(command.data(), command.size(), L"\"%ls\" --service-stdio", authority.helper_path.data()) <= 0) return false;
  std::array<wchar_t, MAX_PATH + 1> directory{};
  const UINT directory_length = GetSystemDirectoryW(directory.data(), static_cast<UINT>(directory.size()));
  if (!directory_length || directory_length >= directory.size()) return false;
  wchar_t environment[2]{};
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(authority.helper_path.data(), command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      environment, directory.data(), &startup.StartupInfo, &process)) return false;
  child.process.Reset(process.hProcess); child.thread.Reset(process.hThread);
  stdin_read.Reset(); stdout_write.Reset(); stderr_write.Reset();
  if (!AssignProcessToJobObject(child.job.Get(), child.process.Get())) return false;
  DWORD written = 0;
  // The only write is smaller than the new, empty pipe's 4096-byte capacity.
  if (!WriteFile(stdin_write.Get(), request.data(), static_cast<DWORD>(request.size()), &written, nullptr) ||
      written != request.size()) return false;
  stdin_write.Reset();
  if (GetTickCount64() >= deadline || ResumeThread(child.thread.Get()) == static_cast<DWORD>(-1)) return false;
  std::array<std::uint8_t, kResponseBytes> response{};
  std::uint8_t unused = 0;
  std::size_t received = 0, errors = 0;
  bool stdout_eof = false, stderr_eof = false;
  for (;;) {
    if (GetTickCount64() >= deadline || !Drain(stdout_read.Get(), response.data(), response.size(), &received, &stdout_eof) ||
        !Drain(stderr_read.Get(), &unused, 0, &errors, &stderr_eof)) return false;
    const DWORD wait = WaitForSingleObject(child.process.Get(), 10);
    if (wait != WAIT_TIMEOUT && wait != WAIT_OBJECT_0) return false;
    if (wait == WAIT_OBJECT_0 && stdout_eof && stderr_eof) {
      DWORD code = 1;
      if (!GetExitCodeProcess(child.process.Get(), &code) || code != 0 || received != response.size() ||
          !child.Stop() || GetTickCount64() >= deadline) return false;
      return DecodeResponse(authority, response, signature);
    }
  }
}
}  // namespace goatcitadel::worker_tls
