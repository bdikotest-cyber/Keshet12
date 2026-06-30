// fetch-keshet12.js
// מדמה את ה-WebView החבוי שבאפליקציה: טוען את עמוד הלייב של mako עם דפדפן headless,
// מיירט את בקשת ה-m3u8 (עם ה-JWT הטרי), ושולח את ה-URL+Cookie ל-Cloudflare Worker.
//
// רץ ע"י GitHub Actions כל ~15 דקות (ראה .github/workflows/keshet12-refresh.yml)

const puppeteer = require('puppeteer');

const LIVE_PAGE_URL = 'https://www.mako.co.il/mako-vod-live-tv/VOD-6540b8dcb64fd31006.htm';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const M3U8_REGEX = /(mako\.co\.il|akamaized\.net|k12|keshet|cloudfront\.net|cdn-redge|mako|vod\.mako|cdn\.mako|mako-static).*\.(m3u8|m3u)/i;

const WORKER_UPDATE_URL = process.env.WORKER_UPDATE_URL; // לדוגמה: https://tv.ingestwalla.workers.dev/keshet12-update
const UPDATE_SECRET = process.env.UPDATE_SECRET;

// בדיוק כמו ב-Kotlin: רשימת חסימה לפרסום/אנליטיקס — מקצר דרמטית את הזמן עד לתפיסת ה-m3u8
const BLOCKED_DOMAIN_FRAGMENTS = [
  'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
  'google-analytics.com', 'analytics.google.com', 'googleadservices.com',
  'facebook.net', 'facebook.com/tr',
  'tiktok.com', 'tiktokw.us',
  'taboola.com', 'outbrain.com',
  'criteo.com', 'clarity.ms',
  'braze.eu', 'braze.com',
  'permutive.com',
  '3lift.com', 'rubiconproject.com', 'adnxs.com', 'smartadserver.com',
];

function isBlockedAdRequest(url) {
  const lower = url.toLowerCase();
  return BLOCKED_DOMAIN_FRAGMENTS.some(f => lower.includes(f));
}

async function main() {
  if (!WORKER_UPDATE_URL || !UPDATE_SECRET) {
    console.error('Missing WORKER_UPDATE_URL or UPDATE_SECRET env vars');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let capturedUrl = null;
  let capturedCookie = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(DESKTOP_UA);
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const url = req.url();

      if (isBlockedAdRequest(url)) {
        req.abort();
        return;
      }

      if (!capturedUrl && /\.(m3u8|m3u)(\?|$)/i.test(url) && M3U8_REGEX.test(url)) {
        capturedUrl = url;
        console.log('Captured m3u8 URL:', url.slice(0, 120));
      }

      req.continue();
    });

    console.log('Loading live page:', LIVE_PAGE_URL);
    await page.goto(LIVE_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // נותן לפלייר זמן לבקש את ה-m3u8 (כמו ב-onPageFinished+evaluateJavascript באפליקציה)
    try {
      await page.evaluate(() => {
        document.querySelectorAll('video').forEach(v => { try { v.play(); } catch (e) {} });
      });
    } catch (_) {}

    const deadline = Date.now() + 20000;
    while (!capturedUrl && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (!capturedUrl) {
      console.error('Timeout — no m3u8 captured. mako may have changed something.');
      process.exit(1);
    }

    // אוסף cookies (כמו CookieManager.getInstance().getCookie ב-Kotlin)
    const cookies = await page.cookies(LIVE_PAGE_URL);
    capturedCookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  } finally {
    await browser.close();
  }

  console.log('Sending update to Worker...');
  const resp = await fetch(WORKER_UPDATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Update-Secret': UPDATE_SECRET,
    },
    body: JSON.stringify({ url: capturedUrl, cookie: capturedCookie }),
  });

  if (!resp.ok) {
    console.error('Worker update failed:', resp.status, await resp.text());
    process.exit(1);
  }

  console.log('Worker updated successfully.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
