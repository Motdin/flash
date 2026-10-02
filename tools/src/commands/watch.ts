import { runWatchDaemon } from '../agent/watcher.js';
import type { OperatorMode } from '../agent/llm-operator.js';
import { loadToolEnv } from '../config/env.js';
import { ui } from '../ui/index.js';

loadToolEnv();

function parseSimpleFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    const next = argv[i + 1];
    out[key] = inline ?? (next && !next.startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}

const flags = parseSimpleFlags(process.argv.slice(2));
const chains = (flags.chains ?? flags.chain)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

runWatchDaemon({
  chains,
  intervalSec: flags.interval ? Number(flags.interval) : undefined,
  minimumUsd: flags['min-usd'] ? Number(flags['min-usd']) : undefined,
  arbLoanUsd: flags['loan-usd'] ? Number(flags['loan-usd']) : undefined,
  minProfitUsd: flags['min-profit-usd'] ? Number(flags['min-profit-usd']) : undefined,
  mode: flags.mode as OperatorMode | undefined,
  autoBroadcast: flags.broadcast !== undefined ? flags.broadcast !== 'false' : undefined,
  httpPort: flags['http-port'] !== undefined ? Number(flags['http-port']) : undefined,
  once: flags.once === 'true',
  json: flags.json === 'true',
}).catch((err: unknown) => {
  ui.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
