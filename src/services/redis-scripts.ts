/**
 * Lua script: price-range filtering performed entirely inside Redis.
 *
 *   KEYS[1] = staysync:hotels:{city}        (sorted set: member = hotel key, score = price)
 *   KEYS[2] = staysync:hotels:{city}:data   (hash: hotel key → offer JSON)
 *   KEYS[3] = staysync:hotels:{city}:meta   (string: metadata JSON)
 *   ARGV[1] = min price ("-inf" when not given)   — inclusive
 *   ARGV[2] = max price ("+inf" when not given)   — inclusive
 *
 * Returns nil on a cache miss, otherwise { metaJson, offerJson1, offerJson2, … }
 * in ascending price order (equal prices ordered by hotel key).
 *
 * Runs atomically: a concurrent refresh (MULTI/EXEC) can never be observed half-done.
 * Treated as a miss (nil) so the caller refreshes instead of serving bad data:
 *   - meta missing                     → never cached, or expired
 *   - meta unreadable                  → corrupted
 *   - ZCARD ≠ meta.count               → keys out of sync (e.g. tampered)
 *   - a member has no JSON in the hash → keys out of sync
 * Requires Redis ≥ 6.2 for ZRANGE … BYSCORE.
 */
export const FILTER_HOTELS_BY_PRICE_LUA = `
local meta = redis.call('GET', KEYS[3])
if not meta then
  return nil
end

local ok, decoded = pcall(cjson.decode, meta)
if not ok or type(decoded) ~= 'table' or type(decoded.count) ~= 'number' then
  return nil
end
if redis.call('ZCARD', KEYS[1]) ~= decoded.count then
  return nil
end

local members = redis.call('ZRANGE', KEYS[1], ARGV[1], ARGV[2], 'BYSCORE')
local result = { meta }

-- HMGET in batches: unpack() of a very large list can exceed Lua's stack.
local BATCH = 500
for first = 1, #members, BATCH do
  local last = math.min(first + BATCH - 1, #members)
  local values = redis.call('HMGET', KEYS[2], unpack(members, first, last))
  for i = 1, #values do
    if not values[i] then
      return nil
    end
    result[#result + 1] = values[i]
  end
end

return result
`;
