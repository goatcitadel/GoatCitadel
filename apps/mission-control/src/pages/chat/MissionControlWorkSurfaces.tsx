import { Suspense, lazy } from "react";
import type { ChatMode } from "@goatcitadel/contracts";
import type { CodeWorkbenchPanel as CodeWorkbenchPanelComponent } from "../../components/CodeWorkbenchPanel";
import type { CoworkCanvasPanel as CoworkCanvasPanelComponent } from "../../components/CoworkCanvasPanel";
import { ChatSurfaceLayout } from "./ChatSurfaceLayout";

const LazyCoworkCanvasPanel = lazy(async () => {
  const module = await import("../../components/CoworkCanvasPanel");
  return { default: module.CoworkCanvasPanel };
});

const LazyCodeWorkbenchPanel = lazy(async () => {
  const module = await import("../../components/CodeWorkbenchPanel");
  return { default: module.CodeWorkbenchPanel };
});

interface BaseWorkSurfaceProps {
  mode: ChatMode;
  sessionRail: React.ReactNode;
  primaryColumn: React.ReactNode;
  workflowColumn?: React.ReactNode;
  contextDock: React.ReactNode;
  dockOpen: boolean;
  onDockOpenChange?: (next: boolean) => void;
  hasActiveSession?: boolean;
  sessionRailOpen?: boolean;
  onSessionRailOpenChange?: (next: boolean) => void;
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
      onDockOpenChange={props.onDockOpenChange}
      hasActiveSession={props.hasActiveSession}
      sessionRailOpen={props.sessionRailOpen}
      onSessionRailOpenChange={props.onSessionRailOpenChange}
    />
  );
}

export function CoworkWorkSurface(
  props: BaseWorkSurfaceProps & {
    coworkPanel: React.ComponentProps<typeof CoworkCanvasPanelComponent>;
  },
) {
  return (
    <ChatSurfaceLayout
      mode={props.mode}
      sessionRail={props.sessionRail}
      primaryColumn={props.primaryColumn}
      workflowColumn={
        props.workflowColumn ?? (
          <Suspense fallback={<div className="panel panel-pad" aria-hidden="true" />}>
            <LazyCoworkCanvasPanel {...props.coworkPanel} />
          </Suspense>
        )
      }
      contextDock={props.contextDock}
      dockOpen={props.dockOpen}
      onDockOpenChange={props.onDockOpenChange}
      hasActiveSession={props.hasActiveSession}
      sessionRailOpen={props.sessionRailOpen}
      onSessionRailOpenChange={props.onSessionRailOpenChange}
    />
  );
}

export function CodeWorkSurface(
  props: BaseWorkSurfaceProps & {
    codePanel: React.ComponentProps<typeof CodeWorkbenchPanelComponent>;
  },
) {
  return (
    <ChatSurfaceLayout
      mode={props.mode}
      sessionRail={props.sessionRail}
      primaryColumn={props.primaryColumn}
      workflowColumn={
        props.workflowColumn ?? (
          <Suspense fallback={<div className="panel panel-pad" aria-hidden="true" />}>
            <LazyCodeWorkbenchPanel {...props.codePanel} />
          </Suspense>
        )
      }
      contextDock={props.contextDock}
      dockOpen={props.dockOpen}
      onDockOpenChange={props.onDockOpenChange}
      hasActiveSession={props.hasActiveSession}
      sessionRailOpen={props.sessionRailOpen}
      onSessionRailOpenChange={props.onSessionRailOpenChange}
    />
  );
}
