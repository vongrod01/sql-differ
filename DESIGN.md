---
name: database-diff
description: A calm dark review desk for reading schema differences and choosing what goes into a script.
colors:
  night-ink: "#0b0d13"
  sheet-slate: "#171b26"
  control-slate: "#242a36"
  recess-ink: "#0d1017"
  edge-line: "rgba(255, 255, 255, .12)"
  paper-white: "#f2f3f5"
  quiet-grey: "#a3a6b0"
  nav-grey: "#c9ccd4"
  action-blue: "#0a84ff"
  action-blue-text: "#6cb2ff"
  on-action: "#ffffff"
  add-green: "#34d65c"
  add-green-tint: "rgba(48, 209, 88, .17)"
  extra-red: "#ff6f66"
  extra-red-tint: "rgba(255, 69, 58, .18)"
  change-amber: "#ffb02e"
  change-amber-tint: "rgba(255, 159, 10, .17)"
  unverified-grey: "#c3c6cf"
  unverified-tint: "rgba(255, 255, 255, .10)"
  armed-red: "#c9332a"
typography:
  display:
    fontFamily: "Leelawadee UI, Segoe UI, Tahoma, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.2
    fontFeature: "tnum"
  headline:
    fontFamily: "Leelawadee UI, Segoe UI, Tahoma, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: 1.3
  title:
    fontFamily: "Leelawadee UI, Segoe UI, Tahoma, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.6
  body:
    fontFamily: "Leelawadee UI, Segoe UI, Tahoma, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Leelawadee UI, Segoe UI, Tahoma, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.6
  code:
    fontFamily: "Consolas, Cascadia Mono, Leelawadee UI, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "6px"
  md: "14px"
  lg: "20px"
  xl: "24px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.control-slate}"
    textColor: "{colors.paper-white}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "7px 18px"
    height: "40px"
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.on-action}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "7px 18px"
    height: "40px"
  button-danger-armed:
    backgroundColor: "{colors.armed-red}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.pill}"
    padding: "7px 18px"
    height: "40px"
  input:
    backgroundColor: "{colors.recess-ink}"
    textColor: "{colors.paper-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
    height: "40px"
  nav-link:
    textColor: "{colors.nav-grey}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
  chip-add:
    backgroundColor: "{colors.add-green-tint}"
    textColor: "{colors.add-green}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 11px"
  chip-extra:
    backgroundColor: "{colors.extra-red-tint}"
    textColor: "{colors.extra-red}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 11px"
  chip-change:
    backgroundColor: "{colors.change-amber-tint}"
    textColor: "{colors.change-amber}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 11px"
  chip-unverified:
    backgroundColor: "{colors.unverified-tint}"
    textColor: "{colors.unverified-grey}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 11px"
  panel:
    backgroundColor: "{colors.sheet-slate}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.xl}"
    padding: "16px 18px"
  code-block:
    backgroundColor: "{colors.recess-ink}"
    textColor: "{colors.paper-white}"
    typography: "{typography.code}"
    rounded: "{rounded.lg}"
    padding: "14px"
---

# Design System: database-diff

## Overview

**Creative North Star: "The Review Desk"**

A dark, quiet desk where one developer sits down with two versions of a database and decides what leaves it. Everything on the surface exists to be read first and acted on second: sheets of a single slate tone hold the text, a few capsule controls sit on them, and four status colours say what kind of difference each row is. Nothing decorates and nothing competes with the rows.

The page is Operate-mode work, so the system is plain on purpose. The canvas is solid Night Ink with no pattern or image behind it, and the reading sheets are opaque, so a Thai sentence or a SQL line never sits over anything that moves or blurs. The only softness is in the controls: buttons, chips, inputs, nav and filters share one capsule form, which gives the tool a calm, approachable character without turning the tables into ornament.

The HTML reports use the same tokens as the web app, so a report opened from disk reads as the same room as the app it came from.

**Key Characteristics:**
- Dark only; solid canvas, opaque sheets, no backdrop imagery, no blur.
- One capsule form (pill, 999px) for every control; larger radii only for the sheets that hold content.
- Four status hues carry difference state; one blue carries "you can act on this".
- Depth is tonal: lighter slate means closer, near-black means recessed. There are no outer shadows.
- Thai first: 15px body at a 1.6 line height with Leelawadee UI, so Thai vowel and tone marks have room.

## Colors

A near-black blue-grey canvas with three slate steps above it, white text, and a tightly rationed set of status hues and one blue.

### Primary
- **Action Blue** (`#0a84ff`): the fill of the one main action on a view, of ticked checkboxes, of selected pills (category and day pickers, the segmented control) and of the running tag. On buttons and selected pills it is applied as a translucent top-down gradient over the dark surface rather than a flat slab.
- **Action Blue Text** (`#6cb2ff`): the same blue where it is text or a line: links, focus rings, link-style buttons and the spinner's moving edge. The lighter value keeps it readable on slate.

### Secondary
Status hues. They mean one thing each and appear only with a word beside them.
- **Add Green** (`#34d65c`): something that will be added; also "ok" and "done". Tint: `#34d65c` at 17% (`add-green-tint`).
- **Extra Red** (`#ff6f66`): something that exists only on the other side and would be removed; also errors and the danger text on delete. Tint: `extra-red-tint`.
- **Change Amber** (`#ffb02e`): something that exists on both sides but differs, and warnings. Tint: `change-amber-tint`.
- **Unverified Grey** (`#c3c6cf`): something that could not be compared (for example a missing VIEW DEFINITION permission). Tint: `unverified-tint`.

### Neutral
- **Night Ink** (`#0b0d13`): the canvas under everything.
- **Sheet Slate** (`#171b26`): the opaque reading surface: panels, tables, cards, notices.
- **Control Slate** (`#242a36`): the raised surface of buttons, the nav capsule and the action bar.
- **Recess Ink** (`#0d1017`): recessed wells: inputs, nested panels, log and code blocks, checkbox interiors.
- **Edge Line** (`rgba(255, 255, 255, .12)`): the 1px outline of every sheet, control and capsule. It rises to 28% under reduced-transparency or forced colors and to 45% under increased contrast.
- **Paper White** (`#f2f3f5`): primary text.
- **Quiet Grey** (`#a3a6b0`): secondary text, table headers, field labels, hints. Brightens to `#c4c7cf` under increased contrast.
- **Nav Grey** (`#c9ccd4`): idle nav links and unselected pills.
- **Armed Red** (`#c9332a`): the fill of a delete button after its first click.

### Named Rules
**The Status Word Rule.** A status colour never appears alone. Green, red, amber and grey always sit beside the word that says what the row is (the kind words in the report and in `app.js`), so the colour confirms the meaning and never carries it.

**The One Blue Rule.** Blue means you can act on this. It is never used for decoration or for a difference state.

**The Opaque Reading Rule.** Text sits on Sheet Slate, Control Slate or Recess Ink, never directly on the canvas and never over a translucent or blurred layer.

## Typography

**Display, Headline, Title, Body and Label Font:** Leelawadee UI (with Segoe UI, Tahoma, system-ui, sans-serif)
**Code Font:** Consolas (with Cascadia Mono, Leelawadee UI, monospace)

**Character:** One humanist system family for Thai and Latin, chosen for its Thai coverage. A monospace for everything that is SQL or an object name, falling back to Leelawadee UI so Thai inside code still renders.

### Hierarchy
- **Display** (700, 28px, 1.2, tabular figures): the count on each status card. Numbers align in columns.
- **Headline** (650, 26px, 1.3): the page title, one per view.
- **Title** (650, 18px): section headings inside a view.
- **Body** (400, 15px, 1.6): everything that is read, including Thai. The 1.6 line height is load-bearing for Thai marks.
- **Label** (650, 14px): chip text, table headers, side titles. Field labels and hints use the same 14px at normal weight in Quiet Grey.
- **Code** (400, 14px, 1.55): the live log and script views; object names in the report are 16px at 650.

### Named Rules
**The Tabular Numbers Rule.** Any number that is counted, summed or compared (counts, sizes, durations, table cells in `.num`) uses tabular figures and right alignment.

## Layout

A single centered column. Content is capped at 1180px with 16px side padding, 24px above and 72px below. The nav capsule floats above it, sticky 12px from the top and capped at 1148px, so the page scrolls beneath it.

Inside the column, sheets stack with a 16px gap. Side-by-side groups (the two servers in a comparison) use an auto-fit grid with a 280px minimum and a 16px gap; the status cards use a 200px minimum and a 12px gap. Spacing runs on a 4, 8, 12, 16, 24 rhythm; table cells breathe at 11px by 16px.

The main action lives in a capsule bar that sticks 14px above the bottom of the viewport, so it stays reachable while a long form or list scrolls under it.

Below 640px the nav wraps onto a second row instead of scrolling (hiding the current page is worse than taking a row), cell padding tightens to 9px by 11px, and sheets drop to 14px padding. Below 520px the category rows stack their label above their pills.

## Elevation & Depth

Tonal layering with no outer shadows. The three slates are the depth system: Night Ink is the floor, Sheet Slate is the surface you read, Control Slate is what you press, and Recess Ink is a well cut into a sheet. Outer shadow and blur tokens exist (`--edge`, `--lift`, `--blur`) and are set to nothing; a control that needs to stand out gets a brighter Edge Line, not a shadow.

### Shadow Vocabulary
- **Recess** (`box-shadow: inset 0 1px 3px rgba(0, 0, 0, .45)`): inputs, selects and checkbox wells. Nested panels and code blocks use the same inset at .35 and .5 strength.

### Named Rules
**The Flat Floor Rule.** There is no backdrop image, pattern, glow or blur behind the content, and sheets do not cast shadows. Depth comes from the step between slates.

## Shapes

Two radii families that never mix. Every interactive control is a full capsule (999px): buttons, chips, nav links, the segmented control, category and day pills, the action bar. Containers that hold reading content are large soft rectangles: panels at 24px, nested panels and notices at 20px, inputs and wells at 14px. Checkboxes are the only small radius (6px) and radios are circles. All outlines are 1px Edge Line; selected pills swap the outline for a blue one rather than thickening it.

## Components

### Buttons
- **Shape:** full capsule (999px), 40px tall, 7px by 18px padding; the compact variant used in table rows is 34px tall at 14px.
- **Default:** Control Slate fill with Edge Line outline and Paper White text.
- **Primary:** Action Blue as a top-down gradient from 86% to 54% opacity, a blue outline, white 650-weight text. It marks the main action of a view.
- **Hover / Focus:** hover brightens the fill with a faint white gradient and turns the outline blue; focus-visible draws a 2px Action Blue Text ring offset 2px; active nudges down 1px. State changes ease over .15s, and only when the person has not asked for reduced motion.
- **Danger:** default button with Extra Red text; after the first click it becomes armed, filled Armed Red with a white label, and needs a second click.
- **Link:** no fill, no outline, Action Blue Text, underline on hover.

### Chips
- **Style:** pill with a 14px, 650-weight word on a status tint (Add Green, Extra Red, Change Amber, Unverified Grey; blue for running).
- **State:** chips are read-only labels. The selectable variant is the pill picker for categories and days: a Nav Grey pill with a faint white fill that turns to the blue gradient with white text when checked, keeping the real checkbox underneath for the keyboard.

### Cards / Containers
- **Corner Style:** 24px panels, 20px for cards and nested panels.
- **Background:** Sheet Slate for panels and tables; Recess Ink for panels nested inside a panel.
- **Shadow Strategy:** none outside; nested panels use Recess.
- **Border:** 1px Edge Line.
- **Internal Padding:** 16px by 18px on panels (14px on phones); 12px by 16px on cards.
- **Status cards:** a card tinted with a top-down gradient of its status hue (40% fading to 16%) over Sheet Slate with a matching outline, a 28px count in the status colour, the kind word and one grey line explaining it.

### Inputs / Fields
- **Style:** Recess Ink well, 14px radius, 40px tall, 7px by 14px padding, Edge Line outline with the Recess shadow. Selects are drawn with their own chevron.
- **Focus:** 2px Action Blue Text ring, offset 2px.
- **Error / Disabled:** errors are Extra Red text at 14px under the field; disabled controls drop to 55% opacity and lose their pointer.

### Navigation
A capsule at the top: brand on the left, five links centered, the language picker on the right. Links are Nav Grey pills; hover adds a faint white wash; the active page turns white at 650 weight on a brighter capsule. The language picker is a globe icon and a compact pill select (Thai, Eng). On phones the links wrap to a second row.

### Tables
One Sheet Slate sheet with a 24px radius, horizontal scroll when needed. Header cells are Quiet Grey, 14px, 650, on a 5% white wash and never wrap. Rows are separated by 9% white lines (the last row has none). Numeric columns right-align with tabular figures; clickable rows wash 6% white on hover.

### Code and log blocks
Recess Ink with a 20px radius, 14px padding, the Recess shadow and Code type, wrapping long lines and scrolling at 360px high. In the report, object names and the markers for added and removed lines use the same code font.

## Do's and Don'ts

### Do:
- **Do** keep every interactive control a full capsule (999px) and every content sheet a large soft rectangle (14 to 24px).
- **Do** pair each status colour with its word and keep the meaning fixed: green adds, red is extra, amber changes, grey is unverified, blue is an action.
- **Do** put text on Sheet Slate, Control Slate or Recess Ink, and use the step between slates to show depth.
- **Do** use tabular figures and right alignment for every counted number.
- **Do** keep the app and the HTML reports on the same tokens; change one and change the other.
- **Do** honour reduced motion, reduced transparency, increased contrast and forced colors with the fallbacks already in the stylesheet.

### Don't:
- **Don't** add a backdrop image, circuit or code pattern, gradient glow or any decoration behind the content. The plain Night Ink canvas is the confirmed, permanent design.
- **Don't** use blur or translucent glass on anything that carries reading content.
- **Don't** use a status colour for decoration, or blue for a difference state.
- **Don't** add outer drop shadows; use a brighter outline or a different slate.
- **Don't** add a light theme; the system is dark only.
