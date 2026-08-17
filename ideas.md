# Gold Journal — Product & Design Direction

Gold Journal is a serious, private performance journal for a discretionary XAUUSD trader. The interface should feel closer to an instrument panel than a generic finance dashboard: **dark graphite surfaces, controlled gold highlights, compact numerical density, and brief, consequential motion**. The central principle is that data must feel calm and legible under pressure, while decisions and risk signals remain unmissable.

## Visual philosophy

The foundation is a near-black **#10141A** canvas with layered graphite panels, thin low-contrast rules, and a restrained amber-gold accent. Inter handles labels, hierarchy, and prose; DM Mono is reserved for balance, P&L, timestamps, percentages, and risk figures. Gold should communicate focus, intent, and primary action—not decoration. Green and red are semantic-only signals for positive and negative outcomes; amber marks attention and risk.

The desktop experience uses a stable left navigation rail and an information-dense workspace. Mobile collapses this into a compact top bar, full-height drawer, and thumb-accessible bottom navigation. Cards use shallow depth, a fine inner edge, and modest hover elevation. Animations stay under 300ms and use opacity and transform, with a reduced-motion fallback.

## First delivery focus

The foundation delivery should make the journal usable rather than merely presentational: authentication, account creation and switching, cloud persistence, the trade log, cash movements, trade creation/editing/viewing/deletion, basic goals and dashboard summaries, and an installable PWA shell. Supporting pages should have complete navigation and robust empty/error states while their deeper workflows are completed in sequence.

## Interaction decisions

The interface starts with a branded AU splash rather than a blank page. A user’s main decision surface is the Trade Log, where the current account, balance, win rate, P&L, and active goal risk are visible before the table. The trade composer uses focused groups—details, strategy, execution, risk, evidence, emotions, and notes—to make complete journaling straightforward without creating one intimidating wall of fields.

All dates are formatted through one DD/MM/YYYY formatter. Risk/reward is always presented as `1 : X.XX` and returns an em dash when risk is zero or missing. New trades auto-select a session based on Pakistan Standard Time, while edits preserve the original selection. Destructive operations require a confirmation dialog, and all workflows communicate specific outcomes.

