#include "cell_controller_client_protocol.hpp"
#include "cell_runtime_client_session.hpp"
#include "cell_runtime_result.hpp"
#include "cell_joined_capacity_wire.hpp"
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
  DWORD maximum_wall_ms = 600000;
  // Runtime setup/receipt messages have short individual I/O deadlines. The
  // independent overall deadline is reserved for the runtime owner itself.
  ULONGLONG IoDeadline() const noexcept {
    return maximum_wall_ms > 600000 ? std::min<ULONGLONG>(deadline, GetTickCount64() + 5000) : deadline;
  }
  DWORD Authorize() noexcept {
    const auto state = WaitForSingleObject(stop, 0);
    if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_OPERATION_ABORTED : ERROR_INVALID_HANDLE;
    const auto now = GetTickCount64();
    if (now >= deadline) return ERROR_TIMEOUT;
    if (deadline - now > maximum_wall_ms) return ERROR_INVALID_PARAMETER;
    return owner.authorize(owner.context);
  }
  DWORD Send(CellControllerMessage kind, const void* bytes, DWORD count) noexcept {
    const DWORD error = Authorize();
    return error ? error : WriteCellControllerMessage(pipe, kind, bytes, count, stop, IoDeadline());
  }
};
}
DWORD RunCellControllerClientSession(HANDLE pipe, HANDLE stop, ULONGLONG deadline,
  const CellControllerRequest& input, const CellControllerClientOwner& input_owner) noexcept {
  try {
    // Freeze caller-owned input before any callback can change the operation,
    // expected history, principals or callback table during the exchange.
    auto request = input;
    const auto owner = input_owner;
    const bool capacity = IsCellControllerCapacity(request.operation);
    const bool backing_capacity = IsCellControllerBackingCapacity(request.operation);
    const bool combined_install = IsCellControllerInstallCapacity(request.operation);
    const bool pool_metadata = IsCellControllerPoolCapacity(request.operation);
    const bool pool_capacity = pool_metadata && !combined_install;
    const bool inventory = IsCellControllerInventory(request.operation) && !pool_metadata;
    const bool creation = IsCellControllerCreation(request.operation);
    const bool runtime = IsCellControllerRuntime(request.operation);
    const bool installation = IsCellControllerInstall(request.operation);
    const bool installation_capacity = owner.installation_capacity.reserve != nullptr;
    if ((installation_capacity || owner.installation_capacity.context) &&
        (!installation_capacity || (request.operation != kCellControllerInstallOperation && !combined_install))) return ERROR_INVALID_STATE;
    if (combined_install && (!installation_capacity || !owner.connection)) return ERROR_INVALID_STATE;
    CellRuntimeInstallRequest install_request;
    if (!owner.context || !owner.authorize || !owner.checkpoint || !owner.receipt) return ERROR_INVALID_STATE;
    if (((creation && IsCellControllerVolume(request.operation)) || capacity || runtime) && !owner.volume_authority) return ERROR_INVALID_STATE;
    if (runtime && !owner.run_runtime) return ERROR_INVALID_STATE;
    if (installation && (!owner.installation_authority || !owner.installation_outcome ||
        DecodeCellRuntimeInstall(request.installation_bytes, {request.installation.nonce, request.installation.request_sha256}, &install_request))) return ERROR_INVALID_STATE;
    if (capacity && !combined_install && (pool_capacity ? !owner.pool_capacity : inventory ? !owner.inventory : backing_capacity ? !owner.backing_capacity : !owner.capacity)) return ERROR_INVALID_STATE;
    if (pool_metadata && !Nonzero(request.capture_nonce)) return ERROR_INVALID_DATA;
    CellFileSha256 pool_snapshot_sha256{}; std::size_t pool_members = 0;
    CellRuntimeCleanupAdmission cleanup_admission;
    if (IsCellControllerProtection(request.operation)) {
      CellFileSha256 policy{};
      if (HashCellVolumeRootSecurity(owner.owner_sid, owner.controller_sid, &policy)) return ERROR_INVALID_STATE;
    }
    Client client{pipe, stop, deadline, owner};
    if (runtime) client.maximum_wall_ms = 86400000;
    if (installation || capacity) client.maximum_wall_ms = 60000;
    DWORD error = client.Authorize();
    if (error) return error;
    CellControllerNonce hello{};
    if (BCryptGenRandom(nullptr, hello.data(), static_cast<ULONG>(hello.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 || !Nonzero(hello))
      return ERROR_GEN_FAILURE;
    request.nonce = hello;
    if (capacity) {
      // Helpers start without a connection nonce. Validate complete histories
      // only after creating this client's nonce, still before any pipe write.
      CellRuntimeCleanupSet decoded;
      CellControllerPoolHistory pool;
      CellRuntimePoolCleanupSet pool_cleanup;
      if (DecodeCellControllerCleanupAdmission(request, &cleanup_admission) ||
          DecodeCellControllerCleanup(request, request.cleanup_bytes, cleanup_admission.binding, owner.owner_sid, owner.controller_sid, &decoded) ||
          DecodeCellControllerPoolHistory(request.pool_history, request, owner.owner_sid, owner.controller_sid, &pool) ||
          DecodeCellRuntimePoolCleanup(request.pool_cleanup, request, owner.owner_sid, owner.controller_sid, &pool_cleanup)) return ERROR_INVALID_DATA;
      pool_snapshot_sha256 = pool.snapshot_sha256; pool_members = pool.members.size();
    }
    std::array<std::uint8_t, kCellControllerRequestBytes> wire{};
    if (!EncodeCellControllerRequest(request, &wire, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
    error = client.Send(CellControllerMessage::hello, hello.data(), static_cast<DWORD>(hello.size()));
    std::array<std::uint8_t, 64> welcome{};
    if (!error) error = ReadCellControllerMessage(pipe, CellControllerMessage::welcome, welcome.data(), static_cast<DWORD>(welcome.size()), stop, client.IoDeadline());
    if (!error) error = client.Authorize();
    if (error) return error;
    std::copy_n(welcome.begin() + 32, 32, client.nonce.begin());
    if (!std::equal(hello.begin(), hello.end(), welcome.begin()) || !Nonzero(client.nonce)) return ERROR_INVALID_DATA;
    if (owner.connection) {
      const auto authenticated_nonce = client.nonce;
      error = owner.connection(owner.context, authenticated_nonce);
      if (!error) error = client.Authorize();
      if (error) return error;
    }
    request.nonce = client.nonce;
    const auto now = GetTickCount64();
    if (now >= deadline || deadline - now < 100) return ERROR_TIMEOUT;
    request.wall_ms = static_cast<DWORD>(std::min<ULONGLONG>(request.wall_ms, deadline - now));
    if (!EncodeCellControllerRequest(request, &wire, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
    error = client.Send(CellControllerMessage::request, wire.data(), static_cast<DWORD>(wire.size()));
    if (!error && !creation && IsCellControllerVolume(request.operation)) {
      std::array<std::uint8_t, kCellControllerVolumeHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.volume_records.size(); ++index)
        std::copy(request.volume_records[index].begin(), request.volume_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::volume_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && !creation && IsCellControllerFormat(request.operation)) {
      std::array<std::uint8_t, kCellControllerFormatHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.format_records.size(); ++index)
        std::copy(request.format_records[index].begin(), request.format_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::format_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && !creation && IsCellControllerProtection(request.operation)) {
      std::array<std::uint8_t, kCellControllerProtectionHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.protection_records.size(); ++index)
        std::copy(request.protection_records[index].begin(), request.protection_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::protection_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && !creation && IsCellControllerMount(request.operation)) {
      std::array<std::uint8_t, kCellControllerMountHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.creation_records.size(); ++index)
        std::copy(request.creation_records[index].begin(), request.creation_records[index].end(), history.begin() + 32 + index * 1024);
      for (std::size_t index = 0; index < request.mount_records.size(); ++index)
        std::copy(request.mount_records[index].begin(), request.mount_records[index].end(), history.begin() + 32 + (5 + index) * 1024);
      error = client.Send(CellControllerMessage::mount_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && !creation && IsCellControllerMountedWorkspace(request.operation)) {
      std::array<std::uint8_t, kCellControllerMountedWorkspaceHistoryBytes> history{};
      std::copy(client.nonce.begin(), client.nonce.end(), history.begin());
      for (std::size_t index = 0; index < request.mounted_workspace_records.size(); ++index)
        std::copy(request.mounted_workspace_records[index].begin(), request.mounted_workspace_records[index].end(), history.begin() + 32 + index * 1024);
      error = client.Send(CellControllerMessage::mounted_workspace_history, history.data(), static_cast<DWORD>(history.size()));
    }
    if (!error && installation) {
      CellControllerRuntimeBindingBytes binding{};
      if (!EncodeCellControllerRuntimeBinding(client.nonce, request.installation, &binding)) return ERROR_INVALID_DATA;
      error = client.Send(CellControllerMessage::install_binding, binding.data(), static_cast<DWORD>(binding.size()));
      if (!error) error = client.Send(CellControllerMessage::install_request, request.installation_bytes.data(), static_cast<DWORD>(request.installation_bytes.size()));
    }
    if (!error && capacity) {
      CellControllerPoolHistory pool;
      if (DecodeCellControllerPoolHistory(request.pool_history, request, owner.owner_sid, owner.controller_sid, &pool)) return ERROR_INVALID_DATA;
      std::array<std::uint8_t, 32 + kCellControllerPoolHeaderBytes> header{};
      std::copy(client.nonce.begin(), client.nonce.end(), header.begin());
      std::copy_n(request.pool_history.begin(), kCellControllerPoolHeaderBytes, header.begin() + 32);
      error = client.Send(CellControllerMessage::pool_history_header, header.data(), static_cast<DWORD>(header.size()));
      for (std::size_t index = 0; index < pool.members.size() && !error; ++index) {
        std::array<std::uint8_t, 32 + kCellControllerPoolMemberFirstBytes> member{};
        std::copy(client.nonce.begin(), client.nonce.end(), member.begin());
        std::copy_n(request.pool_history.begin() + kCellControllerPoolHeaderBytes + index * kCellControllerPoolMemberBytes,
          kCellControllerPoolMemberFirstBytes, member.begin() + 32);
        error = client.Send(CellControllerMessage::pool_history_member, member.data(), static_cast<DWORD>(member.size()));
        std::array<std::uint8_t, 32 + kCellControllerPoolMemberBytes - kCellControllerPoolMemberFirstBytes> tail{};
        std::copy(client.nonce.begin(), client.nonce.end(), tail.begin());
        std::copy_n(request.pool_history.begin() + kCellControllerPoolHeaderBytes + index * kCellControllerPoolMemberBytes + kCellControllerPoolMemberFirstBytes,
          kCellControllerPoolMemberBytes - kCellControllerPoolMemberFirstBytes, tail.begin() + 32);
        if (!error) error = client.Send(CellControllerMessage::pool_history_member_tail, tail.data(), static_cast<DWORD>(tail.size()));
      }
    }
    if (!error && capacity) {
      std::array<std::uint8_t, 448> admission{};
      std::copy(client.nonce.begin(), client.nonce.end(), admission.begin());
      std::copy(request.cleanup_admission.begin(), request.cleanup_admission.end(), admission.begin() + 32);
      error = client.Send(CellControllerMessage::cleanup_admission, admission.data(), static_cast<DWORD>(admission.size()));
      std::array<std::uint8_t, 36> size{};
      std::copy(client.nonce.begin(), client.nonce.end(), size.begin());
      Put32(size.data() + 32, static_cast<std::uint32_t>(request.pool_cleanup.size()));
      if (!error) error = client.Send(CellControllerMessage::pool_cleanup_size, size.data(), static_cast<DWORD>(size.size()));
      for (std::size_t offset = 0; !error && offset < request.pool_cleanup.size(); offset += 4096) {
        const auto count = std::min<std::size_t>(4096, request.pool_cleanup.size() - offset);
        std::vector<std::uint8_t> chunk(36 + count);
        std::copy(client.nonce.begin(), client.nonce.end(), chunk.begin());
        Put32(chunk.data() + 32, static_cast<std::uint32_t>(offset));
        std::copy_n(request.pool_cleanup.begin() + offset, count, chunk.begin() + 36);
        error = client.Send(CellControllerMessage::pool_cleanup_chunk, chunk.data(), static_cast<DWORD>(chunk.size()));
      }
      if (!error && pool_metadata) {
        std::array<std::uint8_t, 64> binding{}; std::copy(client.nonce.begin(), client.nonce.end(), binding.begin());
        std::copy(request.capture_nonce.begin(), request.capture_nonce.end(), binding.begin() + 32);
        error = client.Send(CellControllerMessage::pool_capture_binding, binding.data(), 64);
        if (!error && IsCellControllerInstallCapacity(request.operation)) {
          if (!Nonzero(request.references_sha256)) return ERROR_INVALID_DATA;
          std::copy(request.references_sha256.begin(), request.references_sha256.end(), binding.begin() + 32);
          error = client.Send(CellControllerMessage::controller_attestation_context, binding.data(), 64);
        }
      }
    }
    if (!error && runtime) {
      CellControllerRuntimeBindingBytes binding{};
      if (!EncodeCellControllerRuntimeBinding(client.nonce, request.runtime, &binding)) return ERROR_INVALID_DATA;
      error = client.Send(CellControllerMessage::runtime_binding, binding.data(), static_cast<DWORD>(binding.size()));
    }
    if (error) return error;
    std::uint32_t count = 0, volume_checks = 0, authorized_volume_count = 0;
    std::uint32_t installation_checks = 0;
    bool installation_received = false;
    std::unique_ptr<CellInstallCapacityPipeClient> installation_reservation;
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
    CellProvisioningFootprint observation;
    CellProvisioningBackingFootprint backing_observation;
    CellProvisioningInventory inventory_observation;
    std::uint32_t inventory_count = 0;
    bool capacity_received = false;
    std::vector<std::uint8_t> pool_response;
    bool pool_reauthorized = false;
    bool cleanup_completed = false;
    bool runtime_completed = false;
    for (;;) {
      CellControllerMessage kind{}; std::array<std::uint8_t, 1056> reply{};
      error = client.Authorize();
      if (!error) error = ReadCellControllerReply(pipe, &kind, &reply, stop, client.IoDeadline());
      if (!error) error = client.Authorize();
      if (error) return error;
      if (!std::equal(client.nonce.begin(), client.nonce.end(), reply.begin())) return ERROR_INVALID_DATA;
      if (kind == CellControllerMessage::install_capacity_capture || kind == CellControllerMessage::install_capacity_authority) {
        if (!installation_capacity || count != 21 || !installation_checks || installation_received ||
            (combined_install && !cleanup_completed) ||
            previous != request.installation.checkpoint_sha256) return ERROR_INVALID_DATA;
        CellInstallCapacityChallenge challenge{}; std::copy_n(reply.begin(), challenge.size(), challenge.begin());
        if (kind == CellControllerMessage::install_capacity_capture) {
          if (installation_reservation) return ERROR_INVALID_DATA;
          installation_reservation = std::make_unique<CellInstallCapacityPipeClient>(pipe, stop, deadline, client.nonce,
            CellRuntimeInstallBinding{request.installation.nonce, request.installation.request_sha256},
            CellFootprintScanGuard{[](void* raw) noexcept -> DWORD { return static_cast<Client*>(raw)->Authorize(); }, &client, stop});
          error = installation_reservation->BeginReceived(owner.installation_capacity, challenge);
        } else {
          if (!installation_reservation) return ERROR_INVALID_DATA;
          error = installation_reservation->ReplyReceived(challenge);
        }
        if (error) return error;
        continue;
      }
      if (kind == CellControllerMessage::install_outcome) {
        if (!installation || installation_received || count != 21 || installation_checks < 2 ||
            (installation_capacity && !installation_reservation) ||
            !std::equal(install_request.binding.nonce.begin(), install_request.binding.nonce.end(), reply.begin() + 40) ||
            !std::equal(install_request.binding.request_sha256.begin(), install_request.binding.request_sha256.end(), reply.begin() + 72) ||
            !std::equal(previous.begin(), previous.end(), reply.begin() + 104)) return ERROR_INVALID_DATA;
        std::array<std::uint8_t, 352> evidence{}; std::copy_n(reply.begin() + 32, 352, evidence.begin());
        error = owner.installation_outcome(owner.context, evidence);
        std::array<std::uint8_t, 64> acknowledgement{}; std::copy(client.nonce.begin(), client.nonce.end(), acknowledgement.begin());
        std::copy_n(evidence.begin() + 320, 32, acknowledgement.begin() + 32);
        if (!error) error = client.Send(CellControllerMessage::install_outcome_received, acknowledgement.data(), 64);
        if (error) return error;
        installation_received = true; continue;
      }
      if (kind == CellControllerMessage::install_authority) {
        const auto ordinal = U32(reply.data() + 128);
        if (!installation || installation_received || count != 21 || installation_checks >= 65536 || ordinal != installation_checks + 1 ||
            U32(reply.data() + 132) != 1 || previous != request.installation.checkpoint_sha256 ||
            !std::equal(request.installation.nonce.begin(), request.installation.nonce.end(), reply.begin() + 32) ||
            !std::equal(request.installation.request_sha256.begin(), request.installation.request_sha256.end(), reply.begin() + 64) ||
            !std::equal(previous.begin(), previous.end(), reply.begin() + 96)) return ERROR_INVALID_DATA;
        ++installation_checks;
        error = owner.installation_authority(owner.context, install_request, ordinal);
        if (!error) error = client.Send(CellControllerMessage::install_authorized, reply.data(), 136);
        if (error) return error;
        continue;
      }
      if (kind == CellControllerMessage::volume_authority) {
        const auto ordinal = U32(reply.data() + 32), observed = U32(reply.data() + 36);
        if ((capacity_received && !pool_capacity) || runtime_completed || (!capacity && !runtime && (!creation || !IsCellControllerVolume(request.operation))) ||
            volume_checks >= kCellControllerMaximumVolumeChecks || ordinal != volume_checks + 1 ||
            observed != count || count < 5 || count > CellControllerCheckpointLimit(request.operation) || ((capacity || runtime) && count != 21) ||
            !std::equal(previous.begin(), previous.end(), reply.begin() + 40)) return ERROR_INVALID_DATA;
        ++volume_checks;
        error = owner.volume_authority(owner.context, ordinal, count, previous);
        if (!error) error = client.Send(CellControllerMessage::volume_authorized, reply.data(), 72);
        if (error) return error;
        authorized_volume_count = count;
        if (pool_capacity && capacity_received) pool_reauthorized = true;
        continue;
      }
      if (kind == CellControllerMessage::cleanup_ready) {
        if (!capacity || cleanup_completed || capacity_received || count != 21 || !volume_checks || authorized_volume_count != count) return ERROR_INVALID_DATA;
        CellControllerRuntimeBindingBytes bytes{}; CellControllerRuntimeBinding binding;
        std::copy_n(reply.begin(), bytes.size(), bytes.begin());
        const CellControllerRuntimeBinding expected{cleanup_admission.binding.challenge, cleanup_admission.binding.set_sha256, previous};
        if (!DecodeCellControllerRuntimeBinding(client.nonce, bytes, &binding) || binding != expected) return ERROR_INVALID_DATA;
        const CellFootprintScanGuard local{[](void* raw) noexcept -> DWORD { return static_cast<Client*>(raw)->Authorize(); }, &client, stop};
        CellRuntimeCleanupTransfer transfer(pipe, deadline, cleanup_admission.binding, local);
        error = transfer.Write(request.cleanup_bytes);
        if (!error) error = client.Authorize();
        if (error) return error;
        cleanup_completed = true; continue;
      }
      if (kind == CellControllerMessage::runtime_ready) {
        if (!runtime || runtime_completed || count != 21 || !volume_checks || authorized_volume_count != count || previous != request.runtime.checkpoint_sha256) return ERROR_INVALID_DATA;
        CellControllerRuntimeBindingBytes bytes{}; CellControllerRuntimeBinding binding;
        std::copy_n(reply.begin(), bytes.size(), bytes.begin());
        if (!DecodeCellControllerRuntimeBinding(client.nonce, bytes, &binding) || binding != request.runtime) return ERROR_INVALID_DATA;
        const auto completed = owner.run_runtime(owner.context, pipe, stop, deadline, binding);
        if (completed.error) return completed.error;
        if (!completed.request_acknowledged || !completed.input_ended || !completed.output_ended || !completed.result_received ||
            !completed.retention_attempted || !completed.retention_confirmed || !completed.retention_receipt_sent || !completed.execution.binding_verified ||
            completed.execution.binding.nonce != binding.nonce || completed.execution.binding.request_sha256 != binding.request_sha256) return ERROR_INVALID_DATA;
        error = client.Authorize(); if (error) return error;
        runtime_completed = true; continue;
      }
      if (kind == CellControllerMessage::pool_capacity_ready) {
        if (!pool_capacity || !cleanup_completed || capacity_received || count != 21 || !volume_checks || authorized_volume_count != count ||
            !std::equal(request.capture_nonce.begin(), request.capture_nonce.end(), reply.begin() + 32)) return ERROR_INVALID_DATA;
        error = ReadCellPoolCapacityResponse(pipe, deadline, client.nonce,
          {[](void* raw) noexcept -> DWORD { return static_cast<Client*>(raw)->Authorize(); }, &client, stop}, &pool_response);
        if (error) return error;
        if (U32(pool_response.data() + 8) != 1 || U32(pool_response.data() + 12) != pool_members || U32(pool_response.data() + 20) != 0 ||
            !std::equal(pool_snapshot_sha256.begin(), pool_snapshot_sha256.end(), pool_response.begin() + 56) ||
            !std::equal(request.plan.assignment_binding.begin(), request.plan.assignment_binding.end(), pool_response.begin() + 96) ||
            !std::equal(request.plan.profile_sha256.begin(), request.plan.profile_sha256.end(), pool_response.begin() + 128) ||
            !std::equal(request.capture_nonce.begin(), request.capture_nonce.end(), pool_response.begin() + 480)) return ERROR_INVALID_DATA;
        capacity_received = true; pool_reauthorized = false; continue;
      }
      if (kind == CellControllerMessage::capacity_observation) {
        if (!capacity || !cleanup_completed || backing_capacity || inventory || capacity_received || count != 21 || !volume_checks || authorized_volume_count != count) return ERROR_INVALID_DATA;
        CellControllerCapacityBytes bytes{};
        std::copy_n(reply.begin(), bytes.size(), bytes.begin());
        if (!DecodeCellControllerCapacity(client.nonce, bytes, &observation) ||
            !MatchesCellControllerCapacity(request, observation, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
        capacity_received = true;
        continue;
      }
      if (kind == CellControllerMessage::backing_capacity_observation) {
        if (!backing_capacity || !cleanup_completed || capacity_received || count != 21 || !volume_checks || authorized_volume_count != count) return ERROR_INVALID_DATA;
        CellControllerBackingCapacityBytes bytes{};
        std::copy_n(reply.begin(), bytes.size(), bytes.begin());
        if (!DecodeCellControllerBackingCapacity(client.nonce, bytes, &backing_observation) ||
            !MatchesCellControllerBackingCapacity(request, backing_observation, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
        capacity_received = true;
        continue;
      }
      if (kind == CellControllerMessage::inventory_observation) {
        if (!inventory || !cleanup_completed || capacity_received || count != 21 || !volume_checks || authorized_volume_count != count) return ERROR_INVALID_DATA;
        CellControllerCapacityBytes bytes{};
        std::copy_n(reply.begin(), bytes.size(), bytes.begin());
        auto summary_request = request; summary_request.operation = kCellControllerCapacityOperation;
        if (!DecodeCellControllerCapacity(client.nonce, bytes, &observation) ||
            !MatchesCellControllerCapacity(summary_request, observation, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
        inventory_observation = {observation.anchor, observation.assignment_binding, observation.profile_sha256,
          observation.checkpoint_sha256, observation.workspace, {observation.footprint, {}}};
        inventory_count = observation.footprint.file_count + observation.footprint.directory_count;
        inventory_observation.inventory.entries.reserve(inventory_count);
        capacity_received = true;
        continue;
      }
      if (kind == CellControllerMessage::inventory_chunk) {
        if (!inventory || !capacity_received) return ERROR_INVALID_DATA;
        CellControllerInventoryChunkBytes bytes{};
        std::copy_n(reply.begin(), bytes.size(), bytes.begin());
        CellControllerInventoryChunk chunk;
        auto& entries = inventory_observation.inventory.entries;
        if (!DecodeCellControllerInventoryChunk(client.nonce, bytes, &chunk) || chunk.start != entries.size() ||
            chunk.count != std::min<std::size_t>(kCellControllerInventoryChunkEntries, inventory_count - entries.size())) return ERROR_INVALID_DATA;
        entries.insert(entries.end(), chunk.entries.begin(), chunk.entries.begin() + chunk.count);
        continue;
      }
      if (kind == CellControllerMessage::receipt) {
        std::array<std::uint8_t, 16> receipt{}; std::copy_n(reply.begin() + 32, 16, receipt.begin());
        const auto native_error = U32(receipt.data()), phase = U32(receipt.data() + 4), attempted = U32(receipt.data() + 8);
        const bool volume = IsCellControllerVolume(request.operation);
        const auto maximum = CellControllerCheckpointLimit(request.operation);
        if (installation && !native_error && (installation_checks < 2 || !installation_received)) return ERROR_INVALID_DATA;
        if (capacity && !combined_install && (native_error ? capacity_received : (!capacity_received || authorized_volume_count != count))) return ERROR_INVALID_DATA;
        if (pool_capacity && !native_error && !pool_reauthorized) return ERROR_INVALID_DATA;
        if (runtime && !native_error && !runtime_completed) return ERROR_INVALID_DATA;
        if (!native_error && creation && volume && authorized_volume_count != count) return ERROR_INVALID_DATA;
        if (U32(receipt.data() + 12) != count || phase > 5 || phase < std::min(count, 5u) || attempted > 1 ||
            (!creation && attempted) || (!native_error && ((volume ? (phase != 5 || count != maximum) :
            (phase != count || (count != 1 && count != 3 && count != 5))) ||
            (creation && (count != maximum || attempted != 1))))) return ERROR_INVALID_DATA;
        if (capacity_received) {
          if (inventory && !MatchesCellControllerInventory(request, inventory_observation, owner.owner_sid, owner.controller_sid)) return ERROR_INVALID_DATA;
          error = pool_capacity ? owner.pool_capacity(owner.context, client.nonce, pool_response) : inventory ? owner.inventory(owner.context, client.nonce, inventory_observation) :
            backing_capacity ? owner.backing_capacity(owner.context, client.nonce, backing_observation) : owner.capacity(owner.context, client.nonce, observation);
          if (!error) error = client.Authorize();
          if (error) return error;
        }
        error = owner.receipt(owner.context, receipt);
        if (!error) error = client.Send(CellControllerMessage::finish, client.nonce.data(), static_cast<DWORD>(client.nonce.size()));
        return error;
      }
      if (kind != CellControllerMessage::checkpoint || capacity_received) return ERROR_INVALID_DATA;
      CellProvisioningRecord record{}; std::copy_n(reply.begin() + 32, record.size(), record.begin());
      CellFileSha256 digest{};
      if (count >= CellControllerCheckpointLimit(request.operation) || !RecordHash(record, &digest) ||
          !std::equal(digest.begin(), digest.end(), record.begin() + 992)) return ERROR_INVALID_DATA;
      if (count < 5) {
        creation_records.push_back(record);
        if (!creation && IsCellControllerMount(request.operation) && record != request.creation_records[count]) return ERROR_INVALID_DATA;
        if (IsCellControllerProtection(request.operation) &&
            (!MatchesSid(record.data() + 232, owner.owner_sid) || !MatchesSid(record.data() + 416, owner.controller_sid))) return ERROR_INVALID_DATA;
        if (std::memcmp(record.data(), "GCCELLP1", 8) || U32(record.data() + 8) != count + 1 || U32(record.data() + 12) != count + 1 ||
          !std::equal(previous.begin(), previous.end(), record.begin() + 16) ||
          !std::equal(wire.begin() + 80, wire.begin() + 144, record.begin() + 48) ||
          !std::equal(wire.begin() + 144, wire.begin() + 176, record.begin() + 112) ||
          !std::equal(wire.begin() + 176, wire.begin() + 200, record.begin() + 144) ||
          !std::equal(wire.begin() + 40, wire.begin() + 80, record.begin() + 192)) return ERROR_INVALID_DATA;
      if (!count) {
        std::copy_n(record.begin() + 168, 24, journal.begin());
        if (!creation && (!std::equal(journal.begin(), journal.end(), wire.begin() + 200) || digest != request.anchor.prepared_sha256))
          return ERROR_INVALID_DATA;
      } else if (!std::equal(journal.begin(), journal.end(), record.begin() + 168)) return ERROR_INVALID_DATA;
        if (count == 4) {
          disk.control = Identity(record.data() + 624); disk.backing = Identity(record.data() + 696); disk_recorded = digest;
          if (IsCellControllerMount(request.operation)) {
            CellProvisioningAnchor captured; captured.file = Identity(journal.data());
            std::copy_n(creation_records.front().begin() + 992, 32, captured.prepared_sha256.begin());
            if (ValidateCellProvisioningHistory(request.plan, request.parent, request.cell_name, owner.owner_sid, owner.controller_sid,
                captured, creation_records, &workspace, &disk, &disk_recorded)) return ERROR_INVALID_DATA;
          }
        }
      } else if (count < 11) {
        if (creation && authorized_volume_count != count) return ERROR_INVALID_DATA;
        volume_records.push_back(record);
        if (ValidateCellVolumeProvisioningPrefix(request.plan, Identity(journal.data()), disk, disk_recorded, volume_records) ||
            (!creation && record != request.volume_records[count - 5])) return ERROR_INVALID_DATA;
      } else if (count < 13) {
        if (creation && authorized_volume_count != count) return ERROR_INVALID_DATA;
        format_records.push_back(record);
        if (ValidateCellFormatProvisioningPrefix(request.plan, Identity(journal.data()), disk, disk_recorded, volume_records, format_records) ||
            (!creation && record != request.format_records[count - 11])) return ERROR_INVALID_DATA;
      } else if (count < 15) {
        if (creation && authorized_volume_count != count) return ERROR_INVALID_DATA;
        protection_records.push_back(record);
        if (ValidateCellProtectionProvisioningPrefix(request.plan, Identity(journal.data()), disk, disk_recorded,
            owner.owner_sid, owner.controller_sid, volume_records, format_records, protection_records) ||
            (!creation && record != request.protection_records[count - 13])) return ERROR_INVALID_DATA;
      } else if (count < 19) {
        if (creation && authorized_volume_count != count) return ERROR_INVALID_DATA;
        mount_records.push_back(record);
        if (ValidateCellMountProvisioningPrefix(request.plan, Identity(journal.data()), workspace, disk, disk_recorded,
            owner.owner_sid, owner.controller_sid, volume_records, format_records, protection_records, mount_records) ||
            (!creation && record != request.mount_records[count - 15])) return ERROR_INVALID_DATA;
      } else {
        if (creation && authorized_volume_count != count) return ERROR_INVALID_DATA;
        workspace_records.push_back(record);
        if (ValidateCellMountedWorkspaceProvisioningPrefix(request.plan, Identity(journal.data()), workspace, disk, disk_recorded,
            request.cell_name, owner.owner_sid, owner.controller_sid, volume_records, format_records, protection_records, mount_records, workspace_records) ||
            (!creation && record != request.mounted_workspace_records[count - 19])) return ERROR_INVALID_DATA;
      }
      CellFileSha256 committed{};
      error = owner.checkpoint(owner.context, record, creation, &committed);
      if (error) return error;
      ++count; previous = digest;
      if (creation) {
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
