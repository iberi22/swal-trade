# Extension side-panel tests

One file per panel area, all sharing the harness in `helpers/panel.ts`. The
Playwright project `extension` picks up every `tests/ext-*.spec.ts`.

| File | Area |
|---|---|
| `ext-operacion.spec.ts` | Operación: context band, levels map, findings/legend, chart and CVD, paint commands, headlines, explain card |
| `ext-sizing.spec.ts` | Sizing: sizer, scale-in, trade cards, position card, page balance as capital |
| `ext-drawing.spec.ts` | «Tu dibujo» card and its hotkey |
| `ext-mytrades.spec.ts` | Mis trades: page and API history, metrics, exports, analysis tab, AI card |
| `ext-scanner.spec.ts` | Escáner: public mover scan |
| `ext-settings.spec.ts` | Ajustes: persistence, hotkeys, prompt config, credentials |
| `ext-learn.spec.ts` | Glossary tooltips and the Aprender tab |
| `ext-shell.spec.ts` | Panel shell: tabs, keyboard navigation, collapsed sections |

## Harness API (`helpers/panel.ts`)

| Export | What it does |
|---|---|
| `openSidePanel(fetchImpl?, klines?, initScript?)` | Loads the WXT build output of the extension (run `npm run build` in apps/extension first) in a persistent Chromium and returns `{ page, extensionId, errors, newsRequests, close() }`. Stubs klines, depth, premiumIndex, ticker, exchangeInfo, alternative.me, the local radar, the news endpoint and every websocket. `fetchImpl` answers the news call, `klines` overrides the candle window, `initScript` runs before the panel boots. Always `await panel.close()` in `finally`. |
| `openTab(page, name)` | Clicks a tab by name and waits until it is selected. |
| `openAnalysis(page)` | Opens «Mis trades» with the «Clave API» source. |
| `seedSettings(page, settings)` | Writes `storage.local.settings` and reloads the panel. |
| `fulfillJson(route, body, status?)` | Fulfils a route with JSON and permissive CORS. |
| `FNG` | alternative.me fear-and-greed payload. |
| `toBinanceKlines(candles?, opts?)` / `aggressiveBuyKlines()` | Binance-shaped candle rows; the second one has a taker-buy shock. |
| `scannerKlines(lastOpen, lastClose)` and `SC_BAR` | 5-minute scanner candles around a drop. |
| `FUTURES_TAB_FAKE` | `chrome.tabs.query` stub for an active Binance Futures tab (id 7). |
| `MOCK_ANALYSIS_SCRIPT`, `KEY_META` | Account/history/AI background mock and a configured read-only key. |
| `NEWS_URL`, `SidePanel` | News host and the panel handle type. |

## Rules for new tests

- **Mock all network.** CI egress gets HTTP 451 from Binance and there is no
  local radar or bridge. Add routes through `openSidePanel` or `page.route`
  with `fulfillJson`; never rely on a live host.
- **Use `data-testid`** (and accessible roles/names) for selectors. No CSS
  structure or nth-child selectors, no text that a copy change can break.
- **No test depends on another.** Each test opens its own panel, seeds its own
  state and closes it. Order and `--workers` must not matter.
- **No `.skip`.** Fix the mock or the assertion instead of disabling a test.
- Keep area-specific fixtures in the area file; anything used by two areas
  belongs in `helpers/panel.ts`.
