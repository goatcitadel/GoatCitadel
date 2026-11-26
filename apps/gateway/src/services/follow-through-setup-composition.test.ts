import { expect, it, vi } from "vitest";
import { createFollowThroughSetupForGateway } from "./follow-through-setup-composition.js";
it("review binds current conversation preferences and actual quiet-hour zone without changing settings", async () => {
  let prefs = { revision: 1, providerId: "local", model: "fixture" },
    autonomy = { revision: 1, activeHours: { start: 12, end: 18, tz: "Asia/Kathmandu" } };
  const create = vi.fn(),
    gateway = {
      storage: {
        chatSessionMeta: {
          get: async () => ({
            workspaceId: "w",
            origin: "operator",
            lifecycleStatus: "active",
            lifecycleIntentId: "incarnation",
          }),
        },
        sessions: { getBySessionId: async () => ({ kind: "dm" }) },
        chatSessionPrefs: { get: async () => prefs },
        sessionAutonomyPrefs: { get: async () => autonomy },
        integrationConnections: {
          list: async () => [
            {
              connectionId: "local",
              key: "discord",
              revision: "r1",
              label: "Project brief",
              enabled: true,
              status: "connected",
              workspaceId: "w",
              config: { runtimeMode: "gateway", defaultChannelId: "123456789012345678" },
            },
            {
              connectionId: "other",
              key: "discord",
              revision: "r1",
              label: "Other project",
              enabled: true,
              status: "connected",
              workspaceId: "other",
              config: { runtimeMode: "gateway", defaultChannelId: "223456789012345678" },
            },
          ],
        },
        permissionProfiles: { listProfiles: async () => [] },
        workspaceHooks: { listByTrigger: async () => [] },
        workspaces: { get: async () => ({ lifecycleStatus: "active", citadelId: "personal" }) },
        citadels: { findRecord: async () => ({ lifecycleStatus: "active" }) },
        cronJobs: { get: async () => undefined },
      },
      config: { assistant: { budgets: { dailyUsdHardCap: 2, sessionTokenHardCap: 20000 } } },
      readFeatureFlags: async () => ({ durableKernelV1Enabled: true, scheduledChatTurnsV1Enabled: true }),
      readSettingsRevision: () => 4,
      cronAutomationService: { createCronJob: create },
    };
  const service = createFollowThroughSetupForGateway(gateway as never),
    scope = { workspaceId: "w", sessionId: "s", actorId: "operator" };
  const first = await service.inspect(scope);
  expect(first.channelDestinations?.map((item) => item.connectionId)).toEqual(["local"]);
  expect(first).toMatchObject({ quietHours: { start: 12, end: 18, timezone: "Asia/Kathmandu" } });
  prefs = { ...prefs, revision: 2, model: "other-model" };
  const modelChanged = await service.inspect(scope);
  expect(modelChanged.sourceHash).not.toBe(first.sourceHash);
  autonomy = { ...autonomy, revision: 2, activeHours: { start: 8, end: 17, tz: "Europe/Berlin" } };
  expect((await service.inspect(scope)).sourceHash).not.toBe(modelChanged.sourceHash);
  expect(create).not.toHaveBeenCalled();
});
