export interface CompletionTurn {
  key: string
  hasUser: boolean
  hasAnswer: boolean
  signature: string
  version: number | null
  busy: boolean
  generating: boolean
  finalActions: boolean
  mediaPending: boolean
}

export interface CompletionSnapshot {
  route: string
  turns: CompletionTurn[]
  composerReady: boolean
}

interface Round {
  id: number
  done: boolean
  baseline: string | null
  baselineVersion: number | null
  changed: boolean
  lastSignature: string
  stableSince: number
  quietSince: number | null
}

/** Only submitted or visibly generating replies can produce a completion event. */
export class CompletionTracker {
  private sequence = 0
  private initialized = false
  private route: string | null = null
  private known = new Set<string>()
  private rounds = new Map<string, Round>()
  private lastLatest: string | null = null
  private lastGenerating = false
  private intentUntil = 0

  constructor(
    private complete: (event: { round: number; isLatest: boolean }) => void,
    private resetOwner: () => void,
    private stableMs = 1500,
  ) {}

  get active() {
    return [...this.rounds.values()].some((round) => !round.done)
  }

  get pendingKeys(): ReadonlySet<string> {
    return new Set([...this.rounds].filter(([, round]) => !round.done).map(([key]) => key))
  }

  submit(now: number) {
    this.intentUntil = now + 30_000
  }

  private startRound(turn: CompletionTurn, now: number, existing = false) {
    if (this.rounds.has(turn.key) && !this.rounds.get(turn.key)!.done) return
    this.rounds.set(turn.key, {
      id: ++this.sequence,
      done: false,
      baseline: existing ? turn.signature : null,
      baselineVersion: existing ? turn.version : null,
      changed: !existing,
      lastSignature: turn.signature,
      stableSince: now,
      quietSince: null,
    })
    this.intentUntil = 0
  }

  private baseline(snapshot: CompletionSnapshot, now: number) {
    this.rounds.clear()
    this.known = new Set(snapshot.turns.map((turn) => turn.key))
    this.route = snapshot.route
    const latest = snapshot.turns.at(-1)
    this.lastLatest = latest?.key ?? null
    this.lastGenerating = !!latest?.generating
    this.initialized = true
    if (latest?.generating) this.startRound(latest, now)
  }

  observe(snapshot: CompletionSnapshot, now: number) {
    if (!this.initialized) {
      this.baseline(snapshot, now)
      return
    }
    if (snapshot.route !== this.route) {
      // A new conversation receives its permanent URL after submission.
      const assigningFirstId =
        /\/app\/?$/.test(this.route || "") &&
        /\/app\/[^/]+$/.test(snapshot.route) &&
        (this.active || now < this.intentUntil)
      if (assigningFirstId) this.route = snapshot.route
      else {
        this.intentUntil = 0
        this.resetOwner()
        this.baseline(snapshot, now)
        return
      }
    }

    const latest = snapshot.turns.at(-1)
    const latestKey = latest?.key ?? null
    const rising = latest?.generating && (!this.lastGenerating || latestKey !== this.lastLatest)
    // Restored history may append turns, replace answer nodes and show busy
    // indicators. None of those changes proves that a new reply was requested.
    if (
      latest?.hasUser &&
      !this.known.has(latest.key) &&
      (now < this.intentUntil || latest.generating)
    ) {
      this.startRound(latest, now)
    } else if (latest && (rising || (now < this.intentUntil && latest.busy))) {
      this.startRound(latest, now, true)
    }

    for (const turn of snapshot.turns) {
      this.known.add(turn.key)
      const round = this.rounds.get(turn.key)
      if (!round || round.done) continue
      if (round.lastSignature !== turn.signature) {
        round.lastSignature = turn.signature
        round.stableSince = now
      }
      round.changed ||= turn.signature !== round.baseline || turn.version !== round.baselineVersion
      if (
        turn.generating ||
        turn.busy ||
        !turn.hasAnswer ||
        !round.changed ||
        turn.mediaPending ||
        !turn.finalActions ||
        (turn.key === latestKey && !snapshot.composerReady)
      ) {
        round.quietSince = null
        continue
      }
      round.quietSince ??= now
      if (now - Math.max(round.quietSince, round.stableSince) >= this.stableMs) {
        round.done = true
        this.complete({ round: round.id, isLatest: turn.key === latestKey })
      }
    }

    if (this.rounds.size > 100) {
      for (const [key, round] of this.rounds) {
        if (this.rounds.size <= 80) break
        if (round.done) this.rounds.delete(key)
      }
    }
    this.lastLatest = latestKey
    this.lastGenerating = !!latest?.generating
  }
}
