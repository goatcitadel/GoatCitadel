import { useMemo, useRef, useState, type FormEvent } from "react";
import type { FollowThroughSetupDraft, FollowThroughSetupResponse } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { ScheduleTiming } from "../work/ScheduleTiming";
import {
  browserTimeZone,
  defaultScheduleExpression,
  formatInZone,
  scheduleCadence,
  scheduleZoneOptions,
} from "../work/schedule-cadence";
import { resolveFollowThroughLocalTime } from "./follow-through-timing";
export type ReviewedFollowThroughSetup = { sourceHash: string; draft: FollowThroughSetupDraft };
const inputStyle = "w-full min-w-0 rounded-md border border-line-control bg-canvas p-2 text-fg";
export function ChatFollowThroughSetupForm({
  setup,
  pending = false,
  uncertain = false,
  error,
  onCreate,
  onClose,
  onRefresh,
}: {
  setup: FollowThroughSetupResponse;
  pending?: boolean;
  uncertain?: boolean;
  error?: string;
  onCreate: (input: ReviewedFollowThroughSetup) => Promise<void>;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const [purpose, setPurpose] = useState(""),
    [kind, setKind] = useState<"recurring" | "once" | "event">("recurring"),
    [schedule, setSchedule] = useState(defaultScheduleExpression),
    [timezone, setTimezone] = useState(browserTimeZone),
    [localTime, setLocalTime] = useState(""),
    [fold, setFold] = useState(""),
    [hookId, setHookId] = useState(setup.eventSources[0]?.hookId ?? ""),
    [profileId, setProfileId] = useState(setup.profiles[0]?.profileId ?? ""),
    [review, setReview] = useState<ReviewedFollowThroughSetup>(),
    [validation, setValidation] = useState<string>();
  const confirmLock = useRef(false),
    blocked = setup.blockedReasons.length > 0 || setup.profiles.length === 0,
    locked = pending || uncertain;
  const instants = useMemo(() => {
    if (!localTime) return { values: [] as string[] };
    try {
      return { values: resolveFollowThroughLocalTime(localTime, timezone) };
    } catch (cause) {
      return { values: [] as string[], error: cause instanceof Error ? cause.message : "Choose a valid time." };
    }
  }, [localTime, timezone]);
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (locked || blocked) return;
    setValidation(undefined);
    try {
      const text = purpose.normalize("NFKC").trim();
      if (!text || !profileId) throw new Error("Add a purpose and choose the permissions to review.");
      if (kind === "once" && (instants.error || !instants.values.length))
        throw new Error(instants.error ?? "That wall-clock time does not exist in this timezone. Choose another time.");
      if (kind === "once" && instants.values.length > 1 && !fold)
        throw new Error("This time occurs twice. Choose the occurrence you want.");
      if (kind === "event" && !setup.eventSources.some((source) => source.hookId === hookId))
        throw new Error("Choose an enabled subagent completion observer in this workspace.");
      if (kind === "event" && !setup.quietHours?.timezone)
        throw new Error("Refresh the conversation's active hours before reviewing an event wake.");
      const trigger =
        kind === "recurring"
          ? { kind, schedule }
          : kind === "once"
            ? { kind, at: instants.values[Number(fold || 0)]!, timezone }
            : { kind, hookId, notBefore: new Date().toISOString(), timezone: setup.quietHours!.timezone };
      setReview({
        sourceHash: setup.sourceHash,
        draft: { purpose: text, permissionProfileId: profileId, trigger, delivery: { kind: "conversation" } },
      });
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : "Review the missing schedule details.");
    }
  }
  async function confirm() {
    if (!review || confirmLock.current || pending || blocked || review.sourceHash !== setup.sourceHash) return;
    confirmLock.current = true;
    try {
      await onCreate(review);
    } finally {
      confirmLock.current = false;
    }
  }
  const profile = setup.profiles.find((item) => item.profileId === (review?.draft.permissionProfileId ?? profileId)),
    stale = Boolean(review && review.sourceHash !== setup.sourceHash);
  return (
    <section className="grid min-w-0 gap-3 border-t border-line-subtle pt-3 text-sm" aria-label="Set up follow-through">
      <h3 className="font-semibold text-fg">Set up follow-through</h3>
      {setup.blockedReasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      {!setup.profiles.length ? (
        <p>No current permission profile is available. Review your access before creating agentic work.</p>
      ) : null}
      {validation || error || uncertain ? (
        <div role="alert">
          {validation || error ? <p>{validation ?? error}</p> : null}
          {uncertain ? (
            <p>
              GoatCitadel could not confirm creation. Keep this request while you check the saved schedule. Retrying
              sends the same request.
            </p>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <>
          <dl className="grid min-w-0 gap-2 break-words">
            <div>
              <dt className="font-medium">Purpose</dt>
              <dd className="whitespace-pre-wrap">{review.draft.purpose}</dd>
            </div>
            <div>
              <dt className="font-medium">When</dt>
              <dd>
                {review.draft.trigger.kind === "recurring"
                  ? scheduleCadence(review.draft.trigger.schedule)
                  : review.draft.trigger.kind === "once"
                    ? `${formatInZone(new Date(review.draft.trigger.at), review.draft.trigger.timezone)} · ${review.draft.trigger.timezone}`
                    : `When a verified subagent completes · ${setup.eventSources.find((source) => source.hookId === (review.draft.trigger.kind === "event" ? review.draft.trigger.hookId : ""))?.label ?? "Observer unavailable"}`}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Reports to</dt>
              <dd>This conversation, when attention is needed or a result changes.</dd>
            </div>
            <div>
              <dt className="font-medium">Permissions</dt>
              <dd>
                {profile?.label ?? "Profile unavailable"}. Scheduled restrictions and required approvals apply. A
                changed profile needs fresh review.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Cost and token limits</dt>
              <dd>
                Shared installation limit: ${setup.limits.dailyUsdHardCap} per day;{" "}
                {setup.limits.sessionTokenHardCap.toLocaleString()} tokens per conversation. This does not reserve a
                separate allowance for this schedule.
              </dd>
            </div>
          </dl>
          {stale ? <p>Setup or limits changed after review. Review the current details before creating work.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              data-follow-through-confirm
              disabled={blocked || stale || pending}
              loading={pending}
              loadingLabel="Creating follow-through…"
              onClick={() => void confirm()}
            >
              {uncertain ? "Retry exact setup request" : "Create this follow-through"}
            </Button>
            <Button size="sm" disabled={locked} onClick={() => setReview(undefined)}>
              Edit details
            </Button>
          </div>
        </>
      ) : (
        <form className="grid min-w-0 gap-3" onSubmit={prepare}>
          <Field
            label="Purpose"
            required
            help="Describe the result to check. Keep credentials in their connection setup."
          >
            {(props) => (
              <textarea
                {...props}
                className={inputStyle}
                value={purpose}
                rows={3}
                maxLength={2000}
                disabled={locked || blocked}
                onChange={(event) => setPurpose(event.target.value)}
              />
            )}
          </Field>
          <Field label="Trigger">
            {(props) => (
              <select
                {...props}
                className={inputStyle}
                value={kind}
                disabled={locked || blocked}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="recurring">Recurring check</option>
                <option value="once">One check at a chosen time</option>
                <option value="event" disabled={!setup.eventSources.length}>
                  A verified subagent completes
                </option>
              </select>
            )}
          </Field>
          {kind === "recurring" ? (
            <ScheduleTiming value={schedule} disabled={locked || blocked} onChange={setSchedule} />
          ) : (
            <>
              {kind === "once" ? (
                <Field label="Timezone">
                  {(props) => (
                    <select
                      {...props}
                      className={inputStyle}
                      value={timezone}
                      disabled={locked || blocked}
                      onChange={(event) => {
                        setTimezone(event.target.value);
                        setFold("");
                      }}
                    >
                      {scheduleZoneOptions(timezone).map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
              {kind === "once" ? (
                <>
                  <Field label="Date and time" required>
                    {(props) => (
                      <input
                        {...props}
                        className={inputStyle}
                        type="datetime-local"
                        value={localTime}
                        disabled={locked || blocked}
                        onChange={(event) => {
                          setLocalTime(event.target.value);
                          setFold("");
                        }}
                      />
                    )}
                  </Field>
                  {instants.values.length > 1 ? (
                    <Field label="Which occurrence?" help="The clock repeats this time when daylight saving ends.">
                      {(props) => (
                        <select
                          {...props}
                          className={inputStyle}
                          value={fold}
                          disabled={locked}
                          onChange={(event) => setFold(event.target.value)}
                        >
                          <option value="">Choose an occurrence</option>
                          {instants.values.map((at, index) => (
                            <option key={at} value={String(index)}>
                              {index === 0 ? "First" : "Second"} · {at}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                  ) : null}
                </>
              ) : (
                <>
                  <Field label="Completion observer">
                    {(props) => (
                      <select
                        {...props}
                        className={inputStyle}
                        value={hookId}
                        disabled={locked || blocked}
                        onChange={(event) => setHookId(event.target.value)}
                      >
                        {setup.eventSources.map((source) => (
                          <option key={source.hookId} value={source.hookId}>
                            {source.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <p>
                    Only verified completions in this conversation can wake this job. Events during quiet hours wait
                    until the conversation is active.
                  </p>
                  <p>
                    Conversation active hours:{" "}
                    {setup.quietHours
                      ? `${String(setup.quietHours.start).padStart(2, "0")}:00–${String(setup.quietHours.end).padStart(2, "0")}:00 · ${setup.quietHours.timezone}${setup.quietHours.start === setup.quietHours.end ? " (always active)" : ""}`
                      : "Unavailable; refresh before reviewing."}
                    . Future changes to the conversation's hours apply to this event wake.
                  </p>
                </>
              )}
            </>
          )}
          <Field
            label="Permissions"
            help="Work uses scheduled restrictions intersected with this exact reviewed profile."
          >
            {(props) => (
              <select
                {...props}
                className={inputStyle}
                value={profileId}
                disabled={locked || blocked}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {setup.profiles.map((item) => (
                  <option key={item.profileId} value={item.profileId}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <p>
            Reports here only when a result changes or attention is needed. Uses the shared installation cost and token
            limits shown at review.
          </p>
          {!setup.eventSources.length ? (
            <p className="text-xs text-fg-muted">
              Event checks need an enabled subagent completion observer in Capabilities › Hooks.
            </p>
          ) : null}
          <Button size="sm" type="submit" variant="primary" disabled={locked || blocked || !purpose.trim()}>
            Review follow-through
          </Button>
        </form>
      )}
      <div className="flex flex-wrap gap-2">
        {onRefresh ? (
          <Button size="sm" disabled={pending} onClick={onRefresh}>
            Refresh setup
          </Button>
        ) : null}
        <Button size="sm" disabled={pending} onClick={onClose}>
          Close setup
        </Button>
      </div>
    </section>
  );
}
