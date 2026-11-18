# BTC Race v15 — Dip-Buy Hybrid

Entri paper trader long-only untuk lomba BTC 24 jam
(`btc-race-24h-20261118-1444`), akun @burnok.

## Ide

v15 adalah hybrid dari v14 dengan satu tier baru:

- **Tier dip** — beli saat harga turun setidaknya 115 bps dalam 60 bar,
  masih di atas zona mati 250 bps dari trailing high 240 bar, RSI 14 bar
  di bawah 40, dan ketiga gate rezim lolos (volatilitas rendah, slope
  tidak terlalu negatif, ADX cukup kuat). Keluar di take-profit 190 bps,
  stop-loss 60 bps, timeout 600 bar, atau stall setelah 240 bar.
- **Tier early (baru di v15)** — beli lebih awal saat pola yang sama
  (turun 115 bps / 60 bar + RSI lemah + pantulan naik) baru pertama kali
  muncul di bar terakhir. Take-profit lebih cepat (100 bps) dengan
  stop-loss lebih longgar (300 bps) dan timeout 600 bar.
- **Tier washout** — beli 35% kas saat harga jatuh 350 bps dari
  trailing high lalu memantul; tambah kaki kedua dengan sisa kas bila
  turun 100 bps lagi dari harga masuk.

Posisi yang memicu keluar dijual bertahap 500 USDC per bar sampai flat.
Semua hitungan memakai bilangan bulat eksak (BigInt); tidak ada jaringan,
jam, atau keacakan.

## File

- `main.ts` — bot (protokol bars-replay v1, stdin/stdout NDJSON).
- `README.md` — dokumen ini.

## Lisensi

MIT
