const breeze = require('./breeze');
const config = require('./config');
const logger = require('./logger');

// ─────────────────────── Universe ───────────────────────

const NIFTY50_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
  'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
  'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'TITAN',
  'SUNPHARMA', 'WIPRO', 'ULTRACEMCO', 'BAJFINANCE', 'NESTLEIND',
  'POWERGRID', 'NTPC', 'ONGC', 'TECHM', 'HCLTECH',
  'TATAMOTORS', 'JSWSTEEL', 'TATASTEEL', 'INDUSINDBK', 'ADANIENT',
  'ADANIPORTS', 'BAJAJFINSV', 'BPCL', 'BRITANNIA', 'CIPLA',
  'COALINDIA', 'DIVISLAB', 'DRREDDY', 'EICHERMOT', 'GRASIM',
  'HEROMOTOCO', 'HINDALCO', 'M&M', 'HDFCLIFE', 'SBILIFE',
  'SHREECEM', 'TATACONSUM', 'UPL', 'VEDL', 'BAJAJ-AUTO',
];

const SECTORS = {
  RELIANCE: 'energy',   TCS: 'it',           HDFCBANK: 'banking',
  INFY: 'it',           ICICIBANK: 'banking', HINDUNILVR: 'fmcg',
  ITC: 'fmcg',          SBIN: 'banking',      BHARTIARTL: 'telecom',
  KOTAKBANK: 'banking', LT: 'infra',          AXISBANK: 'banking',
  ASIANPAINT: 'consumer', MARUTI: 'auto',     TITAN: 'consumer',
  SUNPHARMA: 'pharma',  WIPRO: 'it',          ULTRACEMCO: 'cement',
  BAJFINANCE: 'finance', NESTLEIND: 'fmcg',   POWERGRID: 'energy',
  NTPC: 'energy',       ONGC: 'energy',       TECHM: 'it',
  HCLTECH: 'it',        TATAMOTORS: 'auto',   JSWSTEEL: 'metals',
  TATASTEEL: 'metals',  INDUSINDBK: 'banking', ADANIENT: 'energy',
  ADANIPORTS: 'infra',  BAJAJFINSV: 'finance', BPCL: 'energy',
  BRITANNIA: 'fmcg',    CIPLA: 'pharma',      COALINDIA: 'energy',
  DIVISLAB: 'pharma',   DRREDDY: 'pharma',    EICHERMOT: 'auto',
  GRASIM: 'cement',     HEROMOTOCO: 'auto',   HINDALCO: 'metals',
  'M&M': 'auto',        HDFCLIFE: 'finance',  SBILIFE: 'finance',
  SHREECEM: 'cement',   TATACONSUM: 'fmcg',   UPL: 'chemicals',
  VEDL: 'metals',       'BAJAJ-AUTO': 'auto',
};

// ─────────────────────── Math ───────────────────────

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

// ─────────────────────── Market-wide checks ───────────────────────

async function getNiftyConditions() {
  try {
    // Nifty 50 index via Breeze. If this fails, we proceed with a warning.
    const quote = await breeze.getQuote('NIFTY');
    const changePct = parseFloat(quote['ltp-percent-change'] || 0);
    logger.info(`Nifty 50: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`);
    return { changePct, available: true };
  } catch (e) {
    logger.warn(`Could not fetch Nifty data (${e.message}). Market condition check skipped.`);
    return { changePct: 0, available: false };
  }
}

async function getVix() {
  try {
    const quote = await breeze.getQuote('INDIAVIX');
    const vix = parseFloat(quote.ltp || 0);
    logger.info(`India VIX: ${vix}`);
    return { vix, available: true };
  } catch (e) {
    logger.warn(`Could not fetch VIX data (${e.message}). VIX check skipped.`);
    return { vix: 0, available: false };
  }
}

// ─────────────────────── Per-stock analysis ───────────────────────

async function analyzeStock(symbol) {
  try {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 100); // ~100 calendar days → ~70 trading days

    const [quote, history] = await Promise.all([
      breeze.getQuote(symbol),
      breeze.getHistoricalData(symbol, fromDate, toDate),
    ]);

    const ltp = parseFloat(quote.ltp);
    const prevClose = parseFloat(quote['previous-close']);
    const todayVolume = parseFloat(quote['total-quantity-traded'] || 0);

    if (!ltp || !prevClose) {
      return { symbol, passed: false, reason: 'invalid_quote_data' };
    }

    const changePct = ((ltp - prevClose) / prevClose) * 100;

    if (!history || history.length < 55) {
      return { symbol, passed: false, reason: `insufficient_history: ${history ? history.length : 0} days` };
    }

    const closes = history.map(d => parseFloat(d.close)).filter(Boolean);
    const last20Volumes = history.slice(-20).map(d => parseFloat(d.volume)).filter(v => v > 0);

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const avgVolume20 = last20Volumes.length > 0
      ? last20Volumes.reduce((a, b) => a + b, 0) / last20Volumes.length
      : 0;
    const volumeMultiplier = avgVolume20 > 0 ? todayVolume / avgVolume20 : 99;

    return {
      symbol,
      ltp,
      prevClose,
      changePct,
      todayVolume,
      avgVolume20,
      volumeMultiplier,
      ema20,
      ema50,
      sector: SECTORS[symbol] || 'other',
    };
  } catch (e) {
    logger.error(`  Error fetching ${symbol}: ${e.message}`);
    return { symbol, passed: false, reason: `api_error: ${e.message}` };
  }
}

// ─────────────────────── Filter ───────────────────────

function filterStock(data, openSymbols) {
  const { symbol, changePct, ltp, ema20, ema50, volumeMultiplier } = data;

  if (openSymbols.includes(symbol)) {
    return { passed: false, reason: 'already_in_open_positions' };
  }
  if (changePct > -config.MIN_FALL_PCT) {
    return { passed: false, reason: `fall_too_small: ${changePct.toFixed(2)}% (need ≤ -${config.MIN_FALL_PCT}%)` };
  }
  if (changePct < -config.MAX_FALL_PCT) {
    return { passed: false, reason: `fall_too_large: ${changePct.toFixed(2)}% (max -${config.MAX_FALL_PCT}%)` };
  }
  if (ema20 === null || ltp < ema20) {
    return {
      passed: false,
      reason: `below_20EMA: ltp=${ltp.toFixed(2)} ema20=${ema20 ? ema20.toFixed(2) : 'N/A'}`,
    };
  }
  if (ema50 === null || ltp < ema50) {
    return {
      passed: false,
      reason: `below_50EMA: ltp=${ltp.toFixed(2)} ema50=${ema50 ? ema50.toFixed(2) : 'N/A'}`,
    };
  }
  if (volumeMultiplier >= config.MAX_VOLUME_MULTIPLIER) {
    return {
      passed: false,
      reason: `volume_too_high: ${volumeMultiplier.toFixed(2)}x avg (max ${config.MAX_VOLUME_MULTIPLIER}x)`,
    };
  }

  return { passed: true };
}

// ─────────────────────── Scoring ───────────────────────

function scoreStock(data) {
  const { changePct, ltp, ema20 } = data;

  // Proximity to 20 EMA: closer = higher (max 5 pts)
  const emaPctDist = Math.abs((ltp - ema20) / ema20) * 100;
  const emaScore = Math.max(0, 5 - emaPctDist);

  // Fall sweetspot: ideal -1.5%, penalise distance (max 5 pts)
  const fallScore = Math.max(0, 5 - Math.abs(changePct + 1.5) * 2);

  return parseFloat((emaScore + fallScore).toFixed(2));
}

// ─────────────────────── Sector diversity picker ───────────────────────

function pickDiverse(scored, maxPositions) {
  const sectorsSeen = new Set();
  const picked = [];
  const remainder = [];

  for (const stock of scored) {
    if (picked.length >= maxPositions) break;
    if (!sectorsSeen.has(stock.sector)) {
      sectorsSeen.add(stock.sector);
      picked.push(stock);
    } else {
      remainder.push(stock);
    }
  }

  for (const stock of remainder) {
    if (picked.length >= maxPositions) break;
    picked.push(stock);
  }

  return picked;
}

// ─────────────────────── Main screener ───────────────────────

async function screenStocks(openSymbols = []) {
  logger.info(`Screening ${NIFTY50_SYMBOLS.length} Nifty 50 stocks...`);
  const all = [];

  // Fetch in batches of 5 to respect rate limits
  const BATCH = 5;
  for (let i = 0; i < NIFTY50_SYMBOLS.length; i += BATCH) {
    const batch = NIFTY50_SYMBOLS.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(analyzeStock));
    all.push(...results);
    if (i + BATCH < NIFTY50_SYMBOLS.length) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  const passed = [];
  for (const data of all) {
    if (data.passed === false) {
      logger.info(`  SKIP  ${data.symbol.padEnd(12)} — ${data.reason}`);
      continue;
    }
    const { passed: ok, reason } = filterStock(data, openSymbols);
    if (!ok) {
      logger.info(`  FAIL  ${data.symbol.padEnd(12)} — ${reason}`);
    } else {
      const score = scoreStock(data);
      logger.info(
        `  PASS  ${data.symbol.padEnd(12)} ` +
        `chg=${data.changePct.toFixed(2).padStart(6)}%  ` +
        `ltp=${data.ltp.toFixed(2)}  ` +
        `ema20=${data.ema20.toFixed(2)}  ` +
        `vol=${data.volumeMultiplier.toFixed(2)}x  score=${score}`
      );
      passed.push({ ...data, score });
    }
  }

  passed.sort((a, b) => b.score - a.score);
  const selected = pickDiverse(passed, config.MAX_POSITIONS);

  logger.info(`Screening done: ${all.length} screened | ${passed.length} passed | ${selected.length} selected`);
  return { screened: all.length, passed: passed.length, selected };
}

module.exports = {
  NIFTY50_SYMBOLS,
  SECTORS,
  screenStocks,
  getNiftyConditions,
  getVix,
  calculateEMA,
};
