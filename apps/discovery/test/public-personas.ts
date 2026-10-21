import type { PublicPersona } from "@ren-ai/onboarding";

export const publicPersonas: readonly PublicPersona[] = [
  {
    id: "jia",
    name: "백지아",
    age: 26,
    bio: "커피와 산책을 좋아해요.",
    imageUrl: "https://persona-images.renai.im/00000000-0000-0000-0000-000000000001.jpg",
    portraits: {
      anime: "https://persona-images.renai.im/00000000-0000-0000-0000-000000000001.jpg",
      photo: "https://persona-images.renai.im/00000000-0000-0000-0000-000000000002.jpg",
    },
    secondaryPortraits: [
      {
        style: "anime",
        imageUrl: "https://persona-images.renai.im/00000000-0000-0000-0000-000000000003.jpg",
      },
    ],
    profile: {
      introduction: "햇살 좋은 날엔 같이 걸어요.",
      sections: [{ type: "interests", title: "좋아하는 것", items: ["커피", "산책"] }],
    },
  },
  { id: "subin", name: "한수빈", bio: "반가워요.", imageUrl: "" },
];
