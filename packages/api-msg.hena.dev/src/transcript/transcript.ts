import { timestamp } from "@ren-ai/plugin-application/phone";
export { timestamp } from "@ren-ai/plugin-application/phone";
export const sent = () => "sent";
export const notSent = (reason: string) => `not sent: ${reason}`;
export const notReacted = (reason: string) => `not reacted: ${reason}`;

const tags =
  /<(?=\/?(?:message|gap|photo|tapback|edited|unsent|notice|sent-by-you|phone|checked-phone|conversation-started|voice-memo|video|file|location|app)\b)/gi;

const words = (text: string) => text.replace(tags, "‹");
const attribute = (text: string) => words(text).replaceAll('"', "”");

export const message = (text: string, date: number, previous: number | null, timeZone: string) => {
  const at = timestamp(date, timeZone);
  return `${gap(date, previous, timeZone)}<message at="${at}">${words(text)}</message>`;
};

export const gap = (date: number, previous: number | null, timeZone: string) => {
  if (previous === null) return "";
  const at = timestamp(date, timeZone);
  const earlier = timestamp(previous, timeZone);
  const elapsed = Math.max(0, Math.floor((date - previous) / 60000));
  return earlier.slice(0, 10) !== at.slice(0, 10) || elapsed >= 60
    ? `<gap>${Math.floor(elapsed / 60)}h ${elapsed % 60}m later</gap>\n`
    : "";
};

export const photo = (date: number, timeZone: string) =>
  `<photo at="${timestamp(date, timeZone)}"/>`;

export const placeholder = (
  kind: "voice-memo" | "video" | "file" | "location" | "app",
  date: number,
  timeZone: string,
) => `<${kind} at="${timestamp(date, timeZone)}"/>`;

export const tapback = (emoji: string, target: string, date: number, timeZone: string) =>
  `<tapback at="${timestamp(date, timeZone)}" emoji="${attribute(emoji)}" on="${attribute(target)}"/>`;

export const reply = (text: string, target: string, date: number, timeZone: string) =>
  `<message at="${timestamp(date, timeZone)}" reply-to="${attribute(target)}">${words(text)}</message>`;

export const edited = (old: string, text: string, date: number, timeZone: string) =>
  `<edited was="${attribute(old)}" at="${timestamp(date, timeZone)}">${words(text)}</edited>`;

export const unsent = (date: number, timeZone: string) =>
  `<unsent at="${timestamp(date, timeZone)}"/>`;
export const checkedPhone = (date: number, timeZone: string) =>
  `<checked-phone at="${timestamp(date, timeZone)}"/>`;
export const conversationStarted = (
  at: number,
  openingLine: string,
  notice: string,
  timeZone: string,
) =>
  `<conversation-started at="${timestamp(at, timeZone)}"/>\n${openingLine}\n<notice>${words(notice)}</notice>`;

export const sentByYou = (text: string, date: number, timeZone: string) =>
  `<sent-by-you at="${timestamp(date, timeZone)}">${words(text)}</sent-by-you>`;
