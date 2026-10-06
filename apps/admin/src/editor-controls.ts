export function syncGender(form: HTMLFormElement) {
  const selector = form.ownerDocument.querySelector<HTMLSelectElement>("[data-persona-gender]");
  const input = form.querySelector<HTMLInputElement>('input[name="gender"]');
  if (selector && input) input.value = selector.value;
}

export function bindProfileSource(form: HTMLFormElement) {
  if (form.dataset["profileComplete"] !== "true") return;
  const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
  const description = form.querySelector<HTMLTextAreaElement>('[name="description"]')!;
  const generate = form.querySelector<HTMLButtonElement>('[value="generate"]')!;
  const controlled = [
    ...form.ownerDocument.querySelectorAll<HTMLButtonElement>("[data-source-bound]"),
  ].map((button) => ({ button, disabled: button.disabled }));
  const update = () => {
    const changed =
      name.value.trim() !== form.dataset["sourceName"] ||
      description.value.trim() !== form.dataset["sourceDescription"];
    generate.hidden = !changed;
    for (const { button, disabled } of controlled) button.disabled = changed || disabled;
  };
  name.addEventListener("input", update);
  description.addEventListener("input", update);
  update();
}
