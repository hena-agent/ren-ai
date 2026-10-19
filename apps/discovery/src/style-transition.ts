export async function decodeStyleImages(urls: readonly string[]): Promise<void> {
  await Promise.all(
    [...new Set(urls)].filter(Boolean).map(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
    }),
  );
}

export async function revealImageStyle(commit: () => void): Promise<void> {
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    !document.startViewTransition
  ) {
    commit();
    return;
  }
  const root = document.documentElement;
  root.style.setProperty(
    "--style-reveal-radius",
    `${Math.hypot(window.innerWidth, window.innerHeight)}px`,
  );
  root.classList.add("style-reveal");
  try {
    const transition = document.startViewTransition(commit);
    await Promise.all([
      transition.updateCallbackDone,
      transition.ready.catch(() => undefined),
      transition.finished,
    ]);
  } finally {
    root.classList.remove("style-reveal");
    root.style.removeProperty("--style-reveal-radius");
  }
}
