import { locales } from "@repo/onboarding";

export type Copy = {
  market: { country: string; dialCode: string };
  privacyNoticeVersion: string;
  home: { title: string; description: string; privacyLink: string };
  form: {
    handleLabel: string;
    countryLabel: string;
    submit: string;
    invalidHandle: string;
    consent: string;
    inProgress: string;
    waitlistLink: string;
  };
  privacy: { title: string; placeholder: string; homeLink: string };
  answers: {
    sent: string;
    no_imessage: string;
    unknown: string;
    full: string;
    try_later: string;
  };
  waitlist: {
    title: string;
    emailLabel: string;
    invalidEmail: string;
    submit: string;
    success: string;
    failure: string;
  };
  notice: string;
};

export const copy: Copy = locales.ko;
