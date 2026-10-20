# 0005. Idempotency through unique indexes and client-supplied keys

Status: Accepted

## Context

Browsers retry form posts, beacons fire twice, checkout can be double-clicked, and webhooks are redelivered.

## Decision

Form and checkout accept a `submissionId`; opt-in events accept an `externalId`; both map to partial unique indexes (`events(funnel_id, type, external_id)`, `orders(funnel_id, idem_key)`) and `INSERT ... ON CONFLICT DO NOTHING`, so concurrent duplicates resolve in the database, not in application checks. The payment provider call is idempotent on the same key. `Idempotency-Key` also stops a retried write being counted twice by the rate limiter.

## Alternatives considered

Application-level "check then insert" (racy under concurrency); distributed locks.

## Consequences

Clients must send stable keys for retries to be free; a missing key means a retry is a new submission.
