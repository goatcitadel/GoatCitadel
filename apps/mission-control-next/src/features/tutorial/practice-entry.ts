import {
  clearPracticeStorage,
  installPracticeGatewayTransport,
} from "@goatcitadel/mission-control-shared/api/gateway-transport";
import { createPracticeSession } from "./practice-fixture.js";
import { mountTutorialGuide } from "./practice-guide.js";
import { unmountApplicationRoot } from "../../app/application-root";
import { setPracticeLocation } from "./practice-location";
import { recordTutorialReturn, type TutorialHandoff } from "./handoff";
import "./tutorial.css";

export async function mountTutorial(root: HTMLElement, scope: TutorialHandoff): Promise<void> {
  const session = createPracticeSession();
  installPracticeGatewayTransport(session.transport);
  setPracticeLocation("/chat?sessionId=" + encodeURIComponent(session.sessionId) + "&shell=cockpit");
  document.documentElement.dataset.shell = "cockpit";
  let disposed = false;
  const guide: { remove?: () => void } = {};
  function dispose() {
    if (disposed) return;
    disposed = true;
    session.dispose();
    guide.remove?.();
    unmountApplicationRoot(root);
    clearPracticeStorage();
  }
  const leave = (message: string) => {
    dispose();
    const query = new URLSearchParams({ shell: "cockpit" });
    recordTutorialReturn(scope);
    if (message) query.set("tutorialEnded", message);
    location.replace("/chat?" + query);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && disposed) leave("exited");
  });
  const { mountCockpit } = await import("../../cockpit-entry");
  if (disposed) return;
  mountCockpit(root);
  guide.remove = mountTutorialGuide(session, setPracticeLocation, leave);
}
