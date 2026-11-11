// Captures GENUINE model proposals for the planning contexts the shipped scenarios produce, so the public demo
// can show real model output without an API key. Usage: node scripts/record-planner.ts
// Uses the local Claude Code CLI (`claude -p`) under the owner's existing login. Each recording stores the exact
// prompt, the raw response, the serving model reported by the CLI, a timestamp and sha256 digests.
// Replayed recordings are labelled "recorded" in the UI and are validated against live state like any candidate.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Hub, Session } from '../src/runner.ts';
import { Planner, fingerprint, plannerPrompt, sha256 } from '../src/planner.ts';
import type { Recording } from '../src/planner.ts';
import type { RunState } from '../src/engine.ts';

const MODEL = process.env.KEEL_RECORD_MODEL ?? 'claude-sonnet-5-5';
const out = new URL('../fixtures/planner-recordings.json', import.meta.url);
const recordings: Recording[] = [];

class RecordingPlanner extends Planner {
  recorded(s: RunState) {
    const fp = fingerprint(s);
    if (!this.recordings.some((r) => r.fingerprint === fp)) {
      const prompt = plannerPrompt(s);
      const r = spawnSync('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--no-session-persistence', '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Agent'], { input: prompt, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 24 });
      if (r.status !== 0) throw new Error(`claude -p failed: ${r.stderr}`);
      const meta = JSON.parse(r.stdout) as { result: string; modelUsage?: Record<string, unknown>; is_error?: boolean };
      if (meta.is_error) throw new Error(`model error: ${meta.result}`);
      const served = Object.keys(meta.modelUsage ?? {}).filter((m) => !/haiku/.test(m)).join(', ') || `${MODEL} (requested; CLI reported no usage)`;
      const rec: Recording = {
        fingerprint: fp, scenario: s.scenario, model: served, capturedAt: new Date().toISOString(),
        prompt, response: meta.result, promptSha256: sha256(prompt), responseSha256: sha256(meta.result),
      };
      this.recordings.push(rec);
      recordings.push(rec);
      console.log(`recorded ${s.scenario} ${fp.slice(0, 10)} via ${served}: ${meta.result.slice(0, 140).replace(/\s+/g, ' ')}…`);
    }
    return super.recorded(s);
  }
}

for (const scenario of ['delivery', 'recovery', 'flapping']) {
  const hub = await Hub.open(':memory:');
  hub.planner = new RecordingPlanner(new URL('file:///nonexistent'));
  const s = await (await Session.create(hub, `rec-${scenario}`, scenario, ['keel'])).runToEnd();
  if (scenario === 'flapping') {
    const id = `rec-${scenario}-keel`;
    for (const f of hub.state(id)!.world.unstable) await hub.submit(id, { t: 'operator', cmd: 'confirm', fact: f, value: hub.state(id)!.world.facts[f], at: s.tick }, s);
    await hub.submit(id, { t: 'operator', cmd: 'resume', at: s.tick }, s);
    await s.runToEnd();
  }
  await hub.close();
}
mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true });
writeFileSync(out, JSON.stringify(recordings, null, 2) + '\n');
console.log(`wrote ${recordings.length} recordings to fixtures/planner-recordings.json`);
