import { createContext, type ReactNode } from "react";

export interface InspectorContent {
  title: string;
  body: ReactNode;
  source?: string;
  /**
   * Set only by an open the operator asked for by hand (a click or Enter on a row or an Inspect control): the docked
   * or floating panel then takes focus once. An open from an address, a reload, a refetch or a list walk leaves focus
   * where it is. The panel acts on it once per content, so an update of the same panel never moves focus again.
   */
  focusOnOpen?: boolean;
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
