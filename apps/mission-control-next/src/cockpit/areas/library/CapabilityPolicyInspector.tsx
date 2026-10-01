import { useEffect, useRef, useState } from "react";
import { humanizeToken, presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { inspectSelectedToolPolicy, loadPolicyInspectionOptions, parsePolicyArguments,
  type PolicyInspectionInput, type PolicyInspectionOptions, type PolicyInspectionResult } from "./capability-policy-inspection";

const FIELD = "mt-1 w-full rounded-md border border-line bg-raised px-2 py-2 text-base text-fg";
const bounded = (value: string, limit = 240) => value.length > limit ? `${value.slice(0, limit)}…` : value;
const TRUST: { value: NonNullable<PolicyInspectionInput["trustLevel"]>; label: string }[] = [
  { value: "trusted_operator", label: "Operator input" }, { value: "trusted_workspace", label: "Trusted workspace input" },
  { value: "mixed_untrusted", label: "Mixed trusted and untrusted input" }, { value: "untrusted_external", label: "Untrusted external input" },
];

export function CapabilityPolicyInspector({ workspaceId, toolName }: { workspaceId: string; toolName?: string }) {
  const [open, setOpen] = useState(false);
  if (!toolName) return <p className="text-xs text-fg-muted">Context evaluation is available for entries with a Gateway tool identity.</p>;
  return <section aria-label="Tool policy inspector" className="mt-3 space-y-3 rounded-md border border-line-subtle p-3">
    <h3 className="font-medium text-fg">Evaluate a selected tool context</h3>
    <p className="text-xs text-fg-muted">Gateway records an advisory decision for your selected context and arguments. This does not run the tool, create an approval, or grant access.</p>
    <Button size="sm" onClick={() => setOpen((value) => !value)}>{open ? "Close policy inspector" : "Inspect tool policy"}</Button>
    {open ? <PolicyForm key={JSON.stringify([workspaceId, toolName])} workspaceId={workspaceId} toolName={toolName} /> : null}
  </section>;
}

function PolicyForm({ workspaceId, toolName }: { workspaceId: string; toolName: string }) {
  const [options, setOptions] = useState<PolicyInspectionOptions>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [agentId, setAgentId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [surface, setSurface] = useState<PolicyInspectionInput["surface"]>("tools");
  const [trustLevel, setTrustLevel] = useState<NonNullable<PolicyInspectionInput["trustLevel"]>>("trusted_operator");
  const [preset, setPreset] = useState("omitted");
  const [customArgs, setCustomArgs] = useState("{}");
  const [result, setResult] = useState<PolicyInspectionResult>();
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const pendingRef = useRef(false);
  useEffect(() => {
    const requestRevision = ++revision.current;
    setOptions(undefined); setError(undefined); setLoading(true); setResult(undefined); setAgentId(""); setSessionId("");
    setPreset("omitted"); setCustomArgs("{}");
    void loadPolicyInspectionOptions(workspaceId, toolName).then((value) => {
      if (revision.current === requestRevision) setOptions(value);
    }).catch((cause: unknown) => {
      if (revision.current === requestRevision) setError(describeApiError(cause).summary);
    }).finally(() => { if (revision.current === requestRevision) setLoading(false); });
    return () => { revision.current += 1; };
  }, [workspaceId, toolName, reload]);
  function invalidate() { revision.current += 1; setResult(undefined); setError(undefined); }
  const examples = options?.tool.examples.slice(0, 10) ?? [];
  function selectedArguments() {
    if (preset === "omitted") return undefined;
    if (preset === "custom") return parsePolicyArguments(customArgs);
    const example = examples[Number(preset)];
    if (!example) throw new Error("The selected argument example is no longer available.");
    return parsePolicyArguments(JSON.stringify(example.args));
  }
  async function evaluate() {
    if (pendingRef.current || !options || !options.agents.some((agent) => agent.agentId === agentId)
      || !options.sessions.some((session) => session.sessionId === sessionId)) return;
    invalidate();
    const requestRevision = revision.current;
    try {
      const args = selectedArguments();
      pendingRef.current = true; setPending(true);
      const value = await inspectSelectedToolPolicy({ toolName, workspaceId, agentId, sessionId, surface, trustLevel,
        ...(args === undefined ? {} : { args }) }, () => revision.current === requestRevision);
      if (revision.current === requestRevision) setResult(value);
    } catch (cause) {
      if (revision.current === requestRevision) setError(describeApiError(cause).summary);
    } finally { pendingRef.current = false; setPending(false); }
  }
  const selectedExample = preset !== "omitted" && preset !== "custom" ? examples[Number(preset)] : undefined;
  return <div className="space-y-3">
    {loading ? <p role="status">Loading current tool and context choices…</p> : null}
    {error ? <p role="alert" className="break-words text-sm text-status-failed">{bounded(error, 600)}</p> : null}
    <Button size="sm" disabled={loading || pending} onClick={() => { invalidate(); setReload((value) => value + 1); }}>Refresh context choices</Button>
    {options ? <>
      <p className="break-all text-xs text-fg-muted">Tool: {bounded(toolName)} · Workspace: {bounded(workspaceId)}</p>
      <label className="block text-xs text-fg-muted">Agent
        <select className={FIELD} value={agentId} onChange={(event) => { invalidate(); setAgentId(event.target.value); }}>
          <option value="">Choose an active agent</option>
          {options.agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{bounded(agent.name, 80)} · {bounded(agent.agentId, 80)}</option>)}
        </select>
      </label>
      <label className="block text-xs text-fg-muted">Conversation
        <select className={FIELD} value={sessionId} onChange={(event) => { invalidate(); setSessionId(event.target.value); }}>
          <option value="">Choose a conversation in this workspace</option>
          {options.sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{bounded(session.title ?? "Untitled conversation", 80)} · {bounded(session.sessionId, 80)}</option>)}
        </select>
      </label>
      {!options.agents.length || !options.sessions.length ? <p className="text-xs">A real active agent and workspace conversation are required. No replacement identities will be created.</p> : null}
      {options.agentsPartial || options.sessionsPartial ? <p className="text-xs text-fg-muted">Showing up to 50 active agents and 50 current conversations. Additional choices may be outside this sample.</p> : null}
      <label className="block text-xs text-fg-muted">Policy surface
        <select className={FIELD} value={surface} onChange={(event) => { invalidate(); setSurface(event.target.value as PolicyInspectionInput["surface"]); }}><option value="tools">Tools</option><option value="chat">Chat</option></select>
      </label>
      <label className="block text-xs text-fg-muted">Input trust
        <select className={FIELD} value={trustLevel} onChange={(event) => { invalidate(); setTrustLevel(event.target.value as typeof trustLevel); }}>{TRUST.map((trust) => <option key={trust.value} value={trust.value}>{trust.label}</option>)}</select>
      </label>
      <p className="text-xs text-fg-muted">Uses the signed-in operator and Gateway-selected profile and override. No task, run, or source attribution is supplied. The chosen agent is a proposed actor for this check.</p>
      <label className="block text-xs text-fg-muted">Arguments to evaluate
        <select className={FIELD} value={preset} onChange={(event) => { invalidate(); setPreset(event.target.value); }}>
          <option value="omitted">Omit arguments</option>
          {examples.map((example, index) => <option key={index} value={String(index)}>Example: {bounded(example.title, 100)}</option>)}
          <option value="custom">Advanced: custom argument object</option>
        </select>
      </label>
      {preset === "omitted" ? <p className="text-xs text-fg-muted">Arguments are omitted. Path, host, and other argument-dependent restrictions may need a concrete example.</p> : null}
      {selectedExample ? <ArgumentSummary args={selectedExample.args} /> : null}
      {preset === "custom" ? <label className="block text-xs text-fg-muted">Exact argument object (JSON, up to 16 KiB)
        <textarea className={`${FIELD} min-h-28 font-mono text-sm`} value={customArgs} maxLength={16 * 1024} spellCheck={false}
          onChange={(event) => { invalidate(); setCustomArgs(event.target.value); }} />
      </label> : null}
      <p className="text-xs text-fg-muted">Checks policy for these inputs. It does not validate tool arguments or guarantee later execution. Keep secrets out of inspection arguments.</p>
      <Button size="sm" disabled={pending || !agentId || !sessionId} onClick={() => void evaluate()}>{pending ? "Evaluating policy…" : "Evaluate selected context"}</Button>
      {pending ? <p role="status" className="text-xs text-fg-muted">Reading current context and recording an advisory decision…</p> : null}
      {result ? <PolicyResult value={result} /> : null}
    </> : null}
  </div>;
}

function ArgumentSummary({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args);
  return <div className="rounded-md bg-sunken p-2 text-xs">
    <p className="font-medium text-fg">Exact catalog example · {entries.length} argument fields</p>
    <dl className="mt-2 grid gap-2">{entries.slice(0, 12).map(([key, value]) => <div key={key}>
      <dt className="break-all font-medium">{bounded(key, 100)}</dt>
      <dd className="whitespace-pre-wrap break-words text-fg-muted">{typeof value === "string" ? bounded(value)
        : Array.isArray(value) ? `${value.length} array items` : value && typeof value === "object" ? `${Object.keys(value).length} nested fields` : String(value)}</dd>
    </div>)}</dl>
    {entries.length > 12 ? <p>{entries.length - 12} further fields are included unchanged.</p> : null}
  </div>;
}

function PolicyResult({ value }: { value: PolicyInspectionResult }) {
  const { decision } = value;
  const label = decision.requiresApproval ? "Approval would be required" : decision.allowed ? "Allowed by this evaluation" : "Blocked by this evaluation";
  return <section aria-label="Advisory policy result" className="space-y-2 rounded-md border border-line bg-sunken p-3">
    <p className="font-medium text-fg">{label}</p>
    <StatusBadge status={presentRiskLevel(decision.riskLevel)} />
    <p className="text-xs">Profile: {bounded(value.profileLabel)}</p>
    <p className="text-xs">{decision.localOperatorOverrideId ? "A local operator override was applied." : "No local operator override was reported."}</p>
    {decision.matchedGrantId ? <p className="break-all text-xs">Matched grant: {bounded(decision.matchedGrantId)}</p> : null}
    {decision.wardEffect ? <p className="text-xs">Ward effect: {bounded(humanizeToken(decision.wardEffect))}</p> : null}
    {decision.reasonCodes.length ? <ul className="list-disc space-y-1 pl-4 text-xs">{decision.reasonCodes.slice(0, 12).map((reason, index) => <li className="break-words" key={index}>{bounded(humanizeToken(reason))}</li>)}</ul> : <p className="text-xs">No reason codes were returned.</p>}
    {decision.reasonCodes.length > 12 ? <p className="text-xs">{decision.reasonCodes.length - 12} further reason codes were returned.</p> : null}
    <p className="text-xs text-fg-muted">Recorded advisory snapshot at <time dateTime={value.checkedAt}>{value.checkedAt}</time>. Re-evaluate after context or policy changes.</p>
  </section>;
}
