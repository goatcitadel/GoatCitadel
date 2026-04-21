import { useEffect, useRef } from "react";
import type { editor as MonacoEditorNamespace } from "monaco-editor";

interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  language?: string;
  height?: number | string;
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
  if (!normalized) {
    return "plaintext";
  }
  if (normalized === "js" || normalized === "jsx") {
    return "javascript";
  }
  if (normalized === "ts" || normalized === "tsx") {
    return "typescript";
  }
  return normalized;
}

export function MonacoDiffEditor({ original, modified, language, height = "100%", className }: MonacoDiffEditorProps) {
  type MonacoModule = typeof import("monaco-editor");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const editorRef = useRef<MonacoEditorNamespace.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<MonacoEditorNamespace.ITextModel | null>(null);
  const modifiedModelRef = useRef<MonacoEditorNamespace.ITextModel | null>(null);

  useEffect(() => {
    if (!shouldRenderMonaco() || !containerRef.current) {
      return undefined;
    }
    let disposed = false;

    void import("monaco-editor").then((monaco) => {
      if (disposed || !containerRef.current) {
        return;
      }
      monacoRef.current = monaco;
      monaco.editor.setTheme(resolveMonacoTheme());
      editorRef.current = monaco.editor.createDiffEditor(containerRef.current, {
        automaticLayout: true,
        glyphMargin: false,
        lineNumbers: "on",
        minimap: { enabled: false },
        readOnly: true,
        renderSideBySide: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
      });
    });

    return () => {
      disposed = true;
      originalModelRef.current?.dispose();
      modifiedModelRef.current?.dispose();
      editorRef.current?.dispose();
      originalModelRef.current = null;
      modifiedModelRef.current = null;
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!shouldRenderMonaco() || !editorRef.current || !monaco) {
      return;
    }
    originalModelRef.current?.dispose();
    modifiedModelRef.current?.dispose();
    originalModelRef.current = monaco.editor.createModel(original, normalizeMonacoLanguage(language));
    modifiedModelRef.current = monaco.editor.createModel(modified, normalizeMonacoLanguage(language));
    editorRef.current.setModel({
      original: originalModelRef.current,
      modified: modifiedModelRef.current,
    });
    monaco.editor.setTheme(resolveMonacoTheme());
  }, [language, modified, original]);

  if (!shouldRenderMonaco()) {
    return (
      <div className={className}>
        <pre>{original}</pre>
        <pre>{modified}</pre>
      </div>
    );
  }

  return <div ref={containerRef} className={className} style={{ height }} />;
}
