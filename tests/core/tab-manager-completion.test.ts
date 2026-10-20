// @vitest-environment jsdom
import assert from "node:assert/strict"
import { afterEach, test, vi } from "vitest"

import { GeminiAdapter } from "~adapters/gemini"
import { ChatGPTAdapter } from "~adapters/chatgpt"
import { DEFAULT_SETTINGS } from "~constants/default-settings"
import type { CompletionTracker } from "~core/completion-tracker"
import { TabManager } from "~core/tab-manager"
import { platform } from "~platform"
import type { Settings } from "~utils/storage"

vi.mock("~platform", () => ({ platform: { notify: vi.fn(), focusWindow: vi.fn() } }))
vi.mock("~utils/i18n", () => ({ t: (key: string) => key }))

// Expose private state only to drive production code with deterministic DOM timelines.
type TestManager = Omit<TabManager, never> & {
  settings: Settings["tab"]
  completionTracker: CompletionTracker | null
  aiState: string
  lastAiState: string
  userSawCompletion: boolean
  isRunning: boolean
  lastConversationTitle: string | null
  pollCompletion(): void
  onAiComplete(): void
  beginNetworkGeneration(): void
  onWindowFocus(): void
  isUserAway(): boolean
  startTitleObserver(): void
  stopTitleObserver(): void
  startTitleUpdateLoop(): void
  getCleanConversationTitle(): string
  applyManagedTitle(): void
  computeStatusPrefix(): string
  scheduleNextTitleUpdate(): void
  playNotificationSound(): void
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function fixture(site = "gemini", settings: Partial<Settings["tab"]> = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  vi.clearAllMocks()
  const intervals = new Set<unknown>()
  const setInterval = window.setInterval.bind(window)
  const clearInterval = window.clearInterval.bind(window)
  vi.spyOn(window, "setInterval").mockImplementation((handler, delay, ...args) => {
    const id = setInterval(handler, delay, ...args)
    intervals.add(id)
    return id
  })
  vi.spyOn(window, "clearInterval").mockImplementation((id) => {
    if (id !== undefined) intervals.delete(id)
    clearInterval(id)
  })
  document.body.innerHTML = '<div class="ql-editor" contenteditable="true" role="textbox"></div>'
  window.history.replaceState({}, "", "/app/test")
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return (this.closest("[hidden]") ? [] : [{ width: 10, height: 10 }]) as unknown as DOMRectList
  })
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.closest("[hidden]") ? null : document.body
  })
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  const adapter = site === "gemini" ? new GeminiAdapter() : new ChatGPTAdapter()
  const m = new TabManager(adapter, {
    ...DEFAULT_SETTINGS.tab,
    autoRename: true,
    showNotification: true,
    notifyWhenFocused: true,
    notificationSound: false,
    autoFocus: false,
    ...settings,
  }) as unknown as TestManager
  m.lastConversationTitle = "fixture"
  m.startTitleObserver = m.stopTitleObserver = m.startTitleUpdateLoop = () => {}
  m.getCleanConversationTitle = () => "fixture"
  m.applyManagedTitle = () => {}
  m.computeStatusPrefix = () => ""
  m.updateTabName = () => {}
  m.scheduleNextTitleUpdate = () => {}
  function turn(id: string, { text = "answer", busy = false, actions = true, image = false } = {}) {
    const element = document.createElement("div")
    element.className = "conversation-container"
    element.id = id
    element.innerHTML = `<user-query><div class="user-query-container">question</div></user-query>
      <model-response><message-content><div class="markdown" aria-busy="${busy}">${text}</div>
      ${image ? '<img src="https://example.test/generated.png">' : ""}</message-content></model-response>
      ${actions ? '<message-actions><button aria-label="答得好"></button></message-actions>' : ""}`
    document.body.append(element)
    return element
  }
  return {
    m,
    Base: TabManager,
    adapter,
    document,
    window,
    turn,
    intervals,
    notices: () => vi.mocked(platform.notify).mock.calls.length,
    poll: (now: number) => {
      vi.setSystemTime(now)
      m.pollCompletion()
    },
    close: () => m.destroy(),
  }
}

test("actual original notification path sends once with all required DOM evidence", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.poll(2600)
    f.poll(4000)
    assert.equal(f.notices(), 1)
    assert.equal(f.m.aiState, "completed")
  } finally {
    f.close()
  }
})
test("foreground enabled ignores stale userSawCompletion on every new round", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.userSawCompletion = true
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.m.userSawCompletion = true
    f.m.onWindowFocus()
    f.poll(2600)
    assert.equal(f.notices(), 1)
    f.m.completionTracker!.submit(2700)
    f.turn("two")
    f.poll(2800)
    f.poll(4300)
    assert.equal(f.notices(), 2)
  } finally {
    f.close()
  }
})
test("foreground disabled retains user preference", () => {
  const f = fixture("gemini", { notifyWhenFocused: false })
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.poll(2600)
    assert.equal(f.notices(), 0)
  } finally {
    f.close()
  }
})
test("background notifies even if foreground notifications are disabled", () => {
  const f = fixture("gemini", { notifyWhenFocused: false })
  try {
    f.m.isUserAway = () => true
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.poll(2600)
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})
test("DOM busy, stop controls, disabled composer, and missing final controls block completion", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    const t = f.turn("one", { busy: true, actions: false })
    f.poll(1100)
    f.poll(10000)
    assert.equal(f.notices(), 0)
    t.querySelector("[aria-busy]")!.setAttribute("aria-busy", "false")
    f.poll(12000)
    assert.equal(f.notices(), 0)
    const actions = f.document.createElement("message-actions")
    actions.innerHTML = '<button aria-label="答得好"></button>'
    t.append(actions)
    const stop = f.document.createElement("button")
    stop.className = "send-button stop"
    f.document.body.append(stop)
    f.poll(14000)
    f.poll(20000)
    assert.equal(f.notices(), 0)
    stop.remove()
    f.document.querySelector(".ql-editor")!.setAttribute("aria-disabled", "true")
    f.poll(22000)
    f.poll(25000)
    assert.equal(f.notices(), 0)
    f.document.querySelector(".ql-editor")!.removeAttribute("aria-disabled")
    f.poll(26000)
    f.poll(27500)
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})
test("late network completion cannot duplicate a DOM completion or reset a newer round", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.poll(2600)
    f.m.completionTracker!.submit(2700)
    const t = f.turn("two", { busy: true })
    f.poll(2800)
    f.m.onAiComplete()
    assert.equal(f.notices(), 1)
    assert.equal(f.m.aiState, "generating")
    t.querySelector("[aria-busy]")!.setAttribute("aria-busy", "false")
    f.poll(3000)
    f.poll(4500)
    f.m.onAiComplete()
    assert.equal(f.notices(), 2)
  } finally {
    f.close()
  }
})
test("generated image with no answer text waits for the actual image", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    const t = f.turn("one", { text: "", image: true })
    const image = t.querySelector("img")!
    let loaded = false
    Object.defineProperties(image, {
      complete: { get: () => loaded },
      naturalWidth: { get: () => (loaded ? 1024 : 0) },
    })
    f.poll(1100)
    f.poll(10000)
    assert.equal(f.notices(), 0)
    loaded = true
    f.poll(11000)
    f.poll(12500)
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})
test("disabled notifications and destroyed manager never send later notifications", () => {
  const f = fixture("gemini", { showNotification: false })
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.poll(2600)
    assert.equal(f.notices(), 0)
    f.m.stop()
    assert.equal(f.intervals.size, 0)
    f.poll(3000)
    assert.equal(f.notices(), 0)
  } finally {
    f.close()
  }
})
test("settings stop/restart baselines history and removes event listeners", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.m.updateSettings({ ...f.m.settings, autoRename: false })
    assert.equal(f.m.completionTracker, null)
    f.m.updateSettings({ ...f.m.settings, autoRename: true })
    f.poll(8000)
    assert.equal(f.notices(), 0)
    assert.equal(f.intervals.size, 1)
  } finally {
    f.close()
  }
})
test("legacy title fallback cannot send a second notification", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.isUserAway = () => true
    f.m.isRunning = true
    f.m.aiState = "idle"
    f.m.lastAiState = "generating"
    f.m.updateTabName = f.Base.prototype.updateTabName
    f.m.updateTabName(true)
    assert.equal(f.notices(), 0)
  } finally {
    f.close()
  }
})
test("completion uses the existing sound playback path when enabled", () => {
  const f = fixture("gemini", { notificationSound: true })
  try {
    let sounds = 0
    f.m.playNotificationSound = () => {
      sounds++
    }
    f.m.start()
    f.m.completionTracker!.submit(1000)
    f.turn("one")
    f.poll(1100)
    f.poll(2600)
    f.poll(4000)
    assert.equal(f.notices(), 1)
    assert.equal(sounds, 1)
  } finally {
    f.close()
  }
})

test("native Enter submission starts a short reply without a network start event", () => {
  const f = fixture()
  try {
    f.m.start()
    f.document
      .querySelector(".ql-editor")
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    f.turn("short")
    f.poll(1100)
    f.poll(2600)
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})

test("busy on the response element itself blocks completion", () => {
  const f = fixture()
  try {
    f.m.start()
    const t = f.turn("one")
    t.querySelector("model-response")!.setAttribute("aria-busy", "true")
    f.poll(1100)
    f.poll(10000)
    assert.equal(f.notices(), 0)
    t.querySelector("model-response")!.setAttribute("aria-busy", "false")
    f.poll(11000)
    f.poll(12500)
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})

test("hidden final controls do not count as completion evidence", () => {
  const f = fixture()
  try {
    f.m.start()
    f.m.completionTracker!.submit(1000)
    const t = f.turn("one")
    const button = t.querySelector<HTMLButtonElement>("message-actions button")!
    button.hidden = true
    f.poll(1100)
    f.poll(10000)
    assert.equal(f.notices(), 0)
    button.hidden = false
    f.poll(11000)
    f.poll(12500)
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})

test("switching conversations cannot notify for the newly loaded history", () => {
  const f = fixture()
  try {
    f.m.start()
    f.turn("one", { busy: true })
    f.poll(1100)
    f.document.querySelector(".conversation-container")!.remove()
    f.window.history.pushState({}, "", "/app/other")
    f.turn("other")
    f.poll(5000)
    f.poll(10000)
    assert.equal(f.notices(), 0)
    assert.equal(f.m.aiState, "idle")
  } finally {
    f.close()
  }
})

test("sites without per-reply snapshots retain their network completion path", () => {
  const f = fixture("chatgpt")
  try {
    f.m.start()
    assert.equal(f.m.completionTracker, null)
    assert.equal(f.intervals.size, 0)
    f.m.beginNetworkGeneration()
    f.m.onAiComplete()
    assert.equal(f.notices(), 1)
  } finally {
    f.close()
  }
})
