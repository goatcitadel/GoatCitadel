import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import type { ErrandOverlayEvent, ErrandTargetInfo } from "@goatcitadel/policy-engine";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  createApproval,
  expirePendingApprovals,
  resolveApproval,
  withdrawApproval,
  type ApprovalLifecycleHost,
} from "../approval-lifecycle-service.js";
import { ApprovalRuntimeService } from "../approval-runtime-service.js";
import { assertChatTurnToolUseOpen } from "../chat-turn-control.js";
import { ERRAND_APPROVAL_TTL_MS } from "./errand-constants.js";
import type { ErrandApprovalInput } from "./errand-loop.js";
import {
  createErrandApprovalGate,
  errandLoopApprovalHooks,
  ERRAND_APPROVAL_IN_FLIGHT_MESSAGE,
  ERRAND_MAX_PAGE_CHANGED_REASKS,
  ERRAND_PAGE_CHANGED_TITLE,
  ERRAND_PAGE_KEPT_CHANGING_REASON,
  type ErrandApprovalGateDeps,
} from "./errand-approval-gate.js";

const BEFORE_PNG = Buffer.from("before-png");
const AFTER_PNG = Buffer.from("after-png");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// One migrated database for the file (migrations are slow); every test seeds its own Chat turn.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-errand-gate-"));
let shared: Storage | undefined;
afterAll(() => {
  shared?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
let turnCounter = 0;

function target(partial: Partial<ErrandTargetInfo> = {}): ErrandTargetInfo {
  return {
    x: 100,
    y: 200,
    tagName: "BUTTON",
    role: "button",
    text: "Place order",
    isPasswordLike: false,
    isOneTimeCode: false,
    isOpaque: false,
    rect: { x: 80, y: 190, width: 40, height: 20 },
    ...partial,
  };
}

function approvalInput(partial: Partial<ErrandApprovalInput> = {}): ErrandApprovalInput {
  return {
    category: "purchase",
    title: 'Click "Place order"',
    body: "Buy the cart on shop.example",
    target: target(),
    pageUrl: "https://shop.example/checkout",
    peopleScreenshotPng: BEFORE_PNG,
    ...partial,
  } as ErrandApprovalInput;
}

function openStorage() {
  shared ??= new Storage({
    dbPath: path.join(root, "test.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const db = shared;
  turnCounter += 1;
  const SESSION_ID = `session-errand-${turnCounter}`;
  const TURN_ID = `turn-errand-${turnCounter}`;
  const now = new Date().toISOString();
  db.chatMessages.upsert({
    messageId: `user-${TURN_ID}`,
    sessionId: SESSION_ID,
    role: "user",
    actorType: "user",
    actorId: "operator",
    sourceAuthority: "operator",
    content: "buy it",
    timestamp: now,
  });
  const run = db.durableRuns.createRun({
    workflowKey: "chat.turn.execute",
    status: "waiting",
    payload: { sessionId: SESSION_ID, turnId: TURN_ID },
  });
  db.chatTurnTraces.create({
    turnId: TURN_ID,
    sessionId: SESSION_ID,
    userMessageId: `user-${TURN_ID}`,
    status: "waiting_for_tool",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
    durable: { runId: run.runId, status: "waiting" },
  });
  return { db, SESSION_ID, TURN_ID };
}

function createHost(db: Storage) {
  const storage = createSqliteAsyncStorage(db);
  const host = {
    storage,
    policyEngine: {
      listGrants: vi.fn(() => []),
      listActiveGrants: vi.fn(() => []),
      describeOutsideRootWriteApproval: vi.fn(async () => undefined),
      mintOutsideRootWriteGrant: vi.fn(),
      createGrant: vi.fn(),
      revokeGrant: vi.fn(),
      executeApprovedAction: vi.fn(),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ blockedBy: undefined, patch: undefined })),
      enqueueAfterHooks: vi.fn(),
    },
    approvalWaitRunService: {
      buildApprovalLinkage: vi.fn((linkage?: Record<string, unknown>) => linkage),
      reserveApprovalWaitRun: vi.fn((approval: unknown) => approval),
      primeApprovalLifecycle: vi.fn((approvalId: string) => storage.approvals.get(approvalId)),
    },
    shellExplainerPolicy: { enabled: false, elevateOnDanger: "danger" as const, autoRejectOnDanger: false },
    publishRealtime: vi.fn(async () => undefined),
    resolveApproval: vi.fn(),
    resolveDeviceAccessApproval: vi.fn(),
    executeCodeModePendingApproval: vi.fn(),
    resolveApprovalHookWorkspaceId: vi.fn(async () => "workspace-1"),
    scheduleApprovalExplanation: vi.fn(),
    findProactiveDurableRunIdsForApproval: vi.fn(async () => []),
    wakeDurableRun: vi.fn(),
    enqueueApprovalObservabilityEffects: vi.fn(async () => []),
    enqueueApprovalWaitMaterialization: vi.fn(async () => undefined),
    enqueueApprovalResolutionEffects: vi.fn(async () => []),
    requestApprovalEffectProcessing: vi.fn(),
    awaitApprovalResolutionEffects: vi.fn(async () => []),
  };
  return host as unknown as ApprovalLifecycleHost;
}

function createFakeBrowser(url = "https://shop.example/checkout") {
  const listeners = new Set<(event: ErrandOverlayEvent) => void>();
  const state = { url, target: target() as ErrandTargetInfo | null };
  const browser = {
    currentUrl: vi.fn(() => state.url),
    describeTargetBeneathOverlay: vi.fn(async () => state.target),
    captureForPeople: vi.fn(async () => BEFORE_PNG),
    overlay: {
      render: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({
        connected: true,
        displayed: true,
        mode: "driving" as const,
        bannerText: "GoatCitadel is working",
        notice: null,
        cursor: null,
        controls: {},
      })),
      onEvent: vi.fn((listener: (event: ErrandOverlayEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      withAutomationInput: vi.fn(async <T>(dispatch: () => Promise<T>) => dispatch()),
    },
  };
  const emit = (event: ErrandOverlayEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { browser, state, emit };
}

function setup(options: { now?: () => number; failSupersededAppend?: boolean } = {}) {
  const { db, SESSION_ID, TURN_ID } = openStorage();
  const host = createHost(db);
  const runtime = new ApprovalRuntimeService(host as never);
  const fake = createFakeBrowser();
  const realtimeListeners = new Set<(event: RealtimeEvent) => void>();
  let uploads = 0;
  const attachments = {
    upload: vi.fn(async (input: { bytes: Buffer }) => {
      uploads += 1;
      return {
        attachmentId: `attachment-${uploads}`,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      };
    }),
  };
  const controller = new AbortController();
  const nowMs = Date.now();
  const deps: ErrandApprovalGateDeps = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    toolRunId: "tool-run-1",
    browser: fake.browser as unknown as ErrandApprovalGateDeps["browser"],
    approvals: runtime,
    storage: options.failSupersededAppend
      ? ({
          approvals: host.storage.approvals,
          chatInlineApprovals: host.storage.chatInlineApprovals,
          approvalEvents: {
            append: async (event: Parameters<typeof host.storage.approvalEvents.append>[0]) => {
              if (event.eventType === "superseded") throw new Error("disk full");
              return host.storage.approvalEvents.append(event);
            },
            listByApprovalId: (approvalId: string) => host.storage.approvalEvents.listByApprovalId(approvalId),
          },
        } as unknown as ErrandApprovalGateDeps["storage"])
      : host.storage,
    attachments,
    realtime: {
      subscribeRealtime: (listener) => {
        realtimeListeners.add(listener);
        return () => realtimeListeners.delete(listener);
      },
    },
    signal: controller.signal,
    now: options.now ?? (() => nowMs),
  };
  const gate = createErrandApprovalGate(deps);
  cleanups.push(() => controller.abort());
  const pendingIds = async (): Promise<string[]> =>
    (await host.storage.approvals.listPendingBySession(SESSION_ID, undefined, 200, { includeExpired: true })).map(
      (approval) => approval.approvalId,
    );
  const waitForPending = async (count = 1): Promise<string> => {
    await vi.waitFor(
      async () => {
        expect((await pendingIds()).length).toBeGreaterThanOrEqual(count);
      },
      { timeout: 5_000, interval: 20 },
    );
    const ids = await pendingIds();
    return ids[ids.length - 1]!;
  };
  return {
    db,
    host,
    runtime,
    fake,
    attachments,
    controller,
    deps,
    gate,
    nowMs,
    waitForPending,
    realtimeListeners,
    SESSION_ID,
    TURN_ID,
  };
}

describe("errand approval gate", () => {
  it("creates a caution approval with the screenshot attachment", async () => {
    const { db, gate, nowMs, waitForPending, attachments, controller, SESSION_ID, TURN_ID } = setup();
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    const approval = db.approvals.get(approvalId);
    expect(approval.kind).toBe("browser.errand.action");
    expect(approval.riskLevel).toBe("caution");
    expect(approval.preview.screenshotAttachmentId).toBe("attachment-1");
    expect(approval.preview.screenshotSha256).toBe(createHash("sha256").update(BEFORE_PNG).digest("hex"));
    expect(approval.preview.summary).toBe('Click "Place order" — Buy the cart on shop.example');
    expect(approval.payload).toMatchObject({
      category: "purchase",
      targetText: "Place order",
      pageOrigin: "https://shop.example",
    });
    expect(approval.linkage).toMatchObject({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      toolName: "browser.errand",
      actionType: "purchase",
      originSurface: "chat",
    });
    expect(Date.parse(approval.expiresAt!)).toBe(nowMs + ERRAND_APPROVAL_TTL_MS);
    expect(attachments.upload).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, mimeType: "image/png", bytes: BEFORE_PNG, analysis: "skip" }),
    );
    const inline = db.chatInlineApprovals.listByTurn(TURN_ID);
    expect(inline).toHaveLength(1);
    expect(inline[0]).toMatchObject({ approvalId, sessionId: SESSION_ID, status: "pending", riskLevel: "caution" });
    controller.abort();
    await expect(answer).resolves.toBe("stopped");
  });

  it("resolves approved when approved through the generic resolve", async () => {
    const { host, gate, waitForPending } = setup();
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    await resolveApproval(host, approvalId, { decision: "approve", resolvedBy: "operator" });
    await expect(answer).resolves.toBe("approved");
  });

  it("wakes on the realtime hint before the poll", async () => {
    const { host, gate, waitForPending, realtimeListeners } = setup();
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    await resolveApproval(host, approvalId, { decision: "reject", resolvedBy: "operator" });
    for (const listener of realtimeListeners) {
      listener({
        eventId: "event-1",
        sequence: 1,
        eventType: "approval_resolved",
        source: "approvals",
        timestamp: new Date().toISOString(),
        payload: { approvalId },
      });
    }
    await expect(answer).resolves.toBe("denied");
  });

  it("window approve resolves the same record", async () => {
    const { db, fake, gate, waitForPending } = setup();
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    await vi.waitFor(() =>
      expect(fake.browser.overlay.render).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "approval", requestId: approvalId, title: 'Click "Place order"' }),
      ),
    );
    fake.emit({ type: "approve", requestId: "some-other-request" });
    fake.emit({ type: "approve", requestId: approvalId });
    await expect(answer).resolves.toBe("approved");
    expect(db.approvals.get(approvalId).resolvedBy).toBe("operator:errand-window");
    // Restored before `request` returned, so the loop acts under the driving banner.
    expect(fake.browser.overlay.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "driving", bannerText: "GoatCitadel is working" }),
    );
  });

  it("still works in Chat when the window card cannot be drawn", async () => {
    const { host, fake, gate, waitForPending } = setup();
    fake.browser.overlay.render.mockRejectedValue(new Error("overlay timed out"));
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    await resolveApproval(host, approvalId, { decision: "approve", resolvedBy: "operator" });
    await expect(answer).resolves.toBe("approved");
  });

  it("asks again when the page origin changed after approval", async () => {
    const { db, host, fake, gate, waitForPending, SESSION_ID } = setup();
    const answer = gate.request(approvalInput());
    const first = await waitForPending();
    fake.state.url = "https://evil.example/checkout";
    await resolveApproval(host, first, { decision: "approve", resolvedBy: "operator" });
    await vi.waitFor(
      async () => {
        const pending = await host.storage.approvals.listPendingBySession(SESSION_ID);
        expect(pending.map((item) => item.approvalId)).not.toContain(first);
        expect(pending).toHaveLength(1);
      },
      { timeout: 5_000, interval: 20 },
    );
    const second = (await host.storage.approvals.listPendingBySession(SESSION_ID))[0]!;
    expect(second.preview.title).toBe(ERRAND_PAGE_CHANGED_TITLE);
    expect(second.payload.pageOrigin).toBe("https://evil.example");
    await resolveApproval(host, second.approvalId, { decision: "approve", resolvedBy: "operator" });
    await expect(answer).resolves.toBe("approved");
    expect(db.approvals.get(first).status).toBe("approved");
    const superseded = db.approvalEvents.listByApprovalId(first).filter((event) => event.eventType === "superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.payload).toMatchObject({
      reason: "page_changed",
      actedOn: false,
      originChanged: true,
      approvedOrigin: "https://shop.example",
      reasked: true,
    });
    expect(
      db.approvalEvents.listByApprovalId(second.approvalId).some((event) => event.eventType === "superseded"),
    ).toBe(false);
    expect(gate.lastReason).toBeUndefined();
  });

  it("still re-asks when the superseded evidence cannot be recorded", async () => {
    const { db, host, fake, gate, waitForPending, SESSION_ID } = setup({ failSupersededAppend: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = gate.request(approvalInput());
      const first = await waitForPending();
      fake.state.url = "https://other.example/checkout";
      await resolveApproval(host, first, { decision: "approve", resolvedBy: "operator" });
      let second = "";
      await vi.waitFor(
        async () => {
          const pending = await host.storage.approvals.listPendingBySession(SESSION_ID);
          expect(pending).toHaveLength(1);
          second = pending[0]!.approvalId;
          expect(second).not.toBe(first);
        },
        { timeout: 5_000, interval: 20 },
      );
      await resolveApproval(host, second, { decision: "approve", resolvedBy: "operator" });
      await expect(answer).resolves.toBe("approved");
      expect(db.approvals.get(first).status).toBe("approved");
      expect(warn).toHaveBeenCalledWith(
        "[goatcitadel] errand superseded evidence could not be recorded",
        expect.objectContaining({ approvalId: first, error: "disk full" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("is single-flight: a concurrent second request fails fast", async () => {
    const { gate, controller, waitForPending } = setup();
    const first = gate.request(approvalInput());
    await expect(gate.request(approvalInput())).rejects.toThrow(ERRAND_APPROVAL_IN_FLIGHT_MESSAGE);
    await waitForPending();
    controller.abort();
    await expect(first).resolves.toBe("stopped");
  });

  it("gives up after the page keeps changing through every re-ask", async () => {
    const { db, host, fake, gate, SESSION_ID } = setup();
    const answer = gate.request(approvalInput());
    const decided = new Set<string>();
    for (let round = 0; round <= ERRAND_MAX_PAGE_CHANGED_REASKS; round += 1) {
      let approvalId = "";
      await vi.waitFor(
        async () => {
          const pending = (await host.storage.approvals.listPendingBySession(SESSION_ID)).filter(
            (item) => !decided.has(item.approvalId),
          );
          expect(pending).toHaveLength(1);
          approvalId = pending[0]!.approvalId;
        },
        { timeout: 5_000, interval: 20 },
      );
      decided.add(approvalId);
      fake.state.url = `https://shop-${round}.example/checkout`;
      await resolveApproval(host, approvalId, { decision: "approve", resolvedBy: "operator" });
    }
    await expect(answer).resolves.toBe("denied");
    expect(gate.lastReason).toBe(ERRAND_PAGE_KEPT_CHANGING_REASON);
    expect(errandLoopApprovalHooks(gate).lastDenialReason()).toBe(ERRAND_PAGE_KEPT_CHANGING_REASON);
    expect(decided.size).toBe(ERRAND_MAX_PAGE_CHANGED_REASKS + 1);
    const reasked = [...decided].map(
      (id) => db.approvalEvents.listByApprovalId(id).find((event) => event.eventType === "superseded")?.payload.reasked,
    );
    expect(reasked).toEqual([true, true, true, false]);
    expect(db.approvals.listPendingBySession(SESSION_ID)).toHaveLength(0);
    // The next request starts with no stale reason.
    const next = gate.request(approvalInput({ pageUrl: fake.state.url }));
    await vi.waitFor(async () => expect(await host.storage.approvals.listPendingBySession(SESSION_ID)).toHaveLength(1));
    expect(gate.lastReason).toBeUndefined();
    const nextId = (await host.storage.approvals.listPendingBySession(SESSION_ID))[0]!.approvalId;
    await resolveApproval(host, nextId, { decision: "approve", resolvedBy: "operator" });
    await expect(next).resolves.toBe("approved");
  });

  for (const ending of ["denied", "stopped"] as const) {
    it(`does not put the driving banner back after a ${ending} answer`, async () => {
      const { host, fake, gate, controller, waitForPending } = setup();
      const answer = gate.request(approvalInput());
      const approvalId = await waitForPending();
      await vi.waitFor(() =>
        expect(fake.browser.overlay.render).toHaveBeenCalledWith(expect.objectContaining({ mode: "approval" })),
      );
      if (ending === "denied") {
        await resolveApproval(host, approvalId, { decision: "reject", resolvedBy: "operator" });
      } else {
        controller.abort();
      }
      await expect(answer).resolves.toBe(ending);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fake.browser.overlay.render).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "driving" }));
    });
  }

  it("never draws a card that was still waiting when the errand stopped", async () => {
    const { fake, gate, controller, waitForPending } = setup();
    let releaseSnapshot!: () => void;
    fake.browser.overlay.snapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSnapshot = () =>
            resolve({
              connected: true,
              displayed: true,
              mode: "driving",
              bannerText: "GoatCitadel is working",
              notice: null,
              cursor: null,
              controls: {},
            });
        }),
    );
    const answer = gate.request(approvalInput());
    await waitForPending();
    controller.abort();
    await expect(answer).resolves.toBe("stopped");
    releaseSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.browser.overlay.render).not.toHaveBeenCalled();
  });

  it("asks again when the target moved or changed after approval", async () => {
    const { host, fake, gate, waitForPending, SESSION_ID } = setup();
    const answer = gate.request(approvalInput());
    const first = await waitForPending();
    fake.state.target = target({ text: "Subscribe and pay" });
    await resolveApproval(host, first, { decision: "approve", resolvedBy: "operator" });
    await vi.waitFor(
      async () => {
        const pending = await host.storage.approvals.listPendingBySession(SESSION_ID);
        expect(pending).toHaveLength(1);
        expect(pending[0]!.approvalId).not.toBe(first);
      },
      { timeout: 5_000, interval: 20 },
    );
    const second = (await host.storage.approvals.listPendingBySession(SESSION_ID))[0]!;
    expect(second.payload.targetText).toBe("Subscribe and pay");
    await resolveApproval(host, second.approvalId, { decision: "reject", resolvedBy: "operator" });
    await expect(answer).resolves.toBe("denied");
  });

  it("treats the same origin as enough for a target it could not read", async () => {
    const { host, fake, gate, waitForPending } = setup();
    const unknown = target({ role: "", text: "", tagName: "", rect: { x: 0, y: 0, width: 0, height: 0 } });
    const answer = gate.request(approvalInput({ target: unknown }));
    const approvalId = await waitForPending();
    fake.state.target = null;
    await resolveApproval(host, approvalId, { decision: "approve", resolvedBy: "operator" });
    await expect(answer).resolves.toBe("approved");
  });

  it("expired approvals return expired", async () => {
    const past = Date.now() - ERRAND_APPROVAL_TTL_MS - 60_000;
    const { host, gate, waitForPending } = setup({ now: () => past });
    const answer = gate.request(approvalInput());
    await waitForPending();
    await expect(expirePendingApprovals(host)).resolves.toBe(1);
    await expect(answer).resolves.toBe("expired");
  });

  it("abort withdraws the pending approval and a late approve does nothing", async () => {
    const { db, host, gate, controller, waitForPending } = setup();
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    const startedAt = Date.now();
    controller.abort();
    await expect(answer).resolves.toBe("stopped");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(db.approvals.get(approvalId).status).toBe("rejected");
    const resolved = db.approvalEvents.listByApprovalId(approvalId).find((event) => event.eventType === "resolved");
    expect(resolved?.payload.outcome).toBe("withdrawn");
    expect(resolved?.actorId).toBe("system:errand-stopped");
    await expect(resolveApproval(host, approvalId, { decision: "approve", resolvedBy: "operator" })).rejects.toThrow(
      "already resolved",
    );
    expect(db.approvals.get(approvalId).status).toBe("rejected");
  });

  it("returns stopped without asking when already aborted", async () => {
    const { db, gate, controller, SESSION_ID } = setup();
    controller.abort();
    await expect(gate.request(approvalInput())).resolves.toBe("stopped");
    expect(db.approvals.listPendingBySession(SESSION_ID)).toHaveLength(0);
  });

  it("withdrawPending withdraws the waiting approval", async () => {
    const { db, gate, waitForPending } = setup();
    const answer = gate.request(approvalInput());
    const approvalId = await waitForPending();
    await gate.withdrawPending("system:errand-window-closed");
    await expect(answer).resolves.toBe("stopped");
    expect(db.approvals.get(approvalId).resolvedBy).toBe("system:errand-window-closed");
  });

  it("withdrawApproval leaves other pending approvals of the turn alone", async () => {
    const { db, SESSION_ID, TURN_ID } = openStorage();
    const host = createHost(db);
    const linkage = { sessionId: SESSION_ID, turnId: TURN_ID };
    const create = () =>
      createApproval(host, { kind: "browser.errand.action", riskLevel: "caution", payload: {}, preview: {}, linkage });
    const first = await create();
    const second = await create();
    await withdrawApproval(host, first.approvalId, "system:errand-stopped");
    expect(db.approvals.get(first.approvalId).status).toBe("rejected");
    expect(db.approvals.get(second.approvalId).status).toBe("pending");
    expect(
      db.approvalEvents.listByApprovalId(first.approvalId).find((event) => event.eventType === "resolved")?.payload
        .outcome,
    ).toBe("withdrawn");
    await expect(assertChatTurnToolUseOpen(host.storage, SESSION_ID, TURN_ID)).resolves.toBeUndefined();
    await expect(withdrawApproval(host, first.approvalId, "system:errand-stopped")).rejects.toThrow("already resolved");
  });

  it("records the after screenshot against the approved request", async () => {
    const { db, host, gate, attachments, waitForPending } = setup();
    const hooks = errandLoopApprovalHooks(gate);
    const answer = hooks.requestApproval(approvalInput());
    const approvalId = await waitForPending();
    await resolveApproval(host, approvalId, { decision: "approve", resolvedBy: "operator" });
    await expect(answer).resolves.toBe("approved");
    await hooks.afterApprovedAction(AFTER_PNG);
    expect(attachments.upload).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileName: "errand-after.png", bytes: AFTER_PNG, mimeType: "image/png" }),
    );
    const after = db.approvalEvents
      .listByApprovalId(approvalId)
      .find((event) => event.eventType === "errand_after_screenshot");
    expect(after?.payload).toMatchObject({
      screenshotAttachmentId: "attachment-2",
      screenshotSha256: createHash("sha256").update(AFTER_PNG).digest("hex"),
    });
    // Only once per approval.
    await hooks.afterApprovedAction(AFTER_PNG);
    expect(attachments.upload).toHaveBeenCalledTimes(2);
  });
});
