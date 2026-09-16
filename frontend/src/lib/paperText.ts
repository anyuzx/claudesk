function tidyPaperText(value: string): string {
  return value
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s*([-–/])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function fallbackNormalize(value: string): string {
  return tidyPaperText(
    value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&alpha;/gi, 'α')
    .replace(/&beta;/gi, 'β')
    .replace(/&gamma;/gi, 'γ')
    .replace(/&delta;/gi, 'δ')
    .replace(/&epsilon;/gi, 'ε')
    .replace(/&kappa;/gi, 'κ')
    .replace(/&lambda;/gi, 'λ')
    .replace(/&mu;/gi, 'μ')
    .replace(/&pi;/gi, 'π')
    .replace(/&sigma;/gi, 'σ')
    .replace(/&tau;/gi, 'τ')
    .replace(/&phi;/gi, 'φ')
    .replace(/&omega;/gi, 'ω')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  )
}

export function formatPaperDateLabel(publishedDate: string, journalAbbrev?: string | null): string {
  if (!journalAbbrev) return publishedDate
  return `${publishedDate} · ${journalAbbrev}`
}

export function formatPaperDoi(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  let candidate = trimmed
    .replace(/^doi\s*:/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim()

  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // Keep the original value if it is not URI encoded.
  }

  const doi = candidate.trim().toLowerCase()
  if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) return null
  return doi
}

export function formatAssetSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function normalizePaperText(value: string): string {
  if (!value) return ''
  if (!/[<&]/.test(value)) return value

  if (typeof DOMParser === 'undefined') {
    return fallbackNormalize(value)
  }

  const doc = new DOMParser().parseFromString(value, 'text/html')
  const text = doc.documentElement.textContent ?? ''
  return tidyPaperText(text)
}
