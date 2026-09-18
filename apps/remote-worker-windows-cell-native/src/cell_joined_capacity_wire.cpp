#include "cell_joined_capacity_wire.hpp"
#include "cell_security.hpp"
#include "cell_pool_capacity.hpp"
#include <algorithm>
#include <limits>
#include <set>
#include <cstring>

namespace goatcitadel::worker_cell {
namespace {
void ResponsePut(std::uint8_t* bytes, std::uint32_t value) noexcept {
  for (unsigned i = 0; i < 4; ++i) bytes[i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint32_t ResponseU32(const std::uint8_t* bytes) noexcept {
  std::uint32_t value = 0; for (unsigned i = 0; i < 4; ++i) value |= std::uint32_t(bytes[i]) << (8 * i); return value;
}
DWORD ResponseCurrent(const CellFootprintScanGuard& guard, ULONGLONG deadline) noexcept {
  const auto check = [&]() -> DWORD {
    if (guard.cancellation && WaitForSingleObject(guard.cancellation, 0) != WAIT_TIMEOUT) return ERROR_CANCELLED;
    return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
  };
  if (!guard.authorize) return ERROR_INVALID_PARAMETER;
  auto error = check(); if (!error) error = guard.authorize(guard.context); return error ? error : check();
}
bool ResponseHeader(std::span<const std::uint8_t> bytes, const CellControllerNonce& nonce) noexcept {
  return bytes.size() >= 88 + 384 + 840 && bytes.size() <= kCellPoolCapacityResponseMaximumBytes &&
    !std::memcmp(bytes.data(), "GCPRESP1", 8) && std::equal(nonce.begin(), nonce.end(), bytes.begin() + 24);
}
bool ResponseParameters(const CellControllerNonce& nonce, ULONGLONG deadline) noexcept {
  const auto now = GetTickCount64();
  return std::any_of(nonce.begin(), nonce.end(), [](auto byte) { return byte != 0; }) && deadline > now && deadline - now <= 60000;
}
}
DWORD WriteCellPoolCapacityResponse(HANDLE pipe, ULONGLONG deadline, const CellControllerNonce& supplied_nonce,
  const CellFootprintScanGuard& supplied_guard, std::span<const std::uint8_t> supplied) noexcept {
  const auto nonce = supplied_nonce; const auto guard = supplied_guard;
  if (!ResponseParameters(nonce, deadline) || !ResponseHeader(supplied, nonce)) return ERROR_INVALID_PARAMETER;
  try {
    // Freeze before invoking authority callbacks, which may re-enter owners.
    const std::vector<std::uint8_t> bytes(supplied.begin(), supplied.end());
    std::array<std::uint8_t, 36> header{}; std::copy(nonce.begin(), nonce.end(), header.begin());
    ResponsePut(header.data() + 32, static_cast<std::uint32_t>(bytes.size()));
    auto error = ResponseCurrent(guard, deadline);
    if (!error) error = WriteCellControllerMessage(pipe, CellControllerMessage::pool_capacity_size, header.data(), 36, guard.cancellation, deadline);
    if (!error) error = ResponseCurrent(guard, deadline);
    for (std::size_t offset = 0; !error && offset < bytes.size();) {
      const auto count = std::min<std::size_t>(4096, bytes.size() - offset);
      std::array<std::uint8_t, 36 + 4096> chunk{}; std::copy(nonce.begin(), nonce.end(), chunk.begin());
      ResponsePut(chunk.data() + 32, static_cast<std::uint32_t>(offset)); std::copy_n(bytes.begin() + offset, count, chunk.begin() + 36);
      error = ResponseCurrent(guard, deadline);
      if (!error) error = WriteCellControllerMessage(pipe, CellControllerMessage::pool_capacity_chunk, chunk.data(), static_cast<DWORD>(36 + count), guard.cancellation, deadline);
      if (!error) error = ResponseCurrent(guard, deadline);
      offset += count;
    }
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD ReadCellPoolCapacityResponse(HANDLE pipe, ULONGLONG deadline, const CellControllerNonce& supplied_nonce,
  const CellFootprintScanGuard& supplied_guard, std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto nonce = supplied_nonce; const auto guard = supplied_guard; output->clear();
  if (!ResponseParameters(nonce, deadline)) return ERROR_INVALID_PARAMETER;
  try {
    std::array<std::uint8_t, 36> header{};
    auto error = ResponseCurrent(guard, deadline);
    if (!error) error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_capacity_size, header.data(), 36, guard.cancellation, deadline);
    if (!error) error = ResponseCurrent(guard, deadline);
    if (error) return error;
    const auto size = ResponseU32(header.data() + 32);
    if (!std::equal(nonce.begin(), nonce.end(), header.begin()) || size < 88 + 384 + 840 || size > kCellPoolCapacityResponseMaximumBytes) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes(size);
    for (std::size_t offset = 0; offset < bytes.size();) {
      const auto count = std::min<std::size_t>(4096, bytes.size() - offset);
      std::array<std::uint8_t, 36 + 4096> chunk{};
      error = ResponseCurrent(guard, deadline);
      if (!error) error = ReadCellControllerMessage(pipe, CellControllerMessage::pool_capacity_chunk, chunk.data(), static_cast<DWORD>(36 + count), guard.cancellation, deadline);
      if (!error) error = ResponseCurrent(guard, deadline);
      if (error) return error;
      if (!std::equal(nonce.begin(), nonce.end(), chunk.begin()) || ResponseU32(chunk.data() + 32) != offset) return ERROR_INVALID_DATA;
      std::copy_n(chunk.begin() + 36, count, bytes.begin() + offset); offset += count;
    }
    if (!ResponseHeader(bytes, nonce)) return ERROR_INVALID_DATA;
    error = ResponseCurrent(guard, deadline); if (error) return error;
    *output = std::move(bytes); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD EncodeCellPoolCapacityResponse(const CellControllerRequest& retained,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellCapacityLayoutRecord& layout, const CellFileSha256& capture_nonce,
  const CellPoolJoinedCapacity& observation, std::vector<std::uint8_t>* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  output->clear();
  try {
    CellPoolJoinedCapacityBytes encoded;
    auto error = EncodeCellPoolJoinedCapacity(retained, owner_sid, controller_sid, layout, capture_nonce, observation, &encoded);
    if (error) return error;
    std::size_t size = 88 + encoded.layout.size() + encoded.host.size(), chunks = 0;
    if (encoded.members.empty() || encoded.members.size() > 64) return ERROR_INVALID_DATA;
    for (const auto& member : encoded.members) {
      if (member.guest_chunks.empty() || member.guest_chunks.size() > 1063 - chunks) return ERROR_INVALID_DATA;
      chunks += member.guest_chunks.size();
      size += 8 + member.guest.size() + member.backing.size() + member.guest_chunks.size() * 1000;
    }
    if (size > kCellPoolCapacityResponseMaximumBytes) return ERROR_INVALID_DATA;
    std::vector<std::uint8_t> bytes(size);
    const auto put = [&](std::size_t offset, std::uint32_t value) {
      for (unsigned i = 0; i < 4; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
    };
    std::memcpy(bytes.data(), "GCPRESP1", 8); put(8, 1); put(12, static_cast<std::uint32_t>(encoded.members.size()));
    put(16, static_cast<std::uint32_t>(encoded.host.size())); // reserved word at 20 stays zero.
    std::copy(retained.nonce.begin(), retained.nonce.end(), bytes.begin() + 24);
    std::copy(encoded.pool_sha256.begin(), encoded.pool_sha256.end(), bytes.begin() + 56);
    std::size_t position = 88;
    const auto append = [&](const auto& input) {
      std::copy(input.begin(), input.end(), bytes.begin() + position); position += input.size();
    };
    append(encoded.layout); append(encoded.host);
    for (std::size_t i = 0; i < encoded.members.size(); ++i) {
      const auto& member = encoded.members[i];
      put(position, static_cast<std::uint32_t>(i)); put(position + 4, static_cast<std::uint32_t>(member.guest_chunks.size())); position += 8;
      append(member.guest); append(member.backing);
      for (const auto& chunk : member.guest_chunks) append(chunk);
    }
    if (position != bytes.size()) return ERROR_INVALID_DATA;
    *output = std::move(bytes); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD EncodeCellPoolJoinedCapacity(const CellControllerRequest& retained,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellCapacityLayoutRecord& layout, const CellFileSha256& supplied_nonce,
  const CellPoolJoinedCapacity& observation, CellPoolJoinedCapacityBytes* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto nonce = supplied_nonce;
  *output = {};
  try {
    CellControllerPoolHistory pool;
    auto error = DecodeCellControllerPoolHistory(retained.pool_history, retained, owner_sid, controller_sid, &pool);
    if (error) return error;
    if (!IsCellControllerInventory(retained.operation) ||
        layout.assignment_binding != retained.plan.assignment_binding || layout.profile_sha256 != retained.plan.profile_sha256 ||
        observation.host.backings.size() != pool.members.size() || observation.guests.size() != pool.members.size()) return ERROR_INVALID_DATA;
    std::size_t entries = 0;
    for (const auto& area : observation.host.areas) {
      if (area.entries.size() > 20000 - entries) return ERROR_INVALID_DATA;
      entries += area.entries.size();
    }
    for (const auto& guest : observation.guests) {
      if (guest.inventory.entries.size() > 20000 - entries) return ERROR_INVALID_DATA;
      entries += guest.inventory.entries.size();
    }
    CellPoolJoinedCapacityBytes bytes; bytes.pool_sha256 = pool.snapshot_sha256;
    error = EncodeCellCapacityLayout(layout, &bytes.layout);
    if (!error) error = EncodeCellCapacityCapture(layout, nonce, observation.host.areas, &bytes.host);
    if (error) return error;
    // The host encoder verifies root identities, unique objects and totals.
    // Every admitted member must locate its original host objects in that one
    // capture; a complete-looking guest cannot substitute an unrelated tree.
    const auto find = [&](const CellFileIdentity& identity) -> const CellDirectoryInventoryEntry* {
      for (const auto& area : observation.host.areas)
        for (const auto& entry : area.entries) if (entry.identity == identity) return &entry;
      return nullptr;
    };
    const auto file = [&](const CellFileIdentity& identity, std::uint64_t logical, std::uint64_t allocated) {
      const auto* entry = find(identity);
      return entry && !entry->directory && entry->logical_file_bytes == logical && entry->allocated_bytes == allocated;
    };
    const auto directory = [&](const CellFileIdentity& identity) {
      const auto* entry = find(identity); return entry && entry->directory;
    };
    std::set<std::uint64_t> guest_volumes;
    for (std::size_t index = 0; index < pool.members.size(); ++index) {
      const auto& member = pool.members[index]; const auto& guest = observation.guests[index];
      const auto& backing = observation.host.backings[index];
      auto backing_request = member; backing_request.operation = kCellControllerBackingCapacityOperation;
      if (!MatchesCellControllerInventory(member, guest, owner_sid, controller_sid) ||
          !MatchesCellControllerBackingCapacity(backing_request, backing, owner_sid, controller_sid) ||
          guest.inventory.footprint.allocated_bytes > backing.backing.record.spec.virtual_bytes ||
          !guest_volumes.insert(guest.inventory.footprint.root.volume_serial).second ||
          std::any_of(layout.roots.begin(), layout.roots.end(), [&](const auto& root) { return root.volume_serial == guest.inventory.footprint.root.volume_serial; }) ||
          !file(backing.anchor.file, backing.journal_bytes, backing.journal_allocated_bytes) ||
          !file(backing.backing.record.backing, backing.backing.file_bytes, backing.backing.allocated_bytes) ||
          !directory(backing.workspace.parent) ||
          !std::all_of(backing.workspace.directories.begin(), backing.workspace.directories.end(), directory)) return ERROR_INVALID_DATA;
      CellJoinedCapacityMemberBytes encoded;
      const CellProvisioningFootprint summary{guest.anchor, guest.assignment_binding, guest.profile_sha256,
        guest.checkpoint_sha256, guest.workspace, guest.inventory.footprint};
      if (!EncodeCellControllerCapacity(retained.nonce, summary, &encoded.guest) ||
          !EncodeCellControllerBackingCapacity(retained.nonce, backing, &encoded.backing)) return ERROR_INVALID_DATA;
      const auto all = std::span<const CellDirectoryInventoryEntry>(guest.inventory.entries);
      for (std::size_t start = 0; start < all.size(); start += kCellControllerInventoryChunkEntries) {
        CellControllerInventoryChunkBytes chunk{};
        if (!EncodeCellControllerInventoryChunk(retained.nonce, static_cast<std::uint32_t>(start),
            all.subspan(start, std::min(kCellControllerInventoryChunkEntries, all.size() - start)), &chunk)) return ERROR_INVALID_DATA;
        encoded.guest_chunks.push_back(chunk);
      }
      bytes.members.push_back(std::move(encoded));
    }
    *output = std::move(bytes); return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD EncodeCellJoinedCapacity(const CellControllerRequest& retained,
  const std::wstring& owner_sid, const std::wstring& controller_sid,
  const CellCapacityLayoutRecord& layout, const CellFileSha256& supplied_nonce,
  const CellProvisioningJoinedCapacity& observation, CellJoinedCapacityBytes* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  const auto nonce = supplied_nonce;
  *output = {};
  try {
    // The operation selectors below validate the same independently retained
    // history against each existing frame; they do not authorize a request.
    if (retained.operation != kCellControllerInventoryOperation ||
        layout.assignment_binding != retained.plan.assignment_binding ||
        layout.profile_sha256 != retained.plan.profile_sha256 ||
        !MatchesCellControllerInventory(retained, observation.guest, owner_sid, controller_sid)) return ERROR_INVALID_DATA;
    auto backing_request = retained;
    backing_request.operation = kCellControllerBackingCapacityOperation;
    const auto& backing = observation.host.backing;
    if (!MatchesCellControllerBackingCapacity(backing_request, backing, owner_sid, controller_sid) ||
        observation.guest.inventory.footprint.allocated_bytes > backing.backing.record.spec.virtual_bytes)
      return ERROR_INVALID_DATA;
    std::size_t entries = observation.guest.inventory.entries.size();
    if (entries > 20000) return ERROR_INVALID_DATA;
    for (std::size_t index = 0; index < layout.roots.size(); ++index) {
      const auto count = observation.host.areas[index].entries.size();
      if (layout.roots[index].volume_serial == observation.guest.inventory.footprint.root.volume_serial ||
          count > 20000 - entries) return ERROR_INVALID_DATA;
      entries += count;
    }
    CellJoinedCapacityBytes bytes;
    auto error = EncodeCellCapacityLayout(layout, &bytes.layout);
    if (!error) error = EncodeCellCapacityCapture(layout, nonce, observation.host.areas, &bytes.host);
    if (error) return error;
    // The host encoder has already established globally unique identities,
    // exact totals and directory roots. Require the original journal, backing
    // file and host directories rather than accepting unrelated valid trees.
    const auto find = [&](const CellFileIdentity& identity) -> const CellDirectoryInventoryEntry* {
      for (const auto& area : observation.host.areas)
        for (const auto& entry : area.entries) if (entry.identity == identity) return &entry;
      return nullptr;
    };
    const auto file = [&](const CellFileIdentity& identity, std::uint64_t logical, std::uint64_t allocated) {
      const auto* entry = find(identity);
      return entry && !entry->directory && entry->logical_file_bytes == logical && entry->allocated_bytes == allocated;
    };
    if (!file(backing.anchor.file, backing.journal_bytes, backing.journal_allocated_bytes) ||
        !file(backing.backing.record.backing, backing.backing.file_bytes, backing.backing.allocated_bytes)) return ERROR_INVALID_DATA;
    const auto directory = [&](const CellFileIdentity& identity) {
      const auto* entry = find(identity); return entry && entry->directory;
    };
    if (!directory(backing.workspace.parent) ||
        !std::all_of(backing.workspace.directories.begin(), backing.workspace.directories.end(), directory)) return ERROR_INVALID_DATA;
    const auto& guest = observation.guest;
    const CellProvisioningFootprint summary{guest.anchor, guest.assignment_binding, guest.profile_sha256,
      guest.checkpoint_sha256, guest.workspace, guest.inventory.footprint};
    if (!EncodeCellControllerCapacity(retained.nonce, summary, &bytes.guest) ||
        !EncodeCellControllerBackingCapacity(retained.nonce, backing, &bytes.backing)) return ERROR_INVALID_DATA;
    const auto all = std::span<const CellDirectoryInventoryEntry>(guest.inventory.entries);
    for (std::size_t start = 0; start < all.size(); start += kCellControllerInventoryChunkEntries) {
      CellControllerInventoryChunkBytes chunk{};
      if (!EncodeCellControllerInventoryChunk(retained.nonce, static_cast<std::uint32_t>(start),
          all.subspan(start, std::min(kCellControllerInventoryChunkEntries, all.size() - start)), &chunk)) return ERROR_INVALID_DATA;
      bytes.guest_chunks.push_back(chunk);
    }
    *output = std::move(bytes);
    return ERROR_SUCCESS;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}

struct CellJoinedCapacityCollector::NativeContext final {
  CellProvisioningJournal& journal;
  CellCapacityLayout& layout;
  std::uint64_t lifetime;
  CellCapacityAreaRoots roots;
  std::vector<std::uint8_t> descriptor;
  CellCapacityRootSecurity security;
  static DWORD Matches(void* raw, const CellJoinedCapacityReference& reference) noexcept {
    const auto& self = *static_cast<NativeContext*>(raw);
    const auto& journal = self.journal; const auto& expected = reference.history;
    if (!journal.healthy_ || journal.capacity_close_pending_ || self.lifetime == std::numeric_limits<std::uint64_t>::max() ||
        journal.lifetime_revision_ != self.lifetime || !self.layout.open_ || self.layout.interrupted_) return ERROR_INVALID_STATE;
    if (journal.anchor_ != expected.anchor || journal.name_ != expected.cell_name ||
        journal.owner_ != reference.owner_sid || journal.controller_ != reference.controller_sid ||
        journal.workspace_record_.parent != expected.parent || self.layout.record_ != reference.layout || self.layout.descriptor_ != self.descriptor ||
        self.layout.security_.context != self.security.context || self.layout.security_.verify != self.security.verify ||
        journal.plan_.assignment_binding != expected.plan.assignment_binding || journal.plan_.profile_sha256 != expected.plan.profile_sha256 ||
        !IsEqualGUID(journal.plan_.disk.identifier, expected.plan.disk.identifier) ||
        journal.plan_.disk.virtual_bytes != expected.plan.disk.virtual_bytes || journal.plan_.disk.reserved_file_bytes != expected.plan.disk.reserved_file_bytes ||
        journal.mounted_workspace_phase_ != CellMountedWorkspaceProvisioningPhase::recorded || journal.records_.size() != 21 * 1024)
      return ERROR_FILE_INVALID;
    for (std::size_t i = 0; i < self.roots.size(); ++i)
      if (self.roots[i].handle != self.layout.roots_[i].handle || self.roots[i].identity != self.layout.roots_[i].identity) return ERROR_FILE_INVALID;
    std::size_t offset = 0;
    const auto same = [&](const auto& records) {
      for (const auto& record : records) {
        if (!std::equal(record.begin(), record.end(), journal.records_.begin() + offset)) return false;
        offset += record.size();
      }
      return true;
    };
    return same(expected.creation_records) && same(expected.volume_records) && same(expected.format_records) &&
      same(expected.protection_records) && same(expected.mount_records) && same(expected.mounted_workspace_records) ? ERROR_SUCCESS : ERROR_CRC;
  }
  static DWORD Verify(void* raw, const CellJoinedCapacityReference& reference) noexcept {
    auto& self = *static_cast<NativeContext*>(raw);
    auto error = Matches(raw, reference);
    if (!error) error = self.journal.Verify();
    if (!error) error = self.layout.VerifyRetainedSecurity(reference.owner_sid, reference.controller_sid, self.security, self.descriptor);
    return error ? error : Matches(raw, reference);
  }
  static DWORD Capture(void* raw, const CellJoinedCapacityReference& reference, const CellFootprintScanLimits& limits,
    const CellFootprintScanGuard& guard, const CellFootprintCellBinding& binding, CellProvisioningJoinedCapacity* output) noexcept {
    auto& self = *static_cast<NativeContext*>(raw);
    CellFileSha256 head{};
    std::copy_n(reference.history.mounted_workspace_records.back().begin() + 992, 32, head.begin());
    return self.journal.ObserveJoinedCapacity(reference.history.anchor, head, self.layout, reference.layout, limits, guard, binding, output);
  }
};

DWORD CellJoinedCapacityCollector::Capture(CellProvisioningJournal& journal, CellCapacityLayout& layout,
  const CellJoinedCapacityReference& reference, const CellFootprintScanGuard& authority,
  const CellFootprintCellBinding& binding, CellJoinedCapacityBytes* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  // Close from an authority callback revokes immediately but cannot destroy
  // owners that the nested joined capture is still using on this stack.
  CellProvisioningJournal::CapacityReadScope scope(journal);
  if (!scope.entered) { *output = {}; return ERROR_INVALID_STATE; }
  try {
    NativeContext native{journal, layout, journal.lifetime_revision_, layout.roots_, layout.descriptor_, layout.security_};
    return RunOwned({&native, NativeContext::Matches, NativeContext::Verify, NativeContext::Capture}, reference, authority, binding, output);
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}

DWORD CellJoinedCapacityCollector::RunOwned(const Operations& supplied_operations, const CellJoinedCapacityReference& supplied_reference,
  const CellFootprintScanGuard& supplied_authority, const CellFootprintCellBinding& supplied_binding, CellJoinedCapacityBytes* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    const auto started = GetTickCount64();
    const auto reference = supplied_reference; const auto operations = supplied_operations;
    const auto authority = supplied_authority; const auto binding = supplied_binding;
    const auto& request = reference.history;
    if (!operations.matches || !operations.verify || !operations.capture || !authority.authorize || !binding.authorize ||
        request.operation != kCellControllerInventoryOperation || !reference.limits.wall_limit_ms || reference.limits.wall_limit_ms > 60000 ||
        reference.limits.max_entries < kCellCapacityAreaCount || reference.limits.max_entries > 20000 || reference.limits.max_depth > 64 ||
        reference.layout.assignment_binding != request.plan.assignment_binding || reference.layout.profile_sha256 != request.plan.profile_sha256 ||
        std::all_of(reference.capture_nonce.begin(), reference.capture_nonce.end(), [](auto byte) { return byte == 0; })) return ERROR_INVALID_PARAMETER;
    if (authority.cancellation == INVALID_HANDLE_VALUE || authority.cancellation == GetCurrentThread()) return ERROR_INVALID_HANDLE;
    std::array<std::uint8_t, kCellControllerRequestBytes> request_bytes{};
    CellCapacityLayoutBytes layout_bytes{};
    if (!EncodeCellControllerRequest(request, &request_bytes, reference.owner_sid, reference.controller_sid) ||
        EncodeCellCapacityLayout(reference.layout, &layout_bytes)) return ERROR_INVALID_DATA;
    struct Context final {
      const CellJoinedCapacityReference& reference; Operations operations;
      CellFootprintScanGuard authority; CellFootprintCellBinding binding;
      ULONGLONG deadline; const CellProvisioningJoinedCapacity* captured = nullptr;
      DWORD Control() const noexcept {
        if (authority.cancellation) {
          const auto state = WaitForSingleObject(authority.cancellation, 0);
          if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
        }
        return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      DWORD Matches() const noexcept {
        auto error = Control();
        if (!error) error = operations.matches(operations.context, reference);
        return error ? error : Control();
      }
      static DWORD Authorize(void* raw) noexcept {
        const auto& self = *static_cast<Context*>(raw);
        auto error = self.Matches();
        if (!error) error = self.authority.authorize(self.authority.context);
        if (!error) error = self.Matches();
        if (!error && self.captured) error = self.binding.authorize(self.binding.context, self.reference.history.cell_name,
          self.captured->guest.workspace.directories[static_cast<std::size_t>(CellDirectory::work)]);
        return error ? error : self.Matches();
      }
    } context{reference, operations, authority, binding, started + std::min<DWORD>(reference.limits.wall_limit_ms, request.wall_ms)};
    auto error = Context::Authorize(&context);
    if (!error) error = operations.verify(operations.context, reference);
    if (!error) error = context.Matches();
    if (error) return error;
    auto remaining = reference.limits;
    remaining.wall_limit_ms = static_cast<DWORD>(context.deadline - GetTickCount64());
    if (!remaining.wall_limit_ms || remaining.wall_limit_ms > reference.limits.wall_limit_ms) return ERROR_TIMEOUT;
    CellProvisioningJoinedCapacity observed;
    error = operations.capture(operations.context, reference, remaining, {Context::Authorize, &context, authority.cancellation}, binding, &observed);
    if (error) return error;
    context.captured = &observed;
    if (observed.guest.inventory.entries.size() > reference.limits.max_entries) return ERROR_BUFFER_OVERFLOW;
    auto count = observed.guest.inventory.entries.size();
    for (const auto& area : observed.host.areas) {
      if (area.entries.size() > reference.limits.max_entries - count) return ERROR_BUFFER_OVERFLOW;
      count += area.entries.size();
    }
    error = Context::Authorize(&context);
    CellJoinedCapacityBytes bytes;
    if (!error) error = EncodeCellJoinedCapacity(request, reference.owner_sid, reference.controller_sid, reference.layout, reference.capture_nonce, observed, &bytes);
    // The final callback may revoke authority, close owners or change files.
    // Full native readback follows it, before any byte becomes publishable.
    if (!error) error = Context::Authorize(&context);
    if (!error) error = operations.verify(operations.context, reference);
    if (!error) error = context.Matches();
    if (!error) *output = std::move(bytes);
    return error;
  } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
}
}
