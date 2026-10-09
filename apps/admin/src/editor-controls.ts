export function syncGender(form: HTMLFormElement) {
  const selector = form.ownerDocument.querySelector<HTMLSelectElement>("[data-persona-gender]");
  const input = form.querySelector<HTMLInputElement>('input[name="gender"]');
  if (selector && input) input.value = selector.value;
}
