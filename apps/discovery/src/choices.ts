import { Schema } from "effect";

const choices = Schema.Record(Schema.String, Schema.Boolean);
const key = "ren-ai.discovery.choices";
export type Choices = typeof choices.Type;

export function readChoices(): Choices {
  try {
    const stored = localStorage.getItem(key);
    return stored ? Schema.decodeUnknownSync(choices)(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

export function saveChoices(value: Choices): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
