import type { ComponentProps } from "react";
import { useControlWave, warmControlWave } from "./use-control-wave";

/** Keeps the browser's own disclosure behavior and animates only its heading. */
export function DisclosureSummary({ onClick, onFocus, onPointerEnter, ...props }: ComponentProps<"summary">) {
  const { play } = useControlWave();
  return (
    <summary
      {...props}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) warmControlWave();
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented) warmControlWave();
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.target instanceof Element && event.target.closest("a[href],button,input,label,select,textarea"))
          return;
        play(event.currentTarget, event.currentTarget, event.nativeEvent, { preserveText: true });
      }}
    />
  );
}
