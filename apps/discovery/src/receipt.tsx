import { useCopy } from "./locale.tsx";

export function Receipt({ waiting }: { waiting: boolean }) {
  const copy = useCopy();
  return (
    <section className="receipt" aria-labelledby="receipt-title">
      <span className="receipt-mark" aria-hidden="true">
        <span className="icon icon-check" />
      </span>
      <h1 id="receipt-title">{waiting ? copy.waitingTitle : copy.activeTitle}</h1>
      <p>{waiting ? copy.waitingMessage : copy.activeMessage}</p>
      {waiting && <p className="receipt-hint">{copy.waitingHint}</p>}
    </section>
  );
}
