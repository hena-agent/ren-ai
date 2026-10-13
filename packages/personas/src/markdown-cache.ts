export function cacheMarkdown<T>(parse: (markdown: string) => T) {
  const documents = new Map<string, T>();
  return (markdown: string) => {
    if (documents.has(markdown)) return documents.get(markdown)!;
    const result = parse(markdown);
    if (documents.size === 64) documents.delete(documents.keys().next().value!);
    documents.set(markdown, result);
    return result;
  };
}
