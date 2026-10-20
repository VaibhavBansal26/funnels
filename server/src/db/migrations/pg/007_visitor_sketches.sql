-- One HyperLogLog sketch (util/hll.ts) per funnel and UTC day for distinct visitors over long ranges (docs/SCALING.md, ADR 0014).
-- Written with every event batch, read only when a range has too many page views for an exact scan. `regs` is base64, empty until first written.
CREATE TABLE visitor_sketches (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  regs TEXT NOT NULL,
  PRIMARY KEY (funnel_id, day)
);
