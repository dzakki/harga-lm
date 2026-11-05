const puppeteer = require('puppeteer');

// logammulia.com was rebuilt as a Nuxt SPA. Its price APIs return encrypted
// payloads, so we read the rendered DOM instead.
const PRICE_URL = 'https://logammulia.com/harga-emas';
const HOME_URL = 'https://logammulia.com/';
const DENPASAR_BRANCH_CODE = '049'; // value of the "Butik Emas ANTAM Denpasar" radio in the "Pilih Butik" dialog
// Only the regular bars — Gift Series, Batik, Imlek, Idul Fitri, etc. live in other sections.
const REGULAR_SECTION_TITLE = 'Emas Batangan';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The site pops a "Harga hari ini pada Butik yang Anda pilih belum tersedia" modal
// on load that blocks clicks on the header; close any "OK" modal that is open.
async function dismissOkDialogs(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.v-dialog--active button').forEach((b) => {
      if (b.innerText.trim() === 'OK') b.click();
    });
  });
}

async function selectDenpasar(page) {
  await page.goto(PRICE_URL, { waitUntil: 'networkidle2', timeout: 180000 });
  await sleep(2000);
  await dismissOkDialogs(page);
  await sleep(1000);

  // Open the "Lokasi Butik" picker in the header.
  const opened = await page.evaluate(() => {
    const el = [...document.querySelectorAll('header *, .secondary-nav *')].find(
      (e) => e.children.length === 0 && (e.innerText || '').trim().startsWith('Butik Emas ANTAM'),
    );
    if (el) el.click();
    return !!el;
  });
  if (!opened) throw new Error('Location picker not found');

  const radio = `input[type=radio][value="${DENPASAR_BRANCH_CODE}"]`;
  await page.waitForSelector(radio, { timeout: 30000 });
  await page.evaluate((sel) => document.querySelector(sel).closest('label').click(), radio);
  await sleep(500);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.v-dialog--active button')].find(
      (b) => b.innerText.trim() === 'Pilih',
    );
    if (!btn) throw new Error('"Pilih" button not found');
    btn.click();
  });

  await page.waitForFunction(
    () => (document.querySelector('header')?.innerText || '').includes('Butik Emas ANTAM Denpasar'),
    { timeout: 30000 },
  );
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 60000 }).catch(() => {});
  await sleep(1000);
  await dismissOkDialogs(page);
}

// Reads the "Emas Batangan" price list (the first section under "Emas & Perak").
async function readRegularPrices(page) {
  return page.evaluate((title) => {
    const titleEl = [...document.querySelectorAll('div.font-weight-bold')].find(
      (d) => d.children.length === 0 && d.innerText.trim() === title,
    );
    if (!titleEl) return null;
    // Section wrapper is the closest ".py-6" block containing both title and rows.
    const section = titleEl.closest('.py-6');
    const rows = [...section.querySelectorAll('.d-flex.align-center.border-bottom-grey-2')];
    return rows.map((row) => {
      const cells = [...row.children].filter((c) => c.tagName === 'DIV').map((c) => c.innerText.trim());
      return cells;
    });
  }, REGULAR_SECTION_TITLE);
}

// Homepage "Harga Hari Ini" card: "Harga Jual Emas  Rp 2,357,000/gr".
async function readBuybackPerGram(page) {
  await page.goto(HOME_URL, { waitUntil: 'networkidle2', timeout: 180000 });
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/Harga Jual Emas\s+Rp\s*([\d.,]+)\s*\/\s*gr/i);
  if (!m) throw new Error('Buyback price not found on homepage');
  return parseInt(m[1].replace(/[^\d]/g, ''), 10);
}

const cleanRp = (s) => s.replace(/^Rp\s*/i, '').trim();
const formatNumber = (n) => Math.round(n).toLocaleString('en-US');

async function scrapeHargaEmas() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  );

  try {
    await selectDenpasar(page);
    const rows = await readRegularPrices(page);
    if (!rows || rows.length === 0) throw new Error('Emas Batangan price table not found');

    const entries = rows
      .filter((cells) => cells.length >= 3 && /gr$/i.test(cells[0]))
      .map((cells) => [
        cells[0].replace(/\s*gr$/i, '').trim(),
        {
          harga_dasar: cleanRp(cells[1]),
          harga_final: cleanRp(cells[cells.length - 1]),
          harga_buyback: null,
        },
      ]);
    if (entries.length === 0) throw new Error('Emas Batangan table had no rows');

    // The buyback rate is a single per-gram price that applies to all denominations.
    let pricePerGram = null;
    for (let attempt = 1; attempt <= 3 && pricePerGram === null; attempt++) {
      try {
        if (attempt > 1) await sleep(5000 * attempt);
        pricePerGram = await readBuybackPerGram(page);
        process.stderr.write(`[antam] buyback per gram: ${pricePerGram}\n`);
      } catch (e) {
        process.stderr.write(`[antam] buyback scrape attempt ${attempt} failed: ${e.message}\n`);
      }
    }
    if (pricePerGram !== null) {
      for (const [weight, prices] of entries) {
        prices.harga_buyback = formatNumber(pricePerGram * parseFloat(weight));
      }
    }

    entries.sort(([a], [b]) => parseFloat(a) - parseFloat(b));
    return new Map([['emas_batangan', entries]]);
  } finally {
    await browser.close();
  }
}

function toJson(data) {
  // data is a Map<string, Array<[weight, prices]>>
  // Build JSON string manually — avoids JS engine's integer-key hoisting.
  const categoryLines = [...data.entries()].map(([cat, entries]) => {
    const itemLines = entries.map(([w, v]) => `      "${w}": ${JSON.stringify(v)}`);
    return `  "${cat}": {\n${itemLines.join(',\n')}\n  }`;
  });
  return '{\n' + categoryLines.join(',\n') + '\n}';
}

async function main() {
  // logammulia.com's Cloudflare protection occasionally blocks a request mid-flow;
  // retrying the whole scrape with a fresh browser/session has been enough to clear it.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await scrapeHargaEmas();
      console.log(toJson(data));
      return;
    } catch (err) {
      process.stderr.write(`[antam] attempt ${attempt} failed: ${err.message}\n`);
      if (attempt === maxAttempts) {
        console.error('Scrape failed:', err.message);
        process.exit(1);
      }
      await sleep(10000 * attempt);
    }
  }
}

main();
