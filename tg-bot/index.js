import { vastaiSearchOffers } from './lib/vastai.js';
import 'dotenv/config';

import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.BOT_TOKEN || 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE';
const ALLOWED_TELEGRAM_USER_IDS = parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS || '');

if (!BOT_TOKEN || BOT_TOKEN.includes('PUT_YOUR')) {
  console.error('❌ Set BOT_TOKEN env var (BOT_TOKEN=123:ABC).');
  process.exit(1);
}

if (ALLOWED_TELEGRAM_USER_IDS.size === 0) {
  console.warn('⚠️ No allowed Telegram user IDs specified. Set ALLOWED_TELEGRAM_USER_IDS env var to a comma-separated list of allowed user IDs (e.g. ALLOWED_TELEGRAM_USER_IDS=123456789,987654321).');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const callbackId = query.id;
  const data = query.data || '';

  if (!chatId) {
    await bot.answerCallbackQuery(callbackId, { text: 'Unable to process this action.' });
    return;
  }

  if (!isUserAllowed(userId)) {
    await bot.answerCallbackQuery(callbackId, {
      text: `User ID ${userId ?? 'unknown'} is not allowed.`,
      show_alert: true
    });
    return;
  }

  if (msg.text === '/start') {
    await bot.sendMessage(
      chatId,
      `Hi!\n\nType /help to see available commands.`
    );
    return;
  }

  if (msg.text === '/help') {
    await bot.sendMessage(
      chatId,
      buildHelpMessage()
    );
    return;
  }

  if (msg.text === '/status') {
    await bot.sendMessage(
      chatId,
      buildStatusMessage()
    );
    return;
  }

});

function parseAllowedUserIds(value) {
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function isUserAllowed(userId) {
  if (ALLOWED_TELEGRAM_USER_IDS.size === 0) {
    return false; // No users allowed if the set is empty
  }
  return ALLOWED_TELEGRAM_USER_IDS.has(String(userId));
}

function buildModelKeyboard(models) {
  return models.map((model) => {
    const modelName = model.model || model.name || 'unknown';
    const isActive = modelName === CURRENT_OLLAMA_MODEL;

    return [{
      text: isActive ? `* ${modelName}` : modelName,
      callback_data: `set_model:${modelName}`
    }];
  });
}

function buildHelpMessage() {
  return [
    'Available commands:',
    '/help - show this help message',
    '/status - show current bot settings',
    '',
    '/search - search for offers on Vast AI (to be implemented)',
    '',
    'Usage:',
    ' - to be written...'
  ].join('\n');
}

function buildStatusMessage() {
  const whitelistStatus = ALLOWED_TELEGRAM_USER_IDS.size > 0 ? `${ALLOWED_TELEGRAM_USER_IDS.size} allowed user(s)` : 'empty (no users allowed)';
  const status = '';

  return [
    'Bot status',
    `Access whitelist: ${whitelistStatus}`,
    '',
    'Vast AI Status:',
    status
  ].join('\n');
}
