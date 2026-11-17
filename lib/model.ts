// Token Radar v3 — the model, the mechanism-aware farm plans and their costs.
//
// Two claims, both computed from the sealed snapshot and nothing else:
//
// 1. An implied launch value for every protocol that records no token,
//    priced by a model fitted on the snapshot's own traded protocols.
//    The core is a size curve — log10(value) = a + b * log10(TVL), fitted
//    by least squares on the traded set — because value grows slower
//    than TVL: a flat multiple prices a $2.7B curator and a $27M lending
//    market with the same ruler, and the traded set says the ruler bends.
//    On top of the curve sit family offsets: each category's median
//    curve residual, shrunk toward its parent family's offset with
//    weight n/(n+8) (the parent offset is itself the pooled median
//    residual, shrunk toward the curve with weight n/(n+6)). A family
//    with fewer than three traded members gets no offset of its own and
//    its rows price on the curve; the row's basis says which happened.
//
//    Three further terms were fitted and put to the same gate as
//    everything else here — leave-one-out cross-validation over all
//    traded tokens, with a walk-forward split as the second read: a
//    parent level (thin families priced on their parent offset), a
//    7-day growth tilt, and an age/seasoning term from listed_at. The
//    gate keeps a term only when its leave-one-out median factor miss
//    improves on the model without it; the ablation ladder is computed
//    by looGate() below and printed in full on the dashboard, kept and
//    rejected terms alike. What ships is what survived.
//
// 2. A farm plan per protocol whose costs are added up, not waved at.
//    Each plan is built from the protocol's mechanism (lending loop, DEX
//    liquidity, perps volume, bridge crossings, ...), priced session by
//    session in integer cents under a fee schedule and fee formulas that
//    the dashboard prints in full, and closed by a verdict step: the
//    plan's total modeled cost against a reward under Scenario S — a
//    stated, labeled assumption set, never a prediction — read three
//    ways: the net, the net per hour of modeled work, and the break-even
//    share, the fraction of the Scenario S reward the plan needs to
//    cover its cost. The conservative bound (the same pool shared
//    pro-rata over all TVL) is printed beside it.
//
// Language rule, kept from the data: a protocol whose mcap_usd, gecko_id
// and symbol are all null "records no token" in this snapshot. The file
// cannot prove more, so the entry claims no more.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

// ---------------------------------------------------------------------------
// The snapshot and the board's product-type line (unchanged from v2: the
// data-quality rules were the part of v2 the evidence supported keeping)
// ---------------------------------------------------------------------------

const NAME_VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const NAME_WRAPPED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_HEADS = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
/** Categories the watchlist definition itself sets aside: products of a token that already trades. */
const SET_ASIDE = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

export function loadSnapshot(text: string): Snap {
  const raw = JSON.parse(text) as Snap;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** True when the snapshot records no token for the protocol: all three token fields null. */
export function recordsNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Rankable: records no token and passes the product-type line the watchlist
 * definition draws (no wrapped/staked/bridged products of trading tokens,
 * no exchange-fronted names, no version-suffixed names), applied without
 * the watchlist's $50M floor — the floor is a size line, this is a kind line.
 */
export function isRankable(p: Proto): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && SET_ASIDE.has(p.category)) return false;
  if (NAME_VERSIONED.test(p.name) || NAME_WRAPPED.test(p.name)) return false;
  return !EXCHANGE_HEADS.some((x) => p.name.startsWith(x));
}

// ---------------------------------------------------------------------------
// Small statistics helpers
// ---------------------------------------------------------------------------

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Linear-interpolation quantile over an ascending copy of xs. */
function quantileOf(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;
const roundMult = (x: number): number => Math.round(x * 1e6) / 1e6;
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Days between the protocol's DefiLlama listing and the snapshot date; null when unlisted. */
export function ageDaysOf(p: Proto, asOfMs: number): number | null {
  if (p.listed_at === null) return null;
  return (asOfMs - Date.parse(p.listed_at)) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Families and parents. A protocol's family is its DefiLlama category;
// its parent is the mechanism family the category belongs to — the level
// family offsets shrink toward, and the level the gate tested as a
// pricing level of its own. The mapping is a stated modeling choice,
// printed in full on the dashboard; every category in the snapshot is in
// exactly one parent, and anything unlisted lands in 'Other services'.
// ---------------------------------------------------------------------------

export const PARENT_OF_CATEGORY: Record<string, string> = {
  'Lending': 'Credit', 'CDP': 'Credit', 'CDP Manager': 'Credit', 'Uncollateralized Lending': 'Credit',
  'Collateral Management': 'Credit', 'Collateral Markets': 'Credit', 'Leveraged Farming': 'Credit',
  'Dexs': 'Trading & markets', 'Derivatives': 'Trading & markets', 'Interest Rate Derivatives': 'Trading & markets',
  'Synthetics': 'Trading & markets', 'Options': 'Trading & markets', 'Options Vault': 'Trading & markets',
  'Prediction Market': 'Trading & markets', 'NFT Marketplace': 'Trading & markets', 'Launchpad': 'Trading & markets',
  'OTC Marketplace': 'Trading & markets', 'Liquidity Manager': 'Trading & markets',
  'Yield': 'Yield & allocation', 'Yield Aggregator': 'Yield & allocation', 'Farm': 'Yield & allocation',
  'Risk Curators': 'Yield & allocation', 'Onchain Capital Allocator': 'Yield & allocation', 'Basis Trading': 'Yield & allocation',
  'Liquid Staking': 'Staking & restaking', 'Liquid Restaking': 'Staking & restaking', 'Restaking': 'Staking & restaking',
  'Staking Pool': 'Staking & restaking', 'Restaked BTC': 'Staking & restaking',
  'Bridge': 'Bridges & chains', 'Canonical Bridge': 'Bridges & chains', 'Cross Chain Bridge': 'Bridges & chains', 'Chain': 'Bridges & chains',
  'RWA': 'Asset & stablecoin products', 'Indexes': 'Asset & stablecoin products', 'Algo-Stables': 'Asset & stablecoin products',
  'Dual-Token Stablecoin': 'Asset & stablecoin products', 'Stablecoin Issuer': 'Asset & stablecoin products',
  'Stablecoin Wrapper': 'Asset & stablecoin products', 'Anchor BTC': 'Asset & stablecoin products',
  'Decentralized BTC': 'Asset & stablecoin products', 'Reserve Currency': 'Asset & stablecoin products',
  'CEX': 'Exchange & payments', 'CeDeFi': 'Exchange & payments', 'Payments': 'Exchange & payments', 'Crypto Card Issuer': 'Exchange & payments',
  'Privacy': 'Other services', 'AI Agents': 'Other services', 'Decentralized AI': 'Other services', 'DOR': 'Other services',
  'Token Locker': 'Other services', 'Governance Incentives': 'Other services', 'Insurance': 'Other services',
};

export function familyOf(p: Proto): string {
  return p.category ?? 'Uncategorized';
}
export function parentOf(p: Proto): string {
  return PARENT_OF_CATEGORY[familyOf(p)] ?? 'Other services';
}

// ---------------------------------------------------------------------------
// The staged fit. One pass over a training set produces every stage the
// gate scores, so a fold of cross-validation refits the whole pipeline —
// curve, offsets, tilts — on the fold's protocols alone and no held-out
// figure can leak into any stage.
// ---------------------------------------------------------------------------

/** The fit's raw material: traded protocols with a real, positive market cap and TVL. */
export function fitPool(protocols: Proto[]): Proto[] {
  return protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

const MIN_FAMILY_PEERS = 3;
const MIN_PARENT_PEERS = 3;
const SHRINK_FAMILY_K = 8;
const SHRINK_PARENT_K = 6;
/** The growth tilt may move a price by at most this factor either way (log10 bounds). */
const GROWTH_CLAMP: [number, number] = [Math.log10(0.8), Math.log10(1.25)];
/** The age term may move a price by at most this factor either way (log10 bounds). */
const AGE_CLAMP: [number, number] = [Math.log10(0.7), Math.log10(1.5)];

export interface CurveFit {
  a: number;
  b: number;
}

export interface FamilyFit {
  category: string;
  parent: string;
  peers: number;
  median_resid: number;
  offset: number;
  offset_factor: number;
}

export interface ParentFit {
  parent: string;
  peers: number;
  median_resid: number;
  offset: number;
  offset_factor: number;
}

/** Least squares of log10(mcap) on log10(TVL) — the size curve. */
function fitCurve(train: Proto[]): CurveFit {
  const n = train.length;
  const xs = train.map((p) => Math.log10(p.tvl_usd));
  const ys = train.map((p) => Math.log10(p.mcap_usd!));
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]!; my += ys[i]!; }
  mx /= n; my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; }
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** One-variable least squares on a winsorized regressor (5th–95th percentile). */
function slopeWinsorized(pairs: [number, number][]): number {
  if (pairs.length < 8) return 0;
  const lo = quantileOf(pairs.map((p) => p[0]), 0.05);
  const hi = quantileOf(pairs.map((p) => p[0]), 0.95);
  const w = pairs.map(([z, r]): [number, number] => [clampNum(z, lo, hi), r]);
  const mz = w.reduce((s, p) => s + p[0], 0) / w.length;
  const mr = w.reduce((s, p) => s + p[1], 0) / w.length;
  let sxy = 0;
  let sxx = 0;
  for (const [z, r] of w) { sxy += (z - mz) * (r - mr); sxx += (z - mz) ** 2; }
  return sxx > 0 ? sxy / sxx : 0;
}

export interface Terms {
  offsets: boolean;
  parentLevel: boolean;
  growth: boolean;
  age: boolean;
}

export interface StagedFit {
  curve: CurveFit;
  families: Map<string, FamilyFit>;
  parents: Map<string, ParentFit>;
  growth_slope: number;
  age_slope: number;
  median_change: number;
  median_h: number;
  as_of_ms: number;
}

export function fitStaged(train: Proto[], asOfMs: number): StagedFit {
  const curve = fitCurve(train);
  const resid = new Map<string, number>();
  for (const p of train) resid.set(p.slug, Math.log10(p.mcap_usd!) - (curve.a + curve.b * Math.log10(p.tvl_usd)));

  // Parent offsets first: family offsets shrink toward them.
  const byParent = new Map<string, number[]>();
  const byFamily = new Map<string, number[]>();
  const famParent = new Map<string, string>();
  for (const p of train) {
    const r = resid.get(p.slug)!;
    const par = parentOf(p);
    const fam = familyOf(p);
    famParent.set(fam, par);
    const pl = byParent.get(par); if (pl) pl.push(r); else byParent.set(par, [r]);
    const fl = byFamily.get(fam); if (fl) fl.push(r); else byFamily.set(fam, [r]);
  }
  const parents = new Map<string, ParentFit>();
  for (const [parent, rs] of byParent) {
    const medR = medianOf(rs);
    const off = (rs.length / (rs.length + SHRINK_PARENT_K)) * medR;
    parents.set(parent, { parent, peers: rs.length, median_resid: medR, offset: off, offset_factor: roundMult(10 ** off) });
  }
  const families = new Map<string, FamilyFit>();
  for (const [fam, rs] of byFamily) {
    const medR = medianOf(rs);
    const par = famParent.get(fam)!;
    const parOff = parents.get(par)?.offset ?? 0;
    const w = rs.length / (rs.length + SHRINK_FAMILY_K);
    const off = w * medR + (1 - w) * parOff;
    families.set(fam, { category: fam, parent: par, peers: rs.length, median_resid: medR, offset: off, offset_factor: roundMult(10 ** off) });
  }

  const offsetOf = (p: Proto, parentLevel: boolean): number => {
    const fam = families.get(familyOf(p));
    if (fam && fam.peers >= MIN_FAMILY_PEERS) return fam.offset;
    if (parentLevel) {
      const par = parents.get(parentOf(p));
      if (par && par.peers >= MIN_PARENT_PEERS) return par.offset;
    }
    return 0;
  };
  const residAfterOffsets = train.map((p) => resid.get(p.slug)! - offsetOf(p, false));

  // Growth tilt: least squares of post-offset residuals on the log growth
  // ratio relative to the pool's median week. change_7d is in percent.
  const median_change = medianOf(train.map((p) => p.change_7d ?? 0));
  const zOf = (p: Proto): number => {
    if (p.change_7d === null) return 0;
    return Math.log10((1 + p.change_7d / 100) / (1 + median_change / 100));
  };
  const growthPairs: [number, number][] = [];
  train.forEach((p, i) => {
    if (p.change_7d !== null) growthPairs.push([zOf(p), residAfterOffsets[i]!]);
  });
  const growth_slope = slopeWinsorized(growthPairs);

  // Age term: least squares of post-offset residuals on log10(1 + age in
  // years), centered on the pool's median so a protocol with no listing
  // date takes the neutral value.
  const hOf = (p: Proto): number | null => {
    const d = ageDaysOf(p, asOfMs);
    return d === null ? null : Math.log10(1 + Math.max(0, d) / 365.25);
  };
  const hs = train.map(hOf).filter((h): h is number => h !== null);
  const median_h = hs.length ? medianOf(hs) : 0;
  const agePairs: [number, number][] = [];
  train.forEach((p, i) => {
    const h = hOf(p);
    if (h !== null) agePairs.push([h - median_h, residAfterOffsets[i]!]);
  });
  const age_slope = slopeWinsorized(agePairs);

  return { curve, families, parents, growth_slope, age_slope, median_change, median_h, as_of_ms: asOfMs };
}

/** The price a staged fit gives one protocol under a term set, and the level that priced it. */
export function predictLog(fit: StagedFit, p: Proto, terms: Terms): { logv: number; level: 'family' | 'parent' | 'global'; level_n: number } {
  let level: 'family' | 'parent' | 'global' = 'global';
  let level_n = 0;
  let off = 0;
  if (terms.offsets) {
    const fam = fit.families.get(familyOf(p));
    if (fam && fam.peers >= MIN_FAMILY_PEERS) {
      off = fam.offset; level = 'family'; level_n = fam.peers;
    } else if (terms.parentLevel) {
      const par = fit.parents.get(parentOf(p));
      if (par && par.peers >= MIN_PARENT_PEERS) {
        off = par.offset; level = 'parent'; level_n = par.peers;
      }
    }
  }
  let lv = fit.curve.a + fit.curve.b * Math.log10(p.tvl_usd) + off;
  if (terms.growth && p.change_7d !== null) {
    const z = Math.log10((1 + p.change_7d / 100) / (1 + fit.median_change / 100));
    lv += clampNum(fit.growth_slope * z, GROWTH_CLAMP[0], GROWTH_CLAMP[1]);
  }
  if (terms.age) {
    const d = ageDaysOf(p, fit.as_of_ms);
    if (d !== null) {
      const h = Math.log10(1 + Math.max(0, d) / 365.25);
      lv += clampNum(fit.age_slope * (h - fit.median_h), AGE_CLAMP[0], AGE_CLAMP[1]);
    }
  }
  return { logv: lv, level, level_n };
}

// ---------------------------------------------------------------------------
// The validation gate: leave-one-out over the whole traded set, a
// walk-forward split as the second read, and the ablation ladder the
// dashboard prints. A candidate term joins the shipped model only when
// its leave-one-out median factor miss improves on the model without
// it — the rule is executed here, not asserted in prose. Each ladder
// step also carries its leave-one-out median on the head of the board
// (the pool's top decile by TVL and by realized cap): a head read was
// run on the two rejected tilts after the fact, and the method view
// prints it as evidence — it selects nothing.
// ---------------------------------------------------------------------------

export interface LadderStep {
  key: 'flat' | 'curve' | 'offsets' | 'parent' | 'growth' | 'age';
  label: string;
  loo_factor: number;
  wf_factor: number;
  /** Leave-one-out median factor miss on the head cuts: the pool's top decile by TVL and by realized cap. Evidence only — the gate selects on the overall median. */
  loo_head_tvl: number;
  loo_head_mcap: number;
  kept: boolean;
}

export interface OofRow {
  p: Proto;
  pred: number;
  actual: number;
  log_resid: number;
  level: 'family' | 'parent' | 'global';
}

export interface Validation {
  loo_n: number;
  flat_factor: number;
  final_factor: number;
  spearman: number;
  wf_train_n: number;
  wf_test_n: number;
  band_lo_factor: number;
  band_hi_factor: number;
}

export interface GateResult {
  terms: Terms;
  ladder: LadderStep[];
  oof: OofRow[];
  validation: Validation;
}

const factorMiss = (pred: number, actual: number): number => Math.exp(Math.abs(Math.log(pred / actual)));

function looEvaluate(pool: Proto[], asOfMs: number, terms: Terms): { factor: number; oof: OofRow[] } {
  const oof: OofRow[] = [];
  for (let i = 0; i < pool.length; i++) {
    const train = pool.filter((_, j) => j !== i);
    const fit = fitStaged(train, asOfMs);
    const { logv, level } = predictLog(fit, pool[i]!, terms);
    const pred = 10 ** logv;
    oof.push({ p: pool[i]!, pred, actual: pool[i]!.mcap_usd!, log_resid: logv - Math.log10(pool[i]!.mcap_usd!), level });
  }
  return { factor: round2(medianOf(oof.map((r) => factorMiss(r.pred, r.actual)))), oof };
}

function wfEvaluate(train: Proto[], test: Proto[], asOfMs: number, terms: Terms): number {
  const fit = fitStaged(train, asOfMs);
  return round2(medianOf(test.map((p) => factorMiss(10 ** predictLog(fit, p, terms).logv, p.mcap_usd!))));
}

const NO_TERMS: Terms = { offsets: false, parentLevel: false, growth: false, age: false };

export function looGate(protocols: Proto[], asOfMs: number): GateResult {
  const pool = fitPool(protocols);
  // Walk-forward split: the dated traded protocols in listing order,
  // fitted on the oldest 60%, scored on the newest 40%.
  const dated = pool.filter((p) => p.listed_at !== null).sort((a, b) => Date.parse(a.listed_at!) - Date.parse(b.listed_at!));
  const cut = Math.floor(dated.length * 0.6);
  const wfTrain = dated.slice(0, cut);
  const wfTest = dated.slice(cut);

  const flatLoo = round2(medianOf(pool.map((p) => factorMiss(0.25 * p.tvl_usd, p.mcap_usd!))));
  const flatWf = round2(medianOf(wfTest.map((p) => factorMiss(0.25 * p.tvl_usd, p.mcap_usd!))));
  const flatOof: OofRow[] = pool.map((p) => ({
    p,
    pred: 0.25 * p.tvl_usd,
    actual: p.mcap_usd!,
    log_resid: Math.log10(0.25 * p.tvl_usd) - Math.log10(p.mcap_usd!),
    level: 'global' as const,
  }));

  // Head-of-board cuts: the pool's top decile by TVL and by realized cap.
  const headK = Math.ceil(pool.length / 10);
  const headTvl = new Set([...pool].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1)).slice(0, headK).map((p) => p.slug));
  const headMcap = new Set([...pool].sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1)).slice(0, headK).map((p) => p.slug));
  const headFactor = (oof: OofRow[], cut: Set<string>): number =>
    round2(medianOf(oof.filter((r) => cut.has(r.p.slug)).map((r) => factorMiss(r.pred, r.actual))));

  interface Row { key: LadderStep['key']; label: string; terms: Terms; loo: number; oof: OofRow[] | null }
  const rows: Row[] = [{ key: 'flat', label: 'Flat 0.25 × TVL (the house baseline, unfitted)', terms: NO_TERMS, loo: flatLoo, oof: flatOof }];
  let current: Terms = { ...NO_TERMS };
  let currentEval = looEvaluate(pool, asOfMs, current);
  rows.push({ key: 'curve', label: 'Size curve: log₁₀ value on log₁₀ TVL', terms: { ...current }, loo: currentEval.factor, oof: currentEval.oof });
  let keptOof = currentEval.oof;
  const keptKeys = new Set<string>(['curve']);

  const candidates: { key: LadderStep['key']; label: string; add: (t: Terms) => Terms }[] = [
    { key: 'offsets', label: '+ Family offsets (median residual, shrunk to parent)', add: (t) => ({ ...t, offsets: true }) },
    { key: 'parent', label: '+ Parent level (thin families priced on the parent offset)', add: (t) => ({ ...t, parentLevel: true }) },
    { key: 'growth', label: '+ Growth tilt (7-day TVL change, clamped ×0.80–×1.25)', add: (t) => ({ ...t, growth: true }) },
    { key: 'age', label: '+ Age term (days tracked with no token, clamped ×0.70–×1.50)', add: (t) => ({ ...t, age: true }) },
  ];
  for (const c of candidates) {
    const spec = c.add(current);
    const ev = looEvaluate(pool, asOfMs, spec);
    const kept = ev.factor < currentEval.factor;
    rows.push({ key: c.key, label: c.label, terms: spec, loo: ev.factor, oof: ev.oof });
    if (kept) {
      current = spec;
      currentEval = ev;
      keptOof = ev.oof;
      keptKeys.add(c.key);
    }
  }

  const ladder: LadderStep[] = rows.map((r) => ({
    key: r.key,
    label: r.label,
    loo_factor: r.loo,
    wf_factor: r.key === 'flat' ? flatWf : wfEvaluate(wfTrain, wfTest, asOfMs, r.terms),
    loo_head_tvl: r.oof ? headFactor(r.oof, headTvl) : 0,
    loo_head_mcap: r.oof ? headFactor(r.oof, headMcap) : 0,
    kept: r.key === 'flat' ? false : keptKeys.has(r.key),
  }));

  // Spearman rank correlation of the shipped model's out-of-fold prices.
  const rankOf = (xs: number[]): number[] => {
    const order = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
    const ranks = new Array<number>(xs.length);
    order.forEach((idx, r) => { ranks[idx] = r; });
    return ranks;
  };
  const pr = rankOf(keptOof.map((r) => r.pred));
  const ar = rankOf(keptOof.map((r) => r.actual));
  const n = keptOof.length;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (pr[i]! - ar[i]!) ** 2;
  const spearman = round2(1 - (6 * d2) / (n * (n * n - 1)));

  const resids = keptOof.map((r) => r.log_resid);
  return {
    terms: current,
    ladder,
    oof: keptOof,
    validation: {
      loo_n: pool.length,
      flat_factor: flatLoo,
      final_factor: currentEval.factor,
      spearman,
      wf_train_n: wfTrain.length,
      wf_test_n: wfTest.length,
      band_lo_factor: roundMult(10 ** quantileOf(resids, 0.25)),
      band_hi_factor: roundMult(10 ** quantileOf(resids, 0.75)),
    },
  };
}

// ---------------------------------------------------------------------------
// Calibration and error decomposition, read off the shipped model's
// out-of-fold predictions — every traded protocol priced by a model that
// never saw it.
// ---------------------------------------------------------------------------

export interface CalDecile {
  decile: number;
  n: number;
  mean_pred: number;
  mean_real: number;
  ratio: number;
}

export interface Calibration {
  deciles: CalDecile[];
  /** Least-squares slope of log(realized) on log(predicted) over the out-of-fold set; 1 is the diagonal. */
  slope: number;
  intercept: number;
  /** Deciles whose mean prediction lands below the mean realized cap (ratio < 1). */
  under_deciles: number;
}

export function calibrationOf(oof: OofRow[]): Calibration {
  const rows = [...oof].sort((a, b) => a.pred - b.pred || (a.p.slug < b.p.slug ? -1 : 1));
  const n = rows.length;
  const deciles: CalDecile[] = [];
  for (let d = 0; d < 10; d++) {
    const bucket = rows.slice(Math.floor((d * n) / 10), Math.floor(((d + 1) * n) / 10));
    if (bucket.length === 0) continue;
    const meanPred = bucket.reduce((s, r) => s + r.pred, 0) / bucket.length;
    const meanReal = bucket.reduce((s, r) => s + r.actual, 0) / bucket.length;
    deciles.push({ decile: d + 1, n: bucket.length, mean_pred: Math.round(meanPred), mean_real: Math.round(meanReal), ratio: round2(meanPred / meanReal) });
  }
  const xs = rows.map((r) => Math.log(r.pred));
  const ys = rows.map((r) => Math.log(r.actual));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; }
  const slope = sxy / sxx;
  return { deciles, slope: round2(slope), intercept: round2(my - slope * mx), under_deciles: deciles.filter((d) => d.ratio < 1).length };
}

export interface DecompRow {
  label: string;
  n: number;
  median_factor: number;
}

export interface WorstRow {
  name: string;
  slug: string;
  category: string | null;
  tvl_usd: number;
  pred: number;
  actual: number;
  factor: number;
  cause: 'thin family' | 'stale input' | 'genuine model miss';
  cause_detail: string;
}

export interface Decomposition {
  by_category: DecompRow[];
  by_tvl_band: DecompRow[];
  worst: WorstRow[];
  worst_k: number;
}

const TVL_BANDS: { label: string; lo: number; hi: number }[] = [
  { label: 'Under $10M', lo: 0, hi: 10_000_000 },
  { label: '$10–50M', lo: 10_000_000, hi: 50_000_000 },
  { label: '$50–250M', lo: 50_000_000, hi: 250_000_000 },
  { label: 'Over $250M', lo: 250_000_000, hi: Number.POSITIVE_INFINITY },
];

/**
 * Where the out-of-fold error lives: median factor miss by category and
 * by TVL band, and the worst decile of misses named, each classified
 * under a stated rule applied in order — priced on the curve because its
 * family is thin (thin family), TVL moved at least 25% inside the
 * snapshot's own 7-day window (stale input), otherwise a genuine miss.
 */
export function decompositionOf(oof: OofRow[], fit: StagedFit): Decomposition {
  const medFactor = (rs: OofRow[]): number => round2(medianOf(rs.map((r) => factorMiss(r.pred, r.actual))));
  const byCat = new Map<string, OofRow[]>();
  for (const r of oof) {
    const key = r.p.category ?? 'Uncategorized';
    const list = byCat.get(key);
    if (list) list.push(r);
    else byCat.set(key, [r]);
  }
  const by_category: DecompRow[] = [...byCat.entries()]
    .map(([label, rs]) => ({ label, n: rs.length, median_factor: medFactor(rs) }))
    .sort((a, b) => b.median_factor - a.median_factor || (a.label < b.label ? -1 : 1));
  const by_tvl_band: DecompRow[] = TVL_BANDS.map((b) => {
    const rs = oof.filter((r) => r.p.tvl_usd >= b.lo && r.p.tvl_usd < b.hi);
    return { label: b.label, n: rs.length, median_factor: rs.length ? medFactor(rs) : 0 };
  }).filter((b) => b.n > 0);
  const worst_k = Math.max(1, Math.round(oof.length / 10));
  const worst: WorstRow[] = [...oof]
    .sort((a, b) => factorMiss(b.pred, b.actual) - factorMiss(a.pred, a.actual) || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, worst_k)
    .map((r) => {
      let cause: WorstRow['cause'];
      let cause_detail: string;
      if (r.level === 'global') {
        const fam = fit.families.get(familyOf(r.p));
        cause = 'thin family';
        cause_detail = `its family (${r.p.category ?? 'Uncategorized'}) has ${fam ? fam.peers : 0} traded members in the pool — fewer than 3 — so the size curve priced it with no family offset`;
      } else if (r.p.change_7d !== null && Math.abs(r.p.change_7d) >= 25) {
        cause = 'stale input';
        cause_detail = `its TVL moved ${r.p.change_7d.toFixed(1)}% inside the snapshot's own 7-day window — the input was in flux`;
      } else {
        cause = 'genuine model miss';
        cause_detail = 'the market values this protocol far from where the curve and its family offset put it';
      }
      return {
        name: r.p.name,
        slug: r.p.slug,
        category: r.p.category,
        tvl_usd: r.p.tvl_usd,
        pred: Math.round(r.pred),
        actual: r.actual,
        factor: round2(factorMiss(r.pred, r.actual)),
        cause,
        cause_detail,
      };
    });
  return { by_category, by_tvl_band, worst, worst_k };
}

// ---------------------------------------------------------------------------
// Data quality: the snapshot audited before any fitting (defi-data-quality)
// ---------------------------------------------------------------------------

export interface BandViolation {
  name: string;
  slug: string;
  category: string | null;
  multiple: number;
  tvl_usd: number;
  mcap_usd: number;
  side: 'high' | 'low';
  cause: string;
}

export interface DataQuality {
  protocols: number;
  records_no_token: number;
  excl_set_aside: { category: string; n: number }[];
  excl_set_aside_total: number;
  excl_versioned: number;
  excl_wrapped: number;
  excl_exchange: number;
  board_rows: number;
  tokenized: number;
  zero_mcap: number;
  negative_mcap: { name: string; slug: string; mcap_usd: number }[];
  partial_token_records: number;
  fit_pool_n: number;
  fit_excl_zero: number;
  fit_excl_negative: number;
  fit_excl_nonpos_tvl: number;
  completeness: { field: string; nulls: number; pct: number }[];
  dup_slugs: number;
  dup_names: number;
  tvl_zero: number;
  tvl_negative: number;
  watchlist_total: number;
  watchlist_in_snapshot: number;
  watchlist_missing: string[];
  watchlist_on_board: number;
  band_lo: number;
  band_hi: number;
  band_violations: BandViolation[];
  band_effect: { slope_with: number; slope_without: number; board_changed_gt1pct: number; median_abs_change_pct: number };
  wrapper_protocols: number;
  wrapper_no_token: number;
  wrapper_in_fit: number;
}

const WRAPPER_CATS = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/**
 * The snapshot-level audit, computed from the file itself: the board's
 * product-type exclusions by rule with counts, the fit pool's exclusions,
 * completeness and validity counts, watchlist verification, and a
 * log-space IQR sanity band over the traded multiples whose violators
 * are named — never deleted — with the measured effect of dropping them
 * (the shipped model refitted without them, board prices compared).
 */
export function dataQualityOf(snapshot: Snap, fit: StagedFit, terms: Terms, board: Row[], asOfMs: number): DataQuality {
  const ps = snapshot.protocols;
  const noToken = ps.filter(recordsNoToken);
  const aside = new Map<string, number>();
  let versioned = 0;
  let wrapped = 0;
  let exchange = 0;
  for (const p of noToken) {
    if (p.category !== null && SET_ASIDE.has(p.category)) aside.set(p.category, (aside.get(p.category) ?? 0) + 1);
    else if (NAME_VERSIONED.test(p.name)) versioned++;
    else if (NAME_WRAPPED.test(p.name)) wrapped++;
    else if (EXCHANGE_HEADS.some((x) => p.name.startsWith(x))) exchange++;
  }
  const pool = fitPool(ps);
  const logs = pool.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd)).sort((a, b) => a - b);
  const q1 = quantileOf(logs, 0.25);
  const q3 = quantileOf(logs, 0.75);
  const iqr = q3 - q1;
  const bandLo = 10 ** (q1 - 1.5 * iqr);
  const bandHi = 10 ** (q3 + 1.5 * iqr);
  const violations: BandViolation[] = pool
    .map((p) => ({ p, m: p.mcap_usd! / p.tvl_usd }))
    .filter(({ m }) => m < bandLo || m > bandHi)
    .sort((a, b) => b.m - a.m)
    .map(({ p, m }) => ({
      name: p.name,
      slug: p.slug,
      category: p.category,
      multiple: roundMult(m),
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      side: m > bandHi ? ('high' as const) : ('low' as const),
      cause:
        m > bandHi
          ? "the token's market value sits far outside the TVL this snapshot records for it — the cap likely prices something the TVL does not capture, or is an FDV-like figure"
          : 'the recorded cap is a sliver of the recorded TVL — a stale or orphaned token price, or TVL the token does not capture',
    }));
  const violSlugs = new Set(violations.map((v) => v.slug));
  const fitWithout = fitStaged(pool.filter((p) => !violSlugs.has(p.slug)), asOfMs);
  const protoBySlug = new Map(ps.map((p) => [p.slug, p]));
  let changed = 0;
  const pctChanges: number[] = [];
  for (const row of board) {
    const p = protoBySlug.get(row.slug);
    if (!p) continue;
    const alt = Math.max(1, Math.round(10 ** predictLog(fitWithout, p, terms).logv));
    const pct = Math.abs(alt - row.implied_value_usd) / row.implied_value_usd;
    pctChanges.push(pct * 100);
    if (pct > 0.01) changed++;
  }
  const countNull = (f: (p: Proto) => boolean): number => ps.filter(f).length;
  const pct1 = (n: number): number => round1((n / ps.length) * 100);
  const slugCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const p of ps) {
    slugCounts.set(p.slug, (slugCounts.get(p.slug) ?? 0) + 1);
    nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  }
  const snapSlugs = new Set(ps.map((p) => p.slug));
  return {
    protocols: ps.length,
    records_no_token: noToken.length,
    excl_set_aside: [...aside.entries()]
      .map(([category, n]) => ({ category, n }))
      .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1)),
    excl_set_aside_total: [...aside.values()].reduce((a, b) => a + b, 0),
    excl_versioned: versioned,
    excl_wrapped: wrapped,
    excl_exchange: exchange,
    board_rows: board.length,
    tokenized: ps.filter((p) => p.mcap_usd !== null).length,
    zero_mcap: ps.filter((p) => p.mcap_usd === 0).length,
    negative_mcap: ps
      .filter((p) => p.mcap_usd !== null && p.mcap_usd < 0)
      .map((p) => ({ name: p.name, slug: p.slug, mcap_usd: p.mcap_usd! })),
    partial_token_records: ps.filter((p) => p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null)).length,
    fit_pool_n: pool.length,
    fit_excl_zero: ps.filter((p) => p.mcap_usd === 0).length,
    fit_excl_negative: ps.filter((p) => p.mcap_usd !== null && p.mcap_usd < 0).length,
    fit_excl_nonpos_tvl: ps.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd <= 0).length,
    completeness: [
      { field: 'category', nulls: countNull((p) => p.category === null), pct: pct1(countNull((p) => p.category === null)) },
      { field: 'chains (empty)', nulls: countNull((p) => p.chains.length === 0), pct: pct1(countNull((p) => p.chains.length === 0)) },
      { field: 'change_7d', nulls: countNull((p) => p.change_7d === null), pct: pct1(countNull((p) => p.change_7d === null)) },
      { field: 'listed_at', nulls: countNull((p) => p.listed_at === null), pct: pct1(countNull((p) => p.listed_at === null)) },
    ],
    dup_slugs: [...slugCounts.values()].filter((n) => n > 1).length,
    dup_names: [...nameCounts.values()].filter((n) => n > 1).length,
    tvl_zero: countNull((p) => p.tvl_usd === 0),
    tvl_negative: countNull((p) => p.tvl_usd < 0),
    watchlist_total: snapshot.watchlist.length,
    watchlist_in_snapshot: snapshot.watchlist.filter((s) => snapSlugs.has(s)).length,
    watchlist_missing: snapshot.watchlist.filter((s) => !snapSlugs.has(s)),
    watchlist_on_board: board.filter((r) => r.watchlist).length,
    band_lo: roundMult(bandLo),
    band_hi: roundMult(bandHi),
    band_violations: violations,
    band_effect: {
      slope_with: round2(fit.curve.b),
      slope_without: round2(fitWithout.curve.b),
      board_changed_gt1pct: changed,
      median_abs_change_pct: round1(medianOf(pctChanges)),
    },
    wrapper_protocols: ps.filter((p) => p.category !== null && WRAPPER_CATS.has(p.category)).length,
    wrapper_no_token: noToken.filter((p) => p.category !== null && WRAPPER_CATS.has(p.category)).length,
    wrapper_in_fit: pool.filter((p) => p.category !== null && WRAPPER_CATS.has(p.category)).length,
  };
}

// ---------------------------------------------------------------------------
// Plan economics. All money below is integer cents until it is printed, so
// a plan's step costs sum to its stated total exactly — no rounding drift
// between the steps a reader sees and the verdict that closes the plan.
// ---------------------------------------------------------------------------

/** Scenario S, the reward assumption set — printed in full on the dashboard. */
export const SCENARIO = {
  /** Share of the implied value assumed to go to early users at a launch. */
  allocation_share: 0.05,
  /** The pool is shared over this assumed farmed fraction of TVL, not all of it. */
  farmed_fraction: 0.25,
};

/** Modeled hours: 45 minutes of setup plus one hour per session. */
export const SETUP_HOURS = 0.75;
export const SESSION_HOURS = 1;

export interface FeePart {
  label: string;
  cents: number;
  at: 'open' | 'window';
}

export interface StepCost {
  gas_cents: number;
  fees_cents: number;
}

export interface Plan {
  mechanism: string;
  mechanism_label: string;
  position_usd: number;
  band: string;
  weeks: number;
  sessions: number;
  hours: number;
  gas_per_session_cents: number;
  fee_parts: FeePart[];
  step_costs: StepCost[];
  gas_total_cents: number;
  fees_total_cents: number;
  total_cost_cents: number;
  reward_scenario_cents: number;
  reward_pro_rata_cents: number;
  net_scenario_cents: number;
  net_pro_rata_cents: number;
  net_per_hour_cents: number;
  /** Percent of the Scenario S reward the plan must receive to cover its cost; over 100 means it cannot. */
  break_even_pct: number;
  verdict: string;
}

interface Tier {
  min_tvl: number;
  band_lo: number;
  band_hi: number;
  weeks: number;
}

/** Working-capital bands by protocol scale; the modeled position is the band midpoint. */
const TIERS: Tier[] = [
  { min_tvl: 250_000_000, band_lo: 2_500, band_hi: 10_000, weeks: 10 },
  { min_tvl: 100_000_000, band_lo: 1_000, band_hi: 4_000, weeks: 10 },
  { min_tvl: 50_000_000, band_lo: 500, band_hi: 2_000, weeks: 8 },
  { min_tvl: 15_000_000, band_lo: 200, band_hi: 800, weeks: 7 },
  { min_tvl: 0, band_lo: 50, band_hi: 300, weeks: 5 },
];

function tierFor(tvl: number): Tier {
  for (const t of TIERS) if (tvl >= t.min_tvl) return t;
  return TIERS[TIERS.length - 1]!;
}

/** Sessions a week, the cadence every plan is costed at. */
const SESSIONS_PER_WEEK = 2;

/** Modeled gas per session, in cents, by chain — an assumption, printed on the dashboard. */
const GAS_CENTS: Record<string, number> = {
  Ethereum: 450,
  Solana: 6,
  'BNB Chain': 25,
  Tron: 30,
  Bitcoin: 60,
  Sui: 10,
  Aptos: 10,
  NEAR: 10,
  Cosmos: 15,
  Sei: 10,
  Injective: 10,
  Celestia: 10,
  Starknet: 20,
  Hyperliquid: 5,
};
const L2_CHAINS = new Set([
  'Arbitrum', 'Optimism', 'Base', 'Linea', 'Scroll', 'zkSync Era', 'Mantle',
  'Ink', 'Blast', 'Mode', 'Taiko', 'Unichain', 'World Chain', 'Zora', 'Boba',
  'Metis', 'Polygon', 'Avalanche', 'Sonic', 'Berachain', 'Monad', 'Flare',
]);
const GAS_DEFAULT_CENTS = 60;

function gasCentsFor(chain: string): number {
  const known = GAS_CENTS[chain];
  if (known !== undefined) return known;
  return L2_CHAINS.has(chain) ? 35 : GAS_DEFAULT_CENTS;
}

const GAS_TOKEN: Record<string, string> = {
  Ethereum: 'ETH', Base: 'ETH', Arbitrum: 'ETH', Optimism: 'ETH', Linea: 'ETH',
  Scroll: 'ETH', 'zkSync Era': 'ETH', Mantle: 'MNT', Solana: 'SOL',
  'BNB Chain': 'BNB', Polygon: 'POL', Avalanche: 'AVAX', Sui: 'SUI',
  Aptos: 'APT', Tron: 'TRX', Bitcoin: 'BTC', Cosmos: 'ATOM', NEAR: 'NEAR',
  Starknet: 'STRK', Hyperliquid: 'HYPE', Sei: 'SEI', Injective: 'INJ',
  Celestia: 'TIA', Berachain: 'BERA', Monad: 'MON', Sonic: 'S', Flare: 'FLR',
  TON: 'TON', Cardano: 'ADA', Ink: 'ETH', Stellar: 'XLM', Bittensor: 'TAO',
};

/** Print cents as dollars: whole dollars without decimals, otherwise two. */
export function fmtUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = abs % 100;
  const body = rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}

export function fmtSignedUsd(cents: number): string {
  return cents >= 0 ? `+${fmtUsd(cents)}` : fmtUsd(cents);
}

/** FNV-1a over the slug: picks plan phrasings deterministically per protocol. */
function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Mechanisms. A plan is keyed by what the protocol actually does: the steps
// name that mechanism's real actions and its fee parts come from that
// mechanism's formula. P is the modeled position in dollars, W the window
// in weeks, N the session count.
// ---------------------------------------------------------------------------

interface PlanCtx {
  name: string;
  chain: string;
  chains: string[];
  gasToken: string;
  band: string;
  position: number;
  weeks: number;
}

interface Mech {
  label: string;
  fees: (P: number, W: number, N: number) => FeePart[];
  open: (c: PlanCtx) => string;
  core: (c: PlanCtx) => string;
  breadth: (c: PlanCtx) => string;
  breadthSolo: (c: PlanCtx) => string;
  track: (c: PlanCtx) => string;
}

const fee = (label: string, cents: number, at: 'open' | 'window'): FeePart => ({ label, cents: Math.max(0, Math.round(cents)), at });
const MECHS: Record<string, Mech> = {
  dex: {
    label: 'DEX swaps + two-sided liquidity',
    fees: (P, W, N) => [
      fee('swap fees at 0.15% on modeled turnover of a quarter-position a session', 100 * (P / 4) * N * 0.0015, 'window'),
      fee('LP rebalance fees at 0.1% of the position a week', 100 * P * 0.001 * W, 'window'),
    ],
    open: () => 'Make a first small swap through its main interface, then seed a two-sided position in one of its busiest pools',
    core: () => 'route ordinary swaps through it each session and keep the pool position in range, rebalancing rather than withdrawing when it drifts',
    breadth: () => 'trade and provide on its second-busiest chain as well, so the history is not confined to one network',
    breadthSolo: () => 'add a second pool position on a different pair, so the record is not a single market',
    track: () => 'claim pool fees and any liquidity incentives it issues on its own schedule, and log every rebalance with its fee',
  },
  'liq-mgr': {
    label: 'Managed liquidity position',
    fees: (P, W, N) => [
      fee('swap fees at 0.15% on modeled turnover of a quarter-position a session', 100 * (P / 4) * N * 0.0015, 'window'),
      fee('position adjustment fees at 0.1% of the position a week', 100 * P * 0.001 * W, 'window'),
    ],
    open: () => 'Deposit a first tranche into its main managed position',
    core: () => 'keep the managed position in range across the window, checking it each session and topping up rather than exiting at the first rebalance',
    breadth: () => 'open a second managed position on another chain it runs',
    breadthSolo: () => 'open a second managed position on another pair, at a different range',
    track: () => 'follow its rebalance notices and claim any manager incentives it pays, logging each adjustment',
  },
  'lev-farm': {
    label: 'Leveraged liquidity farming',
    fees: (P, W, N) => [
      fee('swap fees at 0.15% on modeled turnover of a quarter-position a session', 100 * (P / 4) * N * 0.0015, 'window'),
      fee('position adjustment fees at 0.1% of the position a week', 100 * P * 0.001 * W, 'window'),
    ],
    open: () => 'Open a small leveraged position at the lowest leverage it offers',
    core: () => 'keep leverage conservative, check the position\u2019s health every session, and top up collateral early rather than letting it near liquidation',
    breadth: () => 'run a second, smaller leveraged position on a different pair it offers',
    breadthSolo: () => 'run a second, smaller position on a different underlying pair it offers',
    track: () => 'claim farm rewards on its schedule and keep a dated log of every health check and top-up',
  },
  lending: {
    label: 'Lending loop: supply, borrow, repay',
    fees: (P, W) => [
      fee('borrow interest on a 55% loan-to-value loop at a modeled 6% APR', 100 * P * 0.55 * 0.06 * (W / 52), 'window'),
    ],
    open: () => 'Supply a first tranche as collateral in its main money market',
    core: () => 'borrow a modest share against the collateral and repay on a cycle, keeping the health factor comfortably clear of liquidation the whole window',
    breadth: () => 'run a second, smaller supply position on another chain it serves',
    breadthSolo: () => 'run a second, smaller supply position in a different asset market it lists',
    track: () => 'claim any supply or borrow incentives it issues and log every loop cycle with the interest it cost',
  },
  vault: {
    label: 'Yield vault deposit',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main vault or strategy',
    core: () => 'keep the deposit live for the whole window, harvest or compound on schedule, and add in tranches rather than one lump sum',
    breadth: () => 'open a smaller position in a second vault on another chain it runs',
    breadthSolo: () => 'open a smaller position in a second vault running a different strategy or asset',
    track: () => 'claim distributions as they are paid and log each tranche with its date and size',
  },
  aggregator: {
    label: 'Auto-compounding vault',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main auto-compounding vault',
    core: () => 'keep the position compounding across the window and top it up in tranches, letting the harvest cycle do its work',
    breadth: () => 'open a smaller position in a vault on another chain it aggregates',
    breadthSolo: () => 'open a smaller position in a second vault on a different underlying asset',
    track: () => 'log each top-up and check the vault\u2019s reported yield against the position\u2019s actual growth weekly',
  },
  farm: {
    label: 'Farm pool staking',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main farm pool',
    core: () => 'keep the farm position live and claim or compound its rewards on a weekly cadence rather than letting them sit',
    breadth: () => 'join a second pool it runs, on a different pair or asset',
    breadthSolo: () => 'join a second pool it runs, on a different pair or asset',
    track: () => 'claim rewards on schedule and keep a dated log of every claim and compound',
  },
  allocator: {
    label: 'Capital allocation vault',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main allocation vault',
    core: () => 'keep the allocation live across the window, claim distributions on schedule, and add in tranches as the vault allocates',
    breadth: () => 'open a smaller position in a second strategy it allocates to',
    breadthSolo: () => 'open a smaller position in a second strategy it allocates to',
    track: () => 'follow its allocation reports and log every distribution the position receives',
  },
  curator: {
    label: 'Curated vault deposit',
    fees: () => [],
    open: () => 'Deposit a first tranche into one of its curated vaults',
    core: () => 'keep the vault position live across the window and follow the curator\u2019s reallocation notices instead of chasing them',
    breadth: () => 'split a smaller tranche into a second vault under a different curator or risk profile',
    breadthSolo: () => 'split a smaller tranche into a second vault under a different curator or risk profile',
    track: () => 'log each reallocation notice and claim any curator incentives the vault pays',
  },
  basis: {
    label: 'Basis position',
    fees: () => [],
    open: () => 'Open a first small basis position through its vault',
    core: () => 'keep the position funded for the whole window; basis returns accrue with time in the trade, not with churn, so resist closing early',
    breadth: () => 'add a second tranche on a different underlying if it offers one',
    breadthSolo: () => 'add a second tranche on a different underlying if it offers one',
    track: () => 'log the funding the position earns or pays each week, since that is the position\u2019s real carry',
  },
  perps: {
    label: 'Perpetuals volume',
    fees: (P, _W, N) => [
      fee('taker fees at 0.05% on 3x notional, one trade a session', 100 * P * 3 * N * 0.0005, 'window'),
    ],
    open: () => 'Open a first small trade on its main perpetual market',
    core: () => 'trade small size on a regular cadence, opening and closing cleanly, rather than holding one large directional position',
    breadth: () => 'trade a second market it lists, so the activity is not one instrument only',
    breadthSolo: () => 'trade a second market it lists, so the activity is not one instrument only',
    track: () => 'log every trade with its fee and funding paid or received; funding is excluded from this plan\u2019s cost model and cuts both ways',
  },
  cdp: {
    label: 'Collateralised debt position',
    fees: (P, W) => [
      fee('mint fee at 0.5% of the amount minted against the collateral', 100 * 0.005 * 0.4 * P, 'open'),
      fee('stability fee at a modeled 3% APR on the minted amount', 100 * 0.4 * P * 0.03 * (W / 52), 'window'),
    ],
    open: () => 'Open a small collateralised debt position and mint a modest amount of its stablecoin against it',
    core: () => 'keep the collateral ratio well above the liquidation line, and repay and re-mint on a cycle rather than letting the position sit untouched',
    breadth: () => 'use the minted stablecoin inside its own ecosystem where it is accepted',
    breadthSolo: () => 'open a second small position on another collateral type it accepts',
    track: () => 'check the collateral ratio weekly and log every mint, repay and stability charge',
  },
  options: {
    label: 'Options flow',
    fees: (P, W) => [
      fee('option premiums at a modeled 2% of the position per weekly roll', 100 * P * 0.02 * W, 'window'),
    ],
    open: () => 'Buy or write a first small option position',
    core: () => 'roll small positions on a weekly cadence and let some expire rather than closing everything early',
    breadth: () => 'use a second strike or expiry series it offers',
    breadthSolo: () => 'use a second strike or expiry series it offers',
    track: () => 'log every premium paid and every expiry; the premium line is this plan\u2019s main cost and it is spent, not held',
  },
  'options-vault': {
    label: 'Options vault epochs',
    fees: () => [],
    open: () => 'Deposit a first tranche into its main options vault',
    core: () => 'keep the deposit across several weekly epochs, since vault strategies settle per epoch and partial epochs earn partial results',
    breadth: () => 'join a second vault on a different underlying where offered',
    breadthSolo: () => 'join a second vault on a different underlying where offered',
    track: () => 'log each epoch\u2019s settlement against the deposit and claim payouts as they land',
  },
  bridge: {
    label: 'Bridge crossings',
    fees: (P, W) => [
      fee('relayer fees at 0.1% of the amount crossed', 100 * P * W * 0.001, 'window'),
      fee('fixed crossing fees at $0.75 a crossing, two a week', 150 * W, 'window'),
    ],
    open: () => 'Bridge a small amount across its busiest route',
    core: () => 'move funds in both directions on two different routes, at varied times of day, rather than one large crossing',
    breadth: () => 'use a second chain pair it supports, so the history is not a single corridor',
    breadthSolo: () => 'use a second chain pair it supports, so the history is not a single corridor',
    track: () => 'use the bridged funds in the destination chain\u2019s own apps between crossings, and log every crossing with its fee',
  },
  chain: {
    label: 'Native chain activity',
    fees: (P) => [fee('bridge-in fee at 0.1% of the amount moved onto the chain', 100 * 0.001 * P, 'open')],
    open: () => 'Bridge starter funds onto the chain and make a first transaction in one of its native apps',
    core: () => 'use its native decentralised apps each session — swaps, lending, a name or NFT mint where cheap — so the wallet builds ordinary history',
    breadth: () => 'hold a small balance and keep transacting through quiet weeks, not only during campaigns',
    breadthSolo: () => 'hold a small balance and keep transacting through quiet weeks, not only during campaigns',
    track: () => 'log active days and distinct apps used; on a chain, breadth of ordinary use is the record that matters',
  },
  staking: {
    label: 'Staking pool',
    fees: () => [],
    open: () => 'Stake a first tranche in its main pool',
    core: () => 'compound or re-stake rewards on a fixed cadence instead of letting them sit idle',
    breadth: () => 'join a second pool it runs where the terms differ',
    breadthSolo: () => 'join a second pool it runs where the terms differ',
    track: () => 'claim rewards on schedule and log every compound with its date',
  },
  restaking: {
    label: 'Restaking delegation',
    fees: () => [],
    open: () => 'Restake or delegate a first tranche through its main vault or operator set',
    core: () => 'keep the position delegated for the full window and track its operator or service rewards as they accrue',
    breadth: () => 'split a smaller second tranche across another operator or vault it lists',
    breadthSolo: () => 'split a smaller second tranche across another operator or vault it lists',
    track: () => 'claim points or rewards it issues on schedule and log the delegation\u2019s state weekly',
  },
  rwa: {
    label: 'Real-world asset holding',
    fees: (P) => [fee('onboarding and subscription fee at 0.25% of the position', 100 * 0.0025 * P, 'open')],
    open: () => 'Complete its onboarding or KYC step if it requires one, then make a first deposit',
    core: () => 'hold the real-world-asset position across the window and claim distributions as they are paid',
    breadth: () => 'add a second asset or tranche it offers rather than concentrating in one',
    breadthSolo: () => 'add a second asset or tranche it offers rather than concentrating in one',
    track: () => 'log every distribution and keep the onboarding records with the position\u2019s paperwork',
  },
  launchpad: {
    label: 'Launchpad participation',
    fees: (P) => [fee('participation fee at 1% of a half-position allocation', 100 * 0.01 * (P / 2), 'open')],
    open: () => 'Register or verify the wallet on its launch platform',
    core: () => 'take part in the sales it runs at small size and hold at least part of each allocation instead of flipping all of it',
    breadth: () => 'stake or lock in its participation tier system if it runs one',
    breadthSolo: () => 'stake or lock in its participation tier system if it runs one',
    track: () => 'log every sale entered, the allocation received and what was held versus sold',
  },
  prediction: {
    label: 'Prediction market trading',
    fees: (P) => [fee('trading fees at 1% on modeled volume of 4x the position', 100 * P * 4 * 0.01, 'window')],
    open: () => 'Fund the account and take a first small position in a liquid market',
    core: () => 'trade both sides across several markets over the window rather than placing one large bet',
    breadth: () => 'take the less crowded side, or provide liquidity, in a second market category',
    breadthSolo: () => 'take the less crowded side, or provide liquidity, in a second market category',
    track: () => 'log every position with its entry price and settlement; settled history is the record here',
  },
  nft: {
    label: 'NFT marketplace trading',
    fees: (P) => [fee('marketplace fees at 2% on modeled volume of 2x the position', 100 * P * 2 * 0.02, 'window')],
    open: () => 'Make a first small purchase or listing on the marketplace',
    core: () => 'trade modest items on a regular cadence, listing as well as buying, so the wallet is not one-directional',
    breadth: () => 'use its second-busiest collection or chain where it operates on more than one',
    breadthSolo: () => 'use a second collection it lists actively, so the history is not one set of items',
    track: () => 'log buys, listings and sales with fees; creator royalties are excluded from this plan\u2019s cost model',
  },
  privacy: {
    label: 'Shielded usage',
    fees: (P, W) => [fee('shield and unshield fees at 0.1% of the position per weekly cycle', 100 * P * 0.001 * W, 'window')],
    open: () => 'Make a first small shielded deposit through its main interface',
    core: () => 'use the private transfer or shield flow a few times at varied amounts and intervals',
    breadth: () => 'withdraw through its standard route so the full cycle is on record',
    breadthSolo: () => 'withdraw through its standard route so the full cycle is on record',
    track: () => 'keep private records of each shield, transfer and unshield with dates and amounts',
  },
  synthetics: {
    label: 'Synthetic positions',
    fees: (P, _W, N) => [fee('trade fees at 0.15% of the position, one trade a session', 100 * P * 0.0015 * N, 'window')],
    open: () => 'Mint or trade a first small synthetic position',
    core: () => 'keep collateral posted and adjust the position each session rather than setting it and forgetting it',
    breadth: () => 'use a second synthetic asset it issues where available',
    breadthSolo: () => 'use a second synthetic asset it issues where available',
    track: () => 'log every adjustment with its fee and the collateral posted against it',
  },
  indexes: {
    label: 'Index holding',
    fees: (P) => [fee('issuance fee at 0.2% of the position', 100 * 0.002 * P, 'open')],
    open: () => 'Buy a first tranche of its main index product',
    core: () => 'hold the index across the window and add on a monthly cadence rather than trading it',
    breadth: () => 'hold a second index it issues where the composition differs',
    breadthSolo: () => 'hold a second index it issues where the composition differs',
    track: () => 'log each monthly addition and the index\u2019s composition changes as they are announced',
  },
  insurance: {
    label: 'Cover and capital pool',
    fees: (P, W) => [fee('cover premium at a modeled 4% APR on the position', 100 * P * 0.04 * (W / 52), 'window')],
    open: () => 'Buy a small cover policy, or stake into its capital pool',
    core: () => 'keep cover or stake live across the window and renew rather than letting it lapse',
    breadth: () => 'take a second cover type it underwrites where offered',
    breadthSolo: () => 'take a second cover type it underwrites where offered',
    track: () => 'log premiums paid and renewals; a claim, if one ever arises, is filed from the same wallet',
  },
  payments: {
    label: 'Payments usage',
    fees: () => [],
    open: () => 'Make a first real payment or transfer through it',
    core: () => 'route ordinary small payments through it each week, the way the product is meant to be used',
    breadth: () => 'use a second rail or currency it supports',
    breadthSolo: () => 'use a second rail or currency it supports',
    track: () => 'log payment count and volume monthly; interchange the product pays the user is excluded from this cost model',
  },
  locker: {
    label: 'Token locking terms',
    fees: (P) => [fee('lock fee at 0.5% of the amount locked', 100 * 0.005 * P, 'open')],
    open: () => 'Lock a small amount through its locker',
    core: () => 'keep a lock live for a full term and renew it once; locker usage is measured in completed terms, not in clicks',
    breadth: () => 'use its vesting or distribution tool if a small project-side use is available',
    breadthSolo: () => 'use its vesting or distribution tool if a small project-side use is available',
    track: () => 'log each lock\u2019s start, term and renewal so completed terms are provable',
  },
  stablecoin: {
    label: 'Stablecoin mint and liquidity',
    fees: (P, W) => [fee('mint, redeem and pool fees at 0.1% of the position per weekly cycle', 100 * P * 0.001 * W, 'window')],
    open: () => 'Mint or acquire a first tranche of its stablecoin and place it in one of its main pools',
    core: () => 'hold and use the stablecoin across the window, cycling a modest share through its pools and redemption route',
    breadth: () => 'use a second chain or pool where the stablecoin circulates',
    breadthSolo: () => 'use a second pool where the stablecoin circulates',
    track: () => 'log mints, redemptions and pool positions with their fees',
  },
  ai: {
    label: 'AI product usage',
    fees: (P) => [fee('usage credits bought over the window, modeled at 25% of the position', 100 * 0.25 * P, 'window')],
    open: () => 'Create an account or wallet link and buy a first small block of usage credits',
    core: () => 'use the product for real tasks each session; on a usage product, genuine consumption is the activity being recorded',
    breadth: () => 'use a second feature or model it offers, so the usage is not one endpoint repeated',
    breadthSolo: () => 'use a second feature or model it offers, so the usage is not one endpoint repeated',
    track: () => 'log credits bought and consumed; unspent credits are a cost only when they expire, which this model does not assume',
  },
  otc: {
    label: 'OTC dealing',
    fees: (P) => [fee('dealer spread at 0.3% on one full-position trade', 100 * 0.003 * P, 'open')],
    open: () => 'Request a first small quote and complete one trade through its desk or interface',
    core: () => 'trade at modest size on a regular cadence, taking quotes rather than posting one large order',
    breadth: () => 'trade a second asset or pair it quotes',
    breadthSolo: () => 'trade a second asset or pair it quotes',
    track: () => 'log every quote taken and the spread it carried',
  },
  governance: {
    label: 'Governance participation',
    fees: () => [],
    open: () => 'Take a first position in its governance or incentive product',
    core: () => 'vote where it asks holders to vote and keep the position live across the window rather than only at snapshot time',
    breadth: () => 'take part in a second programme or season it runs',
    breadthSolo: () => 'take part in a second programme or season it runs',
    track: () => 'log every vote with its date; a voting record is the substance of this plan',
  },
  collateral: {
    label: 'Collateral deposit',
    fees: () => [],
    open: () => 'Deposit a first tranche of collateral through its main interface',
    core: () => 'keep the collateral posted across the window and adjust it on a weekly check rather than chasing minimums',
    breadth: () => 'post a second, smaller tranche in another collateral type it accepts',
    breadthSolo: () => 'post a second, smaller tranche in another collateral type it accepts',
    track: () => 'log the collateral balance weekly and claim any yield or incentives it pays',
  },
  oracle: {
    label: 'Data service usage',
    fees: (P, _W, N) => [fee('data-request fees at 0.1% of the position a session', 100 * P * 0.001 * N, 'window')],
    open: () => 'Make a first data request or stake through its main interface',
    core: () => 'consume its data or staking product on a regular cadence, the way an integrating project would',
    breadth: () => 'use a second feed or product line it offers',
    breadthSolo: () => 'use a second feed or product line it offers',
    track: () => 'log requests made and fees paid per session',
  },
  generic: {
    label: 'Core product usage',
    fees: (P, _W, N) => [fee('protocol fees at a modeled 0.1% of the position a session', 100 * P * 0.001 * N, 'window')],
    open: () => 'Make a first small transaction through its main product',
    core: () => 'use its core product on a regular cadence at modest size, the way a genuine early user would',
    breadth: () => 'use a second surface it offers — another chain, market or product line',
    breadthSolo: () => 'use a second surface it offers — another market or product line on the same chain',
    track: () => 'log every session with its action and fee, so consistent use is provable later',
  },
};

/** Category to mechanism. Categories absent here fall back to generic usage. */
const CATEGORY_MECH: Record<string, string> = {
  Dexs: 'dex',
  'Liquidity Manager': 'liq-mgr',
  'Leveraged Farming': 'lev-farm',
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  Yield: 'vault',
  'Yield Aggregator': 'aggregator',
  Farm: 'farm',
  'Onchain Capital Allocator': 'allocator',
  'Risk Curators': 'curator',
  'Basis Trading': 'basis',
  Derivatives: 'perps',
  'Interest Rate Derivatives': 'perps',
  CDP: 'cdp',
  'CDP Manager': 'cdp',
  Options: 'options',
  'Options Vault': 'options-vault',
  'Cross Chain Bridge': 'bridge',
  Chain: 'chain',
  'Staking Pool': 'staking',
  Restaking: 'restaking',
  RWA: 'rwa',
  Launchpad: 'launchpad',
  'Prediction Market': 'prediction',
  'NFT Marketplace': 'nft',
  Privacy: 'privacy',
  Synthetics: 'synthetics',
  Indexes: 'indexes',
  Insurance: 'insurance',
  Payments: 'payments',
  'Crypto Card Issuer': 'payments',
  'Token Locker': 'locker',
  'Algo-Stables': 'stablecoin',
  'Dual-Token Stablecoin': 'stablecoin',
  'Stablecoin Issuer': 'stablecoin',
  'Anchor BTC': 'stablecoin',
  'Decentralized BTC': 'stablecoin',
  'Decentralized AI': 'ai',
  'AI Agents': 'ai',
  'OTC Marketplace': 'otc',
  'Governance Incentives': 'governance',
  'Reserve Currency': 'governance',
  'Collateral Management': 'collateral',
  'Collateral Markets': 'collateral',
  DOR: 'oracle',
};

function mechFor(p: Proto): { key: string; mech: Mech } {
  const key = CATEGORY_MECH[p.category ?? ''] ?? 'generic';
  return { key, mech: MECHS[key]! };
}

/**
 * The verdict ladder, defined on the dashboard and keyed on the deposit
 * model: SKIP when the Scenario S reward does not cover the plan's cost
 * at all; FARM when it covers the cost twice over (the plan still breaks
 * even if the reward lands at half the scenario); THIN between the two.
 */
export function verdictFor(netCents: number, costCents: number, rewardCents: number): string {
  if (netCents <= 0 || rewardCents <= 0) return 'SKIP';
  return costCents * 2 <= rewardCents ? 'FARM' : 'THIN';
}

/**
 * Build one protocol's plan: mechanism steps with their costs, and the
 * closing verdict. Gas is split as 2 sessions of setup, 1 to open, 1 to
 * breadth, the rest to the core cadence; fees land where they are incurred
 * (open parts on the opening step, window parts on the core step). The
 * reward keys on the protocol's own effective multiple — its implied
 * value over its TVL — so two plans share economics only when their
 * inputs genuinely coincide.
 */
export function buildPlan(p: Proto, effMultiple: number): { steps: string[]; plan: Plan } {
  const tier = tierFor(p.tvl_usd);
  const position = (tier.band_lo + tier.band_hi) / 2;
  const band = `$${tier.band_lo.toLocaleString('en-US')}–$${tier.band_hi.toLocaleString('en-US')}`;
  const weeks = tier.weeks;
  const sessions = weeks * SESSIONS_PER_WEEK;
  const hours = Math.round((SETUP_HOURS + sessions * SESSION_HOURS) * 100) / 100;
  const chain = p.chains[0] ?? 'Ethereum';
  const gasToken = GAS_TOKEN[chain] ?? 'the native gas token';
  const gas = gasCentsFor(chain);
  const { key, mech } = mechFor(p);
  const parts = mech.fees(position, weeks, sessions);
  const openFees = parts.filter((f) => f.at === 'open').reduce((s, f) => s + f.cents, 0);
  const windowFees = parts.filter((f) => f.at === 'window').reduce((s, f) => s + f.cents, 0);

  const stepCosts: StepCost[] = [
    { gas_cents: 2 * gas, fees_cents: 0 },
    { gas_cents: gas, fees_cents: openFees },
    { gas_cents: (sessions - 2) * gas, fees_cents: windowFees },
    { gas_cents: gas, fees_cents: 0 },
    { gas_cents: 0, fees_cents: 0 },
    { gas_cents: 0, fees_cents: 0 },
  ];
  const gasTotal = stepCosts.reduce((s, c) => s + c.gas_cents, 0);
  const feesTotal = openFees + windowFees;
  const total = gasTotal + feesTotal;

  const rewardS = Math.round(SCENARIO.allocation_share / SCENARIO.farmed_fraction * effMultiple * position * 100);
  const rewardC = Math.round(SCENARIO.allocation_share * effMultiple * position * 100);
  const netS = rewardS - total;
  const netC = rewardC - total;
  const netPerHour = Math.round(netS / hours);
  const breakEven = rewardS > 0 ? round1((100 * total) / rewardS) : 99999;
  const verdict = verdictFor(netS, total, rewardS);

  const ctx: PlanCtx = { name: p.name, chain, chains: p.chains, gasToken, band, position, weeks };
  const h = slugHash(p.slug);
  const pick = (options: string[], salt: number): string => options[(h >>> salt) % options.length]!;
  const costClause = (i: number): string => {
    const c = stepCosts[i]!;
    const sum = c.gas_cents + c.fees_cents;
    if (sum === 0) return ' Modeled cost: $0 — this step is off-chain.';
    const split = c.fees_cents === 0 ? 'all gas' : `gas ${fmtUsd(c.gas_cents)}, protocol fees ${fmtUsd(c.fees_cents)}`;
    return ` Modeled cost: ${fmtUsd(sum)} (${split}).`;
  };
  const ageNote = p.listed_at ? `DefiLlama has tracked it since ${p.listed_at}` : 'DefiLlama gives no listing date for it';
  const moveNote = p.change_7d === null
    ? 'its 7-day TVL change is unreported'
    : `its TVL moved ${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in the last 7 days`;
  const beText = breakEven > 999 ? 'over 999' : breakEven.toFixed(1);

  const steps = [
    pick([
      `Set up one dedicated wallet for ${p.name} on ${chain} and fund it with about ${fmtUsd(2 * gas)} of ${gasToken} for setup fees; keep it separate from any main wallet. Allow 30–45 minutes, including a small test transaction.`,
      `Prepare a clean wallet for ${p.name}: fund it on ${chain} with roughly ${fmtUsd(2 * gas)} worth of ${gasToken} so fees never stall a session. Setup takes about 30 minutes, including a small test transaction.`,
      `Start from a fresh farming wallet on ${chain}: send over about ${fmtUsd(2 * gas)} of ${gasToken} for gas and confirm a small test transaction lands before committing real size. Budget 30–45 minutes.`,
    ], 0) + costClause(0),
    `${mech.open(ctx)}, sized as the first slice of a ${band} working position (modeled at $${position.toLocaleString('en-US')}).` + costClause(1),
    `Core activity, ${weeks} weeks at two sessions a week: ${mech.core(ctx)}. ${ageNote}, and ${moveNote}, so size in gradually rather than all at once.` + costClause(2),
    (p.chains.length > 1
      ? `Spread the activity: ${p.name} also runs on ${p.chains.slice(1, 3).join(' and ')}. ${mech.breadth(ctx).charAt(0).toUpperCase() + mech.breadth(ctx).slice(1)}.`
      : `Deepen the single-chain footprint: ${mech.breadthSolo(ctx)}. ${p.name} is tracked on ${chain} only, so breadth has to come from its own product range.`) + costClause(3),
    pick([
      `Track the position: ${mech.track(ctx)}. Also check ${p.name}\u2019s official channels for a points, quests or early-user programme and enrol this same wallet if one is live; keep a dated log of every session, about 10 minutes a week.`,
      `Track the position: ${mech.track(ctx)}. If ${p.name} runs a points or early-user programme on its official channels, join it from this wallet and keep dated records of each action; 5–10 minutes of bookkeeping a week is enough.`,
    ], 3) + costClause(4),
    `Net verdict for ${p.name}: plan cost ${fmtUsd(total)} all-in (gas ${fmtUsd(gasTotal)}, protocol fees ${fmtUsd(feesTotal)}) over ${weeks} weeks on a $${position.toLocaleString('en-US')} modeled position, ${hours} modeled hours of work. Scenario S — a launch at the model's implied value, ${SCENARIO.allocation_share * 100}% of it to early users, the pool shared over an assumed farmed ${SCENARIO.farmed_fraction * 100}% of TVL — pays ${fmtUsd(rewardS)}: net ${fmtSignedUsd(netS)} (${fmtSignedUsd(netPerHour)} an hour), ${verdict}. Break-even at ${beText}% of the Scenario S reward; the pure TVL pro-rata bound pays ${fmtUsd(rewardC)} (net ${fmtSignedUsd(netC)}). Scenario S is an assumption set, not a prediction.`,
  ];

  const plan: Plan = {
    mechanism: key,
    mechanism_label: mech.label,
    position_usd: position,
    band,
    weeks,
    sessions,
    hours,
    gas_per_session_cents: gas,
    fee_parts: parts,
    step_costs: stepCosts,
    gas_total_cents: gasTotal,
    fees_total_cents: feesTotal,
    total_cost_cents: total,
    reward_scenario_cents: rewardS,
    reward_pro_rata_cents: rewardC,
    net_scenario_cents: netS,
    net_pro_rata_cents: netC,
    net_per_hour_cents: netPerHour,
    break_even_pct: breakEven,
    verdict,
  };
  return { steps: steps.map((s) => s.trim()), plan };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  parent: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  curve_value_usd: number;
  offset_factor: number;
  family_peers: number;
  parent_offset_factor: number;
  eff_multiple: number;
  level: 'family' | 'parent' | 'global';
  level_n: number;
  band_lo_usd: number;
  band_hi_usd: number;
  watchlist: boolean;
  plan: Plan;
}

export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  change_7d: number | null;
}

export interface Radar {
  board: Row[];
  live: LiveRow[];
  fit: StagedFit;
  terms: Terms;
  ladder: LadderStep[];
  validation: Validation;
  calibration: Calibration;
  decomposition: Decomposition;
  dq: DataQuality;
  live_total: number;
  scatter: { tvl_usd: number; mcap_usd: number }[];
}

export function buildRadar(snapshot: Snap): Radar {
  const asOfMs = Date.parse(snapshot.as_of);
  const gate = looGate(snapshot.protocols, asOfMs);
  const fit = fitStaged(fitPool(snapshot.protocols), asOfMs);
  const terms = gate.terms;
  const watch = new Set(snapshot.watchlist);
  const v = gate.validation;
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const { logv, level, level_n } = predictLog(fit, p, terms);
      const implied = Math.max(1, Math.round(10 ** logv));
      const curveValue = Math.max(1, Math.round(10 ** (fit.curve.a + fit.curve.b * Math.log10(p.tvl_usd))));
      return { p, implied, curveValue, level, level_n };
    })
    .sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const peersByCat = new Map<string, number>();
  for (const p of fitPool(snapshot.protocols)) {
    const c = familyOf(p);
    peersByCat.set(c, (peersByCat.get(c) ?? 0) + 1);
  }
  const board: Row[] = scored.map((s, i) => {
    const effMultiple = s.implied / s.p.tvl_usd;
    const { steps, plan } = buildPlan(s.p, effMultiple);
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: s.implied,
      farm_steps: steps,
      category: s.p.category,
      parent: parentOf(s.p),
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      curve_value_usd: s.curveValue,
      offset_factor: roundMult(s.implied / s.curveValue),
      family_peers: peersByCat.get(familyOf(s.p)) ?? 0,
      parent_offset_factor: roundMult(fit.parents.get(parentOf(s.p))?.offset_factor ?? 1),
      eff_multiple: roundMult(effMultiple),
      level: s.level,
      level_n: s.level_n,
      band_lo_usd: Math.min(s.implied, Math.max(1, Math.round(s.implied * v.band_lo_factor))),
      band_hi_usd: Math.max(s.implied, Math.round(s.implied * v.band_hi_factor)),
      watchlist: watch.has(s.p.slug),
      plan,
    };
  });
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 80)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: roundMult(p.mcap_usd! / p.tvl_usd),
      change_7d: p.change_7d,
    }));
  return {
    board,
    live,
    fit,
    terms,
    ladder: gate.ladder,
    validation: gate.validation,
    calibration: calibrationOf(gate.oof),
    decomposition: decompositionOf(gate.oof, fit),
    dq: dataQualityOf(snapshot, fit, terms, board, asOfMs),
    live_total: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    scatter: fitPool(snapshot.protocols).map((p) => ({ tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! })),
  };
}

/** The board as board.json carries it: the gate's fields plus the plan's headline economics. */
export function boardJsonRows(radar: Radar): unknown[] {
  return radar.board.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
    mechanism: r.plan.mechanism,
    level: r.level,
    band_lo_usd: r.band_lo_usd,
    band_hi_usd: r.band_hi_usd,
    plan_cost_usd: r.plan.total_cost_cents / 100,
    scenario_reward_usd: r.plan.reward_scenario_cents / 100,
    net_scenario_usd: r.plan.net_scenario_cents / 100,
    net_per_hour_usd: r.plan.net_per_hour_cents / 100,
    break_even_pct: r.plan.break_even_pct,
    verdict: r.plan.verdict,
  }));
}

/** The dashboard's data, written beside the page: window.RADAR = { board, live, model, ladder, ... }. */
export function dataScript(radar: Radar, snapshot: Snap): string {
  const payload = {
    board: radar.board,
    live: radar.live,
    live_total: radar.live_total,
    model: {
      a: radar.fit.curve.a,
      b: radar.fit.curve.b,
      fit_n: fitPool(snapshot.protocols).length,
      zero_mcap_seen: snapshot.protocols.filter((p) => p.mcap_usd === 0).length,
      min_family_peers: MIN_FAMILY_PEERS,
      shrink_family_k: SHRINK_FAMILY_K,
      shrink_parent_k: SHRINK_PARENT_K,
      growth_slope: radar.fit.growth_slope,
      age_slope: radar.fit.age_slope,
      median_change: radar.fit.median_change,
      families: [...radar.fit.families.values()]
        .filter((f) => f.peers >= MIN_FAMILY_PEERS)
        .map((f) => ({ category: f.category, parent: f.parent, peers: f.peers, offset_factor: f.offset_factor }))
        .sort((a, b) => b.offset_factor - a.offset_factor),
      parents: [...radar.fit.parents.values()]
        .map((f) => ({ parent: f.parent, peers: f.peers, offset_factor: f.offset_factor }))
        .sort((a, b) => b.offset_factor - a.offset_factor),
      terms: radar.terms,
    },
    ladder: radar.ladder,
    validation: radar.validation,
    calibration: radar.calibration,
    decomposition: radar.decomposition,
    dq: radar.dq,
    scatter: radar.scatter,
    scenario: SCENARIO,
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
    },
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}

/** A self-check in the gate's own terms: the first refusal, or null when the board is clean. */
export function boardIssue(board: Row[], snapshot: Snap): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100–4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  for (const [i, row] of board.entries()) {
    if (!slugs.has(row.slug)) return `row ${i + 1}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1}: rank is ${row.rank}, not ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) {
      return `row ${row.slug}: implied_value_usd ${row.implied_value_usd} is not a positive whole number within the cap`;
    }
    if (row.implied_value_usd > prev) return `row ${row.slug}: implied value rises as rank ascends`;
    prev = row.implied_value_usd;
    if (row.band_lo_usd > row.implied_value_usd || row.band_hi_usd < row.implied_value_usd) {
      return `row ${row.slug}: band ${row.band_lo_usd}–${row.band_hi_usd} does not bracket the implied value`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug}: ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug}: a farm step trims to ${len} characters`;
    }
    const planSum = row.plan.step_costs.reduce((s, c) => s + c.gas_cents + c.fees_cents, 0);
    if (planSum !== row.plan.total_cost_cents) return `row ${row.slug}: step costs sum to ${planSum}, plan total says ${row.plan.total_cost_cents}`;
    if (row.plan.net_scenario_cents !== row.plan.reward_scenario_cents - row.plan.total_cost_cents) {
      return `row ${row.slug}: net does not equal scenario reward minus cost`;
    }
  }
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}
