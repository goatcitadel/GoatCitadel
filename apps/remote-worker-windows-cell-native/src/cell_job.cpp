#include "cell_job.hpp"
#include "cell_job_stdio_internal.hpp"
#include <sddl.h>
#include <userenv.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <cwchar>
#include <limits>
#include <utility>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr DWORD kDrainDeadlineMs = 5000;
constexpr DWORD kMaximumDiagnostics = 65536;
constexpr std::uint64_t kMaximumRawOutput = 64ULL * 1024 * 1024;
class Handle final {
 public:
  explicit Handle(HANDLE value = nullptr) noexcept : value_(value) {}
  ~Handle() { Reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE Get() const noexcept { return value_; }
  bool Valid() const noexcept { return value_ && value_ != INVALID_HANDLE_VALUE; }
  void Reset(HANDLE value = nullptr) noexcept {
    if (Valid()) CloseHandle(value_);
    value_ = value;
  }
 private:
  HANDLE value_;
};
class LocalMemory final {
 public:
  ~LocalMemory() { if (value) LocalFree(value); }
  void* value = nullptr;
};
class AppContainerSid final {
 public:
  ~AppContainerSid() { if (value) FreeSid(value); }
  PSID value = nullptr;
};
struct Attributes final {
  std::vector<std::uint8_t> memory;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
  bool Initialize(HANDLE (&inherited)[3], HANDLE* job, SECURITY_CAPABILITIES* security) {
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 3, 0, &bytes);
    if (!bytes || bytes > 65536) return false;
    memory.resize(bytes);
    auto* candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());
    if (!InitializeProcThreadAttributeList(candidate, 3, 0, &bytes)) return false;
    list = candidate;
    return UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited, sizeof(inherited), nullptr, nullptr) &&
      UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, job, sizeof(HANDLE), nullptr, nullptr) &&
      UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        security, sizeof(*security), nullptr, nullptr);
  }
};
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
DWORD TokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS kind, DWORD minimum, std::vector<std::uint8_t>* data) {
  DWORD bytes = 0;
  if (GetTokenInformation(token, kind, nullptr, 0, &bytes) || GetLastError() != ERROR_INSUFFICIENT_BUFFER ||
      bytes < minimum || bytes > 65536) return ERROR_INVALID_DATA;
  data->resize(bytes);
  if (!GetTokenInformation(token, kind, data->data(), bytes, &bytes)) return Error();
  return bytes >= minimum && bytes <= data->size() ? ERROR_SUCCESS : ERROR_INVALID_DATA;
}
DWORD VerifyAppContainer(HANDLE process, PSID expected) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw_token)) return Error();
  Handle token(raw_token);
  DWORD is_container = 0, bytes = 0;
  if (!GetTokenInformation(token.Get(), TokenIsAppContainer, &is_container, sizeof(is_container), &bytes)) return Error();
  if (bytes != sizeof(is_container) || is_container != 1) return ERROR_INVALID_SID;
  std::vector<std::uint8_t> information;
  DWORD error = TokenInformation(token.Get(), TokenAppContainerSid, sizeof(TOKEN_APPCONTAINER_INFORMATION), &information);
  if (error) return error;
  const auto* identity = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(information.data());
  if (!identity->TokenAppContainer || !IsValidSid(identity->TokenAppContainer) ||
      !EqualSid(identity->TokenAppContainer, expected)) return ERROR_INVALID_SID;
  error = TokenInformation(token.Get(), TokenCapabilities, sizeof(DWORD), &information);
  if (error) return error;
  if (reinterpret_cast<const TOKEN_GROUPS*>(information.data())->GroupCount != 0) return ERROR_ACCESS_DENIED;
  error = TokenInformation(token.Get(), TokenIntegrityLevel, sizeof(TOKEN_MANDATORY_LABEL), &information);
  if (error) return error;
  const PSID integrity = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(information.data())->Label.Sid;
  if (!integrity || !IsValidSid(integrity) || *GetSidSubAuthorityCount(integrity) != 1 ||
      *GetSidSubAuthority(integrity, 0) != SECURITY_MANDATORY_LOW_RID) return ERROR_ACCESS_DENIED;
  return ERROR_SUCCESS;
}
bool ValidEnvironment(const std::vector<wchar_t>& block) {
  if (block.size() < 2 || block.size() > 32767 || block.back() || block[block.size() - 2]) return false;
  if (block[0] == L'\0') return block.size() == 2;
  std::vector<std::wstring> names;
  for (std::size_t begin = 0; begin + 1 < block.size();) {
    const auto end = std::find(block.begin() + begin, block.end(), L'\0');
    const std::wstring entry(block.begin() + begin, end);
    const auto equals = entry.find(L'=');
    if (!equals || equals == std::wstring::npos) return false;
    const auto name = entry.substr(0, equals);
    for (wchar_t value : name) if (!((value >= L'A' && value <= L'Z') ||
        (value >= L'a' && value <= L'z') || (value >= L'0' && value <= L'9') || value == L'_')) return false;
    for (const auto& previous : names)
      if (CompareStringOrdinal(previous.c_str(), -1, name.c_str(), -1, TRUE) == CSTR_EQUAL) return false;
    names.push_back(name);
    begin = static_cast<std::size_t>(end - block.begin()) + 1;
    if (block[begin] == L'\0') return begin + 1 == block.size();
  }
  return false;
}
bool Valid(const JobCommand& command, const JobLimits& limits) {
  if (command.job_name.size() != 40 || command.job_name.compare(0, 8, L"gc-cell-") != 0) return false;
  for (std::size_t index = 8; index < command.job_name.size(); ++index) {
    const wchar_t value = command.job_name[index];
    if (!((value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'f'))) return false;
  }
  if (command.app_container_name != L"GoatCitadel.Worker." + command.job_name.substr(8)) return false;
  return IsLiteralCellPath(command.image) && IsLiteralCellPath(command.directory) &&
    !command.command_line.empty() && command.command_line.size() < 32767 &&
    command.command_line.find(L'\0') == std::wstring::npos && ValidEnvironment(command.environment) &&
    limits.process_limit > 0 && limits.process_limit <= 4096 && limits.memory_bytes > 0 &&
    limits.memory_bytes <= std::numeric_limits<SIZE_T>::max() && limits.cpu_milli > 0 &&
    limits.wall_ms > 0 && limits.wall_ms <= 86'400'000 && limits.raw_output_bytes > 0 &&
    limits.raw_output_bytes <= kMaximumRawOutput && limits.diagnostic_bytes <= kMaximumDiagnostics &&
    limits.diagnostic_bytes <= limits.raw_output_bytes && limits.input_bytes <= kMaximumCellJobInputBytes &&
    command.standard_input.size() <= limits.input_bytes;
}
DWORD PrivateDescriptor(LocalMemory* descriptor) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) return Error();
  Handle token(raw_token);
  DWORD bytes = 0;
  GetTokenInformation(token.Get(), TokenUser, nullptr, 0, &bytes);
  if (!bytes || bytes > 65536) return ERROR_INVALID_DATA;
  std::vector<std::uint8_t> user(bytes);
  if (!GetTokenInformation(token.Get(), TokenUser, user.data(), bytes, &bytes)) return Error();
  LPWSTR sid_text = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid_text)) return Error();
  LocalMemory sid;
  sid.value = sid_text;
  const std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(sid_text) + L")";
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &raw_descriptor, nullptr)) return Error();
  descriptor->value = raw_descriptor;
  return ERROR_SUCCESS;
}
DWORD PrivateJob(const std::wstring& name, Handle* job) {
  LocalMemory descriptor;
  const DWORD descriptor_error = PrivateDescriptor(&descriptor);
  if (descriptor_error) return descriptor_error;
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
  SetLastError(ERROR_SUCCESS);
  const HANDLE created = CreateJobObjectW(&attributes, (L"Local\\" + name).c_str());
  const DWORD error = GetLastError();
  if (!created) return error ? error : ERROR_GEN_FAILURE;
  if (error == ERROR_ALREADY_EXISTS) { CloseHandle(created); return ERROR_ALREADY_EXISTS; }
  job->Reset(created);
  return ERROR_SUCCESS;
}
bool MakePipe(Handle* reader, Handle* writer) {
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
  HANDLE read = nullptr, write = nullptr;
  if (!CreatePipe(&read, &write, &attributes, 4096)) return false;
  reader->Reset(read);
  writer->Reset(write);
  return SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0) != FALSE;
}
// Anonymous pipes cannot perform overlapped writes. A private, first-instance
// named pipe lets the same owner pump stdin and output while enforcing deadlines.
// Only its read handle is inherited. Names carry no authority and are never sent
// to the child; both endpoints must belong to this process before any write.
class InputPipe final {
 public:
  ~InputPipe() { Cancel(); }
  DWORD Open(const std::vector<std::uint8_t>& bytes, JobStdioChannel* stdio) {
    bytes_ = &bytes;
    stdio_ = stdio;
    input_closed_ = bytes.empty() && !stdio;
    SECURITY_ATTRIBUTES inherited{sizeof(inherited), nullptr, TRUE};
    if (input_closed_) {
      reader_.Reset(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &inherited, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
      return reader_.Valid() ? ERROR_SUCCESS : Error();
    }
    LocalMemory descriptor;
    DWORD error = PrivateDescriptor(&descriptor);
    if (error) return error;
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), descriptor.value, FALSE};
    std::array<std::uint8_t, 16> random{};
    if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return ERROR_GEN_FAILURE;
    std::wstring name = L"\\\\.\\pipe\\LOCAL\\gc-cell-stdin-";
    constexpr wchar_t hex[] = L"0123456789abcdef";
    for (const auto byte : random) { name += hex[byte >> 4]; name += hex[byte & 15]; }
    writer_.Reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE |
      FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 4096, 4096, 0, &attributes));
    if (!writer_.Valid()) return Error();
    event_.Reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event_.Valid()) return Error();
    operation_.hEvent = event_.Get();
    reader_.Reset(CreateFileW(name.c_str(), GENERIC_READ, 0, &inherited, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (!reader_.Valid()) return Error();
    if (!ConnectNamedPipe(writer_.Get(), &operation_)) {
      error = Error();
      if (error == ERROR_IO_PENDING) { pending_ = true; return ERROR_INVALID_DATA; }
      if (error != ERROR_PIPE_CONNECTED) return error;
    }
    ULONG peer = 0;
    if (!GetNamedPipeClientProcessId(writer_.Get(), &peer) || peer != GetCurrentProcessId() ||
        !GetNamedPipeServerProcessId(reader_.Get(), &peer) || peer != GetCurrentProcessId()) return ERROR_ACCESS_DENIED;
    return ERROR_SUCCESS;
  }
  HANDLE ChildHandle() const noexcept { return reader_.Get(); }
  void ReleaseChildHandle() noexcept { reader_.Reset(); }
  std::uint64_t Written() const noexcept { return written_; }
  bool Complete() const noexcept { return input_closed_ && chunk_written_ == chunk_size_ && !pending_; }
  DWORD Pump() noexcept {
    if (pending_) {
      DWORD written = 0;
      if (!GetOverlappedResult(writer_.Get(), &operation_, &written, FALSE)) {
        const DWORD error = Error();
        if (error == ERROR_IO_INCOMPLETE) return ERROR_SUCCESS;
        pending_ = false;
        return error;
      }
      pending_ = false;
      if (!written || written > chunk_size_ - chunk_written_) return ERROR_WRITE_FAULT;
      written_ += written;
      chunk_written_ += written;
    }
    if (Complete()) { writer_.Reset(); return ERROR_SUCCESS; }
    if (chunk_written_ == chunk_size_) {
      chunk_size_ = 0; chunk_written_ = 0;
      if (stdio_) {
        const DWORD error = JobStdioAccess::TakeInput(*stdio_, chunk_.data(), static_cast<DWORD>(chunk_.size()),
          &chunk_size_, &input_closed_);
        if (error) return error;
      } else {
        chunk_size_ = static_cast<DWORD>(std::min<std::size_t>(chunk_.size(), bytes_->size() - written_));
        std::copy_n(bytes_->data() + written_, chunk_size_, chunk_.data());
        input_closed_ = written_ + chunk_size_ == bytes_->size();
      }
      if (Complete()) { writer_.Reset(); return ERROR_SUCCESS; }
      // An empty live queue is not EOF. Output and cancellation still progress.
      if (!chunk_size_) return ERROR_SUCCESS;
    }
    if (!ResetEvent(event_.Get())) return Error();
    if (!WriteFile(writer_.Get(), chunk_.data() + chunk_written_, chunk_size_ - chunk_written_, nullptr, &operation_)) {
      const DWORD error = Error();
      if (error != ERROR_IO_PENDING) return error;
    }
    pending_ = true;
    return ERROR_SUCCESS;
  }
  void Cancel() noexcept {
    if (pending_) {
      // Cancellation is not completion. Retain OVERLAPPED and its buffer until
      // the exact local pipe operation has finished, even when cancellation races.
      CancelIoEx(writer_.Get(), &operation_);
      DWORD written = 0;
      if (GetOverlappedResult(writer_.Get(), &operation_, &written, TRUE) && written <= chunk_size_ - chunk_written_) {
        written_ += written;
        chunk_written_ += written;
      }
      pending_ = false;
    }
    writer_.Reset();
  }
 private:
  Handle reader_, writer_, event_;
  OVERLAPPED operation_{};
  const std::vector<std::uint8_t>* bytes_ = nullptr;
  JobStdioChannel* stdio_ = nullptr;
  std::array<std::uint8_t, 4096> chunk_{};
  DWORD chunk_size_ = 0, chunk_written_ = 0;
  std::size_t written_ = 0;
  bool pending_ = false, input_closed_ = false;
};
void Capture(OutputCapture* output, const std::uint8_t* bytes, DWORD count, DWORD budget) {
  output->raw_bytes += count;
  const auto prefix_cap = budget / 2;
  const auto tail_cap = budget - prefix_cap;
  const auto prefix_count = std::min<std::size_t>(prefix_cap - output->prefix.size(), count);
  output->prefix.insert(output->prefix.end(), bytes, bytes + prefix_count);
  bytes += prefix_count;
  const std::size_t remaining = count - prefix_count;
  if (tail_cap && remaining) {
    if (remaining >= tail_cap) output->tail.assign(bytes + remaining - tail_cap, bytes + remaining);
    else {
      if (output->tail.size() + remaining > tail_cap)
        output->tail.erase(output->tail.begin(), output->tail.begin() + (output->tail.size() + remaining - tail_cap));
      output->tail.insert(output->tail.end(), bytes, bytes + remaining);
    }
  }
  output->truncated = output->raw_bytes > output->prefix.size() + output->tail.size();
}
DWORD Drain(HANDLE pipe, OutputCapture* output, DWORD budget, bool* ended,
             JobStdioChannel* stdio, JobOutputStream stream) {
  if (*ended) return ERROR_SUCCESS;
  DWORD available = 0;
  if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) {
    const DWORD error = Error();
    if (error == ERROR_BROKEN_PIPE) { *ended = true; return ERROR_SUCCESS; }
    return error;
  }
  if (!available) return ERROR_SUCCESS;
  std::array<std::uint8_t, 4096> bytes{};
  DWORD received = 0;
  if (!ReadFile(pipe, bytes.data(), std::min<DWORD>(available, static_cast<DWORD>(bytes.size())), &received, nullptr)) return Error();
  Capture(output, bytes.data(), received, budget);
  return stdio ? JobStdioAccess::PublishOutput(*stdio, stream, bytes.data(), received) : ERROR_SUCCESS;
}
DWORD Observe(HANDLE job, JobResult* result, DWORD* active) noexcept {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) ||
      !QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr)) return Error();
  *active = accounting.ActiveProcesses;
  result->sampled_peak_active_processes = std::max(result->sampled_peak_active_processes, *active);
  result->total_processes = accounting.TotalProcesses;
  result->peak_job_memory_bytes = std::max<std::uint64_t>(result->peak_job_memory_bytes, limits.PeakJobMemoryUsed);
  result->cpu_time_100ns = static_cast<std::uint64_t>(accounting.TotalKernelTime.QuadPart) +
    static_cast<std::uint64_t>(accounting.TotalUserTime.QuadPart);
  return ERROR_SUCCESS;
}
}

DWORD CpuRateForMilliCores(DWORD cpu_milli, DWORD active_processors) noexcept {
  if (!cpu_milli || !active_processors) return 0;
  return static_cast<DWORD>(std::min<std::uint64_t>(10000, static_cast<std::uint64_t>(cpu_milli) * 10 / active_processors));
}

JobResult RunBoundedJob(const JobCommand& command_input, const JobLimits& limits_input,
                        HANDLE cancellation, JobStdioChannel* stdio) noexcept {
  JobResult result;
  struct StdioLifetime final {
    JobStdioChannel* channel = nullptr;
    JobResult& result;
    ~StdioLifetime() { if (channel) JobStdioAccess::Finish(*channel,
      result.process_id == 0 || (result.zero_processes_verified && result.output_drained)); }
  } stdio_lifetime{nullptr, result};
  try {
    if (command_input.standard_input.size() > kMaximumCellJobInputBytes ||
        command_input.standard_input.size() > limits_input.input_bytes ||
        (stdio && !command_input.standard_input.empty())) {
      result.error = ERROR_INVALID_PARAMETER; return result;
    }
    const JobCommand command = command_input;
    const JobLimits limits = limits_input;
    if (!Valid(command, limits)) { result.error = ERROR_INVALID_PARAMETER; return result; }
    if (stdio) {
      result.error = JobStdioAccess::Begin(*stdio, limits.input_bytes);
      if (result.error) return result;
      stdio_lifetime.channel = stdio;
    }
    if (cancellation) {
      const DWORD status = WaitForSingleObject(cancellation, 0);
      if (status == WAIT_OBJECT_0) { result.end = JobEnd::cancelled; return result; }
      if (status != WAIT_TIMEOUT) { result.error = ERROR_INVALID_HANDLE; return result; }
    }
    const DWORD processors = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    result.configured_cpu_rate = CpuRateForMilliCores(limits.cpu_milli, processors);
    if (!result.configured_cpu_rate) { result.error = ERROR_NOT_SUPPORTED; return result; }
    PinnedCellLaunchFiles launch_files;
    result.error = launch_files.Open(command.image, command.directory,
      command.expected_image_sha256, command.expected_directory_identity);
    if (result.error) return result;
    result.launch_files_verified = true;
    // Provisioning owns profile creation and ACLs. Derivation does not create,
    // adopt or delete a profile and failure never falls back to caller identity.
    AppContainerSid app_container;
    const HRESULT derived = DeriveAppContainerSidFromAppContainerName(command.app_container_name.c_str(), &app_container.value);
    if (FAILED(derived) || !app_container.value || !IsValidSid(app_container.value)) {
      result.error = FAILED(derived) && HRESULT_FACILITY(derived) == FACILITY_WIN32 ? HRESULT_CODE(derived) : ERROR_INVALID_SID;
      return result;
    }
    SECURITY_CAPABILITIES security{};
    security.AppContainerSid = app_container.value;
    Handle job;
    result.error = PrivateJob(command.job_name, &job);
    if (result.error) return result;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits{};
    job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    job_limits.BasicLimitInformation.ActiveProcessLimit = limits.process_limit;
    job_limits.JobMemoryLimit = static_cast<SIZE_T>(limits.memory_bytes);
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
    cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
    cpu.CpuRate = result.configured_cpu_rate;
    if (!SetInformationJobObject(job.Get(), JobObjectExtendedLimitInformation, &job_limits, sizeof(job_limits)) ||
        !SetInformationJobObject(job.Get(), JobObjectCpuRateControlInformation, &cpu, sizeof(cpu))) {
      result.error = Error(); return result;
    }
    Handle output_read, output_write, error_read, error_write;
    if (!MakePipe(&output_read, &output_write) || !MakePipe(&error_read, &error_write)) {
      result.error = Error(); return result;
    }
    InputPipe input;
    result.error = input.Open(command.standard_input, stdio);
    if (result.error) return result;
    HANDLE inherited_handles[]{input.ChildHandle(), output_write.Get(), error_write.Get()};
    HANDLE job_handle = job.Get();
    Attributes attributes;
    if (!attributes.Initialize(inherited_handles, &job_handle, &security)) { result.error = Error(); return result; }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.StartupInfo.wShowWindow = SW_HIDE;
    startup.StartupInfo.hStdInput = input.ChildHandle();
    startup.StartupInfo.hStdOutput = output_write.Get();
    startup.StartupInfo.hStdError = error_write.Get();
    startup.lpAttributeList = attributes.list;
    auto command_line = command.command_line;
    auto environment = command.environment;
    PROCESS_INFORMATION created{};
    const ULONGLONG started = GetTickCount64();
    if (!CreateProcessW(launch_files.ProcessImagePath().c_str(), command_line.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
        environment.data(), launch_files.DirectoryPath().c_str(), &startup.StartupInfo, &created)) {
      result.error = Error();
      DWORD active = 0;
      if (Observe(job.Get(), &result, &active) == ERROR_SUCCESS && active == 0) result.zero_processes_verified = true;
      return result;
    }
    Handle process(created.hProcess), thread(created.hThread);
    result.process_id = created.dwProcessId;
    input.ReleaseChildHandle(); output_write.Reset(); error_write.Reset();
    BOOL contained = FALSE;
    DWORD active = 0;
    bool stopped = false;
    ULONGLONG draining_started = 0;
    auto stop = [&](JobEnd end, DWORD error) {
      if (stopped) return;
      stopped = true;
      result.end = end;
      result.error = error;
      draining_started = GetTickCount64();
      if (!TerminateJobObject(job.Get(), ERROR_PROCESS_ABORTED)) {
        result.end = JobEnd::control_failed;
        result.error = Error();
      }
      input.Cancel();
      result.standard_input_bytes_written = input.Written();
      result.standard_input_complete = input.Complete();
    };
    auto check_control = [&] {
      if (stopped) return;
      if (GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) != processors) stop(JobEnd::control_failed, ERROR_RETRY);
      if (cancellation) {
        const DWORD cancelled = WaitForSingleObject(cancellation, 0);
        if (cancelled == WAIT_OBJECT_0) stop(JobEnd::cancelled, ERROR_SUCCESS);
        else if (cancelled != WAIT_TIMEOUT) stop(JobEnd::control_failed, ERROR_INVALID_HANDLE);
      }
      if (GetTickCount64() - started >= limits.wall_ms) stop(JobEnd::wall_limit, ERROR_SUCCESS);
    };
    const DWORD identity_error = VerifyAppContainer(process.Get(), app_container.value);
    result.app_container_verified = identity_error == ERROR_SUCCESS;
    const DWORD image_error = launch_files.VerifyProcessImage(process.Get());
    result.process_image_verified = image_error == ERROR_SUCCESS;
    if (identity_error || image_error) stop(JobEnd::control_failed, identity_error ? identity_error : image_error);
    else if (!IsProcessInJob(process.Get(), job.Get(), &contained) || !contained ||
        Observe(job.Get(), &result, &active) != ERROR_SUCCESS || active != 1) {
      stop(JobEnd::control_failed, ERROR_INVALID_DATA);
    } else {
      check_control();
      if (!stopped) {
        if (ResumeThread(thread.Get()) == static_cast<DWORD>(-1)) stop(JobEnd::launch_failed, Error());
        else result.end = JobEnd::exited;
      }
    }
    thread.Reset();
    bool output_ended = false, error_ended = false;
    for (;;) {
      if (WaitForSingleObject(process.Get(), 0) == WAIT_TIMEOUT) check_control();
      if (!stopped) {
        const DWORD input_error = input.Pump();
        result.standard_input_bytes_written = input.Written();
        result.standard_input_complete = input.Complete();
        if (input_error) stop(JobEnd::control_failed, input_error);
      }
      const DWORD output_error = Drain(output_read.Get(), &result.standard_output, limits.diagnostic_bytes / 2, &output_ended,
        stopped ? nullptr : stdio, JobOutputStream::standard_output);
      const DWORD error_error = Drain(error_read.Get(), &result.standard_error,
        limits.diagnostic_bytes - limits.diagnostic_bytes / 2, &error_ended,
        stopped ? nullptr : stdio, JobOutputStream::standard_error);
      if (output_error || error_error) {
        const DWORD error = output_error ? output_error : error_error;
        stop(error == ERROR_NOT_ENOUGH_QUOTA ? JobEnd::output_limit : JobEnd::control_failed, error);
      }
      if (result.standard_output.raw_bytes + result.standard_error.raw_bytes > limits.raw_output_bytes)
        stop(JobEnd::output_limit, ERROR_SUCCESS);
      const DWORD observed = Observe(job.Get(), &result, &active);
      result.zero_processes_verified = !observed && active == 0;
      if (observed) stop(JobEnd::control_failed, observed);
      const DWORD process_state = WaitForSingleObject(process.Get(), 0);
      if (process_state != WAIT_OBJECT_0 && process_state != WAIT_TIMEOUT) stop(JobEnd::control_failed, ERROR_INVALID_HANDLE);
      if (process_state == WAIT_OBJECT_0) {
        if (!GetExitCodeProcess(process.Get(), &result.process_exit_code)) stop(JobEnd::control_failed, Error());
        if (!input.Complete()) stop(JobEnd::control_failed, ERROR_BROKEN_PIPE);
        if (!observed && active) {
          result.terminated_descendants = true;
          stop(result.end, result.error);
        }
      }
      if (!observed && active == 0) {
        result.zero_processes_verified = true;
        if (!draining_started) draining_started = GetTickCount64();
        if (process_state == WAIT_OBJECT_0 && output_ended && error_ended) { result.output_drained = true; return result; }
      }
      if (draining_started && GetTickCount64() - draining_started >= kDrainDeadlineMs) {
        result.end = JobEnd::control_failed;
        result.error = ERROR_TIMEOUT;
        return result;
      }
      Sleep(2);
    }
  } catch (...) {
    // Stack unwinding closes the only owned job handle; kill-on-close is the
    // crash fallback. Without a successful final query, never claim zero liveness.
    result.end = JobEnd::control_failed;
    result.error = ERROR_NOT_ENOUGH_MEMORY;
    result.zero_processes_verified = false;
    result.output_drained = false;
    return result;
  }
}
}  // namespace goatcitadel::worker_cell
