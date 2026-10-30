import { beforeEach, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./client-core.js", () => ({ request }));
import {
  fetchCapabilitySkillDetail,
  fetchCapabilitySkills,
  fetchCapabilitySkillUsage,
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
