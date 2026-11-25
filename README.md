# makefun-sharpe-sprint-cleanest

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/skipsektestnet/makefun-sharpe-sprint-cleanest/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/skipsektestnet/makefun-sharpe-sprint-cleanest/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady Sharpe: a paper trading bot for the Pump.fun Sharpe Sprint on make.fun (agent-fun/replay/v2). Places go by **hourly Sharpe ratio**, so this bot optimises the shape of returns, not the size of any one trade: many equal-sized, short-lived, diversified trades (122 coins on the 24 h dev window, ~30 expected in a 6 h final window — safely above the 20-mint guardrail), every loss capped, max drawdown 0.85%.

It buys fresh launches in their first 5 slots only when the opening tape already proves broad, real buying (≥5 trades, ≥2 distinct non-creator buyers) and the creator bought 0.3–2.5 SOL of their own coin — skin in the game, not a bundle. One 0.15 SOL shot per coin (in practice capped at 1% of real reserves, so every position ends up similarly small). It leaves at take profit +30%, stop loss −15%, max hold 10 slots, or the moment the creator sells.

What the dev window measured: tight exits hurt the Sharpe ratio — a partial take-profit at +8% with a −6% stop scored +0.003 SOL and Sharpe −0.04, while the wide exits scored +0.315 SOL and Sharpe 0.31 in the local simulator. Waiting 2–8 slots for "confirmation" buys the top (price already up >2x by then), and a stricter tape lifts the win rate to 46% but drops the mint count below the guardrail for a 6 h window. So the partial take-profit, trailing stop and outflow exit are parked off as tunable knobs.

## Run it

The grader runs `node /bot/main.ts` (Node 22+, no dependencies, no build).

## Local results (dev window, kit dataset, 24 h)

**Kit grade-local (`--driver process`, two executions, reproduced byte for byte):**

- Net PnL: **+0.274 SOL** (return +2.74%; 90% interval −0.006 .. +0.605 SOL)
- 244 fills over **122 coins, 122 round trips** (all ≥0.01 SOL), win rate 34.4%, max drawdown 0.85%, 0 rejected
- Fees: 0.197 SOL curve + 0.026 SOL tx; at 2x fees still **+0.050 SOL**
- Top 3 coins made 33% of the gains; without them net PnL is still +0.05 SOL
- Guardrails: **met** (≥20 coins with round trips ≥0.01 SOL, drawdown ≤50%)

**Local simulator (same window, hourly Sharpe):** net +0.315 SOL, hourly Sharpe **0.31**, both halves positive (+0.049 / +0.266 SOL).

## Files

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the bot: launch filter, entries, exits.
- `vendor/makefun-bot.ts` — the kit's SDK shim, byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jeq52989&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
