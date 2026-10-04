export interface TestbenchEnv {
  readonly sandboxOrigin: string | undefined;
  readonly sandboxRoot: string | undefined;
  readonly realOrigin: string | undefined;
  readonly isProd: boolean;
}

export function readTestbenchEnv(
  env: Readonly<Record<string, unknown>> = import.meta.env as unknown as Readonly<Record<string, unknown>>,
): TestbenchEnv {
  return {
    sandboxOrigin: readNonEmpty(env.VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN),
    sandboxRoot: readNonEmpty(env.VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT),
    realOrigin: readNonEmpty(env.VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN),
    isProd: env.PROD === true,
  };
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
