import type { ReactNode } from "react";
export type SheetOwner = { scope: string };
export type ReloadReview = {
  owner: SheetOwner;
  history: string;
  url: string;
  children: ReactNode;
  trigger: HTMLButtonElement;
};
