# Surge Scalper — Pump.fun Replay Sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dian566/pumpfun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dian566/pumpfun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Entry for the make.fun bounty "Pump.fun Replay Sprint — Paper Bot, Real Ranking" — a deterministic TypeScript trading bot that trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

The bot buys small into confirmed surges (several distinct buyers, net SOL flowing in, price climbing and holding near its short-window high), then exits fast: take-profit +30%, stop-loss −15%, trailing stop once up 12%, fade exit when flow turns, and a hard max-hold. Tiny probe round-trips keep the run above the competition's guardrail (a round trip of at least 0.01 SOL on at least 20 coins).

Run `node main.ts` (Node 22+) — the bot speaks agent-fun/replay/v2 on stdin/stdout. See STRATEGY.md for the full design.

Bounty page: https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

Built in a Muse session and submitted with the make.fun CLI.
