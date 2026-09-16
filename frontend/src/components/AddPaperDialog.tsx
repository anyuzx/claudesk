import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AddPaperByDoiResult } from '../types'
import * as api from '../api'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogClose, DialogTitle } from './ui/dialog'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

type Notice = {
  type: 'info' | 'error'
  text: string
  warnings?: string[]
}

type AddPaperDialogProps = {
  open: boolean
  onClose: () => void
  onPaperAdded: (result: AddPaperByDoiResult) => void
}

function statusLabel(status: AddPaperByDoiResult['status']): string {
  if (status === 'created') return 'Added'
  if (status === 'duplicate') return 'Matched existing paper'
  return 'Paper already exists'
}

function formatDoiWarning(warning: string): string {
  if (warning.includes('Version suffix was removed')) {
    return 'Version suffix removed for lookup; double-check the DOI.'
  }
  if (warning.includes('No abstract found')) {
    return "No abstract found; paste one in the selected paper's Abstract tab."
  }
  return warning
}

export default function AddPaperDialog({
  open,
  onClose,
  onPaperAdded,
}: AddPaperDialogProps) {
  const [doiInput, setDoiInput] = useState('')
  const [savePaper, setSavePaper] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const wasOpenRef = useRef(false)

  const addPaperMut = useMutation({
    mutationFn: (data: { doi: string; save: boolean }) => api.addPaperByDoi(data),
    onSuccess: (result) => {
      setNotice({
        type: 'info',
        text: statusLabel(result.status),
        warnings: result.warnings.map(formatDoiWarning),
      })
      setDoiInput('')
      onPaperAdded(result)
    },
    onError: (error) => {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'DOI add failed',
      })
    },
  })

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (wasOpenRef.current) return
    wasOpenRef.current = true
    setDoiInput('')
    setSavePaper(true)
    setNotice(null)
  }, [open])

  function requestClose() {
    if (addPaperMut.isPending) return
    onClose()
  }

  function submitDoi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const doi = doiInput.trim()
    if (!doi) {
      setNotice({ type: 'error', text: 'DOI is required.' })
      return
    }
    setNotice(null)
    addPaperMut.mutate({ doi, save: savePaper })
  }

  const noticeLines = notice ? [notice.text, ...(notice.warnings ?? [])] : []

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose()
      }}
      ariaDescribedBy={notice ? 'add-paper-notice' : undefined}
      className="max-w-md"
      disablePointerDismissal={addPaperMut.isPending}
      initialFocus={inputRef}
    >
      <form
        onSubmit={submitDoi}
        className="contents"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle
            id="add-paper-title"
          >
            Add Paper
          </DialogTitle>
          <DialogClose
            disabled={addPaperMut.isPending}
          >
            Cancel
          </DialogClose>
        </div>

        <Field className="grid gap-2">
          <FieldLabel htmlFor="add-paper-doi" className="text-secondary">
            DOI
          </FieldLabel>
          <Input
            id="add-paper-doi"
            ref={inputRef}
            value={doiInput}
            onChange={(event) => setDoiInput(event.target.value)}
            disabled={addPaperMut.isPending}
            placeholder="DOI or DOI URL"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={notice?.type === 'error' ? true : undefined}
          />
        </Field>

        <div className="mt-4 flex items-center justify-between gap-4">
          <label className="flex items-center gap-2 font-mono text-xs uppercase text-secondary">
            <Checkbox
              checked={savePaper}
              onCheckedChange={setSavePaper}
              disabled={addPaperMut.isPending}
            />
            Save
          </label>
          <Button
            type="submit"
            disabled={addPaperMut.isPending}
            variant="ghost"
            size="sm"
            className="font-mono text-xs uppercase"
          >
            {addPaperMut.isPending ? 'Adding...' : 'Add'}
          </Button>
        </div>

        {notice && (
          <Alert
            id="add-paper-notice"
            variant={notice.type === 'error' ? 'error' : 'default'}
            className="mt-4"
          >
            {noticeLines.map((line) => (
              <AlertDescription key={line}>
                [{line}]
              </AlertDescription>
            ))}
          </Alert>
        )}
      </form>
    </Dialog>
  )
}
