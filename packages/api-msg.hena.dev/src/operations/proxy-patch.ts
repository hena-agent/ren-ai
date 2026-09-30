/** Patch only the reviewed cookie proxy shape; unfamiliar user edits fail closed. */
export const patchProxy = (source: string): string => {
  const changes = [
    [
      '  headers.set("authorization", basicAuthHeader());',
      '  headers.set("authorization", req.headers.get("authorization") ?? basicAuthHeader());',
    ],
    [
      "if (resp.status === 401 && !retried)",
      'if (resp.status === 401 && !retried && !req.headers.has("authorization"))',
    ],
    ["type WSData = { target: string;", "type WSData = { authorization: string; target: string;"],
    [
      "const authed = verifyToken(cookies[COOKIE_NAME]);",
      'const authed = /^Basic /i.test(req.headers.get("authorization") ?? "") || verifyToken(cookies[COOKIE_NAME]);',
    ],
    [
      "data: { target: url.pathname + url.search, queue: [] }",
      'data: { authorization: req.headers.get("authorization") ?? basicAuthHeader(), target: url.pathname + url.search, queue: [] }',
    ],
    [
      "headers: { Authorization: basicAuthHeader() }",
      "headers: { Authorization: ws.data.authorization }",
    ],
  ];
  let result = source;
  for (const [before, after] of changes) {
    if (result.split(before!).length !== 2)
      throw new Error(`Unrecognized or already patched proxy: ${before}`);
    result = result.replace(before!, after!);
  }
  return result;
};
