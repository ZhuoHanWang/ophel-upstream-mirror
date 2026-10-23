import { afterEach, expect, test, vi } from "vitest"

import { startCompletionPolling } from "~platform/extension/completion-polling"
import { MSG_WAIT_COMPLETION_POLL } from "~utils/messaging"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test("background responses drive one pending check at a time and cancellation ignores late responses", async () => {
  const responses: ((response: { success: boolean }) => void)[] = []
  const sendMessage = vi.fn(() => new Promise((resolve) => responses.push(resolve)))
  vi.stubGlobal("chrome", { runtime: { sendMessage } })
  const poll = vi.fn()
  const stop = startCompletionPolling(poll)

  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: MSG_WAIT_COMPLETION_POLL })
  expect(poll).not.toHaveBeenCalled()
  responses[0]({ success: true })
  await Promise.resolve()
  expect(poll).toHaveBeenCalledTimes(1)
  expect(sendMessage).toHaveBeenCalledTimes(2)

  stop()
  responses[1]({ success: true })
  await Promise.resolve()
  expect(poll).toHaveBeenCalledTimes(1)
  expect(sendMessage).toHaveBeenCalledTimes(2)
})

test.each([
  ["transport rejection", () => Promise.reject(new Error("Connection closed"))],
  ["failed response", () => Promise.resolve({ success: false, error: "Unavailable" })],
  ["missing background handler", () => Promise.resolve(undefined)],
])("%s is reported and cannot become a successful check", async (_name, sendMessage) => {
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(sendMessage) } })
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const poll = vi.fn()
  const stop = startCompletionPolling(poll)
  await Promise.resolve()
  await Promise.resolve()
  expect(poll).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledTimes(1)
  stop()
})
