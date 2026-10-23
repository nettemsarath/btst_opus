const breeze = require('./breeze');
const config = require('./config');
const logger = require('./logger');

// ─────────────────────── Universe ───────────────────────

// ICICIDirect ISec codes (ShortName from NSEScripMaster.txt) — required by Breeze API.
// NSE symbol → ISec code mapping verified from SecurityMaster/NSEScripMaster.txt.
// Nifty50 composition current as of Sep 2026 (9 stale stocks replaced).
const NIFTY50_SYMBOLS = [
  'RELIND', 'TCS',    'HDFBAN', 'INFTEC', 'ICIBAN',
  'HINLEV', 'ITC',    'STABAN', 'BHAAIR', 'KOTMAH',
  'LARTOU', 'AXIBAN', 'ASIPAI', 'MARUTI', 'TITIND',
  'SUNPHA', 'WIPRO',  'ULTCEM', 'BAJFI',  'NESIND',
  'POWGRI', 'NTPC',   'ONGC',   'TECMAH', 'HCLTEC',
  'TATMOT', 'JSWSTE', 'TATSTE', 'JIOFIN', 'ADAENT',
  'ADAPOR', 'BAFINS', 'BHAELE', 'APOHOS', 'CIPLA',
  'COALIN', 'TRENT',  'DRREDD', 'EICMOT', 'GRASIM',
  'MAXHEA', 'HINDAL', 'MAHMAH', 'HDFSTA', 'SBILIF',
  'SHRTRA', 'TATGLO', 'ZOMLIM', 'INTAVI', 'BAAUTO',
];

// Nifty Next 50 — ISec codes verified from SecurityMaster/NSEScripMaster.txt Sep 2026.
const NIFTY_NEXT50_SYMBOLS = [
  'ADAGRE', 'AMBCE',  'AURPHA', 'BAJHOL', 'BANBAR',
  'BERPAI', 'BOSLIM', 'BRIIND', 'CHOINV', 'COLPAL',
  'CUMIND', 'DABIND', 'DIVLAB', 'DLFLIM', 'GODCON',
  'GODPRO', 'HAVIND', 'HDFAMC', 'HINZIN', 'ICILOM',
  'ICIPRU', 'INDOIL', 'INDRAI', 'INDHOT', 'INFEDG',
  'JSWENE', 'LUPIN',  'MARLIM', 'MOTSUM', 'MUTFIN',
  'PAGIND', 'PETLNG', 'PIDIND', 'PIIND',  'RURELE',
  'SAIL',   'SIEMEN', 'SRF',   'TATCOM', 'TATELX',
  'TATPOW', 'TORPHA', 'TVSMOT', 'UNIBR',  'VEDLIM',
  'VOLTAS', 'ZEEENT',
];

const NIFTY100_SYMBOLS = [...NIFTY50_SYMBOLS, ...NIFTY_NEXT50_SYMBOLS];

const SECTORS = {
  // Nifty 50
  RELIND: 'energy',   TCS: 'it',        HDFBAN: 'banking',
  INFTEC: 'it',       ICIBAN: 'banking', HINLEV: 'fmcg',
  ITC: 'fmcg',        STABAN: 'banking', BHAAIR: 'telecom',
  KOTMAH: 'banking',  LARTOU: 'infra',   AXIBAN: 'banking',
  ASIPAI: 'consumer', MARUTI: 'auto',    TITIND: 'consumer',
  SUNPHA: 'pharma',   WIPRO: 'it',       ULTCEM: 'cement',
  BAJFI: 'finance',   NESIND: 'fmcg',    POWGRI: 'energy',
  NTPC: 'energy',     ONGC: 'energy',    TECMAH: 'it',
  HCLTEC: 'it',       TATMOT: 'auto',    JSWSTE: 'metals',
  TATSTE: 'metals',   JIOFIN: 'finance', ADAENT: 'energy',
  ADAPOR: 'infra',    BAFINS: 'finance', BHAELE: 'defense',
  APOHOS: 'pharma',   CIPLA: 'pharma',   COALIN: 'energy',
  TRENT: 'consumer',  DRREDD: 'pharma',  EICMOT: 'auto',
  GRASIM: 'cement',   MAXHEA: 'pharma',  HINDAL: 'metals',
  MAHMAH: 'auto',     HDFSTA: 'finance', SBILIF: 'finance',
  SHRTRA: 'finance',  TATGLO: 'fmcg',    ZOMLIM: 'consumer',
  INTAVI: 'aviation', BAAUTO: 'auto',
  // Nifty Next 50
  ADAGRE: 'energy',   AMBCE: 'cement',   AURPHA: 'pharma',
  BAJHOL: 'finance',  BANBAR: 'banking', BERPAI: 'consumer',
  BOSLIM: 'auto',     BRIIND: 'fmcg',    CHOINV: 'finance',
  COLPAL: 'fmcg',     CUMIND: 'infra',   DABIND: 'fmcg',
  DIVLAB: 'pharma',   DLFLIM: 'realty',  GODCON: 'fmcg',
  GODPRO: 'realty',   HAVIND: 'consumer',HDFAMC: 'finance',
  HINZIN: 'metals',   ICILOM: 'finance', ICIPRU: 'finance',
  INDOIL: 'energy',   INDRAI: 'consumer',INDHOT: 'consumer',
  INFEDG: 'it',       JSWENE: 'energy',  LUPIN: 'pharma',
  MARLIM: 'fmcg',     MOTSUM: 'auto',    MUTFIN: 'finance',
  PAGIND: 'consumer', PETLNG: 'energy',  PIDIND: 'consumer',
  PIIND: 'pharma',    RURELE: 'finance', SAIL: 'metals',
  SIEMEN: 'infra',    SRF: 'infra',      TATCOM: 'telecom',
  TATELX: 'it',       TATPOW: 'energy',  TORPHA: 'pharma',
  TVSMOT: 'auto',     UNIBR: 'fmcg',     VEDLIM: 'metals',
  VOLTAS: 'consumer', ZEEENT: 'media',
};

// ─────────────────────── Helpers ───────────────────────

function _errMsg(e) {
  if (e == null) return 'unknown error';
  if (e instanceof Error) return e.message || e.toString();
  if (typeof e === 'string') return e.split('\n')[0];
  if (typeof e === 'object') return e.message || e.error || e.Error || JSON.stringify(e);
  return String(e);
}

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
    const ltp = parseFloat(quote.ltp || 0);
    const prevClose = parseFloat(quote['previous_close'] || 0);
    const changePct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
    logger.info(`Nifty 50: ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`);
    return { changePct, ltp, available: true };
  } catch (e) {
    const msg = _errMsg(e);
    logger.warn(`Could not fetch Nifty data (${msg}). Market condition check skipped.`);
    return { changePct: 0, available: false };
  }
}

async function getVix() {
  try {
    const quote = await breeze.getQuote('INDVIX');
    const vix = parseFloat(quote.ltp || 0);
    logger.info(`India VIX: ${vix}`);
    return { vix, available: true };
  } catch (e) {
    const msg = _errMsg(e);
    logger.warn(`Could not fetch VIX data (${msg}). VIX check skipped.`);
    return { vix: 0, available: false };
  }
}

// ─────────────────────── Per-stock analysis ───────────────────────

function _istDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

// Fold today's LTP into an EMA computed on completed days.
function _emaWithToday(prevEma, ltp, period) {
  const k = 2 / (period + 1);
  return ltp * k + prevEma * (1 - k);
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// Indicators that only depend on completed daily candles. They do not change during
// the day, so they are prefetched before the buy phase and cached until midnight.
let _historyCache = { date: null, bySymbol: {} };

async function fetchHistoryIndicators(symbol) {
  const today = _istDateStr();
  if (_historyCache.date === today && _historyCache.bySymbol[symbol]) {
    return _historyCache.bySymbol[symbol];
  }

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - config.HISTORY_CALENDAR_DAYS);

  const history = await breeze.getHistoricalData(symbol, fromDate, toDate);

  // Drop today's partial candle (if Breeze returns one) so EMAs and the volume
  // average are built from completed sessions only.
  const candles = (history || [])
    .filter(d => {
      const day = String(d.datetime).slice(0, 10);
      return !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today;
    })
    .map(d => ({
      high: parseFloat(d.high),
      low: parseFloat(d.low),
      close: parseFloat(d.close),
      volume: parseFloat(d.volume),
    }))
    .filter(c => c.close > 0 && c.high > 0 && c.low > 0);

  const closes = candles.map(c => c.close);
  const last20Volumes = candles.slice(-20).map(c => c.volume).filter(v => v > 0);
  const atr14 = calculateATR(candles, 14);
  const lastClose = closes[closes.length - 1];

  const indicators = {
    days: candles.length,
    prevEma20: calculateEMA(closes, 20),
    prevEma50: calculateEMA(closes, 50),
    avgVolume20: last20Volumes.length > 0
      ? last20Volumes.reduce((a, b) => a + b, 0) / last20Volumes.length
      : 0,
    atrPct: atr14 && lastClose ? (atr14 / lastClose) * 100 : null,
  };

  if (_historyCache.date !== today) _historyCache = { date: today, bySymbol: {} };
  _historyCache.bySymbol[symbol] = indicators;
  return indicators;
}

async function prefetchHistory() {
  logger.info(`Prefetching daily history for ${NIFTY100_SYMBOLS.length} stocks...`);
  let ok = 0;
  for (const symbol of NIFTY100_SYMBOLS) {
    try {
      await fetchHistoryIndicators(symbol);
      ok++;
    } catch (e) {
      logger.warn(`  History prefetch failed for ${symbol}: ${_errMsg(e)} — will retry at buy time`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  logger.info(`History prefetch done: ${ok}/${NIFTY100_SYMBOLS.length} cached`);
}

async function analyzeStock(symbol) {
  try {
    const [quote, hist] = await Promise.all([
      breeze.getQuote(symbol),
      fetchHistoryIndicators(symbol),
    ]);

    const ltp = parseFloat(quote.ltp);
    const prevClose = parseFloat(quote['previous_close']);
    const high = parseFloat(quote.high || 0);
    const low = parseFloat(quote.low || 0);
    const todayVolume = parseFloat(quote['total_quantity_traded'] || 0);

    if (!ltp || !prevClose) {
      return { symbol, passed: false, reason: 'invalid_quote_data' };
    }

    const changePct = ((ltp - prevClose) / prevClose) * 100;

    if (hist.days < 60 || hist.prevEma50 === null) {
      return { symbol, passed: false, reason: `insufficient_history: ${hist.days} days` };
    }

    const ema20 = _emaWithToday(hist.prevEma20, ltp, 20);
    const ema50 = _emaWithToday(hist.prevEma50, ltp, 50);
    const volumeMultiplier = hist.avgVolume20 > 0 ? todayVolume / hist.avgVolume20 : 99;
    const closeLocation = high > low ? (ltp - low) / (high - low) : 0.5;

    return {
      symbol,
      ltp,
      prevClose,
      changePct,
      todayVolume,
      avgVolume20: hist.avgVolume20,
      volumeMultiplier,
      ema20,
      ema50,
      atrPct: hist.atrPct,
      closeLocation,
      sector: SECTORS[symbol] || 'other',
    };
  } catch (e) {
    const msg = _errMsg(e);
    logger.error(`  Error fetching ${symbol}: ${msg}`);
    return { symbol, passed: false, reason: `api_error: ${msg}` };
  }
}

// ─────────────────────── Filter ───────────────────────

function filterStock(data, openSymbols) {
  const { symbol, changePct, ltp, ema20, ema50, volumeMultiplier, atrPct, closeLocation } = data;

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
  // Pullback in an uptrend means the short EMA is above the long one.
  if (ema20 < ema50) {
    return { passed: false, reason: `no_uptrend: ema20=${ema20.toFixed(2)} < ema50=${ema50.toFixed(2)}` };
  }
  if (volumeMultiplier >= config.MAX_VOLUME_MULTIPLIER) {
    return {
      passed: false,
      reason: `volume_too_high: ${volumeMultiplier.toFixed(2)}x avg (max ${config.MAX_VOLUME_MULTIPLIER}x)`,
    };
  }
  if (atrPct === null || atrPct > config.MAX_ATR_PCT) {
    return {
      passed: false,
      reason: `too_volatile: atr=${atrPct ? atrPct.toFixed(2) : 'N/A'}% (max ${config.MAX_ATR_PCT}%)`,
    };
  }
  if (closeLocation < config.MIN_CLOSE_LOCATION) {
    return {
      passed: false,
      reason: `near_day_low: close_loc=${closeLocation.toFixed(2)} (min ${config.MIN_CLOSE_LOCATION})`,
    };
  }

  return { passed: true };
}

// ─────────────────────── Scoring ───────────────────────

function scoreStock(data) {
  const { changePct, ltp, ema20, closeLocation } = data;

  // Proximity to 20 EMA: closer = higher (max 5 pts)
  const emaPctDist = Math.abs((ltp - ema20) / ema20) * 100;
  const emaScore = Math.max(0, 5 - emaPctDist);

  // Fall sweetspot: ideal -1.5%, penalise distance (max 5 pts)
  const fallScore = Math.max(0, 5 - Math.abs(changePct + 1.5) * 2);

  // Intraday recovery: buyers stepping in off the low into the close (max 3 pts)
  const recoveryScore = 3 * closeLocation;

  return parseFloat((emaScore + fallScore + recoveryScore).toFixed(2));
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
  logger.info(`Screening ${NIFTY100_SYMBOLS.length} Nifty 100 stocks...`);
  const all = [];

  // Process sequentially with a delay to avoid hitting Breeze API rate limits.
  // Batching 5 at a time fires 10 simultaneous requests (quote + history per stock),
  // which consistently triggers rate limiting.
  for (let i = 0; i < NIFTY100_SYMBOLS.length; i++) {
    const result = await analyzeStock(NIFTY100_SYMBOLS[i]);
    all.push(result);
    if (i + 1 < NIFTY100_SYMBOLS.length) {
      await new Promise(r => setTimeout(r, 300));
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
        `vol=${data.volumeMultiplier.toFixed(2)}x  atr=${data.atrPct.toFixed(2)}%  ` +
        `close_loc=${data.closeLocation.toFixed(2)}  score=${score}`
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
  NIFTY_NEXT50_SYMBOLS,
  NIFTY100_SYMBOLS,
  SECTORS,
  screenStocks,
  prefetchHistory,
  getNiftyConditions,
  getVix,
  calculateEMA,
};
