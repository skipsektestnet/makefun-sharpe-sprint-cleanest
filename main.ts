// Steady Sharpe — entrypoint for the Pump.fun Sharpe Sprint paper bot.
//
// The grader runs `node /bot/main.ts` (Node 22+, no build, no dependencies).
// All decisions live in strategy.ts; the agent-fun/replay/v2 wire protocol
// lives in the vendored SDK shim (vendor/makefun-bot.ts). This file only
// wires the two together: a single strategy instance, built once from the
// default parameters, answering every batch the harness sends.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// One strategy for the whole run — it carries all per-mint state itself,
// so nothing here needs to remember anything between batches.
const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
