// A headless Edge of its own (a temp profile, never the person's browser) for
// looking at the UI. Edge is on every Windows 11 machine and is what the
// desktop app's web view is built on.
//
//   import { withPage } from './browser.mjs';
//   await withPage('http://127.0.0.1:5191/#/projects', async (page) => {
//     await page.waitForSelector('.page');
//     await page.screenshot({ path: 'projects.png' });
//   });
import { chromium } from 'playwright-core';

export async function withPage(url, fn, { width = 1280, height = 800, scheme = 'dark' } = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errors.push(`console: ${m.text()}`));
    await page.goto(url);
    const result = await fn(page);
    if (errors.length) console.log('page errors:', JSON.stringify(errors.slice(0, 8)));
    return result;
  } finally {
    await browser.close();
  }
}
