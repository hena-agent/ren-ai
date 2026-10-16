import { Compartment, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { goToNextChunk, unifiedMergeView } from "@codemirror/merge";
import { isolateHistory } from "@codemirror/commands";
import { markdownHeadings, publicHeading } from "@ren-ai/personas/profile";

export function bindDocumentTools(editor: HTMLElement, view: EditorView) {
  for (const trigger of editor.querySelectorAll<HTMLButtonElement>("[data-document-dialog]")) {
    const dialog = editor.querySelector<HTMLDialogElement>(
      `#${trigger.dataset["documentDialog"]}`,
    )!;
    trigger.addEventListener("click", () => {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("h2[tabindex]")?.focus();
    });
    dialog
      .querySelector("[data-close-document-dialog]")!
      .addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => trigger.focus({ preventScroll: true }));
  }
  editor.querySelector("[data-jump-public-profile]")!.addEventListener("click", () => {
    const heading = markdownHeadings(view.state.doc.toString()).find(
      (entry) => entry.depth === 2 && entry.title === publicHeading,
    );
    if (!heading) {
      editor.querySelector<HTMLButtonElement>("#open-profile-help")!.click();
      return;
    }
    view.dispatch({
      selection: { anchor: heading.start, head: heading.end },
      effects: EditorView.scrollIntoView(heading.start, { y: "center" }),
    });
    view.focus();
  });
  const original = editor.querySelector<HTMLTextAreaElement>("[data-improvement-source]");
  if (!original) return;
  const improved = view.state.doc.toString();
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: original.value },
    annotations: Transaction.addToHistory.of(false),
  });
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: improved },
    annotations: isolateHistory.of("full"),
  });
  const toggle = editor.querySelector<HTMLInputElement>("[data-improvement-diff]")!;
  const diff = new Compartment();
  const extension = () =>
    toggle.checked
      ? unifiedMergeView({
          original: original.value,
          mergeControls: false,
          syntaxHighlightDeletions: false,
          allowInlineDiffs: true,
        })
      : [];
  view.dispatch({ effects: StateEffect.appendConfig.of(diff.of(extension())) });
  goToNextChunk(view);
  toggle.addEventListener("change", () =>
    view.dispatch({ effects: diff.reconfigure(extension()) }),
  );
}
