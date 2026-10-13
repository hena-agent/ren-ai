---
status: accepted
---

# Conversations own current State and two-tier Memory

The operator wants Personas to consult and update their current condition and memories, including
context-sensitive randomness and forgetting. The previous state/memory design proposed shared Persona
life plus per-user memories. The operator selected independent runtime State and Memory per Conversation.

## Decision

- Persona identity and authoring initial values remain Catalog-owned. A new Conversation starts from
  those values; runtime updates never change another Conversation or reset on Catalog refresh.
- Short-term Memory holds current life, relevant facts and unfinished plans and is supplied every run.
  Long-term Memory stores selected lasting facts and experiences and is searched on demand.
- Current State keeps the five established axes and supports meaningful additional scalar values.
  New values carry meanings and evidence instead of imposing a numeric axis on every condition.
- Starting affection is proposed from the Persona's disposition, relationship views and contact expectations,
  and edited by the operator in initial State. A new Conversation copies that value into its current affection.
  Later Catalog edits never reset existing affection or fill an unspecified existing value. Affection is
  positive interest, not familiarity, trust, dating intent or an action probability; uncertain experiences
  may change it using dice, but it is not rerolled each turn.
- Persona-authored probabilities and the existing dice tool govern uncertain choices. Dice results and
  memory mutations have durable replay receipts; completed choices are not rerolled after interruption.
- Long-term records can become faded or forgotten. Fading retains only the remaining gist; forgetting
  removes content from current recall. These changes update short-term Memory in the same commit.
  Conversation history and previous storage revisions remain operational records, not current recall.
- One private revision snapshot owns the current documents and replay receipts. An atomic pointer
  publishes the revision; root Markdown files are views. Native export/restore includes the runtime snapshot.
- OpenCode checkpoint summaries supplement the real history. They do not replace file Memory, and current
  State and memory clarity override stale summaries and search results.

## Trade-offs

Shared Persona life would make events visible across relationships but requires cross-Conversation
coordination and distinct provenance rules. Independent copies give a clear boundary and preserve the
existing lifelong session/reset model. A future shared-life product decision would require an explicit redesign.

Keeping only OpenCode summaries would make selective retrieval and forgetting indistinguishable from
transcript compression. Explicit short/long-term Memory supports both without discarding the actual history.
Immutable revisions keep paired changes and receipts coherent without introducing another database.
