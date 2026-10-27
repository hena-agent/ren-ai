export function fakeVerification() {
  let callback: ((token: string) => void) | undefined;
  window.turnstile = {
    render: (_, options) => {
      callback = options.callback;
      return "widget";
    },
    remove: () => {},
  };
  return (token: string) => callback?.(token);
}

export function submitVerifiedContact(verify: (token: string) => void) {
  fireEvent.change(screen.getByRole("textbox", { name: "이름" }), { target: { value: "민수" } });
  fireEvent.click(screen.getByRole("checkbox", { name: discoveryNotice.consent }));
  act(() => verify("human"));
  fireEvent.click(screen.getByRole("button", { name: "동의하고 대기 등록" }));
}
import { act, fireEvent, screen } from "@testing-library/react";
import { discoveryNotice } from "@ren-ai/onboarding";
