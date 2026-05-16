import { randomUUID } from "node:crypto";
import type { TaskDistressSignal, TaskDistressSignalCode, TaskDistressSeverity } from "@goatcitadel/contracts";

export interface EmitDistressInput {
  code: TaskDistressSignalCode;
  severity: TaskDistressSeverity;
  title: string;
  summary: string;
  emittedBy?: string;
  evidenceRef?: string;
  now?: () => string;
  idFactory?: () => string;
}

export function emitDistressSignal(
  current: TaskDistressSignal[] | undefined,
  input: EmitDistressInput,
): TaskDistressSignal[] {
  const signal: TaskDistressSignal = {
    signalId: input.idFactory ? input.idFactory() : randomUUID(),
    code: input.code,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    emittedBy: input.emittedBy,
    evidenceRef: input.evidenceRef,
    createdAt: input.now ? input.now() : new Date().toISOString(),
  };
  return [signal, ...(current ?? [])];
}

export interface ResolveDistressInput {
  resolvedBy?: string;
  now?: () => string;
}

export function resolveDistressSignal(
  current: TaskDistressSignal[] | undefined,
  signalId: string,
  input: ResolveDistressInput = {},
): TaskDistressSignal[] {
  const list = current ?? [];
  const at = input.now ? input.now() : new Date().toISOString();
  return list.map((signal) =>
    signal.signalId === signalId && !signal.resolvedAt
      ? { ...signal, resolvedAt: at, resolvedBy: input.resolvedBy }
      : signal,
  );
}

export interface DistressSummary {
  info: number;
  warn: number;
  critical: number;
  resolvedCount: number;
}

export function summarizeDistress(signals: TaskDistressSignal[] | undefined): DistressSummary {
  const summary: DistressSummary = { info: 0, warn: 0, critical: 0, resolvedCount: 0 };
  for (const signal of signals ?? []) {
    if (signal.resolvedAt) {
      summary.resolvedCount += 1;
      continue;
    }
    const severity = signal.severity as keyof Omit<DistressSummary, "resolvedCount">;
    summary[severity] += 1;
  }
  return summary;
}
