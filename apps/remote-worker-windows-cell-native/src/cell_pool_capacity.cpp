#include "cell_pool_capacity.hpp"
#include "cell_controller_protocol.hpp"
#include "cell_runtime_result.hpp"
#include <algorithm>
#include <limits>
#include <set>

namespace goatcitadel::worker_cell {
namespace {
bool Nonzero(const auto& bytes) noexcept {
  return std::any_of(bytes.begin(), bytes.end(), [](auto byte) { return byte != 0; });
}
bool Same(const CellProvisioningBackingFootprint& a, const CellProvisioningBackingFootprint& b) noexcept {
  const auto& x = a.backing; const auto& y = b.backing;
  return a.anchor == b.anchor && a.assignment_binding == b.assignment_binding && a.profile_sha256 == b.profile_sha256 &&
    a.checkpoint_sha256 == b.checkpoint_sha256 && a.workspace == b.workspace && a.journal_bytes == b.journal_bytes &&
    a.journal_allocated_bytes == b.journal_allocated_bytes && a.host_file_allocated_bytes == b.host_file_allocated_bytes &&
    x.file_bytes == y.file_bytes && x.allocated_bytes == y.allocated_bytes && x.record.control == y.record.control &&
    x.record.backing == y.record.backing && IsEqualGUID(x.record.spec.identifier, y.record.spec.identifier) &&
    x.record.spec.virtual_bytes == y.record.spec.virtual_bytes && x.record.spec.reserved_file_bytes == y.record.spec.reserved_file_bytes;
}
}
struct CellPoolCapacityCollector::NativeContext final {
  CellCapacityLayout& layout;
  CellCapacityLayoutRecord record;
  CellCapacityAreaRoots roots;
  std::vector<std::uint8_t> descriptor;
  CellCapacityRootSecurity security;
  bool Matches() const noexcept {
    if (!layout.open_ || layout.interrupted_ || layout.record_ != record || layout.descriptor_ != descriptor ||
        layout.security_.context != security.context || layout.security_.verify != security.verify) return false;
    for (std::size_t i = 0; i < roots.size(); ++i)
      if (roots[i].handle != layout.roots_[i].handle || roots[i].identity != layout.roots_[i].identity) return false;
    return true;
  }
  DWORD Check() noexcept {
    if (!Matches()) return ERROR_FILE_INVALID;
    const auto error = layout.Verify();
    return error ? error : Matches() ? ERROR_SUCCESS : ERROR_FILE_INVALID;
  }
};
DWORD CellPoolCapacityCollector::CaptureRecorded(HANDLE parent, CellProvisioningJournal& current,
  const CellControllerRequest& request, const std::wstring& owner_sid, const std::wstring& controller_sid,
  CellCapacityLayout& layout, const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits,
  const CellFootprintScanGuard& guard, CellPoolJoinedCapacity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  CellControllerPoolHistory pool;
  auto error = DecodeCellControllerPoolHistory(request.pool_history, request, owner_sid, controller_sid, &pool);
  CellRuntimePoolCleanupSet cleanup;
  if (!error) error = DecodeCellRuntimePoolCleanup(request.pool_cleanup, request, owner_sid, controller_sid, &cleanup);
  if (error) return error;
  const RecordedOperations operations{nullptr,
    [](void*, HANDLE parent, const CellControllerRequest& member, const std::wstring& owner,
      const std::wstring& controller, CellProvisioningJournal& journal) noexcept -> DWORD {
      return journal.OpenRecorded(parent, member.parent, member.cell_name, owner, controller, member.plan, member.anchor,
        member.volume_records, member.format_records, member.protection_records, member.mount_records, member.mounted_workspace_records);
    },
    [](void*, CellProvisioningJournal& journal, const CellControllerRequest& member,
      CellWorkspaceIdentities* host, CellWorkspaceIdentities* guest) noexcept -> DWORD {
      // Include the five creation records even though OpenRecorded separately
      // checks the volume and mounted stages. The current journal is reused,
      // so every stage must also be read back against the retained request.
      const auto same = [&](auto getter, const auto& expected) noexcept -> DWORD {
        std::vector<CellProvisioningRecord> actual;
        const auto error = (journal.*getter)(&actual);
        return error ? error : std::equal(actual.begin(), actual.end(), expected.begin(), expected.end()) ? ERROR_SUCCESS : ERROR_CRC;
      };
      auto error = same(&CellProvisioningJournal::RecordCheckpoints, member.creation_records);
      if (!error) error = same(&CellProvisioningJournal::RecordVolumeCheckpoints, member.volume_records);
      if (!error) error = same(&CellProvisioningJournal::RecordFormatCheckpoints, member.format_records);
      if (!error) error = same(&CellProvisioningJournal::RecordProtectionCheckpoints, member.protection_records);
      if (!error) error = same(&CellProvisioningJournal::RecordMountCheckpoints, member.mount_records);
      if (!error) error = same(&CellProvisioningJournal::RecordMountedWorkspaceCheckpoints, member.mounted_workspace_records);
      if (!error) error = journal.RecordWorkspace(host);
      if (!error) error = journal.RecordMountedWorkspace(guest);
      return error;
    },
    [](void*, CellProvisioningJournal& journal, const CellRuntimeCleanupSet& set,
      const CellRuntimeCleanupAdmission& admission, const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept -> DWORD {
      return CellRuntimeLocalOutcome::VerifyInstallationCoverage(journal, set.anchor, set.checkpoint_sha256, admission.installations, guard, wall_ms);
    },
    [](void*, CellProvisioningJournal& journal, const CellRuntimeCleanupSet& set,
      const CellFootprintScanGuard& guard, DWORD wall_ms) noexcept -> DWORD {
      return CellRuntimeLocalOutcome::VerifyCleanupCoverage(journal, set.anchor, set.checkpoint_sha256, set.expectations, guard, wall_ms);
    },
    [](void*, CellCapacityLayout& layout, const CellCapacityLayoutRecord& record,
      std::span<const CellPoolGuestMember> members, const CellFootprintScanLimits& limits,
      const CellFootprintScanGuard& guard, CellPoolJoinedCapacity* output) noexcept -> DWORD {
      return CaptureJoined(layout, record, members, limits, guard, output);
    }};
  return RunRecorded(operations, parent, current, request, pool, cleanup, owner_sid, controller_sid, layout, record, limits, guard, output);
}
DWORD CellPoolCapacityCollector::RunRecorded(const RecordedOperations& supplied_operations, HANDLE parent,
  CellProvisioningJournal& current, const CellControllerRequest& supplied_current, const CellControllerPoolHistory& supplied_pool,
  const CellRuntimePoolCleanupSet& supplied_cleanup,
  const std::wstring& supplied_owner, const std::wstring& supplied_controller, CellCapacityLayout& layout,
  const CellCapacityLayoutRecord& supplied_record, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, CellPoolJoinedCapacity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  *output = {};
  try {
    const auto started = GetTickCount64();
    if (supplied_pool.members.empty() || supplied_pool.members.size() > kCellCapacityPoolMaximumMembers) return ERROR_INVALID_DATA;
    // Freeze all retained values before the first owner callback. The decoded
    // members contain no cleanup stream or nested pool container.
    const auto operations = supplied_operations; const auto pool = supplied_pool;
    const auto cleanup = supplied_cleanup;
    if (cleanup.members.size() != pool.members.size() || cleanup.admissions.size() != pool.members.size()) return ERROR_INVALID_DATA;
    const auto current_anchor = supplied_current.anchor; const auto current_name = supplied_current.cell_name;
    const auto owner = supplied_owner; const auto controller = supplied_controller;
    const auto record = supplied_record; auto limits = supplied_limits; const auto guard = supplied_guard;
    limits.wall_limit_ms = std::min<DWORD>(limits.wall_limit_ms, supplied_current.wall_ms);
    if (!operations.open || !operations.read || !operations.installations || !operations.runtime || !operations.capture || !guard.authorize ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 60000 || limits.max_entries < kCellCapacityAreaCount ||
        limits.max_entries > 20000 || limits.max_depth > 64) return ERROR_INVALID_PARAMETER;
    struct Control final {
      CellFootprintScanGuard guard; ULONGLONG deadline;
      DWORD Check() const noexcept {
        if (guard.cancellation) {
          const auto state = WaitForSingleObject(guard.cancellation, 0);
          if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
        }
        return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Authorize(void* raw) noexcept {
        const auto& self = *static_cast<Control*>(raw);
        auto error = self.Check();
        if (!error) error = self.guard.authorize(self.guard.context);
        return error ? error : self.Check();
      }
    } control{guard, started + limits.wall_limit_ms};
    const CellFootprintScanGuard authority{Control::Authorize, &control, guard.cancellation};
    struct Retained final {
      std::unique_ptr<CellProvisioningJournal> owned;
      CellProvisioningJournal* journal = nullptr;
      CellWorkspaceIdentities host, guest;
      const CellControllerRequest* request = nullptr;
      static DWORD Bound(const void* raw, const std::wstring& name, const CellFileIdentity& work) noexcept {
        const auto& self = *static_cast<const Retained*>(raw);
        return name == self.request->cell_name && work == self.guest.directories[static_cast<std::size_t>(CellDirectory::work)]
          ? ERROR_SUCCESS : ERROR_FILE_INVALID;
      }
    };
    std::vector<Retained> retained(pool.members.size());
    std::vector<CellPoolGuestMember> members; members.reserve(pool.members.size());
    bool reused = false;
    for (std::size_t i = 0; i < pool.members.size(); ++i) {
      auto error = Control::Authorize(&control); if (error) return error;
      const auto& request = pool.members[i]; auto& held = retained[i]; held.request = &request;
      if (request.anchor == current_anchor && request.cell_name == current_name) {
        if (reused) return ERROR_INVALID_DATA;
        held.journal = &current; reused = true;
      } else {
        held.owned = std::make_unique<CellProvisioningJournal>(); held.journal = held.owned.get();
        error = operations.open(operations.context, parent, request, owner, controller, *held.journal);
      }
      if (!error) error = Control::Authorize(&control);
      if (!error) error = operations.read(operations.context, *held.journal, request, &held.host, &held.guest);
      if (!error) error = Control::Authorize(&control);
      if (error) return error;
      const auto& set = cleanup.members[i];
      if (set.anchor != request.anchor || set.workspace != held.guest ||
          !std::equal(set.checkpoint_sha256.begin(), set.checkpoint_sha256.end(), request.mounted_workspace_records.back().begin() + 992)) return ERROR_INVALID_DATA;
      auto remaining = [&]() noexcept -> DWORD {
        const auto now = GetTickCount64();
        return now >= control.deadline ? 0 : static_cast<DWORD>(control.deadline - now);
      };
      auto budget = remaining(); if (!budget) return ERROR_TIMEOUT;
      error = operations.installations(operations.context, *held.journal, set, cleanup.admissions[i], authority, budget);
      if (!error) error = Control::Authorize(&control);
      if (error) return error;
      budget = remaining(); if (!budget) return ERROR_TIMEOUT;
      error = operations.runtime(operations.context, *held.journal, set, authority, budget);
      if (!error) error = Control::Authorize(&control);
      if (error) return error;
      CellPoolGuestMember member;
      member.host = {held.journal, request.anchor, held.host.directories[0], {}, request.plan.assignment_binding, request.plan.profile_sha256};
      std::copy_n(request.mounted_workspace_records.back().begin() + 992, 32, member.host.head.begin());
      member.cell_name = request.cell_name; member.binding = {Retained::Bound, &held};
      members.push_back(std::move(member));
    }
    if (!reused) return ERROR_INVALID_DATA;
    auto error = Control::Authorize(&control); if (error) return error;
    const auto now = GetTickCount64();
    if (now >= control.deadline) return ERROR_TIMEOUT;
    limits.wall_limit_ms = static_cast<DWORD>(control.deadline - now);
    CellPoolJoinedCapacity result;
    error = operations.capture(operations.context, layout, record, members, limits, authority, &result);
    if (!error && (result.host.backings.size() != members.size() || result.guests.size() != members.size())) error = ERROR_INVALID_DATA;
    // All journal owners remain alive until capture's pinned reads and this
    // last exact-history/identity readback have finished. Never publish a subset.
    if (!error) error = Control::Authorize(&control);
    for (std::size_t i = 0; !error && i < retained.size(); ++i) {
      auto& held = retained[i]; CellWorkspaceIdentities host, guest;
      error = control.Check();
      if (!error) error = operations.read(operations.context, *held.journal, pool.members[i], &host, &guest);
      if (!error && (host != held.host || guest != held.guest)) error = ERROR_FILE_INVALID;
    }
    // No further external authorization callback after the last identity
    // readback: a callback can itself invalidate a previously checked owner.
    if (!error) error = control.Check();
    if (!error) *output = std::move(result);
    return error;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellPoolCapacityCollector::Capture(CellCapacityLayout& layout, const CellCapacityLayoutRecord& record,
  std::span<const CellPoolCapacityMember> members, const CellFootprintScanLimits& limits,
  const CellFootprintScanGuard& guard, CellPoolCapacity* output, const CellCapacityCaptureObserver* observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
  NativeContext native{layout, record, layout.roots_, layout.descriptor_, layout.security_};
  const Operations operations{&native,
    [](void* raw, std::size_t, const CellPoolCapacityMember& member, DWORD wall_ms, const CellFootprintScanGuard& authority,
      const CellProvisioningBackingObserver& held, CellProvisioningBackingFootprint* result) noexcept -> DWORD {
      auto& self = *static_cast<NativeContext*>(raw);
      auto error = self.Check();
      if (!error) error = member.journal->WithBackingCapacity(member.anchor, member.head, wall_ms, authority, held, result);
      return error ? error : self.Check();
    },
    [](void* raw, const CellCapacityLayoutRecord& roots, const CellFootprintScanLimits& bounded,
      const CellFootprintScanGuard& authority, CellCapacityAreaInventories* result,
      const CellCapacityBorrowedFiles* borrowed, const CellCapacityCaptureObserver* held) noexcept -> DWORD {
      auto& self = *static_cast<NativeContext*>(raw);
      auto error = self.Check();
      if (!error) error = self.layout.Scan(roots, bounded, authority, result, borrowed, held);
      return error ? error : self.Check();
    }};
  return Run(operations, record, members, limits, guard, output, observer);
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellPoolCapacityCollector::Run(const Operations& supplied_operations, const CellCapacityLayoutRecord& supplied_record,
  std::span<const CellPoolCapacityMember> supplied_members, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, CellPoolCapacity* output, const CellCapacityCaptureObserver* supplied_observer) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    const auto started = GetTickCount64();
    const auto operations = supplied_operations; const auto record = supplied_record;
    const auto limits = supplied_limits; const auto guard = supplied_guard;
    // Check the bound before copying or recursively entering any member.
    if (supplied_members.size() > kCellCapacityPoolMaximumMembers) { *output = {}; return ERROR_BUFFER_OVERFLOW; }
    const std::vector<CellPoolCapacityMember> members(supplied_members.begin(), supplied_members.end());
    detail::CellCapacityObservation observer(supplied_observer);
    *output = {};
    if (!operations.borrow || !operations.scan || !guard.authorize || !observer.Valid() ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 60000 || limits.max_entries < kCellCapacityAreaCount ||
        limits.max_entries > 20000 || limits.max_depth > 64) return ERROR_INVALID_PARAMETER;
    std::set<CellProvisioningJournal*> journals;
    std::set<std::pair<std::uint64_t, std::array<std::uint8_t, 16>>> identities;
    for (const auto& member : members) {
      if (!member.journal || !member.anchor.file.volume_serial || !Nonzero(member.anchor.file.file_id) ||
          !member.workspace_root.volume_serial || !Nonzero(member.workspace_root.file_id) ||
          !Nonzero(member.anchor.prepared_sha256) || !Nonzero(member.head) || !Nonzero(member.assignment_binding) ||
          !Nonzero(member.profile_sha256) || !journals.insert(member.journal).second ||
          !identities.emplace(member.anchor.file.volume_serial, member.anchor.file.file_id).second) return ERROR_INVALID_PARAMETER;
    }
    struct Context final {
      Operations operations; const CellCapacityLayoutRecord& record; const std::vector<CellPoolCapacityMember>& members;
      CellFootprintScanLimits limits; CellFootprintScanGuard authority; ULONGLONG deadline;
      const CellCapacityCaptureObserver* observer;
      std::vector<CellCapacityBorrowedFile> files;
      std::vector<const CellCapacityMountLeaf*> mounts;
      std::vector<CellFootprintScanGuard> guards;
      CellPoolCapacity result;
      DWORD Control() const noexcept {
        if (authority.cancellation) {
          const auto state = WaitForSingleObject(authority.cancellation, 0);
          if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
        }
        return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Base(void* raw) noexcept {
        auto& self = *static_cast<Context*>(raw);
        auto error = self.Control();
        if (!error) error = self.authority.authorize(self.authority.context);
        return error ? error : self.Control();
      }
      static DWORD All(void* raw) noexcept {
        auto& self = *static_cast<Context*>(raw);
        auto error = Base(raw);
        for (const auto& held : self.guards) {
          if (error) break;
          error = held.authorize(held.context);
          if (!error) error = self.Control();
        }
        return error;
      }
      DWORD Next(std::size_t index) noexcept {
        try {
          auto error = All(this); if (error) return error;
          const auto now = GetTickCount64(); if (now >= deadline) return ERROR_TIMEOUT;
          if (index == members.size()) {
            auto bounded = limits; bounded.wall_limit_ms = static_cast<DWORD>(deadline - now);
            const CellFootprintScanGuard combined{All, this, authority.cancellation};
            const CellCapacityBorrowedFiles borrowed{files, combined, mounts};
            error = operations.scan(operations.context, record, bounded, combined, &result.areas,
              files.empty() && mounts.empty() ? nullptr : &borrowed, observer);
            return error ? error : All(this);
          }
          struct Borrow final {
            Context& owner; std::size_t index; bool attempted = false, discarded = false, accepted = false;
            CellProvisioningBackingFootprint captured;
            static DWORD Capture(void* raw, const CellCapacityBorrowedFiles& borrowed,
              const CellProvisioningBackingFootprint& value) noexcept {
              auto& self = *static_cast<Borrow*>(raw); auto& owner = self.owner;
              if (self.attempted || self.discarded) { self.discarded = true; return ERROR_INVALID_STATE; }
              self.attempted = true;
              const auto& member = owner.members[self.index];
              if (!borrowed.guard.authorize || borrowed.files.size() != 2 || borrowed.mounts.size() > 1 ||
                  value.anchor != member.anchor || value.checkpoint_sha256 != member.head ||
                  value.assignment_binding != member.assignment_binding || value.profile_sha256 != member.profile_sha256 ||
                  value.workspace.directories[static_cast<std::size_t>(CellDirectory::root)] != member.workspace_root ||
                  value.workspace.parent != owner.record.roots[0]) return ERROR_FILE_INVALID;
              const auto& journal = borrowed.files[0]; const auto& backing = borrowed.files[1];
              if (journal.identity != value.anchor.file || journal.parent != value.workspace.parent ||
                  journal.logical_bytes != value.journal_bytes || journal.allocated_bytes != value.journal_allocated_bytes ||
                  backing.identity != value.backing.record.backing || backing.parent != value.backing.record.control ||
                  backing.logical_bytes != value.backing.file_bytes || backing.allocated_bytes != value.backing.allocated_bytes ||
                  value.journal_allocated_bytes > std::numeric_limits<std::uint64_t>::max() - value.backing.allocated_bytes ||
                  value.host_file_allocated_bytes != value.journal_allocated_bytes + value.backing.allocated_bytes) return ERROR_FILE_INVALID;
              const auto file_count = owner.files.size(), mount_count = owner.mounts.size(), guard_count = owner.guards.size();
              struct Restore final {
                Context& owner; std::size_t files, mounts, guards;
                ~Restore() { owner.files.resize(files); owner.mounts.resize(mounts); owner.guards.resize(guards); }
              } restore{owner, file_count, mount_count, guard_count};
              try {
                self.captured = value;
                owner.files.insert(owner.files.end(), borrowed.files.begin(), borrowed.files.end());
                owner.mounts.insert(owner.mounts.end(), borrowed.mounts.begin(), borrowed.mounts.end());
                owner.guards.push_back(borrowed.guard);
                const auto error = owner.Next(self.index + 1);
                self.accepted = !error;
                return error;
              } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
            }
            static void Discard(void* raw) noexcept { static_cast<Borrow*>(raw)->discarded = true; }
          } borrowed{*this, index};
          CellProvisioningBackingFootprint final;
          error = operations.borrow(operations.context, index, members[index], static_cast<DWORD>(deadline - now),
            {Base, this, authority.cancellation}, {&borrowed, Borrow::Capture, Borrow::Discard}, &final);
          if (!error && (!borrowed.accepted || borrowed.discarded || !Same(final, borrowed.captured))) error = ERROR_INVALID_DATA;
          if (!error) error = All(this);
          if (!error) result.backings[index] = final;
          return error;
        } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
      }
    } context{operations, record, members, limits, guard, started + limits.wall_limit_ms, observer.Bridge()};
    context.result.backings.resize(members.size());
    const auto error = context.Next(0);
    if (!error) { *output = std::move(context.result); observer.Complete(); }
    return error;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellPoolCapacityCollector::CaptureJoined(CellCapacityLayout& layout, const CellCapacityLayoutRecord& record,
  std::span<const CellPoolGuestMember> members, const CellFootprintScanLimits& limits,
  const CellFootprintScanGuard& guard, CellPoolJoinedCapacity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
  if (members.size() > kCellCapacityPoolMaximumMembers) { *output = {}; return ERROR_BUFFER_OVERFLOW; }
  struct Native final {
    NativeContext custody;
    std::vector<CellCapacityChild> children;
    std::array<std::unique_ptr<CellDirectoryInventoryPins>, kCellCapacityPoolMaximumMembers> pins;
    static DWORD Host(void* raw, const CellCapacityLayoutRecord& record, std::span<const CellPoolCapacityMember> members,
      const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellPoolCapacity* output,
      const JoinedObserver& observer) noexcept {
      struct Bridge final {
        JoinedObserver observer;
        const CellFileIdentity& root;
        const std::vector<CellCapacityChild>& children;
        static DWORD Capture(void* raw, const CellCapacityPinnedView& view) noexcept {
          const auto& self = *static_cast<Bridge*>(raw);
          struct Held final {
            const CellCapacityPinnedView& view;
            static DWORD Check(void* raw) noexcept { return static_cast<Held*>(raw)->view.Check(); }
          } held{view};
          auto error = view.VerifyChildren(self.root, self.children);
          if (!error) error = self.observer.capture(self.observer.context, {Held::Check, &held});
          return error ? error : view.VerifyChildren(self.root, self.children);
        }
        static void Discard(void* raw) noexcept {
          const auto& self = *static_cast<Bridge*>(raw); self.observer.discard(self.observer.context);
        }
      } bridge{observer, static_cast<Native*>(raw)->custody.record.roots[0], static_cast<Native*>(raw)->children};
      const CellCapacityCaptureObserver capture{&bridge, Bridge::Capture, Bridge::Discard};
      auto& self = *static_cast<Native*>(raw);
      auto error = self.custody.Check();
      if (!error) error = CellPoolCapacityCollector::Capture(self.custody.layout, record, members, limits, guard, output, &capture);
      return error ? error : self.custody.Check();
    }
    static DWORD Guest(void* raw, std::size_t index, const CellPoolGuestMember& member,
      const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellProvisioningInventory* output) noexcept {
      auto& self = *static_cast<Native*>(raw);
      if (index >= self.pins.size() || self.pins[index]) return ERROR_INVALID_STATE;
      try {
        self.pins[index] = std::make_unique<CellDirectoryInventoryPins>();
        const CellFootprintCellBinding bound{[](const void* raw, const std::wstring& name, const CellFileIdentity& work) noexcept -> DWORD {
          const auto& member = *static_cast<const CellPoolGuestMember*>(raw);
          return name == member.cell_name ? member.binding.authorize(member.binding.context, name, work) : ERROR_FILE_INVALID;
        }, &member};
        return member.host.journal->CaptureMountedInventory(member.host.anchor, member.host.head, limits, guard, bound, *self.pins[index], output);
      } catch (...) { return ERROR_NOT_ENOUGH_MEMORY; }
    }
    static DWORD Check(void* raw, std::size_t index) noexcept {
      auto& self = *static_cast<Native*>(raw);
      return index < self.pins.size() && self.pins[index] && self.pins[index]->Ready() ? self.pins[index]->Check() : ERROR_INVALID_STATE;
    }
    static void Close(void* raw, std::size_t index) noexcept {
      auto& self = *static_cast<Native*>(raw); if (index < self.pins.size()) self.pins[index].reset();
    }
  } native{{layout, record, layout.roots_, layout.descriptor_, layout.security_}};
  for (const auto& member : members) {
    native.children.push_back({member.cell_name, member.host.workspace_root, true});
    native.children.push_back({member.cell_name + L".provisioning", member.host.anchor.file, false});
  }
  return RunJoined({&native, Native::Host, Native::Guest, Native::Check, Native::Close}, record, members, limits, guard, output);
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
DWORD CellPoolCapacityCollector::RunJoined(const JoinedOperations& supplied_operations, const CellCapacityLayoutRecord& supplied_record,
  std::span<const CellPoolGuestMember> supplied_members, const CellFootprintScanLimits& supplied_limits,
  const CellFootprintScanGuard& supplied_guard, CellPoolJoinedCapacity* output) noexcept {
  if (!output) return ERROR_INVALID_PARAMETER;
  try {
    const auto started = GetTickCount64();
    if (supplied_members.size() > kCellCapacityPoolMaximumMembers) { *output = {}; return ERROR_BUFFER_OVERFLOW; }
    const auto operations = supplied_operations; const auto record = supplied_record;
    const auto limits = supplied_limits; const auto guard = supplied_guard;
    const std::vector<CellPoolGuestMember> members(supplied_members.begin(), supplied_members.end());
    *output = {};
    if (!operations.host || !operations.guest || !operations.check || !operations.close || !guard.authorize ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 60000 || limits.max_entries < kCellCapacityAreaCount ||
        limits.max_entries > 20000 || limits.max_depth > 64) return ERROR_INVALID_PARAMETER;
    std::set<std::wstring> names;
    std::vector<CellPoolCapacityMember> hosts;
    for (const auto& member : members) {
      if (!member.binding.authorize || member.cell_name.size() != 40 || member.cell_name.compare(0, 8, L"gc-cell-") ||
          member.cell_name.find_first_not_of(L"0123456789abcdef", 8) != std::wstring::npos || !names.insert(member.cell_name).second)
        return ERROR_INVALID_PARAMETER;
      hosts.push_back(member.host);
    }
    struct Context final {
      JoinedOperations operations; const std::vector<CellPoolGuestMember>& members;
      CellFootprintScanLimits limits; CellFootprintScanGuard authority; ULONGLONG deadline;
      std::vector<CellProvisioningInventory> guests;
      std::size_t completed = 0, entries = 0;
      bool attempted = false, failed = false;
      ~Context() { for (std::size_t i = 0; i < members.size(); ++i) operations.close(operations.context, i); }
      DWORD Control() const noexcept {
        if (failed) return ERROR_INVALID_STATE;
        if (authority.cancellation) {
          const auto state = WaitForSingleObject(authority.cancellation, 0);
          if (state != WAIT_TIMEOUT) return state == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE;
        }
        return GetTickCount64() >= deadline ? ERROR_TIMEOUT : ERROR_SUCCESS;
      }
      static DWORD Authorize(void* raw) noexcept {
        auto& self = *static_cast<Context*>(raw);
        auto error = self.Control();
        if (!error) error = self.authority.authorize(self.authority.context);
        for (std::size_t i = 0; !error && i < self.completed; ++i) {
          const auto& member = self.members[i];
          error = member.binding.authorize(member.binding.context, member.cell_name,
            self.guests[i].workspace.directories[static_cast<std::size_t>(CellDirectory::work)]);
          if (!error) error = self.operations.check(self.operations.context, i);
        }
        return error ? error : self.Control();
      }
      static DWORD Capture(void* raw, const CellFootprintScanGuard& supplied_pinned) noexcept {
        auto& self = *static_cast<Context*>(raw);
        if (self.attempted || self.failed || !supplied_pinned.authorize) { self.failed = true; return ERROR_INVALID_STATE; }
        self.attempted = true;
        struct Held final {
          Context& owner; CellFootprintScanGuard pinned;
          static DWORD Check(void* raw) noexcept {
            auto& self = *static_cast<Held*>(raw);
            auto error = self.pinned.authorize(self.pinned.context);
            if (!error) error = Context::Authorize(&self.owner);
            return error ? error : self.pinned.authorize(self.pinned.context);
          }
        } held{self, supplied_pinned};
        auto error = Held::Check(&held);
        for (std::size_t i = 0; !error && i < self.members.size(); ++i) {
          if (self.entries >= self.limits.max_entries) { error = ERROR_BUFFER_OVERFLOW; break; }
          const auto now = GetTickCount64(); if (now >= self.deadline) { error = ERROR_TIMEOUT; break; }
          auto bounded = self.limits; bounded.wall_limit_ms = static_cast<DWORD>(self.deadline - now);
          bounded.max_entries -= static_cast<std::uint32_t>(self.entries);
          const auto& member = self.members[i]; auto& guest = self.guests[i];
          error = self.operations.guest(self.operations.context, i, member, bounded,
            {Held::Check, &held, self.authority.cancellation}, &guest);
          if (!error && (guest.anchor != member.host.anchor || guest.checkpoint_sha256 != member.host.head ||
              guest.assignment_binding != member.host.assignment_binding || guest.profile_sha256 != member.host.profile_sha256 ||
              guest.inventory.entries.empty() || guest.inventory.entries.size() > bounded.max_entries)) error = ERROR_FILE_INVALID;
          if (!error) error = self.operations.check(self.operations.context, i);
          if (!error) { ++self.completed; self.entries += guest.inventory.entries.size(); error = Held::Check(&held); }
        }
        if (error) self.failed = true;
        return error;
      }
      static void Discard(void* raw) noexcept { static_cast<Context*>(raw)->failed = true; }
    } context{operations, members, limits, guard, started + limits.wall_limit_ms};
    context.guests.resize(members.size());
    CellPoolJoinedCapacity result;
    auto error = Context::Authorize(&context);
    const JoinedObserver observer{&context, Context::Capture, Context::Discard};
    if (!error) error = operations.host(operations.context, record, hosts, limits,
      {Context::Authorize, &context, guard.cancellation}, &result.host, observer);
    if (!error && (!context.attempted || context.failed || context.completed != members.size() || result.host.backings.size() != members.size()))
      error = ERROR_INVALID_DATA;
    std::size_t total = context.entries;
    for (const auto& area : result.host.areas) {
      if (area.entries.size() > limits.max_entries - total) { error = ERROR_BUFFER_OVERFLOW; break; }
      total += area.entries.size();
    }
    for (std::size_t i = 0; !error && i < members.size(); ++i) {
      const auto& backing = result.host.backings[i]; const auto& expected = members[i].host;
      if (backing.anchor != expected.anchor || backing.checkpoint_sha256 != expected.head ||
          backing.assignment_binding != expected.assignment_binding || backing.profile_sha256 != expected.profile_sha256) error = ERROR_FILE_INVALID;
    }
    if (!error) error = Context::Authorize(&context);
    if (!error) { result.guests = std::move(context.guests); *output = std::move(result); }
    return error;
  } catch (...) { *output = {}; return ERROR_NOT_ENOUGH_MEMORY; }
}
}
