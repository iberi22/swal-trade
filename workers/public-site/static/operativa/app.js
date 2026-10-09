/**
 * SynapseTrader Public Dashboard Client
 * Vanilla JS, no external libraries, strictly XSS-safe (DOM textContent only).
 */

(function () {
  'use strict';

  // Demo mode detection via ?demo=1 query parameter
  const urlParams = new URLSearchParams(window.location.search);
  const isDemo = urlParams.get('demo') === '1';
  const REFRESH_INTERVAL_MS = 30000;

  // Cache DOM references
  const els = {
    modeBadge: document.getElementById('mode-badge'),
    demoBanner: document.getElementById('demo-banner'),
    honestyDisclaimer: document.getElementById('honesty-disclaimer'),
    disclaimerText: document.getElementById('disclaimer-text'),
    chipEngineStatus: document.getElementById('chip-engine-status'),
    chipFeedStatus: document.getElementById('chip-feed-status'),
    chipLastPriceUpdate: document.getElementById('chip-last-price-update'),
    chipSnapshotAge: document.getElementById('chip-snapshot-age'),
    staleWarning: document.getElementById('stale-warning'),
    kpiEquityPct: document.getElementById('kpi-equity-pct'),
    kpiCapitalSub: document.getElementById('kpi-capital-sub'),
    kpiDailyPnl: document.getElementById('kpi-daily-pnl'),
    kpiMaxDd: document.getElementById('kpi-max-dd'),
    kpiOpenPositions: document.getElementById('kpi-open-positions'),
    kpiTotalTrades: document.getElementById('kpi-total-trades'),
    kpiWinRate: document.getElementById('kpi-win-rate'),
    equityCurveRange: document.getElementById('equity-curve-range'),
    chartContainer: document.getElementById('chart-container'),
    pointsFormulaText: document.getElementById('points-formula-text'),
    botsCount: document.getElementById('bots-count'),
    botsTableBody: document.getElementById('bots-table-body'),
    positionsCount: document.getElementById('positions-count'),
    positionsTableBody: document.getElementById('positions-table-body'),
    tradesCount: document.getElementById('trades-count'),
    tradesTableBody: document.getElementById('trades-table-body'),
    footerStatus: document.getElementById('footer-status')
  };

  // --- Formatters (es-ES Intl.NumberFormat, Safe, Null-graceful) ---

  function formatSignedPct(val, decimals = 2) {
    if (val === null || val === undefined || typeof val !== 'number' || isNaN(val)) return '—';
    const fmt = new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: 'exceptZero'
    });
    return `${fmt.format(val)} %`;
  }

  function formatUnsignedPct(val, decimals = 2) {
    if (val === null || val === undefined || typeof val !== 'number' || isNaN(val)) return '—';
    const fmt = new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: 'never'
    });
    return `${fmt.format(Math.abs(val))} %`;
  }

  function formatPoints(val) {
    if (val === null || val === undefined || typeof val !== 'number' || isNaN(val)) return '—';
    const fmt = new Intl.NumberFormat('es-ES', {
      signDisplay: 'exceptZero',
      maximumFractionDigits: 0
    });
    return fmt.format(Math.round(val));
  }

  function formatPlainNumber(val, decimals = 2) {
    if (val === null || val === undefined || typeof val !== 'number' || isNaN(val)) return '—';
    const fmt = new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      signDisplay: 'never'
    });
    return fmt.format(val);
  }

  function formatPrice(val) {
    if (val === null || val === undefined || typeof val !== 'number' || isNaN(val)) return '—';
    const decimals = (Math.abs(val) >= 1) ? 2 : 4;
    return new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(val);
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr || typeof isoStr !== 'string') return '—';
    const ts = new Date(isoStr).getTime();
    if (isNaN(ts)) return '—';
    const diffS = Math.floor((Date.now() - ts) / 1000);
    if (diffS < 0) return 'recién';
    if (diffS < 60) return `hace ${diffS} s`;
    const diffM = Math.floor(diffS / 60);
    if (diffM < 60) return `hace ${diffM} min`;
    const diffH = Math.floor(diffM / 60);
    if (diffH < 24) return `hace ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    return `hace ${diffD} d`;
  }

  function formatDateTime(isoStr) {
    if (!isoStr || typeof isoStr !== 'string') return '—';
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('es-ES', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function colorClassForValue(val) {
    if (typeof val !== 'number' || isNaN(val) || val === 0) return '';
    return val > 0 ? 'text-pos' : 'text-neg';
  }

  // --- Safe DOM Cell Generators ---

  function createCell(text, className) {
    const td = document.createElement('td');
    td.textContent = (text !== null && text !== undefined && text !== '') ? String(text) : '—';
    if (className) td.className = className;
    return td;
  }

  function createTagCell(text, tagModifier) {
    const td = document.createElement('td');
    if (!text) {
      td.textContent = '—';
      td.className = 'text-muted';
      return td;
    }
    const span = document.createElement('span');
    span.className = `tag tag-${tagModifier}`;
    span.textContent = String(text);
    td.appendChild(span);
    return td;
  }

  // --- Empty / No-Snapshot State ---

  function renderEmptyState() {
    // Banner
    if (els.honestyDisclaimer) {
      els.honestyDisclaimer.classList.remove('hidden');
    }
    if (els.disclaimerText) {
      els.disclaimerText.textContent = 'El motor todavía no ha publicado datos. La página se actualiza sola cada 30 s.';
    }

    // Chips
    if (els.chipEngineStatus) {
      els.chipEngineStatus.textContent = 'Sin datos';
      els.chipEngineStatus.className = 'chip-val';
    }
    if (els.chipFeedStatus) {
      els.chipFeedStatus.textContent = 'Sin datos';
      els.chipFeedStatus.className = 'chip-val';
    }
    if (els.chipLastPriceUpdate) {
      els.chipLastPriceUpdate.textContent = 'Sin datos';
    }
    if (els.chipSnapshotAge) {
      els.chipSnapshotAge.textContent = 'Sin datos';
    }
    if (els.staleWarning) {
      els.staleWarning.classList.add('hidden');
    }

    // KPIs
    if (els.kpiEquityPct) {
      els.kpiEquityPct.textContent = '—';
      els.kpiEquityPct.className = 'kpi-val';
    }
    if (els.kpiCapitalSub) {
      els.kpiCapitalSub.textContent = '—';
    }
    if (els.kpiDailyPnl) {
      els.kpiDailyPnl.textContent = '—';
      els.kpiDailyPnl.className = 'kpi-val';
    }
    if (els.kpiMaxDd) {
      els.kpiMaxDd.textContent = '—';
      els.kpiMaxDd.className = 'kpi-val';
    }
    if (els.kpiOpenPositions) {
      els.kpiOpenPositions.textContent = '—';
    }
    if (els.kpiTotalTrades) {
      els.kpiTotalTrades.textContent = '—';
    }
    if (els.kpiWinRate) {
      els.kpiWinRate.textContent = '—';
    }

    // Chart placeholder
    if (els.chartContainer) {
      els.chartContainer.textContent = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'chart-placeholder';
      emptyDiv.textContent = 'Sin datos publicados';
      els.chartContainer.appendChild(emptyDiv);
    }
    if (els.equityCurveRange) {
      els.equityCurveRange.textContent = '—';
    }

    // Tables
    if (els.botsTableBody) {
      els.botsTableBody.textContent = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 11;
      td.className = 'text-center text-muted';
      td.textContent = 'Sin datos publicados';
      tr.appendChild(td);
      els.botsTableBody.appendChild(tr);
    }
    if (els.botsCount) {
      els.botsCount.textContent = '0 bots';
    }

    if (els.positionsTableBody) {
      els.positionsTableBody.textContent = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'text-center text-muted';
      td.textContent = 'Sin datos publicados';
      tr.appendChild(td);
      els.positionsTableBody.appendChild(tr);
    }
    if (els.positionsCount) {
      els.positionsCount.textContent = '0 abiertas';
    }

    if (els.tradesTableBody) {
      els.tradesTableBody.textContent = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'text-center text-muted';
      td.textContent = 'Sin datos publicados';
      tr.appendChild(td);
      els.tradesTableBody.appendChild(tr);
    }
    if (els.tradesCount) {
      els.tradesCount.textContent = '0 registrados';
    }
  }

  // --- Render Sections ---

  function renderHeaderAndStatus(snapshot) {
    const mode = (snapshot.mode || 'paper').toLowerCase();

    // Mode badge
    if (els.modeBadge) {
      els.modeBadge.textContent = mode.toUpperCase();
      els.modeBadge.className = `badge badge-${mode}`;
    }

    // Honesty disclaimer: visible while mode !== "live"
    if (els.honestyDisclaimer) {
      if (mode === 'live') {
        els.honestyDisclaimer.classList.add('hidden');
      } else {
        els.honestyDisclaimer.classList.remove('hidden');
        if (els.disclaimerText) {
          els.disclaimerText.textContent =
            'Operativa en paper trading. Ninguna estrategia tiene todavía una ventaja estadística validada fuera de muestra. No es asesoría financiera.';
        }
      }
    }

    // Engine chips
    const engine = snapshot.engine || {};
    if (els.chipEngineStatus) {
      const statusMap = {
        running: 'En ejecución',
        paused: 'Pausado',
        emergency_stop: 'Parada de emergencia',
        degraded: 'Degradado'
      };
      els.chipEngineStatus.textContent = statusMap[engine.status] || engine.status || 'Desconocido';
    }

    if (els.chipFeedStatus) {
      els.chipFeedStatus.textContent = engine.feed_ok ? 'Conectado (OK)' : 'Desconectado';
      els.chipFeedStatus.className = `chip-val ${engine.feed_ok ? 'text-pos' : 'text-neg'}`;
    }

    if (els.chipLastPriceUpdate) {
      els.chipLastPriceUpdate.textContent = formatRelativeTime(engine.last_price_update_at);
    }

    // Snapshot age calculation & warning (> 5 min)
    let snapshotAgeSeconds = null;
    if (snapshot.generated_at) {
      const genTime = new Date(snapshot.generated_at).getTime();
      if (!isNaN(genTime)) {
        snapshotAgeSeconds = Math.max(0, Math.floor((Date.now() - genTime) / 1000));
      }
    }

    if (els.chipSnapshotAge) {
      if (snapshotAgeSeconds !== null) {
        els.chipSnapshotAge.textContent = formatRelativeTime(snapshot.generated_at);
      } else {
        els.chipSnapshotAge.textContent = '—';
      }
    }

    if (els.staleWarning) {
      if (snapshotAgeSeconds !== null && snapshotAgeSeconds > 300) {
        els.staleWarning.classList.remove('hidden');
      } else {
        els.staleWarning.classList.add('hidden');
      }
    }
  }

  function renderKPIs(snapshot) {
    const acc = snapshot.account || {};

    if (els.kpiEquityPct) {
      els.kpiEquityPct.textContent = formatSignedPct(acc.equity_pct, 2);
      els.kpiEquityPct.className = `kpi-val ${colorClassForValue(acc.equity_pct)}`;
    }

    if (els.kpiCapitalSub) {
      if (snapshot.mode === 'paper' && typeof acc.initial_capital === 'number') {
        els.kpiCapitalSub.textContent = `Capital inicial: $ ${formatPlainNumber(acc.initial_capital, 2)}`;
      } else {
        els.kpiCapitalSub.textContent = 'Rendimiento acumulado';
      }
    }

    if (els.kpiDailyPnl) {
      els.kpiDailyPnl.textContent = formatSignedPct(acc.daily_pnl_pct, 2);
      els.kpiDailyPnl.className = `kpi-val ${colorClassForValue(acc.daily_pnl_pct)}`;
    }

    if (els.kpiMaxDd) {
      els.kpiMaxDd.textContent = formatUnsignedPct(acc.max_drawdown_pct, 2);
      els.kpiMaxDd.className = 'kpi-val text-warning';
    }

    if (els.kpiOpenPositions) {
      els.kpiOpenPositions.textContent = (typeof acc.open_positions === 'number')
        ? new Intl.NumberFormat('es-ES').format(acc.open_positions)
        : '—';
    }

    if (els.kpiTotalTrades) {
      els.kpiTotalTrades.textContent = (typeof acc.total_trades === 'number')
        ? new Intl.NumberFormat('es-ES').format(acc.total_trades)
        : '—';
    }

    if (els.kpiWinRate) {
      els.kpiWinRate.textContent = formatUnsignedPct(acc.win_rate, 1);
    }
  }

  // --- Equity Curve Chart ---

  let lastEquityCurve = null;
  let lastRenderedWidth = 0;

  function getNiceTicks(minVal, maxVal, targetTicks = 4) {
    let range = maxVal - minVal;
    if (range < 0.1) {
      const mid = (maxVal + minVal) / 2;
      minVal = mid - 0.5;
      maxVal = mid + 0.5;
      range = 1.0;
    }

    const rawStep = range / (targetTicks - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;

    let stepNorm;
    if (norm < 1.5) stepNorm = 1;
    else if (norm < 3.5) stepNorm = 2;
    else if (norm < 7.5) stepNorm = 5;
    else stepNorm = 10;

    let step = stepNorm * mag;

    let yMin = Math.floor(minVal / step) * step;
    let yMax = Math.ceil(maxVal / step) * step;

    let count = Math.round((yMax - yMin) / step) + 1;
    if (count > 5) {
      if (stepNorm === 1) step = 2 * mag;
      else if (stepNorm === 2) step = 5 * mag;
      else if (stepNorm === 5) step = 10 * mag;
      else step = 20 * mag;
      yMin = Math.floor(minVal / step) * step;
      yMax = Math.ceil(maxVal / step) * step;
    } else if (count < 3) {
      step = step / 2;
      yMin = Math.floor(minVal / step) * step;
      yMax = Math.ceil(maxVal / step) * step;
    }

    const ticks = [];
    const n = Math.round((yMax - yMin) / step);
    for (let i = 0; i <= n; i++) {
      ticks.push(Number((yMin + i * step).toFixed(6)));
    }

    return { ticks, yMin, yMax, step };
  }

  function renderEquityChart(curve) {
    if (!els.chartContainer) return;
    lastEquityCurve = curve;

    if (!Array.isArray(curve) || curve.length === 0) {
      els.chartContainer.textContent = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'chart-placeholder';
      emptyDiv.textContent = 'Sin datos publicados';
      els.chartContainer.appendChild(emptyDiv);
      if (els.equityCurveRange) els.equityCurveRange.textContent = '—';
      return;
    }

    if (els.equityCurveRange) {
      const firstT = curve[0].t;
      const lastT = curve[curve.length - 1].t;
      els.equityCurveRange.textContent = `${formatDateTime(firstT)} — ${formatDateTime(lastT)} (${curve.length} puntos)`;
    }

    const containerWidth = els.chartContainer.clientWidth;
    const width = Math.max(300, Math.round(containerWidth || 800));
    lastRenderedWidth = width;
    const height = 220;
    const padTop = 20;
    const padBottom = 25;
    const padLeft = 70;
    const padRight = 20;

    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    // Determine min and max
    let minVal = 0;
    let maxVal = 0;
    curve.forEach((pt) => {
      const v = typeof pt.equity_pct === 'number' ? pt.equity_pct : 0;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    });

    const { ticks, yMin, yMax, step } = getNiceTicks(minVal, maxVal, 4);

    function getX(i) {
      if (curve.length <= 1) return padLeft + plotWidth / 2;
      return padLeft + (i / (curve.length - 1)) * plotWidth;
    }

    function getY(pct) {
      if (yMax === yMin) return padTop + plotHeight / 2;
      return padTop + (1 - (pct - yMin) / (yMax - yMin)) * plotHeight;
    }

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'chart-svg');

    // Defs for gradient
    const defs = document.createElementNS(svgNS, 'defs');
    const grad = document.createElementNS(svgNS, 'linearGradient');
    grad.setAttribute('id', 'equityGrad');
    grad.setAttribute('x1', '0%');
    grad.setAttribute('y1', '0%');
    grad.setAttribute('x2', '0%');
    grad.setAttribute('y2', '100%');

    const stop1 = document.createElementNS(svgNS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', 'var(--chart-line)');
    stop1.setAttribute('stop-opacity', '0.28');

    const stop2 = document.createElementNS(svgNS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', 'var(--chart-line)');
    stop2.setAttribute('stop-opacity', '0.0');

    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Grid lines and labels (3-5 ticks; skip labels closer than 14 px)
    const decimals = step < 0.1 ? 2 : (step < 1 ? 1 : 0);
    const sortedTicks = ticks.slice().sort((a, b) => getY(a) - getY(b));
    let lastLabelY = null;

    sortedTicks.forEach((val) => {
      const yPos = getY(val);
      if (yPos < padTop - 2 || yPos > height - padBottom + 2) return;

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(padLeft));
      line.setAttribute('y1', String(yPos));
      line.setAttribute('x2', String(width - padRight));
      line.setAttribute('y2', String(yPos));
      line.setAttribute('stroke', val === 0 ? 'var(--chart-zero-line)' : 'var(--border-color)');
      line.setAttribute('stroke-width', val === 0 ? '1.5' : '1');
      if (val === 0) line.setAttribute('stroke-dasharray', '4 4');
      svg.appendChild(line);

      // Check 14px threshold to prevent label overlap
      if (lastLabelY !== null && Math.abs(yPos - lastLabelY) < 14) {
        return; // skip label
      }
      lastLabelY = yPos;

      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', String(padLeft - 8));
      label.setAttribute('y', String(yPos + 4));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('fill', 'var(--text-muted)');
      label.setAttribute('font-size', '11');
      label.setAttribute('font-family', 'var(--font-mono)');
      label.textContent = formatSignedPct(val, decimals);
      svg.appendChild(label);
    });

    // Build path coordinates
    const points = curve.map((pt, i) => {
      const pct = typeof pt.equity_pct === 'number' ? pt.equity_pct : 0;
      return { x: getX(i), y: getY(pct) };
    });

    if (points.length > 0) {
      let pathD = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
      for (let i = 1; i < points.length; i++) {
        pathD += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
      }

      // Area fill
      const zeroY = getY(0);
      const clampedZeroY = Math.max(padTop, Math.min(height - padBottom, zeroY));
      const areaD = `${pathD} L ${points[points.length - 1].x.toFixed(2)} ${clampedZeroY.toFixed(2)} L ${points[0].x.toFixed(2)} ${clampedZeroY.toFixed(2)} Z`;
      const areaPath = document.createElementNS(svgNS, 'path');
      areaPath.setAttribute('d', areaD);
      areaPath.setAttribute('fill', 'url(#equityGrad)');
      svg.appendChild(areaPath);

      // Curve line
      const linePath = document.createElementNS(svgNS, 'path');
      linePath.setAttribute('d', pathD);
      linePath.setAttribute('fill', 'none');
      linePath.setAttribute('stroke', 'var(--chart-line)');
      linePath.setAttribute('stroke-width', '2');
      linePath.setAttribute('stroke-linecap', 'round');
      linePath.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(linePath);

      // Last point indicator dot
      const lastPt = points[points.length - 1];
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', lastPt.x.toFixed(2));
      dot.setAttribute('cy', lastPt.y.toFixed(2));
      dot.setAttribute('r', '4');
      dot.setAttribute('fill', 'var(--chart-line)');
      svg.appendChild(dot);
    }

    els.chartContainer.textContent = '';
    els.chartContainer.appendChild(svg);
  }

  // Recompute chart on resize
  window.addEventListener('resize', () => {
    if (lastEquityCurve) {
      renderEquityChart(lastEquityCurve);
    }
  });

  if (typeof ResizeObserver !== 'undefined' && els.chartContainer) {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect ? entry.contentRect.width : 0;
        if (w > 0 && Math.abs(w - lastRenderedWidth) >= 2 && lastEquityCurve) {
          renderEquityChart(lastEquityCurve);
        }
      }
    });
    ro.observe(els.chartContainer);
  }

  // --- Tables Rendering ---

  function renderBotsTable(snapshot) {
    if (els.pointsFormulaText && snapshot.points_formula) {
      els.pointsFormulaText.textContent = snapshot.points_formula;
    }

    const rawBots = Array.isArray(snapshot.bots) ? snapshot.bots.slice() : [];
    if (els.botsCount) {
      els.botsCount.textContent = `${rawBots.length} bot${rawBots.length === 1 ? '' : 's'}`;
    }

    if (!els.botsTableBody) return;
    els.botsTableBody.textContent = '';

    if (rawBots.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 11;
      td.className = 'text-center text-muted';
      td.textContent = 'Sin datos publicados';
      tr.appendChild(td);
      els.botsTableBody.appendChild(tr);
      return;
    }

    // Sort by points descending
    rawBots.sort((a, b) => (b.points || 0) - (a.points || 0));

    rawBots.forEach((bot, idx) => {
      const tr = document.createElement('tr');

      // Rank #
      tr.appendChild(createCell(idx + 1, 'td-rank'));

      // Bot Name
      const botCell = createCell(bot.name || bot.id);
      botCell.style.fontWeight = '600';
      tr.appendChild(botCell);

      // Estado
      const statusMap = { active: 'Activo', gated: 'Gated', disabled: 'Inactivo' };
      const statusText = statusMap[bot.status] || bot.status || '—';
      tr.appendChild(createTagCell(statusText, bot.status || 'disabled'));

      // Fidelidad del simulador badge
      const fid = bot.fidelity || 'unmeasured';
      tr.appendChild(createTagCell(fid, fid));

      // Veredicto de investigación
      tr.appendChild(createCell(bot.research_verdict || '—', 'text-muted'));

      // Puntos (+ / - color, signed)
      const pointsCell = createCell(formatPoints(bot.points), `text-right text-mono ${colorClassForValue(bot.points)}`);
      pointsCell.style.fontWeight = '700';
      tr.appendChild(pointsCell);

      // Trades
      tr.appendChild(createCell(new Intl.NumberFormat('es-ES').format(bot.trades), 'text-right text-mono'));

      // Win Rate % (unsigned!)
      tr.appendChild(createCell(formatUnsignedPct(bot.win_rate, 1), 'text-right text-mono'));

      // Profit Factor (plain number!)
      tr.appendChild(createCell(formatPlainNumber(bot.profit_factor, 2), 'text-right text-mono'));

      // PnL % (+ / - color, signed)
      tr.appendChild(createCell(formatSignedPct(bot.pnl_pct, 2), `text-right text-mono ${colorClassForValue(bot.pnl_pct)}`));

      // Último trade
      tr.appendChild(createCell(formatRelativeTime(bot.last_trade_at), 'text-muted'));

      els.botsTableBody.appendChild(tr);
    });
  }

  function renderPositionsTable(positions) {
    const rawPositions = Array.isArray(positions) ? positions : [];
    if (els.positionsCount) {
      els.positionsCount.textContent = `${rawPositions.length} abierta${rawPositions.length === 1 ? '' : 's'}`;
    }

    if (!els.positionsTableBody) return;
    els.positionsTableBody.textContent = '';

    if (rawPositions.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'text-center text-muted';
      td.textContent = 'Sin datos publicados';
      tr.appendChild(td);
      els.positionsTableBody.appendChild(tr);
      return;
    }

    rawPositions.forEach((pos) => {
      const tr = document.createElement('tr');
      tr.appendChild(createCell(pos.bot, 'text-mono'));
      tr.appendChild(createCell(pos.symbol, 'text-mono'));

      // Side (long / short)
      const sideText = (pos.side || '').toUpperCase();
      tr.appendChild(createTagCell(sideText, (pos.side || '').toLowerCase()));

      tr.appendChild(createCell(formatPrice(pos.entry_price), 'text-right text-mono'));
      tr.appendChild(createCell(formatSignedPct(pos.upnl_pct, 2), `text-right text-mono ${colorClassForValue(pos.upnl_pct)}`));
      tr.appendChild(createCell(formatRelativeTime(pos.opened_at), 'text-muted'));

      els.positionsTableBody.appendChild(tr);
    });
  }

  function renderTradesTable(trades) {
    const rawTrades = Array.isArray(trades) ? trades : [];
    if (els.tradesCount) {
      els.tradesCount.textContent = `${rawTrades.length} registrado${rawTrades.length === 1 ? '' : 's'}`;
    }

    if (!els.tradesTableBody) return;
    els.tradesTableBody.textContent = '';

    if (rawTrades.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'text-center text-muted';
      td.textContent = 'Sin datos publicados';
      tr.appendChild(td);
      els.tradesTableBody.appendChild(tr);
      return;
    }

    rawTrades.forEach((trade) => {
      const tr = document.createElement('tr');
      tr.appendChild(createCell(trade.bot, 'text-mono'));
      tr.appendChild(createCell(trade.symbol, 'text-mono'));

      const sideText = (trade.side || '').toUpperCase();
      tr.appendChild(createTagCell(sideText, (trade.side || '').toLowerCase()));

      tr.appendChild(createCell(formatPrice(trade.entry_price), 'text-right text-mono'));
      tr.appendChild(createCell(formatPrice(trade.exit_price), 'text-right text-mono'));
      tr.appendChild(createCell(formatSignedPct(trade.pnl_pct, 2), `text-right text-mono ${colorClassForValue(trade.pnl_pct)}`));
      tr.appendChild(createCell(trade.exit_reason || '—', 'text-mono'));
      tr.appendChild(createCell(formatRelativeTime(trade.closed_at), 'text-muted'));

      els.tradesTableBody.appendChild(tr);
    });
  }

  // --- Main Fetch Cycle ---

  async function fetchSnapshot() {
    try {
      const url = isDemo ? './demo-snapshot.json' : '/public/v1/snapshot';
      const response = await fetch(url, { cache: 'no-cache' });

      if (isDemo && response.status === 404) {
        if (els.demoBanner) {
          els.demoBanner.textContent = 'demo no disponible en producción';
          els.demoBanner.classList.remove('hidden');
        }
        renderEmptyState();
        return;
      }

      if (response.status === 503) {
        renderEmptyState();
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const snapshot = await response.json();
      if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('Respuesta inválida');
      }

      if (isDemo && els.demoBanner) {
        els.demoBanner.textContent = 'Modo Demostración (?demo=1)';
        els.demoBanner.classList.remove('hidden');
      }

      renderHeaderAndStatus(snapshot);
      renderKPIs(snapshot);
      renderEquityChart(snapshot.equity_curve);
      renderBotsTable(snapshot);
      renderPositionsTable(snapshot.open_positions);
      renderTradesTable(snapshot.recent_trades);

      if (els.footerStatus) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        els.footerStatus.textContent = `Actualizado cada 30 s • Última consulta: ${timeStr}`;
      }
    } catch (err) {
      renderEmptyState();
      if (els.footerStatus) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        els.footerStatus.textContent = `Sin conexión con el motor • Reintentando cada 30 s (${timeStr})`;
      }
    }
  }

  // Initial fetch and 30-second interval
  fetchSnapshot();
  setInterval(fetchSnapshot, REFRESH_INTERVAL_MS);
})();
