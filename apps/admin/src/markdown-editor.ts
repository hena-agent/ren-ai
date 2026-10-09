import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";

export function markdownEditor(host: HTMLElement, source: HTMLTextAreaElement) {
  return new EditorView({
    parent: host,
    root: host.ownerDocument,
    doc: source.value,
    extensions: [
      markdown(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      lineNumbers(),
      lintGutter(),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      EditorState.readOnly.of(source.readOnly),
      EditorView.editable.of(!source.readOnly),
      EditorView.cspNonce.of(
        host.ownerDocument.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')?.content ??
          "",
      ),
      EditorView.contentAttributes.of({
        "aria-label": "persona.md Markdown 원문",
        "aria-describedby": "document-issues",
        spellcheck: "false",
      }),
      EditorView.theme(
        {
          "&": { color: "var(--ink)", backgroundColor: "var(--field)", fontSize: "14px" },
          ".cm-content": {
            fontFamily: "monospace",
            padding: "16px 0",
            minHeight: "240px",
            lineHeight: "1.75",
          },
          ".cm-scroller": { overflow: "visible" },
          ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--muted)", border: "none" },
          ".cm-tooltip": { backgroundColor: "var(--panel)", borderColor: "var(--line)" },
        },
        { dark: true },
      ),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        source.value = update.state.doc.toString();
        source.dispatchEvent(
          new source.ownerDocument.defaultView!.Event("input", { bubbles: true }),
        );
      }),
    ],
  });
}
