import { useEffect, useRef, useState } from "react";
import { readChoices } from "./choices.ts";
import { useCopy, useLocale, LocalePicker } from "./locale.tsx";
import { localizedPath } from "./public-routing.ts";

const seenKey = "ren-ai.discovery.guide-seen";

function remember() {
  try {
    localStorage.setItem(seenKey, "1");
  } catch {
    // Dismissal must work even when browser storage is blocked.
  }
}

export function Guide({ firstVisit }: { firstVisit: boolean }) {
  const copy = useCopy();
  const { locale } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    const backdropClick = (event: MouseEvent) => {
      if (event.target === element) element.close();
    };
    element.addEventListener("click", backdropClick);
    return () => element.removeEventListener("click", backdropClick);
  }, []);
  useEffect(() => {
    if (!firstVisit || Object.keys(readChoices()).length) return;
    try {
      if (localStorage.getItem(seenKey)) return;
    } catch {
      // Without storage, the mounted guide still appears only once per page load.
    }
    open();
  }, [firstVisit]);
  function open() {
    dialog.current!.showModal();
    start.current!.focus();
  }
  function close() {
    dialog.current!.close();
  }
  return (
    <>
      <button
        ref={trigger}
        className="guide-trigger"
        type="button"
        aria-label={copy.guide.open}
        onClick={open}
      >
        <span className="icon icon-info" aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        className="guide"
        aria-labelledby="guide-title"
        onCancel={close}
        onClose={() => {
          remember();
          trigger.current!.focus();
        }}
      >
        <div className="guide-content">
          <div className="guide-toolbar">
            <LocalePicker portalContainer={portal} />
            <button
              className="guide-trigger"
              type="button"
              aria-label={copy.guide.close}
              onClick={close}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <h2 id="guide-title">{copy.guide.title}</h2>
          <ul>
            {copy.guide.steps.map((text, index) => (
              <li key={index}>
                <span
                  className={`icon icon-${["heart", "arrow", "message"][index]}`}
                  aria-hidden="true"
                />
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <p className="guide-requirement">{copy.guide.requirement}</p>
          <button ref={start} className="primary-button" type="button" onClick={close}>
            {copy.guide.start}
          </button>
          <nav aria-label={copy.guide.open}>
            <a href={localizedPath("/about", locale)} onClick={remember}>
              {copy.guide.about}
            </a>
            <a href={`${localizedPath("/about", locale)}#privacy`} onClick={remember}>
              {copy.guide.privacy}
            </a>
          </nav>
          <div ref={setPortal} />
        </div>
      </dialog>
    </>
  );
}
