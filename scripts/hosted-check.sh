#!/usr/bin/env bash
# Local stand-in for the hosted deployment: the production Docker image on PostgreSQL.
#  1. start container k1, create a session, SIGKILL k1 mid-run;
#  2. start k2 on the same database: it must resume the session from Postgres and finish with no duplicate effect;
#  3. start k3 while k2 is still serving (a zero-downtime deploy overlap): k2 must be fenced (health 503), k3 healthy.
# Usage: PG_URL=postgres://user:pass@host.docker.internal:55432/keel bash scripts/hosted-check.sh
set -euo pipefail
IMG=${IMG:-keel:local}
SCHEMA=hc_$RANDOM$RANDOM
PG_URL=${PG_URL:?set PG_URL (reachable from inside a container)}
run() { docker run -d --name "$1" -e DATABASE_URL="$PG_URL" -e KEEL_PG_SCHEMA="$SCHEMA" -e KEEL_TICK_MS=400 -p "127.0.0.1:$2:3000" "$IMG" >/dev/null; }
wait_up() { for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$1/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "port $1 never became healthy"; return 1; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(($1)(j))})"; }
cleanup() { docker rm -f hc1 hc2 hc3 >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
fail() { echo "FAIL: $*"; exit 1; }

run hc1 3301; wait_up 3301
SID=$(curl -s -X POST -H 'content-type: application/json' -d '{"scenario":"delivery"}' http://127.0.0.1:3301/api/sessions | js 'j=>j.sessionId')
sleep 3
echo "before kill: $(curl -s http://127.0.0.1:3301/api/sessions/$SID | js "j=>'t'+j.tick+' '+j.runs.map(r=>r.policy+':'+r.status).join(' ')")"
docker kill -s KILL hc1 >/dev/null
echo "hc1 SIGKILLed"

run hc2 3302; wait_up 3302
for _ in $(seq 1 60); do
  S=$(curl -s http://127.0.0.1:3302/api/sessions/$SID | js "j=>j.runs.every(r=>r.status==='completed'&&!r.metrics.outcomePending)")
  [ "$S" = "true" ] && break; sleep 1
done
[ "$S" = "true" ] || fail "the resumed session never completed"
OK=$(curl -s http://127.0.0.1:3302/api/sessions/$SID | js "j=>j.runs.every(r=>r.metrics.duplicateEffects===0)&&j.runs.find(r=>r.policy==='keel').metrics.goalMet&&!j.runs.find(r=>r.policy==='static').metrics.goalMet")
[ "$OK" = "true" ] || fail "expected no duplicate effect, KEEL goal met, static goal missed"
echo "after resume: $(curl -s http://127.0.0.1:3302/api/sessions/$SID | js "j=>j.runs.map(r=>r.policy+': '+r.status+' goalMet='+r.metrics.goalMet+' dupEffects='+r.metrics.duplicateEffects+' recovered='+(r.metrics.preservedCompleted)+' | '+r.metrics.truth).join('\n               ')")"

run hc3 3303; wait_up 3303
SID2=$(curl -s -X POST -H 'content-type: application/json' -d '{"scenario":"recovery"}' http://127.0.0.1:3303/api/sessions | js 'j=>j.sessionId')
echo "overlap: old hc2 health=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3302/api/health) (expect 200 until it next writes)"
# hc2 still owns live sessions? it writes on its next tick only if it has unsettled sessions; force a write attempt:
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"scenario":"delivery"}' http://127.0.0.1:3302/api/sessions)
echo "old hc2 create-session after takeover: HTTP $CODE (expect 500/503, never 201)"
case "$CODE" in 500|503) ;; *) fail "the old writer answered $CODE after the takeover";; esac
OLD=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3302/api/health)
NEW=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3303/api/health)
echo "old hc2 health now: $OLD (expect 503)"
echo "new hc3 health: $NEW; new session $SID2 created on hc3"
[ "$OLD" = 503 ] && [ "$NEW" = 200 ] && [ -n "$SID2" ] && [ "$SID2" != undefined ] || fail "fencing: old $OLD, new $NEW, session '$SID2'"
docker logs hc2 2>&1 | grep -m1 fenced || true
echo "PASS"
