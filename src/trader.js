const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const breeze = require('./breeze');
const screener = require('./screener');
const config = require('./config');
const logger = require('./logger');

const BOT_POS_FILE = path.join(__dirname, '../data/bot_positions.json');
const PNL_FILE = path.join(__dirname, '../data/pnl.json');

// ─────────────────────── IST helpers ───────────────────────

function getISTDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function getISTTimeStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function getYesterdayISTStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return getISTDateStr(d);
}

// ─────────────────────── File helpers ───────────────────────

function readBotPositions() {
  try {
    if (!fs.existsSync(BOT_POS_FILE)) return [];
    const raw = fs.readFileSync(BOT_POS_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    logger.error(`Failed to read bot_positions.json: ${e.message}`);
    return [];
  }
}

function writeBotPositions(positions) {
  fs.writeFileSync(BOT_POS_FILE, JSON.stringify(positions, null, 2));
}

function readPnL() {
  try {
    if (!fs.existsSync(PNL_FILE)) return [];
    const raw = fs.readFileSync(PNL_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    logger.error(`Failed to read pnl.json: ${e.message}`);
    return [];
  }
}

function appendToPnL(trade) {
  const trades = readPnL();
  trades.push(trade);
  fs.writeFileSync(PNL_FILE, JSON.stringify(trades, null, 2));
}

// ─────────────────────── Sell helpers ───────────────────────

// Unsold positions bought on any earlier day. Using "buy_date < today" instead of
// "buy_date === yesterday" picks up Friday buys on Monday, buys made before a
// holiday, and positions whose sell failed on a previous morning.
function getPositionsToSell() {
  const today = getISTDateStr();
  return readBotPositions().filter(p => !p.sold && p.buy_date < today);
}

async function sellPosition(position, ltp, exitReason) {
  const { stock, shares, buy_price, id, order_id: buyOrderId } = position;
  // Breeze API prohibits market orders (SEBI circular) — always use limit.
  // Price below LTP so the order crosses the spread: a sell limit under the bid
  // still fills at the bid, and fills are never verified, so a resting order
  // would leave shares the bot believes it sold. Stoploss uses a wider buffer.
  const orderType = 'limit';
  const bufferPct = exitReason === 'stoploss'
    ? config.STOPLOSS_LIMIT_BUFFER_PCT
    : config.SELL_LIMIT_BUFFER_PCT;
  const price = Math.floor((ltp * (1 - bufferPct / 100)) / 0.05) * 0.05;

  logger.info(
    `SELL ${stock} x${shares} @ ${price.toFixed(2)} ` +
    `[${exitReason.toUpperCase()}] [LIMIT]`
  );

  // Shares bought yesterday are not yet in demat (T+1), so a 'cash' sell is
  // rejected with "Insufficient stocks allocated in demat". Sell as BTST first;
  // fall back to 'cash' in case the shares have already been credited (e.g. a
  // position held over a weekend/holiday or left over from a failed sell).
  let orderId = null;
  try {
    const result = await breeze.placeOrder({ stockCode: stock, action: 'sell', quantity: shares, price, orderType, product: 'btst' });
    orderId = result.orderId;
  } catch (e) {
    logger.warn(`  BTST sell failed for ${stock}: ${e instanceof Error ? e.message : String(e)} — retrying as CASH`);
    try {
      const result = await breeze.placeOrder({ stockCode: stock, action: 'sell', quantity: shares, price, orderType, product: 'cash' });
      orderId = result.orderId;
    } catch (e2) {
      logger.error(`  Failed to place sell order for ${stock}: ${e2 instanceof Error ? e2.message : String(e2)}`);
      return false;
    }
  }

  // Mark sold in bot_positions.json
  const positions = readBotPositions();
  const idx = positions.findIndex(p => p.id === id);
  if (idx >= 0) positions[idx].sold = true;
  writeBotPositions(positions);

  // Record in pnl.json
  const pnlAmount = parseFloat(((ltp - buy_price) * shares).toFixed(2));
  const pnlPct = parseFloat((((ltp - buy_price) / buy_price) * 100).toFixed(2));

  appendToPnL({
    id,
    stock,
    buy_date: position.buy_date,
    buy_time: position.buy_time,
    buy_price: position.buy_price,
    shares,
    buy_order_id: buyOrderId,
    sell_date: getISTDateStr(),
    sell_time: getISTTimeStr(),
    sell_price: ltp,
    sell_order_id: orderId,
    pnl_amount: pnlAmount,
    pnl_pct: pnlPct,
    exit_reason: exitReason,
  });

  logger.info(`  ${stock}: P&L ₹${pnlAmount} (${pnlPct}%) — ${exitReason}`);
  return true;
}

async function checkAndSellPosition(position) {
  const { stock, buy_price } = position;
  let ltp;

  try {
    const quote = await breeze.getQuote(stock);
    ltp = parseFloat(quote.ltp);
  } catch (e) {
    logger.error(`  Cannot get LTP for ${stock}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  const targetPrice = buy_price * (1 + config.TARGET_PCT / 100);
  const slPrice = buy_price * (1 - config.STOPLOSS_PCT / 100);

  // Track the best price seen this morning for the trailing profit lock.
  const peak = Math.max(position.peak_price || 0, ltp);
  if (peak !== position.peak_price) {
    const positions = readBotPositions();
    const idx = positions.findIndex(p => p.id === position.id);
    if (idx >= 0) {
      positions[idx].peak_price = peak;
      writeBotPositions(positions);
    }
  }
  const trailArmed = peak >= buy_price * (1 + config.TRAIL_TRIGGER_PCT / 100);
  const trailPrice = peak * (1 - config.TRAIL_GIVEBACK_PCT / 100);

  logger.info(
    `  Check ${stock}: ltp=${ltp.toFixed(2)} buy=${buy_price} peak=${peak.toFixed(2)} ` +
    `target=${targetPrice.toFixed(2)} sl=${slPrice.toFixed(2)}` +
    (trailArmed ? ` trail=${trailPrice.toFixed(2)}` : '')
  );

  if (ltp >= targetPrice) return sellPosition(position, ltp, 'target hit');
  if (ltp <= slPrice) return sellPosition(position, ltp, 'stoploss');
  if (trailArmed && ltp <= trailPrice) return sellPosition(position, ltp, 'trailing stop');

  logger.info(`  ${stock} in range — holding`);
  return false;
}

// ─────────────────────── SELL PHASE ───────────────────────

async function executeSell() {
  logger.info('══════════ SELL PHASE 9:16 AM ══════════');

  if (!(await breeze.pingSession())) {
    logger.error('ABORT SELL: Session invalid or API unreachable — re-submit token at http://localhost:3000');
    return;
  }

  const toManage = getPositionsToSell();

  if (toManage.length === 0) {
    logger.info('No open bot positions from previous days — nothing to sell');
    return;
  }

  const buyDates = [...new Set(toManage.map(p => p.buy_date))].join(', ');
  logger.info(`Managing ${toManage.length} bot position(s) bought on ${buyDates}`);
  for (const pos of toManage) {
    await checkAndSellPosition(pos);
    await new Promise(r => setTimeout(r, 400));
  }
}

async function checkRemainingPositions() {
  if (!breeze.isSessionValid()) return;
  const remaining = getPositionsToSell();

  if (remaining.length === 0) return;

  logger.info(`[1-min check] ${remaining.length} position(s) still open`);
  for (const pos of remaining) {
    await checkAndSellPosition(pos);
    await new Promise(r => setTimeout(r, 400));
  }
}

async function executeDeadlineSell() {
  logger.info('══════════ DEADLINE SELL 10:00 AM ══════════');

  const remaining = getPositionsToSell();

  if (remaining.length === 0) {
    logger.info('No positions remaining at deadline — all clear');
    return;
  }

  logger.warn(`DEADLINE: Force-selling ${remaining.length} position(s)`);
  for (const pos of remaining) {
    let ltp;
    try {
      const quote = await breeze.getQuote(pos.stock);
      ltp = parseFloat(quote.ltp);
    } catch (e) {
      logger.error(`Cannot get LTP for ${pos.stock} at deadline: ${e instanceof Error ? e.message : String(e)}. Using buy price.`);
      ltp = pos.buy_price;
    }
    await sellPosition(pos, ltp, 'deadline exit');
    await new Promise(r => setTimeout(r, 400));
  }

  logger.info('══════════ DEADLINE SELL COMPLETE ══════════');
}

// ─────────────────────── BUY PHASE ───────────────────────

function isHoliday() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/holidays.json'), 'utf8'));
    const today = getISTDateStr();
    return (data.holidays || []).includes(today);
  } catch {
    logger.warn('Could not read holidays.json — assuming not a holiday');
    return false;
  }
}

async function executeBuy() {
  logger.info('══════════ BUY PHASE 2:55 PM ══════════');

  // ── Prerequisite checks ──────────────────────────────
  if (!breeze.isSessionValid()) {
    logger.warn('SKIP BUY: Session token expired or missing');
    return;
  }

  if (!(await breeze.pingSession())) {
    logger.error('SKIP BUY: Session rejected by ICICI (ping failed) — re-submit token at http://localhost:3000');
    return;
  }

  if (isHoliday()) {
    logger.info('SKIP BUY: Today is a market holiday');
    return;
  }

  const { changePct: niftyChg, ltp: niftyLtp, available: niftyOk } = await screener.getNiftyConditions();
  if (niftyOk && niftyLtp === 0) {
    logger.info('SKIP BUY: Nifty LTP is zero — market appears closed or holiday');
    return;
  }
  if (niftyOk && niftyChg < -config.MAX_NIFTY_FALL_PCT) {
    logger.warn(`SKIP BUY: Nifty fell ${niftyChg.toFixed(2)}% — limit is -${config.MAX_NIFTY_FALL_PCT}%`);
    return;
  }

  const { vix, available: vixOk } = await screener.getVix();
  if (vixOk && vix > config.MAX_VIX) {
    logger.warn(`SKIP BUY: VIX=${vix} exceeds max ${config.MAX_VIX}`);
    return;
  }

  logger.info(
    `Market OK: Nifty=${niftyOk ? niftyChg.toFixed(2) + '%' : 'N/A'} ` +
    `VIX=${vixOk ? vix : 'N/A'}`
  );

  // ── Capacity check ───────────────────────────────────
  const currentPositions = readBotPositions();
  const openSymbols = currentPositions.filter(p => !p.sold).map(p => p.stock);

  if (openSymbols.length >= config.MAX_POSITIONS) {
    logger.warn(`SKIP BUY: Already at max open positions (${openSymbols.length}/${config.MAX_POSITIONS})`);
    return;
  }

  const slotsLeft = config.MAX_POSITIONS - openSymbols.length;

  // ── Screen stocks ────────────────────────────────────
  const { screened, passed, selected } = await screener.screenStocks(openSymbols);

  if (selected.length === 0) {
    logger.info(`No stocks passed filters today (${screened} screened, ${passed} passed, 0 selected)`);
    return;
  }

  const toBuy = selected.slice(0, slotsLeft);
  const slotBudget = Math.floor(config.ALLOCATED_CAPITAL / config.MAX_POSITIONS);

  // ── Place orders ─────────────────────────────────────
  for (const stock of toBuy) {
    const shares = Math.floor(slotBudget / stock.ltp);

    if (shares === 0) {
      logger.warn(`SKIP ${stock.symbol}: 0 shares — too expensive (ltp=${stock.ltp}, budget=₹${slotBudget})`);
      continue;
    }

    // Limit price = LTP + 0.3%, rounded to nearest 0.05
    const buyPrice = Math.ceil((stock.ltp * 1.003) / 0.05) * 0.05;
    const totalCost = shares * buyPrice;

    logger.info(
      `BUY ${stock.symbol}: ` +
      `shares=${shares} price=₹${buyPrice.toFixed(2)} total=₹${totalCost.toFixed(0)} ` +
      `score=${stock.score} sector=${stock.sector}`
    );

    let orderId = null;
    try {
      const result = await breeze.placeOrder({
        stockCode: stock.symbol,
        action: 'buy',
        quantity: shares,
        price: buyPrice,
        orderType: 'limit',
      });
      orderId = result.orderId;
    } catch (e) {
      logger.error(`  Buy order failed for ${stock.symbol}: ${e instanceof Error ? e.message : String(e)} — skipping`);
      continue;
    }

    const position = {
      id: uuidv4(),
      stock: stock.symbol,
      buy_date: getISTDateStr(),
      buy_time: getISTTimeStr(),
      buy_price: buyPrice,
      shares,
      order_id: orderId,
      sold: false,
    };

    const allPositions = readBotPositions();
    allPositions.push(position);
    writeBotPositions(allPositions);

    logger.info(`  Position logged — id=${position.id} orderId=${orderId}`);
    await new Promise(r => setTimeout(r, 300));
  }

  logger.info('══════════ BUY PHASE COMPLETE ══════════');
}

module.exports = {
  executeSell,
  checkRemainingPositions,
  executeDeadlineSell,
  executeBuy,
  readBotPositions,
  readPnL,
  getISTDateStr,
  getISTTimeStr,
  getYesterdayISTStr,
};
