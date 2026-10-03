export const timestamp = (date: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("weekday")} ${part("hour")}:${part("minute")}`;
};

export const phone = (now: number, timeZone: string, status: "sent" | "delivered" | number) =>
  `<phone now="${timestamp(now, timeZone)}" your-last-message="${typeof status === "number" ? `read ${timestamp(status, timeZone).slice(-5)}` : status}"/>`;
