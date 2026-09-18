#include "cell_runtime_dispatch.hpp"
#include "cell_stdio_protocol.hpp"
#include <algorithm>
#include <bcrypt.h>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
std::uint32_t U32(const std::uint8_t* bytes) noexcept {
  return static_cast<std::uint32_t>(bytes[0]) | (static_cast<std::uint32_t>(bytes[1]) << 8) |
    (static_cast<std::uint32_t>(bytes[2]) << 16) | (static_cast<std::uint32_t>(bytes[3]) << 24);
}
template <typename Bytes> bool Nonzero(const Bytes& bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; });
}
DWORD DecodeFilePlan(std::span<const std::uint8_t> bytes, CellRuntimeFilePlan* output) {
  if (bytes.size() < 25 || bytes.size() > 20 + 64 * 516 || std::memcmp(bytes.data(), "GCFPLAN1", 8)) return ERROR_INVALID_PARAMETER;
  const auto count = U32(bytes.data() + 8);
  CellRuntimeFilePlan plan;
  plan.maximum_file_bytes = U32(bytes.data() + 12); plan.maximum_total_bytes = U32(bytes.data() + 16);
  if (!count || count > 64 || !plan.maximum_file_bytes || plan.maximum_file_bytes > 1048576 ||
      !plan.maximum_total_bytes || plan.maximum_total_bytes > 64 * 1048576) return ERROR_INVALID_PARAMETER;
  std::size_t offset = 20;
  for (std::uint32_t index = 0; index < count; ++index) {
    if (offset + 4 > bytes.size()) return ERROR_INVALID_PARAMETER;
    const auto length = U32(bytes.data() + offset); offset += 4;
    if (!length || length > 512 || offset + length > bytes.size()) return ERROR_INVALID_PARAMETER;
    const auto* text = reinterpret_cast<const char*>(bytes.data() + offset);
    const auto size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, static_cast<int>(length), nullptr, 0);
    if (!size) return ERROR_INVALID_PARAMETER;
    std::wstring path(static_cast<std::size_t>(size), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, static_cast<int>(length), path.data(), size) != size ||
        !IsCellRuntimeFileSelectionPath(path)) return ERROR_INVALID_PARAMETER;
    for (const auto& previous : plan.paths)
      if (CompareStringOrdinal(previous.data(), static_cast<int>(previous.size()), path.data(), size, TRUE) == CSTR_EQUAL) return ERROR_INVALID_PARAMETER;
    plan.paths.push_back(std::move(path)); offset += length;
  }
  if (offset != bytes.size()) return ERROR_INVALID_PARAMETER;
  *output = std::move(plan); return ERROR_SUCCESS;
}
DWORD SelectBoundPaths(void* raw, std::vector<std::wstring>* output) noexcept {
  try { *output = static_cast<const CellRuntimeFilePlan*>(raw)->paths; return ERROR_SUCCESS; }
  catch (...) { output->clear(); return ERROR_NOT_ENOUGH_MEMORY; }
}
}
DWORD HashCellRuntimeDispatch(std::span<const std::uint8_t> input, CellFileSha256* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  if (input.size() <= 156 || input.size() > kMaximumRuntimeDispatchBytes) { *output = {}; return ERROR_INVALID_PARAMETER; }
  try {
    constexpr char domain[] = "goatcitadel.worker-runtime-dispatch.v1";
    std::vector<std::uint8_t> bytes(domain, domain + sizeof(domain));
    bytes.insert(bytes.end(), input.begin(), input.end());
    *output = {};
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
    CellFileSha256 digest{};
    const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) return ERROR_INVALID_DATA;
    *output = digest; return ERROR_SUCCESS;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellRuntimeDispatch(const std::vector<std::uint8_t>& input,
  const CellRuntimeDispatchBinding& supplied_expected, CellRuntimeDispatch* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    const auto expected = supplied_expected;
    if (input.size() <= 156 || input.size() > kMaximumRuntimeDispatchBytes) { *output = {}; return ERROR_INVALID_PARAMETER; }
    const auto bytes = input;
    *output = {};
    if (!Nonzero(expected.nonce) || !Nonzero(expected.request_sha256)) return ERROR_ACCESS_DENIED;
    CellFileSha256 digest{};
    auto error = HashCellRuntimeDispatch(bytes, &digest);
    if (error) return error;
    if (digest != expected.request_sha256 || !std::equal(expected.nonce.begin(), expected.nonce.end(), bytes.begin() + 8)) return ERROR_ACCESS_DENIED;
    const bool with_plan = std::memcmp(bytes.data(), "GCRUN002", 8) == 0;
    const std::size_t configuration_end = 144ULL + U32(bytes.data() + 140);
    if ((!with_plan && std::memcmp(bytes.data(), "GCRUN001", 8)) || configuration_end <= 156 || configuration_end > bytes.size() ||
        (!with_plan && configuration_end != bytes.size()) ||
        std::memcmp(bytes.data() + 144, kWorkerProtectedStdioMagic, 8) || U32(bytes.data() + 152) != configuration_end - 156)
      return ERROR_INVALID_PARAMETER;
    CellRuntimeDispatch value;
    auto& reference = value.reference;
    for (unsigned index = 0; index < 8; ++index) reference.anchor.file.volume_serial |= static_cast<std::uint64_t>(bytes[40 + index]) << (index * 8);
    std::copy_n(bytes.begin() + 48, 16, reference.anchor.file.file_id.begin());
    std::copy_n(bytes.begin() + 64, 32, reference.anchor.prepared_sha256.begin());
    std::copy_n(bytes.begin() + 96, 32, reference.checkpoint_sha256.begin());
    reference.inventory_limits = {U32(bytes.data() + 128), U32(bytes.data() + 132), U32(bytes.data() + 136)};
    const auto& limits = reference.inventory_limits;
    if (!reference.anchor.file.volume_serial || !Nonzero(reference.anchor.file.file_id) || !Nonzero(reference.anchor.prepared_sha256) ||
        !Nonzero(reference.checkpoint_sha256) || !limits.max_entries || limits.max_entries > 20000 || limits.max_depth > 64 ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 60000) return ERROR_INVALID_PARAMETER;
    error = DecodeWorkerStdioConfiguration(std::vector<std::uint8_t>(bytes.begin() + 156, bytes.begin() + configuration_end), &value.command, &value.limits, true, 86'400'000);
    if (error) return error;
    if (with_plan) {
      CellRuntimeFilePlan plan;
      error = DecodeFilePlan(std::span<const std::uint8_t>(bytes).subspan(configuration_end), &plan);
      if (error) return error;
      value.file_staging = std::move(plan);
    }
    value.binding = expected;
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
CellRuntimeDispatchResult RunCellRuntimeDispatch(CellProvisioningJournal& journal,
  const std::vector<std::uint8_t>& bytes, const CellRuntimeDispatchBinding& expected,
  const CellFootprintScanGuard& authority, JobStdioChannel* stdio, const CellRuntimeFileStaging* staging) noexcept {
  CellRuntimeDispatchResult result;
  CellRuntimeDispatch request;
  result.execution.runtime.job.error = DecodeCellRuntimeDispatch(bytes, expected, &request);
  if (result.execution.runtime.job.error) return result;
  result.binding = request.binding; result.binding_verified = true;
  CellRuntimeFileStaging bound_staging;
  if (request.file_staging) {
    if (staging) { result.execution.runtime.job.error = ERROR_INVALID_PARAMETER; return result; }
    bound_staging.context = &*request.file_staging;
    bound_staging.maximum_files = static_cast<std::uint32_t>(request.file_staging->paths.size());
    bound_staging.maximum_file_bytes = request.file_staging->maximum_file_bytes;
    bound_staging.maximum_total_bytes = request.file_staging->maximum_total_bytes;
    bound_staging.select_paths = SelectBoundPaths;
    staging = &bound_staging;
  }
  result.execution = CellJournalRuntimeRunner::Run(journal, request.reference, request.command, request.limits, authority, stdio, staging);
  return result;
}
}
