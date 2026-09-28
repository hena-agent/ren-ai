import type { Event } from "@ren-ai/persona-engine";
import type { Character } from "./loop.ts";

const DAY_MS = 24 * 60 * 60_000;

const events: Record<string, Event> = {
  harin: {
    id: "event:harin-exhibit",
    kind: "life",
    text: "사진전 설치를 앞둔 날, 함께 설치하기로 한 사람이 오지 못하게 됐다. 하린은 전시장에 걸 사진과 액자 배치를 혼자 정해야 한다.",
  },
  jiwoo: {
    id: "event:jiwoo-presentation",
    kind: "life",
    text: "새 직장에서 처음 맡은 팀 발표가 내일이다. 지우는 동료의 일까지 도와주느라 자기 발표 자료를 아직 마무리하지 못했다.",
  },
};

export const eventFor = (
  character: Character,
  persona: string,
  at: number,
  immediate = false,
): Event | null => {
  const event = events[persona];
  if (!event || character.session.stage === "ended") return null;
  if (character.session.events.some((item) => item.id === event.id)) return null;
  if (immediate) return event;
  if (!["acquaintance", "familiar", "flirting"].includes(character.session.stage)) return null;
  const first = character.entries.find(
    (entry): entry is Extract<Character["entries"][number], { type: "input" }> =>
      entry.type === "input" && entry.event.kind === "user",
  );
  if (first?.at === undefined || at - first.at < DAY_MS) return null;
  if (character.lastSentAt === null) return null;
  const lastReply = character.session.events.findLastIndex((item) => item.kind === "reply");
  if (character.session.events.slice(lastReply + 1).some((item) => item.kind === "user"))
    return null;
  return event;
};
