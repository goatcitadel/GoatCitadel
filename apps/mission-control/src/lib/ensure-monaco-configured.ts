let monacoConfigurationPromise: Promise<void> | null = null;

type MonacoRuntimeGlobal = typeof globalThis & {
  MonacoEnvironment?: unknown;
};

export async function ensureMonacoConfigured(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  if ((globalThis as MonacoRuntimeGlobal).MonacoEnvironment) {
    return;
  }

  if (import.meta.env.MODE === "test") {
    return;
  }

  monacoConfigurationPromise ??= import("./configure-monaco").then(() => undefined);
  await monacoConfigurationPromise;
}
