// Lua for Redis. Each decision is ONE script call, so check-and-update is atomic across every node and process.
// Time comes from Redis (`TIME`), so node clocks and their skew do not matter; ARGV[1] may carry an explicit "now"
// (milliseconds) which only tests use, to replay a fake clock. All keys of one call share the `{subject}` hash tag (Redis Cluster safe).
// Return values are integers (Redis truncates Lua numbers), so every value is rounded explicitly. The arithmetic mirrors math.ts.

const PRELUDE = `
local function now_ms(arg)
  if arg ~= 0 then return arg end
  local t = redis.call('TIME')
  return t[1] * 1000 + math.floor(t[2] / 1000)
end
local EPS = 0.05
-- guards: KEYS[2] deny, KEYS[3] allow, KEYS[4] penalty. Codes: 0 allowed, 1 limited, 2 blocked, 3 denied, 4 bypassed.
local function guards(now)
  if redis.call('EXISTS', KEYS[2]) == 1 then
    local ttl = redis.call('PTTL', KEYS[2])
    if ttl < 0 then ttl = 86400000 end
    return {3, 0, 0, ttl}
  end
  if redis.call('EXISTS', KEYS[3]) == 1 then return {4, 9007199254740991, 0, 0} end
  local pen = redis.call('GET', KEYS[4])
  if pen and tonumber(pen) > now then
    local left = math.ceil(tonumber(pen) - now)
    return {2, 0, left, left}
  end
  return nil
end
-- strike: KEYS[5] strikes, KEYS[6] level, KEYS[4] penalty; ARGV[p..p+3] = enabled, threshold, strikeWindow, decay, then the steps
local function strike(now, p)
  if ARGV[p] ~= '1' then return 0 end
  local n = redis.call('INCR', KEYS[5])
  if n == 1 then redis.call('PEXPIRE', KEYS[5], tonumber(ARGV[p + 2])) end
  if n < tonumber(ARGV[p + 1]) then return 0 end
  redis.call('DEL', KEYS[5])
  local lvl = redis.call('INCR', KEYS[6])
  local nsteps = #ARGV - (p + 3)
  local idx = math.min(lvl, nsteps)
  local block = tonumber(ARGV[p + 3 + idx])
  redis.call('PEXPIRE', KEYS[6], block + tonumber(ARGV[p + 3]))
  redis.call('SET', KEYS[4], string.format('%.0f', now + block), 'PX', block)
  return block
end
`;

/** KEYS: state, deny, allow, penalty, strikes, level. ARGV: now, emissionMs, capacity, cost, penaltyEnabled, threshold, strikeWindowMs, decayMs, steps... */
export const GCRA = `${PRELUDE}
local now = now_ms(tonumber(ARGV[1]))
local g = guards(now)
if g then return g end
local T = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local tat = tonumber(redis.call('GET', KEYS[1]))
if (not tat) or tat < now then tat = now end
local tau = T * cap
local newtat = tat + cost * T
local diff = newtat - now
if diff > tau + EPS then
  local remaining = math.max(0, math.floor((tau - (tat - now)) / T + EPS))
  local retry = math.max(1, math.ceil(diff - tau - EPS))
  local block = strike(now, 5)
  if block > 0 then return {2, 0, block, block} end
  return {1, remaining, math.ceil(tat - now), retry}
end
redis.call('SET', KEYS[1], string.format('%.3f', newtat), 'PX', math.ceil(diff) + 1000)
return {0, math.max(0, math.floor((tau - diff) / T + EPS)), math.ceil(diff), 0}
`;

/** KEYS: state(hash), deny, allow, penalty, strikes, level. ARGV: now, limit, windowMs, cost, mode(1 consume / 0 check), penaltyEnabled, threshold, strikeWindowMs, decayMs, steps... */
export const WINDOW = `${PRELUDE}
local now = now_ms(tonumber(ARGV[1]))
local g = guards(now)
if g then return g end
local limit = tonumber(ARGV[2])
local w = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local consume = ARGV[5] == '1'
local idx = math.floor(now / w)
local st = redis.call('HMGET', KEYS[1], 'i', 'c', 'p')
local i, c, p = tonumber(st[1]), tonumber(st[2]), tonumber(st[3])
if not i then i = idx; c = 0; p = 0
elseif idx == i + 1 then p = c; c = 0; i = idx
elseif idx > i + 1 then p = 0; c = 0; i = idx end
local elapsed = now - idx * w
local weight = (w - elapsed) / w
local est = p * weight + c
local allowed
if consume then allowed = est + cost <= limit + EPS else allowed = est < limit - EPS end
local reset = math.max(1, math.ceil(w - elapsed))
if allowed then
  if consume then
    c = c + cost
    redis.call('HSET', KEYS[1], 'i', i, 'c', c, 'p', p)
    redis.call('PEXPIRE', KEYS[1], 2 * w)
    est = est + cost
  end
  return {0, math.max(0, math.floor(limit - est + EPS)), reset, 0}
end
local need = cost
if not consume then need = 0 end
local retry
if consume and cost > limit then retry = w
else
  local room = limit - c - need
  if room >= 0 then
    local fneeded = 0
    if p > 0 then fneeded = 1 - room / p end
    local fnow = elapsed / w
    retry = math.max(0, (math.max(fneeded, fnow) - fnow) * w)
  else
    local roomnext = limit - need
    local fnext = 0
    if c > 0 then fnext = math.max(0, 1 - roomnext / c) end
    retry = w - elapsed + fnext * w
  end
end
retry = math.max(1, math.ceil(retry))
local remaining = math.max(0, math.floor(limit - est + EPS))
if consume then
  local block = strike(now, 6)
  if block > 0 then return {2, 0, block, block} end
end
return {1, remaining, reset, retry}
`;

/** KEYS: zset. ARGV: now, max, ttlMs, leaseId. Returns {ok, count, retryAfterMs}. */
export const ACQUIRE = `
local now = tonumber(ARGV[1])
if now == 0 then local t = redis.call('TIME'); now = t[1] * 1000 + math.floor(t[2] / 1000) end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, count, math.max(1, math.ceil(tonumber(first[2]) - now))}
end
redis.call('ZADD', KEYS[1], string.format('%.0f', now + tonumber(ARGV[3])), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, count + 1, 0}
`;

/** KEYS: marker. ARGV: ttlMs. Returns 1 the first time. */
export const ONCE = `
if redis.call('SET', KEYS[1], '1', 'PX', tonumber(ARGV[1]), 'NX') then return 1 end
return 0
`;
