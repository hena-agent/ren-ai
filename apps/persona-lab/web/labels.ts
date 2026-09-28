export const labels: Record<string, string> = {
  autonomy: "자율성",
  sociability: "사교성",
  initiative: "연락 주도성",
  sensitivity: "감수성",
  expression: "감정 표현성",
  novelty: "새로움 선호",
  mood: "기분",
  energy: "활력",
  stress: "스트레스",
  connection: "교류 욕구",
  solitude: "혼자 있을 욕구",
  familiarity: "친숙함",
  trust: "신뢰",
  affection: "호감",
  disappointment: "서운함",
  stage: "관계 단계",
  openness: "자기 개방",
  guardedness: "방어적 태도",
};

export const stageLabels: Record<string, string> = {
  stranger: "초면",
  acquaintance: "알아가기",
  familiar: "친숙함",
  flirting: "썸",
  dating: "연애",
  ended: "종료",
};

export const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
