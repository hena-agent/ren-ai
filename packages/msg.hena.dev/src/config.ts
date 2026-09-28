// Cloudflare's always-pass key is for dev and tests; deployment supplies the real widget key.
declare global {
  interface ImportMetaEnv {
    readonly VITE_TURNSTILE_SITE_KEY?: string;
  }
}

const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
export const turnstileSiteKey = siteKey || "1x00000000000000000000AA";
