import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-success" />
        ),
        info: (
          <InfoIcon className="size-4 text-secondary" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4 text-warn" />
        ),
        error: (
          <OctagonXIcon className="size-4 text-accent" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin text-secondary" />
        ),
      }}
      style={
        {
          '--normal-bg': 'var(--color-bg)',
          '--normal-text': 'var(--color-primary)',
          '--normal-border': 'var(--color-border)',
          '--success-bg': 'color-mix(in oklch, var(--color-success) 10%, var(--color-bg))',
          '--success-text': 'var(--color-primary)',
          '--success-border': 'color-mix(in oklch, var(--color-success) 38%, var(--color-border))',
          '--error-bg': 'color-mix(in oklch, var(--color-accent) 10%, var(--color-bg))',
          '--error-text': 'var(--color-primary)',
          '--error-border': 'color-mix(in oklch, var(--color-accent) 38%, var(--color-border))',
          '--border-radius': 'var(--control-radius)',
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'border-border bg-bg text-primary shadow-none font-sans',
          title: 'font-mono text-xs tracking-normal text-display',
          description: 'font-sans text-xs text-secondary',
          closeButton: 'border-border bg-bg text-secondary hover:bg-hover hover:text-display',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
