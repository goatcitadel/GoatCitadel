import { useRef, useState } from "react";
import type {
  IntegrationConnection,
  NotificationRule,
  NotificationRuleInput,
  NotificationTarget,
  NotificationTargetInput,
} from "@goatcitadel/contracts";
import {
  createNotificationRule,
  createNotificationTarget,
  fetchIntegrationConnection,
  fetchNotificationDeliveries,
  fetchNotificationRules,
  fetchNotificationTargets,
  sendTestNotification,
  updateNotificationRule,
  updateNotificationTarget,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { beginIntegrationMutation } from "../integration-connection-mutation";
import { getErrorMessage } from "../SettingsShared";
import {
  assertNotificationReceipt,
  emptyNotificationRule,
  emptyNotificationTarget,
  notificationConflictRejected,
  notificationRuleInput,
  notificationTargetInput,
  sameNotificationValue,
} from "./notification-routing-binding";
import type { NotificationRoutingState } from "./use-notification-routing-state";
import {
  assertNotificationTestReceipt,
  notificationDeliveryObservationMatches,
  notificationTestPending,
  retainNotificationTestEvidence,
  useNotificationTestEvidence,
} from "./notification-test-evidence";

type Change =
  | { kind: "create-target"; input: NotificationTargetInput; channel?: IntegrationConnection }
  | { kind: "create-rule"; input: NotificationRuleInput; targets: NotificationTarget[] }
  | { kind: "target-state"; target: NotificationTarget; input: NotificationTargetInput }
  | { kind: "rule-state"; rule: NotificationRule; input: NotificationRuleInput }
  | { kind: "test"; target: NotificationTarget };
export type NotificationReview = Change & { generation: number; title: string; message: string };

export function useNotificationRoutingActions(s: NotificationRoutingState) {
  const testEvidence = useNotificationTestEvidence(s.key, s.deliveries);
  const [storedReview, setStoredReview] = useState<NotificationReview | null>(null);
  const reviewRef = useRef<NotificationReview | null>(null);
  const review = storedReview && s.currentAt(storedReview.generation) ? storedReview : null;
  function prepare(change: Change, title: string, message: string) {
    if (s.attempt.locked || s.loading || s.loadError || !s.currentAt(s.generation)) return false;
    const next = { ...structuredClone(change), generation: s.generation, title, message };
    reviewRef.current = next;
    setStoredReview(next);
    s.setNotice(null);
    return true;
  }
  const cancelReview = () => {
    reviewRef.current = null;
    setStoredReview(null);
  };
  async function handleCreateTarget(): Promise<boolean> {
    const input = notificationTargetInput(s.targetForm);
    const channel =
      input.kind === "channel_connection"
        ? s.channels.find((item) => item.connectionId === input.channelConnectionId)
        : undefined;
    if (
      !input.label ||
      (input.kind === "channel_connection" ? !channel : !input.webhookUrlSecretRef?.startsWith("keychain:"))
    ) {
      s.setNotice({
        tone: "warning",
        message:
          "Choose an enabled channel in this workspace, or supply an existing keychain webhook reference, and enter a label.",
      });
      return false;
    }
    prepare(
      { kind: "create-target", input, channel },
      "Create notification destination?",
      `Create ${input.label} in workspace ${s.workspaceId}. ${channel ? `Channel: ${channel.label} (${channel.connectionId}).` : `Webhook reference: ${input.webhookUrlSecretRef}.`} This saves routing metadata; it does not send a test.`,
    );
    return false;
  }
  async function handleCreateRule(): Promise<boolean> {
    const input = notificationRuleInput(s.ruleForm),
      targets = s.activeTargets.filter((item) => input.targetIds.includes(item.targetId));
    if (
      !input.label ||
      !input.eventTypes.length ||
      !input.targetIds.length ||
      targets.length !== input.targetIds.length
    ) {
      s.setNotice({
        tone: "warning",
        message: "Choose a label, events, and current active destinations before reviewing this rule.",
      });
      return false;
    }
    prepare(
      { kind: "create-rule", input, targets },
      "Create notification rule?",
      `Create ${input.label} in workspace ${s.workspaceId}. Events: ${input.eventTypes.join(", ")}. Destinations: ${targets.map((item) => item.label).join(", ")}. Delivery policy: ${input.deliveryPolicy}. Future matching events can send notifications.`,
    );
    return false;
  }
  function handleTargetState(target: NotificationTarget, lifecycleState: "disabled" | "archived") {
    if (!s.targets.some((item) => sameNotificationValue(item, target))) return;
    prepare(
      { kind: "target-state", target, input: notificationTargetInput({ ...target, lifecycleState }) },
      `${lifecycleState === "disabled" ? "Disable" : "Archive"} notification destination?`,
      `${target.label} · workspace ${s.workspaceId} · reviewed revision ${target.revision}. Rules keep their reference; this destination will no longer receive notifications.`,
    );
  }
  function handleArchiveRule(rule: NotificationRule) {
    if (!s.rules.some((item) => sameNotificationValue(item, rule))) return;
    prepare(
      { kind: "rule-state", rule, input: notificationRuleInput({ ...rule, lifecycleState: "archived" }) },
      "Archive notification rule?",
      `${rule.label} · workspace ${s.workspaceId} · reviewed revision ${rule.revision}. This rule will stop routing future events.`,
    );
  }
  function handleTest(target: NotificationTarget) {
    if (
      testEvidence.testPending(target.targetId) ||
      target.lifecycleState !== "active" ||
      !s.targets.some((item) => sameNotificationValue(item, target))
    )
      return;
    prepare(
      { kind: "test", target },
      "Send test notification?",
      `Send a real notification to ${target.label} in workspace ${s.workspaceId}, using ${target.kind === "channel_connection" ? `channel ${target.channelConnectionId}` : `webhook reference ${target.webhookUrlSecretRef}`}. This has an external side effect. The destination is re-read before sending; this API has no atomic revision precondition.`,
    );
  }
  async function confirmReview() {
    const captured = review;
    if (!captured || reviewRef.current !== captured) return false;
    if (captured.kind === "test" && notificationTestPending(s.key, captured.target.targetId)) return false;
    const operation = beginIntegrationMutation(s.key);
    if (!operation) return false;
    const current = () => s.currentAt(captured.generation) && reviewRef.current === captured;
    const submittedTarget = structuredClone(s.targetForm),
      submittedRule = structuredClone(s.ruleForm);
    let clean = false;
    let message: string;
    try {
      if (captured.kind === "create-target" && captured.channel) {
        const channel = await fetchIntegrationConnection(captured.channel.connectionId);
        if (!current()) return false;
        if (!sameNotificationValue(channel, captured.channel))
          throw new Error("The configured channel changed. Refresh and review the destination again.");
      }
      if (captured.kind !== "create-target") {
        const [targets, rules] = await Promise.all([
          fetchNotificationTargets(s.workspaceId, true),
          fetchNotificationRules(s.workspaceId, true),
        ]);
        if (!current()) return false;
        const targetMatches = (target: NotificationTarget) =>
          targets.items.some((item) => sameNotificationValue(item, target));
        if (
          (captured.kind === "create-rule" && !captured.targets.every(targetMatches)) ||
          ((captured.kind === "test" || captured.kind === "target-state") && !targetMatches(captured.target)) ||
          (captured.kind === "rule-state" && !rules.items.some((item) => sameNotificationValue(item, captured.rule)))
        )
          throw new Error("The reviewed notification configuration changed. Refresh and review it again.");
      }
      if (!current()) return false;
      if (captured.kind === "create-target" || captured.kind === "target-state") {
        const before = captured.kind === "target-state" ? captured.target : undefined;
        const receipt = await operation.write(
          () =>
            before
              ? updateNotificationTarget(s.workspaceId, before.targetId, before.revision, captured.input)
              : createNotificationTarget(s.workspaceId, captured.input),
          async (result) => {
            if (
              getGatewayApiBaseUrl() !== s.installation ||
              (!before && s.targets.some((item) => item.targetId === result.targetId))
            )
              throw new Error("The destination receipt cannot be bound to the reviewed installation and creation.");
            assertNotificationReceipt(result, s.workspaceId, captured.input, before);
            const after = await fetchNotificationTargets(s.workspaceId, true);
            if (
              getGatewayApiBaseUrl() !== s.installation ||
              !after.items.some((item) => sameNotificationValue(item, result))
            )
              throw new Error("The saved destination could not be independently confirmed.");
          },
          before
            ? (error) => notificationConflictRejected(error, "target", before.targetId, before.revision)
            : undefined,
        );
        if (captured.kind === "create-target")
          clean = s.targetDraft.acceptSaved(emptyNotificationTarget(submittedTarget.kind), undefined, submittedTarget);
        message = `Destination ${receipt.label}: ${receipt.lifecycleState}, revision ${receipt.revision}, confirmed by the Gateway.`;
      } else if (captured.kind === "create-rule" || captured.kind === "rule-state") {
        const before = captured.kind === "rule-state" ? captured.rule : undefined;
        const receipt = await operation.write(
          () =>
            before
              ? updateNotificationRule(s.workspaceId, before.ruleId, before.revision, captured.input)
              : createNotificationRule(s.workspaceId, captured.input),
          async (result) => {
            if (
              getGatewayApiBaseUrl() !== s.installation ||
              (!before && s.rules.some((item) => item.ruleId === result.ruleId))
            )
              throw new Error("The rule receipt cannot be bound to the reviewed installation and creation.");
            assertNotificationReceipt(result, s.workspaceId, captured.input, before);
            const after = await fetchNotificationRules(s.workspaceId, true);
            if (
              getGatewayApiBaseUrl() !== s.installation ||
              !after.items.some((item) => sameNotificationValue(item, result))
            )
              throw new Error("The saved rule could not be independently confirmed.");
          },
          before ? (error) => notificationConflictRejected(error, "rule", before.ruleId, before.revision) : undefined,
        );
        if (captured.kind === "create-rule")
          clean = s.ruleDraft.acceptSaved(emptyNotificationRule(), undefined, submittedRule);
        message = `Rule ${receipt.label}: ${receipt.lifecycleState}, revision ${receipt.revision}, confirmed by the Gateway.`;
      } else {
        if (notificationTestPending(s.key, captured.target.targetId)) return false;
        const result = await operation.write(
          () => sendTestNotification(s.workspaceId, captured.target.targetId),
          async (result) => {
            const delivery = assertNotificationTestReceipt(result, s.workspaceId, captured.target.targetId);
            if (getGatewayApiBaseUrl() !== s.installation || delivery.status === "unknown_after_send")
              throw new Error(
                "The notification test outcome is unconfirmed. Inspect delivery evidence before sending another test.",
              );
            const after = await fetchNotificationDeliveries(s.workspaceId, 50, {
              signal: new AbortController().signal,
            });
            if (
              getGatewayApiBaseUrl() !== s.installation ||
              !notificationDeliveryObservationMatches(
                delivery,
                after.items.find((item) => item.deliveryId === delivery.deliveryId),
              )
            )
              throw new Error("The test delivery record could not be independently confirmed.");
            retainNotificationTestEvidence(s.key, after.items.find((item) => item.deliveryId === delivery.deliveryId)!, true);
          },
        );
        message =
          result.status === "pending"
            ? "Test delivery: pending. Refresh delivery evidence before sending another test to this destination."
            : `Test delivery: ${result.status}. The exact destination delivery record was confirmed.`;
      }
      if (!current()) return clean;
      cancelReview();
      s.setNotice({ tone: "info", message });
      if (clean) s.setEditor(null);
      await s.reload();
      return clean;
    } catch (error) {
      if (current()) {
        cancelReview();
        s.setNotice({ tone: "error", message: getErrorMessage(error) });
      }
      return false;
    } finally {
      operation.finish();
    }
  }
  return {
    ...testEvidence,
    review,
    cancelReview,
    confirmReview,
    handleCreateTarget,
    handleCreateRule,
    handleTargetState,
    handleArchiveRule,
    handleTest,
    busyId: s.attempt.pending ? "pending" : "",
  };
}
