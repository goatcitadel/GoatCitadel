#include "cell_job.hpp"
#include "appcontainer_fixture.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <thread>
#include <stdexcept>
#include <type_traits>

using namespace goatcitadel::worker_cell;
using namespace goatcitadel::worker_cell_test;
unsigned RunCellFilesystemTests(const std::wstring& source_image);
void RequireVolumeAttachmentPrivilege();
int RunCellVirtualDiskRecoveryFixture(int argc, wchar_t** argv);
int RunCellProvisioningRecoveryFixture(int argc, wchar_t** argv);
bool CellProvisioningRecoveryProcessVerified();
std::string CellProvisioningCheckpointRecordsJson();
std::string CellProvisioningDiskLayoutIdsHex();
std::string CellVolumeProvisioningRecordsJson();
std::string CellVolumeProvisioningCoreRecordsJson();
std::string CellFormatProvisioningHistoryJson();
std::string CellProtectionProvisioningHistoryJson();
std::string CellMountProvisioningHistoryJson();
std::string CellMountedWorkspaceProvisioningHistoryJson();
unsigned RunCellMountedWorkspaceJournalTests(const std::wstring& directory);
unsigned RunCellHostCapacityJournalFixture(const std::wstring& directory);
unsigned RunCellProvisioningJournalFixture(const std::wstring& directory);
unsigned RunCellRuntimeDispatchTests();
bool CellVirtualDiskRecoveryProcessVerified();
bool CellVirtualDiskAttachmentRecoveryVerified();
bool CellVirtualDiskDeviceBindingVerified();
unsigned CellVirtualDiskDeviceMetadataChecks();
unsigned RunCellVirtualDiskLayoutTests();
unsigned RunCellVirtualDiskVolumeTests();
unsigned RunCellNtfsFormatTests();
std::string CellDiskLayoutCheckpointRecordsJson();
unsigned RunCellJobInputTests(const std::wstring& image,
  JobCommand (*command)(const std::wstring&, const std::wstring&), JobLimits limits);
unsigned RunCellJobStdioTests(const std::wstring& image,
  JobCommand (*command)(const std::wstring&, const std::wstring&), JobLimits limits);
unsigned RunCellWorkspaceTests(const JobCommand& command, DWORD& explicit_create, DWORD& explicit_dacl,
  unsigned& disk_checks, unsigned& attachment_checks, unsigned& journal_checks, bool live_attachment, bool include_journal = true);
unsigned RunCellRuntimeBundleTests(const std::wstring& image,
  JobCommand (*command)(const std::wstring&, const std::wstring&), CellFileSha256& golden);
namespace {
unsigned checks = 0, sequence = 0;
void Check(bool condition, const char* description) {
  ++checks;
  if (!condition) throw std::runtime_error(std::string(description) + " (check " + std::to_string(checks) + ")");
}
std::wstring Quote(const std::wstring& value) { return L"\"" + value + L"\""; }
JobCommand Command(const std::wstring& image, const std::wstring& arguments) {
  std::array<wchar_t, 48> name{};
  swprintf_s(name.data(), name.size(), L"gc-cell-%016llx%016llx",
    static_cast<unsigned long long>(GetCurrentProcessId()),
    static_cast<unsigned long long>(GetTickCount64()) + ++sequence);
  JobCommand command;
  command.job_name = name.data();
  command.image = image;
  command.command_line = Quote(image) + L" " + arguments;
  command.directory = image.substr(0, image.find_last_of(L'\\'));
  command.app_container_name = PrepareAppContainer(command.job_name, image);
  BindLaunchFixture(&command);
  // Explicit Windows runtime values only. AppContainer process creation needs
  // LOCALAPPDATA in the child block; the caller's ambient block stays excluded.
  std::array<wchar_t, MAX_PATH> windows{};
  const UINT length = GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  if (!length || length >= windows.size()) throw std::runtime_error("Resolve fixture SystemRoot failed.");
  const std::wstring system_root = L"SystemRoot=" + std::wstring(windows.data());
  command.environment.assign(system_root.begin(), system_root.end());
  command.environment.push_back(L'\0');
  for (const wchar_t* key : {L"LOCALAPPDATA=", L"TEMP=", L"TMP="}) {
    const std::wstring entry = key + command.directory;
    command.environment.insert(command.environment.end(), entry.begin(), entry.end());
    command.environment.push_back(L'\0');
  }
  command.environment.push_back(L'\0');
  return command;
}
JobLimits Limits() { return {3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 1024}; }
std::string Text(const OutputCapture& output) {
  return std::string(output.prefix.begin(), output.prefix.end()) + std::string(output.tail.begin(), output.tail.end());
}
void Exited(const JobResult& result) {
  if (result.error || result.end != JobEnd::exited || result.process_exit_code > 255)
    std::fprintf(stderr, "Native result: error=%lu end=%u pid=%lu exit=%lu token=%d zero=%d drained=%d stdout=%s stderr=%s\n",
      result.error, static_cast<unsigned>(result.end), result.process_id, result.process_exit_code,
      result.app_container_verified, result.zero_processes_verified, result.output_drained,
      Text(result.standard_output).c_str(), Text(result.standard_error).c_str());
  Check(result.error == ERROR_SUCCESS, "native API succeeded");
  Check(result.end == JobEnd::exited, "entry process exited normally");
  Check(result.zero_processes_verified, "exact retained job has zero active processes");
  Check(result.output_drained, "both output pipes reach EOF");
  Check(result.app_container_verified, "actual child token has the expected AppContainer identity and no capabilities");
  Check(result.launch_files_verified, "native launch holds the admitted image and directory identities");
  Check(result.process_image_verified, "suspended process image matches the pinned native image before resume");
}
static_assert(!std::is_default_constructible_v<JobQuiescence> && !std::is_copy_constructible_v<JobQuiescence>);
unsigned RunExecutionAuthorityTests(const std::wstring& image) {
  const auto before = checks;
  struct State final {
    unsigned calls = 0, captures = 0, deny_at = 0, mode = 0;
    HANDLE stop = nullptr;
    JobQuiescenceObserver* caller = nullptr;
    static DWORD Execute(void* raw) noexcept {
      auto& self = *static_cast<State*>(raw); ++self.calls;
      if (self.mode == 4) self.caller->authorize_execution = nullptr;
      if ((self.mode == 5 && self.calls == 1) || (self.mode == 6 && self.calls == 2)) SetEvent(self.stop);
      if (self.mode == 7) Sleep(100);
      return self.deny_at && self.calls >= self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Authorize(void* raw) noexcept {
      const auto& self = *static_cast<State*>(raw);
      return self.deny_at && self.calls >= self.deny_at ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
    }
    static DWORD Capture(void* raw, const JobQuiescence& job) noexcept {
      ++static_cast<State*>(raw)->captures; return job.Check();
    }
    static void Discard(void*) noexcept {}
  };
  for (unsigned mode = 0; mode < 8; ++mode) {
    State state; state.mode = mode;
    state.deny_at = mode >= 1 && mode <= 3 ? mode : mode == 4 ? 2 : 0;
    state.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Check(state.stop != nullptr, "Create execution authority fixture cancellation event");
    JobQuiescenceObserver observer{&state, State::Authorize, State::Capture, State::Discard, 10000, State::Execute};
    state.caller = &observer;
    auto limits = Limits(); if (mode == 7) limits.wall_ms = 50;
    const auto result = RunBoundedJob(Command(image, mode == 3 ? L"sleep" : L"exit"), limits, state.stop, nullptr, &observer);
    CloseHandle(state.stop);
    if (!mode) {
      Exited(result);
      Check(state.calls >= 2 && state.captures == 1 && result.quiescent_capture_verified && Text(result.standard_output) == "finished\r\n",
        "Admitted job checks execution before creation and resume, then separately captures quiescent output");
    } else {
      Check(!state.captures && !result.quiescent_capture_verified, "Revoked execution or cancellation cannot release capture");
      if (mode <= 4) Check(result.error == ERROR_ACCESS_DENIED && result.end == JobEnd::control_failed && state.calls == state.deny_at,
        "Execution denial remains authoritative before creation, before resume, while running and after caller callback mutation");
      else Check(result.error == (mode == 7 ? DWORD{ERROR_TIMEOUT} : DWORD{ERROR_OPERATION_ABORTED}), "Cancellation and elapsed wall limit rechecked after blocking authorization");
      if (mode == 1 || mode == 5 || mode == 7) Check(!result.process_id && !result.standard_output.raw_bytes,
        "Prelaunch denial or expired authority creates no child");
      else {
        Check(result.process_id && result.zero_processes_verified && result.output_drained,
          "Revocation joins the exact owned job and drains its pipes");
        if (mode != 3) Check(!result.standard_output.raw_bytes && !result.standard_error.raw_bytes,
          "Denied suspended process never runs its output-producing entrypoint");
      }
    }
  }
  return checks - before;
}
struct CaptureState final {
  unsigned authorizations = 0, captures = 0, discards = 0;
  unsigned mode = 0;
  bool captured_identity = false, denied = false;
  HANDLE stop = nullptr, unexpected_process = nullptr;
  const JobCommand* command = nullptr;
  CellDirectoryInventory inventory;
  static DWORD Authorize(void* context) noexcept {
    auto& state = *static_cast<CaptureState*>(context); ++state.authorizations;
    return state.denied ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  }
  static void Discard(void* context) noexcept {
    auto& state = *static_cast<CaptureState*>(context); ++state.discards; state.inventory = {};
  }
  static DWORD Capture(void* context, const JobQuiescence& job) noexcept {
    auto& state = *static_cast<CaptureState*>(context); ++state.captures;
    state.captured_identity = job.JobName() == state.command->job_name && job.DirectoryIdentity() == state.command->expected_directory_identity;
    const auto binding = job.CellBinding();
    auto wrong_name = job.JobName(); wrong_name.back() ^= 1;
    auto wrong_work = job.DirectoryIdentity(); wrong_work.file_id.back() ^= 1;
    const auto before = state.authorizations;
    Check(binding.authorize(binding.context, wrong_name, job.DirectoryIdentity()) == ERROR_ACCESS_DENIED &&
      binding.authorize(binding.context, job.JobName(), wrong_work) == ERROR_ACCESS_DENIED && state.authorizations == before,
      "borrowed job binding refuses another cell or directory before canonical authorization");
    Check(binding.authorize(binding.context, job.JobName(), job.DirectoryIdentity()) == 0 && state.authorizations == before + 1,
      "matching journal identity rechecks the exact held job and current authority");
    state.denied = true;
    Check(binding.authorize(binding.context, job.JobName(), job.DirectoryIdentity()) == ERROR_ACCESS_DENIED,
      "borrowed job binding does not cache canonical authorization");
    state.denied = false;
    const DWORD observed = job.ObserveDirectoryInventory({}, &state.inventory);
    if (observed) return observed;
    if (state.mode == 1) return ERROR_INVALID_DATA;
    if (state.mode == 2) state.denied = true;
    if (state.mode == 3) SetEvent(state.stop);
    if (state.mode == 4) {
      for (unsigned index = 0; index < 1000; ++index) {
        Sleep(10);
        const DWORD checked = job.Check();
        if (checked == ERROR_TIMEOUT) {
          Check(binding.authorize(binding.context, job.JobName(), job.DirectoryIdentity()) == ERROR_TIMEOUT,
            "borrowed journal binding expires with the capture deadline");
          return ERROR_SUCCESS;
        }
        if (checked) return checked;
      }
      return ERROR_INVALID_STATE;
    }
    if (state.mode == 5) {
      // Controlled trusted-host interference: assign a new suspended process
      // after the initial empty query. It must invalidate publication.
      HANDLE owned_job = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, (L"Local\\" + job.JobName()).c_str());
      if (!owned_job) return GetLastError();
      auto line = state.command->command_line;
      STARTUPINFOW startup{}; startup.cb = sizeof(startup);
      PROCESS_INFORMATION created{};
      if (!CreateProcessW(state.command->image.c_str(), line.data(), nullptr, nullptr, FALSE,
          CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, state.command->directory.c_str(), &startup, &created)) {
        const DWORD error = GetLastError(); CloseHandle(owned_job); return error;
      }
      const BOOL assigned = AssignProcessToJobObject(owned_job, created.hProcess);
      const DWORD error = assigned ? ERROR_SUCCESS : GetLastError();
      CloseHandle(owned_job); CloseHandle(created.hThread);
      if (!assigned) { TerminateProcess(created.hProcess, error); WaitForSingleObject(created.hProcess, 5000); CloseHandle(created.hProcess); return error; }
      state.unexpected_process = created.hProcess;
    }
    if (state.mode == 2 || state.mode == 3 || state.mode == 5) {
      const DWORD expected = state.mode == 2 ? ERROR_ACCESS_DENIED : state.mode == 3 ? ERROR_CANCELLED : ERROR_BUSY;
      Check(binding.authorize(binding.context, job.JobName(), job.DirectoryIdentity()) == expected,
        "borrowed journal binding observes revocation, cancellation and a late process in the held job");
    }
    return ERROR_SUCCESS;
  }
};
unsigned RunQuiescentCaptureTests(const std::wstring& image) {
  const unsigned before = checks;
  for (unsigned mode = 0; mode <= 5; ++mode) {
    const std::wstring directory = image.substr(0, image.find_last_of(L'\\')) + L"\\capture-" +
      std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(mode);
    Check(CreateDirectoryW(directory.c_str(), nullptr) != FALSE, "isolated capture fixture directory created");
    const std::wstring isolated_image = directory + L"\\fixture.exe";
    Check(CopyFileW(image.c_str(), isolated_image.c_str(), TRUE) != FALSE, "capture fixture image copied without overwriting");
    auto command = Command(isolated_image, L"exit");
    CaptureState state; state.command = &command; state.mode = mode;
    state.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Check(state.stop != nullptr, "capture cancellation fixture created");
    JobQuiescenceObserver observer{&state, CaptureState::Authorize, CaptureState::Capture, CaptureState::Discard, mode == 4 ? 2000UL : 10000UL};
    const auto result = RunBoundedJob(command, Limits(), state.stop, nullptr, &observer);
    Check(result.quiescent_capture_attempted && state.captures == 1, "capture runs once after real child exit and pipe drain");
    Check(state.captured_identity && state.authorizations > 2, "capture binds pinned directory and repeatedly checks current authority");
    if (mode == 0) {
      Exited(result);
      Check(result.quiescent_capture_verified && !result.quiescent_capture_error, "held empty job gates successful capture");
      Check(!state.inventory.entries.empty() && state.inventory.footprint.root == command.expected_directory_identity, "real inventory covers the pinned launch directory");
      Check(state.discards == 1, "successful output survives the final check");
    } else {
      const DWORD expected[] = {0, ERROR_INVALID_DATA, ERROR_ACCESS_DENIED, ERROR_CANCELLED, ERROR_TIMEOUT, ERROR_BUSY};
      Check(!result.quiescent_capture_verified && result.quiescent_capture_error == expected[mode], "capture failure is explicit");
      Check(result.end == JobEnd::control_failed && result.error == expected[mode], "capture failure cannot report normal completion");
      Check(state.inventory.entries.empty() && state.discards == 2, "failed capture clears provisional inventory");
      if (mode == 5) {
        Check(state.unexpected_process && WaitForSingleObject(state.unexpected_process, 5000) == WAIT_OBJECT_0, "only the owned job's added child is killed on close");
        Check(!result.zero_processes_verified, "late child invalidates the earlier zero-process receipt");
        CloseHandle(state.unexpected_process);
      }
    }
    CloseHandle(state.stop);
  }
  for (unsigned mode = 0; mode < 4; ++mode) {
    auto command = Command(image, L"exit"); CaptureState state; state.command = &command;
    JobQuiescenceObserver observer{&state, CaptureState::Authorize, CaptureState::Capture, CaptureState::Discard, 10000};
    if (mode == 0) observer.authorize = nullptr;
    if (mode == 1) observer.capture = nullptr;
    if (mode == 2) observer.wall_ms = 60001;
    if (mode == 3) state.denied = true;
    const auto result = RunBoundedJob(command, Limits(), nullptr, nullptr, &observer);
    Check(!result.quiescent_capture_attempted && !result.quiescent_capture_verified && state.captures == 0, "missing or revoked capture authority never invokes the reader");
    if (mode < 3) Check(!result.process_id && result.error == ERROR_INVALID_PARAMETER, "invalid observer refuses before launch");
    else Check(result.quiescent_capture_error == ERROR_ACCESS_DENIED, "revocation refuses post-job observation");
  }
  return checks - before;
}
}

int Main(int argc, wchar_t** argv) {
  if (argc == 3 && wcscmp(argv[1], L"--provisioning-phase") == 0) {
    const auto journal_checks = RunCellProvisioningJournalFixture(argv[2]);
    std::printf("{\"phase\":\"provisioning\",\"status\":\"passed\",\"checks\":%u,\"provisioningJournalChecks\":%u,"
      "\"provisioningRecoveryProcessVerified\":%s,\"provisioningCheckpointRecords\":%s,\"provisioningDiskLayoutIdsHex\":\"%s\","
      "\"volumeProvisioningCoreRecords\":%s,\"volumeProvisioningRecords\":%s,\"formatProvisioningHistory\":%s,"
      "\"protectionProvisioningHistory\":%s,\"mountProvisioningHistory\":%s}\n",
      journal_checks, journal_checks, CellProvisioningRecoveryProcessVerified() ? "true" : "false",
      CellProvisioningCheckpointRecordsJson().c_str(), CellProvisioningDiskLayoutIdsHex().c_str(),
      CellVolumeProvisioningCoreRecordsJson().c_str(), CellVolumeProvisioningRecordsJson().c_str(),
      CellFormatProvisioningHistoryJson().c_str(), CellProtectionProvisioningHistoryJson().c_str(), CellMountProvisioningHistoryJson().c_str());
    return 0;
  }
  if (argc == 3 && wcscmp(argv[1], L"--workspace-phase") == 0) {
    DWORD explicit_create = ERROR_GEN_FAILURE, explicit_dacl = ERROR_GEN_FAILURE;
    unsigned disk_checks = 0, attachment_checks = 0, journal_checks = 0;
    const auto workspace_checks = RunCellWorkspaceTests(Command(argv[2], L"workspace"), explicit_create, explicit_dacl,
      disk_checks, attachment_checks, journal_checks, false, false);
    std::printf("{\"phase\":\"workspace\",\"status\":\"passed\",\"checks\":%u,\"workspaceChecks\":%u,\"virtualDiskChecks\":%u,"
      "\"volumeAttachmentChecks\":%u,\"volumeAttachmentExercised\":false,\"explicitDescriptorCreateError\":%lu,\"explicitDescriptorWriteDaclError\":%lu,"
      "\"virtualDiskRecoveryProcessVerified\":%s,\"volumeAttachmentRecoveryVerified\":%s,\"volumeDeviceBindingVerified\":%s,\"volumeDeviceMetadataChecks\":%u,"
      "\"provisioningJournalChecks\":%u,\"provisioningRecoveryProcessVerified\":%s,\"provisioningCheckpointRecords\":%s,\"provisioningDiskLayoutIdsHex\":\"%s\","
      "\"volumeProvisioningCoreRecords\":%s,\"volumeProvisioningRecords\":%s,\"formatProvisioningHistory\":%s,\"protectionProvisioningHistory\":%s,"
      "\"mountProvisioningHistory\":%s,\"controllerDescriptorControl\":true}\n",
      workspace_checks + disk_checks + attachment_checks + journal_checks, workspace_checks, disk_checks, attachment_checks,
      explicit_create, explicit_dacl, CellVirtualDiskRecoveryProcessVerified() ? "true" : "false",
      CellVirtualDiskAttachmentRecoveryVerified() ? "true" : "false", CellVirtualDiskDeviceBindingVerified() ? "true" : "false",
      CellVirtualDiskDeviceMetadataChecks(), journal_checks, CellProvisioningRecoveryProcessVerified() ? "true" : "false",
      CellProvisioningCheckpointRecordsJson().c_str(), CellProvisioningDiskLayoutIdsHex().c_str(),
      CellVolumeProvisioningCoreRecordsJson().c_str(), CellVolumeProvisioningRecordsJson().c_str(),
      CellFormatProvisioningHistoryJson().c_str(), CellProtectionProvisioningHistoryJson().c_str(), CellMountProvisioningHistoryJson().c_str());
    return 0;
  }
  if (argc == 3 && wcscmp(argv[1], L"--host-capacity-journal") == 0) {
    const auto host_checks = RunCellHostCapacityJournalFixture(argv[2]);
    std::printf("{\"checks\":%u,\"hostCapacityObserver\":true,\"volumeAttachmentExercised\":false}\n", host_checks);
    return 0;
  }
  if (argc == 3 && wcscmp(argv[1], L"--mounted-workspace-journal") == 0) {
    const auto journal_checks = RunCellMountedWorkspaceJournalTests(argv[2]);
    std::printf("{\"checks\":%u,\"mountedWorkspaceProvisioningHistory\":%s,\"mountedWorkspaceExercised\":false}\n",
      journal_checks, CellMountedWorkspaceProvisioningHistoryJson().c_str());
    return 0;
  }
  if (argc >= 2 && wcscmp(argv[1], L"--recorded-provisioning") == 0)
    return RunCellProvisioningRecoveryFixture(argc, argv);
  if (argc >= 2 && wcscmp(argv[1], L"--recorded-disk") == 0)
    return RunCellVirtualDiskRecoveryFixture(argc, argv);
  if (argc == 3 && wcscmp(argv[1], L"--cleanup-profile") == 0)
    return CleanupKnownAppContainer(argv[2]) ? 0 : 98;
  if (argc == 4 && wcscmp(argv[1], L"--network") == 0) {
    const auto result = RunBoundedJob(Command(argv[2], L"network " + std::wstring(argv[3])), Limits());
    Exited(result);
    int network_error = 0, connected = 1;
    const bool reported = sscanf_s(Text(result.standard_output).c_str(), "network_error=%d connected=%d", &network_error, &connected) == 2;
    const bool blocked = result.process_exit_code == 0 && reported && connected == 0 &&
      (network_error == 10013 || network_error == 10060);
    if (!blocked)
      std::fprintf(stderr, "Network fixture: exit=%lu output=%s\n", result.process_exit_code, Text(result.standard_output).c_str());
    // The JS harness brackets this with successful runs of the same native
    // probe outside AppContainer against the same live listener. Preserve an
    // observed timeout as a timeout, rather than calling it access denied.
    Check(blocked, "zero-capability AppContainer cannot connect in the bounded loopback probe");
    std::printf("{\"checks\":%u,\"status\":\"passed\",\"networkError\":%d,\"connected\":false}\n", checks, network_error);
    return 0;
  }
  if (argc == 4 && (wcscmp(argv[1], L"--hold") == 0 || wcscmp(argv[1], L"--hold-stdio") == 0)) {
    const bool interactive = wcscmp(argv[1], L"--hold-stdio") == 0;
    auto limits = Limits();
    limits.wall_ms = 30000;
    limits.input_bytes = kCellJobStdioQueueBytes;
    const auto command = Command(argv[2], L"sleep");
    JobStdioChannel channel;
    std::vector<std::uint8_t> input(kCellJobStdioQueueBytes, 42);
    if (interactive && channel.WriteInput(input.data(), static_cast<DWORD>(input.size()), true)) return 98;
    ReportOwnedProfile(command.app_container_name, std::wstring(argv[3]) + L".profile");
    std::thread report([&] { ReportOwnedJobProcess(command.job_name, command.app_container_name, argv[3]); });
    const auto result = RunBoundedJob(command, limits, nullptr, interactive ? &channel : nullptr);
    report.join();
    return result.error ? 2 : 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--volume-preflight") == 0) {
    RequireVolumeAttachmentPrivilege();
    std::printf("{\"checks\":1,\"status\":\"passed\",\"volumePrivilegeAvailable\":true}\n");
    return 0;
  }
  const bool live_attachment = argc == 3 && wcscmp(argv[1], L"--volume-attachment") == 0;
  const bool core_only = argc == 3 && wcscmp(argv[1], L"--core-phase") == 0;
  if (argc != 2 && !live_attachment && !core_only) return 99;
  const std::wstring image = argv[live_attachment || core_only ? 2 : 1];
  const auto started = GetTickCount64();
  const auto phase = [&](const char* name) {
    std::fprintf(stderr, "Native job phase: %s at %llu ms\n", name,
      static_cast<unsigned long long>(GetTickCount64() - started));
    std::fflush(stderr);
  };
  phase("runtime-dispatch");
  const unsigned runtime_dispatch_checks = RunCellRuntimeDispatchTests();
  checks += runtime_dispatch_checks;
  phase("quiescent-capture");
  const unsigned quiescent_capture_checks = RunQuiescentCaptureTests(image);
  phase("execution-authority");
  const unsigned execution_authority_checks = RunExecutionAuthorityTests(image);
  phase("job-resources");
  Check(CpuRateForMilliCores(1000, 8) == 1250, "CPU limit uses milli-cores and total processor count");
  Check(CpuRateForMilliCores(1, 128) == 0, "unrepresentable CPU allowance is not enlarged");
  Check(CpuRateForMilliCores(1001, 3) == 3336, "CPU rate rounds down");
  Check(CpuRateForMilliCores(9000, 8) == 10000, "above-machine allowance caps at all machine cycles");
  Check(CpuRateForMilliCores(0, 8) == 0 && CpuRateForMilliCores(1, 0) == 0, "invalid CPU inputs fail closed");
  auto result = RunBoundedJob(Command(image, L"exit"), Limits());
  Exited(result);
  Check(result.process_exit_code == 7 && Text(result.standard_output) == "finished\r\n", "nonzero exit and output retained");

  auto security = Command(image, L"security");
  const auto private_path = security.directory + L"\\private-" + std::to_wstring(GetCurrentProcessId()) + L".txt";
  WritePrivateFixture(private_path);
  HANDLE private_file = CreateFileW(private_path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  Check(private_file != INVALID_HANDLE_VALUE, "host control can open the existing private fixture");
  char first = 0;
  DWORD read = 0;
  const bool readable = ReadFile(private_file, &first, 1, &read, nullptr) && read == 1 && first == 't';
  CloseHandle(private_file);
  Check(readable, "host control reads the known private fixture contents");
  HANDLE self = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_WRITE | PROCESS_DUP_HANDLE | PROCESS_TERMINATE,
    FALSE, GetCurrentProcessId());
  Check(self != nullptr, "host control can open the real parent with the tested access rights");
  CloseHandle(self);
  security.command_line += L" " + Quote(private_path) + L" " + Quote(L"Local\\" + security.job_name) +
    L" " + std::to_wstring(GetCurrentProcessId()) + L" " + Quote(security.app_container_name);
  result = RunBoundedJob(security, Limits());
  Exited(result);
  const auto observed_security = Text(result.standard_output);
  Check(result.process_exit_code == 0 && observed_security.find("app=1 sid=1 caps=0 integrity=4096") != std::string::npos,
    "child independently observes its exact low-integrity AppContainer token with zero capabilities");
  Check(observed_security.find("read=5 write=5 image=1") != std::string::npos,
    "child cannot read or write the private file but can read its explicitly granted executable");
  Check(observed_security.find("job=5") != std::string::npos || observed_security.find("job=2") != std::string::npos,
    "child cannot reopen the private named job for limit changes or termination");
  Check(observed_security.find("parent=5") != std::string::npos,
    "child cannot obtain parent injection, handle duplication or termination rights");

  SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
  HANDLE private_event = CreateEventW(&attributes, TRUE, FALSE, nullptr);
  Check(private_event != nullptr, "private inheritable fixture event created");
  SetEnvironmentVariableW(L"GOAT_CELL_TEST_AMBIENT", L"must-not-inherit");
  result = RunBoundedJob(Command(image, L"inspect " + std::to_wstring(reinterpret_cast<std::uintptr_t>(private_event))), Limits());
  SetEnvironmentVariableW(L"GOAT_CELL_TEST_AMBIENT", nullptr);
  Exited(result);
  const auto inspection = Text(result.standard_output);
  const DWORD expected_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
    JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  Check(inspection.find("process=3 memory=67108864 flags=" + std::to_string(expected_flags)) != std::string::npos,
    "kernel reports exact process, memory and no-breakaway flags");
  Check(inspection.find("cpu=" + std::to_string(result.configured_cpu_rate) + " cpuFlags=5") != std::string::npos,
    "kernel reports the configured hard CPU cap");
  Check(inspection.find("ambient=0") != std::string::npos && inspection.find("inheritedEvent=0") != std::string::npos,
    "ambient environment and unrelated inheritable handle are excluded");
  Check(WaitForSingleObject(private_event, 0) == WAIT_TIMEOUT, "unlisted event remains inaccessible to child");
  CloseHandle(private_event);

  result = RunBoundedJob(Command(image, L"memory"), Limits());
  Exited(result);
  unsigned long long allocated = 0;
  unsigned long allocation_error = 0;
  Check(sscanf_s(Text(result.standard_output).c_str(), "allocated=%llu error=%lu", &allocated, &allocation_error) == 2,
    "memory fixture reports successful allocations and the actual refusal code");
  Check(result.process_exit_code == 0 && allocated > 0 && allocated < Limits().memory_bytes &&
    allocation_error == ERROR_COMMITMENT_LIMIT, "kernel refuses commits above the job budget");
  Check(result.peak_job_memory_bytes >= allocated, "OS memory accounting is retained without clamping failed charges");
  auto memory_control = Limits();
  memory_control.memory_bytes = 512ULL * 1024 * 1024;
  result = RunBoundedJob(Command(image, L"memory"), memory_control);
  Exited(result);
  Check(result.process_exit_code == 94 && Text(result.standard_output).find("allocated=268435456 error=0") != std::string::npos,
    "the same bounded allocation succeeds with a larger job budget");

  result = RunBoundedJob(Command(image, L"process"), Limits());
  Exited(result);
  Check(Text(result.standard_output).find("started=2 refused=6") != std::string::npos, "kernel enforces aggregate process ceiling");
  Check(result.terminated_descendants && result.total_processes >= 3, "parent exit drains both remaining descendants");
  result = RunBoundedJob(Command(image, L"breakaway"), Limits());
  Exited(result);
  Check(Text(result.standard_output).find("started=0 refused=1") != std::string::npos, "child cannot break away from the job");

  auto small_capture = Limits();
  small_capture.diagnostic_bytes = 64;
  result = RunBoundedJob(Command(image, L"capture"), small_capture);
  Exited(result);
  Check(result.standard_output.raw_bytes == 100 && result.standard_output.truncated, "raw count precedes bounded capture");
  Check(result.standard_output.prefix.size() == 16 && result.standard_output.tail.size() == 16,
    "stdout receives its bounded prefix and tail budget");
  Check(std::string(result.standard_output.tail.begin(), result.standard_output.tail.end()) == "4567890123456789", "tail preserves final bytes");
  result = RunBoundedJob(Command(image, L"flood"), small_capture);
  Check(result.end == JobEnd::output_limit && result.zero_processes_verified, "output pressure stops and drains the exact job");
  Check(result.standard_output.raw_bytes + result.standard_error.raw_bytes > small_capture.raw_output_bytes,
    "all raw stdout and stderr bytes count against one allowance");
  Check(result.standard_output.prefix.size() + result.standard_output.tail.size() +
    result.standard_error.prefix.size() + result.standard_error.tail.size() <= small_capture.diagnostic_bytes,
    "retained stdout and stderr cannot exceed the combined diagnostic allowance");

  auto short_run = Limits();
  short_run.wall_ms = 250;
  const ULONGLONG before = GetTickCount64();
  result = RunBoundedJob(Command(image, L"sleep"), short_run);
  Check(result.end == JobEnd::wall_limit && result.zero_processes_verified && GetTickCount64() - before < 5000,
    "wall deadline terminates an idle child without waiting for natural exit");
  HANDLE cancellation = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Check(cancellation != nullptr, "cancellation event created");
  const auto cancelled_command = Command(image, L"sleep");
  const auto cancelled_name = L"Local\\" + cancelled_command.job_name;
  bool cancellation_observed_process = false;
  std::thread cancel([&] {
    // Profile preparation is outside RunBoundedJob. Cancel only after the
    // exact named job owns a process, rather than racing setup with a timer.
    const auto deadline = GetTickCount64() + 5000;
    while (GetTickCount64() < deadline) {
      HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, cancelled_name.c_str());
      if (job) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        cancellation_observed_process = QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
          &accounting, sizeof(accounting), nullptr) && accounting.ActiveProcesses != 0;
        CloseHandle(job);
      }
      if (cancellation_observed_process) break;
      Sleep(1);
    }
    SetEvent(cancellation);
  });
  result = RunBoundedJob(cancelled_command, Limits(), cancellation);
  cancel.join();
  Check(cancellation_observed_process && result.end == JobEnd::cancelled && result.zero_processes_verified,
    "cancellation terminates the exact job");
  result = RunBoundedJob(Command(image, L"exit"), Limits(), cancellation);
  Check(result.end == JobEnd::cancelled && result.process_id == 0, "already-cancelled work never launches");
  CloseHandle(cancellation);

  auto cpu = Limits();
  cpu.cpu_milli = 100;
  result = RunBoundedJob(Command(image, L"cpu"), cpu);
  Exited(result);
  Check(result.cpu_time_100ns > 0 && result.cpu_time_100ns < 8'000'000, "hard cap bounds real busy-loop CPU time");

  const auto collision = Command(image, L"exit");
  HANDLE existing = CreateJobObjectW(nullptr, (L"Local\\" + collision.job_name).c_str());
  Check(existing != nullptr, "existing-name fixture created");
  result = RunBoundedJob(collision, Limits());
  Check(result.error == ERROR_ALREADY_EXISTS && !result.zero_processes_verified && result.process_id == 0,
    "existing jobs are refused without an absence or zero-process claim");
  CloseHandle(existing);
  auto invalid = Limits();
  invalid.process_limit = 0;
  result = RunBoundedJob(Command(image, L"exit"), invalid);
  Check(result.error == ERROR_INVALID_PARAMETER && result.process_id == 0, "invalid limits never launch");
  auto ambient = Command(image, L"exit");
  ambient.environment = {L'A', L'=', L'B', L'\0'};
  result = RunBoundedJob(ambient, Limits());
  Check(result.error == ERROR_INVALID_PARAMETER && result.process_id == 0, "unterminated environment never launches");
  auto missing_identity = Command(image, L"exit");
  missing_identity.app_container_name.clear();
  result = RunBoundedJob(missing_identity, Limits());
  Check(result.error == ERROR_INVALID_PARAMETER && result.process_id == 0 && !result.app_container_verified,
    "missing AppContainer identity never launches under caller identity");
  auto mismatched_identity = Command(image, L"exit");
  mismatched_identity.app_container_name.back() = mismatched_identity.app_container_name.back() == L'0' ? L'1' : L'0';
  result = RunBoundedJob(mismatched_identity, Limits());
  Check(result.error == ERROR_INVALID_PARAMETER && result.process_id == 0 && !result.app_container_verified,
    "a valid AppContainer name for another cell never launches");
  auto wrong_image = Command(image, L"exit");
  wrong_image.expected_image_sha256[0] ^= 1;
  result = RunBoundedJob(wrong_image, Limits());
  Check(result.error == ERROR_CRC && result.process_id == 0 && !result.launch_files_verified,
    "image hash mismatch never reaches process creation");
  auto wrong_root = Command(image, L"exit");
  wrong_root.expected_directory_identity.file_id[0] ^= 1;
  result = RunBoundedJob(wrong_root, Limits());
  Check(result.error == ERROR_FILE_INVALID && result.process_id == 0 && !result.launch_files_verified,
    "directory identity mismatch never reaches process creation");
  phase("filesystem");
  const unsigned filesystem_checks = RunCellFilesystemTests(image);
  checks += filesystem_checks;
  phase("input");
  const unsigned input_checks = RunCellJobInputTests(image, Command, Limits());
  checks += input_checks;
  phase("stdio");
  const unsigned stdio_checks = RunCellJobStdioTests(image, Command, Limits());
  checks += stdio_checks;
  DWORD explicit_create = ERROR_GEN_FAILURE, explicit_dacl = ERROR_GEN_FAILURE;
  unsigned disk_checks = 0, attachment_checks = 0, journal_checks = 0;
  phase("workspace");
  const unsigned workspace_checks = core_only ? 0 : RunCellWorkspaceTests(Command(image, L"workspace"), explicit_create, explicit_dacl,
    disk_checks, attachment_checks, journal_checks, live_attachment);
  checks += workspace_checks + disk_checks + attachment_checks + journal_checks;
  phase("layout");
  const unsigned layout_checks = RunCellVirtualDiskLayoutTests();
  checks += layout_checks;
  phase("volume-binding");
  const unsigned volume_binding_checks = RunCellVirtualDiskVolumeTests();
  checks += volume_binding_checks;
  phase("format-fixtures");
  const unsigned ntfs_format_checks = RunCellNtfsFormatTests();
  checks += ntfs_format_checks;
  CellFileSha256 golden{};
  phase("runtime-bundle");
  const unsigned bundle_checks = RunCellRuntimeBundleTests(image, Command, golden);
  phase("complete");
  checks += bundle_checks;
  std::array<char, 65> golden_hex{};
  for (std::size_t i = 0; i < golden.size(); ++i) sprintf_s(golden_hex.data() + i * 2, 3, "%02x", golden[i]);
  std::printf("{\"checks\":%u,\"filesystemChecks\":%u,\"inputChecks\":%u,\"stdioChecks\":%u,\"workspaceChecks\":%u,\"virtualDiskChecks\":%u,\"volumeAttachmentChecks\":%u,\"volumeAttachmentExercised\":%s,\"runtimeBundleChecks\":%u,\"runtimeBundleGoldenSha256\":\"%s\",\"explicitDescriptorCreateError\":%lu,"
    "\"explicitDescriptorWriteDaclError\":%lu,\"virtualDiskRecoveryProcessVerified\":%s,\"volumeAttachmentRecoveryVerified\":%s,\"volumeDeviceBindingVerified\":%s,\"volumeDeviceMetadataChecks\":%u,\"provisioningJournalChecks\":%u,\"provisioningRecoveryProcessVerified\":%s,\"provisioningCheckpointRecords\":%s,\"volumeLayoutComponentChecks\":%u,\"volumeLayoutExercised\":false,\"volumeLayoutCheckpointRecords\":%s,\"provisioningDiskLayoutIdsHex\":\"%s\",\"volumeProvisioningCoreRecords\":%s,\"volumeProvisioningRecords\":%s,\"volumeBindingComponentChecks\":%u,\"volumeBindingExercised\":false,\"ntfsFormatComponentChecks\":%u,\"ntfsFormatExercised\":false,\"formatProvisioningHistory\":%s,\"protectionProvisioningHistory\":%s,\"volumeRootProtectionExercised\":false,\"mountProvisioningHistory\":%s,\"volumeMountExercised\":false,"
    "\"controllerDescriptorControl\":true,\"runtimeDispatchChecks\":%u,\"quiescentCaptureChecks\":%u,\"executionAuthorityChecks\":%u,\"status\":\"passed\",\"phase\":\"%s\"}\n",
    checks, filesystem_checks, input_checks, stdio_checks, workspace_checks, disk_checks, attachment_checks, live_attachment ? "true" : "false",
    bundle_checks, golden_hex.data(), explicit_create, explicit_dacl, CellVirtualDiskRecoveryProcessVerified() ? "true" : "false",
    CellVirtualDiskAttachmentRecoveryVerified() ? "true" : "false", CellVirtualDiskDeviceBindingVerified() ? "true" : "false",
    CellVirtualDiskDeviceMetadataChecks(), journal_checks, CellProvisioningRecoveryProcessVerified() ? "true" : "false",
    CellProvisioningCheckpointRecordsJson().c_str(), layout_checks, CellDiskLayoutCheckpointRecordsJson().c_str(),
    CellProvisioningDiskLayoutIdsHex().c_str(), CellVolumeProvisioningCoreRecordsJson().c_str(), CellVolumeProvisioningRecordsJson().c_str(),
    volume_binding_checks, ntfs_format_checks, CellFormatProvisioningHistoryJson().c_str(), CellProtectionProvisioningHistoryJson().c_str(),
    CellMountProvisioningHistoryJson().c_str(), runtime_dispatch_checks, quiescent_capture_checks, execution_authority_checks,
    core_only ? "core" : "combined");
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  int result = 1;
  try { result = Main(argc, argv); }
  catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); }
  if (!CleanupAppContainers()) { std::fprintf(stderr, "Task-owned AppContainer cleanup failed.\n"); return 97; }
  return result;
}
