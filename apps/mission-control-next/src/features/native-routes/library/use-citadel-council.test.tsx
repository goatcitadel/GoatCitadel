// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfileRecord, CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { useCitadelCouncil } from "./use-citadel-council";
import { __resetCitadelAccessAttemptsForTests } from "./citadel-access-state";
import { overviewStructure } from "./citadel-overview.test-support";
const api = vi.hoisted(() => ({
  getCitadelAccessSnapshot: vi.fn(),
  assignCitadelCouncilAgent: vi.fn(),
  unassignCitadelCouncilAgent: vi.fn(),
  fetchAgents: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => "http://one" }));
const agent: AgentProfileRecord = {
  agentId: "research",
  roleId: "researcher",
  name: "Research",
  title: "Researcher",
  summary: "Existing research profile",
  specialties: [],
  defaultTools: [],
  aliases: [],
  isBuiltin: false,
  editable: true,
  lifecycleStatus: "active",
  status: "idle",
  sessionCount: 0,
  activeSessions: 0,
  createdAt: "now",
  updatedAt: "now",
};
const fixture = (id = "one"): CitadelAccessSnapshot => ({
  citadelId: id,
  revision: "a".repeat(64),
  structure: { ...overviewStructure(), citadelId: id },
  council: [],
  wards: [],
  passages: [],
  members: [],
  integrations: [],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root,
  container: HTMLDivElement,
  scope: string,
  owner: CitadelAccessSnapshot,
  control: ReturnType<typeof useCitadelCouncil>;
function Harness() {
  control = useCitadelCouncil(scope);
  return <p>{control.notice}</p>;
}
async function render(next = scope) {
  scope = next;
  await act(async () => root.render(<Harness />));
}
async function review() {
  await act(async () => control.request("assign"));
  expect(control.review?.agentId).toBe(agent.agentId);
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetCitadelAccessAttemptsForTests();
  scope = "one";
  owner = fixture();
  api.getCitadelAccessSnapshot.mockImplementation(async () => structuredClone(owner));
  api.fetchAgents.mockResolvedValue({ items: [structuredClone(agent)] });
  api.assignCitadelCouncilAgent.mockImplementation(async (id: string, agentId: string) => {
    owner = {
      ...owner,
      revision: "b".repeat(64),
      council: [{ assignmentId: "seat", citadelId: id, agentId, createdAt: "now" }],
    };
    return structuredClone(owner);
  });
  api.unassignCitadelCouncilAgent.mockImplementation(async () => {
    owner = { ...owner, revision: "c".repeat(64), council: [] };
    return structuredClone(owner);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
describe("shared Council lifetime and exact review", () => {
  it("requires explicit confirmation and proves the exact saved seat without starting an agent", async () => {
    await review();
    expect(api.assignCitadelCouncilAgent).not.toHaveBeenCalled();
    await act(async () => control.confirm());
    expect(api.assignCitadelCouncilAgent).toHaveBeenCalledWith("one", "research", "a".repeat(64));
    expect(control.council.items).toEqual(owner.council);
    expect(control.notice).toBe("Agent seated in this Citadel.");
    expect(api.fetchAgents).toHaveBeenCalledTimes(2);
    expect(api.getCitadelAccessSnapshot).toHaveBeenCalledTimes(3);
  });
  it.each(["cancel", "selection", "inspection", "refresh", "scope-round-trip"])(
    "withholds dispatch when %s changes during agent preflight",
    async (kind) => {
      await review();
      const reply = deferred<{ items: AgentProfileRecord[] }>();
      api.fetchAgents.mockReturnValueOnce(reply.promise);
      let saving!: Promise<void>;
      await act(async () => {
        saving = control.confirm();
      });
      if (kind === "cancel") await act(async () => control.cancel());
      if (kind === "selection") await act(async () => control.setSelectedAgentId("different"));
      if (kind === "inspection") await act(async () => control.setSelectedSeatId("different-seat"));
      if (kind === "refresh") await act(async () => control.reloadAgents());
      if (kind === "scope-round-trip") {
        owner = fixture("two");
        await render("two");
        owner = fixture();
        await render("one");
      }
      await act(async () => {
        reply.resolve({ items: [agent] });
        await saving;
      });
      expect(api.assignCitadelCouncilAgent).not.toHaveBeenCalled();
      expect(control.access.attempt.phase).toBe("idle");
    },
  );
  it("requires another review when the actual selected profile changes", async () => {
    await review();
    const changed = { ...agent, summary: "Peer changed profile" };
    api.fetchAgents.mockResolvedValue({ items: [changed] });
    await act(async () => control.confirm());
    expect(api.assignCitadelCouncilAgent).not.toHaveBeenCalled();
    expect(control.notice).toContain("profile changed");
    expect(control.council.agents).toEqual([changed]);
    await review();
    await act(async () => control.confirm());
    expect(api.assignCitadelCouncilAgent).toHaveBeenCalledTimes(1);
  });
  it("suppresses a late confirmation notice after a new operator selection", async () => {
    api.fetchAgents.mockResolvedValue({ items: [agent, { ...agent, agentId: "different", name: "Other profile" }] });
    await act(async () => control.reloadAgents());
    await review();
    const reply = deferred<CitadelAccessSnapshot>();
    api.assignCitadelCouncilAgent.mockReturnValueOnce(reply.promise);
    let saving!: Promise<void>;
    await act(async () => {
      saving = control.confirm();
    });
    await act(async () => control.setSelectedAgentId("different"));
    owner = {
      ...owner,
      revision: "b".repeat(64),
      council: [{ assignmentId: "seat", citadelId: "one", agentId: "research", createdAt: "now" }],
    };
    await act(async () => {
      reply.resolve(owner);
      await saving;
    });
    expect(control.notice).toBeNull();
    expect(control.selectedAgentId).toBe("different");
    expect(control.council.items).toEqual(owner.council);
  });
  it("retains an unconfirmed seat mutation across remount", async () => {
    await review();
    api.assignCitadelCouncilAgent.mockRejectedValue(new Error("Response lost"));
    await act(async () => control.confirm());
    await act(async () => root.render(<p>Closed</p>));
    await render();
    expect(control.access.ready).toBe(false);
    expect(control.access.error).toContain("unconfirmed");
    await act(async () => {
      control.request("assign");
      void control.confirm();
    });
    expect(api.assignCitadelCouncilAgent).toHaveBeenCalledTimes(1);
  });
  it("removes a saved reference with an unavailable profile while retaining unrelated access rows", async () => {
    owner = {
      ...owner,
      council: [{ assignmentId: "missing-seat", citadelId: "one", agentId: "missing-profile", createdAt: "now" }],
    };
    api.fetchAgents.mockResolvedValue({ items: [] });
    await act(async () => {
      await control.access.reload();
      await control.reloadAgents();
    });
    await act(async () => control.request("remove", "missing-profile"));
    expect(control.review?.profile).toBeUndefined();
    await act(async () => control.confirm());
    expect(api.unassignCitadelCouncilAgent).toHaveBeenCalledWith("one", "missing-profile", "a".repeat(64));
    expect(control.council.items).toEqual([]);
  });
});
