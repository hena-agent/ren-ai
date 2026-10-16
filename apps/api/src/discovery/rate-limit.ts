export function submissionLimit() {
  const submissions = new Map<string | undefined, number[]>();
  return (ip: string | undefined, now: number) => {
    const cutoff = now - 3_600_000;
    // Insertion order tracks the latest admitted attempt. Expiry is amortized O(1).
    for (const [key, dates] of submissions) {
      if (dates[dates.length - 1]! > cutoff) break;
      submissions.delete(key);
    }
    const recent = submissions.get(ip);
    if (!recent && submissions.size >= 10_000) return true;
    const active = recent?.filter((date) => date > cutoff) ?? [];
    if (active.length >= 5) return true;
    active.push(now);
    submissions.delete(ip);
    submissions.set(ip, active);
    return false;
  };
}
