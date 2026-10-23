// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SiteAdapter } from "~adapters/base"
import { PromptManager } from "~core/prompt-manager"
import {
  appendQuickQuoteMarker,
  resolvePendingQuickQuoteMarkerEntriesFromElement,
} from "~core/quick-quote-marker"
import {
  createPromptQuoteReference,
  createPromptSelectionAnchor,
  scrollToQuoteReference,
} from "~core/quick-quote-utils"

vi.mock("~constants", () => ({ VIRTUAL_CATEGORY: { ALL: "all" } }))
vi.mock("~constants/defaults", () => ({ SITE_IDS: {} }))
vi.mock("~stores/prompts-store", () => ({}))
vi.mock("~utils/dom-toolkit", () => ({ DOMToolkit: {} }))
vi.mock("~utils/device", () => ({ isLikelyMobileDevice: () => false }))

let sessionNumber = 0
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
)
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect")

const restorePrototypeProperty = (
  prototype: object,
  name: string,
  descriptor: PropertyDescriptor | undefined,
) => {
  if (descriptor) Object.defineProperty(prototype, name, descriptor)
  else Reflect.deleteProperty(prototype, name)
}

function fixture() {
  document.body.innerHTML = `
    <main class="conversation"><article id="source" class="message"></article></main>
    <textarea></textarea>
  `
  const root = document.querySelector<HTMLElement>(".message")!
  const editor = document.querySelector("textarea")!
  const sessionId = `quote-session-${++sessionNumber}`
  const insertPrompt = vi.fn((content: string) => {
    editor.value = content
    return true
  })
  const adapter = {
    getSiteId: () => "gemini",
    getSessionId: () => sessionId,
    getCurrentCid: () => null,
    getChatContentSelectors: () => [".message"],
    getUserQuerySelector: () => ".user-query",
    getResponseContainerSelector: () => ".conversation",
    getScrollContainer: () => document.querySelector<HTMLElement>(".conversation"),
    getTextareaElement: () => editor,
    findTextarea: vi.fn(() => editor),
    insertPrompt,
  } as unknown as SiteAdapter
  const manager = new PromptManager(adapter)
  const resolve = (content: string, options = {}) => {
    const message = document.createElement("div")
    message.textContent = content
    return resolvePendingQuickQuoteMarkerEntriesFromElement(message, content, {
      allowMarkerlessMatch: true,
      currentSiteId: "gemini",
      currentSessionId: sessionId,
      markerlessScopeKey: `${sessionId}:new-message`,
      ...options,
    })
  }

  return { root, editor, adapter, manager, insertPrompt, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  restorePrototypeProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView)
  restorePrototypeProperty(Range.prototype, "getBoundingClientRect", originalRangeRect)
  document.body.replaceChildren()
})

describe("selection quote anchors", () => {
  it("anchors Markdown quotes against their original DOM text", () => {
    const { root, adapter } = fixture()
    root.innerHTML = '<p>长度 <span class="math-inline" data-math="a+b">a+b</span>。</p>'
    const range = document.createRange()
    range.selectNodeContents(root)

    const reference = createPromptQuoteReference({ range, selectedText: "长度 $a+b$。", adapter })!

    expect(reference.quoteText).toBe("> 长度 $a+b$。")
    expect(reference.selectedText).toBe("长度 $a+b$。")
    expect(reference.anchor).toMatchObject({
      selectedText: "长度 a+b。",
      selectedLength: "长度 a+b。".length,
      selectionIndex: 0,
      rootSelector: "#source",
    })
  })

  it("locates the selected occurrence when the same text appears twice", () => {
    const { root, adapter } = fixture()
    root.textContent = "开头 重复内容 中间 重复内容 结尾"
    const start = root.textContent.lastIndexOf("重复内容")
    const range = document.createRange()
    range.setStart(root.firstChild!, start)
    range.setEnd(root.firstChild!, start + 4)

    const anchor = createPromptSelectionAnchor({ range, selectedText: "重复内容", adapter })

    expect(anchor).toMatchObject({
      selectionIndex: start,
      selectedLength: 4,
      beforeText: "开头 重复内容 中间",
      afterText: "结尾",
      rootSelector: "#source",
      rootIndex: 0,
    })
  })

  it("normalizes whitespace across inline nodes and ignores quote chips", () => {
    const { root, adapter } = fixture()
    root.innerHTML = `<span class="gh-quick-quote-chip-row">辅助引用标签</span><p> \t开头<span> \n 目标 </span><strong> 段落\t尾部 </strong></p>`
    const paragraph = root.querySelector("p")!
    const range = document.createRange()
    range.setStart(paragraph, 1)
    range.setEnd(paragraph, 3)

    const anchor = createPromptSelectionAnchor({
      range,
      selectedText: range.toString().trim(),
      adapter,
    })

    expect(anchor).toMatchObject({
      selectionIndex: 3,
      beforeText: "开头",
      selectedLength: "目标 段落 尾部".length,
      rootTextSignature: "开头 目标 段落 尾部",
    })
  })

  it("captures a long quote with bounded DOM point comparisons", () => {
    const { root, adapter } = fixture()
    const prefix = "长回答的前文。".repeat(20000)
    const selectedText = "需要引用的长文本。".repeat(700)
    root.append(document.createTextNode(prefix), document.createTextNode(` \n${selectedText} 结尾`))
    const range = document.createRange()
    range.setStart(root.lastChild!, 2)
    range.setEnd(root.lastChild!, 2 + selectedText.length)
    const pointChecks = vi.spyOn(Range.prototype, "isPointInRange")

    const anchor = createPromptSelectionAnchor({ range, selectedText, adapter })

    expect(anchor?.selectionIndex).toBe(prefix.length + 1)
    expect(anchor?.selectedLength).toBe(selectedText.length)
    expect(anchor?.afterText).toBe("结尾")
    expect(pointChecks.mock.calls.length).toBeLessThanOrEqual(2)
  })
})

describe("quote insertion boundary", () => {
  it.each(["full", "ref"] as const)(
    "inserts visible text for a %s marker and retains its source reference",
    async (kind) => {
      const { root, editor, adapter, manager, insertPrompt, resolve } = fixture()
      root.textContent = "原文段落，包含需要引用的内容。"
      const range = document.createRange()
      range.selectNodeContents(root)
      const quoteRef = createPromptQuoteReference({
        range,
        selectedText: root.textContent,
        adapter,
      })!
      const content = `请解释这段内容：\n\n${quoteRef.quoteText}`
      const markedContent = appendQuickQuoteMarker(content, quoteRef, { kind })
      expect(markedContent).toContain("ophel-quick-quote:")

      expect(await manager.insertPrompt(markedContent)).toBe(true)

      expect(insertPrompt).toHaveBeenCalledWith(content)
      expect(editor.value).toBe(content)
      expect(editor.value).not.toContain("ophel-quick-quote")
      expect(resolve(content)[0]?.reference).toEqual(quoteRef)
      expect(resolve(content, { currentSessionId: "another-session" })).toEqual([])
    },
  )

  it("keeps ordinary prompt whitespace intact", async () => {
    const { manager, editor } = fixture()
    const content = "  缩进\n\n\n保留空行  \n"

    expect(await manager.insertPrompt(content)).toBe(true)
    expect(editor.value).toBe(content)
  })

  it("never passes a quote payload to the editor during insertion retries", async () => {
    vi.useFakeTimers()
    const { root, adapter, manager, insertPrompt } = fixture()
    root.textContent = "引用内容"
    const range = document.createRange()
    range.selectNodeContents(root)
    const quoteRef = createPromptQuoteReference({ range, selectedText: root.textContent, adapter })!
    insertPrompt.mockReturnValueOnce(false)
    const inserting = manager.insertPrompt(appendQuickQuoteMarker(quoteRef.quoteText, quoteRef))

    await vi.runAllTimersAsync()

    expect(await inserting).toBe(true)
    expect(insertPrompt).toHaveBeenCalledTimes(2)
    expect(insertPrompt.mock.calls.map(([content]) => content)).toEqual([
      quoteRef.quoteText,
      quoteRef.quoteText,
    ])
  })

  it("retries immediately when the cached editor has been replaced", async () => {
    vi.useFakeTimers()
    const { editor: oldEditor, adapter, manager } = fixture()
    const newEditor = document.createElement("textarea")
    document.body.append(newEditor)
    let activeEditor = oldEditor
    const insertPrompt = vi.spyOn(adapter, "insertPrompt").mockImplementation((content) => {
      if (activeEditor === oldEditor) return false
      newEditor.value = content
      return true
    })
    vi.spyOn(adapter, "getTextareaElement").mockReturnValue(oldEditor)
    const findTextarea = vi.spyOn(adapter, "findTextarea").mockImplementation(() => {
      activeEditor = newEditor
      return newEditor
    })

    expect(await manager.insertPrompt("replacement editor")).toBe(true)
    expect(findTextarea).toHaveBeenCalledTimes(1)
    expect(insertPrompt).toHaveBeenCalledTimes(2)
    expect(newEditor.value).toBe("replacement editor")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops retrying a failed insertion and preserves the existing draft", async () => {
    vi.useFakeTimers()
    const { editor, manager, insertPrompt } = fixture()
    editor.value = "existing draft"
    insertPrompt.mockReturnValue(false)

    const inserting = manager.insertPrompt("> 公式 $a+b$\n\n")
    await vi.runAllTimersAsync()

    expect(await inserting).toBe(false)
    expect(insertPrompt).toHaveBeenCalledTimes(5)
    expect(editor.value).toBe("existing draft")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("can jump from a resolved sent quote back to its original text", async () => {
    const { root, adapter, manager, resolve } = fixture()
    root.textContent = "前文 需要引用的内容 后文"
    const range = document.createRange()
    range.setStart(root.firstChild!, 3)
    range.setEnd(root.firstChild!, 10)
    const reference = createPromptQuoteReference({
      range,
      selectedText: range.toString(),
      adapter,
    })!
    const visibleContent = `${reference.quoteText}\n\n`
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    })
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 0, 0),
    })
    vi.stubGlobal("CSS", { escape: (value: string) => value })

    expect(await manager.insertPrompt(appendQuickQuoteMarker(visibleContent, reference))).toBe(true)
    const sentReference = resolve(visibleContent)[0]?.reference
    expect(sentReference).toBeDefined()
    expect(scrollToQuoteReference(sentReference!, adapter)).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
