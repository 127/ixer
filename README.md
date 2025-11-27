# ixer — post to X via Playwright

The `tweet.js` script opens X (Twitter) in Playwright, logs in (or uses saved state from `twitter-auth.json`), and posts a tweet. The post text comes from `TWEET_TEXT`.

## Requirements
- Node.js 18+ and npm
- Playwright browsers installed: `npm install` and `npx playwright install`
- X account with username/password and optionally a TOTP secret for 2FA

## Setup
1. Install dependencies and browsers:
   ```bash
   npm install
   npx playwright install
   ```
2. Copy and fill env vars:
   ```bash
   cp .env.example .env
   ```
   In `.env`, set `TWITTER_USERNAME` and `TWITTER_PASSWORD`. For 2FA you can add `TWITTER_2FA_SECRET` (TOTP secret) or a one-time `TWITTER_2FA_CODE`.

## Environment variables
- `TWEET_TEXT` — post text (default: "Привет, X!").
- `BROWSER` — `chromium` (default) or `webkit`.
- `HEADLESS` — `true|false`; with `MANUAL_LOGIN=true` the window is always visible.
- `MANUAL_LOGIN` — `true|false`; when `true`, log in manually in the opened browser, then press Enter in the terminal.
- `TWITTER_USERNAME`, `TWITTER_PASSWORD` — used for automatic login (`MANUAL_LOGIN=false`).
- `TWITTER_2FA_SECRET` or `TWITTER_2FA_CODE` — pass 2FA without manual input.
- Session persists to `twitter-auth.json` next to the script.

## Run
Auto-login with creds from `.env`:
```bash
TWEET_TEXT="Post via Playwright" npm run tweet
```

First run with manual login (if there are captchas/confirmations):
```bash
MANUAL_LOGIN=true HEADLESS=false npm run tweet
# log in in the opened browser, return to the terminal and press Enter
```

Subsequent background run using saved session:
```bash
HEADLESS=true TWEET_TEXT="New post" npm run tweet
```

## Reset session
Delete `twitter-auth.json` to log in again (manual or automatic).
