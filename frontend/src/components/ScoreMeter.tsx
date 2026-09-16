import { useStore } from '../store'

type ScoreMeterProps = {
  value: number
  cells?: number
  hotThreshold?: number
  className?: string
}

export default function ScoreMeter({
  value,
  cells,
  hotThreshold,
  className = '',
}: ScoreMeterProps) {
  const prefs = useStore((s) => s.uiPrefs)
  const cellsResolved = cells ?? prefs.scoreMeterCells
  const hotResolved = hotThreshold ?? prefs.scoreMeterHotThreshold
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const filledCount = Math.round(clamped * cellsResolved)
  const hot = clamped >= hotResolved

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="font-mono text-xs tabular-nums font-bold">{clamped.toFixed(2)}</span>
      <span className="inline-flex items-center gap-px" aria-hidden="true">
        {Array.from({ length: cellsResolved }, (_, i) => {
          const filled = i < filledCount
          return (
            <span
              key={i}
              className={[
                'block h-3 w-1 border',
                filled
                  ? hot
                    ? 'bg-accent border-accent'
                    : 'bg-current border-current'
                  : 'bg-transparent border-current opacity-40',
              ].join(' ')}
            />
          )
        })}
      </span>
    </span>
  )
}
