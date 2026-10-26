require('dotenv').config();

module.exports = {
  ALLOCATED_CAPITAL: parseInt(process.env.ALLOCATED_CAPITAL) || 50000,
  MAX_POSITIONS: parseInt(process.env.MAX_POSITIONS) || 3,
  DRY_RUN: process.env.DRY_RUN !== 'false',

  // Buy filters
  MIN_FALL_PCT: 0.5,
  MAX_FALL_PCT: 2.5,
  MAX_VOLUME_MULTIPLIER: 1.5,
  // Where LTP sits in today's high-low range (0 = at the low, 1 = at the high).
  // Requiring a bounce off the low avoids buying stocks still being sold into the close.
  MIN_CLOSE_LOCATION: 0.35,
  // 14-day ATR as % of price. Above this, normal daily noise is bigger than the stoploss.
  MAX_ATR_PCT: 3.0,
  // ~100 trading days so the 50 EMA has converged.
  HISTORY_CALENDAR_DAYS: 150,

  // Sell thresholds
  TARGET_PCT: 1.2,
  STOPLOSS_PCT: 1.5,
  // Once a position has been up TRAIL_TRIGGER_PCT, exit if it gives back
  // TRAIL_GIVEBACK_PCT from its peak. Locks in opening gap-ups that start to fade.
  TRAIL_TRIGGER_PCT: 0.6,
  TRAIL_GIVEBACK_PCT: 0.4,
  // Sell limits sit below LTP so they cross the spread and fill at the bid.
  // Orders are not checked for execution, so an unfilled sell leaves untracked shares.
  SELL_LIMIT_BUFFER_PCT: 0.3,
  STOPLOSS_LIMIT_BUFFER_PCT: 0.5,

  // Market filters
  MAX_NIFTY_FALL_PCT: 1.5,
  MAX_VIX: 20,

  // Timing (IST, 24hr) — informational; cron expressions are hardcoded in scheduler.js
  SELL_TIME: '09:16',
  SELL_DEADLINE: '10:00',
  PREFETCH_TIME: '14:40',
  BUY_TIME: '14:55',

  EXCHANGE: 'NSE',
  PRODUCT: 'CNC',

  SESSION_VALIDITY_HOURS: 24,

  BREEZE_API_KEY: process.env.BREEZE_API_KEY,
  BREEZE_API_SECRET: process.env.BREEZE_API_SECRET,

  PORT: parseInt(process.env.PORT) || 3000,
};
