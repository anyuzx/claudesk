import {
  normalizeBlockquoteCalloutMarkerSpacing,
  unescapeBlockquoteCalloutMarkers,
} from './markdownCallouts'
import { stripRichMarkdownCursorSentinels } from './richMarkdownMath'
import { normalizeRichMarkdownTableEmptyCells } from './richMarkdownTables'

function unescapeWikilinkDelimiters(value: string): string {
  return value
    .replace(/\\\[\\\[/g, '[[')
    .replace(/\\\]\\\]/g, ']]')
}

export function cleanRichMarkdownOutput(value: string): string {
  return unescapeWikilinkDelimiters(
    normalizeRichMarkdownTableEmptyCells(
      normalizeBlockquoteCalloutMarkerSpacing(
        unescapeBlockquoteCalloutMarkers(stripRichMarkdownCursorSentinels(value)),
      ),
    ),
  )
}
