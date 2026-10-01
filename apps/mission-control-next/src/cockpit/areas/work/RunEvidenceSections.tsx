import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";
import { recordedCostLabel } from "../chat/recorded-cost";

function tone(status: string): "running" | "waiting" | "done" | "failed" | "neutral" {
  if (["running", "started", "executing"].includes(status)) return "running";
  if (["waiting", "blocked", "paused", "approval_required"].includes(status)) return "waiting";
  if (["completed", "done", "executed"].includes(status)) return "done";
  if (["failed", "partial", "dead_lettered"].includes(status)) return "failed";
  return "neutral";
}

function EvidenceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border border-line bg-raised p-4"><h2 className="font-display text-lg font-semibold text-fg">{title}</h2><div className="mt-3">{children}</div></section>;
}

export function RunEvidenceSections({ trace }: { trace: ObserveRunTraceResponse }) {
  const lifecycle = trace.lifecycle.response;
  const plans = lifecycle?.executionPlans ?? [];
  const delegations = lifecycle?.delegationRuns ?? [];
  const steps = lifecycle?.delegationSteps ?? [];
  return <>
    <EvidenceSection title="Plan and steps">
      {trace.lifecycle.state !== "available" ? <p className="text-sm text-fg-muted">Plan evidence is {humanizeToken(trace.lifecycle.state).toLowerCase()}.</p>
        : plans.length ? <ol className="grid gap-3">{plans.map((plan) => <li key={plan.planId} className="rounded-md border border-line-subtle p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-fg">{plan.objective}</p><StatusBadge status={{ label: humanizeToken(plan.status), tone: tone(plan.status) }} /></div>
          {plan.summary ? <p className="mt-1 text-sm text-fg-secondary">{plan.summary}</p> : null}
          {plan.steps.length ? <ol className="mt-3 grid gap-2">{plan.steps.map((step) => <li key={step.stepId} className="flex flex-wrap items-start justify-between gap-2 border-t border-line-subtle pt-2 text-sm">
            <span className="min-w-0 text-fg-secondary">{step.index + 1}. {step.objective}{step.delegatedRole ? ` · ${step.delegatedRole}` : ""}</span>
            <StatusBadge status={{ label: humanizeToken(step.status), tone: tone(step.status) }} />
          </li>)}</ol> : <p className="mt-2 text-xs text-fg-muted">No plan steps were recorded.</p>}
        </li>)}</ol> : <p className="text-sm text-fg-muted">No execution plan was linked to this run.</p>}
    </EvidenceSection>
    <EvidenceSection title="Delegation">
      {trace.lifecycle.state !== "available" ? <p className="text-sm text-fg-muted">Delegation evidence is {humanizeToken(trace.lifecycle.state).toLowerCase()}.</p>
        : delegations.length ? <ol className="grid gap-3">{delegations.map((run) => <li key={run.runId} className="rounded-md border border-line-subtle p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-fg">{run.objective}</p><StatusBadge status={{ label: humanizeToken(run.status), tone: tone(run.status) }} /></div>
          <p className="mt-1 text-xs text-fg-muted">{run.roles.join(" → ") || "Roles not recorded"}</p>
          {steps.filter((step) => step.runId === run.runId).length ? <ol className="mt-3 grid gap-2">{steps.filter((step) => step.runId === run.runId).map((step) => <li key={step.stepId} className="border-t border-line-subtle pt-2 text-sm">
            <div className="flex justify-between gap-2"><span className="font-medium text-fg">{step.role}</span><StatusBadge status={{ label: humanizeToken(step.status), tone: tone(step.status) }} /></div>
            {step.summary ? <p className="mt-1 text-fg-secondary">{step.summary}</p> : null}
            {step.error ? <p className="mt-1 text-status-failed">{step.error}</p> : null}
            {step.durableRunId ? <NativeOwnerLink scope={[trace.runId, step.stepId, step.durableRunId]} className="mt-1 inline-block text-accent hover:underline" href={`/work/runs/${encodeURIComponent(step.durableRunId)}`}>Open child run evidence</NativeOwnerLink> : null}
          </li>)}</ol> : <p className="mt-2 text-xs text-fg-muted">No delegated steps were linked.</p>}
        </li>)}</ol> : <p className="text-sm text-fg-muted">No delegation run was linked to this run.</p>}
    </EvidenceSection>
    <EvidenceSection title="Tool activity">
      {trace.toolCalls.state !== "available" ? <p className="text-sm text-fg-muted">Tool evidence is {humanizeToken(trace.toolCalls.state).toLowerCase()}.</p>
        : trace.toolCalls.items.length ? <ol className="grid gap-2">{trace.toolCalls.items.map((tool) => <li key={tool.toolRunId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-subtle p-3 text-sm">
          <span className="min-w-0 text-fg">{tool.toolName}{tool.reused ? " · Reused" : ""}</span><StatusBadge status={{ label: humanizeToken(tool.status), tone: tone(tool.status) }} />
        </li>)}</ol> : <p className="text-sm text-fg-muted">No tool calls were linked to this run.</p>}
    </EvidenceSection>
    <EvidenceSection title="Model usage">
      {trace.providerUsage.state !== "available" ? <p className="text-sm text-fg-muted">Model usage is {humanizeToken(trace.providerUsage.state).toLowerCase()}.</p>
        : trace.providerUsage.items.length ? <ol className="grid gap-2">{trace.providerUsage.items.map((item) => <li key={item.turnId} className="rounded-md border border-line-subtle p-3 text-sm">
          <p className="font-medium text-fg">{[item.providerId, item.model].filter(Boolean).join(" · ") || "Model not recorded"}</p>
          <p className="mt-1 text-xs text-fg-muted">{item.usage?.inputTokens ?? "Unknown"} input tokens · {item.usage?.outputTokens ?? "Unknown"} output tokens · Cost {recordedCostLabel(item.costUsd, item.usage?.costSource)}</p>
        </li>)}</ol> : <p className="text-sm text-fg-muted">No model usage was linked to this run.</p>}
    </EvidenceSection>
  </>;
}
