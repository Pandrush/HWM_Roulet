const MIN_BET = 375;
const MAX_TOTAL_BET = 21000;
const API_BASE = window.RULYA_API || '';
const POLL_INTERVAL_MS = 90_000;
const MAX_SPIN_HISTORY = 1000;
const MAX_SPIN_HISTORY_UI = 100;
const SPIN_FETCH_LIMIT = 100;
const MAX_PROCESSED_IDS = 1100;
const MIN_HISTORY_FOR_AI = 50;
const MAX_RISK_PERCENT = 0.10;
const STATE_VERSION = 5;

const STORAGE_STATE_KEY = 'rulya_state';
const STORAGE_HWM_KEY = 'rulya_hwm_rules';

let dynamicRules = {};
let rulesMeta = {
  updatedAt: null,
  periodDays: 31,
  loading: true,
  fromCache: false,
  refreshing: false,
  progress: null,
  error: null,
};

let pollTimer = null;
let pollInFlight = false;

let state = {
  missStreak: 0,
  spinHistory: [],
  processedSpinIds: [],
  pendingSuggestion: null,
  lastSpinNumber: null,
  autopilotEnabled: true,
  lastPollAt: null,
  balance: null,
};

// ─── localStorage ────────────────────────────────────────────────────────────

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_STATE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);

    if (parsed.version !== STATE_VERSION) {
      state.missStreak = parsed.missStreak ?? 0;
      state.spinHistory = (parsed.spinHistory ?? []).slice(0, MAX_SPIN_HISTORY);
      state.processedSpinIds = parsed.processedSpinIds ?? [];
      state.pendingSuggestion = parsed.pendingSuggestion ?? null;
      state.lastSpinNumber = parsed.lastSpinNumber ?? null;
      state.autopilotEnabled = parsed.autopilotEnabled ?? true;
      state.lastPollAt = parsed.lastPollAt ?? null;
      state.balance = parsed.balance ?? null;
      saveState();
      return;
    }

    state.missStreak = parsed.missStreak ?? 0;
    state.spinHistory = parsed.spinHistory ?? [];
    state.processedSpinIds = parsed.processedSpinIds ?? [];
    state.pendingSuggestion = parsed.pendingSuggestion ?? null;
    state.lastSpinNumber = parsed.lastSpinNumber ?? null;
    state.autopilotEnabled = parsed.autopilotEnabled ?? true;
    state.lastPollAt = parsed.lastPollAt ?? null;
    state.balance = parsed.balance ?? null;
  } catch (_) {}
  normalizeSpinHistory();
}

function saveState() {
  try {
    normalizeSpinHistory();
    const pending = state.pendingSuggestion
      ? {
          afterNumber: state.pendingSuggestion.afterNumber,
          bets: state.pendingSuggestion.bets,
          type: state.pendingSuggestion.type,
        }
      : null;

    const payload = JSON.stringify({
      version: STATE_VERSION,
      missStreak: state.missStreak,
      spinHistory: state.spinHistory.map(s => ({
        id: s.id,
        number: s.number,
        time: s.time,
        gamesAgo: s.gamesAgo ?? null,
        won: s.won ?? null,
        suggestedBets: s.suggestedBets ?? [],
        afterNumber: s.afterNumber ?? null,
        manual: s.manual ?? false,
      })),
      processedSpinIds: state.processedSpinIds.slice(0, MAX_PROCESSED_IDS),
      pendingSuggestion: pending,
      lastSpinNumber: state.lastSpinNumber,
      autopilotEnabled: state.autopilotEnabled,
      lastPollAt: state.lastPollAt,
      balance: state.balance,
    });

    localStorage.setItem(STORAGE_STATE_KEY, payload);
  } catch (err) {
    if (err?.name === 'QuotaExceededError' && state.spinHistory.length > 200) {
      state.spinHistory = state.spinHistory.slice(0, 200);
      state.processedSpinIds = state.processedSpinIds.slice(0, 200);
      try {
        localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify({
          version: STATE_VERSION,
          missStreak: state.missStreak,
          spinHistory: state.spinHistory,
          processedSpinIds: state.processedSpinIds,
          pendingSuggestion: null,
          lastSpinNumber: state.lastSpinNumber,
          autopilotEnabled: state.autopilotEnabled,
          lastPollAt: state.lastPollAt,
          balance: state.balance,
        }));
      } catch (_) {}
    }
  }
}

function hardResetSpinState() {
  state.missStreak = 0;
  state.spinHistory = [];
  state.processedSpinIds = [];
  state.pendingSuggestion = null;
  state.lastSpinNumber = null;
  document.getElementById('lastNumber').value = '';
  document.getElementById('suggestionSection').hidden = true;
  saveState();
  renderSpinHistory();
  updateBetDisplay(0);
  renderAiAnalytics();
}

function loadHwmFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_HWM_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data?.rules || typeof data.rules !== 'object') return null;
    return data;
  } catch (_) {
    return null;
  }
}

function saveHwmToStorage(data) {
  const payload = {
    updatedAt: data.updatedAt || new Date().toISOString(),
    periodDays: data.periodDays ?? 31,
    source: data.source || 'https://daily.heroeswm.ru/roulette/spin-repeat.php',
    rules: data.rules,
    errors: data.errors || [],
  };
  localStorage.setItem(STORAGE_HWM_KEY, JSON.stringify(payload));
  return payload;
}

function applyHwmData(data, { fromCache = false } = {}) {
  dynamicRules = data.rules || {};
  rulesMeta.updatedAt = data.updatedAt;
  rulesMeta.periodDays = data.periodDays || 31;
  rulesMeta.fromCache = fromCache;
}

// ─── Правила ─────────────────────────────────────────────────────────────────

function normalizeNumber(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === '0' || trimmed === '00') return trimmed;
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 0 || n > 36) return null;
  return String(n);
}

function getRule(afterNumber) {
  if (dynamicRules[afterNumber]) {
    return { ...dynamicRules[afterNumber], source: 'hwm' };
  }
  return null;
}

function formatRulesStatus() {
  const el = document.getElementById('rulesStatus');
  if (!el) return;

  if (rulesMeta.loading) {
    el.textContent = 'Загрузка правил…';
    el.className = 'stats-text warn';
    return;
  }
  if (rulesMeta.refreshing) {
    const p = rulesMeta.progress;
    el.textContent = `Загрузка с heroeswm.ru${p ? ` (${p.current}/${p.total})` : ''}…`;
    el.className = 'stats-text warn';
    return;
  }
  if (rulesMeta.error && Object.keys(dynamicRules).length === 0) {
    el.textContent = rulesMeta.error;
    el.className = 'stats-text err';
    return;
  }
  if (rulesMeta.updatedAt) {
    const time = new Date(rulesMeta.updatedAt).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    el.textContent = `HWM ${rulesMeta.periodDays} дн. · ${time}`;
    el.className = 'stats-text ok';
    return;
  }
  el.textContent = 'Нет статистики — обновите с сайта';
  el.className = 'stats-text err';
}

function updateAutopilotStatus(extra = '') {
  const el = document.getElementById('autopilotStatus');
  const btn = document.getElementById('btnToggleAutopilot');
  if (!el) return;

  if (!state.autopilotEnabled) {
    el.textContent = '⏸ Автопилот на паузе';
    el.className = 'stats-text warn';
    if (btn) btn.textContent = 'Включить';
    return;
  }

  el.textContent = `🟢 Автопилот${extra}`;
  el.className = 'stats-text ok';
  if (btn) btn.textContent = 'Пауза';
}

function mergeAndPersistHwm(apiData) {
  const saved = saveHwmToStorage(apiData);
  applyHwmData(saved, { fromCache: false });
  rulesMeta.error = null;
}

function initRules() {
  rulesMeta.loading = true;
  formatRulesStatus();
  const cached = loadHwmFromStorage();
  if (cached) {
    applyHwmData(cached, { fromCache: true });
    rulesMeta.error = null;
  } else {
    dynamicRules = {};
    rulesMeta.error = 'Нет сохранённой статистики — нажмите «Обновить статистику»';
  }
  rulesMeta.loading = false;
  formatRulesStatus();
}

async function refreshRulesFromHwm() {
  if (!confirm('Загрузить статистику с heroeswm.ru (~20 сек)?')) return;

  const btn = document.getElementById('btnRefreshRules');
  btn.disabled = true;
  rulesMeta.refreshing = true;
  formatRulesStatus();

  try {
    const res = await fetch(`${API_BASE}/api/refresh/sync`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Сервер недоступен (cd server && npm start)');
    }
    mergeAndPersistHwm(await res.json());
    if (state.lastSpinNumber) showSuggestion(state.lastSpinNumber);
  } catch (err) {
    rulesMeta.error = err.message;
    alert('Ошибка: ' + err.message);
  } finally {
    rulesMeta.refreshing = false;
    btn.disabled = false;
    formatRulesStatus();
  }
}

function importHwmJsonFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.rules) throw new Error('Нет поля rules');
      mergeAndPersistHwm(data);
      formatRulesStatus();
      alert(`Импортировано ${Object.keys(data.rules).length} правил`);
    } catch (e) {
      alert('Ошибка JSON: ' + e.message);
    }
  };
  reader.readAsText(file);
}

// ─── AI-аналитика и умные ставки ─────────────────────────────────────────────

const AI_DEFAULTS = { avgMissStreak: 5, maxMissStreak: 10 };

function isResolvedBet(spin) {
  return spin.won === true || spin.won === false;
}

function analyzeBetHistory(history) {
  const resolved = history.filter(s => isResolvedBet(s) && s.suggestedBets?.length > 0);
  const chronological = [...resolved].reverse();

  let wins = 0;
  const missStreaks = [];
  let currentStreak = 0;
  let maxMissStreak = 0;

  for (const spin of chronological) {
    if (spin.won) {
      if (currentStreak > 0) missStreaks.push(currentStreak);
      maxMissStreak = Math.max(maxMissStreak, currentStreak);
      currentStreak = 0;
      wins += 1;
    } else {
      currentStreak += 1;
    }
  }
  if (currentStreak > 0) {
    missStreaks.push(currentStreak);
    maxMissStreak = Math.max(maxMissStreak, currentStreak);
  }

  const total = resolved.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const avgMissStreak = missStreaks.length > 0
    ? missStreaks.reduce((sum, n) => sum + n, 0) / missStreaks.length
    : AI_DEFAULTS.avgMissStreak;
  const effectiveMaxMiss = total > 0
    ? Math.max(maxMissStreak, Math.ceil(avgMissStreak))
    : AI_DEFAULTS.maxMissStreak;

  return {
    winRate,
    avgMissStreak,
    maxMissStreak: effectiveMaxMiss,
    sampleSize: total,
    databaseSize: history.length,
  };
}

function getAiStatus(currentMisses, avgMissStreak, maxMissStreak) {
  if (currentMisses < avgMissStreak) return 'Ожидание';
  if (maxMissStreak <= avgMissStreak) {
    return 'Повышенный риск — прогрессия запущена';
  }
  const progress = Math.min((currentMisses - avgMissStreak) / (maxMissStreak - avgMissStreak), 1);
  if (progress < 0.35) return 'Повышенный риск — прогрессия запущена';
  if (progress < 0.75) return 'Агрессивная прогрессия';
  return 'Максимальная прогрессия — пик дисперсии';
}

function applyBankrollCaps(perNumber, total, count, balance) {
  let p = perNumber;
  let t = total;
  let riskCapped = false;
  let balanceCapped = false;
  let maxBetCapped = false;

  if (balance != null && balance > 0) {
    const safeLimit = Math.floor(balance * MAX_RISK_PERCENT);
    const minTotal = MIN_BET * count;

    if (t > safeLimit) {
      riskCapped = true;
      t = Math.max(safeLimit, minTotal);
      p = Math.max(Math.floor(t / count), MIN_BET);
      t = p * count;
    }

    if (t > balance) {
      balanceCapped = true;
      p = Math.max(Math.floor(balance / count), MIN_BET);
      t = p * count;
    }
  }

  if (t > MAX_TOTAL_BET) {
    maxBetCapped = true;
    p = Math.max(Math.floor(MAX_TOTAL_BET / count), MIN_BET);
    t = p * count;
  }

  return { perNumber: p, total: t, riskCapped, balanceCapped, maxBetCapped };
}

function buildBetResult(perNumber, total, count, balance, multiplier, extras) {
  const caps = applyBankrollCaps(perNumber, total, count, balance);
  const bankrollWarning = (caps.riskCapped || caps.balanceCapped)
    ? '⚠️ Нехватка банка: ставка снижена для защиты капитала'
    : null;

  return {
    perNumber: caps.perNumber,
    total: caps.total,
    multiplier,
    capped: caps.maxBetCapped,
    riskCapped: caps.riskCapped,
    balanceCapped: caps.balanceCapped,
    bankrollWarning,
    ...extras,
  };
}

function calculateSmartBet(history, currentMisses, numbersCount = 1, currentBalance = null) {
  const count = Math.max(numbersCount, 1);
  const stats = analyzeBetHistory(history);
  const dbSize = history.length;

  if (dbSize < MIN_HISTORY_FOR_AI) {
    return buildBetResult(MIN_BET, MIN_BET * count, count, currentBalance, 1, {
      stats,
      status: `Разогрев алгоритма: сбор данных (${dbSize}/${MIN_HISTORY_FOR_AI})`,
      warmup: true,
    });
  }

  const { avgMissStreak, maxMissStreak } = stats;

  let multiplier = 1;
  if (currentMisses >= avgMissStreak) {
    if (maxMissStreak <= avgMissStreak) {
      multiplier = 1 + Math.min(currentMisses - avgMissStreak + 1, 3);
    } else {
      const excess = currentMisses - avgMissStreak;
      const range = maxMissStreak - avgMissStreak;
      const progress = Math.min(excess / range, 1);
      const steps = [1, 1.5, 2, 2.5, 3, 3.5, 4];
      const stepIndex = Math.min(Math.floor(progress * (steps.length - 1)) + 1, steps.length - 1);
      multiplier = steps[Math.max(stepIndex, 1)];
    }
  }

  const status = getAiStatus(currentMisses, avgMissStreak, maxMissStreak);
  const perNumber = Math.max(Math.round(MIN_BET * multiplier), MIN_BET);
  const total = perNumber * count;

  return buildBetResult(perNumber, total, count, currentBalance, multiplier, {
    stats,
    status,
    warmup: false,
  });
}

function calculateBet(numbersCount) {
  return calculateSmartBet(state.spinHistory, state.missStreak, numbersCount, state.balance);
}

function renderAiAnalytics(betCalc) {
  const sampleEl = document.getElementById('aiSampleSize');
  const winRateEl = document.getElementById('aiWinRate');
  const maxMissEl = document.getElementById('aiMaxMiss');
  const balanceEl = document.getElementById('aiBalance');
  const statusEl = document.getElementById('aiStatus');
  const metricsEl = document.querySelector('.ai-metrics');
  if (!sampleEl) return;

  const result = betCalc || calculateBet(1);
  const { stats, status, warmup, bankrollWarning } = result;
  const dbSize = state.spinHistory.length;

  sampleEl.textContent = `(база: ${dbSize} спинов)`;
  winRateEl.textContent = stats.sampleSize > 0 ? `${stats.winRate.toFixed(1)}%` : '—';
  maxMissEl.textContent = stats.sampleSize > 0 ? String(stats.maxMissStreak) : '—';
  if (balanceEl) {
    balanceEl.textContent = state.balance != null && state.balance > 0
      ? `${state.balance.toLocaleString('ru-RU')} 🪙`
      : '—';
  }

  if (metricsEl) metricsEl.classList.toggle('warmup', warmup);

  if (bankrollWarning) {
    statusEl.textContent = bankrollWarning;
    statusEl.className = 'ai-status active';
    return;
  }

  if (warmup) {
    statusEl.textContent = `Разогрев алгоритма: сбор данных (${dbSize}/${MIN_HISTORY_FOR_AI})`;
    statusEl.className = 'ai-status warmup';
    return;
  }

  statusEl.textContent = status;
  statusEl.className = 'ai-status' + (status.startsWith('Ожидание') ? '' : ' active');
}

function updateBalanceInput() {
  const input = document.getElementById('balanceInput');
  if (!input) return;
  input.value = state.balance != null && state.balance > 0 ? state.balance : '';
}

function applyBalanceFromResolution(pending, won) {
  if (state.balance == null || state.balance <= 0) return;
  if (!isActiveBet(pending)) return;

  const total = pending.betCalc?.total;
  if (!total) return;

  if (won) state.balance += total * 35;
  else state.balance -= total;

  state.balance = Math.max(0, Math.round(state.balance));
  saveState();
  updateBalanceInput();
}

// ─── Ставки (UI) ─────────────────────────────────────────────────────────────

function buildSuggestion(afterNumber) {
  const rule = getRule(afterNumber);
  if (!rule) {
    return { afterNumber, bets: [], type: 'unknown', betCalc: calculateBet(1) };
  }
  const bets = [...rule.bets];
  return {
    afterNumber,
    bets,
    type: rule.type,
    betCalc: calculateBet(bets.length || 1),
    rule,
  };
}

function showSuggestion(afterNumber) {
  const section = document.getElementById('suggestionSection');
  const skipWarning = document.getElementById('skipWarning');
  const badge = document.getElementById('signalBadge');
  const betsGrid = document.getElementById('betsGrid');
  const suggestion = buildSuggestion(afterNumber);
  const rule = suggestion.rule;

  document.getElementById('afterNumber').textContent = afterNumber;
  section.hidden = false;

  if (!rule) {
    badge.textContent = 'Нет правила';
    badge.className = 'badge weak';
    skipWarning.hidden = false;
    skipWarning.textContent = '⚠️ Нет правила для этого числа';
    betsGrid.innerHTML = '';
    state.pendingSuggestion = suggestion;
    updateBetDisplay(0);
    return;
  }

  const isSkip = rule.type === 'skip';
  const isWeak = rule.type === 'weak';
  skipWarning.hidden = !(isSkip || isWeak);
  if (isSkip) skipWarning.textContent = rule.note || '⚠️ Лучше пропустить';
  if (isWeak) skipWarning.textContent = rule.note || '⚠️ Слабый сигнал';

  badge.textContent = rule.type === 'hit' ? 'Хит' : isSkip ? 'Пропуск' : isWeak ? 'Слабый' : 'Ставка';
  badge.className = `badge ${rule.type === 'hit' ? 'hit' : isSkip || isWeak ? 'weak' : 'normal'}`;

  const { bets, betCalc } = suggestion;
  const statsMap = Object.fromEntries((rule.topStats || []).map(s => [s.next, s]));
  betsGrid.innerHTML = '';

  if (bets.length === 0) {
    betsGrid.innerHTML = '<p class="empty-history">Пропусти раунд</p>';
  } else {
    bets.forEach((num, i) => {
      const chip = document.createElement('div');
      chip.className = `bet-chip ${i > 0 ? 'alt' : ''}`;
      const stat = statsMap[num];
      chip.innerHTML = `<span class="number">${num}</span><span class="amount">${betCalc.perNumber.toLocaleString('ru-RU')} 🪙</span>${stat ? `<span class="stat-count">${stat.count31}× за 31 дн.</span>` : ''}`;
      betsGrid.appendChild(chip);
    });
  }

  const tag = document.createElement('p');
  tag.className = 'hint';
  tag.style.marginTop = '8px';
  tag.textContent = '📊 HWM Daily · автопроверка на след. спин';
  betsGrid.appendChild(tag);

  state.pendingSuggestion = suggestion;
  updateBetDisplay(bets.length || 0, betCalc);
}

function updateBetDisplay(numbersCount, betCalc) {
  if (!betCalc) betCalc = calculateBet(numbersCount || 1);
  document.getElementById('betPerNumber').textContent = `${betCalc.perNumber.toLocaleString('ru-RU')} 🪙`;
  document.getElementById('totalBet').textContent = `${betCalc.total.toLocaleString('ru-RU')} 🪙`;
  document.getElementById('missCount').textContent = state.missStreak;
  document.getElementById('multiplier').textContent = `×${betCalc.multiplier.toFixed(2)}`;
  renderAiAnalytics(betCalc);
}

// ─── Автопилот: auto-resolve + история спинов ───────────────────────────────

function parseSpinTimestamp(timeStr) {
  if (!timeStr) return 0;
  const m = String(timeStr).trim().match(/^(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return 0;

  const now = new Date();
  let year = now.getFullYear();
  const month = parseInt(m[1], 10) - 1;
  const day = parseInt(m[2], 10);
  const hour = parseInt(m[3], 10);
  const minute = parseInt(m[4], 10);

  let ts = new Date(year, month, day, hour, minute, 0).getTime();
  // Переход года: дата «из будущего» → прошлый год
  if (ts > now.getTime() + 86_400_000) {
    ts = new Date(year - 1, month, day, hour, minute, 0).getTime();
  }
  return ts;
}

function getSpinSortTime(spin) {
  const fromTime = parseSpinTimestamp(spin?.time);
  if (fromTime) return fromTime;
  const idTime = spin?.id?.split('|')[0];
  return parseSpinTimestamp(idTime);
}

/** Старый → новый (для симуляции и авто-резолва). */
function compareSpinChronological(a, b) {
  if (a?.gamesAgo != null && b?.gamesAgo != null && a.gamesAgo !== b.gamesAgo) {
    return b.gamesAgo - a.gamesAgo;
  }
  return getSpinSortTime(a) - getSpinSortTime(b);
}

/** Новый → старый (для UI и хранения). */
function compareSpinNewestFirst(a, b) {
  return compareSpinChronological(b, a);
}

function normalizeSpinHistory() {
  const byId = new Map();
  for (const spin of state.spinHistory) {
    if (!spin?.id) continue;
    const existing = byId.get(spin.id);
    if (!existing || getSpinSortTime(spin) >= getSpinSortTime(existing)) {
      byId.set(spin.id, spin);
    }
  }

  state.spinHistory = [...byId.values()].sort(compareSpinNewestFirst);

  if (state.spinHistory.length > MAX_SPIN_HISTORY) {
    state.spinHistory.length = MAX_SPIN_HISTORY;
  }

  if (state.spinHistory.length > 0) {
    state.lastSpinNumber = state.spinHistory[0].number;
  }
}

function isActiveBet(pending) {
  return pending && pending.bets?.length > 0 && pending.type !== 'skip';
}

function autoResolve(landedNumber) {
  const pending = state.pendingSuggestion;
  if (!isActiveBet(pending)) return null;

  const won = pending.bets.includes(landedNumber);
  if (won) state.missStreak = 0;
  else state.missStreak += 1;

  return {
    won,
    suggestedBets: pending.bets,
    afterNumber: pending.afterNumber,
  };
}

function rememberSpinId(id) {
  if (!state.processedSpinIds.includes(id)) {
    state.processedSpinIds.unshift(id);
    if (state.processedSpinIds.length > MAX_PROCESSED_IDS) {
      state.processedSpinIds.length = MAX_PROCESSED_IDS;
    }
  }
}

function isSpinProcessed(spin) {
  return state.processedSpinIds.includes(spin.id)
    || state.spinHistory.some(s => s.id === spin.id);
}

/** Один шаг симуляции: проверить pending на этом спине → записать → сгенерировать подсказку на следующий. */
function recordSpinStep(spin, { skipResolve = false } = {}) {
  const resolution = skipResolve ? null : autoResolve(spin.number);

  state.spinHistory.unshift({
    id: spin.id,
    number: spin.number,
    time: spin.time,
    gamesAgo: spin.gamesAgo ?? null,
    won: resolution?.won ?? null,
    suggestedBets: resolution?.suggestedBets ?? [],
    afterNumber: resolution?.afterNumber ?? null,
  });

  rememberSpinId(spin.id);
  state.pendingSuggestion = buildSuggestion(spin.number);
  return resolution;
}

function processNewSpin(spin, { applyBalance = false, deferPersist = false } = {}) {
  if (isSpinProcessed(spin)) return false;

  const pendingBefore = state.pendingSuggestion;
  const resolution = autoResolve(spin.number);
  if (applyBalance && resolution) {
    applyBalanceFromResolution(pendingBefore, resolution.won);
  }

  state.spinHistory.unshift({
    id: spin.id,
    number: spin.number,
    time: spin.time,
    gamesAgo: spin.gamesAgo ?? null,
    won: resolution?.won ?? null,
    suggestedBets: resolution?.suggestedBets ?? [],
    afterNumber: resolution?.afterNumber ?? null,
    manual: spin.manual ?? false,
  });

  normalizeSpinHistory();
  rememberSpinId(spin.id);
  document.getElementById('lastNumber').value = spin.number;
  state.pendingSuggestion = buildSuggestion(spin.number);

  if (!deferPersist) {
    showSuggestion(spin.number);
    saveState();
    renderSpinHistory();
    updateBetDisplay(state.pendingSuggestion?.bets?.length || 0);
  }

  return true;
}

function simulateHistoricalSpins(spins) {
  const batch = (Array.isArray(spins) ? spins : []).slice(0, SPIN_FETCH_LIMIT);

  if (!batch.length) return 0;

  const chronological = [...batch].sort(compareSpinChronological);

  state.missStreak = 0;
  state.pendingSuggestion = null;
  state.spinHistory = [];
  state.processedSpinIds = [];

  for (let i = 0; i < chronological.length; i++) {
    recordSpinStep(chronological[i], { skipResolve: i === 0 });
  }

  const latest = chronological[chronological.length - 1];
  normalizeSpinHistory();
  state.lastSpinNumber = latest.number;
  document.getElementById('lastNumber').value = latest.number;
  showSuggestion(latest.number);
  saveState();
  renderSpinHistory();
  updateBetDisplay(state.pendingSuggestion?.bets?.length || 0);

  return chronological.length;
}

function processIncrementalSpins(spins, { applyBalance = false } = {}) {
  if (!spins.length) return 0;

  const fresh = spins.filter(s => !isSpinProcessed(s));
  if (fresh.length === 0) return 0;

  // Резолв строго от старых к новым; merge — unshift + нормализация по timestamp
  fresh.sort(compareSpinChronological);

  let count = 0;
  for (const spin of fresh) {
    if (processNewSpin(spin, { applyBalance, deferPersist: true })) count += 1;
  }

  if (count > 0) {
    normalizeSpinHistory();
    showSuggestion(state.lastSpinNumber);
    saveState();
    renderSpinHistory();
    updateBetDisplay(state.pendingSuggestion?.bets?.length || 0);
  }

  return count;
}

async function reloadSpinHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/spins/recent?limit=${SPIN_FETCH_LIMIT}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'API недоступен (запустите: cd server && npm start)');

    const spins = Array.isArray(data.spins) ? data.spins : [];

    let count;
    if (state.spinHistory.length === 0) {
      count = simulateHistoricalSpins(spins);
    } else {
      count = processIncrementalSpins(spins);
      renderSpinHistory();
      renderAiAnalytics();
      if (state.lastSpinNumber) showSuggestion(state.lastSpinNumber);
    }

    updateAutopilotStatus(count ? ` · +${count} спинов` : ' · актуально');
    return count;
  } catch (err) {
    alert('Не удалось загрузить историю: ' + err.message);
    return 0;
  }
}

async function bootstrapSpinHistory() {
  if (state.spinHistory.length === 0) {
    await reloadSpinHistory();
  } else {
    normalizeSpinHistory();
    renderSpinHistory();
    if (state.lastSpinNumber) {
      document.getElementById('lastNumber').value = state.lastSpinNumber;
      showSuggestion(state.lastSpinNumber);
    }
  }
}

function renderSpinHistory() {
  const list = document.getElementById('spinHistoryList');
  const timeEl = document.getElementById('lastSpinTime');
  if (!list) return;

  if (state.spinHistory.length === 0) {
    list.innerHTML = '<p class="empty-history">Ожидание спинов…</p>';
    if (timeEl) timeEl.textContent = '';
    return;
  }

  list.innerHTML = state.spinHistory.slice(0, MAX_SPIN_HISTORY_UI).map(s => {
    const cls = s.won === true ? 'spin-chip win' : s.won === false ? 'spin-chip loss' : 'spin-chip';
    const icon = s.won === true ? '✓' : s.won === false ? '✗' : '';
    const timeStr = s.time != null ? String(s.time) : '';
    const bets = Array.isArray(s.suggestedBets) ? s.suggestedBets : [];
    const title = s.afterNumber
      ? `После ${s.afterNumber} → ${bets.join(', ') || '—'}`
      : timeStr;
    const timeLabel = timeStr.includes(' ') ? timeStr.split(' ')[1] : timeStr;
    const num = s.number != null ? String(s.number) : '?';
    return `<div class="${cls}" title="${title}"><span class="spin-num">${num}</span>${icon ? `<span class="spin-icon">${icon}</span>` : ''}<span class="spin-time">${timeLabel}</span></div>`;
  }).join('');

  const latest = state.spinHistory[0];
  if (timeEl && latest) {
    timeEl.textContent = `Последний: ${latest.time}`;
  }
}

async function pollLiveSpins() {
  if (!state.autopilotEnabled || pollInFlight) return;

  pollInFlight = true;
  try {
    const res = await fetch(`${API_BASE}/api/spins/recent?limit=${SPIN_FETCH_LIMIT}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'API недоступен');

    state.lastPollAt = new Date().toISOString();
    const spins = Array.isArray(data.spins) ? data.spins : [];
    const added = processIncrementalSpins(spins, { applyBalance: true });
    if (added > 0) saveState();

    const pollTime = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    updateAutopilotStatus(added ? ` · +${added} спин` : ` · ${pollTime}`);
  } catch (_) {
    updateAutopilotStatus(' · нет связи');
  } finally {
    pollInFlight = false;
  }
}

function startAutopilot() {
  stopAutopilot();
  pollLiveSpins();
  pollTimer = setInterval(pollLiveSpins, POLL_INTERVAL_MS);
}

function stopAutopilot() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function toggleAutopilot() {
  state.autopilotEnabled = !state.autopilotEnabled;
  saveState();
  if (state.autopilotEnabled) {
    startAutopilot();
  } else {
    stopAutopilot();
    updateAutopilotStatus();
  }
}

function handleManualSpin(raw) {
  const num = normalizeNumber(raw);
  if (!num) {
    alert('Число от 0 до 36 или 00');
    return;
  }
  const now = new Date();
  const spin = {
    id: `manual|${now.toISOString()}|${num}`,
    time: now.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ''),
    number: num,
    gamesAgo: 0,
    manual: true,
  };
  processNewSpin(spin);
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function buildQuickNumbers() {
  const container = document.getElementById('quickNumbers');
  const nums = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
  container.innerHTML = nums.map(n =>
    `<button type="button" class="quick-btn ${n === '0' || n === '00' ? 'zero' : ''}" data-num="${n}">${n}</button>`
  ).join('');
  container.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => handleManualSpin(btn.dataset.num));
  });
}

const MAX_BALANCE = 999_999_999;

function handleSetBalance() {
  const raw = document.getElementById('balanceInput').value.trim().replace(/\s/g, '');
  if (!/^\d+$/.test(raw)) {
    alert('Введите целое число золота (0 или больше)');
    return;
  }
  const val = parseInt(raw, 10);
  if (val < 0 || val > MAX_BALANCE) {
    alert(`Баланс должен быть от 0 до ${MAX_BALANCE.toLocaleString('ru-RU')}`);
    return;
  }
  state.balance = val;
  saveState();
  updateBalanceInput();
  if (state.lastSpinNumber) showSuggestion(state.lastSpinNumber);
  else updateBetDisplay(0);
  renderAiAnalytics();
}

function handleHardReset() {
  if (!confirm(
    'Hard Reset: будут удалены история спинов, баланс, промахи и вся сессия.\n\n'
    + 'Правила HWM (статистика с сайта) сохранятся.\n\nПродолжить?',
  )) return;

  const hwmRules = localStorage.getItem(STORAGE_HWM_KEY);
  localStorage.clear();
  if (hwmRules) localStorage.setItem(STORAGE_HWM_KEY, hwmRules);
  location.reload();
}

function handleReset() {
  if (!confirm('Сбросить промахи и историю спинов?\n\nСтатистика HWM сохранится.')) return;
  hardResetSpinState();
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  loadState();
  initRules();
  buildQuickNumbers();
  updateBalanceInput();
  updateBetDisplay(0);
  renderAiAnalytics();
  updateAutopilotStatus();

  document.getElementById('btnSetBalance').addEventListener('click', handleSetBalance);
  document.getElementById('balanceInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSetBalance();
  });
  document.getElementById('btnSuggest').addEventListener('click', () => {
    handleManualSpin(document.getElementById('lastNumber').value);
  });
  document.getElementById('lastNumber').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleManualSpin(e.target.value);
  });
  document.getElementById('btnReset').addEventListener('click', handleReset);
  document.getElementById('btnRefreshRules').addEventListener('click', refreshRulesFromHwm);
  document.getElementById('btnToggleAutopilot').addEventListener('click', toggleAutopilot);
  document.getElementById('btnReplaySpins').addEventListener('click', reloadSpinHistory);
  document.getElementById('btnHardReset').addEventListener('click', handleHardReset);
  document.getElementById('btnHardResetHistory').addEventListener('click', handleHardReset);

  const importInput = document.getElementById('importRulesFile');
  if (importInput) {
    importInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) importHwmJsonFile(file);
      e.target.value = '';
    });
  }

  await bootstrapSpinHistory();

  if (state.autopilotEnabled) startAutopilot();
});
