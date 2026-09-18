#include "cell_installed_pool_capacity.hpp"
#include <cstdio>
#include <stdexcept>
#include <string>

using namespace goatcitadel::worker_cell;
namespace goatcitadel::worker_cell {
struct CellInstalledPoolCapacityTestPeer final {
  template<class Owner> static DWORD Capture(Owner& owner, CellProvisioningJournal& journal, const CellControllerRequest& request,
    const CellFootprintScanLimits& limits, const CellFootprintScanGuard& guard, CellCapacityLayoutRecord* record, CellPoolJoinedCapacity* result) {
    return CellInstalledPoolCapacity::Run({&owner, Owner::Roots, Owner::Open, Owner::Capture}, journal, request, limits, guard, record, result);
  }
};
}
namespace {
unsigned checks = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
struct Owner final {
  std::string mode;
  unsigned calls = 0, roots = 0, opens = 0, captures = 0;
  HANDLE stop = nullptr;
  CellControllerRequest* supplied = nullptr;
  CellCapacityAreaRoots expected;
  CellCapacityLayoutRecord opened;
  static DWORD Current(void* raw) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.calls;
    if (self.mode == "mutate" && self.calls == 1) { self.supplied->plan.profile_sha256.fill(99); self.supplied->parent = {}; }
    if (self.mode == "revoke" && self.calls >= 4) return ERROR_ACCESS_DENIED;
    if (self.mode == "pre-revoke") return ERROR_ACCESS_DENIED;
    return ERROR_SUCCESS;
  }
  static DWORD Roots(void* raw, CellCapacityAreaRoots* roots) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.roots; *roots = self.expected;
    if (self.mode == "foreign-parent") (*roots)[0].identity.file_id[0] ^= 1;
    if (self.mode == "missing-root") (*roots)[12].handle = INVALID_HANDLE_VALUE;
    if (self.mode == "unadmitted") return ERROR_ACCESS_DENIED;
    if (self.mode == "cancel-roots") SetEvent(self.stop);
    return ERROR_SUCCESS;
  }
  static DWORD Open(void* raw, CellCapacityLayout&, const CellCapacityLayoutRecord& record, const CellCapacityAreaRoots&) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.opens; self.opened = record;
    if (self.mode == "bad-acl") return ERROR_ACCESS_DENIED;
    return ERROR_SUCCESS;
  }
  static DWORD Capture(void* raw, HANDLE parent, CellProvisioningJournal&, const CellControllerRequest& request, CellCapacityLayout&,
    const CellCapacityLayoutRecord& record, const CellFootprintScanLimits& limits, const CellFootprintScanGuard&, CellPoolJoinedCapacity* output) noexcept {
    auto& self = *static_cast<Owner*>(raw); ++self.captures;
    if (parent != self.expected[0].handle || request.parent != self.expected[0].identity || record != self.opened ||
        !limits.wall_limit_ms || limits.wall_limit_ms > 10000 || request.plan.profile_sha256[0] != 2) return ERROR_INVALID_DATA;
    output->guests.resize(2); output->host.backings.resize(2);
    if (self.mode == "cancel-capture") SetEvent(self.stop);
    return self.mode == "partial" ? ERROR_CRC : ERROR_SUCCESS;
  }
};
}
int main() {
  try {
    for (const char* mode : {"success", "mutate", "pre-revoke", "unadmitted", "foreign-parent", "missing-root", "bad-acl",
        "partial", "revoke", "cancel-roots", "cancel-capture", "wrong-operation", "entries", "depth", "deadline"}) {
      Owner owner; owner.mode = mode; owner.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
      Check(owner.stop != nullptr, "owned cancellation event");
      for (std::size_t i = 0; i < owner.expected.size(); ++i) {
        owner.expected[i].handle = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(i + 100));
        owner.expected[i].identity.volume_serial = 1; owner.expected[i].identity.file_id[0] = static_cast<std::uint8_t>(i + 1);
      }
      CellControllerRequest request; request.operation = kCellControllerPoolCapacityOperation;
      request.parent = owner.expected[0].identity; request.plan.assignment_binding.fill(1); request.plan.profile_sha256.fill(2);
      owner.supplied = &request;
      CellFootprintScanLimits limits{20000, 64, 10000};
      if (owner.mode == "wrong-operation") request.operation = 16;
      if (owner.mode == "entries") limits.max_entries = 20001;
      if (owner.mode == "depth") limits.max_depth = 65;
      if (owner.mode == "deadline") limits.wall_limit_ms = 60001;
      CellProvisioningJournal journal; CellCapacityLayoutRecord record; record.assignment_binding.fill(9);
      CellPoolJoinedCapacity output; output.guests.resize(1);
      const auto error = CellInstalledPoolCapacityTestPeer::Capture(owner, journal, request, limits, {Owner::Current, &owner, owner.stop}, &record, &output);
      const bool success = owner.mode == "success" || owner.mode == "mutate";
      Check(success ? error == ERROR_SUCCESS : error != ERROR_SUCCESS, mode);
      if (success) {
        Check(owner.roots == 1 && owner.opens == 1 && owner.captures == 1 && owner.calls == 4, "ordered ownership and final authority");
        Check(record.assignment_binding[0] == 1 && record.profile_sha256[0] == 2, "request snapshot frozen before callbacks");
        Check(output.guests.size() == 2 && output.host.backings.size() == 2, "complete joined output transferred");
        for (std::size_t i = 0; i < record.roots.size(); ++i) Check(record.roots[i] == owner.expected[i].identity, "layout derives installed identity");
      } else {
        Check(record == CellCapacityLayoutRecord{} && output.guests.empty() && output.host.backings.empty(), "failure discards all outputs");
        if (owner.mode == "foreign-parent" || owner.mode == "missing-root" || owner.mode == "unadmitted" || owner.mode == "pre-revoke")
          Check(owner.opens == 0 && owner.captures == 0, "inadmissible roots never reach collector");
      }
      CloseHandle(owner.stop);
    }
    std::printf("{\"passed\":true,\"checks\":%u,\"installedService\":false,\"volumeOperations\":false}\n", checks);
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
