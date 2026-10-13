// Headless screenshots of app nodes as rendered by the PWA (Playwright on the hub).
import { chromium, type Browser } from 'playwright-core';
import type { HubConfig } from '../config.js';
import { log } from '../events.js';

const L = log('shot');

export interface Shot {
  png: Buffer;
  consoleErrors: string[];
}

export class Shooter {
  private browser?: Promise<Browser>;
  constructor(private cfg: HubConfig, private token: string) {}

  private get(): Promise<Browser> {
    if (!this.browser)
      this.browser = chromium.launch({ executablePath: this.cfg.screenshot.chromiumPath || undefined, args: ['--no-sandbox'] }).catch((e) => {
        this.browser = undefined;
        throw e;
      });
    return this.browser;
  }

  async shoot(nodeId: string, size?: { width: number; height: number }): Promise<Shot> {
    const b = await this.get();
    const url = new URL(this.cfg.publicUrl);
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: (size?.width ?? 640) + 40, height: (size?.height ?? 420) + 40 }, deviceScaleFactor: 1 });
    await ctx.addCookies([{ name: 'hub_token', value: this.token, domain: url.hostname, path: '/', secure: url.protocol === 'https:', httpOnly: true, sameSite: 'Strict' }]);
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 300)));
    try {
      await page.goto(`${this.cfg.publicUrl.replace(/\/$/, '')}/?shot=${encodeURIComponent(nodeId)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const el = page.locator('[data-testid="app-node"]').first();
      await el.waitFor({ timeout: 15000 });
      try {
        await page.locator('[data-app-ready="1"]').first().waitFor({ timeout: 10000 });
      } catch {
        consoleErrors.push('app view did not complete ui/initialize within 10 s');
      }
      await page.waitForTimeout(1300); // first status poll + paint
      const png = await el.screenshot({ timeout: 10000 });
      return { png, consoleErrors };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async close() {
    if (this.browser) (await this.browser).close().catch(() => {});
  }
}

export { L as shotLog };
