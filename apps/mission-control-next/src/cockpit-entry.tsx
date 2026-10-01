import React from "react";
import { renderApplicationRoot } from "./app/application-root";
import { CockpitApp } from "@next/cockpit/app/CockpitApp";
import "@next/cockpit/styles/cockpit.css";
import "@next/cockpit/areas/settings/model-setup.css";
import "@next/cockpit/areas/chat/chat-build-editor.css";
import "@next/cockpit/areas/chat/chat-utility-panels.css";
import "@next/features/threaded-surface/styles/change-plans.css";

export function mountCockpit(root: HTMLElement): void {
  renderApplicationRoot(root,
    <React.StrictMode>
      <CockpitApp />
    </React.StrictMode>,
  );
}
