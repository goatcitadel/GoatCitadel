import type { CheckContext, CheckDef } from "../runner/types";
import type { TargetInfo } from "../gateway-target/detect-target";

export const SANDBOX_TARGET: TargetInfo = {
  kind: "sandbox",
  requested: "sandbox",
  origin: "http://127.0.0.1:41873",
  sandboxVerified: true,
  rootDir: "/tmp/goatcitadel-usability-testbench",
  reason: undefined,
};

export const REAL_TARGET: TargetInfo = {
  kind: "real",
  requested: "real",
  origin: "http://127.0.0.1:8787",
  sandboxVerified: false,
  rootDir: undefined,
  reason: undefined,
};

export interface RecordedStep {
  readonly title: string;
  readonly status: "pass" | "fail";
}

export interface RecordedContext extends CheckContext {
  readonly steps: RecordedStep[];
  readonly messages: string[];
}

export interface TestContextOverrides {
  readonly target?: TargetInfo;
  readonly workspaceId?: string | undefined;
  readonly signal?: AbortSignal;
}

export function makeTestContext(overrides: TestContextOverrides = {}): RecordedContext {
  const steps: RecordedStep[] = [];
  const messages: string[] = [];
  return {
    target: overrides.target ?? SANDBOX_TARGET,
    workspaceId: "workspaceId" in overrides ? overrides.workspaceId : "ws-testbench",
    signal: overrides.signal ?? new AbortController().signal,
    steps,
    messages,
    log(message: string) {
      messages.push(message);
    },
    async step<T>(title: string, run: () => Promise<T>): Promise<T> {
      try {
        const value = await run();
        steps.push({ title, status: "pass" });
        return value;
      } catch (error) {
        steps.push({ title, status: "fail" });
        throw error;
      }
    },
  };
}

export function findCheck(checks: readonly CheckDef[], id: string): CheckDef {
  const found = checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(`No check with id ${id}.`);
  }
  return found;
}
