// Surge Scalper — a deterministic paper bot for the pump.fun replay sprint.
//
// Idea: most pump.fun curves bleed out, but a minority surge on real buy pressure
// shortly after launch. This bot buys small into a confirmed surge (several
// distinct buyers, net SOL flowing in, price climbing and holding near its
// short-window high), then exits fast: a modest take-profit, a tight stop-loss,
// a trailing stop once the trade is up, and a fade exit when the flow turns.
// Positions are capped hard so no single coin can hurt the run, and tiny
// probe round-trips keep the run above the competition's guardrail
// (a round trip of at least 0.01 SOL on at least 20 coins) when the main
// signal is quiet.
//
// Deterministic by construction: every decision comes only from the batch
// stream (hello, batch, orders, slot) — no clock, no randomness, no network,
// no environment. Iteration is over insertion-ordered maps fed by the batches,
// so two runs of the same replay produce identical orders.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window, in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window needed to enter. */
  minNetSol: number;
  /** Buy trades in the window needed to enter. */
  minBuys: number;
  /** Distinct buying wallets in the window needed to enter. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL (avoid one-wallet pumps). */
  maxBuyerShare: number;
  /** Real SOL reserve bounds of a curve at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** First buy of a position, in SOL. */
  initialSol: number;
  /** Each pyramid add-on buy, in SOL. */
  addSol: number;
  /** Total SOL per position at most. */
  maxPerPositionSol: number;
  /** Smallest buy worth sending, in SOL. */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell when value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop arms once peak value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then sell when value falls below peak * (1 - trail). */
  trail: number;
  /** Fade exit: sell when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Sell on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Sell after this many slots held, unless the position is up enough. */
  maxHold: number;
  /** ...unless value is at least cost * (1 + holdIfUp). */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the whole run. */
  maxEntries: number;
  /** Most main positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target coins and fills by the end of the window. */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time the pace is measured over. */
  paceSecs: number;
  /** Size of one guardrail probe round trip, in SOL. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 50,
  minNetSol: 0.4,
  minBuys: 4,
  minBuyers: 4,
  minPriceUp: 0.06,
  nearHigh: 0.95,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 50,
  minAge: 100,
  initialSol: 0.1,
  addSol: 0.1,
  maxPerPositionSol: 0.5,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.15,
  takeProfit: 0.3,
  trailArm: 0.12,
  trail: 0.18,
  fadeWindow: 25,
  fadeNetSol: 0.25,
  bigSellSol: 1.5,
  maxHold: 1500,
  holdIfUp: 0.1,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  maxExposureSol: 3,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 86400,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee: 0.95% protocol + 0.30% creator (fallback bps from hello). */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastValue: number;
}

export function createBot(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** True when a curve's recent tape shows a healthy surge worth buying. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        // The last trade at or before the window start anchors the rise.
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** What a position is worth now in SOL, after curve fee and one tx fee. */
  const positionValue = (
    tokens: number,
    vq: number,
    vt: number,
    txSol: number,
  ): number => {
    const quoteOut = (tokens * vq) / (vt + tokens);
    return (quoteOut / LAMPORTS) * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // --- Exits first: take-profit, trailing stop, stop-loss, fade, big sell, max hold.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = positionValue(Number(pos.token_amount), vq, vt, txSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value < h.peak * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = p.initialSol;
        } else {
          // Pyramid into strength only: price stepped up from the last buy
          // and net SOL still flows in.
          if (h.exiting || !h.filled || h.invested >= p.maxPerPositionSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * 1.08) continue;
          if (flow(t, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxPerPositionSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peak: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastBuyPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
        }
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
