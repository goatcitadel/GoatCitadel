import { useEffect, useRef } from "react";
import type { editor as MonacoEditorNamespace } from "monaco-editor";
import { shouldRenderMonacoRuntime } from "./monaco-runtime";
import {
  loadMonacoEditorRuntime,
  normalizeMonacoLoaderLanguage,
  type MonacoEditorApiModule,
} from "./monaco-loader";

interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  language?: string;
  height?: number | string;
  className?: string;
}

function resolveMonacoTheme(): "vs" | "vs-dark" {
  if (typeof document === "undefined") {
    return "vs-dark";
  }
  return document.querySelector(".theme-citadel-light") ? "vs" : "vs-dark";
}

export function MonacoDiffEditor({ original, modified, language, height = "100%", className }: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<MonacoEditorApiModule | null>(null);
  const editorRef = useRef<MonacoEditorNamespace.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<MonacoEditorNamespace.ITextModel | null>(null);
  const modifiedModelRef = useRef<MonacoEditorNamespace.ITextModel | null>(null);
  const latestInputRef = useRef({ original, modified, language });
  latestInputRef.current = { original, modified, language };

  function applyDiffModel(nextOriginal: string, nextModified: string, nextLanguage?: string): void {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!shouldRenderMonacoRuntime() || !editor || !monaco) {
      return;
    }
    originalModelRef.current?.dispose();
    modifiedModelRef.current?.dispose();
    const normalizedLanguage = normalizeMonacoLoaderLanguage(nextLanguage);
    originalModelRef.current = monaco.editor.createModel(nextOriginal, normalizedLanguage);
    modifiedModelRef.current = monaco.editor.createModel(nextModified, normalizedLanguage);
    editor.setModel({
      original: originalModelRef.current,
      modified: modifiedModelRef.current,
    });
    monaco.editor.setTheme(resolveMonacoTheme());
  }

  useEffect(() => {
    if (!shouldRenderMonacoRuntime() || !containerRef.current) {
      return undefined;
    }
    let disposed = false;

    void loadMonacoEditorRuntime(language).then((monaco) => {
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
      const latestInput = latestInputRef.current;
      applyDiffModel(latestInput.original, latestInput.modified, latestInput.language);
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
    applyDiffModel(original, modified, language);
  }, [language, modified, original]);

  if (!shouldRenderMonacoRuntime()) {
    return (
      <div className={className}>
        <pre>{original}</pre>
        <pre>{modified}</pre>
      </div>
    );
  }

  return <div ref={containerRef} className={className} style={{ height }} />;
}
