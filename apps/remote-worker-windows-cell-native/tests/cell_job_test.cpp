#include "cell_job.hpp"
#include "appcontainer_fixture.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <thread>
#include <stdexcept>

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
  unsigned& disk_checks, unsigned& attachment_checks, unsigned& journal_checks, bool live_attachment);
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
}

int Main(int argc, wchar_t** argv) {
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
  if (argc != 2 && !live_attachment) return 99;
  const std::wstring image = argv[live_attachment ? 2 : 1];
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
  std::thread cancel([&] { Sleep(150); SetEvent(cancellation); });
  result = RunBoundedJob(Command(image, L"sleep"), Limits(), cancellation);
  cancel.join();
  Check(result.end == JobEnd::cancelled && result.zero_processes_verified, "cancellation terminates the exact job");
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
  const unsigned filesystem_checks = RunCellFilesystemTests(image);
  checks += filesystem_checks;
  const unsigned input_checks = RunCellJobInputTests(image, Command, Limits());
  checks += input_checks;
  const unsigned stdio_checks = RunCellJobStdioTests(image, Command, Limits());
  checks += stdio_checks;
  DWORD explicit_create = ERROR_GEN_FAILURE, explicit_dacl = ERROR_GEN_FAILURE;
  unsigned disk_checks = 0, attachment_checks = 0, journal_checks = 0;
  const unsigned workspace_checks = RunCellWorkspaceTests(Command(image, L"workspace"), explicit_create, explicit_dacl,
    disk_checks, attachment_checks, journal_checks, live_attachment);
  checks += workspace_checks + disk_checks + attachment_checks + journal_checks;
  const unsigned layout_checks = RunCellVirtualDiskLayoutTests();
  checks += layout_checks;
  const unsigned volume_binding_checks = RunCellVirtualDiskVolumeTests();
  checks += volume_binding_checks;
  const unsigned ntfs_format_checks = RunCellNtfsFormatTests();
  checks += ntfs_format_checks;
  CellFileSha256 golden{};
  const unsigned bundle_checks = RunCellRuntimeBundleTests(image, Command, golden);
  checks += bundle_checks;
  std::array<char, 65> golden_hex{};
  for (std::size_t i = 0; i < golden.size(); ++i) sprintf_s(golden_hex.data() + i * 2, 3, "%02x", golden[i]);
  std::printf("{\"checks\":%u,\"filesystemChecks\":%u,\"inputChecks\":%u,\"stdioChecks\":%u,\"workspaceChecks\":%u,\"virtualDiskChecks\":%u,\"volumeAttachmentChecks\":%u,\"volumeAttachmentExercised\":%s,\"runtimeBundleChecks\":%u,\"runtimeBundleGoldenSha256\":\"%s\",\"explicitDescriptorCreateError\":%lu,"
    "\"explicitDescriptorWriteDaclError\":%lu,\"virtualDiskRecoveryProcessVerified\":%s,\"volumeAttachmentRecoveryVerified\":%s,\"volumeDeviceBindingVerified\":%s,\"volumeDeviceMetadataChecks\":%u,\"provisioningJournalChecks\":%u,\"provisioningRecoveryProcessVerified\":%s,\"provisioningCheckpointRecords\":%s,\"volumeLayoutComponentChecks\":%u,\"volumeLayoutExercised\":false,\"volumeLayoutCheckpointRecords\":%s,\"provisioningDiskLayoutIdsHex\":\"%s\",\"volumeProvisioningCoreRecords\":%s,\"volumeProvisioningRecords\":%s,\"volumeBindingComponentChecks\":%u,\"volumeBindingExercised\":false,\"ntfsFormatComponentChecks\":%u,\"ntfsFormatExercised\":false,\"formatProvisioningHistory\":%s,\"protectionProvisioningHistory\":%s,\"volumeRootProtectionExercised\":false,\"mountProvisioningHistory\":%s,\"volumeMountExercised\":false,"
    "\"controllerDescriptorControl\":true,\"status\":\"passed\"}\n",
    checks, filesystem_checks, input_checks, stdio_checks, workspace_checks, disk_checks, attachment_checks, live_attachment ? "true" : "false",
    bundle_checks, golden_hex.data(), explicit_create, explicit_dacl, CellVirtualDiskRecoveryProcessVerified() ? "true" : "false",
    CellVirtualDiskAttachmentRecoveryVerified() ? "true" : "false", CellVirtualDiskDeviceBindingVerified() ? "true" : "false",
    CellVirtualDiskDeviceMetadataChecks(), journal_checks, CellProvisioningRecoveryProcessVerified() ? "true" : "false",
    CellProvisioningCheckpointRecordsJson().c_str(), layout_checks, CellDiskLayoutCheckpointRecordsJson().c_str(),
    CellProvisioningDiskLayoutIdsHex().c_str(), CellVolumeProvisioningCoreRecordsJson().c_str(), CellVolumeProvisioningRecordsJson().c_str(),
    volume_binding_checks, ntfs_format_checks, CellFormatProvisioningHistoryJson().c_str(), CellProtectionProvisioningHistoryJson().c_str(),
    CellMountProvisioningHistoryJson().c_str());
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  int result = 1;
  try { result = Main(argc, argv); }
  catch (const std::exception& error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); }
  if (!CleanupAppContainers()) { std::fprintf(stderr, "Task-owned AppContainer cleanup failed.\n"); return 97; }
  return result;
}
