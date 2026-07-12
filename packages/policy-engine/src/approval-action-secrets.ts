const RAW_REMOTE_APPROVAL_BEARER_PATTERN = /grat_[A-Za-z0-9_-]{43}/i;

export function assertNoRawRemoteApprovalBearer(value: unknown): void {
  if (RAW_REMOTE_APPROVAL_BEARER_PATTERN.test(JSON.stringify(value ?? null))) {
    throw new Error("Raw remote approval bearers are not accepted in tool arguments; use a protected template.");
  }
}
