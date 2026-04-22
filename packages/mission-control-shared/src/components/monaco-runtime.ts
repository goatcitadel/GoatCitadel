const MONACO_TEST_RUNTIME_FLAG = "__GOATCITADEL_ENABLE_MONACO_TEST_RUNTIME__";

type MonacoRuntimeGlobal = typeof globalThis & {
  [MONACO_TEST_RUNTIME_FLAG]?: boolean;
};

export function shouldRenderMonacoRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (import.meta.env.MODE !== "test") {
    return true;
  }
  return Boolean((globalThis as MonacoRuntimeGlobal)[MONACO_TEST_RUNTIME_FLAG]);
}

export function setMonacoTestRuntimeEnabled(enabled: boolean): void {
  if (import.meta.env.MODE !== "test") {
    return;
  }
  (globalThis as MonacoRuntimeGlobal)[MONACO_TEST_RUNTIME_FLAG] = enabled;
}
