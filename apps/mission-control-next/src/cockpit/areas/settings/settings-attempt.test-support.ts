import { vi, type Mock } from "vitest";

/**
 * Stands in for the Gateway's record of one Settings save. `capture` decides whether the save is reported with an
 * identity (as the real client does); `read` answers the attempt read (default: the Gateway finished it).
 */
export const settingsAttempt: { capture: boolean; read: Mock; key: string } = {
  capture: true,
  read: vi.fn(),
  key: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
};

/** Call in `beforeEach`: a vi.resetAllMocks() in `afterEach` clears the read. */
export function resetSettingsAttempt() {
  settingsAttempt.capture = true;
  settingsAttempt.read.mockReset();
  settingsAttempt.read.mockResolvedValue({ status: "completed", claimExpired: false });
}

/** The client-core module with the capture the real client does around a mutating request. */
export function withTrackedSettingsSave<T extends { getGatewayApiBaseUrl: () => string }>(original: T) {
  return {
    ...original,
    captureMutationAttempt: (
      dispatch: () => Promise<unknown>,
      onAttempt: (attempt: { attemptKey: string; method: string; path: string; installation: string }) => void,
    ) => {
      if (settingsAttempt.capture)
        onAttempt({
          attemptKey: settingsAttempt.key,
          method: "PATCH",
          path: "/api/v1/settings",
          installation: original.getGatewayApiBaseUrl(),
        });
      return dispatch();
    },
  };
}

/** The mutation-attempts module with the attempt read answered by `settingsAttempt.read`. */
export function withSettingsAttemptRead<T extends object>(original: T): T & { fetchMutationAttempt: Mock } {
  return { ...original, fetchMutationAttempt: settingsAttempt.read };
}
