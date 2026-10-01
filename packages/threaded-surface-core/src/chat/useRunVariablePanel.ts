import { useCallback, useEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  resolveLegacyRunVariableTemplate,
  resolveRunVariableTemplate,
  validateRunVariableBindings,
  type RunTemplateInvocation,
  type RunVariableBindings,
  type RunVariableSchema,
  type RunVariableValue,
} from "@goatcitadel/contracts";

export interface RunVariableFormRequest {
  title: string;
  invocation: Omit<RunTemplateInvocation, "values">;
  schema: RunVariableSchema;
  template: string;
  defaults?: RunVariableBindings;
}

interface RunVariablePanelState extends Omit<RunVariableFormRequest, "defaults"> {
  open: boolean;
  values: RunVariableBindings;
}

export function useRunVariablePanel(input: {
  selectedSessionId: string | null;
  setDraft: Dispatch<SetStateAction<string>>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { selectedSessionId, setDraft, composerRef } = input;
  const [panel, setPanel] = useState<RunVariablePanelState | null>(null);
  const [pendingTemplateInvocation, setPendingTemplateInvocation] = useState<{
    invocation: RunTemplateInvocation;
    resolvedContent: string;
  } | null>(null);

  const resolution = useMemo(() => {
    if (!panel) return { preview: "", error: null as string | null };
    try {
      const validation = validateRunVariableBindings(panel.schema, panel.values);
      const typed = resolveRunVariableTemplate(panel.template, panel.schema, validation.bindings);
      return {
        preview: resolveLegacyRunVariableTemplate(typed, panel.schema, validation.bindings).trim(),
        error: null,
      };
    } catch (error) {
      return { preview: "", error: error instanceof Error ? error.message : String(error) };
    }
  }, [panel]);

  useEffect(() => {
    setPanel(null);
    setPendingTemplateInvocation(null);
  }, [selectedSessionId]);

  const openForm = useCallback((request: RunVariableFormRequest) => {
    const initial = validateRunVariableBindings(request.schema, request.defaults ?? {}, {
      allowMissingRequired: true,
    });
    setPanel({
      open: true,
      title: request.title,
      invocation: request.invocation,
      schema: initial.schema,
      template: request.template,
      values: initial.bindings,
    });
  }, []);

  const onValueChange = useCallback((fieldId: string, value: RunVariableValue | undefined) => {
    setPanel((current) =>
      current
        ? {
            ...current,
            values: Object.fromEntries(
              Object.entries({ ...current.values, [fieldId]: value }).filter(([, fieldValue]) => fieldValue !== undefined),
            ) as RunVariableBindings,
          }
        : current,
    );
  }, []);

  const apply = useCallback(() => {
    if (!panel || resolution.error || !resolution.preview) return;
    const validation = validateRunVariableBindings(panel.schema, panel.values);
    const invocation = { ...panel.invocation, values: validation.bindings } satisfies RunTemplateInvocation;
    setPendingTemplateInvocation({ invocation, resolvedContent: resolution.preview });
    setDraft(resolution.preview);
    setPanel(null);
    globalThis.setTimeout(() => composerRef.current?.focus(), 0);
  }, [composerRef, panel, resolution, setDraft]);

  const close = useCallback(() => setPanel(null), []);
  const clearPendingTemplateInvocation = useCallback(() => setPendingTemplateInvocation(null), []);

  return {
    openForm,
    pendingTemplateInvocation,
    clearPendingTemplateInvocation,
    runVariablePanel: panel
      ? {
          open: panel.open,
          title: panel.title,
          schema: panel.schema,
          values: panel.values,
          preview: resolution.preview,
          error: resolution.error,
          onValueChange,
          onApply: apply,
          onClose: close,
        }
      : undefined,
  };
}
