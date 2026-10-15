import { TIME_UNAVAILABLE, formatAbsoluteTime, presentTime } from "@goatcitadel/mission-control-shared/content/format";

/**
 * The one way the cockpit shows a time: relative text when recent ("5 minutes ago"), the full date and time as the
 * title, and the machine value on `<time dateTime>`. `absolute` shows the full date and time as the visible text.
 */
export function TimeText({
  value,
  absolute,
  prefix,
  className,
}: {
  value: string | number | Date | null | undefined;
  absolute?: boolean;
  /** Plain words before the time, for example "Updated". */
  prefix?: string;
  className?: string;
}) {
  const time = presentTime(value);
  if (!time)
    return (
      <span className={className}>
        {prefix ? `${prefix} · ` : ""}
        {TIME_UNAVAILABLE}
      </span>
    );
  return (
    <time dateTime={time.dateTime} title={time.title} className={className}>
      {prefix ? `${prefix} ` : ""}
      {absolute ? formatAbsoluteTime(value) : time.text}
    </time>
  );
}
