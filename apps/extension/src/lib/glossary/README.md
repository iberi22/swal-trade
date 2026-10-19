# Glossary

Spanish glossary / mini-wiki for the side panel: hover tooltips over any term
and the "Aprender" tab. Structure lives in TypeScript, prose lives in JSON so
it can be translated.

## Files

| File | Purpose |
|------|---------|
| `entries.ts` | `GLOSSARY` (structure only, no prose), `entryById`, `entryForText`, `termsInText`, `normalizeTerm`. |
| `glossary.es.json` | All Spanish text, flat dotted keys. |
| `glossary.test.ts` | Vitest: unique aliases, valid `related`, prose keys present, `statRef` ids exist, every level kind and every analysis-core `kind` has an entry. |
| `stats.json` | Measured reaction rates (produced elsewhere, not authored here). |
| `../../../scripts/glossary-check.mjs` | Content linter (no dependencies). |

## Data model

```ts
interface GlossaryEntry {
  id: string;                       // snake_case or the exact LevelKind (e.g. prevDayHigh)
  category: 'niveles' | 'patrones' | 'sentimiento' | 'cierres' | 'flujo' | 'riesgo' | 'escaner';
  aliases: readonly string[];       // exact strings the UI shows; matched ignoring case and accents
  statRef?: { type: 'level' | 'pattern'; id: string; direction?: 'long' | 'short' };
  related: readonly string[];       // ids of other entries
  role?: 'resistance' | 'support' | 'neutral' | 'context';
}
```

- `statRef.id` must be exactly a `LevelKind` from `src/lib/context/levels.ts`
  or a `kind` emitted by `workers/public-site/static/analisis/analysis-core.js`.
  `direction` is set only for kinds with an intrinsic side (bullish = `long`,
  bearish = `short`).
- Entries without `statRef` are concepts (funding, CVD, stop loss...) with no
  measured reaction rate.
- Matching: `entryForText` needs the whole text to equal an alias;
  `termsInText` finds non-overlapping aliases (longest first, word boundaries)
  and returns offsets into the original text. Merged level labels such as
  `PDH + R1` work.

## Prose keys (`glossary.es.json`)

For each entry `<id>` (all required, plain text, no HTML or markdown, no `{}`):

| Key | Max chars | Content |
|-----|-----------|---------|
| `glossary.<id>.title` | 60 | Name |
| `.short` | 110 | One-line plain definition |
| `.what` | 320 | What it is and how it is computed (formulas where deterministic) |
| `.read` | 320 | How traders read it |
| `.up` / `.down` / `.range` | 220 | Reference reading when the trend is up / down / sideways |
| `.watch` | 220 | Typical traps; say honestly when it is a convention, not a measured edge |

Plus `glossary.category.<id>`, `glossary.ui.*` and the measured-stats templates
`glossary.stats.{promising,no_evidence,negative,none}` that use the
placeholders `{rate} {low} {high} {baseline} {lift} {n}` (UI also uses
`{trend}`). Interpolation is plain `{name}` replacement.

## Hard rules

- Numbers shown to users (rates, intervals, n, lift) come only from
  `stats.json` through the `glossary.stats.*` templates. Never write a measured
  figure in the prose. Formulas and parameters of the code (for example "Bollinger
  20, 2" or "0,72 ATR") are definitions, not measurements, and are allowed.
- Never promise or imply profit. `up`/`down`/`range` are phrased as a
  reference with its limit ("suele ser tratado como...", "no esta medido que...").
- Our audit found no stable directional edge in chart patterns, sessions,
  funding or fear/greed. Say so in `.watch` when it applies.
- Forbidden words (checked by `glossary-check.mjs`, accent and case
  insensitive): comprar, vender, entra, senal de compra/venta, garantiz*,
  siempre, seguro; and "win rate" / "tasa de acierto" outside `glossary.stats.*`.

## Adding a term

1. Find the exact string the UI shows (and any variants) and add them to
   `aliases`. Aliases must be unique across all entries (the test checks it).
2. Add the entry to `entries.ts` with `category`, `related`, `role` and, if it
   is a level or pattern, `statRef`.
3. Add the 8 prose keys to `glossary.es.json`.
4. Run both checks (from `apps/extension`):

```bash
node scripts/glossary-check.mjs
node node_modules/vitest/vitest.mjs run src/lib/glossary
```

`glossary-check.mjs` is a standalone script (`package.json` is not modified).
It verifies prose keys per entry, orphan keys, length limits, forbidden words,
well-formed placeholders and plain text, and exits 1 on any problem.
