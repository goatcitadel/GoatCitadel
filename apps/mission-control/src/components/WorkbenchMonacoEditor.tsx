import { useEffect, useState } from "react";

interface WorkbenchMonacoEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  height?: number | string;
  onChange?: (value: string) => void;
  className?: string;
}

function shouldRenderMonaco(): boolean {
  return typeof window !== "undefined" && import.meta.env.MODE !== "test";
}

function resolveMonacoTheme(): "vs" | "vs-dark" {
  if (typeof document === "undefined") {
    return "vs-dark";
  }
  return document.querySelector(".theme-citadel-light") ? "vs" : "vs-dark";
}

function normalizeMonacoLanguage(language?: string): string {
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
      return "json";
    case "css":
    case "html":
    case "yaml":
    case "xml":
    case "diff":
      return normalized;
    default:
      return "plaintext";
  }
}

export function WorkbenchMonacoEditor({
  value,
  language,
  readOnly = false,
  height = "100%",
  onChange,
  className,
}: WorkbenchMonacoEditorProps) {
  type MonacoEditorComponent = typeof import("@uiw/react-monacoeditor").default;
  const theme = resolveMonacoTheme();
  const resolvedLanguage = normalizeMonacoLanguage(language);
  const [editorComponent, setEditorComponent] = useState<MonacoEditorComponent | null>(null);

  useEffect(() => {
    if (!shouldRenderMonaco()) {
      return;
    }
    void import("@uiw/react-monacoeditor").then((module) => {
      setEditorComponent(() => module.default);
    });
  }, []);

  if (!shouldRenderMonaco()) {
    if (readOnly) {
      return <pre className={className}>{value}</pre>;
    }
    return (
      <textarea
        className={className}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        spellCheck={false}
        style={{ minHeight: typeof height === "number" ? `${height}px` : height }}
      />
    );
  }

  if (!editorComponent) {
    return <div className={className} style={{ minHeight: typeof height === "number" ? `${height}px` : height }} />;
  }

  const MonacoEditor = editorComponent;

  return (
    <MonacoEditor
      className={className}
      value={value}
      language={resolvedLanguage}
      theme={theme}
      height={height}
      options={{
        automaticLayout: true,
        glyphMargin: false,
        lineNumbers: "on",
        minimap: { enabled: false },
        padding: { top: 14, bottom: 14 },
        readOnly,
        renderLineHighlight: readOnly ? "none" : "line",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: resolvedLanguage === "diff" ? "off" : "on",
      }}
      onChange={(nextValue) => onChange?.(nextValue)}
    />
  );
}
