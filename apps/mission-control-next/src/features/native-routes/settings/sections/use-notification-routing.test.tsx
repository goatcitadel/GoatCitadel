import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IntegrationConnection,
  NotificationDeliveryRecord,
  NotificationRule,
  NotificationTarget,
} from "@goatcitadel/contracts";
import { useNotificationRouting } from "./use-notification-routing";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetIntegrationConnectionMutationsForTests } from "../integration-connection-mutation";
import { __resetNotificationTestEvidenceForTests } from "./notification-test-evidence";

const api = vi.hoisted(() => ({
  createNotificationTarget: vi.fn(),
  createNotificationRule: vi.fn(),
  updateNotificationTarget: vi.fn(),
  updateNotificationRule: vi.fn(),
  fetchNotificationTargets: vi.fn(),
  fetchNotificationRules: vi.fn(),
  fetchNotificationDeliveries: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  sendTestNotification: vi.fn(),
  isApiRequestError: vi.fn(() => false),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://notification-fixture",
  // Owner writes are attempt-tracked; these tests do not identify attempts, so dispatch passes straight through.
  captureMutationAttempt: (dispatch: () => Promise<unknown>) => dispatch(),
}));
const stamp = "2026-09-30T12:00:00.000Z";
const channel: IntegrationConnection = {
  connectionId: "channel",
  catalogId: "channel-fixture",
  kind: "channel",
  key: "fixture",
  label: "Local fixture",
  enabled: true,
  status: "connected",
  config: {},
  revision: "a".repeat(64),
  createdAt: stamp,
  updatedAt: stamp,
  workspaceId: "one",
};
const target: NotificationTarget = {
  targetId: "target",
  workspaceId: "one",
  revision: 1,
  label: "Alerts",
  kind: "channel_connection",
  channelConnectionId: "channel",
  lifecycleState: "active",
  createdAt: stamp,
  updatedAt: stamp,
};
const rule: NotificationRule = {
  ruleId: "rule",
  workspaceId: "one",
  revision: 1,
  label: "Failures",
  eventTypes: ["turn.failed"],
  targetIds: ["target"],
  deliveryPolicy: "when_away",
  lifecycleState: "active",
  createdAt: stamp,
  updatedAt: stamp,
};
let ownerTargets: NotificationTarget[],
  ownerRules: NotificationRule[],
  ownerDeliveries: NotificationDeliveryRecord[],
  root: ReactTestRenderer,
  s: ReturnType<typeof useNotificationRouting>;
function Harness({ workspace = "one" }: { workspace?: string }) {
  s = useNotificationRouting(workspace, [channel]);
  return null;
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function mount(workspace = "one") {
  await act(async () => {
    root = create(<Harness workspace={workspace} />);
  });
}
async function change(workspace: string) {
  await act(async () => root.update(<Harness workspace={workspace} />));
}
async function draft() {
  await act(async () => {
    s.setEditor("target");
    s.setTargetForm({
      label: "New destination",
      kind: "channel_connection",
      channelConnectionId: channel.connectionId,
      webhookUrlSecretRef: "",
      credentialSecretRef: "",
    });
  });
  await act(async () => {
    await s.handleCreateTarget();
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetIntegrationConnectionMutationsForTests();
  __resetNotificationTestEvidenceForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected live fetch in notification test");
    }),
  );
  ownerTargets = [structuredClone(target)];
  ownerRules = [structuredClone(rule)];
  ownerDeliveries = [];
  api.fetchNotificationTargets.mockImplementation(async (scope: string) => ({
    items: structuredClone(ownerTargets.filter((item) => item.workspaceId === scope)),
  }));
  api.fetchNotificationRules.mockImplementation(async (scope: string) => ({
    items: structuredClone(ownerRules.filter((item) => item.workspaceId === scope)),
  }));
  api.fetchNotificationDeliveries.mockImplementation(async () => ({ items: structuredClone(ownerDeliveries) }));
  api.fetchIntegrationConnection.mockResolvedValue(channel);
  api.createNotificationTarget.mockImplementation(async (scope: string, input: object) => {
    const saved = { ...target, ...input, targetId: "new", workspaceId: scope };
    ownerTargets.push(saved);
    return structuredClone(saved);
  });
  api.updateNotificationTarget.mockImplementation(
    async (_scope: string, id: string, revision: number, input: object) => {
      const saved = { ...target, ...input, targetId: id, revision: revision + 1 };
      ownerTargets = ownerTargets.map((item) => (item.targetId === id ? saved : item));
      return structuredClone(saved);
    },
  );
  api.updateNotificationRule.mockImplementation(async (_scope: string, id: string, revision: number, input: object) => {
    const saved = { ...rule, ...input, ruleId: id, revision: revision + 1 };
    ownerRules = [saved];
    return structuredClone(saved);
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
describe("shared notification routing owner", () => {
  it("withholds a second pre-reviewed test in another mounted owner after the first is queued", async () => {
    let first!: ReturnType<typeof useNotificationRouting>, second!: ReturnType<typeof useNotificationRouting>;
    function BothOwners() {
      first = useNotificationRouting("one", [channel]);
      second = useNotificationRouting("one", [channel]);
      return null;
    }
    const delivery: NotificationDeliveryRecord = {
      deliveryId: "queued",
      eventId: "event",
      ruleId: "operator_test",
      targetId: "target",
      workspaceId: "one",
      idempotencyKey: "notification:event:operator_test:target",
      status: "pending",
      attemptCount: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    api.sendTestNotification.mockImplementation(async () => {
      ownerDeliveries = [delivery];
      return {
        event: { eventId: "event", workspaceId: "one", source: "operator_test" },
        deliveries: [delivery],
        status: "pending",
      };
    });
    await act(async () => {
      root = create(<BothOwners />);
    });
    await act(async () => {
      first.handleTest(target);
      second.handleTest(target);
    });
    expect(first.review?.kind).toBe("test");
    expect(second.review?.kind).toBe("test");
    const oldConfirmation = second.confirmReview;
    await act(async () => {
      await first.confirmReview();
    });
    await act(async () => {
      await oldConfirmation();
      await second.confirmReview();
    });
    expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
    expect(second.testPending("target")).toBe(true);
  });
  it("retains a queued test across shells and advances only from a fresh bound delivery read without resending", async () => {
    const delivery: NotificationDeliveryRecord = {
      deliveryId: "queued",
      eventId: "queued-event",
      ruleId: "operator_test",
      targetId: target.targetId,
      workspaceId: "one",
      idempotencyKey: "notification:queued-event:operator_test:target",
      status: "pending",
      attemptCount: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    api.sendTestNotification.mockImplementation(async () => {
      ownerDeliveries = [structuredClone(delivery)];
      return {
        event: { eventId: delivery.eventId, workspaceId: "one", source: "operator_test" },
        deliveries: [delivery],
        status: "pending",
      };
    });
    await mount();
    await act(async () => s.handleTest(target));
    await act(async () => {
      await s.confirmReview();
    });
    expect(s.notice?.message).toContain("Test delivery: pending");
    expect(s.attempt.locked).toBe(false);
    expect(s.testPending(target.targetId)).toBe(true);
    await act(async () => root.unmount());
    await mount();
    await act(async () => s.handleTest(target));
    expect(s.review).toBeNull();
    expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
    ownerDeliveries = [{ ...delivery, status: "delivered", updatedAt: "2026-09-30T12:00:01.000Z" }];
    await act(async () => {
      await s.reload();
    });
    expect(s.testPending(target.targetId)).toBe(false);
    expect(s.testDelivery(target.targetId)?.status).toBe("delivered");
    expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
  });
  it.each(["foreign", "regressed", "different-key"])(
    "withholds a %s canonical queued delivery observation",
    async (kind) => {
      const delivery: NotificationDeliveryRecord = {
        deliveryId: "queued",
        eventId: "queued-event",
        ruleId: "operator_test",
        targetId: target.targetId,
        workspaceId: "one",
        idempotencyKey: "notification:queued-event:operator_test:target",
        status: "pending",
        attemptCount: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      api.sendTestNotification.mockImplementation(async () => {
        ownerDeliveries = [
          {
            ...delivery,
            status: "delivered",
            ...(kind === "foreign"
              ? { targetId: "other" }
              : kind === "regressed"
                ? { updatedAt: "2026-09-29T12:00:00.000Z" }
                : { idempotencyKey: "other-key" }),
          },
        ];
        return {
          event: { eventId: delivery.eventId, workspaceId: "one", source: "operator_test" },
          deliveries: [delivery],
          status: "pending",
        };
      });
      await mount();
      await act(async () => s.handleTest(target));
      await act(async () => {
        await s.confirmReview();
      });
      expect(s.attempt.phase).toBe("uncertain");
      expect(s.notice?.message).toContain("could not be independently confirmed");
      await act(async () => s.handleTest(target));
      await act(async () => {
        await s.confirmReview();
      });
      expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
    },
  );
  it("reviews without writes, cancels, and synchronously admits only one exact create", async () => {
    await mount();
    await draft();
    expect(s.review?.kind).toBe("create-target");
    expect(api.createNotificationTarget).not.toHaveBeenCalled();
    await act(async () => s.cancelReview());
    expect(api.createNotificationTarget).not.toHaveBeenCalled();
    await act(async () => {
      await s.handleCreateTarget();
    });
    await act(async () => {
      await Promise.all([s.confirmReview(), s.confirmReview()]);
    });
    expect(api.createNotificationTarget).toHaveBeenCalledTimes(1);
    expect(api.createNotificationTarget).toHaveBeenCalledWith("one", {
      label: "New destination",
      kind: "channel_connection",
      channelConnectionId: "channel",
      lifecycleState: "active",
    });
    expect(api.fetchNotificationTargets).toHaveBeenCalledWith("one", true);
    expect(s.targetDraft.isDirty).toBe(false);
  });
  it.each(["draft", "scope-round-trip"])("withholds dispatch after %s during channel preflight", async (kind) => {
    await mount();
    await draft();
    const pending = deferred<IntegrationConnection>();
    api.fetchIntegrationConnection.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = s.confirmReview();
    });
    if (kind === "draft") await act(async () => s.setTargetForm((value) => ({ ...value, label: "Newer draft" })));
    else {
      await change("two");
      await change("one");
    }
    await act(async () => {
      pending.resolve(channel);
      await saving;
    });
    expect(api.createNotificationTarget).not.toHaveBeenCalled();
    expect(s.attempt.locked).toBe(false);
  });
  it.each(["lost", "readback"])("retains %s create uncertainty across remount", async (kind) => {
    await mount();
    await draft();
    if (kind === "lost") api.createNotificationTarget.mockRejectedValueOnce(new Error("lost response"));
    else api.fetchNotificationTargets.mockResolvedValueOnce({ items: [target] });
    await act(async () => {
      await s.confirmReview();
    });
    expect(s.attempt.phase).toBe("uncertain");
    await act(async () => root.unmount());
    await mount();
    await draft();
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.createNotificationTarget).toHaveBeenCalledTimes(1);
    expect(s.targetDraft.isDirty).toBe(true);
  });
  it("uses exact CAS and includes archived rules in independent readback", async () => {
    await mount();
    await act(async () => s.handleArchiveRule(s.rules[0]!));
    expect(api.updateNotificationRule).not.toHaveBeenCalled();
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.updateNotificationRule).toHaveBeenCalledWith("one", "rule", 1, {
      label: "Failures",
      eventTypes: ["turn.failed"],
      targetIds: ["target"],
      deliveryPolicy: "when_away",
      lifecycleState: "archived",
    });
    expect(api.fetchNotificationRules).toHaveBeenCalledWith("one", true);
    expect(s.rules[0]?.lifecycleState).toBe("archived");
    expect(s.attempt.locked).toBe(false);
  });
  it("rejects a changed destination before a reviewed disable or real test dispatch", async () => {
    await mount();
    await act(async () => s.handleTargetState(target, "disabled"));
    ownerTargets = [{ ...target, revision: 2 }];
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.updateNotificationTarget).not.toHaveBeenCalled();
    await act(async () => s.handleTest(target));
    await act(async () => {
      await s.confirmReview();
    });
    expect(api.sendTestNotification).not.toHaveBeenCalled();
  });
  it.each(["delivered", "unknown_after_send"] as const)(
    "reports canonical %s test truth and never repeats unknown outcomes",
    async (status) => {
      await mount();
      const event = {
        eventId: "event",
        workspaceId: "one",
        source: "operator_test",
        eventType: "durable.attention_required",
        title: "Test notification",
        message: "Fixture",
        createdAt: stamp,
      };
      const delivery: NotificationDeliveryRecord = {
        deliveryId: "delivery",
        eventId: "event",
        ruleId: "operator_test",
        targetId: "target",
        workspaceId: "one",
        idempotencyKey: "notification:event:operator_test:target",
        status,
        attemptCount: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      api.sendTestNotification.mockImplementation(async () => {
        ownerDeliveries = [delivery];
        return { event, deliveries: [delivery], status };
      });
      await act(async () => s.handleTest(target));
      expect(api.sendTestNotification).not.toHaveBeenCalled();
      expect(s.review?.message).toContain("real notification");
      await act(async () => {
        await s.confirmReview();
      });
      expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
      if (status === "delivered") {
        expect(s.notice?.message).toContain("Test delivery: delivered");
        expect(s.attempt.locked).toBe(false);
      } else {
        expect(s.attempt.phase).toBe("uncertain");
        await act(async () => root.unmount());
        await mount();
        await act(async () => s.handleTest(target));
        await act(async () => {
          await s.confirmReview();
        });
        expect(api.sendTestNotification).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("acknowledges a confirmed originating draft after navigation without touching the new workspace", async () => {
    await mount();
    await draft();
    const pending = deferred<NotificationTarget>();
    api.createNotificationTarget.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = s.confirmReview();
    });
    expect(api.createNotificationTarget).toHaveBeenCalledTimes(1);
    await change("two");
    await act(async () => s.setTargetForm((value) => ({ ...value, label: "Keep workspace two" })));
    const saved = { ...target, targetId: "new", label: "New destination" };
    ownerTargets.push(saved);
    await act(async () => {
      pending.resolve(saved);
      await saving;
    });
    expect(s.targetForm.label).toBe("Keep workspace two");
    await change("one");
    expect(s.targetDraft.isDirty).toBe(false);
    expect(s.targetForm.label).toBe("");
  });
});
