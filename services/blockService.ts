// Blocking is enforced by hiding people from each other on read.
//
// The central idea is that a block is *mutually* invisible: if I block
// you, I stop seeing you and you stop seeing me. Enforcing it one way
// only would make blocking self-defeating, since the blocked person
// would still see the blocker's events, comments and profile and could
// keep interacting through them.
//
// Every read path that surfaces one user to another asks for the set of
// ids hidden from the viewer and filters against it. Doing this on read
// rather than mutating data on block means unblocking restores
// everything, and nothing is destroyed by a block made in anger.

import mongoose from "mongoose";
import Block from "../models/block";

// Ids the viewer must not see, in either direction. Callers use this for
// `$nin` filters or in-memory rejection.
export const getHiddenUserIds = async (
  viewerId: string,
): Promise<Set<string>> => {
  const rows = await Block.find({
    $or: [{ blockerId: String(viewerId) }, { blockedId: String(viewerId) }],
  })
    .select("blockerId blockedId")
    .lean();

  const hidden = new Set<string>();
  for (const row of rows) {
    const other =
      String(row.blockerId) === String(viewerId)
        ? String(row.blockedId)
        : String(row.blockerId);
    hidden.add(other);
  }
  return hidden;
};

// Same set, as ObjectIds, for queries against ObjectId-typed fields.
// Ids that aren't valid ObjectIds are dropped rather than throwing —
// some collections store user ids as plain strings.
export const toObjectIds = (ids: Iterable<string>): mongoose.Types.ObjectId[] =>
  Array.from(ids)
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

// Is there a block between these two, in either direction? Used on write
// paths (send a DM, add to a group, send a friend request) where the
// answer gates a single action.
export const isBlockedBetween = async (
  a: string,
  b: string,
): Promise<boolean> => {
  if (String(a) === String(b)) {
    return false;
  }
  const existing = await Block.exists({
    $or: [
      { blockerId: String(a), blockedId: String(b) },
      { blockerId: String(b), blockedId: String(a) },
    ],
  });
  return !!existing;
};

// Did this specific user do the blocking? Distinguishes "you blocked
// them" (offer Unblock) from "they blocked you" (say nothing — telling
// someone they've been blocked is exactly the information a blocked
// person shouldn't get).
export const hasBlocked = async (
  blockerId: string,
  blockedId: string,
): Promise<boolean> => {
  const existing = await Block.exists({
    blockerId: String(blockerId),
    blockedId: String(blockedId),
  });
  return !!existing;
};

// Both directions in one query, for callers that need to tell the two
// cases apart — a viewer who blocked someone gets an explanation and an
// Unblock affordance, while a viewer who was blocked gets the same
// response as if the account didn't exist.
export const getPairState = async (
  viewerId: string,
  otherId: string,
): Promise<{ iBlocked: boolean; theyBlocked: boolean }> => {
  if (String(viewerId) === String(otherId)) {
    return { iBlocked: false, theyBlocked: false };
  }
  const rows = await Block.find({
    $or: [
      { blockerId: String(viewerId), blockedId: String(otherId) },
      { blockerId: String(otherId), blockedId: String(viewerId) },
    ],
  })
    .select("blockerId")
    .lean();

  return {
    iBlocked: rows.some((r) => String(r.blockerId) === String(viewerId)),
    theyBlocked: rows.some((r) => String(r.blockerId) === String(otherId)),
  };
};

export default {
  getHiddenUserIds,
  toObjectIds,
  isBlockedBetween,
  hasBlocked,
  getPairState,
};
