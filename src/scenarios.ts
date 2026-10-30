// Scenario data. Two domains, three scenarios. The engine never branches on a scenario id:
// a scenario is action contracts + initial beliefs + a world-time event feed + SIMULATED physics.
import { createHash } from 'node:crypto';
import type { Domain, Facts, Goal, Json, Params, Step } from './model.ts';
import type { Enums, Source } from './world.ts';

/** One tick of the simulated clock = 10 simulated minutes. */
export const TICK_MIN = 10;

export type SimEffect = { action: string; params: Params; tick: number; harm: string | null };
/** What really happens in the SIMULATED world when an action runs (the agent never reads this). */
export type Physics = Record<string, (p: Params, truth: Facts) => { set?: Facts; harm?: string }>;
export type FeedItem = { tick: number; source: string; fact: string; value: Json; seq?: number; forged?: boolean; replayOf?: number };
export type Scenario = {
  id: string; title: string; blurb: string;
  domain: Domain; goal: Goal; facts: Facts; plan: Step[];
  sources: Record<string, Source>;
  /** Ground-truth changes in world time. Identical for every agent policy. */
  truth: { tick: number; fact: string; value: Json }[];
  /** What observation sources report, in world time. Identical for every agent policy. */
  feed: FeedItem[];
  physics: Physics;
  /** Allowed values of enumerated facts; observations with any other value are rejected. */
  enums: Enums;
  /** Ground-truth success, judged only on the simulated world up to `endTick` (never on future events). */
  outcome(truthAt: (tick: number) => Facts, effects: SimEffect[], endTick: number): { met: boolean; detail: string; pending?: boolean };
  /** World time by which the outcome of the applied effects is decided (e.g. the truck's arrival). */
  settle?(truthAt: (tick: number) => Facts, effects: SimEffect[]): number;
};

const PERMIT_OK = ['none', 'granted'];

const keys = (f: Facts, re: RegExp) => Object.keys(f).map((k) => re.exec(k)?.[1]).filter((x): x is string => !!x);

// ---------------------------------------------------------------- logistics
const logistics: Domain = {
  name: 'Cold-chain fulfilment',
  domains: {
    order: () => ['1042'],
    truck: (f) => keys(f, /^truck:(\w+)\.status$/),
    route: (f) => keys(f, /^route:(\w+)\.status$/),
  },
  actions: {
    pick: {
      type: 'pick', describe: 'Pick the order items from the cold store.', params: { order: 'order' },
      commitment: 'reversible', duration: 2, cost: () => 1,
      requires: (p) => [{ fact: `order:${p.order}.stock`, op: 'eq', value: 'available' }],
      produces: (p) => ({ [`order:${p.order}.picked`]: true }),
      effectKey: (p) => `pick:${p.order}`,
    },
    pack: {
      type: 'pack', describe: 'Seal the order into an insulated cold box (holds temperature for coldHoldMin minutes).', params: { order: 'order' },
      commitment: 'irreversible', duration: 3, cost: () => 2,
      requires: (p) => [{ fact: `order:${p.order}.picked`, op: 'eq', value: true }],
      produces: (p) => ({ [`order:${p.order}.packed`]: true }),
      effectKey: (p) => `pack:${p.order}`,
    },
    load: {
      type: 'load', describe: 'Load the packed order onto a truck.', params: { order: 'order', truck: 'truck' },
      commitment: 'reversible', duration: 2, cost: () => 1,
      requires: (p) => [
        { fact: `order:${p.order}.packed`, op: 'eq', value: true },
        { fact: `truck:${p.truck}.status`, op: 'eq', value: 'available' },
      ],
      produces: (p) => ({ [`order:${p.order}.loadedOn`]: p.truck, [`truck:${p.truck}.status`]: 'loaded' }),
      effectKey: (p) => `load:${p.order}`,
    },
    label: {
      type: 'label', describe: 'Print the routing label for a route onto the box.', params: { order: 'order', route: 'route' },
      commitment: 'reversible', duration: 1, cost: () => 1,
      requires: (p) => [{ fact: `order:${p.order}.packed`, op: 'eq', value: true }],
      produces: (p) => ({ [`order:${p.order}.labelRoute`]: p.route }),
      effectKey: (p) => `label:${p.order}:${p.route}`,
    },
    request_permit: {
      type: 'request_permit', describe: 'Obtain a cold-chain transit permit for a route that requires one.', params: { route: 'route' },
      commitment: 'reversible', duration: 2, cost: () => 3,
      requires: (p) => [
        { fact: `route:${p.route}.permit`, op: 'eq', value: 'required' },
        { fact: 'permit-office:main.status', op: 'eq', value: 'open' },
      ],
      produces: (p) => ({ [`route:${p.route}.permit`]: 'granted' }),
      effectKey: (p) => `permit:${p.route}`,
    },
    dispatch: {
      type: 'dispatch', describe: 'Send the loaded truck on a route. Irreversible once the truck leaves; the route must stay open in transit.', params: { order: 'order', truck: 'truck', route: 'route' },
      commitment: 'irreversible', duration: 1, cost: (p, f) => Number(f[`route:${p.route}.etaMin`] ?? 999),
      requires: (p) => [
        { fact: `order:${p.order}.loadedOn`, op: 'eq', value: p.truck },
        { fact: `order:${p.order}.labelRoute`, op: 'eq', value: p.route },
        { fact: `route:${p.route}.status`, op: 'eq', value: 'open' },
        { fact: `route:${p.route}.permit`, op: 'in', value: PERMIT_OK },
        { fact: `route:${p.route}.etaMin`, op: 'lte', ref: `order:${p.order}.slaMin` },
        { fact: `route:${p.route}.etaMin`, op: 'lte', ref: `order:${p.order}.coldHoldMin` },
      ],
      maintains: (p) => [{ fact: `route:${p.route}.status`, op: 'eq', value: 'open' }],
      produces: (p, f) => ({ [`order:${p.order}.dispatchedVia`]: p.route, [`order:${p.order}.etaMin`]: f[`route:${p.route}.etaMin`] ?? null, [`truck:${p.truck}.status`]: 'en-route' }),
      effectKey: (p) => `dispatch:${p.order}`,
    },
    notify: {
      type: 'notify', describe: 'Tell the customer the delivery is on its way and on time. Cannot be unsent.', params: { order: 'order' },
      commitment: 'irreversible', duration: 1, cost: () => 0,
      requires: (p) => [{ fact: `order:${p.order}.dispatchedVia`, op: 'neq', value: 'none' }],
      produces: (p) => ({ [`order:${p.order}.customerNotified`]: true }),
      effectKey: (p) => `notify:${p.order}`,
    },
  },
};

const logisticsFacts: Facts = {
  'order:1042.stock': 'available', 'order:1042.picked': false, 'order:1042.packed': false,
  'order:1042.loadedOn': 'none', 'order:1042.labelRoute': 'none', 'order:1042.dispatchedVia': 'none', 'order:1042.customerNotified': false,
  'order:1042.etaMin': 0, 'order:1042.slaMin': 70, 'order:1042.coldHoldMin': 90,
  'truck:T1.status': 'available', 'permit-office:main.status': 'open', 'weather:depot.tempC': 24,
  'route:R1.status': 'open', 'route:R1.etaMin': 40, 'route:R1.permit': 'none',
  'route:R2.status': 'open', 'route:R2.etaMin': 55, 'route:R2.permit': 'required',
  'route:R3.status': 'open', 'route:R3.etaMin': 95, 'route:R3.permit': 'none',
};

const logisticsPlan: Step[] = [
  { id: 's1', action: 'pick', params: { order: '1042' } },
  { id: 's2', action: 'pack', params: { order: '1042' } },
  { id: 's3', action: 'load', params: { order: '1042', truck: 'T1' } },
  { id: 's4', action: 'label', params: { order: '1042', route: 'R1' } },
  { id: 's5', action: 'dispatch', params: { order: '1042', truck: 'T1', route: 'R1' } },
  { id: 's6', action: 'notify', params: { order: '1042' } },
];

const logisticsGoal: Goal = {
  statement: 'Dispatch cold-chain order #1042 on an open route whose ETA fits its 70-min SLA and 90-min cold-hold, then notify the customer.',
  success: [
    { fact: 'order:1042.dispatchedVia', op: 'neq', value: 'none' },
    { fact: 'order:1042.etaMin', op: 'lte', ref: 'order:1042.slaMin' },
    { fact: 'order:1042.etaMin', op: 'lte', ref: 'order:1042.coldHoldMin' },
    { fact: 'order:1042.customerNotified', op: 'eq', value: true },
  ],
};

const logisticsPhysics: Physics = {
  dispatch: (p, t) => t[`route:${p.route}.status`] !== 'open'
    ? { harm: `truck ${p.truck} dispatched onto closed route ${p.route}: stuck at the closure` }
    : !PERMIT_OK.includes(t[`route:${p.route}.permit`] as string)
      ? { harm: `truck ${p.truck} dispatched onto ${p.route} without a valid permit (${t[`route:${p.route}.permit`]}): turned back at the checkpoint` }
      : {},
};

const arrival = (truthAt: (tick: number) => Facts, d: SimEffect) => d.tick + Math.ceil(Number(truthAt(d.tick)[`route:${d.params.route}.etaMin`]) / TICK_MIN);

function logisticsOutcome(truthAt: (tick: number) => Facts, effects: SimEffect[], endTick: number) {
  const d = effects.find((e) => e.action === 'dispatch');
  const told = effects.some((e) => e.action === 'notify');
  const lie = told ? '; the customer was told it was on time' : '';
  if (!d) return { met: false, detail: `order #1042 never left the depot${lie}` };
  if (d.harm) return { met: false, detail: d.harm + lie };
  const route = String(d.params.route);
  const t0 = truthAt(d.tick);
  const eta = Number(t0[`route:${route}.etaMin`]);
  const arrives = arrival(truthAt, d);
  for (let t = d.tick; t <= Math.min(arrives, endTick); t++) {
    if (truthAt(t)[`route:${route}.status`] !== 'open') return { met: false, detail: `route ${route} closed at t${t} while truck T1 was in transit: stuck, cold box at risk${lie}` };
  }
  if (endTick < arrives) return { met: false, pending: true, detail: `truck T1 in transit on ${route}, due at t${arrives}` };
  if (eta > Number(t0['order:1042.slaMin']) || eta > Number(t0['order:1042.coldHoldMin'])) return { met: false, detail: `route ${route} takes ${eta} min: SLA or cold-hold broken${lie}` };
  if (!told) return { met: false, detail: 'delivered, but the customer was never notified' };
  return { met: true, detail: `order #1042 delivered via ${route} in ${eta} min (SLA 70, cold-hold 90)` };
}

const logisticsEnums: Enums = { 'route:*.status': ['open', 'closed'], 'route:*.permit': ['none', 'required', 'granted', 'revoked'] };
const logisticsSettle = (truthAt: (tick: number) => Facts, effects: SimEffect[]) => {
  const d = effects.find((e) => e.action === 'dispatch' && !e.harm);
  return d ? arrival(truthAt, d) : 0;
};

// Simulation-only HMAC keys; every source in the demo is labelled SIMULATED.
const logisticsSources: Record<string, Source> = {
  'traffic-authority': { id: 'traffic-authority', key: 'sim-key-traffic-authority', mayAssert: ['route:*.status', 'route:*.permit'], rank: 2 },
  'road-sensor-7': { id: 'road-sensor-7', key: 'sim-key-road-sensor-7', mayAssert: ['route:*.status'], rank: 1 },
  'weather-feed': { id: 'weather-feed', key: 'sim-key-weather', mayAssert: ['weather:*.tempC'], rank: 1 },
};

// ---------------------------------------------------------------- service recovery
const ops: Domain = {
  name: 'Service recovery',
  domains: { region: (f) => keys(f, /^svc:([\w-]+)\.status$/).filter((r) => r !== 'region-a') },
  actions: {
    snapshot_db: {
      type: 'snapshot_db', describe: 'Take a consistent snapshot of the orders database.', params: {},
      commitment: 'reversible', duration: 2, cost: () => 1,
      requires: () => [],
      produces: () => ({ 'db.snapshot': true }),
      effectKey: () => 'snapshot_db',
    },
    shed_noncritical: {
      type: 'shed_noncritical', describe: 'Temporarily shed non-critical traffic (recommendations, analytics); critical checkout traffic stays.', params: {},
      commitment: 'reversible', duration: 1, cost: () => 5,
      requires: () => [{ fact: 'traffic.criticalRps', op: 'gt', value: 0 }, { fact: 'traffic.shedding', op: 'eq', value: false }],
      produces: (_p, f) => ({ 'traffic.rps': f['traffic.criticalRps'] ?? null, 'traffic.shedding': true }),
      effectKey: () => 'shed_noncritical',
    },
    shift_traffic: {
      type: 'shift_traffic', describe: 'Move all live traffic off region-a to another region. That region must stay healthy with enough headroom while it serves.', params: { to: 'region' },
      commitment: 'reversible', duration: 2, cost: () => 2,
      requires: (p) => [
        { fact: 'db.snapshot', op: 'eq', value: true },
        { fact: `svc:${p.to}.status`, op: 'eq', value: 'healthy' },
        { fact: `svc:${p.to}.headroomRps`, op: 'gte', ref: 'traffic.rps' },
      ],
      maintains: (p) => [
        { fact: `svc:${p.to}.status`, op: 'eq', value: 'healthy' },
        { fact: `svc:${p.to}.headroomRps`, op: 'gte', ref: 'traffic.rps' },
      ],
      releases: ['shift_traffic'],
      produces: (p) => ({ 'traffic.servedBy': p.to }),
      effectKey: (p) => `shift_traffic:${p.to}`,
    },
    restart_region_a: {
      type: 'restart_region_a', describe: 'Restart region-a (drops its in-memory state). Only safe once drained.', params: {},
      commitment: 'irreversible', duration: 3, cost: () => 3,
      requires: () => [{ fact: 'traffic.servedBy', op: 'neq', value: 'region-a' }],
      produces: () => ({ 'svc:region-a.status': 'healthy' }),
      effectKey: () => 'restart_region_a',
    },
    restore_traffic: {
      type: 'restore_traffic', describe: 'Move traffic back to the recovered region-a.', params: {},
      commitment: 'reversible', duration: 2, cost: () => 1,
      requires: () => [{ fact: 'svc:region-a.status', op: 'eq', value: 'healthy' }],
      releases: ['shift_traffic'],
      produces: () => ({ 'traffic.servedBy': 'region-a' }),
      effectKey: () => 'restore_traffic',
    },
    resume_noncritical: {
      type: 'resume_noncritical', describe: 'Bring shed non-critical traffic back once region-a serves again.', params: {},
      commitment: 'reversible', duration: 1, cost: () => 1,
      requires: () => [
        { fact: 'traffic.shedding', op: 'eq', value: true },
        { fact: 'traffic.servedBy', op: 'eq', value: 'region-a' },
        { fact: 'svc:region-a.status', op: 'eq', value: 'healthy' },
      ],
      produces: (_p, f) => ({ 'traffic.shedding': false, 'traffic.rps': f['traffic.fullRps'] ?? null }),
      effectKey: () => 'resume_noncritical',
    },
  },
};

const opsFacts: Facts = {
  'svc:region-a.status': 'degraded', 'traffic.servedBy': 'region-a',
  'traffic.rps': 1000, 'traffic.fullRps': 1000, 'traffic.criticalRps': 450, 'traffic.shedding': false, 'db.snapshot': false,
  'svc:region-b.status': 'healthy', 'svc:region-b.headroomRps': 1400,
  'svc:region-c.status': 'healthy', 'svc:region-c.headroomRps': 600,
  'ticket:INC-7.note': '',
};

const opsPhysics: Physics = {
  shed_noncritical: (_p, t) => ({ set: { 'traffic.rps': t['traffic.criticalRps'], 'traffic.shedding': true } }),
  shift_traffic: (p, t) => t[`svc:${p.to}.status`] !== 'healthy' || Number(t[`svc:${p.to}.headroomRps`]) < Number(t['traffic.rps'])
    ? { set: { 'traffic.servedBy': p.to }, harm: `traffic moved onto ${p.to}, which was ${t[`svc:${p.to}.status`]}: checkout returns 5xx` }
    : { set: { 'traffic.servedBy': p.to } },
  restart_region_a: () => ({ set: { 'svc:region-a.status': 'healthy' } }),
  restore_traffic: () => ({ set: { 'traffic.servedBy': 'region-a' } }),
  resume_noncritical: (_p, t) => ({ set: { 'traffic.shedding': false, 'traffic.rps': t['traffic.fullRps'] } }),
};

function opsOutcome(truthAt: (tick: number) => Facts, effects: SimEffect[], endTick: number) {
  const h = effects.find((e) => e.harm);
  if (h) return { met: false, detail: h.harm! };
  for (let t = 0; t <= endTick; t++) {
    const w = truthAt(t);
    const r = String(w['traffic.servedBy']);
    if (r !== 'region-a' && (w[`svc:${r}.status`] !== 'healthy' || Number(w[`svc:${r}.headroomRps`]) < Number(w['traffic.rps']))) {
      return { met: false, detail: `${r} became ${w[`svc:${r}.status`]} at t${t} while serving all checkout traffic: customer-facing 5xx` };
    }
  }
  const end = truthAt(endTick);
  if (end['traffic.servedBy'] !== 'region-a' || end['svc:region-a.status'] !== 'healthy') return { met: false, detail: 'checkout not restored to region-a' };
  if (end['traffic.shedding'] !== false) return { met: false, detail: 'region-a restored, but non-critical traffic is still shed (partial recovery)' };
  return { met: true, detail: 'checkout restored in region-a; no customer-facing 5xx at any tick; full traffic back' };
}

const opsGoal: Goal = {
  statement: 'Restore checkout in region-a at full traffic, never serving from an unhealthy or under-capacity region.',
  success: [
    { fact: 'svc:region-a.status', op: 'eq', value: 'healthy' },
    { fact: 'traffic.servedBy', op: 'eq', value: 'region-a' },
    { fact: 'traffic.shedding', op: 'eq', value: false },
  ],
};

// ---------------------------------------------------------------- scenarios
export const scenarios: Record<string, Scenario> = {
  delivery: {
    id: 'delivery', title: 'Cold-chain delivery: a road closes after packing',
    blurb: 'Order #1042 is picked and sealed in its cold box. While it is being loaded, the traffic authority closes route R1.',
    domain: logistics, goal: logisticsGoal, facts: logisticsFacts, plan: logisticsPlan,
    sources: logisticsSources, physics: logisticsPhysics, outcome: logisticsOutcome, enums: logisticsEnums, settle: logisticsSettle,
    truth: [{ tick: 6, fact: 'route:R1.status', value: 'closed' }],
    feed: [
      { tick: 3, source: 'weather-feed', fact: 'weather:depot.tempC', value: 31 },
      { tick: 6, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' },
      { tick: 7, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed', replayOf: 1 },
    ],
  },
  recovery: {
    id: 'recovery', title: 'Service recovery: the failover target degrades',
    blurb: 'Checkout in region-a is degraded. While traffic is being shifted to region-b, the dependency monitor reports region-b degraded too.',
    domain: ops, facts: opsFacts, physics: opsPhysics, goal: opsGoal, outcome: opsOutcome, enums: { 'svc:*.status': ['healthy', 'degraded'] },
    plan: [
      { id: 's1', action: 'snapshot_db', params: {} },
      { id: 's2', action: 'shift_traffic', params: { to: 'region-b' } },
      { id: 's3', action: 'restart_region_a', params: {} },
      { id: 's4', action: 'restore_traffic', params: {} },
    ],
    sources: {
      'dep-monitor': { id: 'dep-monitor', key: 'sim-key-dep-monitor', mayAssert: ['svc:*.status', 'svc:*.headroomRps'], rank: 2 },
      'chatops-bot': { id: 'chatops-bot', key: 'sim-key-chatops', mayAssert: ['ticket:*.note'], rank: 1 },
    },
    truth: [{ tick: 3, fact: 'svc:region-b.status', value: 'degraded' }],
    feed: [
      { tick: 1, source: 'chatops-bot', fact: 'ticket:INC-7.note', value: 'customer reports slow checkout' },
      { tick: 3, source: 'dep-monitor', fact: 'svc:region-b.status', value: 'degraded' },
      { tick: 4, source: 'dep-monitor', fact: 'svc:region-b.status', value: 'healthy', seq: 0 },
    ],
  },
  flapping: {
    id: 'flapping', title: 'Adaptation failure: a faulty sensor flaps both routes',
    blurb: 'road-sensor-7 flips R1 and R2 between open and closed; a forged closure arrives from an unregistered source. Only the traffic authority is right.',
    domain: logistics, goal: logisticsGoal, facts: logisticsFacts, plan: logisticsPlan,
    sources: logisticsSources, physics: logisticsPhysics, outcome: logisticsOutcome, enums: logisticsEnums, settle: logisticsSettle,
    truth: [{ tick: 2, fact: 'route:R1.status', value: 'closed' }],
    feed: [
      { tick: 2, source: 'road-sensor-7', fact: 'route:R1.status', value: 'closed' },
      { tick: 3, source: 'road-sensor-7', fact: 'route:R2.status', value: 'closed' },
      { tick: 4, source: 'road-sensor-7', fact: 'route:R1.status', value: 'open' },
      { tick: 4, source: 'press-office', fact: 'route:R2.status', value: 'closed', forged: true },
      { tick: 5, source: 'road-sensor-7', fact: 'route:R2.status', value: 'open' },
      { tick: 6, source: 'road-sensor-7', fact: 'route:R1.status', value: 'closed' },
      { tick: 7, source: 'road-sensor-7', fact: 'route:R2.status', value: 'closed' },
      { tick: 8, source: 'road-sensor-7', fact: 'route:R1.status', value: 'open' },
      { tick: 9, source: 'road-sensor-7', fact: 'route:R2.status', value: 'open' },
      { tick: 16, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' },
      { tick: 16, source: 'traffic-authority', fact: 'route:R2.status', value: 'open' },
    ],
  },
};

/** Version of the executable contracts (code included). Replay refuses a run recorded under different contracts. */
export function contractHash(S: Scenario): string {
  const fns = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'function' ? v.toString() : v]));
  return createHash('sha256').update(JSON.stringify({
    actions: Object.fromEntries(Object.entries(S.domain.actions).map(([k, a]) => [k, fns(a)])),
    domains: fns(S.domain.domains),
    sources: Object.values(S.sources).map((s) => [s.id, s.mayAssert, s.rank, createHash('sha256').update(s.key).digest('hex')]),
  })).digest('hex').slice(0, 16);
}
