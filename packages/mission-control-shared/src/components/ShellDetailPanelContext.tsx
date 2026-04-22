import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ShellDetailPanelEntry {
  id: string;
  title: string;
  kicker?: string;
  subtitle?: ReactNode;
  body: ReactNode;
  priority?: number;
  actions?: ReactNode;
}

interface ShellDetailPanelContextValue {
  activeEntry: ShellDetailPanelEntry | null;
  registerEntry: (entry: ShellDetailPanelEntry) => () => void;
  openPanel: () => void;
  closePanel: () => void;
  isOpen: boolean;
}

const ShellDetailPanelContext = createContext<ShellDetailPanelContextValue>({
  activeEntry: null,
  registerEntry: () => () => {},
  openPanel: () => {},
  closePanel: () => {},
  isOpen: false,
});

interface ShellDetailPanelProviderProps {
  children: ReactNode;
  isOpen: boolean;
  onOpenPanel: () => void;
  onClosePanel: () => void;
  onActiveEntryChange?: (entry: ShellDetailPanelEntry | null) => void;
}

interface RegisteredEntry extends ShellDetailPanelEntry {
  order: number;
}

export function ShellDetailPanelProvider({
  children,
  isOpen,
  onOpenPanel,
  onClosePanel,
  onActiveEntryChange,
}: ShellDetailPanelProviderProps) {
  const orderRef = useRef(0);
  const [entries, setEntries] = useState<Record<string, RegisteredEntry>>({});

  const registerEntry = useCallback((entry: ShellDetailPanelEntry) => {
    const nextOrder = orderRef.current + 1;
    orderRef.current = nextOrder;
    setEntries((current) => ({
      ...current,
      [entry.id]: {
        ...entry,
        order: nextOrder,
      },
    }));

    return () => {
      setEntries((current) => {
        if (!(entry.id in current)) {
          return current;
        }
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
    };
  }, []);

  const activeEntry = useMemo(() => {
    const values = Object.values(entries);
    if (values.length === 0) {
      return null;
    }
    values.sort((left, right) => {
      const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return right.order - left.order;
    });
    return values[0] ?? null;
  }, [entries]);

  useEffect(() => {
    onActiveEntryChange?.(activeEntry);
  }, [activeEntry, onActiveEntryChange]);

  const value = useMemo<ShellDetailPanelContextValue>(
    () => ({
      activeEntry,
      registerEntry,
      openPanel: onOpenPanel,
      closePanel: onClosePanel,
      isOpen,
    }),
    [activeEntry, isOpen, onClosePanel, onOpenPanel, registerEntry],
  );

  return <ShellDetailPanelContext.Provider value={value}>{children}</ShellDetailPanelContext.Provider>;
}

export function useShellDetailPanel() {
  return useContext(ShellDetailPanelContext);
}
