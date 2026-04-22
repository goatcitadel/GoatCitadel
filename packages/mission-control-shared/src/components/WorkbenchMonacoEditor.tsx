import { useEffect, useRef } from "react";
import type { editor as MonacoEditorNamespace } from "monaco-editor";
import { shouldRenderMonacoRuntime } from "./monaco-runtime";
import {
  loadMonacoEditorRuntime,
  normalizeMonacoLoaderLanguage,
  type MonacoEditorApiModule,
} from "./monaco-loader";

interface WorkbenchMonacoEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  height?: number | string;
  onChange?: (value: string) => void;
  className?: string;
}

function resolveMonacoTheme(): "vs" | "vs-dark" {
  if (typeof document === "undefined") {
    return "vs-dark";
  }
  return document.querySelector(".theme-citadel-light") ? "vs" : "vs-dark";
}

export function WorkbenchMonacoEditor({
  value,
  language,
  readOnly = false,
  height = "100%",
  onChange,
  className,
}: WorkbenchMonacoEditorProps) {
  const usesDiffLayout = language?.trim().toLowerCase() === "diff";
  const resolvedLanguage = usesDiffLayout ? "plaintext" : normalizeMonacoLoaderLanguage(language);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<MonacoEditorApiModule | null>(null);
  const editorRef = useRef<MonacoEditorNamespace.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<MonacoEditorNamespace.ITextModel | null>(null);
  const latestPropsRef = useRef({ value, language: resolvedLanguage, readOnly, onChange });
  const applyingExternalValueRef = useRef(false);
  latestPropsRef.current = { value, language: resolvedLanguage, readOnly, onChange };

  useEffect(() => {
    if (!shouldRenderMonacoRuntime() || !containerRef.current) {
      return undefined;
    }

    let disposed = false;
    void loadMonacoEditorRuntime(resolvedLanguage).then((monaco) => {
      if (disposed || !containerRef.current) {
        return;
      }
      monacoRef.current = monaco;
      monaco.editor.setTheme(resolveMonacoTheme());
      const model = monaco.editor.createModel(latestPropsRef.current.value, latestPropsRef.current.language);
      modelRef.current = model;
      const editor = monaco.editor.create(containerRef.current, {
        automaticLayout: true,
        glyphMargin: false,
        lineNumbers: "on",
        minimap: { enabled: false },
        model,
        padding: { top: 14, bottom: 14 },
        readOnly: latestPropsRef.current.readOnly,
        renderLineHighlight: latestPropsRef.current.readOnly ? "none" : "line",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: usesDiffLayout ? "off" : "on",
      });
      editor.onDidChangeModelContent(() => {
        if (applyingExternalValueRef.current) {
          return;
        }
        latestPropsRef.current.onChange?.(editor.getValue());
      });
      editorRef.current = editor;
    });

    return () => {
      disposed = true;
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [resolvedLanguage]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!monaco || !editor || !model) {
      return;
    }

    monaco.editor.setTheme(resolveMonacoTheme());
    monaco.editor.setModelLanguage(model, resolvedLanguage);
    editor.updateOptions({
      readOnly,
      renderLineHighlight: readOnly ? "none" : "line",
      wordWrap: usesDiffLayout ? "off" : "on",
    });

    if (model.getValue() !== value) {
      applyingExternalValueRef.current = true;
      model.setValue(value);
      applyingExternalValueRef.current = false;
    }
  }, [readOnly, resolvedLanguage, usesDiffLayout, value]);

  if (!shouldRenderMonacoRuntime()) {
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

  return <div ref={containerRef} className={className} style={{ minHeight: typeof height === "number" ? `${height}px` : height }} />;
}
