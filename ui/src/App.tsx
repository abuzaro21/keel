// KEEL judge UI. Everything shown is a projection of committed server records streamed over SSE.
import { useEffect, useMemo, useRef, useState } from 'react';

type Truth = 'true' | 'false' | 'unknown';
type Assumption = { kind: 'requires' | 'maintains'; text: string; fact: string; truth: Truth };
type StepV = { id: string; sig: string; action: string; params: Record<string, unknown>; describe: string; commitment: string; duration: number; state: string; startedAt: number | null; assumptions: Assumption[] };
type Check = { id: string; pass: boolean; detail: string };
type Revision = {
  from: number; to: number; because: string; oldAssumption: string | null; newObservation: string | null; observations: string[];
  contradiction: { stepId: string; sig: string; cond: string; truth: string; obligation: string | null }[];
  affected: string[]; preserved: string[]; completed: string[]; removed: string[]; added: string[];
  edit: { inserted: number; removed: number; modified: number; distance: number }; checks: Check[];
  chosen: { origin: string; scope: string; rationale: string; cost: number; model?: { model: string; capturedAt: string; mode: string } };
  rejected: { origin: string; steps: string[]; failed: Check[] }[];
  before: { id: string; action: string; params: Record<string, unknown> }[]; after: { id: string; action: string; params: Record<string, unknown> }[];
};
type Ev = { t: string; [k: string]: any };
type Row = { runId: string; n: number; kind: string; input: boolean; tick: number; wall: number; ev: Ev };
type Metrics = {
  policy: string; status: string; pause: string | null; beliefGoalMet: boolean | null; goalMet: boolean; truth: string; outcomePending: boolean; violations: string[];
  invalidActions: number; prevented: number; fenced: number; revisions: number; preservedCompleted: number; duplicateEffects: number; wastedEffects: number;
  editDistance: number; rejectedObservations: number; staleObservations: number; duplicateObservations: number;
  latency: { eventId: string; ingressToDetectMs: number; ingressToCommitMs: number | null; eventToDetectTicks: number; eventToCommitTicks: number | null }[];
};
type View = {
  runId: string; policy: string; policyLabel: string; status: string; pause: { kind: string; reason: string } | null; tick: number;
  plan: { version: number; steps: StepV[] }; history: { version: number; steps: { id: string; sig: string }[] }[];
  revisions: number; budget: number | null; goal: { statement: string; success: { fact: string; op: string; value?: unknown; ref?: string }[] };
  facts: Record<string, unknown>; unstable: string[]; worldRev: number; metrics: Metrics;
};
type Scenario = { id: string; title: string; blurb: string; goal: string; domain: string; injectable: { source: string; fact: string; values: unknown[] }[]; tickMs: number; sources: { id: string; rank: number; mayAssert: string[] }[] };
type Run = { view: View; rows: Row[] };

const SCENARIO_TABS: { id: string; label: string; sub: string }[] = [
  { id: 'delivery', label: 'Delivery', sub: 'a road closes after packing' },
  { id: 'recovery', label: 'Service recovery', sub: 'the failover target degrades' },
  { id: 'flapping', label: 'Adaptation failure', sub: 'a faulty sensor flaps' },
];

const WATCH: Record<string, string> = {
  delivery: 'around t6 the traffic authority closes route R1 — after the order was picked, packed and loaded. Compare what each lane does next.',
  recovery: 'region-b degrades while the traffic shift to it is already in flight. Only one lane fences that operation before its effect lands.',
  flapping: 'a low-trust sensor flips the roads open/closed and a forged closure arrives from an unregistered source. Adapting to every change is the failure here.',
};

const pretty = (sig: string) => sig.replace(/\(([^)]*)\)/, (_, a: string) => (a ? ` · ${a.split(',').map((x) => x.split('=')[1]).join(' · ')}` : ''));
const short = (fact: string) => fact.replace(/^order:1042\./, 'order.').replace(/^route:/, '').replace(/^svc:/, '');

export function App() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState(() => (location.hash.slice(1) || 'delivery'));
  const [session, setSession] = useState<{ id: string; runIds: string[] } | null>(null);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const onHash = () => { const h = location.hash.slice(1); if (SCENARIO_TABS.some((t) => t.id === h)) setScenario(h); };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { fetch('/api/scenarios').then((r) => r.json()).then(setScenarios).catch(() => setError('Cannot reach the KEEL server.')); }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    setRuns({}); setSession(null); setError(null);
    fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j; })
      .then((j: { sessionId: string; runIds: string[] }) => {
        if (cancelled) return;
        setSession({ id: j.sessionId, runIds: j.runIds });
        es = new EventSource(`/api/sessions/${j.sessionId}/stream`);
        es.onmessage = (m) => {
          const d = JSON.parse(m.data) as { runId: string; rows: Row[]; view: View; tick: number };
          setTick(d.tick);
          setRuns((prev) => {
            const old = prev[d.runId]?.rows ?? [];
            const last = old.at(-1)?.n ?? 0;
            return { ...prev, [d.runId]: { view: d.view, rows: [...old, ...d.rows.filter((r) => r.n > last)] } };
          });
        };
        es.onerror = () => { if (es?.readyState === EventSource.CLOSED) setError('Stream closed. The demo host may have restarted — start a new run.'); };
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    location.hash = scenario;
    return () => { cancelled = true; es?.close(); };
  }, [scenario, nonce]);

  const sc = scenarios.find((s) => s.id === scenario);
  const ordered = session?.runIds.map((id) => runs[id]).filter((r): r is Run => !!r) ?? [];
  const keel = ordered.find((r) => r.view.policy === 'keel');
  const post = async (path: string, body: unknown) => {
    if (!session) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/sessions/${session.id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) setError((await r.json()).error ?? 'request failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <div>
            <h1>KEEL</h1>
            <p className="tag">The plan can change. The goal stays.</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Scenario">
          {SCENARIO_TABS.map((t) => (
            <button key={t.id} className={t.id === scenario ? 'tab on' : 'tab'} aria-pressed={t.id === scenario} onClick={() => (t.id === scenario ? setNonce((n) => n + 1) : setScenario(t.id))}>
              <span>{t.label}</span><small>{t.sub}</small>
            </button>
          ))}
        </nav>
        <div className="sim" title="Every road, truck, region, sensor and customer here is simulated. No real system is touched.">SIMULATED WORLD · t{tick}</div>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      <section className="intro" aria-label="What you are watching">
        <p className="thesis">Two agents get the same goal, the same plan and the same simulated world. Mid-run, reality changes.</p>
        <ol className="beats">
          <li><b>Assumptions are data.</b> Every step declares what must be true for it to work; KEEL re-checks them on every material event — never on a timer.</li>
          <li><b>Finished work stays finished.</b> Steps with receipts are kept; only the broken part of the plan is repaired, and every repair must pass an independent checker.</li>
          <li><b>When it can’t be sure, it stops.</b> Forged, out-of-order or flapping evidence is refused or held as UNKNOWN until an operator confirms.</li>
        </ol>
        <p className="watch"><span className="eyebrow">Watch for</span>{WATCH[scenario] ?? ''}</p>
      </section>

      {sc && keel && (
        <section className="goal" aria-label="Goal">
          <div>
            <span className="eyebrow">Goal · {sc.domain}</span>
            <p className="goal-text">{keel.view.goal.statement}</p>
            <p className="blurb">{sc.blurb}</p>
          </div>
          <ul className="preds" aria-label="Checked goal conditions">
            {keel.view.goal.success.map((g, i) => <li key={i}><code>{short(g.fact)} {g.op} {g.ref ? short(g.ref) : JSON.stringify(g.value)}</code></li>)}
          </ul>
        </section>
      )}

      <main className={`lanes n${ordered.length}`}>
        {ordered.map((r) => <Lane key={r.view.runId} run={r} tickMs={sc?.tickMs ?? 900} tick={tick} onOperator={(body) => post('operator', { runId: r.view.runId, ...body })} onCrash={() => post('crash', { runId: r.view.runId })} busy={busy} />)}
      </main>

      {ordered.length > 0 && <Feed runs={ordered} />}

      {sc && session && (
        <section className="inject" aria-label="Change the simulated world">
          <h2>Change reality <small>changes the simulated world for both agents; its registered source reports it to both at the same tick</small></h2>
          <div className="inject-row">
            {sc.injectable.flatMap((x) => x.values.map((v) => (
              <button key={`${x.fact}=${v}`} disabled={busy} onClick={() => post('inject', { fact: x.fact, value: v })}>
                <code>{short(x.fact)} = {String(v)}</code><small>{x.source}</small>
              </button>
            )))}
            {sc.injectable[0] && (
              <button className="forge" disabled={busy} onClick={() => post('inject', { fact: sc.injectable[0].fact, value: sc.injectable[0].values[1], forged: true })}>
                <code>forge: {short(sc.injectable[0].fact)} = {String(sc.injectable[0].values[1])}</code><small>fake observation · changes nothing real</small>
              </button>
            )}
          </div>
        </section>
      )}

      {ordered.length > 1 && <Scorecard runs={ordered} />}

      {ordered.length > 0 && <Trace runs={ordered} sessionId={session?.id ?? ''} />}

      <footer className="foot">
        <p>All external systems are <strong>simulated</strong>. Observation sources are signed with simulation-only keys held by the server; the browser can only request the events listed above. Decisions, receipts and every number on this page come from the persisted event log.</p>
      </footer>
    </div>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M7 19 H57" className="old" />
      <path d="M7 19 H27 L47 9 H55" className="new" />
      <path d="M51 5 L57 9 L51 13" className="new" />
      <path d="M5 28 H59" className="water" />
      <path d="M24 28 H40 L34.5 55 Q32 58 29.5 55 Z" className="fin" />
    </svg>
  );
}

function Lane({ run, tickMs, tick, onOperator, onCrash, busy }: { run: Run; tickMs: number; tick: number; onOperator: (b: Record<string, unknown>) => void; onCrash: () => void; busy: boolean }) {
  const v = run.view;
  const revs = run.rows.filter((r) => r.kind === 'revision').map((r) => r.ev.record as Revision);
  const last = revs.at(-1);
  const fenced = new Set(run.rows.filter((r) => r.kind === 'fenced').map((r) => r.ev.stepId as string));
  const completed = run.rows.find((r) => r.kind === 'completed');
  const adaptive = v.policy !== 'static';
  const items = useMemo(() => diffSteps(v.plan.steps, last), [v.plan.steps, last]);
  const status = v.status === 'paused' ? 'paused' : v.status === 'completed' ? 'done' : v.status === 'repairing' ? 'repairing' : 'running';
  const m = v.metrics;
  const finished = v.status === 'completed' || (v.status === 'paused' && !v.plan.steps.some((s) => s.state === 'prepared' || s.state === 'committing'));
  return (
    <article className={`lane ${v.policy}`} aria-label={v.policyLabel}>
      <header className="lane-head">
        <div>
          <h2>{v.policyLabel}</h2>
          <p className="lane-sub">{v.policy === 'static' ? 'Open loop: follows the original plan, never re-checks assumptions' : v.policy === 'naive' ? 'Replans on every change, cheapest plan first, no stability rules' : 'Re-checks assumptions on every material event; repairs only the broken part'}</p>
        </div>
        <div className="lane-meta">
          <span className={`pill ${status}`}>{status}</span>
          <span className="ver">plan v{v.plan.version}</span>
        </div>
      </header>

      <ol className="steps">
        {items.map((it) => <StepCard key={it.key} it={it} tickMs={tickMs} tick={tick} fenced={fenced} />)}
      </ol>

      {v.pause && <PauseCard pause={v.pause} unstable={v.unstable} facts={v.facts} onOperator={onOperator} busy={busy} />}

      {last && adaptive && <ReasonCard rev={last} count={revs.length} />}

      {finished && (
        <div className={`outcome ${m.outcomePending || (v.status === 'paused' && !m.invalidActions) ? 'wait' : m.goalMet ? 'ok' : 'bad'}`} aria-live="polite">
          <div><span className="eyebrow">Agent believes</span><strong>{m.beliefGoalMet === null ? (v.status === 'paused' ? 'paused — goal not reached yet; waiting for an operator' : v.status === 'stopped' ? 'stopped — goal not reached' : '—') : m.beliefGoalMet ? '✓ goal met' : '✗ goal not met'}</strong></div>
          <div><span className="eyebrow">Simulated world</span><strong>{m.outcomePending ? '… ' : m.goalMet ? '✓ ' : '✗ '}{m.truth}</strong></div>
          {m.violations.length > 0 && <div><span className="eyebrow">Known violation</span><span>{m.violations.join('; ')}</span></div>}
          {completed && m.beliefGoalMet && !m.goalMet && !m.outcomePending && <p className="silent">Silent failure: every step has a receipt, the agent reports success, and the world disagrees.</p>}
          {completed && m.beliefGoalMet === false && m.invalidActions > 0 && <p className="silent">Too late: every irreversible step ran on the original plan; the agent learned it had failed only afterwards.</p>}
        </div>
      )}

      {adaptive && v.policy === 'keel' && (
        <button className="crash" disabled={busy || v.status === 'completed'} onClick={onCrash} title="Drops every piece of in-memory agent state and agent timers for this run, then rebuilds the agent from the persisted event log.">
          Crash the agent <small>rebuild from the log</small>
        </button>
      )}
    </article>
  );
}

type Item = { key: string; step: StepV | null; sig: string; tag: 'kept' | 'added' | 'removed' };
function diffSteps(steps: StepV[], last: Revision | undefined): Item[] {
  if (!last) return steps.map((s) => ({ key: s.id, step: s, sig: s.sig, tag: 'kept' }));
  const added = new Set(last.added);
  const out: Item[] = [];
  let removedShown = false;
  for (const s of steps) {
    if (added.has(s.sig) && !removedShown) {
      removedShown = true;
      last.removed.forEach((sig, i) => out.push({ key: `rm-${i}-${sig}`, step: null, sig, tag: 'removed' }));
    }
    out.push({ key: s.id, step: s, sig: s.sig, tag: added.has(s.sig) ? 'added' : 'kept' });
  }
  if (!removedShown) last.removed.forEach((sig, i) => out.push({ key: `rm-${i}-${sig}`, step: null, sig, tag: 'removed' }));
  return out;
}

function StepCard({ it, tickMs, tick, fenced }: { it: Item; tickMs: number; tick: number; fenced: Set<string> }) {
  if (!it.step) {
    return (
      <li className="step removed" aria-label={`removed: ${it.sig}`}>
        <span className="ico" aria-hidden="true">✕</span>
        <div className="body"><span className="name">{pretty(it.sig)}</span><span className="badge rm">dropped in repair</span></div>
      </li>
    );
  }
  const s = it.step;
  const st = s.state === 'done' ? 'done' : s.state === 'prepared' ? 'prep' : s.state === 'committing' ? 'commit' : 'todo';
  const progress = s.state === 'prepared' && s.startedAt !== null ? Math.min(1, (tick - s.startedAt) / Math.max(1, s.duration)) : 0;
  return (
    <li className={`step ${st} ${it.tag}`}>
      <span className="ico" aria-hidden="true">{st === 'done' ? '✓' : st === 'prep' || st === 'commit' ? '◐' : '○'}</span>
      <div className="body">
        <div className="line">
          <span className="name">{pretty(s.sig)}</span>
          {s.commitment === 'irreversible' && <span className="badge lock" title="Irreversible once it happens">irreversible</span>}
          {it.tag === 'added' && <span className="badge add">added in repair</span>}
          {fenced.has(s.id) && st !== 'done' && <span className="badge fence">fenced once</span>}
          <span className="state">{st === 'done' ? 'receipt' : st === 'prep' ? 'preparing' : st === 'commit' ? 'applying' : 'pending'}</span>
        </div>
        {st === 'prep' && <div className="bar" aria-hidden="true"><i style={{ width: `${Math.round(progress * 100)}%`, transitionDuration: `${tickMs}ms` }} /></div>}
        {st !== 'done' && s.assumptions.length > 0 && (
          <ul className="assume" aria-label="Assumptions">
            {s.assumptions.map((a, i) => (
              <li key={i} className={`chip ${a.truth}`} title={`${a.kind === 'maintains' ? 'Must keep holding after this step' : 'Must hold when this step starts'}: ${a.text} — ${a.truth}`}>
                <span aria-hidden="true">{a.truth === 'true' ? '✓' : a.truth === 'false' ? '✗' : '?'}</span>{a.kind === 'maintains' && <em>keeps</em>}{short(a.text)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function ReasonCard({ rev, count }: { rev: Revision; count: number }) {
  const model = rev.chosen.model;
  return (
    <section className="reason" aria-live="polite" aria-label="Why the plan changed">
      <header><span className="eyebrow">Revision v{rev.from} → v{rev.to}{count > 1 ? ` · ${count} revisions` : ''}</span></header>
      <p className="because">{rev.because}</p>
      <dl className="chain">
        <div><dt>New observation</dt><dd>{rev.newObservation ?? '—'}</dd></div>
        <div><dt>Broken assumption</dt><dd>{rev.contradiction[0] ? <><code>{rev.contradiction[0].cond}</code>{rev.contradiction[0].obligation ? ` (commitment of ${pretty(rev.contradiction[0].obligation)})` : ` (needed by ${pretty(rev.contradiction[0].sig)})`}</> : '—'}</dd></div>
        <div><dt>Kept (receipts)</dt><dd>{rev.completed.length ? `${rev.completed.length} completed step${rev.completed.length > 1 ? 's' : ''} carried over unchanged` : 'none yet'}</dd></div>
        <div><dt>Changed</dt><dd>{rev.removed.map(pretty).join(', ') || '—'} <span className="arrow">→</span> {rev.added.map(pretty).join(', ') || '—'}</dd></div>
        <div><dt>Edit</dt><dd>{rev.edit.distance} ({rev.edit.modified} rebound, {rev.edit.inserted} inserted, {rev.edit.removed} removed)</dd></div>
        <div><dt>Safety checks</dt><dd className="checks">{rev.checks.map((c) => <span key={c.id} className={c.pass ? 'pass' : 'fail'} title={c.detail}>{c.pass ? '✓' : '✗'} {c.id}</span>)}</dd></div>
        <div><dt>Proposed by</dt><dd>{model ? <>recorded model output · {model.model} · captured {model.capturedAt.slice(0, 10)} · <strong>validated now</strong></> : rev.chosen.origin.startsWith('search') ? <>deterministic search · {rev.chosen.rationale}</> : rev.chosen.origin}{rev.rejected.length > 0 && <> · {rev.rejected.length} candidate{rev.rejected.length > 1 ? 's' : ''} rejected</>}</dd></div>
      </dl>
      {rev.rejected.length > 0 && (
        <details className="rejected">
          <summary>Rejected candidates</summary>
          <ul>{rev.rejected.map((r, i) => <li key={i}><code>{r.steps.map(pretty).join(' → ')}</code> <span className="why">{r.origin}: {r.failed[0]?.detail}</span></li>)}</ul>
        </details>
      )}
    </section>
  );
}

function PauseCard({ pause, unstable, facts, onOperator, busy }: { pause: { kind: string; reason: string }; unstable: string[]; facts: Record<string, unknown>; onOperator: (b: Record<string, unknown>) => void; busy: boolean }) {
  return (
    <section className="pause" role="status" aria-label="Paused">
      <span className="eyebrow">Paused · {pause.kind.replace('_', ' ')}</span>
      <p>{pause.reason}</p>
      <div className="ops">
        {unstable.map((f) => (
          <button key={f} disabled={busy} onClick={() => onOperator({ cmd: 'confirm', fact: f, value: facts[f] })} title="Operator confirms the latest reported value; instability is cleared for this fact only">
            Confirm <code>{short(f)} = {String(facts[f])}</code>
          </button>
        ))}
        <button disabled={busy} onClick={() => onOperator({ cmd: 'resume' })}>Resume</button>
        <button disabled={busy} className="ghost" onClick={() => onOperator({ cmd: 'abort' })}>Stop run</button>
      </div>
    </section>
  );
}

function Feed({ runs }: { runs: Run[] }) {
  const keel = runs.find((r) => r.view.policy === 'keel') ?? runs[0];
  const rows = keel.rows;
  const items = rows.filter((r) => r.kind === 'verdict').map((r) => {
    const after = rows.slice(rows.indexOf(r) + 1, rows.indexOf(r) + 6);
    const contra = after.find((x) => x.kind === 'contradiction' && x.ev.trigger?.eventId === r.ev.obs.eventId);
    const assessed = after.find((x) => x.kind === 'assessed');
    return { r, contra, assessed };
  }).reverse();
  return (
    <section className="feed" aria-label="Observation stream">
      <h2>Observation stream <small>what the sources reported, and what KEEL made of it</small></h2>
      {items.length === 0 && <p className="empty">No observations yet. The plan is running on its original assumptions.</p>}
      <ol>
        {items.map(({ r, contra, assessed }) => {
          const o = r.ev.obs, v = r.ev.v;
          const cls = v.kind !== 'applied' ? v.kind : contra ? 'material' : 'calm';
          return (
            <li key={r.n} className={`obs ${cls}`}>
              <span className="t">t{o.observedAt}</span>
              <span className="src">{o.source}</span>
              <code>{short(o.fact)} = {JSON.stringify(o.value)}</code>
              <span className="verdict">
                {v.kind === 'applied' ? (contra ? 'REALITY CHANGED — assumption broken' : v.becameUnstable ? 'accepted · now UNSTABLE' : assessed?.ev.result === 'no_impact' ? 'accepted · no impact on the plan' : v.changed ? 'accepted · plan still valid' : 'accepted · no change') : v.kind === 'duplicate' ? 'duplicate delivery · ignored' : `${v.kind} · ${v.reason}`}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Scorecard({ runs }: { runs: Run[] }) {
  const ms = runs.map((r) => r.view.metrics);
  const lat = (m: Metrics) => {
    const l = m.latency.find((x) => x.eventToCommitTicks !== null) ?? m.latency[0];
    if (!l) return '—';
    return `detected ${l.eventToDetectTicks} tick${l.eventToDetectTicks === 1 ? '' : 's'} after the event · ${l.eventToCommitTicks === null ? 'no revision' : `revised ${l.eventToCommitTicks} tick${l.eventToCommitTicks === 1 ? '' : 's'} after (${Math.round(l.ingressToCommitMs ?? 0)} ms)`}`;
  };
  const rowsDef: [string, (m: Metrics) => string, string][] = [
    ['Goal met (simulated truth)', (m) => (m.goalMet ? '✓ yes' : '✗ no'), 'Judged on the simulated world, not on the agent’s report'],
    ['Agent reported success', (m) => (m.beliefGoalMet === null ? '—' : m.beliefGoalMet ? 'yes' : 'no'), ''],
    ['Harmful actions executed', (m) => String(m.invalidActions), 'Effects the simulator recorded as harmful'],
    ['Broken steps caught before running', (m) => String(m.prevented), ''],
    ['Operations fenced before their effect', (m) => String(m.fenced), ''],
    ['Plan revisions', (m) => String(m.revisions), ''],
    ['Completed steps preserved', (m) => String(m.preservedCompleted), 'Receipts carried unchanged into the latest revision'],
    ['Duplicate effects', (m) => String(m.duplicateEffects), ''],
    ['Plan edit distance', (m) => String(m.editDistance), 'Levenshtein over step signatures, summed over revisions'],
    ['Rejected / stale / duplicate events', (m) => `${m.rejectedObservations} / ${m.staleObservations} / ${m.duplicateObservations}`, ''],
    ['Adaptation latency', lat, 'From the event: ticks of simulated world time to detection; wall-clock ms from ingress to committed revision'],
  ];
  return (
    <section className="score" aria-label="Side-by-side comparison">
      <h2>Same world, same events <small>every number recomputed from the event log</small></h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Metric</th>{runs.map((r) => <th scope="col" key={r.view.runId}>{r.view.policyLabel}</th>)}</tr></thead>
          <tbody>{rowsDef.map(([k, f, hint]) => <tr key={k}><th scope="row" title={hint}>{k}</th>{ms.map((m, i) => <td key={i}>{f(m)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function Trace({ runs, sessionId }: { runs: Run[]; sessionId: string }) {
  const [which, setWhich] = useState(runs.findIndex((r) => r.view.policy === 'keel'));
  const r = runs[Math.max(0, which)];
  const ref = useRef<HTMLPreElement>(null);
  return (
    <details className="trace">
      <summary>Persistent audit trace <small>raw event log · {r.rows.length} records</small></summary>
      <div className="trace-bar">
        {runs.map((x, i) => <button key={x.view.runId} className={i === which ? 'on' : ''} onClick={() => setWhich(i)}>{x.view.policyLabel}</button>)}
        <a href={`/api/sessions/${sessionId}/export`} target="_blank" rel="noreferrer">Export JSON</a>
      </div>
      <pre ref={ref}>{r.rows.map((x) => `#${x.n} t${x.tick} ${x.input ? 'IN ' : '   '}${x.kind.padEnd(18)} ${summary(x.ev)}`).join('\n')}</pre>
    </details>
  );
}

function summary(e: Ev): string {
  switch (e.t) {
    case 'observation': return `${e.obs.source} ${e.obs.fact}=${JSON.stringify(e.obs.value)} (${e.obs.eventId})`;
    case 'verdict': return `${e.v.kind}${e.v.reason ? ` · ${e.v.reason}` : ''}`;
    case 'dispatch': return `${e.action} ${JSON.stringify(e.params)} op=${e.opId} gen=${e.gen}`;
    case 'commit_effect': case 'effect_ready': case 'reconcile_requested': return `op=${e.opId} gen=${e.gen}`;
    case 'receipt': return `op=${e.opId} gen=${e.gen} ${e.detail}`;
    case 'contradiction': return e.failures.map((f: { sig: string; cond: string }) => `${f.sig} needs ${f.cond}`).join('; ');
    case 'revision': return `v${e.record.from}→v${e.record.to} ${e.record.because}`;
    case 'planner_output': return `${e.candidates.length} candidates`;
    case 'repair_requested': return `rev ${e.basedOnRev} plan v${e.planVersion}`;
    default: return e.reason ?? e.detail ?? e.by ?? '';
  }
}
