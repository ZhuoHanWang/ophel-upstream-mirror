// @vitest-environment jsdom
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"

import type { SiteAdapter } from "~adapters/base"
import { QuickQuoteActions } from "~components/QuickQuoteActions"
import type { PromptChain } from "~core/prompt-action-types"
import type { PromptManager } from "~core/prompt-manager"
import * as quoteUtils from "~core/quick-quote-utils"
import { showToast } from "~utils/toast"

const { visibleChains } = vi.hoisted(() => ({ visibleChains: [] as PromptChain[] }))

vi.mock("~stores/prompt-chains-store", () => ({
  usePromptChainsStore: (selector: (state: unknown) => unknown) =>
    selector({ chains: visibleChains, updateLastUsed: vi.fn() }),
}))
vi.mock("~stores/prompts-store", () => ({
  usePromptsStore: (selector: (state: unknown) => unknown) => selector({ prompts: [] }),
}))
vi.mock("~stores/queue-store", () => ({
  useQueueStore: (selector: (state: unknown) => unknown) => selector({ enqueueMany: vi.fn() }),
}))
vi.mock("~stores/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        settings: { features: { prompts: { quickQuoteEnabled: true, promptQueue: false } } },
        updateDeepSetting: vi.fn(),
      }),
    { getState: () => ({ settings: { features: { prompts: { promptQueue: false } } } }) },
  ),
}))
vi.mock("~utils/i18n", () => ({ t: (key: string) => key }))
vi.mock("~utils/toast", () => ({ showToast: vi.fn() }))

let root: Root | null = null

const fixture = async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.body.innerHTML =
    '<main class="conversation"><article class="message" id="first">第一段引用内容</article><article class="message" id="second">第二段引用内容</article></main>'
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  let sessionId = "session-one"
  const adapter = {
    getQuickQuoteSupportMode: () => "enabled",
    getSiteId: () => "gemini",
    getSessionId: () => sessionId,
    getCurrentCid: () => "account",
    getChatContentSelectors: () => [".message"],
    getUserQuerySelector: () => "",
    getResponseContainerSelector: () => ".conversation",
    getScrollContainer: () => document.querySelector(".conversation"),
    getObserveTarget: () => null,
  } as unknown as SiteAdapter
  const insertPrompt = vi.fn().mockResolvedValue(true)
  const manager = { insertPrompt } as unknown as PromptManager
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames[id - 1] = () => {}
  })
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(10, 10, 80, 20), new DOMRect(20, 10_000, 20, 20)],
  })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function (this: Range) {
      return this.collapsed ? new DOMRect(45, 320, 0, 20) : new DOMRect(10, 10, 80, 20)
    },
  })
  await act(async () =>
    root!.render(React.createElement(QuickQuoteActions, { adapter, promptManager: manager })),
  )

  const select = async (index: number) => {
    const message = document.querySelectorAll(".message")[index]
    const range = document.createRange()
    range.selectNodeContents(message)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector(".gh-quick-quote-popover")).not.toBeNull()
  }
  const changeLiveSelection = (index: number) => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelectorAll(".message")[index])
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const clickQuote = async () => {
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[title="quickQuoteQuote"]')!.click()
      await Promise.resolve()
    })
  }
  return {
    frames,
    select,
    changeLiveSelection,
    clickQuote,
    insertPrompt,
    setSessionId: (value: string) => (sessionId = value),
  }
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  visibleChains.length = 0
  vi.clearAllMocks()
  vi.restoreAllMocks()
  delete (Range.prototype as Partial<Range>).getClientRects
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it("precomputes after the popover appears and reuses the anchor on click", async () => {
  const anchor = vi.spyOn(quoteUtils, "createPromptQuoteReference")
  const f = await fixture()
  await f.select(0)
  expect(anchor).not.toHaveBeenCalled()
  expect(f.frames.length).toBe(1)

  await act(async () => f.frames[0](performance.now()))
  expect(anchor).toHaveBeenCalledTimes(1)
  await f.clickQuote()
  expect(anchor).toHaveBeenCalledTimes(1)
  expect(f.insertPrompt).toHaveBeenCalledTimes(1)
})

it("builds a fresh anchor for an immediate click or a changed selection", async () => {
  const anchor = vi.spyOn(quoteUtils, "createPromptQuoteReference")
  const f = await fixture()
  await f.select(0)
  await f.clickQuote()
  expect(anchor).toHaveBeenCalledTimes(1)

  await f.select(0)
  await f.select(1)
  await f.clickQuote()
  expect(anchor).toHaveBeenCalledTimes(2)
  expect(anchor.mock.calls[1][0].selectedText).toContain("第二段")
  expect(f.insertPrompt).toHaveBeenCalledTimes(2)
})

it("does not insert a stale selection after a session switch", async () => {
  const f = await fixture()
  await f.select(0)
  f.setSessionId("session-two")
  await f.clickQuote()
  expect(f.insertPrompt).not.toHaveBeenCalled()

  await f.select(1)
  await f.clickQuote()
  expect(f.insertPrompt).toHaveBeenCalledTimes(1)
})

it("uses the current selection when it changes before the toolbar refresh", async () => {
  const anchor = vi.spyOn(quoteUtils, "createPromptQuoteReference")
  const f = await fixture()
  await f.select(0)
  f.changeLiveSelection(1)
  await f.clickQuote()

  expect(anchor).toHaveBeenCalledTimes(1)
  expect(anchor.mock.calls[0][0].selectedText).toContain("第二段")
  expect(f.insertPrompt.mock.calls[0][0]).toContain("第二段引用内容")
})

it.each([false, true])(
  "positions the toolbar at the active endpoint when backward=%s despite distant controls",
  async (backward) => {
    await fixture()
    const text = document.querySelector("#second")!.firstChild as Text
    const selection = window.getSelection()!
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      if (!this.collapsed) return new DOMRect(45, 200, 300, 240)
      return this.startOffset === 0 ? new DOMRect(45, 200, 0, 20) : new DOMRect(300, 420, 0, 20)
    })
    selection.setBaseAndExtent(text, backward ? text.length : 0, text, backward ? 0 : text.length)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const popover = document.querySelector<HTMLElement>(".gh-quick-quote-popover")
    expect(popover?.style.left).toBe(backward ? "45px" : "300px")
    expect(popover?.style.top).toBe(backward ? "152px" : "372px")
  },
)

it.each([false, true])(
  "uses the visible range end when the caret is unmeasurable and backward=%s",
  async (backward) => {
    await fixture()
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect())
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      new DOMRect(10, -100, 80, 20),
      new DOMRect(100, 200, 80, 20),
      new DOMRect(300, 400, 80, 20),
      new DOMRect(20, 10_000, 20, 20),
    ] as unknown as DOMRectList)
    const text = document.querySelector("#second")!.firstChild as Text
    window
      .getSelection()!
      .setBaseAndExtent(text, backward ? text.length : 0, text, backward ? 0 : text.length)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const popover = document.querySelector<HTMLElement>(".gh-quick-quote-popover")
    expect(popover?.style.left).toBe(backward ? "140px" : "340px")
    expect(popover?.style.top).toBe(backward ? "152px" : "352px")
  },
)

it.each(["top-left", "bottom-right"])("keeps the full toolbar within the %s edge", async (edge) => {
  const f = await fixture()
  const topLeft = edge === "top-left"
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(topLeft ? 1 : window.innerWidth - 1, topLeft ? 1 : window.innerHeight + 200, 0, 20),
  )
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("gh-quick-quote-popover")
      ? new DOMRect(0, 0, 240, 40)
      : new DOMRect()
  })
  await f.select(1)

  const popover = document.querySelector<HTMLElement>(".gh-quick-quote-popover")!
  const center = Number.parseFloat(popover.style.left)
  const top = Number.parseFloat(popover.style.top)
  expect(center - 120).toBeGreaterThanOrEqual(10)
  expect(center + 120).toBeLessThanOrEqual(window.innerWidth - 10)
  expect(top).toBeGreaterThanOrEqual(10)
  expect(top + 40).toBeLessThanOrEqual(window.innerHeight - 10)
})

it("hides the toolbar when neither the caret nor any selection rect is visible", async () => {
  await fixture()
  const text = document.querySelector("#second")!.firstChild as Text
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect())
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    new DOMRect(20, 10_000, 20, 20),
  ] as unknown as DOMRectList)
  window.getSelection()!.setBaseAndExtent(text, text.length, text, 0)

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(document.querySelector(".gh-quick-quote-popover")).toBeNull()
})

it("reuses the precomputed anchor for a prompt chain", async () => {
  visibleChains.push({
    id: "test-chain",
    title: "test-chain",
    showInSelectionPopover: true,
    steps: [{ id: "step", promptId: "", runMode: "enqueue" }],
    createdAt: 1,
    updatedAt: 1,
  })
  const anchor = vi.spyOn(quoteUtils, "createPromptQuoteReference")
  const f = await fixture()
  await f.select(0)
  await act(async () => f.frames[0](performance.now()))
  expect(anchor).toHaveBeenCalledTimes(1)

  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[title="test-chain"]')!.click(),
  )
  expect(anchor).toHaveBeenCalledTimes(1)
  expect(document.querySelector(".gh-quick-quote-queue-gate")).not.toBeNull()
})

it.each(["quote", "chain"])("preserves the editor caret after inserting a %s", async (action) => {
  if (action === "chain") {
    visibleChains.push({
      id: "insert-chain",
      title: "insert-chain",
      showInSelectionPopover: true,
      steps: [
        { id: "step", promptId: "", mode: "inline", inlineContent: "{{quote}}", runMode: "insert" },
      ],
      createdAt: 1,
      updatedAt: 1,
    })
  }
  const f = await fixture()
  const editor = document.createElement("div")
  editor.setAttribute("contenteditable", "true")
  editor.tabIndex = 0
  document.body.append(editor)
  f.insertPrompt.mockImplementation(async () => {
    editor.textContent = "draft with quote"
    editor.focus()
    const range = document.createRange()
    range.setStart(editor.firstChild!, 5)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })

  await f.select(0)
  if (action === "quote") await f.clickQuote()
  else {
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[title="insert-chain"]')!.click()
      await Promise.resolve()
    })
  }

  expect(f.insertPrompt).toHaveBeenCalledTimes(1)
  expect(document.querySelector(".gh-quick-quote-popover")).toBeNull()
  expect(document.activeElement).toBe(editor)
  const selection = window.getSelection()!
  expect(selection.rangeCount).toBe(1)
  expect(selection.isCollapsed).toBe(true)
  expect(selection.anchorNode).toBe(editor.firstChild)
  expect(selection.anchorOffset).toBe(5)
})

it("clears the source selection and popover after a successful insertion", async () => {
  const f = await fixture()
  await f.select(0)
  await f.clickQuote()

  expect(window.getSelection()!.rangeCount).toBe(0)
  expect(document.querySelector(".gh-quick-quote-popover")).toBeNull()
})

it("keeps the source selection and popover and shows an error when insertion fails", async () => {
  const f = await fixture()
  f.insertPrompt.mockResolvedValue(false)
  await f.select(0)
  await f.clickQuote()

  expect(window.getSelection()!.toString()).toBe("第一段引用内容")
  expect(document.querySelector(".gh-quick-quote-popover")).not.toBeNull()
  expect(showToast).toHaveBeenCalledWith("insertFailed")
  expect(showToast).not.toHaveBeenCalledWith("quickQuoteInserted", 1800)
})
