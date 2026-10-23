import { MSG_WAIT_COMPLETION_POLL, sendToBackground } from "~utils/messaging"

/** Use the extension background's clock instead of throttled page timers. */
export function startCompletionPolling(poll: () => void): () => void {
  let stopped = false

  const run = async () => {
    while (!stopped) {
      const response = await sendToBackground({ type: MSG_WAIT_COMPLETION_POLL })
      if (stopped) return
      if (!response?.success) throw new Error(response?.error || "Completion polling failed")
      poll()
    }
  }

  void run().catch((error) => {
    if (!stopped) console.error("[Ophel] Background completion polling failed:", error)
  })

  return () => {
    stopped = true
  }
}
