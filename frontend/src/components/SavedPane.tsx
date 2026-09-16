import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown10, CalendarArrowDown, Rows3 } from 'lucide-react'
import * as api from '../api'
import { usePaperSelection } from '../hooks/usePaperSelection'
import PaperListCard, { loadPaperCardCompact, savePaperCardCompact } from './PaperListCard'
import { PaneBody, PaneFrame, PaneHeader, PaneToolbar } from './Pane'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'

type Sort = 'score' | 'date'

export default function SavedPane({
  headerLeading,
  headerActions,
}: {
  headerLeading?: ReactNode
  headerActions?: ReactNode
}) {
  const [sort, setSort] = useState<Sort>('score')
  const [compactCards, setCompactCards] = useState(() => loadPaperCardCompact('saved'))

  const papersQuery = useQuery({
    queryKey: ['papers', 'saved', sort],
    queryFn: () => api.fetchPapers(undefined, 'saved', sort),
  })
  const { data: papers = [], isLoading } = papersQuery

  const noteSelection = usePaperSelection()

  return (
    <PaneFrame className="h-full">
      <PaneHeader
        title="Saved"
        meta={`${papers.length} paper${papers.length !== 1 ? 's' : ''}`}
        leading={headerLeading}
        actions={headerActions}
      />
      <PaneToolbar>
        <div className="flex min-w-0 flex-nowrap items-center gap-3 overflow-hidden">
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              icon={ArrowDown10}
              onClick={() => setSort('score')}
              aria-pressed={sort === 'score'}
              active={sort === 'score'}
              label="Sort by score"
              className={[
                'transition-opacity data-[active=true]:bg-transparent',
                sort === 'score' ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
              ].join(' ')}
            />
            <IconButton
              icon={CalendarArrowDown}
              onClick={() => setSort('date')}
              aria-pressed={sort === 'date'}
              active={sort === 'date'}
              label="Sort by date"
              className={[
                'transition-opacity data-[active=true]:bg-transparent',
                sort === 'date' ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
              ].join(' ')}
            />
          </div>
          <div className="ml-auto flex shrink-0 items-center">
            <IconButton
              icon={Rows3}
              onClick={() => {
                setCompactCards((current) => savePaperCardCompact('saved', !current))
              }}
              aria-pressed={compactCards}
              active={compactCards}
              label="Compact paper cards"
              className={[
                'leading-none transition-opacity data-[active=true]:bg-transparent',
                compactCards ? 'text-display opacity-100' : 'text-muted hover:text-secondary',
              ].join(' ')}
            />
          </div>
        </div>
      </PaneToolbar>

      <PaneBody>
        <div className="max-w-7xl min-w-0">
          {isLoading && (
            <InlineStatus bracketed>LOADING...</InlineStatus>
          )}

          {papersQuery.isError && (
            <InlineStatus tone="error" className="mb-3" onRetry={() => { void papersQuery.refetch() }} retrying={papersQuery.isFetching}>
              {papersQuery.data === undefined
                ? 'Could not load saved papers.'
                : 'Could not refresh saved papers. Showing previously loaded papers.'}
            </InlineStatus>
          )}

          {!isLoading && !papersQuery.isError && papers.length === 0 && (
            <InlineStatus>
              No saved papers yet. Hit SAVE on any paper in the Digest tab.
            </InlineStatus>
          )}

          {papers.map((paper) => (
            <PaperListCard
              key={paper.id}
              paper={paper}
              selected={noteSelection.selectedPaperId === paper.id}
              compact={compactCards}
              onSelect={noteSelection.selectPaper}
            />
          ))}
        </div>
      </PaneBody>
    </PaneFrame>
  )
}
