import { timestamp } from "@ren-ai/plugin-application/phone";
import type { StartingRelationship } from "@ren-ai/onboarding";
export { timestamp } from "@ren-ai/plugin-application/phone";
export const sent = () => "sent";
export const sentAt = (date: number, timeZone: string) =>
  `sent ${timestamp(date, timeZone).slice(-5)}`;
export const readAt = (date: number, timeZone: string) =>
  `read ${timestamp(date, timeZone).slice(-5)}`;
export const notSent = (reason: string) => `not sent: ${reason}`;
export const notReacted = (reason: string) => `not reacted: ${reason}`;

const tags =
  /<(?=\/?(?:message|gap|photo|photo-by-you|tapback|edited|unsent|notice|sent-by-you|phone|checked-phone|conversation-started|voice-memo|video|file|location|app)\b)/gi;

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

export const photoByYou = (date: number, timeZone: string) =>
  `<photo-by-you at="${timestamp(date, timeZone)}"/>`;

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
const webConsent =
  "The user consented on the website. Send your own first greeting; do not send a separate service notice.";
/** Opens every Conversation, at first contact and when its session is rebuilt. */
export const conversationStarted = (
  at: number,
  openingLine: string,
  timeZone: string,
  preferredLanguage?: string,
  profile?: { name: string | null; age: number | null; gender: string | null },
  startingRelationship?: StartingRelationship,
) =>
  `<conversation-started at="${timestamp(at, timeZone)}"${preferredLanguage ? ` preferred-language="${attribute(preferredLanguage)}"` : ""}${profile ? profileAttributes(profile) : ""}${startingRelationship ? ` starting-relationship="${startingRelationship}"` : ""}/>\n${openingLine}\n<notice>${words(webConsent)}</notice>`;

const profileAttributes = (profile: {
  name: string | null;
  age: number | null;
  gender: string | null;
}) =>
  Object.entries({ name: profile.name, age: profile.age, gender: profile.gender })
    .filter(([, value]) => value !== null)
    .map(
      ([key, value]) =>
        ` user-${key}="${attribute(String(value)).replaceAll("<", "‹").replaceAll(">", "›")}"`,
    )
    .join("");

export const sentByYou = (text: string, date: number, timeZone: string) =>
  `<sent-by-you at="${timestamp(date, timeZone)}">${words(text)}</sent-by-you>`;
