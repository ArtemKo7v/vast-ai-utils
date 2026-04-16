import { vastaiManageInstance, vastaiShowCurrentUser, vastaiShowInstances } from './lib/vastai.js';
import 'dotenv/config';

import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.BOT_TOKEN || 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE';
const ALLOWED_TELEGRAM_USER_IDS = parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS || '');
const INSTANCE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const CREDIT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LOW_CREDIT_THRESHOLD = 5;
const DISPLAY_TIME_ZONE = 'Europe/Paris';

const instanceCache = {
  instances: [],
  lastUpdatedAt: null,
  lastError: null,
};

const balanceCache = {
  balance: null,
  previousBalance: null,
  lastUpdatedAt: null,
  previousUpdatedAt: null,
  burnRatePerHour: null,
  lastError: null,
};

const creditAlertConfig = {
  lowCreditThreshold: DEFAULT_LOW_CREDIT_THRESHOLD,
  lowCreditAlertSent: false,
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

  const instanceCommandMatch = text.match(/^\/instance(?:@\w+)?\s+(start|stop)\s+#?(\d+)$/i);
  if (instanceCommandMatch) {
    const action = instanceCommandMatch[1].toLowerCase();
    const state = action === 'start' ? 'running' : 'stopped';
    await handleInstanceStateCommand(chatId, instanceCommandMatch[2], state);
    return;
  }

  const thresholdCommandMatch = text.match(/^\/threshold(?:@\w+)?\s+([0-9]+(?:[\.,][0-9]+)?)$/i);
  if (thresholdCommandMatch) {
    await handleThresholdCommand(chatId, thresholdCommandMatch[1]);
    return;
  }

  if (text === '/start' || /^\/start(?:@\w+)?$/.test(text)) {
    await bot.sendMessage(chatId, 'Hi!\n\nType /help to see available commands.');
    return;
  }

  if (text === '/help') {
    await bot.sendMessage(chatId, buildHelpMessage());
    return;
  }

  if (text === '/status') {
    if (!balanceCache.lastUpdatedAt) {
      await refreshBalanceCache();
    }

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

async function handleInstanceStateCommand(chatId, instanceId, state) {
  const actionLabel = state === 'running' ? 'start' : 'stop';
  const progressLabel = state === 'running' ? 'Starting' : 'Stopping';
  const cachedInstance = findInstanceById(instanceId);

  await bot.sendMessage(chatId, `${progressLabel} instance #${instanceId}...`);

  const result = await vastaiManageInstance(instanceId, state);
  const success = result?.success === true;

  if (!success) {
    const errorText = extractApiError(result) || `Failed to ${actionLabel} instance #${instanceId}.`;
    await bot.sendMessage(chatId, errorText);
    return;
  }

  await refreshInstanceCache();

  const updatedInstance = findInstanceById(instanceId) || cachedInstance;
  const instanceTitle = updatedInstance ? buildInstanceTitle(updatedInstance) : `#${instanceId}`;
  const statusText = updatedInstance ? getDisplayStatus(updatedInstance) : (state === 'running' ? 'Starting' : 'Stopped');
  const verbPast = state === 'running' ? 'start requested' : 'stop requested';

  await bot.sendMessage(
    chatId,
    `${instanceTitle} ${verbPast}. Current group: ${statusText}`,
    { parse_mode: 'Markdown' }
  );
}

async function handleThresholdCommand(chatId, rawValue) {
  const parsedValue = Number(rawValue.replace(',', '.'));

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    await bot.sendMessage(chatId, 'Threshold must be a non-negative number. Example: /threshold 5');
    return;
  }

  creditAlertConfig.lowCreditThreshold = parsedValue;

  if (balanceCache.balance !== null && balanceCache.balance >= parsedValue) {
    creditAlertConfig.lowCreditAlertSent = false;
  }

  await bot.sendMessage(
    chatId,
    `Low credit threshold set to $${formatMoney(parsedValue)}.`
  );
}

async function refreshInstanceCache() {
  const previousInstances = instanceCache.instances;
  const hadPreviousSnapshot = instanceCache.lastUpdatedAt !== null;

  try {
    const instances = await vastaiShowInstances();

    instanceCache.instances = Array.isArray(instances) ? instances : [];
    instanceCache.lastUpdatedAt = new Date();
    instanceCache.lastError = null;

    if (hadPreviousSnapshot) {
      await notifyInstanceChanges(previousInstances, instanceCache.instances);
    }
  } catch (error) {
    instanceCache.lastError = error instanceof Error ? error.message : String(error);
    console.error('Failed to refresh instance cache:', error);
  }
}

async function refreshBalanceCache() {
  try {
    const user = await vastaiShowCurrentUser();
    const nextBalance = Number(user?.credit);

    if (!Number.isFinite(nextBalance)) {
      balanceCache.lastError = 'Credit is missing in Vast.ai response.';
      return;
    }

    const nextUpdatedAt = new Date();
    const hadPreviousSnapshot = balanceCache.lastUpdatedAt !== null && balanceCache.balance !== null;
    const previousBalance = balanceCache.balance;
    const previousUpdatedAt = balanceCache.lastUpdatedAt;

    if (hadPreviousSnapshot) {
      balanceCache.previousBalance = previousBalance;
      balanceCache.previousUpdatedAt = previousUpdatedAt;
      balanceCache.burnRatePerHour = calculateBurnRatePerHour(
        previousBalance,
        nextBalance,
        previousUpdatedAt,
        nextUpdatedAt
      );
    }

    balanceCache.balance = nextBalance;
    balanceCache.lastUpdatedAt = nextUpdatedAt;
    balanceCache.lastError = null;

    if (hadPreviousSnapshot) {
      await notifyCreditChanges(previousBalance, nextBalance);
    }
  } catch (error) {
    balanceCache.lastError = error instanceof Error ? error.message : String(error);
    console.error('Failed to refresh balance cache:', error);
  }
}

async function notifyCreditChanges(previousBalance, currentBalance) {
  if (currentBalance > previousBalance) {
    await broadcastMessage(buildCreditTopUpMessage(currentBalance - previousBalance), { parse_mode: 'Markdown' });
  }

  const threshold = creditAlertConfig.lowCreditThreshold;

  if (currentBalance >= threshold) {
    creditAlertConfig.lowCreditAlertSent = false;
    return;
  }

  if (!creditAlertConfig.lowCreditAlertSent) {
    creditAlertConfig.lowCreditAlertSent = true;
    await broadcastMessage(buildLowCreditMessage(currentBalance, threshold), { parse_mode: 'Markdown' });
  }
}

async function notifyInstanceChanges(previousInstances, currentInstances) {
  if (subscribedChatIds.size === 0) {
    return;
  }

  const previousById = new Map(previousInstances.map((instance) => [String(instance.id), instance]));
  const currentById = new Map(currentInstances.map((instance) => [String(instance.id), instance]));

  for (const instance of currentInstances) {
    const instanceId = String(instance.id ?? '');
    const previousInstance = previousById.get(instanceId);

    if (!previousInstance) {
      await broadcastMessage(buildInstanceAddedMessage(instance), { parse_mode: 'Markdown' });
      continue;
    }

    const previousStatus = getDisplayStatus(previousInstance);
    const currentStatus = getDisplayStatus(instance);

    if (previousStatus !== currentStatus) {
      const message = buildStatusChangeMessage(instance, previousStatus, currentStatus);
      await broadcastMessage(message, { parse_mode: 'Markdown' });
    }
  }

  for (const instance of previousInstances) {
    const instanceId = String(instance.id ?? '');

    if (!currentById.has(instanceId)) {
      await broadcastMessage(buildInstanceDeletedMessage(instance), { parse_mode: 'Markdown' });
    }
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
void refreshBalanceCache();
setInterval(() => {
  void refreshInstanceCache();
}, INSTANCE_REFRESH_INTERVAL_MS);
setInterval(() => {
  void refreshBalanceCache();
}, CREDIT_REFRESH_INTERVAL_MS);

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
    '/status - show current bot settings and credit',
    '/list - show current Vast.ai instances from bot memory',
    '/instance start #id - start a stopped Vast.ai instance',
    '/instance stop #id - stop a Vast.ai instance without deleting it',
    '/threshold 5 - set low credit warning threshold',
    '',
    '/search - search for offers on Vast AI (to be implemented)',
  ].join('\n');
}

function buildStatusMessage() {
  const whitelistStatus = ALLOWED_TELEGRAM_USER_IDS.size > 0 ? `${ALLOWED_TELEGRAM_USER_IDS.size} allowed user(s)` : 'empty (no users allowed)';
  const apiStatus = process.env.VAST_API_KEY ? 'API configured via VAST_API_KEY' : 'VAST_API_KEY is not configured';
  const instanceCacheStatus = instanceCache.lastUpdatedAt
    ? `instances cached: ${instanceCache.instances.length}`
    : 'instance cache is not initialized yet';
  const subscribedChatsStatus = `notification chats: ${subscribedChatIds.size}`;
  const creditStatus = buildCreditStatusLine();
  const creditThresholdStatus = `low credit threshold: $${formatMoney(creditAlertConfig.lowCreditThreshold)}`;
  const statusUpdatedAt = getStatusUpdatedAt();
  const title = statusUpdatedAt ? `Bot status (updated at ${formatDateTime(statusUpdatedAt)})` : 'Bot status';

  return [
    title,
    `Access whitelist: ${whitelistStatus}`,
    '',
    'Vast AI Status:',
    apiStatus,
    instanceCacheStatus,
    creditStatus,
    creditThresholdStatus,
    subscribedChatsStatus
  ].join('\n');
}

function buildCreditStatusLine() {
  if (balanceCache.lastUpdatedAt === null || balanceCache.balance === null) {
    return 'credit cache is not initialized yet';
  }

  const parts = [
    `credit: $${formatMoney(balanceCache.balance)}`,
  ];

  if (balanceCache.burnRatePerHour !== null) {
    parts.push(`approx spend: ${formatMoneyPerHour(balanceCache.burnRatePerHour)}`);
  }

  if (balanceCache.lastError) {
    parts.push(`last credit error: ${balanceCache.lastError}`);
  }

  return parts.join(', ');
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
  return [
    '*Instance status changed*',
    buildInstanceTitle(instance),
    `_${escapeMarkdown(previousStatus)} -> ${escapeMarkdown(currentStatus)}_`,
  ].join('\n');
}

function buildInstanceAddedMessage(instance) {
  return [
    '*Instance was added*',
    buildInstanceTitle(instance),
    `_Status: ${escapeMarkdown(getDisplayStatus(instance))}_`,
  ].join('\n');
}

function buildInstanceDeletedMessage(instance) {
  return [
    '*Instance was deleted*',
    buildInstanceTitle(instance),
    `_Last known status: ${escapeMarkdown(getDisplayStatus(instance))}_`,
  ].join('\n');
}

function buildCreditTopUpMessage(delta) {
  return [
    '*Credit was topped up*',
    `Amount: ${escapeMarkdown(formatTopUpAmount(delta))}`,
    `Current credit: $${escapeMarkdown(formatMoney(balanceCache.balance ?? 0))}`,
  ].join('\n');
}

function buildLowCreditMessage(currentBalance, threshold) {
  return [
    '*Low credit warning*',
    `Current credit: $${escapeMarkdown(formatMoney(currentBalance))}`,
    `Threshold: $${escapeMarkdown(formatMoney(threshold))}`,
  ].join('\n');
}

function buildInstanceTitle(instance) {
  const id = instance.id ?? 'unknown';
  const label = escapeMarkdown(instance.label || instance.template_name || instance.gpu_name || 'Unnamed instance');
  const countryFlag = getCountryFlag(instance.country_code);

  return `${countryFlag} #${id} ${label}`;
}

function formatInstanceLines(instance) {
  const host = escapeMarkdown(instance.public_ipaddr || instance.ssh_host || 'n/a');
  const displayStatus = escapeMarkdown(getDisplayStatus(instance));
  const gpuName = escapeMarkdown(instance.gpu_name || 'unknown');

  return [
    buildInstanceTitle(instance),
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

  if (actualStatusLower === 'running') {
    return 'Running';
  }

  if (actualStatusLower === 'exited') {
    if (statusMessageLower.includes('failed') || statusMessageLower.includes('error')) {
      return 'Error';
    }

    return 'Stopped';
  }

  if (actualStatusLower === 'created') {
    return 'Starting';
  }

  if (actualStatusLower === 'offline') {
    return 'Offline';
  }

  if (currentStateLower === 'running') {
    return 'Running';
  }

  if (
    (currentStateLower === 'stopped' || intendedStatusLower === 'stopped' || nextStateLower === 'stopped') &&
    (statusMessageLower.includes('failed') || statusMessageLower.includes('error'))
  ) {
    return 'Error';
  }

  if (
    currentStateLower === 'loading' ||
    currentStateLower === 'starting' ||
    currentStateLower === 'restarting' ||
    intendedStatusLower === 'running' ||
    nextStateLower === 'running'
  ) {
    return 'Starting';
  }

  if (
    currentStateLower === 'stopped' ||
    intendedStatusLower === 'stopped' ||
    nextStateLower === 'stopped'
  ) {
    return 'Stopped';
  }

  if (currentStateLower === 'offline' || nextStateLower === 'offline') {
    return 'Offline';
  }

  return actualStatus || currentState || intendedStatus || nextState || 'Offline';
}

function findInstanceById(instanceId) {
  return instanceCache.instances.find((instance) => String(instance.id) === String(instanceId)) || null;
}

function extractApiError(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }

  return result.msg || result.error || result.detail || '';
}

function calculateBurnRatePerHour(previousBalance, currentBalance, previousUpdatedAt, currentUpdatedAt) {
  const elapsedMs = currentUpdatedAt.getTime() - previousUpdatedAt.getTime();

  if (elapsedMs <= 0) {
    return null;
  }

  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  return (previousBalance - currentBalance) / elapsedHours;
}

function getStatusUpdatedAt() {
  const timestamps = [instanceCache.lastUpdatedAt, balanceCache.lastUpdatedAt].filter(Boolean);

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps.map((value) => value.getTime())));
}

function formatTopUpAmount(delta) {
  const rounded = Math.round(delta);

  if (rounded !== 0) {
    const relativeDifference = Math.abs(delta - rounded) / Math.abs(delta);
    if (relativeDifference < 0.1) {
      return `$${rounded}`;
    }
  }

  return `$${formatMoney(delta)}`;
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

function formatMoney(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, '');
}

function formatMoneyPerHour(value) {
  const sign = value >= 0 ? '$' : '-$';
  return `${sign}${formatMoney(Math.abs(value))}/h`;
}

function escapeMarkdown(value) {
  return String(value).replace(/([_*`\[])/g, '\\$1');
}

