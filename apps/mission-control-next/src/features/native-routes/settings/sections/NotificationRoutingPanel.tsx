import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { Bell, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { NOTIFICATION_EVENT_TYPES, type NotificationTargetKind } from "@goatcitadel/contracts";
import type { IntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { NativeButton } from "../../primitives";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { SettingsButtonRow, SettingsField, SettingsFieldGrid, SettingsNotice, SettingsStack } from "../SettingsShared";
import { useNotificationRouting } from "./use-notification-routing";
interface NotificationRoutingPanelProps {
  workspaceId: string;
  channels: IntegrationConnection[];
  defaultTargetKind?: NotificationTargetKind;
}
export function NotificationRoutingPanel({
  workspaceId,
  channels: suppliedChannels,
  defaultTargetKind = "channel_connection",
}: NotificationRoutingPanelProps) {
  const s = useNotificationRouting(workspaceId, suppliedChannels, defaultTargetKind);
  const {
    targets,
    rules,
    deliveries,
    loading,
    loadError,
    notice,
    editor,
    setEditor,
    leave,
    targetDraft,
    ruleDraft,
    targetForm,
    ruleForm,
    setTargetForm,
    setRuleForm,
    activeTargets,
    channels,
    reload,
    toggleTarget,
    toggleEventType,
    handleCreateTarget,
    handleCreateRule,
    handleTargetState,
    handleArchiveRule,
    handleTest,
    busyId,
  } = s;
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Notification routing"
      subtitle="Operator-managed destinations and rules. Chat and models can reference rules, never raw endpoints or credentials."
      stats={[
        { label: "Targets", value: loadError ? "Unavailable" : loading ? "Loading" : String(activeTargets.length) },
        { label: "Rules", value: loadError ? "Unavailable" : loading ? "Loading" : String(rules.length) },
        { label: "Recent", value: loadError ? "Unavailable" : loading ? "Loading" : String(deliveries.length) },
      ]}
    >
      <SettingsStack>
        {notice ? <SettingsNotice notice={notice} /> : null}
        {s.attempt.phase === "uncertain" ? (
          <SettingsNotice
            notice={{
              tone: "warning",
              message: s.attempt.message ?? "Notification outcome is unconfirmed; further changes are withheld.",
            }}
          />
        ) : null}
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
            <fieldset className="mc-next-settings-fieldset" disabled={s.attempt.locked}>
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
                      disabled={s.attempt.locked || busyId === "create-target" || !targetForm.label.trim()}
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
                        s.attempt.locked ||
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
                      {s.testDelivery(target.targetId) ? (
                        <p role="status">
                          Latest test for {target.label}: {s.testDelivery(target.targetId)!.status.replaceAll("_", " ")}
                          .{" "}
                          {s.testPending(target.targetId)
                            ? "Refresh evidence before another send."
                            : "Confirmed by the Gateway."}
                        </p>
                      ) : null}
                      <SettingsButtonRow>
                        <NativeButton
                          variant="secondary"
                          disabled={
                            s.attempt.locked ||
                            s.testPending(target.targetId) ||
                            busyId === `test:${target.targetId}` ||
                            target.lifecycleState !== "active"
                          }
                          onClick={() => void handleTest(target)}
                          aria-label={`Test notification destination ${target.label}`}
                        >
                          <Send size={15} /> Test
                        </NativeButton>
                        <NativeButton
                          variant="ghost"
                          disabled={s.attempt.locked || busyId === target.targetId}
                          onClick={() => void handleTargetState(target, "disabled")}
                          aria-label={`Disable notification destination ${target.label}`}
                        >
                          Disable
                        </NativeButton>
                        <NativeButton
                          variant="ghost"
                          disabled={s.attempt.locked || busyId === target.targetId}
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
                        disabled={s.attempt.locked || busyId === rule.ruleId}
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
        <ConfirmModal
          open={Boolean(s.review)}
          title={s.review?.title ?? "Review notification change"}
          message={s.review?.message ?? ""}
          confirmLabel="Apply reviewed notification action"
          pending={s.attempt.pending}
          confirmDisabled={s.attempt.phase === "uncertain"}
          onCancel={s.cancelReview}
          onConfirm={() => void s.confirmReview()}
        />
        {leave.dialog}
      </SettingsStack>
    </NativeCard>
  );
}
