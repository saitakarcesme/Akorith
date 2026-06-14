# Phase 14.4 — Chat scroll reliability validation

## The bug

Long chats — especially ones containing a large copyable code/prompt block — could not be
scrolled all the way to the top. Scrolling up from the newest message stopped at (roughly) the big
block; older messages above it were unreachable. It appeared "restore-specific" only because chats
restored from Recent Chats tend to be the long ones.

## Root cause

`.chat-messages` (the scroll container) had accumulated, across phases, two rules that combined to:

```
display: flex;
flex-direction: column;     /* from the legacy bubble layout block */
justify-content: center;    /* from a later "centered column" block */
overflow-y: auto;
```

A flex container that **centers its content along the scroll axis** cannot scroll to the *start*
once the content overflows: the overflowing top is laid out above the scrollable region and is
clipped. With short content (no overflow) centering is a no-op, so the bug only showed up once a
chat was tall enough — i.e. with a big block or a long history.

## Fix

- `.chat-messages` → `display: block`. The inner `.chat-messages-col` centers itself horizontally
  with `margin: 0 auto` and a fixed reading width; content flows top→bottom and the whole history
  scrolls normally.
- `overflow-anchor: none` so an explicit scroll-to-bottom is never fought by scroll anchoring.
- Larger bottom padding so the last turn clears the docked composer.
- Code blocks bounded: `.chat-code` / `pre` use `max-width: 100%`, `overflow-x: auto`,
  `overflow-y: hidden` — a long line scrolls the block horizontally and never blocks vertical scroll.

Auto-scroll is unchanged: it snaps to the bottom only when the user is already near the bottom
(`nearBottomRef`). A restored chat opens at the bottom and can be scrolled fully to the top.

## Manual checks

1. Open/create a chat; paste/generate a large fenced code block plus several messages above it.
2. Quit and relaunch the app; restore the chat from **Recent Chats**.
3. Scroll up → reach the **oldest** message (no stop at the block). ✅
4. Inside the code block, scroll horizontally on a long line → only the block scrolls; the page
   scroll is unaffected. ✅
5. Send a new message while parked at the bottom → it snaps to bottom; while scrolled up → it does
   not yank you down. ✅

## Related Phase 14.4 checks

- Project `⋯` menu opens (fixed-position, not clipped), closes on outside-click / Escape.
- **Reveal in Finder** opens the project folder; **Remove from Akorith** removes the project from the
  list (disk folder untouched) and an active removal returns to a clean no-project Workspace.
- Projects render as a clean folder list (folder icon + name + muted path), not avatar cards.
- UI scale (`setZoomFactor(1.1)`) makes the whole app ~10% larger and more readable; nothing clipped.
