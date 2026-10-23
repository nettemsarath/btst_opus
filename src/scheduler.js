const cron = require('node-cron');
const logger = require('./logger');
const trader = require('./trader');
const screener = require('./screener');
const breeze = require('./breeze');

const TZ = 'Asia/Kolkata';
let _checkInterval = null;
// The check currently in flight, so runs never overlap and the deadline sell
// waits for it — overlapping runs could sell the same position twice.
let _activeCheck = null;

// ─────────────────────── Position check loop ───────────────────────

function startPositionChecks() {
  if (_checkInterval) return;
  logger.info('Starting 1-minute position check loop (runs until 9:45 deadline)');
  _checkInterval = setInterval(() => {
    if (_activeCheck) {
      logger.warn('[1-min] Previous check still running — skipping this tick');
      return;
    }
    logger.info('[1-min] Checking remaining positions...');
    _activeCheck = trader.checkRemainingPositions()
      .catch(e => logger.error(`[1-min] Position check error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { _activeCheck = null; });
  }, 60 * 1000);
}

function stopPositionChecks() {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
    logger.info('1-minute position check loop stopped');
  }
}

// ─────────────────────── Scheduler ───────────────────────

function startScheduler() {
  logger.info(`Scheduler active — timezone: ${TZ}`);

  // 9:16 AM IST — begin sell phase + start 1-min checks. The overnight gap is
  // realised at the open, so exits start right after the first minute of trading.
  cron.schedule('16 9 * * 1-5', async () => {
    logger.info('[CRON] 9:16 AM — sell phase triggered');
    try {
      _activeCheck = trader.executeSell();
      await _activeCheck;
    } catch (e) {
      logger.error(`[CRON] Sell phase error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      _activeCheck = null;
    }
    startPositionChecks();
  }, { timezone: TZ });

  // 9:45 AM IST — hard deadline sell
  cron.schedule('45 9 * * 1-5', async () => {
    logger.info('[CRON] 9:45 AM — deadline sell triggered');
    stopPositionChecks();
    if (_activeCheck) await _activeCheck;
    try {
      await trader.executeDeadlineSell();
    } catch (e) {
      logger.error(`[CRON] Deadline sell error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, { timezone: TZ });

  // 2:40 PM IST — prefetch daily history so the buy phase only needs live quotes
  cron.schedule('40 14 * * 1-5', async () => {
    if (!breeze.isSessionValid()) {
      logger.warn('[CRON] 2:40 PM — skipping history prefetch: session invalid');
      return;
    }
    logger.info('[CRON] 2:40 PM — history prefetch triggered');
    try {
      await screener.prefetchHistory();
    } catch (e) {
      logger.error(`[CRON] History prefetch error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, { timezone: TZ });

  // 2:58 PM IST — buy phase
  cron.schedule('58 14 * * 1-5', async () => {
    logger.info('[CRON] 2:58 PM — buy phase triggered');
    try {
      await trader.executeBuy();
    } catch (e) {
      logger.error(`[CRON] Buy phase error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, { timezone: TZ });

  logger.info('Scheduled jobs:');
  logger.info('  SELL START    → 09:16 AM IST (Mon-Fri), then every minute');
  logger.info('  SELL DEADLINE → 09:45 AM IST (Mon-Fri)');
  logger.info('  PREFETCH      → 02:40 PM IST (Mon-Fri)');
  logger.info('  BUY           → 02:58 PM IST (Mon-Fri)');
}

module.exports = { startScheduler };
