# Arenaflix HLS Scraper

Independent HLS URL scraper for Arenaflix player.

**Status:** Research phase - isolated from main player

## How it works
1. GitHub Actions runs daily (2 AM UTC)
2. Playwright scraper loads embed pages in headless Chromium
3. Sniffs network traffic for `.m3u8` URLs
4. URLs saved to `hls/movie/{tmdbId}` and `hls/tv/{id}/S{season}.json`
5. Player fetches from this repo (with fallback to Watchout2025)

## Why headless browser?
Simple HTTP scraping fails because:
- Videasy uses Cloudflare Turnstile protection
- m3u8 URLs are loaded via JavaScript (not in static HTML)
- Real browser passes protection and executes JS

## Structure
```
hls/
  movie/
    {tmdbId}          # Contains direct HLS URL (plain text)
  tv/
    {tmdbId}/
      S{season}.json  # JSON: {"1": "url", "2": "url", ...}
scripts/
  scrape-playwright.js  # Main scraper (Playwright + Chromium)
  scrape.py             # Simple HTTP scraper (fallback, limited)
.github/
  workflows/
    scrape.yml        # Daily cron
RESEARCH.md           # Detailed research findings
```

## API
- Movie: `https://raw.githubusercontent.com/{user}/arenaflix-hls-api/main/hls/movie/{tmdbId}`
- TV: `https://raw.githubusercontent.com/{user}/arenaflix-hls-api/main/hls/tv/{tmdbId}/S{season}.json`

## Setup
1. Create GitHub repo (e.g., `arenaflix-hls-api`)
2. Push this code
3. GitHub Actions will run daily automatically
4. Update player to fetch from your repo first, Watchout2025 as fallback

## Local testing
```bash
npm install
npx playwright install chromium
node scripts/scrape-playwright.js
```

## Sources
- **Primary:** Videasy (`player.videasy.net`) - Has Hindi+English audio
- **Fallback:** VidSrc (`vidsrc.pm`, `vidsrc.to`)

See RESEARCH.md for detailed findings.
