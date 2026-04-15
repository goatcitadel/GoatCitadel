import type { ChatMode } from "@goatcitadel/contracts";
import { CodeWorkbenchPanel } from "../../components/CodeWorkbenchPanel";
import { CoworkCanvasPanel } from "../../components/CoworkCanvasPanel";
import { ChatSurfaceLayout } from "./ChatSurfaceLayout";

interface BaseWorkSurfaceProps {
  mode: ChatMode;
  sessionRail: React.ReactNode;
  primaryColumn: React.ReactNode;
  workflowColumn?: React.ReactNode;
  contextDock: React.ReactNode;
  dockOpen: boolean;
  hasActiveSession?: boolean;
}

export function ChatWorkSurface(props: BaseWorkSurfaceProps) {
  return (
    <ChatSurfaceLayout
      mode={props.mode}
      sessionRail={props.sessionRail}
      primaryColumn={props.primaryColumn}
      workflowColumn={props.workflowColumn}
      contextDock={props.contextDock}
      dockOpen={props.dockOpen}
      hasActiveSession={props.hasActiveSession}
    />
  );
}

export function CoworkWorkSurface(
  props: BaseWorkSurfaceProps & {
    coworkPanel: React.ComponentProps<typeof CoworkCanvasPanel>;
  },
) {
  return (
    <ChatSurfaceLayout
      mode={props.mode}
      sessionRail={props.sessionRail}
      primaryColumn={props.primaryColumn}
      workflowColumn={props.workflowColumn ?? <CoworkCanvasPanel {...props.coworkPanel} />}
      contextDock={props.contextDock}
      dockOpen={props.dockOpen}
      hasActiveSession={props.hasActiveSession}
    />
  );
}

export function CodeWorkSurface(
  props: BaseWorkSurfaceProps & {
    codePanel: React.ComponentProps<typeof CodeWorkbenchPanel>;
  },
) {
  return (
    <ChatSurfaceLayout
      mode={props.mode}
      sessionRail={props.sessionRail}
      primaryColumn={props.primaryColumn}
      workflowColumn={props.workflowColumn ?? <CodeWorkbenchPanel {...props.codePanel} />}
      contextDock={props.contextDock}
      dockOpen={props.dockOpen}
      hasActiveSession={props.hasActiveSession}
    />
  );
}
