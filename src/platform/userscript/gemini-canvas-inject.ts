import {
  installGeminiCanvasCodeBridge,
  type GeminiCanvasCodeBridgeWindow,
} from "~core/gemini-canvas-code-bridge"
import {
  installGeminiComposerBridge,
  type GeminiComposerBridgeWindow,
} from "~core/gemini-composer-bridge"

declare const unsafeWindow: (GeminiCanvasCodeBridgeWindow & GeminiComposerBridgeWindow) | undefined

function getPageWindow(): GeminiCanvasCodeBridgeWindow & GeminiComposerBridgeWindow {
  if (typeof unsafeWindow !== "undefined" && unsafeWindow !== window) {
    return unsafeWindow
  }

  return window as GeminiCanvasCodeBridgeWindow & GeminiComposerBridgeWindow
}

export function injectGeminiCanvasCodeBridge(): void {
  if (location.hostname !== "gemini.google.com") return

  const pageWindow = getPageWindow()
  installGeminiCanvasCodeBridge(pageWindow)
  installGeminiComposerBridge(pageWindow)
}
