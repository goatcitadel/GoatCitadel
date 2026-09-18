#include "cell_controller_protocol.hpp"
#include "cell_runtime_session.hpp"
#include "cell_runtime_result.hpp"
#include "cell_joined_capacity_wire.hpp"
#include "cell_pool_capacity.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
std::uint32_t U32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0; for (unsigned i = 0; i < 4; ++i) value |= static_cast<std::uint32_t>(bytes[i]) << (8 * i); return value;
}
std::uint64_t U64(const std::uint8_t* bytes) noexcept {
  std::uint64_t value = 0; for (unsigned i = 0; i < 8; ++i) value |= static_cast<std::uint64_t>(bytes[i]) << (8 * i); return value;
}
void Put32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (unsigned i = 0; i < 4; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
CellFileIdentity Identity(const std::uint8_t* bytes) noexcept {
  CellFileIdentity value; value.volume_serial = U64(bytes); std::copy_n(bytes + 8, 16, value.file_id.begin()); return value;
}
template<class T> bool Nonzero(const T& value) noexcept { return std::any_of(value.begin(), value.end(), [](auto byte) { return byte != 0; }); }
bool ValidIdentity(const CellFileIdentity& value) noexcept { return value.volume_serial && Nonzero(value.file_id); }
bool ValidCapacity(const CellProvisioningFootprint& value) noexcept {
  constexpr std::uint64_t maximum_safe_integer = 9007199254740991ULL;
  const auto& footprint = value.footprint;
  if (!ValidIdentity(value.anchor.file) || !Nonzero(value.anchor.prepared_sha256) ||
      !Nonzero(value.assignment_binding) || !Nonzero(value.profile_sha256) || !Nonzero(value.checkpoint_sha256) ||
      !ValidIdentity(value.workspace.parent) || footprint.root != value.workspace.directories[0] ||
      footprint.logical_file_bytes > maximum_safe_integer || footprint.allocated_bytes > maximum_safe_integer ||
      footprint.directory_count < 4 || footprint.directory_count > 20000 ||
      footprint.file_count > 20000 - footprint.directory_count || (!footprint.file_count && footprint.logical_file_bytes)) return false;
  for (std::size_t index = 0; index < value.workspace.directories.size(); ++index) {
    const auto& directory = value.workspace.directories[index];
    if (!ValidIdentity(directory) || directory.volume_serial != value.workspace.parent.volume_serial ||
        directory == value.workspace.parent ||
        std::find(value.workspace.directories.begin(), value.workspace.directories.begin() + index, directory) !=
          value.workspace.directories.begin() + index) return false;
  }
  return true;
}
bool ValidBackingCapacity(const CellProvisioningBackingFootprint& value) noexcept {
  const auto& backing = value.backing;
  if (!Nonzero(value.anchor.prepared_sha256) || !Nonzero(value.assignment_binding) || !Nonzero(value.profile_sha256) ||
      !Nonzero(value.checkpoint_sha256) || !IsValidCellVirtualDiskSpec(backing.record.spec) ||
      backing.record.spec.virtual_bytes < 64ULL * 1024 * 1024 || backing.record.control != value.workspace.directories[1] ||
      backing.file_bytes < backing.record.spec.virtual_bytes || backing.allocated_bytes < backing.file_bytes ||
      backing.allocated_bytes > backing.record.spec.reserved_file_bytes || value.journal_bytes != 21 * 1024 ||
      value.journal_allocated_bytes < value.journal_bytes || value.journal_allocated_bytes > 65536 ||
      value.host_file_allocated_bytes != backing.allocated_bytes + value.journal_allocated_bytes) return false;
  const std::array<CellFileIdentity, 7> identities{value.workspace.parent, value.workspace.directories[0], value.workspace.directories[1],
    value.workspace.directories[2], value.workspace.directories[3], value.anchor.file, backing.record.backing};
  for (std::size_t index = 0; index < identities.size(); ++index)
    if (!ValidIdentity(identities[index]) || identities[index].volume_serial != value.workspace.parent.volume_serial ||
        std::find(identities.begin(), identities.begin() + index, identities[index]) != identities.begin() + index) return false;
  return true;
}
bool Known(CellControllerMessage kind, DWORD count) noexcept {
  switch (kind) {
    case CellControllerMessage::controller_attestation_challenge: return count == 36;
    case CellControllerMessage::controller_attestation_proof: return count == 460;
    case CellControllerMessage::controller_attestation_context: return count == 64;
    case CellControllerMessage::hello: return count == 32;
    case CellControllerMessage::welcome: return count == 64;
    case CellControllerMessage::request: return count == kCellControllerRequestBytes;
    case CellControllerMessage::cleanup_admission: return count == 448;
    case CellControllerMessage::pool_cleanup_size: return count == 36;
    case CellControllerMessage::pool_cleanup_chunk: return count > 36 && count <= 36 + 4096;
    case CellControllerMessage::pool_capacity_size: return count == 36;
    case CellControllerMessage::pool_capacity_chunk: return count > 36 && count <= 36 + 4096;
    case CellControllerMessage::pool_capture_binding: return count == 64;
    case CellControllerMessage::pool_capacity_ready: return count == 64;
    case CellControllerMessage::install_capacity_authority:
    case CellControllerMessage::install_capacity_capture:
    case CellControllerMessage::install_capacity_authorized: return count == 144;
    case CellControllerMessage::cleanup_ready: return count == CellControllerRuntimeBindingBytes{}.size();
    case CellControllerMessage::pool_history_header: return count == 32 + kCellControllerPoolHeaderBytes;
    case CellControllerMessage::pool_history_member: return count == 32 + kCellControllerPoolMemberFirstBytes;
    case CellControllerMessage::pool_history_member_tail: return count == 32 + kCellControllerPoolMemberBytes - kCellControllerPoolMemberFirstBytes;
    case CellControllerMessage::install_request: return count == kCellRuntimeInstallBytes;
    case CellControllerMessage::install_binding: return count == CellControllerRuntimeBindingBytes{}.size();
    case CellControllerMessage::install_authority:
    case CellControllerMessage::install_authorized: return count == 136;
    case CellControllerMessage::install_outcome: return count == 384;
    case CellControllerMessage::install_outcome_received: return count == 64;
    case CellControllerMessage::checkpoint: return count == 1056;
    case CellControllerMessage::acknowledgement: return count == 68;
    case CellControllerMessage::receipt: return count == 48;
    case CellControllerMessage::finish: return count == 32;
    case CellControllerMessage::volume_authority: return count == 72;
    case CellControllerMessage::volume_authorized: return count == 72;
    case CellControllerMessage::volume_history: return count == kCellControllerVolumeHistoryBytes;
    case CellControllerMessage::format_history: return count == kCellControllerFormatHistoryBytes;
    case CellControllerMessage::protection_history: return count == kCellControllerProtectionHistoryBytes;
    case CellControllerMessage::mount_history: return count == kCellControllerMountHistoryBytes;
    case CellControllerMessage::mounted_workspace_history: return count == kCellControllerMountedWorkspaceHistoryBytes;
    case CellControllerMessage::capacity_observation: return count == kCellControllerCapacityObservationBytes;
    case CellControllerMessage::backing_capacity_observation: return count == kCellControllerBackingCapacityObservationBytes;
    case CellControllerMessage::inventory_observation: return count == kCellControllerCapacityObservationBytes;
    case CellControllerMessage::inventory_chunk: return count == CellControllerInventoryChunkBytes{}.size();
    case CellControllerMessage::runtime_authority:
    case CellControllerMessage::runtime_delivery_authority:
    case CellControllerMessage::runtime_delivery_authorized:
    case CellControllerMessage::runtime_authorized: return count == 104;
    case CellControllerMessage::runtime_binding:
    case CellControllerMessage::runtime_control_setup:
    case CellControllerMessage::runtime_control_hello:
    case CellControllerMessage::runtime_control_welcome:
    case CellControllerMessage::runtime_ready: return count == CellControllerRuntimeBindingBytes{}.size();
    case CellControllerMessage::runtime_input_ack: return count == 80;
    case CellControllerMessage::runtime_parent_input_poll: return count == 88;
    case CellControllerMessage::runtime_parent_input_reply: return count == 1148;
    case CellControllerMessage::runtime_parent_output_received: return count == 84;
    case CellControllerMessage::runtime_parent_finish:
    case CellControllerMessage::runtime_parent_finished: return count == 100;
    case CellControllerMessage::runtime_control_authority:
    case CellControllerMessage::runtime_control_authorized: return count == 1168;
    case CellControllerMessage::runtime_input:
    case CellControllerMessage::runtime_input_end:
    case CellControllerMessage::runtime_output:
    case CellControllerMessage::runtime_output_end:
    case CellControllerMessage::runtime_error:
    case CellControllerMessage::runtime_error_end: return count == 1056;
  }
  return false;
}
struct Parent final { HANDLE value = INVALID_HANDLE_VALUE; ~Parent() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
struct Session final {
  HANDLE pipe, stop;
  const CellControllerSessionOwner& owner;
  ULONGLONG deadline;
  CellControllerNonce nonce;
  CellControllerSessionResult& result;
  CellFileSha256 retained_head{};
  bool volume = false;
  bool format = false;
  bool protection = false;
  bool mount = false;
  bool mounted_workspace = false;
  bool capacity = false;
  bool runtime = false;
  CellControllerRuntimeBinding installation;
  ULONGLONG next_capacity_authority = 0;
  std::unique_ptr<CellControllerMeasurementHold> measurement;
  ULONGLONG IoDeadline() const noexcept {
    return runtime ? std::min<ULONGLONG>(deadline, GetTickCount64() + 5000) : deadline;
  }
  DWORD Authorize(bool first = false) noexcept {
    const DWORD state = WaitForSingleObject(stop, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
    const auto error = owner.authorize(owner.context, first);
    return !error && measurement ? measurement->Verify() : error;
  }
  static DWORD AuthorizeInstallation(void* context) noexcept {
    auto& session = *static_cast<Session*>(context);
    auto error = session.Authorize();
    if (error) return error;
    if (!Nonzero(session.installation.nonce) || session.result.checkpoints != 21 ||
        session.retained_head != session.installation.checkpoint_sha256 ||
        session.result.installation_authority_checks >= 65536) return ERROR_INVALID_STATE;
    std::array<std::uint8_t, 136> challenge{}, reply{};
    std::copy(session.nonce.begin(), session.nonce.end(), challenge.begin());
    std::copy(session.installation.nonce.begin(), session.installation.nonce.end(), challenge.begin() + 32);
    std::copy(session.installation.request_sha256.begin(), session.installation.request_sha256.end(), challenge.begin() + 64);
    std::copy(session.retained_head.begin(), session.retained_head.end(), challenge.begin() + 96);
    Put32(challenge.data() + 128, ++session.result.installation_authority_checks);
    Put32(challenge.data() + 132, 1);
    const auto deadline = std::min<ULONGLONG>(session.deadline, GetTickCount64() + 5000);
    error = WriteCellControllerMessage(session.pipe, CellControllerMessage::install_authority, challenge.data(),
      static_cast<DWORD>(challenge.size()), session.stop, deadline);
    if (!error) error = ReadCellControllerMessage(session.pipe, CellControllerMessage::install_authorized, reply.data(),
      static_cast<DWORD>(reply.size()), session.stop, deadline);
    if (!error && reply != challenge) error = ERROR_INVALID_DATA;
    return error ? error : session.Authorize();
  }
  DWORD Record(const CellProvisioningRecord& record, bool acknowledge) noexcept {
    DWORD error = Authorize();
    if (error) return error;
    const bool volume_record = result.checkpoints >= 5;
    const bool format_record = result.checkpoints >= 11;
    const bool protection_record = result.checkpoints >= 13;
    const bool mount_record = result.checkpoints >= 15;
    const bool workspace_record = result.checkpoints >= 19;
    if (result.checkpoints >= (mounted_workspace ? 21u : mount ? 19u : protection ? 15u : format ? 13u : volume ? 11u : 5u) ||
        std::memcmp(record.data(), workspace_record ? "GCCMWP01" : mount_record ? "GCCMNV01" : protection_record ? "GCCPRV01" : format_record ? "GCCFMT01" : volume_record ? "GCCVOL01" : "GCCELLP1", 8) ||
        U32(record.data() + 8) != (workspace_record ? result.checkpoints - 18 : mount_record ? result.checkpoints - 14 : protection_record ? result.checkpoints - 12 : format_record ? result.checkpoints - 10 : volume_record ? result.checkpoints - 4 : result.checkpoints + 1)) return ERROR_INVALID_DATA;
    std::array<std::uint8_t, 1056> bytes{};
    std::copy(nonce.begin(), nonce.end(), bytes.begin()); std::copy(record.begin(), record.end(), bytes.begin() + 32);
    error = WriteCellControllerMessage(pipe, CellControllerMessage::checkpoint, bytes.data(), static_cast<DWORD>(bytes.size()), stop, IoDeadline());
    if (error) return error;
    ++result.checkpoints;
    std::copy_n(record.begin() + 992, retained_head.size(), retained_head.begin());
    if (!acknowledge) return ERROR_SUCCESS;
    std::array<std::uint8_t, 68> ack{};
    error = ReadCellControllerMessage(pipe, CellControllerMessage::acknowledgement, ack.data(), static_cast<DWORD>(ack.size()), stop, IoDeadline());
    if (!error) error = Authorize();
    if (!error && (!std::equal(nonce.begin(), nonce.end(), ack.begin()) || U32(ack.data() + 32) != result.checkpoints ||
        !std::equal(record.begin() + 992, record.end(), ack.begin() + 36))) error = ERROR_INVALID_DATA;
    return error;
  }
  static DWORD AuthorizeVolume(void* context) noexcept {
    if (!context) return ERROR_INVALID_PARAMETER;
    auto& session = *static_cast<Session*>(context);
    DWORD error = session.Authorize();
    if (error) return error;
    if (!session.volume || session.result.checkpoints < 5 || session.result.checkpoints > (session.mounted_workspace ? 21u : session.mount ? 19u : session.protection ? 15u : session.format ? 13u : 11u) ||
        session.result.volume_authority_checks >= kCellControllerMaximumVolumeChecks || !Nonzero(session.retained_head)) return ERROR_INVALID_STATE;
    std::array<std::uint8_t, 72> challenge{}, reply{};
    std::copy(session.nonce.begin(), session.nonce.end(), challenge.begin());
    Put32(challenge.data() + 32, ++session.result.volume_authority_checks);
    Put32(challenge.data() + 36, session.result.checkpoints);
    std::copy(session.retained_head.begin(), session.retained_head.end(), challenge.begin() + 40);
    error = WriteCellControllerMessage(session.pipe, CellControllerMessage::volume_authority, challenge.data(),
      static_cast<DWORD>(challenge.size()), session.stop, session.IoDeadline());
    if (!error) error = ReadCellControllerMessage(session.pipe, CellControllerMessage::volume_authorized, reply.data(),
      static_cast<DWORD>(reply.size()), session.stop, session.IoDeadline());
    if (!error && reply != challenge) error = ERROR_INVALID_DATA;
    return error ? error : session.Authorize();
  }
  static DWORD Commit(void* context, const CellProvisioningRecord& record, CellFileSha256* digest) noexcept {
    if (!context || !digest) return ERROR_INVALID_PARAMETER;
    *digest = {};
    auto& session = *static_cast<Session*>(context);
    const DWORD error = session.Record(record, true);
    if (!error) std::copy_n(record.begin() + 992, 32, digest->begin());
    return error;
  }
  static DWORD AuthorizeCapacity(void* context) noexcept {
    auto& session = *static_cast<Session*>(context);
    auto error = session.Authorize();
    if (error) return error;
    if (!session.capacity || session.result.checkpoints != 21) return ERROR_INVALID_STATE;
    // Local identity and native tree checks run at every reader boundary. Keep
    // remote lease checks bounded across the 60-second read, then force another
    // check before publishing. A cached read check never authorizes an effect.
    if (GetTickCount64() >= session.next_capacity_authority) {
      error = AuthorizeVolume(context);
      if (!error) session.next_capacity_authority = GetTickCount64() + 250;
    }
    return error;
  }
};
}
bool EncodeCellControllerRuntimeBinding(const CellControllerNonce& connection_nonce, const CellControllerRuntimeBinding& binding,
  CellControllerRuntimeBindingBytes* output) noexcept {
  if (!output) return false; *output = {};
  if (!Nonzero(connection_nonce) || !Nonzero(binding.nonce) || !Nonzero(binding.request_sha256) || !Nonzero(binding.checkpoint_sha256)) return false;
  std::copy(connection_nonce.begin(), connection_nonce.end(), output->begin());
  std::copy(binding.nonce.begin(), binding.nonce.end(), output->begin() + 32);
  std::copy(binding.request_sha256.begin(), binding.request_sha256.end(), output->begin() + 64);
  std::copy(binding.checkpoint_sha256.begin(), binding.checkpoint_sha256.end(), output->begin() + 96);
  return true;
}
bool DecodeCellControllerRuntimeBinding(const CellControllerNonce& connection_nonce, const CellControllerRuntimeBindingBytes& bytes,
  CellControllerRuntimeBinding* output) noexcept {
  if (!output) return false; *output = {};
  CellControllerRuntimeBinding value;
  std::copy_n(bytes.begin() + 32, 32, value.nonce.begin()); std::copy_n(bytes.begin() + 64, 32, value.request_sha256.begin());
  std::copy_n(bytes.begin() + 96, 32, value.checkpoint_sha256.begin());
  CellControllerRuntimeBindingBytes expected{};
  if (!EncodeCellControllerRuntimeBinding(connection_nonce, value, &expected) || expected != bytes) return false;
  *output = value; return true;
}
bool MatchesCellControllerRuntimeResult(const CellControllerRuntimeBinding& binding, const CellRuntimeSessionResult& runtime) noexcept {
  return !runtime.error && runtime.request_received && runtime.dispatch_started && runtime.dispatch_joined && runtime.output_ended &&
    runtime.local_intent_retained && runtime.local_outcome_retained && runtime.result_acknowledged && runtime.result_retention_acknowledged &&
    (!runtime.file_selection_requested || runtime.files_acknowledged) &&
    runtime.execution.binding_verified && runtime.execution.binding.nonce == binding.nonce && runtime.execution.binding.request_sha256 == binding.request_sha256;
}
bool ValidateCellControllerInstallRequest(const CellControllerRequest& request) noexcept {
  if (!IsCellControllerInstall(request.operation)) return false;
  CellControllerRuntimeBindingBytes binding{};
  if (!EncodeCellControllerRuntimeBinding(request.nonce, request.installation, &binding)) return false;
  CellRuntimeInstallRequest decoded;
  if (DecodeCellRuntimeInstall(request.installation_bytes, {request.installation.nonce, request.installation.request_sha256}, &decoded)) return false;
  return decoded.journal_identity == request.anchor.file && decoded.prepared_sha256 == request.anchor.prepared_sha256 &&
    decoded.checkpoint_sha256 == request.installation.checkpoint_sha256 &&
    std::equal(decoded.checkpoint_sha256.begin(), decoded.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992);
}
bool DecodeCellControllerRequest(const std::array<std::uint8_t, kCellControllerRequestBytes>& bytes,
  const CellControllerNonce& nonce, CellControllerRequest* output) noexcept {
  if (!output) return false;
  *output = {};
  try {
    CellControllerRequest value;
    value.operation = U32(bytes.data()); value.wall_ms = U32(bytes.data() + 4);
    if (!IsCellControllerOperation(value.operation) || value.wall_ms < 100 ||
        value.wall_ms > (IsCellControllerRuntime(value.operation) ? 86400000u : (IsCellControllerCapacity(value.operation) || IsCellControllerInstall(value.operation)) ? 60000u : 600000u) || !Nonzero(nonce) ||
        !std::equal(nonce.begin(), nonce.end(), bytes.begin() + 8)) return false;
    value.nonce = nonce;
    for (std::size_t index = 40; index < 80; ++index) value.cell_name += static_cast<wchar_t>(bytes[index]);
    if (value.cell_name.compare(0, 8, L"gc-cell-") || value.cell_name.find_first_not_of(L"0123456789abcdef", 8) != std::wstring::npos) return false;
    std::copy_n(bytes.begin() + 80, 32, value.plan.assignment_binding.begin());
    std::copy_n(bytes.begin() + 112, 32, value.plan.profile_sha256.begin());
    std::memcpy(&value.plan.disk.identifier, bytes.data() + 144, sizeof(GUID));
    value.plan.disk.virtual_bytes = U64(bytes.data() + 160); value.plan.disk.reserved_file_bytes = U64(bytes.data() + 168);
    value.parent = Identity(bytes.data() + 176); value.anchor.file = Identity(bytes.data() + 200);
    std::copy_n(bytes.begin() + 224, 32, value.anchor.prepared_sha256.begin());
    if (!Nonzero(value.plan.assignment_binding) || !Nonzero(value.plan.profile_sha256) || !ValidIdentity(value.parent) ||
        !IsValidCellVirtualDiskSpec(value.plan.disk) || (IsCellControllerVolume(value.operation) && value.plan.disk.virtual_bytes < 64ULL * 1024 * 1024)) return false;
    if (IsCellControllerCreation(value.operation) ? value.anchor != CellProvisioningAnchor{} :
        (!ValidIdentity(value.anchor.file) || value.anchor.file.volume_serial != value.parent.volume_serial || !Nonzero(value.anchor.prepared_sha256))) return false;
    *output = std::move(value); return true;
  } catch (...) { return false; }
}
bool EncodeCellControllerRequest(const CellControllerRequest& request,
  std::array<std::uint8_t, kCellControllerRequestBytes>* output,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (!output) return false;
  *output = {};
  if (request.cell_name.size() != 40) return false;
  std::array<std::uint8_t, kCellControllerRequestBytes> bytes{};
  const auto put64 = [&](std::size_t offset, std::uint64_t value) {
    for (unsigned i = 0; i < 8; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
  };
  const auto putIdentity = [&](std::size_t offset, const CellFileIdentity& identity) {
    put64(offset, identity.volume_serial); std::copy(identity.file_id.begin(), identity.file_id.end(), bytes.begin() + offset + 8);
  };
  Put32(bytes.data(), request.operation); Put32(bytes.data() + 4, request.wall_ms);
  std::copy(request.nonce.begin(), request.nonce.end(), bytes.begin() + 8);
  for (std::size_t i = 0; i < 40; ++i) {
    if (request.cell_name[i] > 127) return false;
    bytes[40 + i] = static_cast<std::uint8_t>(request.cell_name[i]);
  }
  std::copy(request.plan.assignment_binding.begin(), request.plan.assignment_binding.end(), bytes.begin() + 80);
  std::copy(request.plan.profile_sha256.begin(), request.plan.profile_sha256.end(), bytes.begin() + 112);
  std::memcpy(bytes.data() + 144, &request.plan.disk.identifier, sizeof(GUID));
  put64(160, request.plan.disk.virtual_bytes); put64(168, request.plan.disk.reserved_file_bytes);
  putIdentity(176, request.parent); putIdentity(200, request.anchor.file);
  std::copy(request.anchor.prepared_sha256.begin(), request.anchor.prepared_sha256.end(), bytes.begin() + 224);
  CellControllerRequest validated;
  if (!DecodeCellControllerRequest(bytes, request.nonce, &validated)) return false;
  if ((!IsCellControllerCreation(request.operation) && IsCellControllerVolume(request.operation)) ? !ValidateCellControllerVolumeHistory(request) :
      std::any_of(request.volume_records.begin(), request.volume_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  if ((!IsCellControllerCreation(request.operation) && IsCellControllerFormat(request.operation)) ? !ValidateCellControllerFormatHistory(request) :
      std::any_of(request.format_records.begin(), request.format_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  if ((!IsCellControllerCreation(request.operation) && IsCellControllerProtection(request.operation)) ? !ValidateCellControllerProtectionHistory(request, owner_sid, controller_sid) :
      std::any_of(request.protection_records.begin(), request.protection_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  if ((!IsCellControllerCreation(request.operation) && IsCellControllerMount(request.operation)) ? !ValidateCellControllerMountHistory(request, owner_sid, controller_sid) :
      (std::any_of(request.creation_records.begin(), request.creation_records.end(), [](const auto& record) { return Nonzero(record); }) ||
       std::any_of(request.mount_records.begin(), request.mount_records.end(), [](const auto& record) { return Nonzero(record); }))) return false;
  if ((!IsCellControllerCreation(request.operation) && IsCellControllerMountedWorkspace(request.operation)) ? !ValidateCellControllerMountedWorkspaceHistory(request, owner_sid, controller_sid) :
      std::any_of(request.mounted_workspace_records.begin(), request.mounted_workspace_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  CellControllerRuntimeBindingBytes runtime{};
  if (IsCellControllerRuntime(request.operation) ?
      (!EncodeCellControllerRuntimeBinding(request.nonce, request.runtime, &runtime) ||
       !std::equal(request.runtime.checkpoint_sha256.begin(), request.runtime.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992)) :
      request.runtime != CellControllerRuntimeBinding{}) return false;
  if (IsCellControllerInstall(request.operation) ? !ValidateCellControllerInstallRequest(request) :
      (request.installation != CellControllerRuntimeBinding{} || Nonzero(request.installation_bytes))) return false;
  *output = bytes; return true;
}
DWORD DecodeCellControllerPoolHistory(std::span<const std::uint8_t> bytes, const CellControllerRequest& supplied,
  const std::wstring& owner_sid, const std::wstring& controller_sid, CellControllerPoolHistory* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    auto current = supplied;
    if (IsCellControllerInstallCapacity(current.operation)) {
      if (!ValidateCellControllerInstallRequest(current)) return ERROR_INVALID_DATA;
      current.operation = kCellControllerPoolCapacityOperation;
      current.installation = {}; current.installation_bytes = {};
    }
    std::array<std::uint8_t, kCellControllerRequestBytes> expected{};
    if (!IsCellControllerCapacity(current.operation) || !EncodeCellControllerRequest(current, &expected, owner_sid, controller_sid) ||
        bytes.size() < kCellControllerPoolHeaderBytes || std::memcmp(bytes.data(), "GCPPOOL1", 8) || U32(bytes.data() + 12) != 1 ||
        std::any_of(bytes.begin() + 16, bytes.begin() + 48, [](auto byte) { return byte != 0; }) ||
        !std::equal(current.plan.assignment_binding.begin(), current.plan.assignment_binding.end(), bytes.begin() + 80) ||
        Identity(bytes.data() + 112) != current.parent) return ERROR_INVALID_DATA;
    const auto count = U32(bytes.data() + 8);
    if (!count || count > 64 || bytes.size() != kCellControllerPoolHeaderBytes + count * kCellControllerPoolMemberBytes) return ERROR_INVALID_DATA;
    CellControllerPoolHistory result;
    std::copy_n(bytes.begin() + 48, 32, result.snapshot_sha256.begin());
    if (!Nonzero(result.snapshot_sha256)) return ERROR_INVALID_DATA;
    bool found_current = false;
    for (std::size_t index = 0; index < count; ++index) {
      auto position = kCellControllerPoolHeaderBytes + index * kCellControllerPoolMemberBytes;
      std::array<std::uint8_t, kCellControllerRequestBytes> encoded{};
      std::copy_n(bytes.begin() + position, encoded.size(), encoded.begin()); position += encoded.size();
      // The retained container has no connection authority. Only the admitted
      // outer session supplies its nonce; a sender cannot choose one here.
      if (std::any_of(encoded.begin() + 8, encoded.begin() + 40, [](auto byte) { return byte != 0; })) return ERROR_INVALID_DATA;
      const auto retained_wall = U32(encoded.data() + 4);
      if (retained_wall < current.wall_ms || retained_wall > 60000) return ERROR_INVALID_DATA;
      Put32(encoded.data() + 4, current.wall_ms);
      std::copy(current.nonce.begin(), current.nonce.end(), encoded.begin() + 8);
      CellControllerRequest member;
      if (!DecodeCellControllerRequest(encoded, current.nonce, &member) || member.operation != current.operation ||
          member.wall_ms != current.wall_ms || member.parent != current.parent) return ERROR_INVALID_DATA;
      const auto read = [&](auto& records) { for (auto& record : records) {
        std::copy_n(bytes.begin() + position, record.size(), record.begin()); position += record.size();
      } };
      read(member.creation_records); read(member.volume_records); read(member.format_records);
      read(member.protection_records); read(member.mount_records); read(member.mounted_workspace_records);
      std::array<std::uint8_t, kCellControllerRequestBytes> verified{};
      if (!EncodeCellControllerRequest(member, &verified, owner_sid, controller_sid) || verified != encoded) return ERROR_INVALID_DATA;
      for (const auto& prior : result.members)
        if (prior.cell_name == member.cell_name || prior.anchor.file == member.anchor.file ||
            prior.plan.assignment_binding == member.plan.assignment_binding) return ERROR_INVALID_DATA;
      if (member.plan.assignment_binding == current.plan.assignment_binding) {
        if (found_current || encoded != expected || member.creation_records != current.creation_records ||
            member.volume_records != current.volume_records || member.format_records != current.format_records ||
            member.protection_records != current.protection_records || member.mount_records != current.mount_records ||
            member.mounted_workspace_records != current.mounted_workspace_records) return ERROR_INVALID_DATA;
        found_current = true;
      }
      result.members.push_back(std::move(member));
    }
    if (!found_current) return ERROR_INVALID_DATA;
    *output = std::move(result); return ERROR_SUCCESS;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
bool ValidateCellControllerVolumeHistory(const CellControllerRequest& request) noexcept {
  if (IsCellControllerCreation(request.operation) || !IsCellControllerVolume(request.operation)) return false;
  const auto& first = request.volume_records.front();
  CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
  disk.control = Identity(first.data() + 168); disk.backing = Identity(first.data() + 192);
  CellFileSha256 base{}; std::copy_n(first.begin() + 216, base.size(), base.begin());
  return !ValidateCellVolumeProvisioningPrefix(request.plan, request.anchor.file, disk, base, request.volume_records);
}
bool ValidateCellControllerFormatHistory(const CellControllerRequest& request) noexcept {
  if (IsCellControllerCreation(request.operation) || !IsCellControllerFormat(request.operation) || !ValidateCellControllerVolumeHistory(request)) return false;
  const auto& first = request.volume_records.front();
  CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
  disk.control = Identity(first.data() + 168); disk.backing = Identity(first.data() + 192);
  CellFileSha256 base{}; std::copy_n(first.begin() + 216, base.size(), base.begin());
  return !ValidateCellFormatProvisioningPrefix(request.plan, request.anchor.file, disk, base, request.volume_records, request.format_records);
}
bool ValidateCellControllerProtectionHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (IsCellControllerCreation(request.operation) || !IsCellControllerProtection(request.operation) || !ValidateCellControllerFormatHistory(request)) return false;
  const auto& first = request.volume_records.front();
  CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
  disk.control = Identity(first.data() + 168); disk.backing = Identity(first.data() + 192);
  CellFileSha256 base{}; std::copy_n(first.begin() + 216, base.size(), base.begin());
  return !ValidateCellProtectionProvisioningPrefix(request.plan, request.anchor.file, disk, base,
    owner_sid, controller_sid, request.volume_records, request.format_records, request.protection_records);
}
bool ValidateCellControllerMountHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (IsCellControllerCreation(request.operation) || !IsCellControllerMount(request.operation) || !ValidateCellControllerProtectionHistory(request, owner_sid, controller_sid)) return false;
  CellWorkspaceIdentities workspace; CellVirtualDiskRecord disk; CellFileSha256 base{};
  if (ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner_sid, controller_sid,
      request.anchor, request.creation_records, &workspace, &disk, &base)) return false;
  return !ValidateCellMountProvisioningPrefix(request.plan, request.anchor.file, workspace, disk, base,
    owner_sid, controller_sid, request.volume_records, request.format_records, request.protection_records, request.mount_records);
}
bool ValidateCellControllerMountedWorkspaceHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (IsCellControllerCreation(request.operation) || !IsCellControllerMountedWorkspace(request.operation) || !ValidateCellControllerMountHistory(request, owner_sid, controller_sid)) return false;
  CellWorkspaceIdentities workspace; CellVirtualDiskRecord disk; CellFileSha256 base{};
  if (ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner_sid, controller_sid,
      request.anchor, request.creation_records, &workspace, &disk, &base)) return false;
  return !ValidateCellMountedWorkspaceProvisioningPrefix(request.plan, request.anchor.file, workspace, disk, base,
    request.cell_name, owner_sid, controller_sid, request.volume_records, request.format_records, request.protection_records,
    request.mount_records, request.mounted_workspace_records);
}
DWORD DecodeCellControllerCleanupAdmission(const CellControllerRequest& request, CellRuntimeCleanupAdmission* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  if (!IsCellControllerCapacity(request.operation)) return ERROR_INVALID_DATA;
  const auto count = U32(request.cleanup_admission.data() + 72);
  if (count > 1) return ERROR_INVALID_DATA;
  const std::size_t size = 80 + 336 * count;
  if (std::any_of(request.cleanup_admission.begin() + size, request.cleanup_admission.end(), [](auto byte) { return byte != 0; })) return ERROR_INVALID_DATA;
  CellRuntimeCleanupAdmission value;
  auto error = DecodeCellRuntimeCleanupAdmission(std::span(request.cleanup_admission).first(size), &value);
  for (const auto& installation : value.installations) {
    CellRuntimeInstallRequest decoded;
    if (!error) error = DecodeCellRuntimeInstall(installation.bytes, installation.binding, &decoded);
    if (!error && (decoded.journal_identity != request.anchor.file || decoded.prepared_sha256 != request.anchor.prepared_sha256 ||
        !std::equal(decoded.checkpoint_sha256.begin(), decoded.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992))) error = ERROR_INVALID_DATA;
  }
  if (!error) *output = std::move(value);
  return error;
}
DWORD DecodeCellControllerCleanup(const CellControllerRequest& request, std::span<const std::uint8_t> bytes,
    const CellRuntimeCleanupBinding& expected, const std::wstring& owner_sid, const std::wstring& controller_sid,
    CellRuntimeCleanupSet* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    std::array<std::uint8_t, kCellControllerRequestBytes> encoded{};
    if ((!IsCellControllerCapacity(request.operation) && !IsCellControllerInstall(request.operation) && !IsCellControllerRuntime(request.operation)) ||
        !EncodeCellControllerRequest(request, &encoded, owner_sid, controller_sid)) return ERROR_INVALID_DATA;
    CellRuntimeCleanupSet value;
    auto error = DecodeCellRuntimeCleanup(bytes, expected, &value);
    if (error) return error;
    if (value.anchor != request.anchor || !std::equal(value.checkpoint_sha256.begin(), value.checkpoint_sha256.end(),
        request.mounted_workspace_records.back().begin() + 992)) return ERROR_INVALID_DATA;
    // Derive these identities from the validated outer history, including for
    // empty cleanup sets. No runtime entry exists to supply a cross-check then.
    CellMountedWorkspaceBinding binding;
    binding.cell_name = request.cell_name;
    const auto* mount = request.mount_records.back().data() + 280;
    std::copy_n(mount + 480, 32, binding.mount_sha256.begin());
    binding.volume_root = Identity(mount + 152);
    error = HashCellVolumeRootSecurity(owner_sid, controller_sid, &binding.security_sha256);
    if (error) return error;
    std::array<CellMountedWorkspaceCheckpoint, 2> records{};
    for (std::size_t index = 0; index < records.size(); ++index)
      std::copy_n(request.mounted_workspace_records[index].begin() + 280, records[index].size(), records[index].begin());
    CellWorkspaceIdentities workspace;
    error = DecodeCellMountedWorkspaceCheckpoints(binding, records, &workspace);
    if (error) return error;
    if (value.workspace != workspace) return ERROR_INVALID_DATA;
    *output = std::move(value); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
bool EncodeCellControllerCapacity(const CellControllerNonce& nonce, const CellProvisioningFootprint& value, CellControllerCapacityBytes* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!Nonzero(nonce) || !ValidCapacity(value)) return false;
  CellControllerCapacityBytes bytes{};
  const auto put64 = [&](std::size_t offset, std::uint64_t number) {
    for (unsigned i = 0; i < 8; ++i) bytes[offset + i] = static_cast<std::uint8_t>(number >> (8 * i));
  };
  const auto putIdentity = [&](std::size_t offset, const CellFileIdentity& identity) {
    put64(offset, identity.volume_serial); std::copy(identity.file_id.begin(), identity.file_id.end(), bytes.begin() + offset + 8);
  };
  std::copy(nonce.begin(), nonce.end(), bytes.begin()); putIdentity(32, value.anchor.file);
  std::copy(value.anchor.prepared_sha256.begin(), value.anchor.prepared_sha256.end(), bytes.begin() + 56);
  std::copy(value.assignment_binding.begin(), value.assignment_binding.end(), bytes.begin() + 88);
  std::copy(value.profile_sha256.begin(), value.profile_sha256.end(), bytes.begin() + 120);
  std::copy(value.checkpoint_sha256.begin(), value.checkpoint_sha256.end(), bytes.begin() + 152);
  putIdentity(184, value.workspace.parent);
  for (std::size_t index = 0; index < value.workspace.directories.size(); ++index) putIdentity(208 + 24 * index, value.workspace.directories[index]);
  putIdentity(304, value.footprint.root); put64(328, value.footprint.logical_file_bytes); put64(336, value.footprint.allocated_bytes);
  Put32(bytes.data() + 344, value.footprint.file_count); Put32(bytes.data() + 348, value.footprint.directory_count);
  *output = bytes; return true;
}
bool DecodeCellControllerCapacity(const CellControllerNonce& nonce, const CellControllerCapacityBytes& bytes, CellProvisioningFootprint* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!Nonzero(nonce) || !std::equal(nonce.begin(), nonce.end(), bytes.begin())) return false;
  CellProvisioningFootprint value;
  value.anchor.file = Identity(bytes.data() + 32);
  std::copy_n(bytes.begin() + 56, 32, value.anchor.prepared_sha256.begin());
  std::copy_n(bytes.begin() + 88, 32, value.assignment_binding.begin());
  std::copy_n(bytes.begin() + 120, 32, value.profile_sha256.begin());
  std::copy_n(bytes.begin() + 152, 32, value.checkpoint_sha256.begin());
  value.workspace.parent = Identity(bytes.data() + 184);
  for (std::size_t index = 0; index < value.workspace.directories.size(); ++index) value.workspace.directories[index] = Identity(bytes.data() + 208 + 24 * index);
  value.footprint = {Identity(bytes.data() + 304), U64(bytes.data() + 328), U64(bytes.data() + 336), U32(bytes.data() + 344), U32(bytes.data() + 348)};
  if (!ValidCapacity(value)) return false;
  *output = value; return true;
}
bool MatchesCellControllerCapacity(const CellControllerRequest& request, const CellProvisioningFootprint& value,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  try {
    std::array<std::uint8_t, kCellControllerRequestBytes> encoded{};
    if (request.operation != kCellControllerCapacityOperation || !ValidCapacity(value) ||
        !EncodeCellControllerRequest(request, &encoded, owner_sid, controller_sid) || request.anchor != value.anchor ||
        request.plan.assignment_binding != value.assignment_binding || request.plan.profile_sha256 != value.profile_sha256 ||
        !std::equal(value.checkpoint_sha256.begin(), value.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992)) return false;
    // The full outer history was validated above. Derive the native workspace
    // identities from its mount binding, never from the returned observation.
    CellMountedWorkspaceBinding binding;
    binding.cell_name = request.cell_name;
    const auto* mount = request.mount_records.back().data() + 280;
    std::copy_n(mount + 480, 32, binding.mount_sha256.begin());
    binding.volume_root = Identity(mount + 152);
    if (HashCellVolumeRootSecurity(owner_sid, controller_sid, &binding.security_sha256)) return false;
    std::array<CellMountedWorkspaceCheckpoint, 2> records{};
    for (std::size_t index = 0; index < records.size(); ++index)
      std::copy_n(request.mounted_workspace_records[index].begin() + 280, records[index].size(), records[index].begin());
    CellWorkspaceIdentities workspace;
    return !DecodeCellMountedWorkspaceCheckpoints(binding, records, &workspace) && value.workspace == workspace;
  } catch (...) { return false; }
}
bool EncodeCellControllerBackingCapacity(const CellControllerNonce& nonce, const CellProvisioningBackingFootprint& value,
  CellControllerBackingCapacityBytes* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!Nonzero(nonce) || !ValidBackingCapacity(value)) return false;
  CellControllerBackingCapacityBytes bytes{};
  const auto put64 = [&](std::size_t offset, std::uint64_t number) {
    for (unsigned i = 0; i < 8; ++i) bytes[offset + i] = static_cast<std::uint8_t>(number >> (8 * i));
  };
  const auto putIdentity = [&](std::size_t offset, const CellFileIdentity& identity) {
    put64(offset, identity.volume_serial); std::copy(identity.file_id.begin(), identity.file_id.end(), bytes.begin() + offset + 8);
  };
  std::copy(nonce.begin(), nonce.end(), bytes.begin()); putIdentity(32, value.anchor.file);
  std::copy(value.anchor.prepared_sha256.begin(), value.anchor.prepared_sha256.end(), bytes.begin() + 56);
  std::copy(value.assignment_binding.begin(), value.assignment_binding.end(), bytes.begin() + 88);
  std::copy(value.profile_sha256.begin(), value.profile_sha256.end(), bytes.begin() + 120);
  std::copy(value.checkpoint_sha256.begin(), value.checkpoint_sha256.end(), bytes.begin() + 152);
  putIdentity(184, value.workspace.parent);
  for (std::size_t index = 0; index < value.workspace.directories.size(); ++index) putIdentity(208 + index * 24, value.workspace.directories[index]);
  std::memcpy(bytes.data() + 304, &value.backing.record.spec.identifier, 16);
  put64(320, value.backing.record.spec.virtual_bytes); put64(328, value.backing.record.spec.reserved_file_bytes);
  putIdentity(336, value.backing.record.control); putIdentity(360, value.backing.record.backing);
  put64(384, value.backing.file_bytes); put64(392, value.backing.allocated_bytes); put64(400, value.journal_bytes);
  put64(408, value.journal_allocated_bytes); put64(416, value.host_file_allocated_bytes);
  *output = bytes; return true;
}
bool DecodeCellControllerBackingCapacity(const CellControllerNonce& nonce, const CellControllerBackingCapacityBytes& bytes,
  CellProvisioningBackingFootprint* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!Nonzero(nonce) || !std::equal(nonce.begin(), nonce.end(), bytes.begin())) return false;
  CellProvisioningBackingFootprint value;
  value.anchor.file = Identity(bytes.data() + 32);
  std::copy_n(bytes.begin() + 56, 32, value.anchor.prepared_sha256.begin());
  std::copy_n(bytes.begin() + 88, 32, value.assignment_binding.begin());
  std::copy_n(bytes.begin() + 120, 32, value.profile_sha256.begin());
  std::copy_n(bytes.begin() + 152, 32, value.checkpoint_sha256.begin());
  value.workspace.parent = Identity(bytes.data() + 184);
  for (std::size_t index = 0; index < value.workspace.directories.size(); ++index) value.workspace.directories[index] = Identity(bytes.data() + 208 + index * 24);
  std::memcpy(&value.backing.record.spec.identifier, bytes.data() + 304, 16);
  value.backing.record.spec.virtual_bytes = U64(bytes.data() + 320); value.backing.record.spec.reserved_file_bytes = U64(bytes.data() + 328);
  value.backing.record.control = Identity(bytes.data() + 336); value.backing.record.backing = Identity(bytes.data() + 360);
  value.backing.file_bytes = U64(bytes.data() + 384); value.backing.allocated_bytes = U64(bytes.data() + 392);
  value.journal_bytes = U64(bytes.data() + 400); value.journal_allocated_bytes = U64(bytes.data() + 408); value.host_file_allocated_bytes = U64(bytes.data() + 416);
  if (!ValidBackingCapacity(value)) return false;
  *output = value; return true;
}
bool MatchesCellControllerBackingCapacity(const CellControllerRequest& request, const CellProvisioningBackingFootprint& value,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  try {
    std::array<std::uint8_t, kCellControllerRequestBytes> encoded{};
    if (!IsCellControllerBackingCapacity(request.operation) || !ValidBackingCapacity(value) ||
        !EncodeCellControllerRequest(request, &encoded, owner_sid, controller_sid) || request.anchor != value.anchor ||
        request.plan.assignment_binding != value.assignment_binding || request.plan.profile_sha256 != value.profile_sha256 ||
        !std::equal(value.checkpoint_sha256.begin(), value.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992)) return false;
    CellWorkspaceIdentities workspace; CellVirtualDiskRecord disk; CellFileSha256 head{};
    const std::vector<CellProvisioningRecord> records(request.creation_records.begin(), request.creation_records.end());
    return !ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner_sid, controller_sid,
      request.anchor, records, &workspace, &disk, &head) && workspace == value.workspace && disk.control == value.backing.record.control &&
      disk.backing == value.backing.record.backing && IsEqualGUID(disk.spec.identifier, value.backing.record.spec.identifier) &&
      disk.spec.virtual_bytes == value.backing.record.spec.virtual_bytes && disk.spec.reserved_file_bytes == value.backing.record.spec.reserved_file_bytes;
  } catch (...) { return false; }
}
bool ValidateCellControllerInventory(const CellProvisioningInventory& value) noexcept {
  const auto& inventory = value.inventory;
  const auto& footprint = inventory.footprint;
  if (!ValidCapacity({value.anchor, value.assignment_binding, value.profile_sha256, value.checkpoint_sha256,
      value.workspace, footprint}) || inventory.entries.size() != static_cast<std::uint64_t>(footprint.file_count) + footprint.directory_count)
    return false;
  std::uint64_t logical = 0, allocated = 0;
  std::uint32_t files = 0, directories = 0;
  std::array<bool, 4> roots{};
  const CellDirectoryInventoryEntry* previous = nullptr;
  for (const auto& entry : inventory.entries) {
    if (!ValidIdentity(entry.identity) || entry.identity.volume_serial != footprint.root.volume_serial ||
        (previous && !(previous->identity.file_id < entry.identity.file_id)) || (entry.directory && entry.logical_file_bytes) ||
        entry.logical_file_bytes > 9007199254740991ULL - logical || entry.allocated_bytes > 9007199254740991ULL - allocated) return false;
    logical += entry.logical_file_bytes; allocated += entry.allocated_bytes;
    if (entry.directory) {
      ++directories;
      for (std::size_t index = 0; index < roots.size(); ++index)
        if (entry.identity == value.workspace.directories[index]) roots[index] = true;
    } else ++files;
    previous = &entry;
  }
  return files == footprint.file_count && directories == footprint.directory_count && logical == footprint.logical_file_bytes &&
    allocated == footprint.allocated_bytes && std::all_of(roots.begin(), roots.end(), [](bool present) { return present; });
}
bool MatchesCellControllerInventory(const CellControllerRequest& request, const CellProvisioningInventory& value,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (!IsCellControllerInventory(request.operation) || !ValidateCellControllerInventory(value)) return false;
  try {
    auto summary_request = request; summary_request.operation = kCellControllerCapacityOperation;
    return MatchesCellControllerCapacity(summary_request, {value.anchor, value.assignment_binding, value.profile_sha256,
      value.checkpoint_sha256, value.workspace, value.inventory.footprint}, owner_sid, controller_sid);
  } catch (...) { return false; }
}
bool EncodeCellControllerInventoryChunk(const CellControllerNonce& nonce, std::uint32_t start,
  std::span<const CellDirectoryInventoryEntry> entries, CellControllerInventoryChunkBytes* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!Nonzero(nonce) || entries.empty() || entries.size() > kCellControllerInventoryChunkEntries ||
      start >= 20000 || entries.size() > 20000 - start) return false;
  CellControllerInventoryChunkBytes bytes{};
  std::copy(nonce.begin(), nonce.end(), bytes.begin()); Put32(bytes.data() + 32, start);
  Put32(bytes.data() + 36, static_cast<std::uint32_t>(entries.size()));
  const auto put64 = [&](std::size_t offset, std::uint64_t number) {
    for (unsigned index = 0; index < 8; ++index) bytes[offset + index] = static_cast<std::uint8_t>(number >> (8 * index));
  };
  for (std::size_t index = 0; index < entries.size(); ++index) {
    const auto& entry = entries[index]; const auto offset = 40 + index * 48;
    if (!ValidIdentity(entry.identity) || (entry.directory && entry.logical_file_bytes) ||
        entry.logical_file_bytes > 9007199254740991ULL || entry.allocated_bytes > 9007199254740991ULL) return false;
    put64(offset, entry.identity.volume_serial);
    std::copy(entry.identity.file_id.begin(), entry.identity.file_id.end(), bytes.begin() + offset + 8);
    Put32(bytes.data() + offset + 24, entry.directory ? 1 : 0);
    put64(offset + 32, entry.logical_file_bytes); put64(offset + 40, entry.allocated_bytes);
  }
  *output = bytes; return true;
}
bool DecodeCellControllerInventoryChunk(const CellControllerNonce& nonce, const CellControllerInventoryChunkBytes& bytes,
  CellControllerInventoryChunk* output) noexcept {
  if (!output) return false;
  *output = {};
  if (!Nonzero(nonce) || !std::equal(nonce.begin(), nonce.end(), bytes.begin())) return false;
  CellControllerInventoryChunk value; value.start = U32(bytes.data() + 32); value.count = U32(bytes.data() + 36);
  if (!value.count || value.count > kCellControllerInventoryChunkEntries || value.start >= 20000 || value.count > 20000 - value.start)
    return false;
  for (std::size_t index = 0; index < value.count; ++index) {
    const auto offset = 40 + index * 48;
    if (U32(bytes.data() + offset + 24) > 1) return false;
    value.entries[index] = {Identity(bytes.data() + offset), U32(bytes.data() + offset + 24) == 1,
      U64(bytes.data() + offset + 32), U64(bytes.data() + offset + 40)};
  }
  CellControllerInventoryChunkBytes canonical{};
  if (!EncodeCellControllerInventoryChunk(nonce, value.start, std::span(value.entries).first(value.count), &canonical) || canonical != bytes)
    return false;
  *output = value; return true;
}
DWORD ReadCellControllerReply(HANDLE pipe, CellControllerMessage* kind, std::array<std::uint8_t, 1056>* bytes,
  HANDLE stop, ULONGLONG deadline) noexcept {
  if (!kind || !bytes) return ERROR_INVALID_PARAMETER;
  *kind = static_cast<CellControllerMessage>(0); *bytes = {};
  std::array<std::uint8_t, 16> header{};
  DWORD error = ReadCellPipe(pipe, header.data(), static_cast<DWORD>(header.size()), stop, deadline);
  const auto received = static_cast<CellControllerMessage>(U32(header.data() + 8));
  const auto count = U32(header.data() + 12);
  if (!error && (std::memcmp(header.data(), "GCCELL01", 8) ||
      (received != CellControllerMessage::checkpoint && received != CellControllerMessage::receipt && received != CellControllerMessage::volume_authority &&
       received != CellControllerMessage::capacity_observation && received != CellControllerMessage::backing_capacity_observation &&
       received != CellControllerMessage::inventory_observation && received != CellControllerMessage::inventory_chunk &&
       received != CellControllerMessage::runtime_authority && received != CellControllerMessage::runtime_ready && received != CellControllerMessage::cleanup_ready &&
       received != CellControllerMessage::install_authority && received != CellControllerMessage::install_outcome &&
       received != CellControllerMessage::install_capacity_capture && received != CellControllerMessage::install_capacity_authority &&
       received != CellControllerMessage::pool_capacity_ready) || !Known(received, count)))
    error = ERROR_INVALID_DATA;
  if (!error) error = ReadCellPipe(pipe, bytes->data(), count, stop, deadline);
  if (error) { *bytes = {}; return error; }
  *kind = received; return ERROR_SUCCESS;
}
DWORD ReadCellControllerMessage(HANDLE pipe, CellControllerMessage kind, void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline) noexcept {
  if (!bytes || !Known(kind, count)) return ERROR_INVALID_PARAMETER;
  std::array<std::uint8_t, 16> header{};
  DWORD error = ReadCellPipe(pipe, header.data(), static_cast<DWORD>(header.size()), stop, deadline);
  if (!error && (std::memcmp(header.data(), "GCCELL01", 8) || U32(header.data() + 8) != static_cast<std::uint32_t>(kind) ||
      U32(header.data() + 12) != count)) error = ERROR_INVALID_DATA;
  return error ? error : ReadCellPipe(pipe, bytes, count, stop, deadline);
}
DWORD WriteCellControllerMessage(HANDLE pipe, CellControllerMessage kind, const void* bytes, DWORD count, HANDLE stop, ULONGLONG deadline) noexcept {
  if (!bytes || !Known(kind, count)) return ERROR_INVALID_PARAMETER;
  std::array<std::uint8_t, 16> header{}; std::memcpy(header.data(), "GCCELL01", 8);
  Put32(header.data() + 8, static_cast<std::uint32_t>(kind)); Put32(header.data() + 12, count);
  const DWORD error = WriteCellPipe(pipe, header.data(), static_cast<DWORD>(header.size()), stop, deadline);
  return error ? error : WriteCellPipe(pipe, bytes, count, stop, deadline);
}
CellControllerSessionResult RunCellControllerSession(HANDLE pipe, HANDLE stop, const CellControllerSessionOwner& input_owner) noexcept {
  CellControllerSessionResult result;
  try {
    const auto owner = input_owner;
    if (!owner.authorize || !owner.arm_watchdog || !IsLiteralCellPath(owner.parent_path) || !ValidIdentity(owner.parent)) return result;
    Session session{pipe, stop, owner, GetTickCount64() + 5000, {}, result};
    owner.arm_watchdog(owner.context, session.deadline + 2000);
    std::array<std::uint8_t, 32> hello{};
    result.error = ReadCellControllerMessage(pipe, CellControllerMessage::hello, hello.data(), static_cast<DWORD>(hello.size()), stop, session.deadline);
    if (!result.error && !Nonzero(hello)) result.error = ERROR_INVALID_DATA;
    if (!result.error) result.error = session.Authorize(true);
    if (!result.error && (BCryptGenRandom(nullptr, session.nonce.data(), static_cast<ULONG>(session.nonce.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 ||
        !Nonzero(session.nonce))) result.error = ERROR_GEN_FAILURE;
    if (result.error) return result;
    std::array<std::uint8_t, 64> welcome{};
    std::copy(hello.begin(), hello.end(), welcome.begin()); std::copy(session.nonce.begin(), session.nonce.end(), welcome.begin() + 32);
    result.error = WriteCellControllerMessage(pipe, CellControllerMessage::welcome, welcome.data(), static_cast<DWORD>(welcome.size()), stop, session.deadline);
    std::array<std::uint8_t, kCellControllerRequestBytes> bytes{}; CellControllerRequest request;
    if (!result.error) result.error = ReadCellControllerMessage(pipe, CellControllerMessage::request, bytes.data(), static_cast<DWORD>(bytes.size()), stop, session.deadline);
    if (!result.error) result.error = session.Authorize();
    if (!result.error && (!DecodeCellControllerRequest(bytes, session.nonce, &request) || request.parent != owner.parent)) result.error = ERROR_INVALID_DATA;
    if (result.error) return result;
    session.deadline = GetTickCount64() + request.wall_ms; owner.arm_watchdog(owner.context, session.deadline + 2000);
    session.runtime = IsCellControllerRuntime(request.operation);
    session.volume = IsCellControllerVolume(request.operation);
    session.format = IsCellControllerFormat(request.operation);
    session.protection = IsCellControllerProtection(request.operation);
    session.mount = IsCellControllerMount(request.operation);
    session.mounted_workspace = IsCellControllerMountedWorkspace(request.operation);
    session.capacity = IsCellControllerCapacity(request.operation);
    if (IsCellControllerCreation(request.operation) && session.volume &&
        (!owner.provision_volume || (session.format && !owner.provision_format) ||
         (session.protection && !owner.provision_protection) || (session.mount && !owner.provision_mount) ||
         (session.mounted_workspace && !owner.provision_mounted_workspace))) { result.error = ERROR_NOT_SUPPORTED; return result; }
    if (!IsCellControllerCreation(request.operation) && session.volume) {
      std::array<std::uint8_t, kCellControllerVolumeHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::volume_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.volume_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.volume_records[i].begin());
      if (!result.error && !ValidateCellControllerVolumeHistory(request)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (!IsCellControllerCreation(request.operation) && session.format) {
      std::array<std::uint8_t, kCellControllerFormatHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::format_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.format_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.format_records[i].begin());
      if (!result.error && !ValidateCellControllerFormatHistory(request)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (!IsCellControllerCreation(request.operation) && session.protection) {
      std::array<std::uint8_t, kCellControllerProtectionHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::protection_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.protection_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.protection_records[i].begin());
      if (!result.error && !ValidateCellControllerProtectionHistory(request, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (!IsCellControllerCreation(request.operation) && session.mount) {
      std::array<std::uint8_t, kCellControllerMountHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::mount_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) {
        for (std::size_t i = 0; i < request.creation_records.size(); ++i)
          std::copy_n(history.begin() + 32 + i * 1024, 1024, request.creation_records[i].begin());
        for (std::size_t i = 0; i < request.mount_records.size(); ++i)
          std::copy_n(history.begin() + 32 + (5 + i) * 1024, 1024, request.mount_records[i].begin());
      }
      if (!result.error && !ValidateCellControllerMountHistory(request, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (!IsCellControllerCreation(request.operation) && session.mounted_workspace) {
      std::array<std::uint8_t, kCellControllerMountedWorkspaceHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::mounted_workspace_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.mounted_workspace_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.mounted_workspace_records[i].begin());
      if (!result.error && !ValidateCellControllerMountedWorkspaceHistory(request, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (IsCellControllerInstall(request.operation)) {
      CellControllerRuntimeBindingBytes binding{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::install_binding, binding.data(), static_cast<DWORD>(binding.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !DecodeCellControllerRuntimeBinding(session.nonce, binding, &request.installation)) result.error = ERROR_INVALID_DATA;
      if (!result.error) result.error = ReadCellControllerMessage(pipe, CellControllerMessage::install_request, request.installation_bytes.data(),
        static_cast<DWORD>(request.installation_bytes.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !ValidateCellControllerInstallRequest(request)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
      session.installation = request.installation;
    }
    CellRuntimeCleanupAdmission cleanup_admission;
    if (session.capacity) {
      std::array<std::uint8_t, 32 + kCellControllerPoolHeaderBytes> pool_header{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_history_header, pool_header.data(), static_cast<DWORD>(pool_header.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      const auto count = U32(pool_header.data() + 40);
      if (!result.error && (!std::equal(session.nonce.begin(), session.nonce.end(), pool_header.begin()) || !count || count > 64)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
      request.pool_history.assign(pool_header.begin() + 32, pool_header.end());
      for (std::size_t index = 0; index < count && !result.error; ++index) {
        std::array<std::uint8_t, 32 + kCellControllerPoolMemberFirstBytes> member{};
        result.error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_history_member, member.data(), static_cast<DWORD>(member.size()), stop, session.IoDeadline());
        if (!result.error) result.error = session.Authorize();
        if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), member.begin())) result.error = ERROR_INVALID_DATA;
        if (!result.error) request.pool_history.insert(request.pool_history.end(), member.begin() + 32, member.end());
        std::array<std::uint8_t, 32 + kCellControllerPoolMemberBytes - kCellControllerPoolMemberFirstBytes> tail{};
        if (!result.error) result.error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_history_member_tail, tail.data(), static_cast<DWORD>(tail.size()), stop, session.IoDeadline());
        if (!result.error) result.error = session.Authorize();
        if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), tail.begin())) result.error = ERROR_INVALID_DATA;
        if (!result.error) request.pool_history.insert(request.pool_history.end(), tail.begin() + 32, tail.end());
      }
      CellControllerPoolHistory pool;
      if (!result.error) result.error = DecodeCellControllerPoolHistory(request.pool_history, request, owner.owner_sid, owner.controller_sid, &pool);
      if (result.error) return result;
      std::array<std::uint8_t, 448> admission{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::cleanup_admission, admission.data(), static_cast<DWORD>(admission.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), admission.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) {
        std::copy_n(admission.begin() + 32, request.cleanup_admission.size(), request.cleanup_admission.begin());
        result.error = DecodeCellControllerCleanupAdmission(request, &cleanup_admission);
      }
      if (result.error) return result;
      std::array<std::uint8_t, 36> cleanup_size{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_cleanup_size, cleanup_size.data(), static_cast<DWORD>(cleanup_size.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      const auto cleanup_bytes = U32(cleanup_size.data() + 32);
      if (!result.error && (!std::equal(session.nonce.begin(), session.nonce.end(), cleanup_size.begin()) ||
          cleanup_bytes < kCellRuntimePoolCleanupHeaderBytes || cleanup_bytes > kMaximumCellRuntimePoolCleanupBytes)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
      request.pool_cleanup.reserve(cleanup_bytes);
      for (std::size_t offset = 0; offset < cleanup_bytes; offset += 4096) {
        const auto chunk_bytes = std::min<std::size_t>(4096, cleanup_bytes - offset);
        std::vector<std::uint8_t> chunk(36 + chunk_bytes);
        result.error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_cleanup_chunk, chunk.data(), static_cast<DWORD>(chunk.size()), stop, session.IoDeadline());
        if (!result.error) result.error = session.Authorize();
        if (!result.error && (!std::equal(session.nonce.begin(), session.nonce.end(), chunk.begin()) || U32(chunk.data() + 32) != offset)) result.error = ERROR_INVALID_DATA;
        if (result.error) return result;
        request.pool_cleanup.insert(request.pool_cleanup.end(), chunk.begin() + 36, chunk.end());
      }
      CellRuntimePoolCleanupSet decoded_cleanup;
      result.error = DecodeCellRuntimePoolCleanup(request.pool_cleanup, request, owner.owner_sid, owner.controller_sid, &decoded_cleanup);
      if (result.error) return result;
      if (IsCellControllerPoolCapacity(request.operation)) {
        std::array<std::uint8_t, 64> binding{};
        result.error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_capture_binding, binding.data(), 64, stop, session.IoDeadline());
        if (!result.error) result.error = session.Authorize();
        if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), binding.begin())) result.error = ERROR_INVALID_DATA;
        std::copy_n(binding.begin() + 32, 32, request.capture_nonce.begin());
        if (!result.error && !Nonzero(request.capture_nonce)) result.error = ERROR_INVALID_DATA;
        if (!result.error && IsCellControllerInstallCapacity(request.operation)) {
          result.error = ReadCellControllerMessage(pipe, CellControllerMessage::controller_attestation_context,
            binding.data(), 64, stop, session.IoDeadline());
          if (!result.error) result.error = session.Authorize();
          if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), binding.begin())) result.error = ERROR_INVALID_DATA;
          std::copy_n(binding.begin() + 32, 32, request.references_sha256.begin());
          if (!result.error && !Nonzero(request.references_sha256)) result.error = ERROR_INVALID_DATA;
        }
        if (result.error) return result;
      }
    }
    Parent parent;
    if (IsCellControllerRuntime(request.operation)) {
      CellControllerRuntimeBindingBytes binding{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::runtime_binding, binding.data(), static_cast<DWORD>(binding.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error && (!DecodeCellControllerRuntimeBinding(session.nonce, binding, &request.runtime) ||
          !std::equal(request.runtime.checkpoint_sha256.begin(), request.runtime.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992))) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (request.operation == kCellControllerInstallOperation && (!owner.install_runtime || !owner.begin_measurement)) result.error = ERROR_NOT_SUPPORTED;
    else if (IsCellControllerInstallCapacity(request.operation) && (!owner.install_runtime_capacity || !owner.begin_measurement)) result.error = ERROR_NOT_SUPPORTED;
    else if (IsCellControllerRuntime(request.operation) && !owner.run_runtime) result.error = ERROR_NOT_SUPPORTED;
    else if (session.capacity && !IsCellControllerInstallCapacity(request.operation) && (!owner.begin_measurement || (IsCellControllerPoolCapacity(request.operation) ? !owner.observe_pool_capacity : IsCellControllerInventory(request.operation) ? !owner.observe_inventory :
        IsCellControllerBackingCapacity(request.operation) ? !owner.observe_backing_capacity : !owner.observe_capacity))) result.error = ERROR_NOT_SUPPORTED;
    else {
      // Installation mutates the same retained pool that capacity scans cover.
      // Hold actual writer exclusion before opening its journal, through local
      // outcome retention and the terminal receipt. This is not admission or
      // a capacity reservation; fresh installation authority remains required.
      if (request.operation == kCellControllerInstallOperation || IsCellControllerInstallCapacity(request.operation)) {
        result.error = owner.begin_measurement(owner.context, request, stop, session.deadline, &session.measurement);
        if (!result.error && !session.measurement) result.error = ERROR_INVALID_STATE;
        if (!result.error) result.error = session.Authorize();
      }
      if (!result.error) {
        parent.value = CreateFileW(owner.parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        result.error = parent.value == INVALID_HANDLE_VALUE ? GetLastError() : session.Authorize();
      }
    }
    CellProvisioningJournal journal;
    if (!result.error && IsCellControllerCreation(request.operation)) {
      CellProvisioningCommitter committer{Session::Commit, &session}; CellProvisioningAnchor anchor;
      result.creation_attempted = true;
      result.error = journal.Create(parent.value, owner.parent, request.cell_name, owner.owner_sid, owner.controller_sid, request.plan, &anchor, &committer);
      if (!result.error) result.error = session.Authorize();
      if (!result.error) result.error = journal.ProvisionWorkspace(anchor);
      if (!result.error) result.error = session.Authorize();
      if (!result.error) {
        const auto now = GetTickCount64();
        result.error = now >= session.deadline ? ERROR_TIMEOUT :
          journal.ProvisionDisk(anchor, static_cast<DWORD>(session.deadline - now), stop);
      }
      if (!result.error && session.volume) {
        const CellVolumeProvisioningCommitter volume_committer{Session::Commit, Session::AuthorizeVolume, &session};
        result.error = Session::AuthorizeVolume(&session);
        const auto now = GetTickCount64();
        if (!result.error) result.error = now >= session.deadline ? ERROR_TIMEOUT :
          owner.provision_volume(owner.context, journal, anchor, volume_committer, static_cast<DWORD>(session.deadline - now), stop);
        if (!result.error && (journal.VolumePhase() != CellVolumeProvisioningPhase::partitioned || result.checkpoints != 11)) result.error = ERROR_IO_INCOMPLETE;
        if (!result.error) result.error = Session::AuthorizeVolume(&session);
      }
      if (!result.error && session.format) {
        const CellFormatProvisioningCommitter format_committer{Session::Commit, Session::AuthorizeVolume, &session};
        result.error = Session::AuthorizeVolume(&session);
        const auto now = GetTickCount64();
        if (!result.error) result.error = now >= session.deadline ? ERROR_TIMEOUT :
          owner.provision_format(owner.context, journal, anchor, format_committer, static_cast<DWORD>(session.deadline - now), stop);
        if (!result.error && (journal.FormatPhase() != CellFormatProvisioningPhase::formatted || result.checkpoints != 13)) result.error = ERROR_IO_INCOMPLETE;
        if (!result.error) result.error = Session::AuthorizeVolume(&session);
      }
      if (!result.error && session.protection) {
        const CellProtectionProvisioningCommitter protection_committer{Session::Commit, Session::AuthorizeVolume, &session};
        result.error = Session::AuthorizeVolume(&session);
        const auto now = GetTickCount64();
        if (!result.error) result.error = now >= session.deadline ? ERROR_TIMEOUT :
          owner.provision_protection(owner.context, journal, anchor, protection_committer, static_cast<DWORD>(session.deadline - now), stop);
        if (!result.error && (journal.ProtectionPhase() != CellProtectionProvisioningPhase::protected_root || result.checkpoints != 15)) result.error = ERROR_IO_INCOMPLETE;
        // The journal's final authorization is followed by native verification.
        // Do not insert another blocking authority exchange after that readback.
      }
      if (!result.error && session.mount) {
        const CellMountProvisioningCommitter mount_committer{Session::Commit, Session::AuthorizeVolume, &session};
        result.error = Session::AuthorizeVolume(&session);
        const auto now = GetTickCount64();
        if (!result.error) result.error = now >= session.deadline ? ERROR_TIMEOUT :
          owner.provision_mount(owner.context, journal, anchor, mount_committer, static_cast<DWORD>(session.deadline - now), stop);
        if (!result.error && (journal.MountPhase() != CellMountProvisioningPhase::mounted || result.checkpoints != 19)) result.error = ERROR_IO_INCOMPLETE;
      }
      if (!result.error && session.mounted_workspace) {
        const CellMountedWorkspaceProvisioningCommitter workspace_committer{Session::Commit, Session::AuthorizeVolume, &session};
        result.error = Session::AuthorizeVolume(&session);
        const auto now = GetTickCount64();
        if (!result.error) result.error = now >= session.deadline ? ERROR_TIMEOUT :
          owner.provision_mounted_workspace(owner.context, journal, anchor, workspace_committer, static_cast<DWORD>(session.deadline - now), stop);
        if (!result.error && (journal.MountedWorkspacePhase() != CellMountedWorkspaceProvisioningPhase::recorded || result.checkpoints != 21)) result.error = ERROR_IO_INCOMPLETE;
      }
    } else if (!result.error) {
      const auto volume_history = session.volume ? std::span<const CellVolumeProvisioningRecord>(request.volume_records) : std::span<const CellVolumeProvisioningRecord>{};
      const auto format_history = session.format ? std::span<const CellFormatProvisioningRecord>(request.format_records) : std::span<const CellFormatProvisioningRecord>{};
      const auto protection_history = session.protection ? std::span<const CellProtectionProvisioningRecord>(request.protection_records) : std::span<const CellProtectionProvisioningRecord>{};
      const auto mount_history = session.mount ? std::span<const CellMountProvisioningRecord>(request.mount_records) : std::span<const CellMountProvisioningRecord>{};
      const auto workspace_history = session.mounted_workspace ? std::span<const CellMountedWorkspaceProvisioningRecord>(request.mounted_workspace_records) : std::span<const CellMountedWorkspaceProvisioningRecord>{};
      result.error = journal.OpenRecorded(parent.value, owner.parent, request.cell_name, owner.owner_sid, owner.controller_sid, request.plan, request.anchor, volume_history, format_history, protection_history, mount_history, workspace_history);
      std::vector<CellProvisioningRecord> records;
      if (!result.error) result.error = journal.RecordCheckpoints(&records);
      if (!result.error && session.mount && (records.size() != request.creation_records.size() ||
          !std::equal(records.begin(), records.end(), request.creation_records.begin()))) result.error = ERROR_CRC;
      if (!result.error) for (const auto& record : records) { result.error = session.Record(record, false); if (result.error) break; }
      if (!result.error && session.volume) {
        std::vector<CellVolumeProvisioningRecord> volume_records;
        result.error = journal.RecordVolumeCheckpoints(&volume_records);
        if (!result.error) for (const auto& record : volume_records) { result.error = session.Record(record, false); if (result.error) break; }
      }
      if (!result.error && session.format) {
        std::vector<CellFormatProvisioningRecord> format_records;
        result.error = journal.RecordFormatCheckpoints(&format_records);
        if (!result.error) for (const auto& record : format_records) { result.error = session.Record(record, false); if (result.error) break; }
      }
      if (!result.error && session.protection) {
        std::vector<CellProtectionProvisioningRecord> protection_records;
        result.error = journal.RecordProtectionCheckpoints(&protection_records);
        if (!result.error) for (const auto& record : protection_records) { result.error = session.Record(record, false); if (result.error) break; }
      }
      if (!result.error && session.mount) {
        std::vector<CellMountProvisioningRecord> mount_records;
        result.error = journal.RecordMountCheckpoints(&mount_records);
        if (!result.error) for (const auto& record : mount_records) { result.error = session.Record(record, false); if (result.error) break; }
      }
      if (!result.error && session.mounted_workspace) {
        std::vector<CellMountedWorkspaceProvisioningRecord> workspace_records;
        result.error = journal.RecordMountedWorkspaceCheckpoints(&workspace_records);
        if (!result.error) for (const auto& record : workspace_records) { result.error = session.Record(record, false); if (result.error) break; }
      }
    }
    if (!result.error && IsCellControllerRuntime(request.operation)) {
      if (result.checkpoints != 21 || session.retained_head != request.runtime.checkpoint_sha256) result.error = ERROR_CRC;
      if (!result.error) result.error = Session::AuthorizeVolume(&session);
      CellControllerRuntimeBindingBytes ready{};
      if (!result.error && !EncodeCellControllerRuntimeBinding(session.nonce, request.runtime, &ready)) result.error = ERROR_INVALID_DATA;
      if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::runtime_ready, ready.data(), static_cast<DWORD>(ready.size()), stop, session.IoDeadline());
      if (!result.error) result.error = session.Authorize();
      if (!result.error) {
        result.runtime_attempted = true;
        const auto runtime = owner.run_runtime(owner.context, pipe, stop, session.deadline, journal, request.runtime);
        result.error = runtime.error;
        if (!result.error && !MatchesCellControllerRuntimeResult(request.runtime, runtime)) result.error = ERROR_INVALID_DATA;
        if (!result.error) result.error = session.Authorize();
        if (!result.error) result.runtime_retained = true;
      }
    }
    if (!result.error && session.capacity) {
      result.error = Session::AuthorizeCapacity(&session);
      if (!result.error && !session.measurement) result.error = owner.begin_measurement(owner.context, request, stop, session.deadline, &session.measurement);
      if (!result.error && !session.measurement) result.error = ERROR_INVALID_STATE;
      if (!result.error) result.error = session.Authorize();
      CellControllerRuntimeBindingBytes ready{};
      const CellControllerRuntimeBinding binding{cleanup_admission.binding.challenge, cleanup_admission.binding.set_sha256, session.retained_head};
      if (!result.error && !EncodeCellControllerRuntimeBinding(session.nonce, binding, &ready)) result.error = ERROR_INVALID_DATA;
      if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::cleanup_ready, ready.data(), static_cast<DWORD>(ready.size()), stop, session.IoDeadline());
      if (!result.error) {
        // Raw transfer occupies the pipe until ACK: local peer checks must not
        // interleave canonical authority frames into this phase.
        const CellFootprintScanGuard local{[](void* raw) noexcept -> DWORD { return static_cast<Session*>(raw)->Authorize(); }, &session, stop};
        CellRuntimeCleanupTransfer transfer(pipe, session.deadline, cleanup_admission.binding, local);
        CellRuntimeCleanupSet cleanup;
        result.error = transfer.ReadVerifiedForController(journal, request, owner.owner_sid, owner.controller_sid, cleanup_admission.installations, &cleanup);
      }
      if (!result.error) result.error = Session::AuthorizeCapacity(&session);
    }
    if (!result.error && IsCellControllerInstall(request.operation)) {
      result.error = Session::AuthorizeInstallation(&session);
      if (!result.error) {
        const auto now = GetTickCount64();
        if (now >= session.deadline) result.error = ERROR_TIMEOUT;
        else {
          const bool recovering = request.operation == kCellControllerInstallRecoveryOperation;
          RuntimeBundleInstallResult installed;
          if (!recovering) {
            result.installation_attempted = true;
            if (IsCellControllerInstallCapacity(request.operation)) {
              installed = owner.install_runtime_capacity(owner.context, pipe, stop, session.deadline, journal, request,
                *session.measurement, {Session::AuthorizeInstallation, &session, stop},
                {[](void* raw) noexcept -> DWORD { return static_cast<Session*>(raw)->Authorize(); }, &session, stop});
            } else installed = owner.install_runtime(owner.context, journal, request.installation_bytes,
                {request.installation.nonce, request.installation.request_sha256}, static_cast<DWORD>(session.deadline - now),
                {Session::AuthorizeInstallation, &session, stop});
            result.error = installed.error;
          }
          CellRuntimeInstallRequest decoded;
          if (!result.error) result.error = DecodeCellRuntimeInstall(request.installation_bytes,
            {request.installation.nonce, request.installation.request_sha256}, &decoded);
          if (!result.error && !recovering && (!installed.verified || installed.files_created != 2 || installed.directories_created ||
              installed.bytes_written != decoded.files[0].bytes + decoded.files[1].bytes)) result.error = ERROR_INVALID_DATA;
          if (!result.error) result.error = Session::AuthorizeInstallation(&session);
          CellRuntimeInstallLocalRecord retained;
          if (!result.error) result.error = CellRuntimeLocalOutcome::ReadInstall(journal, request.installation_bytes,
            {request.installation.nonce, request.installation.request_sha256}, &retained);
          // Recovery only reads a sealed terminal record. An intent alone is
          // uncertain and never permits a retry, even when a copy owner exists.
          if (!result.error && (!retained.outcome_retained || retained.bytes.size() != 352)) result.error = ERROR_INVALID_DATA;
          if (!result.error && !recovering && (!retained.installation.verified ||
              retained.installation.error || retained.installation.files_created != installed.files_created ||
              retained.installation.directories_created != installed.directories_created || retained.installation.bytes_written != installed.bytes_written)) result.error = ERROR_INVALID_DATA;
          if (!result.error) result.error = Session::AuthorizeInstallation(&session);
          if (!result.error) {
            std::array<std::uint8_t, 384> evidence{}; std::copy(request.nonce.begin(), request.nonce.end(), evidence.begin());
            std::copy(retained.bytes.begin(), retained.bytes.end(), evidence.begin() + 32);
            result.error = WriteCellControllerMessage(pipe, CellControllerMessage::install_outcome, evidence.data(), 384, stop, session.IoDeadline());
            std::array<std::uint8_t, 64> received{};
            if (!result.error) result.error = ReadCellControllerMessage(pipe, CellControllerMessage::install_outcome_received, received.data(), 64, stop, session.IoDeadline());
            if (!result.error && (!std::equal(request.nonce.begin(), request.nonce.end(), received.begin()) ||
                !std::equal(retained.outcome_sha256.begin(), retained.outcome_sha256.end(), received.begin() + 32))) result.error = ERROR_INVALID_DATA;
            if (!result.error) result.error = session.Authorize();
          }
          if (!result.error) result.installation_retained = true;
        }
      }
    }
    if (!result.error && request.operation == kCellControllerCapacityOperation) {
      CellProvisioningFootprint observation;
      result.error = Session::AuthorizeCapacity(&session);
      if (!result.error) {
        const auto now = GetTickCount64();
        result.error = now >= session.deadline ? ERROR_TIMEOUT : owner.observe_capacity(owner.context, journal, request.anchor, session.retained_head,
          {20000, 64, static_cast<DWORD>(session.deadline - now)}, {Session::AuthorizeCapacity, &session, stop}, &observation);
      }
      if (!result.error) result.error = Session::AuthorizeVolume(&session);
      if (!result.error && !MatchesCellControllerCapacity(request, observation, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      CellControllerCapacityBytes capacity{};
      if (!result.error && !EncodeCellControllerCapacity(session.nonce, observation, &capacity)) result.error = ERROR_INVALID_DATA;
      if (!result.error) result.error = session.Authorize();
      if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::capacity_observation,
        capacity.data(), static_cast<DWORD>(capacity.size()), stop, session.deadline);
      result.capacity_written = !result.error;
    }
    if (!result.error && IsCellControllerBackingCapacity(request.operation)) {
      CellProvisioningBackingFootprint observation;
      result.error = Session::AuthorizeCapacity(&session);
      if (!result.error) {
        const auto now = GetTickCount64();
        result.error = now >= session.deadline ? ERROR_TIMEOUT : owner.observe_backing_capacity(owner.context, journal, request.anchor, session.retained_head,
          static_cast<DWORD>(session.deadline - now), {Session::AuthorizeCapacity, &session, stop}, &observation);
      }
      if (!result.error) result.error = Session::AuthorizeVolume(&session);
      if (!result.error && !MatchesCellControllerBackingCapacity(request, observation, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      CellControllerBackingCapacityBytes capacity{};
      if (!result.error && !EncodeCellControllerBackingCapacity(session.nonce, observation, &capacity)) result.error = ERROR_INVALID_DATA;
      if (!result.error) result.error = session.Authorize();
      if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::backing_capacity_observation,
        capacity.data(), static_cast<DWORD>(capacity.size()), stop, session.deadline);
      result.capacity_written = !result.error;
    }
    if (!result.error && request.operation == kCellControllerPoolCapacityOperation) {
      CellCapacityLayoutRecord layout; CellPoolJoinedCapacity observation;
      result.error = Session::AuthorizeCapacity(&session);
      if (!result.error) {
        const auto now = GetTickCount64();
        result.error = now >= session.deadline ? ERROR_TIMEOUT : owner.observe_pool_capacity(owner.context, journal, request,
          {20000, 64, static_cast<DWORD>(session.deadline - now)}, {Session::AuthorizeCapacity, &session, stop}, &layout, &observation);
      }
      std::vector<std::uint8_t> response;
      if (!result.error) result.error = EncodeCellPoolCapacityResponse(request, owner.owner_sid, owner.controller_sid, layout, request.capture_nonce, observation, &response);
      if (!result.error) result.error = Session::AuthorizeVolume(&session);
      std::array<std::uint8_t, 64> ready{}; std::copy(session.nonce.begin(), session.nonce.end(), ready.begin());
      std::copy(request.capture_nonce.begin(), request.capture_nonce.end(), ready.begin() + 32);
      if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::pool_capacity_ready, ready.data(), 64, stop, session.deadline);
      // The chunk stream cannot interleave volume-authority challenges. Retain
      // local measurement/endpoint custody throughout, then force a fresh
      // canonical check before the terminal receipt releases the consumer.
      if (!result.error) result.error = WriteCellPoolCapacityResponse(pipe, session.deadline, session.nonce,
        {[](void* raw) noexcept -> DWORD { return static_cast<Session*>(raw)->Authorize(); }, &session, stop}, response);
      if (!result.error) result.error = Session::AuthorizeVolume(&session);
      result.capacity_written = !result.error;
    }
    if (!result.error && IsCellControllerInventory(request.operation) && !IsCellControllerPoolCapacity(request.operation)) {
      CellProvisioningInventory observation;
      result.error = Session::AuthorizeCapacity(&session);
      if (!result.error) {
        const auto now = GetTickCount64();
        result.error = now >= session.deadline ? ERROR_TIMEOUT : owner.observe_inventory(owner.context, journal, request.anchor, session.retained_head,
          {20000, 64, static_cast<DWORD>(session.deadline - now)}, {Session::AuthorizeCapacity, &session, stop}, &observation);
      }
      if (!result.error) result.error = Session::AuthorizeVolume(&session);
      if (!result.error && !MatchesCellControllerInventory(request, observation, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      CellControllerCapacityBytes summary{};
      if (!result.error && !EncodeCellControllerCapacity(session.nonce, {observation.anchor, observation.assignment_binding,
          observation.profile_sha256, observation.checkpoint_sha256, observation.workspace, observation.inventory.footprint}, &summary)) result.error = ERROR_INVALID_DATA;
      if (!result.error) result.error = session.Authorize();
      if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::inventory_observation,
        summary.data(), static_cast<DWORD>(summary.size()), stop, session.deadline);
      for (std::size_t start = 0; !result.error && start < observation.inventory.entries.size(); start += kCellControllerInventoryChunkEntries) {
        CellControllerInventoryChunkBytes chunk_bytes{};
        const auto entries = std::span(observation.inventory.entries).subspan(start,
          std::min(kCellControllerInventoryChunkEntries, observation.inventory.entries.size() - start));
        if (!EncodeCellControllerInventoryChunk(session.nonce, static_cast<std::uint32_t>(start), entries, &chunk_bytes)) result.error = ERROR_INVALID_DATA;
        if (!result.error) result.error = session.Authorize();
        if (!result.error) result.error = WriteCellControllerMessage(pipe, CellControllerMessage::inventory_chunk,
          chunk_bytes.data(), static_cast<DWORD>(chunk_bytes.size()), stop, session.deadline);
      }
      result.capacity_written = !result.error;
    }
    result.phase = journal.Phase();
    std::array<std::uint8_t, 48> receipt{}; std::copy(session.nonce.begin(), session.nonce.end(), receipt.begin());
    Put32(receipt.data() + 32, result.error); Put32(receipt.data() + 36, static_cast<unsigned>(result.phase));
    Put32(receipt.data() + 40, result.creation_attempted ? 1 : 0); Put32(receipt.data() + 44, result.checkpoints);
    // The receipt may fail after cancellation or peer loss. That never changes
    // the operation outcome or grants permission to retry an uncertain effect.
    if (!session.Authorize()) result.receipt_written = WriteCellControllerMessage(pipe, CellControllerMessage::receipt,
      receipt.data(), static_cast<DWORD>(receipt.size()), stop, session.IoDeadline()) == ERROR_SUCCESS;
    if (result.receipt_written) {
      // DisconnectNamedPipe discards unread buffered bytes. Wait for an explicit
      // receipt acknowledgement, without extending the operation deadline.
      CellControllerNonce finish{};
      if (!result.error && IsCellControllerInstallCapacity(request.operation) && owner.finish_installation)
        result.receipt_acknowledged = !owner.finish_installation(owner.context) && !session.Authorize();
      else result.receipt_acknowledged = !ReadCellControllerMessage(pipe, CellControllerMessage::finish,
        finish.data(), static_cast<DWORD>(finish.size()), stop, session.IoDeadline()) &&
        finish == session.nonce && !session.Authorize();
    }
    return result;
  } catch (...) { result.error = ERROR_NOT_ENOUGH_MEMORY; return result; }
}
}
