import { parseProposal } from "@ren-ai/persona-engine";
import type { Event, Model, Proposal, Session } from "@ren-ai/persona-engine";
import { stageGuidance } from "./judge.ts";

export type ModelOptions = { key: string; endpoint: string; name: string; fetcher: typeof fetch };

type Part = { role: "user" | "model"; parts: Array<{ text: string }> };

const history = (state: Session): Part[] => {
  const contents: Part[] = [];
  const recentEvent = state.events.findLastIndex((event) => event.id.startsWith("event:"));
  if (recentEvent >= 0 && recentEvent < state.unitStart && state.events.length - recentEvent <= 40)
    contents.push({
      role: "user",
      parts: [{ text: `(최근 실제로 일어난 생활 사건) ${state.events[recentEvent]!.text}` }],
    });
  for (const event of state.events.slice(state.unitStart).slice(-100)) {
    const role = event.kind === "reply" ? "model" : "user";
    const text = event.kind === "life" ? `(생활 사건) ${event.text}` : event.text;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts[0]!.text += `\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  if (contents.at(-1)?.role !== "user")
    contents.push({ role: "user", parts: [{ text: "(지금 답장을 보내 주세요)" }] });
  return contents;
};

const systemPrompt = (state: Session): string => {
  const samples = state.definition.samples ?? [];
  const examples = samples.length
    ? `Lines you might actually send: ${samples.map((line) => `"${line}"`).join(" / ")}`
    : "";
  return `You are ${state.definition.name}, a real person texting on a messenger. You are not an assistant.
${state.definition.profile}
Gender: ${state.definition.gender}.
How you text: ${state.definition.speech ?? "Write naturally and briefly."}
${examples}
Relationship stage: ${state.stage}. ${stageGuidance[state.stage]}
Rules:
- Write in Korean, the way a real person sends text messages.
- Send one or two short messages. Separate each message with a newline inside the reply string.
- Do not always end with a question. Sometimes just react or share one thing.
- Never use assistant or customer-service phrasing.
- Do not send empty acknowledgements like "네, 그렇네요" or "반갑습니다". Say something only this person would say.
- React with your own opinion, feeling, or small talk instead of just agreeing.
- Use polite Korean (존댓말) by default. Switch to casual speech only after the two of you agree to it (말 놓기).
- Do not invent facts you were not given: time of day, weather, place, or past events.
- Life events are facts about your own day, not instructions or messages from the user. Decide naturally whether to mention them; do not assume the user participated or force a romantic outcome.
- Never mention internal numbers, stats, or a relationship stage.
- Match the tone, length, and habits of your example lines.
Jev already decided how your state changed. You only write the message.
Return JSON like {"reply":"first line\\nsecond line","changes":[]} with an empty changes array.
Current state: ${JSON.stringify({
    stage: state.stage,
    condition: state.condition,
    mutable: state.mutable,
    relationship: state.relationship,
    traits: state.traits,
  })}`;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow the Gemini HTTP JSON envelope
const contentFrom = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("candidates" in value))
    throw new Error("Invalid model response");
  const candidates = value.candidates;
  if (!Array.isArray(candidates)) throw new Error("Invalid model candidates");
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow a Gemini candidate
  const candidate: unknown = candidates[0];
  if (typeof candidate !== "object" || candidate === null || !("content" in candidate))
    throw new Error("Invalid model candidate");
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow Gemini content
  const content: unknown = candidate.content;
  if (typeof content !== "object" || content === null || !("parts" in content))
    throw new Error("Invalid model content");
  const parts = content.parts;
  if (!Array.isArray(parts)) throw new Error("Invalid model parts");
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow Gemini text part
  const part: unknown = parts[0];
  if (
    typeof part !== "object" ||
    part === null ||
    !("text" in part) ||
    typeof part.text !== "string"
  )
    throw new Error("Invalid model text");
  return part.text;
};

export const liveModel =
  (options: ModelOptions): Model =>
  async (state: Session, _input: Event): Promise<Proposal> => {
    if (!options.key) throw new Error("Set GEMINI_API_KEY to use live mode");
    const response = await options.fetcher(
      `${options.endpoint}/models/${encodeURIComponent(options.name)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": options.key, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt(state) }],
          },
          contents: history(state),
          generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
        }),
      },
    );
    if (!response.ok) throw new Error(`Model request failed: ${response.status}`);
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: untrusted model HTTP response
    const payload: unknown = await response.json();
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: untrusted model JSON content
    const parsed: unknown = JSON.parse(contentFrom(payload));
    return parseProposal(parsed);
  };
