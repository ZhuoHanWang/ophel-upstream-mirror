# Gemini completion notification fix

This change is based on the unofficial `c-hoffmann/ophel-upstream-mirror`
at `1edcbe6071937f6f9e6997424e65f3f96ed99feb` (Ophel `1.2.12`).

## Behavior

Gemini now tracks each paired user/assistant turn separately. A reply starts
tracking only after a send/regenerate action or an observed generation control.
Network events request a fresh DOM snapshot; they cannot start or end a reply,
because Gemini's history requests also match the network monitor. Completion
requires all of the following for at least 1.5 seconds:

- An answer exists in the matching turn.
- The stop control and visible busy indicators are absent.
- Final response actions are visible and enabled.
- The latest turn's composer is available.
- The answer and image state have stopped changing, and images are loaded.

Existing completed history is baselined without notifications, including replies
that appear later in batches or initially show loading placeholders. Appended
turns, busy indicators and replaced answer nodes alone are not generation
evidence. Regenerations must change the answer or its content node. Consecutive
replies have independent timers and deduplication. A focus event cannot suppress a different reply's
notification, and the title update fallback cannot bypass this tracker.

DOM observation starts tracking new replies without waiting for a page timer.
While replies are pending, the extension background responds to one poll request
per second so minimized windows do not depend on throttled page timers. Each
response requests a fresh DOM snapshot; it is not completion evidence itself.
Idle conversations stop requesting ticks, and stopping the manager cancels
observation and ignores any outstanding response. Userscripts use a page clock
through the same platform interface because they have no extension background.

DOM details stay in `GeminiAdapter`; the tracker only receives hashes, element
identities and state flags. Other adapters do not opt in. Notification, sound
and focus delivery still use the existing platform abstraction. No new
permissions, settings or user-facing strings are added.

The existing requirement to enable tab management (`autoRename`) remains.
“Notify when focused” still controls foreground notifications. This is source
code, so it cannot be installed through the JSON site hotfix importer.

## Verification

With Node 20.19+ or Node 22.12+ and the repository's pinned pnpm 9.15.0:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint:check
pnpm typecheck
pnpm test
pnpm build
pnpm build:userscript
pnpm build:firefox
```

Vitest executes the production tracker, Gemini adapter and tab manager
with synthetic DOM timelines in jsdom. Platform delivery is mocked; passing
tests do not establish real Chrome notification/audio delivery
or reproduce a particular reported failure.

## Manual checks and limits

Test short replies, long thinking gaps, rapid follow-ups, regeneration,
conversation switching, foreground/background settings and generated images on
the actual Gemini site. Refresh Gemini after loading the rebuilt extension.
Avoid running the old and new extensions together.

Only normal paired conversation containers are covered. Canvas and Deep
Research panels outside these containers require separate validation. If
Gemini removes a pending turn from the DOM, tracking waits for it to reappear;
there is no timeout that guesses success. Frozen or discarded pages, or Gemini
deferring its own final DOM updates, can still delay notifications. Userscript
page timers remain subject to browser throttling. Gemini DOM changes can require
adapter updates.

Keep personal settings and conversations out of commits. Back up settings
before testing a different source snapshot, and verify compatibility before
importing data. Unpacked builds are generated under `build/chrome-mv3-prod`.
