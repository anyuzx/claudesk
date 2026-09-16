import type { Project } from '../types'

function rawAcronym(name: string, maxChars: number): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const singleCap = Math.min(maxChars, 3)
  if (words.length === 1) {
    const letters = words[0].replace(/[^A-Za-z0-9]/g, '')
    return letters.slice(0, singleCap).toUpperCase()
  }
  return words
    .map((word) => {
      const m = word.match(/[A-Za-z0-9]/)
      return m ? m[0] : ''
    })
    .join('')
    .slice(0, maxChars)
    .toUpperCase()
}

function fallbackLabel(project: Project, maxChars: number): string {
  const slugCap = Math.min(maxChars, 3)
  const slugLetters = (project.slug ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, slugCap).toUpperCase()
  if (slugLetters) return slugLetters
  return `P${project.id}`
}

export function buildProjectAbbreviations(
  projects: Project[],
  maxChars: number = 4,
): Map<number, string> {
  const result = new Map<number, string>()
  const groups = new Map<string, Project[]>()

  const sorted = [...projects].sort((a, b) => a.id - b.id)
  for (const project of sorted) {
    const base = rawAcronym(project.name, maxChars) || fallbackLabel(project, maxChars)
    const list = groups.get(base) ?? []
    list.push(project)
    groups.set(base, list)
  }

  for (const [base, list] of groups) {
    if (list.length === 1) {
      result.set(list[0].id, base)
    } else {
      list.forEach((project, i) => result.set(project.id, `${base}${i + 1}`))
    }
  }

  return result
}
