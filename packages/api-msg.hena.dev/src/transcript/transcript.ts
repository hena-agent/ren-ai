export const sent = () => "sent";
export const notSent = (reason: string) => `not sent: ${reason}`;
export const conversationStarted = (
  at: number,
  openingLine: string,
  notice: string,
  timeZone: string,
) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  const timestamp = `${field("year")}-${field("month")}-${field("day")} ${field("weekday")} ${field("hour")}:${field("minute")}`;
  return `<conversation-started at="${timestamp}"/>\n${openingLine}\n<notice>${notice}</notice>`;
};
