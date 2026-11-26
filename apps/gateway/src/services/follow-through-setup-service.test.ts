import { expect, it, vi } from "vitest";
import { FollowThroughSetupService } from "./follow-through-setup-service.js";
function fixture() {
  const source = {
    workspaceId: "w",
    sessionId: "s",
    citadelId: "personal",
    sessionIncarnationId: "incarnation",
    active: true,
    privateOperator: true,
    configRevision: 4,
    enabled: true,
    profiles: [
      {
        profileId: "safe",
        revision: "profile-revision",
        label: "Safe",
        description: "Reviewed access",
        approvalMode: "approve_risky",
      },
    ],
    eventSources: [{ hookId: "h", label: "Subagent completed" }],
    limits: { scope: "installation", dailyUsdHardCap: 2, sessionTokenHardCap: 20000 },
    blockedReasons: [],
  };
  const jobs = new Map<string, any>(),
    create = vi.fn(async (input: any, creator: any) => {
      const job = { ...input, revision: 1, creatorAuthority: creator };
      jobs.set(job.jobId, job);
      return job;
    });
  const deps = {
    readSource: vi.fn(async () => source),
    getJob: async (id: string) => jobs.get(id),
    createJob: create,
    now: () => new Date("2026-11-19T16:00:00.000Z"),
  };
  return { source, create, deps, service: new FollowThroughSetupService(deps as never) };
}
const scope = { workspaceId: "w", sessionId: "s", actorId: "operator" };
it("pins a reviewed channel brief to the exact configured connection and destination", async () => {
  const f = fixture();
  const destination = {
    connectionId: "discord-1",
    revision: "rev-1",
    channelKey: "discord",
    target: "123456789012345678",
    label: "Project brief",
  };
  Object.assign(f.source, { channelDestinations: [destination] });
  const setup = await f.service.inspect(scope);
  expect(setup.channelDestinations).toEqual([destination]);
  const input = {
    ...scope,
    expectedSetupHash: setup.sourceHash,
    operationId: "brief-operation-12345",
    purpose: "Send a daily brief",
    permissionProfileId: "safe",
    trigger: { kind: "recurring" as const, schedule: "0 9 * * * America/Los_Angeles" },
    delivery: { kind: "channel" as const, connectionId: destination.connectionId },
  };
  await expect(
    f.service.create({ ...input, delivery: { kind: "channel", connectionId: "foreign" } }),
  ).rejects.toThrow();
  const job = await f.service.create(input);
  expect(job.actionConfig?.agentTurn).toMatchObject({
    deliverMode: "always",
    deliveryChannel: {
      connectionId: destination.connectionId,
      connectionRevision: destination.revision,
      channelKey: destination.channelKey,
      target: destination.target,
    },
  });
  destination.target = "987654321098765432";
  await expect(f.service.create(input)).rejects.toThrow(/refresh/i);
  expect(f.create).toHaveBeenCalledTimes(1);
});
it("reviewing setup creates nothing; one exact explicit decision creates an owned recurring job", async () => {
  const f = fixture(),
    setup = await f.service.inspect(scope);
  expect(f.create).not.toHaveBeenCalled();
  const input = {
    ...scope,
    expectedSetupHash: setup.sourceHash,
    operationId: "operation-1234567890",
    purpose: "Check the supplied result and report a change",
    permissionProfileId: "safe",
    trigger: { kind: "recurring" as const, schedule: "30 9 * * * America/Los_Angeles" },
    delivery: { kind: "conversation" as const },
  };
  const first = await f.service.create(input),
    second = await f.service.create(input);
  expect(first.jobId).toBe(second.jobId);
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.create).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "agent_turn",
      schedule: input.trigger.schedule,
      actionConfig: {
        agentTurn: expect.objectContaining({
          sessionId: "s",
          prompt: input.purpose,
          deliverMode: "on_notify",
          createdBy: {
            operatorId: "operator",
            authActorId: "operator",
            depth: 0,
            permissionProfileId: "safe",
            permissionProfileRevision: "profile-revision",
          },
        }),
      },
    }),
    { actorId: "operator", source: "authenticated_operator" },
  );
});
it("stale limits, foreign scope, missing sign-in or an unreviewed profile cannot create work", async () => {
  const f = fixture(),
    setup = await f.service.inspect(scope),
    input = {
      ...scope,
      expectedSetupHash: setup.sourceHash,
      operationId: "operation-1234567890",
      purpose: "Check",
      permissionProfileId: "foreign",
      trigger: { kind: "once" as const, at: "2026-11-20T12:00:00.000Z", timezone: "UTC" },
      delivery: { kind: "conversation" as const },
    };
  await expect(f.service.create(input)).rejects.toThrow();
  input.permissionProfileId = "safe";
  f.source.limits.dailyUsdHardCap = 1;
  await expect(f.service.create(input)).rejects.toThrow();
  await expect(f.service.inspect({ ...scope, workspaceId: "foreign" })).rejects.toThrow();
  await expect(f.service.create({ ...input, actorId: undefined })).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
});
it("records an exact one-shot or verified event binding without enabling other background work", async () => {
  const f = fixture(),
    setup = await f.service.inspect(scope),
    base = {
      ...scope,
      expectedSetupHash: setup.sourceHash,
      purpose: "Check a changed result",
      permissionProfileId: "safe",
      delivery: { kind: "conversation" as const },
    };
  const once = await f.service.create({
    ...base,
    operationId: "one-shot-1234567890",
    trigger: { kind: "once", at: "2026-11-20T12:00:00.000Z", timezone: "Europe/London" },
  });
  expect(once.actionConfig?.agentTurn?.oneShot).toEqual({ at: "2026-11-20T12:00:00.000Z", timezone: "Europe/London" });
  const event = await f.service.create({
    ...base,
    operationId: "event-1234567890123",
    trigger: { kind: "event", hookId: "h", notBefore: "2026-11-19T16:00:00.000Z", timezone: "UTC" },
  });
  expect(event.actionConfig?.agentTurn?.eventWake).toMatchObject({
    sourceSessionId: "s",
    workspaceId: "w",
    hookId: "h",
    eventType: "subagent.end",
  });
  expect(f.deps.readSource).toHaveBeenCalled();
});
it("keeps credential values out of persisted scheduled purposes", async () => {
  const f = fixture(),
    setup = await f.service.inspect(scope);
  await expect(
    f.service.create({
      ...scope,
      expectedSetupHash: setup.sourceHash,
      operationId: "secret-1234567890123",
      purpose: "Check this using Authorization: Bearer synthetic_credential_1234567890",
      permissionProfileId: "safe",
      trigger: { kind: "recurring", schedule: "30 9 * * * UTC" },
      delivery: { kind: "conversation" },
    }),
  ).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
});
it("an event cannot label quiet hours with a different client-selected timezone", async () => {
  const f = fixture();
  Object.assign(f.source, { quietHours: { start: 12, end: 18, timezone: "Asia/Kathmandu" } });
  const setup = await f.service.inspect(scope);
  await expect(
    f.service.create({
      ...scope,
      expectedSetupHash: setup.sourceHash,
      operationId: "wrong-zone-1234567890",
      purpose: "Check a verified completion",
      permissionProfileId: "safe",
      trigger: { kind: "event", hookId: "h", notBefore: "2026-11-19T16:00:00.000Z", timezone: "UTC" },
      delivery: { kind: "conversation" },
    }),
  ).rejects.toThrow(/quiet|timezone|hours/i);
  expect(f.create).not.toHaveBeenCalled();
});
