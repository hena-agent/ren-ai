import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";

export function updateEditorDiagnostics(
  view: EditorView,
  field: HTMLTextAreaElement,
  list: HTMLElement,
  issues: readonly { start: number; end: number; line: number; message: string }[],
  select: () => void,
) {
  const invalid = String(issues.length > 0);
  field.setAttribute("aria-invalid", invalid);
  view.contentDOM.setAttribute("aria-invalid", invalid);
  view.dispatch(
    setDiagnostics(
      view.state,
      issues.map((issue) => ({
        from: issue.start,
        to: issue.end,
        severity: "error",
        message: issue.message,
      })),
    ),
  );
  list.replaceChildren(
    ...issues.map((issue) => {
      const item = field.ownerDocument.createElement("li");
      const button = field.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = `${issue.line}행 · ${issue.message}`;
      button.addEventListener("click", () => {
        select();
        const start = Math.min(issue.start, view.state.doc.length);
        view.dispatch({
          selection: { anchor: start, head: Math.min(issue.end, view.state.doc.length) },
          effects: EditorView.scrollIntoView(start, { y: "center" }),
        });
        view.focus();
      });
      item.append(button);
      return item;
    }),
  );
}
