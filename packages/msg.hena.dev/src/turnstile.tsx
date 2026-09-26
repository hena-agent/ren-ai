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
        },
      ) => string;
      remove: (id: string) => void;
    };
  }
}

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let widget: string | undefined;
    const render = () => {
      if (window.turnstile) {
        widget = window.turnstile.render(element.current!, {
          sitekey: turnstileSiteKey,
          callback: onToken,
          "expired-callback": () => onToken(""),
          "error-callback": () => onToken(""),
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
    document.head.append(script);
    return () => {
      if (widget) window.turnstile?.remove(widget);
      script.removeEventListener("load", render);
      script.remove();
    };
  }, [onToken]);

  return <div ref={element} />;
}
