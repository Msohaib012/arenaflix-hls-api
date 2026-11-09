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
 * Videasy direct API (Nov 2026): the player page no longer requests any
 * .m3u8 — it fetches an encrypted payload from api.speedracelight.com
 * and decrypts it locally. This mirrors the current open-source
 * extractors (MaxStream's VideasyExtractor, TMDB-Embed-API's
 * providers/videasy.js): GET /seed?mediaId=, then
 * /{route}/sources-with-title?...&enc=2&seed=, then XOR-decrypt with
 * the seed cipher below (plaintext starts with the "mvm1" magic).
 */
const VIDEASY_API = 'https://api.speedracelight.com';
const VIDEASY_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://player.videasy.to',
  'Referer': 'https://player.videasy.to/',
};
const VIDEASY_ROUTES = ['cdn', 'm4uhd', 'lamovie', 'meine'];
const _MAGIC = [109, 118, 109, 49]; // "mvm1"
const _HASH_TABLE = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580];
const _u32x = x => x >>> 0;
const _mul32 = (a, b) => Math.imul(a, b) >>> 0;
function _rotl32(x, n) { x >>>= 0; n &= 31; return n === 0 ? x : ((x << n) | (x >>> (32 - n))) >>> 0; }
function _hash32(x) { x = _u32x(x); x ^= x >>> 16; x = _mul32(x, 2246822507); x ^= x >>> 13; x = _mul32(x, 3266489909); x ^= x >>> 16; return _u32x(x); }
function _fnv1a(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = _mul32(h ^ str.charCodeAt(i), 16777619); return _hash32(h); }
function _initStream(seed, secondKey) {
  const S = new Array(61);
  let a = _u32x(_hash32(_fnv1a(seed) ^ _hash32(_u32x((secondKey >>> 0) ^ 2654435769))));
  for (let i = 0; i < 8; i++) {
    if ((i * (i + 1) & 1) === 0) {
      const idx = a % 61;
      a = _rotl32(a + _u32x(2654435769), 7 + (7 & i));
      S[idx] = _u32x(a ^ _hash32(a));
      a = _hash32(_u32x(a + idx));
    } else {
      S[i] = _HASH_TABLE[15 & i];
    }
  }
  return { S, acc: _u32x(_hash32(2779096485 ^ a)) };
}
function _nextByte(st, ctr) {
  const r = st.S; const o = st.acc; const n = o % 61;
  const inSet = 0 - Number(n in r);
  const d = r[n] >>> 0;
  const x = _u32x(d ^ _mul32(2654435769, ctr + 1));
  const y = _u32x((o ^ x) | (o & x & inSet));
  const no = _hash32(_u32x(_rotl32(_u32x(y + o), 31 & n) ^ _rotl32(o, 31 & Math.imul(n, 7))) + 2654435769);
  r[n] = no >>> 0; st.acc = no; return no >>> 0;
}
function _keystream(seed, secondKey, len) {
  const st = _initStream(seed, secondKey);
  const out = new Uint8Array(len); let ctr = 0;
  for (let i = 0; i < len;) {
    const b = _nextByte(st, ctr++);
    out[i++] = 255 & b;
    if (i < len) out[i++] = (b >>> 8) & 255;
    if (i < len) out[i++] = (b >>> 16) & 255;
    if (i < len) out[i++] = (b >>> 24) & 255;
  }
  return out;
}
function decryptVideasyPayload(payload, seed, secondKey) {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(4 * Math.ceil(payload.length / 4), '=');
  const data = Buffer.from(b64, 'base64');
  const ks = _keystream(seed, secondKey, data.length);
  for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
  for (let i = 0; i < _MAGIC.length; i++) {
    if (data[i] !== _MAGIC[i]) throw new Error('Invalid encrypted payload');
  }
  return data.subarray(_MAGIC.length).toString('utf8');
}

async function scrapeVideasyApi(tmdbId) {
  try {
    const seedRes = await fetch(`${VIDEASY_API}/seed?mediaId=${tmdbId}`, { headers: VIDEASY_API_HEADERS });
    const seedText = await seedRes.text();
    console.log(`  Videasy API seed: HTTP ${seedRes.status}`);
    if (!seedRes.ok) return null;
    const seed = JSON.parse(seedText).seed;
    if (!seed) return null;
    for (const route of VIDEASY_ROUTES) {
      try {
        const url = `${VIDEASY_API}/${route}/sources-with-title?mediaType=movie&tmdbId=${tmdbId}&enc=2&seed=${encodeURIComponent(seed)}`;
        const res = await fetch(url, { headers: VIDEASY_API_HEADERS });
        const text = await res.text();
        if (!res.ok || !text || text.length < 20 || text.startsWith('<')) {
          console.log(`  Videasy API ${route}: HTTP ${res.status}, no payload`);
          continue;
        }
        const data = JSON.parse(decryptVideasyPayload(text, seed, String(tmdbId)));
        const sources = Array.isArray(data.sources) ? data.sources.filter(s => s && s.url) : [];
        if (!sources.length) {
          console.log(`  Videasy API ${route}: decrypted, 0 sources`);
          continue;
        }
        if (data.playlist) {
          console.log(`  Videasy API ${route}: playlist found`);
          return data.playlist;
        }
        sources.sort((a, b) => (parseInt(String(b.quality || '').match(/\d{3,4}/)?.[0] || '0', 10)
          - parseInt(String(a.quality || '').match(/\d{3,4}/)?.[0] || '0', 10)));
        console.log(`  Videasy API ${route}: ${sources.length} source(s), best ${sources[0].quality || 'Auto'}`);
        return sources[0].url;
      } catch (e) {
        console.log(`  Videasy API ${route} failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`  Videasy API failed: ${e.message}`);
  }
  return null;
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

  // Videasy moved player.videasy.net -> player.videasy.to in early
  // Nov 2026 (the .net host 301-redirects to .to behind a broken TLS
  // setup, which killed every run from 2026-11-07). Try the current
  // domain first, then the old one in case it is ever restored.
  const hosts = ['https://player.videasy.to', 'https://player.videasy.net'];
  for (const host of hosts) {
   try {
    const url = `${host}/movie/${tmdbId}`;
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

    if (m3u8Urls.length > 0) return m3u8Urls[0];
  } catch (e) {
    console.log(`  Videasy failed on ${host}: ${e.message}`);
  }
  }
  return m3u8Urls[0] || null;
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
      // The embed now opens on a poster whose Play control sits inside
      // nested iframes — a top-frame click never reaches it. Try every
      // frame's play control, then a plain centre click.
      for (const frame of page.frames()) {
        try {
          await frame.click('button[class*="play"], [aria-label*="Play"], [class*="play-button"], div[class*="play"]', { timeout: 1500 });
          console.log(`  Clicked play inside a frame on ${domain}`);
          break;
        } catch (e) { /* not this frame */ }
      }
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
    // Embed hosts keep breaking their TLS chains (Videasy .net threw
    // ERR_CERT_AUTHORITY_INVALID on the runner); the scraper only
    // watches responses for .m3u8 URLs, so TLS errors must not abort
    // the navigation before the player can load.
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // Videasy direct API first (the page lane below is a legacy fallback —
  // since the .to move the player resolves streams via the encrypted
  // API, not via page network traffic)
  let url = await scrapeVideasyApi(tmdbId);

  // Legacy Videasy page scrape
  if (!url) {
    url = await scrapeVideasy(page, tmdbId);
  }

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
