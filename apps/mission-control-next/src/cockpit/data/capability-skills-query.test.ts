import { beforeEach, expect, it, vi } from "vitest";

const fetchCapabilitySkills = vi.hoisted(() => vi.fn(async () => ({ items: [] })));
const fetchCapabilitySkillUsage = vi.hoisted(() => vi.fn(async () => ({ skills: [] })));
const fetchCapabilitySkillDetail = vi.hoisted(() => vi.fn(async () => ({ skillId: "s-1" })));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => ({
  fetchCapabilitySkills,
  fetchCapabilitySkillUsage,
  fetchCapabilitySkillDetail,
}));

import { skillDetailQuery, skillListQuery, skillUsageQuery } from "./capability-skills-query";
import { queryKeys } from "./query-keys";

beforeEach(() => {
  fetchCapabilitySkills.mockClear();
  fetchCapabilitySkillUsage.mockClear();
  fetchCapabilitySkillDetail.mockClear();
});

it("reads the skill list for the workspace under its own key, passing the abort signal", async () => {
  const options = skillListQuery("ws-1");
  expect(options.queryKey).toEqual(queryKeys.capabilitySkills("ws-1"));
  expect(options.staleTime).toBeUndefined();
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilitySkills).toHaveBeenCalledWith("ws-1", { signal });
});

it("reads the use counts without asking for a re-count, and treats them as fresh for a minute", async () => {
  const options = skillUsageQuery();
  expect(options.queryKey).toEqual(queryKeys.capabilitySkillUsage());
  expect(options.staleTime).toBe(60_000);
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilitySkillUsage).toHaveBeenCalledWith({ signal });
});

it("reads one skill's details under a key that names the workspace and the skill", async () => {
  const options = skillDetailQuery("ws-1", "s-1");
  expect(options.queryKey).toEqual(queryKeys.capabilitySkillDetail("ws-1", "s-1"));
  expect(options.queryKey).not.toEqual(queryKeys.capabilitySkillDetail("ws-1", "s-2"));
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilitySkillDetail).toHaveBeenCalledWith("ws-1", "s-1", { signal });
});
