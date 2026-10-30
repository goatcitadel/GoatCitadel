import { beforeEach, expect, it, vi } from "vitest";

const fetchCapabilitySkills = vi.hoisted(() => vi.fn(async () => ({ items: [] })));
const fetchCapabilitySkillUsage = vi.hoisted(() => vi.fn(async () => ({ skills: [] })));
const fetchCapabilitySkillDetail = vi.hoisted(() => vi.fn(async () => ({ skillId: "s-1" })));
const fetchCapabilitySkillDiscover = vi.hoisted(() => vi.fn(async () => ({ items: [] })));
const fetchCapabilitySkillInstalls = vi.hoisted(() => vi.fn(async () => ({ installs: [] })));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => ({
  fetchCapabilitySkills,
  fetchCapabilitySkillUsage,
  fetchCapabilitySkillDetail,
  fetchCapabilitySkillDiscover,
  fetchCapabilitySkillInstalls,
}));

import {
  skillDetailQuery,
  skillDiscoverQuery,
  skillInstallsQuery,
  skillListQuery,
  skillUsageQuery,
} from "./capability-skills-query";
import { queryKeys } from "./query-keys";

beforeEach(() => {
  fetchCapabilitySkills.mockClear();
  fetchCapabilitySkillUsage.mockClear();
  fetchCapabilitySkillDetail.mockClear();
  fetchCapabilitySkillDiscover.mockClear();
  fetchCapabilitySkillInstalls.mockClear();
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

it("reads Discover under a key that names the workspace and the search term, and sends the term only when there is one", async () => {
  const signal = new AbortController().signal;
  const plain = skillDiscoverQuery("ws-1", "");
  expect(plain.queryKey).toEqual(["skills", "capability-skill-discover", "ws-1", ""]);
  expect(plain.queryKey).toEqual(queryKeys.capabilitySkillDiscover("ws-1", ""));
  await plain.queryFn?.({ signal } as never);
  expect(fetchCapabilitySkillDiscover).toHaveBeenLastCalledWith("ws-1", { signal });

  const searched = skillDiscoverQuery("ws-1", "pdf");
  expect(searched.queryKey).not.toEqual(plain.queryKey);
  expect(skillDiscoverQuery("ws-2", "pdf").queryKey).not.toEqual(searched.queryKey);
  await searched.queryFn?.({ signal } as never);
  expect(fetchCapabilitySkillDiscover).toHaveBeenLastCalledWith("ws-1", { q: "pdf", signal });
});

it("reads the installs under a key that names the workspace", async () => {
  const options = skillInstallsQuery("ws-1");
  expect(options.queryKey).toEqual(["skills", "capability-skill-installs", "ws-1"]);
  expect(options.queryKey).toEqual(queryKeys.capabilitySkillInstalls("ws-1"));
  const signal = new AbortController().signal;
  await options.queryFn?.({ signal } as never);
  expect(fetchCapabilitySkillInstalls).toHaveBeenCalledWith("ws-1", { signal });
});
