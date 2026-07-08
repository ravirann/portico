"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { lintFlow } from "@/lib/flow-lint";

/** On-brand light editor chrome — cool clinical paper, blue selection, hairline
 *  gutter. Kept in-file so the editor matches the console without touching CSS. */
const porticoTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--paper-2)",
      color: "var(--ink)",
      fontSize: "12.5px",
      border: "1px solid var(--line)",
      borderRadius: "var(--radius-sm)",
    },
    "&.cm-focused": { outline: "none", borderColor: "var(--accent-line)" },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      caretColor: "var(--accent)",
      padding: "12px 0",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--ink-3)",
      border: "none",
      borderRight: "1px solid var(--line)",
      fontFamily: "var(--font-mono)",
      fontSize: "11.5px",
    },
    ".cm-activeLine": { backgroundColor: "oklch(0.955 0.02 238 / 0.45)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "var(--accent-wash)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "1.5px wavy var(--fail)" },
  },
  { dark: false },
);

/** Syntax colors keyed to the design system's ink + medical-blue palette.
 *  Strings take a muted teal, numbers the ok-green family, so keys (blue),
 *  strings, and scalars stay distinguishable on the cool paper. */
const porticoHighlight = HighlightStyle.define([
  { tag: [t.definition(t.propertyName), t.propertyName, t.atom], color: "var(--accent)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "oklch(0.46 0.07 195)" },
  { tag: [t.number, t.bool, t.null, t.keyword], color: "oklch(0.5 0.09 165)" },
  { tag: [t.comment], color: "var(--ink-3)", fontStyle: "italic" },
  { tag: [t.meta, t.punctuation], color: "var(--ink-3)" },
]);

/** On-brand dark editor chrome — cool blue-slate paper (matching the app's
 *  dark --paper), light ink, blue selection + caret. Explicit oklch values
 *  (not vars) so the surface stays correct even mid theme-transition. */
const porticoDarkTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "oklch(0.235 0.016 245)",
      color: "oklch(0.94 0.008 235)",
      fontSize: "12.5px",
      border: "1px solid oklch(0.335 0.02 243)",
      borderRadius: "var(--radius-sm)",
    },
    "&.cm-focused": { outline: "none", borderColor: "oklch(0.45 0.06 243)" },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      caretColor: "oklch(0.72 0.10 243)",
      padding: "12px 0",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "oklch(0.56 0.024 240)",
      border: "none",
      borderRight: "1px solid oklch(0.335 0.02 243)",
      fontFamily: "var(--font-mono)",
      fontSize: "11.5px",
    },
    ".cm-activeLine": { backgroundColor: "oklch(0.315 0.019 245 / 0.55)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "oklch(0.72 0.10 243)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "oklch(0.32 0.05 243)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "oklch(0.72 0.10 243)" },
    ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "1.5px wavy oklch(0.70 0.15 27)" },
  },
  { dark: true },
);

/** Syntax colors tuned for legibility on the dark surface (light blue keys,
 *  warm string amber, ok-green numbers) — same token families as the light set. */
const porticoDarkHighlight = HighlightStyle.define([
  { tag: [t.definition(t.propertyName), t.propertyName, t.atom], color: "oklch(0.78 0.09 240)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "oklch(0.8 0.1 60)" },
  { tag: [t.number, t.bool, t.null, t.keyword], color: "oklch(0.75 0.1 165)" },
  { tag: [t.comment], color: "oklch(0.62 0.024 240)", fontStyle: "italic" },
  { tag: [t.meta, t.punctuation], color: "oklch(0.56 0.024 240)" },
]);

/** Track the active theme: explicit data-theme wins; otherwise fall back to the
 *  OS preference. Re-reads on data-theme mutations (ThemeToggle) and OS changes. */
function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const compute = () => {
      const attr = document.documentElement.getAttribute("data-theme");
      if (attr === "dark") return true;
      if (attr === "light") return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    };
    setIsDark(compute());
    const obs = new MutationObserver(() => setIsDark(compute()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => setIsDark(compute());
    mq.addEventListener("change", onMq);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);
  return isDark;
}

export interface YamlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Reports validity (no error diagnostics) plus the current error messages. */
  onValidChange?: (valid: boolean, errors: string[]) => void;
  /** "flow" runs the flow-spec check; "plain" only reports YAML parse errors. */
  mode?: "flow" | "plain";
  /** Approximate min height for the editor surface. */
  minHeight?: string;
}

export function YamlEditor({ value, onChange, onValidChange, mode = "plain", minHeight = "320px" }: YamlEditorProps) {
  const [errors, setErrors] = useState<string[]>([]);
  const isDark = useIsDark();
  const onValidRef = useRef(onValidChange);
  onValidRef.current = onValidChange;

  // Recompute the flat error list (for the strip + parent callback) on change.
  useEffect(() => {
    const { valid, errors } = lintFlow(value, mode);
    setErrors(errors);
    onValidRef.current?.(valid, errors);
  }, [value, mode]);

  // In-editor squiggles + gutter markers driven by the same pure linter.
  const extensions = useMemo(
    () => [
      yaml(),
      syntaxHighlighting(isDark ? porticoDarkHighlight : porticoHighlight),
      lintGutter(),
      linter((view): Diagnostic[] => {
        const src = view.state.doc.toString();
        const len = src.length;
        return lintFlow(src, mode).issues.map((i) => ({
          from: Math.min(i.from, len),
          to: Math.min(Math.max(i.to, i.from + 1), len),
          severity: i.severity,
          message: i.message,
        }));
      }),
      EditorView.lineWrapping,
    ],
    [mode, isDark],
  );

  return (
    <div>
      <CodeMirror
        value={value}
        onChange={onChange}
        // The theme goes through the dedicated prop (not `extensions`) so it
        // replaces @uiw's default light theme instead of losing the cascade
        // to its hardcoded white background.
        theme={isDark ? porticoDarkTheme : porticoTheme}
        extensions={extensions}
        minHeight={minHeight}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false }}
      />
      <div
        style={{
          marginTop: 8,
          minHeight: 20,
          fontSize: 12,
          fontFamily: "var(--font-mono)",
        }}
      >
        {errors.length === 0 ? (
          <span style={{ color: "var(--ok)" }}>✓ no issues</span>
        ) : (
          <ul style={{ listStyle: "none", display: "grid", gap: 4 }}>
            {errors.map((e, i) => (
              <li key={i} style={{ display: "flex", gap: 8, color: "var(--fail)" }}>
                <span style={{ fontWeight: 700 }}>✗</span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
