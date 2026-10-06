import { locales } from "@ren-ai/onboarding";

export type Copy = {
  market: { country: string; dialCode: string };
  privacyNoticeVersion: string;
  home: { title: string; description: string; privacyLink: string };
  catalog: {
    title: string;
    change: string;
    loading: string;
    failure: string;
    retry: string;
    empty: string;
  };
  form: {
    handleLabel: string;
    countryLabel: string;
    submit: string;
    invalidHandle: string;
    consent: string;
    inProgress: string;
    verificationFailed: string;
    waitlistLink: string;
  };
  privacy: {
    title: string;
    placeholder: string;
    intro: string[];
    sections: { title: string; paragraphs: string[] }[];
    contact: { title: string; email: string };
    homeLink: string;
  };
  answers: {
    sent: string;
    no_imessage: string;
    unknown: string;
    full: string;
    try_later: string;
    persona_unavailable: string;
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
