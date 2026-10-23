/**
 * Gemini 输入框主世界桥。
 *
 * content script 运行在 isolated world，读不到 Gemini 挂在 DOM 上的 Quill
 * 实例（祖先节点上的 __quill）。原生 insertText 会逐行触发布局，已有
 * 草稿还可能被 Gemini 重新解析覆盖。通过同步 DOM 事件让 MAIN world
 * 执行 Quill 的原子插入，并把结果写回共享 DOM。
 */

export const GEMINI_COMPOSER_INSERT_EVENT = "ophel-gemini-composer-insert"
export const GEMINI_COMPOSER_BRIDGE_ATTR = "data-ophel-gemini-composer-main"

const GEMINI_COMPOSER_REQUEST_ATTR = "data-ophel-gemini-composer-request"
const GEMINI_COMPOSER_CONTENT_ATTR = "data-ophel-gemini-composer-content"
const GEMINI_COMPOSER_USE_CARET_ATTR = "data-ophel-gemini-composer-use-caret"
const GEMINI_COMPOSER_RESULT_ATTR = "data-ophel-gemini-composer-result"

export interface GeminiQuillSelection {
  index: number
  length: number
}

export interface GeminiQuillEditor {
  root: HTMLElement
  getLength: () => number
  getSelection: () => GeminiQuillSelection | null
  insertText: (index: number, text: string, source?: string) => unknown
  setSelection?: (index: number, length: number, source?: string) => unknown
}

export type GeminiQuillInsertResult = "inserted" | "unavailable" | "failed"

export interface GeminiComposerBridgeWindow extends Window {
  __ophelGeminiComposerBridgeInstalled?: boolean
}

const isElementInWindow = (
  candidate: EventTarget | null | undefined,
  pageWindow: GeminiComposerBridgeWindow,
): candidate is HTMLElement => {
  if (!candidate || (candidate as Node).nodeType !== 1) return false
  const element = candidate as HTMLElement
  return element.ownerDocument === pageWindow.document && typeof element.hasAttribute === "function"
}

export function findGeminiQuillEditor(editor: HTMLElement): GeminiQuillEditor | null {
  let node: Element | null = editor

  while (node) {
    const quill = (node as Element & { __quill?: unknown }).__quill
    if (
      quill &&
      typeof quill === "object" &&
      "root" in quill &&
      (quill as { root?: unknown }).root === editor &&
      "getLength" in quill &&
      typeof (quill as { getLength?: unknown }).getLength === "function" &&
      "getSelection" in quill &&
      typeof (quill as { getSelection?: unknown }).getSelection === "function" &&
      "insertText" in quill &&
      typeof (quill as { insertText?: unknown }).insertText === "function"
    ) {
      return quill as GeminiQuillEditor
    }
    node = node.parentElement
  }

  return null
}

export function insertGeminiQuillText(
  editor: HTMLElement,
  content: string,
  useCaret: boolean,
): GeminiQuillInsertResult {
  const quill = findGeminiQuillEditor(editor)
  if (!quill) return "unavailable"

  try {
    const endIndex = Math.max(0, quill.getLength() - 1)
    const selection = useCaret ? quill.getSelection() : null
    const insertionIndex =
      selection &&
      selection.length === 0 &&
      Number.isInteger(selection.index) &&
      selection.index >= 0 &&
      selection.index <= endIndex
        ? selection.index
        : endIndex

    quill.insertText(insertionIndex, content, "user")
    if (typeof quill.setSelection === "function") {
      try {
        quill.setSelection(insertionIndex + content.length, 0, "user")
      } catch (error) {
        console.warn("[Ophel] Gemini Quill caret update failed", error)
      }
    }
    return "inserted"
  } catch (error) {
    // 不做 DOM 文本猜测：多行引用在 Quill 的 textContent 里可能丢失换行
    console.warn("[Ophel] Gemini Quill insertion failed", error)
    return "failed"
  }
}

/**
 * 从 isolated world 同步请求主世界执行插入。
 *
 * dispatchEvent 会同步执行主世界监听器，因此这里可以在不改变
 * SiteAdapter.insertPrompt 同步签名的前提下拿到结果。
 */
export function insertGeminiPromptViaBridge(
  editor: HTMLElement,
  content: string,
  useCaret: boolean,
): boolean {
  const documentElement = editor.ownerDocument?.documentElement
  if (!documentElement?.hasAttribute(GEMINI_COMPOSER_BRIDGE_ATTR)) return false

  const requestId = `ophel-gemini-composer-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const expectedResult = `${requestId}:ok`

  editor.setAttribute(GEMINI_COMPOSER_REQUEST_ATTR, requestId)
  editor.setAttribute(GEMINI_COMPOSER_CONTENT_ATTR, content)
  editor.setAttribute(GEMINI_COMPOSER_USE_CARET_ATTR, useCaret ? "1" : "0")
  editor.removeAttribute(GEMINI_COMPOSER_RESULT_ATTR)

  try {
    editor.dispatchEvent(new Event(GEMINI_COMPOSER_INSERT_EVENT, { bubbles: true, composed: true }))
    return editor.getAttribute(GEMINI_COMPOSER_RESULT_ATTR) === expectedResult
  } catch (error) {
    console.warn("[Ophel] Gemini composer bridge request failed", error)
    return false
  } finally {
    editor.removeAttribute(GEMINI_COMPOSER_REQUEST_ATTR)
    editor.removeAttribute(GEMINI_COMPOSER_CONTENT_ATTR)
    editor.removeAttribute(GEMINI_COMPOSER_USE_CARET_ATTR)
    editor.removeAttribute(GEMINI_COMPOSER_RESULT_ATTR)
  }
}

export function installGeminiComposerBridge(pageWindow: GeminiComposerBridgeWindow): void {
  if (pageWindow.__ophelGeminiComposerBridgeInstalled) return

  pageWindow.__ophelGeminiComposerBridgeInstalled = true
  const markMainReady = () => {
    try {
      pageWindow.document?.documentElement?.setAttribute(GEMINI_COMPOSER_BRIDGE_ATTR, "1")
    } catch {
      // 忽略 document 尚未准备好的异常
    }
  }
  markMainReady()
  if (!pageWindow.document?.documentElement && typeof pageWindow.addEventListener === "function") {
    pageWindow.addEventListener("DOMContentLoaded", markMainReady, { once: true })
  }

  // Gemini 的 Angular 包装层可能阻止事件冒泡到 window，而且两个 world 之间
  // 的 Event 构造器不同。监听 document 并在事件路径中取第一个编辑器节点，
  // 可以同时兼容编辑器和富文本祖先节点上派发的事件。
  pageWindow.document?.addEventListener?.(GEMINI_COMPOSER_INSERT_EVENT, (event) => {
    const target = event.target
    const path = typeof event.composedPath === "function" ? event.composedPath() : []
    const element = [...path, target].find(
      (candidate): candidate is HTMLElement =>
        isElementInWindow(candidate, pageWindow) &&
        candidate.hasAttribute(GEMINI_COMPOSER_REQUEST_ATTR),
    )
    if (!element) return

    const requestId = element.getAttribute(GEMINI_COMPOSER_REQUEST_ATTR)
    const content = element.getAttribute(GEMINI_COMPOSER_CONTENT_ATTR)
    if (!requestId || content === null) return

    const useCaret = element.getAttribute(GEMINI_COMPOSER_USE_CARET_ATTR) === "1"
    const result = insertGeminiQuillText(element, content, useCaret)
    element.setAttribute(
      GEMINI_COMPOSER_RESULT_ATTR,
      `${requestId}:${result === "inserted" ? "ok" : "error"}`,
    )
  })
}
