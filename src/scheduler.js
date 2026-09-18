const cron = require('node-cron');
const logger = require('./logger');
const trader = require('./trader');

const TZ = 'Asia/Kolkata';
let _checkInterval = null;

// ─────────────────────── Position check loop ───────────────────────

function startPositionChecks() {
  if (_checkInterval) return;
  logger.info('Starting 5-minute position check loop (runs until 9:45 deadline)');
  _checkInterval = setInterval(async () => {
    logger.info('[5-min] Checking remaining positions...');
    try {
      await trader.checkRemainingPositions();
    } catch (e) {
      logger.error(`[5-min] Position check error: ${e.message}`);
    }
  }, 5 * 60 * 1000);
}

function stopPositionChecks() {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
    logger.info('5-minute position check loop stopped');
  }
}

// ─────────────────────── Scheduler ───────────────────────

function startScheduler() {
  logger.info(`Scheduler active — timezone: ${TZ}`);

  // 9:30 AM IST — begin sell phase + start 5-min checks
  cron.schedule('30 9 * * 1-5', async () => {
    logger.info('[CRON] 9:30 AM — sell phase triggered');
    try {
      await trader.executeSell();
      startPositionChecks();
    } catch (e) {
      logger.error(`[CRON] Sell phase error: ${e.message}`);
    }
  }, { timezone: TZ });

  // 9:45 AM IST — hard deadline sell
  cron.schedule('45 9 * * 1-5', async () => {
    logger.info('[CRON] 9:45 AM — deadline sell triggered');
    stopPositionChecks();
    try {
      await trader.executeDeadlineSell();
    } catch (e) {
      logger.error(`[CRON] Deadline sell error: ${e.message}`);
    }
  }, { timezone: TZ });

  // 2:50 PM IST — buy phase
  cron.schedule('50 14 * * 1-5', async () => {
    logger.info('[CRON] 2:50 PM — buy phase triggered');
    try {
      await trader.executeBuy();
    } catch (e) {
      logger.error(`[CRON] Buy phase error: ${e.message}`);
    }
  }, { timezone: TZ });

  logger.info('Scheduled jobs:');
  logger.info('  SELL START  → 09:30 AM IST (Mon-Fri)');
  logger.info('  SELL DEADLINE → 09:45 AM IST (Mon-Fri)');
  logger.info('  BUY         → 02:50 PM IST (Mon-Fri)');
}

module.exports = { startScheduler };
