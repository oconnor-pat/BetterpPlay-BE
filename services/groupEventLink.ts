// Keeps recurring events in sync with their attached Group's roster.
//
// Background: when a user creates a recurring event with a Group
// attached (the "trivia crew" scenario), our event-creation route
// pre-generates N future-dated instances and snapshots the Group's
// members into each one's `invitedUsers`. That snapshot is fine for the
// initial series, but the whole point of the Group primitive is that
// adding someone to the trivia crew on Tuesday should automatically
// invite them to next Tuesday's trivia. This service is the live link.
//
// Mental model:
// - Past instances are immutable snapshots — they were what they were
//   on the day they happened, and we never rewrite history.
// - Future instances re-pull the Group's current member list whenever
//   the Group changes. Per-instance edits (e.g. adding one extra
//   person to this Friday's game) are real and they stick — until the
//   next Group-membership change overwrites them. That trade-off
//   matches the "rituals don't die" intent: the Group is the
//   recurring audience, individual-instance edits are exceptions.
// - Renaming the Group refreshes the cached `groupName` so the "via
//   [Group]" badge always reads correctly without a join at read time.
//
// PR 4 will call these helpers from every member-mutation route
// (add/remove/promote/demote). For PR 3 they exist and are invoked
// from the delete path so a deleted group cleanly detaches from its
// future events.

import Event from "../models/event";
import Group from "../models/group";

// `today()` returns a YYYY-MM-DD string matching the format we store on
// the Event document, so the `>= today` filter is a string compare.
const todayString = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Re-resolve a Group's current member list and push it onto every
// future-dated recurring event that points at that group. Idempotent —
// safe to call multiple times in a row.
export const refreshRecurringInvitesForGroup = async (
  groupId: string,
): Promise<void> => {
  const group = await Group.findById(groupId).lean();
  if (!group) return;

  const memberIds = ((group.members as any[]) || [])
    .map((m) => String(m.userId))
    .filter(Boolean);

  // Excluding the event creator from invitedUsers matches the same
  // convention the create route uses — the creator is implicitly on
  // their own event.
  const events = await Event.find({
    groupId: String(group._id),
    isRecurring: true,
    date: { $gte: todayString() },
  });

  await Promise.all(
    events.map(async (evt: any) => {
      const filtered = memberIds.filter(
        (id) => id !== String(evt.createdBy),
      );
      evt.invitedUsers = filtered;
      evt.groupName = group.name;
      await evt.save();
    }),
  );
};

// Called when a Group is deleted. We don't delete the events — they
// were planned with this audience in mind and they should still happen
// — but we clear both the `groupId` reference and the cached
// `groupName` so the event card stops rendering a dangling group label.
// Earlier versions kept `groupName` as a tombstone for narrative
// context, but in practice a name without a working link (and without
// the avatar strip, which requires a live groupId to resolve) read as a
// bug to users. The event itself still carries the full story via its
// title, date, location, and invitee list — losing the group shorthand
// doesn't lose meaning.
export const detachGroupFromEvents = async (
  groupId: string,
): Promise<void> => {
  await Event.updateMany(
    { groupId: String(groupId) },
    { $unset: { groupId: "", groupName: "" } },
  );
};

export default {
  refreshRecurringInvitesForGroup,
  detachGroupFromEvents,
};
