import type { ChatMode } from "@goatcitadel/contracts";
import type { ReactNode } from "react";

export function ChatSurfaceLayout({
  mode,
  sessionRail,
  primaryColumn,
  workflowColumn,
  contextDock,
  dockOpen,
}: {
  mode: ChatMode;
  sessionRail: ReactNode;
  primaryColumn: ReactNode;
  workflowColumn?: ReactNode;
  contextDock: ReactNode;
  dockOpen: boolean;
}) {
  return (
    <div className="chat-v11-shell">
      {sessionRail}
      <div className="chat-v11-main">
        <div className={`chat-v11-conversation-shell surface-${mode}`}>
          <div
            className={`chat-v11-main-grid${mode === "cowork" ? " with-cowork" : ""}${mode === "code" ? " with-code" : ""}${dockOpen ? " with-dock-open" : " with-dock-collapsed"}`}
          >
            {workflowColumn ? (
              <div className={`chat-v11-secondary-column chat-v11-secondary-column-${mode}`}>
                {workflowColumn}
              </div>
            ) : null}
            <div className="chat-v11-primary-column">
              {primaryColumn}
            </div>
            {dockOpen ? (
              <div className="chat-v11-dock-column">
                {contextDock}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
