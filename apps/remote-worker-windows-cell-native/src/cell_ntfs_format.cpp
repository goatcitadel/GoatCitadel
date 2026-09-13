#include "cell_ntfs_format.hpp"
#include "cell_ntfs_format_wmi.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "ole32.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::size_t digest_offset = 480;
constexpr std::uint64_t mib = 1024 * 1024;
constexpr wchar_t label[] = L"GoatCitadel cell";
DWORD Error() noexcept { const DWORD error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
DWORD Control(ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return state == WAIT_FAILED ? Error() : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
DWORD Remaining(ULONGLONG deadline) noexcept {
  const auto now = GetTickCount64();
  return now >= deadline ? 0 : static_cast<DWORD>(std::min<ULONGLONG>(600000, deadline - now));
}
bool ValidPartition(std::uint64_t bytes) noexcept { return bytes >= 8 * mib && bytes <= 1024 * 1024 * mib && bytes % mib == 0; }
bool ValidIdentity(const CellNtfsIdentity& value, std::uint64_t bytes) noexcept {
  return ValidPartition(bytes) && value.serial && value.sectors <= bytes / 512 &&
    value.sectors >= bytes / 512 - 8 && value.clusters == value.sectors / 8;
}
template<typename T> void Put(CellNtfsFormatCheckpoint& bytes, std::size_t offset, const T& value) noexcept {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}
template<typename T> void Get(const CellNtfsFormatCheckpoint& bytes, std::size_t offset, T* value) noexcept {
  std::memcpy(value, bytes.data() + offset, sizeof(*value));
}
DWORD Encode(const CellNtfsFormatBinding& binding, CellNtfsFormatPhase phase, const CellFileSha256& previous,
             const CellNtfsIdentity& identity, CellNtfsFormatCheckpoint* output) noexcept {
  output->fill(0);
  if (!IsValidCellNtfsFormatBinding(binding) || (phase != CellNtfsFormatPhase::intent && phase != CellNtfsFormatPhase::formatted) ||
      (phase == CellNtfsFormatPhase::formatted && !ValidIdentity(identity, binding.partition_bytes))) return ERROR_INVALID_DATA;
  auto& bytes = *output;
  std::memcpy(bytes.data(), "GCCNTF01", 8); Put(bytes, 8, static_cast<std::uint32_t>(phase)); Put(bytes, 16, previous);
  Put(bytes, 48, binding.layout_sha256); Put(bytes, 80, binding.volume_id); Put(bytes, 96, binding.partition_bytes);
  Put(bytes, 104, std::uint32_t{512}); Put(bytes, 108, std::uint32_t{4096});
  std::memcpy(bytes.data() + 112, label, sizeof(label));
  if (phase == CellNtfsFormatPhase::formatted) { Put(bytes, 184, identity.serial); Put(bytes, 192, identity.sectors); Put(bytes, 200, identity.clusters); }
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(digest_offset), bytes.data() + digest_offset, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status < 0 ? ERROR_GEN_FAILURE : ERROR_SUCCESS;
}
}
bool IsValidCellNtfsFormatBinding(const CellNtfsFormatBinding& binding) noexcept {
  return std::any_of(binding.layout_sha256.begin(), binding.layout_sha256.end(), [](auto byte) { return byte != 0; }) &&
    !IsEqualGUID(binding.volume_id, GUID{}) && ValidPartition(binding.partition_bytes);
}
DWORD InspectCellNtfsVolume(std::span<const std::uint8_t> bytes, std::uint64_t partition_bytes, CellNtfsIdentity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!ValidPartition(partition_bytes)) return ERROR_INVALID_PARAMETER;
  if (bytes.size() != sizeof(NTFS_VOLUME_DATA_BUFFER)) return ERROR_INVALID_DATA;
  NTFS_VOLUME_DATA_BUFFER value{}; std::memcpy(&value, bytes.data(), sizeof(value));
  CellNtfsIdentity identity{static_cast<std::uint64_t>(value.VolumeSerialNumber.QuadPart),
    static_cast<std::uint64_t>(value.NumberSectors.QuadPart), static_cast<std::uint64_t>(value.TotalClusters.QuadPart)};
  if (value.BytesPerSector != 512 || value.BytesPerCluster != 4096 ||
      value.NumberSectors.QuadPart <= 0 || value.TotalClusters.QuadPart <= 0 ||
      value.FreeClusters.QuadPart < 0 || value.FreeClusters.QuadPart > value.TotalClusters.QuadPart ||
      !ValidIdentity(identity, partition_bytes)) return ERROR_FILE_INVALID;
  *output = identity;
  return ERROR_SUCCESS;
}
DWORD ValidateCellNtfsFormatCheckpointPrefix(const CellNtfsFormatBinding& binding,
  std::span<const CellNtfsFormatCheckpoint> records, CellNtfsIdentity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!IsValidCellNtfsFormatBinding(binding)) return ERROR_INVALID_PARAMETER;
  if (records.empty() || records.size() > 2) return ERROR_INVALID_DATA;
  CellFileSha256 previous{}; CellNtfsIdentity identity{};
  for (std::size_t index = 0; index < records.size(); ++index) {
    if (index == 1) { Get(records[index], 184, &identity.serial); Get(records[index], 192, &identity.sectors); Get(records[index], 200, &identity.clusters); }
    CellNtfsFormatCheckpoint expected{};
    const DWORD error = Encode(binding, static_cast<CellNtfsFormatPhase>(index + 1), previous, identity, &expected);
    if (error) return error;
    if (records[index] != expected) return ERROR_INVALID_DATA;
    Get(expected, digest_offset, &previous);
  }
  *output = identity;
  return ERROR_SUCCESS;
}
DWORD DecodeCellNtfsFormatCheckpoints(const CellNtfsFormatBinding& binding,
  std::span<const CellNtfsFormatCheckpoint> records, CellNtfsIdentity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const DWORD error = ValidateCellNtfsFormatCheckpointPrefix(binding, records, output);
  if (error) return error;
  return records.size() == 2 ? ERROR_SUCCESS : ERROR_IO_INCOMPLETE;
}
struct CellNtfsFormat::NativeContext final { CellNtfsFormat* owner; CellWorkspaceDirectories* workspace; ULONGLONG deadline; HANDLE cancellation; };
CellNtfsFormat::Operations CellNtfsFormat::NativeOperations(NativeContext& context) noexcept {
  return {
    [](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); const DWORD remaining = Remaining(value.deadline);
      return remaining ? value.owner->volume_.Verify(*value.workspace, remaining, value.cancellation) : ERROR_TIMEOUT;
    },
    [](void* raw, bool* is_raw, CellNtfsIdentity* output) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); *is_raw = false; *output = {};
      CellNtfsTargetFilesystem filesystem{};
      DWORD error = CellNtfsFormatWmi::Read(value.owner->volume_.path_, &filesystem, value.deadline, value.cancellation);
      if (error) return error;
      if (filesystem == CellNtfsTargetFilesystem::other) return ERROR_NOT_SUPPORTED;
      std::array<std::uint8_t, sizeof(NTFS_VOLUME_DATA_BUFFER)> bytes{}; DWORD used = 0;
      error = value.owner->volume_.ReadNtfs(bytes, &used, value.deadline, value.cancellation);
      if (filesystem == CellNtfsTargetFilesystem::raw) {
        if (error != ERROR_UNRECOGNIZED_VOLUME && error != ERROR_INVALID_FUNCTION) return error ? error : ERROR_FILE_INVALID;
        *is_raw = true; return ERROR_SUCCESS;
      }
      if (error) return error;
      if (used > bytes.size()) return ERROR_INVALID_DATA;
      return InspectCellNtfsVolume(std::span(bytes).first(used), value.owner->binding_.partition_bytes, output);
    },
    [](void* raw, DWORD (*guard)(void*) noexcept, void* guard_context) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw);
      return CellNtfsFormatWmi::Format(value.owner->volume_.path_, guard, guard_context, value.deadline, value.cancellation);
    }, &context,
  };
}
DWORD CellNtfsFormat::Bind(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
                          ULONGLONG deadline, HANDLE cancellation) noexcept {
  const DWORD remaining = Remaining(deadline);
  DWORD error = remaining ? volume_.Open(source, workspace, remaining, cancellation) : ERROR_TIMEOUT;
  if (error) return error;
  try {
    std::vector<CellDiskLayoutCheckpoint> records;
    error = volume_.layout_.RecordCheckpoints(&records);
    if (!error && records.size() != 4) error = ERROR_INVALID_DATA;
    if (!error) {
      std::copy_n(records.back().begin() + 480, 32, binding_.layout_sha256.begin());
      binding_.partition_bytes = volume_.layout_.snapshot_.data_length;
      const auto guid = volume_.path_.substr(10, 38);
      if (FAILED(CLSIDFromString(guid.c_str(), &binding_.volume_id)) || !IsValidCellNtfsFormatBinding(binding_)) error = ERROR_INVALID_DATA;
    }
    return error ? error : Control(deadline, cancellation);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellNtfsFormat::Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool authorize) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error && authorize) error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (!error) error = operations.verify(operations.context);
  return error ? error : Control(deadline, cancellation);
}
DWORD CellNtfsFormat::RequireRaw(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  // Preserve both authority fences, but follow each with native identity and
  // RAW readback. No canonical RPC may sit between the final readback and send.
  for (unsigned pass = 0; pass < 2; ++pass) {
    DWORD error = Check(operations, deadline, cancellation, true);
    bool raw = false; CellNtfsIdentity existing{};
    if (!error) error = operations.probe(operations.context, &raw, &existing);
    if (!error && (!raw || existing != CellNtfsIdentity{})) error = ERROR_ALREADY_EXISTS;
    if (error) return error;
  }
  return Check(operations, deadline, cancellation, false);
}
DWORD CellNtfsFormat::Commit(CellNtfsFormatPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error) error = committer_.authorize(committer_.context);
  if (error) return error;
  CellFileSha256 previous{}, expected{}, acknowledged{};
  if (!records_.empty()) Get(records_.back(), digest_offset, &previous);
  CellNtfsFormatCheckpoint record{};
  error = Encode(binding_, phase, previous, identity_, &record);
  if (!error) error = Control(deadline, cancellation);
  if (error) return error;
  records_.push_back(record); Get(record, digest_offset, &expected);
  error = committer_.commit(committer_.context, record, &acknowledged);
  if (!error && acknowledged != expected) error = ERROR_INVALID_DATA;
  return error ? error : Control(deadline, cancellation);
}
DWORD CellNtfsFormat::Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = RequireRaw(operations, deadline, cancellation);
  if (!error) error = Commit(CellNtfsFormatPhase::intent, deadline, cancellation);
  if (!error) error = RequireRaw(operations, deadline, cancellation);
  struct Guard { CellNtfsFormat* owner; const Operations* operations; ULONGLONG deadline; HANDLE cancellation; } guard{this, &operations, deadline, cancellation};
  if (!error) error = operations.format(operations.context, [](void* raw) noexcept -> DWORD {
    auto& value = *static_cast<Guard*>(raw);
    return value.owner->RequireRaw(*value.operations, value.deadline, value.cancellation);
  }, &guard);
  if (!error) error = Check(operations, deadline, cancellation, true);
  bool raw = true;
  if (!error) error = operations.probe(operations.context, &raw, &identity_);
  if (!error && (raw || !ValidIdentity(identity_, binding_.partition_bytes))) error = ERROR_FILE_INVALID;
  if (!error) error = Check(operations, deadline, cancellation, true);
  if (!error) error = Commit(CellNtfsFormatPhase::formatted, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true);
  CellNtfsIdentity acknowledged{};
  if (!error) error = operations.probe(operations.context, &raw, &acknowledged);
  if (!error && (raw || acknowledged != identity_)) error = ERROR_FILE_INVALID;
  if (!error) error = Check(operations, deadline, cancellation, true);
  if (!error) error = operations.probe(operations.context, &raw, &acknowledged);
  if (!error && (raw || acknowledged != identity_)) error = ERROR_FILE_INVALID;
  if (!error) error = Check(operations, deadline, cancellation, false);
  if (!error) state_ = CellNtfsFormatState::formatted;
  return error;
}
DWORD CellNtfsFormat::Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = DecodeCellNtfsFormatCheckpoints(binding_, records_, &identity_);
  if (!error) error = Check(operations, deadline, cancellation, false);
  bool raw = true; CellNtfsIdentity observed{};
  if (!error) error = operations.probe(operations.context, &raw, &observed);
  if (!error && (raw || observed != identity_)) error = ERROR_FILE_INVALID;
  if (!error) error = Check(operations, deadline, cancellation, false);
  if (!error) state_ = CellNtfsFormatState::formatted;
  return error;
}
DWORD CellNtfsFormat::Create(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
  const CellNtfsFormatCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.commit || !committer.authorize) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  attempted_ = true; state_ = CellNtfsFormatState::unknown; committer_ = committer;
  try { records_.reserve(2); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  error = committer_.authorize(committer_.context);
  if (!error) error = Bind(source, workspace, deadline, cancellation);
  NativeContext context{this, &workspace, deadline, cancellation};
  if (!error) error = Run(NativeOperations(context), deadline, cancellation);
  freshly_formatted_ = !error;
  return error;
}
DWORD CellNtfsFormat::OpenRecorded(CellVirtualDiskLayout& source, CellWorkspaceDirectories& workspace,
  std::span<const CellNtfsFormatCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || records.size() != 2) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  attempted_ = true; state_ = CellNtfsFormatState::unknown;
  try { records_.assign(records.begin(), records.end()); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  DWORD error = Control(deadline, cancellation);
  if (!error) error = Bind(source, workspace, deadline, cancellation);
  NativeContext context{this, &workspace, deadline, cancellation};
  return error ? error : Recover(NativeOperations(context), deadline, cancellation);
}
DWORD CellNtfsFormat::Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellNtfsFormatState::formatted) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  state_ = CellNtfsFormatState::unknown;
  NativeContext context{this, &workspace, GetTickCount64() + wall_limit_ms, cancellation};
  return Recover(NativeOperations(context), context.deadline, cancellation);
}
DWORD CellNtfsFormat::RecordCheckpoints(std::vector<CellNtfsFormatCheckpoint>* output) const noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  if (records_.empty()) return ERROR_INVALID_STATE;
  try { *output = records_; return ERROR_SUCCESS; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
void CellNtfsFormat::Close() noexcept { freshly_formatted_ = false; state_ = CellNtfsFormatState::unknown; volume_.Close(); }
}
