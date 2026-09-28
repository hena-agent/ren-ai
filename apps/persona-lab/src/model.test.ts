import { expect, it } from "vitest";
import { createSession } from "@ren-ai/persona-engine";
import { liveModel } from "./model.ts";
import { personas } from "./personas.ts";

const harin = personas["harin"]!;
const session = createSession(harin, "test");
const input = { id: "e1", kind: "user", text: "안녕" } as const;
const options = (fetcher: typeof fetch) => ({
  key: "secret",
  endpoint: "http://model.test/v1beta",
  name: "test-model",
  fetcher,
});
const reply = (): Response =>
  Response.json({
    candidates: [
      { content: { parts: [{ text: JSON.stringify({ reply: "안녕", changes: [] }) }] } },
    ],
  });
const fetcher: typeof fetch = async (url, init) => {
  expect(url).toBe("http://model.test/v1beta/models/test-model:generateContent");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({
    "x-goog-api-key": "secret",
    "Content-Type": "application/json",
  });
  expect(init?.body).toContain("하린");
  expect(init?.body).toContain("a real person texting");
  expect(init?.body).toContain("How you text: 짧고 건조하게");
  expect(init?.body).toContain(
    'Lines you might actually send: \\"안녕하세요.\\" / \\"오늘은 좀 바빴어요.\\" / \\"그건 좀 아닌 것 같은데요.\\"',
  );
  expect(init?.body).toContain("Relationship stage: stranger. You have just met.");
  expect(init?.body).toContain("- Send one or two short messages.");
  expect(init?.body).toContain("- Use polite Korean (존댓말) by default.");
  expect(init?.body).toContain('"systemInstruction":{"parts":[{"text":');
  expect(init?.body).toContain(
    '"contents":[{"role":"user","parts":[{"text":"(지금 답장을 보내 주세요)"}]}]',
  );
  expect(init?.body).toContain(
    '"generationConfig":{"responseMimeType":"application/json","temperature":0.9}',
  );
  expect(init?.body).toContain('\\"stage\\":\\"stranger\\"');
  expect(init?.body).toContain('\\"condition\\":{');
  expect(init?.body).toContain('\\"mutable\\":{');
  expect(init?.body).toContain('\\"relationship\\":{');
  expect(init?.body).toContain('\\"traits\\":[');
  return reply();
};
const ok: typeof fetch = async () =>
  Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] });
const failed: typeof fetch = async () => new Response("no", { status: 503 });
const bareFetcher: typeof fetch = async (_url, init) => {
  expect(init?.body).toContain("Write naturally and briefly.");
  expect(init?.body).not.toContain("Lines you might actually send");
  expect(init?.body).not.toContain("Stryker was here!");
  expect(init?.body).not.toContain("undefined");
  return reply();
};
const jiwooFetcher: typeof fetch = async (_url, init) => {
  expect(init?.body).toContain("다정하고 리액션이 많다");
  expect(init?.body).toContain(
    '\\"앗 안녕하세요 ㅎㅎ\\" / \\"오늘 하루는 어땠어요?\\" / \\"헐 진짜요?ㅋㅋ\\"',
  );
  return reply();
};

it("builds a model request and parses its JSON proposal", async () => {
  expect(await liveModel(options(fetcher))(session, input)).toEqual({ reply: "안녕", changes: [] });
});

it("falls back to default texting when a Persona has no voice fields", async () => {
  const bare = structuredClone(harin);
  Reflect.deleteProperty(bare, "speech");
  Reflect.deleteProperty(bare, "samples");
  await expect(
    liveModel(options(bareFetcher))(createSession(bare, "bare"), input),
  ).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
  await expect(
    liveModel(options(jiwooFetcher))(createSession(personas["jiwoo"]!, "jiwoo"), input),
  ).resolves.toEqual({ reply: "안녕", changes: [] });
});

const roleFetcher: typeof fetch = async (_url, init) => {
  expect(init?.body).toContain('{"role":"user","parts":[{"text":"안녕"}]}');
  expect(init?.body).toContain('{"role":"model","parts":[{"text":"네."}]}');
  expect(init?.body).toContain("(생활 사건) 사진전\\n바빠?");
  expect(init?.body).not.toContain("(지금 답장을 보내 주세요)");
  return reply();
};
const capFetcher: typeof fetch = async (_url, init) => {
  expect(init?.body).not.toContain("line000");
  expect(init?.body).toContain("line001");
  expect(init?.body).toContain("line100");
  return reply();
};

const unitFetcher: typeof fetch = async (_url, init) => {
  expect(init?.body).toContain("새 단위");
  expect(init?.body).not.toContain("옛 단위");
  return reply();
};
const withEvent: typeof fetch = async (_url, init) => {
  expect(init?.body).toContain(
    '"role":"user","parts":[{"text":"(최근 실제로 일어난 생활 사건) 사진전 설치를 앞둠',
  );
  expect(init?.body).toContain("(최근 실제로 일어난 생활 사건) 사진전 설치를 앞둠");
  expect(init?.body).toContain("사진은 골랐어요?");
  expect(init?.body).not.toContain("혼자 정리해 볼게요.");
  expect(init?.body).toContain("Life events are facts about your own day");
  return reply();
};
const expired: typeof fetch = async (_url, init) => {
  expect(init?.body).not.toContain("(최근 실제로 일어난 생활 사건) 사진전 설치를 앞둠");
  return reply();
};
const currentEvent: typeof fetch = async (_url, init) => {
  expect(init?.body).not.toContain("(최근 실제로 일어난 생활 사건)");
  expect(init?.body).toContain("(생활 사건) 사진전 설치를 앞둠");
  return reply();
};

it("reads only the events recorded since the current unit boundary", async () => {
  const unit = createSession(harin, "unit");
  unit.events.push(
    { id: "u1", kind: "user", text: "옛 단위" },
    { id: "r1", kind: "reply", text: "네." },
    { id: "u2", kind: "user", text: "새 단위" },
  );
  unit.unitStart = 2;
  await expect(liveModel(options(unitFetcher))(unit, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
});

it("keeps a recent prepared life event available after the conversation unit closes", async () => {
  const first = createSession(harin, "first-event");
  first.events.push(
    { id: "event:harin-exhibit", kind: "life", text: "사진전 설치를 앞둠" },
    { id: "r1", kind: "reply", text: "혼자 정리해 볼게요." },
    { id: "u2", kind: "user", text: "사진은 골랐어요?" },
  );
  first.unitStart = 2;
  await expect(liveModel(options(withEvent))(first, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
  const continued = createSession(harin, "event");
  continued.events.push(
    { id: "u0", kind: "user", text: "이전 대화" },
    { id: "r0", kind: "reply", text: "안녕하세요" },
    { id: "event:harin-exhibit", kind: "life", text: "사진전 설치를 앞둠" },
    { id: "r1", kind: "reply", text: "혼자 정리해 볼게요." },
    { id: "u2", kind: "user", text: "사진은 골랐어요?" },
  );
  continued.unitStart = 4;
  await expect(liveModel(options(withEvent))(continued, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
  continued.unitStart = 2;
  await expect(liveModel(options(currentEvent))(continued, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
  continued.unitStart = 4;
  continued.events.push(
    ...Array.from({ length: 37 }, (_, index) => ({
      id: `late-${index}`,
      kind: "user" as const,
      text: "새 대화",
    })),
  );
  await expect(liveModel(options(withEvent))(continued, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
  continued.events.push({ id: "later", kind: "user", text: "다른 이야기" });
  await expect(liveModel(options(expired))(continued, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
});

it("maps stored events to a role transcript and caps the window at 100", async () => {
  const role = createSession(harin, "role");
  role.events.push(
    { id: "u1", kind: "user", text: "안녕" },
    { id: "r1", kind: "reply", text: "네." },
    { id: "l1", kind: "life", text: "사진전" },
    { id: "u2", kind: "user", text: "바빠?" },
  );
  await expect(liveModel(options(roleFetcher))(role, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
  const capped = createSession(harin, "cap");
  for (let i = 0; i <= 100; i++)
    capped.events.push({
      id: `c${i}`,
      kind: "user",
      text: `line${String(i).padStart(3, "0")}`,
    });
  await expect(liveModel(options(capFetcher))(capped, input)).resolves.toEqual({
    reply: "안녕",
    changes: [],
  });
});

it("rejects unavailable models and malformed provider envelopes", async () => {
  await expect(liveModel({ ...options(ok), key: "" })(session, input)).rejects.toThrow(
    "GEMINI_API_KEY",
  );
  await expect(liveModel(options(failed))(session, input)).rejects.toThrow("503");
  await expect(liveModel(options(ok))(session, input)).rejects.toThrow("Expected");
  for (const [value, error] of [
    [null, "Invalid model response"],
    [3, "Invalid model response"],
    [{}, "Invalid model response"],
    [{ candidates: "bad" }, "Invalid model candidates"],
    [{ candidates: [] }, "Invalid model candidate"],
    [{ candidates: [null] }, "Invalid model candidate"],
    [{ candidates: [{}] }, "Invalid model candidate"],
    [{ candidates: [{ content: null }] }, "Invalid model content"],
    [{ candidates: [{ content: {} }] }, "Invalid model content"],
    [{ candidates: [{ content: "bad" }] }, "Invalid model content"],
    [{ candidates: [{ content: { parts: "bad" } }] }, "Invalid model parts"],
    [{ candidates: [{ content: { parts: [] } }] }, "Invalid model text"],
    [{ candidates: [{ content: { parts: [null] } }] }, "Invalid model text"],
    [{ candidates: [{ content: { parts: [{}] } }] }, "Invalid model text"],
    [{ candidates: [{ content: { parts: ["bad"] } }] }, "Invalid model text"],
    [{ candidates: [{ content: { parts: [{ text: 2 }] } }] }, "Invalid model text"],
  ] as const) {
    const malformed: typeof fetch = async () => Response.json(value);
    await expect(liveModel(options(malformed))(session, input)).rejects.toThrow(error);
  }
});
