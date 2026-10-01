import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type {
  IntegrationConnection,
  NotificationDeliveryRecord,
  NotificationEventType,
  NotificationRule,
  NotificationTarget,
  NotificationTargetKind,
} from "@goatcitadel/contracts";
import {
  fetchNotificationDeliveries,
  fetchNotificationRules,
  fetchNotificationTargets,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { getErrorMessage, type Notice } from "../SettingsShared";
import { emptyNotificationRule, emptyNotificationTarget } from "./notification-routing-binding";
import { useIntegrationConnectionMutation } from "../integration-connection-mutation";

export function useNotificationRoutingState(
  workspaceId: string,
  channels: IntegrationConnection[],
  defaultTargetKind: NotificationTargetKind,
) {
  const installation = getGatewayApiBaseUrl(),
    key = JSON.stringify(["notification-routing", installation, workspaceId]);
  const [targets, setTargets] = useState<NotificationTarget[]>([]),
    [rules, setRules] = useState<NotificationRule[]>([]),
    [deliveries, setDeliveries] = useState<NotificationDeliveryRecord[]>([]);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState<string | null>(null),
    [notice, setNotice] = useState<Notice | null>(null);
  const [editor, setStoredEditor] = useState<"target" | "rule" | null>(null);
  const leave = useDraftLeave(),
    attempt = useIntegrationConnectionMutation(key);
  const targetDraft = useSessionDraft(`${key}:target:new`, emptyNotificationTarget(defaultTargetKind), undefined, {
    label: "Notification destination",
    active: editor === "target",
  });
  const ruleDraft = useSessionDraft(`${key}:rule:new`, emptyNotificationRule(), undefined, {
    label: "Notification rule",
    active: editor === "rule",
  });
  const identity = JSON.stringify([key, editor, targetDraft.value, ruleDraft.value]);
  const live = useRef({ identity, key, generation: 0, read: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.key = key;
    live.current.generation++;
  }
  const currentAt = (generation: number) =>
    live.current.mounted &&
    live.current.key === key &&
    live.current.generation === generation &&
    getGatewayApiBaseUrl() === installation;
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    setStoredEditor(null);
    setNotice(null);
    return () => {
      owner.mounted = false;
      owner.generation++;
      owner.read++;
    };
  }, [key]);
  const reload = useCallback(async () => {
    const read = ++live.current.read;
    const current = () =>
      live.current.mounted &&
      live.current.key === key &&
      live.current.read === read &&
      getGatewayApiBaseUrl() === installation;
    setLoading(true);
    setLoadError(null);
    try {
      if (!workspaceId.trim()) throw new Error("Select a workspace before reviewing notification routing.");
      const [targetResponse, ruleResponse, deliveryResponse] = await Promise.all([
        fetchNotificationTargets(workspaceId, true),
        fetchNotificationRules(workspaceId, true),
        fetchNotificationDeliveries(workspaceId, 30, { signal: new AbortController().signal }),
      ]);
      if (!current()) return;
      const lists = [targetResponse.items, ruleResponse.items, deliveryResponse.items];
      if (!lists.every((items) => Array.isArray(items) && items.every((item) => item.workspaceId === workspaceId)))
        throw new Error("The notification owner returned unavailable or differently scoped records.");
      setTargets(targetResponse.items);
      setRules(ruleResponse.items);
      setDeliveries(deliveryResponse.items);
    } catch (error) {
      if (current()) {
        setTargets([]);
        setRules([]);
        setDeliveries([]);
        setLoadError(getErrorMessage(error));
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [installation, key, workspaceId]);
  useEffect(() => {
    setTargets([]);
    setRules([]);
    setDeliveries([]);
    void reload();
  }, [reload]);
  function setEditor(value: typeof editor) {
    live.current.generation++;
    setStoredEditor(value);
  }
  function setTargetForm(value: SetStateAction<typeof targetDraft.value>) {
    live.current.generation++;
    targetDraft.setValue(value);
  }
  function setRuleForm(value: SetStateAction<typeof ruleDraft.value>) {
    live.current.generation++;
    ruleDraft.setValue(value);
  }
  const toggleEventType = (eventType: NotificationEventType) =>
    setRuleForm((current) => ({
      ...current,
      eventTypes: current.eventTypes.includes(eventType)
        ? current.eventTypes.filter((item) => item !== eventType)
        : [...current.eventTypes, eventType],
    }));
  const toggleTarget = (targetId: string) =>
    setRuleForm((current) => ({
      ...current,
      targetIds: current.targetIds.includes(targetId)
        ? current.targetIds.filter((item) => item !== targetId)
        : [...current.targetIds, targetId],
    }));
  return {
    workspaceId,
    installation,
    key,
    channels: channels.filter(
      (item) => item.kind === "channel" && item.enabled && (!item.workspaceId || item.workspaceId === workspaceId),
    ),
    targets,
    rules,
    deliveries,
    activeTargets: targets.filter((target) => target.lifecycleState === "active"),
    loading,
    loadError,
    notice,
    setNotice,
    editor,
    setEditor,
    leave,
    attempt,
    targetDraft,
    ruleDraft,
    targetForm: targetDraft.value,
    ruleForm: ruleDraft.value,
    setTargetForm,
    setRuleForm,
    toggleEventType,
    toggleTarget,
    reload,
    currentAt,
    generation: live.current.generation,
  };
}
export type NotificationRoutingState = ReturnType<typeof useNotificationRoutingState>;
