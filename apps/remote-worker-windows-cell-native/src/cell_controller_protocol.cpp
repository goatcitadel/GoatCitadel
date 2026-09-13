#include "cell_controller_protocol.hpp"
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
bool Known(CellControllerMessage kind, DWORD count) noexcept {
  switch (kind) {
    case CellControllerMessage::hello: return count == 32;
    case CellControllerMessage::welcome: return count == 64;
    case CellControllerMessage::request: return count == kCellControllerRequestBytes;
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
  DWORD Authorize(bool first = false) noexcept {
    const DWORD state = WaitForSingleObject(stop, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    if (GetTickCount64() >= deadline) return ERROR_TIMEOUT;
    return owner.authorize(owner.context, first);
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
    error = WriteCellControllerMessage(pipe, CellControllerMessage::checkpoint, bytes.data(), static_cast<DWORD>(bytes.size()), stop, deadline);
    if (error) return error;
    ++result.checkpoints;
    std::copy_n(record.begin() + 992, retained_head.size(), retained_head.begin());
    if (!acknowledge) return ERROR_SUCCESS;
    std::array<std::uint8_t, 68> ack{};
    error = ReadCellControllerMessage(pipe, CellControllerMessage::acknowledgement, ack.data(), static_cast<DWORD>(ack.size()), stop, deadline);
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
      static_cast<DWORD>(challenge.size()), session.stop, session.deadline);
    if (!error) error = ReadCellControllerMessage(session.pipe, CellControllerMessage::volume_authorized, reply.data(),
      static_cast<DWORD>(reply.size()), session.stop, session.deadline);
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
};
}
bool DecodeCellControllerRequest(const std::array<std::uint8_t, kCellControllerRequestBytes>& bytes,
  const CellControllerNonce& nonce, CellControllerRequest* output) noexcept {
  if (!output) return false;
  *output = {};
  try {
    CellControllerRequest value;
    value.operation = U32(bytes.data()); value.wall_ms = U32(bytes.data() + 4);
    if (value.operation < 1 || value.operation > 12 || value.wall_ms < 100 || value.wall_ms > 600000 || !Nonzero(nonce) ||
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
  if ((request.operation == 4 || request.operation == 6 || request.operation == 8 || request.operation == 10 || request.operation == 12) ? !ValidateCellControllerVolumeHistory(request) :
      std::any_of(request.volume_records.begin(), request.volume_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  if ((request.operation == 6 || request.operation == 8 || request.operation == 10 || request.operation == 12) ? !ValidateCellControllerFormatHistory(request) :
      std::any_of(request.format_records.begin(), request.format_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  if ((request.operation == 8 || request.operation == 10 || request.operation == 12) ? !ValidateCellControllerProtectionHistory(request, owner_sid, controller_sid) :
      std::any_of(request.protection_records.begin(), request.protection_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  if ((request.operation == 10 || request.operation == 12) ? !ValidateCellControllerMountHistory(request, owner_sid, controller_sid) :
      (std::any_of(request.creation_records.begin(), request.creation_records.end(), [](const auto& record) { return Nonzero(record); }) ||
       std::any_of(request.mount_records.begin(), request.mount_records.end(), [](const auto& record) { return Nonzero(record); }))) return false;
  if (request.operation == 12 ? !ValidateCellControllerMountedWorkspaceHistory(request, owner_sid, controller_sid) :
      std::any_of(request.mounted_workspace_records.begin(), request.mounted_workspace_records.end(), [](const auto& record) { return Nonzero(record); })) return false;
  *output = bytes; return true;
}
bool ValidateCellControllerVolumeHistory(const CellControllerRequest& request) noexcept {
  if (request.operation != 4 && request.operation != 6 && request.operation != 8 && request.operation != 10 && request.operation != 12) return false;
  const auto& first = request.volume_records.front();
  CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
  disk.control = Identity(first.data() + 168); disk.backing = Identity(first.data() + 192);
  CellFileSha256 base{}; std::copy_n(first.begin() + 216, base.size(), base.begin());
  return !ValidateCellVolumeProvisioningPrefix(request.plan, request.anchor.file, disk, base, request.volume_records);
}
bool ValidateCellControllerFormatHistory(const CellControllerRequest& request) noexcept {
  if ((request.operation != 6 && request.operation != 8 && request.operation != 10 && request.operation != 12) || !ValidateCellControllerVolumeHistory(request)) return false;
  const auto& first = request.volume_records.front();
  CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
  disk.control = Identity(first.data() + 168); disk.backing = Identity(first.data() + 192);
  CellFileSha256 base{}; std::copy_n(first.begin() + 216, base.size(), base.begin());
  return !ValidateCellFormatProvisioningPrefix(request.plan, request.anchor.file, disk, base, request.volume_records, request.format_records);
}
bool ValidateCellControllerProtectionHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if ((request.operation != 8 && request.operation != 10 && request.operation != 12) || !ValidateCellControllerFormatHistory(request)) return false;
  const auto& first = request.volume_records.front();
  CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
  disk.control = Identity(first.data() + 168); disk.backing = Identity(first.data() + 192);
  CellFileSha256 base{}; std::copy_n(first.begin() + 216, base.size(), base.begin());
  return !ValidateCellProtectionProvisioningPrefix(request.plan, request.anchor.file, disk, base,
    owner_sid, controller_sid, request.volume_records, request.format_records, request.protection_records);
}
bool ValidateCellControllerMountHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if ((request.operation != 10 && request.operation != 12) || !ValidateCellControllerProtectionHistory(request, owner_sid, controller_sid)) return false;
  CellWorkspaceIdentities workspace; CellVirtualDiskRecord disk; CellFileSha256 base{};
  if (ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner_sid, controller_sid,
      request.anchor, request.creation_records, &workspace, &disk, &base)) return false;
  return !ValidateCellMountProvisioningPrefix(request.plan, request.anchor.file, workspace, disk, base,
    owner_sid, controller_sid, request.volume_records, request.format_records, request.protection_records, request.mount_records);
}
bool ValidateCellControllerMountedWorkspaceHistory(const CellControllerRequest& request,
  const std::wstring& owner_sid, const std::wstring& controller_sid) noexcept {
  if (request.operation != 12 || !ValidateCellControllerMountHistory(request, owner_sid, controller_sid)) return false;
  CellWorkspaceIdentities workspace; CellVirtualDiskRecord disk; CellFileSha256 base{};
  if (ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner_sid, controller_sid,
      request.anchor, request.creation_records, &workspace, &disk, &base)) return false;
  return !ValidateCellMountedWorkspaceProvisioningPrefix(request.plan, request.anchor.file, workspace, disk, base,
    request.cell_name, owner_sid, controller_sid, request.volume_records, request.format_records, request.protection_records,
    request.mount_records, request.mounted_workspace_records);
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
      (received != CellControllerMessage::checkpoint && received != CellControllerMessage::receipt && received != CellControllerMessage::volume_authority) || !Known(received, count)))
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
CellControllerSessionResult RunCellControllerSession(HANDLE pipe, HANDLE stop, const CellControllerSessionOwner& owner) noexcept {
  CellControllerSessionResult result;
  if (!owner.authorize || !owner.arm_watchdog || !IsLiteralCellPath(owner.parent_path) || !ValidIdentity(owner.parent)) return result;
  try {
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
    session.volume = IsCellControllerVolume(request.operation);
    session.format = IsCellControllerFormat(request.operation);
    session.protection = IsCellControllerProtection(request.operation);
    session.mount = IsCellControllerMount(request.operation);
    session.mounted_workspace = IsCellControllerMountedWorkspace(request.operation);
    if (IsCellControllerCreation(request.operation) && session.volume &&
        (!owner.provision_volume || (session.format && !owner.provision_format) ||
         (session.protection && !owner.provision_protection) || (session.mount && !owner.provision_mount) ||
         (session.mounted_workspace && !owner.provision_mounted_workspace))) { result.error = ERROR_NOT_SUPPORTED; return result; }
    if (request.operation == 4 || request.operation == 6 || request.operation == 8 || request.operation == 10 || request.operation == 12) {
      std::array<std::uint8_t, kCellControllerVolumeHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::volume_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.deadline);
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.volume_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.volume_records[i].begin());
      if (!result.error && !ValidateCellControllerVolumeHistory(request)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (request.operation == 6 || request.operation == 8 || request.operation == 10 || request.operation == 12) {
      std::array<std::uint8_t, kCellControllerFormatHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::format_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.deadline);
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.format_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.format_records[i].begin());
      if (!result.error && !ValidateCellControllerFormatHistory(request)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (request.operation == 8 || request.operation == 10 || request.operation == 12) {
      std::array<std::uint8_t, kCellControllerProtectionHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::protection_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.deadline);
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.protection_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.protection_records[i].begin());
      if (!result.error && !ValidateCellControllerProtectionHistory(request, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    if (request.operation == 10 || request.operation == 12) {
      std::array<std::uint8_t, kCellControllerMountHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::mount_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.deadline);
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
    if (request.operation == 12) {
      std::array<std::uint8_t, kCellControllerMountedWorkspaceHistoryBytes> history{};
      result.error = ReadCellControllerMessage(pipe, CellControllerMessage::mounted_workspace_history, history.data(),
        static_cast<DWORD>(history.size()), stop, session.deadline);
      if (!result.error) result.error = session.Authorize();
      if (!result.error && !std::equal(session.nonce.begin(), session.nonce.end(), history.begin())) result.error = ERROR_INVALID_DATA;
      if (!result.error) for (std::size_t i = 0; i < request.mounted_workspace_records.size(); ++i)
        std::copy_n(history.begin() + 32 + i * 1024, 1024, request.mounted_workspace_records[i].begin());
      if (!result.error && !ValidateCellControllerMountedWorkspaceHistory(request, owner.owner_sid, owner.controller_sid)) result.error = ERROR_INVALID_DATA;
      if (result.error) return result;
    }
    Parent parent{CreateFileW(owner.parent_path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)};
    result.error = parent.value == INVALID_HANDLE_VALUE ? GetLastError() : session.Authorize();
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
    result.phase = journal.Phase();
    std::array<std::uint8_t, 48> receipt{}; std::copy(session.nonce.begin(), session.nonce.end(), receipt.begin());
    Put32(receipt.data() + 32, result.error); Put32(receipt.data() + 36, static_cast<unsigned>(result.phase));
    Put32(receipt.data() + 40, result.creation_attempted ? 1 : 0); Put32(receipt.data() + 44, result.checkpoints);
    // The receipt may fail after cancellation or peer loss. That never changes
    // the operation outcome or grants permission to retry an uncertain effect.
    if (!session.Authorize()) result.receipt_written = WriteCellControllerMessage(pipe, CellControllerMessage::receipt,
      receipt.data(), static_cast<DWORD>(receipt.size()), stop, session.deadline) == ERROR_SUCCESS;
    if (result.receipt_written) {
      // DisconnectNamedPipe discards unread buffered bytes. Wait for an explicit
      // receipt acknowledgement, without extending the operation deadline.
      CellControllerNonce finish{};
      result.receipt_acknowledged = !ReadCellControllerMessage(pipe, CellControllerMessage::finish,
        finish.data(), static_cast<DWORD>(finish.size()), stop, session.deadline) &&
        finish == session.nonce && !session.Authorize();
    }
    return result;
  } catch (...) { result.error = ERROR_NOT_ENOUGH_MEMORY; return result; }
}
}
