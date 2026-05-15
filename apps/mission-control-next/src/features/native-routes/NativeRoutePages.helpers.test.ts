import { describe, expect, it } from "vitest";
import {
  dedupeAgentProfiles,
  deriveCapabilityStatus,
  formatBytes,
  formatDateTime,
  formatEvidenceMetadata,
  formatPercent,
  formatTaskStatus,
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

function capability(overrides: Record<string, unknown>) {
  return {
    capabilityId: "capability-a",
    title: "Capability A",
    kind: "tool",
    category: "ops",
    summary: "Operational capability.",
    callable: false,
    lifecycleState: "active",
    ...overrides,
  } as any;
}

describe("NativeRoutePages helper tails", () => {
  it("preserves native load data and records fallback issues", async () => {
    await expect(nativeLoad("Tasks", Promise.resolve({ items: [1] }), { items: [] })).resolves.toEqual({
      data: { items: [1] },
      issue: null,
    });

    const failed = await nativeLoad("Tasks", Promise.reject(new Error("gateway offline")), { items: [] });
    expect(failed).toEqual({
      data: { items: [] },
      issue: { label: "Tasks", message: "gateway offline" },
    });
    expect(nativeLoadIssues([{ data: {}, issue: null }, failed])).toEqual([failed.issue]);
  });

  it("dedupes agent profiles and keeps route sections stable", () => {
    expect(
      dedupeAgentProfiles([
        { agentId: "", roleId: "architect", name: "Architect", marker: 1 },
        { agentId: "", roleId: "architect", name: "ARCHITECT", marker: 2 },
        { agentId: "agent-2", roleId: "coder", name: "Coder", marker: 3 },
      ]),
    ).toEqual([
      { agentId: "", roleId: "architect", name: "Architect", marker: 1 },
      { agentId: "agent-2", roleId: "coder", name: "Coder", marker: 3 },
    ]);
    expect(routeSectionWithDefault({ area: "library" } as any, "agents")).toBe("agents");
    expect(routeSectionWithDefault({ area: "library", section: "skills" } as any, "agents")).toBe("skills");
  });

  it("merges capability catalog truth and classifies every operator posture", () => {
    const merged = mergeCapabilities(
      [
        capability({ capabilityId: "b", title: "B", sourceRef: "skill://b" }),
        capability({ capabilityId: "a", title: "A", lifecycleState: "deprecated" }),
      ],
      [capability({ capabilityId: "b", title: "B", callable: true, reviewWarning: "Needs review" })],
    );
    expect(merged.map((item) => [item.capabilityId, item.callable])).toEqual([
      ["a", false],
      ["b", true],
    ]);

    const cases = [
      [capability({ lifecycleState: "revoked" }), "unavailable"],
      [capability({ reviewWarning: "Bad evidence" }), "degraded"],
      [capability({ lifecycleState: "deprecated" }), "degraded"],
      [capability({ callable: true }), "available"],
      [capability({ kind: "proposal" }), "inspect-only"],
      [capability({ kind: "candidate_skill" }), "inspect-only"],
      [capability({ sourceProvider: "mcp" }), "configured"],
      [capability({ toolName: "browser.search" }), "configured"],
      [capability({ skillId: "skill-1" }), "configured"],
      [capability({ capabilityId: "empty", title: "Empty" }), "unavailable"],
    ] as const;
    for (const [item, status] of cases) {
      expect(deriveCapabilityStatus(item).status).toBe(status);
    }
    expect(summarizeCapabilityCounts(cases.map(([item]) => item))).toMatchObject({
      all: cases.length,
      available: 1,
      configured: 3,
      "inspect-only": 2,
      degraded: 2,
      unavailable: 2,
    });
  });

  it("serializes evaluation drafts and rejects malformed operator entries", () => {
    const scenarios = [{ title: "Trace", prompt: "Trace it", expectedOutcome: "Evidence" }];
    const criteria = [{ label: "Grounded", description: "Uses evidence", requiredTerms: ["hash", "source"] }];

    expect(serializeScenarioDrafts(scenarios as any)).toBe("Trace | Trace it | Evidence");
    expect(serializeCriterionDrafts(criteria as any)).toBe("Grounded | Uses evidence | hash, source");
    expect(parseScenarioDrafts("")).toBeUndefined();
    expect(parseCriterionDrafts("")).toBeUndefined();
    expect(parseScenarioDrafts("Trace | Trace it | Evidence")).toEqual(scenarios);
    expect(parseCriterionDrafts("Grounded | Uses evidence | hash, source")).toEqual(criteria);
    expect(() => parseScenarioDrafts("missing | fields")).toThrow("Scenario line 1");
    expect(() => parseCriterionDrafts("missing")).toThrow("Criterion line 1");
  });

  it("formats native route metadata without inventing missing truth", () => {
    expect(splitCommaList(" alpha, , beta ")).toEqual(["alpha", "beta"]);
    expect(formatEvidenceMetadata()).toBeUndefined();
    expect(formatEvidenceMetadata({ run: "run-1", score: 0.82, extra: true, ignored: "tail" })).toBe(
      "run: run-1 · score: 0.82 · extra: true",
    );
    expect(formatPercent(Number.NaN)).toBe("n/a");
    expect(formatPercent(0.824)).toBe("82%");
    expect(truncateText("short", 20)).toBe("short");
    expect(truncateText("alpha beta gamma", 10)).toBe("alpha beta\n\n…");
    expect(formatDateTime()).toBe("Unknown");
    expect(formatDateTime("bad-date")).toBe("bad-date");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatTaskStatus("needs_operator_review")).toBe("Needs Operator Review");
  });

  it("reads nested payload evidence without trusting malformed entries", () => {
    const payload = {
      output: {
        title: "  Evidence packet  ",
        score: 42,
        ignored: "",
      },
      evidenceRefs: [
        null,
        "bad",
        { refType: "trace", refId: "trace-1", hash: "sha-1", metadata: { runId: "run-1" } },
        { refType: "artifact", refId: "artifact-1", hash: 7, metadata: ["bad"] },
        { refType: "", refId: "missing-type" },
      ],
    };

    expect(readPayloadPath(null, "output.title")).toBeUndefined();
    expect(readPayloadPath([], "output.title")).toBeUndefined();
    expect(readPayloadPath(payload, "output.title")).toBe("  Evidence packet  ");
    expect(readPayloadPath(payload, "output.missing.value")).toBeUndefined();
    expect(readPayloadString(payload, ["output.ignored", "output.score"])).toBe("42");
    expect(readPayloadString(payload, ["output.missing"])).toBeUndefined();
    expect(readPayloadEvidenceRefs({ evidenceRefs: "bad" })).toEqual([]);
    expect(readPayloadEvidenceRefs(payload)).toEqual([
      { refType: "trace", refId: "trace-1", hash: "sha-1", metadata: { runId: "run-1" } },
      { refType: "artifact", refId: "artifact-1", hash: undefined, metadata: undefined },
    ]);
  });
});
