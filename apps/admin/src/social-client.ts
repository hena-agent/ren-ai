import { Schema } from "effect";
import { SocialSnapshot, type SocialAccount } from "@ren-ai/onboarding/social";
import { GenerationError, protect, requestId, validationFailure } from "./logging.ts";

export interface SocialClient {
  list: (before?: number) => Promise<SocialSnapshot>;
  configure: (account: SocialAccount) => Promise<SocialSnapshot>;
  operate: (action: "open" | "now", accountId: string) => Promise<void>;
}
const snapshot = async (response: Response) => {
  try {
    return Schema.decodeUnknownSync(SocialSnapshot)(await response.json());
  } catch (cause) {
    throw validationFailure(
      "소셜 응답 형식이 올바르지 않습니다.",
      { code: "social_schema" },
      cause,
    );
  }
};
export function socialClient(origin: string, token: string, fetcher: typeof fetch): SocialClient {
  const request = async (path: string, input?: object) => {
    protect(token);
    if (!origin || !token)
      throw new GenerationError("소셜 API 연결 설정이 필요합니다.", {
        code: "social_unconfigured",
      });
    const base = new URL(origin);
    if (
      base.username ||
      base.password ||
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))
    )
      throw new GenerationError("소셜 API 주소를 확인해 주세요.", { code: "social_url" });
    let response: Response;
    try {
      response = await fetcher(new URL(`/management/social${path}`, base), {
        method: input ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Operation-ID": requestId(),
        },
        ...(input && { body: JSON.stringify(input) }),
        signal: AbortSignal.timeout(20000),
        redirect: "manual",
      });
    } catch (cause) {
      throw validationFailure(
        "소셜 API에 연결할 수 없습니다.",
        { code: "social_transport" },
        cause,
      );
    }
    if (!response.ok)
      throw new GenerationError(
        response.status === 409
          ? "실행 상태나 초대 코드가 변경되었습니다. 새로고침 후 확인해 주세요."
          : "소셜 요청에 실패했습니다. 연결 설정과 입력값을 확인해 주세요.",
        { code: "social_response", status: response.status },
      );
    return response;
  };
  return {
    list: async (before) =>
      snapshot(await request(before === undefined ? "" : `?before=${before}`)),
    configure: async (account) => snapshot(await request("/accounts", account)),
    operate: async (action, accountId) => {
      await request(`/${action}`, { accountId });
    },
  };
}
