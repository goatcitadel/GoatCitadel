import { createContext, type ReactNode } from "react";

export interface InspectorContent {
  title: string;
  body: ReactNode;
  source?: string;
  /**
   * The panel opens for a move the operator is making elsewhere (J and K walking a list), so it must not take focus
   * from the list. Without it, a panel that opens docked or floating takes focus.
   */
  keepFocus?: boolean;
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

/** Separate disclosure currency does not rerender Chat on inspector body updates. */
export const InspectorSourceContext = createContext<string | null>(null);
