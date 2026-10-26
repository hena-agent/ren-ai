import { Schema } from "effect";
import {
  ContactSnapshot,
  ContactSelection,
  ConversationLanguages,
  InvitationSettings,
} from "@ren-ai/onboarding";
import type { SelectContacts, StartContact } from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import { GenerationError, protect, requestId, validationFailure } from "./logging.ts";
import {
  ConversationList,
  ConversationDetail,
  ConversationRuntime,
  ConversationMessages,
} from "@ren-ai/onboarding";
import type {
  ConversationQuery,
  ConversationRecovery,
  ConversationEnding,
} from "@ren-ai/onboarding";

export interface ConversationClient {
  list: (input: typeof ConversationQuery.Type) => Promise<typeof ConversationList.Type>;
  detail: (id: number, registrationsBefore?: string) => Promise<typeof ConversationDetail.Type>;
  runtime: (id: number) => Promise<typeof ConversationRuntime.Type>;
  messages: (id: number, before?: number) => Promise<typeof ConversationMessages.Type>;
  image: (id: number, message: number, guid: string, attachment: number) => Promise<Response>;
  recover: (input: typeof ConversationRecovery.Type) => Promise<void>;
  end: (input: typeof ConversationEnding.Type) => Promise<void>;
}

export interface ManagementClient {
  conversations?: ConversationClient;
  list: () => Promise<typeof ContactSnapshot.Type>;
  select: (input: typeof SelectContacts.Type) => Promise<typeof ContactSelection.Type>;
  start: (input: typeof StartContact.Type) => Promise<typeof ContactSelection.Type>;
  refreshCatalog: () => Promise<void>;
  languages: (registrationID: string) => Promise<typeof ConversationLanguages.Type>;
  configureInvitations: (input: typeof InvitationSettings.Type) => Promise<void>;
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

const conflictMessage = (path: string) =>
  path.includes("/conversations")
    ? "종료·전송 상태가 변경되었거나 결과가 아직 불확실합니다. 상태를 다시 확인해 주세요."
    : path.endsWith("/start")
      ? "이 테스트 연락처는 지금 고른 페르소나로 시작할 수 없습니다. 배정 한도 5명과 이 연락처의 관계 종료 이력·현재 상태를 확인해 주세요."
      : "선정 요청이나 배정 후보가 변경되었습니다. 배정 한도 5명과 각 연락처의 관계 종료 이력·현재 상태, 배정할 수 없는 Like 후보가 있는지 확인해 주세요. 상태를 새로고침한 뒤 새 요청으로 제출해 주세요.";

export function managementClient(
  url: string,
  token: string,
  fetcher: typeof fetch = fetch,
): ManagementClient {
  const request = async (
    path: string,
    input?:
      | typeof SelectContacts.Type
      | typeof StartContact.Type
      | typeof ConversationRecovery.Type
      | typeof ConversationEnding.Type
      | typeof InvitationSettings.Type,
    method = input ? "POST" : "GET",
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
        method,
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
    if (response.status === 409) throw new PersonaError("conflict", conflictMessage(path));
    if (
      response.status === 404 &&
      (path.startsWith("/management/conversations/") || path.startsWith("/operator/message-image?"))
    )
      throw new PersonaError("not_found", "대화를 찾을 수 없습니다.");
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
    conversations: {
      image: (id, message, guid, attachment) =>
        request(
          `/operator/message-image?${new URLSearchParams({ id: String(id), message: String(message), guid, attachment: String(attachment) })}`,
        ),
      messages: async (id, before) =>
        conversationResponse(
          ConversationMessages,
          await request(
            `/operator/messages?id=${id}${before === undefined ? "" : `&before=${before}`}`,
          ),
        ),
      list: async (input) => {
        const params = new URLSearchParams({ filter: input.filter, search: input.search });
        if (input.before !== undefined) params.set("before", String(input.before));
        return conversationResponse(
          ConversationList,
          await request(`/management/conversations?${params}`),
        );
      },
      detail: async (id, registrationsBefore) =>
        conversationResponse(
          ConversationDetail,
          await request(
            `/management/conversations/${id}${registrationsBefore ? `?registrationsBefore=${encodeURIComponent(registrationsBefore)}` : ""}`,
          ),
        ),
      runtime: async (id) =>
        conversationResponse(
          ConversationRuntime,
          await request(`/operator/conversations?id=${id}`),
        ),
      recover: async (input) => {
        await request("/operator/conversations", input);
      },
      end: async (input) => {
        await request(`/management/conversations/${input.id}/end`, input);
      },
    },
    languages: async (registrationID) => {
      const response = await request(
        `/operator/languages?registrationID=${encodeURIComponent(registrationID)}`,
      );
      try {
        return Schema.decodeUnknownSync(ConversationLanguages)(await response.json());
      } catch (cause) {
        throw validationFailure(
          "현재 언어 실력 응답이 올바르지 않습니다.",
          { code: "management_schema" },
          cause,
        );
      }
    },
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
          input.assignments
            ? "/management/discovery/select-assigned"
            : input.registrationIDs
              ? "/management/discovery/select-specific"
              : "/management/discovery/select",
          input,
        ),
      ),
    start: async (input) => selection(await request("/management/discovery/start", input)),
    refreshCatalog: async () => {
      await request("/management/catalog/refresh", undefined, "POST");
    },
    configureInvitations: async (input) => {
      await request("/management/discovery/invitations", input);
    },
  };
}

async function conversationResponse<A>(schema: Schema.Codec<A>, response: Response): Promise<A> {
  try {
    return Schema.decodeUnknownSync(schema)(await response.json());
  } catch (cause) {
    throw validationFailure(
      "대화 상태 응답 형식이 올바르지 않습니다.",
      { code: "management_schema" },
      cause,
    );
  }
}
