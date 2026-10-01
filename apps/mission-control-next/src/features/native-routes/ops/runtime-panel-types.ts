import type { Dispatch, SetStateAction } from "react";
import type { CronActionOption } from "./runtime-schedule-model";

export type RuntimePanelSetter<T> = Dispatch<SetStateAction<T>>;
export type RuntimeTab = "services" | "efficiency" | "backups";
export type RuntimeScheduleEditor = "create" | "designer" | null;
export type RuntimeScheduleDraft = { name: string; schedule: string; action: CronActionOption };
export type RuntimeAutomationDraft = {
  taskDescription: string;
  trigger: string;
  frequency: string;
  successCriteria: string;
  constraints: string;
};
export type RuntimeInspection = {
  scope: string;
  kind: "session" | "event" | "schedule" | "report" | "replay";
  id: string;
};
export type RuntimeOpenInspection = (kind: RuntimeInspection["kind"], id: string) => void;
