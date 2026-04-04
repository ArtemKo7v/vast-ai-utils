import { vastaiShowInstances } from './lib/vastai.js';
import 'dotenv/config';

import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.BOT_TOKEN || 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE';
const ALLOWED_TELEGRAM_USER_IDS = parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS || '');
const INSTANCE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const DISPLAY_TIME_ZONE = 'Europe/Paris';

const instanceCache = {
  instances: [],
  lastUpdatedAt: null,
  lastError: null,
};

const subscribedChatIds = new Set();

if (!BOT_TOKEN || BOT_TOKEN.includes('PUT_YOUR')) {
  console.error('Set BOT_TOKEN env var (BOT_TOKEN=123:ABC).');
  process.exit(1);
}

if (ALLOWED_TELEGRAM_USER_IDS.size === 0) {
  console.warn('No allowed Telegram user IDs specified. Set ALLOWED_TELEGRAM_USER_IDS env var to a comma-separated list of allowed user IDs (e.g. ALLOWED_TELEGRAM_USER_IDS=123456789,987654321).');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = msg.text || '';

  if (!chatId || !text.startsWith('/')) {
    return;
  }

  if (!isUserAllowed(userId)) {
    await bot.sendMessage(chatId, `User ID ${userId ?? 'unknown'} is not allowed.`);
    return;
  }

  rememberChat(chatId);

  if (text === '/start') {
    await bot.sendMessage(chatId, 'Hi!\n\nType /help to see available commands.');
    return;
  }

  if (text === '/help') {
    await bot.sendMessage(chatId, buildHelpMessage());
    return;
  }

  if (text === '/status') {
    await bot.sendMessage(chatId, buildStatusMessage());
    return;
  }

  if (text === '/list') {
    if (!instanceCache.lastUpdatedAt) {
      await bot.sendMessage(chatId, 'Instance cache is warming up. Trying to refresh now...');
      await refreshInstanceCache();
    }

    await bot.sendMessage(chatId, buildInstancesMessage(instanceCache), {
      parse_mode: 'Markdown'
    });
    return;
  }
});

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

  rememberChat(chatId);
  await bot.answerCallbackQuery(callbackId, { text: `Unknown action: ${data}` });
});

async function refreshInstanceCache() {
  const previousInstances = instanceCache.instances;
  const hadPreviousSnapshot = instanceCache.lastUpdatedAt !== null;

  try {
    const instances = await vastaiShowInstances();

    instanceCache.instances = Array.isArray(instances) ? instances : [];
    instanceCache.lastUpdatedAt = new Date();
    instanceCache.lastError = null;

    if (hadPreviousSnapshot) {
      await notifyStatusChanges(previousInstances, instanceCache.instances);
    }
  } catch (error) {
    instanceCache.lastError = error instanceof Error ? error.message : String(error);
    console.error('Failed to refresh instance cache:', error);
  }
}

async function notifyStatusChanges(previousInstances, currentInstances) {
  if (subscribedChatIds.size === 0) {
    return;
  }

  const previousById = new Map(previousInstances.map((instance) => [String(instance.id), instance]));

  for (const instance of currentInstances) {
    const instanceId = String(instance.id ?? '');
    const previousInstance = previousById.get(instanceId);

    if (!previousInstance) {
      continue;
    }

    const previousStatus = getDisplayStatus(previousInstance);
    const currentStatus = getDisplayStatus(instance);

    if (previousStatus === currentStatus) {
      continue;
    }

    const message = buildStatusChangeMessage(instance, previousStatus, currentStatus);
    await broadcastMessage(message, { parse_mode: 'Markdown' });
  }
}

async function broadcastMessage(text, options = {}) {
  for (const chatId of subscribedChatIds) {
    try {
      await bot.sendMessage(chatId, text, options);
    } catch (error) {
      console.error(`Failed to send message to chat ${chatId}:`, error.message || error);
    }
  }
}

void refreshInstanceCache();
setInterval(() => {
  void refreshInstanceCache();
}, INSTANCE_REFRESH_INTERVAL_MS);

function rememberChat(chatId) {
  subscribedChatIds.add(chatId);
}

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
    return false;
  }
  return ALLOWED_TELEGRAM_USER_IDS.has(String(userId));
}

function buildHelpMessage() {
  return [
    'Available commands:',
    '/help - show this help message',
    '/status - show current bot settings',
    '/list - show current Vast.ai instances from bot memory',
    '',
    '/search - search for offers on Vast AI (to be implemented)',
    '',
    'Usage:',
    ' - to be written...'
  ].join('\n');
}

function buildStatusMessage() {
  const whitelistStatus = ALLOWED_TELEGRAM_USER_IDS.size > 0 ? `${ALLOWED_TELEGRAM_USER_IDS.size} allowed user(s)` : 'empty (no users allowed)';
  const apiStatus = process.env.VAST_API_KEY ? 'API configured via VAST_API_KEY' : 'VAST_API_KEY is not configured';
  const cacheStatus = instanceCache.lastUpdatedAt
    ? `instances cached: ${instanceCache.instances.length}, updated at ${formatDateTime(instanceCache.lastUpdatedAt)}`
    : 'instance cache is not initialized yet';
  const subscribedChatsStatus = `notification chats: ${subscribedChatIds.size}`;

  return [
    'Bot status',
    `Access whitelist: ${whitelistStatus}`,
    '',
    'Vast AI Status:',
    apiStatus,
    cacheStatus,
    subscribedChatsStatus
  ].join('\n');
}

function buildInstancesMessage(cache) {
  if (!cache.lastUpdatedAt) {
    return 'Instances are not loaded yet.';
  }

  const groups = [
    { title: 'Running', items: [] },
    { title: 'Error', items: [] },
    { title: 'Starting', items: [] },
    { title: 'Stopped', items: [] },
    { title: 'Offline', items: [] },
  ];

  for (const instance of cache.instances) {
    const displayStatus = getDisplayStatus(instance);
    const group = groups.find((entry) => entry.title === displayStatus) || groups[4];
    group.items.push(instance);
  }

  const lines = [
    '*Current Vast.ai instances*',
    `_Last update: ${escapeMarkdown(formatDateTime(cache.lastUpdatedAt))}_`,
  ];

  if (cache.lastError) {
    lines.push(`_Last refresh error: ${escapeMarkdown(cache.lastError)}_`);
  }

  if (cache.instances.length === 0) {
    lines.push('', 'No instances found.');
    return lines.join('\n');
  }

  for (const group of groups) {
    if (group.items.length === 0) {
      continue;
    }

    lines.push('', buildGroupHeading(group.title, group.items.length));

    for (const instance of sortInstances(group.items)) {
      lines.push(...formatInstanceLines(instance));
    }
  }

  return lines.join('\n');
}

function buildStatusChangeMessage(instance, previousStatus, currentStatus) {
  const id = instance.id ?? 'unknown';
  const label = escapeMarkdown(instance.label || instance.template_name || instance.gpu_name || 'Unnamed instance');
  const countryFlag = getCountryFlag(instance.country_code);

  return [
    '*Instance status changed*',
    `${countryFlag} #${id} ${label}`,
    `_${escapeMarkdown(previousStatus)} -> ${escapeMarkdown(currentStatus)}_`,
  ].join('\n');
}

function formatInstanceLines(instance) {
  const id = instance.id ?? 'unknown';
  const label = escapeMarkdown(instance.label || instance.template_name || instance.gpu_name || 'Unnamed instance');
  const host = escapeMarkdown(instance.public_ipaddr || instance.ssh_host || 'n/a');
  const displayStatus = escapeMarkdown(getDisplayStatus(instance));
  const gpuName = escapeMarkdown(instance.gpu_name || 'unknown');
  const countryFlag = getCountryFlag(instance.country_code);

  return [
    `${countryFlag} #${id} ${label}`,
    `Status: ${displayStatus}`,
    `GPU: ${gpuName} x${instance.num_gpus ?? '?'}`,
    `Host: ${host}`,
    ''
  ];
}

function sortInstances(instances) {
  return [...instances].sort((a, b) => {
    const left = Number(a.id ?? 0);
    const right = Number(b.id ?? 0);
    return left - right;
  });
}

function buildGroupHeading(title, count) {
  const iconMap = {
    Running: '🟢',
    Error: '🔴',
    Starting: '🟡',
    Stopped: '⏹️',
    Offline: '⚫',
  };

  const icon = iconMap[title] || '•';
  return `*${icon} ${escapeMarkdown(title)} (${count})*\n____________`;
}

function getDisplayStatus(instance) {
  const actualStatus = String(instance.actual_status || '').trim();
  const currentState = String(instance.cur_state || '').trim();
  const intendedStatus = String(instance.intended_status || '').trim();
  const nextState = String(instance.next_state || '').trim();
  const statusMessage = String(instance.status_msg || '').trim();

  const actualStatusLower = actualStatus.toLowerCase();
  const currentStateLower = currentState.toLowerCase();
  const intendedStatusLower = intendedStatus.toLowerCase();
  const nextStateLower = nextState.toLowerCase();
  const statusMessageLower = statusMessage.toLowerCase();

  if (actualStatusLower === 'running' || currentStateLower === 'running') {
    return 'Running';
  }

  if (
    (currentStateLower === 'stopped' || intendedStatusLower === 'stopped' || nextStateLower === 'stopped' || actualStatusLower === 'exited') &&
    (statusMessageLower.includes('failed') || statusMessageLower.includes('error'))
  ) {
    return 'Error';
  }

  if (
    currentStateLower === 'loading' ||
    currentStateLower === 'starting' ||
    currentStateLower === 'restarting' ||
    intendedStatusLower === 'running' ||
    nextStateLower === 'running' ||
    actualStatusLower === 'created'
  ) {
    return 'Starting';
  }

  if (
    currentStateLower === 'stopped' ||
    intendedStatusLower === 'stopped' ||
    nextStateLower === 'stopped' ||
    actualStatusLower === 'exited'
  ) {
    return 'Stopped';
  }

  if (
    currentStateLower === 'offline' ||
    actualStatusLower === 'offline' ||
    nextStateLower === 'offline'
  ) {
    return 'Offline';
  }

  return actualStatus || currentState || intendedStatus || nextState || 'Offline';
}

function getCountryFlag(countryCode) {
  const normalizedCode = String(countryCode || '').trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalizedCode)) {
    return '🏳️';
  }

  return String.fromCodePoint(
    ...normalizedCode.split('').map((char) => 127397 + char.charCodeAt(0))
  );
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(value);
}

function escapeMarkdown(value) {
  return String(value).replace(/([_*`\[])/g, '\\$1');
}
