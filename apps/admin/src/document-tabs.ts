export function bindDocumentTabs(form: HTMLFormElement, measure: () => void) {
  const tabs = [...form.querySelectorAll<HTMLButtonElement>("[data-editor-tab]")];
  const input = form.querySelector<HTMLInputElement>('[name="tab"]')!;
  const select = (key: string, focus = false) => {
    input.value = key;
    for (const tab of tabs) {
      const active = tab.dataset["editorTab"] === key;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      form.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")!}`)!.hidden = !active;
      if (active && focus) tab.focus();
    }
    measure();
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab.dataset["editorTab"]!));
    tab.addEventListener("keydown", (event) => {
      const next = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next]!.dataset["editorTab"]!, true);
    });
  }
  return select;
}
