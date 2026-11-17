# makefun-token-radar-v3

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mangkarones3-afk/makefun-token-radar-v3/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mangkarones3-afk/makefun-token-radar-v3/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the frozen DefiLlama snapshot sealed with the bounty — third generation. Every protocol in the snapshot that records no token is priced by a model fitted on the snapshot's own traded protocols: a **log-log size curve** (value grows slower than TVL, so the curve compresses the giants a flat multiple overprices) plus **family offsets** — each category's median curve residual, shrunk toward its parent family. Every candidate term beyond the curve — family offsets, a deeper parent level, a 7-day growth tilt, an age term from the listing date — had to pass a **leave-one-out gate over all 128 traded tokens** before it shipped; the dashboard prints the full ladder, kept and rejected alike, with a walk-forward second read. Each row carries its P25–P75 band from the out-of-fold residuals and a basis label naming the level that priced it.

Every farm plan is **mechanism-aware and netted to a verdict on a deposit model**: generated from what the protocol actually does (lending loops, DEX liquidity, perps volume, bridge crossings, options epochs, locker terms), priced session by session in integer cents under a stated gas schedule and per-mechanism fee formulas, and closed by a net, a net per hour of modeled work and a break-even share under a clearly labelled reward scenario (Scenario S: a launch at the model's implied value, 5% to early users, the pool shared over an assumed farmed 25% of TVL), with the pure TVL pro-rata bound printed beside it. Scenario rewards are assumptions, not predictions; the dashboard's method view shows every input. All 40 watchlist protocols are covered, plus every other rankable pre-token protocol the model finds in the snapshot (198 rows).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only. The program writes `board.json` (the ranked board), `data.js` (the same board for the page), `dashboard/` and `screenshots/` into the output directory, and `dossier.json` last.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ram1fzcx&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
