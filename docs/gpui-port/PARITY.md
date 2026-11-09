# GPUI port: parity

What the GPUI app does compared with the Swift app, worked out from which
behaviour specs pass (`features/`). The table is written by
`node features/parity.mjs` from each machine's report. Don't edit it by hand.

A blank cell means no spec covers that yet, not that the feature is missing.
The full list of features is [features.md](features.md).

## The table

<!-- parity:start -->

54 of 325 features have a spec so far, across 94 scenarios.

Scenarios passing: Swift: 93 of 94, Mac: 93 of 94, Windows: 24 of 94, Linux: 93 of 94.


### 0. Foundations everything else needs

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `foundation.rpc` Runner RPC client | pass | pass | pass | pass |

### 3. Sidebar and inbox

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `sidebar.sections` Sections | pass | pass | partly | pass |
| `sidebar.sort` Inbox sort | pass | pass | pending | pass |
| `sidebar.search` Thread search | pass | pass | pass | pass |
| `sidebar.newthread` New thread button | pass | pass | pending | pass |
| `sidebar.row` Thread row | pass | pass | pending | pass |
| `sidebar.row.marks` Row left marks | pass | pass | partly | pass |
| `sidebar.row.origin` Origin mark | pass | pass | pending | pass |
| `sidebar.row.status` Row right status | pass | pass | pending | pass |
| `sidebar.row.hoverbuttons` Hover buttons | pass | pass | partly | pass |
| `sidebar.row.menu` Row context menu | pass | pass | pending | pass |
| `sidebar.subagents` Sub-agent tree | pass | pass | pending | pass |
| `sidebar.archived.paging` Archived paging | pass | pass | pending | pass |
| `sidebar.skeleton` Loading skeleton | pass | pass | pending | pass |
| `sidebar.hibernate.presets` Hibernate presets | pass | pass | partly | pass |
| `sidebar.hibernate.pick` Pick a time | pending | pending | pending | pending |
| `sidebar.hibernate.wake` Wake when… | pass | pass | pending | pass |

### 5. Transcript row kinds

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `transcript.list` The transcript list | pass | pass | pending | pass |
| `transcript.user` Your bubble | pass | pass | pass | pass |
| `transcript.reply` Assistant reply | pass | pass | partly | pass |
| `transcript.thinking` Thinking line | pass | pass | pending | pass |
| `transcript.tool` Tool line | pass | pass | partly | pass |
| `transcript.tooloutput` Tool output styling | pass | pass | pending | pass |
| `transcript.diff` Diff row | pass | pass | pending | pass |
| `transcript.images` Images row | pass | pass | pending | pass |
| `transcript.approval` Approval card | pass | pass | pass | pass |
| `transcript.approval.stacked` Stacked approval | pass | pass | pending | pass |
| `transcript.approval.settled` Settled approval | pass | pass | pass | pass |
| `transcript.question` Question card | pass | pass | pass | pass |
| `transcript.secret` Secret card | pass | pass | pending | pass |
| `transcript.review` Review card | pass | pass | pending | pass |
| `transcript.turnfooter` Turn footer | pass | pass | pass | pass |
| `transcript.error` Error row | pass | pass | pass | pass |
| `transcript.workedfor` Worked-for group | pass | pass | pass | pass |
| `transcript.working` Working line | pass | pass | pending | pass |
| `transcript.changes` Changes card | pass | pass | partly | pass |
| `transcript.rowmenu` Row context menu | pass | pass | pending | pass |

### 7. Composer

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `composer.textbox` Text box | pass | pass | partly | pass |
| `composer.return` Return, Shift-Return | pass | pass | pass | pass |
| `composer.listcontinue` List continuation | pass | pass | pending | pass |
| `composer.picturechips` Picture chips | pass | pass | pending | pass |
| `composer.chiphover` Chip hover and × | pass | pass | pending | pass |
| `composer.filedrop` File path drop | pass | pass | pending | pass |
| `composer.dropanywhere` Drop anywhere on thread | pass | pass | pending | pass |
| `composer.modelpicker` Model picker | pass | pass | pending | pass |
| `composer.permission` Permission chip | pass | pass | pending | pass |
| `composer.contextring` Context ring | pass | pass | pending | pass |
| `composer.send` Send and Stop | pass | pass | pass | pass |

### 8. Cards in the composer

| Feature | Swift | Mac | Windows | Linux |
|---|---|---|---|---|
| `card.done` Done card | pass | pass | pending | pass |
| `card.needsyou` Needs you card | pass | pass | partly | pass |
| `card.collapse` Collapse | pass | pass | pending | pass |
| `card.somethingelse` Something else box | pass | pass | pending | pass |
| `card.returnflow` Return flow | pass | pass | pending | pass |
| `card.answers` Answer and follow-up state | pass | pass | partly | pass |

<!-- parity:end -->

## The log

One entry a slice, newest first. Every entry has a `Verification:` line: a spec
run or a screenshot from the running app. A slice with no runtime check doesn't
count. (Ghostex's port log is where this shape comes from; its slices 214 to 268
built parsers and gates with no launch of the app, which is the trap.)

### 2026-11-09 BearDock for GPUI

- New crates: `desktop/dock/layout` (the tree, line for line from Swift, no GPUI)
  and `desktop/dock` (rendering, dragging, drop targets, torn-out windows), with
  a demo.
- Not in the app yet. GPUI can't scale or tilt a live subtree, so the ghost is a
  second copy of the panel. Glides between layouts aren't there. Moving a window
  by hand is Mac only; Windows and X11 use the OS drag, Wayland a menu command.
- Remaining: integrating it into the app, then the glides.
- Verification: `cargo test -p threadbear-dock-layout`, 32 tests; `press` tests
  headless, 4; real CGEvent drags on Tinker Desk through `pointer-test.sh`.

### 2026-11-09 Composer: the open card in the box

- The open card (Needs you or Done) is drawn at the top of the composer from the
  reducer's `open_card()`, and its row in the list is zero height, as the Swift
  one is. Done has Archive and its follow-ups with tick and "?"; Needs you has its
  asks with answer buttons or rows, Something else boxes, Return going on to the
  next unanswered ask, collapse, and one ask at a time when it's tall. Picks stay
  with the composer while another thread is open, and `decide` and `ask` match
  the Swift automation (`dump` has `composer.card` and `decisions` on both apps,
  the Swift one added to AppDump.swift).
- Files: `desktop/gpui/src/composer_card.rs`, `desktop/gpui/src/rows.rs` (one
  line), `features/composer-cards.feature`, `app/Sources/Threadbear/AppDump.swift`.
- Remaining: pictures in the Something else boxes, the page slide, the card
  keeping its tallest page's height, link buttons on asks, the beep when Return
  can't go on, the picks' chips when collapsed, the new-thread page and the
  slash palette.
- Verification: whole suite 44 of 44 on `TB_APP=gpui` on Linux (`cloud`) and a
  real Mac (Tinker Desk), and 44 of 44 on `TB_APP=swift` on Tinker Desk;
  side-by-side screenshot of the paged card against Swift's.

### 2026-11-09 Composer: the chips under the box

- The row under the words: "+" (Attach images…, folder), the model chip with its
  picker (search, rail of pools or providers, rows with default and selection,
  effort), the permission chip, the account chip when there are no pools, and the
  context ring with its popover. Each click updates at once through the
  `update_open` guess. `composer-menu` (permission, model, context) matches the
  Swift text; `desktop/core/src/logins.rs` ports the picker logic with tests.
- Files: `desktop/gpui/src/composer_chips.rs`, `desktop/core/src/logins.rs`,
  `features/composer-chips.feature`.
- Remaining: provider logos on the model rows and chip, usage badges on the
  account and model chips, Older rail details, Schedule… in "+".
- Verification: `TB_APP=swift` on Tinker Desk 4 of 4 for
  `@composer.permission @composer.modelpicker`; `TB_APP=gpui` on Linux (`cloud`)
  4 of 4 and on Tinker Desk 10 of 10 together with the composer's text scenarios;
  screenshot of the chip row against Swift's.

### 2026-11-09 Composer: pictures as inline chips

- Paste, drop or the automation's `paste-image` puts a chip with a thumbnail in the
  words at the cursor, each picture copied in through `media.import`, dimmed
  until it's in; the strip of thumbnails over the words has × on hover; a chip's
  hover shows the picture after a beat; `[Picture N]` markers go with the words.
  These are real gpui-kit inline tokens (`InlineToken` on `TextareaState`, 0.9.0),
  so no fork: atomic in the editing, in undo, with the Swift draft's U+FFFC mark.
  The whole thread is a drop target (`on_drop` and `drag_over` on the pane).
- Files: `desktop/gpui/src/composer.rs`, `features/sending.feature`,
  `features/support/sample.png`, `features/tools/shot.ts` (optional commands).
- Remaining: `composer.chipcopy`, a whole-insert undo step (each chip and its
  spaces are separate undo steps today).
- Verification: `TB_APP=gpui` on Linux (`cloud`) and a real Mac (Tinker Desk), 4 of
  4 for `@composer.picturechips @composer.filedrop @composer.chiphover`;
  `TB_APP=swift` on Tinker Desk 4 of 4; screenshot of two chips against Swift's.

### 2026-11-09 Composer: its own file, the rounded box, list continuation, paste

- The composer is out of `thread.rs` into `desktop/gpui/src/composer.rs`, one
  `Composer` entity per thread on the app (`Threadbear.composers`) so what's typed
  and its undo stay with the thread. Rounded card, 15/23 text, two to ten lines,
  Return sends, Shift-Return makes a new line and carries markdown lists on
  through one edit (`ListContinuation` is in `desktop/core/src/composer.rs` with
  its tests), the send circle and Stop. `paste` joins the automation commands.
- Files: `desktop/gpui/src/composer.rs`, `desktop/core/src/composer.rs`,
  `features/sending.feature`.
- Remaining: pictures, the chips under the box, the cards, the new-thread page.
- Verification: `TB_APP=gpui` on Linux (`cloud`) and a real Mac (Tinker Desk) 7 of
  7 for `@composer.textbox @composer.return @composer.send @composer.listcontinue`;
  `TB_APP=swift` on Tinker Desk 4 of 4 for the new ones; side-by-side screenshot of
  the box against the Swift one.
### 2026-11-09 The transcript's rows, drawn like the Swift app

- What changed: the reading column, Mike's bubble, assistant markdown in
  gpui-kit's TextView styled from Theme.swift's values (`rows/markdown.rs`),
  work lines opening to their detail (`rows/work.rs`), diff rows and the Edited
  N files card (`rows/diff.rs`), every card with its buttons, spinner and
  tooltips (`rows/cards.rs`), images (`rows/images.rs`), notes, gaps, errors,
  footers, the row's right-click menu with Copy message, Copy transcript and
  Copy debug info (`rows/export.rs`), work links scrolling to their step, and
  the list itself: GPUI's `list` with TranscriptController's behaviour
  (`rows/list.rs`): tail following, paging older events in near the top,
  remembered scroll per thread (across a thread being reopened, paging until
  its row is back), not moving when rows open or are added above.
- Files: `desktop/gpui/src/rows.rs`, `desktop/gpui/src/rows/`, the list parts
  of `desktop/gpui/src/thread.rs`, additions to `desktop/gpui/src/style.rs`,
  `automation.rs` (`scroll`, `link`, `menu`, `clipboard`, `expand` with `file`
  and `all`); `features/reading-a-thread.feature`, `features/cards.feature`,
  `features/scrolling.feature` and their steps; `features/tools/rows.ts`.
- Remaining: the bear in the working line (a paw for now; foundation.bear),
  file-path links' search of the files a thread's tools touched and their
  right-click menus (paths in inline code link and open from the thread's
  folder), reply buttons, thread and picture chips, the selection bar, the
  edit pencil and send lift, the table's natural widths (the kit stretches
  them to the column), held-back tool output for other runners' threads, the
  lit-up step's fade, opening a review.
- Verification: `TB_APP=swift cucumber-js` on Tinker Desk's desktop, 41 of 41
  scenarios; `TB_APP=gpui cucumber-js` on Tinker Desk's desktop, 41 of 41, and
  on `cloud` under Xvfb, 41 of 41. `features/tools/long-thread.ts` on Tinker
  Desk (M2), release build, real rows: first page open in 23 ms, 10,000 rows
  loaded and folded in 123 ms, a scrolling frame 0.55 ms median, 1.2 ms worst
  (0.62 and 2.5 ms for fast scrolling). Side-by-side screenshots of every card
  and row kind from both apps.
### 2026-11-09 The sidebar: rows, headings, actions, Hibernate

- Rules ported to `desktop/core/src/sidebar.rs` and `inbox.rs`: `ThreadSections`
  (the Inbox order, and the Mac's Inbox/Running split where the first port had
  followed the website; `InboxUrgency` now checked against its shared cases),
  `ThreadRowLook`, `RowMode`, `ThreadByline`, `ProjectMark`, `RelativeTime` and
  the trailing words, `Snooze`, `WakeWords`, `BackgroundWork`,
  `BusyThreadAction`, `SubagentRows`, `ArchiveRows`.
- `desktop/gpui/src/sidebar.rs` draws them: tile (letter, symbol or picture),
  bold title, place line with the origin mark, blue dot or tick, status and
  time with the ticking timer, headings with counts and folds, the Inbox sort,
  hover buttons that change the row at once, the right-click menu, Hibernate
  presets, Pick a time, Wake when, Rename and Delete, search, New thread, the
  sub-agent tree, archived paging, the loading rows. `icons.rs` maps SF Symbols
  to Lucide.
- `sidebar.archived.foot` dropped: the Swift app undid it on 9 Nov (cfbf3cb3).
- Specs: four new files, 32 scenarios (`sidebar-rows`, `-sections`, `-actions`,
  `-loading`); the Swift `dump` says what a row draws; `desktop/scripts/spec.sh`
  builds and runs them through `remote.sh` with a private copy of the binary.
- Remaining: other runners' rows and Move to, swipe and drag, row motion; Open
  in New Panel is greyed until BearDock; a sub-agent's click opens its thread
  (no sub-agent transcript yet); the open row doesn't hold its place when read;
  folds and sort aren't kept across launches; Pick a time has no script path on
  either app (`@manual`).
- Verification: `TB_APP=swift cucumber-js` on Tinker Desk, 56 of 56 scenarios;
  `TB_APP=gpui cucumber-js` on Tinker Desk 56 of 56 and on `cloud` 56 of 56;
  `cargo test -p threadbear-core`; side-by-side pictures from Tinker Desk.

### 2026-11-09 Risk checks: Chromium in a slot, accessibility, Windows

- Spike (`gpui-web-spike` branch): CEF 156 in a GPUI layout slot on macOS, with a
  gpui-kit menu in its own window over the page.
- Accessibility: Voice Type works; the AX tree below the window doesn't yet.
- Windows: CI ran all 24 scenarios on a real `windows-latest` machine.
- Remaining: Windows and Linux for the web engine, the accessibility tree.
- Verification: spike screenshots from Tinker Desk; `ax-dump` on Tinker Desk;
  `Behaviour specs` in the Desktop app workflow, 24 of 24 on Windows.

### 2026-11-09 The transcript's logic in Rust

- Ported `ThreadbearCore/Transcript` to `desktop/core/src/reducer`, and the
  GPUI thread pane now draws its rows from it (a first pass at how each kind
  looks).
- Golden files: `GoldenTranscriptTests.swift` writes the rows for all 18
  fixtures, closed and open, and both languages check them.
- Remaining: every row's real look, composer card, paging older rows in.
- Verification: `cargo test -p threadbear-core`, 197 tests; specs 24 of 24 on
  Linux (`cloud`) and on a real Mac desktop (Tinker Desk).

### 2026-11-09 Long-thread speed check

- `features/tools/long-thread.ts` on Tinker Desk (M2), release build: a thread
  of 12,500 rows loads and folds in 94 ms, and a frame takes 0.6 ms at the
  median and 2.5 ms at worst while scrolling. A debug build is about ten times
  slower and still fast enough.
- Remaining: paging, and the same check after real row layouts land.
- Verification: the numbers above, run on the machine.

### 2026-11-09 The spec harness

- Added `features/` (Gherkin, Cucumber.js), driving the Swift app through
  `dev-app.sh` and the GPUI app through a debug-only automation socket.
- Files: `features/**`, `desktop/gpui/src/automation.rs`,
  `desktop/scripts/remote.sh`.
- Remaining: the rest of the daily driver.
- Verification: `TB_APP=swift cucumber-js` on Tinker Desk, 24 of 24 scenarios;
  `TB_APP=gpui cucumber-js` on `cloud` under Xvfb, 17 of 24 at this point.
