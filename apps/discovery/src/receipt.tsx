import { useCopy } from "./locale.tsx";
import { invitationToken } from "./public-routing.ts";

export function Receipt({ waiting }: { waiting: boolean }) {
  const copy = useCopy();
  const invited = waiting && Boolean(invitationToken(window.location.hash));
  return (
    <section className="receipt" aria-labelledby="receipt-title">
      <span className="receipt-mark" aria-hidden="true">
        <span className="icon icon-check" />
      </span>
      <h1 id="receipt-title">
        {invited ? copy.invitationTitle : waiting ? copy.waitingTitle : copy.activeTitle}
      </h1>
      <p>{invited ? copy.invitationMessage : waiting ? copy.waitingMessage : copy.activeMessage}</p>
      {waiting && (
        <p className="receipt-hint">{invited ? copy.invitationHint : copy.waitingHint}</p>
      )}
    </section>
  );
}
