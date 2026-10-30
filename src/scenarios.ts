// Scenario data. Two domains, three scenarios. The engine never branches on a scenario id:
// a scenario is action contracts + initial beliefs + a world-time event feed + simulated physics.
import type { Domain, Facts, Goal, Json, Params, Step } from './model.ts';
import type { Source } from './world.ts';

/** What really happens in the SIMULATED world when an action runs (the agent never reads this). */
export type Physics = Record<string, (p: Params, truth: Facts) => { set?: Facts; harm?: string }>;
export type FeedItem = { tick: number; source: string; fact: string; value: Json; seq?: number; forged?: boolean; replayOf?: number };
export type Scenario = {
  id: string; title: string; blurb: string;
  domain: Domain; goal: Goal; facts: Facts; plan: Step[];
  sources: Record<string, Source>;
  /** Ground truth changes in world time. Same for every agent policy. */
  truth: { tick: number; fact: string; value: Json }[];
  /** What observation sources report, in world time. Same for every agent policy. */
  feed: FeedItem[];
  physics: Physics;
  /** Ground-truth success, judged on the simulated world only. */
  outcome(truth: Facts, harms: string[]): { met: boolean; detail: string };
};

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
      type: 'pack', describe: 'Pack into an insulated cold box (holds temperature for coldHoldMin minutes).', params: { order: 'order' },
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
        { fact: 'permit-office.status', op: 'eq', value: 'open' },
      ],
      produces: (p) => ({ [`route:${p.route}.permit`]: 'granted' }),
      effectKey: (p) => `permit:${p.route}`,
    },
    dispatch: {
      type: 'dispatch', describe: 'Send the loaded truck on a route. Irreversible once the truck leaves.', params: { order: 'order', truck: 'truck', route: 'route' },
      commitment: 'irreversible', duration: 1, cost: (p, f) => Number(f[`route:${p.route}.etaMin`] ?? 999),
      requires: (p) => [
        { fact: `order:${p.order}.loadedOn`, op: 'eq', value: p.truck },
        { fact: `order:${p.order}.labelRoute`, op: 'eq', value: p.route },
        { fact: `route:${p.route}.status`, op: 'eq', value: 'open' },
        { fact: `route:${p.route}.permit`, op: 'neq', value: 'required' },
        { fact: `route:${p.route}.etaMin`, op: 'lte', ref: `order:${p.order}.slaMin` },
        { fact: `route:${p.route}.etaMin`, op: 'lte', ref: `order:${p.order}.coldHoldMin` },
      ],
      produces: (p) => ({ [`order:${p.order}.dispatchedVia`]: p.route, [`truck:${p.truck}.status`]: 'en-route' }),
      effectKey: (p) => `dispatch:${p.order}`,
    },
    notify: {
      type: 'notify', describe: 'Tell the customer the delivery is on its way and on time.', params: { order: 'order' },
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
  'order:1042.slaMin': 70, 'order:1042.coldHoldMin': 90,
  'truck:T1.status': 'available', 'permit-office.status': 'open',
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
  statement: 'Deliver cold-chain order #1042 within its 70-minute SLA without breaking the cold box.',
  success: [
    { fact: 'order:1042.dispatchedVia', op: 'neq', value: 'none' },
    { fact: 'order:1042.customerNotified', op: 'eq', value: true },
  ],
};

const logisticsPhysics: Physics = {
  dispatch: (p, t) => t[`route:${p.route}.status`] === 'open'
    ? { set: { 'order:1042.delivered': true } }
    : { set: { 'order:1042.delivered': false }, harm: `truck ${p.truck} dispatched onto closed route ${p.route}: stuck at the closure, cold box expires` },
};

const logisticsOutcome = (t: Facts, harms: string[]) => t['order:1042.delivered'] === true && harms.length === 0
  ? { met: true, detail: 'order #1042 delivered within SLA, cold chain intact' }
  : { met: false, detail: harms[0] ?? 'order #1042 not delivered' };

// Real HMAC keys live only in this simulation; the demo labels every source as SIMULATED.
const logisticsSources: Record<string, Source> = {
  'traffic-authority': { id: 'traffic-authority', key: 'sim-key-traffic-authority', mayAssert: ['route:'], authoritative: true },
  'road-sensor-7': { id: 'road-sensor-7', key: 'sim-key-road-sensor-7', mayAssert: ['route:'], authoritative: false },
  'weather-feed': { id: 'weather-feed', key: 'sim-key-weather', mayAssert: ['weather:'], authoritative: false },
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
      type: 'shed_noncritical', describe: 'Shed non-critical traffic (recommendations, analytics); only critical checkout traffic remains.', params: {},
      commitment: 'reversible', duration: 1, cost: () => 5,
      requires: () => [],
      produces: (_p, f) => ({ 'traffic.rps': f['traffic.criticalRps'] ?? null, 'traffic.shedding': true }),
      effectKey: () => 'shed_noncritical',
    },
    shift_traffic: {
      type: 'shift_traffic', describe: 'Move all live traffic from region-a to another region.', params: { to: 'region' },
      commitment: 'reversible', duration: 2, cost: () => 2,
      requires: (p) => [
        { fact: 'db.snapshot', op: 'eq', value: true },
        { fact: `svc:${p.to}.status`, op: 'eq', value: 'healthy' },
        { fact: `svc:${p.to}.headroomRps`, op: 'gte', ref: 'traffic.rps' },
      ],
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
      produces: () => ({ 'traffic.servedBy': 'region-a' }),
      effectKey: () => 'restore_traffic',
    },
  },
};

const opsFacts: Facts = {
  'svc:region-a.status': 'degraded', 'traffic.servedBy': 'region-a',
  'traffic.rps': 1000, 'traffic.criticalRps': 450, 'traffic.shedding': false, 'db.snapshot': false,
  'svc:region-b.status': 'healthy', 'svc:region-b.headroomRps': 1400,
  'svc:region-c.status': 'healthy', 'svc:region-c.headroomRps': 600,
};

const opsPhysics: Physics = {
  shed_noncritical: (_p, t) => ({ set: { 'traffic.rps': t['traffic.criticalRps'] } }),
  shift_traffic: (p, t) => t[`svc:${p.to}.status`] !== 'healthy' || Number(t[`svc:${p.to}.headroomRps`]) < Number(t['traffic.rps'])
    ? { set: { 'traffic.servedBy': p.to, 'checkout.outage': true }, harm: `traffic moved onto ${p.to}, which was ${t[`svc:${p.to}.status`]}: checkout returns 5xx` }
    : { set: { 'traffic.servedBy': p.to, 'checkout.outage': false } },
  restart_region_a: () => ({ set: { 'svc:region-a.status': 'healthy' } }),
  restore_traffic: () => ({ set: { 'traffic.servedBy': 'region-a' } }),
};

// ---------------------------------------------------------------- scenarios
export const scenarios: Record<string, Scenario> = {
  delivery: {
    id: 'delivery', title: 'Cold-chain delivery: a road closes after packing',
    blurb: 'Order #1042 is picked and packed. While it is being loaded, the traffic authority closes route R1.',
    domain: logistics, goal: logisticsGoal, facts: logisticsFacts, plan: logisticsPlan,
    sources: logisticsSources, physics: logisticsPhysics, outcome: logisticsOutcome,
    truth: [{ tick: 6, fact: 'route:R1.status', value: 'closed' }],
    feed: [
      { tick: 3, source: 'weather-feed', fact: 'weather:depot.tempC', value: 31 },
      { tick: 6, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed' },
      { tick: 7, source: 'traffic-authority', fact: 'route:R1.status', value: 'closed', replayOf: 1 },
    ],
  },
  recovery: {
    id: 'recovery', title: 'Service recovery: the failover target degrades',
    blurb: 'Checkout in region-a is degraded. Mid-recovery, the dependency monitor reports region-b degraded too.',
    domain: ops, facts: opsFacts, physics: opsPhysics,
    goal: {
      statement: 'Restore checkout in region-a without a customer-facing outage.',
      success: [{ fact: 'svc:region-a.status', op: 'eq', value: 'healthy' }, { fact: 'traffic.servedBy', op: 'eq', value: 'region-a' }],
    },
    plan: [
      { id: 's1', action: 'snapshot_db', params: {} },
      { id: 's2', action: 'shift_traffic', params: { to: 'region-b' } },
      { id: 's3', action: 'restart_region_a', params: {} },
      { id: 's4', action: 'restore_traffic', params: {} },
    ],
    sources: {
      'dep-monitor': { id: 'dep-monitor', key: 'sim-key-dep-monitor', mayAssert: ['svc:'], authoritative: true },
      'chatops-bot': { id: 'chatops-bot', key: 'sim-key-chatops', mayAssert: ['ticket:'], authoritative: false },
    },
    truth: [{ tick: 3, fact: 'svc:region-b.status', value: 'degraded' }],
    feed: [
      { tick: 1, source: 'chatops-bot', fact: 'ticket:INC-7.note', value: 'customer reports slow checkout' },
      { tick: 3, source: 'dep-monitor', fact: 'svc:region-b.status', value: 'degraded' },
      { tick: 4, source: 'dep-monitor', fact: 'svc:region-b.status', value: 'healthy', seq: 0 },
    ],
    outcome: (t, harms) => harms.length === 0 && t['svc:region-a.status'] === 'healthy' && t['traffic.servedBy'] === 'region-a'
      ? { met: true, detail: 'checkout recovered in region-a with zero 5xx' }
      : { met: false, detail: harms[0] ?? 'checkout not restored' },
  },
  flapping: {
    id: 'flapping', title: 'Adaptation failure: a faulty sensor flaps both routes',
    blurb: 'road-sensor-7 alternates R1 and R2 between open and closed. One forged closure arrives from an unregistered source.',
    domain: logistics, goal: logisticsGoal, facts: logisticsFacts, plan: logisticsPlan,
    sources: logisticsSources, physics: logisticsPhysics, outcome: logisticsOutcome,
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
