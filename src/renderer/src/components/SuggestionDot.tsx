/**
 * "You need to look here." One dot per navigation row that has AI suggestions
 * waiting, and an aggregate on anything collapsed so nothing hides.
 *
 * The count and the source live in `title` and `aria-label`, never in colour
 * alone — a dot the reader cannot distinguish is not a notification.
 */
export default function SuggestionDot({
  count,
  sources,
  blocked = 0,
  aggregate = false
}: {
  count: number
  /** Proposal titles: "2 suggestions · Codex update after ch. 12". */
  sources: readonly string[]
  /** How many of them need a look before they can be applied. */
  blocked?: number
  /** A rolled-up count for a collapsed section, drawn a little quieter. */
  aggregate?: boolean
}): React.JSX.Element | null {
  if (count <= 0) return null
  const label =
    `${count} suggestion${count === 1 ? '' : 's'}` +
    (sources.length > 0 ? ` · ${sources.join(', ')}` : '') +
    (blocked > 0 ? ` · ${blocked} needs a look first` : '')
  return (
    <span
      title={label}
      aria-label={label}
      className={`ml-1 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums ${
        aggregate ? 'bg-amber-900/60 text-amber-300/90' : 'bg-amber-800 text-amber-100'
      }`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
