#pragma once

#include "../../remote-worker-windows-host-native/src/service_inspection.hpp"

namespace goatcitadel::remote_worker_provisioner {

using SignerInspectionObject = worker_host::WorkerInspectionObject;
using SignerInspectionAcl = worker_host::WorkerInspectionAcl;
constexpr std::size_t kSignerInspectionAclBytes = worker_host::kWorkerInspectionAclBytes;

// Preserve every original ACE and append only the fixed worker's inspection
// grant. This composes a descriptor; it never changes a kernel object.
bool ComposeSignerInspectionAcl(PSID owner, PACL original,
    SignerInspectionObject object, SignerInspectionAcl* output) noexcept;

// Called only by the signer after its complete SCM/token identity validation,
// before arming transport. Targets only this process and its own primary token.
bool GrantCurrentSignerInspectionAccess() noexcept;

#if defined(GOATCITADEL_PROVISIONER_TESTING)
// Tests use their own process and a newly duplicated, unassigned token, with
// the test user's owner. These entrypoints are absent from production builds.
bool ApplySignerInspectionAclForTest(HANDLE token, PSID expected_owner) noexcept;
bool ApplySignerProcessInspectionForTest(PSID expected_owner) noexcept;
#endif

}  // namespace goatcitadel::remote_worker_provisioner
