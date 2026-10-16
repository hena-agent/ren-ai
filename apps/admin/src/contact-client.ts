import { Schema } from "effect";
import { ContactSnapshot, ContactSelection } from "@ren-ai/onboarding";
import type { SelectContacts, StartContact } from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import { GenerationError, protect, requestId, validationFailure } from "./logging.ts";

export interface ManagementClient {
  list: () => Promise<typeof ContactSnapshot.Type>;
  select: (input: typeof SelectContacts.Type) => Promise<typeof ContactSelection.Type>;
  start: (input: typeof StartContact.Type) => Promise<typeof ContactSelection.Type>;
}

async function selection(response: Response) {
  try {
    return Schema.decodeUnknownSync(ContactSelection)(await response.json());
  } catch (cause) {
    throw validationFailure(
      "선정 응답 형식이 올바르지 않습니다. 같은 요청으로 다시 확인해 주세요.",
      { code: "management_schema" },
      cause,
    );
  }
}

export function managementClient(
  url: string,
  token: string,
  fetcher: typeof fetch = fetch,
): ManagementClient {
  const request = async (
    path: string,
    input?: typeof SelectContacts.Type | typeof StartContact.Type,
  ) => {
    protect(token);
    if (!url || !token)
      throw new GenerationError("메시징 API 연결 설정이 필요합니다.", {
        code: "management_unconfigured",
      });
    const base = new URL(url);
    if (
      base.username ||
      base.password ||
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))
    )
      throw new GenerationError("메시징 API 주소 설정을 확인해 주세요.", {
        code: "management_url",
      });
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method: input ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Operation-ID": requestId(),
          ...(input && { "Content-Type": "application/json" }),
        },
        ...(input && { body: JSON.stringify(input) }),
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
      });
    } catch (cause) {
      throw validationFailure(
        "메시징 API에 연결할 수 없습니다. 같은 요청으로 다시 시도해 주세요.",
        { stage: "management.request", code: "management_transport" },
        cause,
      );
    }
    if (response.status === 409)
      throw new PersonaError(
        "conflict",
        "이 테스트 연락처는 지금 고른 페르소나로 시작할 수 없습니다. 상태를 새로고침해 확인해 주세요.",
      );
    if (!response.ok) {
      const upstream = response.headers.get("x-request-id");
      const operationId =
        upstream && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(upstream)
          ? upstream
          : "unavailable";
      throw new GenerationError(
        "메시징 API 요청이 실패했습니다. 연결 설정과 요청 ID를 확인해 주세요.",
        { status: response.status, code: "management_response", operationId },
      );
    }
    return response;
  };
  return {
    list: async () => {
      const response = await request("/management/discovery");
      try {
        return Schema.decodeUnknownSync(ContactSnapshot)(await response.json());
      } catch (cause) {
        throw validationFailure(
          "대기자 응답 형식이 올바르지 않습니다.",
          { code: "management_schema" },
          cause,
        );
      }
    },
    select: async (input) =>
      selection(
        await request(
          input.registrationIDs
            ? "/management/discovery/select-specific"
            : "/management/discovery/select",
          input,
        ),
      ),
    start: async (input) => selection(await request("/management/discovery/start", input)),
  };
}
