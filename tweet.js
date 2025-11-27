require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { authenticator } = require('otplib');
const { chromium, webkit, devices } = require('playwright');

const STORAGE_PATH = path.join(__dirname, 'twitter-auth.json');
const HOME_SELECTOR = '[data-testid="SideNav_NewTweet_Button"], [data-testid="tweetTextarea_0"]';
const BROWSER = process.env.BROWSER || 'chromium'; // chromium|webkit
const DESKTOP_CHROME = devices['Desktop Chrome'];
const DESKTOP_SAFARI = devices['Desktop Safari'];
const LOGIN_URLS = [
  'https://x.com/i/flow/login',
  'https://x.com/login',
  'https://mobile.x.com/login'
];

async function isLoggedIn(page) {
  const selectors = [
    HOME_SELECTOR,
    '[data-testid="AppTabBar_Profile_Link"]',
    '[data-testid="primaryColumn"]'
  ];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function waitForHomeOr2FA(page) {
  const twoFaInput = page.locator('input[name="text"]');
  const twoFaPrompt = page.getByText(/verification code|two[- ]?factor/i);

  const result = await Promise.race([
    page.waitForSelector(HOME_SELECTOR, { timeout: 20000 }).then(() => 'home').catch(() => null),
    twoFaInput.waitFor({ state: 'visible', timeout: 20000 }).then(() => '2fa').catch(() => null),
    twoFaPrompt.waitFor({ state: 'visible', timeout: 20000 }).then(() => '2fa').catch(() => null)
  ]);

  if (!result) {
    throw new Error('Login did not reach home or 2FA prompt in time.');
  }

  return result;
}

async function clickRetryIfPresent(page) {
  const retryBtn = page.getByRole('button', { name: /retry/i });
  if (await retryBtn.isVisible().catch(() => false)) {
    await retryBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function waitForLoginInput(page) {
  const usernameInput = page.locator('input[autocomplete="username"], input[name="text"]');
  await usernameInput.waitFor({ state: 'visible', timeout: 20000 });
  return usernameInput;
}

async function goToLogin(page) {
  for (const url of LOGIN_URLS) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await clickRetryIfPresent(page);
      await page.waitForSelector(
        'input[autocomplete="username"], input[name="text"], input[name="session[username_or_email]"]',
        { state: 'visible', timeout: 30000 }
      );
      return;
    } catch {
      // try next URL
    }
  }
  throw new Error('Could not reach login form.');
}

async function navigateToPassword(page, username) {
  const passwordSelector = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
  const identifierSelector = 'input[name="text"], input[autocomplete="username"], input[data-testid="ocfEnterTextTextInput"]';
  const errorBanner = page.getByText(/could not log you in|try again later/i);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const passwordInput = page.locator(passwordSelector);
    // Wait primarily for password; only fall back to identifier if nothing changes.
    const result = await Promise.race([
      passwordInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'password').catch(() => null),
      identifierSelector
        ? page.locator(identifierSelector).waitFor({ state: 'visible', timeout: 15000 }).then(() => 'identifier').catch(() => null)
        : Promise.resolve(null)
    ]);

    if (result === 'password') {
      return passwordInput;
    }

    if (await errorBanner.isVisible().catch(() => false)) {
      await page.waitForTimeout(2000);
    }

    const identifierInput = page.locator(identifierSelector);
    if (await identifierInput.isVisible().catch(() => false)) {
      await identifierInput.fill(username);
      const nextBtn =
        (await page.getByRole('button', { name: /next|continue|log in/i }).elementHandles())[0] ||
        (await page.locator('[data-testid="ocfEnterTextNextButton"]').elementHandles())[0];

      if (nextBtn) {
        await nextBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      await clickRetryIfPresent(page);
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // Final wait once more before failing.
  const passwordInput = page.locator(passwordSelector);
  await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
  return passwordInput;
}

function promptForTwoFactorCode() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Enter 2FA code from email/auth app: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function handleTwoFactor(page) {
  const totpSecret = process.env.TWITTER_2FA_SECRET;
  const oneTimeCode = process.env.TWITTER_2FA_CODE;

  let code;
  if (oneTimeCode) {
    code = oneTimeCode;
  } else if (totpSecret) {
    code = authenticator.generate(totpSecret);
  } else {
    code = await promptForTwoFactorCode();
  }

  const codeInput = page.locator('input[name="text"]');
  await codeInput.waitFor({ state: 'visible', timeout: 15000 });
  await codeInput.fill(code);

  const verifyButton = page.getByRole('button', { name: /next|verify|confirm|log in/i });
  if (await verifyButton.isVisible().catch(() => false)) {
    await verifyButton.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForSelector(HOME_SELECTOR, { timeout: 20000 });
}

async function saveState(context) {
  await context.storageState({ path: STORAGE_PATH });
}

async function openComposer(page) {
  const composeButtons = [
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="DashButton_Profile_SidebarCompose"]',
    '[data-testid="app-bar-new-tweet-button"]',
    '[data-testid="AppTabBar_ComposeButton"]',
    '[data-testid="toolBarComposeButton"]',
    '[data-testid="compositionButton"]'
  ];

  for (const selector of composeButtons) {
    const btn = page.locator(selector);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      return;
    }
  }

  // Keyboard shortcut on desktop.
  await page.keyboard.press('n').catch(() => {});
}

async function dismissOverlays(page) {
  // Try common close buttons and cookie/consent overlays.
  const closeSelectors = [
    '[data-testid="app-bar-close"]',
    '[aria-label="Close"]',
    '[data-testid="close"]',
    '[data-testid="confirmationSheetConfirm"]',
    '[data-testid="confirmationSheetCancel"]',
    '[data-testid="dialog"] button',
    '[data-testid="sheetDialog"] button',
    '[data-testid="twc-cc-mask"] + div [data-testid]'
  ];

  for (const sel of closeSelectors) {
    const btn = page.locator(sel);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // Remove intercepting mask if still present.
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid="twc-cc-mask"]').forEach((el) => el.remove());
    document.querySelectorAll('#layers > div[role="presentation"], #layers [style*="pointer-events"]').forEach((el) => {
      el.remove();
    });
    const layer = document.getElementById('layers');
    if (layer) {
      layer.style.pointerEvents = 'none';
    }
  }).catch(() => {});
}

async function writeTweet(page, composer, tweetText) {
  await composer.focus().catch(() => {});
  // Select all and insert text to avoid partial input and trigger Draft events.
  const selectAllKey = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
  await page.keyboard.press(selectAllKey).catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.insertText(tweetText);
  await page.waitForTimeout(300);
}

async function handleSaveDraftPrompt(page) {
  const prompt = page.getByText(/save post/i);
  if (!(await prompt.isVisible({ timeout: 500 }).catch(() => false))) {
    return false;
  }

  const sendNow = page.getByRole('button', { name: /send now|post now|post/i });
  const dontSave = page.getByRole('button', { name: /don't save|discard/i });
  const cancel = page.getByRole('button', { name: /cancel/i });

  if (await sendNow.isVisible().catch(() => false)) {
    await sendNow.click().catch(() => {});
  } else if (await dontSave.isVisible().catch(() => false)) {
    await dontSave.click().catch(() => {});
  } else if (await cancel.isVisible().catch(() => false)) {
    await cancel.click().catch(() => {});
  } else {
    // Fallback: click the first button inside the dialog.
    const dialog = page.locator('[role="dialog"] [role="button"]');
    if ((await dialog.count()) >= 1) {
      await dialog.first().click().catch(() => {});
    } else {
      const buttons = page.locator('[role="button"]');
      if ((await buttons.count()) >= 1) {
        await buttons.first().click().catch(() => {});
      }
    }
  }
  await page.waitForTimeout(500);
  return true;
}

async function sendViaShortcut(page) {
  const enterKey = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
  await page.keyboard.press(enterKey).catch(() => {});
  await page.waitForTimeout(500);
}

async function clickSendButton(page, timeout = 10000) {
  const sendSelector =
    '[data-testid="tweetButtonInline"]:not([disabled]):not([aria-disabled="true"]), ' +
    '[data-testid="tweetButtonInlineComposer"]:not([disabled]):not([aria-disabled="true"]), ' +
    '[data-testid="tweetButton"]:not([disabled]):not([aria-disabled="true"])';
  const sendButtons = page.locator(sendSelector);
  if ((await sendButtons.count()) === 0) {
    return;
  }

  const sendButton = sendButtons.first();
  try {
    await sendButton.waitFor({ state: 'visible', timeout });
    await dismissOverlays(page);
    await sendButton.evaluate((btn) => btn.click());
    await page.waitForTimeout(300);
  } catch {
    // If we couldn't click (e.g., already sent or UI changed), ignore.
  }
}

async function getComposerTextbox(page) {
  const selectors = [
    'div[data-testid="tweetTextarea_0"] div[role="textbox"]',
    'div[role="textbox"][data-testid="tweetTextarea_0"]',
    'div[data-testid="tweetTextarea_0"]',
    'div[data-testid="tweetTextarea_1"]',
    'div[role="textbox"][data-testid^="tweetTextarea_"]',
    'div[role="textbox"][aria-label*="What"]',
    'div[role="textbox"]'
  ];

  for (const selector of selectors) {
    const box = page.locator(selector);
    if (await box.isVisible({ timeout: 1000 }).catch(() => false)) {
      return box;
    }
  }

  throw new Error('Could not find tweet composer textbox.');
}

async function ensureLogin(page, context, username, password) {
  if (!username || !password) {
    console.error('Set TWITTER_USERNAME and TWITTER_PASSWORD env vars before running the first time.');
    process.exit(1);
  }

  await goToLogin(page);

  // Mobile login form (m.twitter.com/login)
  const mobileUserInput = page.locator('input[name="session[username_or_email]"]');
  const mobilePassInput = page.locator('input[name="session[password]"]');
  if (await mobileUserInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await mobileUserInput.fill(username);
    await mobilePassInput.fill(password);
    const loginBtn =
      (await page.getByRole('button', { name: /log in/i }).elementHandles())[0] ||
      (await page.locator('div[data-testid="LoginForm_Login_Button"], [data-testid="LoginForm_Login_Button"]').elementHandles())[0];
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    const postLoginState = await waitForHomeOr2FA(page);
    if (postLoginState === '2fa') {
      await handleTwoFactor(page);
    }
    await saveState(context);
    return;
  }

  // Step 1: username/phone/email
  const usernameInput = await waitForLoginInput(page);
  await usernameInput.fill(username);
  await page.getByRole('button', { name: 'Next' }).click();

  // Handle extra identifier prompts and reach password step.
  const passwordInput = await navigateToPassword(page, username);
  await passwordInput.waitFor({ state: 'visible' });
  await passwordInput.fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();

  const postLoginState = await waitForHomeOr2FA(page);
  if (postLoginState === '2fa') {
    await handleTwoFactor(page);
  }

  // Persist the authenticated state for future runs.
  await saveState(context);
}

function getDeviceAndUA() {
  if (BROWSER === 'webkit') {
    return {
      device: DESKTOP_SAFARI,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
    };
  }
  return {
    device: DESKTOP_CHROME,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };
}

async function createContext(headless, storageState) {
  const { device, userAgent } = getDeviceAndUA();
  const isChromium = BROWSER === 'chromium';
  const launchOpts = {
    headless,
    args: isChromium ? ['--disable-blink-features=AutomationControlled'] : undefined
  };

  const browser =
    BROWSER === 'webkit' ? await webkit.launch(launchOpts) : await chromium.launch(launchOpts);

  const context = await browser.newContext({
    ...device,
    viewport: { width: 1280, height: 720 },
    userAgent,
    locale: 'en-US',
    timezoneId: 'UTC',
    storageState
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);

  return { browser, context, page };
}

async function loginAndTweet() {
  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const tweetText = process.env.TWEET_TEXT || 'Привет, X!';
  const manualLogin = process.env.MANUAL_LOGIN === 'true';
  const headless = manualLogin ? false : process.env.HEADLESS === 'true';

  const hasCachedState = fs.existsSync(STORAGE_PATH);
  const { browser, context, page } = await createContext(headless, hasCachedState ? STORAGE_PATH : undefined);

  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });

  if (!(await isLoggedIn(page))) {
    if (manualLogin) {
      console.log('Manual login mode: log in in the opened browser, then press Enter here.');
      await goToLogin(page);
      await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Press Enter after you finish logging in...', () => {
          rl.close();
          resolve();
        });
      });
    } else {
      await ensureLogin(page, context, username, password);
    }
  }

  if (!(await isLoggedIn(page))) {
    console.error('Not logged in. Complete login manually (set MANUAL_LOGIN=true) or check credentials/2FA.');
    process.exit(1);
  }

  // Refresh state and ensure home.
  await saveState(context);
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Open composer and post tweet.
  await openComposer(page);

  const composer = await getComposerTextbox(page);
  await composer.waitFor({ state: 'visible' });
  await dismissOverlays(page);
  await writeTweet(page, composer, tweetText);
  await dismissOverlays(page);
  await sendViaShortcut(page);
  await handleSaveDraftPrompt(page);

  // If compose dialog is still present, fall back to clicking send.
  const stillOpen = await composer.isVisible().catch(() => false);
  if (stillOpen) {
    await clickSendButton(page);
    await handleSaveDraftPrompt(page);
  }

  // Save state again in case X rotated tokens.
  await context.storageState({ path: STORAGE_PATH });

  await page.waitForTimeout(3000);
  await browser.close();
}

loginAndTweet().catch((err) => {
  console.error(err);
  process.exit(1);
});
