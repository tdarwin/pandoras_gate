import { EditorView } from '@codemirror/view'

/** Writing-first dark theme: serif prose, centered measure, quiet chrome. */
export const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '1.0625rem',
      backgroundColor: 'transparent',
      color: '#e4e4e7'
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
      caretColor: '#a5b4fc'
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-line': { padding: '0' },
    '.cm-cursor': { borderLeftColor: '#a5b4fc', borderLeftWidth: '2px' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(99, 102, 241, 0.25) !important'
    },

    '.cm-lp-heading': { fontWeight: '600', color: '#fafafa' },
    '.cm-lp-h1': { fontSize: '1.75em', lineHeight: '1.3', paddingTop: '0.8em' },
    '.cm-lp-h2': { fontSize: '1.45em', lineHeight: '1.3', paddingTop: '0.6em' },
    '.cm-lp-h3': { fontSize: '1.2em', paddingTop: '0.4em' },
    '.cm-lp-h4, .cm-lp-h5, .cm-lp-h6': { fontSize: '1.05em' },

    '.cm-lp-strong': { fontWeight: '700', color: '#fafafa' },
    '.cm-lp-em': { fontStyle: 'italic' },
    '.cm-lp-strike': { textDecoration: 'line-through', color: '#a1a1aa' },
    '.cm-lp-code': {
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: '0.9em',
      backgroundColor: 'rgba(255,255,255,0.08)',
      borderRadius: '4px',
      padding: '0.1em 0.3em'
    },
    '.cm-lp-link': { color: '#a5b4fc', textDecoration: 'underline' },
    '.cm-lp-bullet': { color: '#818cf8' },
    '.cm-lp-blockquote': {
      borderLeft: '3px solid #52525b',
      paddingLeft: '1rem',
      color: '#a1a1aa',
      fontStyle: 'italic'
    },
    '.cm-lp-hr': {
      border: 'none',
      borderTop: '1px solid #3f3f46',
      margin: '1.5rem auto',
      width: '60%'
    },
    '.cm-lp-frontmatter': {
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      fontSize: '0.8rem',
      color: '#71717a',
      border: '1px solid #27272a',
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
      backgroundColor: 'rgba(255,255,255,0.07)'
    },
    '.cm-lp-status-ai-draft': { color: '#fbbf24' },
    '.cm-lp-status-final': { color: '#34d399' }
  },
  { dark: true }
)
