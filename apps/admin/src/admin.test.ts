import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonaStore } from "@ren-ai/personas";
import { Window } from "happy-dom";
import type { HTMLFormElement, HTMLInputElement, HTMLTextAreaElement } from "happy-dom";
import { expect, test } from "vitest";
import { createAdmin } from "./admin.ts";
import copy from "./copy.json";

const authorization = `Basic ${Buffer.from("admin:test-password").toString("base64")}`;
const fields = {
  id: "harin",
  name: "하린",
  bio: "퇴근 후에는 동네를 오래 걸어요.",
  imageUrl: "https://example.com/harin.jpg",
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "번호 받았으니까 먼저 연락해 봐",
  memory: "이름과 함께 나눈 약속을 기억해.",
  prompt: "너는 하린이야. 짧게 한국어로 이야기해.",
};

const request = (path: string, body?: Record<string, string>) =>
  new Request(`http://localhost:3002${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization, origin: "http://localhost:3002" },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });

test("an operator creates, reloads, edits and publishes a persona through the admin form", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-personas-"));
  const window = new Window();
  try {
    const store = await createPersonaStore(root);
    const admin = createAdmin(store, "test-password", "body { color: white; }");
    window.document.write(await (await admin(request("/new"))).text());
    expect(window.document.querySelector("form")?.getAttribute("method")).toBe("post");
    const created = await admin(request("/personas", fields));
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/personas/harin?saved=1");
    const reopened = createAdmin(await createPersonaStore(root), "test-password", "");
    const saved = await reopened(request("/personas/harin?saved=1"));
    expect(saved.status).toBe(200);
    window.document.body.innerHTML = await saved.text();
    expect(window.document.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(
      "하린",
    );
    expect(
      window.document.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')?.value,
    ).toBe("너는 하린이야. 짧게 한국어로 이야기해.");
    expect(window.document.querySelector("output")?.textContent).toContain("저장했습니다");
    const updated = await reopened(
      request("/personas/harin", { ...fields, name: "하린 수정", published: "on" }),
    );
    expect(updated.status).toBe(303);
    const list = await reopened(request("/"));
    window.document.body.innerHTML = await list.text();
    expect(window.document.querySelector(".card-link")?.getAttribute("href")).toBe(
      "/personas/harin",
    );
    expect(window.document.querySelector(".badge")?.className).toBe("badge live");
    expect(window.document.body.textContent).toContain("하린 수정");
    const publicList = await reopened(new Request("http://localhost:3002/api/personas"));
    expect(await publicList.json()).toEqual([
      {
        id: "harin",
        name: "하린 수정",
        bio: "퇴근 후에는 동네를 오래 걸어요.",
        imageUrl: "https://example.com/harin.jpg",
      },
    ]);
    expect((await store.get("harin")).published).toBe(true);
  } finally {
    await window.happyDOM.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the native form is labeled, editable on creation and readonly only for a saved ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-form-"));
  const window = new Window();
  try {
    const store = await createPersonaStore(root);
    const admin = createAdmin(store, "test-password", "test styles");
    const empty = await admin(request("/"));
    const emptyPage = await empty.text();
    expect(empty.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(empty.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(emptyPage).toContain("아직 저장된 페르소나가 없습니다.");
    expect(emptyPage).toMatch(/^<!doctype html>/);
    expect(emptyPage).toContain('aria-current="page"');
    window.document.write(await (await admin(request("/new"))).text());
    const form = window.document.querySelector<HTMLFormElement>("form");
    expect(form?.getAttribute("action")).toBe("/personas");
    const id = window.document.querySelector<HTMLInputElement>("#id");
    expect(id).not.toBeNull();
    expect(id!.readOnly).toBe(false);
    expect(id!.required).toBe(true);
    expect(id!.maxLength).toBe(64);
    expect(id!.pattern).toBe("[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}");
    expect(id!.getAttribute("aria-describedby")).toBe("id-hint");
    expect(window.document.querySelector<HTMLInputElement>("#language")?.value).toBe("ko");
    expect(window.document.querySelector<HTMLInputElement>("#timeZone")?.value).toBe("Asia/Seoul");
    for (const name of ["id", "name", "bio", "imageUrl", "openingLine", "memory", "prompt"]) {
      expect(
        window.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)
          ?.value,
      ).toBe("");
    }
    expect(window.document.querySelector<HTMLInputElement>("#published")?.checked).toBe(false);
    expect(window.document.querySelector<HTMLInputElement>("#name")?.required).toBe(true);
    expect(window.document.querySelector<HTMLInputElement>("#imageUrl")?.required).toBe(false);
    expect(window.document.querySelector('[role="alert"]')).toBeNull();
    expect(window.document.querySelector("output")).toBeNull();
    const expectedLabels = [
      "ID",
      "이름",
      "프로필 이미지 URL",
      "짧은 소개",
      "프로필 공개",
      "언어",
      "시간대",
      "첫 인사 지침",
      "기억 지침",
      "페르소나 프롬프트",
    ];
    expect(
      [...window.document.querySelectorAll("label")].map((label) => label.textContent?.trim()),
    ).toEqual(expectedLabels);
    for (const label of window.document.querySelectorAll("label")) {
      expect(window.document.getElementById(label.getAttribute("for") ?? "")).not.toBeNull();
    }
    for (const [name, value] of Object.entries(fields)) {
      const control = window.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[name="${name}"]`,
      );
      expect(control).not.toBeNull();
      control!.value = value;
    }
    const submitted = Object.fromEntries(new window.FormData(form!).entries());
    const saved = await admin(
      new Request("http://localhost:3002/personas", {
        method: "POST",
        headers: { authorization, origin: "http://localhost:3002" },
        body: new URLSearchParams(
          Object.entries(submitted).map(([key, value]) => [key, String(value)]),
        ),
      }),
    );
    expect(saved.status).toBe(303);
    window.document.body.innerHTML = await (await admin(request("/personas/harin"))).text();
    expect(window.document.querySelector<HTMLInputElement>("#id")?.readOnly).toBe(true);
    expect(window.document.querySelector("form")?.getAttribute("action")).toBe("/personas/harin");
    expect(window.document.querySelector("aside h2")?.textContent).toBe("저장된 카드 미리보기");
    expect(window.document.querySelector(".persona-card img")?.getAttribute("alt")).toBe(
      "하린 프로필",
    );
    expect(window.document.querySelector(".persona-card img")?.getAttribute("src")).toBe(
      "https://example.com/harin.jpg",
    );
    expect(window.document.querySelector(".persona-card h3")?.textContent).toBe("하린");
    expect(window.document.querySelector(".persona-card p")?.textContent).toBe(
      "퇴근 후에는 동네를 오래 걸어요.",
    );
    expect(window.document.querySelector(".badge")?.className).toBe("badge");
    expect(window.document.querySelector("output")).toBeNull();
    expect(window.document.querySelector("header nav [aria-current]")).toBeNull();
    const styles = await admin(request("/style.css"));
    expect(styles.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await styles.text()).toBe("test styles");
  } finally {
    await window.happyDOM.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("authentication and same-origin submission protect every management operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-access-"));
  try {
    const store = await createPersonaStore(root);
    expect(() => createAdmin(store, " ", "")).toThrow("ADMIN_PASSWORD is required");
    const admin = createAdmin(store, "test-password", "");
    for (const path of ["/", "/new", "/style.css", "/personas/harin"]) {
      const denied = await admin(new Request(`http://localhost:3002${path}`));
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBe(
        'Basic realm="Persona Admin", charset="UTF-8"',
      );
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    const wrong = await admin(
      new Request("http://localhost:3002/", { headers: { authorization: "Basic wrong" } }),
    );
    expect(wrong.status).toBe(401);
    const deniedPost = await admin(
      new Request("http://localhost:3002/personas", {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
    );
    expect(deniedPost.status).toBe(401);
    for (const origin of ["https://evil.example", "null", ""]) {
      const blocked = await admin(
        new Request("http://localhost:3002/personas", {
          method: "POST",
          headers: { authorization, origin },
          body: new URLSearchParams(fields),
        }),
      );
      expect(blocked.status).toBe(400);
      expect(await blocked.text()).toContain(copy.originError);
    }
    const method = await admin(
      new Request("http://localhost:3002/", { method: "DELETE", headers: { authorization } }),
    );
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, POST");
    const unsupported = await admin(
      new Request("http://localhost:3002/api/personas", { method: "POST" }),
    );
    expect(unsupported.status).toBe(401);
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation preserves submitted fields, publication can be reversed, and missing pages fail clearly", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-validation-"));
  const window = new Window();
  try {
    const store = await createPersonaStore(root);
    const admin = createAdmin(store, "test-password", "");
    const invalid = await admin(request("/personas", { ...fields, published: "on", imageUrl: "" }));
    expect(invalid.status).toBe(400);
    window.document.write(await invalid.text());
    expect(window.document.querySelector('[role="alert"]')?.textContent).toContain(
      "소개와 프로필 이미지",
    );
    expect(window.document.querySelector<HTMLInputElement>("#name")?.value).toBe("하린");
    expect(window.document.querySelector<HTMLInputElement>("#published")?.checked).toBe(true);
    expect(window.document.querySelector(".image-placeholder")?.textContent).toBe(
      "NO PROFILE IMAGE",
    );
    expect(await store.list()).toEqual([]);
    await admin(request("/personas", { ...fields, published: "on" }));
    const duplicate = await admin(request("/personas", { ...fields, name: "덮어쓰기" }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("이미 사용 중인 ID");
    const mismatch = await admin(request("/personas/harin", { ...fields, id: "changed" }));
    expect(mismatch.status).toBe(400);
    window.document.body.innerHTML = await mismatch.text();
    expect(window.document.body.textContent).toContain("ID는 변경할 수 없습니다");
    expect(window.document.querySelector<HTMLInputElement>("#id")?.value).toBe("harin");
    expect(window.document.querySelector<HTMLInputElement>("#name")?.value).toBe("하린");
    const published = await admin(request("/personas/harin"));
    expect(await published.text()).toContain("LIVE / 공개");
    const withdrawn = await admin(request("/personas/harin", fields));
    expect(withdrawn.status).toBe(303);
    const cards = await admin(new Request("http://localhost:3002/api/personas"));
    expect(cards.headers.get("cache-control")).toBe("no-store");
    expect(await cards.json()).toEqual([]);
    for (const path of [
      "/unknown",
      "/personas",
      "/personas/missing",
      "/personas/harin/extra",
      "/prefix/personas/harin",
    ]) {
      const missing = await admin(request(path));
      expect(missing.status).toBe(404);
      window.document.body.innerHTML = await missing.text();
      expect(window.document.querySelector('[role="alert"]')).not.toBeNull();
      expect(window.document.querySelector(".persona-card")).toBeNull();
      expect(window.document.querySelector("output")).toBeNull();
    }
    for (const path of ["/wrong", "/style.css"]) {
      const unsupported = await admin(request(path, fields));
      expect(unsupported.status).toBe(404);
      expect(await unsupported.text()).not.toContain("persona-card");
    }
    const malformed = await admin(
      new Request("http://localhost:3002/personas", {
        method: "POST",
        headers: {
          authorization,
          origin: "http://localhost:3002",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toContain(copy.formError);
    expect((await store.get("harin")).name).toBe("하린");
  } finally {
    await window.happyDOM.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing fields and file uploads are rejected rather than becoming persona text", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-inputs-"));
  try {
    const store = await createPersonaStore(root);
    const admin = createAdmin(store, "test-password", "");
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.delete("name");
    const missing = await admin(
      new Request("http://localhost:3002/personas", {
        method: "POST",
        headers: { authorization, origin: "http://localhost:3002" },
        body: form,
      }),
    );
    expect(missing.status).toBe(400);
    form.set("name", new File(["not text"], "name.txt"));
    const uploaded = await admin(
      new Request("http://localhost:3002/personas", {
        method: "POST",
        headers: { authorization, origin: "http://localhost:3002" },
        body: form,
      }),
    );
    expect(uploaded.status).toBe(400);
    const body = await uploaded.text();
    expect(body).toContain(copy.formError);
    expect(body).not.toContain("persona-card");
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage outages show a generic error instead of private storage details", async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-outage-"));
  try {
    const store = await createPersonaStore(root);
    const admin = createAdmin(store, "test-password", "");
    await rm(root, { recursive: true });
    for (const path of ["/", "/api/personas"]) {
      const response = await admin(request(path));
      expect(response.status).toBe(503);
      const page = await response.text();
      expect(page).toContain(copy.failure);
      expect(page).not.toContain(root);
      expect(page).not.toContain("ENOENT");
    }
    const save = await admin(request("/personas", fields));
    expect(save.status).toBe(503);
    expect(await save.text()).toContain("하린");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
