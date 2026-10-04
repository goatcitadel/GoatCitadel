import { createRoot } from "react-dom/client";
import "@next/styles/mission-control-next-tokens.css";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next-theme-bridge.css";
import "@next/styles/mission-control-next.css";
import "@next/features/native-routes/primitives/primitives.css";
import "./testbench.css";
import type { TestbenchEnv } from "../env";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { TestbenchApp } from "./TestbenchApp";

const THEME_CLASS = "theme-signal-noir";

export function mountTestbench(container: HTMLElement, targetRequest: TargetRequest, env: TestbenchEnv): void {
  // Theme on html and body so content portaled to body (dialogs) inherits it, as in the main app.
  document.documentElement.classList.add(THEME_CLASS);
  document.body.classList.add(THEME_CLASS);
  createRoot(container).render(<TestbenchApp targetRequest={targetRequest} env={env} />);
}
