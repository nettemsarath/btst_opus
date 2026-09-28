const express = require('express');
const path = require('path');
const breeze = require('./breeze');
const trader = require('./trader');
const config = require('./config');
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────── Root — auto-capture redirect ───────────────────────

// ICICI Direct redirects here after login — supports both GET and POST redirects.
// Token may arrive in the query string (?apisession=...) or the POST body.
async function handleRedirect(req, res) {
  const apisession = req.query.apisession || req.body.apisession;
  const { activated, error } = req.query;

  if (apisession) {
    logger.info('Session token received via redirect URL — activating...');
    try {
      await breeze.generateSession(apisession.trim());
      logger.info('Session auto-activated from redirect URL');
      return res.redirect('/?activated=true');
    } catch (e) {
      logger.error(`Auto-session activation failed: ${e.message}`);
      return res.redirect('/?error=' + encodeURIComponent(e.message));
    }
  }

  res.sendFile(path.join(__dirname, '../templates/index.html'));
}

app.get('/', handleRedirect);
app.post('/', handleRedirect);
// ─────────────────────── Session endpoints ───────────────────────

app.get('/session/status', (req, res) => {
  res.json(breeze.getSessionInfo());
});

// Expose the Breeze login URL so the frontend button can use it
app.get('/api/login-url', (req, res) => {
  if (!config.BREEZE_API_KEY) {
    return res.status(500).json({ error: 'BREEZE_API_KEY not configured in .env' });
  }
  res.json({
    url: `https://api.icicidirect.com/apiuser/login?api_key=${config.BREEZE_API_KEY}`,
  });
});

app.get('/health', (req, res) => {
  const up = process.uptime();
  const h = Math.floor(up / 3600);
  const m = Math.floor((up % 3600) / 60);
  const s = Math.floor(up % 60);
  res.json({
    status: 'ok',
    uptime: `${h}h ${m}m ${s}s`,
    uptime_seconds: Math.floor(up),
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────── Dashboard API ───────────────────────

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const session = breeze.getSessionInfo();
    const allPositions = trader.readBotPositions();
    const openPositions = allPositions.filter(p => !p.sold);
    const pnlHistory = trader.readPnL();

    // Enrich open positions with live LTP (only if session is valid)
    const enriched = await Promise.all(
      openPositions.map(async (pos) => {
        if (!session.valid) {
          return { ...pos, ltp: null, pnl_pct: null, pnl_amount: null, status: 'no_session' };
        }
        try {
          const quote = await breeze.getQuote(pos.stock);
          const ltp = parseFloat(quote.ltp);
          const pnlPct = parseFloat((((ltp - pos.buy_price) / pos.buy_price) * 100).toFixed(2));
          const pnlAmount = parseFloat(((ltp - pos.buy_price) * pos.shares).toFixed(2));
          const targetPrice = pos.buy_price * (1 + config.TARGET_PCT / 100);
          const slPrice = pos.buy_price * (1 - config.STOPLOSS_PCT / 100);
          const status = ltp >= targetPrice ? 'target' : ltp <= slPrice ? 'stoploss' : 'holding';
          return { ...pos, ltp, pnl_pct: pnlPct, pnl_amount: pnlAmount, status };
        } catch {
          return { ...pos, ltp: null, pnl_pct: null, pnl_amount: null, status: 'fetch_error' };
        }
      })
    );

    const stats = computeStats(pnlHistory);
    const monthly = computeMonthly(pnlHistory);
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const historyPage = [...pnlHistory].reverse().slice((page - 1) * perPage, page * perPage);

    res.json({
      session,
      config: {
        allocated_capital: config.ALLOCATED_CAPITAL,
        max_positions: config.MAX_POSITIONS,
        dry_run: config.DRY_RUN,
        target_pct: config.TARGET_PCT,
        stoploss_pct: config.STOPLOSS_PCT,
      },
      today: {
        open_count: openPositions.length,
        next_action: getNextAction(),
      },
      positions: enriched,
      history: historyPage,
      history_total: pnlHistory.length,
      history_pages: Math.ceil(pnlHistory.length / perPage),
      stats,
      monthly,
    });
  } catch (e) {
    logger.error(`Dashboard API error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────── HTML pages ───────────────────────

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../templates/dashboard.html'));
});

// ─────────────────────── Helpers ───────────────────────

function getNextAction() {
  const now = new Date();
  const istStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [h, m] = istStr.split(':').map(Number);
  const mins = h * 60 + m;

  if (mins < 9 * 60 + 30) return { label: 'Sell check',    time: '9:30 AM IST' };
  if (mins < 9 * 60 + 45) return { label: 'Deadline sell', time: '9:45 AM IST' };
  if (mins < 14 * 60 + 50) return { label: 'Buy phase',    time: '2:50 PM IST' };
  return { label: 'Sell check (tomorrow)', time: '9:30 AM IST' };
}

function computeStats(trades) {
  if (!trades.length) {
    return { total: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: 0, avg_win: 0, avg_loss: 0, best: null, worst: null };
  }
  const wins = trades.filter(t => t.pnl_amount > 0);
  const losses = trades.filter(t => t.pnl_amount <= 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl_amount || 0), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_pct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_pct, 0) / losses.length : 0;
  const sorted = [...trades].sort((a, b) => (b.pnl_amount || 0) - (a.pnl_amount || 0));

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    total_pnl: parseFloat(totalPnl.toFixed(2)),
    avg_win: parseFloat(avgWin.toFixed(2)),
    avg_loss: parseFloat(avgLoss.toFixed(2)),
    best: sorted[0] || null,
    worst: sorted[sorted.length - 1] || null,
  };
}

function computeMonthly(trades) {
  const map = {};
  for (const t of trades) {
    if (!t.sell_date) continue;
    const key = t.sell_date.slice(0, 7);
    map[key] = parseFloat(((map[key] || 0) + (t.pnl_amount || 0)).toFixed(2));
  }
  return map;
}

function startServer(port) {
  app.listen(port, () => {
    logger.info(`Server → http://localhost:${port}`);
    logger.info(`Dashboard → http://localhost:${port}/dashboard`);
    logger.info(`Redirect URL for ICICI Direct API settings → http://localhost:${port}/`);
  });
}

module.exports = { startServer };
