import { describe, expect, it } from "vitest";
import { formatExecutionBackend } from "./format";

describe("Build workbench formatting", () => {
  it("formats Code Mode execution backend posture without implying missing evidence", () => {
    expect(formatExecutionBackend()).toBe("not recorded");
    expect(
      formatExecutionBackend({
        backendId: "trusted-code-host",
        kind: "host",
        label: "Trusted-code host runner",
        status: "active",
        runtimeSupport: "active_runner",
        isolationProfile: "best_effort_host/temp_only/no_network",
      }),
    ).toBe("Trusted-code host runner · host · active · active_runner · best_effort_host/temp_only/no_network");
    expect(
      formatExecutionBackend({
        backendId: "aider-cli-adapter",
        kind: "aider_adapter",
        label: "Aider CLI adapter",
        status: "preview",
        runtimeSupport: "preview_only",
        adapterForBackendId: "docker-container",
      }),
    ).toBe("Aider CLI adapter · aider_adapter · preview · preview_only · adapter for docker-container");
  });
});
