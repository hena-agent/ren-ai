export const sent = () => "sent";
export const notSent = (reason: string) => `not sent: ${reason}`;
export const notReacted = (reason: string) => `not reacted: ${reason}`;

const tags =
  /<(?=\/?(?:message|gap|photo|tapback|edited|unsent|notice|sent-by-you|phone|checked-phone|conversation-started)\b)/gi;

const words = (text: string) => text.replace(tags, "‹");
const attribute = (text: string) => words(text).replaceAll('"', "”");

const timestamp = (date: number, timeZone: string) => {
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

export const message = (text: string, date: number, previous: number | null, timeZone: string) => {
  const at = timestamp(date, timeZone);
  if (previous === null) return `<message at="${at}">${words(text)}</message>`;
  const earlier = timestamp(previous, timeZone);
  const elapsed = Math.max(0, Math.floor((date - previous) / 60000));
  const gap =
    earlier.slice(0, 10) !== at.slice(0, 10) || elapsed >= 60
      ? `<gap>${Math.floor(elapsed / 60)}h ${elapsed % 60}m later</gap>\n`
      : "";
  return `${gap}<message at="${at}">${words(text)}</message>`;
};

export const edited = (old: string, text: string, date: number, timeZone: string) =>
  `<edited was="${attribute(old)}" at="${timestamp(date, timeZone)}">${words(text)}</edited>`;

export const unsent = (date: number, timeZone: string) =>
  `<unsent at="${timestamp(date, timeZone)}"/>`;
export const conversationStarted = (
  at: number,
  openingLine: string,
  notice: string,
  timeZone: string,
) =>
  `<conversation-started at="${timestamp(at, timeZone)}"/>\n${openingLine}\n<notice>${words(notice)}</notice>`;

export const sentByYou = (text: string, date: number, timeZone: string) =>
  `<sent-by-you at="${timestamp(date, timeZone)}">${words(text)}</sent-by-you>`;
