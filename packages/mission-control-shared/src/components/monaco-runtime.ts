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

/** The active shell owns theme; retained Classic classes must not override Cockpit. */
export function resolveMonacoTheme(): "vs" | "vs-dark" {
  if (typeof document === "undefined") return "vs-dark";
  if (document.documentElement.dataset.shell === "cockpit")
    return document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark";
  return document.querySelector(".theme-citadel-light") ? "vs" : "vs-dark";
}

export function observeMonacoTheme(apply: (theme: "vs" | "vs-dark") => void): () => void {
  apply(resolveMonacoTheme());
  const observer = new MutationObserver(() => apply(resolveMonacoTheme()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-shell", "class"],
  });
  // Classic keeps its theme class on the application root.
  if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
