/** The four stem bars and the name, as in the title bar and on the tray icon. */
export function Wordmark() {
  return (
    <>
      <span className="flex h-4 items-end gap-[2px]" aria-hidden="true">
        {['#f472b6', '#fbbf24', '#60a5fa', '#c8f04a'].map((color, i) => (
          <span key={color} className="w-[3px] rounded-full" style={{ height: [9, 14, 7, 12][i], background: color }} />
        ))}
      </span>
      <span className="font-display text-[12.5px] font-semibold tracking-wide text-muted">OpenStems</span>
    </>
  )
}
