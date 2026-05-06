import { describe, expect, it } from "vitest";
import {
  AGENTIC_HARNESS_REGISTRY,
  probeAgenticHarnessAvailability,
  type AgenticHarnessId,
} from "./agentic-harness-availability.js";

describe("probeAgenticHarnessAvailability", () => {
  it("emits registry-backed records for all external harnesses and the governed scripted runner", () => {
    expect(AGENTIC_HARNESS_REGISTRY.map((entry) => entry.harnessId)).toEqual([
      "codex_cli",
      "claude_code",
      "opencode",
      "gemini_cli",
      "acp",
      "scripted_runner",
    ]);

    const records = probeAgenticHarnessAvailability({
      env: {
        OPENAI_API_KEY: "test-openai",
        GEMINI_API_KEY: "test-gemini",
        GOATCITADEL_ACP_ENDPOINT: "http://127.0.0.1:9000",
      },
      now: () => "2026-05-05T00:00:00.000Z",
      resolveExecutable: (command) =>
        ({
          codex: "/usr/local/bin/codex",
          claude: "/usr/local/bin/claude",
          gemini: "/usr/local/bin/gemini",
          acp: "/usr/local/bin/acp",
        })[command],
      permissions: {
        codex_cli: true,
        claude_code: true,
        gemini_cli: false,
        acp: true,
        scripted_runner: true,
      },
      sandbox: { required: true, satisfied: true },
      sandboxByHarness: {
        acp: {
          required: true,
          satisfied: false,
          reason: "ACP adapter must run in a per-run sandbox before callable exposure.",
        },
      },
      policyApprovedToolNames: ["memory.read", "artifact.write"],
    });

    expect(records).toHaveLength(6);
    expect(statusByHarness(records)).toEqual({
      codex_cli: "callable",
      claude_code: "not_configured",
      opencode: "unavailable",
      gemini_cli: "blocked",
      acp: "blocked",
      scripted_runner: "callable",
    });
    expect(records.find((record) => record.harnessId === "codex_cli")).toMatchObject({
      executablePath: "/usr/local/bin/codex",
      callable: true,
      reasons: [],
      sandboxRequired: true,
      sandboxSatisfied: true,
    });
    expect(records.find((record) => record.harnessId === "claude_code")?.reasons).toContain(
      "config: Harness configuration is missing. Checked env keys: ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR.",
    );
    expect(records.find((record) => record.harnessId === "opencode")?.reasons).toEqual(
      expect.arrayContaining([
        "executable: Executable not found. Checked: opencode.",
        "config: Harness configuration is missing. Checked env keys: OPENCODE_AUTH_TOKEN, OPENCODE_CONFIG_DIR.",
        "permission: Harness is not policy-approved for callable execution.",
      ]),
    );
    expect(records.find((record) => record.harnessId === "gemini_cli")?.reasons).toContain(
      "permission: Harness is not policy-approved for callable execution.",
    );
    expect(records.find((record) => record.harnessId === "acp")?.reasons).toContain(
      "sandbox: ACP adapter must run in a per-run sandbox before callable exposure.",
    );
  });

  it("marks scripted runner not configured until policy-approved tool names are provided", () => {
    const scriptedRunner = probeAgenticHarnessAvailability({
      env: {},
      now: () => "2026-05-05T00:00:00.000Z",
      resolveExecutable: () => undefined,
      permissions: { scripted_runner: true },
      sandbox: { required: true, satisfied: true },
      policyApprovedToolNames: [],
    }).find((record) => record.harnessId === "scripted_runner");

    expect(scriptedRunner).toMatchObject({
      status: "not_configured",
      callable: false,
      executablePath: undefined,
    });
    expect(scriptedRunner?.reasons).toContain(
      "config: No policy-approved tool names were provided for the scripted runner.",
    );
  });

  it("hides configured harness capability when the executable is missing", () => {
    const codex = probeAgenticHarnessAvailability({
      env: { OPENAI_API_KEY: "test-openai" },
      now: () => "2026-05-05T00:00:00.000Z",
      resolveExecutable: () => undefined,
      permissions: { codex_cli: true },
      sandbox: { required: true, satisfied: true },
    }).find((record) => record.harnessId === "codex_cli");

    expect(codex).toMatchObject({
      status: "unavailable",
      callable: false,
      executablePath: undefined,
    });
    expect(codex?.reasons).toContain("executable: Executable not found. Checked: codex.");
  });
});

function statusByHarness(
  records: Array<{ harnessId: AgenticHarnessId; status: string }>,
): Record<AgenticHarnessId, string> {
  return Object.fromEntries(records.map((record) => [record.harnessId, record.status])) as Record<
    AgenticHarnessId,
    string
  >;
}
