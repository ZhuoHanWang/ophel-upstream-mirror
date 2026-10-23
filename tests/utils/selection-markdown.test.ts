// @vitest-environment jsdom
import katex from "katex"
import { afterEach, describe, expect, it } from "vitest"

import { selectionToMarkdown } from "~utils/selection-markdown"

const inlineMath = (latex: string): string => {
  const host = document.createElement("span")
  host.className = "math-inline"
  host.dataset.math = latex
  host.style.userSelect = "none"
  host.innerHTML = katex.renderToString(latex)
  return host.outerHTML
}

const selectContents = (html: string, selector = "article"): Range => {
  document.body.innerHTML = `<article>${html}</article>`
  const range = document.createRange()
  range.selectNodeContents(document.querySelector(selector)!)
  return range
}

afterEach(() => document.body.replaceChildren())

describe("selectionToMarkdown", () => {
  it("recovers the path and length formulas from an unselectable Gemini list", () => {
    const path = String.raw`1 \xrightarrow{b=8} 3 \xrightarrow{d=4} 2 \xrightarrow{c=9} 4 \xrightarrow{g=6} 6`
    const sum = "8 + 4 + 9 + 6 = 27"
    const range = selectContents(
      `<h3>二、寻找关键路径与选项验证</h3><p>从源点 ① 到汇点 ⑥：</p><ol><li><strong>路径 ①：</strong>${inlineMath(path)}：长度 ${inlineMath(sum)}</li></ol><p>总长度均为 27。</p>`,
    )
    const before = document.body.innerHTML

    const markdown = selectionToMarkdown(range)

    expect(markdown).toBe(
      `### 二、寻找关键路径与选项验证\n从源点 ① 到汇点 ⑥：\n\n\n1. **路径 ①：**$${path}$：长度 $${sum}$\n\n总长度均为 27。`,
    )
    expect(markdown.match(/\\xrightarrow\{b=8\}/g)).toHaveLength(1)
    expect(markdown).not.toContain("katex")
    expect(document.body.innerHTML).toBe(before)
  })

  it("keeps partial text selections bounded and preserves special characters", () => {
    const range = selectContents("<p>不应引用：目标 ① → ⑥，x &lt; y &amp; z。也不应引用</p>")
    const node = document.querySelector("p")!.firstChild!
    const selected = "目标 ① → ⑥，x < y & z。"
    range.setStart(node, 5)
    range.setEnd(node, 5 + selected.length)

    expect(selectionToMarkdown(range)).toBe(selected)
  })

  it("retains block formulas and emits nested KaTeX source only once", () => {
    const latex = String.raw`\begin{aligned}a &= b \\ c &= d\end{aligned}`
    const range = selectContents(
      `<p>公式：</p><div class="math-block" data-math="${latex}">${katex.renderToString(latex, { displayMode: true })}</div>`,
    )

    expect(selectionToMarkdown(range)).toBe(`公式：\n\n\n$$\n${latex}\n$$`)
  })

  it.each(["data-math-source", "data-custom-copy-text", "data-tex", "data-latex"])(
    "reads %s source without duplicating existing delimiters",
    (attribute) => {
      const range = selectContents(`<span ${attribute}="\\(x^2 + y^2\\)">rendered glyphs</span>`)

      expect(selectionToMarkdown(range)).toBe("$x^2 + y^2$")
    },
  )

  it("reads standalone KaTeX annotations", () => {
    const latex = String.raw`\frac{a}{b}`
    const range = selectContents(katex.renderToString(latex))

    expect(selectionToMarkdown(range)).toBe(`$${latex}$`)
  })

  it("retains the whole formula when the selection starts and ends within glyphs", () => {
    const range = selectContents(inlineMath("x^2 + y^2"))
    const node = document.querySelector(".katex-html .mathnormal")!.firstChild!
    range.setStart(node, 0)
    range.setEnd(node, 1)

    expect(selectionToMarkdown(range)).toBe("$x^2 + y^2$")
    expect(range.toString()).toBe("x")
  })

  it("keeps a selected list item's formatting without copying other items", () => {
    const range = selectContents("<ol><li>不应引用</li><li><strong>目标</strong>内容</li></ol>")
    range.selectNodeContents(document.querySelectorAll("li")[1])

    expect(selectionToMarkdown(range)).toBe("1. **目标**内容")
  })

  it("preserves the code block context of a partial selection", () => {
    const range = selectContents(
      '<pre><code class="language-ts">before\nconst x = 1 &lt; 2\nafter</code></pre>',
    )
    const node = document.querySelector("code")!.firstChild!
    range.setStart(node, 7)
    range.setEnd(node, 22)

    expect(selectionToMarkdown(range)).toBe("```ts\nconst x = 1 < 2\n```")
  })

  it("keeps formulas, inline code and escaped pipes in table cells", () => {
    const range = selectContents(
      `<table><thead><tr><th>活动</th><th>长度</th></tr></thead><tbody><tr><td><code>a|b</code></td><td>${inlineMath("a+b=27")}</td></tr></tbody></table>`,
    )

    expect(selectionToMarkdown(range)).toBe(
      "| 活动 | 长度 |\n| --- | --- |\n| `a\\|b` | $a+b=27$ |",
    )
  })

  it("preserves table context for a selection within a single cell", () => {
    const range = selectContents("<table><tr><td>目标</td><td>不应引用</td></tr></table>")
    range.selectNodeContents(document.querySelector("td")!)

    expect(selectionToMarkdown(range)).toBe("| 目标 |")
  })

  it("omits Ophel controls, copy buttons and script contents", () => {
    const range = selectContents(
      '<p>目标<span class="gh-quick-quote-chip-row">来源引用</span></p><button>复制</button><script>hidden()</script>',
    )

    expect(selectionToMarkdown(range)).toBe("目标")
  })

  it("returns no content for a collapsed selection", () => {
    const range = selectContents(inlineMath("x^2"))
    range.collapse(true)

    expect(selectionToMarkdown(range)).toBe("")
  })
})
