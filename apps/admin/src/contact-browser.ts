export function bindContactManagement(document: Document) {
  const form = document.querySelector<HTMLFormElement>("#contact-direct-selection");
  if (form && form.dataset["contactRetry"] !== "true") {
    const rows = [...document.querySelectorAll<HTMLInputElement>("[data-contact-select]")];
    const all = document.querySelector<HTMLInputElement>("[data-contact-all]")!;
    const count = form.querySelector<HTMLOutputElement>("[data-contact-count]")!;
    const sync = () => {
      const selected = rows.filter((row) => row.checked);
      count.textContent = `${selected.length}명 선택${selected.length > 100 ? " · 한 번에 최대 100명" : ""}`;
      all.checked = rows.length > 0 && selected.length === rows.length;
      all.indeterminate = selected.length > 0 && selected.length < rows.length;
      for (const button of form.querySelectorAll<HTMLButtonElement>(
        "[data-contact-needs-selection]",
      ))
        button.disabled =
          !selected.length ||
          selected.length > 100 ||
          (button.value === "select-specific" &&
            selected.some((row) => row.dataset["eligible"] !== "true"));
    };
    all?.addEventListener("change", () => {
      rows.forEach((row, index) => {
        row.checked = all.checked && index < 100;
      });
      sync();
    });
    rows.forEach((row) => row.addEventListener("change", sync));
    // Empty/error pages still show the toolbar but have no table.
    if (all) sync();
    if (all) document.defaultView!.addEventListener("pageshow", sync);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-text]")) {
    const copy = async () => {
      const status = document.querySelector<HTMLOutputElement>("[data-copy-status]")!;
      try {
        await document.defaultView!.navigator.clipboard.writeText(button.dataset["copyText"]!);
        status.textContent = "복사했습니다.";
      } catch {
        status.textContent = "복사하지 못했습니다. 공유 링크를 직접 선택해 복사해 주세요.";
      }
    };
    button.addEventListener("click", () => {
      void copy();
    });
  }
}
