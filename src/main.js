require('dotenv').config();
const logger = require('./logger');
const breeze = require('./breeze');
const { startScheduler } = require('./scheduler');
const { startServer } = require('./api');
const config = require('./config');

async function main() {
  logger.info('╔══════════════════════════════════════╗');
  logger.info('║         BTST Bot — Starting Up       ║');
  logger.info('╚══════════════════════════════════════╝');

  if (!config.BREEZE_API_KEY || !config.BREEZE_API_SECRET) {
    logger.error('BREEZE_API_KEY and BREEZE_API_SECRET must be set in .env');
    process.exit(1);
  }

  logger.info(`Mode:     ${config.DRY_RUN ? '🔵 DRY RUN (no real orders)' : '🔴 LIVE TRADING'}`);
  logger.info(`Capital:  ₹${config.ALLOCATED_CAPITAL.toLocaleString('en-IN')}`);
  logger.info(`Slots:    ${config.MAX_POSITIONS} max positions`);
  logger.info(`Sell:     09:16 AM IST (1-min checks) | Deadline: 10:00 AM IST | Buy: 02:55 PM IST`);

  if (config.DRY_RUN) {
    logger.warn('DRY RUN active — no real orders will be placed until DRY_RUN=false in .env');
  }

  // Try to restore an existing valid session
  const restored = await breeze.initFromSavedSession();
  if (!restored) {
    logger.warn('No active session — open http://localhost:3000 and submit your session token');
  }

  startServer(config.PORT);
  startScheduler();

  logger.info('Bot ready. Waiting for scheduled events.');
}

main().catch(e => {
  const logger = require('./logger');
  logger.error(`Fatal startup error: ${e.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason).split('\n')[0];
  logger.error(`Unhandled rejection: ${msg}`);
});

process.on('uncaughtException', (e) => {
  logger.error(`Uncaught exception: ${e.message}`);
  process.exit(1);
});
