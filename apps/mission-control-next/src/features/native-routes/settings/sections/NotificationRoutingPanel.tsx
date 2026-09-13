import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
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
  const [editor, setEditor] = useState<"target" | "rule" | null>(null);
  const leave = useDraftLeave();
  const busyRef = useRef(false);
  const loadGeneration = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const emptyTarget = {
    label: "",
    kind: defaultTargetKind,
    channelConnectionId: "",
    webhookUrlSecretRef: "",
    credentialSecretRef: "",
  };
  const emptyRule = {
    label: "",
    eventTypes: DEFAULT_EVENT_TYPES,
    targetIds: [] as string[],
    deliveryPolicy: "when_away" as "always" | "when_away",
  };
  const targetDraft = useSessionDraft("notifications:" + workspaceId + ":target:new", emptyTarget, undefined, {
    label: "Notification destination",
    active: editor === "target",
    onSave: () => handleCreateTarget(),
  });
  const ruleDraft = useSessionDraft("notifications:" + workspaceId + ":rule:new", emptyRule, undefined, {
    label: "Notification rule",
    active: editor === "rule",
    onSave: () => handleCreateRule(),
  });
  const targetForm = targetDraft.value,
    setTargetForm = targetDraft.setValue,
    ruleForm = ruleDraft.value,
    setRuleForm = ruleDraft.setValue;

  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [targetResponse, ruleResponse, deliveryResponse] = await Promise.all([
        fetchNotificationTargets(workspaceId),
        fetchNotificationRules(workspaceId),
        fetchNotificationDeliveries(workspaceId, 30),
      ]);
      if (generation !== loadGeneration.current) return;
      setTargets(targetResponse.items ?? []);
      setRules(ruleResponse.items ?? []);
      setDeliveries(deliveryResponse.items ?? []);
    } catch (error) {
      if (generation === loadGeneration.current) setLoadError(getErrorMessage(error));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setTargets([]);
    setRules([]);
    setDeliveries([]);
    setEditor(null);
    void reload();
    return () => {
      loadGeneration.current += 1;
    };
  }, [reload]);

  const activeTargets = useMemo(() => targets.filter((target) => target.lifecycleState === "active"), [targets]);

  const handleCreateTarget = async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    const submitted = targetForm;
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
      const clean = targetDraft.acceptSaved(emptyTarget, undefined, submitted);
      setNotice({ tone: "success", message: "Notification target created." });
      await reload();
      if (clean) setEditor(null);
      return clean;
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
      return false;
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  };

  const handleTargetState = async (target: NotificationTarget, lifecycleState: "disabled" | "archived") => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      return false;
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  };

  const handleTest = async (target: NotificationTarget) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(`test:${target.targetId}`);
    try {
      const result = await sendTestNotification(workspaceId, target.targetId);
      const status = result.status;
      setNotice({
        tone: status === "failed" ? "error" : status === "delivered" ? "success" : "info",
        message: `Test delivery: ${status}.`,
      });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
      return false;
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  };

  const handleCreateRule = async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    const submitted = ruleForm;
    setBusyId("create-rule");
    try {
      await createNotificationRule(workspaceId, ruleForm);
      const clean = ruleDraft.acceptSaved(emptyRule, undefined, submitted);
      setNotice({ tone: "success", message: "Notification rule created." });
      await reload();
      if (clean) setEditor(null);
      return clean;
    } catch (error) {
      setNotice({ tone: "error", message: getErrorMessage(error) });
      return false;
    } finally {
      busyRef.current = false;
      setBusyId("");
    }
  };

  const handleArchiveRule = async (rule: NotificationRule) => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      return false;
    } finally {
      busyRef.current = false;
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
      stats={[{label:"Targets",value:loadError ? "Unavailable" : loading ? "Loading" : String(activeTargets.length)},{label:"Rules",value:loadError ? "Unavailable" : loading ? "Loading" : String(rules.length)},{label:"Recent",value:loadError ? "Unavailable" : loading ? "Loading" : String(deliveries.length)}]}
    >
      <SettingsStack>
        {notice ? <SettingsNotice notice={notice} /> : null}
        {loading ? <p role="status">Loading notification routing…</p> : null}
        {loadError ? (
          <SettingsNotice
            notice={{ tone: "warning", message: "Notification data is unavailable or stale: " + loadError }}
          />
        ) : null}
        {editor ? (
          <FocusedDetail
            title={editor === "target" ? "New notification destination" : "New notification rule"}
            onClose={() => leave.request(() => setEditor(null))}
          >
            <fieldset className="mc-next-settings-fieldset" disabled={Boolean(busyId)}>
              {editor === "target" ? (
                <>
                  {" "}
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
                          setTargetForm((current) => ({
                            ...current,
                            kind: event.target.value as NotificationTargetKind,
                          }))
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
                </>
              ) : (
                <>
                  {" "}
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
                </>
              )}
            </fieldset>
          </FocusedDetail>
        ) : (
          <>
            <SettingsButtonRow>
              <NativeButton onClick={() => setEditor("target")}>
                New destination{targetDraft.isDirty ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton onClick={() => setEditor("rule")}>
                New rule{ruleDraft.isDirty ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton variant="secondary" onClick={() => void reload()} disabled={loading}>
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>

            <section aria-labelledby="notification-target-heading">
              <h4 id="notification-target-heading">Destinations</h4>
              <div className="mc-next-settings-list" role="list" aria-label="Notification destinations">
                {!loading && !loadError && !targets.length ? <p>No notification destinations configured.</p> : null}
                {targets.map((target) => (
                  <div role="listitem" key={target.targetId}>
                    <NativeDisclosureCard
                      id={"notification-target-" + target.targetId}
                      title={target.label}
                      subtitle={target.kind.replaceAll("_", " ") + " · " + target.lifecycleState}
                    >
                      <div>
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
                    </NativeDisclosureCard>
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="notification-rule-heading">
              <h4 id="notification-rule-heading">Rules</h4>
              <div className="mc-next-settings-list" role="list" aria-label="Notification rules">
                {!loading && !loadError && !rules.length ? <p>No notification rules configured.</p> : null}
                {rules.map((rule) => (
                  <div role="listitem" key={rule.ruleId}>
                    <NativeDisclosureCard
                      id={"notification-rule-" + rule.ruleId}
                      title={rule.label}
                      subtitle={rule.deliveryPolicy.replaceAll("_", " ") + " · " + rule.lifecycleState}
                    >
                      <div>
                        <p>
                          {rule.deliveryPolicy.replace("_", " ")} · {rule.eventTypes.join(", ")} · revision{" "}
                          {rule.revision}
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
                    </NativeDisclosureCard>
                  </div>
                ))}
              </div>
            </section>

            <NativeDisclosureCard id="notification-delivery-heading" title="Recent delivery truth">
              <div className="mc-next-settings-list" role="list" aria-label="Recent notification deliveries">
                {!loading && !loadError && !deliveries.length ? <p>No recent deliveries returned.</p> : null}
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
            </NativeDisclosureCard>
          </>
        )}
        {leave.dialog}
      </SettingsStack>
    </NativeCard>
  );
}
