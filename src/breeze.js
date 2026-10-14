const { BreezeConnect } = require('breezeconnect');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const SESSION_FILE = path.join(__dirname, '../data/session.json');

let _breeze = null;
let _sessionReady = false;

// ─────────────────────── Instance ───────────────────────

// breezeconnect library bug: `url` is declared with `let` inside the `try` block of
// makeRequest but referenced in the `catch` block (out of scope), so any HTTP error
// surfaces as "ReferenceError: url is not defined" instead of the real cause.
// We replace makeRequest on the instance with a corrected version that also replicates
// the library's auth header generation (X-Checksum, X-Timestamp, X-AppKey, X-SessionToken).
function _patchMakeRequest(breeze) {
  const API_URL = 'https://api.icicidirect.com/breezeapi/api/v1/';
  breeze.makeRequest = async function patchedMakeRequest(method, endpoint, body, header) {
    const url = API_URL + endpoint; // declared outside try so catch can reference it
    try {
      const timestamp = new Date().toISOString().split('.')[0] + '.000Z';
      const bodyStr = JSON.stringify(body || {});
      const checksum = crypto
        .createHash('sha256')
        .update(timestamp + bodyStr + config.BREEZE_API_SECRET)
        .digest('hex');

      const authHeaders = {
        ...header,
        'Content-Type': 'application/json',
        'X-Checksum': 'token ' + checksum,
        'X-Timestamp': timestamp,
        'X-AppKey': config.BREEZE_API_KEY,
        'X-SessionToken': this.apiSession || '',
      };

      const res = await axios({ method: method.toLowerCase(), url, data: body, headers: authHeaders });
      return res;
    } catch (error) {
      throw new Error(`makeRequest ${method} ${url} failed: ${error.message}`);
    }
  };
}

function _getInstance() {
  if (!_breeze) {
    if (!config.BREEZE_API_KEY) throw new Error('BREEZE_API_KEY not set in .env');
    _breeze = new BreezeConnect({ appKey: config.BREEZE_API_KEY });
    _patchMakeRequest(_breeze);
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

function _istDateStr(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function _midnightISTExpiry(istDateStr) {
  // Token expires at 00:00 IST of the next day = end of istDateStr in IST.
  // 00:00 IST = UTC-05:30, so next IST day's midnight = same UTC date at 18:30.
  const [y, m, d] = istDateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 18, 30, 0));
}

// Result of the most recent pingSession(): null = not pinged since the token was set,
// true/false = last ping outcome. A failed ping marks the session invalid even if the
// token was saved today, because ICICI can reject a token the date check still accepts.
let _lastPing = null; // { ok: boolean, at: Date, error?: string }

function isSessionValid() {
  const session = loadSession();
  if (!session || !session.session_token || !session.saved_at) return false;
  const savedDateIST = _istDateStr(new Date(session.saved_at));
  const todayIST = _istDateStr(new Date());
  if (savedDateIST !== todayIST) return false;
  return !(_lastPing && !_lastPing.ok);
}

function getSessionInfo() {
  const session = loadSession();
  if (!session || !session.saved_at) {
    return { valid: false, reason: 'No session found. Submit a token at http://localhost:3000' };
  }

  const savedAt = new Date(session.saved_at);
  const savedDateIST = _istDateStr(savedAt);
  const todayIST = _istDateStr(new Date());
  const valid = isSessionValid();

  const expiresAt = _midnightISTExpiry(savedDateIST);
  const now = new Date();
  const hoursRemaining = Math.max(0, (expiresAt - now) / 3600000);
  const ageHours = (now - savedAt) / 3600000;

  return {
    valid,
    saved_at: session.saved_at,
    expires_at: expiresAt.toISOString(),
    hours_remaining: parseFloat(hoursRemaining.toFixed(1)),
    age_hours: parseFloat(ageHours.toFixed(1)),
    last_ping: _lastPing
      ? { ok: _lastPing.ok, at: _lastPing.at.toISOString(), error: _lastPing.error }
      : null,
  };
}

// ─────────────────────── Auth ───────────────────────

async function generateSession(sessionToken) {
  if (!config.BREEZE_API_SECRET) throw new Error('BREEZE_API_SECRET not set in .env');
  const breeze = _getInstance();
  await breeze.generateSession(config.BREEZE_API_SECRET, sessionToken);
  _sessionReady = true;
  _lastPing = null; // new token — clear any earlier failed-ping state
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
    const alive = await pingSession();
    if (alive) {
      logger.info('Breeze session restored and verified live');
    } else {
      logger.warn('Session restored but API ping failed — token may be stale. Re-submit at http://localhost:3000');
    }
    return true;
  } catch (e) {
    logger.error(`Failed to restore session: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function pingSession() {
  if (!_breeze || !_sessionReady) return false;
  const fail = (reason) => {
    _lastPing = { ok: false, at: new Date(), error: reason };
    logger.error(`pingSession failed: ${reason}`);
    return false;
  };
  try {
    const res = await _breeze.getQuotes({
      stockCode: 'NIFTY',
      exchangeCode: 'NSE',
      productType: 'cash',
      expiryDate: '',
      strikePrice: '',
      right: 'others',
    });
    if (res && res.Success && res.Success[0]) {
      _lastPing = { ok: true, at: new Date() };
      return true;
    }
    return fail(`empty response (Status=${res && res.Status}, Error=${res && res.Error})`);
  } catch (e) {
    // breezeConnect throws a string with the stack appended; keep only the first line
    // (contains the HTTP status, e.g. "Request failed with status code 401").
    return fail(String((e && e.message) || e).split('\n')[0]);
  }
}

function _requireSession() {
  if (!_breeze || !_sessionReady) throw new Error('Breeze session not initialised');
  return _breeze;
}

// ─────────────────────── Market data ───────────────────────

async function _withRetry(fn, label, retries = 3, delayMs = 1000) {
  let consecutive503 = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) logger.info(`${label} recovered on attempt ${attempt}/${retries}`);
      return result;
    } catch (e) {
      // breezeConnect's errorException throws a string with the full stack appended;
      // take only the first line so we don't dump a raw stack trace into the log.
      const firstLine = String(e.message || e).split('\n')[0];
      const is503 = firstLine.includes('503');
      if (is503) consecutive503++;
      if (attempt === retries) {
        if (consecutive503 === retries) {
          logger.warn(`${label} — all retries returned 503. If this persists, your session token may be stale. Re-submit at http://localhost:3000`);
        }
        throw e;
      }
      logger.warn(`${label} failed (attempt ${attempt}/${retries}), retrying in ${delayMs * attempt}ms: ${firstLine}`);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

/**
 * Returns a quote object for a single NSE cash stock.
 * Response fields (Breeze naming): ltp, previous_close, ltp_percent_change,
 * total_quantity_traded, open, high, low
 */
async function getQuote(stockCode) {
  const breeze = _requireSession();
  return _withRetry(async () => {
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
  }, `getQuote(${stockCode})`);
}

/**
 * Returns array of daily OHLCV candles sorted ascending by date.
 * Each item: { datetime, open, high, low, close, volume }
 */
function _toBreezeDateStr(date) {
  const pad = n => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  return `${y}-${m}-${d}T07:00:00.000Z`;
}

async function getHistoricalData(stockCode, fromDate, toDate) {
  const breeze = _requireSession();
  return _withRetry(async () => {
    const res = await breeze.getHistoricalDatav2({
      interval: '1day',
      fromDate: _toBreezeDateStr(fromDate),
      toDate: _toBreezeDateStr(toDate),
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
  }, `getHistoricalData(${stockCode})`);
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

  // validityDate: today's market close at 15:30 IST (UTC+5:30 = 10:00 UTC)
  const now = new Date();
  const istMidnight = new Date(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now) + 'T00:00:00+05:30'
  );
  const vd = new Date(istMidnight.getTime() + (15 * 60 + 30) * 60 * 1000);

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
    right: '',
    strikePrice: '',
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
  pingSession,
  getQuote,
  getHistoricalData,
  placeOrder,
};
