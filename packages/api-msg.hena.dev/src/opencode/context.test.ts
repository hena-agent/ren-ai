import { Message } from "@opencode/ai";
import { expect, test } from "vitest";
import { phone } from "@ren-ai/plugin-application/phone";
import { cleanContext } from "../../../plugins/context/src/clean.ts";

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
    system: [
      { type: "text" as const, text: "You are Persona1." },
      {
        type: "text" as const,
        text: "Today's date: Fri Sep 25 2026\n\nHere is some useful information about the environment you are running in:\n<env>leaked</env>\n\nInstructions from: /session/AGENTS.md\nRead her phone.",
      },
    ],
    messages: [conversation, date, systemDate, restart, quoted, ...extra],
    tools: {
      send: { description: "ok", input: {} },
      execute: { description: "bad", input: {} },
    },
  };
  const status = phone(Date.parse("2026-09-25T14:41:00Z"), "Asia/Seoul", "delivered");
  expect(cleanContext(first, status, new Set(["send"]))).toEqual(["execute"]);
  expect(first.system.map((part) => part.text)).toEqual([
    "You are Persona1.",
    "Instructions from: /session/AGENTS.md\nRead her phone.",
  ]);
  expect(first.messages).toEqual([conversation, quoted, ...extra, Message.user(status)]);
  expect(Object.keys(first.tools)).toEqual(["send"]);
  const second = {
    system: [...first.system],
    messages: [conversation, date, systemDate, restart, quoted, ...extra],
    tools: { intruder: { description: "bad", input: {} } },
  };
  const later = phone(
    Date.parse("2026-09-25T14:42:00Z"),
    "Asia/Seoul",
    Date.parse("2026-09-25T14:40:00Z"),
  );
  expect(cleanContext(second, later, new Set())).toEqual(["intruder"]);
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

test("native instruction history updates survive a combined date, environment, tool and skill update", () => {
  const rules =
    "The instructions from /session/AGENTS.md changed. Here's the diff:\n```diff\n- old\n+ new\n```";
  const event = {
    system: [
      {
        type: "text" as const,
        text: "Native persona prompt\n# Code Mode\nThis is her own instruction.",
      },
      { type: "text" as const, text: "Today's date: Sat Oct 03 2026" },
    ],
    messages: [
      Message.system(
        `Today's date is now: Sat Oct 03 2026\n\nThe environment you are running in is now:\n<env>private path</env>\n\nThe Code Mode tool catalog has changed.\nTool guide\n\n${rules}\n\nThe available skills have changed.\nSkill guide`,
      ),
    ],
    tools: {},
  };
  cleanContext(event, "phone", new Set());
  expect(event.system).toEqual([
    {
      type: "text",
      text: "Native persona prompt\n# Code Mode\nThis is her own instruction.",
    },
  ]);
  expect(event.messages[0]?.content).toEqual([Message.text(rules)]);
});

test("harness-looking text authored inside native AGENTS.md is not erased", () => {
  const native =
    "Instructions from: /session/AGENTS.md\nToday's date: a story title\n\n# Code Mode\nThis is authored ground rules, not a tool catalog.";
  const event = {
    system: [
      { type: "text" as const, text: "Native persona." },
      { type: "text" as const, text: native },
    ],
    messages: [],
    tools: {},
  };
  cleanContext(event, "phone", new Set());
  expect(event.system[1]?.text).toBe(native);
});
