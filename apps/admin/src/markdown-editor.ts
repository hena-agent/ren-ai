import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { lintGutter } from "@codemirror/lint";

const sourceHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.propertyName, tags.link], color: "var(--focus)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--signal)" },
  { tag: tags.string, color: "var(--ink)" },
  { tag: [tags.comment, tags.punctuation, tags.meta], color: "var(--muted)" },
  { tag: [tags.heading, tags.strong], fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
]);

export function markdownEditor(
  host: HTMLElement,
  source: HTMLTextAreaElement,
  language: "markdown" | "yaml" = "markdown",
) {
  return new EditorView({
    parent: host,
    root: host.ownerDocument,
    doc: source.value,
    extensions: [
      language === "yaml" ? yaml() : markdown(),
      placeholder(source.placeholder),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      lineNumbers(),
      lintGutter(),
      syntaxHighlighting(sourceHighlighting),
      EditorView.lineWrapping,
      EditorState.readOnly.of(source.readOnly),
      EditorView.editable.of(!source.readOnly),
      EditorView.cspNonce.of(
        host.ownerDocument.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')?.content ??
          "",
      ),
      EditorView.contentAttributes.of({
        "aria-label": source.getAttribute("aria-label") ?? "persona.md Markdown 원문",
        "aria-describedby": source.getAttribute("aria-describedby") ?? "document-issues",
        spellcheck: "false",
      }),
      EditorView.theme(
        {
          "&": { color: "var(--ink)", backgroundColor: "var(--field)", fontSize: "14px" },
          ".cm-content": {
            fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, "Apple SD Gothic Neo", monospace',
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
