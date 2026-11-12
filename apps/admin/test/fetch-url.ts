export function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return "url" in input ? input.url : input.href;
}
