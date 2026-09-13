#include "cell_runtime_bundle.hpp"
#include <functional>
#include "appcontainer_fixture.hpp"
#include <algorithm>
#include <array>
#include <stdexcept>

using namespace goatcitadel::worker_cell;
using namespace goatcitadel::worker_cell_test;
unsigned RunCellRuntimeStdioTests(RuntimeJobCommand request, const std::function<void()>& after_start = {});
namespace {
struct Handle final { HANDLE value = INVALID_HANDLE_VALUE; ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
void Require(bool value, const char* text) { if (!value) throw std::runtime_error(text); }
CellFileSha256 Hex(const char* text) {
  CellFileSha256 bytes{};
  const auto nibble = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
  for (std::size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<std::uint8_t>(nibble(text[i * 2]) * 16 + nibble(text[i * 2 + 1]));
  return bytes;
}
void Write(const std::wstring& path, const std::string& data) {
  Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr)};
  Require(file.value != INVALID_HANDLE_VALUE, "Create exclusive bundle fixture failed.");
  DWORD written = 0;
  Require(WriteFile(file.value, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) && written == data.size(), "Write bundle fixture failed.");
}
bool Owned(const std::wstring& root, const std::wstring& path) {
  std::array<wchar_t, 4096> full{};
  const DWORD size = GetFullPathNameW(path.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr);
  return size && size < full.size() && path.rfind(root + L"\\", 0) == 0 && path == full.data();
}
void Remove(const std::wstring& root, const std::wstring& path) {
  Require(Owned(root, path) && DeleteFileW(path.c_str()), "Remove exact owned bundle fixture failed.");
}
CellRuntimeBundleFile File(const std::wstring& root, const std::wstring& relative) {
  auto suffix = relative;
  std::replace(suffix.begin(), suffix.end(), L'/', L'\\');
  JobCommand probe;
  probe.image = root + L"\\" + suffix; probe.directory = root;
  Handle file{CreateFileW(probe.image.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
  LARGE_INTEGER size{};
  Require(file.value != INVALID_HANDLE_VALUE && GetFileSizeEx(file.value, &size) && size.QuadPart >= 0, "Read bundle fixture size failed.");
  if (size.QuadPart) BindLaunchFixture(&probe);
  else probe.expected_image_sha256 = Hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  return {relative, static_cast<std::uint64_t>(size.QuadPart), probe.expected_image_sha256};
}
}

unsigned RunCellRuntimeBundleTests(const std::wstring& source_image,
    JobCommand (*command)(const std::wstring&, const std::wstring&), CellFileSha256& golden) {
  unsigned checks = 0;
  const auto check = [&](bool value, const char* text) { ++checks; Require(value, text); };
  const auto parent = source_image.substr(0, source_image.find_last_of(L'\\'));
  const auto owned = parent + L"\\bundle-" + std::to_wstring(GetCurrentProcessId());
  check(CreateDirectoryW(owned.c_str(), nullptr) != FALSE, "Create exclusive bundle fixture parent failed.");
  const auto root = owned + L"\\runtime";
  check(CreateDirectoryW(root.c_str(), nullptr) != FALSE, "Create exclusive bundle root failed.");
  check(CreateDirectoryW((root + L"\\support").c_str(), nullptr) != FALSE, "Create bundle nested directory failed.");
  const auto image = root + L"\\entry.exe", support = root + L"\\support\\settings.json";
  check(CopyFileW(source_image.c_str(), image.c_str(), TRUE) != FALSE, "Copy bundle executable failed.");
  Write(root + L"\\empty.txt", ""); Write(support, "abc");
  auto launch = command(image, L"exit");
  RuntimeJobCommand request{launch, root, launch.expected_directory_identity, {},
    {File(root, L"empty.txt"), File(root, L"entry.exe"), File(root, L"support/settings.json")}};
  check(HashRuntimeBundleManifest(request.runtime_files, &request.expected_runtime_bundle) == ERROR_SUCCESS, "Hash frozen bundle fixture failed.");
  const auto open = [&](PinnedCellRuntimeBundle& bundle) {
    return bundle.Open(root, request.expected_runtime_root, request.runtime_files, request.expected_runtime_bundle);
  };
  PinnedCellRuntimeBundle bundle;
  check(open(bundle) == ERROR_SUCCESS && bundle.Ready(), "Exact runtime tree including an empty file must verify.");
  check(bundle.ContainsImage(image, launch.expected_image_sha256), "The entry executable must belong to the pinned tree.");
  check(!bundle.ContainsImage(source_image, launch.expected_image_sha256), "A matching executable outside the bundle is not admitted.");
  check(open(bundle) == ERROR_ALREADY_INITIALIZED, "A retained bundle cannot be replaced implicitly.");
  {
    Handle writer{CreateFileW(support.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    check(writer.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_SHARING_VIOLATION, "Pinned support files must refuse writers.");
  }
  check(!MoveFileW(support.c_str(), (root + L"\\support\\other.json").c_str()), "Pinned dependency cannot be renamed.");
  check(!MoveFileW((root + L"\\support").c_str(), (root + L"\\renamed").c_str()), "Pinned dependency directory cannot be renamed.");
  bundle.Reset();
  check(!bundle.Ready() && !bundle.ContainsImage(image, launch.expected_image_sha256), "Reset must clear runtime verification.");
  {
    Handle writer{CreateFileW(support.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    check(writer.value != INVALID_HANDLE_VALUE, "The write control must succeed after reset.");
    check(open(bundle) == ERROR_SHARING_VIOLATION && !bundle.Ready(), "An existing dependency writer prevents verification.");
  }
  auto wrong = request.expected_runtime_root; wrong.file_id[0] ^= 1;
  check(bundle.Open(root, wrong, request.runtime_files, request.expected_runtime_bundle) == ERROR_FILE_INVALID, "Bundle root identity drift must fail.");
  auto digest = request.expected_runtime_bundle; digest[0] ^= 1;
  check(bundle.Open(root, request.expected_runtime_root, request.runtime_files, digest) == ERROR_CRC, "Manifest digest mismatch must fail before launch.");
  auto files = request.runtime_files; files.back().bytes++;
  Require(HashRuntimeBundleManifest(files, &digest) == ERROR_SUCCESS, "Hash changed size fixture failed.");
  check(bundle.Open(root, request.expected_runtime_root, files, digest) == ERROR_FILE_INVALID, "Admitted dependency size must match disk.");
  files = request.runtime_files; files.back().sha256[0] ^= 1;
  Require(HashRuntimeBundleManifest(files, &digest) == ERROR_SUCCESS, "Hash changed content fixture failed.");
  check(bundle.Open(root, request.expected_runtime_root, files, digest) == ERROR_CRC, "Admitted dependency digest must match disk.");
  Write(root + L"\\extra.dll", "unexpected");
  check(open(bundle) == ERROR_INVALID_DATA && !bundle.Ready(), "An unlisted DLL must refuse the complete runtime.");
  auto rejected = RunVerifiedRuntimeJob(request, {3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 1024});
  check(rejected.job.process_id == 0 && !rejected.runtime_bundle_verified && rejected.job.error != 0, "An incomplete runtime cannot reach process creation.");
  Remove(owned, root + L"\\extra.dll");
  check(CreateDirectoryW((root + L"\\extra").c_str(), nullptr) != FALSE, "Create extra directory control failed.");
  check(open(bundle) == ERROR_INVALID_DATA, "Unlisted empty directories must also be refused.");
  Require(Owned(owned, root + L"\\extra") && RemoveDirectoryW((root + L"\\extra").c_str()), "Remove owned extra directory failed.");
  Require(Owned(owned, support) && MoveFileW(support.c_str(), (owned + L"\\saved.json").c_str()), "Move owned dependency for missing-file probe failed.");
  check(open(bundle) == ERROR_FILE_NOT_FOUND, "A missing dependency must be detected.");
  Require(MoveFileW((owned + L"\\saved.json").c_str(), support.c_str()), "Restore owned dependency failed.");
  Write(support + L":hidden", "unexpected stream");
  check(open(bundle) == ERROR_ACCESS_DENIED, "Dependency alternate data streams must be refused.");
  Remove(owned, support + L":hidden");
  const auto link = owned + L"\\linked.json";
  Require(CreateHardLinkW(link.c_str(), support.c_str(), nullptr) != FALSE, "Create owned hardlink control failed.");
  check(open(bundle) == ERROR_ACCESS_DENIED, "A dependency with another hardlink must be refused.");
  Remove(owned, link);
  {
    Handle cancelled{CreateEventW(nullptr, TRUE, TRUE, nullptr)};
    check(cancelled.value != nullptr && bundle.Open(root, request.expected_runtime_root, request.runtime_files,
      request.expected_runtime_bundle, cancelled.value) == ERROR_CANCELLED, "Cancelled verification must not launch.");
  }
  for (const wchar_t* name : {L"", L"/entry.exe", L"../entry.exe", L"dir/../entry.exe", L"dir//entry.exe", L"dir/", L"C:/entry.exe",
      L"entry.exe:stream", L"NUL.txt", L"COM1.exe", L"entry.exe.", L"entry.exe ", L"dir\\entry.exe", L"nonascii-\u00e9.txt"}) {
    files = {{name, 0, {}}};
    check(HashRuntimeBundleManifest(files, &digest) == ERROR_INVALID_PARAMETER, "Invalid bundle path spelling must fail before filesystem access.");
  }
  for (const auto& invalid : std::vector<std::vector<CellRuntimeBundleFile>>{
      {}, {{L"b", 0, {}}, {L"a", 0, {}}}, {{L"a", 0, {}}, {L"a", 0, {}}},
      {{L"Dir/a", 0, {}}, {L"dir/b", 0, {}}}, {{L"a", 0, {}}, {L"a/b", 0, {}}},
      {{L"a", 256ULL * 1024 * 1024 + 1, {}}}, std::vector<CellRuntimeBundleFile>(4097)})
    check(HashRuntimeBundleManifest(invalid, &digest) == ERROR_INVALID_PARAMETER, "Invalid bundle structure or bounds must fail.");
  const std::vector<CellRuntimeBundleFile> vector{{L"a.txt", 3, Hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")},
    {L"lib/empty.txt", 0, Hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")}};
  check(HashRuntimeBundleManifest(vector, &golden) == ERROR_SUCCESS, "Hash cross-language bundle vector failed.");
  files.clear();
  for (unsigned i = 0; i < 2049; ++i) {
    std::array<wchar_t, 40> path{};
    swprintf_s(path.data(), path.size(), L"d%04u/inner/a", i);
    files.push_back({path.data(), 0, {}});
  }
  check(HashRuntimeBundleManifest(files, &digest) == ERROR_INVALID_PARAMETER, "Implicit directories must have a bounded inventory.");
  files.clear();
  for (const wchar_t* path : {L"a", L"b", L"c", L"d", L"e"}) files.push_back({path, 256ULL * 1024 * 1024, {}});
  check(HashRuntimeBundleManifest(files, &digest) == ERROR_INVALID_PARAMETER, "Total runtime bytes must remain bounded.");
  const auto completed = RunVerifiedRuntimeJob(request, {3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 1024});
  check(completed.runtime_bundle_verified && completed.runtime_bundle_sha256 == request.expected_runtime_bundle, "Runtime launch must retain the exact bundle digest.");
  check(completed.job.error == 0 && completed.job.end == JobEnd::exited && completed.job.process_exit_code == 7,
    "Verified runtime must execute the actual fixture process.");
  check(completed.job.zero_processes_verified && completed.job.output_drained && completed.job.app_container_verified,
    "Runtime adapter preserves process, output and AppContainer proof.");
  request.launch = command(image, L"input");
  request.launch.standard_input = {'g', 'c', 0, 255};
  JobLimits input_limits{3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 1024, 4};
  const auto delivered = RunVerifiedRuntimeJob(request, input_limits);
  check(delivered.runtime_bundle_verified && delivered.runtime_bundle_sha256 == request.expected_runtime_bundle &&
    delivered.job.end == JobEnd::exited && delivered.job.error == 0 && delivered.job.process_exit_code == 0,
    "Verified runtime must forward bounded stdin to its exact executable.");
  check(delivered.job.standard_input_complete && delivered.job.standard_input_bytes_written == 4 &&
    delivered.job.zero_processes_verified && delivered.job.output_drained && delivered.job.app_container_verified,
    "Verified runtime preserves input, output, token and exact-job completion evidence.");
  const auto& capture = delivered.job.standard_output;
  const auto input_output = std::string(capture.prefix.begin(), capture.prefix.end()) + std::string(capture.tail.begin(), capture.tail.end());
  check(input_output.find("input_bytes=4 ") != std::string::npos && input_output.find("eof=1 readonly=1") != std::string::npos,
    "Verified runtime's AppContainer child observes request bytes and EOF.");
  input_limits.input_bytes = 0;
  rejected = RunVerifiedRuntimeJob(request, input_limits);
  check(rejected.job.process_id == 0 && !rejected.runtime_bundle_verified && rejected.job.error == ERROR_INVALID_PARAMETER,
    "Bundle adapter refuses input outside its allowance before retaining runtime files.");
  input_limits.input_bytes = kMaximumCellJobInputBytes;
  request.launch.standard_input.resize(kMaximumCellJobInputBytes + 1);
  rejected = RunVerifiedRuntimeJob(request, input_limits);
  check(rejected.job.process_id == 0 && !rejected.runtime_bundle_verified && rejected.job.error == ERROR_INVALID_PARAMETER,
    "Bundle adapter refuses oversized input before copying request bytes.");
  request.launch.standard_input.clear();
  checks += RunCellRuntimeStdioTests(request);
  ++input_limits.input_bytes;
  rejected = RunVerifiedRuntimeJob(request, input_limits);
  check(rejected.job.process_id == 0 && !rejected.runtime_bundle_verified && rejected.job.error == ERROR_INVALID_PARAMETER,
    "Bundle adapter cannot enlarge the internal input ceiling.");
  request.launch.image = source_image;
  rejected = RunVerifiedRuntimeJob(request, {3, 64ULL * 1024 * 1024, 1000, 5000, 8192, 1024});
  check(!rejected.runtime_bundle_verified && rejected.job.process_id == 0 && rejected.job.error == ERROR_FILE_INVALID,
    "An executable outside the exact bundle never reaches launch.");
  return checks;
}
