import assert from "node:assert/strict"
import { test } from "vitest"
import {
  CompletionTracker,
  type CompletionTurn,
  type CompletionSnapshot,
} from "~core/completion-tracker"
const turn = (key: string, extra: Partial<CompletionTurn> = {}): CompletionTurn => ({
  key,
  hasUser: true,
  hasAnswer: true,
  signature: "answer-" + key,
  version: 1,
  busy: false,
  generating: false,
  finalActions: true,
  mediaPending: false,
  ...extra,
})
const snapshot = (
  turns: CompletionTurn[],
  extra: Partial<CompletionSnapshot> = {},
): CompletionSnapshot => ({
  route: "/app/example",
  turns,
  composerReady: true,
  ...extra,
})
function fixture(history: CompletionTurn[] = []) {
  const completed: { round: number; isLatest: boolean }[] = [],
    resets: boolean[] = []
  const tracker = new CompletionTracker(
    (event) => completed.push({ ...event }),
    () => resets.push(true),
  )
  tracker.observe(snapshot(history), 0)
  return { tracker, completed, resets }
}
test("existing completed history does not notify", () => {
  const f = fixture([turn("old")])
  f.tracker.observe(snapshot([turn("old")]), 5000)
  assert.deepEqual(f.completed.length, 0)
})

test("history arriving after an empty initial snapshot does not start a round", () => {
  const f = fixture()
  f.tracker.observe(snapshot([turn("old", { busy: true, hasAnswer: false })]), 10)
  assert.equal(f.tracker.active, false)
  f.tracker.observe(snapshot([turn("old")]), 100)
  f.tracker.observe(snapshot([turn("old")]), 5000)
  assert.equal(f.completed.length, 0)
})

test("a busy history placeholder in the initial snapshot is not an active generation", () => {
  const f = fixture([turn("old", { busy: true, hasAnswer: false })])
  assert.equal(f.tracker.active, false)
  f.tracker.observe(snapshot([turn("old")]), 100)
  f.tracker.observe(snapshot([turn("old")]), 5000)
  assert.equal(f.completed.length, 0)
})

test("completed history arriving in several batches never notifies", () => {
  const f = fixture()
  f.tracker.observe(snapshot([turn("old-one")]), 10)
  f.tracker.observe(snapshot([turn("old-one"), turn("old-two")]), 100)
  f.tracker.observe(snapshot([turn("old-one"), turn("old-two")]), 5000)
  assert.equal(f.tracker.active, false)
  assert.equal(f.completed.length, 0)
})

test("rehydrating a known history answer is not a regeneration", () => {
  const f = fixture([turn("old")])
  f.tracker.observe(snapshot([turn("old", { busy: true })]), 10)
  f.tracker.observe(snapshot([turn("old", { signature: "hydrated", version: 2 })]), 100)
  f.tracker.observe(snapshot([turn("old", { signature: "hydrated", version: 2 })]), 5000)
  assert.equal(f.tracker.active, false)
  assert.equal(f.completed.length, 0)
})

test("switching to an empty route then loading its history stays idle", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a", { generating: true })]), 20)
  f.tracker.observe(snapshot([], { route: "/app/other" }), 100)
  const history = snapshot([turn("old", { busy: true })], { route: "/app/other" })
  f.tracker.observe(history, 200)
  const ready = snapshot([turn("old"), turn("older")], { route: "/app/other" })
  f.tracker.observe(ready, 300)
  f.tracker.observe(ready, 5000)
  assert.equal(f.tracker.active, false)
  assert.equal(f.completed.length, 0)
  assert.equal(f.resets.length, 1)
})

test("opening a conversation that is actually generating still tracks its completion", () => {
  const f = fixture([turn("running", { generating: true, busy: true })])
  assert.equal(f.tracker.active, true)
  f.tracker.observe(snapshot([turn("running")]), 100)
  f.tracker.observe(snapshot([turn("running")]), 1600)
  assert.equal(f.completed.length, 1)
})
test("network silence while thinking never completes", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a", { generating: true })], { composerReady: false }), 20)
  f.tracker.observe(snapshot([turn("a", { generating: true })], { composerReady: false }), 120000)
  assert.deepEqual(f.completed.length, 0)
})
test("final response must be stable and notifies only once", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a")]), 20)
  f.tracker.observe(snapshot([turn("a", { signature: "updated" })]), 1000)
  f.tracker.observe(snapshot([turn("a", { signature: "updated" })]), 2499)
  assert.deepEqual(f.completed.length, 0)
  f.tracker.observe(snapshot([turn("a", { signature: "updated" })]), 2500)
  f.tracker.observe(snapshot([turn("a", { signature: "updated" })]), 9000)
  assert.deepEqual(f.completed.length, 1)
})
test("two rapid rounds complete independently even if the second is still generating", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a", { generating: true })]), 20)
  f.tracker.observe(snapshot([turn("a")]), 500)
  f.tracker.submit(600)
  const secondBusy = snapshot([turn("a"), turn("b", { generating: true })], {
    composerReady: false,
  })
  f.tracker.observe(secondBusy, 700)
  f.tracker.observe(secondBusy, 2000)
  assert.deepEqual(f.completed, [{ round: 1, isLatest: false }])
  f.tracker.observe(snapshot([turn("a"), turn("b")]), 2100)
  f.tracker.observe(snapshot([turn("a"), turn("b")]), 3600)
  assert.deepEqual(f.completed.length, 2)
})
test("a short answer can complete without observing a stop button", () => {
  const f = fixture([turn("old")])
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("old"), turn("short")]), 20)
  f.tracker.observe(snapshot([turn("old"), turn("short")]), 1520)
  assert.deepEqual(f.completed.length, 1)
})
test("user submission alone cannot notify using the previous answer", () => {
  const f = fixture([turn("old")])
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("old")]), 20)
  f.tracker.observe(snapshot([turn("old")]), 10000)
  assert.deepEqual(f.completed.length, 0)
})
test("brief stop-control disappearance does not complete while busy or before final actions", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a", { generating: true, finalActions: false })]), 20)
  f.tracker.observe(snapshot([turn("a", { busy: true, finalActions: false })]), 5000)
  f.tracker.observe(snapshot([turn("a", { finalActions: false })]), 10000)
  assert.deepEqual(f.completed.length, 0)
  f.tracker.observe(snapshot([turn("a")]), 11000)
  f.tracker.observe(snapshot([turn("a", { generating: true })]), 11500)
  f.tracker.observe(snapshot([turn("a")]), 12000)
  f.tracker.observe(snapshot([turn("a")]), 13500)
  assert.deepEqual(f.completed.length, 1)
})
test("generated media waits until loaded and stable", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("image", { mediaPending: true })]), 20)
  f.tracker.observe(snapshot([turn("image", { mediaPending: true })]), 10000)
  assert.deepEqual(f.completed.length, 0)
  f.tracker.observe(snapshot([turn("image")]), 11000)
  f.tracker.observe(snapshot([turn("image")]), 12500)
  assert.deepEqual(f.completed.length, 1)
})
test("switching conversations clears pending rounds and does not notify old history", () => {
  const f = fixture()
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a", { generating: true })]), 20)
  f.tracker.observe(snapshot([turn("other")], { route: "/app/other" }), 100)
  f.tracker.observe(snapshot([turn("other")], { route: "/app/other" }), 5000)
  assert.deepEqual(f.completed.length, 0)
  assert.deepEqual(f.resets.length, 1)
})
test("new conversation ID assignment preserves the submitted round", () => {
  const f = fixture()
  f.tracker.observe(snapshot([], { route: "/app" }), 1)
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a")]), 20)
  f.tracker.observe(snapshot([turn("a")]), 1520)
  assert.deepEqual(f.completed.length, 1)
})
test("regeneration cannot complete using the unchanged previous answer", () => {
  const f = fixture([turn("a")])
  f.tracker.observe(snapshot([turn("a", { generating: true })]), 20)
  f.tracker.observe(snapshot([turn("a")]), 100)
  f.tracker.observe(snapshot([turn("a")]), 5000)
  assert.deepEqual(f.completed.length, 0)
  f.tracker.observe(snapshot([turn("a", { signature: "new-answer" })]), 6000)
  f.tracker.observe(snapshot([turn("a", { signature: "new-answer" })]), 7500)
  assert.deepEqual(f.completed.length, 1)
})

test("a busy indicator alone cannot turn an unchanged old answer into a new completion", () => {
  const f = fixture([turn("a")])
  f.tracker.submit(10)
  f.tracker.observe(snapshot([turn("a", { busy: true })]), 20)
  f.tracker.observe(snapshot([turn("a")]), 100)
  f.tracker.observe(snapshot([turn("a")]), 10000)
  assert.deepEqual(f.completed.length, 0)
})

test("a reply cleared and regenerated to identical text still completes once", () => {
  const f = fixture([turn("a")])
  f.tracker.observe(snapshot([turn("a", { generating: true })]), 20)
  f.tracker.observe(
    snapshot([turn("a", { generating: true, signature: "", hasAnswer: false })]),
    30,
  )
  f.tracker.observe(snapshot([turn("a")]), 100)
  f.tracker.observe(snapshot([turn("a")]), 1600)
  assert.deepEqual(f.completed.length, 1)
})

test("requested regeneration with only a busy indicator starts a separate round", () => {
  const f = fixture([turn("a")])
  f.tracker.submit(1)
  f.tracker.observe(snapshot([turn("a", { busy: true })]), 10)
  f.tracker.observe(snapshot([turn("a", { signature: "regenerated" })]), 100)
  f.tracker.observe(snapshot([turn("a", { signature: "regenerated" })]), 1600)
  assert.deepEqual(f.completed.length, 1)
})
