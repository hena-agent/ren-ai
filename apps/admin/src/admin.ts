import { createHash, timingSafeEqual } from "node:crypto";
import { decodePersona, PersonaError } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord } from "@ren-ai/personas";
import { emptyPersona, renderPage } from "./page.tsx";
import copy from "./copy.json";

const html = (page: string, status = 200) =>
  new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self'; img-src https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });

function readForm(form: FormData): PersonaRecord {
  const fields = Object.fromEntries(
    Object.keys(emptyPersona).map((name) => {
      const value = form.get(name);
      if (value !== null && typeof value !== "string") {
        throw new PersonaError("invalid", copy.formError);
      }
      return [name, value ?? ""];
    }),
  );
  return { ...emptyPersona, ...fields, published: form.get("published") === "on" };
}

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow request and storage failures before rendering a response
function failure(error: unknown, record?: PersonaRecord, editing?: boolean) {
  const status =
    error instanceof PersonaError
      ? { invalid: 400, not_found: 404, conflict: 409 }[error.kind]
      : 503;
  return html(
    renderPage({
      personas: [],
      record,
      editing,
      error: error instanceof PersonaError ? error.message : copy.failure,
    }),
    status,
  );
}

export function createAdmin(
  store: Awaited<ReturnType<typeof createPersonaStore>>,
  password: string,
  stylesheet: string,
) {
  if (!password.trim()) throw new Error("ADMIN_PASSWORD is required");
  const expected = createHash("sha256")
    .update(`Basic ${Buffer.from(`admin:${password}`).toString("base64")}`)
    .digest();
  const submit = async (request: Request, url: URL, id: string | undefined) => {
    let record: PersonaRecord | undefined;
    try {
      if (request.headers.get("origin") !== url.origin)
        throw new PersonaError("invalid", copy.originError);
      if (url.pathname !== "/personas" && !id)
        return html(renderPage({ personas: [], error: copy.notFound }), 404);
      const form = await request.formData().catch(() => {
        throw new PersonaError("invalid", copy.formError);
      });
      record = readForm(form);
      if (id && record.id !== id) {
        record = { ...record, id };
        throw new PersonaError("invalid", copy.identityError);
      }
      const persona = decodePersona(record);
      if (id) await store.update(persona);
      else await store.create(persona);
      return new Response(null, {
        status: 303,
        headers: { Location: `/personas/${persona.id}?saved=1` },
      });
    } catch (error) {
      return failure(error, record, Boolean(id));
    }
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/personas") {
        return Response.json(await store.publicList(), {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const authorization = request.headers.get("authorization");
      if (
        !authorization ||
        !timingSafeEqual(createHash("sha256").update(authorization).digest(), expected)
      ) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Persona Admin", charset="UTF-8"',
            "Cache-Control": "no-store",
          },
        });
      }
      if (request.method !== "GET" && request.method !== "POST")
        return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
      if (request.method === "GET" && url.pathname === "/style.css") {
        return new Response(stylesheet, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      }
      const match = /^\/personas\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (request.method === "POST") return submit(request, url, match?.[1]);
      let record: PersonaRecord | undefined;
      if (match) record = await store.get(match[1]!);
      else if (url.pathname === "/new") record = emptyPersona;
      else if (url.pathname !== "/")
        return html(renderPage({ personas: [], error: copy.notFound }), 404);
      return html(
        renderPage({
          personas: await store.list(),
          record,
          editing: Boolean(match),
          saved: url.searchParams.get("saved") === "1",
        }),
      );
    } catch (error) {
      return failure(error);
    }
  };
}
