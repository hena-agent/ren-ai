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
