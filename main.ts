// Paper trader long-only untuk lomba BTC: hybrid dip-buy (v15).
// Membaca pesan JSON per baris dari stdin, membalas satu reply per batch.
// Hanya standard library; semua uang dan harga memakai bilangan bulat eksak.

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const SCALE = 10000n;
const BPS = 10000n;
const MIN_NOTIONAL = 1000000n;
const MAX_SLIPPAGE = 200;
const PRICE_DIV = 10000000n;

// Ambang-ambang strategi (basis poin, kecuali disebutkan).
const DIP_WINDOW = 60;
const DIP_DROP = 115n;
const DIP_DEAD = 250n;
const DIP_TP = 190n;
const DIP_SL = 60n;
const DIP_TIMEOUT = 600;
const STALL_BARS = 240;
const STALL_TP = 80n;

const EARLY_DROP = 115n;
const EARLY_TP = 100n;
const EARLY_SL = 300n;
const EARLY_TIMEOUT = 600;

const WASH_WINDOW = 240;
const WASH_DEPTH = 350n;
const WASH_TP = 190n;
const WASH_SL = 300n;
const WASH_TIMEOUT = 600;
const LEG2_DROP = 100n;
const LEG1_PCT = 35n;

const VOL_CEIL = 13n;
const SLOPE_FLOOR = -20n;
const ADX_FLOOR = 40n;
const EXIT_USDC = 500n;

// Tahap posisi: 0 flat, 1 washout kaki pertama, 2 washout kaki kedua,
// 8 trade tier early, 9 trade tier dip.
let closes: bigint[] = [];
let highs: bigint[] = [];
let lows: bigint[] = [];
let warmupBars = 0;
let cash = 0n;
let heldQty = 0n;
let heldCost = 0n;
let stage = 0;
let exiting = false;
let entryPrice = 0n;
let entrySeq: number | null = null;
let pendingStage: number | null = null;
let pendingEntryPrice = 0n;
let pendingEntrySeq: number | null = null;
let nextClient = 1;
let rollingSum = 0n;
let rollingHist: bigint[] = [];
let plusSum = 0n;
let minusSum = 0n;
let trSum = 0n;
let prevAdx = 0n;

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// Akar kuadrat bulat (pembulatan ke bawah) dengan metode Newton.
function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// Nilai suatu kuantitas pada suatu harga.
function valueAt(qty: bigint, price: bigint): bigint {
  return (qty * price) / PRICE_DIV;
}

// Volatilitas: simpangan baku return satu menit atas 60 penutup terakhir.
function volatility(): bigint {
  const n = closes.length;
  if (n < 60) return 0n;
  const rets: bigint[] = [];
  let sum = 0n;
  for (let i = n - 60; i < n; i++) {
    const prev = closes[i - 1];
    const r = ((closes[i] - prev) * BPS * SCALE) / prev;
    rets.push(r);
    sum += r;
  }
  const mean = sum / 60n;
  let sq = 0n;
  for (const r of rets) {
    const d = r - mean;
    sq += d * d;
  }
  return isqrt(sq / 60n);
}

// Slope: perubahan jumlah bergulir 240 penutup selama 60 bar terakhir.
function slope(): bigint {
  const n = closes.length;
  if (n < 300) return 0n;
  const latest = rollingHist[n - 1];
  const older = rollingHist[n - 1 - 60];
  if (older <= 0n) return 0n;
  return (BPS * SCALE * (latest - older)) / older;
}

// Kondisi RSI 14 bar yang berakhir di indeks idx: 3*gains <= 2*losses.
function rsiOkAt(idx: number): boolean {
  let gains = 0n;
  let losses = 0n;
  for (let k = idx - 13; k <= idx; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0n) gains += d;
    else losses += -d;
  }
  return losses > 0n && 3n * gains <= 2n * losses;
}

// Kondisi tier early pada suatu indeks penutup.
function earlyOkAt(idx: number): boolean {
  if (idx < 60) return false;
  const c = closes[idx];
  const ref = closes[idx - 60];
  const dropOk = c * BPS < ref * (BPS - EARLY_DROP);
  const turnUp = c > closes[idx - 2];
  return dropOk && rsiOkAt(idx) && turnUp;
}

function buyOrder(amount: bigint): any {
  const order = {
    side: "buy",
    client_id: "o" + nextClient,
    symbol: SYMBOL,
    notional_quote_units: amount.toString(),
    max_slippage_bps: MAX_SLIPPAGE,
  };
  nextClient += 1;
  return order;
}

function sellOrder(qty: bigint): any {
  const order = {
    side: "sell",
    client_id: "o" + nextClient,
    symbol: SYMBOL,
    qty: qty.toString(),
    max_slippage_bps: MAX_SLIPPAGE,
  };
  nextClient += 1;
  return order;
}

// Kuantitas keluar bertahap: senilai 500 USDC pada penutup terakhir.
function gradualQty(last: bigint): bigint {
  if (last <= 0n) return heldQty;
  const q = (EXIT_USDC * 10000000000000n) / last;
  return q > heldQty ? heldQty : q;
}

function reply(seq: number, orders: any[]): any {
  return { type: "reply", seq, orders };
}

function decide(seq: number): any {
  const orders: any[] = [];
  const n = closes.length;
  if (n < 62) return reply(seq, orders);
  const last = closes[n - 1];
  if (last <= 0n) return reply(seq, orders);
  const turnUp = last > closes[n - 3];
  const rsiOk = rsiOkAt(n - 1);

  if (heldQty === 0n) {
    let wash = false;
    let dipAlive = false;
    let dip60 = false;
    let volOk = false;
    let slopeOk = false;
    let adxOk = false;
    if (n > WASH_WINDOW) {
      let trailingHigh = closes[n - WASH_WINDOW];
      for (let i = n - WASH_WINDOW + 1; i < n; i++) {
        if (closes[i] > trailingHigh) trailingHigh = closes[i];
      }
      wash = last * BPS < trailingHigh * (BPS - WASH_DEPTH);
      dipAlive = last * BPS > trailingHigh * (BPS - DIP_DEAD);
      dip60 = last * BPS < closes[n - 1 - DIP_WINDOW] * (BPS - DIP_DROP);
      volOk = volatility() < VOL_CEIL * SCALE;
      slopeOk = slope() >= SLOPE_FLOOR * SCALE;
      adxOk = prevAdx >= ADX_FLOOR * SCALE;
    }
    if (wash && turnUp) {
      const spend = (cash * LEG1_PCT) / 100n;
      if (spend >= MIN_NOTIONAL) {
        orders.push(buyOrder(spend));
      }
      pendingStage = 1;
      pendingEntryPrice = last;
      pendingEntrySeq = seq;
      return reply(seq, orders);
    }
    if (dipAlive && dip60 && rsiOk && volOk && slopeOk && adxOk) {
      if (cash >= MIN_NOTIONAL) {
        orders.push(buyOrder(cash));
      }
      pendingStage = 9;
      pendingEntryPrice = last;
      pendingEntrySeq = seq;
      return reply(seq, orders);
    }
    if (earlyOkAt(n - 1) && !earlyOkAt(n - 2)) {
      if (cash >= MIN_NOTIONAL) {
        orders.push(buyOrder(cash));
      }
      pendingStage = 8;
      pendingEntryPrice = last;
      pendingEntrySeq = seq;
      return reply(seq, orders);
    }
    return reply(seq, orders);
  }

  // Memegang trade tier early.
  if (stage === 8) {
    const val = valueAt(heldQty, last);
    const tpHit = val * BPS >= heldCost * (BPS + EARLY_TP);
    const slHit = val * BPS <= heldCost * (BPS - EARLY_SL);
    const toHit = entrySeq !== null && seq - entrySeq >= EARLY_TIMEOUT;
    if (tpHit || slHit || toHit) {
      orders.push(sellOrder(heldQty));
      return reply(seq, orders);
    }
  }

  // Keluar bertahap.
  if (exiting && heldQty > 0n) {
    orders.push(sellOrder(gradualQty(last)));
    return reply(seq, orders);
  }

  // Washout kaki pertama: tambah kaki kedua saat turun ekstra.
  if (stage === 1 && cash > 0n) {
    const leg2 =
      last * BPS < entryPrice * (BPS - LEG2_DROP) &&
      turnUp &&
      cash >= MIN_NOTIONAL;
    if (leg2) {
      orders.push(buyOrder(cash));
      pendingStage = 2;
      pendingEntryPrice = entryPrice;
      pendingEntrySeq = entrySeq;
      return reply(seq, orders);
    }
  }

  // Posisi washout atau dip: take-profit, stop-loss, timeout, stall (dip).
  if (stage === 1 || stage === 2 || stage === 9) {
    const tp = stage === 9 ? DIP_TP : WASH_TP;
    const sl = stage === 9 ? DIP_SL : WASH_SL;
    const val = valueAt(heldQty, last);
    const tpHit = val * BPS >= heldCost * (BPS + tp);
    const slHit = val * BPS <= heldCost * (BPS - sl);
    const toHit = entrySeq !== null && seq - entrySeq >= DIP_TIMEOUT;
    const stallHit =
      stage === 9 &&
      entrySeq !== null &&
      seq - entrySeq >= STALL_BARS &&
      val * BPS < heldCost * (BPS + STALL_TP);
    if (tpHit || slHit || toHit || stallHit) {
      exiting = true;
      orders.push(sellOrder(gradualQty(last)));
      return reply(seq, orders);
    }
  }

  return reply(seq, orders);
}

function processBatch(msg: any): any {
  const seq: number = msg.seq;
  const account = msg.account || {};
  cash = BigInt(account.cash_quote_units || "0");
  heldQty = 0n;
  heldCost = 0n;
  const positions = Array.isArray(account.positions) ? account.positions : [];
  for (const p of positions) {
    if (p.symbol === SYMBOL) {
      heldQty = BigInt(p.qty || "0");
      heldCost = BigInt(p.cost_quote_units || "0");
      break;
    }
  }

  const bars = Array.isArray(msg.bars) ? msg.bars : [];
  for (const bar of bars) {
    if (bar.symbol !== SYMBOL) continue;
    const c = BigInt(bar.c);
    const h = BigInt(bar.h);
    const l = BigInt(bar.l);
    const idx = closes.length;
    if (idx >= 1) {
      const prevHigh = highs[highs.length - 1];
      const prevLow = lows[lows.length - 1];
      const prevClose = closes[closes.length - 1];
      const up = h - prevHigh;
      const down = prevLow - l;
      const plus = up > down && up > 0n ? up : 0n;
      const minus = down > up && down > 0n ? down : 0n;
      let tr = h - l;
      const tr2 = h - prevClose;
      const tr3 = prevClose - l;
      if (tr2 > tr) tr = tr2;
      if (tr3 > tr) tr = tr3;
      if (idx <= 14) {
        plusSum += plus;
        minusSum += minus;
        trSum += tr;
      } else {
        plusSum = plusSum - plusSum / 14n + plus;
        minusSum = minusSum - minusSum / 14n + minus;
        trSum = trSum - trSum / 14n + tr;
      }
      if (idx >= 14 && trSum > 0n) {
        const diPlus = (100n * SCALE * plusSum) / trSum;
        const diMinus = (100n * SCALE * minusSum) / trSum;
        const diSum = diPlus + diMinus;
        const dx =
          diSum === 0n
            ? 0n
            : (100n * SCALE * absBig(diPlus - diMinus)) / diSum;
        if (idx === 14) {
          prevAdx = dx;
        } else {
          prevAdx = (prevAdx * 13n + dx) / 14n;
        }
      }
    }
    closes.push(c);
    highs.push(h);
    lows.push(l);
    rollingSum += c;
    if (closes.length > WASH_WINDOW) {
      rollingSum -= closes[closes.length - 1 - WASH_WINDOW];
    }
    rollingHist.push(rollingSum);
  }

  // Adopsi tier tertunda.
  if (heldQty > 0n && pendingStage !== null) {
    stage = pendingStage;
    entryPrice = pendingEntryPrice;
    entrySeq = pendingEntrySeq;
    pendingStage = null;
  }
  if (heldQty === 0n) {
    stage = 0;
    pendingStage = null;
    exiting = false;
  }

  if (seq < warmupBars) return reply(seq, []);
  return decide(seq);
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      process.exit(1);
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      process.exit(1);
    }
    if (msg.type === "hello") {
      warmupBars =
        typeof msg.warmup_bars === "number" ? msg.warmup_bars : 0;
    } else if (msg.type === "batch") {
      const out = processBatch(msg);
      process.stdout.write(JSON.stringify(out) + "\n");
    } else if (msg.type === "done") {
      process.exit(0);
    } else {
      process.exit(1);
    }
  }
}

main();
