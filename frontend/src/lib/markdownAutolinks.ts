import type { Root } from 'mdast'

type MarkdownNode = {
  type?: string
  value?: unknown
  url?: unknown
  children?: MarkdownNode[]
}

function nodeText(node: MarkdownNode): string {
  if (node.type === 'text' && typeof node.value === 'string') return node.value
  return (node.children ?? []).map(nodeText).join('')
}

function isTextNode(node: MarkdownNode | undefined): node is MarkdownNode & { value: string } {
  return node?.type === 'text' && typeof node.value === 'string'
}

function isGfmBareDomainAutolink(node: MarkdownNode | undefined) {
  if (node?.type !== 'link' || typeof node.url !== 'string') return false

  const text = nodeText(node)
  return text.startsWith('www.') && node.url === `http://${text}`
}

export function unwrapAngleBracketBareAutolinks(node: MarkdownNode): void {
  const children = node.children
  if (!children) return

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child) unwrapAngleBracketBareAutolinks(child)
  }

  for (let index = 1; index < children.length - 1; index += 1) {
    const previous = children[index - 1]
    const current = children[index]
    const next = children[index + 1]

    if (
      !isTextNode(previous) ||
      !isGfmBareDomainAutolink(current) ||
      !isTextNode(next) ||
      !previous.value.endsWith('<') ||
      !next.value.startsWith('>')
    ) {
      continue
    }

    previous.value = previous.value.slice(0, -1)
    next.value = next.value.slice(1)
  }

  node.children = children.filter((child) => (
    !isTextNode(child) || child.value.length > 0
  ))
}

function remarkAngleBracketBareAutolinks() {
  return (tree: Root) => {
    unwrapAngleBracketBareAutolinks(tree as MarkdownNode)
  }
}

export default remarkAngleBracketBareAutolinks
