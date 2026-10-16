#!/usr/bin/env node
/**
 * Arenaflix HLS Scraper - Playwright version
 * Uses headless Chromium to extract m3u8 URLs from embed pages.
 * Designed to run on GitHub Actions (Chrome pre-installed).
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Test movies - expand this list for production
const TEST_MOVIES = [
  1007757,  // Swapped
  550,      // Fight Club
  27205,    // Inception
  558,      // Spider-Man 2
  969681,   // Test movie
];

const BASE_DIR = path.join(__dirname, '..', 'hls');

/**
 * Extract direct URL from proxy URLs like:
 * https://p1.mov2day.xyz/proxy?url=<encoded>&data=<b64>&type=...
 * Returns the decoded direct URL, or the original if not a proxy URL.
 */
function extractDirectUrl(url) {
  try {
    if (url.includes('/proxy?url=')) {
      const u = new URL(url);
      const direct = u.searchParams.get('url');
      if (direct && direct.startsWith('http')) {
        console.log(`  Extracted direct URL from proxy`);
        return direct;
      }
    }
  } catch (e) {}
  return url;
}

/**
 * Extract m3u8 URL from Videasy embed page
 */
async function scrapeVideasy(page, tmdbId) {
  const m3u8Urls = [];

  // Listen for network responses
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
    // Wait for player to load and make requests
    await page.waitForTimeout(8000);

    // Try to trigger playback if there's a play button
    try {
      await page.click('button[class*="play"], [aria-label*="Play"]', { timeout: 3000 });
      await page.waitForTimeout(5000);
    } catch (e) {
      // No play button or already playing
    }

    return m3u8Urls[0] || null;
  } catch (e) {
    console.log(`  Videasy failed: ${e.message}`);
    return null;
  }
}

/**
 * Extract m3u8 URL from VidSrc embed page
 */
async function scrapeVidSrc(page, tmdbId) {
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

  const domains = ['https://vidsrc.pm', 'https://vidsrc.to'];

  for (const domain of domains) {
    try {
      const url = `${domain}/embed/movie/${tmdbId}`;
      console.log(`  Trying: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(8000);
      if (m3u8Urls.length > 0) return m3u8Urls[0];
    } catch (e) {
      console.log(`  ${domain} failed: ${e.message}`);
    }
  }
  return m3u8Urls[0] || null;
}

async function scrapeMovie(browser, tmdbId) {
  console.log(`\nScraping movie ${tmdbId}...`);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Try Videasy first (has Hindi+English audio)
  let url = await scrapeVideasy(page, tmdbId);

  // Fallback to VidSrc
  if (!url) {
    console.log(`  Trying VidSrc fallback...`);
    url = await scrapeVidSrc(page, tmdbId);
  }

  // Extract direct URL from proxy URLs (proxies get 403, direct works with headers)
  if (url) url = extractDirectUrl(url);

  await context.close();
  return url;
}

async function main() {
  // Ensure directories exist
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
      const filePath = path.join(BASE_DIR, 'movie', String(tmdbId));
      fs.writeFileSync(filePath, url);
      console.log(`  ✓ Saved to hls/movie/${tmdbId}`);
      success++;
    } else {
      console.log(`  ✗ No URL found for ${tmdbId}`);
    }
  }

  await browser.close();
  console.log(`\nDone: ${success}/${TEST_MOVIES.length} scraped`);

  // Exit with error if nothing scraped (for CI visibility)
  process.exit(success > 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
