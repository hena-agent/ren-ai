import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fromPartial } from "@total-typescript/shoehorn";
import { useBrowser } from "../test/browser.ts";
import { UploadControls, UploadDialog } from "./upload-controls.tsx";
import { bindUploads } from "./upload-browser.ts";

useBrowser();
function setup() {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <input name="draft" value="private-draft" readOnly />
      <UploadControls portraitStyle="photo" locked={false} full={false} />
      <UploadControls portraitStyle="anime" locked={false} full={false} />
      <button
        type="button"
        data-upload-style="photo"
        data-upload-image="https://persona-images.renai.im/old.jpg"
      >
        교체
      </button>
      <UploadDialog />
    </form>,
  );
  const form = document.querySelector("form")!;
  const window = form.ownerDocument.defaultView!;
  const dialog = document.querySelector("dialog")!;
  const input = form.querySelector<HTMLInputElement>("[data-upload-file]")!;
  const canvas = document.querySelector("canvas")!;
  const draw = vi.fn<CanvasRenderingContext2D["drawImage"]>();
  vi.spyOn(canvas, "getContext").mockReturnValue(
    fromPartial<CanvasRenderingContext2D>({ drawImage: draw }),
  );
  const bitmap = fromPartial<ImageBitmap>({ width: 1600, height: 900, close: vi.fn<() => void>() });
  const decode = vi
    .fn<(image: ImageBitmapSource) => Promise<ImageBitmap>>()
    .mockResolvedValue(bitmap);
  Object.defineProperty(window, "createImageBitmap", { value: decode, configurable: true });
  const encode = vi
    .spyOn(canvas, "toBlob")
    .mockImplementation((callback) => callback(new window.Blob(["jpeg"], { type: "image/jpeg" })));
  const install = vi.fn<(next: Document) => void>();
  bindUploads(form, install);
  const status = () => form.querySelector("[data-upload-status]")!.textContent;
  const file = (type = "image/png", size = 12) =>
    new window.File([new Uint8Array(size)], "portrait.png", { type });
  const choose = (selected?: File) => {
    Object.defineProperty(input, "files", {
      value: selected ? [selected] : null,
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
  };
  const button = form.querySelector<HTMLButtonElement>("[data-upload-style]")!;
  const confirm = form.querySelector<HTMLButtonElement>("[data-upload-confirm]")!;
  return {
    form,
    dialog,
    input,
    bitmap,
    button,
    confirm,
    decode,
    encode,
    draw,
    install,
    status,
    file,
    choose,
  };
}

test("file selection requires crop confirmation, adjusts the 4:5 preview, and uploads only the encoded crop", async () => {
  const s = setup();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<main>updated</main>"));
  vi.stubGlobal("fetch", fetcher);
  s.button.click();
  s.choose(s.file());
  await vi.waitFor(() => expect(s.dialog.open).toBe(true));
  expect(fetcher).not.toHaveBeenCalled();
  const slider = s.dialog.querySelector<HTMLInputElement>("[data-crop-zoom]")!;
  slider.value = "200";
  slider.dispatchEvent(new Event("input"));
  expect(s.draw).toHaveBeenLastCalledWith(s.bitmap, 620, 225, 360, 450, 0, 0, 1024, 1280);
  s.confirm.click();
  s.confirm.click();
  await vi.waitFor(() => expect(s.install).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0]![0]).toBe("/upload-image?style=photo");
  expect(s.encode).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
  expect(s.dialog.open).toBe(false);
});

test("drop selects its style, replacement selects only its target, and cancel makes no upload", async () => {
  const s = setup();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<main>updated</main>"));
  vi.stubGlobal("fetch", fetcher);
  const drop = s.form.querySelector<HTMLElement>('[data-upload-drop="anime"]')!;
  drop.dispatchEvent(new window.DragEvent("dragover", { cancelable: true }));
  expect(drop.classList.contains("drag-over")).toBe(true);
  drop.dispatchEvent(new window.DragEvent("dragleave"));
  expect(drop.classList.contains("drag-over")).toBe(false);
  const event = new window.DragEvent("drop", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [s.file()] } });
  drop.dispatchEvent(event);
  await vi.waitFor(() => expect(s.dialog.open).toBe(true));
  s.dialog.querySelector<HTMLButtonElement>("[data-upload-cancel]")!.click();
  expect(fetcher).not.toHaveBeenCalled();
  s.form.querySelector<HTMLButtonElement>("[data-upload-image]")!.click();
  s.choose(s.file());
  await vi.waitFor(() => expect(s.dialog.open).toBe(true));
  s.confirm.click();
  await vi.waitFor(() => expect(s.install).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0]![0]).toContain(
    "image=https%3A%2F%2Fpersona-images.renai.im%2Fold.jpg",
  );
});

test("bad files, multiple drops, empty selection and decode failures do not submit", async () => {
  const s = setup();
  s.choose();
  s.choose(s.file());
  expect(s.status()).toContain("20MB");
  s.button.click();
  s.choose(s.file("image/gif"));
  expect(s.status()).toContain("20MB");
  s.choose(s.file("image/png", 20_000_001));
  expect(s.status()).toContain("20MB");
  const drop = s.form.querySelector("[data-upload-drop]")!;
  drop.dispatchEvent(new window.DragEvent("drop"));
  expect(s.status()).toContain("한 장씩");
  s.decode.mockRejectedValueOnce(new Error("decode"));
  s.choose(s.file());
  await vi.waitFor(() => expect(s.status()).toContain("읽을 수 없습니다"));
  expect(s.dialog.open).toBe(false);
});

test("queue, pending decode and network locks prevent concurrent changes; failures preserve the crop for retry", async () => {
  const s = setup();
  s.form.dataset["queueLocked"] = "true";
  s.button.click();
  s.choose(s.file());
  expect(s.decode).not.toHaveBeenCalled();
  const drop = s.form.querySelector("[data-upload-drop]")!;
  drop.dispatchEvent(new window.DragEvent("drop"));
  s.form.dataset["queueLocked"] = "false";
  s.button.disabled = true;
  drop.dispatchEvent(new window.DragEvent("drop"));
  s.button.disabled = false;
  s.form.setAttribute("aria-busy", "true");
  s.button.click();
  s.form.removeAttribute("aria-busy");
  s.confirm.click();
  s.dialog.querySelector("input")!.dispatchEvent(new Event("input"));
  s.dialog.dispatchEvent(new Event("close"));
  s.button.click();
  s.choose(s.file());
  s.choose(s.file());
  await vi.waitFor(() => expect(s.dialog.open).toBe(true));
  let release = vi.fn<(response: Response) => void>();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = vi.fn<(response: Response) => void>(resolve);
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  s.confirm.click();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const cancel = new Event("cancel", { cancelable: true });
  s.dialog.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  s.dialog.querySelector<HTMLButtonElement>("[data-upload-cancel]")!.click();
  expect(s.dialog.open).toBe(true);
  release(new Response('<div class="notice error">업로드 저장 실패</div>', { status: 503 }));
  await vi.waitFor(() => expect(s.status()).toBe("업로드 저장 실패"));
  expect(s.confirm.disabled).toBe(false);
  expect(s.install).not.toHaveBeenCalled();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 400 })),
  );
  s.confirm.click();
  await vi.waitFor(() => expect(s.status()).toContain("사진 업로드에 실패"));
  s.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
});

test("binding skips forms without upload UI", () => {
  document.body.innerHTML = "<form></form>";
  expect(
    bindUploads(document.querySelector("form")!, vi.fn<(next: Document) => void>()),
  ).toBeUndefined();
});
test("crop controls do not invalidate normal persona submissions", () => {
  const { form } = setup();
  expect(
    [...form.querySelectorAll("input")]
      .filter((input) => !input.checkValidity())
      .map((input) => input.outerHTML),
  ).toEqual([]);
});
