export function submissionLimit() {
  const submissions = new Map<string | undefined, number[]>();
  return (ip: string | undefined, now: number) => {
    const recent = submissions.get(ip);
    if (!recent) {
      submissions.set(ip, [now]);
      return false;
    }
    const active = recent.filter((date) => date > now - 3_600_000);
    active.push(now);
    submissions.set(ip, active);
    return active.length > 5;
  };
}
