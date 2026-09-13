#pragma once
#include <windows.h>
#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::worker_host {
enum class WorkerInspectionObject : std::uint8_t { Process, Token };
constexpr std::size_t kWorkerInspectionAclBytes = 4096U;
struct WorkerInspectionAcl final {
  alignas(16) std::array<std::uint8_t, kWorkerInspectionAclBytes> bytes{};
};

// Preserve every existing ACE and add only the fixed worker's query grant.
// This composes a descriptor; it never mutates a kernel object.
bool ComposeWorkerInspectionAcl(PSID owner, PACL original,
    WorkerInspectionObject object, WorkerInspectionAcl* output) noexcept;

// The caller must first validate its complete service/SCM/installed identity.
// This routine independently requires a SYSTEM primary token in session zero,
// without impersonation, restriction or AppContainer. It changes only its own
// process and primary-token DACLs, retaining all original ACEs and protection.
// The worker receives QUERY_LIMITED_INFORMATION/SYNCHRONIZE and TOKEN_QUERY;
// no privilege, control, duplication, memory access or token assignment is added.
bool GrantCurrentSystemWorkerInspectionAccess() noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING) || defined(GOATCITADEL_SERVICE_INSPECTION_TESTING)
// Test-only mutation of the test process or an unassigned primary-token copy.
bool ApplyWorkerTokenInspectionForTest(HANDLE token, PSID expected_owner) noexcept;
bool ApplyWorkerProcessInspectionForTest(PSID expected_owner) noexcept;
#endif
}
