export const executionSnapshot = (revision = "initial") => ({
  revision,
  personas: [
    {
      id: "persona1",
      source: `---
name: Sora
published: true
time-zone: Asia/Seoul
language: ko
opening-line: Say hello
memory: Remember.
---
You are Sora.

## 공개 프로필

A musician.
`,
      state: `---\nmood: ${revision === "initial" ? 50 : 60}\nenergy: 50\nstress: 50\nconnection: 50\nsolitude: 50\naffection: 50\ntraits: {}\n---\n`,
      memory: `# 현재 생활\n\n${revision} Memory\n`,
    },
  ],
});
