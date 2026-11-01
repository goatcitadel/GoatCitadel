import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStoreUnavailableError } from "./secret-store-service.js";
import {
  INSPECTION_ID,
  OPERATOR,
  PLUGIN_ID,
  WORKSPACE_ID,
  fullViews,
  pluginInstallHarness,
  type PluginInstallFixture,
} from "./capability-plugin-install.test-support.js";

const harnesses: Array<ReturnType<typeof pluginInstallHarness>> = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function harness(input: PluginInstallFixture = {}) {
  const created = pluginInstallHarness(input);
  harnesses.push(created);
  return created;
}

const SECRET = "whsec-meeting-tools-0123456789";

function installInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    inspectionId: INSPECTION_ID,
    hookSecrets: { "tool-watch": SECRET },
    actorId: OPERATOR.actorId,
    idempotencyKey: "install-key-1",
    ...overrides,
  };
}

describe("CapabilityPluginActionsService.install", () => {
  it("installs from one call when the setting is on, and answers applied with the plan's summary", async () => {
    const h = harness();

    const outcome = await h.actions.install(installInput());

    expect(outcome).toEqual({
      planId: expect.any(String),
      outcome: "applied",
      summary: expect.stringMatching(/^Installed Meeting tools\. /u),
    });
    const plan = await h.plans.get(OPERATOR, outcome.planId);
    expect(plan).toMatchObject({ status: "completed", origin: { surface: "capabilities", workspaceId: WORKSPACE_ID } });
    expect((await h.store.get(PLUGIN_ID))?.state).toBe("installed");
  });

  it("answers waiting with the approval id when the setting is off", async () => {
    const h = harness({ skip: false });

    const outcome = await h.actions.install(installInput());

    expect(outcome).toEqual({
      planId: expect.any(String),
      outcome: "waiting",
      approvalId: "approval-plugin-install",
      summary: expect.stringContaining("Save Issues, switched off"),
    });
  });

  it("stores hook secrets in the key store and never in the plan", async () => {
    const h = harness({ skip: false });

    const outcome = await h.actions.install(installInput());

    const [ref] = [...h.state.keychain.keys()];
    expect(ref).toMatch(/^keychain:goatcitadel:hook:[0-9a-f-]{36}$/u);
    expect(h.state.keychain.get(ref!)).toBe(SECRET);
    const plan = await h.plans.get(OPERATOR, outcome.planId);
    expect(plan.request).toMatchObject({ kind: "plugin_install", hookSecretRefs: { "tool-watch": ref } });
    // The value is in no ledger row, no event and no link: only its reference is.
    expect(h.ledgerText()).not.toContain(SECRET);
    expect(h.ledgerText()).toContain(ref!);

    h.approve();
    await h.plans.reconcileApproval("approval-plugin-install");
    expect(h.state.hooks[0]?.action).toEqual({
      type: "webhook",
      webhook: { url: "https://hooks.example.com/goat", secretRef: ref },
    });
    expect(h.ledgerText()).not.toContain(SECRET);
    expect(JSON.stringify(await h.store.get(PLUGIN_ID))).not.toContain(SECRET);
  });

  it("deletes the stored secrets when the plan is declined", async () => {
    const h = harness({ skip: false });
    const outcome = await h.actions.install(installInput());
    const [ref] = [...h.state.keychain.keys()];

    h.deny();
    await h.plans.reconcileApproval("approval-plugin-install");

    expect((await h.plans.get(OPERATOR, outcome.planId)).status).not.toBe("completed");
    expect(h.state.deletedSecrets).toEqual([ref]);
    expect(h.state.keychain.size).toBe(0);
    expect(h.state.order).toEqual([]);
    expect(await h.store.get(PLUGIN_ID)).toBeUndefined();
  });

  it("deletes the stored secrets when the plan is cancelled or runs out of time", async () => {
    const cancelled = harness({ skip: false });
    const plan = await cancelled.plans.create({
      actor: OPERATOR,
      request: cancelled.pluginRequest({
        "tool-watch": "keychain:goatcitadel:hook:00000000-0000-4000-8000-0000000000aa",
      }),
    });
    await cancelled.plans.cancel(OPERATOR, plan.planId, plan.revision);
    expect(cancelled.state.deletedSecrets).toEqual(["keychain:goatcitadel:hook:00000000-0000-4000-8000-0000000000aa"]);

    // A plan left waiting in the Inbox past its 15 minutes is expired by the control plane's own sweep.
    const expired = harness({ skip: false });
    const waiting = await expired.actions.install(installInput());
    expect(waiting.outcome).toBe("waiting");
    const [stored] = [...expired.state.keychain.keys()];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      const swept = await expired.plans.reconcileActive();
      expect(swept.map((item) => [item.planId, item.status])).toEqual([[waiting.planId, "failed"]]);
    } finally {
      vi.useRealTimers();
    }
    expect((await expired.plans.get(OPERATOR, waiting.planId)).result?.failureCode).toBe("expired");
    expect(expired.state.deletedSecrets).toEqual([stored]);
    expect(expired.state.keychain.size).toBe(0);
    expect(expired.state.order).toEqual([]);
  });

  it("answers a replayed key from the first plan and never stores a new secret", async () => {
    const h = harness({ skip: false });
    const first = await h.actions.install(installInput());
    expect(h.state.keychain.size).toBe(1);

    const again = await h.actions.install(installInput({ hookSecrets: { "tool-watch": "another-secret-value" } }));
    const replayed = await h.actions.install(installInput({ replayOnly: true }));

    expect(again).toEqual(first);
    expect(replayed).toEqual(first);
    expect(h.state.keychain.size).toBe(1);
    expect(h.state.deletedSecrets).toEqual([]);
    expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toHaveLength(1);
  });

  it("refuses a replay whose first answer is gone", async () => {
    const h = harness();
    await expect(h.actions.install(installInput({ replayOnly: true }))).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.state.keychain.size).toBe(0);
  });

  // One migrated database per case (F20): four in one test came close to the 15 s timeout on a loaded machine.
  it.each([
    [
      "an expired inspection",
      (h: ReturnType<typeof harness>) => {
        h.state.inspection = { ...h.state.inspection, expiresAt: new Date(Date.now() - 1).toISOString() };
      },
      { httpStatus: 404, message: "That plugin check wasn't found, or it ran out of time. Check the plugin again." },
    ],
    [
      "files changed on disk",
      (h: ReturnType<typeof harness>) => {
        h.state.tampered = true;
      },
      {
        httpStatus: 409,
        message: "This plugin's files changed on this computer since it was checked. Check it again.",
      },
    ],
    [
      "an edited manifest",
      (h: ReturnType<typeof harness>) => {
        h.state.manifestText = h.state.manifestText.replace("Meeting tools", "Meeting tools 2");
      },
      { httpStatus: 409, message: "This plugin changed since it was checked. Check it again." },
    ],
    [
      "an inspection that isn't installable",
      (h: ReturnType<typeof harness>) => {
        h.state.inspection = { ...h.state.inspection, installable: false };
      },
      { httpStatus: 409 },
    ],
  ])("refuses %s, storing no secret and making no plan", async (_case, change, refusal) => {
    const h = harness();
    change(h);

    await expect(h.actions.install(installInput())).rejects.toMatchObject(refusal);
    expect(h.state.keychain.size).toBe(0);
    expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toEqual([]);
  });

  it("refuses a plugin that is already installed, or another workspace's check", async () => {
    const installed = harness();
    await installed.actions.install(installInput());
    await expect(installed.actions.install(installInput({ idempotencyKey: "install-key-2" }))).rejects.toMatchObject({
      httpStatus: 409,
      message: "Meeting tools is already installed.",
    });

    const elsewhere = harness();
    await expect(elsewhere.actions.install(installInput({ workspaceId: "lab" }))).rejects.toMatchObject({
      httpStatus: 404,
    });
    elsewhere.state.inspection = { ...elsewhere.state.inspection, workspaceId: "lab" };
    await expect(elsewhere.actions.install(installInput())).rejects.toMatchObject({
      httpStatus: 409,
      message: "This plugin was checked for another workspace. Check it again here.",
    });
    expect(elsewhere.state.keychain.size).toBe(0);
  });

  it("refuses an unverified plugin that takes the id of one that ships with GoatCitadel", async () => {
    const h = harness({ trust: "unverified", builtInIds: ["other-plugin", PLUGIN_ID] });

    await expect(h.actions.install(installInput())).rejects.toMatchObject({
      httpStatus: 409,
      code: "PLUGIN_ID_RESERVED",
      message: "A plugin that ships with GoatCitadel already uses this id.",
    });
    expect(h.state.keychain.size).toBe(0);

    // The built-in plugin itself installs.
    const builtIn = harness({ trust: "built_in", builtInIds: [PLUGIN_ID] });
    expect((await builtIn.actions.install(installInput())).outcome).toBe("applied");
  });

  it.each([
    ["no secret for a hook", {}, "Every hook needs its own signing secret."],
    [
      "a secret for a piece that isn't a hook",
      { "tool-watch": SECRET, issues: SECRET },
      "Only a hook takes a signing secret.",
    ],
    ["an empty secret", { "tool-watch": "" }, "A signing secret is 1 to 512 characters, with no space at either end."],
    [
      "a secret with a space at an end",
      { "tool-watch": ` ${SECRET}` },
      "A signing secret is 1 to 512 characters, with no space at either end.",
    ],
    [
      "a secret over 512 characters",
      { "tool-watch": "x".repeat(513) },
      "A signing secret is 1 to 512 characters, with no space at either end.",
    ],
  ])("refuses %s with a 400, before any secret or plan", async (_label, hookSecrets, message) => {
    const h = harness();

    await expect(h.actions.install(installInput({ hookSecrets }))).rejects.toMatchObject({ httpStatus: 400, message });
    expect(h.state.keychain.size).toBe(0);
    expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toEqual([]);
  });

  it("takes a 512-character secret, and none at all for a plugin without hooks", async () => {
    const h = harness();
    expect((await h.actions.install(installInput({ hookSecrets: { "tool-watch": "x".repeat(512) } }))).outcome).toBe(
      "applied",
    );

    const noHooks = harness({
      manifest: {
        schemaVersion: 1,
        pluginId: PLUGIN_ID,
        name: "Meeting tools",
        description: "Notes and checks for meetings.",
        version: "1.0.0",
        pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }],
      },
      views: fullViews().filter((view) => view.pieceId === "no-browser"),
    });
    const outcome = await noHooks.actions.install(installInput({ hookSecrets: undefined }));
    expect(outcome.outcome).toBe("applied");
    expect((await noHooks.plans.get(OPERATOR, outcome.planId)).request).not.toHaveProperty("hookSecretRefs");
  });

  it("deletes the stored secrets when the plan can't be made", async () => {
    const h = harness();
    // The check is dropped after the install read it and before the plan reads it again: the plan is refused.
    const read = h.sources.readInspection.getMockImplementation()!;
    h.sources.readInspection.mockImplementationOnce(read).mockImplementationOnce(async () => undefined);

    await expect(h.actions.install(installInput())).rejects.toMatchObject({ httpStatus: 404 });
    expect(h.state.deletedSecrets).toHaveLength(1);
    expect(h.state.keychain.size).toBe(0);
    expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toEqual([]);
  });

  it("says plainly when the key store can't keep a hook's secret, and makes no plan", async () => {
    const h = harness();
    h.storeHookSecret.mockImplementationOnce(() => {
      throw new SecretStoreUnavailableError("OS keychain backend is unavailable on this host");
    });

    await expect(h.actions.install(installInput())).rejects.toMatchObject({
      httpStatus: 503,
      message:
        "This computer's key store can't be used right now, so a hook's signing secret can't be kept. Nothing was installed.",
      details: { reason: "key_store_unavailable" },
    });
    expect(h.state.keychain.size).toBe(0);
    expect(await h.sync.list({ workspaceId: WORKSPACE_ID })).toEqual([]);
  });
});
