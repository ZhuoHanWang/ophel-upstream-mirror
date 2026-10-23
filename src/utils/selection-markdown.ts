import { htmlToMarkdown, MARKDOWN_MATH_SELECTOR } from "~utils/exporter"

const getElement = (node: Node): Element | null =>
  node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement

const getMathHost = (node: Node): Element | null => {
  let host = getElement(node)?.closest(MARKDOWN_MATH_SELECTOR) || null
  if (!host) return null

  let parent = host.parentElement?.closest(MARKDOWN_MATH_SELECTOR)
  while (parent) {
    host = parent
    parent = host.parentElement?.closest(MARKDOWN_MATH_SELECTOR)
  }
  return host
}

/** Serialize the selected DOM, including formulas excluded by user-select: none. */
export const selectionToMarkdown = (range: Range): string => {
  if (range.collapsed) return ""

  const contentRange = range.cloneRange()
  const startMath = getMathHost(contentRange.startContainer)
  const endMath = getMathHost(contentRange.endContainer)
  // Rendered glyphs and MathML are duplicate views of one formula. A selection
  // touching either view must retain the complete source exactly once.
  if (startMath) contentRange.setStartBefore(startMath)
  if (endMath) contentRange.setEndAfter(endMath)

  const source = getElement(contentRange.commonAncestorContainer)
  const document = contentRange.startContainer.ownerDocument!
  let content: Node = contentRange.cloneContents()
  if (source) {
    // cloneContents omits its common ancestor. Keep the formatting context of
    // partial selections inside lists, tables and code without copying siblings.
    const context = source.closest("pre, code-block, table, ol, ul, blockquote") || source
    let current: Element | null = source
    while (current) {
      const wrapper = current.cloneNode(false)
      wrapper.appendChild(content)
      content = wrapper
      if (current === context) break
      current = current.parentElement
    }
  }

  const container = document.createElement("div")
  container.appendChild(content)
  container
    .querySelectorAll(".gh-root, .gh-main-panel, .gh-quick-quote-chip-row, .gh-quick-quote-chip")
    .forEach((element) => element.remove())
  return htmlToMarkdown(container)
}
