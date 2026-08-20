import EventRating from "../models/eventRating";
import PlayerRating from "../models/playerRating";
import Event from "../models/event";
import { getHiddenUserIds } from "./blockService";

export type RatingSummary = { average: number; count: number };

/**
 * Aggregate host ratings (from post-event hostScore) for many user ids.
 * Ratings from users blocked with the host are excluded so a block drops
 * that person's contribution to averages (and unblocking restores it).
 */
export const aggregateHostRatings = async (
  hostIds: string[],
): Promise<Map<string, RatingSummary>> => {
  const unique = Array.from(new Set(hostIds.filter(Boolean).map(String)));
  const result = new Map<string, RatingSummary>();
  if (unique.length === 0) {
    return result;
  }

  await Promise.all(
    unique.map(async (hostId) => {
      const hidden = await getHiddenUserIds(hostId);
      const match: Record<string, unknown> = { hostId };
      if (hidden.size > 0) {
        match.raterId = { $nin: Array.from(hidden) };
      }
      const rows = await EventRating.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$hostId",
            average: { $avg: "$hostScore" },
            count: { $sum: 1 },
          },
        },
      ]);
      if (rows[0]) {
        result.set(hostId, {
          average: Math.round(rows[0].average * 10) / 10,
          count: rows[0].count,
        });
      }
    }),
  );

  return result;
};

/**
 * Aggregate peer player ratings for many user ids.
 * Same block exclusion as host ratings.
 */
export const aggregatePlayerRatings = async (
  userIds: string[],
): Promise<Map<string, RatingSummary>> => {
  const unique = Array.from(new Set(userIds.filter(Boolean).map(String)));
  const result = new Map<string, RatingSummary>();
  if (unique.length === 0) {
    return result;
  }

  await Promise.all(
    unique.map(async (rateeId) => {
      const hidden = await getHiddenUserIds(rateeId);
      const match: Record<string, unknown> = { rateeId };
      if (hidden.size > 0) {
        match.raterId = { $nin: Array.from(hidden) };
      }
      const rows = await PlayerRating.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$rateeId",
            average: { $avg: "$score" },
            count: { $sum: 1 },
          },
        },
      ]);
      if (rows[0]) {
        result.set(rateeId, {
          average: Math.round(rows[0].average * 10) / 10,
          count: rows[0].count,
        });
      }
    }),
  );

  return result;
};

/** True if both users appear on the same event roster at least once,
 *  or one hosted an event the other attended. */
export const haveSharedRoster = async (
  userA: string,
  userB: string,
): Promise<boolean> => {
  if (!userA || !userB || userA === userB) {
    return false;
  }
  const shared = await Event.exists({
    $or: [
      {
        $and: [{ "roster.userId": userA }, { "roster.userId": userB }],
      },
      { createdBy: userA, "roster.userId": userB },
      { createdBy: userB, "roster.userId": userA },
    ],
  });
  return !!shared;
};

export default {
  aggregateHostRatings,
  aggregatePlayerRatings,
  haveSharedRoster,
};
