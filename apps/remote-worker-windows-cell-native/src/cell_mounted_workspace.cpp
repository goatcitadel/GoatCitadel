#include "cell_mounted_workspace.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
constexpr std::size_t digest_offset = 480;
bool Nonzero(const CellFileSha256& value) noexcept { return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; }); }
bool Identity(const CellFileIdentity& value) noexcept {
  return value.volume_serial && std::any_of(value.file_id.begin(), value.file_id.end(), [](auto byte) { return byte != 0; });
}
bool Workspace(const CellMountedWorkspaceBinding& binding, const CellWorkspaceIdentities& value) noexcept {
  if (value.parent != binding.volume_root) return false;
  for (std::size_t i = 0; i < value.directories.size(); ++i) {
    const auto& identity = value.directories[i];
    if (!Identity(identity) || identity.volume_serial != value.parent.volume_serial || identity == value.parent) return false;
    for (std::size_t before = 0; before < i; ++before) if (value.directories[before] == identity) return false;
  }
  return true;
}
DWORD Control(ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
  if (cancellation) {
    const DWORD state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
DWORD Remaining(ULONGLONG deadline) noexcept {
  const auto now = GetTickCount64(); return now < deadline ? static_cast<DWORD>(deadline - now) : 0;
}
void Put(std::uint8_t* bytes, std::uint64_t value, unsigned length = 8) noexcept {
  for (unsigned i = 0; i < length; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint64_t Get(const std::uint8_t* bytes, unsigned length = 8) noexcept {
  std::uint64_t value = 0; for (unsigned i = 0; i < length; ++i) value |= static_cast<std::uint64_t>(bytes[i]) << (8 * i); return value;
}
void PutIdentity(std::uint8_t* bytes, const CellFileIdentity& identity) noexcept {
  Put(bytes, identity.volume_serial); std::copy(identity.file_id.begin(), identity.file_id.end(), bytes + 8);
}
CellFileIdentity ReadIdentity(const std::uint8_t* bytes) noexcept {
  CellFileIdentity value; value.volume_serial = Get(bytes); std::copy_n(bytes + 8, 16, value.file_id.begin()); return value;
}
DWORD Encode(const CellMountedWorkspaceBinding& binding, const CellWorkspaceIdentities& workspace,
  CellMountedWorkspacePhase phase, const CellFileSha256& previous, CellMountedWorkspaceCheckpoint* output) noexcept {
  *output = {};
  if (!IsValidCellMountedWorkspaceBinding(binding) ||
      (phase != CellMountedWorkspacePhase::intent && phase != CellMountedWorkspacePhase::recorded) ||
      (phase == CellMountedWorkspacePhase::recorded && !Workspace(binding, workspace))) return ERROR_INVALID_DATA;
  auto& bytes = *output;
  std::memcpy(bytes.data(), "GCCWRK01", 8); Put(bytes.data() + 8, static_cast<unsigned>(phase), 4);
  std::copy(previous.begin(), previous.end(), bytes.begin() + 16);
  std::copy(binding.mount_sha256.begin(), binding.mount_sha256.end(), bytes.begin() + 48);
  std::copy(binding.security_sha256.begin(), binding.security_sha256.end(), bytes.begin() + 80);
  for (std::size_t i = 0; i < binding.cell_name.size(); ++i) bytes[112 + i] = static_cast<std::uint8_t>(binding.cell_name[i]);
  PutIdentity(bytes.data() + 152, binding.volume_root);
  if (phase == CellMountedWorkspacePhase::recorded)
    for (std::size_t i = 0; i < workspace.directories.size(); ++i) PutIdentity(bytes.data() + 176 + i * 24, workspace.directories[i]);
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status >= 0) status = BCryptHash(algorithm, nullptr, 0, bytes.data(), static_cast<ULONG>(digest_offset), bytes.data() + digest_offset, 32);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) { *output = {}; return ERROR_CRC; }
  return ERROR_SUCCESS;
}
}
bool IsValidCellMountedWorkspaceBinding(const CellMountedWorkspaceBinding& binding) noexcept {
  return Nonzero(binding.mount_sha256) && Nonzero(binding.security_sha256) && Identity(binding.volume_root) &&
    binding.cell_name.size() == 40 && !binding.cell_name.compare(0, 8, L"gc-cell-") &&
    binding.cell_name.find_first_not_of(L"0123456789abcdef", 8) == std::wstring::npos;
}
DWORD ValidateCellMountedWorkspaceCheckpointPrefix(const CellMountedWorkspaceBinding& binding,
  std::span<const CellMountedWorkspaceCheckpoint> records, CellWorkspaceIdentities* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!IsValidCellMountedWorkspaceBinding(binding) || records.empty() || records.size() > 2) return ERROR_INVALID_PARAMETER;
  CellWorkspaceIdentities workspace; CellFileSha256 previous{};
  for (std::size_t i = 0; i < records.size(); ++i) {
    if (i) {
      workspace.parent = binding.volume_root;
      for (std::size_t directory = 0; directory < workspace.directories.size(); ++directory)
        workspace.directories[directory] = ReadIdentity(records[i].data() + 176 + directory * 24);
    }
    CellMountedWorkspaceCheckpoint expected{};
    const DWORD error = Encode(binding, workspace, static_cast<CellMountedWorkspacePhase>(i + 1), previous, &expected);
    if (error) return error;
    if (expected != records[i]) return ERROR_INVALID_DATA;
    std::copy_n(expected.begin() + digest_offset, 32, previous.begin());
  }
  if (records.size() == 2) *output = workspace;
  return ERROR_SUCCESS;
}
DWORD DecodeCellMountedWorkspaceCheckpoints(const CellMountedWorkspaceBinding& binding,
  std::span<const CellMountedWorkspaceCheckpoint> records, CellWorkspaceIdentities* output) noexcept {
  const DWORD error = ValidateCellMountedWorkspaceCheckpointPrefix(binding, records, output);
  return error ? error : records.size() == 2 ? ERROR_SUCCESS : ERROR_IO_INCOMPLETE;
}
struct CellMountedWorkspace::NativeContext final {
  CellMountedWorkspace* owner; CellVolumeMount* mount; CellVolumeProtection* protection; CellWorkspaceDirectories* host;
  ULONGLONG deadline; HANDLE cancellation;
};
CellMountedWorkspace::Operations CellMountedWorkspace::NativeOperations(NativeContext& context) noexcept {
  return {
    [](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); const auto remaining = Remaining(value.deadline);
      DWORD error = remaining ? value.mount->Verify(*value.protection, *value.host, remaining, value.cancellation) : ERROR_TIMEOUT;
      if (!error && (value.mount->binding_.volume_root != value.owner->binding_.volume_root ||
          value.mount->binding_.security_sha256 != value.owner->binding_.security_sha256 || value.mount->records_.size() != 4 ||
          !std::equal(value.owner->binding_.mount_sha256.begin(), value.owner->binding_.mount_sha256.end(), value.mount->records_.back().begin() + 480)))
        error = ERROR_FILE_INVALID;
      return error;
    },
    [](void* raw, CellWorkspaceIdentities* output, DWORD (*guard)(void*) noexcept, void* guard_context) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); auto& owner = *value.owner;
      DWORD error = owner.contents_.Create(value.protection->RootHandle(), owner.binding_.volume_root, owner.binding_.cell_name,
        owner.owner_sid_, owner.controller_sid_, guard, guard_context);
      return error ? error : owner.contents_.RecordIdentities(output);
    },
    [](void* raw, const CellWorkspaceIdentities& expected, bool reopen) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); auto& owner = *value.owner;
      DWORD error = reopen ? owner.contents_.OpenRecorded(value.protection->RootHandle(), expected, owner.binding_.cell_name,
        owner.owner_sid_, owner.controller_sid_) : ERROR_SUCCESS;
      CellWorkspaceIdentities actual;
      if (!error) error = owner.contents_.RecordIdentities(&actual);
      return error ? error : actual == expected ? ERROR_SUCCESS : ERROR_FILE_INVALID;
    }, &context,
  };
}
DWORD CellMountedWorkspace::Prepare(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
  const std::wstring& owner_sid, const std::wstring& controller_sid, ULONGLONG deadline, HANDLE cancellation) noexcept {
  const auto remaining = Remaining(deadline);
  DWORD error = remaining ? mount.Verify(protection, host, remaining, cancellation) : ERROR_TIMEOUT;
  if (!error && mount.records_.size() != 4) error = ERROR_INVALID_STATE;
  if (error) return error;
  try {
    const auto& host_root = host.DirectoryPath(CellDirectory::root);
    binding_.cell_name = host_root.substr(host_root.find_last_of(L'\\') + 1);
    binding_.volume_root = mount.binding_.volume_root;
    std::copy_n(mount.records_.back().begin() + 480, 32, binding_.mount_sha256.begin());
    error = HashCellVolumeRootSecurity(owner_sid, controller_sid, &binding_.security_sha256);
    if (!error && (binding_.security_sha256 != mount.binding_.security_sha256 || !IsValidCellMountedWorkspaceBinding(binding_))) error = ERROR_INVALID_DATA;
    if (!error) { owner_sid_ = owner_sid; controller_sid_ = controller_sid; }
    return error ? error : Control(deadline, cancellation);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellMountedWorkspace::Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool authorize) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error && authorize) error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (!error) error = operations.verify(operations.context);
  return error ? error : Control(deadline, cancellation);
}
DWORD CellMountedWorkspace::Commit(CellMountedWorkspacePhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error) error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (error) return error;
  CellFileSha256 previous{}, acknowledged{};
  if (!records_.empty()) std::copy_n(records_.back().begin() + digest_offset, 32, previous.begin());
  CellMountedWorkspaceCheckpoint record{};
  error = Encode(binding_, identities_, phase, previous, &record);
  if (error) return error;
  try { records_.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  error = committer_.commit(committer_.context, record, &acknowledged);
  if (!error && !std::equal(acknowledged.begin(), acknowledged.end(), record.begin() + digest_offset)) error = ERROR_INVALID_DATA;
  return error ? error : Control(deadline, cancellation);
}
DWORD CellMountedWorkspace::Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  struct Guard { CellMountedWorkspace* owner; const Operations* operations; ULONGLONG deadline; HANDLE cancellation; }
    guard{this, &operations, deadline, cancellation};
  const auto current = [](void* raw) noexcept -> DWORD {
    auto& value = *static_cast<Guard*>(raw); return value.owner->Check(*value.operations, value.deadline, value.cancellation, true);
  };
  DWORD error = Check(operations, deadline, cancellation, true);
  if (!error) error = Commit(CellMountedWorkspacePhase::intent, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true);
  if (!error) error = operations.create(operations.context, &identities_, current, &guard);
  if (!error && !Workspace(binding_, identities_)) error = ERROR_FILE_INVALID;
  if (!error) error = Check(operations, deadline, cancellation, true);
  if (!error) error = operations.inspect(operations.context, identities_, false);
  if (!error) error = Commit(CellMountedWorkspacePhase::recorded, deadline, cancellation);
  // Final authority precedes native readback; no blocking callback follows it.
  if (!error) error = Check(operations, deadline, cancellation, true);
  if (!error) error = operations.inspect(operations.context, identities_, false);
  if (!error) error = Control(deadline, cancellation);
  if (!error) state_ = CellMountedWorkspaceState::recorded;
  return error;
}
DWORD CellMountedWorkspace::Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool reopen) noexcept {
  CellWorkspaceIdentities recorded;
  DWORD error = DecodeCellMountedWorkspaceCheckpoints(binding_, records_, &recorded);
  if (!error && identities_ != CellWorkspaceIdentities{} && identities_ != recorded) error = ERROR_FILE_INVALID;
  if (!error) error = Check(operations, deadline, cancellation, false);
  if (!error) error = operations.inspect(operations.context, recorded, reopen);
  if (!error) error = Check(operations, deadline, cancellation, false);
  if (!error) error = operations.inspect(operations.context, recorded, false);
  if (!error) error = Control(deadline, cancellation);
  if (!error) { identities_ = recorded; state_ = CellMountedWorkspaceState::recorded; }
  return error;
}
CellMountedWorkspace::~CellMountedWorkspace() { Close(); }
DWORD CellMountedWorkspace::Create(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
  const std::wstring& owner_sid, const std::wstring& controller_sid, const CellMountedWorkspaceCommitter& committer,
  DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.commit || !committer.authorize) return ERROR_INVALID_PARAMETER;
  if (mount.State() != CellVolumeMountState::mounted || !mount.freshly_mounted_ || mount.workspace_attempted_) return ERROR_INVALID_STATE;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  attempted_ = true; state_ = CellMountedWorkspaceState::unknown; committer_ = committer; mount.workspace_attempted_ = true;
  error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (!error) error = Prepare(mount, protection, host, owner_sid, controller_sid, deadline, cancellation);
  NativeContext context{this, &mount, &protection, &host, deadline, cancellation};
  return error ? error : Run(NativeOperations(context), deadline, cancellation);
}
DWORD CellMountedWorkspace::OpenRecorded(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  std::span<const CellMountedWorkspaceCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || records.size() != 2) return ERROR_INVALID_PARAMETER;
  attempted_ = true; state_ = CellMountedWorkspaceState::unknown;
  try { records_.assign(records.begin(), records.end()); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (!error) error = Prepare(mount, protection, host, owner_sid, controller_sid, deadline, cancellation);
  NativeContext context{this, &mount, &protection, &host, deadline, cancellation};
  return error ? error : Recover(NativeOperations(context), deadline, cancellation, true);
}
DWORD CellMountedWorkspace::Verify(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
  DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellMountedWorkspaceState::recorded) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  state_ = CellMountedWorkspaceState::unknown;
  NativeContext context{this, &mount, &protection, &host, GetTickCount64() + wall_limit_ms, cancellation};
  return Recover(NativeOperations(context), context.deadline, cancellation, false);
}
DWORD CellMountedWorkspace::RecordIdentities(CellVolumeMount& mount, CellVolumeProtection& protection, CellWorkspaceDirectories& host,
  CellWorkspaceIdentities* output, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const DWORD error = Verify(mount, protection, host, wall_limit_ms, cancellation);
  if (!error) *output = identities_;
  return error;
}
DWORD CellMountedWorkspace::RecordCheckpoints(std::vector<CellMountedWorkspaceCheckpoint>* output) const noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  if (records_.empty()) return ERROR_INVALID_STATE;
  try { *output = records_; return ERROR_SUCCESS; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
void CellMountedWorkspace::Close() noexcept { state_ = CellMountedWorkspaceState::unknown; contents_.Close(); }
}
