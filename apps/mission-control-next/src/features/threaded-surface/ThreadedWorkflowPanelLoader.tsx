import { lazy } from "react";

export const LazyThreadedWorkflowPanel = lazy(async () => {
  const module = await import("./ThreadedWorkflowPanel");
  return { default: module.ThreadedWorkflowPanel };
});
