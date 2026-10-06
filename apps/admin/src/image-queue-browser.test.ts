import { afterEach, expect, test, vi } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { watchImageQueue, submitImageForm } from "./image-queue-browser.ts";
import { bindPending } from "./pending.ts";
import copy from "./copy.json";

useBrowser();
afterEach(() => {
  vi.useRealTimers();
});

const queuePage = (active: boolean, state: string, draft: string, images: string) =>
  `<section data-image-job="batch" data-job-active="${active}"><div data-image-progress><output data-queue-status>${state}</output></div></section><form id="persona-editor"><input name="draft" value="${draft}"><output data-pending></output></form><aside>${images}</aside>`;

test("polling updates each completed photo and signed preview while keeping the existing locked editor in place", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = queuePage(true, "waiting", "old", "");
  const form = document.querySelector("form")!;
  const response = queuePage(
    true,
    "saving",
    "partial",
    '<img src="/images/completed.jpg" alt="completed">',
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(response));
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/image-jobs/batch");
  expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "X-Image-Queue": "1" });
  expect(document.querySelector("form")).toBe(form);
  expect(document.querySelector<HTMLImageElement>("aside img")?.getAttribute("src")).toBe(
    "/images/completed.jpg",
  );
  expect(document.querySelector<HTMLInputElement>('[name="draft"]')?.value).toBe("partial");
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe("saving");
  fetcher.mockResolvedValue(new Response(queuePage(false, "completed", "final", "saved")));
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("form")).not.toBe(form);
  expect(document.querySelector<HTMLInputElement>('[name="draft"]')?.value).toBe("final");
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("unchanged progress avoids replacing preview nodes and a transport failure leaves a visible recovery message", async () => {
  vi.useFakeTimers();
  const markup = queuePage(true, "waiting", "old", "unchanged");
  document.body.innerHTML = markup;
  const preview = document.querySelector("aside")!;
  const child = preview.firstChild;
  const status = document.querySelector("[data-queue-status]");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(markup));
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("aside")).toBe(preview);
  expect(preview.firstChild).toBe(child);
  expect(document.querySelector("[data-queue-status]")).toBe(status);
  fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe(
    copy.queueConnectionFailure,
  );
  document.body.innerHTML = "";
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("confirmed image submissions use the queue header and transport failures allow a same-target retry", async () => {
  document.body.innerHTML =
    '<form action="/personas" data-generating="Generating"><input name="draft" value="private signed draft"><button value="generate" name="intent">Generate</button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  const button = form.querySelector("button")!;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(new Response(queuePage(false, "done", "new", "preview")));
  vi.stubGlobal("fetch", fetcher);
  const history = vi.spyOn(document.defaultView!.history, "replaceState");
  bindPending(form, submitImageForm);
  form.requestSubmit(button);
  await vi.waitFor(() =>
    expect(form.querySelector("output")?.textContent).toBe(copy.queueConnectionFailure),
  );
  expect(form.hasAttribute("aria-busy")).toBe(false);
  form.requestSubmit(button);
  await vi.waitFor(() =>
    expect(document.querySelector("[data-queue-status]")?.textContent).toBe("done"),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Image-Queue": "1" });
  const firstId = new Headers(fetcher.mock.calls[0]![1]!.headers).get("X-Image-Request");
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get("X-Image-Request")).toBe(firstId);
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
  expect(history).not.toHaveBeenCalled();
});

test("a target-specific form action is respected and the job URL becomes the reloadable browser location", async () => {
  document.body.innerHTML =
    '<form action="/personas"><button formaction="/image-jobs/batch/retry?image=0">Retry</button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  const response = new Response(queuePage(false, "done", "new", "preview"));
  Object.defineProperty(response, "url", { value: "/image-jobs/batch" });
  const history = vi.spyOn(document.defaultView!.history, "replaceState");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  submitImageForm(form, form.querySelector("button"));
  await vi.waitFor(() => expect(history).toHaveBeenCalledWith(null, "", "/image-jobs/batch"));
  expect(fetcher.mock.calls[0]?.[0]).toBe("/image-jobs/batch/retry?image=0");
});

test("queued pages focus the progress title, keep polling after installation, and rebind image actions on the finished page", async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<form action="/personas"><button value="generate" name="intent">Generate</button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  const running = queuePage(true, "running", "current", "preview").replace(
    "<div data-image-progress>",
    '<h2 id="image-queue-title" tabindex="-1">Progress</h2><div data-image-progress>',
  );
  const completed = queuePage(false, "completed", "final", "preview").replace(
    '<input name="draft"',
    '<button value="regenerate" name="intent">Again</button><input name="draft"',
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(running))
    .mockResolvedValueOnce(new Response(completed))
    .mockResolvedValue(new Response(queuePage(false, "retried", "new", "preview")));
  vi.stubGlobal("fetch", fetcher);
  const focus = vi.spyOn(document.defaultView!.HTMLElement.prototype, "focus");
  const scroll = vi.spyOn(document.defaultView!.HTMLElement.prototype, "scrollIntoView");
  submitImageForm(form, form.querySelector("button"));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.activeElement?.id).toBe("image-queue-title");
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(scroll).toHaveBeenCalledWith({ block: "start" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe("completed");
  const next = document.querySelector("form")!;
  const event = new SubmitEvent("submit", {
    cancelable: true,
    submitter: next.querySelector("button")!,
  });
  next.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe("retried");
});

test("a legacy finished page without queue markup is installable, and button-less image transport uses the form action", async () => {
  document.body.innerHTML = '<form action="/personas"><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("<main>Completed legacy response</main>"));
  vi.stubGlobal("fetch", fetcher);
  submitImageForm(form, null);
  await vi.waitFor(() =>
    expect(document.querySelector("main")?.textContent).toBe("Completed legacy response"),
  );
  expect(form.querySelector("output")?.textContent).toBe("");
  expect(fetcher.mock.calls[0]?.[0]).toBe(form.action);
});

test("a successful polling response without queue markup replaces the page rather than leaving stale progress", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = queuePage(true, "running", "old", "preview");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("<main>Legacy recovery page</main>"));
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("main")?.textContent).toBe("Legacy recovery page");
  expect(document.querySelector("[data-image-job]")).toBeNull();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const promptPage = (active: boolean, token: string, maximum: string) =>
  queuePage(active, "progress", token, "photo").replace(
    "<output data-pending>",
    `<div data-add-images><button data-image-maximum="${maximum}">Add</button></div><dialog data-portrait-dialog><textarea></textarea><select><option value="1">One</option><option value="2">Two</option></select></dialog><output data-pending>`,
  );

test("polling keeps the operator's open prompt and selection even when the last queued photo finishes", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = promptPage(true, "before", "5");
  const form = document.querySelector("form")!;
  const dialog = document.querySelector("dialog")!;
  const prompt = dialog.querySelector("textarea")!;
  const count = dialog.querySelector("select")!;
  dialog.showModal();
  prompt.value = "a private next-photo direction";
  count.value = "2";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(promptPage(false, "completed", "4")));
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("form")).toBe(form);
  expect(dialog.open).toBe(true);
  expect(prompt.value).toBe("a private next-photo direction");
  expect(count.value).toBe("2");
  expect(form.querySelector<HTMLInputElement>('[name="draft"]')!.value).toBe("completed");
  expect(form.querySelector("[data-image-maximum]")!.getAttribute("data-image-maximum")).toBe("5");
  dialog.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("form")).not.toBe(form);
  expect(document.querySelector("[data-image-maximum]")!.getAttribute("data-image-maximum")).toBe(
    "4",
  );
});

test("an options dialog on a page without a registered job never starts background polling", async () => {
  vi.useFakeTimers();
  document.body.innerHTML =
    "<dialog data-portrait-dialog open><textarea>Unsubmitted</textarea></dialog>";
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetcher).not.toHaveBeenCalled();
});

test("a registration acknowledgement keeps the active editor reusable and ignores an older in-flight poll", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = queuePage(true, "first", "original", "old image");
  const form = document.querySelector("form")!;
  form.innerHTML +=
    '<button name="intent" value="subportrait">Add another</button><div data-add-images>old capacity</div>';
  bindPending(form, submitImageForm);
  const { deferred } = await import("../test/queue.ts");
  const oldPoll = deferred<Response>();
  const accepted = queuePage(true, "next queued", "current", "updated image").replace(
    "<output data-pending>",
    "<div data-add-images>new capacity</div><output data-pending>",
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(oldPoll.promise)
    .mockImplementation(async () => new Response(accepted));
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(1000);
  form.requestSubmit(form.querySelector("button"));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("form")).toBe(form);
  expect(form.hasAttribute("aria-busy")).toBe(false);
  expect(document.querySelector("[data-queue-status]")!.textContent).toBe("next queued");
  expect(form.querySelector("[data-add-images]")!.textContent).toBe("new capacity");
  const capacityNode = form.querySelector("[data-add-images]")!.firstChild;
  oldPoll.resolve(new Response(queuePage(false, "obsolete", "stale", "old image")));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("form")).toBe(form);
  expect(form.querySelector<HTMLInputElement>('[name="draft"]')!.value).toBe("current");
  form.requestSubmit(form.querySelector("button"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(form.querySelector("[data-add-images]")!.firstChild).toBe(capacityNode);
  expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get("X-Image-Request")).not.toBe(
    new Headers(fetcher.mock.calls[2]![1]!.headers).get("X-Image-Request"),
  );
});

test("registration pauses a scheduled poll until its acknowledgement, without issuing a second request", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = queuePage(true, "running", "old", "photo");
  const form = document.querySelector("form")!;
  const { deferred } = await import("../test/queue.ts");
  const registration = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>().mockReturnValue(registration.promise);
  vi.stubGlobal("fetch", fetcher);
  watchImageQueue();
  submitImageForm(form, null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  registration.resolve(new Response(queuePage(false, "done", "new", "photo")));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("[data-queue-status]")!.textContent).toBe("done");
});

test("a partial legacy poll without an additions panel preserves the existing addition controls", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = promptPage(true, "old", "5");
  const addition = document.querySelector("[data-add-images]")!.firstChild;
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(queuePage(true, "running", "new", "photo"))),
  );
  watchImageQueue();
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-add-images]")!.firstChild).toBe(addition);
  expect(document.querySelector("[data-queue-status]")!.textContent).toBe("running");
  expect(document.querySelector<HTMLInputElement>('[name="draft"]')!.value).toBe("new");
});

test("a lost acknowledgement keeps its request identity across preview polling but changed targets or prompts create new confirmations", async () => {
  document.body.innerHTML =
    '<form action="/personas"><input name="draft" value="original"><input name="portraitInstructions" value="first"><button name="intent" value="subportrait" formaction="/personas?style=photo">Add</button><output data-pending></output></form>';
  const form = document.querySelector("form")!;
  const button = form.querySelector("button")!;
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  const submit = async () => {
    submitImageForm(form, button);
    await vi.waitFor(() =>
      expect(form.querySelector("output")!.textContent).toBe(copy.queueConnectionFailure),
    );
    return new Headers(fetcher.mock.calls.at(-1)![1]!.headers).get("X-Image-Request");
  };
  const first = await submit();
  form.querySelector<HTMLInputElement>('[name="draft"]')!.value = "a newer polled preview";
  expect(await submit()).toBe(first);
  button.setAttribute("formaction", "/personas?style=anime");
  const next = await submit();
  expect(next).not.toBe(first);
  form.querySelector<HTMLInputElement>('[name="portraitInstructions"]')!.value =
    "changed operator direction";
  expect(await submit()).not.toBe(next);
});

const alertPage = (notice: string) =>
  `<main>${notice}${queuePage(true, "running", "current", "photo")}</main>`;

test.each([false, true])(
  "a rejected registration retains its alert and progress until success, including a partial error reply (existing alert: %s)",
  async (existing) => {
    vi.useFakeTimers();
    document.body.innerHTML = alertPage(
      existing ? '<p class="notice error" role="alert">Previous error</p>' : "",
    );
    const form = document.querySelector("form")!;
    const rejected = new Response(
      alertPage('<p class="notice error" role="alert">Capacity is reserved</p>'),
      { status: 400 },
    );
    Object.defineProperty(rejected, "url", { value: "/personas?style=photo" });
    const history = vi.spyOn(document.defaultView!.history, "replaceState");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response(alertPage("")))
      .mockResolvedValueOnce(new Response(alertPage(""), { status: 400 }))
      .mockImplementation(async () => new Response(alertPage("")));
    vi.stubGlobal("fetch", fetcher);
    submitImageForm(form, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".notice.error")!.textContent).toBe("Capacity is reserved");
    expect(document.querySelector("form")).toBe(form);
    expect(history).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector(".notice.error")!.textContent).toBe("Capacity is reserved");
    submitImageForm(form, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".notice.error")!.textContent).toBe("Capacity is reserved");
    submitImageForm(form, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".notice.error")).toBeNull();
    expect(document.querySelector("form")).toBe(form);
  },
);
