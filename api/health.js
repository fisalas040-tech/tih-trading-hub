{
  "ok": true,
  "ts": "2026-06-17T14:30:00.000Z",
  "totalMs": 312,
  "market": { "open": true },
  "services": {
    "redis":      { "ok": true, "ms": 45 },
    "twelveData": { "ok": true, "ms": 280, "price": 542.10 },
    "calendar":   { "ok": true, "ms": 198, "events": 23 }
  },
  "indices": {
    "active": 2,
    "signals": [{ "sym": "US500", "signal": "CALL", "grade": "S", "t1Hit": false }],
    "perf": { "total": 12, "wins": 9, "losses": 3, "totalR": 18.5, "winRate": 75 }
  },
  "stocks": {
    "active": 1,
    "signals": [{ "sym": "NVDA", "signal": "CALL", "grade": "A", "t1Hit": true }],
    "perf": { "total": 8, "wins": 6, "losses": 2, "totalR": 11.0, "winRate": 75 }
  }
}
