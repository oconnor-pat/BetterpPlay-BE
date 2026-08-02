// Shared validation for user-supplied reaction emoji. Used by both event
// reactions (routes/events.ts) and group chat message reactions
// (routes/groups.ts) so the two surfaces can't drift apart on what counts
// as an acceptable reaction.

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
