export function bindLayerLayout(page: HTMLElement) {
  const form = page.querySelector<HTMLFormElement>("[data-layer-layout-form]")!;
  const select = form.querySelector<HTMLSelectElement>("[data-layer-layout-select]")!;
  const fields = ["x", "y", "width", "height"].map((name) =>
    form.querySelector<HTMLInputElement>(`[name="${name}"]`)!,
  );
  const selected = () =>
    page.querySelector<SVGImageElement>(`[data-layer-image="${select.value}"]`)!;
  const read = () => {
    const image = selected();
    for (const field of fields) field.value = image.getAttribute(field.name)!;
  };
  select.addEventListener("change", read);
  for (const field of fields)
    field.addEventListener("input", () => {
      selected().setAttribute(field.name, field.value);
      page.dispatchEvent(new page.ownerDocument.defaultView!.Event("layer-layout-change"));
    });
  for (const solo of page.querySelectorAll<HTMLButtonElement>("[data-layer-solo]"))
    solo.addEventListener("click", () => {
      const index = solo.dataset["layerSolo"]!;
      for (const toggle of page.querySelectorAll<HTMLInputElement>("[data-layer-toggle]")) {
        toggle.checked = toggle.dataset["layerToggle"] === index;
        toggle.dispatchEvent(new page.ownerDocument.defaultView!.Event("change"));
      }
      if (index !== "0") {
        select.value = index;
        read();
      }
    });
}
