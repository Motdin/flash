import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionOutcome } from './executor.js';
import type { OperatorDecision } from './llm-operator.js';

export const defaultLogPath = fileURLToPath(
  new URL('../../logs/operator.jsonl', import.meta.url),
);

export type OperatorAuditEntry = {
  cycle: number;
  chain: string;
  blockNumber: string;
  gasPriceGwei: string;
  whitelistedCount: number;
  pendingWhitelistCount: number;
  profitableRoutesCount: number;
  bestRouteSummary?: string;
  decision: OperatorDecision;
  outcome: ExecutionOutcome;
  timestamp: string;
};

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export async function appendAuditLog(
  entry: OperatorAuditEntry,
  logPath = process.env.OPERATOR_LOG_PATH ?? defaultLogPath,
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const line = `${JSON.stringify(entry, serializeBigInt)}\n`;
    await appendFile(logPath, line, 'utf8');
  } catch {
    // Do not crash daemon if filesystem is read-only
  }
}

export async function sendOperatorAlert(entry: OperatorAuditEntry): Promise<void> {
  if (entry.decision.action === 'HOLD') return;

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;

  const textMessage = [
    `⚡ *[MORPHO LLM OPERATOR]*`,
    `Chain: *${entry.chain.toUpperCase()}* (Block ${entry.blockNumber})`,
    `Action: *${entry.decision.action}* (${entry.decision.source}, conf: ${(entry.decision.confidence * 100).toFixed(0)}%)`,
    `Reason: ${entry.decision.reasoning}`,
    `Outcome: ${entry.outcome.summary}`,
    ...(entry.outcome.explorerUrls.length
      ? [`Tx: ${entry.outcome.explorerUrls.join(' , ')}`]
      : []),
  ].join('\n');

  const tasks: Promise<unknown>[] = [];

  if (webhookUrl) {
    tasks.push(
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          {
            content: textMessage,
            text: textMessage,
            event: entry.decision.action,
            chain: entry.chain,
            decision: entry.decision,
            outcome: entry.outcome,
          },
          serializeBigInt,
        ),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    );
  }

  if (tgToken && tgChatId) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChatId,
          text: textMessage,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}
