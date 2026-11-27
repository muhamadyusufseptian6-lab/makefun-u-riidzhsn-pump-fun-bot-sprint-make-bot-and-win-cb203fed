// Tangga Petir — a pump.fun replay bot for agent-fun/replay/v2.
//
// Idea, in one paragraph: most pump.fun coins that ever pay do their paying
// early, while the crowd is still arriving — but only when the crowd is
// actually still buying. So this bot only buys young coins whose recent trade
// flow is buy-dominated (at least 70% of the last 20 trades' SOL volume is
// buys), that have climbed a little off their own low (+8%) without already
// running away (+100% cap, no vertical blow-off tops), risks a fixed small
// ticket (0.25 SOL) on each, and then runs the classic asymmetric book:
// losers are cut fast at -8%, half comes off at +20%, and the rest rides a
// trailing stop — once a coin has peaked at +40% or more, everything goes
// if it falls 20 points off its peak, so a runner can pay +100% or more
// while a winner never turns back into a loser. Anything still flat after
// 1000 slots is sold so the cash can go find a livelier coin. Five open
// positions at most, so one bad coin can never sink the run,
// and the 20-coin round-trip bar is met by turning the book over, not by
// betting big on one mint. A rejected order is never spammed: buys and sells
// cool down after a rejection instead of retrying every batch.
//
// Determinism: every decision comes only from the events the harness
// delivers. No clock, no environment, no Math.random — only integer math on
// the reserves, so two runs produce the same action log byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, Fill } from './vendor/makefun-bot.ts';

// Scale for fixed-point prices: price = virtual_quote * SCALE / virtual_token.
const SCALE = 1_000_000n;

// --- knobs (all in fixed units; tune the idea, not the tape) ----------------
const BUY_LAMPORTS = 250_000_000n; // 0.25 SOL per ticket
const MIN_BUY_LAMPORTS = 20_000_000n; // below this the ticket is not worth its fees
const CASH_RESERVE_LAMPORTS = 300_000_000n; // never deploy the last 0.3 SOL
const MAX_OPEN_POSITIONS = 5; // hello.caps.max_open_positions
const MAX_BUYS_PER_MINT = 3; // spread the book, don't marry one coin
const MAX_TRADES_TO_ENTER = 120; // only young coins
const MIN_TRADES_TO_ENTER = 3; // need at least a hint of a trend
const FLOW_WINDOW = 20; // recent trades the buy-pressure filter looks at
const MIN_BUY_SHARE_BPS = 7000; // >=70% of recent trade SOL volume must be buys
const RISE_OFF_LOW_BPS = 800; // +8% off the coin's own low: enter early
const RISE_OFF_START_BPS = 300; // +3% above where it started
const MAX_RUN_UP_BPS = 10000; // never chase past +100% from the start
const SPIKE_TRADES = 10; // a >50% jump inside this many trades is a blow-off top
const SPIKE_BPS = 5000;
const TAKE_HALF_BPS = 2000; // +20%: sell half
const TRAIL_TRIGGER_BPS = 4000; // once the peak gain reaches +40% ...
const TRAIL_DROP_BPS = 2000; // ... sell the rest if it falls 20 points off peak
const STOP_LOSS_BPS = -800; // -8%: sell everything
const STALE_SLOTS = 1000; // flat this long: sell and move on
const LOSS_COOLDOWN_SLOTS = 50; // after a losing exit, leave the coin alone
const BUY_REJECT_COOLDOWN_SLOTS = 25; // after a rejected buy, stop spamming it
const SELL_REJECT_COOLDOWN_SLOTS = 10; // after a rejected sell, wait before retry
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 2000;

interface CoinMemory {
  firstPrice: bigint;
  lowPrice: bigint;
  highPrice: bigint;
  lastPrice: bigint;
  trades: number;
  buys: number;
  entryPrice: bigint; // SOL per token, scaled by SCALE, from the buy fill
  peakGainBps: bigint; // best gain since entry, in bps (for the trailing stop)
  buySlot: number; // slot the buy order was decided on
  halfSold: boolean;
  lastLossSlot: number; // slot of the last stop-loss exit, -1 when none
  lastBuyRejectSlot: number;
  lastSellRejectSlot: number;
  // Recent trade flow: ring of the last FLOW_WINDOW trades, SOL volume by side.
  flowBuySol: bigint;
  flowSellSol: bigint;
  flowCount: number;
  flowSlots: number[]; // slots of the trades in the window, oldest first
  flowSides: boolean[]; // is_buy per trade in the window
  flowAmounts: bigint[]; // sol_amount per trade in the window
  recentLow: bigint; // lowest price over the last SPIKE_TRADES trades
  recentLowTrades: number; // trade count when recentLow was set
}

const memory = new Map<string, CoinMemory>();

function newMemory(price: bigint, trades: number): CoinMemory {
  return {
    firstPrice: price,
    lowPrice: price,
    highPrice: price,
    lastPrice: price,
    trades,
    buys: 0,
    entryPrice: 0n,
    peakGainBps: 0n,
    buySlot: -1,
    halfSold: false,
    lastLossSlot: -1,
    lastBuyRejectSlot: -1,
    lastSellRejectSlot: -1,
    flowBuySol: 0n,
    flowSellSol: 0n,
    flowCount: 0,
    flowSlots: [],
    flowSides: [],
    flowAmounts: [],
    recentLow: price,
    recentLowTrades: trades,
  };
}

function priceOf(vq: bigint, vt: bigint): bigint {
  if (vt <= 0n) return 0n;
  return (vq * SCALE) / vt;
}

// Gain of `price` against `entry`, in basis points (can be negative).
function gainBps(price: bigint, entry: bigint): bigint {
  if (entry <= 0n) return 0n;
  return ((price - entry) * 10_000n) / entry;
}

function observe(state: BotState, batch: Batch): void {
  // Fold this batch's trades into each coin's flow window first, so the
  // price and flow the decisions below use include the latest trade.
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const mem = memory.get(e.mint);
    if (mem === undefined) continue;
    const amount = BigInt(e.sol_amount);
    mem.flowSides.push(e.is_buy);
    mem.flowAmounts.push(amount);
    mem.flowSlots.push(e.slot);
    if (e.is_buy) mem.flowBuySol += amount;
    else mem.flowSellSol += amount;
    mem.flowCount++;
    if (mem.flowSides.length > FLOW_WINDOW) {
      const oldSide = mem.flowSides.shift()!;
      const oldAmount = mem.flowAmounts.shift()!;
      mem.flowSlots.shift();
      if (oldSide) mem.flowBuySol -= oldAmount;
      else mem.flowSellSol -= oldAmount;
    }
  }
  for (const curve of state.curves.values()) {
    if (curve.complete) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0n) continue;
    let mem = memory.get(curve.mint);
    if (mem === undefined) {
      memory.set(curve.mint, newMemory(price, curve.trades));
    } else {
      mem.lastPrice = price;
      if (price < mem.lowPrice) mem.lowPrice = price;
      if (price > mem.highPrice) mem.highPrice = price;
      if (mem.entryPrice > 0n) {
        const gain = gainBps(price, mem.entryPrice);
        if (gain > mem.peakGainBps) mem.peakGainBps = gain;
      }
      // Rolling low over the last SPIKE_TRADES trades: reset when the window
      // has moved past the trade that set it.
      if (price < mem.recentLow) {
        mem.recentLow = price;
        mem.recentLowTrades = curve.trades;
      } else if (curve.trades - mem.recentLowTrades > SPIKE_TRADES) {
        mem.recentLow = price;
        mem.recentLowTrades = curve.trades;
      }
      mem.trades = curve.trades;
    }
  }
}

function foldFills(batch: Batch, state: BotState): void {
  for (const fill of batch.fills as Fill[]) {
    const mem = memory.get(fill.mint);
    if (mem === undefined) continue;
    if (fill.status === 'rejected') {
      if (fill.side === 'buy') mem.lastBuyRejectSlot = state.slot;
      else mem.lastSellRejectSlot = state.slot;
      continue;
    }
    if (fill.status !== 'filled') continue;
    if (fill.side === 'buy') {
      const tokens = BigInt(fill.token_amount);
      const spent = BigInt(fill.quote_lamports);
      if (tokens > 0n && spent > 0n) {
        mem.entryPrice = (spent * SCALE) / tokens;
        mem.buySlot = fill.decided_slot;
        mem.halfSold = false;
        mem.buys += 1;
      }
    } else {
      // A sell fill: if we sold everything, the position is closed.
      const holding = state.positions.get(fill.mint);
      if (holding === undefined || holding.token_amount <= 0n) {
        const gain = gainBps(mem.lastPrice, mem.entryPrice);
        if (gain < 0n) mem.lastLossSlot = state.slot;
        mem.entryPrice = 0n;
        mem.peakGainBps = 0n;
        mem.buySlot = -1;
        mem.halfSold = false;
      } else if (mem.halfSold === false) {
        mem.halfSold = true;
      }
    }
  }
}

function pendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function pendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

await runBot({
  onBatch(state, batch) {
    observe(state, batch);
    foldFills(batch, state);

    const orders: { side: 'buy' | 'sell'; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }[] = [];

    // --- exits first: protect what we hold before opening anything new -----
    for (const [mint, holding] of state.positions) {
      if (pendingSell(state, mint)) continue;
      const mem = memory.get(mint);
      if (mem === undefined || mem.entryPrice <= 0n) continue;
      if (mem.lastSellRejectSlot >= 0 && state.slot - mem.lastSellRejectSlot < SELL_REJECT_COOLDOWN_SLOTS) continue;
      const price = mem.lastPrice;
      if (price <= 0n) continue;
      const gain = gainBps(price, mem.entryPrice);
      const tokens = holding.token_amount;
      if (tokens <= 0n) continue;

      if (gain <= STOP_LOSS_BPS) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (mem.peakGainBps >= TRAIL_TRIGGER_BPS && gain <= mem.peakGainBps - BigInt(TRAIL_DROP_BPS)) {
        // Trailing stop: a runner that peaked at +40% or more and has now
        // fallen 20 points off its peak — bank what is left of the run.
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      } else if (gain >= TAKE_HALF_BPS && !mem.halfSold) {
        const half = tokens / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SELL_SLIPPAGE_BPS });
        }
      } else if (mem.buySlot >= 0 && state.slot - mem.buySlot >= STALE_SLOTS) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // --- entries: young climbers with buy-dominated flow only ---------------
    if (state.committedPositionCount() < MAX_OPEN_POSITIONS) {
      let freeCash = state.freeCashLamports();
      for (const curve of state.curves.values()) {
        if (orders.length >= 16) break;
        if (state.committedPositionCount() + countNewBuys(orders) >= MAX_OPEN_POSITIONS) break;
        if (curve.complete) continue;
        if (state.positions.has(curve.mint)) continue;
        if (pendingBuy(state, curve.mint)) continue;
        const mem = memory.get(curve.mint);
        if (mem === undefined) continue;
        if (mem.buys >= MAX_BUYS_PER_MINT) continue;
        if (mem.trades < MIN_TRADES_TO_ENTER || mem.trades > MAX_TRADES_TO_ENTER) continue;
        if (mem.lastLossSlot >= 0 && state.slot - mem.lastLossSlot < LOSS_COOLDOWN_SLOTS) continue;
        if (mem.lastBuyRejectSlot >= 0 && state.slot - mem.lastBuyRejectSlot < BUY_REJECT_COOLDOWN_SLOTS) continue;
        const price = mem.lastPrice;
        if (price <= 0n) continue;
        if (gainBps(price, mem.lowPrice) < RISE_OFF_LOW_BPS) continue;
        if (gainBps(price, mem.firstPrice) < RISE_OFF_START_BPS) continue;
        if (gainBps(price, mem.firstPrice) > MAX_RUN_UP_BPS) continue;
        // No vertical blow-off tops: a >50% jump inside the last 10 trades
        // is a spike already spent, not a trend to join.
        if (gainBps(price, mem.recentLow) > SPIKE_BPS) continue;
        // Buy pressure: most of the recent trade SOL must be buys.
        if (mem.flowCount < 5) continue;
        const flowTotal = mem.flowBuySol + mem.flowSellSol;
        if (flowTotal <= 0n) continue;
        if ((mem.flowBuySol * 10_000n) / flowTotal < MIN_BUY_SHARE_BPS) continue;

        const cap = state.maxBuyLamports(curve.mint);
        let size = BUY_LAMPORTS < cap ? BUY_LAMPORTS : cap;
        if (size < MIN_BUY_LAMPORTS) continue;
        const room = freeCash - CASH_RESERVE_LAMPORTS;
        if (room < MIN_BUY_LAMPORTS) break;
        if (size > room) size = room;
        if (size < MIN_BUY_LAMPORTS) continue;

        orders.push({ side: 'buy', mint: curve.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        freeCash -= size;
      }
    }

    return orders;
  },
});

function countNewBuys(orders: { side: string }[]): number {
  let n = 0;
  for (const o of orders) if (o.side === 'buy') n++;
  return n;
}
