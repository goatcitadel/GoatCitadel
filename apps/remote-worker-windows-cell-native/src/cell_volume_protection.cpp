#include "cell_volume_protection.hpp"
#include "cell_security.hpp"
#include <aclapi.h>
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#include <cwchar>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
constexpr std::size_t digest_offset = 480;
constexpr std::uint64_t mib = 1024 * 1024;
DWORD Error() noexcept { const auto error = GetLastError(); return error ? error : ERROR_GEN_FAILURE; }
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
bool Nonzero(std::span<const std::uint8_t> bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto value) { return value != 0; });
}
DWORD Hash(std::span<const std::uint8_t> bytes, CellFileSha256* output) noexcept {
  output->fill(0);
  if (bytes.empty() || bytes.size() > 4096) return ERROR_INVALID_DATA;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return ERROR_NOT_SUPPORTED;
  const auto result = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(bytes.data()),
    static_cast<ULONG>(bytes.size()), output->data(), static_cast<ULONG>(output->size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return result < 0 ? ERROR_GEN_FAILURE : ERROR_SUCCESS;
}
template<typename T> void Put(CellVolumeProtectionCheckpoint& bytes, std::size_t offset, const T& value) noexcept {
  std::memcpy(bytes.data() + offset, &value, sizeof(value));
}
template<typename T> void Get(const CellVolumeProtectionCheckpoint& bytes, std::size_t offset, T* value) noexcept {
  std::memcpy(value, bytes.data() + offset, sizeof(*value));
}
DWORD Encode(const CellVolumeProtectionBinding& binding, CellVolumeProtectionPhase phase,
  const CellFileSha256& previous, CellVolumeProtectionCheckpoint* output) noexcept {
  output->fill(0);
  if (!IsValidCellVolumeProtectionBinding(binding) ||
      (phase != CellVolumeProtectionPhase::intent && phase != CellVolumeProtectionPhase::protected_root)) return ERROR_INVALID_DATA;
  auto& bytes = *output;
  std::memcpy(bytes.data(), "GCCPRT01", 8); Put(bytes, 8, static_cast<std::uint32_t>(phase)); Put(bytes, 16, previous);
  Put(bytes, 48, binding.format_sha256); Put(bytes, 80, binding.security_sha256); Put(bytes, 112, binding.volume_id);
  Put(bytes, 128, binding.partition_bytes); Put(bytes, 136, binding.ntfs.serial);
  Put(bytes, 144, binding.ntfs.sectors); Put(bytes, 152, binding.ntfs.clusters);
  Put(bytes, 160, binding.root.volume_serial); Put(bytes, 168, binding.root.file_id);
  CellFileSha256 hash{};
  const auto error = Hash(std::span(bytes).first(digest_offset), &hash);
  if (!error) Put(bytes, digest_offset, hash);
  return error;
}
}
bool IsValidCellVolumeProtectionBinding(const CellVolumeProtectionBinding& binding) noexcept {
  return Nonzero(binding.format_sha256) && Nonzero(binding.security_sha256) && !IsEqualGUID(binding.volume_id, GUID{}) &&
    binding.partition_bytes >= 8 * mib && binding.partition_bytes <= 1024 * 1024 * mib && binding.partition_bytes % mib == 0 &&
    binding.ntfs.serial && binding.ntfs.sectors <= binding.partition_bytes / 512 &&
    binding.ntfs.sectors >= binding.partition_bytes / 512 - 8 && binding.ntfs.clusters == binding.ntfs.sectors / 8 &&
    binding.root.volume_serial == binding.ntfs.serial && Nonzero(binding.root.file_id);
}
DWORD HashCellVolumeRootSecurity(const std::wstring& owner, const std::wstring& controller, CellFileSha256* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->fill(0);
  try {
    std::vector<std::uint8_t> descriptor;
    const auto error = BuildCellParentSecurity(owner, controller, &descriptor);
    if (error) return error;
    constexpr char domain[] = "goatcitadel.native-cell-volume-root-security.v1";
    std::vector<std::uint8_t> bytes(std::begin(domain), std::end(domain));
    for (const auto* sid : {&owner, &controller}) {
      bytes.push_back(static_cast<std::uint8_t>(sid->size())); bytes.push_back(static_cast<std::uint8_t>(sid->size() >> 8));
      for (const auto character : *sid) bytes.push_back(static_cast<std::uint8_t>(character));
    }
    return Hash(bytes, output);
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ValidateCellVolumeProtectionCheckpointPrefix(const CellVolumeProtectionBinding& binding,
  std::span<const CellVolumeProtectionCheckpoint> records) noexcept {
  if (!IsValidCellVolumeProtectionBinding(binding)) return ERROR_INVALID_PARAMETER;
  if (records.empty() || records.size() > 2) return ERROR_INVALID_DATA;
  CellFileSha256 previous{};
  for (std::size_t index = 0; index < records.size(); ++index) {
    CellVolumeProtectionCheckpoint expected{};
    const auto error = Encode(binding, static_cast<CellVolumeProtectionPhase>(index + 1), previous, &expected);
    if (error) return error;
    if (records[index] != expected) return ERROR_INVALID_DATA;
    Get(expected, digest_offset, &previous);
  }
  return ERROR_SUCCESS;
}
DWORD DecodeCellVolumeProtectionCheckpoints(const CellVolumeProtectionBinding& binding,
  std::span<const CellVolumeProtectionCheckpoint> records) noexcept {
  const auto error = ValidateCellVolumeProtectionCheckpointPrefix(binding, records);
  return error ? error : records.size() == 2 ? ERROR_SUCCESS : ERROR_IO_INCOMPLETE;
}
DWORD CellVolumeProtection::InspectRoot(HANDLE handle, const std::wstring& expected_path,
  std::uint64_t expected_serial, CellFileIdentity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!handle || handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK) return ERROR_INVALID_HANDLE;
  FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO file{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &file, sizeof(file))) return Error();
  constexpr DWORD unsafe = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_SPARSE_FILE | FILE_ATTRIBUTE_COMPRESSED |
    FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
  if ((attributes.FileAttributes & unsafe) || attributes.ReparseTag || !(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      !standard.Directory || standard.DeletePending || standard.NumberOfLinks != 1 ||
      standard.EndOfFile.QuadPart < 0 || standard.AllocationSize.QuadPart < 0 ||
      !expected_serial || file.VolumeSerialNumber != expected_serial) return ERROR_FILE_INVALID;
  std::array<wchar_t, 16> filesystem{}; DWORD flags = 0;
  if (!GetVolumeInformationByHandleW(handle, nullptr, 0, nullptr, nullptr, &flags,
      filesystem.data(), static_cast<DWORD>(filesystem.size()))) return Error();
  if (wcscmp(filesystem.data(), L"NTFS") != 0 || !(flags & FILE_PERSISTENT_ACLS)) return ERROR_NOT_SUPPORTED;
  alignas(FILE_STREAM_INFO) std::array<std::uint8_t, 8192> streams{};
  if (!GetFileInformationByHandleEx(handle, FileStreamInfo, streams.data(), static_cast<DWORD>(streams.size()))) {
    if (Error() != ERROR_HANDLE_EOF) return Error();
  } else {
    const auto* stream = reinterpret_cast<const FILE_STREAM_INFO*>(streams.data());
    if (stream->StreamNameLength || stream->NextEntryOffset) return ERROR_ACCESS_DENIED;
  }
  std::array<wchar_t, 2048> path{};
  const auto length = GetFinalPathNameByHandleW(handle, path.data(), static_cast<DWORD>(path.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!length) return Error();
  if (length >= path.size() || length != expected_path.size() ||
      CompareStringOrdinal(path.data(), static_cast<int>(length), expected_path.c_str(), static_cast<int>(expected_path.size()), TRUE) != CSTR_EQUAL)
    return ERROR_FILE_INVALID;
  output->volume_serial = file.VolumeSerialNumber;
  std::copy(std::begin(file.FileId.Identifier), std::end(file.FileId.Identifier), output->file_id.begin());
  if (!Nonzero(output->file_id)) { *output = {}; return ERROR_FILE_INVALID; }
  return ERROR_SUCCESS;
}
DWORD CellVolumeProtection::ApplySecurity(HANDLE root, const std::vector<std::uint8_t>& descriptor,
  DWORD (*guard)(void*) noexcept, void* context) noexcept {
  if (!guard || descriptor.empty() || descriptor.size() > 4096 ||
      !IsValidSecurityDescriptor(const_cast<std::uint8_t*>(descriptor.data()))) return ERROR_INVALID_PARAMETER;
  void* bytes = const_cast<std::uint8_t*>(descriptor.data());
  PSID owner = nullptr, group = nullptr; PACL dacl = nullptr, label = nullptr;
  BOOL ignored = FALSE, present = FALSE; SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  if (!GetSecurityDescriptorControl(bytes, &control, &revision) || !(control & SE_DACL_PROTECTED) ||
      !GetSecurityDescriptorOwner(bytes, &owner, &ignored) || !owner || !IsValidSid(owner) ||
      !GetSecurityDescriptorGroup(bytes, &group, &ignored) || !group || !IsValidSid(group) ||
      !GetSecurityDescriptorDacl(bytes, &present, &dacl, &ignored) || !present || !dacl || !IsValidAcl(dacl) || !dacl->AceCount ||
      !GetSecurityDescriptorSacl(bytes, &present, &label, &ignored) || !present || !label || !IsValidAcl(label) || label->AceCount != 1)
    return ERROR_INVALID_SECURITY_DESCR;
  // Revalidate after preparing the SDK arguments, immediately before the only
  // security write. The descriptor is generated from frozen controller SIDs.
  const auto error = guard(context);
  if (error) return error;
  return SetSecurityInfo(root, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION, owner, group, dacl, label);
}
struct CellVolumeProtection::NativeContext final {
  CellVolumeProtection* owner; CellWorkspaceDirectories* workspace; ULONGLONG deadline; HANDLE cancellation;
};
HANDLE CellVolumeProtection::OpenRoot(const std::wstring& path, bool writable) noexcept {
  return CreateFileW(path.c_str(), FILE_GENERIC_READ | (writable ? WRITE_DAC | WRITE_OWNER : 0), FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}
CellVolumeProtection::Operations CellVolumeProtection::NativeOperations(NativeContext& context) noexcept {
  return {
    [](void* raw) noexcept -> DWORD {
      auto& value = *static_cast<NativeContext*>(raw); auto& owner = *value.owner;
      const auto remaining = Remaining(value.deadline);
      DWORD error = remaining ? owner.format_.Verify(*value.workspace, remaining, value.cancellation) : ERROR_TIMEOUT;
      CellFileIdentity held{}, named{};
      if (!error) error = InspectRoot(owner.root_, owner.path_, owner.binding_.ntfs.serial, &held);
      if (!error && held != owner.binding_.root) error = ERROR_FILE_INVALID;
      if (error) return error;
      const HANDLE current = OpenRoot(owner.path_, false);
      if (current == INVALID_HANDLE_VALUE) return Error();
      error = InspectRoot(current, owner.path_, owner.binding_.ntfs.serial, &named); CloseHandle(current);
      if (!error && named != owner.binding_.root) error = ERROR_FILE_INVALID;
      return error;
    },
    [](void* raw) noexcept -> DWORD {
      auto& owner = *static_cast<NativeContext*>(raw)->owner;
      return VerifyCellSecurity(owner.root_, owner.descriptor_);
    },
    [](void* raw, DWORD (*guard)(void*) noexcept, void* guard_context) noexcept -> DWORD {
      auto& owner = *static_cast<NativeContext*>(raw)->owner;
      return ApplySecurity(owner.root_, owner.descriptor_, guard, guard_context);
    }, &context,
  };
}
DWORD CellVolumeProtection::Prepare(CellNtfsFormat& source, const std::wstring& owner, const std::wstring& controller) noexcept {
  if (source.State() != CellNtfsFormatState::formatted || source.records_.size() != 2) return ERROR_INVALID_STATE;
  DWORD error = BuildCellParentSecurity(owner, controller, &descriptor_);
  if (!error) error = HashCellVolumeRootSecurity(owner, controller, &binding_.security_sha256);
  if (!error) error = DecodeCellNtfsFormatCheckpoints(source.binding_, source.records_, &binding_.ntfs);
  if (!error) {
    Get(source.records_.back(), digest_offset, &binding_.format_sha256);
    binding_.volume_id = source.binding_.volume_id; binding_.partition_bytes = source.binding_.partition_bytes;
  }
  return error;
}
DWORD CellVolumeProtection::Bind(CellNtfsFormat& source, CellWorkspaceDirectories& workspace, bool create,
  ULONGLONG deadline, HANDLE cancellation) noexcept {
  auto remaining = Remaining(deadline);
  DWORD error = remaining ? source.Verify(workspace, remaining, cancellation) : ERROR_TIMEOUT;
  if (!error && descriptor_ != workspace.parent_descriptor_) error = ERROR_INVALID_SECURITY_DESCR;
  remaining = Remaining(deadline);
  if (!error) error = remaining ? format_.OpenRecorded(source.volume_.layout_, workspace, source.records_, remaining, cancellation) : ERROR_TIMEOUT;
  if (error) return error;
  try { path_ = format_.volume_.path_; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  if (!IsCellVolumeGuidPath(path_)) return ERROR_BAD_PATHNAME;
  error = Control(deadline, cancellation);
  if (error) return error;
  root_ = OpenRoot(path_, create);
  if (root_ == INVALID_HANDLE_VALUE) return Error();
  CellFileIdentity actual{};
  error = InspectRoot(root_, path_, binding_.ntfs.serial, &actual);
  if (!error) {
    if (create) binding_.root = actual;
    else if (actual != binding_.root) error = ERROR_FILE_INVALID;
  }
  return error ? error : Control(deadline, cancellation);
}
DWORD CellVolumeProtection::Check(const Operations& operations, ULONGLONG deadline, HANDLE cancellation, bool authorize, bool security) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error && authorize) error = committer_.authorize(committer_.context);
  // Canonical RPCs may take time. Read native identity/security after the
  // authority exchange so drift during that exchange cannot become success.
  if (!error) error = Control(deadline, cancellation);
  if (!error) error = operations.verify(operations.context);
  if (!error && security) error = operations.security(operations.context);
  return error ? error : Control(deadline, cancellation);
}
DWORD CellVolumeProtection::Commit(CellVolumeProtectionPhase phase, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Control(deadline, cancellation);
  if (!error) error = committer_.authorize(committer_.context);
  if (error) return error;
  CellFileSha256 previous{}, expected{}, acknowledged{};
  if (!records_.empty()) Get(records_.back(), digest_offset, &previous);
  CellVolumeProtectionCheckpoint record{};
  error = Encode(binding_, phase, previous, &record);
  if (!error) error = Control(deadline, cancellation);
  if (error) return error;
  records_.push_back(record); Get(record, digest_offset, &expected);
  error = committer_.commit(committer_.context, record, &acknowledged);
  if (!error && acknowledged != expected) error = ERROR_INVALID_DATA;
  return error ? error : Control(deadline, cancellation);
}
DWORD CellVolumeProtection::Run(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = Check(operations, deadline, cancellation, true);
  if (!error) error = Commit(CellVolumeProtectionPhase::intent, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true);
  struct Guard { CellVolumeProtection* owner; const Operations* operations; ULONGLONG deadline; HANDLE cancellation; }
    guard{this, &operations, deadline, cancellation};
  if (!error) error = operations.apply(operations.context, [](void* raw) noexcept -> DWORD {
    auto& value = *static_cast<Guard*>(raw);
    return value.owner->Check(*value.operations, value.deadline, value.cancellation, true);
  }, &guard);
  if (!error) error = Check(operations, deadline, cancellation, true, true);
  if (!error) error = Commit(CellVolumeProtectionPhase::protected_root, deadline, cancellation);
  if (!error) error = Check(operations, deadline, cancellation, true, true);
  if (!error) state_ = CellVolumeProtectionState::protected_root;
  return error;
}
DWORD CellVolumeProtection::Recover(const Operations& operations, ULONGLONG deadline, HANDLE cancellation) noexcept {
  DWORD error = DecodeCellVolumeProtectionCheckpoints(binding_, records_);
  if (!error) error = Check(operations, deadline, cancellation, false, true);
  if (!error) error = Check(operations, deadline, cancellation, false, true);
  if (!error) state_ = CellVolumeProtectionState::protected_root;
  return error;
}
CellVolumeProtection::~CellVolumeProtection() { Close(); }
DWORD CellVolumeProtection::Create(CellNtfsFormat& source, CellWorkspaceDirectories& workspace,
  const std::wstring& owner, const std::wstring& controller, const CellVolumeProtectionCommitter& committer,
  DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || !committer.commit || !committer.authorize) return ERROR_INVALID_PARAMETER;
  if (source.State() != CellNtfsFormatState::formatted || !source.freshly_formatted_ || source.protection_attempted_)
    return ERROR_INVALID_STATE;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  DWORD error = Control(deadline, cancellation);
  if (error) return error;
  attempted_ = true; state_ = CellVolumeProtectionState::unknown; committer_ = committer;
  // Consume before any fallible binding/OS work; a new owner cannot retry a
  // partially acknowledged operation through the same successful formatter.
  source.protection_attempted_ = true;
  try { records_.reserve(2); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  error = committer_.authorize(committer_.context);
  if (!error) error = Prepare(source, owner, controller);
  if (!error) error = Bind(source, workspace, true, deadline, cancellation);
  NativeContext context{this, &workspace, deadline, cancellation};
  if (!error) error = Run(NativeOperations(context), deadline, cancellation);
  if (!error) freshly_protected_ = true;
  return error;
}
DWORD CellVolumeProtection::OpenRecorded(CellNtfsFormat& source, CellWorkspaceDirectories& workspace,
  const std::wstring& owner, const std::wstring& controller,
  std::span<const CellVolumeProtectionCheckpoint> records, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (attempted_) return ERROR_ALREADY_INITIALIZED;
  if (!wall_limit_ms || wall_limit_ms > 600000 || records.size() != 2) return ERROR_INVALID_PARAMETER;
  const ULONGLONG deadline = GetTickCount64() + wall_limit_ms;
  attempted_ = true; state_ = CellVolumeProtectionState::unknown;
  try { records_.assign(records.begin(), records.end()); } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
  DWORD error = Control(deadline, cancellation);
  if (!error) error = Prepare(source, owner, controller);
  if (!error) {
    Get(records_[0], 160, &binding_.root.volume_serial); Get(records_[0], 168, &binding_.root.file_id);
    error = DecodeCellVolumeProtectionCheckpoints(binding_, records_);
  }
  if (!error) error = Bind(source, workspace, false, deadline, cancellation);
  NativeContext context{this, &workspace, deadline, cancellation};
  return error ? error : Recover(NativeOperations(context), deadline, cancellation);
}
DWORD CellVolumeProtection::Verify(CellWorkspaceDirectories& workspace, DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (state_ != CellVolumeProtectionState::protected_root) return ERROR_INVALID_STATE;
  if (!wall_limit_ms || wall_limit_ms > 600000) return ERROR_INVALID_PARAMETER;
  state_ = CellVolumeProtectionState::unknown;
  NativeContext context{this, &workspace, GetTickCount64() + wall_limit_ms, cancellation};
  return Recover(NativeOperations(context), context.deadline, cancellation);
}
DWORD CellVolumeProtection::RecordCheckpoints(std::vector<CellVolumeProtectionCheckpoint>* output) const noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  if (records_.empty()) return ERROR_INVALID_STATE;
  try { *output = records_; return ERROR_SUCCESS; } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellVolumeProtection::RecordRoot(CellWorkspaceDirectories& workspace, CellFileIdentity* output,
  DWORD wall_limit_ms, HANDLE cancellation) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  const auto error = Verify(workspace, wall_limit_ms, cancellation);
  if (!error) *output = binding_.root;
  return error;
}
HANDLE CellVolumeProtection::RootHandle() const noexcept {
  return state_ == CellVolumeProtectionState::protected_root && root_ != INVALID_HANDLE_VALUE ? root_ : nullptr;
}
void CellVolumeProtection::Close() noexcept {
  state_ = CellVolumeProtectionState::unknown;
  if (root_ != INVALID_HANDLE_VALUE) CloseHandle(root_);
  root_ = INVALID_HANDLE_VALUE; format_.Close();
}
}
