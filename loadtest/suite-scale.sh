#!/usr/bin/env bash
# Scale-out matrix for event ingestion (see docs/SCALING.md "Measured"). Each run: real PostgreSQL, private Redis, N server processes, 20 s of load, then DB verification.
# Usage: loadtest/suite-scale.sh [seconds]   (needs server/dist built and TEST_PG_URL, see loadtest/scale.mjs)
set -u
S=${1:-20}
cd "$(dirname "$0")/.."
for run in "1 on" "2 on" "4 on" "1 off" "2 on kill" "2 off kill"; do
  set -- $run
  nodes=$1; q=$2; kill=${3:-}
  name="scale-n${nodes}-q${q}${kill:+-kill}"
  node loadtest/scale.mjs --nodes "$nodes" --queue "$q" --seconds "$S" --conc 64 ${kill:+--kill} --out "loadtest/results/$name.json" 2>&1 | grep -v -i -E "warning|trace-warnings" | tail -1 | cut -c1-400
done
