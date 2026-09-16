import { useMemo, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import type { Project } from '../types'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from './ui/combobox'
import { Dialog, DialogClose, DialogTitle } from './ui/dialog'
import { IconButton } from './ui/icon-button'
import { InlineStatus } from './ui/inline-status'

type ProjectLinkDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: number[]
  onChange: (projectIds: number[]) => void
  projects: Project[]
  createProjectLabel?: string
  description?: string
  disabled?: boolean
  emptyLabel?: string
  errorMessage?: string | null
  loading?: boolean
  onCreateProject?: () => void
  title?: string
}

type ProjectLinkButtonProps = Omit<ProjectLinkDialogProps, 'open' | 'onOpenChange'> & {
  buttonLabel?: string
  className?: string
  variant?: 'inline' | 'icon'
}

export function normalizeProjectIds(projectIds: number[]): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []
  for (const projectId of projectIds) {
    if (!Number.isInteger(projectId) || projectId <= 0 || seen.has(projectId)) continue
    seen.add(projectId)
    ordered.push(projectId)
  }
  return ordered
}

export function labelForProjectSelection(
  projects: Project[],
  projectIds: number[],
  fallback = 'PROJECTS',
): string {
  const selectedProjects = normalizeProjectIds(projectIds)
    .map((projectId) => projects.find((project) => project.id === projectId))
    .filter((project): project is Project => project != null)

  if (selectedProjects.length === 0) return fallback
  if (selectedProjects.length === 1) return selectedProjects[0].name.toUpperCase()
  return `${selectedProjects.length} PROJECTS`
}

export function ProjectLinkPicker({
  className,
  emptyLabel = 'No matching projects',
  inputLabel = 'Search projects',
  placeholder = 'Add to project...',
  selectedPlaceholder = 'Add project...',
  value,
  onChange,
  projects,
  disabled = false,
}: {
  className?: string
  emptyLabel?: string
  inputLabel?: string
  placeholder?: string
  selectedPlaceholder?: string
  value: number[]
  onChange: (projectIds: number[]) => void
  projects: Project[]
  disabled?: boolean
}) {
  const selectedIds = useMemo(() => normalizeProjectIds(value), [value])
  const selectedValues = useMemo(() => selectedIds.map(String), [selectedIds])
  const projectValues = useMemo(() => projects.map((project) => String(project.id)), [projects])
  const projectByValue = useMemo(() => {
    return new Map(projects.map((project) => [String(project.id), project]))
  }, [projects])

  return (
    <Combobox
      items={projectValues}
      multiple
      value={selectedValues}
      onValueChange={(nextValues) => {
        if (disabled) return
        onChange(normalizeProjectIds(nextValues.map((projectId) => Number(projectId))))
      }}
      itemToStringLabel={(projectId) => projectByValue.get(projectId)?.name ?? projectId}
      itemToStringValue={(projectId) => projectId}
      autoHighlight
      openOnInputClick
    >
      <div className={['flex min-w-0 items-start gap-2', className].filter(Boolean).join(' ')}>
        <ComboboxChips aria-disabled={disabled} className="min-w-0 flex-1">
          <ComboboxValue>
            {selectedValues.map((projectId) => {
              const project = projectByValue.get(projectId)
              if (!project) return null
              return (
                <ComboboxChip key={projectId} showRemove={!disabled}>
                  {project.name}
                </ComboboxChip>
              )
            })}
          </ComboboxValue>
          <ComboboxChipsInput
            aria-label={inputLabel}
            disabled={disabled}
            placeholder={selectedValues.length === 0 ? placeholder : selectedPlaceholder}
          />
        </ComboboxChips>
        {selectedValues.length > 0 && (
          <ComboboxClear
            aria-label="Clear project links"
            title="Clear project links"
            disabled={disabled}
          />
        )}
      </div>
      <ComboboxContent>
        <ComboboxEmpty>{projects.length === 0 ? emptyLabel : 'No matching projects'}</ComboboxEmpty>
        <ComboboxList>
          {(projectId: string) => {
            const project = projectByValue.get(projectId)
            if (!project) return null
            return (
              <ComboboxItem key={projectId} value={projectId} disabled={disabled}>
                {project.name}
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export function ProjectLinkDialog({
  open,
  onOpenChange,
  value,
  onChange,
  projects,
  createProjectLabel = 'Create Project',
  description,
  disabled = false,
  emptyLabel = 'No projects exist yet.',
  errorMessage = null,
  loading = false,
  onCreateProject,
  title = 'Link Projects',
}: ProjectLinkDialogProps) {
  const selectedIds = normalizeProjectIds(value)
  const pickerDisabled = disabled || loading

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-lg"
      disablePointerDismissal={disabled}
    >
      <div>
        <div className="mb-4">
          <DialogTitle>{title}</DialogTitle>
          {description && (
            <p className="mt-2 text-sm leading-relaxed text-secondary">{description}</p>
          )}
        </div>

        {loading ? (
          <InlineStatus uppercase>Loading projects...</InlineStatus>
        ) : projects.length === 0 ? (
          <div>
            <p className="text-sm text-secondary">{emptyLabel}</p>
            {onCreateProject && (
              <button
                type="button"
                onClick={onCreateProject}
                className="mt-4 font-mono text-xs uppercase text-secondary hover:text-display"
              >
                {createProjectLabel}
              </button>
            )}
          </div>
        ) : (
          <ProjectLinkPicker
            value={selectedIds}
            onChange={onChange}
            projects={projects}
            disabled={pickerDisabled}
          />
        )}

        <div className="mt-4 flex items-center justify-between gap-4">
          {!loading && projects.length > 0 ? (
            <span className="font-mono text-[10px] uppercase text-muted">
              {selectedIds.length === 0
                ? 'No project links'
                : `${selectedIds.length} ${selectedIds.length === 1 ? 'project' : 'projects'} linked`}
            </span>
          ) : (
            <span aria-hidden="true" />
          )}

          <DialogClose
            variant="display"
            disabled={disabled}
          >
            CONFIRM
          </DialogClose>
        </div>

        {errorMessage && (
          <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed text-accent">
            {errorMessage}
          </p>
        )}
      </div>
    </Dialog>
  )
}

export default function ProjectLinkButton({
  value,
  onChange,
  projects,
  buttonLabel,
  className = '',
  createProjectLabel,
  description,
  disabled = false,
  emptyLabel,
  errorMessage,
  loading = false,
  onCreateProject,
  title,
  variant = 'inline',
}: ProjectLinkButtonProps) {
  const [open, setOpen] = useState(false)
  const selectedIds = useMemo(() => normalizeProjectIds(value), [value])
  const fallbackLabel = projects.length === 0 ? (emptyLabel ?? 'NO PROJECTS') : 'PROJECTS'
  const label = buttonLabel ?? labelForProjectSelection(projects, selectedIds, fallbackLabel)
  const buttonDisabled = disabled || loading || (projects.length === 0 && !onCreateProject)

  return (
    <>
      {variant === 'icon' ? (
        <IconButton
          icon={FolderPlus}
          onClick={() => setOpen(true)}
          disabled={buttonDisabled}
          label={buttonLabel ?? 'Link projects'}
          title={buttonLabel ?? 'Link projects'}
          className={className}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={buttonDisabled}
          className={[
            'inline-flex min-h-7 min-w-0 items-center gap-1.5 border border-border px-2 py-1 font-mono text-xs uppercase text-secondary transition-colors',
            'hover:bg-hover hover:text-display focus-visible:bg-hover focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-secondary',
            'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-secondary',
            className,
          ].join(' ')}
        >
          <FolderPlus size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      )}

      {open && (
        <ProjectLinkDialog
          open={open}
          onOpenChange={setOpen}
          value={selectedIds}
          onChange={onChange}
          projects={projects}
          createProjectLabel={createProjectLabel}
          description={description}
          disabled={disabled}
          emptyLabel={emptyLabel}
          errorMessage={errorMessage}
          loading={loading}
          onCreateProject={onCreateProject}
          title={title}
        />
      )}
    </>
  )
}
