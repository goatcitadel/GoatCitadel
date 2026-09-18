#include "cell_volume_mount.hpp"
#include "cell_security.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstddef>
#include <cstring>
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::size_t digest_offset = 480;
DWORD Error() noexcept { const auto error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
DWORD Control(ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (cancellation) {
    if (cancellation == INVALID_HANDLE_VALUE || cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    const auto state = WaitForSingleObject(cancellation, 0);
    if (state == WAIT_OBJECT_0) return ERROR_CANCELLED;
    if (state != WAIT_TIMEOUT) return state == WAIT_FAILED ? Error() : ERROR_INVALID_HANDLE;
  }
  return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
}
DWORD Remaining(ULONGLONG deadline) noexcept {
  const auto now = GetTickCount64();
  return now >= deadline ? 0 : static_cast<DWORD>(std::min<ULONGLONG>(600000, deadline - now));
}
bool Nonzero(std::span<const std::uint8_t> bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; });
}
bool Identity(const CellFileIdentity& value) noexcept { return value.volume_serial && Nonzero(value.file_id); }
DWORD Hash(std::span<const std::uint8_t> bytes, CellFileSha256* output) noexcept {
  output->fill(0);
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto result = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(bytes.data()),
    static_cast<ULONG>(bytes.size()), output->data(), static_cast<ULONG>(output->size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return result < 0 ? ERROR_GEN_FAILURE : ERROR_SUCCESS;
}
template<typename T> void Put(CellVolumeMountCheckpoint& bytes, std::size_t offset, const T& value) noexcept {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}
template<typename T> void Get(const CellVolumeMountCheckpoint& bytes, std::size_t offset, T* value) noexcept {
  std::memcpy(value, bytes.data() + offset, sizeof(*value));
}
void PutIdentity(CellVolumeMountCheckpoint& bytes, std::size_t offset, const CellFileIdentity& value) noexcept {
  Put(bytes, offset, value.volume_serial); Put(bytes, offset + 8, value.file_id);
}
CellVolumeMountTarget Target(const CellVolumeMountBinding& binding, const CellFileIdentity& directory) noexcept {
  return {binding.volume_id, binding.parent, directory, binding.volume_root};
}
DWORD Encode(const CellVolumeMountBinding& binding, const CellFileIdentity& directory, CellVolumeMountPhase phase,
  const CellFileSha256& previous, CellVolumeMountCheckpoint* output) noexcept {
  output->fill(0);
  const auto sequence = static_cast<unsigned>(phase);
  if (!IsValidCellVolumeMountBinding(binding) || sequence < 1 || sequence > 4 ||
      (sequence > 1 && !IsValidCellVolumeMountTarget(Target(binding, directory)))) return ERROR_INVALID_DATA;
  auto& bytes = *output;
  std::memcpy(bytes.data(), "GCCMNT01", 8); Put(bytes, 8, sequence); Put(bytes, 16, previous);
  Put(bytes, 48, binding.protection_sha256); Put(bytes, 80, binding.security_sha256); Put(bytes, 112, binding.volume_id);
  PutIdentity(bytes, 128, binding.parent); PutIdentity(bytes, 152, binding.volume_root);
  if (sequence > 1) PutIdentity(bytes, 176, directory);
  CellFileSha256 digest{};
  const auto error = Hash(std::span(bytes).first(digest_offset), &digest);
  if (!error) Put(bytes, digest_offset, digest);
  return error;
}
DWORD Folder(HANDLE parent, std::wstring* output) noexcept {
  try {
    std::array<wchar_t, 2048> bytes{};
    const auto used = GetFinalPathNameByHandleW(parent, bytes.data(), static_cast<DWORD>(bytes.size()),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (!used) return Error();
    if (used >= bytes.size()) return ERROR_FILENAME_EXCED_RANGE;
    const std::wstring native(bytes.data(), used);
    // The DOS locator is derived from the held parent, never selected by the
    // caller. Recheck it after every authority exchange and before submission.
    if (!native.starts_with(L"\\\\?\\") || native.size() < 8 || native[5] != L':' || native[6] != L'\\') return ERROR_BAD_PATHNAME;
    const auto path = native.substr(4) + L"\\volume";
    if (!IsLiteralCellPath(path) || path.size() >= 2047) return ERROR_BAD_PATHNAME;
    *output = path + L"\\";
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
struct Handle final {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
}
bool IsValidCellVolumeMountBinding(const CellVolumeMountBinding& binding) noexcept {
  return Nonzero(binding.protection_sha256) && Nonzero(binding.security_sha256) && !IsEqualGUID(binding.volume_id, GUID{}) &&
    Identity(binding.parent) && Identity(binding.volume_root) && binding.parent.volume_serial != binding.volume_root.volume_serial;
}
DWORD ValidateCellVolumeMountCheckpointPrefix(const CellVolumeMountBinding& binding,
  std::span<const CellVolumeMountCheckpoint> records, CellFileIdentity* directory) noexcept {
  if (!directory) return ERROR_INVALID_PARAMETER;
  *directory = {};
  if (!IsValidCellVolumeMountBinding(binding)) return ERROR_INVALID_PARAMETER;
  if (records.empty() || records.size() > 4) return ERROR_INVALID_DATA;
  CellFileIdentity recorded{};
  if (records.size() > 1) {
    Get(records[1], 176, &recorded.volume_serial); Get(records[1], 184, &recorded.file_id);
    if (!IsValidCellVolumeMountTarget(Target(binding, recorded))) return ERROR_INVALID_DATA;
  }
  CellFileSha256 previous{};
  for (std::size_t index = 0; index < records.size(); ++index) {
    CellVolumeMountCheckpoint expected{};
    const auto error = Encode(binding, recorded, static_cast<CellVolumeMountPhase>(index + 1), previous, &expected);
    if (error) return error;
    if (records[index] != expected) return ERROR_INVALID_DATA;
    Get(expected, digest_offset, &previous);
  }
  *directory = recorded;
  return ERROR_SUCCESS;
}
DWORD DecodeCellVolumeMountCheckpoints(const CellVolumeMountBinding& binding,
  std::span<const CellVolumeMountCheckpoint> records, CellFileIdentity* directory) noexcept {
  const auto error = ValidateCellVolumeMountCheckpointPrefix(binding, records, directory);
  if (error) return error;
  if (records.size() == 4) return ERROR_SUCCESS;
  *directory = {}; return ERROR_IO_INCOMPLETE;
}
DWORD CellVolumeMount::EmptyDirectory(HANDLE directory) noexcept {
  if (!directory || directory == INVALID_HANDLE_VALUE || GetFileType(directory) != FILE_TYPE_DISK) return ERROR_INVALID_HANDLE;
  alignas(FILE_ID_BOTH_DIR_INFO) std::array<std::uint8_t, 8192> bytes{};
  if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryRestartInfo, bytes.data(), static_cast<DWORD>(bytes.size()))) {
    const auto error = Error(); return error == ERROR_NO_MORE_FILES ? ERROR_SUCCESS : error;
  }
  constexpr auto base = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
  std::size_t offset = 0;
  unsigned seen = 0;
  for (unsigned count = 0; count < 2; ++count) {
    if (offset > bytes.size() - base) return ERROR_INVALID_DATA;
    DWORD next = 0, length = 0;
    std::memcpy(&next, bytes.data() + offset + offsetof(FILE_ID_BOTH_DIR_INFO, NextEntryOffset), sizeof(next));
    std::memcpy(&length, bytes.data() + offset + offsetof(FILE_ID_BOTH_DIR_INFO, FileNameLength), sizeof(length));
    if (length > bytes.size() - offset - base) return ERROR_INVALID_DATA;
    if (length != 2 && length != 4) return ERROR_DIR_NOT_EMPTY;
    std::array<wchar_t, 2> name{}; std::memcpy(name.data(), bytes.data() + offset + base, length);
    if (name[0] != L'.' || (length == 4 && name[1] != L'.')) return ERROR_DIR_NOT_EMPTY;
    const unsigned bit = length == 2 ? 1 : 2;
    if (seen & bit) return ERROR_INVALID_DATA;
    seen |= bit;
    if (!next) return ERROR_SUCCESS;
    if ((next & 7u) || next < base + length || next > bytes.size() - offset) return ERROR_INVALID_DATA;
    offset += next;
  }
  return ERROR_DIR_NOT_EMPTY;
}
struct CellVolumeMount::NativeContext final {
  CellVolumeMount* owner; CellVolumeProtection* source; CellWorkspaceDirectories* workspace;
  ULONGLONG deadline; HANDLE cancellation;
};
CellVolumeMount::Operations CellVolumeMount::NativeOperations(NativeContext& context) noexcept {
  return {
    [](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); auto& owner = *value.owner;
      auto& source = *value.source; auto& workspace = *value.workspace;
      const auto remaining = Remaining(value.deadline);
      DWORD error = remaining ? source.Verify(workspace, remaining, value.cancellation) : ERROR_TIMEOUT;
      if (!error) error = workspace.Verify();
      CellFileSha256 protection{};
      if (!error && source.records_.size() != 2) error = ERROR_INVALID_DATA;
      if (!error) Get(source.records_.back(), digest_offset, &protection);
      if (!error && (protection != owner.binding_.protection_sha256 || source.binding_.security_sha256 != owner.binding_.security_sha256 ||
          !IsEqualGUID(source.binding_.volume_id, owner.binding_.volume_id) || source.binding_.root != owner.binding_.volume_root ||
          workspace.DirectoryIdentity(CellDirectory::root) != owner.binding_.parent || source.path_ != owner.volume_path_ ||
          source.descriptor_ != owner.descriptor_ || workspace.parent_descriptor_ != owner.descriptor_)) error = ERROR_FILE_INVALID;
      std::wstring current;
      if (!error) error = Folder(workspace.DirectoryHandle(CellDirectory::root), &current);
      if (!error && current != owner.folder_) error = ERROR_FILE_INVALID;
      return error;
    },
    [](void* raw, bool created, bool mounted) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); auto& owner = *value.owner; auto& workspace = *value.workspace;
      std::array<wchar_t, 4096> paths{}; DWORD used = 0;
      if (!GetVolumePathNamesForVolumeNameW(owner.volume_path_.c_str(), paths.data(), static_cast<DWORD>(paths.size()), &used)) return Error();
      DWORD error = InspectCellVolumeMountNames(paths, used, mounted ? std::wstring_view(owner.folder_) : std::wstring_view{});
      if (error || !created) return error;
      const auto target = Target(owner.binding_, owner.directory_identity_);
      const auto parent = workspace.DirectoryHandle(CellDirectory::root);
      error = ReadCellMountHostDirectory(parent, owner.directory_, target, mounted);
      if (!error) error = VerifyCellSecurity(owner.directory_, owner.descriptor_);
      Handle named;
      if (!error) error = workspace.OpenVolumeMountDirectory(false, &named.value);
      if (!error) error = ReadCellMountHostDirectory(parent, named.value, target, mounted);
      if (!error) error = VerifyCellSecurity(named.value, owner.descriptor_);
      if (!error && !mounted) error = EmptyDirectory(owner.directory_);
      if (!error && mounted) {
        Handle resolved{CreateFileW(owner.folder_.c_str(), FILE_GENERIC_READ, FILE_SHARE_READ,
          nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)};
        if (resolved.value == INVALID_HANDLE_VALUE) return Error();
        error = ReadCellMountVolumeRoot(resolved.value, target);
        if (!error) error = VerifyCellSecurity(resolved.value, owner.descriptor_);
      }
      return error;
    },
    [](void* raw, CellFileIdentity* output, DWORD (*guard)(void*) noexcept, void* guard_context) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw);
      return value.owner->CreateDirectory(*value.workspace, output, guard, guard_context);
    },
    [](void* raw, DWORD (*guard)(void*) noexcept, void* guard_context) noexcept -> DWORD {
      auto& owner = *static_cast<NativeContext*>(raw)->owner;
      // Both SDK arguments are private, derived from pinned/recorded objects.
      // The last authority exchange is followed by native readback inside guard.
      const auto error = guard(guard_context);
      if (error) return error;
      return SetVolumeMountPointW(owner.folder_.c_str(), owner.volume_path_.c_str()) ? ERROR_SUCCESS : Error();
    }, &context,
  };
}
DWORD CellVolumeMount::CreateDirectory(CellWorkspaceDirectories& workspace, CellFileIdentity* output,
  DWORD (*guard)(void*) noexcept, void* context) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (directory_) return ERROR_ALREADY_INITIALIZED;
  DWORD error = workspace.OpenVolumeMountDirectory(true, &directory_, guard, context);
  FILE_ID_INFO actual{};
  if (!error && !GetFileInformationByHandleEx(directory_, FileIdInfo, &actual, sizeof(actual))) error = Error();
  if (!error) {
    output->volume_serial = actual.VolumeSerialNumber;
    std::copy(std::begin(actual.FileId.Identifier), std::end(actual.FileId.Identifier), output->file_id.begin());
    if (!IsValidCellVolumeMountTarget(Target(binding_, *output))) error = ERROR_FILE_INVALID;
  }
  return error;
}
DWORD CellVolumeMount::Prepare(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
  ULONGLONG deadline, HANDLE cancellation) noexcept {
  const auto remaining = Remaining(deadline);
  DWORD error = remaining ? source.Verify(workspace, remaining, cancellation) : ERROR_TIMEOUT;
  if (!error) error = workspace.Verify();
  if (!error && (source.records_.size() != 2 || source.descriptor_ != workspace.parent_descriptor_)) error = ERROR_INVALID_DATA;
  if (error) return error;
  try {
    Get(source.records_.back(), digest_offset, &binding_.protection_sha256);
    binding_.security_sha256 = source.binding_.security_sha256; binding_.volume_id = source.binding_.volume_id;
    binding_.parent = workspace.DirectoryIdentity(CellDirectory::root); binding_.volume_root = source.binding_.root;
    descriptor_ = source.descriptor_; volume_path_ = source.path_;
    if (!IsValidCellVolumeMountBinding(binding_) || !IsCellVolumeGuidPath(volume_path_)) return ERROR_INVALID_DATA;
    error = Folder(workspace.DirectoryHandle(CellDirectory::root), &folder_);
    return error ? error : Control(deadline, cancellation);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVolumeMount::Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation,
  bool authorize, bool created, bool mounted) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error && authorize) error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (!error && created && !IsValidCellVolumeMountTarget(Target(binding_, directory_identity_))) error = ERROR_INVALID_DATA;
  if (!error) error = operations.verify(operations.context);
  if (!error) error = operations.inspect(operations.context, created, mounted);
  return error ? error : Control(deadline, cancellation);
}
DWORD CellVolumeMount::Commit(CellVolumeMountPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error) error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (error) return error;
  CellFileSha256 previous{}, expected{}, acknowledged{};
  if (!records_.empty()) Get(records_.back(), digest_offset, &previous);
  CellVolumeMountCheckpoint record{};
  error = Encode(binding_, directory_identity_, phase, previous, &record);
  if (error) return error;
  try { records_.push_back(record); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  Get(record, digest_offset, &expected);
  error = committer_.commit(committer_.context, record, &acknowledged);
  if (!error && acknowledged != expected) error = ERROR_INVALID_DATA;
  return error ? error : Control(deadline, cancellation);
}
DWORD CellVolumeMount::Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  if (!IsValidCellVolumeMountBinding(binding_)) return ERROR_INVALID_PARAMETER;
  struct Guard { CellVolumeMount* owner; const Operations* operations; ULONGLONG deadline; HANDLE cancellation; bool created; }
    guard{this, &operations, deadline, cancellation, false};
  const auto authorize_mutation = [](void* raw) noexcept -> DWORD {
    auto& value = *static_cast<Guard*>(raw);
    return value.owner->Check(*value.operations, value.deadline, value.cancellation, true, value.created, false);
  };
  DWORD error = Check(operations, deadline, cancellation, true, false, false);
  if (!error) error = Commit(CellVolumeMountPhase::prepared, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true, false, false);
  if (!error) error = operations.create_directory(operations.context, &directory_identity_, authorize_mutation, &guard);
  if (!error) error = Check(operations, deadline, cancellation, true, true, false);
  if (!error) error = Commit(CellVolumeMountPhase::directory_recorded, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true, true, false);
  if (!error) error = Commit(CellVolumeMountPhase::mount_intent, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true, true, false);
  guard.created = true;
  if (!error) error = operations.mount(operations.context, authorize_mutation, &guard);
  if (!error) error = Check(operations, deadline, cancellation, true, true, true);
  if (!error) error = Commit(CellVolumeMountPhase::mounted, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true, true, true);
  if (!error) state_ = CellVolumeMountState::mounted;
  return error;
}
DWORD CellVolumeMount::Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  CellFileIdentity recorded{};
  DWORD error = DecodeCellVolumeMountCheckpoints(binding_, records_, &recorded);
  if (!error && Identity(directory_identity_) && directory_identity_ != recorded) error = ERROR_FILE_INVALID;
  if (!error) directory_identity_ = recorded;
  if (!error) error = Check(operations, deadline, cancellation, false, true, true);
  if (!error) error = Check(operations, deadline, cancellation, false, true, true);
  if (!error) state_ = CellVolumeMountState::mounted;
  return error;
}
CellVolumeMount::~CellVolumeMount() { Close(); }
DWORD CellVolumeMount::Create(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
  const CellVolumeMountCommitter& committer, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.commit || !committer.authorize) return ERROR_INVALID_PARAMETER;
  if (source.State() != CellVolumeProtectionState::protected_root || !source.freshly_protected_ || source.mount_attempted_) return ERROR_INVALID_STATE;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  attempted_ = true; state_ = CellVolumeMountState::unknown; committer_ = committer; source.mount_attempted_ = true;
  try { records_.reserve(4); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  error = committer_.authorize(committer_.context);
  if (!error) error = Control(deadline, cancellation);
  if (!error) error = Prepare(source, workspace, deadline, cancellation);
  NativeContext context{this, &source, &workspace, deadline, cancellation};
  if (!error) error = Run(NativeOperations(context), deadline, cancellation);
  if (!error) freshly_mounted_ = true;
  return error;
}
DWORD CellVolumeMount::OpenRecorded(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
  std::span<const CellVolumeMountCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || records.size() != 4) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  attempted_ = true; state_ = CellVolumeMountState::unknown;
  try { records_.assign(records.begin(), records.end()); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  DWORD error = Control(deadline, cancellation);
  if (!error) error = Prepare(source, workspace, deadline, cancellation);
  if (!error) error = DecodeCellVolumeMountCheckpoints(binding_, records_, &directory_identity_);
  // Exact complete records precede the no-follow leaf open. Recovery never
  // creates the directory or remounts an uncertain/interrupted operation.
  if (!error) error = workspace.OpenVolumeMountDirectory(false, &directory_);
  NativeContext context{this, &source, &workspace, deadline, cancellation};
  return error ? error : Recover(NativeOperations(context), deadline, cancellation);
}
DWORD CellVolumeMount::Verify(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
  DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellVolumeMountState::mounted) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  state_ = CellVolumeMountState::unknown;
  NativeContext context{this, &source, &workspace, GetTickCount64() + wall_limit_ms, cancellation};
  return Recover(NativeOperations(context), context.deadline, cancellation);
}
DWORD CellVolumeMount::RecordCheckpoints(std::vector<CellVolumeMountCheckpoint>* output) const noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  if (records_.empty()) return ERROR_INVALID_STATE;
  try { *output = records_; return ERROR_SUCCESS; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVolumeMount::WithCapacityLeaf(CellVolumeProtection& source, CellWorkspaceDirectories& workspace,
  DWORD wall_limit_ms, const CellFootprintScanGuard& guard, const CellCapacityMountObserver& observer) noexcept {
  NativeContext context{this, &source, &workspace, GetTickCount64() + wall_limit_ms, guard.cancellation};
  return ReadCapacityLeaf(NativeOperations(context), wall_limit_ms, guard, observer);
}
DWORD CellVolumeMount::ReadCapacityLeaf(const Operations& supplied_operations, DWORD wall_limit_ms,
  const CellFootprintScanGuard& supplied_guard, const CellCapacityMountObserver& supplied_observer) noexcept {
  if (capacity_reading_) { capacity_interrupted_ = true; return ERROR_INVALID_STATE; }
  const auto operations = supplied_operations; const auto guard = supplied_guard; const auto observer = supplied_observer;
  if (!wall_limit_ms || wall_limit_ms > 60000 || !guard.authorize || !observer.capture || !observer.discard ||
      !operations.verify || !operations.inspect) return ERROR_INVALID_PARAMETER;
  const auto deadline = GetTickCount64() + wall_limit_ms;
  auto error = Control(deadline, guard.cancellation); if (error) return error;
  if (state_ != CellVolumeMountState::mounted || !directory_ || directory_ == INVALID_HANDLE_VALUE) return ERROR_INVALID_STATE;
  capacity_reading_ = true; capacity_interrupted_ = false;
  struct Scope final {
    CellVolumeMount& owner; const CellCapacityMountObserver& observer;
    bool attempted = false, complete = false;
    ~Scope() {
      if (attempted && !complete) observer.discard(observer.context);
      owner.capacity_reading_ = false;
    }
  } scope{*this, observer};
  try {
    CellFileIdentity recorded;
    error = DecodeCellVolumeMountCheckpoints(binding_, records_, &recorded);
    if (error) return error;
    if (recorded != directory_identity_) return ERROR_FILE_INVALID;
    Handle held;
    if (!DuplicateHandle(GetCurrentProcess(), directory_, GetCurrentProcess(), &held.value, 0, FALSE, DUPLICATE_SAME_ACCESS)) return Error();
    struct Context final {
      CellVolumeMount& owner; const Operations& operations; ULONGLONG deadline; HANDLE cancellation;
      CellVolumeMountBinding binding; CellFileIdentity directory; HANDLE original;
      std::vector<CellVolumeMountCheckpoint> records; std::vector<std::uint8_t> descriptor;
      std::wstring folder, volume_path;
      bool Matches() const noexcept {
        return !owner.capacity_interrupted_ && owner.state_ == CellVolumeMountState::mounted && owner.directory_ == original &&
          owner.directory_identity_ == directory && owner.records_ == records && owner.descriptor_ == descriptor &&
          owner.folder_ == folder && owner.volume_path_ == volume_path &&
          owner.binding_.protection_sha256 == binding.protection_sha256 && owner.binding_.security_sha256 == binding.security_sha256 &&
          owner.binding_.parent == binding.parent && owner.binding_.volume_root == binding.volume_root &&
          IsEqualGUID(owner.binding_.volume_id, binding.volume_id);
      }
      static DWORD Check(void* raw) noexcept {
        const auto& self = *static_cast<Context*>(raw);
        auto checked = Control(self.deadline, self.cancellation); if (checked) return checked;
        if (!self.Matches()) return ERROR_FILE_INVALID;
        checked = self.owner.Check(self.operations, self.deadline, self.cancellation, false, true, true);
        if (!checked && !self.Matches()) checked = ERROR_FILE_INVALID;
        return checked ? checked : Control(self.deadline, self.cancellation);
      }
    } context{*this, operations, deadline, guard.cancellation, binding_, directory_identity_, directory_,
      records_, descriptor_, folder_, volume_path_};
    const auto authorize = [&]() noexcept -> DWORD {
      auto checked = Control(deadline, guard.cancellation);
      if (!checked) checked = guard.authorize(guard.context);
      return checked ? checked : Context::Check(&context);
    };
    error = authorize(); if (error) return error;
    const CellCapacityMountLeaf leaf(Target(context.binding, context.directory), held.value, &context, Context::Check);
    scope.attempted = true;
    error = observer.capture(observer.context, leaf);
    if (!error) error = authorize();
    if (!error) error = leaf.Check();
    if (!error) scope.complete = true;
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
void CellVolumeMount::Close() noexcept {
  if (capacity_reading_) capacity_interrupted_ = true;
  state_ = CellVolumeMountState::unknown; freshly_mounted_ = false;
  if (directory_ && directory_ != INVALID_HANDLE_VALUE) CloseHandle(directory_);
  directory_ = nullptr;
}
}
