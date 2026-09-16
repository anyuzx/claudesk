import { Progress as ProgressPrimitive } from '@base-ui/react/progress'

import { cn } from '../../lib/cn'

type ProgressProps = Omit<ProgressPrimitive.Root.Props, 'className'> & {
  className?: string
  indicatorClassName?: string
  trackClassName?: string
}

type ProgressTrackProps = Omit<ProgressPrimitive.Track.Props, 'className'> & {
  className?: string
}

type ProgressIndicatorProps = Omit<ProgressPrimitive.Indicator.Props, 'className'> & {
  className?: string
}

type ProgressLabelProps = Omit<ProgressPrimitive.Label.Props, 'className'> & {
  className?: string
}

type ProgressValueProps = Omit<ProgressPrimitive.Value.Props, 'className'> & {
  className?: string
}

function Progress({
  children,
  className,
  indicatorClassName,
  trackClassName,
  value,
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn('block w-full', className)}
      {...props}
    >
      {children}
      <ProgressTrack className={trackClassName}>
        <ProgressIndicator className={indicatorClassName} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({ className, ...props }: ProgressTrackProps) {
  return (
    <ProgressPrimitive.Track
      data-slot="progress-track"
      className={cn(
        'block h-1.5 w-full overflow-hidden rounded-[var(--control-radius)] bg-[color-mix(in_oklab,var(--color-border)_72%,var(--color-surface))]',
        className,
      )}
      {...props}
    />
  )
}

function ProgressIndicator({ className, ...props }: ProgressIndicatorProps) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn('block h-full bg-secondary transition-all', className)}
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressLabelProps) {
  return (
    <ProgressPrimitive.Label
      data-slot="progress-label"
      className={cn('font-mono text-xs uppercase text-secondary', className)}
      {...props}
    />
  )
}

function ProgressValue({ className, ...props }: ProgressValueProps) {
  return (
    <ProgressPrimitive.Value
      data-slot="progress-value"
      className={cn('font-mono text-xs tabular-nums text-muted', className)}
      {...props}
    />
  )
}

export {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
}
