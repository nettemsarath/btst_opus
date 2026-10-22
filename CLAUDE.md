# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BTST (buy today, sell tomorrow) bot for NSE India using the ICICI Direct **Breeze API**. Plain Node.js (CommonJS, no build step). It buys dip stocks from the Nifty 100 at ~14:58 IST and sells them the next morning at target, stoploss or a 09:45 deadline. It trades real money when `DRY_RUN=false`.

## Commands

- `npm install`, then `npm start` (runs `node src/main.js`)
- `docker compose up --build` runs it on port 3000. `data/` and `logs/` are mounted as volumes.
- There is no test runner, linter or build configured. The `test/` directory is empty.
- Config comes from `.env`: `BREEZE_API_KEY`, `BREEZE_API_SECRET`, `ALLOCATED_CAPITAL`, `MAX_POSITIONS`, `DRY_RUN`, `PORT`. `DRY_RUN` defaults to **true** and only the literal string `false` enables live orders.
- Strategy constants (fall %, target, stoploss, VIX and Nifty limits) are hardcoded in `src/config.js`, not in `.env`.

## Architecture

Single process started by `src/main.js`. It restores the saved session, starts the Express server (`api.js`) and registers the cron jobs (`scheduler.js`).

- **`scheduler.js`**: node-cron jobs in `Asia/Kolkata`, Mon-Fri.
  - 09:30 runs `trader.executeSell()` and starts a 5-minute `setInterval` position check.
  - 09:45 stops the interval and runs `executeDeadlineSell()`, which force-sells whatever is left.
  - 14:58 runs `executeBuy()`.
- **`trader.js`**: the orchestration logic. Buy flow:
  1. Check the session and ping it.
  2. Check the holiday list.
  3. Check the Nifty fall and VIX gates.
  4. Check slot capacity.
  5. `screener.screenStocks()`.
  6. Place limit orders at LTP+0.3%, sized as `ALLOCATED_CAPITAL / MAX_POSITIONS` per slot.

  Sell flow compares LTP against the target or stoploss from `buy_price`. The stoploss limit price is LTP×0.995.
- **`screener.js`**: holds the hardcoded Nifty 100 universe and sector map.
  - The symbols are **ICICI "ISec" short codes** (e.g. `HDFBAN`, `RELIND`), not NSE tickers. Breeze requires them. Look them up in `SecurityMaster/NSEScripMaster.txt` (ShortName column) when adding or replacing stocks.
  - Each stock is fetched sequentially with a 300ms delay to avoid rate limits (one quote plus one historical call per stock, 100 stocks).
  - The filter requires a fall between 0.5% and 2.5%, LTP above both EMA20 and EMA50, and volume under 1.5x the 20-day average.
  - Stocks are ranked by a score (proximity to EMA20 plus a -1.5% sweet spot), then `pickDiverse` prefers one stock per sector.
- **`breeze.js`**: the only module that talks to Breeze. It wraps the `breezeconnect` SDK and holds session state, `_withRetry` (503 retries), `getQuote`, `getHistoricalData` and `placeOrder`. `DRY_RUN` is enforced inside `placeOrder`, which returns a fake `DRY-<ts>` order id. All orders go through there.
- **`api.js`**: Express server. ICICI redirects to `/` with `?apisession=<token>` after login, and this activates the session. It also serves `/dashboard` (`templates/dashboard.html`), `/api/dashboard-data`, `/session/status`, `/health` and `/api/login-url`.
- **State is JSON files in `data/`, with no database.**
  - `bot_positions.json`: open and closed positions, with a `sold` flag.
  - `pnl.json`: closed trades.
  - `session.json`: the Breeze session token.
  - `holidays.json`: **must be updated manually each year**. The buy phase skips holidays only from this list, plus a Nifty LTP == 0 check.

## Things that are easy to get wrong

- **Daily manual login.** The Breeze session token is issued per day and is invalid after midnight IST. A human must log in through the ICICI login URL each trading day (`http://localhost:PORT`). `isSessionValid()` checks that the token was saved today (IST) and that the last `pingSession()` did not fail. If the session is invalid, both buy and sell abort silently apart from a log line.
- **The `breezeconnect` SDK is monkey-patched.** `_patchMakeRequest` in `breeze.js` replaces `makeRequest`. The SDK references an out-of-scope `url` in its catch block, which hides real HTTP errors, and the patch re-implements the auth headers (`X-Checksum` is a sha256 of timestamp + body + secret). Keep the two in sync if you touch auth or upgrade the SDK.
- **Market orders are not allowed** by Breeze (SEBI), so all orders are `limit`.
- **Sell phase selects every unsold position with `buy_date < today`** (`getPositionsToSell` in `trader.js`). This covers Friday buys on Monday, buys before a holiday, and positions left over from a failed sell. The sell tries product `btst` first (works only on the next trading day, T+1) and falls back to `cash` for shares already credited to demat.
- **`SELL_TIME`, `SELL_DEADLINE` and `BUY_TIME` in `config.js` are not read.** Cron expressions in `scheduler.js` are hardcoded. Change both places, plus the labels in `api.js` `getNextAction()` (which still says 2:50 PM) and the log text in `main.js` and `trader.js`.
- P&L is recorded from LTP at order placement, not the actual fill price. Orders are not checked for execution.
- Stoploss and target are only evaluated at 09:30, then every 5 minutes until 09:45. There are no resting broker-side stoploss orders.

## Repo hygiene

`.env`, `data/session.json`, `data/bot_positions.json`, `data/pnl.json` and `logs/*` are **tracked in git**, even though `.gitignore` lists `.env` and `logs/*` (ignored only for new files). `.env.example` also appears to hold real-looking key values. Don't commit credentials or session tokens, and consider `git rm --cached` plus rotating the keys.
