import type { PublicPersona } from "@ren-ai/onboarding";

export const publicPersonas: readonly PublicPersona[] = [
  {
    id: "jia",
    name: "백지아",
    age: 26,
    bio: "커피와 산책을 좋아해요.",
    imageUrl: "https://images.example/jia-anime.webp",
    portraits: {
      anime: "https://images.example/jia-anime.webp",
      photo: "https://images.example/jia-photo.webp",
    },
    secondaryPortraits: [{ style: "anime", imageUrl: "https://images.example/jia-walk.webp" }],
    profile: {
      introduction: "햇살 좋은 날엔 같이 걸어요.",
      sections: [{ type: "interests", title: "좋아하는 것", items: ["커피", "산책"] }],
    },
  },
  { id: "subin", name: "한수빈", bio: "반가워요.", imageUrl: "" },
];
