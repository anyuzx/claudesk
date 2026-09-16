import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderPlus } from 'lucide-react'
import * as api from '../api'
import { useStore } from '../store'
import { ProjectLinkDialog, normalizeProjectIds } from './ProjectLinkButton'
import { ContextMenuItem } from './ui/context-menu'
import { DropdownMenuItem } from './ui/dropdown-menu'

type PaperProjectLinkButtonProps = {
  projectIds: number[]
  onCreateProject: () => void
  onOpenDialog: () => void
}

type PaperProjectLinkDialogProps = {
  paperId: number
  projectIds: number[]
  onClose: () => void
}

type PaperProjectLinkMenuSurface = 'context' | 'dropdown'

function PaperProjectLinkMenuAction({
  children,
  onClick,
  surface,
}: {
  children: ReactNode
  onClick: () => void
  surface: PaperProjectLinkMenuSurface
}) {
  if (surface === 'context') {
    return <ContextMenuItem onClick={onClick}>{children}</ContextMenuItem>
  }

  return <DropdownMenuItem onClick={onClick}>{children}</DropdownMenuItem>
}

function PaperProjectLinkMenuItem({
  onCreateProject,
  onOpenDialog,
  surface,
}: PaperProjectLinkButtonProps & { surface: PaperProjectLinkMenuSurface }) {
  const setActiveTab = useStore((state) => state.setActiveTab)

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })

  if (!isLoading && projects.length === 0) {
    return (
      <PaperProjectLinkMenuAction
        surface={surface}
        onClick={() => {
          onCreateProject()
          setActiveTab('projects')
        }}
      >
        <FolderPlus aria-hidden="true" />
        <span className="min-w-0 truncate">CREATE PROJECT</span>
      </PaperProjectLinkMenuAction>
    )
  }

  return (
    <PaperProjectLinkMenuAction surface={surface} onClick={onOpenDialog}>
      <FolderPlus aria-hidden="true" />
      <span className="min-w-0 truncate">PROJECTS</span>
    </PaperProjectLinkMenuAction>
  )
}

export default function PaperProjectLinkButton(props: PaperProjectLinkButtonProps) {
  return <PaperProjectLinkMenuItem {...props} surface="dropdown" />
}

export function PaperProjectLinkContextMenuItem(props: PaperProjectLinkButtonProps) {
  return <PaperProjectLinkMenuItem {...props} surface="context" />
}

export function PaperProjectLinkDialog({
  paperId,
  projectIds,
  onClose,
}: PaperProjectLinkDialogProps) {
  const qc = useQueryClient()
  const setActiveTab = useStore((state) => state.setActiveTab)
  const [draftProjectIds, setDraftProjectIds] = useState<number[]>(() => normalizeProjectIds(projectIds))
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.fetchProjects(),
  })

  useEffect(() => {
    setDraftProjectIds(normalizeProjectIds(projectIds))
  }, [projectIds])

  const selectedIds = useMemo(() => normalizeProjectIds(draftProjectIds), [draftProjectIds])

  const syncMutation = useMutation({
    mutationFn: async ({
      currentProjectIds,
      nextProjectIds,
    }: {
      currentProjectIds: number[]
      nextProjectIds: number[]
    }) => {
      const addedProjectIds = nextProjectIds.filter((projectId) => !currentProjectIds.includes(projectId))
      const removedProjectIds = currentProjectIds.filter((projectId) => !nextProjectIds.includes(projectId))

      for (const projectId of addedProjectIds) {
        await api.addPaperToProject(projectId, paperId)
      }
      for (const projectId of removedProjectIds) {
        await api.removePaperFromProject(projectId, paperId)
      }

      return nextProjectIds
    },
    onSuccess: async (nextProjectIds) => {
      setDraftProjectIds(nextProjectIds)
      setErrorMessage(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['papers'] }),
        qc.invalidateQueries({ queryKey: ['projects'] }),
        qc.invalidateQueries({ queryKey: ['search'] }),
      ])
    },
    onError: (error) => {
      setDraftProjectIds(normalizeProjectIds(projectIds))
      setErrorMessage(error instanceof Error ? error.message : 'Project sync failed.')
    },
  })

  return (
    <ProjectLinkDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      value={selectedIds}
      onChange={(nextProjectIds) => {
        const normalizedProjectIds = normalizeProjectIds(nextProjectIds)
        setErrorMessage(null)
        setDraftProjectIds(normalizedProjectIds)
        syncMutation.mutate({
          currentProjectIds: selectedIds,
          nextProjectIds: normalizedProjectIds,
        })
      }}
      projects={projects}
      disabled={syncMutation.isPending}
      emptyLabel="No projects exist yet."
      errorMessage={errorMessage}
      loading={isLoading}
      onCreateProject={() => {
        onClose()
        setActiveTab('projects')
      }}
      title="Paper Projects"
    />
  )
}
