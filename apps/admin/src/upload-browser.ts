import { cropBlob, cropRectangle } from "./crop-image.ts";

export function bindUploads(form: HTMLFormElement, install: (next: Document) => void) {
  const dialog = form.querySelector<HTMLDialogElement>("[data-upload-dialog]");
  if (!dialog) return;
  const window = form.ownerDocument.defaultView!;
  const input = form.querySelector<HTMLInputElement>("[data-upload-file]")!;
  const status = (message: string) => {
    for (const output of form.querySelectorAll("[data-upload-status]"))
      output.textContent = message;
  };
  const canvas = dialog.querySelector<HTMLCanvasElement>("canvas")!;
  const zoom = dialog.querySelector<HTMLInputElement>("[data-crop-zoom]")!;
  const x = dialog.querySelector<HTMLInputElement>("[data-crop-x]")!;
  const y = dialog.querySelector<HTMLInputElement>("[data-crop-y]")!;
  const confirm = dialog.querySelector<HTMLButtonElement>("[data-upload-confirm]")!;
  let image: ImageBitmap | undefined;
  let target: HTMLElement | undefined;
  let loading = false;
  const locked = () =>
    loading || form.dataset["queueLocked"] === "true" || form.hasAttribute("aria-busy");
  const draw = () => {
    if (!image) return;
    const rect = cropRectangle(
      image.width,
      image.height,
      Number(zoom.value) / 100,
      Number(x.value),
      Number(y.value),
    );
    canvas
      .getContext("2d")!
      .drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, 1024, 1280);
  };
  const open = async (file: File) => {
    if (locked()) return;
    if (
      !target ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 20_000_000
    ) {
      status("20MB 이하의 PNG, JPEG 또는 WebP 사진을 선택하세요.");
      return;
    }
    loading = true;
    status("사진을 읽는 중…");
    try {
      image = await window.createImageBitmap(file);
      zoom.value = "100";
      x.value = "50";
      y.value = "50";
      draw();
      status("");
      dialog.showModal();
    } catch {
      status("사진을 읽을 수 없습니다. 다른 파일을 선택하세요.");
    } finally {
      loading = false;
    }
  };
  for (const button of form.querySelectorAll<HTMLButtonElement>("[data-upload-style]"))
    button.addEventListener("click", () => {
      if (locked()) return;
      target = button;
      input.value = "";
      input.click();
    });
  input.addEventListener("change", () => {
    if (input.files?.[0]) void open(input.files[0]);
  });
  for (const drop of form.querySelectorAll<HTMLElement>("[data-upload-drop]")) {
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("drag-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("drag-over");
      const button = drop.querySelector<HTMLButtonElement>("[data-upload-style]")!;
      if (button.disabled || locked()) return;
      target = button;
      if (event.dataTransfer?.files.length !== 1) {
        status("사진을 한 장씩 올려 주세요.");
        return;
      }
      void open(event.dataTransfer.files[0]!);
    });
  }
  for (const slider of [zoom, x, y]) slider.addEventListener("input", draw);
  dialog.addEventListener("close", () => {
    image?.close();
    image = undefined;
    target?.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    if (loading) event.preventDefault();
  });
  dialog.querySelector("[data-upload-cancel]")!.addEventListener("click", () => {
    if (!loading) dialog.close();
  });
  confirm.addEventListener("click", () => {
    if (locked() || !image) return;
    loading = true;
    confirm.disabled = true;
    const body = new FormData(form);
    const params = new URLSearchParams({ style: target!.dataset["uploadStyle"]! });
    if (target!.dataset["uploadImage"]) params.set("image", target!.dataset["uploadImage"]);
    status("사진을 업로드하는 중…");
    void cropBlob(canvas)
      .then(async (blob) => {
        body.set("image", blob, "portrait.jpg");
        const response = await fetch(`/upload-image?${params}`, { method: "POST", body });
        const next = new window.DOMParser().parseFromString(await response.text(), "text/html");
        if (!response.ok)
          throw new Error(
            next.querySelector(".notice.error")?.textContent ?? "사진 업로드에 실패했습니다.",
          );
        dialog.close();
        return next;
      })
      .then(install)
      .catch((error: Error) => {
        status(error.message);
      })
      .finally(() => {
        loading = false;
        confirm.disabled = false;
      });
  });
}
