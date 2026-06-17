const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../utils/logger');

const logger = createLogger('puppeteer');

const WHATSAPP_WEB_URL = 'https://web.whatsapp.com';

class PuppeteerHandler {
  constructor(sessionDir) {
    this.sessionDir = sessionDir;
    this.browser = null;
    this.page = null;
  }

  async launch() {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }

    const executablePath = this._findChromiumPath();
    if (!executablePath) {
      throw new Error(
        'Chromium not found. Install Google Chrome or Chromium and ensure it is accessible.'
      );
    }

    logger.info('Launching browser', { executablePath, sessionDir: this.sessionDir });

    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: this.sessionDir,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1200,800',
      ],
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());

    this.browser.on('disconnected', () => {
      logger.warn('Browser disconnected');
      this.browser = null;
      this.page = null;
    });

    return this.page;
  }

  async openWhatsApp() {
    if (!this.page) throw new Error('Browser not launched');
    await this.page.goto(WHATSAPP_WEB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    logger.info('Navigated to WhatsApp Web');
  }

  async waitForLogin(timeoutMs = 120000) {
    logger.info('Waiting for WhatsApp login...');
    await this.page.waitForFunction(
      () => {
        return (
          document.querySelector('[data-testid="chat-list"]') ||
          document.querySelector('._ahlk') ||
          document.querySelector('[data-testid="default-user"]') ||
          document.querySelector('div[data-js-navbar-status]') ||
          (document.title && document.title.includes('WhatsApp'))
        );
      },
      { timeout: timeoutMs, polling: 1500 }
    );
    await this._sleep(2000);
    logger.info('WhatsApp login confirmed');
  }

  async isLoggedIn() {
    try {
      const result = await this.page.evaluate(() => {
        return !!(
          document.querySelector('[data-testid="chat-list"]') ||
          document.querySelector('._ahlk') ||
          document.querySelector('[data-testid="default-user"]')
        );
      });
      return result;
    } catch {
      return false;
    }
  }

  async openChat(phone) {
    const cleaned = phone.replace(/\D/g, '');
    const url = `${WHATSAPP_WEB_URL}/send?phone=${cleaned}`;
    logger.info('Opening chat', { phone: cleaned });

    // Navigate to the click-to-chat URL for this contact.
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Give WhatsApp a moment to start resolving the number.
    await this._sleep(2500);

    const isInvalid = await this._checkInvalidPhone();
    if (isInvalid) {
      throw new Error(`Phone number not registered on WhatsApp: ${phone}`);
    }

    // The /send?phone= URL shows a brief "starting chat" screen and then
    // WhatsApp internally REDIRECTS to the real conversation. That redirect
    // is effectively a reload. If we type the message (or the user presses
    // Enter) before it finishes, WhatsApp reloads and the message is lost --
    // which looks like WhatsApp "restarting" instead of sending. So we wait
    // for the URL to leave /send (the redirect) before doing anything. This
    // is non-blocking: if it never changes we still continue after a short
    // timeout.
    await this.page
      .waitForFunction(
        () => !window.location.href.includes('/send'),
        { timeout: 10000, polling: 400 }
      )
      .catch(() => {});

    // Now wait for the compose box of the settled conversation.
    await this._waitForChatBox(20000);

    // Final settle so no late reload happens while the message is typed and
    // while the user is clicking Send.
    await this._sleep(1500);
  }

  async _checkInvalidPhone() {
    try {
      return await this.page.evaluate(() => {
        const body = document.body.innerText;
        return (
          body.includes('Phone number shared via url is invalid') ||
          body.includes('not registered') ||
          body.includes('invalid phone')
        );
      });
    } catch {
      return false;
    }
  }

  async _waitForChatBox(timeoutMs = 15000) {
    await this.page.waitForFunction(
      () => {
        return !!(
          document.querySelector('[data-testid="conversation-compose-box-input"]') ||
          document.querySelector('div[contenteditable="true"][data-tab]') ||
          document.querySelector('footer div[contenteditable="true"]')
        );
      },
      { timeout: timeoutMs, polling: 800 }
    );
    await this._sleep(1000);
  }

  async typeMessage(text) {
    const box = await this._getChatBox();
    if (!box) throw new Error('Message input box not found');

    await box.click();
    await this._sleep(300);

    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('a');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.press('Backspace');
    await this._sleep(200);

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await box.type(lines[i], { delay: 20 });
      if (i < lines.length - 1) {
        await this.page.keyboard.down('Shift');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Shift');
      }
    }

    logger.info('Message typed');
  }

  async _getChatBox() {
    const selectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = await this.page.$(sel);
      if (el) return el;
    }
    return null;
  }

  async attachFile(filePath, type) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    logger.info('Attaching file', { filePath, type });

    const attachBtn = await this._findAttachButton();
    if (!attachBtn) throw new Error('Attach button not found');

    await attachBtn.click();
    await this._sleep(900);

    // Newer WhatsApp Web only exposes a single persistent image/* input
    // (the sticker/quick-image one) until you click a specific menu item.
    // Uploading to it makes images send as STICKERS. To send a real photo we
    // click the "Photos & videos" menu item and intercept the file chooser
    // it triggers.
    let attached = false;
    try {
      const [fileChooser] = await Promise.all([
        this.page.waitForFileChooser({ timeout: 8000 }),
        this._clickPhotosMenuItem(),
      ]);
      await fileChooser.accept([filePath]);
      attached = true;
      logger.info('File attached via Photos & Videos chooser');
    } catch (err) {
      logger.warn('Photos & Videos chooser failed, trying direct input', { err: err.message });
    }

    if (!attached) {
      const fileInput = await this._findMediaInput();
      if (!fileInput) {
        await this._pressEscape();
        throw new Error('No suitable file input found');
      }
      await fileInput.uploadFile(filePath);
    }

    await this._sleep(2500);

    const captionBox = await this.page.$('[data-testid="media-caption-input-container"] div[contenteditable="true"]');
    if (captionBox) {
      await captionBox.click();
    }

    await this._sleep(1000);
    logger.info('File attached', { type });
  }

  async _clickPhotosMenuItem() {
    await this._sleep(200);
    const clicked = await this.page.evaluate(() => {
      const re = /photos?\s*(&|and)?\s*videos?/i;
      const items = Array.from(
        document.querySelectorAll('li, div[role="button"], div[role="menuitem"], button, span')
      );
      let best = null;
      for (const el of items) {
        const txt = (el.textContent || '').trim();
        if (re.test(txt) && txt.length < 60) {
          if (!best || txt.length < (best.textContent || '').trim().length) best = el;
        }
      }
      if (best) {
        const target = best.closest('li, div[role="button"], div[role="menuitem"], button') || best;
        target.click();
        return true;
      }
      return false;
    });
    if (!clicked) {
      throw new Error('"Photos & videos" menu item not found');
    }
    await this._sleep(300);
  }

  async _findMediaInput() {
    const inputs = await this.page.$$('input[type="file"]');
    const info = [];
    for (let i = 0; i < inputs.length; i++) {
      const accept = await this.page.evaluate((el) => el.getAttribute('accept') || '', inputs[i]);
      info.push(`#${i} accept="${accept}"`);
    }
    logger.info('FILE INPUTS DETECTED', { count: inputs.length, inputs: info });

    for (let i = 0; i < inputs.length; i++) {
      if (/video/i.test(info[i])) return inputs[i];
    }
    for (let i = 0; i < inputs.length; i++) {
      if (/image/i.test(info[i])) return inputs[i];
    }
    return inputs.length ? inputs[0] : null;
  }

  async _findAttachButton() {
    const selectors = [
      '[data-testid="attach-menu-icon"]',
      '[data-testid="clip"]',
      'span[data-icon="attach-menu-plus"]',
      'span[data-icon="plus-rounded"]',
      'span[data-icon="plus"]',
      'button[aria-label="Attach"]',
      'div[title="Attach"]',
    ];
    for (const sel of selectors) {
      const el = await this.page.$(sel);
      if (el) return el;
    }
    return null;
  }

  async confirmFilePreviewAndPrepare() {
    await this._sleep(500);
  }

  async _pressEscape() {
    await this.page.keyboard.press('Escape');
    await this._sleep(300);
  }

  async isBrowserAlive() {
    try {
      if (!this.browser || !this.page) return false;
      await this.page.evaluate(() => true);
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (err) {
      logger.warn('Error closing browser', { err: err.message });
    } finally {
      this.browser = null;
      this.page = null;
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _findChromiumPath() {
    const platform = process.platform;
    const candidates = [];

    if (platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Chromium\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      );
    } else if (platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      );
    } else {
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
      );
    }

    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }
}

module.exports = PuppeteerHandler;
