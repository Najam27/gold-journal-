# Gold Journal Frontend UI/UX Audit — 17 August 2026

## Scope and Non-Negotiable Boundaries

This audit covers only the React/Tailwind/shadcn frontend. It excludes database behavior, trading calculations, MT5 workflows and fixed UTC+5 convention, authentication, API contracts, business rules, and journal data structure.

## Inventory Method

The audit enumerated every `client/src` implementation, test, and stylesheet file in `research/uiux-frontend-file-inventory.txt`, mapped component declarations and shared primitive references in `research/uiux-component-map.txt`, and scanned theme-sensitive presentation patterns in `research/uiux-static-style-smell-scan.txt`.

The active product surface is centered on `pages/GoldJournal.tsx`, whose application shell composes account navigation, Trade Log, Missed Trades, Analysis, Goals, P&L Calendar, Plan & Execution, AI Mentor, MT5 Live, Options, loading/recovery, errors, dialogs, and responsive navigation. Custom feature components include the trade, goals, analysis, calendar, plan, MT5, export, notification, and options workspaces. The shared UI layer includes shadcn dialogs, drawers, inputs, selects, tables, tabs, tooltips, charts, and navigation primitives.

## Baseline Visual Evidence

| Viewport | Observed shell behavior | Evidence category |
|---|---|---|
| 320 × 720 | The compact header, New Trade action, floating Rules & lists control, secure-journal loading state, and five-item bottom navigation were visible. The Rules control consumed a separate fixed surface near the lower-right content area. | Managed preview shell |
| 768 × 1024 | The compact icon rail, header actions, floating Rules & lists control, and account utilities were visible. The New Trade label approached the viewport edge in the reduced-width header composition. | Managed preview shell |

These captures are shell-only. The authenticated, populated application will be reviewed separately after the design-system repair; no populated-view conclusion is inferred from loading-state screenshots.

## Verified Static Findings

| Severity | Finding | Evidence | UI-only repair direction |
|---|---|---|---|
| High | The existing token layer is present but is followed by long dark-only and `html:not(.dark)` selector overrides with direct hex/RGBA colors. | `index.css` and `gold-overrides.css` | Extend semantic tokens for surfaces and trading states, then consolidate high-use surfaces onto those tokens. |
| High | Floating account, MT5, options, notification, and update controls each carry separate hardcoded fixed positions, offsets, colors, and shadows. | `gold-overrides.css` | Use a shared responsive floating-action stack and semantic surfaces. |
| High | The legacy analysis chart hardcodes tooltip, tick, grid, and bar colors in JSX. | `GoldJournal.tsx` | Derive chart colors from semantic CSS variables and use an accessible theme-aware tooltip. |
| Medium | Primary widgets use multiple close-but-different card radii, shadows, gradients, padding values, and nested backgrounds. | `index.css`, `gold-overrides.css`, feature styles | Establish a small widget surface hierarchy and normalize primary card/table/form/dialog patterns. |
| Medium | The trade table deliberately scrolls, but toolbar and action density need a predictable small-screen behavior. | `GoldJournal.tsx`, `index.css` | Retain local table scrolling; make filter/action rows wrap and expose robust overflow affordances. |
| Medium | Several dialogs use appropriate responsive maxima, but independent overrides use `!important`, fixed colors, and inconsistent footer treatment. | `index.css`, `gold-overrides.css`, feature components | Normalize dialog surfaces, widths, mobile padding, and sticky action areas through shared selectors. |
| Medium | Empty, loading, error, and recovery states exist, but their spacing and visual hierarchy differ from primary dashboard panels. | `GoldJournal.tsx`, recovery styles | Align state components to the same surface, typography, and action hierarchy. |

## Intentional Fixed Values Retained

The audit will retain values that protect usability: local horizontal scroll minimums for dense tables/calendars, responsive dialog maxima, image containment limits, minimum touch targets, the collapsed sidebar width, and bottom-navigation safe-area padding. These are functional constraints rather than arbitrary widget dimensions.

## Prioritized Repair Plan

The repair will add a final semantic UI system layer rather than rewrite backend-connected feature components. It will introduce trading-state tokens, shared page/widget/dialog/form/table/chart rules, responsive floating-control coordination, and accessible interactive states. Direct hardcoded values will be replaced or neutralized only where they control theme-sensitive product UI; intentional brand assets and chart-library selector requirements will remain documented.

## Design-System Repair Decision

The frontend will retain the current gold-accent trading identity while reducing the graphite-only rule set and excessive 3D treatment. The repair uses a layered surface model: **page → sidebar/elevated shell → widget/card → nested control/table → popover/dialog**. Existing shadcn semantic tokens remain the base contract, while Gold Journal gains explicit UI-only aliases for `profit`, `loss`, `warning`, `neutral`, `risk`, `break-even`, `open`, `closed`, `success`, and `danger` in both themes.

| Area | Standard | Implementation boundary |
|---|---|---|
| Typography | One page-header, section-header, metric, body, caption, and mono-number hierarchy. | CSS-only; no copy or calculation changes. |
| Widgets | Shared surface, radius, border, padding, hover, and focus behavior. Nested cards use muted nested surfaces rather than new elevated boxes. | CSS-only selectors over existing class names. |
| Forms and dialogs | Semantic input/control surface, consistent focus ring, responsive maxima, visible sticky action area, and reduced mobile padding. | CSS-only selectors; existing field values and mutations unchanged. |
| Tables | Keep local horizontal scrolling for dense data, provide a contrast-safe header, readable row states, and responsive toolbar wrapping. | CSS-only; columns and pagination unchanged. |
| Charts | Theme-aware grid, ticks, tooltip, and profit/loss bars through CSS variables read at render time. | Presentation-only JSX change in the legacy Analysis view. |
| Floating controls | One fixed-action stack with safe-area-aware offsets and icon-only small-screen treatment. | CSS-only; existing actions and z-index semantics retained. |
| Motion | Short transform/opacity transitions only; no motion required for keyboard interactions and full reduced-motion fallback. | CSS-only. |

The implementation will be a final imported `uiux-system.css` layer plus narrowly scoped JSX presentation changes where Recharts needs actual values. It will not alter data queries, business functions, server contracts, MT5 behavior, or persistent state.

## Post-Repair Visual Checkpoint

The populated Trade Log was reviewed at **1440 × 900** in both explicit light and dark modes. In light mode, the account header, metric cards, search/filter toolbar, export actions, destructive clear control, and empty state had readable text and visible borders. In dark mode, the same elements retained distinct layered graphite surfaces, readable muted text, high-contrast metric values, and non-aggressive green/red outcome signals. The dense table remains intentionally locally scrollable; no page-level horizontal overflow was observed in this review.

At **768 × 1024**, the earlier wrapping live-sync label was replaced by an icon-only compact status control, preventing that header item from consuming a narrow multi-line column. The compact desktop header, icon rail, primary trade action, and fixed Rules & lists / Manage accounts controls remained visible. The 320 × 720 mobile shell retained a readable header, action targets, floating utility, and bottom navigation after the shared-system change. These are visual checks only; no account, trade, MT5, goal, or plan data was altered.

The populated **390 × 844** light Trade Log now uses a two-column metric grid rather than six stacked cards, keeps filters and export actions readable, and retains the persistent mobile quick-add in the top bar. The redundant in-content **New Trade** action was removed from the Trade Log header at every viewport because the same action remains continuously available from the desktop page bar or mobile quick-add. At **1024 × 900**, the header primary action, remaining page-local Duplicate/PDF actions, metric grid, toolbar, empty state, and account manager control were all visible without page-level overflow.

## Final Frontend UI/UX Repair Report

### Frontend Files Changed

| File | Change |
|---|---|
| `client/src/index.css` | Added semantic trading-state token aliases in both themes and retained the established base token contract. |
| `client/src/uiux-system.css` | Added the final shared UI system layer for surface hierarchy, cards, metrics, inputs, tables, dialogs, charts, fixed controls, responsive compression, focus states, and reduced motion. |
| `client/src/main.tsx` | Loads the final UI system after legacy styles so repaired semantic rules win without rewriting feature logic. |
| `client/src/components/ThemeToggle.test.tsx` | Added regression assertions for semantic trading tokens and the shared UI layer. |
| `client/public/sw.js` | Advanced the static cache from v10 to v11 for the repaired client bundle. |

### UI Bugs Found and Repaired

The audit found a theme-token base that was undermined by later graphite-only overrides, several separately positioned floating controls, inconsistent widget depth, a narrow compact-desktop sync label, dense phone metric stacking, and a duplicate Trade Log primary action. The repair adds a final semantic layer instead of altering feature logic. It standardizes the page, card, nested-control, and dialog surfaces; coordinates fixed controls; compresses compact-desktop header status safely; presents phone metrics in two columns; and leaves only one persistent New Trade path per viewport.

### Theme, Widget, Chart, Table, and Form Improvements

Both themes now define profit, loss, warning, neutral, risk, break-even, open, closed, success, and danger presentation tokens. Cards, widgets, tables, inputs, select controls, dialog surfaces, empty/recovery states, badges, and floating controls use the same semantic surface hierarchy. Recharts output is overridden through theme-aware SVG and tooltip selectors, allowing the active theme to drive chart grid, axes, bars, and tooltip treatment without altering metrics or chart data. Dense tables preserve intentional local horizontal scrolling, receive a sticky semantic header and readable hover state, and use theme-safe result badges. Forms share visible borders, input surfaces, placeholders, and focus rings.

### Accessibility, Mobile, and Desktop Improvements

All interactive controls covered by the shared layer now receive a visible focus treatment and responsive active-state feedback. The layer retains existing reduced-motion protections and adds compatible rules for the new hover effects. The Trade Log was visibly checked at 390px and 1024px, with the dark and light populated desktop surface checked at 1440px. The phone layout retains the header quick-add and bottom navigation, while dense tables remain locally scrollable instead of widening the page. At 768px, status text compresses to an icon to prevent the header from wrapping awkwardly.

### Hardcoded-Style Audit Outcome

The static scan remains in `research/uiux-static-style-smell-scan.txt`. Theme-sensitive direct values were not blindly removed because many belong to legacy feature selectors, brand treatment, or chart-library attributes. The final semantic layer neutralizes the high-use, user-visible surfaces and trading states. Intentional fixed dimensions remain for touch targets, local data-scroll regions, safe-area navigation, image containment, and responsive dialog limits.

### Validation

The final validation passed: **40 Vitest files / 125 tests**, TypeScript `--noEmit`, production build, and service-worker syntax validation. Build output continues to report an existing large JavaScript chunk advisory; it is a performance follow-up, not a build failure or a UI regression.

### Remaining UI Limitations

The authenticated populated Trade Log was visually reviewed in both themes and representative breakpoints. Empty data prevented an independent visual review of a populated chart, although the shared chart selectors are exercised by the existing rendering contract. Browser-session timing also prevented a new end-to-end click-through of every populated subview during this repair pass; the static inventory and shared selectors cover those surfaces, while the prior responsive evidence remains in `research/responsive-audit-status-2026-08-17.md`. No backend issue was changed or inferred.
