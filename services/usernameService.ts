import Event from "../models/event";
import User from "../models/user";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim();
}

export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return "Username must be 3–20 characters and use only letters, numbers, or underscores.";
  }
  return null;
}

export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    return "Name must be between 1 and 80 characters.";
  }
  return null;
}

/**
 * Rename a user and cascade denormalized username fields on events.
 */
export async function renameUser(
  userId: string,
  oldUsername: string,
  newUsername: string,
): Promise<void> {
  if (oldUsername === newUsername) {
    return;
  }

  const taken = await User.findOne({
    username: newUsername,
    _id: { $ne: userId },
  }).select("_id");
  if (taken) {
    throw new Error("USERNAME_TAKEN");
  }

  await User.findByIdAndUpdate(userId, { username: newUsername });

  await Promise.all([
    Event.updateMany(
      { createdByUsername: oldUsername },
      { $set: { createdByUsername: newUsername } },
    ),
    Event.updateMany(
      { "roster.username": oldUsername },
      { $set: { "roster.$[p].username": newUsername } },
      { arrayFilters: [{ "p.username": oldUsername }] },
    ),
    Event.updateMany(
      { "waitlist.username": oldUsername },
      { $set: { "waitlist.$[p].username": newUsername } },
      { arrayFilters: [{ "p.username": oldUsername }] },
    ),
    Event.updateMany(
      { "spotReservation.username": oldUsername },
      { $set: { "spotReservation.username": newUsername } },
    ),
    Event.updateMany(
      { "rsvps.username": oldUsername },
      { $set: { "rsvps.$[p].username": newUsername } },
      { arrayFilters: [{ "p.username": oldUsername }] },
    ),
    Event.updateMany(
      { "joinRequests.username": oldUsername },
      { $set: { "joinRequests.$[p].username": newUsername } },
      { arrayFilters: [{ "p.username": oldUsername }] },
    ),
    Event.updateMany(
      { "guestAddRequests.requestedByUsername": oldUsername },
      {
        $set: {
          "guestAddRequests.$[p].requestedByUsername": newUsername,
        },
      },
      { arrayFilters: [{ "p.requestedByUsername": oldUsername }] },
    ),
    Event.updateMany(
      { "guestAddRequests.proposedUsername": oldUsername },
      {
        $set: { "guestAddRequests.$[p].proposedUsername": newUsername },
      },
      { arrayFilters: [{ "p.proposedUsername": oldUsername }] },
    ),
  ]);
}
