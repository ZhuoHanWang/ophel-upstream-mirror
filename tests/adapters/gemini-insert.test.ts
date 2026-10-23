// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"

import { GeminiAdapter } from "~adapters/gemini"
import {
  GEMINI_COMPOSER_BRIDGE_ATTR,
  GEMINI_COMPOSER_INSERT_EVENT,
  type GeminiComposerBridgeWindow,
  installGeminiComposerBridge,
} from "~core/gemini-composer-bridge"

vi.mock("~platform", () => ({ platform: {} }))

interface MockQuill {
  root: HTMLElement
  getLength: ReturnType<typeof vi.fn>
  getSelection: ReturnType<typeof vi.fn>
  insertText: ReturnType<typeof vi.fn>
  setSelection: ReturnType<typeof vi.fn>
}

const bridgeListeners: EventListenerOrEventListenerObject[] = []

afterEach(() => {
  bridgeListeners.splice(0).forEach((listener) => {
    document.removeEventListener(GEMINI_COMPOSER_INSERT_EVENT, listener)
  })
  vi.restoreAllMocks()
  window.getSelection()?.removeAllRanges()
  document.documentElement.removeAttribute(GEMINI_COMPOSER_BRIDGE_ATTR)
  delete (window as GeminiComposerBridgeWindow).__ophelGeminiComposerBridgeInstalled
  document.body.replaceChildren()
})

function createEditor(draft: string): HTMLElement {
  const editor = document.createElement("div")
  editor.className = "ql-editor"
  editor.contentEditable = "true"
  editor.tabIndex = 0
  editor.textContent = draft
  document.body.append(editor)
  return editor
}

function attachQuill(editor: HTMLElement): MockQuill {
  // 真实页面把 Quill 挂在编辑器祖先 rich-textarea 上，而不是编辑器本身
  const host = document.createElement("div")
  host.className = "rich-textarea"
  editor.before(host)
  host.append(editor)

  const quill: MockQuill = {
    root: editor,
    getLength: vi.fn(() => (editor.textContent || "").length + 1),
    getSelection: vi.fn(() => null),
    insertText: vi.fn((index: number, text: string) => {
      const currentText = editor.textContent || ""
      editor.textContent = currentText.slice(0, index) + text + currentText.slice(index)
    }),
    setSelection: vi.fn(),
  }
  Object.defineProperty(host, "__quill", { configurable: true, value: quill })
  return quill
}

function mountAdapter(editor: HTMLElement): GeminiAdapter {
  const adapter = new GeminiAdapter()
  ;(adapter as unknown as { textarea: HTMLElement }).textarea = editor
  return adapter
}

function mockExecCommand() {
  const execCommand = vi.fn(() => false)
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand })
  return execCommand
}

function installBridge() {
  const addEventListener = vi.spyOn(document, "addEventListener")
  installGeminiComposerBridge(window)
  addEventListener.mock.calls.forEach(([type, listener]) => {
    if (type === GEMINI_COMPOSER_INSERT_EVENT && listener) bridgeListeners.push(listener)
  })
  addEventListener.mockRestore()
}

it("inserts a multiline formula quote into an empty editor in one Quill operation", () => {
  const editor = createEditor("")
  const quill = attachQuill(editor)
  const adapter = mountAdapter(editor)
  const execCommand = mockExecCommand()
  installBridge()
  const content = "> 公式 $a+b$\n>\n> $$\\sum_{i=1}^n i$$\n\n"

  expect(adapter.insertPrompt(content)).toBe(true)
  expect(quill.insertText).toHaveBeenCalledExactlyOnceWith(0, content, "user")
  expect(quill.setSelection).toHaveBeenCalledExactlyOnceWith(content.length, 0, "user")
  expect(editor.textContent).toBe(content)
  expect(execCommand).not.toHaveBeenCalled()
})

it("uses a synchronous bridge to preserve an existing draft", () => {
  const editor = createEditor("existing draft")
  const quill = attachQuill(editor)
  vi.spyOn(window, "queueMicrotask").mockImplementation(() => {
    throw new Error("synchronous bridge expected")
  })
  const adapter = mountAdapter(editor)
  const execCommand = mockExecCommand()
  installBridge()
  const quillHost = editor.parentElement as Element & { __quill?: unknown }
  expect(quillHost.__quill).toBeDefined()

  expect(adapter.insertPrompt("new quote")).toBe(true)
  expect(quill.insertText).toHaveBeenCalledExactlyOnceWith(14, "new quote", "user")
  expect(editor.textContent).toBe("existing draftnew quote")
  expect(execCommand).not.toHaveBeenCalled()
})

it("inserts at a focused collapsed cursor in the middle of a draft", () => {
  const editor = createEditor("existing draft")
  const quill = attachQuill(editor)
  quill.getSelection.mockReturnValue({ index: 9, length: 0 })
  const adapter = mountAdapter(editor)
  editor.focus()
  mockExecCommand()
  installBridge()

  expect(adapter.insertPrompt("new quote")).toBe(true)
  expect(quill.insertText).toHaveBeenCalledWith(9, "new quote", "user")
  expect(quill.setSelection).toHaveBeenCalledWith(18, 0, "user")
  expect(editor.textContent).toBe("existing new quotedraft")
})

it("allows the main world to resolve Quill from the event path", () => {
  const editor = createEditor("existing draft")
  const quill = attachQuill(editor)
  const adapter = mountAdapter(editor)
  const execCommand = mockExecCommand()
  installBridge()

  expect(adapter.insertPrompt("new quote")).toBe(true)
  expect(quill.insertText).toHaveBeenCalledWith(14, "new quote", "user")
  expect(editor.textContent).toBe("existing draftnew quote")
  expect(execCommand).not.toHaveBeenCalled()
})

it.each(["", "existing draft"])("preserves %j when Quill insertion throws", (draft) => {
  const editor = createEditor(draft)
  const quill = attachQuill(editor)
  quill.insertText.mockImplementation(() => {
    throw new Error("quill unavailable")
  })
  const adapter = mountAdapter(editor)
  const execCommand = mockExecCommand()
  installBridge()
  vi.spyOn(console, "warn").mockImplementation(() => {})

  expect(adapter.insertPrompt("new quote")).toBe(false)
  expect(editor.textContent).toBe(draft)
  expect(execCommand).not.toHaveBeenCalled()
})

it.each(["", "existing draft"])("preserves %j when the editor has no Quill", (draft) => {
  const editor = createEditor(draft)
  const adapter = mountAdapter(editor)
  const execCommand = mockExecCommand()
  installBridge()

  expect(adapter.insertPrompt("new quote")).toBe(false)
  expect(editor.textContent).toBe(draft)
  expect(execCommand).not.toHaveBeenCalled()
})

it.each(["", "existing draft"])("preserves %j when the bridge is unavailable", (draft) => {
  const editor = createEditor(draft)
  const quill = attachQuill(editor)
  const adapter = mountAdapter(editor)
  const execCommand = mockExecCommand()

  expect(adapter.insertPrompt("new quote")).toBe(false)
  expect(editor.textContent).toBe(draft)
  expect(quill.insertText).not.toHaveBeenCalled()
  expect(execCommand).not.toHaveBeenCalled()
})

it("does not report a failed insertion after only the caret update throws", () => {
  const editor = createEditor("")
  const quill = attachQuill(editor)
  quill.setSelection.mockImplementation(() => {
    throw new Error("caret unavailable")
  })
  const adapter = mountAdapter(editor)
  installBridge()
  vi.spyOn(console, "warn").mockImplementation(() => {})

  expect(adapter.insertPrompt("new quote")).toBe(true)
  expect(editor.textContent).toBe("new quote")
  expect(quill.insertText).toHaveBeenCalledExactlyOnceWith(0, "new quote", "user")
})
