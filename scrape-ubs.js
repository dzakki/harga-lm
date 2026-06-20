const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const BUY_PAGES = [
  'https://ubslifestyle.com/fine-gold/logam-mulia-ubs/',
  'https://ubslifestyle.com/fine-gold/logam-mulia-ubs/page/2/',
];

const BUYBACK_URL = 'https://ubslifestyle.com/harga-buyback-hari-ini/';
const CATEGORY = 'lm_ubs';

async function scrapeAllPages() {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const entries = [];

  try {
    for (const url of BUY_PAGES) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector('.as-producttile', { timeout: 10000 });
      entries.push(...parsePage(await page.content()));
    }

    // Scrape buyback prices
    await page.goto(BUYBACK_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    const buybackMap = parseBuybackPage(await page.content());

    for (const entry of entries) {
      const [weight, prices] = entry;
      prices.harga_buyback = buybackMap.get(weight) || null;
    }
  } finally {
    await browser.close();
  }

  return entries;
}

function formatPrice(raw) {
  // raw is a plain number string e.g. "5483500" → "5.483.500"
  return Number(raw).toLocaleString('id-ID');
}

function parsePage(html) {
  const $ = cheerio.load(html);
  const entries = [];

  $('.as-producttile').each((_, el) => {
    const title = $(el).attr('data-product-title') || '';
    const priceRaw = $(el).attr('data-product-price') || '';

    // Extract weight: "ubs logam mulia 0.5 gram classic" → "0.5"
    const match = title.match(/(\d+(?:[.,]\d+)?)\s*gram/i);
    if (!match || !priceRaw) return;

    const berat = match[1].replace(',', '.');
    const price = formatPrice(priceRaw);

    entries.push([berat, { harga_dasar: price, harga_final: price, harga_buyback: null }]);
  });

  return entries;
}

// Returns Map<weight, buybackPrice> from the buyback page table
// Table columns: Pecahan | Harga Beli | Harga Jual (Buyback)
function parseBuybackPage(html) {
  const $ = cheerio.load(html);
  const map = new Map();

  $('table tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 3) return;

    const raw = $(cells.eq(0)).text().trim().replace(/\s*gr(?:am)?\.?/i, '').replace(',', '.').trim();
    if (!raw || isNaN(parseFloat(raw))) return;

    const priceRaw = $(cells.eq(2)).text().replace(/[^\d]/g, '');
    if (!priceRaw) return;

    map.set(raw, formatPrice(priceRaw));
  });

  return map;
}

function toJson(category, entries) {
  // Sort numerically then build JSON manually to preserve float-key order
  entries.sort(([a], [b]) => parseFloat(a) - parseFloat(b));

  const itemLines = entries.map(([w, v]) => `      "${w}": ${JSON.stringify(v)}`);
  const inner = `  "${category}": {\n${itemLines.join(',\n')}\n  }`;
  return '{\n' + inner + '\n}';
}

scrapeAllPages()
  .then((entries) => console.log(toJson(CATEGORY, entries)))
  .catch((err) => {
    console.error('Scrape failed:', err.message);
    process.exit(1);
  });
