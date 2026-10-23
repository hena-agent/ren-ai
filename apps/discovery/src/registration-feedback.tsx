import { RegistrationError } from "./client.ts";
import { useCopy, useLocale } from "./locale.tsx";

export function RegistrationFeedback({
  failure,
  onReview,
  onReload,
}: {
  failure: RegistrationError;
  onReview: () => void;
  onReload: () => void;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const code = failure.code;
  const message =
    code === "registration"
      ? copy.joinFailure
      : code === "verification"
        ? copy.verificationFailure
        : code === "reselection"
          ? copy.reselectionFailure
          : copy.registrationErrors[code];
  return (
    <div className="form-error" role="alert">
      <p>{message}</p>
      {failure.retryAt !== undefined && (
        <p>
          {copy.retryAt}:{" "}
          <time dateTime={new Date(failure.retryAt).toISOString()}>
            {new Date(failure.retryAt).toLocaleTimeString(locale)}
          </time>
        </p>
      )}
      {failure.requestId && (
        <p>
          {copy.requestId}: {failure.requestId}
        </p>
      )}
      {(code === "personas" || code === "ended_personas") && (
        <button className="text-button" type="button" onClick={onReview}>
          {copy.reviewSelection}
        </button>
      )}
      {code === "consent" && (
        <button className="text-button" type="button" onClick={onReload}>
          {copy.reloadNotice}
        </button>
      )}
    </div>
  );
}
