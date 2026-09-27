# Tests run a real OpenCode host with OpenCode's scripted model

The server's tests don't fake OpenCode. They run the same in-process host the server assembles, on an in-memory database, with throwaway XDG folders and the network blocked. OpenCode's own scripted model, `TestLLM` from `@opencode/ai/testing`, plays the persona. So the imsg plugin's tools and hooks, the deny-all set on each session, prompt IDs derived from iMessage GUIDs, and session removal are all tested through OpenCode itself. An OpenCode upgrade that breaks the host therefore fails CI, which ADR-0004 relies on. A probe confirmed that this works under Vitest 5 on Node 24, on macOS and on Linux x64. There, a host starts in 30–120 ms and one turn takes 0.2–0.5 s.

## Considered Options

- **An OpenCode interface of our own, backed by a fake.** The tools and hooks would be tested as plain functions, and the host assembly would sit under a coverage exception. Tests would be faster, but nothing would check the wiring, and an upgrade could break it unnoticed.

## Consequences

- The only fakes we write are for iMessage and for Messages' UI. Everything else outside the process is swapped out through Effect's own services.
- Each test that touches OpenCode costs a fraction of a second, which makes mutation runs longer. If CI gets slow, mutation testing moves to its own job, run only on changed code for pull requests.
- OpenCode's plugins for local model servers (Ollama, LM Studio, vLLM) poll 127.0.0.1 every 30 seconds. The host turns them off, and tests block the network as well.
