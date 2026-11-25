// Steady Sharpe — a paper bot for the Pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// Ranking here is by HOURLY SHARPE, not raw PnL: steady, controlled gains beat
// one lucky moonshot, and a placement still needs net PnL > 0 after every fee.
// This bot therefore optimises the SHAPE of returns, not the size of any one
// trade: many equal-sized, short-lived, diversified trades (121 coins on the
// 24 h dev window, ~30 expected in a 6 h final window — safely above the
// 20-mint guardrail), every loss capped, no single coin able to dent an hour
// (max drawdown 0.85% on dev).
//
// What the dev window MEASURED (local simulator, full 24 h, both halves
// positive: +0.049 / +0.266 SOL) — and what it overturned:
//   * The opening jump is where the edge lives (the sniper's finding, and
//     re-confirmed here): waiting 2-8 slots for "confirmation" buys the top —
//     by the time 8 trades / 3 buyers show, the price is already up >2x and
//     the run-up cap kills every candidate. So entry stays early (age 0-5
//     slots) on the proven filter: >=5 trades, >=2 distinct non-creator
//     buyers, creator bought 0.3-2.5 SOL of their own mint, creator has not
//     sold, real reserves 0.3-30 SOL.
//   * Tight exits HURT the Sharpe ratio, they do not help it: partial
//     take-profit at +8% / full +18% with a -6% stop measured +0.003 SOL and
//     Sharpe -0.04 — clipping winners kills the mean faster than it cuts the
//     variance, and the -6% stop whipsaws coins that dip then run. Wide exits
//     (+30% / -15%) measured +0.315 SOL, Sharpe 0.31. So the partial
//     take-profit, the tight stop, the trailing stop (+10%/-4% cost 0.026 SOL)
//     and the outflow exit (cost 0.036 SOL) are all OFF in the final config —
//     kept as tunable knobs, parked at values that never fire.
//   * Entry is one equal 0.15 SOL shot per mint (buys are in practice capped
//     at 1% of real reserves, ~0.01-0.05 SOL, so the stake is a ceiling, not
//     a size — every position ends up similarly small, which is what keeps
//     the hourly return distribution tight). No adds, no pyramiding.
//   * Exits: take profit +30%, stop loss -15%, max hold 10 slots, leave at
//     once if the creator sells. That is the whole exit set.
//   * A stricter tape (8 trades / 3 buyers) lifts the win rate to 46% but
//     drops the mint count to 61/24 h (~15 in a 6 h window — below the
//     20-mint guardrail) and lowers both net PnL and Sharpe, so it stays off.
//
// Fully deterministic: no clock, no randomness, no I/O, no network.
// Iteration only over insertion-ordered maps fed by the batch stream.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest a mint may be, in slots since its create event, to buy it. */
  minSlotAge: number;
  /** Oldest a mint may be, in slots since its create event, for a first buy. */
  maxSlotAge: number;
  /** Lamports aimed at per mint in total (every buy stays under 1% of real SOL). */
  stakePerCoin: number;
  /** Smallest single buy worth a tx fee — and the guardrail round-trip floor. */
  floorBuy: number;
  /** Real SOL reserve window at decision time, in lamports. */
  reserveLow: number;
  reserveHigh: number;
  /** The creator's own buys in the create slot, in lamports: skin, not a bundle. */
  devBuyLow: number;
  devBuyHigh: number;
  /** Trades seen and distinct non-creator buyers seen before entry, at least. */
  tapeTradesMin: number;
  tapeBuyersMin: number;
  /** Lamports sold by others over lamports bought, in bps, at most. */
  sellShareCap: number;
  /** Biggest single non-creator sell seen, in bps of the real SOL reserve, at most. */
  bigDumpCap: number;
  /** Price now over the create price, in bps: window. */
  runupLow: number;
  runupHigh: number;
  /** The recent-flow window in slots, and what it must show (lamports, net buys). */
  flowSpan: number;
  flowFloor: number;
  /** Skip a mint whose creator already sold before entry. */
  refuseDevSold: boolean;
  /** Slippage allowed on buys, in bps. */
  buySlip: number;
  /** First take-profit: sell firstTpShare of the position at firstTp over cost. */
  firstTp: number;
  firstTpShare: number;
  /** After the first take-profit, the rest stops out this far under cost, in bps. */
  postTpStop: number;
  /** Leave when the position is worth this much over its cost, in bps. */
  takeProfit: number;
  /** Leave when it is worth this much under its cost, in bps. */
  stopLoss: number;
  /** Trailing stop: up at least trailStart, leave on a trailDrop fall from the peak. */
  trailStart: number;
  trailDrop: number;
  /** Leave after holding this many slots. */
  holdLimit: number;
  /** Leave when the creator sells while the position is held. */
  leaveOnDevSell: boolean;
  /** Leave when the recent net flow drops below minus this many lamports. */
  outflowLimit: number;
}

export const DEFAULT_PARAMS: Params = {
  minSlotAge: 0,
  maxSlotAge: 5,
  stakePerCoin: 150_000_000,
  floorBuy: 10_000_000,
  reserveLow: 300_000_000,
  reserveHigh: 30_000_000_000,
  devBuyLow: 300_000_000,
  devBuyHigh: 2_500_000_000,
  tapeTradesMin: 5,
  tapeBuyersMin: 2,
  sellShareCap: 10_000,
  bigDumpCap: 10_000,
  runupLow: 0,
  runupHigh: 1_000_000,
  flowSpan: 10,
  // Measured neutral on the dev window, parked off (see header).
  flowFloor: -1_000_000_000_000,
  refuseDevSold: true,
  buySlip: 10_000,
  // Partial take-profit measured WORSE (see header): parked off.
  firstTp: 1_000_000,
  firstTpShare: 5_000,
  postTpStop: 600,
  takeProfit: 3_000,
  stopLoss: 1_500,
  // Trailing stop measured worse: parked off.
  trailStart: 1_000_000,
  trailDrop: 400,
  holdLimit: 10,
  leaveOnDevSell: true,
  // Outflow exit measured worse: parked off.
  outflowLimit: 1_000_000_000_000,
};

interface Print {
  slot: number;
  bought: boolean;
  amount: bigint;
  trader: Pubkey;
}

interface Launch {
  id: Pubkey;
  bornSlot: number;
  maker: Pubkey;
  /** Reserves at create time: the run-up is measured against these. */
  baseQ: bigint;
  baseT: bigint;
  makerBuy: bigint;
  tradeCount: number;
  crowd: Set<Pubkey>;
  boughtTotal: bigint;
  soldByCrowd: bigint;
  worstDump: bigint;
  makerSold: boolean;
  lastSeenSlot: number;
  /** Prints of the last flowSpan slots; older ones are dropped as new ones land. */
  tape: Print[];
  buysPlaced: number;
  /** Never buy it again (left, filtered out for good, or finished). */
  closed: boolean;
  finished: boolean;
}

interface Open {
  openedAt: number;
  feesPaid: bigint;
  peak: bigint;
  makerSoldAtEntry: boolean;
  tookFirstTp: boolean;
}

const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against (q, t) pays out once curve fees are taken off. */
function exitValue(tokens: bigint, q: bigint, t: bigint): bigint {
  if (tokens <= 0n || t <= 0n) {
    return 0n;
  }
  const gross = (tokens * q) / (t + tokens);
  const fee = (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return gross - fee;
}

/** A fresh position record: opened at `slot`, tx fees `fees` already paid. */
function newOpen(slot: number, fees: bigint, makerSold: boolean): Open {
  return {
    openedAt: slot,
    feesPaid: fees,
    peak: 0n,
    makerSoldAtEntry: makerSold,
    tookFirstTp: false,
  };
}

export function createStrategy(opts: Params = DEFAULT_PARAMS) {
  const cfg = opts;
  const launches = new Map<Pubkey, Launch>();
  const holds = new Map<Pubkey, Open>();
  /** Mints that already have a sell on its way out. */
  const exiting = new Set<Pubkey>();
  const stakeAmt = BigInt(cfg.stakePerCoin);
  const floorAmt = BigInt(cfg.floorBuy);

  /** Net lamports bought minus sold, plus distinct buyers, over the last flowSpan slots. */
  function recentFlow(launch: Launch, slot: number): { net: bigint; buyers: number } {
    const from = slot - cfg.flowSpan;
    let drop = 0;
    while (drop < launch.tape.length && launch.tape[drop]!.slot <= from) {
      drop += 1;
    }
    if (drop > 0) {
      launch.tape.splice(0, drop);
    }
    let net = 0n;
    const crowd = new Set<Pubkey>();
    for (const print of launch.tape) {
      if (print.bought) {
        net += print.amount;
        if (print.trader !== launch.maker) {
          crowd.add(print.trader);
        }
      } else {
        net -= print.amount;
      }
    }
    return { net, buyers: crowd.size };
  }

  /** Whether an order of the given side for this mint is still waiting to fill. */
  function pending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) {
        return true;
      }
    }
    return false;
  }

  /** Fold a batch of chain events into the per-mint tape the filters read. */
  function absorb(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          id: e.mint,
          bornSlot: e.slot,
          maker: e.creator,
          baseQ: BigInt(e.virtual_quote_reserves),
          baseT: BigInt(e.virtual_token_reserves),
          makerBuy: 0n,
          tradeCount: 0,
          crowd: new Set(),
          boughtTotal: 0n,
          soldByCrowd: 0n,
          worstDump: 0n,
          makerSold: false,
          lastSeenSlot: e.slot,
          tape: [],
          buysPlaced: 0,
          closed: false,
          finished: false,
        });
      } else if (e.event === 'TradeEvent') {
        const launch = launches.get(e.mint);
        if (launch === undefined) {
          continue;
        }
        const amount = BigInt(e.sol_amount);
        launch.tradeCount += 1;
        launch.lastSeenSlot = e.slot;
        launch.tape.push({ slot: e.slot, bought: e.is_buy, amount, trader: e.user });
        const byMaker = e.user === launch.maker;
        if (e.is_buy) {
          launch.boughtTotal += amount;
          if (byMaker && e.slot === launch.bornSlot) {
            launch.makerBuy += amount;
          } else if (!byMaker) {
            launch.crowd.add(e.user);
          }
        } else if (byMaker) {
          launch.makerSold = true;
        } else {
          launch.soldByCrowd += amount;
          const reserveBefore = BigInt(e.real_quote_reserves) + amount;
          if (reserveBefore > 0n) {
            const share = (amount * BPS) / reserveBefore;
            if (share > launch.worstDump) {
              launch.worstDump = share;
            }
          }
        }
      } else {
        const launch = launches.get(e.mint);
        if (launch !== undefined) {
          launch.finished = true;
          launch.closed = true;
        }
      }
    }
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      absorb(batch);
      const out: OrderInput[] = [];
      const quotes = new Map<Pubkey, { q: bigint; t: bigint }>();
      for (const m of batch.marks) {
        quotes.set(m.mint, {
          q: BigInt(m.virtual_quote_reserves),
          t: BigInt(m.virtual_token_reserves),
        });
      }
      const batchCap = state.hello.caps.max_orders_per_batch;
      const fee = state.txFeeLamports();

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          holds.delete(f.mint);
          exiting.delete(f.mint);
          continue;
        }
        const rec = holds.get(f.mint);
        if (f.status !== 'rejected' && rec !== undefined) {
          rec.feesPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'buy' && f.status === 'filled' && rec === undefined) {
          holds.set(
            f.mint,
            newOpen(
              f.slot,
              BigInt(f.tx_fee_lamports),
              launches.get(f.mint)?.makerSold ?? false,
            ),
          );
        }
      }
      for (const mint of [...exiting]) {
        if (!pending(state, mint, 'sell')) {
          exiting.delete(mint);
        }
      }
      for (const mint of [...holds.keys()]) {
        if (
          !state.positions.has(mint) &&
          !exiting.has(mint) &&
          !pending(state, mint, 'buy')
        ) {
          holds.delete(mint);
        }
      }

      // Leave positions first.
      for (const [mint, pos] of state.positions) {
        if (out.length >= batchCap) {
          break;
        }
        if (exiting.has(mint)) {
          continue;
        }
        const launch = launches.get(mint);
        let rec = holds.get(mint);
        if (rec === undefined) {
          rec = newOpen(state.slot, fee, launch?.makerSold ?? false);
          holds.set(mint, rec);
        }
        let quote = quotes.get(mint);
        if (quote === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) {
            continue;
          }
          quote = { q: curve.virtual_quote_reserves, t: curve.virtual_token_reserves };
        }
        const worth = exitValue(pos.token_amount, quote.q, quote.t) - fee;
        const basis = pos.cost_lamports + rec.feesPaid;
        if (worth > rec.peak) {
          rec.peak = worth;
        }
        let leave = false;
        if (basis > 0n) {
          if (
            !rec.tookFirstTp &&
            worth * BPS >= basis * (BPS + BigInt(cfg.firstTp))
          ) {
            const part = (pos.token_amount * BigInt(cfg.firstTpShare)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              out.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              exiting.add(mint);
              rec.tookFirstTp = true;
              rec.peak = 0n;
              continue;
            }
          }
          if (worth * BPS >= basis * (BPS + BigInt(cfg.takeProfit))) {
            leave = true;
          }
          const stop = rec.tookFirstTp ? BigInt(cfg.postTpStop) : BigInt(cfg.stopLoss);
          if (worth * BPS <= basis * (BPS - stop)) {
            leave = true;
          }
          if (
            rec.peak * BPS >= basis * (BPS + BigInt(cfg.trailStart)) &&
            worth * BPS <= rec.peak * (BPS - BigInt(cfg.trailDrop))
          ) {
            leave = true;
          }
        }
        if (state.slot - rec.openedAt >= cfg.holdLimit) {
          leave = true;
        }
        if (launch !== undefined) {
          if (cfg.leaveOnDevSell && launch.makerSold && !rec.makerSoldAtEntry) {
            leave = true;
          }
          if (recentFlow(launch, state.slot).net < -BigInt(cfg.outflowLimit)) {
            leave = true;
          }
        }
        if (!leave) {
          continue;
        }
        out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        exiting.add(mint);
        if (launch !== undefined) {
          launch.closed = true;
        }
      }

      // New buys: one equal-sized shot per qualifying launch.
      let cash = state.freeCashLamports() - fee * BigInt(out.length);
      let openCount = state.committedPositionCount();
      for (const launch of launches.values()) {
        if (out.length >= batchCap) {
          break;
        }
        if (launch.closed || launch.finished || launch.buysPlaced > 0) {
          continue;
        }
        const age = state.slot - launch.bornSlot;
        if (age > cfg.maxSlotAge) {
          launch.closed = true;
          continue;
        }
        if (age < cfg.minSlotAge) {
          continue;
        }
        if (openCount >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(launch.id);
        if (curve === undefined || curve.complete) {
          continue;
        }
        if (launch.makerSold && cfg.refuseDevSold) {
          launch.closed = true;
          continue;
        }
        const reserve = curve.real_quote_reserves;
        if (reserve < BigInt(cfg.reserveLow) || reserve > BigInt(cfg.reserveHigh)) {
          continue;
        }
        if (
          launch.makerBuy < BigInt(cfg.devBuyLow) ||
          launch.makerBuy > BigInt(cfg.devBuyHigh)
        ) {
          continue;
        }
        if (
          launch.tradeCount < cfg.tapeTradesMin ||
          launch.crowd.size < cfg.tapeBuyersMin
        ) {
          continue;
        }
        if (
          launch.boughtTotal > 0n &&
          launch.soldByCrowd * BPS > launch.boughtTotal * BigInt(cfg.sellShareCap)
        ) {
          continue;
        }
        if (launch.worstDump > BigInt(cfg.bigDumpCap)) {
          continue;
        }
        const q = curve.virtual_quote_reserves;
        const t = curve.virtual_token_reserves;
        const runup = (q * launch.baseT * BPS) / (t * launch.baseQ);
        if (runup > BigInt(cfg.runupHigh) || runup < BigInt(cfg.runupLow)) {
          continue;
        }
        const fl = recentFlow(launch, state.slot);
        if (fl.net < BigInt(cfg.flowFloor)) {
          continue;
        }
        const ceiling = state.maxBuyLamports(launch.id);
        const amount = stakeAmt < ceiling ? stakeAmt : ceiling;
        if (amount < floorAmt) {
          continue;
        }
        if (cash < amount + fee * 6n) {
          continue;
        }
        out.push({ side: 'buy', mint: launch.id, quote_lamports: amount, max_slippage_bps: cfg.buySlip });
        cash -= amount + fee;
        launch.buysPlaced += 1;
        openCount += 1;
      }
      return out;
    },
  };
}
