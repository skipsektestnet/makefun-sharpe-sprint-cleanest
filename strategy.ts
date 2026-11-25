// Steady Sharpe — a paper bot for the Pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// The sprint ranks by HOURLY SHARPE, not raw PnL, and a placement still needs
// net PnL > 0 after every fee. So this bot optimises the SHAPE of returns:
// lots of equal-sized, short-lived, diversified trades (122 coins on the
// 24 h dev window, ~30 expected in a 6 h final window — comfortably above
// the 20-mint guardrail), every loss capped, no single coin able to dent an
// hour (max drawdown 0.85% on dev).
//
// What the dev window MEASURED (local simulator, full 24 h, both halves
// positive: +0.049 / +0.266 SOL) — and what it overturned:
//   * The edge is in the opening jump (the sniper's finding, re-confirmed
//     here): waiting 2-8 slots for "confirmation" buys the top — by the time
//     8 trades / 3 buyers show, the price is already up >2x and the run-up
//     cap kills every candidate. So entry stays early (age 0-5 slots) on the
//     proven filter: >=5 trades, >=2 distinct non-creator buyers, creator
//     bought 0.3-2.5 SOL of their own mint, creator has not sold, real
//     reserves 0.3-30 SOL.
//   * Tight exits HURT the Sharpe ratio, they do not help it: a partial
//     take-profit at +8% with a full +18% and a -6% stop measured +0.003 SOL
//     and Sharpe -0.04 — clipping winners kills the mean faster than it cuts
//     the variance, and the -6% stop whipsaws coins that dip then run. Wide
//     exits (+30% / -15%) measured +0.315 SOL, Sharpe 0.31. So the partial
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

/** One trade print kept on a coin's recent tape. */
interface Tick {
  slot: number;
  buy: boolean;
  lamports: bigint;
  trader: Pubkey;
}

/** Everything remembered about one launch, from its create event onward. */
interface Coin {
  mint: Pubkey;
  born: number;
  maker: Pubkey;
  /** Reserves at create time: the run-up is measured against these. */
  startQuote: bigint;
  startTokens: bigint;
  makerBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  maxDump: bigint;
  makerSold: boolean;
  lastSlot: number;
  /** Prints of the last flowSpan slots; older ones are dropped as new ones land. */
  tape: Tick[];
  buysSent: number;
  /** Never buy it again (left, filtered out for good, or finished). */
  shut: boolean;
  done: boolean;
}

/** A position we hold (or think we hold), with its running fee tally. */
interface Held {
  openedAt: number;
  feesPaid: bigint;
  peak: bigint;
  makerSoldAtEntry: boolean;
  tookFirstTp: boolean;
}

/** Curve fee taken off every sell, in bps. */
const CURVE_FEE = 125n;

/** What selling `tokens` against reserves (q, t) pays out once curve fees are taken off. */
function sellProceeds(tokens: bigint, q: bigint, t: bigint): bigint {
  if (tokens <= 0n || t <= 0n) {
    return 0n;
  }
  const gross = (tokens * q) / (t + tokens);
  const fee = (gross * CURVE_FEE + BPS - 1n) / BPS;
  return gross - fee;
}

/** A fresh position record: opened at `slot`, tx fees `fees` already paid. */
function openHeld(slot: number, fees: bigint, makerSold: boolean): Held {
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
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints that already have a sell on its way out. */
  const leaving = new Set<Pubkey>();
  const stake = BigInt(cfg.stakePerCoin);
  const floor = BigInt(cfg.floorBuy);

  /** Net lamports bought minus sold, plus distinct buyers, over the last flowSpan slots. */
  function windowFlow(coin: Coin, slot: number): { net: bigint; buyers: number } {
    const cutoff = slot - cfg.flowSpan;
    let stale = 0;
    while (stale < coin.tape.length && coin.tape[stale]!.slot <= cutoff) {
      stale += 1;
    }
    if (stale > 0) {
      coin.tape.splice(0, stale);
    }
    let net = 0n;
    const seen = new Set<Pubkey>();
    for (const tick of coin.tape) {
      if (tick.buy) {
        net += tick.lamports;
        if (tick.trader !== coin.maker) {
          seen.add(tick.trader);
        }
      } else {
        net -= tick.lamports;
      }
    }
    return { net, buyers: seen.size };
  }

  /** Whether an order of the given side for this mint is still waiting to fill. */
  function hasPendingOrder(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) {
        return true;
      }
    }
    return false;
  }

  /** Fold a batch of chain events into the per-mint tape the filters read. */
  function ingest(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        coins.set(ev.mint, {
          mint: ev.mint,
          born: ev.slot,
          maker: ev.creator,
          startQuote: BigInt(ev.virtual_quote_reserves),
          startTokens: BigInt(ev.virtual_token_reserves),
          makerBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          maxDump: 0n,
          makerSold: false,
          lastSlot: ev.slot,
          tape: [],
          buysSent: 0,
          shut: false,
          done: false,
        });
      } else if (ev.event === 'TradeEvent') {
        const coin = coins.get(ev.mint);
        if (coin === undefined) {
          continue;
        }
        const amount = BigInt(ev.sol_amount);
        coin.trades += 1;
        coin.lastSlot = ev.slot;
        coin.tape.push({ slot: ev.slot, buy: ev.is_buy, lamports: amount, trader: ev.user });
        const fromMaker = ev.user === coin.maker;
        if (ev.is_buy) {
          coin.bought += amount;
          if (fromMaker && ev.slot === coin.born) {
            coin.makerBuy += amount;
          } else if (!fromMaker) {
            coin.buyers.add(ev.user);
          }
        } else if (fromMaker) {
          coin.makerSold = true;
        } else {
          coin.soldByOthers += amount;
          const reserveBefore = BigInt(ev.real_quote_reserves) + amount;
          if (reserveBefore > 0n) {
            const share = (amount * BPS) / reserveBefore;
            if (share > coin.maxDump) {
              coin.maxDump = share;
            }
          }
        }
      } else {
        const coin = coins.get(ev.mint);
        if (coin !== undefined) {
          coin.done = true;
          coin.shut = true;
        }
      }
    }
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      ingest(batch);
      const orders: OrderInput[] = [];
      const marks = new Map<Pubkey, { q: bigint; t: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          q: BigInt(m.virtual_quote_reserves),
          t: BigInt(m.virtual_token_reserves),
        });
      }
      const perBatchCap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();

      // Reconcile fills first: track fees on held positions, open records for
      // fills we placed, drop records the harness closed for us.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          leaving.delete(f.mint);
          continue;
        }
        const rec = held.get(f.mint);
        if (f.status !== 'rejected' && rec !== undefined) {
          rec.feesPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'buy' && f.status === 'filled' && rec === undefined) {
          held.set(
            f.mint,
            openHeld(
              f.slot,
              BigInt(f.tx_fee_lamports),
              coins.get(f.mint)?.makerSold ?? false,
            ),
          );
        }
      }
      // A mint stops being "leaving" once its sell is no longer in flight.
      for (const mint of [...leaving]) {
        if (!hasPendingOrder(state, mint, 'sell')) {
          leaving.delete(mint);
        }
      }
      // Drop position records for mints we no longer hold at all.
      for (const mint of [...held.keys()]) {
        if (
          !state.positions.has(mint) &&
          !leaving.has(mint) &&
          !hasPendingOrder(state, mint, 'buy')
        ) {
          held.delete(mint);
        }
      }

      // Exits first: decide what to leave before spending on anything new.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= perBatchCap) {
          break;
        }
        if (leaving.has(mint)) {
          continue;
        }
        const coin = coins.get(mint);
        let rec = held.get(mint);
        if (rec === undefined) {
          rec = openHeld(state.slot, txFee, coin?.makerSold ?? false);
          held.set(mint, rec);
        }
        let quote = marks.get(mint);
        if (quote === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) {
            continue;
          }
          quote = { q: curve.virtual_quote_reserves, t: curve.virtual_token_reserves };
        }
        const worth = sellProceeds(pos.token_amount, quote.q, quote.t) - txFee;
        const basis = pos.cost_lamports + rec.feesPaid;
        if (worth > rec.peak) {
          rec.peak = worth;
        }
        let leave = false;
        if (basis > 0n) {
          // Partial take-profit (parked off: firstTp is 100x, never reached).
          if (
            !rec.tookFirstTp &&
            worth * BPS >= basis * (BPS + BigInt(cfg.firstTp))
          ) {
            const part = (pos.token_amount * BigInt(cfg.firstTpShare)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              leaving.add(mint);
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
        if (coin !== undefined) {
          if (cfg.leaveOnDevSell && coin.makerSold && !rec.makerSoldAtEntry) {
            leave = true;
          }
          if (windowFlow(coin, state.slot).net < -BigInt(cfg.outflowLimit)) {
            leave = true;
          }
        }
        if (!leave) {
          continue;
        }
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        leaving.add(mint);
        if (coin !== undefined) {
          coin.shut = true;
        }
      }

      // Entries: one equal-sized shot per qualifying launch, oldest first.
      let cash = state.freeCashLamports() - txFee * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      for (const coin of coins.values()) {
        if (orders.length >= perBatchCap) {
          break;
        }
        if (coin.shut || coin.done || coin.buysSent > 0) {
          continue;
        }
        const age = state.slot - coin.born;
        if (age > cfg.maxSlotAge) {
          coin.shut = true;
          continue;
        }
        if (age < cfg.minSlotAge) {
          continue;
        }
        if (openCount >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(coin.mint);
        if (curve === undefined || curve.complete) {
          continue;
        }
        if (coin.makerSold && cfg.refuseDevSold) {
          coin.shut = true;
          continue;
        }
        const reserve = curve.real_quote_reserves;
        if (reserve < BigInt(cfg.reserveLow) || reserve > BigInt(cfg.reserveHigh)) {
          continue;
        }
        if (
          coin.makerBuy < BigInt(cfg.devBuyLow) ||
          coin.makerBuy > BigInt(cfg.devBuyHigh)
        ) {
          continue;
        }
        if (
          coin.trades < cfg.tapeTradesMin ||
          coin.buyers.size < cfg.tapeBuyersMin
        ) {
          continue;
        }
        if (
          coin.bought > 0n &&
          coin.soldByOthers * BPS > coin.bought * BigInt(cfg.sellShareCap)
        ) {
          continue;
        }
        if (coin.maxDump > BigInt(cfg.bigDumpCap)) {
          continue;
        }
        const q = curve.virtual_quote_reserves;
        const t = curve.virtual_token_reserves;
        const runup = (q * coin.startTokens * BPS) / (t * coin.startQuote);
        if (runup > BigInt(cfg.runupHigh) || runup < BigInt(cfg.runupLow)) {
          continue;
        }
        const flow = windowFlow(coin, state.slot);
        if (flow.net < BigInt(cfg.flowFloor)) {
          continue;
        }
        const ceiling = state.maxBuyLamports(coin.mint);
        const amount = stake < ceiling ? stake : ceiling;
        if (amount < floor) {
          continue;
        }
        if (cash < amount + txFee * 6n) {
          continue;
        }
        orders.push({ side: 'buy', mint: coin.mint, quote_lamports: amount, max_slippage_bps: cfg.buySlip });
        cash -= amount + txFee;
        coin.buysSent += 1;
        openCount += 1;
      }
      return orders;
    },
  };
}
