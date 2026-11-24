# Surge Scalper — strategy notes

## The game

10 SOL of paper money, one 24h replay of pump.fun bonding-curve events
(TradeEvent / CreateEvent / CompleteEvent), scored on final net PnL after
all fees. Two hard constraints shape everything:

- **Guardrail:** a round trip of at least 0.01 SOL on each of at least 20
  coins, max drawdown ≤ 50%. Missing it ranks below every entry that meets it.
- **Determinism:** the entry is executed twice; both action logs must match
  byte for byte. No clock, no randomness, no network, no environment.

Fees are brutal at small size: 1.25% curve fee per side plus 105,000
lamports of tx fee per order. A 0.05 SOL round trip pays ~3% in fees, so a
trade needs a real move to win — and most pump.fun curves only go down.
The winning move is therefore not to trade a lot, but to trade little,
only into confirmed strength, and to cut losers fast.

## Entry (default: dip mode)

On every batch, for each curve that traded, the bot checks a 40-slot tape:

- curve at least 200 slots old,
- real SOL reserves between 2 and 60,
- price down 10–35% over the window, with buy flow returning: net SOL in
  the newer half of the window positive and above the older half's,
- ≥ 6 buy trades and ≥ 6 distinct buyers in the window,
- no single buyer above 50% of the window's buy SOL.

A surge mode (same tape, but price up ≥ 12% and near its window high
instead of down) is kept behind the `dip` flag; on the dev window it lost
more than dip mode in every variant tried.

At most 2 entries per curve, 150-slot cooldown after an exit, at most 5
positions open, at most 2 SOL of exposure at cost.

## Sizing

First buy 0.03 SOL (capped by the harness rule: one batch's buys on a coin
may spend at most 1% of its real SOL reserve). While the price keeps
stepping up ≥ 8% from the last buy and net flow stays positive, the bot
pyramids +0.03 SOL at a time, up to 0.12 SOL per position. False starts
cost little; runners get size.

## Exits (sell the whole position)

- take-profit: value ≥ cost × 1.30
- stop-loss: value < cost × 0.95
- trailing stop: once peak ≥ cost × 1.10, sell below peak × 0.85
- fade: net flow over 20 slots < −0.30 SOL
- big sell: any single recorded sell ≥ 1.5 SOL
- max hold: 800 slots, unless the position is up ≥ 10%

Sells go out at 10,000 bps slippage so exits always land.

## Dev-window results

19 parameter variants were graded locally on the kit's dev window
(24h, 2–3 Nov 2026). The window is a down market: the best entry on the
public leaderboard sits at +0.08 SOL and most are negative. Final choice
(V19, dip-tight): **net PnL −0.14 SOL, 228 fills over 68 coins, 103 round
trips, win rate 11.7%, max drawdown 1.4%** — the least-bad genuine
strategy; surge-chasing lost −0.22..−1.86, completion-riding −0.83,
fresh-sniping −1.16. Small size plus a 5% stop caps the downside on a bad
final window, while dip-bounce winners (top 3 coins = 68% of gains) keep a
real shot at net PnL > 0 on a better window. A probe-only run lost even
less (−0.06) but has no upside engine, so it was not chosen.

## Guardrail probes

The bot paces itself against 25 coins / 200 fills over the window's block
time. When it lags, it opens a 0.012 SOL probe round trip on a liquid curve
and sells it as soon as the buy lands. One probe at a time; each costs
~0.0004 SOL — cheap insurance for the 20-coin bar.

## Files

- `main.ts` — entrypoint: hands the strategy to the replay shim.
- `strategy.ts` — the whole strategy (this design), parameters in
  `DEFAULT_PARAMS`.
- `vendor/makefun-bot.ts` — the kit's replay shim, vendored byte for byte.
