import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { cn } from '../lib/cn'
import { InlineStatus } from './ui/inline-status'
import type { RichMarkdownEditorProps } from './RichMarkdownNoteEditor'

const RichMarkdownEditor = lazy(async () => {
  const module = await import('./RichMarkdownNoteEditor')
  return { default: module.RichMarkdownEditor }
})

type RichMarkdownEditorFieldProps = {
  value: string
  onChange: (value: string) => void
  ariaDescribedBy?: string
  ariaInvalid?: boolean
  ariaLabel: string
  autoFocus?: boolean
  className?: string
  contentTestId?: string
  id?: string
  onBlur?: (value: string) => void
  placeholder?: string
  resetKey?: string
}

const fieldClassName = [
  'claudesk-rich-markdown-editor-field min-h-28 border border-border bg-transparent',
  'font-sans text-sm leading-relaxed text-primary',
].join(' ')

export default function RichMarkdownEditorField({
  value,
  onChange,
  ariaDescribedBy,
  ariaInvalid = false,
  ariaLabel,
  autoFocus = false,
  className,
  contentTestId,
  id,
  onBlur,
  placeholder,
  resetKey,
}: RichMarkdownEditorFieldProps) {
  const generatedId = useId()
  const lastLocalValueRef = useRef(value)
  const [externalSyncVersion, setExternalSyncVersion] = useState(0)

  useEffect(() => {
    if (value === lastLocalValueRef.current) return
    lastLocalValueRef.current = value
    setExternalSyncVersion((version) => version + 1)
  }, [value])

  const handleChange = useCallback<RichMarkdownEditorProps['onChange']>((nextValue) => {
    lastLocalValueRef.current = nextValue
    onChange(nextValue)
  }, [onChange])

  const handleBlur = useCallback<NonNullable<RichMarkdownEditorProps['onBlur']>>((nextValue) => {
    if (nextValue !== lastLocalValueRef.current) {
      lastLocalValueRef.current = nextValue
      flushSync(() => {
        onChange(nextValue)
      })
    }
    onBlur?.(nextValue)
  }, [onBlur, onChange])

  const editorClassName = cn(fieldClassName, className)
  const editorResetKey = resetKey ?? generatedId

  return (
    <Suspense
      fallback={(
        <div className={editorClassName}>
          <InlineStatus uppercase>Loading editor...</InlineStatus>
        </div>
      )}
    >
      <RichMarkdownEditor
        initialValue={value}
        externalValue={value}
        externalSyncVersion={externalSyncVersion}
        resetKey={editorResetKey}
        onChange={handleChange}
        ariaDescribedBy={ariaDescribedBy}
        ariaInvalid={ariaInvalid}
        ariaLabel={ariaLabel}
        autoFocus={autoFocus}
        className={editorClassName}
        contentTestId={contentTestId}
        id={id}
        onBlur={handleBlur}
        placeholder={placeholder}
      />
    </Suspense>
  )
}
