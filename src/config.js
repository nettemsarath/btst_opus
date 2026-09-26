require('dotenv').config();

module.exports = {
  ALLOCATED_CAPITAL: parseInt(process.env.ALLOCATED_CAPITAL) || 50000,
  MAX_POSITIONS: parseInt(process.env.MAX_POSITIONS) || 3,
  DRY_RUN: process.env.DRY_RUN !== 'false',

  // Buy filters
  MIN_FALL_PCT: 0.5,
  MAX_FALL_PCT: 2.5,
  MAX_VOLUME_MULTIPLIER: 1.5,

  // Sell thresholds
  TARGET_PCT: 1.2,
  STOPLOSS_PCT: 1.5,

  // Market filters
  MAX_NIFTY_FALL_PCT: 1.5,
  MAX_VIX: 20,

  // Timing (IST, 24hr)
  SELL_TIME: '09:30',
  SELL_DEADLINE: '09:45',
  BUY_TIME: '14:58',

  EXCHANGE: 'NSE',
  PRODUCT: 'CNC',

  SESSION_VALIDITY_HOURS: 24,

  BREEZE_API_KEY: process.env.BREEZE_API_KEY,
  BREEZE_API_SECRET: process.env.BREEZE_API_SECRET,

  PORT: parseInt(process.env.PORT) || 3000,
};
