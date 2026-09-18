const { BreezeConnect } = require('breezeconnect');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const SESSION_FILE = path.join(__dirname, '../data/session.json');

let _breeze = null;
let _sessionReady = false;

// ─────────────────────── Instance ───────────────────────

function _getInstance() {
  if (!_breeze) {
    if (!config.BREEZE_API_KEY) throw new Error('BREEZE_API_KEY not set in .env');
    _breeze = new BreezeConnect({ appKey: config.BREEZE_API_KEY });
  }
  return _breeze;
}

// ─────────────────────── Session file ───────────────────────

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) {
    logger.error(`Failed to load session file: ${e.message}`);
    return null;
  }
}

function _saveSession(token) {
  const data = {
    session_token: token,
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  return data;
}

// ─────────────────────── Validity ───────────────────────

function isSessionValid() {
  const session = loadSession();
  if (!session || !session.session_token || !session.saved_at) return false;
  const ageMs = Date.now() - new Date(session.saved_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  return ageHours < config.SESSION_VALIDITY_HOURS;
}

function getSessionInfo() {
  const session = loadSession();
  if (!session || !session.saved_at) {
    return { valid: false, reason: 'No session found. Submit a token at http://localhost:3000' };
  }

  const savedAt = new Date(session.saved_at);
  const ageMs = Date.now() - savedAt.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const valid = ageHours < config.SESSION_VALIDITY_HOURS;
  const hoursRemaining = Math.max(0, config.SESSION_VALIDITY_HOURS - ageHours);
  const expiresAt = new Date(savedAt.getTime() + config.SESSION_VALIDITY_HOURS * 3600000);

  return {
    valid,
    saved_at: session.saved_at,
    expires_at: expiresAt.toISOString(),
    hours_remaining: parseFloat(hoursRemaining.toFixed(1)),
    age_hours: parseFloat(ageHours.toFixed(1)),
  };
}

// ─────────────────────── Auth ───────────────────────

async function generateSession(sessionToken) {
  if (!config.BREEZE_API_SECRET) throw new Error('BREEZE_API_SECRET not set in .env');
  const breeze = _getInstance();
  await breeze.generateSession(config.BREEZE_API_SECRET, sessionToken);
  _sessionReady = true;
  const saved = _saveSession(sessionToken);
  logger.info(`Breeze session initialized for token ending ...${sessionToken.slice(-4)}`);
  return saved;
}

async function initFromSavedSession() {
  const session = loadSession();
  if (!session || !isSessionValid()) {
    logger.warn('No valid session — visit http://localhost:3000 to submit a token');
    return false;
  }
  try {
    const breeze = _getInstance();
    await breeze.generateSession(config.BREEZE_API_SECRET, session.session_token);
    _sessionReady = true;
    logger.info('Breeze session restored from saved token');
    return true;
  } catch (e) {
    logger.error(`Failed to restore session: ${e.message}`);
    return false;
  }
}

function _requireSession() {
  if (!_breeze || !_sessionReady) throw new Error('Breeze session not initialised');
  return _breeze;
}

// ─────────────────────── Market data ───────────────────────

/**
 * Returns a quote object for a single NSE cash stock.
 * Response fields (Breeze naming): ltp, previous-close, ltp-percent-change,
 * total-quantity-traded, open, high, low
 */
async function getQuote(stockCode) {
  const breeze = _requireSession();
  const res = await breeze.getQuotes({
    stockCode,
    exchangeCode: 'NSE',
    productType: 'cash',
    expiryDate: '',
    strikePrice: '',
    right: 'others',
  });

  if (!res || !res.Success || !res.Success[0]) {
    throw new Error(`No quote returned for ${stockCode}: ${JSON.stringify(res && res.Error)}`);
  }
  return res.Success[0];
}

/**
 * Returns array of daily OHLCV candles sorted ascending by date.
 * Each item: { datetime, open, high, low, close, volume }
 */
async function getHistoricalData(stockCode, fromDate, toDate) {
  const breeze = _requireSession();
  const res = await breeze.getHistoricalDatav2({
    interval: '1day',
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    stockCode,
    exchangeCode: 'NSE',
    productType: 'cash',
    expiryDate: '',
    strikePrice: '',
    right: 'others',
  });

  if (!res || !res.Success) {
    throw new Error(`No historical data for ${stockCode}: ${JSON.stringify(res && res.Error)}`);
  }

  return [...res.Success].sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

// ─────────────────────── Orders ───────────────────────

/**
 * Places a buy or sell order.
 * In DRY_RUN mode logs the intent and returns a fake order ID.
 *
 * @param {object} params
 * @param {string} params.stockCode
 * @param {'buy'|'sell'} params.action
 * @param {number} params.quantity
 * @param {number} params.price  (ignored for market orders)
 * @param {'limit'|'market'} [params.orderType='limit']
 */
async function placeOrder({ stockCode, action, quantity, price, orderType = 'limit' }) {
  if (config.DRY_RUN) {
    const tag = `DRY-${Date.now()}`;
    logger.info(
      `[DRY RUN] ${action.toUpperCase()} ${stockCode} ` +
      `x${quantity} @ ${orderType === 'market' ? 'MARKET' : price} (${orderType.toUpperCase()})`
    );
    return { orderId: tag, dryRun: true };
  }

  const breeze = _requireSession();

  // validityDate: today's market close
  const vd = new Date();
  vd.setHours(15, 30, 0, 0);

  const res = await breeze.placeOrder({
    stockCode,
    exchangeCode: 'NSE',
    product: 'cash',
    action,
    orderType,
    stoploss: '',
    quantity: String(quantity),
    price: orderType === 'market' ? '0' : String(price),
    validity: 'day',
    validityDate: vd.toISOString(),
    disclosedQuantity: '0',
    expiryDate: '',
    right: 'others',
    strikePrice: '0',
    userRemark: 'btst-bot',
  });

  if (!res || !res.Success) {
    throw new Error(`Order failed for ${stockCode}: ${JSON.stringify(res && res.Error)}`);
  }

  const orderId = res.Success['order-id'] || res.Success.orderId || String(Date.now());
  logger.info(`Order placed: ${action.toUpperCase()} ${stockCode} x${quantity} orderId=${orderId}`);
  return { orderId };
}

module.exports = {
  loadSession,
  isSessionValid,
  getSessionInfo,
  generateSession,
  initFromSavedSession,
  getQuote,
  getHistoricalData,
  placeOrder,
};
