#include "cell_controller_client_protocol.hpp"
#include <bcrypt.h>
#include <algorithm>
#include <cstring>
#pragma comment(lib, "bcrypt.lib")

namespace goatcitadel::worker_cell {
namespace {
std::uint32_t U32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0; for (unsigned i = 0; i < 4; ++i) value |= static_cast<std::uint32_t>(bytes[i]) << (8 * i); return value;
}
void Put32(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (unsigned i = 0; i < 4; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
bool Nonzero(const CellControllerNonce& nonce) noexcept { return std::any_of(nonce.begin(), nonce.end(), [](auto byte) { return byte != 0; }); }
bool MatchesSid(const std::uint8_t* bytes, const std::wstring& sid) noexcept {
  if (sid.empty() || sid.size() >= 184) return false;
  for (std::size_t i = 0; i < 184; ++i)
    if (bytes[i] != (i < sid.size() ? static_cast<std::uint8_t>(sid[i]) : 0)) return false;
  return true;
}
CellFileIdentity Identity(const std::uint8_t* bytes) noexcept {
  CellFileIdentity value;
  for (unsigned i = 0; i < 8; ++i) value.volume_serial |= static_cast<std::uint64_t>(bytes[i]) << (8 * i);
  std::copy_n(bytes + 8, value.file_id.size(), value.file_id.begin()); return value;
}
bool RecordHash(const CellProvisioningRecord& record, CellFileSha256* output) noexcept {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  const auto status = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(record.data()), 992,
    output->data(), static_cast<ULONG>(output->size()));
  BCryptCloseAlgorithmProvider(algorithm, 0); return status >= 0;
}
struct Client final {
  HANDLE pipe, stop;
  ULONGLONG deadline;
  const CellControllerClientOwner& owner;
  CellControllerNonce nonce{};
  DWORD Authorize() noexcept {
    const auto state = WaitForSingleObject(stop, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    if (now >= deadline) return ERROR_TIMEOUT;
    if (deadline - now > 600000) return ERROR_INVALID_PARAMETER;
    return owner.authorize(owner.context);
  }
  DWORD Send(CellControllerMessage kind, const void* bytes, DWORD count) noexcept {
    const DWORD error = Authorize();
    return error ? error : WriteCellControllerMessage(pipe, kind, bytes, count, stop, deadline);
  }
};
}
DWORD RunCellControllerClientSession(HANDLE pipe, HANDLE stop, ULONGLONG deadline,
  const CellControllerRequest& input, const CellControllerClientOwner& owner) noexcept {
  if (!owner.context || !owner.authorize || !owner.checkpoint || !owner.receipt) return ERROR_INVALID_STATE;
  if (IsCellControllerCreation(input.operation) && IsCellControllerVolume(input.operation) && !owner.volume_authority) return ERROR_INVALID_STATE;
  if (IsCellControllerProtection(input.operation)) {
    CellFileSha256 policy{};
    if (HashCellVolumeRootSecurity(owner.owner_sid, owner.controller_sid, &policy)) return ERROR_INVALID_STATE;
  }
  try {
    Client client{pipe, stop, deadline, owner};
    DWORD error = client.Authorize();
    if (error) return error;
    auto request = input;
    CellControllerNonce hello{};
    if (BCryptGenRandom(nullptr, hello.data(), static_cast<ULONG>(hello.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 || !Nonzero(hello))
      return ERROR_GEN_FAILURE;
    request.nonce = hello;
    std::array<std::uint8_t, kCellControllerRequestBytes> wire{};
    if (!EncodeCellControllerRequest(request, &wire, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
    error = client.Send(CellControllerMessage::hello, hello.data(), static_cast<DWORD>(hello.size()));
    std::array<std::uint8_t, 64> welcome{};
    if (!error) error = ReadCellControllerMessage(pipe, CellControllerMessage::welcome, welcome.data(), static_cast<DWORD>(welcome.size()), stop, deadline);
    if (!error) error = client.Authorize();
    if (error) return error;
    std::copy_n(welcome.begin() + 32, 32, client.nonce.begin());
    if (!std::equal(hello.begin(), hello.end(), welcome.begin()) || !Nonzero(client.nonce)) return ERROR_INVALID_DATA;
    request.nonce = client.nonce;
    const auto now = GetTickCount64();
    if (now >= deadline || deadline - now < 100) return ERROR_TIMEOUT;
    request.wall_ms = static_cast<DWORD>(std::min<ULONGLONG>(request.wall_ms, deadline - now));
    if (!EncodeCellControllerRequest(request, &wire, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
    error = client.Send(CellControllerMessage::request, wire.data(), static_cast<DWORD>(wire.size()));
    if (!error && (request.operation == 4 || request.operation == 6 || request.operation == 8 || request.operation == 10 || request.operation == 12)) {
      std::array<std::uint8_t, kCellControllerVolumeHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.volume_records.size(); ++index)
        std::copy(request.volume_records[index].begin(), request.volume_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::volume_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && (request.operation == 6 || request.operation == 8 || request.operation == 10 || request.operation == 12)) {
      std::array<std::uint8_t, kCellControllerFormatHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.format_records.size(); ++index)
        std::copy(request.format_records[index].begin(), request.format_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::format_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && (request.operation == 8 || request.operation == 10 || request.operation == 12)) {
      std::array<std::uint8_t, kCellControllerProtectionHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.protection_records.size(); ++index)
        std::copy(request.protection_records[index].begin(), request.protection_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::protection_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && (request.operation == 10 || request.operation == 12)) {
      std::array<std::uint8_t, kCellControllerMountHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.creation_records.size(); ++index)
        std::copy(request.creation_records[index].begin(), request.creation_records[index].end(), history.begin() + 32 + index * 1024);
      for (std::size_t index = 0; index < request.mount_records.size(); ++index)
        std::copy(request.mount_records[index].begin(), request.mount_records[index].end(), history.begin() + 32 + (5 + index) * 1024);
      error = client.Send(CellControllerMessage::mount_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && request.operation == 12) {
      std::array<std::uint8_t, kCellControllerMountedWorkspaceHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.mounted_workspace_records.size(); ++index)
        std::copy(request.mounted_workspace_records[index].begin(), request.mounted_workspace_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::mounted_workspace_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (error) return error;
    std::uint32_t count = 0, volume_checks = 0, authorized_volume_count = 0;
    CellFileSha256 previous{};
    std::array<std::uint8_t, 24> journal{};
    CellVirtualDiskRecord disk; disk.spec = request.plan.disk;
    CellFileSha256 disk_recorded{};
    std::vector<CellVolumeProvisioningRecord> volume_records;
    std::vector<CellFormatProvisioningRecord> format_records;
    std::vector<CellProtectionProvisioningRecord> protection_records;
    std::vector<CellProvisioningRecord> creation_records;
    std::vector<CellMountProvisioningRecord> mount_records;
    std::vector<CellMountedWorkspaceProvisioningRecord> workspace_records;
    CellWorkspaceIdentities workspace;
    for (;;) {
      CellControllerMessage kind{}; std::array<std::uint8_t, 1056> reply{};
      error = client.Authorize();
      if (!error) error = ReadCellControllerReply(pipe, &kind, &reply, stop, deadline);
      if (!error) error = client.Authorize();
      if (error) return error;
      if (!std::equal(client.nonce.begin(), client.nonce.end(), reply.begin())) return ERROR_INVALID_DATA;
      if (kind == CellControllerMessage::volume_authority) {
        const auto ordinal = U32(reply.data() + 32), observed = U32(reply.data() + 36);
        if (!IsCellControllerCreation(input.operation) || !IsCellControllerVolume(input.operation) ||
            volume_checks >= kCellControllerMaximumVolumeChecks || ordinal != volume_checks + 1 ||
            observed != count || count < 5 || count > CellControllerCheckpointLimit(input.operation) ||
            !std::equal(previous.begin(), previous.end(), reply.begin() + 40)) return ERROR_INVALID_DATA;
        ++volume_checks;
        error = owner.volume_authority(owner.context, ordinal, count, previous);
        if (!error) error = client.Send(CellControllerMessage::volume_authorized, reply.data(), 72);
        if (error) return error;
        authorized_volume_count = count;
        continue;
      }
      if (kind == CellControllerMessage::receipt) {
        std::array<std::uint8_t, 16> receipt{}; std::copy_n(reply.begin() + 32, 16, receipt.begin());
        const auto native_error = U32(receipt.data()), phase = U32(receipt.data() + 4), attempted = U32(receipt.data() + 8);
        const bool volume = IsCellControllerVolume(input.operation), creation = IsCellControllerCreation(input.operation);
        const auto maximum = CellControllerCheckpointLimit(input.operation);
        if (!native_error && creation && volume && authorized_volume_count != count) return ERROR_INVALID_DATA;
        if (U32(receipt.data() + 12) != count || phase > 5 || phase < std::min(count, 5u) || attempted > 1 ||
            (!creation && attempted) || (!native_error && ((volume ? (phase != 5 || count != maximum) :
            (phase != count || (count != 1 && count != 3 && count != 5))) ||
            (creation && (count != maximum || attempted != 1))))) return ERROR_INVALID_DATA;
        error = owner.receipt(owner.context, receipt);
        if (!error) error = client.Send(CellControllerMessage::finish, client.nonce.data(), static_cast<DWORD>(client.nonce.size()));
        return error;
      }
      CellProvisioningRecord record{}; std::copy_n(reply.begin() + 32, record.size(), record.begin());
      CellFileSha256 digest{};
      if (count >= CellControllerCheckpointLimit(input.operation) || !RecordHash(record, &digest) ||
          !std::equal(digest.begin(), digest.end(), record.begin() + 992)) return ERROR_INVALID_DATA;
      if (count < 5) {
        creation_records.push_back(record);
        if ((input.operation == 10 || input.operation == 12) && record != request.creation_records[count]) return ERROR_INVALID_DATA;
        if (IsCellControllerProtection(input.operation) &&
            (!MatchesSid(record.data() + 232, owner.owner_sid) || !MatchesSid(record.data() + 416, owner.controller_sid))) return ERROR_INVALID_DATA;
        if (std::memcmp(record.data(), "GCCELLP1", 8) || U32(record.data() + 8) != count + 1 || U32(record.data() + 12) != count + 1 ||
          !std::equal(previous.begin(), previous.end(), record.begin() + 16) ||
          !std::equal(wire.begin() + 80, wire.begin() + 144, record.begin() + 48) ||
          !std::equal(wire.begin() + 144, wire.begin() + 176, record.begin() + 112) ||
          !std::equal(wire.begin() + 176, wire.begin() + 200, record.begin() + 144) ||
          !std::equal(wire.begin() + 40, wire.begin() + 80, record.begin() + 192)) return ERROR_INVALID_DATA;
      if (!count) {
        std::copy_n(record.begin() + 168, 24, journal.begin());
        if (!IsCellControllerCreation(input.operation) && (!std::equal(journal.begin(), journal.end(), wire.begin() + 200) || digest != request.anchor.prepared_sha256))
          return ERROR_INVALID_DATA;
      } else if (!std::equal(journal.begin(), journal.end(), record.begin() + 168)) return ERROR_INVALID_DATA;
        if (count == 4) {
          disk.control = Identity(record.data() + 624); disk.backing = Identity(record.data() + 696); disk_recorded = digest;
          if (IsCellControllerMount(input.operation)) {
            CellProvisioningAnchor captured; captured.file = Identity(journal.data());
            std::copy_n(creation_records.front().begin() + 992, 32, captured.prepared_sha256.begin());
            if (ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner.owner_sid, owner.controller_sid,
                captured, creation_records, &workspace, &disk, &disk_recorded)) return ERROR_INVALID_DATA;
          }
        }
      } else if (count < 11) {
        if (IsCellControllerCreation(input.operation) && authorized_volume_count != count) return ERROR_INVALID_DATA;
        volume_records.push_back(record);
        if (ValidateCellVolumeProvisioningPrefix(request.plan, Identity(journal.data()), disk, disk_recorded, volume_records) ||
            (!IsCellControllerCreation(input.operation) && record != request.volume_records[count - 5])) return ERROR_INVALID_DATA;
      } else if (count < 13) {
        if (IsCellControllerCreation(input.operation) && authorized_volume_count != count) return ERROR_INVALID_DATA;
        format_records.push_back(record);
        if (ValidateCellFormatProvisioningPrefix(request.plan, Identity(journal.data()), disk, disk_recorded, volume_records, format_records) ||
            (!IsCellControllerCreation(input.operation) && record != request.format_records[count - 11])) return ERROR_INVALID_DATA;
      } else if (count < 15) {
        if (IsCellControllerCreation(input.operation) && authorized_volume_count != count) return ERROR_INVALID_DATA;
        protection_records.push_back(record);
        if (ValidateCellProtectionProvisioningPrefix(request.plan, Identity(journal.data()), disk, disk_recorded,
            owner.owner_sid, owner.controller_sid, volume_records, format_records, protection_records) ||
            (!IsCellControllerCreation(input.operation) && record != request.protection_records[count - 13])) return ERROR_INVALID_DATA;
      } else if (count < 19) {
        if (IsCellControllerCreation(input.operation) && authorized_volume_count != count) return ERROR_INVALID_DATA;
        mount_records.push_back(record);
        if (ValidateCellMountProvisioningPrefix(request.plan, Identity(journal.data()), workspace, disk, disk_recorded,
            owner.owner_sid, owner.controller_sid, volume_records, format_records, protection_records, mount_records) ||
            ((input.operation == 10 || input.operation == 12) && record != request.mount_records[count - 15])) return ERROR_INVALID_DATA;
      } else {
        if (IsCellControllerCreation(input.operation) && authorized_volume_count != count) return ERROR_INVALID_DATA;
        workspace_records.push_back(record);
        if (ValidateCellMountedWorkspaceProvisioningPrefix(request.plan, Identity(journal.data()), workspace, disk, disk_recorded,
            request.cell_name, owner.owner_sid, owner.controller_sid, volume_records, format_records, protection_records, mount_records, workspace_records) ||
            (input.operation == 12 && record != request.mounted_workspace_records[count - 19])) return ERROR_INVALID_DATA;
      }
      CellFileSha256 committed{};
      error = owner.checkpoint(owner.context, record, IsCellControllerCreation(input.operation), &committed);
      if (error) return error;
      ++count; previous = digest;
      if (IsCellControllerCreation(input.operation)) {
        if (committed != digest) return ERROR_INVALID_DATA;
        std::array<std::uint8_t, 68> ack{};
        std::copy(client.nonce.begin(), client.nonce.end(), ack.begin()); Put32(ack.data() + 32, count);
        std::copy(committed.begin(), committed.end(), ack.begin() + 36);
        // Re-attest after the possibly blocking canonical commit callback.
        error = client.Send(CellControllerMessage::acknowledgement, ack.data(), static_cast<DWORD>(ack.size()));
        if (error) return error;
      }
    }
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
