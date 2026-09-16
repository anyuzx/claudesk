import type { Root } from 'mdast'

type MarkdownNode = {
  type?: string
  value?: unknown
  children?: MarkdownNode[]
  position?: unknown
}

const htmlBreakPattern = /^<br\s*\/?>$/i
const blockBreakContainerTypes = new Set(['blockquote', 'listItem', 'root'])

function isHtmlBreak(node: MarkdownNode | undefined): node is MarkdownNode & { value: string } {
  return node?.type === 'html' && typeof node.value === 'string' && htmlBreakPattern.test(node.value.trim())
}

function htmlBreakNode(node: MarkdownNode): MarkdownNode {
  return {
    type: 'break',
    position: node.position,
  }
}

function htmlBreakParagraph(node: MarkdownNode): MarkdownNode {
  return {
    type: 'paragraph',
    children: [htmlBreakNode(node)],
    position: node.position,
  }
}

function normalizeHtmlBreakChildren(node: MarkdownNode): void {
  const children = node.children
  if (!children) return

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!child) continue

    if (isHtmlBreak(child)) {
      if (node.type === 'tableCell' && children.length === 1) {
        children.splice(index, 1)
        index -= 1
        continue
      }

      children[index] = blockBreakContainerTypes.has(node.type ?? '')
        ? htmlBreakParagraph(child)
        : htmlBreakNode(child)
      continue
    }

    normalizeHtmlBreakChildren(child)
  }
}

function remarkHtmlBreaks() {
  return (tree: Root) => {
    normalizeHtmlBreakChildren(tree as MarkdownNode)
  }
}

export default remarkHtmlBreaks
