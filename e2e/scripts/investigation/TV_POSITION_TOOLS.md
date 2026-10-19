# TV Position Tools — verified reading/calling

> Ran 2026-10-19T18:23:16.157Z (UTC). Binance Futures TradingView tab, public page, disposable headless browser.

## Summary

- **BTCUSDT** — ok
- **1000PEPEUSDC** — ok

## Exact working calls

The TradingView API lives in the chart iframe:
```js
const win = [...document.querySelectorAll("iframe")].map(f => f.contentWindow)
  .find(w => w.tradingViewApi && w.tradingViewApi.activeChart);
const chart = win.tradingViewApi.activeChart();
```

Create a position tool (both work; `createMultipointShape` is the one that
loaded the `line-tool-risk-reward.*.js` lazy chunk on the first try):
```js
// long (override levels are in TICKS):
const id = await chart.createShape({ time: <unixSec>, price: <entryPrice> }, {
  shape: "long_position",
  overrides: { profitLevel: 5000, stopLevel: 2500 },
});
// or multipoint:
const id = await chart.createMultipointShape([{ time, price }], {
  shape: "long_position",
  overrides: { profitLevel: 5000, stopLevel: 2500 },
});
// short:
const id = await chart.createMultipointShape([{ time, price }], {
  shape: "short_position",
  overrides: { profitLevel: 5000, stopLevel: 2500 },
});
```

Read (public API preferred):
```js
chart.getAllShapes().map(s => s.name);   // e.g. "LineToolRiskRewardLong"
const s = chart.getShapeById(id);
s.getPoints?.();       // [{time, price, index, offset}, ...]  -> [entry, stop, target]
s.getProperties?.();   // whole props object
s.setProperties?.({ profitLevel, stopLevel });  // live update (ticks)
s.setPoints?.([{ time, price }]);               // live update
chart.removeEntity(id);                          // cleanup
```

> ⚠️ Fragile internal paths (read-only diagnostics; do NOT rely on them in production):
```js
s._source.properties().childs().stopLevel.value()    // ticks
s._source.properties().childs().profitLevel.value()  // ticks
s._source.points()[0].price()                        // entry price
s._source.points()[1].price()                        // stop price
s._source.points()[2].price()                        // target price
s._source.properties().childs().accountSize.value()  // may exist
s._source.properties().childs().risk.value()         // may exist
s._source.properties().childs().quantity?.value()    // qty (if present)
```

## Shape names

- `long_position`
- `long_position -> long_position`
- `short_position`
- `short_position -> short_position`

## Formula (verified numerically)

Read with the PUBLIC API only: `getPoints()[0].price` is the entry; `getProperties()` returns `stopLevel` and
`profitLevel` in TICKS (they update live after `setProperties`). The tick comes from `chart.symbolExt()`.

```
minTick = symbolExt.minmov / symbolExt.pricescale
entry   = getPoints()[0].price
long:   stop = entry - stopLevel * minTick ;  target = entry + profitLevel * minTick
short:  stop = entry + stopLevel * minTick ;  target = entry - profitLevel * minTick
```

Verified: BTCUSDT (minmov 1, pricescale 100 -> tick 0.01), entry 81917.9, stopLevel = profitLevel = 592530
-> stop 81917.9 - 5925.3 = 75992.6 and target 87843.2, exactly TradingView's internal `stopPrice` / `targetPrice`.
1000PEPEUSDC uses tick 1e-7 (pricescale 10000000). The probe's automatic "matches?" table was wrong because
`getPoints()` returns only two time points with the entry price, not three prices; use the formula above.
No drawing events exist on the chart object: poll `getAllShapes()` (names `long_position` / `short_position`).

## Fields available on the tool

Observed child values (internal `_source.properties().childs()`), symbol-specific:

**BTCUSDT** child names: `_listeners`, `_muteChildChanges`, `_owner`, `_name`, `_childs`, `_dependents`, `_schema`, `_themedColors`, `_restoreFactoryDefaultsEvent`, `_replaceThemedColorsOnThemeChange`, `_forbidSavingDefaults`, `_defaultName`, `_useUserPreferences`, `_saveNonDefaultUserPreferencesOnly`, `_ignoreAllowSavingDefaults`, `_saveDefaultsConsumer`, `_factoryDefaultsSupplier`, `_allStateKeys`, `_excludedStateKeys`, `_nonThemedDefaultsKeys`, `_themedDefaultsKeys`, `_allDefaultsKeys`, `_excludedDefaultsKeys`, `_excludedTemplateKeys`, `_alwaysSaveDefaultKeys`, `_theme`, `linecolor`, `linewidth`, `textcolor`, `fontsize`, `fillLabelBackground`, `labelBackgroundColor`, `fillBackground`, `stopBackground`, `profitBackground`, `stopBackgroundTransparency`, `profitBackgroundTransparency`, `drawBorder`, `borderColor`, `compact`, `riskDisplayMode`, `accountSize`, `lotSize`, `risk`, `alwaysShowStats`, `showPriceLabels`, `currency`, `symbolStateVersion`, `zOrderVersion`, `visible`, `frozen`, `symbol`, `currencyId`, `unitId`, `adjustedToSplitTime`, `title`, `linesWidths`, `linesColors`, `intervalsVisibilities`, `interval`, `stopLevel`, `profitLevel`, `entryPointCurrencyRate`, `closePointCurrencyRate`, `entryPrice`, `stopPrice`, `targetPrice`, `riskSize`, `qty`, `amountTarget`, `amountStop`

| field | value |
|---|---|
| `_alwaysSaveDefaultKeys` | `"[undefined]"` |
| `_childs` | `"[undefined]"` |
| `_defaultName` | `"[undefined]"` |
| `_dependents` | `"[undefined]"` |
| `_excludedDefaultsKeys` | `"[undefined]"` |
| `_excludedStateKeys` | `"[undefined]"` |
| `_excludedTemplateKeys` | `"[undefined]"` |
| `_factoryDefaultsSupplier` | `"[undefined]"` |
| `_listeners` | `"[undefined]"` |
| `_name` | `"[undefined]"` |
| `_restoreFactoryDefaultsEvent` | `"[undefined]"` |
| `_saveDefaultsConsumer` | `"[undefined]"` |
| `_schema` | `"[undefined]"` |
| `_theme` | `"dark"` |
| `_useUserPreferences` | `"[undefined]"` |
| `accountSize` | `1000` |
| `adjustedToSplitTime` | `null` |
| `alwaysShowStats` | `false` |
| `amountStop` | `750` |
| `amountTarget` | `1250` |
| `borderColor` | `"#667b8b"` |
| `closePointCurrencyRate` | `1` |
| `compact` | `false` |
| `currency` | `"NONE"` |
| `currencyId` | `null` |
| `drawBorder` | `false` |
| `entryPointCurrencyRate` | `1` |
| `entryPrice` | `81917.9` |
| `fillBackground` | `true` |
| `fillLabelBackground` | `true` |
| `fontsize` | `12` |
| `frozen` | `false` |
| `interval` | `"1D"` |
| `intervalsVisibilities` | `"[undefined]"` |
| `labelBackgroundColor` | `"#585858"` |
| `linecolor` | `"#808080"` |
| `linesColors` | `"#808080"` |
| `linesWidths` | `1` |
| `linewidth` | `1` |
| `lotSize` | `1` |
| `profitBackground` | `"rgba(8, 153, 129, 0.2)"` |
| `profitBackgroundTransparency` | `80` |
| `profitLevel` | `592530` |
| `qty` | `0.04219195652540808` |
| `risk` | `25` |
| `riskDisplayMode` | `"percents"` |
| `riskSize` | `250` |
| `showPriceLabels` | `true` |
| `stopBackground` | `"rgba(242, 54, 69, 0.2)"` |
| `stopBackgroundTransparency` | `80` |
| `stopLevel` | `592530` |
| `stopPrice` | `75992.6` |
| `symbol` | `"BTCUSDT@PRICETYPE=LAST"` |
| `symbolStateVersion` | `2` |
| `targetPrice` | `87843.2` |
| `textcolor` | `"#ffffff"` |
| `title` | `""` |
| `unitId` | `null` |
| `visible` | `true` |
| `zOrderVersion` | `2` |

**1000PEPEUSDC** child names: `_listeners`, `_muteChildChanges`, `_owner`, `_name`, `_childs`, `_dependents`, `_schema`, `_themedColors`, `_restoreFactoryDefaultsEvent`, `_replaceThemedColorsOnThemeChange`, `_forbidSavingDefaults`, `_defaultName`, `_useUserPreferences`, `_saveNonDefaultUserPreferencesOnly`, `_ignoreAllowSavingDefaults`, `_saveDefaultsConsumer`, `_factoryDefaultsSupplier`, `_allStateKeys`, `_excludedStateKeys`, `_nonThemedDefaultsKeys`, `_themedDefaultsKeys`, `_allDefaultsKeys`, `_excludedDefaultsKeys`, `_excludedTemplateKeys`, `_alwaysSaveDefaultKeys`, `_theme`, `linecolor`, `linewidth`, `textcolor`, `fontsize`, `fillLabelBackground`, `labelBackgroundColor`, `fillBackground`, `stopBackground`, `profitBackground`, `stopBackgroundTransparency`, `profitBackgroundTransparency`, `drawBorder`, `borderColor`, `compact`, `riskDisplayMode`, `accountSize`, `lotSize`, `risk`, `alwaysShowStats`, `showPriceLabels`, `currency`, `symbolStateVersion`, `zOrderVersion`, `visible`, `frozen`, `symbol`, `currencyId`, `unitId`, `adjustedToSplitTime`, `title`, `linesWidths`, `linesColors`, `intervalsVisibilities`, `interval`, `stopLevel`, `profitLevel`, `entryPointCurrencyRate`, `closePointCurrencyRate`, `entryPrice`, `stopPrice`, `targetPrice`, `riskSize`, `qty`, `amountTarget`, `amountStop`

| field | value |
|---|---|
| `_alwaysSaveDefaultKeys` | `"[undefined]"` |
| `_childs` | `"[undefined]"` |
| `_defaultName` | `"[undefined]"` |
| `_dependents` | `"[undefined]"` |
| `_excludedDefaultsKeys` | `"[undefined]"` |
| `_excludedStateKeys` | `"[undefined]"` |
| `_excludedTemplateKeys` | `"[undefined]"` |
| `_factoryDefaultsSupplier` | `"[undefined]"` |
| `_listeners` | `"[undefined]"` |
| `_name` | `"[undefined]"` |
| `_restoreFactoryDefaultsEvent` | `"[undefined]"` |
| `_saveDefaultsConsumer` | `"[undefined]"` |
| `_schema` | `"[undefined]"` |
| `_theme` | `"dark"` |
| `_useUserPreferences` | `"[undefined]"` |
| `accountSize` | `1000` |
| `adjustedToSplitTime` | `null` |
| `alwaysShowStats` | `false` |
| `amountStop` | `"NaN"` |
| `amountTarget` | `"NaN"` |
| `borderColor` | `"#667b8b"` |
| `closePointCurrencyRate` | `1` |
| `compact` | `false` |
| `currency` | `"NONE"` |
| `currencyId` | `null` |
| `drawBorder` | `false` |
| `entryPointCurrencyRate` | `1` |
| `entryPrice` | `0` |
| `fillBackground` | `true` |
| `fillLabelBackground` | `true` |
| `fontsize` | `12` |
| `frozen` | `false` |
| `interval` | `"1D"` |
| `intervalsVisibilities` | `"[undefined]"` |
| `labelBackgroundColor` | `"#585858"` |
| `linecolor` | `"#808080"` |
| `linesColors` | `"#808080"` |
| `linesWidths` | `1` |
| `linewidth` | `1` |
| `lotSize` | `1` |
| `profitBackground` | `"rgba(8, 153, 129, 0.2)"` |
| `profitBackgroundTransparency` | `80` |
| `profitLevel` | `6277` |
| `qty` | `"Infinity"` |
| `risk` | `25` |
| `riskDisplayMode` | `"percents"` |
| `riskSize` | `250` |
| `showPriceLabels` | `true` |
| `stopBackground` | `"rgba(242, 54, 69, 0.2)"` |
| `stopBackgroundTransparency` | `80` |
| `stopLevel` | `6277` |
| `stopPrice` | `0` |
| `symbol` | `"1000PEPEUSDC@PRICETYPE=LAST"` |
| `symbolStateVersion` | `2` |
| `targetPrice` | `0` |
| `textcolor` | `"#ffffff"` |
| `title` | `""` |
| `unitId` | `null` |
| `visible` | `true` |
| `zOrderVersion` | `2` |

## Polling recommendation (no events)

The chart object exposes **no drawing/entity event hooks** (all `onDrawingEvent`, `onDrawingChanged`, `onShapeChanged`, `subscribe`, `on`, `off`, `onStudyEvent`, `onEntityAdded`, `onEntityRemoved` are `undefined`).
Readers must **poll** `chart.getAllShapes()` / `chart.getShapeById(id)` on an interval.
Recommended: poll every 1–2 s and diff `points` (entry/stop/target) and the `stopLevel`/`profitLevel` child values; act only when the position the user owns changes.

## Caveats

- The "Original" tab (TradingView `Original` layout) is unreadable via this API — only the chart iframe exposes `tradingViewApi`; other Binance UI panels are closed React, not accessible.
- `_source` paths are fragile internals: they can change name/shape between TV versions. Prefer `getPoints()`/`getProperties()`/`setProperties()`/`setPoints()` on the shape wrapper.
- `createShape`/`createMultipointShape` load a **lazy chunk** (`line-tool-risk-reward.*.js`); on flaky networks the first call can throw `ChunkLoadError`. It is transient: retry up to ~4× with 3 s pauses (or pre-warm with a throwaway create+remove).
- Overrides (`profitLevel`, `stopLevel`) are in **ticks**, not price — multiply by `minTick` to get price distance.
- No login/account data touched; positions created are throwaway drawings and are removed at the end of each run.
