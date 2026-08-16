import EventRating from "../models/eventRating";
import PlayerRating from "../models/playerRating";
import Event from "../models/event";

export type RatingSummary = { average: number; count: number };

/**
 * Aggregate host ratings (from post-event hostScore) for many user ids.
 */
export const aggregateHostRatings = async (
  hostIds: string[],
): Promise<Map<string, RatingSummary>> => {
  const unique = Array.from(new Set(hostIds.filter(Boolean).map(String)));
  const result = new Map<string, RatingSummary>();
  if (unique.length === 0) {
    return result;
  }

  const rows = await EventRating.aggregate([
    { $match: { hostId: { $in: unique } } },
    {
      $group: {
        _id: "$hostId",
        average: { $avg: "$hostScore" },
        count: { $sum: 1 },
      },
    },
  ]);

  for (const row of rows) {
    result.set(String(row._id), {
      average: Math.round(row.average * 10) / 10,
      count: row.count,
    });
  }
  return result;
};

/**
 * Aggregate peer player ratings for many user ids.
 */
export const aggregatePlayerRatings = async (
  userIds: string[],
): Promise<Map<string, RatingSummary>> => {
  const unique = Array.from(new Set(userIds.filter(Boolean).map(String)));
  const result = new Map<string, RatingSummary>();
  if (unique.length === 0) {
    return result;
  }

  const rows = await PlayerRating.aggregate([
    { $match: { rateeId: { $in: unique } } },
    {
      $group: {
        _id: "$rateeId",
        average: { $avg: "$score" },
        count: { $sum: 1 },
      },
    },
  ]);

  for (const row of rows) {
    result.set(String(row._id), {
      average: Math.round(row.average * 10) / 10,
      count: row.count,
    });
  }
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
