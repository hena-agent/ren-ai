import { Message } from "@opencode/ai";
import { expect, test } from "vitest";
import { phone } from "../transcript/transcript.ts";
import { cleanContext } from "./context.ts";

test("only the ephemeral phone line varies; OpenCode notices and tools never reach the model", () => {
  const conversation = Message.user('<message at="2026-09-25 Fri 20:52">안녕</message>');
  const date = Message.user("Today's date is now: Sat Sep 26 2026");
  const systemDate = Message.system("Today's date is now: Sat Sep 26 2026");
  const restart = Message.user(
    "The server restarted while you were working. Continue from where you left off without repeating completed work.",
  );
  const quoted = Message.user(
    '<message at="2026-09-25 Fri 20:53">Today\'s date is now: not a notice</message>',
  );
  const embedded = Message.user([
    Message.text("Today's date is now: Sat Sep 26 2026"),
    Message.text("keep"),
  ]);
  const extra = [
    Message.assistant("Today's date is now: Sat Sep 26 2026"),
    Message.system(
      "The server restarted while you were working. Continue from where you left off without repeating completed work.",
    ),
    Message.user("Today's date is now: Sat Sep 26 2026\nkeep"),
    Message.user([]),
    Message.user([{ type: "effort" }]),
    Message.user([{ type: "reasoning", text: "Today's date is now: Sat Sep 26 2026" }]),
    embedded,
  ];
  const first = {
    system: [{ type: "text" as const, text: "<env>leaked</env>\nToday's date: Friday" }],
    messages: [conversation, date, systemDate, restart, quoted, ...extra],
    tools: { send: { description: "ok", input: {} }, execute: { description: "bad", input: {} } },
  };
  const status = phone(Date.parse("2026-09-25T14:41:00Z"), "Asia/Seoul", "delivered");
  expect(cleanContext(first, "You are Persona1.", status, new Set(["send"]))).toEqual(["execute"]);
  expect(first.system[0]?.text).toMatch(/^You are Persona1\.\nRead the English tags/);
  expect(first.messages).toEqual([conversation, quoted, ...extra, Message.user(status)]);
  expect(Object.keys(first.tools)).toEqual(["send"]);
  const second = {
    system: [{ type: "text" as const, text: "untrusted" }],
    messages: [conversation, date, systemDate, restart, quoted, ...extra],
    tools: { intruder: { description: "bad", input: {} } },
  };
  const later = phone(
    Date.parse("2026-09-25T14:42:00Z"),
    "Asia/Seoul",
    Date.parse("2026-09-25T14:40:00Z"),
  );
  expect(cleanContext(second, "You are Persona1.", later, new Set())).toEqual(["intruder"]);
  expect(second.system).toEqual(first.system);
  expect(second.messages.slice(0, -1)).toEqual(first.messages.slice(0, -1));
  expect(second.messages.at(-1)).toEqual(Message.user(later));
  expect(second.messages.at(-1)).not.toEqual(first.messages.at(-1));
});

test("the last line distinguishes sent, delivered and a read receipt in her time zone", () => {
  const now = Date.parse("2026-09-25T14:41:00Z");
  const zone = "Asia/Seoul";
  expect(phone(now, zone, "sent")).toBe(
    '<phone now="2026-09-25 Fri 23:41" your-last-message="sent"/>',
  );
  expect(phone(now, zone, "delivered")).toBe(
    '<phone now="2026-09-25 Fri 23:41" your-last-message="delivered"/>',
  );
  expect(phone(now, zone, Date.parse("2026-09-25T12:04:00Z"))).toBe(
    '<phone now="2026-09-25 Fri 23:41" your-last-message="read 21:04"/>',
  );
});
