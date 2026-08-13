import { useRef } from 'react'

/**
 * Plain-text editor for non-markdown files (metadata/timeline.yaml). A
 * textarea preserves the file byte-for-byte — no parsing, no surprises.
 */
export default function PlainEditor({
  value,
  onChange,
  onSave
}: {
  value: string
  onChange: (value: string) => void
  onSave?: () => void
}): React.JSX.Element {
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          onSaveRef.current?.()
        }
      }}
      spellCheck={false}
      className="h-full w-full resize-none bg-transparent px-6 py-6 font-mono text-[13px] leading-relaxed text-ink outline-none"
    />
  )
}
