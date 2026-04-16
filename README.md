# Control your Vast.ai instances via Telegram bot

A small Node.js utility for monitoring and controlling your Vast.ai instances from Telegram.

## Features

- View current Vast.ai instances with `/list`
- Group instances by status: `Running`, `Error`, `Starting`, `Stopped`, `Offline`
- See country flags, GPU type, host, and last cache refresh time
- Track credit in `/status`
- Estimate approximate spend rate in `$ / h`
- Start and stop instances with Telegram commands
- Receive notifications when:
  - an instance changes status group
  - a new instance appears
  - an instance disappears
  - credit is topped up
  - credit falls below a configured threshold

## Commands

- `/start` - bot greeting
- `/help` - show available commands
- `/status` - show bot status, cache state, current credit, and spend rate
- `/list` - show cached Vast.ai instances
- `/instance start #id` - request instance start
- `/instance stop #id` - request instance stop without deleting the instance
- `/threshold N` - set low-credit warning threshold

## Requirements

- Node.js
- A Vast.ai API key
- A Telegram bot token
- Your Telegram user ID added to the allowed users list

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
copy .env.example .env
```

3. Fill in the environment variables in `.env`:

```env
VAST_API_KEY=your_vast_api_key
BOT_TOKEN=your_telegram_bot_token
ALLOWED_TELEGRAM_USER_IDS=123456789
```

## Run

```bash
node telegram_bot_server.js
```

## Notes

- Instance list is refreshed every 2 minutes
- Credit is refreshed every 15 minutes
- Notifications are sent only to chats where an allowed user has already interacted with the bot after startup
- Status grouping prefers `actual_status` from Vast.ai response data

## Project Scope

This repository also contains utility code for Vast.ai API work outside the Telegram bot.

## License

MIT. See [LICENSE](./LICENSE).
