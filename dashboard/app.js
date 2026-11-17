'use strict';
/* Token Radar v3 dashboard. Renders window.RADAR (written beside this page
   by main.ts) — the board with its per-row band and basis, the model
   evidence (scatter, ladder, family offsets), the tokenized side of the
   snapshot, and the method view: gate, calibration, decomposition, data
   quality. No network, no libraries. */
const R = window.RADAR;
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (v) => (v === null || v === undefined ? '—' : '$' + num(Math.round(v)));
const money2 = (c) => {
  const v = c / 100;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (v) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%');
const factor = (v) => '×' + Number(v).toFixed(2);

// ---- headline fills ---------------------------------------------------------
const board = R.board;
const setAside = R.dq.excl_set_aside_total + R.dq.excl_versioned + R.dq.excl_wrapped + R.dq.excl_exchange;
const fills = {
  as_of: R.meta.as_of, as_of2: R.meta.as_of, source: R.meta.source, source2: R.meta.source,
  protocols: num(R.meta.protocols), floor: num(R.meta.floor_usd),
  board_rows: num(board.length), self_found: num(board.filter((r) => !r.watchlist).length),
  watch_covered: num(board.filter((r) => r.watchlist).length), watch_total: num(R.meta.watchlist),
  set_aside: num(setAside), fit_n: num(R.model.fit_n),
  loo_final: R.validation.final_factor.toFixed(2), loo_flat: R.validation.flat_factor.toFixed(2),
  curve_a: R.model.a.toFixed(4), curve_b: R.model.b.toFixed(4),
  band_lo_f: R.validation.band_lo_factor.toFixed(2), band_hi_f: R.validation.band_hi_factor.toFixed(2),
  spearman: R.validation.spearman.toFixed(2),
  wf_train: num(R.validation.wf_train_n), wf_test: num(R.validation.wf_test_n),
  cal_under: String(R.calibration.deciles.filter((d) => d.mean_pred < d.mean_real).length),
  cal_slope: R.calibration.slope.toFixed(2),
  zero_mcap: num(R.model.zero_mcap_seen), dq_neg_n: num(R.dq.fit_excl_negative), dq_partial: num(R.dq.partial_token_records),
  live_shown: num(R.live.length), live_total: num(R.live_total),
  family_rows: num(board.filter((r) => r.level === 'family').length),
  curve_rows: num(board.filter((r) => r.level === 'global').length),
};
$$('[data-fill]').forEach((el) => { const k = el.getAttribute('data-fill'); if (k in fills) el.textContent = fills[k]; });

// ---- gate outcome sentence + equation fragments ------------------------------
{
  const kept = R.ladder.filter((s) => s.kept).map((s) => s.label.toLowerCase());
  const rejected = R.ladder.filter((s) => !s.kept && s.key !== 'flat')
    .map((s) => `${s.label.toLowerCase()} (×${s.loo_factor.toFixed(2)} against ×${R.validation.final_factor.toFixed(2)})`);
  const el = $('#gate-outcome');
  if (el) el.innerHTML = `The validation gate (next panel) kept <strong>${esc(kept.join(' and '))}</strong>. It fitted and rejected ${esc(rejected.join('; '))} — each candidate was scored as an addition to the kept model, and none of them lowered the leave-one-out median.`;
  const eq = $('#eq-terms');
  if (eq) {
    const parts = [];
    if (R.model.terms.offsets) parts.push('+ family offset');
    if (R.model.terms.growth) parts.push('+ growth tilt');
    if (R.model.terms.age) parts.push('+ age term');
    eq.textContent = parts.length ? ' ' + parts.join(' ') : '';
  }
}

// ---- scatter: traded tokens, fitted curve, residual band ---------------------
{
  const host = $('#scatter');
  if (host && R.scatter.length) {
    const W = 360, H = 252, L = 46, B = 26, T = 8, Rt = 8;
    const xs = R.scatter.map((p) => Math.log10(p.tvl_usd));
    const ys = R.scatter.map((p) => Math.log10(p.mcap_usd));
    const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
    const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
    const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - Rt);
    const Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - B - T);
    const lo = Math.log10(R.validation.band_lo_factor), hi = Math.log10(R.validation.band_hi_factor);
    const curveY = (x) => R.model.a + R.model.b * x;
    const bandPts = [];
    for (let i = 0; i <= 24; i++) { const x = x0 + ((x1 - x0) * i) / 24; bandPts.push(`${X(x).toFixed(1)},${Y(curveY(x) + hi).toFixed(1)}`); }
    for (let i = 24; i >= 0; i--) { const x = x0 + ((x1 - x0) * i) / 24; bandPts.push(`${X(x).toFixed(1)},${Y(curveY(x) + lo).toFixed(1)}`); }
    const linePts = [];
    for (let i = 0; i <= 24; i++) { const x = x0 + ((x1 - x0) * i) / 24; linePts.push(`${X(x).toFixed(1)},${Y(curveY(x)).toFixed(1)}`); }
    const dots = R.scatter.map((p) => `<circle cx="${X(Math.log10(p.tvl_usd)).toFixed(1)}" cy="${Y(Math.log10(p.mcap_usd)).toFixed(1)}" r="2.1"/>`).join('');
    const fmtTick = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${(v / 1e3).toFixed(0)}K`);
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="scatter-svg" aria-hidden="true">
      <polygon points="${bandPts.join(' ')}" class="sc-band"/>
      ${dots}
      <polyline points="${linePts.join(' ')}" class="sc-line"/>
      <text x="${L}" y="${H - 8}" class="sc-tick">TVL ${fmtTick(10 ** x0)}</text>
      <text x="${W - Rt}" y="${H - 8}" text-anchor="end" class="sc-tick">${fmtTick(10 ** x1)}</text>
      <text x="4" y="${Y(y1) + 4}" class="sc-tick">${fmtTick(10 ** y1)}</text>
      <text x="4" y="${Y(y0) + 4}" class="sc-tick">cap ${fmtTick(10 ** y0)}</text>
    </svg>`;
  }
}

// ---- the gate's ladder (cover + method) --------------------------------------
{
  const SHORT = { flat: 'Flat 0.25× (unfitted)', curve: 'Size curve', offsets: '+ Family offsets', parent: '+ Parent level', growth: '+ Growth tilt', age: '+ Age term' };
  const render = (labelOf) => `<table class="mini"><thead><tr><th>Model step</th><th class="num">LOO median</th><th class="num">Walk-fwd</th><th>Gate</th></tr></thead><tbody>${
    R.ladder.map((s) => `<tr>
      <td>${esc(labelOf(s))}</td>
      <td class="num">×${s.loo_factor.toFixed(2)}</td>
      <td class="num">×${s.wf_factor.toFixed(2)}</td>
      <td>${s.key === 'flat' ? '<span class="gate-base">baseline</span>' : s.kept ? '<span class="gate-kept">kept</span>' : '<span class="gate-rej">rejected</span>'}</td>
    </tr>`).join('')
  }</tbody></table>`;
  const c = $('#ladder-cover'); if (c) c.innerHTML = render((s) => SHORT[s.key] ?? s.label);
  const m = $('#ladder-method'); if (m) m.innerHTML = render((s) => s.label);
  // Head-of-board read on the two rejected tilts (method view only): each
  // tilt's leave-one-out median on the top deciles, against the shipped
  // model's — printed because the overall median is not the only place a
  // rejection could hide a trade-off.
  const hc = $('#ladder-headcuts');
  if (hc) {
    const shippedRow = [...R.ladder].reverse().find((s) => s.kept);
    const line = (s) => {
      const worseA = s.loo_head_tvl >= shippedRow.loo_head_tvl;
      const worseB = s.loo_head_mcap >= shippedRow.loo_head_mcap;
      const tail = worseA && worseB
        ? 'Worse at the head as well — the rejection is not an overall-median trade-off.'
        : !worseA && !worseB
          ? `Better on both head cuts; it stays out on the overall median alone (×${s.loo_factor.toFixed(2)} against the shipped ×${shippedRow.loo_factor.toFixed(2)}), which is the number the gate selects on.`
          : 'Split at the head — better on one cut, worse on the other — and worse overall, so the rejection stands on either read.';
      return `<p class="honest">Head of board — ${esc(s.label)}: leave-one-out ×${s.loo_head_tvl.toFixed(2)} on the top TVL decile and ×${s.loo_head_mcap.toFixed(2)} on the top cap decile, against the shipped model's ×${shippedRow.loo_head_tvl.toFixed(2)} and ×${shippedRow.loo_head_mcap.toFixed(2)}. ${tail}</p>`;
    };
    hc.innerHTML = ['growth', 'age']
      .map((k) => R.ladder.find((s) => s.key === k))
      .filter((s) => s && shippedRow)
      .map(line)
      .join('');
  }
}

// ---- family offsets table ------------------------------------------------------
{
  const host = $('#fam-table');
  if (host) {
    const max = Math.max(...R.model.families.map((f) => Math.abs(Math.log10(f.offset_factor))));
    host.innerHTML = `<table class="mini"><thead><tr><th>Family (category)</th><th>Parent</th><th class="num">Traded peers</th><th class="num">Offset</th><th></th></tr></thead><tbody>${
      R.model.families.map((f) => {
        const w = max > 0 ? Math.round((Math.abs(Math.log10(f.offset_factor)) / max) * 100) : 0;
        const cls = f.offset_factor >= 1 ? 'bar-up' : 'bar-down';
        return `<tr><td>${esc(f.category)}</td><td>${esc(f.parent)}</td><td class="num">${f.peers}</td><td class="num">×${f.offset_factor.toFixed(2)}</td><td class="bar-cell"><span class="bar ${cls}" style="width:${w}%"></span></td></tr>`;
      }).join('')
    }</tbody></table>`;
  }
}

// ---- board ---------------------------------------------------------------------
const state = { q: '', category: '', chain: '', verdict: '', watch: false, sortKey: 'rank', sortDir: 1 };
const basisText = (r) => (r.level === 'family' ? `family fit · n=${r.level_n}` : 'size curve');
function visibleRows() {
  let rows = board.filter((r) =>
    (!state.q || (r.name + ' ' + r.slug).toLowerCase().includes(state.q)) &&
    (!state.category || r.category === state.category) &&
    (!state.chain || r.chains.includes(state.chain)) &&
    (!state.verdict || r.plan.verdict === state.verdict) &&
    (!state.watch || r.watchlist));
  const key = state.sortKey;
  const val = (r) => key === 'plan_cost' ? r.plan.total_cost_cents
    : key === 'plan_net' ? r.plan.net_scenario_cents
    : key === 'plan_nph' ? r.plan.net_per_hour_cents
    : r[key];
  rows = rows.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * state.sortDir;
  });
  return rows;
}
function renderBoard() {
  const rows = visibleRows();
  $('#board-body').innerHTML = rows.map((r) => `<tr data-slug="${esc(r.slug)}" tabindex="0">
    <td class="num">${r.rank}</td>
    <td><span class="pname">${esc(r.name)}${r.watchlist ? ' <span class="star" title="On the curated watchlist">★</span>' : ''}</span><span class="slug">${esc(r.slug)}</span></td>
    <td>${esc(r.category ?? '—')}</td>
    <td>${esc(r.chains[0] ?? '—')}${r.chains.length > 1 ? ` <span class="dim">+${r.chains.length - 1}</span>` : ''}</td>
    <td class="num">${money(r.tvl_usd)}</td>
    <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
    <td class="num"><strong>${money(r.implied_value_usd)}</strong><span class="band-line">${money(r.band_lo_usd)} – ${money(r.band_hi_usd)}</span></td>
    <td class="basis">${esc(basisText(r))}</td>
    <td class="num">${money2(r.plan.total_cost_cents)}</td>
    <td class="num ${r.plan.net_scenario_cents >= 0 ? 'up' : 'down'}">${money2(r.plan.net_scenario_cents)}</td>
    <td class="num ${r.plan.net_per_hour_cents >= 0 ? 'up' : 'down'}">${money2(r.plan.net_per_hour_cents)}</td>
    <td><span class="chip v-${r.plan.verdict.toLowerCase()}">${esc(r.plan.verdict)}</span></td>
  </tr>`).join('');
  $('#row-count').textContent = `${rows.length} of ${board.length} protocols`;
  $$('#board-body tr').forEach((tr) => {
    tr.addEventListener('click', () => openDetail(tr.getAttribute('data-slug')));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(tr.getAttribute('data-slug')); });
  });
}
{
  const cats = [...new Set(board.map((r) => r.category).filter(Boolean))].sort();
  $('#f-category').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  $('#f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
  $('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderBoard(); });
  $('#f-category').addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
  $('#f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('#f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  $('#f-watch').addEventListener('change', (e) => { state.watch = e.target.checked; renderBoard(); });
  $$('#board-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.getAttribute('data-sort');
    if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = 1; }
    renderBoard();
  }));
}

// ---- detail drawer ---------------------------------------------------------------
function openDetail(slug) {
  const r = board.find((x) => x.slug === slug);
  if (!r) return;
  const p = r.plan;
  const offsetRow = r.level === 'family'
    ? `<div class="row"><span>Family offset — ${esc(r.category ?? '')} (parent: ${esc(r.parent)}, parent offset ×${r.parent_offset_factor.toFixed(2)})</span><b>×${r.offset_factor.toFixed(2)} — the family's median curve residual over ${r.level_n} traded peers, shrunk toward the parent</b></div>`
    : `<div class="row"><span>Family offset</span><b>none fitted — ${esc(r.category ?? 'this family')} has ${r.family_peers} traded peer${r.family_peers === 1 ? '' : 's'} (minimum ${R.model.min_family_peers}); the row prices on the size curve, and the gate's ladder shows the deeper parent level was fitted and rejected</b></div>`;
  $('#detail-content').innerHTML = `
    <h2>${esc(r.name)} ${r.watchlist ? '<span class="star">★ watchlist</span>' : ''}</h2>
    <p class="d-sub">${esc(r.slug)} · rank ${r.rank} of ${board.length} · ${esc(r.category ?? 'uncategorised')} · ${esc(r.chains.join(', ') || 'no chains recorded')}${r.listed_at ? ` · tracked since ${esc(r.listed_at)}` : ''}</p>
    <h3>The pricing arithmetic</h3>
    <div class="arith">
      <div class="row"><span>TVL (snapshot)</span><b>${money(r.tvl_usd)}</b></div>
      <div class="row"><span>Size curve at this TVL — 10^(${R.model.a.toFixed(4)} + ${R.model.b.toFixed(4)} · log<sub>10</sub> TVL)</span><b>${money(r.curve_value_usd)}</b></div>
      ${offsetRow}
      <div class="row total"><span>Implied value</span><b>${money(r.implied_value_usd)}</b></div>
      <div class="row"><span>P25–P75 band (out-of-fold residuals)</span><b>${money(r.band_lo_usd)} – ${money(r.band_hi_usd)}</b></div>
      <div class="row"><span>Effective multiple (implied ÷ TVL)</span><b>×${r.eff_multiple.toFixed(3)}</b></div>
      <div class="row"><span>7-day TVL change</span><b>${pct(r.change_7d)}</b></div>
    </div>
    <h3>Plan economics <span class="chip v-${p.verdict.toLowerCase()}">${esc(p.verdict)}</span></h3>
    <div class="arith">
      <div class="row"><span>Mechanism</span><b>${esc(p.mechanism_label)}</b></div>
      <div class="row"><span>Modeled position (TVL band ${esc(p.band)})</span><b>${money(p.position_usd)}</b></div>
      <div class="row"><span>Window · sessions · modeled time</span><b>${p.weeks} weeks · ${p.sessions} sessions · ${p.hours} hours</b></div>
      <div class="row"><span>Gas — ${p.sessions} sessions at ${money2(p.gas_per_session_cents)}</span><b>${money2(p.gas_total_cents)}</b></div>
      ${p.fee_parts.map((f) => `<div class="row"><span>${esc(f.label)}</span><b>${money2(f.cents)}</b></div>`).join('')}
      <div class="row"><span>Protocol fees, total</span><b>${money2(p.fees_total_cents)}</b></div>
      <div class="row total"><span>Plan cost, all-in</span><b>${money2(p.total_cost_cents)}</b></div>
      <div class="row"><span>Scenario S reward (5% to early users, pool over a farmed 25% of TVL)</span><b>${money2(p.reward_scenario_cents)}</b></div>
      <div class="row total"><span>Net under Scenario S · per hour · break-even share</span><b>${money2(p.net_scenario_cents)} · ${money2(p.net_per_hour_cents)}/h · ${p.break_even_pct > 999 ? '&gt;999' : p.break_even_pct.toFixed(1)}% of the reward</b></div>
      <div class="row"><span>Net as a share of the position, over the window</span><b>${(100 * p.net_scenario_cents / 100 / p.position_usd).toFixed(2)}%</b></div>
      <div class="row"><span>Pure pro-rata bound (pool over all of TVL): reward · net</span><b>${money2(p.reward_pro_rata_cents)} · ${money2(p.net_pro_rata_cents)}</b></div>
    </div>
    <h3>The farm plan</h3>
    <ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  $('#detail').classList.remove('hidden');
}
$('#detail-close').addEventListener('click', () => $('#detail').classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#detail').classList.add('hidden'); });

// ---- already trading ----------------------------------------------------------------
$('#live-body').innerHTML = R.live.map((p) => `<tr>
  <td><span class="pname">${esc(p.name)}</span><span class="slug">${esc(p.slug)}</span></td>
  <td>${esc(p.symbol ?? '—')}</td><td>${esc(p.category ?? '—')}</td>
  <td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td>
  <td class="num">×${p.multiple.toFixed(2)}</td>
  <td class="num ${p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down'}">${pct(p.change_7d)}</td>
</tr>`).join('');

// ---- calibration + decomposition -------------------------------------------------------
$('#cal-table').innerHTML = `<table class="mini"><thead><tr><th>Decile by predicted value</th><th class="num">n</th><th class="num">Mean predicted</th><th class="num">Mean realized</th><th class="num">Ratio</th></tr></thead><tbody>${
  R.calibration.deciles.map((d, i) => `<tr><td>${i + 1}${i === 0 ? ' (lowest)' : i === 9 ? ' (highest)' : ''}</td><td class="num">${d.n}</td><td class="num">${money(d.mean_pred)}</td><td class="num">${money(d.mean_real)}</td><td class="num ${d.mean_pred > d.mean_real ? 'down' : 'up'}">×${(d.mean_pred / d.mean_real).toFixed(2)}</td></tr>`).join('')
}</tbody></table>`;
const factorRows = (rows) => rows.slice().sort((a, b) => b.median_factor - a.median_factor)
  .map((v) => `<tr><td>${esc(v.label)}</td><td class="num">${v.n}</td><td class="num">×${v.median_factor.toFixed(2)}</td></tr>`).join('');
$('#dec-cat').innerHTML = `<table class="mini"><thead><tr><th>Category</th><th class="num">n</th><th class="num">Median factor miss</th></tr></thead><tbody>${factorRows(R.decomposition.by_category)}</tbody></table>`;
$('#dec-band').innerHTML = `<table class="mini"><thead><tr><th>TVL band</th><th class="num">n</th><th class="num">Median factor miss</th></tr></thead><tbody>${factorRows(R.decomposition.by_tvl_band)}</tbody></table>`;
$('#dec-worst').innerHTML = `<table class="mini"><thead><tr><th>Protocol</th><th>Category</th><th class="num">Factor miss</th><th>Priced on</th><th>Cause</th></tr></thead><tbody>${
  R.decomposition.worst.map((w) => `<tr><td>${esc(w.name)}</td><td>${esc(w.category ?? '—')}</td><td class="num">×${w.factor.toFixed(1)}</td><td>${w.level === 'family' ? `family fit (n=${w.level_n})` : 'size curve'}</td><td>${esc(w.cause)}</td></tr>`).join('')
}</tbody></table>`;

// ---- data quality -------------------------------------------------------------------------
{
  const d = R.dq;
  const comp = (f) => d.completeness.find((x) => x.field === f) ?? { nulls: 0, pct: 0 };
  const item = (t) => `<div class="dq-item">${t}</div>`;
  $('#dq-body').innerHTML = [
    item(`<strong>The fit pool.</strong> ${num(d.tokenized)} records carry a market cap. The gate's fit uses ${num(d.fit_pool_n)} of them — positive market cap and positive TVL. Excluded, each under a stated rule: ${num(d.fit_excl_zero)} recording a market cap of exactly $0 (a $0 cap is a reporting state, not a price), ${num(d.fit_excl_negative)} recording a negative cap (a feed error by construction; named: ${esc(d.negative_mcap.map((x) => x.name).join(', ') || 'none')}), and ${num(d.fit_excl_nonpos_tvl)} recording no TVL (a log-space fit cannot place them).`),
    item(`<strong>The board.</strong> ${num(d.records_no_token)} records record no token (market cap, gecko id and symbol all null). Of those, ${num(d.excl_set_aside_total)} sit in the set-aside product categories, ${num(d.excl_versioned)} carry a version suffix (V2, V3…) marking them as deployments of a protocol that already trades, ${num(d.excl_wrapped)} are wrapped or staked forms and ${num(d.excl_exchange)} are exchange-fronted names — leaving the ${num(board.length)} rows on the board. ${num(d.watchlist_on_board)} of the ${num(d.watchlist_total)} watchlist slugs are on it; the rest of the watchlist verification is mechanical: ${num(d.watchlist_in_snapshot)} of ${num(d.watchlist_total)} watchlist slugs exist in the snapshot at all.`),
    item(`<strong>Set aside, by category.</strong> ${esc(d.excl_set_aside.map((x) => `${x.category} ${x.n}`).join(' · ') || 'none')}. The wrapper categories inside that line (Liquid Staking, Liquid Restaking, Restaked BTC) hold ${num(d.wrapper_protocols)} protocols in total, ${num(d.wrapper_no_token)} of them recording no token; ${num(d.wrapper_in_fit)} wrapper protocols do trade and sit inside the fit pool, where the curve prices the category like any other.`),
    item(`<strong>Duplicates and validity.</strong> ${num(d.dup_slugs)} slugs and ${num(d.dup_names)} names appear on more than one record; every record is priced on its own figures and none is merged or dropped. TVL is zero on ${num(d.tvl_zero)} records and negative on ${num(d.tvl_negative)}; neither can enter a log-space fit or the board.`),
    item(`<strong>The IQR band.</strong> The traded multiples' interquartile band, widened by 1.5×IQR, runs from ×${d.band_lo.toFixed(3)} to ×${d.band_hi.toFixed(2)}; ${num(d.band_violations.length)} of the ${num(d.fit_pool_n)} fit-pool protocols sit outside it (largest: ${esc(d.band_violations.slice(0, 4).map((v) => `${v.name} ×${v.multiple.toFixed(1)}`).join(', ') || 'none')}). They are named, never deleted. Refitting the shipped model without them moves the curve's slope from ${d.band_effect.slope_with.toFixed(2)} (shipped) to ${d.band_effect.slope_without.toFixed(2)}; ${num(d.band_effect.board_changed_gt1pct)} of ${num(board.length)} board rows would move by more than 1% (median absolute move ${d.band_effect.median_abs_change_pct.toFixed(1)}%). The board is not adjusted for it; the figure is printed so the sensitivity is on the record.`),
    item(`<strong>Completeness.</strong> The shipped model reads TVL alone; the gate's candidate terms read two more fields. The 7-day TVL change is missing for ${num(comp('change_7d').nulls)} of ${num(d.protocols)} rows (${comp('change_7d').pct.toFixed(1)}%) and listed_at for ${num(comp('listed_at').nulls)} (${comp('listed_at').pct.toFixed(1)}%); category is missing for ${num(comp('category').nulls)} and the chain list is empty for ${num(comp('chains (empty)').nulls)}. The gate scored the growth tilt on the rows carrying a change figure and the age term on the dated rows — the ladder in the validation panel carries their numbers and their rejection. The gaps cost the candidates coverage, not the shipped model.`),
    item(`<strong>Partial-token rows.</strong> ${num(d.partial_token_records)} records carry a token symbol or gecko id but no market cap — per-chain deployments of tokens that trade elsewhere. They enter neither the fit (no cap to fit) nor the board (a token exists), and they are the one class this file sets aside without ranking or pricing.`),
  ].join('');
}

// ---- tabs -------------------------------------------------------------------------------------
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + t.getAttribute('data-view')).classList.remove('hidden');
}));

renderBoard();
