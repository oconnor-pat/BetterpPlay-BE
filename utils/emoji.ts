// Shared validation for user-supplied reaction emoji. Used by event
// reactions (routes/events.ts), group chat messages (routes/groups.ts)
// and direct messages (routes/dm.ts) so the surfaces can't drift apart on
// what counts as an acceptable reaction.

// Caps on a single message's reactions. Distinct emoji are limited so the
// pill row stays renderable; the per-user cap stops one person filling it.
export const MAX_DISTINCT_REACTIONS_PER_MESSAGE = 20;
export const MAX_REACTIONS_PER_USER_PER_MESSAGE = 20;

// Any emoji is allowed (the client ships a full picker), so this can't be a
// whitelist check. Instead: reject anything with ASCII letters and require at
// least one non-ASCII code point, which keeps arbitrary text out of a field
// clients render verbatim. The length cap is by code point because ZWJ
// sequences, skin-tone modifiers and flags legitimately run several deep.
export const isValidEmoji = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > 16) {
    return false;
  }
  if (/[a-zA-Z]/.test(trimmed)) {
    return false;
  }
  return /[^\x00-\x7F]/.test(trimmed);
};
