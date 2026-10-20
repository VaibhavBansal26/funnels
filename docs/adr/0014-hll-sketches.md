# 0014. HyperLogLog sketches for distinct visitors over long ranges

Status: Accepted

## Context

Funnel-level "unique visitors" must count each visitor once across steps, so it cannot be summed from per-step rollups. The exact answer is a `COUNT(DISTINCT visitor_id)` over raw `events`, whose cost grows with the number of page views in the range (see PERFORMANCE.md). The target is analytics over any range in under 300 ms p95 on tables of 1B+ events.

## Decision

* One HyperLogLog sketch (4,096 registers, 1.6% standard error, 4 KB dense) per funnel and UTC day in `visitor_sketches`, updated in the same transaction as each event batch (rows locked in key order, so concurrent batches serialise instead of overwriting each other).
* `distinctVisitors` is exact (a bounded scan of `events`) when the range has at most `ANALYTICS_EXACT_DISTINCT_MAX` page views (default 200,000) and uses the merged day sketches above that. Partial UTC days at the edges of a range (time-zone offsets) are added exactly from raw events. `ANALYTICS_DISTINCT_MODE=exact|sketch` forces either. The response states `distinct.method` and `distinct.standardErrorPct`.

## Alternatives considered

A per-day exact distinct table (`visitor_days`: tried first, removed again, it doubled write cost and grew without bound); sketches only (small ranges would be needlessly inexact); ClickHouse `uniq` only (see 0016; it is the same idea one tier up).

## Consequences

Large ranges are approximate by about 1.6% (2 sigma about 3.2%), and a dashboard that sums days will differ slightly from the funnel-level number. Sketches add one read-modify-write of a 4-5 KB row per funnel-day per batch. Sketches of purged funnels cascade away with the funnel.
