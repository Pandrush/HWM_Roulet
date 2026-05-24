const path = require('path');
const express = require('express');
const cors = require('cors');
const { refreshAllRules, loadRules, fetchRecentSpins } = require('./parser');

const app = express();
const PORT = process.env.PORT || 3001;
const STATIC_DIR = path.join(__dirname, '..');

let refreshInProgress = false;
let lastRefreshProgress = null;

app.use(cors());
app.use(express.json());

app.use(express.static(STATIC_DIR));

app.get('/api/status', (_req, res) => {
  const data = loadRules();
  res.json({
    ready: Boolean(data?.rules),
    updatedAt: data?.updatedAt ?? null,
    periodDays: data?.periodDays ?? 31,
    rulesCount: data?.rules ? Object.keys(data.rules).length : 0,
    errors: data?.errors ?? [],
    refreshing: refreshInProgress,
    progress: lastRefreshProgress,
  });
});

app.get('/api/rules', (_req, res) => {
  const data = loadRules();
  if (!data?.rules) {
    return res.status(503).json({
      error: 'Правила ещё не загружены. Запустите POST /api/refresh',
    });
  }
  res.json(data);
});

app.get('/api/rules/:number', (req, res) => {
  const data = loadRules();
  const key = req.params.number;
  const rule = data?.rules?.[key];

  if (!rule) {
    return res.status(404).json({ error: `Нет правила для числа ${key}` });
  }

  res.json({ number: key, ...rule, updatedAt: data.updatedAt });
});

app.post('/api/refresh', async (_req, res) => {
  if (refreshInProgress) {
    return res.status(409).json({ error: 'Обновление уже выполняется', progress: lastRefreshProgress });
  }

  refreshInProgress = true;
  lastRefreshProgress = { current: 0, total: 38 };

  res.json({ started: true, message: 'Обновление запущено (~15–20 сек)' });

  try {
    const result = await refreshAllRules(progress => {
      lastRefreshProgress = progress;
    });
    lastRefreshProgress = null;
    console.log(`Rules updated: ${result.updatedAt}, errors: ${result.errors.length}`);
  } catch (err) {
    console.error('Refresh failed:', err);
  } finally {
    refreshInProgress = false;
  }
});

app.post('/api/refresh/sync', async (_req, res) => {
  if (refreshInProgress) {
    return res.status(409).json({ error: 'Обновление уже выполняется' });
  }

  refreshInProgress = true;
  try {
    const result = await refreshAllRules(progress => {
      lastRefreshProgress = progress;
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    refreshInProgress = false;
    lastRefreshProgress = null;
  }
});

app.get('/api/spins/recent', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 150);
    const data = await fetchRecentSpins(limit);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Ошибка загрузки спинов' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  const data = loadRules();
  console.log(`Руля API: http://localhost:${PORT}`);
  console.log(`Frontend:  http://localhost:${PORT}/index.html`);
  if (data?.updatedAt) {
    console.log(`Rules cache: ${data.updatedAt} (${Object.keys(data.rules).length} numbers)`);
  } else {
    console.log('Rules cache: empty — run POST /api/refresh/sync or npm run refresh');
  }
});
