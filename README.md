# Tangga Petir — Pump.fun Bot Sprint

[![Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/muhamadyusufseptian6-lab/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/muhamadyusufseptian6-lab/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve events, ranked on net PnL. Built with Node 22, standard library only, fully deterministic — run it twice and the action log is byte-identical.

## The idea

Most pump.fun coins that ever pay do their paying early, while the crowd is still arriving. So this bot:

- **Buys young climbers only** — a coin with 3–120 trades seen, up at least 8% off its own low and 3% above where it started, never chased past +100% from its start, and never entered after a >50% spike inside the last 10 trades. It only buys when at least 70% of the last 20 trades' SOL volume is buys.
- **Risks a fixed small ticket** — 0.25 SOL per buy (clamped by the harness buy cap and free cash, keeping a 0.3 SOL reserve), at most 5 open positions, at most 3 buys per coin, so one bad coin can never sink the run.
- **Gets out with a trailing stop** — sells half at +20%; once a coin has peaked at +40% or more, the rest is sold if it falls 20 points off its peak, so a runner can pay far more than +20% while a winner never turns back into a loser. Everything goes at a −8% stop loss, and anything still flat after 1,000 slots is sold so the cash can go find a livelier coin. After a losing exit it leaves that coin alone for 50 slots.
- **Turns the book over** — small tickets and quick exits spread the trading across many coins, which is how it clears the 20-coin round-trip bar (≥0.01 SOL each) instead of betting big on one mint.

Every decision comes only from the replay events the harness delivers. No clock, no environment, no `Math.random` — only integer math on the reserves.

## Files

- `main.ts` — the bot (entrypoint, runs as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's house SDK shim for the `agent-fun/replay/v2` wire protocol (copied unchanged from the competition kit).
- `LICENSE` — MIT.

## Run it

```sh
node main.ts
```

The harness speaks JSON lines on stdin (`hello`, then one `batch` per slot, then `done`) and the bot answers one `reply` per batch on stdout. Diagnostics go to stderr.

## Local checks

- Determinism: feed the same input twice, compare stdout byte for byte — identical.
- Dev grading: `node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process` (see the kit's RULES.txt).

---

Built for make.fun — use referral code `515temp1` if you sign up.
