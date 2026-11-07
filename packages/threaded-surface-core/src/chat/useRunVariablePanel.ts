import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  RunTemplateInvocation,
  RunVariableBindings,
  RunVariableSchema,
  RunVariableValue,
} from "@goatcitadel/contracts";
import { getGatewayAccessRevision, getGatewayCallerScopeRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

type RunVariableCode = typeof import("./run-variable-panel-code.js");
let variableCode: Promise<RunVariableCode> | undefined;

function loadRunVariableCode() {
  return (variableCode ??= import("./run-variable-panel-code.js").catch((error: unknown) => {
    variableCode = undefined;
    throw error;
  }));
}

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
  code: RunVariableCode;
}

export function useRunVariablePanel(input: {
  selectedSessionId: string | null;
  workspaceId?: string;
  enabled?: boolean;
  setDraft: Dispatch<SetStateAction<string>>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { selectedSessionId, workspaceId, enabled, setDraft, composerRef } = input;
  const scope = JSON.stringify([workspaceId, selectedSessionId, enabled]);
  const owner = useRef({ scope });
  if (owner.current.scope !== scope) owner.current = { scope };
  const renderOwner = owner.current;
  const openAttempt = useRef(0);
  const [panel, setPanel] = useState<RunVariablePanelState | null>(null);
  const [pendingTemplateInvocation, setPendingTemplateInvocation] = useState<{
    invocation: RunTemplateInvocation;
    resolvedContent: string;
  } | null>(null);

  const resolution = useMemo(() => {
    if (!panel) return { preview: "", error: null as string | null };
    const { resolveLegacyRunVariableTemplate, resolveRunVariableTemplate, validateRunVariableBindings } = panel.code;
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
    return () => {
      openAttempt.current += 1;
    };
  }, [scope]);

  const openForm = useCallback(
    async (request: RunVariableFormRequest) => {
      if (enabled === false || owner.current !== renderOwner) return;
      const attempt = ++openAttempt.current;
      const installation = getGatewayApiBaseUrl();
      const access = getGatewayAccessRevision();
      const caller = getGatewayCallerScopeRevision();
      const current = () =>
        owner.current === renderOwner &&
        openAttempt.current === attempt &&
        installation === getGatewayApiBaseUrl() &&
        access === getGatewayAccessRevision() &&
        caller === getGatewayCallerScopeRevision();
      try {
        const code = await loadRunVariableCode();
        if (!current()) return;
        const initial = code.validateRunVariableBindings(request.schema, request.defaults ?? {}, {
          allowMissingRequired: true,
        });
        setPanel({
          open: true,
          title: request.title,
          invocation: request.invocation,
          schema: initial.schema,
          template: request.template,
          values: initial.bindings,
          code,
        });
      } catch (error) {
        if (current()) throw error;
      }
    },
    [enabled, renderOwner],
  );

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
    const validation = panel.code.validateRunVariableBindings(panel.schema, panel.values);
    const invocation = { ...panel.invocation, values: validation.bindings } satisfies RunTemplateInvocation;
    setPendingTemplateInvocation({ invocation, resolvedContent: resolution.preview });
    setDraft(resolution.preview);
    setPanel(null);
    globalThis.setTimeout(() => composerRef.current?.focus(), 0);
  }, [composerRef, panel, resolution, setDraft]);

  const close = useCallback(() => {
    openAttempt.current += 1;
    setPanel(null);
  }, []);
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
