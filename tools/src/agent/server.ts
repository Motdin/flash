import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ChainOpportunityReport } from '../morpho/dex-scanner.js';
import { getAtRiskWatchlist, type MorphoBorrowerWatchlistEntry } from '../morpho/liquidation-scanner.js';
import type { LlmOperatorConfig, OperatorMode } from './llm-operator.js';
import type { OperatorAuditEntry } from './logger.js';
import type { ChainWsStatus } from './ws-listener.js';

export type OperatorRuntimeState = {
  startedAt: string;
  running: boolean;
  cycleRunning: boolean;
  cycleCount: number;
  consecutiveFailures: number;
  circuitBreakerTripped: boolean;
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  chains: string[];
  intervalSec: number;
  minimumUsd: number;
  arbLoanUsd: number;
  config: LlmOperatorConfig;
  wsStatuses?: Record<string, ChainWsStatus>;
  atRiskWatchlist?: MorphoBorrowerWatchlistEntry[];
  latestReports: Record<string, ChainOpportunityReport>;
  recentHistory: OperatorAuditEntry[];
  errors: Array<{ chain: string; message: string; timestamp: string }>;
};

export type OperatorServerHandlers = {
  getState: () => OperatorRuntimeState;
  triggerNow: () => Promise<void>;
  updateConfig: (patch: Partial<{ mode: OperatorMode; autoBroadcast: boolean; minProfitUsd: number }>) => void;
};

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, serializeBigInt, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function isAuthorized(req: IncomingMessage): boolean {
  const expectedToken = process.env.OPERATOR_API_TOKEN;
  if (!expectedToken) return true;
  const authHeader = req.headers.authorization ?? '';
  return authHeader === `Bearer ${expectedToken}`;
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EVM Loan Toolkit — VPS LLM Operator & Executor</title>
  <style>
    :root {
      --bg: #080b12;
      --panel: #101624;
      --panel-alt: #151d30;
      --border: #23304d;
      --text: #e6edf7;
      --muted: #8b9bb8;
      --cyan: #22d3ee;
      --green: #34d399;
      --yellow: #fbbf24;
      --red: #f87171;
      --purple: #c084fc;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.5;
      padding: 20px;
    }
    .container { max-width: 1380px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 18px 22px;
      background: linear-gradient(135deg, #101728 0%, #161f38 100%);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .brand h1 {
      font-size: 1.35rem;
      letter-spacing: 0.04em;
      color: var(--cyan);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand p { color: var(--muted); font-size: 0.88rem; margin-top: 2px; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    select, button {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.86rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover, select:hover { border-color: var(--cyan); }
    button.primary {
      background: rgba(34, 211, 238, 0.14);
      border-color: var(--cyan);
      color: var(--cyan);
      font-weight: 600;
    }
    button.primary:hover { background: rgba(34, 211, 238, 0.25); }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
      margin-bottom: 20px;
    }
    .kpi {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 18px;
    }
    .kpi .label { font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    .kpi .value { font-size: 1.25rem; font-weight: 700; margin-top: 4px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.74rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-green { background: rgba(52, 211, 153, 0.15); color: var(--green); border: 1px solid rgba(52, 211, 153, 0.35); }
    .badge-yellow { background: rgba(251, 191, 36, 0.15); color: var(--yellow); border: 1px solid rgba(251, 191, 36, 0.35); }
    .badge-cyan { background: rgba(34, 211, 238, 0.15); color: var(--cyan); border: 1px solid rgba(34, 211, 238, 0.35); }
    .badge-purple { background: rgba(192, 132, 252, 0.15); color: var(--purple); border: 1px solid rgba(192, 132, 252, 0.35); }
    .badge-red { background: rgba(248, 113, 113, 0.15); color: var(--red); border: 1px solid rgba(248, 113, 113, 0.35); }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      margin-bottom: 20px;
    }
    @media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 18px;
    }
    .card h2 {
      font-size: 1rem;
      color: var(--cyan);
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td {
      padding: 9px 10px;
      text-align: left;
      border-bottom: 1px solid rgba(35, 48, 77, 0.65);
    }
    th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .decision-item {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    .decision-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      font-size: 0.82rem;
    }
    .decision-reason { color: var(--text); font-size: 0.88rem; margin-bottom: 6px; }
    .decision-outcome { color: var(--muted); font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>⚡ MORPHO LLM OPERATOR & EXECUTOR (VPS)</h1>
        <p>Autonomous Watch Daemon • Whitelist Sync • DEX Profit Arbitrage & Zero-Fee Flashloan</p>
      </div>
      <div class="controls">
        <label style="font-size:0.82rem;color:var(--muted);">Mode:
          <select id="modeSelect" onchange="changeMode()">
            <option value="dry-run">dry-run (Simulasi)</option>
            <option value="whitelist-only">whitelist-only</option>
            <option value="flashloan">flashloan</option>
            <option value="arbitrage">arbitrage</option>
            <option value="full">full (Auto Whitelist + Arb + Flash)</option>
          </select>
        </label>
        <button id="broadcastBtn" onclick="toggleBroadcast()">Broadcast: OFF</button>
        <button class="primary" id="triggerBtn" onclick="triggerCycle()">↻ Scan & Evaluasi Sekarang</button>
      </div>
    </header>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Status Daemon</div>
        <div class="value" id="kpiStatus">Memuat...</div>
      </div>
      <div class="kpi">
        <div class="label">Operator Mode</div>
        <div class="value" id="kpiMode">-</div>
      </div>
      <div class="kpi">
        <div class="label">LLM Model</div>
        <div class="value mono" id="kpiModel" style="font-size:1rem;">-</div>
      </div>
      <div class="kpi">
        <div class="label">Siklus Watch</div>
        <div class="value" id="kpiCycles">0</div>
      </div>
      <div class="kpi">
        <div class="label">Min Profit / Loan Target</div>
        <div class="value" id="kpiTargets">-</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>
          <span>🛡️ Whitelist & Likuiditas Morpho</span>
          <span class="badge badge-cyan" id="chainCountBadge">0 Chains</span>
        </h2>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Asset</th>
                <th>Likuiditas USD</th>
                <th>Flash Allowlist</th>
                <th>Arb Allowlist</th>
              </tr>
            </thead>
            <tbody id="whitelistTableBody">
              <tr><td colspan="5" style="color:var(--muted);">Menunggu hasil scan...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>
          <span>📈 Kandidat Arbitrase DEX (V2 Quotes)</span>
          <span class="badge badge-green" id="arbCountBadge">0 Rute</span>
        </h2>
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Chain / Rute</th>
                <th>DEX A → DEX B</th>
                <th>Spread</th>
                <th>Net Profit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="arbTableBody">
              <tr><td colspan="5" style="color:var(--muted);">Menunggu kalkulasi quote DEX...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>
        <span>🧠 Keputusan Operator LLM & Riwayat Eksekusi</span>
        <span style="font-size:0.78rem;color:var(--muted);" id="lastUpdatedLabel">-</span>
      </h2>
      <div id="historyContainer">
        <p style="color:var(--muted);font-size:0.88rem;">Belum ada riwayat evaluasi pada sesi ini.</p>
      </div>
    </div>
  </div>

  <script>
    let currentState = null;

    function actionBadge(action) {
      if (action === 'EXECUTE_ARBITRAGE') return '<span class="badge badge-green">EXECUTE_ARBITRAGE</span>';
      if (action === 'SYNC_WHITELIST') return '<span class="badge badge-cyan">SYNC_WHITELIST</span>';
      if (action === 'EXECUTE_FLASHLOAN') return '<span class="badge badge-purple">EXECUTE_FLASHLOAN</span>';
      return '<span class="badge badge-yellow">HOLD</span>';
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();
        currentState = data;
        renderState(data);
      } catch (e) {
        console.error(e);
      }
    }

    function renderState(data) {
      document.getElementById('kpiStatus').innerHTML = data.cycleRunning
        ? '<span class="badge badge-cyan">SCANNING...</span>'
        : '<span class="badge badge-green">ACTIVE / WATCHING</span>';
      document.getElementById('kpiMode').innerHTML =
        '<span class="badge badge-purple">' + data.config.mode + '</span>';
      document.getElementById('kpiModel').textContent = data.config.model || 'deterministic';
      document.getElementById('kpiCycles').textContent = String(data.cycleCount);
      document.getElementById('kpiTargets').textContent =
        '$' + data.config.minProfitUsd + ' / $' + Number(data.arbLoanUsd).toLocaleString();

      const modeSelect = document.getElementById('modeSelect');
      if (document.activeElement !== modeSelect) {
        modeSelect.value = data.config.mode;
      }

      const broadcastBtn = document.getElementById('broadcastBtn');
      broadcastBtn.textContent = 'Broadcast: ' + (data.config.autoBroadcast ? 'ON (LIVE)' : 'OFF (SIMULASI)');
      broadcastBtn.className = data.config.autoBroadcast ? 'badge-red' : '';

      const reports = Object.values(data.latestReports || {});
      document.getElementById('chainCountBadge').textContent = reports.length + ' Chains';

      // Render Whitelist Table
      const wlRows = [];
      for (const rep of reports) {
        for (const t of (rep.tokenWhitelists || []).slice(0, 8)) {
          wlRows.push(
            '<tr>' +
              '<td><strong>' + rep.chain.name + '</strong><br/><span style="font-size:0.74rem;color:var(--muted);">Block ' + rep.blockNumber + '</span></td>' +
              '<td class="mono"><strong>' + t.symbol + '</strong></td>' +
              '<td class="mono">$' + Math.round(t.usdValue || 0).toLocaleString() + '</td>' +
              '<td>' + (t.allowedOnFlashExecutor ? '<span class="badge badge-green">WHITELISTED</span>' : '<span class="badge badge-yellow">PENDING</span>') + '</td>' +
              '<td>' + (rep.arbExecutor ? (t.allowedOnArbExecutor ? '<span class="badge badge-green">WHITELISTED</span>' : '<span class="badge badge-yellow">PENDING</span>') : '<span style="color:var(--muted);font-size:0.75rem;">No Arb Contract</span>') + '</td>' +
            '</tr>'
          );
        }
      }
      document.getElementById('whitelistTableBody').innerHTML =
        wlRows.length ? wlRows.join('') : '<tr><td colspan="5" style="color:var(--muted);">Belum ada aset terdeteksi (periksa RPC di .env atau jalankan scan).</td></tr>';

      // Render Arbitrage Table
      const arbRows = [];
      let totalArb = 0;
      for (const rep of reports) {
        for (const c of (rep.arbitrageCandidates || []).slice(0, 6)) {
          totalArb++;
          const netColor = c.netProfitUsd >= data.config.minProfitUsd ? 'var(--green)' : (c.netProfitUsd > 0 ? 'var(--yellow)' : 'var(--muted)');
          arbRows.push(
            '<tr>' +
              '<td><strong>' + rep.chain.name + '</strong><br/><span class="mono" style="font-size:0.78rem;">' + c.loanSymbol + ' → ' + c.intermediateSymbol + '</span></td>' +
              '<td style="font-size:0.8rem;">' + c.firstRouterName + '<br/>→ ' + c.secondRouterName + '</td>' +
              '<td class="mono">' + c.spreadBps + ' bps</td>' +
              '<td class="mono" style="color:' + netColor + ';font-weight:600;">$' + Number(c.netProfitUsd).toFixed(2) + '</td>' +
              '<td>' + (c.profitable ? '<span class="badge badge-green">PROFITABLE</span>' : '<span class="badge badge-yellow">MONITOR</span>') + '</td>' +
            '</tr>'
          );
        }
      }
      document.getElementById('arbCountBadge').textContent = totalArb + ' Rute';
      document.getElementById('arbTableBody').innerHTML =
        arbRows.length ? arbRows.join('') : '<tr><td colspan="5" style="color:var(--muted);">Belum ada rute DEX V2 yang dievaluasi pada siklus ini.</td></tr>';

      // Render History
      const history = data.recentHistory || [];
      document.getElementById('lastUpdatedLabel').textContent =
        data.lastCycleAt ? 'Siklus terakhir: ' + new Date(data.lastCycleAt).toLocaleTimeString() : 'Menunggu siklus pertama';

      if (history.length === 0) {
        const errs = data.errors || [];
        if (errs.length > 0) {
          document.getElementById('historyContainer').innerHTML = errs.map((er) =>
            '<div class="decision-item">' +
              '<div class="decision-header"><span class="badge badge-red">RPC / SCAN WARNING (' + er.chain + ')</span><span>' + new Date(er.timestamp).toLocaleTimeString() + '</span></div>' +
              '<div class="decision-reason mono">' + er.message + '</div>' +
            '</div>'
          ).join('');
        }
      } else {
        document.getElementById('historyContainer').innerHTML = history.slice(0, 12).map((item) =>
          '<div class="decision-item">' +
            '<div class="decision-header">' +
              '<div>' + actionBadge(item.decision.action) + ' <strong style="margin-left:8px;">' + item.chain.toUpperCase() + '</strong> <span style="color:var(--muted);margin-left:6px;">Block ' + item.blockNumber + ' • Gas ' + Number(item.gasPriceGwei).toFixed(3) + ' gwei</span></div>' +
              '<div style="color:var(--muted);">' + item.decision.source + ' (' + Math.round(item.decision.confidence * 100) + '%) • ' + new Date(item.timestamp).toLocaleTimeString() + '</div>' +
            '</div>' +
            '<div class="decision-reason">' + item.decision.reasoning + '</div>' +
            '<div class="decision-outcome">Outcome: ' + item.outcome.summary + '</div>' +
          '</div>'
        ).join('');
      }
    }

    async function triggerCycle() {
      const btn = document.getElementById('triggerBtn');
      btn.disabled = true;
      btn.textContent = '↻ Memindai...';
      try {
        await fetch('/api/trigger', { method: 'POST' });
        await fetchStatus();
      } finally {
        btn.disabled = false;
        btn.textContent = '↻ Scan & Evaluasi Sekarang';
      }
    }

    async function changeMode() {
      const mode = document.getElementById('modeSelect').value;
      await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      await fetchStatus();
    }

    async function toggleBroadcast() {
      if (!currentState) return;
      const next = !currentState.config.autoBroadcast;
      await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoBroadcast: next }),
      });
      await fetchStatus();
    }

    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;
}

export async function startOperatorServer(
  port: number,
  handlers: OperatorServerHandlers,
  host = '0.0.0.0',
): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const state = handlers.getState();
      const uptimeSec = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      sendJson(res, 200, {
        ok: true,
        status: state.running ? 'watching' : 'stopped',
        cycleRunning: state.cycleRunning,
        cycleCount: state.cycleCount,
        uptimeSec,
        mode: state.config.mode,
        autoBroadcast: state.config.autoBroadcast,
        llmModel: state.config.model,
        chains: state.chains,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const state = handlers.getState();
      state.atRiskWatchlist = getAtRiskWatchlist();
      sendJson(res, 200, state);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watchlist') {
      const chainFilter = url.searchParams.get('chain') ?? undefined;
      sendJson(res, 200, {
        count: getAtRiskWatchlist(chainFilter).length,
        items: getAtRiskWatchlist(chainFilter),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/trigger') {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      void handlers.triggerNow();
      sendJson(res, 202, { ok: true, message: 'Watch cycle triggered' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/mode') {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const patch: Partial<{ mode: OperatorMode; autoBroadcast: boolean; minProfitUsd: number }> = {};
        if (typeof body.mode === 'string') {
          const validModes: OperatorMode[] = [
            'dry-run',
            'whitelist-only',
            'flashloan',
            'arbitrage',
            'liquidation',
            'full',
          ];
          if (validModes.includes(body.mode as OperatorMode)) {
            patch.mode = body.mode as OperatorMode;
          }
        }
        if (typeof body.autoBroadcast === 'boolean') {
          if (body.autoBroadcast === true && !process.env.OPERATOR_API_TOKEN) {
            sendJson(res, 403, {
              error:
                'Keamanan Produksi: Set OPERATOR_API_TOKEN di tools/.env untuk mengaktifkan live broadcast melalui HTTP API, atau aktifkan langsung lewat AUTO_BROADCAST=true di .env / flag --broadcast.',
            });
            return;
          }
          patch.autoBroadcast = body.autoBroadcast;
        }
        if (typeof body.minProfitUsd === 'number' && body.minProfitUsd >= 0) {
          patch.minProfitUsd = body.minProfitUsd;
        }
        handlers.updateConfig(patch);
        sendJson(res, 200, { ok: true, config: handlers.getState().config });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = renderDashboardHtml();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return server;
}
