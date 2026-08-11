import { EditorView } from '@codemirror/view'

/**
 * Writing-first editor theme: serif prose, centered measure, quiet chrome.
 * All colors come from CSS variables defined in styles/main.css, so the
 * editor follows the app theme (dark/light) live — no rebuild needed.
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '1.0625rem',
    backgroundColor: 'transparent',
    color: 'var(--t-ink)'
  },
  '.cm-scroller': {
    fontFamily: "'Iowan Old Style', 'Palatino', Georgia, serif",
    lineHeight: '1.75',
    padding: '2rem 0 40vh'
  },
  '.cm-content': {
    maxWidth: '42rem',
    margin: '0 auto',
    padding: '0 2rem',
    caretColor: 'var(--ed-caret)'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--ed-caret)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--ed-sel) !important'
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },

  '.cm-lp-heading': { fontWeight: '600', color: 'var(--ed-head)' },
  '.cm-lp-h1': { fontSize: '1.75em', lineHeight: '1.3', paddingTop: '0.8em' },
  '.cm-lp-h2': { fontSize: '1.45em', lineHeight: '1.3', paddingTop: '0.6em' },
  '.cm-lp-h3': { fontSize: '1.2em', paddingTop: '0.4em' },
  '.cm-lp-h4, .cm-lp-h5, .cm-lp-h6': { fontSize: '1.05em' },

  '.cm-lp-strong': { fontWeight: '700', color: 'var(--ed-head)' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strike': { textDecoration: 'line-through', color: 'var(--ed-strike)' },
  '.cm-lp-code': {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: '0.9em',
    backgroundColor: 'var(--ed-code-bg)',
    borderRadius: '4px',
    padding: '0.1em 0.3em'
  },
  '.cm-lp-link': { color: 'var(--ed-link)', textDecoration: 'underline' },
  '.cm-lp-bullet': { color: 'var(--ed-bullet)' },
  '.cm-lp-blockquote': {
    borderLeft: '3px solid var(--ed-quote)',
    paddingLeft: '1rem',
    color: 'var(--ed-quote-text)',
    fontStyle: 'italic'
  },
  '.cm-lp-hr': {
    border: 'none',
    borderTop: '1px solid var(--ed-hr)',
    margin: '1.5rem auto',
    width: '60%'
  },
  '.cm-lp-frontmatter': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    fontSize: '0.8rem',
    color: 'var(--ed-fm)',
    border: '1px solid var(--ed-fm-border)',
    borderRadius: '8px',
    padding: '0.5rem 0.75rem',
    marginBottom: '1.5rem',
    cursor: 'pointer'
  },
  '.cm-lp-status': {
    fontSize: '0.7rem',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    borderRadius: '9999px',
    padding: '0.1rem 0.5rem',
    backgroundColor: 'var(--ed-code-bg)'
  },
  '.cm-lp-status-ai-draft': { color: '#d97706' },
  '.cm-lp-status-final': { color: '#059669' },

  /* Merge review chunks */
  '.cm-changedLine': { backgroundColor: 'var(--ed-sel)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--ed-code-bg)' }
})
