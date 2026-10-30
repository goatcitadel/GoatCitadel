import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./client-core.js", () => ({ request }));
import {
  fetchCapabilitySkillDetail,
  fetchCapabilitySkillDiscover,
  fetchCapabilitySkillInstalls,
  fetchCapabilitySkills,
  fetchCapabilitySkillUsage,
  requestCapabilitySkillOperation,
  reviewCapabilitySkill,
  setCapabilitySkillState,
} from "./capability-skills.js";

beforeEach(() => {
  request.mockClear();
});

it("requests the skill list for the encoded workspace", async () => {
  await fetchCapabilitySkills("a/b");
  expect(request).toHaveBeenCalledWith("/api/v1/capabilities/skills?workspaceId=a%2Fb", {
    cache: "no-store",
  });
});

it("forwards the abort signal on every read", async () => {
  const controller = new AbortController();
  await fetchCapabilitySkills("a/b", { signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills?workspaceId=a%2Fb", {
    cache: "no-store",
    signal: controller.signal,
  });
  await fetchCapabilitySkillDetail("a/b", "x", { signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/detail?workspaceId=a%2Fb&skillId=x", {
    cache: "no-store",
    signal: controller.signal,
  });
  await fetchCapabilitySkillUsage({ signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/usage", {
    cache: "no-store",
    signal: controller.signal,
  });
});

it("asks for fresh use counts only on refresh", async () => {
  await fetchCapabilitySkillUsage();
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/usage", { cache: "no-store" });
  await fetchCapabilitySkillUsage({ refresh: false });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/usage", { cache: "no-store" });
  await fetchCapabilitySkillUsage({ refresh: true });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/usage?refresh=true", { cache: "no-store" });
});

it("encodes the skill id in the details request", async () => {
  await fetchCapabilitySkillDetail("a/b", "pack/skill id&more");
  expect(request).toHaveBeenCalledWith(
    "/api/v1/capabilities/skills/detail?workspaceId=a%2Fb&skillId=pack%2Fskill+id%26more",
    { cache: "no-store" },
  );
});

it("sends the switch as a JSON POST and returns the Gateway's outcome", async () => {
  request.mockResolvedValueOnce({ status: "waiting", approvalId: "ap-1" } as never);
  const input = { workspaceId: "ws-1", skillId: "s-1", state: "enabled", expectedRevision: 3 } as const;
  const outcome = await setCapabilitySkillState(input);
  expect(request).toHaveBeenCalledWith("/api/v1/capabilities/skills/state", {
    method: "POST",
    body: JSON.stringify(input),
  });
  expect(outcome).toEqual({ status: "waiting", approvalId: "ap-1" });
});

it("asks Discover for the encoded workspace, and sends the search term and refresh only when asked", async () => {
  await fetchCapabilitySkillDiscover("a/b");
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/discover?workspaceId=a%2Fb", {
    cache: "no-store",
  });
  await fetchCapabilitySkillDiscover("a/b", { q: "", refresh: false });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/discover?workspaceId=a%2Fb", {
    cache: "no-store",
  });
  await fetchCapabilitySkillDiscover("ws-1", { q: "code & review", refresh: true });
  expect(request).toHaveBeenLastCalledWith(
    "/api/v1/capabilities/skills/discover?workspaceId=ws-1&q=code+%26+review&refresh=true",
    { cache: "no-store" },
  );
});

it("forwards the abort signal on the Discover and installs reads", async () => {
  const controller = new AbortController();
  await fetchCapabilitySkillDiscover("ws-1", { q: "pdf", signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/discover?workspaceId=ws-1&q=pdf", {
    cache: "no-store",
    signal: controller.signal,
  });
  await fetchCapabilitySkillInstalls("ws-1", { signal: controller.signal });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/installs?workspaceId=ws-1", {
    cache: "no-store",
    signal: controller.signal,
  });
});

it("reads the installs of the encoded workspace, and one check only when its id is given", async () => {
  await fetchCapabilitySkillInstalls("a/b");
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/installs?workspaceId=a%2Fb", {
    cache: "no-store",
  });
  await fetchCapabilitySkillInstalls("a/b", { snapshotId: "snap 1" });
  expect(request).toHaveBeenLastCalledWith("/api/v1/capabilities/skills/installs?workspaceId=a%2Fb&snapshotId=snap+1", {
    cache: "no-store",
  });
});

it("sends a check as a JSON POST with its own idempotency key and returns the checked skill", async () => {
  const checked = { snapshotId: "snap-1", step: "check_passed" };
  request.mockResolvedValueOnce(checked as never);
  const input = {
    workspaceId: "ws-1",
    source: { kind: "pack", packId: "himalaya" },
    idempotencyKey: "0b6f8f3e-7a53-4a58-9a0c-9e6a2f7b1a11",
  } as const;
  const install = await reviewCapabilitySkill(input);
  // No attempt key is passed: the client adds the Idempotency-Key header, and the body's key makes a retry hand back
  // the same check.
  expect(request).toHaveBeenCalledWith("/api/v1/capabilities/skills/reviews", {
    method: "POST",
    body: JSON.stringify(input),
  });
  expect(install).toBe(checked);
});

it("sends an install step as a JSON POST and returns the Gateway's outcome", async () => {
  request.mockResolvedValueOnce({ status: "waiting", approvalId: "ap-2" } as never);
  const input = { workspaceId: "ws-1", snapshotId: "snap-1", operationKind: "install_inactive" } as const;
  const outcome = await requestCapabilitySkillOperation(input);
  expect(request).toHaveBeenCalledWith("/api/v1/capabilities/skills/operations", {
    method: "POST",
    body: JSON.stringify(input),
  });
  expect(outcome).toEqual({ status: "waiting", approvalId: "ap-2" });
});
