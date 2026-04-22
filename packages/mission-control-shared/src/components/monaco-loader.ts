import loader from "@monaco-editor/loader";
import type * as Monaco from "monaco-editor";

export type MonacoEditorApiModule = typeof Monaco;

const MONACO_PUBLIC_BASE = "/vendor/monaco/vs";

const loadedLanguages = new Set<string>();
const inFlightLanguageLoads = new Map<string, Promise<void>>();
let monacoRuntimePromise: Promise<MonacoEditorApiModule> | null = null;
let monacoLoaderConfigured = false;

export function normalizeMonacoLoaderLanguage(language?: string): string {
  const normalized = language?.trim().toLowerCase();
  switch (normalized) {
    case "js":
    case "jsx":
    case "javascript":
      return "javascript";
    case "ts":
    case "tsx":
    case "typescript":
      return "typescript";
    case "shell":
    case "bash":
    case "zsh":
      return "shell";
    case "md":
    case "markdown":
      return "markdown";
    case "json":
    case "css":
    case "html":
    case "yaml":
    case "xml":
      return normalized;
    default:
      return "plaintext";
  }
}

export async function loadMonacoEditorRuntime(language?: string): Promise<MonacoEditorApiModule> {
  const normalizedLanguage = normalizeMonacoLoaderLanguage(language);
  monacoRuntimePromise ??= loadMonacoRuntime();
  await Promise.all([monacoRuntimePromise, ensureLanguageContribution(normalizedLanguage)]);
  return monacoRuntimePromise;
}

async function loadMonacoRuntime(): Promise<MonacoEditorApiModule> {
  if (typeof window === "undefined") {
    throw new Error("Monaco runtime is only available in the browser.");
  }
  if (!monacoLoaderConfigured) {
    loader.config({
      paths: {
        vs: MONACO_PUBLIC_BASE,
      },
    });
    monacoLoaderConfigured = true;
  }
  return (await loader.init()) as MonacoEditorApiModule;
}

async function ensureLanguageContribution(language: string): Promise<void> {
  if (language === "plaintext" || loadedLanguages.has(language)) {
    return;
  }

  const existingLoad = inFlightLanguageLoads.get(language);
  if (existingLoad) {
    await existingLoad;
    return;
  }

  const loadPromise = Promise.resolve().then(() => {
    loadedLanguages.add(language);
  });
  inFlightLanguageLoads.set(language, loadPromise);

  try {
    await loadPromise;
  } finally {
    inFlightLanguageLoads.delete(language);
  }
}
