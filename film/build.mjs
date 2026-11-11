// Builds the <=90 s KEEL film from REAL captures (film/capture.mjs), the synthetic narration (film/tts.py) and an
// ffmpeg-synthesised music bed. Editing is cuts, restrained crops and marked speed changes only; no UI is faked.
// Output: film/out/keel-film-final.mp4 (1920x1080, 30 fps, H.264 + AAC) and film/keel-film.srt.
// Usage: node film/capture.mjs && python film/tts.py && node film/build.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = F('./out/'), TMP = F('./out/build/');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const W = 1920, H = 1080, FPS = 30;
const json = (p) => JSON.parse(readFileSync(F(p), 'utf8'));
const voice = json('./out/audio/durations.json');
const text = Object.fromEntries(json('./narration.json').map((n) => [n.id, n.text]));
const proof = json('./proof.json');
const marks = Object.fromEntries(['delivery', 'recovery', 'flapping', 'engine'].map((c) => [c, json(`./out/raw/${c}.json`)]));
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

// ------------------------------------------------------------------ edit decision list
// A shot is a span of one capture between two UI-state marks (+ offset, s). box = [x, y, width] crop in the 1920x1080
// capture (the 1536x864 viewport sits top-left); dur stretches or compresses the span, and the film says so on screen.
const BASE = [118, 0, 1300];
const m = (clip, k, d = 0) => marks[clip][k] + d;
const scenes = [
  { card: 'title', len: 5.9, cues: [['title', 0, 0.3]] },
  {
    chip: 'Scenario A · Delivery: a road closes after packing',
    shots: [
      { clip: 'delivery', from: m('delivery', 'loaded', 0.8), to: m('delivery', 'revision'), dur: 5.4 },
      { clip: 'delivery', from: m('delivery', 'revision'), to: m('delivery', 'revision', 3.8), dur: 9.3, box: [458, 150, 960] },
      { clip: 'delivery', from: m('delivery', 'revision', 3.8), to: m('delivery', 'scorecard') },
      { clip: 'delivery', from: m('delivery', 'scorecard'), to: m('delivery', 'end') },
    ],
    cues: [['delivery', 0, 0.3], ['delivery2', 2, 0.6], ['scorecard', 3, 0.2]],
  },
  {
    chip: 'Scenario B · Service recovery: the failover target degrades',
    shots: [
      { clip: 'recovery', from: m('recovery', 'loaded', 0.6), to: m('recovery', 'revision') },
      { clip: 'recovery', from: m('recovery', 'revision'), to: m('recovery', 'revision', 3.3), dur: 5.1, box: [458, 60, 960] },
      // the static lane's outcome card is on screen from about revision+3.5 until the page scrolls at keel-outcome
      { clip: 'recovery', from: m('recovery', 'revision', 3.3), to: m('recovery', 'keel-outcome', 0.2), dur: 5.0 },
      { clip: 'recovery', from: m('recovery', 'keel-outcome', 0.2), to: m('recovery', 'end', -1.0) },
    ],
    cues: [['recovery', 0, 0.3], ['recovery2', 2, 0.2]],
  },
  {
    chip: 'Scenario C · Adaptation failure: a sensor flaps, a report is forged',
    shots: [
      { clip: 'flapping', from: m('flapping', 'loaded', 1.5), to: m('flapping', 'forgery-rejected') },
      { clip: 'flapping', from: m('flapping', 'forgery-rejected'), to: m('flapping', 'keel-paused', -0.1), box: [118, 140, 1040] },
      { clip: 'flapping', from: m('flapping', 'keel-paused', -0.1), to: m('flapping', 'confirmed', 0.2), dur: 4.6 },
      { clip: 'flapping', from: m('flapping', 'confirmed', 0.2), to: m('flapping', 'keel-outcome'), dur: 4.0 },
      { clip: 'flapping', from: m('flapping', 'keel-outcome'), to: m('flapping', 'end', -0.6) },
    ],
    cues: [['flapping', 0, 0.3], ['flapping2', 3, 0.2]],
  },
  {
    chip: 'Crash and recover: the agent process dies mid-step',
    shots: [
      { clip: 'engine', from: m('engine', 'crashed', -2.2), to: m('engine', 'crashed', 1.8), box: [458, 120, 960] },
      { clip: 'engine', from: m('engine', 'crashed', 1.8), to: m('engine', 'keel-outcome'), dur: 2.1 },
      { clip: 'engine', from: m('engine', 'trace'), to: m('engine', 'end', -0.1), box: [0, 300, 1000] },
    ],
    cues: [['engine', 0, 0.6]],
  },
  { card: 'proof', len: 7.9, cues: [['proof', 0, 0.35]] },
  // closing reveal of the logo from ui/public/keel.svg (dark theme tokens); frame-rendered, no burned-in caption: the
  // spoken line is the on-screen tagline
  { card: 'logo', len: 7.0, nocap: true, cues: [['logo', 0, 2.9]] },
];

// ------------------------------------------------------------------ overlays and cards (HTML -> PNG)
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
:root { --bg:#edf1f3; --panel:#fff; --ink:#0d1b2a; --muted:#586979; --line:#d6dee4; --teal:#0e7c7b; --teal-bg:#e1f2f1; --amber:#a86a12; --amber-bg:#fbf0dc; }
* { box-sizing: border-box; } html, body { margin:0; width:${W}px; height:${H}px; font-family:'IBM Plex Sans',sans-serif; color:var(--ink); }
body.clear { background: transparent; } body.card { background: var(--bg); display:flex; align-items:center; justify-content:center; }
.chip { position:absolute; left:40px; top:34px; display:flex; align-items:center; gap:14px; background:var(--panel); border:1px solid var(--line);
  border-radius:12px; padding:12px 18px; font-size:25px; font-weight:600; box-shadow:0 6px 24px rgba(13,27,42,.14); }
.chip i { width:12px; height:12px; border-radius:50%; background:var(--teal); }
.sim { font:500 17px 'IBM Plex Mono',monospace; letter-spacing:.06em; color:var(--amber); background:var(--amber-bg); border-radius:6px; padding:4px 8px; }
.simtag { position:absolute; left:28px; top:26px; } .simtag .sim { box-shadow:0 2px 10px rgba(13,27,42,.18); }
.speed { position:absolute; right:40px; top:34px; font:500 22px 'IBM Plex Mono',monospace; color:#fff; background:rgba(13,27,42,.82); border-radius:10px; padding:10px 14px; }
.cap { position:absolute; left:50%; bottom:58px; transform:translateX(-50%); max-width:1560px; width:max-content; text-align:center;
  background:rgba(13,27,42,.86); color:#fff; font-size:40px; font-weight:500; line-height:1.3; padding:14px 28px; border-radius:12px; }
.logo { width:150px; height:150px; } .old { fill:none; stroke:var(--teal); stroke-opacity:.35; stroke-width:3; stroke-dasharray:4 4; stroke-linecap:round; }
.new { fill:none; stroke:var(--teal); stroke-width:3.5; stroke-linecap:round; stroke-linejoin:round; } .water { stroke:var(--ink); stroke-width:3.5; stroke-linecap:round; } .fin { fill:var(--ink); }
.title { text-align:center; } .title h1 { font-size:148px; letter-spacing:.14em; margin:8px 0 0 .14em; font-weight:700; }
.title .tag { font-size:50px; font-weight:500; margin-top:8px; } .title .sub { font-size:31px; color:var(--muted); margin-top:26px; }
.title .note { margin-top:64px; display:inline-block; font-size:24px; color:var(--amber); background:var(--amber-bg); padding:10px 18px; border-radius:8px; }
.proof { width:1500px; } .proof h2 { font-size:56px; margin:0 0 34px; } .proof .row { display:flex; align-items:baseline; gap:34px; padding:16px 0; border-top:1px solid var(--line); }
.proof .n { font:600 50px 'IBM Plex Mono',monospace; color:var(--teal); width:250px; text-align:right; } .proof .t { font-size:34px; }
.proof .credits { margin-top:40px; font-size:21px; color:var(--muted); line-height:1.5; } .proof .end { margin-top:30px; font-size:34px; font-weight:600; }
`;
const LOGO = `<svg class="logo" viewBox="0 0 64 64"><path d="M7 19 H57" class="old"/><path d="M7 19 H27 L47 9 H55" class="new"/><path d="M51 5 L57 9 L51 13" class="new"/><path d="M5 28 H59" class="water"/><path d="M24 28 H40 L34.5 55 Q32 58 29.5 55 Z" class="fin"/></svg>`;
// The closing reveal: the same five paths as ui/public/keel.svg in the UI's dark-theme colours. window.render(t) sets
// every property from t alone, so each frame is deterministic. Course of events: light comes up, the waterline draws,
// the keel lowers, the old course appears, the repaired course and its arrow draw, the wordmark settles, one sheen
// crosses it, the tagline arrives, then the composition holds still.
const LOGO_REVEAL = `<!doctype html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;700&display=swap');
html, body { margin:0; width:${W}px; height:${H}px; background:#05090d; overflow:hidden; font-family:'IBM Plex Sans',sans-serif; }
#root { position:absolute; inset:0; background:radial-gradient(ellipse 120% 90% at 50% 45%, #0d1a25 0%, #0a141d 45%, #04080b 100%); }
#light { position:absolute; left:50%; top:40%; width:1500px; height:1000px; border-radius:50%;
  background:radial-gradient(closest-side, rgba(62,194,191,.16), rgba(62,194,191,.05) 55%, transparent); }
#stage { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
svg { width:300px; height:300px; overflow:visible; }
.old { fill:none; stroke:#3ec2bf; stroke-width:3; stroke-dasharray:4 4; stroke-linecap:round; }
.new { fill:none; stroke:#3ec2bf; stroke-width:3.5; stroke-linecap:round; stroke-linejoin:round; }
.water { stroke:#e5edf2; stroke-width:3.5; stroke-linecap:round; } .fin { fill:#e5edf2; }
.word { position:relative; margin-top:18px; font-size:150px; font-weight:700; color:#e5edf2; line-height:1; }
.sheen { position:absolute; inset:0; color:transparent; -webkit-background-clip:text; background-clip:text; background-repeat:no-repeat;
  background-image:linear-gradient(100deg, transparent 40%, rgba(255,255,255,.9) 50%, transparent 60%); background-size:300% 100%; }
.tag { margin-top:34px; font-size:46px; font-weight:500; color:#b8c7d3; letter-spacing:.01em; }
</style></head><body><div id="root"><div id="light"></div><div id="stage">
<svg viewBox="0 0 64 64"><path id="old" d="M7 19 H57" class="old"/><path id="nw" d="M7 19 H27 L47 9 H55" class="new"/><path id="arrow" d="M51 5 L57 9 L51 13" class="new"/><path id="water" d="M5 28 H59" class="water"/><path id="fin" d="M24 28 H40 L34.5 55 Q32 58 29.5 55 Z" class="fin"/></svg>
<div class="word" id="word">KEEL<div class="sheen" id="sheen">KEEL</div></div>
<div class="tag" id="tag">The plan can change. The goal stays.</div>
</div></div><script>
const $ = (id) => document.getElementById(id);
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return 1 - Math.pow(1 - x, 3); };
const seg = (t, a, b) => ease((t - a) / (b - a));
const draw = (el, k) => { const L = el.getTotalLength(); el.style.strokeDasharray = L; el.style.strokeDashoffset = L * (1 - k); };
window.render = (t) => {
  $('root').style.opacity = seg(t, 0, 0.8);
  $('light').style.opacity = 0.3 + 0.7 * seg(t, 0.2, 2.6);
  $('light').style.transform = 'translate(-50%,-50%) scale(' + (0.94 + 0.06 * seg(t, 0, 7)) + ')';
  draw($('water'), seg(t, 0.4, 1.4));
  $('fin').style.clipPath = 'inset(0 0 ' + (100 * (1 - seg(t, 1.0, 1.9))) + '% 0)';
  $('old').style.opacity = 0.35 * seg(t, 1.3, 2.0);
  draw($('nw'), seg(t, 1.7, 2.7));
  draw($('arrow'), seg(t, 2.5, 2.95));
  const w = seg(t, 2.8, 3.8), ls = 0.3 - 0.16 * w;
  Object.assign($('word').style, { opacity: w, letterSpacing: ls + 'em', marginLeft: ls + 'em', transform: 'translateY(' + 16 * (1 - w) + 'px)' });
  const s = Math.min(1, Math.max(0, (t - 3.7) / 1.1));
  Object.assign($('sheen').style, { opacity: Math.sin(Math.PI * s) * 0.55, backgroundPosition: (100 - 100 * s) + '% 0' });
  const g = seg(t, 4.0, 4.9);
  Object.assign($('tag').style, { opacity: g, transform: 'translateY(' + 10 * (1 - g) + 'px)' });
};
window.render(0);
</script></body></html>`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = {
  title: () => `<body class="card"><div class="title">${LOGO}<h1>KEEL</h1><div class="tag">The plan can change. The goal stays.</div>
    <div class="sub">An adaptive agent that changes its mind for a reason, and shows the reason.</div>
    <div class="note">Every external system in this film is simulated: no real dispatches, failovers or notifications.</div></div></body>`,
  proof: () => `<body class="card"><div class="proof"><h2>What was checked</h2>
    ${proof.rows.map(([n, t]) => `<div class="row"><div class="n">${esc(n)}</div><div class="t">${esc(t)}</div></div>`).join('')}
    <div class="credits">Footage: unedited screen captures of the KEEL build at commit ${proof.commit}, on a local server; cuts, crops and marked speed changes only.
    Repair proposals shown as recorded model output were captured from claude-sonnet-5-5 and are re-validated live.
    Narration: synthetic voice (Kokoro-82M). Music: synthesised for this film. Evidence logs: docs/evidence/.</div>
    </div></body>`,
  chip: (chip) => `<body class="clear"><div class="chip"><i></i>${esc(chip)}<span class="sim">SIMULATED</span></div></body>`,
  tag: () => `<body class="clear"><div class="simtag"><span class="sim">SIMULATED WORLD</span></div></body>`,
  speed: (label) => `<body class="clear"><div class="speed">${label}</div></body>`,
  cap: (t) => `<body class="clear"><div class="cap">${esc(t)}</div></body>`,
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
async function png(name, body) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>${body}</html>`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const path = `${TMP}${name}.png`;
  await page.screenshot({ path, omitBackground: true });
  return path;
}

// ------------------------------------------------------------------ timeline
const frames = (s) => Math.round(s * FPS);
const CHIP = 4; // seconds the scene title stays up
const tagPng = await png('tag', html.tag());
let t = 0;
const parts = [], overlays = [], cues = [];
for (const [si, sc] of scenes.entries()) {
  const start = t;
  if (sc.card === 'logo') {
    const n = frames(sc.len), file = `${TMP}s${si}.mp4`;
    mkdirSync(`${TMP}logo`, { recursive: true });
    await page.setContent(LOGO_REVEAL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    for (let i = 0; i < n; i++) {
      await page.evaluate((s) => window.render(s), i / FPS);
      await page.screenshot({ path: `${TMP}logo/${String(i).padStart(4, '0')}.png` });
    }
    ff('-framerate', String(FPS), '-i', `${TMP}logo/%04d.png`, '-vf', 'format=yuv420p', '-frames:v', String(n), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', file);
    parts.push(file); sc.starts = [start]; t += n / FPS;
  } else if (sc.card) {
    const n = frames(sc.len);
    const file = `${TMP}s${si}.mp4`;
    const fade = si === 0 ? `fade=in:0:15,` : `fade=out:${n - 24}:24,`;
    ff('-loop', '1', '-framerate', String(FPS), '-i', await png(sc.card, html[sc.card]()), '-vf', `${fade}format=yuv420p`, '-frames:v', String(n), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', file);
    parts.push(file); sc.starts = [start]; t += n / FPS;
  } else {
    sc.starts = [];
    for (const [k, sh] of sc.shots.entries()) {
      const span = sh.to - sh.from;
      const len = sh.dur ?? span, speed = span / len, n = frames(len);
      const [x, y, w] = sh.box ?? BASE, h = Math.round(w * 9 / 16);
      const fades = [k === 0 ? 'fade=in:0:8' : null, k === sc.shots.length - 1 ? `fade=out:${n - 8}:8` : null].filter(Boolean);
      const file = `${TMP}s${si}-${k}.mp4`;
      ff('-ss', sh.from.toFixed(3), '-t', (span + 0.5).toFixed(3), '-i', F(`./out/raw/${sh.clip}.webm`), '-an', '-vf',
        [`crop=${w}:${h}:${x}:${y}`, `scale=${W}:${H}:flags=lanczos`, `setpts=(PTS-STARTPTS)/${speed.toFixed(4)}`, `fps=${FPS}`, 'tpad=stop_mode=clone:stop_duration=2', ...fades, 'format=yuv420p'].join(','),
        '-frames:v', String(n), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', file);
      if (Math.abs(speed - 1) > 0.05) overlays.push({ file: await png(`sp${si}-${k}`, html.speed(`${speed < 1 ? 'slowed' : 'sped up'} ${speed.toFixed(1)}×`)), from: t, to: t + n / FPS });
      if (t + n / FPS > start + CHIP) overlays.push({ file: tagPng, from: Math.max(t, start + CHIP), to: t + n / FPS });
      sc.starts.push(t); parts.push(file); t += n / FPS;
    }
    overlays.push({ file: await png(`chip${si}`, html.chip(sc.chip)), from: start, to: start + CHIP });
  }
  for (const [id, shot, at] of sc.cues) cues.push({ id, at: sc.starts[shot] + at, sceneEnd: t, burn: !sc.nocap });
}
const total = t;
if (total > 90) throw new Error(`film is ${total.toFixed(2)} s; the limit is 90 s`);
for (const c of cues) if (c.at + voice[c.id] > c.sceneEnd + 0.05) console.warn(`cue ${c.id} overruns its scene by ${(c.at + voice[c.id] - c.sceneEnd).toFixed(2)} s`);
for (const [i, c] of cues.slice(1).entries()) if (cues[i].at + voice[cues[i].id] > c.at - 0.1) throw new Error(`cue ${cues[i].id} runs into ${c.id}`);

// ------------------------------------------------------------------ captions (burned in, and as SRT)
const chunks = [];
for (const c of cues) {
  const pieces = text[c.id].split(/(?<=[.:])\s+/).flatMap((s) => (s.length > 74 ? s.split(/(?<=,)\s+/) : [s]));
  const speak = voice[c.id] - 0.35, weight = pieces.reduce((a, p) => a + p.length + 6, 0);
  let at = c.at;
  for (const p of pieces) { const d = speak * (p.length + 6) / weight; chunks.push({ t: p, from: at, to: at + d, burn: c.burn }); at += d; }
}
const ts = (s) => new Date(s * 1000).toISOString().slice(11, 23).replace('.', ',');
writeFileSync(F('./keel-film.srt'), chunks.map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${c.t}\n`).join('\n'));
for (const [i, c] of chunks.entries()) if (c.burn) overlays.push({ file: await png(`c${i}`, html.cap(c.t)), from: c.from, to: c.to });
await browser.close();

// ------------------------------------------------------------------ assemble video
writeFileSync(`${TMP}list.txt`, parts.map((p) => `file '${p}'`).join('\n'));
ff('-f', 'concat', '-safe', '0', '-i', `${TMP}list.txt`, '-c', 'copy', `${TMP}base.mp4`);
const vIn = overlays.flatMap((o) => ['-i', o.file]);
let chain = '[0:v]';
const vf = overlays.map((o, i) => {
  const out = i === overlays.length - 1 ? '[v]' : `[v${i}]`;
  const s = `${chain}[${i + 1}:v]overlay=0:0:enable='between(t,${o.from.toFixed(3)},${o.to.toFixed(3)})'${out}`;
  chain = out; return s;
});
writeFileSync(`${TMP}overlay.txt`, vf.join(';\n'));
ff('-i', `${TMP}base.mp4`, ...vIn, '-/filter_complex', `${TMP}overlay.txt`, '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', `${TMP}video.mp4`);

// ------------------------------------------------------------------ audio: narration cues + synthesised pad
const pad = (f, a) => `${a}*sin(2*PI*${f}*t)`;
const w = '(0.5+0.5*sin(2*PI*t/16))';
const music = `aevalsrc='0.5*(${pad(110, 0.05)}+${w}*(${pad(220, 0.03)}+${pad(261.63, 0.022)}+${pad(329.63, 0.018)})+(1-${w})*(${pad(174.61, 0.03)}+${pad(220, 0.022)}+${pad(261.63, 0.018)}))|0.5*(${pad(110.4, 0.05)}+${w}*(${pad(220.5, 0.03)}+${pad(261.9, 0.022)}+${pad(330.1, 0.018)})+(1-${w})*(${pad(174.9, 0.03)}+${pad(220.4, 0.022)}+${pad(262.0, 0.018)}))':s=48000:d=${total.toFixed(2)}`;
const aIn = cues.flatMap((c) => ['-i', `${OUT}audio/${c.id}.wav`]);
const af = [
  `${music},lowpass=f=1400,aecho=0.8:0.7:120|240:0.25|0.15,volume=0.55,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3[mus]`,
  ...cues.map((c, i) => `[${i}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[a${i}]`),
  `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,asplit[vox][key0]`,
  `[key0]apad[key]`, // the compressor stops with its key input; the voice ends before the film does
  // the music ducks under the voice so no word is masked (checked by ASR, see film/storyboard.md)
  `[mus][key]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=500[duck]`,
  `[duck][vox]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad[aout]`,
].join(';\n');
writeFileSync(`${TMP}audio.txt`, af);
ff(...aIn, '-/filter_complex', `${TMP}audio.txt`, '-map', '[aout]', '-t', total.toFixed(2), '-c:a', 'pcm_s16le', `${TMP}audio.wav`);
ff('-i', `${TMP}video.mp4`, '-i', `${TMP}audio.wav`, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', total.toFixed(3), `${OUT}keel-film-final.mp4`);
console.log(`film: ${total.toFixed(2)} s, ${parts.length} shots, ${chunks.length} captions -> film/out/keel-film-final.mp4`);
