import { useEffect } from "react";

/**
 * Marks the page `data-input="keyboard"` or `"pointer"` after the first key or press. Browsers treat
 * the card's focus on load as keyboard focus, so rings on invisible controls wait for real keys.
 */
export function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const keyboard = () => root.setAttribute("data-input", "keyboard");
    const pointer = () => root.setAttribute("data-input", "pointer");
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointerdown", pointer, true);
      root.removeAttribute("data-input");
    };
  }, []);
}
