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

## Entry

On every batch, for each curve that traded, the bot checks a 50-slot tape:

- curve at least 100 slots old (fresh launches are mostly bundle dumps),
- real SOL reserves between 1 and 50,
- net buy SOL ≥ 0.4 over the window, ≥ 4 buy trades, ≥ 4 distinct buyers,
- price up ≥ 6% from the window start and within 5% of the window high,
- no single buyer above 60% of the window's buy SOL.

At most 2 entries per curve, 150-slot cooldown after an exit, at most 5
positions open, at most 3 SOL of exposure at cost.

## Sizing

First buy 0.10 SOL (capped by the harness rule: one batch's buys on a coin
may spend at most 1% of its real SOL reserve). While the price keeps
stepping up ≥ 8% from the last buy and net flow stays positive, the bot
pyramids +0.10 SOL at a time, up to 0.50 SOL per position. False starts
cost little; runners get size.

## Exits (sell the whole position)

- take-profit: value ≥ cost × 1.30
- stop-loss: value < cost × 0.85
- trailing stop: once peak ≥ cost × 1.12, sell below peak × 0.82
- fade: net flow over 25 slots < −0.25 SOL
- big sell: any single recorded sell ≥ 1.5 SOL
- max hold: 1,500 slots, unless the position is up ≥ 10%

Sells go out at 10,000 bps slippage so exits always land.

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
