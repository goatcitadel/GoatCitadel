import { createApprovalCodeLoader } from "./use-deferred-approval-code";

export const specialistApprovalCode = createApprovalCodeLoader(() => import("./specialist-approval-code"));
