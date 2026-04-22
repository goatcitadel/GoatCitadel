import { memo, useEffect, useState, type JSX } from "react";

function nowLabel(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ClockBadgeInner(): JSX.Element {
  const [label, setLabel] = useState(nowLabel);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLabel(nowLabel());
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return <p>{label}</p>;
}

export const ClockBadge = memo(ClockBadgeInner);
