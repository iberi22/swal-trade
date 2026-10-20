# Exchange adapters

Adapters describe how the panel finds an exchange page, reads its symbol and
(for supported exchanges) reads account data from visible labels. Nothing here
grants browser permissions.

## Status

| Adapter | Status | Reads the page? | Chart |
| --- | --- | --- | --- |
| Binance Futures | `supported` | yes (balance, positions, history) | TradingView iframe |
| Bybit, OKX, Bitget, BingX, MEXC, Gate.io, KuCoin, Hyperliquid | `detected` | no | unknown |

`detected` means only the URL match and `symbolFromUrl` exist. A detected
exchange must never be presented as supported: the panel has no readers for it,
so `isSupported()` is false and `adapterStatusLabel()` says
"detectado (sin soporte todavía)".

## Promoting a `detected` exchange to `supported`

Each step is required; skipping one produces a panel that lies or breaks.

1. **Host permission** in `apps/extension/wxt.config.ts` `host_permissions`,
   limited to the exchange page pattern (never `<all_urls>` or a bare domain
   wildcard). `lib/manifest-guard.test.ts` is a snapshot test: it fails on any
   host that is not in its allow-list, so the allow-list has to be updated in
   the same change and the new host reviewed.
2. **Content-script match**: add the page pattern to the `matches` array of
   `entrypoints/content.ts`. Only then does the script run on that page. Do not
   reuse the Binance pattern.
3. **Label dictionary**: add the exchange's visible labels (account box and
   positions/history tables) to `lib/page-account/labels.ts`, in every language
   the page ships. Binance labels do not transfer: each exchange words the
   account box differently.
4. **Parsers and readers**: write the region finders and parsers for that DOM
   and wire them as `readers` in the adapter (`balance`, `positions`,
   `history`). Keep them pure (`TextNode` in, data out) so they can be tested
   without a browser, and never rely on CSS classes.
5. **Message validation**: route the data through `lib/page-account/messages.ts`
   so the background validates field by field before storing it.
6. **Live verification**: capture the real page (Spanish and English, cross and
   isolated margin), add fixtures built from those captures, and check the
   panel against the exchange UI side by side. Mark the adapter `supported`
   only after that; until then it stays `detected`.

## Deliberately out of scope

- Order placement or form filling on any exchange.
- Reading pages through undocumented APIs or hidden endpoints.
- Any exchange without a TradingView-based chart.
