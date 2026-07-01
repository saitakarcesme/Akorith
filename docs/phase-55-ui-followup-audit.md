# Phase 55 follow-up — remaining Loop / Companions / Agents polish (audit)

The Phase 55 create-modal polish partly landed. This follow-up fixes the real gaps.

## Root causes found

1. **Loop still old.** App routes the Loop nav to `ProjectLoopPage` (Phase 49), but the
   Phase 55 modal work was applied to the *orphaned* `LoopsPage.tsx`. The live
   `ProjectLoopPage` still renders an inline `CreateLoopModal` using `className="modal-backdrop"`
   / `.modal` — classes that have **no CSS** anymore (only `.command-modal-backdrop` exists).
   Result: the create form renders inline at the bottom of the flex column, not a centered
   modal. Its top-right/empty-state buttons use bare `.is-primary`, not the shared button.

2. **Companion composer alignment.** `.companions-composer` uses `align-items: flex-end` and the
   textarea (`min-height: 44px; padding: 11px 14px`, default line-height) does not vertically
   center the placeholder/typed text — it sits slightly high.

3. **Companion Send/Stop mismatch.** Companions use `ComposerActionButton` (`.composer-action-button`,
   a purple 42px gradient), while normal chat uses `.send-button` (a 44px `--accent` circle with a
   scale-on-active, no float). They must be the same control.

4. **Purple CTAs off-theme.** `.action-button.is-primary` and `.composer-action-button` use
   lavender gradients (`#b9a9ff` / `#c4b8ff`) with purple shadows — Akorith's accent is actually a
   near-white neutral (`--accent: #ededf0`, `--on-accent: #1a1a1d`). Hover uses
   `transform: translateY(-1px)` — the unwanted up/down float.

## Fix plan

- **Buttons:** retheme `.action-button.is-primary` to the neutral `--accent`/`--on-accent`
  surface (like `.send-button`), drop the purple gradient/shadow, remove `translateY` hover for
  a subtle background/opacity hover. Extract a shared `ComposerSendButton` (renders `.send-button`)
  used by **both** ChatPanel and Companions so the send/stop control is identical.
- **Companion composer:** center the textarea content (explicit line-height + balanced padding),
  center the button, and give the composer a premium focus-within treatment.
- **Loop:** replace the inline `CreateLoopModal` with the shared `CommandModal` (header/body/footer,
  `FormGrid`, `FieldLabel`, `Primary/SecondaryButton`), Escape + dirty-guard close, internal scroll,
  and reuse the shared create buttons on the page + empty state. Remove the dead inline modal CSS.
- **Docs:** record the correction in the Phase 55 doc.

Target: ≥20 focused commits.
