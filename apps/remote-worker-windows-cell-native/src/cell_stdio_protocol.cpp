#include "cell_stdio_protocol.hpp"
#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace goatcitadel::worker_cell {
namespace {
class Reader final {
 public:
  explicit Reader(const std::vector<std::uint8_t>& bytes) : bytes_(bytes) {}
  std::uint64_t Integer(unsigned count) {
    const auto* bytes = Take(count);
    std::uint64_t result = 0;
    for (unsigned index = 0; index < count; ++index) result |= static_cast<std::uint64_t>(bytes[index]) << (index * 8);
    return result;
  }
  std::wstring Text(DWORD maximum = 16384) {
    const auto size = Integer(4);
    if (!size || size > maximum) throw std::runtime_error("text");
    const auto* value = Take(static_cast<std::size_t>(size));
    if (std::memchr(value, 0, static_cast<std::size_t>(size))) throw std::runtime_error("nul");
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(value), static_cast<int>(size), nullptr, 0);
    if (!length) throw std::runtime_error("utf8");
    std::wstring result(static_cast<std::size_t>(length), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, reinterpret_cast<const char*>(value), static_cast<int>(size),
        result.data(), length) != length) throw std::runtime_error("utf8");
    return result;
  }
  CellFileSha256 Hash() {
    CellFileSha256 result{};
    const auto* bytes = Take(result.size());
    std::copy_n(bytes, result.size(), result.begin());
    return result;
  }
  CellFileIdentity Identity() {
    CellFileIdentity result{};
    result.volume_serial = Integer(8);
    const auto* bytes = Take(result.file_id.size());
    std::copy_n(bytes, result.file_id.size(), result.file_id.begin());
    return result;
  }
  bool Complete() const noexcept { return offset_ == bytes_.size(); }
 private:
  const std::uint8_t* Take(std::size_t count) {
    if (count > bytes_.size() - offset_) throw std::runtime_error("incomplete");
    const auto* result = bytes_.data() + offset_;
    offset_ += count;
    return result;
  }
  const std::vector<std::uint8_t>& bytes_;
  std::size_t offset_ = 0;
};
std::string Boolean(bool value) { return value ? "true" : "false"; }
std::string Hex(const CellFileSha256& bytes) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result;
  for (const auto byte : bytes) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
}
DWORD DecodeWorkerStdioConfiguration(const std::vector<std::uint8_t>& bytes,
                                    RuntimeJobCommand* output, JobLimits* output_limits, bool protected_workspace) noexcept {
  if (!output || !output_limits || bytes.empty() || bytes.size() > kMaximumStdioConfigurationBytes) return ERROR_INVALID_PARAMETER;
  try {
    Reader reader(bytes);
    RuntimeJobCommand command;
    JobLimits limits;
    command.launch.job_name = reader.Text(40);
    command.launch.app_container_name = reader.Text(64);
    command.launch.image = reader.Text();
    command.launch.command_line = reader.Text(32766);
    command.launch.directory = reader.Text();
    command.runtime_root = reader.Text();
    command.launch.expected_image_sha256 = reader.Hash();
    command.launch.expected_directory_identity = reader.Identity();
    command.expected_runtime_root = reader.Identity();
    command.expected_runtime_bundle = reader.Hash();
    limits.process_limit = static_cast<DWORD>(reader.Integer(4));
    limits.memory_bytes = reader.Integer(8);
    limits.cpu_milli = static_cast<DWORD>(reader.Integer(4));
    limits.wall_ms = static_cast<DWORD>(reader.Integer(4));
    limits.raw_output_bytes = reader.Integer(8);
    limits.diagnostic_bytes = static_cast<DWORD>(reader.Integer(4));
    limits.input_bytes = static_cast<DWORD>(reader.Integer(4));
    // The helper is a bounded local transport, not an unattended process host.
    if (!limits.wall_ms || limits.wall_ms > 25000 || limits.input_bytes > kMaximumCellJobInputBytes) return ERROR_INVALID_PARAMETER;
    const auto environment_count = reader.Integer(4);
    if (environment_count > 64) return ERROR_INVALID_PARAMETER;
    command.launch.environment.clear();
    for (std::uint64_t index = 0; index < environment_count; ++index) {
      const auto entry = reader.Text(8192);
      if (command.launch.environment.size() + entry.size() + 2 > 32767) return ERROR_INVALID_PARAMETER;
      command.launch.environment.insert(command.launch.environment.end(), entry.begin(), entry.end());
      command.launch.environment.push_back(L'\0');
    }
    if (!environment_count) command.launch.environment.push_back(L'\0');
    command.launch.environment.push_back(L'\0');
    const auto count = reader.Integer(4);
    if (!count || count > 4096) return ERROR_INVALID_PARAMETER;
    for (std::uint64_t index = 0; index < count; ++index) {
      const auto name = reader.Text(512);
      const auto size = reader.Integer(8);
      const auto hash = reader.Hash();
      command.runtime_files.push_back({name, size, hash});
    }
    if (protected_workspace) {
      RuntimeWorkspaceReference reference;
      reference.parent_path = reader.Text();
      reference.owner_sid = reader.Text(184);
      reference.controller_sid = reader.Text(184);
      reference.identities.parent = reader.Identity();
      for (auto& identity : reference.identities.directories) identity = reader.Identity();
      command.protected_workspace = std::move(reference);
    }
    if (!reader.Complete()) return ERROR_INVALID_PARAMETER;
    *output = std::move(command); *output_limits = limits;
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_INVALID_PARAMETER; }
}
std::string WorkerStdioCompletion(const RuntimeJobResult& result, DWORD bridge_error) {
  const auto& job = result.job;
  return "{\"schemaVersion\":\"goatcitadel.worker-native-stdio.v1\",\"bridgeError\":" + std::to_string(bridge_error) +
    ",\"end\":" + std::to_string(static_cast<unsigned>(job.end)) + ",\"error\":" + std::to_string(job.error) +
    ",\"processExitCode\":" + std::to_string(job.process_exit_code) + ",\"processId\":" + std::to_string(job.process_id) +
    ",\"runtimeBundleVerified\":" + Boolean(result.runtime_bundle_verified) + ",\"runtimeBundleSha256\":\"" + Hex(result.runtime_bundle_sha256) +
    "\",\"zeroProcessesVerified\":" + Boolean(job.zero_processes_verified) + ",\"outputDrained\":" + Boolean(job.output_drained) +
    ",\"appContainerVerified\":" + Boolean(job.app_container_verified) + ",\"launchFilesVerified\":" + Boolean(job.launch_files_verified) +
    ",\"processImageVerified\":" + Boolean(job.process_image_verified) +
    ",\"protectedWorkspaceVerified\":" + Boolean(result.protected_workspace_verified) +
    ",\"standardInputBytesWritten\":" + std::to_string(job.standard_input_bytes_written) + ",\"standardInputComplete\":" + Boolean(job.standard_input_complete) +
    ",\"standardOutputBytes\":" + std::to_string(job.standard_output.raw_bytes) + ",\"standardErrorBytes\":" + std::to_string(job.standard_error.raw_bytes) + "}";
}
}  // namespace goatcitadel::worker_cell
