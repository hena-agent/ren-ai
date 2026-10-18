import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useCopy } from "./locale.tsx";

export function HomeNavigation() {
  const { home } = useCopy();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
  }
  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      close();
      toggle.current!.focus();
    }
  }
  return (
    <div className="home-navigation" data-open={open}>
      <button
        className="home-menu-toggle"
        type="button"
        ref={toggle}
        aria-label={home.menu}
        aria-expanded={open}
        aria-controls="home-menu"
        onClick={() => setOpen(!open)}
        onKeyDown={handleKey}
      >
        <span />
        <span />
      </button>
      <nav id="home-menu" className="home-nav" aria-label={home.navigation}>
        <a href="#about" onClick={close} onKeyDown={handleKey}>
          {home.about}
        </a>
        <a href="#how-it-works" onClick={close} onKeyDown={handleKey}>
          {home.how}
        </a>
        <a href="#faq" onClick={close} onKeyDown={handleKey}>
          {home.faq}
        </a>
      </nav>
    </div>
  );
}
