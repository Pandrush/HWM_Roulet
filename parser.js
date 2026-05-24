const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const BASE_URL = 'https://daily.heroeswm.ru/roulette/spin-repeat.php';
const LIVE_URL = 'https://daily.heroeswm.ru/roulette/all.php';
const DEFAULT_SPIN_LIMIT = 100;
const PERIOD_DAYS = 31;
const RULES_PATH = path.join(__dirname, 'data', 'rules.json');
const REQUEST_DELAY_MS = 350;

const ALL_NUMBERS = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];

function numberToFilter(num) {
  if (num === '0') return 49;
  if (num === '00') return 50;
  return parseInt(num, 10) + 12;
}

function extractNextNumber(cellHtml) {
  const matches = [...cellHtml.matchAll(/>(\d+|00)</g)];
  if (matches.length < 2) return null;
  return matches[1][1];
}

function parseNextNumberTable(html) {
  const $ = cheerio.load(html);
  const tables = $('table.report');

  let nextTable = null;
  tables.each((_, table) => {
    const header = $(table).find('th').first().text().trim();
    if (header.includes('След')) {
      nextTable = $(table);
    }
  });

  if (!nextTable) return [];

  const rows = [];
  nextTable.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 3) return;

    const seqHtml = $(cells[0]).html() || '';
    const count31 = parseInt($(cells[1]).text().trim(), 10);
    const countAll = parseInt($(cells[2]).text().trim(), 10);
    const next = extractNextNumber(seqHtml);

    if (!next || Number.isNaN(count31)) return;
    rows.push({ next, count31, countAll });
  });

  rows.sort((a, b) => b.count31 - a.count31 || b.countAll - a.countAll);
  return rows;
}

function classifyRule(rows) {
  if (rows.length === 0) {
    return { bets: [], type: 'skip', note: 'нет данных' };
  }

  const topCount = rows[0].count31;
  const topRows = rows.filter(r => r.count31 === topCount);
  const topNumbers = topRows.map(r => r.next);

  if (topNumbers.length >= 5) {
    return {
      bets: topNumbers,
      type: 'skip',
      note: 'много равных исходов — лучше пропустить',
      stats: topRows,
    };
  }

  if (topNumbers.length >= 3) {
    return {
      bets: topNumbers,
      type: 'weak',
      note: 'слабый сигнал',
      stats: topRows,
    };
  }

  if (topNumbers.length === 2) {
    return { bets: topNumbers, type: 'hit', stats: topRows };
  }

  const second = rows.find(r => r.count31 < topCount);
  if (second && topCount - second.count31 <= 1) {
    return {
      bets: [topNumbers[0], second.next],
      type: 'normal',
      stats: [rows[0], second],
    };
  }

  return {
    bets: [topNumbers[0]],
    type: 'normal',
    stats: [rows[0]],
  };
}

function extractSpinNumber(cellHtml) {
  if (!cellHtml) return null;
  const m = cellHtml.match(/>(\d+|00)</);
  return m ? m[1] : null;
}

function parseRecentSpinsTable(html, limit = DEFAULT_SPIN_LIMIT) {
  const $ = cheerio.load(html);
  let spinTable = null;

  $('table.report').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => $(th).text().trim()).get();
    if (headers.includes('Выпало') && headers.includes('Время')) {
      spinTable = $(table);
      return false;
    }
  });

  if (!spinTable) {
    return [];
  }

  const spins = [];
  spinTable.find('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 3) return;

    const time = $(cells[0]).text().trim();
    const cellHtml = $(cells[1]).html() || '';
    let number = extractSpinNumber(cellHtml);
    if (!number) {
      number = $(cells[1]).text().trim();
      if (number !== '0' && number !== '00' && !/^\d+$/.test(number)) number = null;
    }
    const gamesAgo = parseInt($(cells[2]).text().trim(), 10);

    if (!time || !number || Number.isNaN(gamesAgo)) return;

    spins.push({
      id: `${time}|${number}`,
      time,
      number,
      gamesAgo,
    });
  });

  return spins.slice(0, limit);
}

async function fetchRecentSpins(limit = DEFAULT_SPIN_LIMIT) {
  try {
    const response = await axios.get(LIVE_URL, {
      responseType: 'arraybuffer',
      timeout: 20000,
      validateStatus: status => status >= 200 && status < 300,
      headers: {
        'User-Agent': 'RulyaParser/1.0 (personal stats tool)',
        Accept: 'text/html',
      },
    });

    if (!response.data?.byteLength) {
      throw new Error('Пустой ответ от HWM (all.php)');
    }

    const html = iconv.decode(Buffer.from(response.data), 'win1251');
    const spins = parseRecentSpinsTable(html, limit);

    return {
      fetchedAt: new Date().toISOString(),
      source: LIVE_URL,
      requested: limit,
      count: spins.length,
      spins,
    };
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      throw new Error('Таймаут при загрузке спинов с HWM');
    }
    if (err.response?.status) {
      throw new Error(`HWM вернул ошибку ${err.response.status}`);
    }
    throw new Error(err.message || 'Не удалось загрузить спины с HWM');
  }
}

async function fetchPage(number) {
  const filter = numberToFilter(number);
  const url = `${BASE_URL}?per=${PERIOD_DAYS}&filter=${filter}&num=0`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent': 'RulyaParser/1.0 (personal stats tool)',
      Accept: 'text/html',
    },
  });

  return iconv.decode(Buffer.from(response.data), 'win1251');
}

async function parseNumber(number) {
  const html = await fetchPage(number);
  const rows = parseNextNumberTable(html);
  const classified = classifyRule(rows);

  return {
    bets: classified.bets,
    type: classified.type,
    note: classified.note,
    topStats: (classified.stats || rows.slice(0, 3)).map(r => ({
      next: r.next,
      count31: r.count31,
      countAll: r.countAll,
    })),
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function refreshAllRules(onProgress) {
  const rules = {};
  const errors = [];

  for (let i = 0; i < ALL_NUMBERS.length; i++) {
    const num = ALL_NUMBERS[i];
    try {
      rules[num] = await parseNumber(num);
      onProgress?.({ current: i + 1, total: ALL_NUMBERS.length, number: num, ok: true });
    } catch (err) {
      errors.push({ number: num, error: err.message });
      onProgress?.({ current: i + 1, total: ALL_NUMBERS.length, number: num, ok: false });
    }

    if (i < ALL_NUMBERS.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    periodDays: PERIOD_DAYS,
    source: BASE_URL,
    rules,
    errors,
  };

  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.writeFileSync(RULES_PATH, JSON.stringify(payload, null, 2), 'utf8');

  return payload;
}

function loadRules() {
  try {
    if (!fs.existsSync(RULES_PATH)) return null;
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  ALL_NUMBERS,
  parseNumber,
  refreshAllRules,
  loadRules,
  fetchRecentSpins,
  parseRecentSpinsTable,
  RULES_PATH,
};
