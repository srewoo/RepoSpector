# RepoSpector logo

**Gutter R**: an R built from the editor's line-number gutter, with the review marker sitting in its bowl. The square
marker echoes the "RS" badge RepoSpector places beside diff lines.

![RepoSpector horizontal logo](png/repospector-horizontal.png)

## Files

| Use | File |
|---|---|
| Logo with name (default) | `svg/repospector-horizontal.svg` |
| Logo with name, stacked | `svg/repospector-stacked.svg` |
| Symbol only | `svg/repospector-symbol.svg` |
| Symbol at 32 px and below (no marker) | `svg/repospector-symbol-small.svg` |
| On dark surfaces | `svg/repospector-symbol-dark-ui.svg` (light teal), `svg/repospector-horizontal-white.svg` |
| One colour | `svg/*-black.svg`, `svg/*-white.svg` |
| App icon (white R on teal tile) | `svg/repospector-app-icon.svg`, `svg/repospector-app-icon-small.svg` |
| Name only | `svg/repospector-wordmark.svg` |
| Website icons | `web/` (favicon.ico, PNG icons, `site.webmanifest`, `head-snippet.html`) |
| PNGs for documents and slides | `png/` |
| Chrome extension icons (16, 32, 48, 128) | `packages/extension/static/icons/` |
| Presentation with mockups | `board.html`, `board/slide-*.png` |

## Colour

| Role | HEX | RGB | Contrast |
|---|---|---|---|
| Teal (the mark) | `#0B6E63` | 11, 110, 99 | 6.13:1 on white |
| Light teal (the mark on dark) | `#5CC8B6` | 92, 200, 182 | 8.90:1 on `#14171A` |
| Ink (the name) | `#1B1F23` | 27, 31, 35 | 16.58:1 on white |
| White (on the teal tile) | `#FFFFFF` | 255, 255, 255 | 6.13:1 on teal |

These are the extension's own colours (`packages/extension/DESIGN.md`), measured with a WCAG contrast checker. For print,
match the teal by eye on a proof; no Pantone reference has been chosen yet.

Never put the dark teal mark on a dark background: it nearly disappears (tested on `#111111` and Chrome's dark
toolbar). Use the light teal or white version there.

## Clear space and size

- **Clear space:** keep at least one stroke width free on every side: 1/6 of the R's height (32 units on its 192-unit
  height). Inside the app-icon tile the R already has its space.
- **Minimum size:** symbol 16 px. At 32 px and below use the small cut (`*-small.svg`); the marker would only be a smudge.
  Horizontal logo at least 120 px wide; below that, use the symbol alone.
- **Chrome toolbar:** use the tile (white R on teal). It reads on light and dark toolbars; the bare R does not on dark.

## Type

The name is **IBM Plex Sans SemiBold** (SIL Open Font License 1.1, which allows logo use), converted to outlines with
the font's own kerning, so no font is needed to use the files. "Plex" is a reserved font name: do not ship a modified
copy of the font under that name. For text that sits next to the logo, use IBM Plex Sans or the system interface font.

## Don't

- Recolour the mark outside the palette, add gradients, shadows or outlines.
- Stretch, rotate or skew it, or change the R's proportions.
- Move the marker, make it round (it then reads as an eye) or remove it above 32 px.
- Set the name in another typeface, or type it out next to the symbol instead of using the lockup files.
- Place the dark teal mark on a dark or busy background.

## Construction

256-unit grid, 32-unit strokes, angles of 0° and 45° only. Stem x 48–80, y 32–224; bowl outer radius 72, inner 40,
centred at (136, 104); leg at 45° from the bowl to the baseline; marker 32 × 32 centred in the bowl. One outline, no
overlaps.

## Before wide use

A trademark search has not been done. Check trademark databases and run a reverse image search before printing
or registering the mark.
