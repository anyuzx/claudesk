export type NoteLivePerformanceEvent = {
  detail?: Record<string, unknown>
  duration?: number
  startTime: number
  type: string
}

type NoteLivePerformanceSink = {
  enabled?: boolean
  events?: NoteLivePerformanceEvent[]
  mark?: (event: NoteLivePerformanceEvent) => void
}

declare global {
  interface Window {
    __claudeskNoteLivePerf?: NoteLivePerformanceSink
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function isNoteLivePerformanceEnabled(): boolean {
  return typeof window !== 'undefined' && window.__claudeskNoteLivePerf?.enabled === true
}

export function recordNoteLivePerformance(
  type: string,
  detail?: Record<string, unknown>,
  startTime = now(),
  duration?: number,
): void {
  if (!isNoteLivePerformanceEnabled()) return

  const event: NoteLivePerformanceEvent = {
    type,
    startTime,
    ...(duration == null ? {} : { duration }),
    ...(detail ? { detail } : {}),
  }
  const sink = window.__claudeskNoteLivePerf
  sink?.events?.push(event)
  sink?.mark?.(event)
}

export function measureNoteLivePerformance<T>(
  type: string,
  detail: Record<string, unknown> | undefined,
  callback: () => T,
): T {
  if (!isNoteLivePerformanceEnabled()) return callback()

  const startTime = now()
  try {
    const value = callback()
    recordNoteLivePerformance(type, detail, startTime, now() - startTime)
    return value
  } catch (error) {
    recordNoteLivePerformance(
      type,
      {
        ...detail,
        error: error instanceof Error ? error.message : String(error),
      },
      startTime,
      now() - startTime,
    )
    throw error
  }
}

export async function measureNoteLivePerformanceAsync<T>(
  type: string,
  detail: Record<string, unknown> | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isNoteLivePerformanceEnabled()) return await callback()

  const startTime = now()
  try {
    const value = await callback()
    recordNoteLivePerformance(type, detail, startTime, now() - startTime)
    return value
  } catch (error) {
    recordNoteLivePerformance(
      type,
      {
        ...detail,
        error: error instanceof Error ? error.message : String(error),
      },
      startTime,
      now() - startTime,
    )
    throw error
  }
}
