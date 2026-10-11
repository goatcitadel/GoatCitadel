import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { CapabilityCatalogEntry, SkillListItem } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { fetchSkills, updateSkillState } from "@goatcitadel/mission-control-shared/api/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCapabilitySkillAttemptsForTests, useCapabilitySkillState } from "./use-capability-skill-state";

vi.mock("@goatcitadel/mission-control-shared/api/skills", () => ({ fetchSkills: vi.fn(), updateSkillState: vi.fn() }));

const item: CapabilityCatalogEntry = {
  capabilityId: "skill:review",
  kind: "skill",
  category: "built_in",
  title: "Review",
  summary: "Review code",
  callable: true,
  skillId: "review",
};
const skill: SkillListItem = {
  skillId: "review",
  name: "Review",
  source: "bundled",
  dir: "skills/review",
  declaredTools: [],
  requires: [],
  keywords: [],
  instructionBody: "Review code",
  mtime: "2026-09-28T00:00:00.000Z",
  revision: 4,
  state: "enabled",
};
type HookValue = ReturnType<typeof useCapabilitySkillState>;
let latest!: HookValue;
const onRefresh = vi.fn<() => void>();
function Harness() {
  latest = useCapabilitySkillState({ item, skill, skillsKnown: true, workspaceId: "workspace-a", onRefresh });
  return null;
}
const http = (status: number) =>
  new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/api/v1/skills/review/state", status, body: { message: "Expected revision does not match." } });

let renderer: ReactTestRenderer | null = null;
beforeEach(async () => {
  __resetCapabilitySkillAttemptsForTests();
  onRefresh.mockClear();
  vi.mocked(fetchSkills).mockReset().mockResolvedValue({ items: [skill] });
  vi.mocked(updateSkillState).mockReset();
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(() => {
  renderer?.unmount();
  renderer = null;
});

async function confirmRequest() {
  await act(async () => latest.requestReview("disabled"));
  await act(async () => latest.confirm());
}

describe("useCapabilitySkillState failure classification", () => {
  it.each([400, 409])("leaves requests available after a Gateway %s refusal and shows its summary", async (status) => {
    vi.mocked(updateSkillState).mockRejectedValueOnce(http(status));
    await confirmRequest();
    expect(updateSkillState).toHaveBeenCalledOnce();
    expect(latest.locked).toBe(false);
    expect(latest.pending).toBe(false);
    expect(latest.target).toBeNull();
    expect(latest.error).toContain(status === 409 ? "This changed somewhere else" : "Expected revision does not match.");
    expect(latest.error).not.toContain("uncertain");
    vi.mocked(updateSkillState).mockResolvedValueOnce({
      pendingApproval: null,
      noMutationRequired: true,
      skillState: { skillId: "review", revision: 4, state: "disabled", updatedAt: skill.mtime },
    });
    await confirmRequest();
    expect(updateSkillState).toHaveBeenCalledTimes(2);
    expect(latest.error).toBeUndefined();
    expect(latest.notice).toContain("already Disabled");
  });

  it.each(["network", "5xx"])("keeps a %s failure after dispatch uncertain and locked", async (kind) => {
    vi.mocked(updateSkillState).mockRejectedValueOnce(
      kind === "network" ? new ApiRequestError("Network error", { kind: "network", method: "POST", path: "/x" }) : http(503),
    );
    await confirmRequest();
    expect(latest.locked).toBe(true);
    expect(latest.error).toContain("Request outcome is uncertain");
    await confirmRequest();
    expect(updateSkillState).toHaveBeenCalledOnce();
  });
});
