#pragma once
#include <windows.h>
#include <array>
#include <cstddef>
#include <cstdint>

namespace goatcitadel::worker_host {
enum class WorkerInspectionObject : std::uint8_t { Process, Token };
// Selects one fixed service SID, never an arbitrary owner supplied by a caller.
enum class WorkerInspectionService : std::uint8_t { Provisioner = 1U, CellController = 2U };
constexpr std::size_t kWorkerInspectionAclBytes = 4096U;
struct WorkerInspectionAcl final {
  alignas(16) std::array<std::uint8_t, kWorkerInspectionAclBytes> bytes{};
};

// Stable, non-sensitive startup diagnostics. No SID, ACL, or token contents are
// emitted. These describe a refusal; they never select a more permissive path.
enum class WorkerInspectionStage : std::uint8_t {
  None = 0U, AmbientToken = 1U, TokenOpen = 2U, TokenIdentity = 3U,
  SignerServiceSid = 4U, ProcessRead = 5U, ProcessCompose = 6U,
  TokenRead = 7U, TokenCompose = 8U,
  TokenBeforeRead = 9U, TokenBeforeCompare = 10U, TokenDescriptor = 11U,
  TokenWrite = 12U, TokenAfterRead = 13U, TokenAfterCompare = 14U,
  ProcessBeforeRead = 15U, ProcessBeforeCompare = 16U, ProcessDescriptor = 17U,
  ProcessWrite = 18U, ProcessAfterRead = 19U, ProcessAfterCompare = 20U,
};
enum class WorkerInspectionFailure : std::uint8_t {
  None = 0U, WindowsApi = 1U, InvalidInput = 2U, MalformedDescriptor = 3U,
  UnexpectedOwner = 4U, AdministratorsOwner = 5U, UnsupportedAcl = 6U,
  UnsupportedAce = 7U, UnsupportedAceFlags = 8U, WorkerGrant = 9U,
  DescriptorChanged = 10U, Identity = 11U, AclBounds = 12U,
  LogonOwnerMismatch = 13U, LogonOwnerAttributes = 14U,
};
struct WorkerInspectionDiagnostic final {
  WorkerInspectionStage stage = WorkerInspectionStage::None;
  WorkerInspectionFailure failure = WorkerInspectionFailure::None;
  DWORD win32_error = ERROR_SUCCESS;
};

// 010 + five stage bits + eight reason bits + sixteen Win32 error bits.
// Unknown/absent diagnostics retain legacy 2060. An oversized Win32 error is
// represented by 0xffff (unavailable), never mistaken for a truncated error.
constexpr std::uint32_t WorkerInspectionServiceExitCode(
    const WorkerInspectionDiagnostic& diagnostic) noexcept {
  const auto stage = static_cast<std::uint32_t>(diagnostic.stage);
  const auto failure = static_cast<std::uint32_t>(diagnostic.failure);
  if (stage == 0U || stage > 20U || failure == 0U || failure > 14U) return 2060U;
  return UINT32_C(0x40000000) | (stage << 24U) | (failure << 16U) |
      (diagnostic.win32_error <= UINT32_C(0xffff) ? diagnostic.win32_error : UINT32_C(0xffff));
}

// Accept SYSTEM or the selected service's own SID as the existing owner.
// Preserve every existing ACE and add the fixed worker's query grant. The
// provisioner also grants identical inspection rights to its fixed availability
// broker; the cell controller never adds broker access.
// This composes a descriptor; it never mutates a kernel object or changes owner.
bool ComposeWorkerInspectionAcl(WorkerInspectionService service, PSID owner, PACL original,
    WorkerInspectionObject object, WorkerInspectionAcl* output,
    WorkerInspectionDiagnostic* diagnostic = nullptr) noexcept;

// The caller must first validate its complete service/SCM/installed identity.
// This routine independently requires a SYSTEM primary token in session zero,
// without impersonation, restriction or AppContainer, and the selected service
// SID enabled with owner eligibility. It accepts SYSTEM, that exact service SID,
// or the exact enabled, owner-eligible logon SID from this same token as each
// kernel object's owner. No caller-supplied logon identity is accepted. It changes only its own
// process and primary-token DACLs, retaining all original ACEs and protection.
// The worker receives QUERY_LIMITED_INFORMATION/SYNCHRONIZE and TOKEN_QUERY;
// the provisioner grants the same rights to its fixed availability broker.
// no privilege, control, duplication, memory access or token assignment is added.
bool GrantCurrentSystemWorkerInspectionAccess(
    WorkerInspectionService service, WorkerInspectionDiagnostic* diagnostic = nullptr) noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING) || defined(GOATCITADEL_SERVICE_INSPECTION_TESTING)
// Test-only mutation of the test process or an unassigned primary-token copy.
bool ApplyWorkerTokenInspectionForTest(HANDLE token, PSID expected_owner,
    WorkerInspectionDiagnostic* diagnostic = nullptr) noexcept;
bool ApplyWorkerProcessInspectionForTest(PSID expected_owner,
    WorkerInspectionDiagnostic* diagnostic = nullptr) noexcept;
bool MatchesInspectionServiceGroupForTest(WorkerInspectionService service, PSID sid, DWORD attributes) noexcept;
// Pure fixture seam for bounded TokenGroups parsing and owner selection. The
// production entrypoint obtains these bytes only from its own validated token.
bool ComposeWorkerInspectionAclWithGroupsForTest(WorkerInspectionService service,
    const BYTE* groups, std::size_t length, PSID owner, PACL original,
    WorkerInspectionObject object, WorkerInspectionAcl* output,
    WorkerInspectionDiagnostic* diagnostic = nullptr) noexcept;
#endif
}
