import type { OperatorMode } from './llm-operator.js';
import type { OperatorRuntimeState } from './server.js';

export type TelegramControllerHandlers = {
  getState: () => OperatorRuntimeState;
  triggerNow: () => Promise<void>;
  updateConfig: (
    patch: Partial<{
      mode: OperatorMode;
      autoBroadcast: boolean;
      minProfitUsd: number;
      resetCircuitBreaker: boolean;
    }>,
  ) => void;
};

type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
};

type TgInlineButton = { text: string; callback_data: string };

export type ParsedTelegramCommand = {
  command: string;
  arg: string;
};

export function parseTelegramCommand(rawText: string): ParsedTelegramCommand {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) {
    return { command: 'ask', arg: trimmed };
  }
  const [firstToken, ...rest] = trimmed.split(/\s+/);
  // Strip '/command@BotName' suffix if used in a group
  const cmd = firstToken.slice(1).split('@')[0].toLowerCase();
  return {
    command: cmd,
    arg: rest.join(' ').trim(),
  };
}

export function isTelegramAuthorized(
  chatId: number | string,
  userId: number | string | undefined,
  allowedChatIdEnv = process.env.TELEGRAM_CHAT_ID,
  allowedAdminsEnv = process.env.TELEGRAM_ADMIN_IDS,
): boolean {
  const allowedSet = new Set<string>();
  for (const raw of [allowedChatIdEnv, allowedAdminsEnv]) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const cleaned = part.trim();
      if (cleaned) allowedSet.add(cleaned);
    }
  }
  if (allowedSet.size === 0) return false;
  if (allowedSet.has(String(chatId))) return true;
  if (userId !== undefined && allowedSet.has(String(userId))) return true;
  return false;
}

export function formatStatusMessage(state: OperatorRuntimeState): string {
  const uptimeSec = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
  const mins = Math.floor(uptimeSec / 60);
  const secs = uptimeSec % 60;

  const lines = [
    `⚡ *MORPHO LLM OPERATOR — VPS STATUS*`,
    ``,
    `• *Status:* ${state.cycleRunning ? '🔄 Scanning...' : '🟢 Active / Watching'}`,
    `• *Mode:* \`${state.config.mode}\``,
    `• *Broadcast:* ${state.config.autoBroadcast ? '🔴 LIVE (ON-CHAIN)' : '🟡 SIMULATION (OFF)'}`,
    `• *Circuit Breaker:* ${state.circuitBreakerTripped ? '🚨 TRIPPED (Auto-Paused)' : `✅ OK (Fail: ${state.consecutiveFailures})`}`,
    `• *LLM Model:* \`${state.config.model}\``,
    `• *Chains:* \`${state.chains.join(', ')}\``,
    `• *Siklus:* ${state.cycleCount} (Interval: ${state.intervalSec}s)`,
    `• *Min Profit / Loan:* $${state.config.minProfitUsd} / $${state.arbLoanUsd.toLocaleString('en-US')}`,
    `• *Max Gas:* ${state.config.maxGasGwei} gwei`,
    `• *Uptime:* ${mins}m ${secs}s`,
  ];

  const lastDecision = state.recentHistory[0];
  if (lastDecision) {
    lines.push(
      ``,
      `🧠 *Keputusan Terakhir (${lastDecision.chain.toUpperCase()}):*`,
      `• Aksi: *${lastDecision.decision.action}* (${Math.round(lastDecision.decision.confidence * 100)}%)`,
      `• Alasan: ${lastDecision.decision.reasoning}`,
      `• Hasil: ${lastDecision.outcome.summary}`,
    );
  }

  return lines.join('\n');
}

export function formatWhitelistMessage(state: OperatorRuntimeState): string {
  const reports = Object.values(state.latestReports);
  if (reports.length === 0) {
    return `🛡️ *STATUS WHITELIST*\nBelum ada data scan. Tekan *Scan Sekarang* atau ketik /scan.`;
  }

  const lines = [`🛡️ *STATUS WHITELIST & LIKUIDITAS MORPHO*`];
  for (const rep of reports) {
    const whitelisted = rep.whitelistedAssets.map((a) => a.symbol).join(', ') || 'Tidak ada';
    const pending = rep.pendingWhitelistAssets.map((a) => a.symbol).join(', ') || 'Tidak ada';
    lines.push(
      ``,
      `*${rep.chain.name.toUpperCase()}* (Block \`${rep.blockNumber}\`)`,
      `• ✅ Whitelisted: \`${whitelisted}\``,
      `• ⏳ Pending Sync: \`${pending}\``,
    );
    for (const token of rep.tokenWhitelists.slice(0, 6)) {
      lines.push(
        `  - *${token.symbol}*: $${Math.round(token.usdValue ?? 0).toLocaleString('en-US')} (${
          token.allowedOnFlashExecutor ? '✅ Flash' : '⏳ Flash'
        }${rep.arbExecutor ? (token.allowedOnArbExecutor ? ' | ✅ Arb' : ' | ⏳ Arb') : ''})`,
      );
    }
  }
  return lines.join('\n');
}

export function formatArbitrageMessage(state: OperatorRuntimeState): string {
  const reports = Object.values(state.latestReports);
  if (reports.length === 0) {
    return `📈 *KANDIDAT ARBITRASE DEX*\nBelum ada data quote DEX. Ketik /scan untuk memindai.`;
  }

  const lines = [`📈 *TOP KANDIDAT ARBITRASE DEX (V2)*`];
  for (const rep of reports) {
    lines.push(``, `*${rep.chain.name.toUpperCase()}* (Gas: \`${Number(rep.gasPriceGwei).toFixed(3)} gwei\`)`);
    const top = rep.arbitrageCandidates.slice(0, 4);
    if (top.length === 0) {
      lines.push(`• Belum ada pasangan rute DEX yang dievaluasi.`);
      continue;
    }
    for (const c of top) {
      const icon = c.profitable ? '🟢' : '⚪';
      lines.push(
        `• ${icon} *${c.loanSymbol} → ${c.intermediateSymbol}* (${c.firstRouterName} → ${c.secondRouterName})`,
        `  Spread: \`${c.spreadBps} bps\` | Gas: \`$${c.estimatedGasCostUsd.toFixed(3)}\` | Net: *$$${c.netProfitUsd.toFixed(2)}*`,
      );
    }
  }
  return lines.join('\n');
}

export function formatHistoryMessage(state: OperatorRuntimeState): string {
  if (state.recentHistory.length === 0) {
    return `📜 *RIWAYAT OPERATOR LLM*\nBelum ada siklus evaluasi yang tercatat.`;
  }
  const lines = [`📜 *RIWAYAT KEPUTUSAN LLM & EKSEKUSI (5 Terakhir)*`];
  for (const item of state.recentHistory.slice(0, 5)) {
    lines.push(
      ``,
      `*[#${item.cycle}] ${item.chain.toUpperCase()}* — *${item.decision.action}*`,
      `• Alasan: ${item.decision.reasoning}`,
      `• Outcome: ${item.outcome.summary}`,
    );
  }
  return lines.join('\n');
}

function buildMainMenuKeyboard(state: OperatorRuntimeState): TgInlineButton[][] {
  const bcastLabel = state.config.autoBroadcast
    ? '🔴 Broadcast: LIVE (Klik -> OFF)'
    : '🟡 Broadcast: SIMULASI (Klik -> ON)';
  return [
    [
      { text: '📊 Status', callback_data: 'cmd:status' },
      { text: '🔄 Scan Sekarang', callback_data: 'cmd:scan' },
    ],
    [
      { text: '🛡️ Whitelist', callback_data: 'cmd:whitelist' },
      { text: '📈 Quote Arbitrase', callback_data: 'cmd:arb' },
    ],
    [
      { text: '📜 Riwayat LLM', callback_data: 'cmd:history' },
      { text: bcastLabel, callback_data: 'cmd:toggle_broadcast' },
    ],
    [
      { text: 'Mode: dry-run', callback_data: 'mode:dry-run' },
      { text: 'Mode: whitelist', callback_data: 'mode:whitelist-only' },
    ],
    [
      { text: 'Mode: flashloan', callback_data: 'mode:flashloan' },
      { text: 'Mode: arbitrage', callback_data: 'mode:arbitrage' },
      { text: 'Mode: FULL', callback_data: 'mode:full' },
    ],
  ];
}

async function askLlmFromTelegram(
  question: string,
  state: OperatorRuntimeState,
): Promise<string> {
  const cfg = state.config;
  if (!cfg.apiKey && !cfg.baseUrl.includes('127.0.0.1') && !cfg.baseUrl.includes('localhost')) {
    return (
      `🤖 *Info Operator (Mode Deterministik)*\n` +
      `LLM_API_KEY belum diisi di \`.env\`, namun berikut status terkini:\n\n` +
      formatStatusMessage(state)
    );
  }

  const contextSnapshot = {
    mode: cfg.mode,
    autoBroadcast: cfg.autoBroadcast,
    minProfitUsd: cfg.minProfitUsd,
    chains: Object.values(state.latestReports).map((r) => ({
      chain: r.chain.key,
      block: r.blockNumber.toString(),
      gasGwei: r.gasPriceGwei,
      whitelisted: r.whitelistedAssets.map((a) => a.symbol),
      pendingWhitelist: r.pendingWhitelistAssets.map((a) => a.symbol),
      topRoutes: r.arbitrageCandidates.slice(0, 3).map((c) => ({
        route: `${c.loanSymbol}->${c.intermediateSymbol}`,
        dex: `${c.firstRouterName}->${c.secondRouterName}`,
        spreadBps: c.spreadBps,
        netProfitUsd: c.netProfitUsd,
        profitable: c.profitable,
      })),
    })),
    lastDecision: state.recentHistory[0] ?? null,
  };

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Anda adalah asisten operator Morpho Flashloan & Arbitrage di VPS yang dikendalikan via Telegram. Jawab pertanyaan pengguna dengan ringkas, akurat, dan dalam Bahasa Indonesia berdasarkan data on-chain real-time berikut.',
          },
          {
            role: 'user',
            content: `Data On-Chain Saat Ini:\n${JSON.stringify(contextSnapshot)}\n\nPertanyaan Operator: ${question}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = body.choices?.[0]?.message?.content?.trim();
    return answer ? `🤖 *LLM Operator (${cfg.model}):*\n\n${answer}` : 'Tidak ada respons dari LLM.';
  } catch (err) {
    return `⚠️ Gagal menghubungi LLM (${err instanceof Error ? err.message : String(err)}).\n\n${formatStatusMessage(state)}`;
  }
}

export async function handleTelegramCommand(
  rawText: string,
  handlers: TelegramControllerHandlers,
): Promise<{ reply: string; showMenu: boolean }> {
  const { command, arg } = parseTelegramCommand(rawText);
  const state = handlers.getState();

  switch (command) {
    case 'start':
    case 'menu':
    case 'help':
      return {
        reply:
          `⚡ *PANEL KONTROL TELEGRAM — MORPHO LLM OPERATOR*\n\n` +
          `Gunakan tombol di bawah atau perintah berikut:\n` +
          `• \`/status\` — Status daemon & keputusan terakhir\n` +
          `• \`/scan\` — Pindai ulang chain & evaluasi LLM sekarang\n` +
          `• \`/whitelist\` — Cek token whitelisted & pending allowlist\n` +
          `• \`/arb\` — Cek spread & profit rute DEX V2\n` +
          `• \`/history\` — 5 keputusan terakhir operator LLM\n` +
          `• \`/mode <nama>\` — Ubah mode (\`dry-run\`, \`whitelist-only\`, \`flashloan\`, \`arbitrage\`, \`full\`)\n` +
          `• \`/broadcast <on|off>\` — Aktifkan/matikan transaksi live\n` +
          `• \`/profit <usd>\` — Ubah minimum profit USD (contoh: \`/profit 10\`)\n` +
          `• \`/ask <pertanyaan>\` — Tanya langsung ke LLM Operator`,
        showMenu: true,
      };

    case 'status':
      return { reply: formatStatusMessage(state), showMenu: true };

    case 'whitelist':
      return { reply: formatWhitelistMessage(state), showMenu: true };

    case 'arb':
    case 'quotes':
      return { reply: formatArbitrageMessage(state), showMenu: true };

    case 'history':
    case 'logs':
      return { reply: formatHistoryMessage(state), showMenu: true };

    case 'scan':
    case 'trigger':
      await handlers.triggerNow();
      return {
        reply: `✅ *Siklus scan & evaluasi LLM selesai dijalankan!*\n\n${formatStatusMessage(handlers.getState())}`,
        showMenu: true,
      };

    case 'mode': {
      const target = arg.toLowerCase() as OperatorMode;
      const valid: OperatorMode[] = ['dry-run', 'whitelist-only', 'flashloan', 'arbitrage', 'full'];
      if (!valid.includes(target)) {
        return {
          reply: `⚠️ Mode tidak valid. Pilih salah satu:\n\`/mode dry-run\`\n\`/mode whitelist-only\`\n\`/mode flashloan\`\n\`/mode arbitrage\`\n\`/mode full\``,
          showMenu: true,
        };
      }
      handlers.updateConfig({ mode: target });
      return {
        reply: `✅ Mode operator berhasil diubah ke *${target}*!`,
        showMenu: true,
      };
    }

    case 'broadcast': {
      const val = arg.toLowerCase();
      if (val !== 'on' && val !== 'off') {
        return {
          reply: `⚠️ Gunakan \`/broadcast on\` atau \`/broadcast off\`.`,
          showMenu: true,
        };
      }
      const next = val === 'on';
      handlers.updateConfig({ autoBroadcast: next, resetCircuitBreaker: next });
      return {
        reply: next
          ? `🔴 *LIVE BROADCAST DIAKTIFKAN!* Operator akan mengirim transaksi on-chain setelah simulasi lulus.`
          : `🟡 *LIVE BROADCAST DINONAKTIFKAN.* Operator kembali ke mode simulasi aman.`,
        showMenu: true,
      };
    }

    case 'profit': {
      const num = Number(arg);
      if (!Number.isFinite(num) || num < 0) {
        return {
          reply: `⚠️ Masukkan angka USD yang valid, contoh: \`/profit 10\``,
          showMenu: false,
        };
      }
      handlers.updateConfig({ minProfitUsd: num });
      return {
        reply: `✅ Target minimum profit bersih diubah menjadi *$${num.toFixed(2)}* setelah gas.`,
        showMenu: true,
      };
    }

    case 'ask': {
      if (!arg) {
        return {
          reply: `Ketik pertanyaan Anda setelah \`/ask\`, contoh:\n\`/ask rute mana yang paling potensial sekarang?\``,
          showMenu: false,
        };
      }
      const answer = await askLlmFromTelegram(arg, state);
      return { reply: answer, showMenu: false };
    }

    default:
      return {
        reply: `Perintah \`/${command}\` tidak dikenal. Ketik \`/menu\` untuk melihat daftar kontrol.`,
        showMenu: true,
      };
  }
}

export function startTelegramBotController(handlers: TelegramControllerHandlers): {
  stop: () => void;
} {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { stop: () => undefined };
  }

  let running = true;
  let offset = 0;
  const apiBase = `https://api.telegram.org/bot${token}`;

  const sendMessage = async (
    targetChatId: number | string,
    text: string,
    showMenu = false,
  ): Promise<void> => {
    try {
      await fetch(`${apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          ...(showMenu
            ? {
                reply_markup: {
                  inline_keyboard: buildMainMenuKeyboard(handlers.getState()),
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Ignore network hiccups on Telegram send
    }
  };

  const answerCallback = async (callbackId: string, text?: string): Promise<void> => {
    try {
      await fetch(`${apiBase}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackId,
          ...(text ? { text } : {}),
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Ignore
    }
  };

  const pollLoop = async (): Promise<void> => {
    while (running) {
      try {
        const res = await fetch(
          `${apiBase}/getUpdates?offset=${offset}&timeout=20&allowed_updates=["message","callback_query"]`,
          { signal: AbortSignal.timeout(25_000) },
        );
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
        for (const update of data.result ?? []) {
          offset = Math.max(offset, update.update_id + 1);

          if (update.message?.text) {
            const msg = update.message;
            const msgText = msg.text ?? '';
            if (!isTelegramAuthorized(msg.chat.id, msg.from?.id)) continue;
            const { reply, showMenu } = await handleTelegramCommand(msgText, handlers);
            await sendMessage(msg.chat.id, reply, showMenu);
          } else if (update.callback_query?.data) {
            const cb = update.callback_query;
            const dataStr = cb.data ?? '';
            const cbChatId = cb.message?.chat.id;
            if (!cbChatId || !isTelegramAuthorized(cbChatId, cb.from.id)) {
              await answerCallback(cb.id, 'Unauthorized');
              continue;
            }

            if (dataStr.startsWith('mode:')) {
              const nextMode = dataStr.slice(5) as OperatorMode;
              handlers.updateConfig({ mode: nextMode });
              await answerCallback(cb.id, `Mode diubah ke ${nextMode}`);
              await sendMessage(cbChatId, `✅ Mode operator diubah ke *${nextMode}*`, true);
            } else if (dataStr === 'cmd:toggle_broadcast') {
              const nextBcast = !handlers.getState().config.autoBroadcast;
              handlers.updateConfig({
                autoBroadcast: nextBcast,
                resetCircuitBreaker: nextBcast,
              });
              await answerCallback(
                cb.id,
                nextBcast ? 'Broadcast LIVE ON' : 'Broadcast SIMULASI OFF',
              );
              await sendMessage(
                cbChatId,
                nextBcast
                  ? `🔴 *LIVE BROADCAST DIAKTIFKAN!*`
                  : `🟡 *LIVE BROADCAST DINONAKTIFKAN (Mode Simulasi).*`,
                true,
              );
            } else if (dataStr.startsWith('cmd:')) {
              const subCmd = dataStr.slice(4);
              await answerCallback(cb.id, `Menjalankan /${subCmd}...`);
              const { reply, showMenu } = await handleTelegramCommand(`/${subCmd}`, handlers);
              await sendMessage(cbChatId, reply, showMenu);
            }
          }
        }
      } catch {
        if (running) {
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
  };

  void pollLoop();

  return {
    stop: () => {
      running = false;
    },
  };
}
