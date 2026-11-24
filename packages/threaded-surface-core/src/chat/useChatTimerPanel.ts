import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeChatTimerStatus, type ChatThreadResponse, type ChatTimerRecord } from "@goatcitadel/contracts";
import {
  cancelChatTimer,
  createChatTimer,
  fetchChatTimers,
  fetchNotificationRules,
  fetchNotificationTargets,
} from "@goatcitadel/mission-control-shared/api/client";
import { toDateTimeLocalValue, zonedDateTimeToIso, type ChatTimerDraft } from "./chat-timer-form";

import { createAttemptKey } from "@goatcitadel/mission-control-shared/api/mutation-attempts";
import {
  getGatewayCallerScopeRevision,
  getGatewayAccessRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

interface ChatTimerPanelState {
  open: boolean;
  busy: boolean;
  error: string | null;
  dueAt: string;
  delayMs?: number;
  timezone: string;
  message: string;
  notificationRuleId: string;
  cancelOnNextReply: boolean;
  rules: Array<{ ruleId: string; label: string }>;
  timers: ChatTimerRecord[];
}

const MAX_REMINDER_LENGTH = 4000;

const INITIAL_STATE: ChatTimerPanelState = {
  open: false,
  busy: false,
  error: null,
  dueAt: "",
  timezone: "UTC",
  message: "",
  notificationRuleId: "",
  cancelOnNextReply: false,
  rules: [],
  timers: [],
};

export function useChatTimerPanel(input: {
  selectedSessionId: string | null;
  workspaceId: string;
  enabled: boolean;
  eventStreamState: string;
  thread: ChatThreadResponse | null;
  pushLocalNotice: (content: string, tone?: "success") => void;
}) {
  const { selectedSessionId, workspaceId, enabled, eventStreamState, thread, pushLocalNotice } = input;
  const caller = getGatewayCallerScopeRevision(),
    access = getGatewayAccessRevision(),
    gateway = getGatewayApiBaseUrl();
  const scope = JSON.stringify([workspaceId, selectedSessionId, enabled, caller, access, gateway]);
  const confirmation = useRef<{ identity: string; key: string; dueAt: string } | null>(null);
  const owner = useRef({ scope, generation: 0 });
  if (owner.current.scope !== scope) owner.current = { scope, generation: owner.current.generation + 1 };
  const generation = owner.current.generation;
  const mounted = useRef(true),
    readTicket = useRef(0),
    editorGeneration = useRef(0);
  const pendingScopes = useRef(new Set<string>());
  const [, refreshPending] = useState(0);
  const [snapshot, setSnapshot] = useState({ generation, value: INITIAL_STATE });
  const panel = snapshot.generation === generation ? snapshot.value : INITIAL_STATE;
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      owner.current.generation === generation &&
      caller === getGatewayCallerScopeRevision() &&
      access === getGatewayAccessRevision() &&
      gateway === getGatewayApiBaseUrl(),
    [generation, caller, access, gateway],
  );
  const setPanel = useCallback(
    (change: (value: ChatTimerPanelState) => ChatTimerPanelState) => {
      if (!isCurrent()) return;
      setSnapshot((current) => ({
        generation,
        value: change(current.generation === generation ? current.value : INITIAL_STATE),
      }));
    },
    [generation, isCurrent],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readTicket.current += 1;
    };
  }, []);
  const matchesOwner = useCallback(
    (timer: ChatTimerRecord | undefined) =>
      timer?.sessionId === selectedSessionId &&
      timer.workspaceId === workspaceId &&
      Boolean(timer.timerId) &&
      Number.isSafeInteger(timer.revision) &&
      timer.revision > 0,
    [selectedSessionId, workspaceId],
  );

  const refresh = useCallback(async () => {
    if (!selectedSessionId || !enabled || !isCurrent()) return;
    const ticket = ++readTicket.current;
    const current = () => isCurrent() && ticket === readTicket.current;
    try {
      const [timersResult, rulesResult, targetsResult] = await Promise.allSettled([
        fetchChatTimers(selectedSessionId),
        fetchNotificationRules(workspaceId),
        fetchNotificationTargets(workspaceId),
      ]);
      if (!current()) return;
      if (timersResult.status === "rejected") throw timersResult.reason;
      if (!timersResult.value.items.every(matchesOwner))
        throw new Error("The Gateway returned timers for a different Chat scope.");
      const rules = rulesResult.status === "fulfilled" ? rulesResult.value.items : [];
      const targets = new Set(
        targetsResult.status === "fulfilled"
          ? targetsResult.value.items
              .filter((target) => target.workspaceId === workspaceId && target.lifecycleState === "active")
              .map((target) => target.targetId)
          : [],
      );
      setPanel((current) => ({
        ...current,
        timers: timersResult.value.items,
        rules: rules
          .filter(
            (rule) =>
              rule.workspaceId === workspaceId &&
              rule.lifecycleState === "active" &&
              rule.eventTypes.includes("timer.due") &&
              rule.targetIds.length > 0 &&
              rule.targetIds.every((id) => targets.has(id)),
          )
          .map((rule) => ({ ruleId: rule.ruleId, label: rule.label })),
        error: null,
      }));
    } catch (error) {
      if (!current()) return;
      setPanel((current) => ({
        ...current,
        timers: [],
        error: error instanceof Error ? error.message : "Unable to load Chat timers.",
      }));
    }
  }, [enabled, isCurrent, matchesOwner, selectedSessionId, setPanel, workspaceId]);

  const open = useCallback(
    (draft?: ChatTimerDraft) => {
      if (!enabled || !selectedSessionId || !isCurrent()) return;
      editorGeneration.current += 1;
      confirmation.current = null;
      const timezone = draft?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      setPanel((current) => ({
        ...current,
        open: true,
        error: null,
        dueAt: draft?.localDueAt ?? toDateTimeLocalValue(new Date(Date.now() + 10 * 60_000)),
        delayMs: draft?.delayMs,
        timezone,
        message: draft?.message ?? "",
        notificationRuleId: "",
        cancelOnNextReply: false,
      }));
    },
    [enabled, isCurrent, selectedSessionId, setPanel],
  );

  const beginMutation = useCallback(() => {
    if (!enabled || !selectedSessionId || !isCurrent() || pendingScopes.current.has(scope)) return undefined;
    pendingScopes.current.add(scope);
    const editor = editorGeneration.current;
    return {
      current: () => isCurrent() && editorGeneration.current === editor,
      finish: () => {
        pendingScopes.current.delete(scope);
        if (mounted.current) refreshPending((value) => value + 1);
      },
    };
  }, [enabled, isCurrent, scope, selectedSessionId]);

  const submit = useCallback(async () => {
    if (!selectedSessionId || !panel.open) return;
    const operation = beginMutation();
    if (!operation) return;
    setPanel((current) => ({ ...current, busy: true, error: null }));
    try {
      const timezone = panel.timezone.trim(),
        message = panel.message.trim(),
        notificationRuleId = panel.notificationRuleId.trim();
      const deliveryRule = notificationRuleId || null;
      const identity = JSON.stringify([
        scope,
        panel.delayMs,
        panel.dueAt,
        timezone,
        message,
        deliveryRule,
        panel.cancelOnNextReply,
      ]);
      if (confirmation.current?.identity !== identity) {
        if (!message) throw new Error("Enter a reminder message.");
        if (message.length > MAX_REMINDER_LENGTH)
          throw new Error(
            `Shorten the reminder to ${MAX_REMINDER_LENGTH.toLocaleString("en")} characters or fewer (it has ${message.length.toLocaleString("en")}).`,
          );
        if (deliveryRule && !panel.rules.some((rule) => rule.ruleId === deliveryRule))
          throw new Error("That destination is unavailable. Choose a ready notification rule or This Chat.");
        new Intl.DateTimeFormat("en", { timeZone: timezone });
        const dueAt = panel.delayMs
          ? new Date(Date.now() + panel.delayMs).toISOString()
          : zonedDateTimeToIso(panel.dueAt, timezone);
        confirmation.current = { identity, dueAt, key: createAttemptKey() };
      }
      const { dueAt, key } = confirmation.current;
      const result = await createChatTimer(
        selectedSessionId,
        {
          dueAt,
          timezone,
          message,
          notificationRuleId: deliveryRule,
          cancelOnNextReply: panel.cancelOnNextReply,
        },
        key,
      );
      if (!operation.current()) return;
      if (!matchesOwner(result.item)) throw new Error("The Gateway returned a timer for a different Chat scope.");
      if (
        Date.parse(result.item.dueAt) !== Date.parse(dueAt) ||
        result.item.timezone !== timezone ||
        result.item.message !== message ||
        result.item.cancelOnNextReply !== panel.cancelOnNextReply ||
        result.item.notificationRuleId !== deliveryRule
      ) {
        throw new Error("The Gateway did not confirm the reviewed timer. Refresh session timers before trying again.");
      }
      setPanel((current) => ({ ...current, busy: false, open: false }));
      pushLocalNotice(
        result.item.status === "active"
          ? "Reminder saved. The Gateway will post it in this Chat when due."
          : `Reminder saved. ${describeChatTimerStatus(result.item)}.`,
        "success",
      );
    } catch (error) {
      if (!operation.current()) return;
      setPanel((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "Unable to create Chat timer.",
      }));
    } finally {
      operation.finish();
    }
  }, [beginMutation, matchesOwner, panel, pushLocalNotice, scope, selectedSessionId, setPanel]);

  const cancel = useCallback(
    async (timerId: string, revision: number) => {
      if (
        !selectedSessionId ||
        !panel.open ||
        !panel.timers.some(
          (timer) =>
            matchesOwner(timer) &&
            timer.timerId === timerId &&
            timer.revision === revision &&
            timer.status === "active",
        )
      )
        return;
      const operation = beginMutation();
      if (!operation) return;
      setPanel((current) => ({ ...current, busy: true, error: null }));
      try {
        const result = await cancelChatTimer(selectedSessionId, timerId, revision);
        if (!operation.current()) return;
        if (
          !matchesOwner(result.item) ||
          result.item.timerId !== timerId ||
          result.item.revision <= revision ||
          result.item.status !== "cancelled"
        )
          throw new Error("The Gateway did not confirm this timer cancellation. Refresh session timers.");
        await refresh();
        if (!operation.current()) return;
        setPanel((current) => ({ ...current, busy: false }));
      } catch (error) {
        if (!operation.current()) return;
        setPanel((current) => ({
          ...current,
          busy: false,
          error: error instanceof Error ? error.message : "Unable to cancel Chat timer.",
        }));
      } finally {
        operation.finish();
      }
    },
    [beginMutation, matchesOwner, panel.open, panel.timers, refresh, selectedSessionId, setPanel],
  );

  useEffect(() => {
    if (panel.open && enabled) void refresh();
  }, [panel.open, enabled, eventStreamState, refresh, thread]);

  const busy = pendingScopes.current.has(scope);
  const chatTimerPanel = useMemo(
    () =>
      enabled
        ? {
            ...panel,
            busy,
            onDueAtChange: (value: string) => setPanel((current) => ({ ...current, dueAt: value, delayMs: undefined })),
            onTimezoneChange: (value: string) => setPanel((current) => ({ ...current, timezone: value })),
            onMessageChange: (value: string) => setPanel((current) => ({ ...current, message: value })),
            onNotificationRuleChange: (value: string) =>
              setPanel((current) => ({ ...current, notificationRuleId: value })),
            onCancelOnNextReplyChange: (value: boolean) =>
              setPanel((current) => ({ ...current, cancelOnNextReply: value })),
            onCreate: () => void submit(),
            onCancelTimer: (timerId: string, revision: number) => void cancel(timerId, revision),
            onClose: () => {
              if (!isCurrent()) return;
              editorGeneration.current += 1;
              readTicket.current += 1;
              setPanel((current) => ({ ...current, open: false }));
            },
          }
        : undefined,
    [busy, cancel, enabled, isCurrent, panel, setPanel, submit],
  );
  return { openChatTimerPanel: open, chatTimerPanel };
}
