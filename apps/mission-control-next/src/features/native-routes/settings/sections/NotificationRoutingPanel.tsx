import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEventType,
  type NotificationRule,
  type NotificationTarget,
  type NotificationTargetKind,
} from "@goatcitadel/contracts";
import {
  createNotificationRule,
  createNotificationTarget,
  fetchNotificationDeliveries,
  fetchNotificationRules,
  fetchNotificationTargets,
  sendTestNotification,
  updateNotificationRule,
  updateNotificationTarget,
  type IntegrationConnection,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeButton } from "../../primitives";
import { NativeCard } from "../../NativeRoutePageLayout";
import {
  getErrorMessage,
  SettingsButtonRow,
  SettingsField,
  SettingsFieldGrid,
  SettingsNotice,
  SettingsStack,
  type Notice,
} from "../SettingsShared";

interface NotificationRoutingPanelProps {
  workspaceId: string;
  channels: IntegrationConnection[];
  defaultTargetKind?: NotificationTargetKind;
}

const DEFAULT_EVENT_TYPES: NotificationEventType[] = [
  "turn.failed",
  "turn.blocked",
  "approval.requested",
  "user_input.requested",
  "durable.attention_required",
  "timer.due",
  "scheduled_turn.failed",
];

export function NotificationRoutingPanel({
  workspaceId,
  channels,
  defaultTargetKind = "channel_connection",
}: NotificationRoutingPanelProps) {
  const [targets, setTargets] = useState<NotificationTarget[]>([]);
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [deliveries, setDeliveries] = useState<Awaited<ReturnType<typeof fetchNotificationDeliveries>>["items"]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [targetForm, setTargetForm] = useState({
    label: "",
    kind: defaultTargetKind,
    channelConnectionId: "",
    webhookUrlSecretRef: "",
    credentialSecretRef: "",
  });
  const [ruleForm, setRuleForm] = useState({
    label: "",
    eventTypes: DEFAULT_EVENT_TYPES,
    targetIds: [] as string[],
    deliveryPolicy: "when_away" as "always" | "when_away",
  });

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [targetResponse, ruleResponse, deliveryResponse] = await Promise.all([
        fetchNotificationTargets(workspaceId),
        fetchNotificationRules(workspaceId),
        fetchNotificationDeliveries(workspaceId, 30),
      ]);
      setTargets(targetResponse.items ?? []);
      setRules(ruleResponse.items ?? []);
      setDeliveries(deliveryResponse.items ?? []);
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeTargets = useMemo(() => targets.filter((target) => target.lifecycleState === "active"), [targets]);

  const handleCreateTarget = async () => {
    setBusyId("create-target");
    setNotice(null);
    try {
      await createNotificationTarget(workspaceId, {
        label: targetForm.label,
        kind: targetForm.kind,
        ...(targetForm.kind === "channel_connection"
          ? { channelConnectionId: targetForm.channelConnectionId }
          : {
              webhookUrlSecretRef: targetForm.webhookUrlSecretRef,
              ...(targetForm.credentialSecretRef ? { credentialSecretRef: targetForm.credentialSecretRef } : {}),
            }),
      });
      setTargetForm((current) => ({ ...current, label: "", webhookUrlSecretRef: "", credentialSecretRef: "" }));
      setNotice({ tone: "success", message: "Notification target created." });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyId("");
    }
  };

  const handleTargetState = async (target: NotificationTarget, lifecycleState: "disabled" | "archived") => {
    setBusyId(target.targetId);
    try {
      await updateNotificationTarget(workspaceId, target.targetId, target.revision, {
        label: target.label,
        kind: target.kind,
        channelConnectionId: target.channelConnectionId,
        webhookUrlSecretRef: target.webhookUrlSecretRef,
        credentialSecretRef: target.credentialSecretRef,
        lifecycleState,
      });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyId("");
    }
  };

  const handleTest = async (target: NotificationTarget) => {
    setBusyId(`test:${target.targetId}`);
    try {
      const result = await sendTestNotification(workspaceId, target.targetId);
      const status = result.status;
      setNotice({ tone: status === "failed" ? "error" : "success", message: `Test delivery: ${status}.` });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyId("");
    }
  };

  const handleCreateRule = async () => {
    setBusyId("create-rule");
    try {
      await createNotificationRule(workspaceId, ruleForm);
      setRuleForm((current) => ({ ...current, label: "", targetIds: [] }));
      setNotice({ tone: "success", message: "Notification rule created." });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyId("");
    }
  };

  const handleArchiveRule = async (rule: NotificationRule) => {
    setBusyId(rule.ruleId);
    try {
      await updateNotificationRule(workspaceId, rule.ruleId, rule.revision, {
        label: rule.label,
        eventTypes: rule.eventTypes,
        targetIds: rule.targetIds,
        deliveryPolicy: rule.deliveryPolicy,
        lifecycleState: "archived",
      });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      setBusyId("");
    }
  };

  const toggleEventType = (eventType: NotificationEventType) => {
    setRuleForm((current) => ({
      ...current,
      eventTypes: current.eventTypes.includes(eventType)
        ? current.eventTypes.filter((item) => item !== eventType)
        : [...current.eventTypes, eventType],
    }));
  };

  const toggleTarget = (targetId: string) => {
    setRuleForm((current) => ({
      ...current,
      targetIds: current.targetIds.includes(targetId)
        ? current.targetIds.filter((item) => item !== targetId)
        : [...current.targetIds, targetId],
    }));
  };

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Notification routing"
      subtitle="Operator-managed destinations and rules. Chat and models can reference rules, never raw endpoints or credentials."
      stats={[
        { label: "Targets", value: String(activeTargets.length) },
        { label: "Rules", value: String(rules.length) },
        { label: "Recent", value: String(deliveries.length) },
      ]}
    >
      <SettingsStack>
        {notice ? <SettingsNotice notice={notice} /> : null}
        <SettingsButtonRow>
          <NativeButton variant="secondary" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={16} />
            Refresh
          </NativeButton>
        </SettingsButtonRow>

        <section aria-labelledby="notification-target-heading">
          <h4 id="notification-target-heading">Destinations</h4>
          <SettingsFieldGrid>
            <SettingsField label="Label">
              <input
                className="mc-next-settings-input"
                value={targetForm.label}
                onChange={(event) => setTargetForm((current) => ({ ...current, label: event.target.value }))}
              />
            </SettingsField>
            <SettingsField label="Kind">
              <select
                className="mc-next-settings-input"
                value={targetForm.kind}
                onChange={(event) =>
                  setTargetForm((current) => ({ ...current, kind: event.target.value as NotificationTargetKind }))
                }
              >
                <option value="channel_connection">Configured channel</option>
                <option value="https_webhook">Keychain HTTPS webhook</option>
              </select>
            </SettingsField>
            {targetForm.kind === "channel_connection" ? (
              <SettingsField label="Channel connection">
                <select
                  className="mc-next-settings-input"
                  value={targetForm.channelConnectionId}
                  onChange={(event) =>
                    setTargetForm((current) => ({ ...current, channelConnectionId: event.target.value }))
                  }
                >
                  <option value="">Select a configured channel</option>
                  {channels.map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.label} · {connection.status}
                    </option>
                  ))}
                </select>
              </SettingsField>
            ) : (
              <>
                <SettingsField label="Webhook URL secret reference">
                  <input
                    className="mc-next-settings-input"
                    placeholder="keychain:goatcitadel:notification-webhook:primary"
                    value={targetForm.webhookUrlSecretRef}
                    onChange={(event) =>
                      setTargetForm((current) => ({ ...current, webhookUrlSecretRef: event.target.value }))
                    }
                  />
                </SettingsField>
                <SettingsField label="Credential secret reference (optional)">
                  <input
                    className="mc-next-settings-input"
                    placeholder="keychain:goatcitadel:notification-token:primary"
                    value={targetForm.credentialSecretRef}
                    onChange={(event) =>
                      setTargetForm((current) => ({ ...current, credentialSecretRef: event.target.value }))
                    }
                  />
                </SettingsField>
              </>
            )}
          </SettingsFieldGrid>
          <SettingsButtonRow>
            <NativeButton
              variant="default"
              disabled={busyId === "create-target" || !targetForm.label.trim()}
              onClick={() => void handleCreateTarget()}
            >
              <Plus size={16} />
              Add destination
            </NativeButton>
          </SettingsButtonRow>
          <div className="mc-next-settings-list" role="list" aria-label="Notification destinations">
            {targets.map((target) => (
              <div className="mc-next-settings-list-row" role="listitem" key={target.targetId}>
                <div>
                  <strong>{target.label}</strong>
                  <p>
                    {target.kind === "channel_connection" ? "Configured channel" : "Allowlisted HTTPS webhook"} ·{" "}
                    {target.lifecycleState} · revision {target.revision}
                  </p>
                </div>
                <SettingsButtonRow>
                  <NativeButton
                    variant="secondary"
                    disabled={busyId === `test:${target.targetId}` || target.lifecycleState !== "active"}
                    onClick={() => void handleTest(target)}
                    aria-label={`Test notification destination ${target.label}`}
                  >
                    <Send size={15} /> Test
                  </NativeButton>
                  <NativeButton
                    variant="ghost"
                    disabled={busyId === target.targetId}
                    onClick={() => void handleTargetState(target, "disabled")}
                    aria-label={`Disable notification destination ${target.label}`}
                  >
                    Disable
                  </NativeButton>
                  <NativeButton
                    variant="ghost"
                    disabled={busyId === target.targetId}
                    onClick={() => void handleTargetState(target, "archived")}
                    aria-label={`Archive notification destination ${target.label}`}
                  >
                    <Trash2 size={15} /> Archive
                  </NativeButton>
                </SettingsButtonRow>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="notification-rule-heading">
          <h4 id="notification-rule-heading">Rules</h4>
          <SettingsFieldGrid>
            <SettingsField label="Rule label">
              <input
                className="mc-next-settings-input"
                value={ruleForm.label}
                onChange={(event) => setRuleForm((current) => ({ ...current, label: event.target.value }))}
              />
            </SettingsField>
            <SettingsField label="Delivery policy">
              <select
                className="mc-next-settings-input"
                value={ruleForm.deliveryPolicy}
                onChange={(event) =>
                  setRuleForm((current) => ({
                    ...current,
                    deliveryPolicy: event.target.value as "always" | "when_away",
                  }))
                }
              >
                <option value="when_away">Only when away</option>
                <option value="always">Always</option>
              </select>
            </SettingsField>
          </SettingsFieldGrid>
          <fieldset className="mc-next-settings-check-grid">
            <legend>Events</legend>
            {NOTIFICATION_EVENT_TYPES.map((eventType) => (
              <label key={eventType}>
                <input
                  type="checkbox"
                  checked={ruleForm.eventTypes.includes(eventType)}
                  onChange={() => toggleEventType(eventType)}
                />
                {eventType}
              </label>
            ))}
          </fieldset>
          <fieldset className="mc-next-settings-check-grid">
            <legend>Destinations</legend>
            {activeTargets.map((target) => (
              <label key={target.targetId}>
                <input
                  type="checkbox"
                  checked={ruleForm.targetIds.includes(target.targetId)}
                  onChange={() => toggleTarget(target.targetId)}
                />
                {target.label}
              </label>
            ))}
          </fieldset>
          <SettingsButtonRow>
            <NativeButton
              variant="default"
              disabled={
                busyId === "create-rule" ||
                !ruleForm.label.trim() ||
                ruleForm.eventTypes.length === 0 ||
                ruleForm.targetIds.length === 0
              }
              onClick={() => void handleCreateRule()}
            >
              <Bell size={16} /> Create rule
            </NativeButton>
          </SettingsButtonRow>
          <div className="mc-next-settings-list" role="list" aria-label="Notification rules">
            {rules.map((rule) => (
              <div className="mc-next-settings-list-row" role="listitem" key={rule.ruleId}>
                <div>
                  <strong>{rule.label}</strong>
                  <p>
                    {rule.deliveryPolicy.replace("_", " ")} · {rule.eventTypes.join(", ")} · revision {rule.revision}
                  </p>
                </div>
                <NativeButton
                  variant="ghost"
                  disabled={busyId === rule.ruleId}
                  onClick={() => void handleArchiveRule(rule)}
                  aria-label={`Archive notification rule ${rule.label}`}
                >
                  <Trash2 size={15} /> Archive
                </NativeButton>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="notification-delivery-heading">
          <h4 id="notification-delivery-heading">Recent delivery truth</h4>
          <div className="mc-next-settings-list" role="list" aria-label="Recent notification deliveries">
            {deliveries.map((delivery) => (
              <div className="mc-next-settings-list-row" role="listitem" key={delivery.deliveryId}>
                <div>
                  <strong>{delivery.status.replaceAll("_", " ")}</strong>
                  <p>
                    Target {delivery.targetId} · attempts {delivery.attemptCount} · {delivery.updatedAt}
                  </p>
                  {delivery.lastError ? <p>{delivery.lastError}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      </SettingsStack>
    </NativeCard>
  );
}
