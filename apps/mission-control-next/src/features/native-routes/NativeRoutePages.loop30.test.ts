import { describe, expect, it } from "vitest";
import {
  dedupeAgentProfiles,
  deriveCapabilityStatus,
  formatBytes,
  formatDateTime,
  formatEvidenceMetadata,
  formatPercent,
  formatTaskStatus,
  getErrorMessage,
  mergeCapabilities,
  nativeLoad,
  nativeLoadIssues,
  parseCriterionDrafts,
  parseScenarioDrafts,
  readPayloadEvidenceRefs,
  readPayloadPath,
  readPayloadString,
  routeSectionWithDefault,
  serializeCriterionDrafts,
  serializeScenarioDrafts,
  splitCommaList,
  summarizeCapabilityCounts,
  truncateText,
} from "./NativeRoutePages";

const capability = (overrides: Record<string, unknown>) =>
  ({
    capabilityId: "cap",
    title: "Capability",
    kind: "tool",
    lifecycleState: "active",
    callable: false,
    ...overrides,
  }) as any;

describe("NativeRoutePages loop 30 helper matrix", () => {
  it("loads native data, dedupes agents, and preserves route defaults", async () => {
    await expect(nativeLoad("ok", Promise.resolve({ ok: true }), { ok: false })).resolves.toEqual({
      data: { ok: true },
      issue: null,
    });
    const failed = await nativeLoad("bad", Promise.reject(new Error("offline")), { ok: false });
    expect(failed.issue).toEqual({ label: "bad", message: "offline" });
    expect(nativeLoadIssues([{ data: {}, issue: null }, failed])).toEqual([failed.issue]);

    expect(
      dedupeAgentProfiles([
        { agentId: "", roleId: "qa", name: "QA", mark: 1 },
        { agentId: "", roleId: "qa", name: "QA", mark: 2 },
        { agentId: "agent-1", roleId: "coder", name: "Coder", mark: 3 },
      ]),
    ).toEqual([
      { agentId: "", roleId: "qa", name: "QA", mark: 1 },
      { agentId: "agent-1", roleId: "coder", name: "Coder", mark: 3 },
    ]);
    expect(routeSectionWithDefault({ area: "library" } as any, "skills")).toBe("skills");
    expect(routeSectionWithDefault({ area: "library", section: "memory" } as any, "skills")).toBe("memory");
  });

  it("classifies capability truth states and summarizes every filter bucket", () => {
    const merged = mergeCapabilities(
      [capability({ capabilityId: "b", title: "B" }), capability({ capabilityId: "a", title: "A" })],
      [capability({ capabilityId: "b", callable: true, sourceProvider: "mcp" })],
    );
    expect(merged.map((item) => item.capabilityId)).toEqual(["a", "b"]);
    expect(merged.find((item) => item.capabilityId === "b")?.callable).toBe(true);

    const items = [
      capability({ lifecycleState: "revoked" }),
      capability({ reviewWarning: "Stale" }),
      capability({ callable: true }),
      capability({ kind: "proposal" }),
      capability({ sourceProvider: "mcp" }),
      capability({ toolName: "browser.search" }),
      capability({ skillId: "skill-1" }),
      capability({ capabilityId: "empty" }),
    ];
    expect(items.map((item) => deriveCapabilityStatus(item).status)).toEqual([
      "unavailable",
      "degraded",
      "available",
      "inspect-only",
      "configured",
      "configured",
      "configured",
      "unavailable",
    ]);
    expect(summarizeCapabilityCounts(items)).toMatchObject({
      all: 8,
      available: 1,
      configured: 3,
      degraded: 1,
      "inspect-only": 1,
      unavailable: 2,
    });
  });

  it("serializes drafts and reads evidence payloads defensively", () => {
    expect(splitCommaList(" a, ,b ")).toEqual(["a", "b"]);
    expect(serializeScenarioDrafts([{ title: "T", prompt: "P", expectedOutcome: "E" }] as any)).toBe("T | P | E");
    expect(serializeCriterionDrafts([{ label: "L", description: "D", requiredTerms: ["a", "b"] }] as any)).toBe(
      "L | D | a, b",
    );
    expect(parseScenarioDrafts("")).toBeUndefined();
    expect(parseCriterionDrafts("")).toBeUndefined();
    expect(() => parseScenarioDrafts("only | two")).toThrow("Scenario line 1");
    expect(() => parseCriterionDrafts("only")).toThrow("Criterion line 1");

    const payload = {
      output: { title: "  Packet  ", score: 42, empty: "" },
      evidenceRefs: [
        "bad",
        { refType: "trace", refId: "trace-1", hash: "sha", metadata: { runId: "run-1" } },
        { refType: "artifact", refId: "artifact-1", hash: 12, metadata: [] },
      ],
    };
    expect(readPayloadPath(payload, "output.title")).toBe("  Packet  ");
    expect(readPayloadPath(payload, "output.missing.value")).toBeUndefined();
    expect(readPayloadString(payload, ["output.empty", "output.score"])).toBe("42");
    expect(readPayloadEvidenceRefs(payload)).toEqual([
      { refType: "trace", refId: "trace-1", hash: "sha", metadata: { runId: "run-1" } },
      { refType: "artifact", refId: "artifact-1", hash: undefined, metadata: undefined },
    ]);
  });

  it("formats operator metadata without inventing missing data", () => {
    expect(formatEvidenceMetadata()).toBeUndefined();
    expect(formatEvidenceMetadata({ run: "run-1", count: 2, ok: true, ignored: "x" })).toBe(
      "run: run-1 · count: 2 · ok: true",
    );
    expect(formatPercent(Number.NaN)).toBe("n/a");
    expect(formatPercent(0.501)).toBe("50%");
    expect(truncateText("short", 20)).toBe("short");
    expect(truncateText("alpha beta gamma", 10)).toBe("alpha beta\n\n…");
    expect(formatDateTime(null)).toBe("Unknown");
    expect(formatDateTime("bad-date")).toBe("bad-date");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatTaskStatus("waiting_for_human")).toBe("Waiting For Human");
  });

  it("covers native helper fallback branches for malformed payloads and valid draft parsing", () => {
    expect(parseScenarioDrafts("Title | Prompt | Expected")).toEqual([
      { title: "Title", prompt: "Prompt", expectedOutcome: "Expected" },
    ]);
    expect(parseCriterionDrafts("Label | Description")).toEqual([
      { label: "Label", description: "Description", requiredTerms: undefined },
    ]);
    expect(readPayloadPath(null, "output.title")).toBeUndefined();
    expect(readPayloadPath([], "output.title")).toBeUndefined();
    expect(readPayloadPath({ output: [] }, "output.title")).toBeUndefined();
    expect(readPayloadString({ output: { empty: "   ", bad: false } }, ["output.empty", "output.bad"])).toBeUndefined();
    expect(readPayloadEvidenceRefs({ evidenceRefs: "not-array" })).toEqual([]);
    expect(readPayloadEvidenceRefs({ evidenceRefs: [{ refType: "trace" }, null, []] })).toEqual([]);
    expect(formatEvidenceMetadata({})).toBeUndefined();
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 1024 * 15)).toBe("15 GB");
    expect(formatTaskStatus("__")).toBe("");
    expect(getErrorMessage(new Error("native down"))).toBe("native down");
    expect(getErrorMessage("bad")).toBe("bad");
  });
});
