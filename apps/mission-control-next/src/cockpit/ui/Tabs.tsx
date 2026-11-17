import { createContext, useContext, useRef, type ComponentProps, type ComponentPropsWithoutRef } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../lib/cn";
import { TAB_ACTIVE_CLASS, TAB_CLASS } from "./tab-style";
import { useControlWave, warmControlWave } from "./use-control-wave";

export const TabsContent = TabsPrimitive.Content;

type TabActivation = { value: string; source: HTMLElement; focus?: MouseEvent };

const TabWaveContext = createContext<{
  automatic: boolean;
  remember: (activation: TabActivation) => void;
} | null>(null);

export function Tabs({
  activationMode = "automatic",
  onValueChange,
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>) {
  const activation = useRef<TabActivation>(undefined);
  const { play } = useControlWave();
  return (
    <TabWaveContext.Provider
      value={{
        automatic: activationMode === "automatic",
        remember: (next) => {
          activation.current = next;
        },
      }}
    >
      <TabsPrimitive.Root
        {...props}
        activationMode={activationMode}
        onValueChange={(value) => {
          const interaction = activation.current;
          activation.current = undefined;
          onValueChange?.(value);
          if (interaction?.value === value) {
            play(interaction.source, interaction.source, interaction.focus, { preserveText: true });
          }
        }}
      />
    </TabWaveContext.Provider>
  );
}

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex gap-1 border-b border-line-subtle", className)} {...props} />;
}

export function TabsTrigger({
  className,
  value,
  disabled,
  wave = true,
  onFocus,
  onKeyDown,
  onMouseDown,
  onPointerEnter,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { wave?: boolean }) {
  const animation = useContext(TabWaveContext);
  const remember = (source: HTMLElement, focus?: MouseEvent) => {
    if (wave && !disabled && source.dataset.state === "inactive") animation?.remember({ value, source, focus });
  };
  return (
    <TabsPrimitive.Trigger
      {...props}
      value={value}
      disabled={disabled}
      className={cn(TAB_CLASS, TAB_ACTIVE_CLASS, "whitespace-nowrap", className)}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (wave && !disabled && !event.defaultPrevented) warmControlWave();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!wave || disabled || event.defaultPrevented) return;
        warmControlWave();
        if (animation?.automatic && event.currentTarget.matches(":focus-visible")) remember(event.currentTarget);
      }}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey) {
          remember(event.currentTarget, event.nativeEvent);
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && (event.key === " " || event.key === "Enter")) remember(event.currentTarget);
      }}
    />
  );
}
