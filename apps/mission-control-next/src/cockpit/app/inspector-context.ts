import { createContext, type ReactNode } from "react";

export interface InspectorContent {
  title: string;
  body: ReactNode;
  source?: string;
}
export interface InspectorApi {
  content: InspectorContent | null;
  getDismissalGeneration: () => number;
  open: (content: InspectorContent) => void;
  close: () => void;
  register: (source: string, content: InspectorContent) => void;
  updateIfOpen: (source: string, content: InspectorContent) => void;
  closeIfOpen: (source: string) => void;
}

// Keep the context identity stable when React refreshes provider and consumer components.
export const InspectorContext = createContext<InspectorApi | null>(null);
