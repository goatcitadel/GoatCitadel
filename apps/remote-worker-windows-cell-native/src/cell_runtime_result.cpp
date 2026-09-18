#include "cell_runtime_result.hpp"
#include "cell_controller_protocol.hpp"
#include "cell_security.hpp"
#include <algorithm>
#include <bcrypt.h>
#include <cstring>
#include <limits>
#include <winternl.h>

#pragma comment(lib, "onecore.lib")

namespace goatcitadel::worker_cell {
namespace {
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned count = 4) noexcept {
  for (unsigned i = 0; i < count; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint64_t Number(const std::uint8_t* bytes, unsigned count = 4) noexcept {
  std::uint64_t value = 0; for (unsigned i = 0; i < count; ++i) value |= static_cast<std::uint64_t>(bytes[i]) << (8 * i); return value;
}
bool Nonzero(const CellFileSha256& bytes) noexcept { return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; }); }
bool Valid(const CellRuntimeDispatch& expected, const CellRuntimeDispatchResult& value) noexcept {
  const auto& runtime = value.execution.runtime; const auto& job = runtime.job;
  if (!Nonzero(expected.binding.nonce) || !Nonzero(expected.binding.request_sha256) || !Nonzero(expected.reference.checkpoint_sha256) ||
      !expected.command.protected_workspace || !value.binding_verified || value.binding.nonce != expected.binding.nonce ||
      value.binding.request_sha256 != expected.binding.request_sha256 || static_cast<unsigned>(job.end) > static_cast<unsigned>(JobEnd::control_failed) ||
      job.configured_cpu_rate > 10000 || job.standard_input_bytes_written > expected.limits.input_bytes ||
      job.standard_output.raw_bytes > expected.limits.raw_output_bytes || job.standard_error.raw_bytes > expected.limits.raw_output_bytes - job.standard_output.raw_bytes ||
      job.peak_job_memory_bytes > 9007199254740991ULL || job.cpu_time_100ns > 9007199254740991ULL) return false;
  if (job.quiescent_capture_verified && (!job.quiescent_capture_attempted || !job.zero_processes_verified || !job.output_drained || job.quiescent_capture_error)) return false;
  if (runtime.runtime_bundle_verified ? runtime.runtime_bundle_sha256 != expected.command.expected_runtime_bundle || !Nonzero(runtime.runtime_bundle_sha256) :
      Nonzero(runtime.runtime_bundle_sha256)) return false;
  const auto& backing = value.execution.backing;
  if (value.execution.backing_verified) {
    if (!value.execution.inventory_verified || !backing.file_bytes || backing.allocated_bytes < backing.file_bytes ||
        backing.journal_bytes != 21 * 1024 || backing.journal_allocated_bytes < backing.journal_bytes ||
        backing.journal_allocated_bytes > kCellProvisioningJournalMaximumAllocatedBytes ||
        backing.allocated_bytes > 9007199254740991ULL - backing.journal_allocated_bytes) return false;
  } else if (backing != CellRuntimeBackingCounts{}) return false;
  if (!value.execution.inventory_verified) return value.execution.inventory == CellProvisioningInventory{};
  const auto& inventory = value.execution.inventory;
  return job.process_id && job.app_container_verified && job.launch_files_verified && job.process_image_verified && job.quiescent_capture_verified &&
    runtime.runtime_bundle_verified && runtime.protected_workspace_verified && inventory.anchor == expected.reference.anchor &&
    inventory.checkpoint_sha256 == expected.reference.checkpoint_sha256 && inventory.workspace == expected.command.protected_workspace->identities &&
    inventory.inventory.entries.size() <= expected.reference.inventory_limits.max_entries && ValidateCellControllerInventory(inventory);
}
std::array<bool, 16> Flags(const CellRuntimeDispatchResult& value) noexcept {
  const auto& runtime = value.execution.runtime; const auto& job = runtime.job;
  return {value.binding_verified, runtime.runtime_bundle_verified, runtime.protected_workspace_verified, value.execution.inventory_verified,
    job.terminated_descendants, job.zero_processes_verified, job.output_drained, job.quiescent_capture_attempted, job.quiescent_capture_verified,
    job.app_container_verified, job.launch_files_verified, job.process_image_verified, job.standard_input_complete,
    job.standard_output.truncated, job.standard_error.truncated, value.execution.backing_verified};
}
using TransferHeader = std::array<std::uint8_t, 112>;
TransferHeader Header(const char* magic, const CellRuntimeDispatchBinding& binding, const CellFileSha256& digest, DWORD size) noexcept {
  TransferHeader header{}; std::memcpy(header.data(), magic, 8);
  std::copy(binding.nonce.begin(), binding.nonce.end(), header.begin() + 8);
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), header.begin() + 40);
  std::copy(digest.begin(), digest.end(), header.begin() + 72); Put(header.data() + 104, size); Put(header.data() + 108, 4096);
  return header;
}
}
DWORD EncodeCellRuntimeResult(const CellRuntimeDispatch& expected, const CellRuntimeDispatchResult& value,
  std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    if (!Valid(expected, value)) { output->clear(); return ERROR_INVALID_DATA; }
    const auto& inventory = value.execution.inventory;
    const auto entries = inventory.inventory.entries.size();
    const auto chunks = (entries + kCellControllerInventoryChunkEntries - 1) / kCellControllerInventoryChunkEntries;
    std::vector<std::uint8_t> bytes(256 + (value.execution.inventory_verified ? 352 + 1000 * chunks : 0));
    std::memcpy(bytes.data(), "GCRRS001", 8);
    std::copy(value.binding.nonce.begin(), value.binding.nonce.end(), bytes.begin() + 8);
    std::copy(value.binding.request_sha256.begin(), value.binding.request_sha256.end(), bytes.begin() + 40);
    std::copy(expected.reference.checkpoint_sha256.begin(), expected.reference.checkpoint_sha256.end(), bytes.begin() + 72);
    const auto flags = Flags(value); std::uint32_t packed = 0;
    for (unsigned i = 0; i < flags.size(); ++i) if (flags[i]) packed |= 1u << i;
    const auto& runtime = value.execution.runtime; const auto& job = runtime.job;
    Put(bytes.data() + 104, packed); Put(bytes.data() + 108, static_cast<unsigned>(job.end));
    const std::array<DWORD, 7> numbers{job.error, job.process_exit_code, job.process_id, job.configured_cpu_rate,
      job.total_processes, job.sampled_peak_active_processes, job.quiescent_capture_error};
    for (unsigned i = 0; i < numbers.size(); ++i) Put(bytes.data() + 112 + 4 * i, numbers[i]);
    const std::array<std::uint64_t, 5> large{job.peak_job_memory_bytes, job.cpu_time_100ns, job.standard_input_bytes_written,
      job.standard_output.raw_bytes, job.standard_error.raw_bytes};
    for (unsigned i = 0; i < large.size(); ++i) Put(bytes.data() + 144 + 8 * i, large[i], 8);
    std::copy(runtime.runtime_bundle_sha256.begin(), runtime.runtime_bundle_sha256.end(), bytes.begin() + 184);
    Put(bytes.data() + 216, entries);
    const auto& backing = value.execution.backing;
    const std::array<std::uint64_t, 4> charges{backing.file_bytes, backing.allocated_bytes, backing.journal_bytes, backing.journal_allocated_bytes};
    for (unsigned i = 0; i < charges.size(); ++i) Put(bytes.data() + 220 + 8 * i, charges[i], 8);
    if (value.execution.inventory_verified) {
      CellControllerCapacityBytes summary{};
      if (!EncodeCellControllerCapacity(value.binding.nonce, {inventory.anchor, inventory.assignment_binding, inventory.profile_sha256,
          inventory.checkpoint_sha256, inventory.workspace, inventory.inventory.footprint}, &summary)) { output->clear(); return ERROR_INVALID_DATA; }
      std::copy(summary.begin(), summary.end(), bytes.begin() + 256);
      for (std::size_t i = 0; i < chunks; ++i) {
        const auto start = i * kCellControllerInventoryChunkEntries;
        const auto count = std::min(kCellControllerInventoryChunkEntries, entries - start);
        CellControllerInventoryChunkBytes chunk{};
        if (!EncodeCellControllerInventoryChunk(value.binding.nonce, static_cast<std::uint32_t>(start),
            std::span(inventory.inventory.entries).subspan(start, count), &chunk)) { output->clear(); return ERROR_INVALID_DATA; }
        std::copy(chunk.begin(), chunk.end(), bytes.begin() + 608 + i * chunk.size());
      }
    }
    *output = std::move(bytes); return ERROR_SUCCESS;
  } catch (...) { output->clear(); return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellRuntimeResult(const CellRuntimeDispatch& supplied_expected, const std::vector<std::uint8_t>& supplied,
  CellRuntimeDispatchResult* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    const auto expected = supplied_expected;
    if (supplied.size() < 256 || supplied.size() > kMaximumCellRuntimeResultBytes) { *output = {}; return ERROR_INVALID_DATA; }
    const auto bytes = supplied; *output = {};
    if (std::memcmp(bytes.data(), "GCRRS001", 8) || !std::equal(expected.binding.nonce.begin(), expected.binding.nonce.end(), bytes.begin() + 8) ||
        !std::equal(expected.binding.request_sha256.begin(), expected.binding.request_sha256.end(), bytes.begin() + 40) ||
        !std::equal(expected.reference.checkpoint_sha256.begin(), expected.reference.checkpoint_sha256.end(), bytes.begin() + 72)) return ERROR_INVALID_DATA;
    CellRuntimeDispatchResult value; value.binding = expected.binding;
    auto& runtime = value.execution.runtime; auto& job = runtime.job;
    const std::array<bool*, 16> flags{&value.binding_verified, &runtime.runtime_bundle_verified, &runtime.protected_workspace_verified, &value.execution.inventory_verified,
      &job.terminated_descendants, &job.zero_processes_verified, &job.output_drained, &job.quiescent_capture_attempted, &job.quiescent_capture_verified,
      &job.app_container_verified, &job.launch_files_verified, &job.process_image_verified, &job.standard_input_complete,
      &job.standard_output.truncated, &job.standard_error.truncated, &value.execution.backing_verified};
    const auto packed = Number(bytes.data() + 104);
    for (unsigned i = 0; i < flags.size(); ++i) *flags[i] = (packed & (std::uint64_t{1} << i)) != 0;
    job.end = static_cast<JobEnd>(Number(bytes.data() + 108));
    const std::array<DWORD*, 7> numbers{&job.error, &job.process_exit_code, &job.process_id, &job.configured_cpu_rate,
      &job.total_processes, &job.sampled_peak_active_processes, &job.quiescent_capture_error};
    for (unsigned i = 0; i < numbers.size(); ++i) *numbers[i] = static_cast<DWORD>(Number(bytes.data() + 112 + 4 * i));
    const std::array<std::uint64_t*, 5> large{&job.peak_job_memory_bytes, &job.cpu_time_100ns, &job.standard_input_bytes_written,
      &job.standard_output.raw_bytes, &job.standard_error.raw_bytes};
    for (unsigned i = 0; i < large.size(); ++i) *large[i] = Number(bytes.data() + 144 + 8 * i, 8);
    std::copy_n(bytes.begin() + 184, 32, runtime.runtime_bundle_sha256.begin());
    const auto count = Number(bytes.data() + 216);
    value.execution.backing = {Number(bytes.data() + 220, 8), Number(bytes.data() + 228, 8),
      Number(bytes.data() + 236, 8), Number(bytes.data() + 244, 8)};
    if (count > 20000 || count > expected.reference.inventory_limits.max_entries) return ERROR_INVALID_DATA;
    const auto chunks = (count + kCellControllerInventoryChunkEntries - 1) / kCellControllerInventoryChunkEntries;
    if (bytes.size() != 256 + (value.execution.inventory_verified ? 352 + 1000 * chunks : 0) || (!value.execution.inventory_verified && count)) return ERROR_INVALID_DATA;
    if (value.execution.inventory_verified) {
      CellControllerCapacityBytes summary{}; std::copy_n(bytes.begin() + 256, summary.size(), summary.begin());
      CellProvisioningFootprint footprint;
      if (!DecodeCellControllerCapacity(expected.binding.nonce, summary, &footprint)) return ERROR_INVALID_DATA;
      auto& inventory = value.execution.inventory;
      inventory = {footprint.anchor, footprint.assignment_binding, footprint.profile_sha256, footprint.checkpoint_sha256,
        footprint.workspace, {footprint.footprint, {}}};
      inventory.inventory.entries.reserve(static_cast<std::size_t>(count));
      for (std::size_t i = 0; i < chunks; ++i) {
        CellControllerInventoryChunkBytes chunk{}; std::copy_n(bytes.begin() + 608 + i * chunk.size(), chunk.size(), chunk.begin());
        CellControllerInventoryChunk decoded;
        if (!DecodeCellControllerInventoryChunk(expected.binding.nonce, chunk, &decoded) || decoded.start != inventory.inventory.entries.size() ||
            decoded.count != std::min<std::uint64_t>(kCellControllerInventoryChunkEntries, count - decoded.start)) return ERROR_INVALID_DATA;
        inventory.inventory.entries.insert(inventory.inventory.entries.end(), decoded.entries.begin(), decoded.entries.begin() + decoded.count);
      }
    }
    std::vector<std::uint8_t> canonical;
    const auto error = EncodeCellRuntimeResult(expected, value, &canonical);
    if (error || canonical != bytes) return error ? error : ERROR_INVALID_DATA;
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD HashCellRuntimeResult(std::span<const std::uint8_t> input, CellFileSha256* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    if (input.size() < 256 || input.size() > kMaximumCellRuntimeResultBytes) { *output = {}; return ERROR_INVALID_PARAMETER; }
    constexpr char domain[] = "goatcitadel.worker-runtime-result.v1";
    std::vector<std::uint8_t> bytes(domain, domain + sizeof(domain)); bytes.insert(bytes.end(), input.begin(), input.end()); *output = {};
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
    CellFileSha256 digest{};
    const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) return ERROR_INVALID_DATA;
    *output = digest; return ERROR_SUCCESS;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellRuntimePoolCleanup(std::span<const std::uint8_t> bytes, const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid, CellRuntimePoolCleanupSet* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    if (bytes.size() < kCellRuntimePoolCleanupHeaderBytes || bytes.size() > kMaximumCellRuntimePoolCleanupBytes ||
        std::memcmp(bytes.data(), "GCPCLN01", 8) || Number(bytes.data() + 12) != 1) return ERROR_INVALID_DATA;
    CellControllerPoolHistory pool;
    auto error = DecodeCellControllerPoolHistory(request.pool_history, request, owner_sid, controller_sid, &pool);
    if (error) return error;
    if (Number(bytes.data() + 8) != pool.members.size() ||
        !std::equal(pool.snapshot_sha256.begin(), pool.snapshot_sha256.end(), bytes.begin() + 16)) return ERROR_INVALID_DATA;
    CellRuntimeCleanupAdmission current;
    error = DecodeCellControllerCleanupAdmission(request, &current); if (error) return error;
    CellRuntimePoolCleanupSet result;
    std::copy_n(bytes.begin() + 48, 32, result.snapshot_sha256.begin());
    if (!Nonzero(result.snapshot_sha256)) return ERROR_INVALID_DATA;
    std::size_t position = kCellRuntimePoolCleanupHeaderBytes, attempts = 0;
    for (auto& member : pool.members) {
      if (bytes.size() - position < kCellRuntimePoolCleanupMemberHeaderBytes ||
          !std::equal(member.plan.assignment_binding.begin(), member.plan.assignment_binding.end(), bytes.begin() + position)) return ERROR_INVALID_DATA;
      const auto admission_bytes = static_cast<std::size_t>(Number(bytes.data() + position + 32));
      const auto cleanup_bytes = static_cast<std::size_t>(Number(bytes.data() + position + 36));
      position += kCellRuntimePoolCleanupMemberHeaderBytes;
      if ((admission_bytes != 80 && admission_bytes != 416) || admission_bytes > bytes.size() - position ||
          cleanup_bytes < 252 || cleanup_bytes > kMaximumCellRuntimeCleanupBytes || (cleanup_bytes - 252) % 108 ||
          cleanup_bytes > bytes.size() - position - admission_bytes) return ERROR_INVALID_DATA;
      std::copy_n(bytes.begin() + position, admission_bytes, member.cleanup_admission.begin()); position += admission_bytes;
      CellRuntimeCleanupAdmission admission;
      error = DecodeCellControllerCleanupAdmission(member, &admission);
      if (error) return error;
      if (admission_bytes != 80 + 336 * admission.installations.size() || admission.binding.challenge != current.binding.challenge ||
          (member.anchor == request.anchor && member.cell_name == request.cell_name && member.cleanup_admission != request.cleanup_admission)) return ERROR_INVALID_DATA;
      CellRuntimeCleanupSet set;
      error = DecodeCellControllerCleanup(member, bytes.subspan(position, cleanup_bytes), admission.binding, owner_sid, controller_sid, &set);
      if (error) return error;
      position += cleanup_bytes;
      attempts += set.expectations.size(); if (attempts > 1000) return ERROR_INVALID_DATA;
      result.admissions.push_back(std::move(admission)); result.members.push_back(std::move(set));
    }
    if (position != bytes.size()) return ERROR_INVALID_DATA;
    *output = std::move(result); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD HashCellRuntimeCleanup(std::span<const std::uint8_t> input, CellFileSha256* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (input.size() < 252 || input.size() > kMaximumCellRuntimeCleanupBytes) return ERROR_INVALID_PARAMETER;
  try {
    constexpr char domain[] = "goatcitadel.worker-runtime-cleanup.v1";
    std::vector<std::uint8_t> bytes(domain, domain + sizeof(domain)); bytes.insert(bytes.end(), input.begin(), input.end());
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
    CellFileSha256 digest{};
    const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), digest.data(), static_cast<ULONG>(digest.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) return ERROR_INVALID_DATA;
    *output = digest; return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD DecodeCellRuntimeCleanup(std::span<const std::uint8_t> input, const CellRuntimeCleanupBinding& expected, CellRuntimeCleanupSet* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto binding = expected;
  *output = {};
  if (input.size() < 252 || input.size() > kMaximumCellRuntimeCleanupBytes || !Nonzero(binding.challenge) || !Nonzero(binding.set_sha256)) return ERROR_INVALID_PARAMETER;
  try {
    const std::vector<std::uint8_t> bytes(input.begin(), input.end());
    CellFileSha256 digest{}; const auto error = HashCellRuntimeCleanup(bytes, &digest); if (error) return error;
    if (digest != binding.set_sha256 || std::memcmp(bytes.data(), "GCCLEAN1", 8) ||
        !std::equal(binding.challenge.begin(), binding.challenge.end(), bytes.begin() + 8)) return ERROR_INVALID_DATA;
    const auto count = Number(bytes.data() + 248);
    if (count > 1000 || bytes.size() != 252 + count * 108) return ERROR_INVALID_DATA;
    const auto identity = [&](std::size_t offset) {
      CellFileIdentity value{Number(bytes.data() + offset, 8)};
      std::copy_n(bytes.begin() + offset + 8, 16, value.file_id.begin()); return value;
    };
    const auto valid_identity = [](const CellFileIdentity& value) {
      return value.volume_serial && std::any_of(value.file_id.begin(), value.file_id.end(), [](auto byte) { return byte != 0; });
    };
    CellRuntimeCleanupSet value; value.binding = binding; value.anchor.file = identity(40);
    std::copy_n(bytes.begin() + 64, 32, value.anchor.prepared_sha256.begin());
    std::copy_n(bytes.begin() + 96, 32, value.checkpoint_sha256.begin());
    value.workspace.parent = identity(128);
    if (!valid_identity(value.anchor.file) || !Nonzero(value.anchor.prepared_sha256) || !Nonzero(value.checkpoint_sha256) || !valid_identity(value.workspace.parent)) return ERROR_INVALID_DATA;
    for (std::size_t index = 0; index < value.workspace.directories.size(); ++index) {
      const auto directory = identity(152 + index * 24);
      if (!valid_identity(directory) || directory.volume_serial != value.workspace.parent.volume_serial || directory == value.workspace.parent ||
          std::find(value.workspace.directories.begin(), value.workspace.directories.begin() + index, directory) != value.workspace.directories.begin() + index) return ERROR_INVALID_DATA;
      value.workspace.directories[index] = directory;
    }
    for (std::size_t index = 0; index < count; ++index) {
      const auto offset = 252 + index * 108;
      CellRuntimeCleanupExpectation item; item.anchor = value.anchor; item.checkpoint_sha256 = value.checkpoint_sha256; item.workspace = value.workspace;
      std::copy_n(bytes.begin() + offset, 32, item.binding.nonce.begin());
      std::copy_n(bytes.begin() + offset + 32, 32, item.binding.request_sha256.begin());
      std::copy_n(bytes.begin() + offset + 64, 32, item.runtime_bundle_sha256.begin());
      item.maximum_input_bytes = static_cast<DWORD>(Number(bytes.data() + offset + 96));
      item.maximum_output_bytes = Number(bytes.data() + offset + 100);
      item.maximum_inventory_entries = static_cast<DWORD>(Number(bytes.data() + offset + 104));
      if (!Nonzero(item.binding.nonce) || !Nonzero(item.binding.request_sha256) || !Nonzero(item.runtime_bundle_sha256) ||
          item.maximum_input_bytes > 1048576 || !item.maximum_output_bytes || item.maximum_output_bytes > 67108864 ||
          !item.maximum_inventory_entries || item.maximum_inventory_entries > 20000 ||
          (!value.expectations.empty() && value.expectations.back().binding.nonce >= item.binding.nonce)) return ERROR_INVALID_DATA;
      value.expectations.push_back(std::move(item));
    }
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
namespace {
template <std::size_t Size>
std::array<std::uint8_t, Size> CleanupHeader(const char* magic, const CellRuntimeCleanupBinding& binding, DWORD size) noexcept {
  std::array<std::uint8_t, Size> bytes{}; std::memcpy(bytes.data(), magic, 8);
  std::copy(binding.challenge.begin(), binding.challenge.end(), bytes.begin() + 8);
  std::copy(binding.set_sha256.begin(), binding.set_sha256.end(), bytes.begin() + 40);
  Put(bytes.data() + 72, size); return bytes;
}
constexpr DWORD kCleanupChunkBytes = 4096;
}
DWORD DecodeCellRuntimeCleanupAdmission(std::span<const std::uint8_t> bytes, CellRuntimeCleanupAdmission* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if ((bytes.size() != 80 && bytes.size() != 416) || std::memcmp(bytes.data(), "GCCADM01", 8) ||
      Number(bytes.data() + 72) != (bytes.size() - 80) / 336 || Number(bytes.data() + 76)) return ERROR_INVALID_DATA;
  try {
    CellRuntimeCleanupAdmission value;
    std::copy_n(bytes.begin() + 8, 32, value.binding.challenge.begin());
    std::copy_n(bytes.begin() + 40, 32, value.binding.set_sha256.begin());
    if (!Nonzero(value.binding.challenge) || !Nonzero(value.binding.set_sha256)) return ERROR_INVALID_DATA;
    if (bytes.size() == 416) {
      CellRuntimeInstallationExpectation installation;
      std::copy_n(bytes.begin() + 80, 32, installation.binding.nonce.begin());
      std::copy_n(bytes.begin() + 112, 32, installation.binding.request_sha256.begin());
      std::copy_n(bytes.begin() + 144, kCellRuntimeInstallBytes, installation.bytes.begin());
      CellRuntimeInstallRequest request;
      const auto error = DecodeCellRuntimeInstall(installation.bytes, installation.binding, &request);
      if (error) return error;
      value.installations.push_back(std::move(installation));
    }
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeCleanupTransfer::Check() const noexcept {
  const auto control = [&]() noexcept -> DWORD {
    if (!authority_.cancellation || authority_.cancellation == INVALID_HANDLE_VALUE) return ERROR_INVALID_HANDLE;
    const auto state = WaitForSingleObject(authority_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    if (now >= deadline_) return ERROR_TIMEOUT;
    return deadline_ - now > 60000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = control();
  if (!error) error = authority_.authorize(authority_.context);
  return error ? error : control();
}
DWORD CellRuntimeCleanupTransfer::Begin() noexcept {
  if (attempted_) return ERROR_INVALID_STATE;
  attempted_ = true;
  if (!authority_.authorize || !Nonzero(binding_.challenge) || !Nonzero(binding_.set_sha256)) return ERROR_INVALID_PARAMETER;
  return Check();
}
DWORD CellRuntimeCleanupTransfer::Read(CellRuntimeCleanupSet* output) noexcept {
  return ReadBound(output, nullptr, nullptr, nullptr);
}
DWORD CellRuntimeCleanupTransfer::ReadForController(const CellControllerRequest& supplied, const std::wstring& owner_sid,
    const std::wstring& controller_sid, CellRuntimeCleanupSet* output) noexcept {
  return ReadController(supplied, owner_sid, controller_sid, output, nullptr);
}
DWORD CellRuntimeCleanupTransfer::ReadVerifiedForController(CellProvisioningJournal& journal, const CellControllerRequest& request,
    const std::wstring& owner_sid, const std::wstring& controller_sid,
    std::span<const CellRuntimeInstallationExpectation> installations, CellRuntimeCleanupSet* output) noexcept {
  if (output) *output = {};
  if (attempted_) return ERROR_INVALID_STATE;
  if (!output || installations.size() > 1000) { attempted_ = true; return ERROR_INVALID_PARAMETER; }
  try {
    // Freeze independently retained installation metadata before any peer or
    // journal callback. The enclosing transfer deadline covers both namespaces.
    struct History final {
      CellProvisioningJournal& journal;
      std::vector<CellRuntimeInstallationExpectation> installations;
      ULONGLONG deadline;
    } history{journal, {installations.begin(), installations.end()}, deadline_};
    const CoverageOwner coverage{&history,
      [](void* raw, const CellRuntimeCleanupSet& set, const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept -> DWORD {
        const auto& held = *static_cast<History*>(raw);
        auto error = CellRuntimeLocalOutcome::VerifyInstallationCoverage(held.journal, set.anchor,
          set.checkpoint_sha256, held.installations, guard, wall_ms);
        if (error) return error;
        const auto now = GetTickCount64();
        if (now >= held.deadline) return ERROR_TIMEOUT;
        return CellRuntimeLocalOutcome::VerifyCleanupCoverage(held.journal, set.anchor,
          set.checkpoint_sha256, set.expectations, guard, static_cast<DWORD>(held.deadline - now));
      }};
    return ReadController(request, owner_sid, controller_sid, output, &coverage);
  } catch (...) { attempted_ = true; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeCleanupTransfer::ReadController(const CellControllerRequest& supplied, const std::wstring& owner_sid,
    const std::wstring& controller_sid, CellRuntimeCleanupSet* output, const CoverageOwner* supplied_coverage) noexcept {
  if (output) *output = {};
  if (attempted_) return ERROR_INVALID_STATE;
  try {
    const auto request = supplied;
    const auto owner = owner_sid, controller = controller_sid;
    const auto coverage = supplied_coverage ? *supplied_coverage : CoverageOwner{};
    return ReadBound(output, &request, &owner, &controller, supplied_coverage ? &coverage : nullptr);
  } catch (...) { attempted_ = true; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeCleanupTransfer::ReadBound(CellRuntimeCleanupSet* output, const CellControllerRequest* request,
    const std::wstring* owner_sid, const std::wstring* controller_sid, const CoverageOwner* coverage) noexcept {
  if (!output) { const bool used = attempted_; attempted_ = true; return used ? ERROR_INVALID_STATE : ERROR_INVALID_PARAMETER; }
  *output = {};
  auto error = Begin(); if (error) return error;
  try {
    std::array<std::uint8_t, 96> header{};
    error = ReadCellPipe(pipe_, header.data(), static_cast<DWORD>(header.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (error) return error;
    const auto size = static_cast<DWORD>(Number(header.data() + 72));
    if (size < 252 || size > kMaximumCellRuntimeCleanupBytes || (size - 252) % 108) return ERROR_INVALID_DATA;
    auto expected_header = CleanupHeader<96>("GCCLX001", binding_, size); Put(expected_header.data() + 76, kCleanupChunkBytes);
    if (header != expected_header) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes(size);
    for (DWORD offset = 0; offset < size;) {
      error = Check(); if (error) return error;
      std::array<std::uint8_t, 16> chunk{};
      error = ReadCellPipe(pipe_, chunk.data(), static_cast<DWORD>(chunk.size()), authority_.cancellation, deadline_);
      if (error) return error;
      const DWORD count = std::min(kCleanupChunkBytes, size - offset);
      if (std::memcmp(chunk.data(), "GCCLD001", 8) || Number(chunk.data() + 8) != offset || Number(chunk.data() + 12) != count) return ERROR_INVALID_DATA;
      error = ReadCellPipe(pipe_, bytes.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check();
      if (error) return error;
      offset += count;
    }
    CellRuntimeCleanupSet value;
    error = request ? DecodeCellControllerCleanup(*request, bytes, binding_, *owner_sid, *controller_sid, &value) :
      DecodeCellRuntimeCleanup(bytes, binding_, &value);
    if (!error) error = Check();
    if (!error && coverage) {
      const auto now = GetTickCount64();
      error = !coverage->verify ? ERROR_INVALID_PARAMETER : now >= deadline_ ? ERROR_TIMEOUT :
        coverage->verify(coverage->context, value, authority_, static_cast<DWORD>(deadline_ - now));
      if (!error) error = Check();
    }
    if (error) return error;
    const auto ack = CleanupHeader<80>("GCCLA001", binding_, size);
    error = WriteCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error) *output = std::move(value);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeCleanupTransfer::Write(std::span<const std::uint8_t> supplied) noexcept {
  if (attempted_) return ERROR_INVALID_STATE;
  if (supplied.size() < 252 || supplied.size() > kMaximumCellRuntimeCleanupBytes) { attempted_ = true; return ERROR_INVALID_PARAMETER; }
  try {
    const std::vector<std::uint8_t> bytes(supplied.begin(), supplied.end());
    auto error = Begin(); if (error) return error;
    CellRuntimeCleanupSet decoded; error = DecodeCellRuntimeCleanup(bytes, binding_, &decoded); if (error) return error;
    const auto size = static_cast<DWORD>(bytes.size());
    auto header = CleanupHeader<96>("GCCLX001", binding_, size); Put(header.data() + 76, kCleanupChunkBytes);
    error = WriteCellPipe(pipe_, header.data(), static_cast<DWORD>(header.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (error) return error;
    for (DWORD offset = 0; offset < size;) {
      error = Check(); if (error) return error;
      const DWORD count = std::min(kCleanupChunkBytes, size - offset);
      std::array<std::uint8_t, 16> chunk{}; std::memcpy(chunk.data(), "GCCLD001", 8); Put(chunk.data() + 8, offset); Put(chunk.data() + 12, count);
      error = WriteCellPipe(pipe_, chunk.data(), static_cast<DWORD>(chunk.size()), authority_.cancellation, deadline_);
      if (!error) error = WriteCellPipe(pipe_, bytes.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check();
      if (error) return error;
      offset += count;
    }
    std::array<std::uint8_t, 80> ack{};
    error = ReadCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error && ack != CleanupHeader<80>("GCCLA001", binding_, size)) error = ERROR_INVALID_DATA;
    return error;
  } catch (...) { attempted_ = true; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD EncodeCellRuntimeStagedFile(const CellRuntimeDispatch& expected, const CellRuntimeDispatchResult& result,
  const CellFileIdentity& identity, std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  if (!output->empty()) SecureZeroMemory(output->data(), output->size());
  output->clear();
  try {
    if (!Valid(expected, result) || !result.execution.inventory_verified || result.execution.staged_files.size() > 64)
      return ERROR_INVALID_DATA;
    const auto& files = result.execution.staged_files;
    const auto file = std::find_if(files.begin(), files.end(), [&](const auto& item) { return item.entry.identity == identity; });
    if (file == files.end() || std::count_if(files.begin(), files.end(), [&](const auto& item) { return item.entry.identity == identity; }) != 1 ||
        file->entry.directory || file->bytes.size() > 1048576 || file->bytes.size() != file->entry.logical_file_bytes)
      return ERROR_INVALID_DATA;
    const auto& inventory = result.execution.inventory.inventory.entries;
    if (std::find(inventory.begin(), inventory.end(), file->entry) == inventory.end()) return ERROR_FILE_INVALID;
    std::vector<std::uint8_t> terminal;
    auto error = EncodeCellRuntimeResult(expected, result, &terminal);
    CellFileSha256 result_hash{}, content_hash{};
    if (!error) error = HashCellRuntimeResult(terminal, &result_hash);
    if (error) return error;
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
    const auto status = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(file->bytes.data()),
      static_cast<ULONG>(file->bytes.size()), content_hash.data(), static_cast<ULONG>(content_hash.size()));
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (status < 0) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes(200 + file->bytes.size());
    std::memcpy(bytes.data(), "GCRFA001", 8);
    std::copy(result.binding.nonce.begin(), result.binding.nonce.end(), bytes.begin() + 8);
    std::copy(result.binding.request_sha256.begin(), result.binding.request_sha256.end(), bytes.begin() + 40);
    std::copy(result_hash.begin(), result_hash.end(), bytes.begin() + 72);
    const auto& work = expected.command.protected_workspace->identities.directories[static_cast<std::size_t>(CellDirectory::work)];
    Put(bytes.data() + 104, work.volume_serial, 8); std::copy(work.file_id.begin(), work.file_id.end(), bytes.begin() + 112);
    Put(bytes.data() + 128, identity.volume_serial, 8); std::copy(identity.file_id.begin(), identity.file_id.end(), bytes.begin() + 136);
    Put(bytes.data() + 152, file->entry.logical_file_bytes, 8); Put(bytes.data() + 160, file->entry.allocated_bytes, 8);
    std::copy(content_hash.begin(), content_hash.end(), bytes.begin() + 168);
    std::copy(file->bytes.begin(), file->bytes.end(), bytes.begin() + 200);
    output->swap(bytes); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

struct CellRuntimeLocalOutcome::State final {
  static constexpr DWORD intent_bytes = 256, terminal_bytes = 96, seal_bytes = 32;
  static constexpr DWORD maximum_bytes = intent_bytes + terminal_bytes + static_cast<DWORD>(kMaximumCellRuntimeResultBytes) + seal_bytes;
  Owner owner;
  CellRuntimeDispatch expected;
  std::optional<CellRuntimeInstallRequest> installation;
  HANDLE file = INVALID_HANDLE_VALUE;
  CellFileIdentity identity;
  std::array<std::uint8_t, intent_bytes> intent{};
  DWORD failure = ERROR_SUCCESS;
  bool write_attempted = false;
  CellProvisioningJournal* journal = nullptr;
  std::uint64_t journal_lifetime = 0;
  HANDLE journal_file = INVALID_HANDLE_VALUE;
  std::vector<std::uint8_t> journal_bytes;
  std::wstring journal_name, journal_owner, journal_controller;
  ~State() { if (file != INVALID_HANDLE_VALUE && file) CloseHandle(file); }
  DWORD Fail(DWORD error) noexcept { if (error && !failure) failure = error; return failure; }
  static DWORD Error() noexcept { const auto error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
  static DWORD Hash(const char* domain, std::span<const std::uint8_t> input, CellFileSha256* output) noexcept {
    try {
      std::vector<std::uint8_t> bytes(domain, domain + std::strlen(domain) + 1); bytes.insert(bytes.end(), input.begin(), input.end());
      BCRYPT_ALG_HANDLE algorithm = nullptr;
      if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
      const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(bytes.size()), output->data(), static_cast<ULONG>(output->size()));
      BCryptCloseAlgorithmProvider(algorithm, 0); return status < 0 ? ERROR_INVALID_DATA : ERROR_SUCCESS;
    } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  }
  static DWORD Journal(void* raw) noexcept {
    auto& self = *static_cast<State*>(raw); auto& current = *self.journal;
    if (current.lifetime_revision_ != self.journal_lifetime || current.file_ != self.journal_file ||
        current.anchor_ != self.owner.anchor || current.records_ != self.journal_bytes || current.descriptor_ != self.owner.descriptor ||
        current.name_ != self.journal_name || current.owner_ != self.journal_owner || current.controller_ != self.journal_controller ||
        current.plan_.assignment_binding != self.owner.assignment || current.plan_.profile_sha256 != self.owner.profile ||
        current.workspace_.DirectoryHandle(CellDirectory::control) != self.owner.directory ||
        current.workspace_.DirectoryIdentity(CellDirectory::control) != self.owner.directory_identity) return ERROR_FILE_INVALID;
    // Recording the outcome is still permitted after runtime Verify has fenced
    // the journal. Check the original host custody, not its execution health or
    // a remote grant that may have been revoked while the owned job was joined.
    std::uint64_t size = 0;
    auto error = current.InspectFile(&size);
    if (!error && size != self.journal_bytes.size()) error = ERROR_FILE_INVALID;
    if (!error) error = current.workspace_.Verify();
    if (error) return error;
    std::array<std::uint8_t, 21 * 1024> bytes{}; LARGE_INTEGER start{}; DWORD read = 0;
    if (!SetFilePointerEx(current.file_, start, nullptr, FILE_BEGIN) ||
        !ReadFile(current.file_, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr)) return Error();
    return read == bytes.size() && std::equal(bytes.begin(), bytes.end(), self.journal_bytes.begin()) ? ERROR_SUCCESS : ERROR_FILE_INVALID;
  }
  DWORD BindJournal(CellProvisioningJournal& source, const CellProvisioningAnchor& anchor, const CellFileSha256& head, bool creation) {
    if ((creation && !source.healthy_) || source.lifetime_revision_ == std::numeric_limits<std::uint64_t>::max() ||
        source.mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded || source.records_.size() != 21 * 1024 ||
        anchor != source.anchor_ || !std::equal(head.begin(), head.end(), source.records_.end() - 32))
      return ERROR_INVALID_STATE;
    journal = &source; journal_lifetime = source.lifetime_revision_; journal_file = source.file_;
    journal_bytes = source.records_; journal_name = source.name_; journal_owner = source.owner_; journal_controller = source.controller_;
    owner = {source.workspace_.DirectoryHandle(CellDirectory::control), source.workspace_.DirectoryIdentity(CellDirectory::control),
      source.anchor_, source.plan_.assignment_binding, source.plan_.profile_sha256, source.descriptor_, this, Journal};
    return Check();
  }
  DWORD Bind(CellProvisioningJournal& source, const CellRuntimeDispatch& request, bool creation) {
    expected = request;
    return BindJournal(source, request.reference.anchor, request.reference.checkpoint_sha256, creation);
  }
  DWORD BindInstall(CellProvisioningJournal& source, const CellRuntimeInstallRequest& request, bool creation) {
    installation = request;
    return BindJournal(source, {request.journal_identity, request.prepared_sha256}, request.checkpoint_sha256, creation);
  }
  DWORD Check() noexcept {
    if (failure) return failure;
    if (!owner.verify || !owner.directory || owner.directory == INVALID_HANDLE_VALUE || owner.descriptor.empty()) return Fail(ERROR_INVALID_PARAMETER);
    auto error = owner.verify(owner.context);
    FILE_ID_INFO id{}; FILE_STANDARD_INFO standard{}; DWORD flags = 0;
    if (!error && (!GetFileInformationByHandleEx(owner.directory, FileIdInfo, &id, sizeof(id)) ||
        !GetFileInformationByHandleEx(owner.directory, FileStandardInfo, &standard, sizeof(standard)) ||
        !GetHandleInformation(owner.directory, &flags))) error = Error();
    if (!error && (!standard.Directory || standard.DeletePending || (flags & HANDLE_FLAG_INHERIT) ||
        id.VolumeSerialNumber != owner.directory_identity.volume_serial ||
        !std::equal(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), owner.directory_identity.file_id.begin()))) error = ERROR_FILE_INVALID;
    return Fail(error);
  }
  DWORD Prepare() noexcept {
    if (installation && installation->files.size() != 2) return Fail(ERROR_INVALID_PARAMETER);
    const auto& nonce = installation ? installation->binding.nonce : expected.binding.nonce;
    const auto& request_hash = installation ? installation->binding.request_sha256 : expected.binding.request_sha256;
    const auto& head = installation ? installation->checkpoint_sha256 : expected.reference.checkpoint_sha256;
    const auto anchor = installation ? CellProvisioningAnchor{installation->journal_identity, installation->prepared_sha256} : expected.reference.anchor;
    if (!Nonzero(nonce) || !Nonzero(request_hash) || !Nonzero(head) ||
        !Nonzero(owner.assignment) || !Nonzero(owner.profile) || anchor != owner.anchor ||
        !owner.anchor.file.volume_serial || !Nonzero(owner.anchor.prepared_sha256)) return Fail(ERROR_INVALID_PARAMETER);
    std::memcpy(intent.data(), installation ? "GCRLI001" : "GCRLO001", 8);
    std::copy(nonce.begin(), nonce.end(), intent.begin() + 8);
    std::copy(request_hash.begin(), request_hash.end(), intent.begin() + 40);
    std::copy(head.begin(), head.end(), intent.begin() + 72);
    Put(intent.data() + 104, owner.anchor.file.volume_serial, 8);
    std::copy(owner.anchor.file.file_id.begin(), owner.anchor.file.file_id.end(), intent.begin() + 112);
    std::copy(owner.anchor.prepared_sha256.begin(), owner.anchor.prepared_sha256.end(), intent.begin() + 128);
    std::copy(owner.assignment.begin(), owner.assignment.end(), intent.begin() + 160);
    std::copy(owner.profile.begin(), owner.profile.end(), intent.begin() + 192);
    CellFileSha256 digest{}; const auto error = Hash(installation ? "goatcitadel.worker-runtime-install-local-intent.v1" : "goatcitadel.worker-runtime-local-intent.v1", std::span(intent).first(224), &digest);
    if (!error) std::copy(digest.begin(), digest.end(), intent.begin() + 224);
    return Fail(error);
  }
  DWORD Open(bool creation) {
    auto error = Prepare(); if (!error) error = Check(); if (error) return error;
    const auto module = GetModuleHandleW(L"ntdll.dll");
    const auto address = module ? GetProcAddress(module, "NtCreateFile") : nullptr;
    const auto conversion = module ? GetProcAddress(module, "RtlNtStatusToDosError") : nullptr;
    if (!address || !conversion) return Fail(ERROR_PROC_NOT_FOUND);
    decltype(&NtCreateFile) create = nullptr; decltype(&RtlNtStatusToDosError) convert = nullptr;
    static_assert(sizeof(create) == sizeof(address) && sizeof(convert) == sizeof(conversion));
    std::memcpy(&create, &address, sizeof(create)); std::memcpy(&convert, &conversion, sizeof(convert));
    std::wstring component; constexpr wchar_t hex[] = L"0123456789abcdef";
    const auto& nonce = installation ? installation->binding.nonce : expected.binding.nonce;
    for (const auto byte : nonce) { component += hex[byte >> 4]; component += hex[byte & 15]; }
    component += installation ? L".runtime-install" : L".runtime";
    UNICODE_STRING name{}; name.Buffer = component.data(); name.Length = static_cast<USHORT>(component.size() * sizeof(wchar_t)); name.MaximumLength = name.Length;
    OBJECT_ATTRIBUTES attributes{}; attributes.Length = sizeof(attributes); attributes.RootDirectory = owner.directory; attributes.ObjectName = &name;
    attributes.Attributes = OBJ_CASE_INSENSITIVE | 0x00001000UL; attributes.SecurityDescriptor = creation ? owner.descriptor.data() : nullptr;
    IO_STATUS_BLOCK io{}; HANDLE opened = nullptr;
    const auto status = create(&opened, FILE_GENERIC_READ | (creation ? FILE_GENERIC_WRITE : 0), &attributes, &io, nullptr, FILE_ATTRIBUTE_NORMAL,
      creation ? 0 : FILE_SHARE_READ, creation ? FILE_CREATE : FILE_OPEN,
      FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT | (creation ? FILE_WRITE_THROUGH : 0), nullptr, 0);
    if (status < 0) return Fail(convert(status));
    file = opened;
    if (io.Information != (creation ? 2U : 1U)) return Fail(ERROR_INVALID_STATE);
    std::uint64_t size = 0; error = Inspect(&size);
    if (!error && creation && size) error = ERROR_INVALID_DATA;
    if (!error && creation) error = Write(intent.data(), static_cast<DWORD>(intent.size()));
    if (!error && creation) { std::vector<std::uint8_t> bytes; error = ReadBytes(&bytes); if (!error && !std::equal(intent.begin(), intent.end(), bytes.begin(), bytes.end())) error = ERROR_CRC; }
    return Fail(error);
  }
  DWORD Inspect(std::uint64_t* size) noexcept {
    auto error = Check(); if (error) return error;
    FILE_ATTRIBUTE_TAG_INFO tag{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO id{}; DWORD flags = 0;
    if (GetFileType(file) != FILE_TYPE_DISK || !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
        !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) || !GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) ||
        !GetHandleInformation(file, &flags)) return Fail(ERROR_INVALID_HANDLE);
    constexpr DWORD unsafe = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
      FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
    constexpr LONGLONG maximum_allocation = ((maximum_bytes + 65535ULL) / 65536) * 65536;
    if ((tag.FileAttributes & unsafe) || tag.ReparseTag || (flags & HANDLE_FLAG_INHERIT) || standard.Directory || standard.DeletePending || standard.NumberOfLinks != 1 ||
        standard.EndOfFile.QuadPart < 0 || standard.EndOfFile.QuadPart > maximum_bytes || standard.AllocationSize.QuadPart < standard.EndOfFile.QuadPart ||
        standard.AllocationSize.QuadPart > maximum_allocation || id.VolumeSerialNumber != owner.directory_identity.volume_serial) return Fail(ERROR_ACCESS_DENIED);
    alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> stream_bytes{};
    if (!GetFileInformationByHandleEx(file, FileStreamInfo, stream_bytes.data(), static_cast<DWORD>(stream_bytes.size()))) return Fail(Error());
    const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(stream_bytes.data());
    constexpr std::wstring_view default_stream = L"::$DATA";
    if (stream->NextEntryOffset || stream->StreamNameLength != default_stream.size() * sizeof(wchar_t) ||
        std::memcmp(stream->StreamName, default_stream.data(), stream->StreamNameLength)) return Fail(ERROR_ACCESS_DENIED);
    CellFileIdentity actual; actual.volume_serial = id.VolumeSerialNumber;
    std::copy(std::begin(id.FileId.Identifier), std::end(id.FileId.Identifier), actual.file_id.begin());
    if (identity.volume_serial && identity != actual) return Fail(ERROR_FILE_INVALID);
    identity = actual;
    error = VerifyCellSecurity(file, owner.descriptor);
    if (!error) *size = static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
    return Fail(error);
  }
  DWORD Write(const void* bytes, DWORD count) noexcept {
    DWORD written = 0;
    if (!WriteFile(file, bytes, count, &written, nullptr) || written != count) return Fail(Error());
    if (!FlushFileBuffers(file)) return Fail(Error());
    return Check();
  }
  DWORD ReadBytes(std::vector<std::uint8_t>* bytes) {
    std::uint64_t size = 0; auto error = Inspect(&size); if (error) return error;
    bytes->resize(static_cast<std::size_t>(size)); LARGE_INTEGER start{}; DWORD read = 0;
    if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN) || !ReadFile(file, bytes->data(), static_cast<DWORD>(bytes->size()), &read, nullptr)) return Fail(Error());
    if (read != bytes->size()) return Fail(ERROR_HANDLE_EOF);
    std::uint64_t after = 0; error = Inspect(&after);
    if (!error && after != size) error = ERROR_FILE_INVALID;
    return Fail(error);
  }
  DWORD Decode(const std::vector<std::uint8_t>& bytes, CellRuntimeLocalOutcomeRecord* output) {
    *output = {};
    if (installation) return Fail(ERROR_INVALID_STATE);
    if (bytes.size() < intent.size() || !std::equal(intent.begin(), intent.end(), bytes.begin())) return Fail(ERROR_INVALID_DATA);
    CellRuntimeLocalOutcomeRecord record; record.file = identity; record.intent_retained = true;
    std::copy_n(intent.begin() + 224, 32, record.intent_sha256.begin());
    if (bytes.size() == intent.size()) { *output = std::move(record); return ERROR_SUCCESS; }
    if (bytes.size() < intent_bytes + terminal_bytes + seal_bytes) return Fail(ERROR_IO_INCOMPLETE);
    const auto* terminal = bytes.data() + intent_bytes;
    const auto count = static_cast<DWORD>(Number(terminal + 8));
    if (std::memcmp(terminal, "GCRLOC01", 8) || count > kMaximumCellRuntimeResultBytes || Number(terminal + 28) ||
        bytes.size() != intent_bytes + terminal_bytes + count + seal_bytes ||
        !std::equal(record.intent_sha256.begin(), record.intent_sha256.end(), terminal + 64)) return Fail(ERROR_INVALID_DATA);
    auto error = Hash("goatcitadel.worker-runtime-local-outcome.v1", std::span(bytes).first(bytes.size() - seal_bytes), &record.outcome_sha256);
    if (!error && !std::equal(record.outcome_sha256.begin(), record.outcome_sha256.end(), bytes.end() - seal_bytes)) error = ERROR_CRC;
    record.execution_error = static_cast<DWORD>(Number(terminal + 12)); record.encoding_error = static_cast<DWORD>(Number(terminal + 16));
    record.observed_job_error = static_cast<DWORD>(Number(terminal + 20)); record.observed_process_id = static_cast<DWORD>(Number(terminal + 24));
    if (!error && count) {
      if (record.encoding_error) return Fail(ERROR_INVALID_DATA);
      const std::vector<std::uint8_t> metadata(bytes.begin() + intent_bytes + terminal_bytes, bytes.end() - seal_bytes);
      CellFileSha256 digest{}; error = HashCellRuntimeResult(metadata, &digest);
      if (!error && !std::equal(digest.begin(), digest.end(), terminal + 32)) error = ERROR_CRC;
      if (!error) error = DecodeCellRuntimeResult(expected, metadata, &record.execution);
      if (!error && record.execution.execution.inventory_verified &&
          (record.execution.execution.inventory.assignment_binding != owner.assignment || record.execution.execution.inventory.profile_sha256 != owner.profile)) error = ERROR_INVALID_DATA;
      if (!error && (record.execution.execution.runtime.job.error != record.observed_job_error || record.execution.execution.runtime.job.process_id != record.observed_process_id)) error = ERROR_INVALID_DATA;
      record.result_encoded = error == ERROR_SUCCESS;
      const auto& job = record.execution.execution.runtime.job;
      record.cleanup_verified = record.result_encoded &&
        (!job.process_id || (job.zero_processes_verified && job.output_drained));
    } else if (!error && (!record.encoding_error || std::any_of(terminal + 32, terminal + 64, [](auto byte) { return byte != 0; }))) error = ERROR_INVALID_DATA;
    if (!error) { record.outcome_retained = true; *output = std::move(record); }
    return Fail(error);
  }
  DWORD DecodeInstall(const std::vector<std::uint8_t>& bytes, CellRuntimeInstallLocalRecord* output) {
    *output = {};
    if (!installation || bytes.size() < intent.size() || !std::equal(intent.begin(), intent.end(), bytes.begin())) return Fail(ERROR_INVALID_DATA);
    CellRuntimeInstallLocalRecord record; record.file = identity; record.intent_retained = true;
    std::copy_n(intent.begin() + 224, 32, record.intent_sha256.begin());
    if (bytes.size() == intent.size()) { record.bytes = bytes; *output = std::move(record); return ERROR_SUCCESS; }
    if (bytes.size() != intent_bytes + 64 + seal_bytes) return Fail(ERROR_IO_INCOMPLETE);
    const auto* terminal = bytes.data() + intent_bytes;
    if (std::memcmp(terminal, "GCRLIT01", 8) || Number(terminal + 12) > 1 ||
        !std::equal(record.intent_sha256.begin(), record.intent_sha256.end(), terminal + 32)) return Fail(ERROR_INVALID_DATA);
    record.installation.error = static_cast<DWORD>(Number(terminal + 8));
    record.installation.verified = Number(terminal + 12) == 1;
    record.installation.files_created = static_cast<DWORD>(Number(terminal + 16));
    record.installation.directories_created = static_cast<DWORD>(Number(terminal + 20));
    record.installation.bytes_written = Number(terminal + 24, 8);
    const auto total = installation->files[0].bytes + installation->files[1].bytes;
    if (record.installation.files_created > 2 || record.installation.directories_created || record.installation.bytes_written > total ||
        (record.installation.verified && (record.installation.error || record.installation.files_created != 2 || record.installation.bytes_written != total)) ||
        (!record.installation.error && !record.installation.verified)) return Fail(ERROR_INVALID_DATA);
    auto error = Hash("goatcitadel.worker-runtime-install-local-outcome.v1", std::span(bytes).first(bytes.size() - seal_bytes), &record.outcome_sha256);
    if (!error && !std::equal(record.outcome_sha256.begin(), record.outcome_sha256.end(), bytes.end() - seal_bytes)) error = ERROR_CRC;
    if (!error) { record.outcome_retained = true; record.bytes = bytes; *output = std::move(record); }
    return Fail(error);
  }
};
CellRuntimeLocalOutcome::CellRuntimeLocalOutcome() = default;
CellRuntimeLocalOutcome::~CellRuntimeLocalOutcome() = default;
DWORD CellRuntimeLocalOutcome::Begin(CellProvisioningJournal& journal, const CellRuntimeDispatch& expected) noexcept {
  if (attempted_) return state_ ? state_->Fail(ERROR_INVALID_STATE) : ERROR_INVALID_STATE;
  attempted_ = true;
  try {
    state_ = std::make_unique<State>(); auto error = state_->Bind(journal, expected, true);
    if (!error) error = state_->Open(true); return state_->Fail(error);
  } catch (...) { return state_ ? state_->Fail(ERROR_NOT_ENOUGH_MEMORY) : ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::BeginOwned(const Owner& owner, const CellRuntimeDispatch& expected) noexcept {
  if (attempted_) return state_ ? state_->Fail(ERROR_INVALID_STATE) : ERROR_INVALID_STATE;
  attempted_ = true;
  try { state_ = std::make_unique<State>(); state_->owner = owner; state_->expected = expected; return state_->Open(true); }
  catch (...) { return state_ ? state_->Fail(ERROR_NOT_ENOUGH_MEMORY) : ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::Retain(const CellRuntimeDispatchResult& supplied, DWORD execution_error, CellRuntimeLocalOutcomeRecord* output) noexcept {
  if (output) *output = {};
  if (!state_ || !output) return ERROR_INVALID_STATE;
  auto& state = *state_;
  if (state.installation) return state.Fail(ERROR_INVALID_STATE);
  if (state.failure) return state.failure;
  if (state.write_attempted) return state.Fail(ERROR_INVALID_STATE);
  state.write_attempted = true;
  try {
    const auto value = supplied; std::vector<std::uint8_t> metadata, bytes;
    const auto encoding_error = value.execution.inventory_verified &&
      (value.execution.inventory.assignment_binding != state.owner.assignment || value.execution.inventory.profile_sha256 != state.owner.profile)
      ? ERROR_INVALID_DATA : EncodeCellRuntimeResult(state.expected, value, &metadata);
    if (encoding_error) metadata.clear();
    auto error = state.ReadBytes(&bytes);
    if (!error && (bytes.size() != state.intent.size() || !std::equal(state.intent.begin(), state.intent.end(), bytes.begin()))) error = ERROR_INVALID_STATE;
    if (error) return state.Fail(error);
    std::array<std::uint8_t, State::terminal_bytes> terminal{}; std::memcpy(terminal.data(), "GCRLOC01", 8);
    Put(terminal.data() + 8, metadata.size()); Put(terminal.data() + 12, execution_error); Put(terminal.data() + 16, encoding_error);
    Put(terminal.data() + 20, value.execution.runtime.job.error); Put(terminal.data() + 24, value.execution.runtime.job.process_id);
    CellFileSha256 digest{};
    if (!encoding_error) error = HashCellRuntimeResult(metadata, &digest);
    if (error) return state.Fail(error);
    std::copy(digest.begin(), digest.end(), terminal.begin() + 32); std::copy_n(state.intent.begin() + 224, 32, terminal.begin() + 64);
    bytes.insert(bytes.end(), terminal.begin(), terminal.end()); bytes.insert(bytes.end(), metadata.begin(), metadata.end());
    CellFileSha256 seal{}; error = State::Hash("goatcitadel.worker-runtime-local-outcome.v1", bytes, &seal);
    if (error) return state.Fail(error); bytes.insert(bytes.end(), seal.begin(), seal.end());
    // ReadBytes left the exclusive handle at the end of the original intent.
    error = state.Write(bytes.data() + State::intent_bytes, static_cast<DWORD>(bytes.size() - State::intent_bytes));
    std::vector<std::uint8_t> retained;
    if (!error) error = state.ReadBytes(&retained);
    if (!error && retained != bytes) error = ERROR_CRC;
    if (!error) error = state.Decode(retained, output);
    return state.Fail(error);
  } catch (...) { return state.Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeLocalOutcome::Read(CellProvisioningJournal& journal, const CellRuntimeDispatch& expected, CellRuntimeLocalOutcomeRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER; *output = {};
  try {
    State state; auto error = state.Bind(journal, expected, false); if (!error) error = state.Open(false);
    std::vector<std::uint8_t> bytes; if (!error) error = state.ReadBytes(&bytes);
    return error ? error : state.Decode(bytes, output);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::ReadOwned(const Owner& owner, const CellRuntimeDispatch& expected, CellRuntimeLocalOutcomeRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER; *output = {};
  try {
    State state; state.owner = owner; state.expected = expected; auto error = state.Open(false);
    std::vector<std::uint8_t> bytes; if (!error) error = state.ReadBytes(&bytes);
    return error ? error : state.Decode(bytes, output);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::VerifyCleanupCoverage(CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellFileSha256& head, std::span<const CellRuntimeCleanupExpectation> requests, const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept {
  try {
    State state; const auto error = state.BindJournal(journal, anchor, head, false);
    return error ? error : VerifyCleanupCoverageOwned(state.owner, requests, guard, wall_ms);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::VerifyInstallationCoverage(CellProvisioningJournal& journal, const CellProvisioningAnchor& anchor,
    const CellFileSha256& head, std::span<const CellRuntimeInstallationExpectation> supplied,
    const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept {
  if (!guard.authorize || !wall_ms || wall_ms > 60000 || supplied.size() > 1000) return ERROR_INVALID_PARAMETER;
  const auto deadline = GetTickCount64() + wall_ms;
  const auto check = [&]() noexcept -> DWORD {
    if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
    if (guard.cancellation) {
      const auto state = WaitForSingleObject(guard.cancellation, 0);
      if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
    }
    return ERROR_SUCCESS;
  };
  auto current = check(); if (current) return current;
  try {
    const std::vector<CellRuntimeInstallationExpectation> frozen(supplied.begin(), supplied.end());
    std::vector<CellRuntimeInstallRequest> requests;
    for (const auto& item : frozen) {
      current = check(); if (current) return current;
      CellRuntimeInstallRequest request;
      const auto error = DecodeCellRuntimeInstall(item.bytes, item.binding, &request);
      if (error) return error;
      if (request.journal_identity != anchor.file || request.prepared_sha256 != anchor.prepared_sha256 ||
          request.checkpoint_sha256 != head) return ERROR_INVALID_DATA;
      requests.push_back(std::move(request));
    }
    State state; const auto error = state.BindJournal(journal, anchor, head, false);
    if (error) return error;
    current = check(); if (current) return current;
    const auto now = GetTickCount64(); if (now >= deadline) return ERROR_TIMEOUT;
    const auto inspected = VerifyAttemptCoverageOwned(state.owner, {}, requests, true, guard, static_cast<DWORD>(deadline - now));
    return inspected ? inspected : check();
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::VerifyCleanupCoverageOwned(const Owner& owner, std::span<const CellRuntimeCleanupExpectation> supplied,
    const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept {
  return VerifyAttemptCoverageOwned(owner, supplied, {}, false, guard, wall_ms);
}
DWORD CellRuntimeLocalOutcome::VerifyAttemptCoverageOwned(const Owner& owner, std::span<const CellRuntimeCleanupExpectation> supplied,
    std::span<const CellRuntimeInstallRequest> supplied_installations, bool installation,
    const CellFootprintScanGuard& supplied_guard, DWORD wall_ms) noexcept {
  if (!supplied_guard.authorize || !wall_ms || wall_ms > 60000 || supplied.size() > 1000 || supplied_installations.size() > 1000) return ERROR_INVALID_PARAMETER;
  const auto deadline = GetTickCount64() + wall_ms;
  try {
    const auto guard = supplied_guard;
    const std::vector<CellRuntimeCleanupExpectation> requests(supplied.begin(), supplied.end());
    const std::vector<CellRuntimeInstallRequest> installs(supplied_installations.begin(), supplied_installations.end());
    const std::wstring suffix = installation ? L".runtime-install" : L".runtime";
    State custody; custody.owner = owner;
    const auto check = [&](bool authorize) -> DWORD {
      if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
      if (guard.cancellation) {
        const auto state = WaitForSingleObject(guard.cancellation, 0);
        if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
      }
      auto error = custody.Check();
      if (!error && authorize) error = guard.authorize(guard.context);
      if (!error) error = custody.Check();
      return error ? error : GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
    };
    const auto names = [&](std::vector<std::wstring>& output) -> DWORD {
      alignas(FILE_ID_BOTH_DIR_INFO) std::array<std::uint8_t, 65536> buffer{};
      bool first = true; unsigned entries = 0;
      for (;;) {
        const auto error = check(false); if (error) return error;
        if (!GetFileInformationByHandleEx(owner.directory, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
            buffer.data(), static_cast<DWORD>(buffer.size()))) return GetLastError() == ERROR_NO_MORE_FILES ? ERROR_SUCCESS : State::Error();
        first = false; std::size_t offset = 0;
        for (;;) {
          constexpr auto header = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
          if (++entries > 20000 || offset > buffer.size() - header) return ERROR_INVALID_DATA;
          const auto* entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
          if (!entry->FileNameLength || entry->FileNameLength % sizeof(wchar_t) || entry->FileNameLength > buffer.size() - offset - header)
            return ERROR_INVALID_DATA;
          const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
          if (name.size() >= suffix.size() && CompareStringOrdinal(name.data() + name.size() - suffix.size(), static_cast<int>(suffix.size()),
              suffix.data(), static_cast<int>(suffix.size()), TRUE) == CSTR_EQUAL) {
            if (name.size() != 64 + suffix.size() || (entry->FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || output.size() >= 1000)
              return ERROR_INVALID_DATA;
            output.push_back(name);
          }
          if (!entry->NextEntryOffset) break;
          if (entry->NextEntryOffset < header + entry->FileNameLength || entry->NextEntryOffset % alignof(FILE_ID_BOTH_DIR_INFO) ||
              entry->NextEntryOffset > buffer.size() - offset) return ERROR_INVALID_DATA;
          offset += entry->NextEntryOffset;
        }
      }
    };
    auto error = check(true); if (error) return error;
    std::vector<std::wstring> expected, before, after;
    constexpr wchar_t hex[] = L"0123456789abcdef";
    const auto count = installation ? installs.size() : requests.size();
    for (std::size_t i = 0; i < count; ++i) {
      const auto& nonce = installation ? installs[i].binding.nonce : requests[i].binding.nonce;
      std::wstring name;
      for (auto byte : nonce) { name += hex[byte >> 4]; name += hex[byte & 15]; }
      expected.push_back(name + suffix);
    }
    std::sort(expected.begin(), expected.end());
    if (std::adjacent_find(expected.begin(), expected.end()) != expected.end()) return ERROR_INVALID_DATA;
    error = names(before); if (error) return error;
    std::sort(before.begin(), before.end()); if (before != expected) return ERROR_INVALID_DATA;
    for (std::size_t i = 0; i < count; ++i) {
      error = check(true); if (error) return error;
      if (installation) {
        CellRuntimeInstallLocalRecord record; error = ReadInstallOwned(owner, installs[i], &record);
        if (error || !record.outcome_retained) return error ? error : ERROR_IO_INCOMPLETE;
        continue;
      }
      const auto& request = requests[i];
      // Reuse the sealed-result decoder with metadata only. This temporary
      // value never reaches a dispatch/launch entry and has no command inputs.
      CellRuntimeDispatch decoder_input;
      decoder_input.binding = request.binding;
      decoder_input.reference.anchor = request.anchor;
      decoder_input.reference.checkpoint_sha256 = request.checkpoint_sha256;
      decoder_input.reference.inventory_limits.max_entries = request.maximum_inventory_entries;
      decoder_input.command.protected_workspace.emplace();
      decoder_input.command.protected_workspace->identities = request.workspace;
      decoder_input.command.expected_runtime_bundle = request.runtime_bundle_sha256;
      decoder_input.limits.input_bytes = request.maximum_input_bytes;
      decoder_input.limits.raw_output_bytes = request.maximum_output_bytes;
      CellRuntimeLocalOutcomeRecord record; error = ReadOwned(owner, decoder_input, &record);
      if (error || !record.outcome_retained || !record.cleanup_verified) return error ? error : ERROR_IO_INCOMPLETE;
    }
    error = check(true); if (error) return error;
    error = names(after); if (error) return error;
    std::sort(after.begin(), after.end()); return after == before ? ERROR_SUCCESS : ERROR_FILE_INVALID;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::BeginInstall(CellProvisioningJournal& journal, std::span<const std::uint8_t> bytes,
    const CellRuntimeInstallBinding& binding) noexcept {
  if (attempted_) return state_ ? state_->Fail(ERROR_INVALID_STATE) : ERROR_INVALID_STATE;
  attempted_ = true;
  try {
    CellRuntimeInstallRequest request; auto error = DecodeCellRuntimeInstall(bytes, binding, &request);
    if (error) return error;
    state_ = std::make_unique<State>(); error = state_->BindInstall(journal, request, true);
    if (!error) error = state_->Open(true); return state_->Fail(error);
  } catch (...) { return state_ ? state_->Fail(ERROR_NOT_ENOUGH_MEMORY) : ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::BeginInstallOwned(const Owner& owner, const CellRuntimeInstallRequest& request) noexcept {
  if (attempted_) return state_ ? state_->Fail(ERROR_INVALID_STATE) : ERROR_INVALID_STATE;
  attempted_ = true;
  try { state_ = std::make_unique<State>(); state_->owner = owner; state_->installation = request; return state_->Open(true); }
  catch (...) { return state_ ? state_->Fail(ERROR_NOT_ENOUGH_MEMORY) : ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::RetainInstall(const RuntimeBundleInstallResult& supplied, CellRuntimeInstallLocalRecord* output) noexcept {
  if (output) *output = {};
  if (!state_ || !output || !state_->installation) return ERROR_INVALID_STATE;
  auto& state = *state_;
  if (state.failure) return state.failure;
  if (state.write_attempted) return state.Fail(ERROR_INVALID_STATE);
  state.write_attempted = true;
  try {
    const auto value = supplied;
    std::vector<std::uint8_t> bytes;
    auto error = state.ReadBytes(&bytes);
    if (!error && (bytes.size() != state.intent.size() || !std::equal(state.intent.begin(), state.intent.end(), bytes.begin()))) error = ERROR_INVALID_STATE;
    if (error) return state.Fail(error);
    std::array<std::uint8_t, 64> terminal{}; std::memcpy(terminal.data(), "GCRLIT01", 8);
    Put(terminal.data() + 8, value.error); Put(terminal.data() + 12, value.verified ? 1 : 0);
    Put(terminal.data() + 16, value.files_created); Put(terminal.data() + 20, value.directories_created);
    Put(terminal.data() + 24, value.bytes_written, 8);
    std::copy_n(state.intent.begin() + 224, 32, terminal.begin() + 32);
    bytes.insert(bytes.end(), terminal.begin(), terminal.end());
    CellFileSha256 seal{}; error = State::Hash("goatcitadel.worker-runtime-install-local-outcome.v1", bytes, &seal);
    if (error) return state.Fail(error); bytes.insert(bytes.end(), seal.begin(), seal.end());
    CellRuntimeInstallLocalRecord checked;
    error = state.DecodeInstall(bytes, &checked); // Validate before any terminal write.
    if (error) return state.Fail(error);
    error = state.Write(bytes.data() + State::intent_bytes, static_cast<DWORD>(bytes.size() - State::intent_bytes));
    std::vector<std::uint8_t> retained;
    if (!error) error = state.ReadBytes(&retained);
    if (!error && retained != bytes) error = ERROR_CRC;
    if (!error) error = state.DecodeInstall(retained, output);
    return state.Fail(error);
  } catch (...) { return state.Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeLocalOutcome::ReadInstall(CellProvisioningJournal& journal, std::span<const std::uint8_t> bytes,
    const CellRuntimeInstallBinding& binding, CellRuntimeInstallLocalRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER; *output = {};
  try {
    CellRuntimeInstallRequest request; auto error = DecodeCellRuntimeInstall(bytes, binding, &request);
    if (error) return error;
    State state; error = state.BindInstall(journal, request, false); if (!error) error = state.Open(false);
    std::vector<std::uint8_t> retained; if (!error) error = state.ReadBytes(&retained);
    return error ? error : state.DecodeInstall(retained, output);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeLocalOutcome::ReadInstallOwned(const Owner& owner, const CellRuntimeInstallRequest& request, CellRuntimeInstallLocalRecord* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER; *output = {};
  try {
    State state; state.owner = owner; state.installation = request; auto error = state.Open(false);
    std::vector<std::uint8_t> bytes; if (!error) error = state.ReadBytes(&bytes);
    return error ? error : state.DecodeInstall(bytes, output);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellRuntimeResultTransfer::Fail(DWORD error) noexcept { if (error && !failure_) failure_ = error; return failure_; }
DWORD CellRuntimeResultTransfer::Check() noexcept {
  if (failure_) return failure_;
  const auto control = [&]() noexcept -> DWORD {
    if (!authority_.authorize || !authority_.cancellation || authority_.cancellation == INVALID_HANDLE_VALUE) return ERROR_INVALID_PARAMETER;
    const auto state = WaitForSingleObject(authority_.cancellation, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    return now >= deadline_ ? ERROR_TIMEOUT : deadline_ - now > 600000 ? ERROR_INVALID_PARAMETER : ERROR_SUCCESS;
  };
  auto error = control(); if (!error) error = authority_.authorize(authority_.context);
  if (!error) error = control();
  return Fail(error);
}
DWORD CellRuntimeResultTransfer::Begin() noexcept {
  if (attempted_) return Fail(ERROR_INVALID_STATE);
  attempted_ = true; return Check();
}
DWORD CellRuntimeResultTransfer::Write(const CellRuntimeDispatchResult& supplied, bool await_retention) noexcept {
  if (attempted_) return Fail(ERROR_INVALID_STATE);
  std::vector<std::uint8_t> bytes;
  auto error = EncodeCellRuntimeResult(expected_, supplied, &bytes); // Freeze before any caller callback.
  if (error) { attempted_ = true; return Fail(error); }
  error = Begin(); if (error) return error;
  CellFileSha256 digest{}; error = HashCellRuntimeResult(bytes, &digest);
  const auto size = static_cast<DWORD>(bytes.size()); const auto header = Header("GCRTS001", expected_.binding, digest, size);
  if (!error) error = WriteCellPipe(pipe_, header.data(), static_cast<DWORD>(header.size()), authority_.cancellation, deadline_);
  for (DWORD offset = 0; !error && offset < size;) {
    error = Check(); if (error) break;
    const auto count = std::min(DWORD{4096}, size - offset); std::array<std::uint8_t, 16> chunk{};
    std::memcpy(chunk.data(), "GCRTC001", 8); Put(chunk.data() + 8, offset); Put(chunk.data() + 12, count);
    error = WriteCellPipe(pipe_, chunk.data(), static_cast<DWORD>(chunk.size()), authority_.cancellation, deadline_);
    if (!error) error = WriteCellPipe(pipe_, bytes.data() + offset, count, authority_.cancellation, deadline_);
    if (!error) error = Check(); offset += count;
  }
  TransferHeader ack{};
  if (!error) error = ReadCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
  if (!error && ack != Header("GCRTA002", expected_.binding, digest, size)) error = ERROR_INVALID_DATA;
  if (!error) error = Check();
  if (!error) validated_ = true;
  if (!error && await_retention) {
    error = ReadCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
    if (!error && ack != Header("GCRTA003", expected_.binding, digest, size)) error = ERROR_INVALID_DATA;
    if (!error) error = Check();
    if (!error) retained_ = true;
  }
  return Fail(error);
}
DWORD CellRuntimeResultTransfer::Read(CellRuntimeDispatchResult* output) noexcept {
  if (output) *output = {};
  if (!output) { attempted_ = true; return Fail(ERROR_INVALID_PARAMETER); }
  auto error = Begin(); if (error) return error;
  try {
    TransferHeader header{};
    error = ReadCellPipe(pipe_, header.data(), static_cast<DWORD>(header.size()), authority_.cancellation, deadline_);
    if (!error) error = Check(); if (error) return Fail(error);
    const auto size = static_cast<DWORD>(Number(header.data() + 104)); CellFileSha256 digest{};
    std::copy_n(header.begin() + 72, digest.size(), digest.begin());
    if (size < 256 || size > kMaximumCellRuntimeResultBytes || !Nonzero(digest) || header != Header("GCRTS001", expected_.binding, digest, size)) return Fail(ERROR_INVALID_DATA);
    std::vector<std::uint8_t> bytes(size);
    for (DWORD offset = 0; offset < size;) {
      error = Check(); if (error) return error;
      std::array<std::uint8_t, 16> chunk{};
      error = ReadCellPipe(pipe_, chunk.data(), static_cast<DWORD>(chunk.size()), authority_.cancellation, deadline_);
      if (error) return Fail(error);
      const auto count = std::min(DWORD{4096}, size - offset);
      if (std::memcmp(chunk.data(), "GCRTC001", 8) || Number(chunk.data() + 8) != offset || Number(chunk.data() + 12) != count) return Fail(ERROR_INVALID_DATA);
      error = ReadCellPipe(pipe_, bytes.data() + offset, count, authority_.cancellation, deadline_);
      if (!error) error = Check(); if (error) return Fail(error); offset += count;
    }
    CellFileSha256 actual{}; error = HashCellRuntimeResult(bytes, &actual);
    if (!error && actual != digest) error = ERROR_CRC;
    CellRuntimeDispatchResult result;
    if (!error) error = DecodeCellRuntimeResult(expected_, bytes, &result);
    if (!error) error = Check();
    const auto ack = Header("GCRTA002", expected_.binding, digest, size);
    if (!error) error = WriteCellPipe(pipe_, ack.data(), static_cast<DWORD>(ack.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error) {
      received_digest_ = digest; received_size_ = size; read_complete_ = true; validated_ = true;
      *output = std::move(result);
    }
    return Fail(error);
  } catch (...) { return Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
DWORD CellRuntimeResultTransfer::Retain(const CellRuntimeDispatchResult& supplied, const CellRuntimeResultRetention& supplied_owner) noexcept {
  if (failure_) return failure_;
  if (!read_complete_ || retention_attempted_) return Fail(ERROR_INVALID_STATE);
  retention_attempted_ = true;
  const auto owner = supplied_owner;
  if (!owner.commit) return Fail(ERROR_INVALID_PARAMETER);
  std::vector<std::uint8_t> bytes; CellFileSha256 digest{};
  auto error = EncodeCellRuntimeResult(expected_, supplied, &bytes);
  if (!error) error = HashCellRuntimeResult(bytes, &digest);
  if (!error && (digest != received_digest_ || bytes.size() != received_size_)) error = ERROR_INVALID_DATA;
  CellRuntimeDispatchResult frozen;
  if (!error) error = DecodeCellRuntimeResult(expected_, bytes, &frozen);
  if (!error) error = Check();
  CellFileSha256 retained{};
  if (!error) error = owner.commit(owner.context, expected_.binding, expected_.reference.checkpoint_sha256, frozen, digest, &retained, deadline_);
  if (!error && retained != received_digest_) error = ERROR_CRC;
  if (!error) error = Check();
  if (!error) {
    retained_ = true;
    const auto receipt = Header("GCRTA003", expected_.binding, received_digest_, received_size_);
    error = WriteCellPipe(pipe_, receipt.data(), static_cast<DWORD>(receipt.size()), authority_.cancellation, deadline_);
    if (!error) error = Check();
    if (!error) retention_sent_ = true;
  }
  return Fail(error);
}
DWORD CellRuntimeResultPipeCommitter::Fail(DWORD error) noexcept {
  DWORD clear = ERROR_SUCCESS; if (error) failure_.compare_exchange_strong(clear, error); return failure_.load();
}
DWORD CellRuntimeResultPipeCommitter::Authorize(void* raw) noexcept {
  auto& self = *static_cast<CellRuntimeResultPipeCommitter*>(raw);
  if (self.failure_.load()) return self.failure_.load();
  if (!self.authority_.authorize) return self.Fail(ERROR_INVALID_PARAMETER);
  const auto error = self.authority_.authorize(self.authority_.context);
  return self.Fail(error);
}
DWORD CellRuntimeResultPipeCommitter::Commit(void* raw, const CellRuntimeDispatchBinding& binding, const CellFileSha256& head,
  const CellRuntimeDispatchResult& supplied, const CellFileSha256& supplied_digest, CellFileSha256* retained, ULONGLONG deadline) noexcept {
  if (!raw || !retained) return ERROR_INVALID_PARAMETER;
  *retained = {}; auto& self = *static_cast<CellRuntimeResultPipeCommitter*>(raw); bool idle = false;
  if (!self.attempted_.compare_exchange_strong(idle, true)) return self.Fail(ERROR_INVALID_STATE);
  try {
    if (GetFileType(self.controller_pipe_) != FILE_TYPE_PIPE || GetFileType(self.parent_pipe_) != FILE_TYPE_PIPE ||
        self.controller_pipe_ == self.parent_pipe_ || CompareObjectHandles(self.controller_pipe_, self.parent_pipe_) ||
        binding.nonce != self.expected_.binding.nonce || binding.request_sha256 != self.expected_.binding.request_sha256 ||
        head != self.expected_.reference.checkpoint_sha256) return self.Fail(ERROR_INVALID_DATA);
    // Freeze and strip any ephemeral raw buffers before calling parent custody.
    std::vector<std::uint8_t> bytes; CellFileSha256 digest{}; CellRuntimeDispatchResult frozen;
    auto error = EncodeCellRuntimeResult(self.expected_, supplied, &bytes);
    if (!error) error = HashCellRuntimeResult(bytes, &digest);
    if (!error && digest != supplied_digest) error = ERROR_CRC;
    if (!error) error = DecodeCellRuntimeResult(self.expected_, bytes, &frozen);
    if (error) return self.Fail(error);
    CellRuntimeResultTransfer transfer(self.parent_pipe_, deadline, self.expected_, {Authorize, &self, self.authority_.cancellation});
    error = transfer.Write(frozen, true);
    if (!error && (!transfer.ValidatedReceipt() || !transfer.RetentionConfirmed())) error = ERROR_INVALID_STATE;
    if (!error) error = self.failure_.load();
    if (!error) *retained = digest;
    return self.Fail(error);
  } catch (...) { return self.Fail(ERROR_NOT_ENOUGH_MEMORY); }
}
}
