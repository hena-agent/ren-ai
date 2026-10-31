import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useCopy } from "./locale.tsx";

export function AboutNavigation() {
  const { about } = useCopy();
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
    <div className="about-navigation" data-open={open}>
      <button
        className="about-menu-toggle"
        type="button"
        ref={toggle}
        aria-label={about.menu}
        aria-expanded={open}
        aria-controls="about-menu"
        onClick={() => setOpen(!open)}
        onKeyDown={handleKey}
      >
        <span />
        <span />
      </button>
      <nav id="about-menu" className="about-nav" aria-label={about.navigation}>
        <a href="#about" onClick={close} onKeyDown={handleKey}>
          {about.about}
        </a>
        <a href="#how-it-works" onClick={close} onKeyDown={handleKey}>
          {about.how}
        </a>
        <a href="#faq" onClick={close} onKeyDown={handleKey}>
          {about.faq}
        </a>
      </nav>
    </div>
  );
}
