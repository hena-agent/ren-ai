export const executionSnapshot = (revision = "initial") => {
  const description = `You are Sora.
${revision === "initial" ? "" : "Updated character instructions."}

## 공개 프로필

A musician.
`;
  return {
    revision,
    personas: [
      {
        persona: {
          id: "persona1",
          name: "Sora",
          bio: "A musician.",
          imageUrl: "",
          published: true,
          timeZone: "Asia/Seoul",
          language: "ko",
          openingLine: "Say hello",
          memory: "Remember.",
          prompt: description,
          description,
          publicProfile: "A musician.",
        },
        state: `---\nmood: ${revision === "initial" ? 50 : 60}\nenergy: 50\nstress: 50\nconnection: 50\nsolitude: 50\naffection: 50\ntraits: {}\n---\n`,
        memory: `# 현재 생활\n\n${revision} Memory\n`,
      },
    ],
  };
};
