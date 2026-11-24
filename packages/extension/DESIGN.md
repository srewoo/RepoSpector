# RepoSpector extension: design direction

Brief chosen by the owner on 2026-11-21 ("calm tool"). Written down by the agent from that brief; edit freely.

Reading this as: a code-review side panel and settings page for developers, used next to GitHub and GitLab diffs, in a quiet tool language. Dial: ENERGY 1 / RHYTHM 1 / MOTION 1.

## Identity

A reviewer's notebook beside the diff. It should feel like part of the developer's workbench, not a product trying to sell itself. Dense, readable, quiet; the code on the left is the main event and the panel defers to it.

Identity motif: **findings are written like review notes**, `file:line` in the code font, then the claim in plain sentences. The `file:line` reference is the one repeated typographic gesture across the panel.

## Dials (and why)

- ENERGY 1: the panel sits beside someone's code for minutes at a time; anything loud competes with the diff.
- RHYTHM 1: settings and findings are lists the user scans top to bottom; a uniform order is easier to scan than varied compositions. Uniformity here is deliberate.
- MOTION 1: hover and focus states only. Nothing animates on its own, with one exception (user request, 2026-11-24): the current step of a running review carries a moving stripe so the user can see work is happening. It stops under `prefers-reduced-motion`.

## Palette

Neutrals plus one accent. Contrast ratios measured with the antislop contrast checker.

| Role | Light | Dark | Measured |
|---|---|---|---|
| Background | #FFFFFF | #14171A | |
| Subtle surface (sections) | #F4F5F7 | #1C2025 | |
| Text | #1B1F23 | #E6E8EB | 16.58 / 14.66 |
| Muted text | #545D68 | #A3ACB6 | 6.68 (6.13 on subtle) / 7.83 (7.12 on subtle) |
| Control border | #8A939E | #6E7781 | 3.11 / 3.96 (non-text, 3:1) |
| Accent | #0B6E63 | #5CC8B6 | 6.13 text on white, white on accent / 8.90 |
| Error | #B42318 | #FF8A7A | 6.57 / 7.85 |

- Accent (deep teal): used only for the primary action on each screen and for the "verified" label on findings. Why teal: it is not the default AI blue or purple, and it reads as "checked" without borrowing GitHub's green or blue.
- Error is always paired with text that says what failed; colour is never the only signal.
- Light and dark follow the system setting (`prefers-color-scheme`); both are maintained.

## Type

- UI: the system font stack (`system-ui, -apple-system, "Segoe UI", sans-serif`). Why: the panel lives next to GitHub and GitLab, which use the system stack; matching them makes the panel feel native, and it costs no font download.
- Code references (`file:line`, model ids, keys' names): the system monospace stack (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`). Why: they are code, and the monospace marks them as such. Never used for headings.
- Sizes: 14px body, 13px secondary, 16px page heading, 15px section heading. No uppercase tracking.

## Shape and space

- Radius 6px on controls and sections, nothing pill-shaped.
- No shadows: the panel is flat; sections separate by a subtle surface and spacing, not elevation.
- Spacing scale 4 / 8 / 12 / 16 / 24.
- Controls at least 36px high (desktop side panel; there is no mobile surface).

## Copy

- Plain and specific: say what a button does ("Save host", "Test key"), say what failed and what to do next.
- No em dashes, no marketing words, no emoji.
