import { useEffect, useRef } from "react";
import { turnstileSiteKey } from "./config.ts";

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
          "unsupported-callback": () => void;
        },
      ) => string;
      remove: (id: string) => void;
    };
  }
}

export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let widget: string | undefined;
    const fail = () => onToken(null);
    const render = () => {
      if (window.turnstile) {
        widget = window.turnstile.render(element.current!, {
          sitekey: turnstileSiteKey,
          callback: onToken,
          "expired-callback": () => onToken(""),
          "error-callback": fail,
          "unsupported-callback": fail,
        });
      }
    };
    if (window.turnstile) {
      render();
      return () => {
        if (widget) window.turnstile?.remove(widget);
      };
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.addEventListener("load", render);
    script.addEventListener("error", fail);
    document.head.append(script);
    return () => {
      if (widget) window.turnstile?.remove(widget);
      script.removeEventListener("load", render);
      script.removeEventListener("error", fail);
      script.remove();
    };
  }, [onToken]);

  return <div ref={element} />;
}
