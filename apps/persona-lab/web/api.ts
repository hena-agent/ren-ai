import type { Character } from "../src/loop.ts";
import type { SessionInfo } from "../src/store.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parsed session JSON
const isCharacter = (value: unknown): value is Character =>
  typeof value === "object" &&
  value !== null &&
  "session" in value &&
  typeof value.session === "object" &&
  value.session !== null &&
  "id" in value.session &&
  typeof value.session.id === "string" &&
  "events" in value.session &&
  Array.isArray(value.session.events) &&
  "decisions" in value &&
  Array.isArray(value.decisions) &&
  "entries" in value &&
  Array.isArray(value.entries);

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parsed session list JSON
const isSessionInfo = (value: unknown): value is SessionInfo =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "persona" in value &&
  typeof value.persona === "string" &&
  "events" in value &&
  typeof value.events === "number" &&
  "paused" in value &&
  typeof value.paused === "boolean";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: server JSON
const json = async (response: Response): Promise<unknown> => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parsed HTTP response
  const value: unknown = await response.json();
  if (!response.ok) {
    if (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
    )
      throw new Error(value.error);
    throw new Error("요청을 처리하지 못했습니다.");
  }
  return value;
};

const character = async (response: Response): Promise<Character> => {
  const value = await json(response);
  if (!isCharacter(value)) throw new Error("세션을 불러오지 못했습니다.");
  return value;
};

export const sessionsFor = async (persona: string): Promise<SessionInfo[]> => {
  const value = await json(await fetch(`/api/sessions?persona=${encodeURIComponent(persona)}`));
  if (!Array.isArray(value) || !value.every(isSessionInfo))
    throw new Error("세션을 불러오지 못했습니다.");
  return value;
};

export const openSession = async (id: string): Promise<Character> =>
  character(await fetch(`/api/session?session=${encodeURIComponent(id)}`));

export const createSession = async (persona: string): Promise<Character> =>
  character(await fetch(`/api/new?persona=${encodeURIComponent(persona)}`, { method: "POST" }));

export const sessionAction = async (
  action: "reset" | "tick" | "event" | "input" | "pause" | "resume",
  id: string,
  options?: { minutes?: string; body?: string },
): Promise<Character> =>
  character(
    await fetch(
      `/api/${action}?session=${encodeURIComponent(id)}${options?.minutes ? `&minutes=${options.minutes}` : ""}`,
      {
        method: "POST",
        ...(options?.body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: options.body }),
      },
    ),
  );

export const deleteSession = async (id: string): Promise<void> => {
  await json(await fetch(`/api/session?session=${encodeURIComponent(id)}`, { method: "DELETE" }));
};

export const importSession = async (body: string): Promise<Character> =>
  character(
    await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );

export const exportSession = async (id: string): Promise<string> =>
  JSON.stringify(await json(await fetch(`/api/export?session=${encodeURIComponent(id)}`)), null, 2);
