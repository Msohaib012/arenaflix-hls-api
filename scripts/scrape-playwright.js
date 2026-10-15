#!/usr/bin/env node
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEST_MOVIES = [1007757, 550, 27205, 558, 969681];
const BASE_DIR = path.join(__dirname, '..', 'hls');

async function scrapeVideasy(page, tmdbId) {
  const m3u8Urls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('.m3u8') && response.status() === 200) {
      if (!m3u8Urls.includes(url)) {
        m3u8Urls.push(url);
        console.log(`  Found m3u8: ${url.substring(0, 80)}...`);
      }
    }
  });
  try {
    const url = `https://player.videasy.net/movie/${tmdbId}`;
    console.log(`  Visiting: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(8000);
    try {
      await page.click('button[class*="play"], [aria-label*="Play"]', { timeout: 3000 });
      await page.waitForTimeout(5000);
    } catch (e) {}
    return m3u8Urls[0] || null;
  } catch (e) {
    console.log(`  Videasy failed: ${e.message}`);
    return null;
  }
}

async function scrapeVidSrc(page, tmdbId) {
  const m3u8Urls = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('.m3u8') && response.status() === 200) {
      if (!m3u8Urls.includes(url)) m3u8Urls.push(url);
    }
  });
  const domains = ['https://vidsrc.pm', 'https://vidsrc.to'];
  for (const domain of domains) {
    try {
      await page.goto(`${domain}/embed/movie/${tmdbId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(8000);
      if (m3u8Urls.length > 0) return m3u8Urls[0];
    } catch (e) {}
  }
  return m3u8Urls[0] || null;
}

async function scrapeMovie(browser, tmdbId) {
  console.log(`\nScraping movie ${tmdbId}...`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  let url = await scrapeVideasy(page, tmdbId);
  if (!url) {
    console.log(`  Trying VidSrc fallback...`);
    url = await scrapeVidSrc(page, tmdbId);
  }
  await context.close();
  return url;
}

async function main() {
  fs.mkdirSync(path.join(BASE_DIR, 'movie'), { recursive: true });
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  let success = 0;
  for (const tmdbId of TEST_MOVIES) {
    const url = await scrapeMovie(browser, tmdbId);
    if (url) {
      fs.writeFileSync(path.join(BASE_DIR, 'movie', String(tmdbId)), url);
      console.log(`  ✓ Saved hls/movie/${tmdbId}`);
      success++;
    } else {
      console.log(`  ✗ No URL for ${tmdbId}`);
    }
  }
  await browser.close();
  console.log(`\nDone: ${success}/${TEST_MOVIES.length}`);
  process.exit(success > 0 ? 0 : 1);
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
