import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/event";
import EventRating from "../models/eventRating";
import PlayerRating from "../models/playerRating";
import User from "../models/user";
import {
  aggregateHostRatings,
  aggregatePlayerRatings,
  haveSharedRoster,
} from "../services/ratingService";
import { getHiddenUserIds, isBlockedBetween } from "../services/blockService";

const router = Router();

const clampScore = (value: unknown): number | null => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    return null;
  }
  return n;
};

const emptyBreakdown = (): Record<string, number> => ({
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0,
  "5": 0,
});

const buildBreakdown = (scores: number[]): Record<string, number> => {
  const breakdown = emptyBreakdown();
  for (const score of scores) {
    const key = String(Math.round(score));
    if (breakdown[key] !== undefined) {
      breakdown[key] += 1;
    }
  }
  return breakdown;
};

const enrichRaters = async (
  raterIds: string[],
): Promise<
  Map<string, { id: string; username: string; profilePicUrl?: string }>
> => {
  const unique = Array.from(new Set(raterIds.filter(Boolean).map(String)));
  const map = new Map<
    string,
    { id: string; username: string; profilePicUrl?: string }
  >();
  if (unique.length === 0) {
    return map;
  }

  const objectIds = unique
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const users = await User.find({ _id: { $in: objectIds } })
    .select("username profilePicUrl")
    .lean();

  for (const user of users as any[]) {
    map.set(String(user._id), {
      id: String(user._id),
      username: user.username || "User",
      profilePicUrl: user.profilePicUrl,
    });
  }
  return map;
};

// Rate (or update) someone as a player.
router.post("/user/:id/player-rating", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const rateeId = String(req.params.id);
    const raterId = String(currentUser.id);

    if (rateeId === raterId) {
      return res.status(403).json({ message: "You can't rate yourself" });
    }
    if (!mongoose.Types.ObjectId.isValid(rateeId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (await isBlockedBetween(raterId, rateeId)) {
      return res.status(403).json({ message: "You can't rate this player" });
    }

    const score = clampScore(req.body?.score);
    if (score === null) {
      return res
        .status(400)
        .json({ message: "score must be an integer from 1 to 5" });
    }

    const shared = await haveSharedRoster(raterId, rateeId);
    if (!shared) {
      return res.status(403).json({
        message:
          "You can only rate players you've been on an event roster with",
      });
    }

    const commentRaw =
      typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
    const comment = commentRaw ? commentRaw.slice(0, 500) : undefined;
    const eventId =
      req.body?.eventId && mongoose.Types.ObjectId.isValid(req.body.eventId)
        ? req.body.eventId
        : undefined;

    const existing = await PlayerRating.findOne({ raterId, rateeId }).lean();
    if (existing) {
      return res.status(409).json({
        message:
          "You've already rated this player. Each person can leave one review.",
      });
    }

    try {
      const rating = await PlayerRating.create({
        raterId,
        rateeId,
        score,
        comment,
        ...(eventId ? { eventId } : {}),
      });
      return res.status(201).json({ success: true, rating });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(409).json({
          message:
            "You've already rated this player. Each person can leave one review.",
        });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error submitting player rating:", error);
    return res.status(500).json({ message: "Failed to submit player rating" });
  }
});

// Whether the current user can rate this person + their existing rating.
router.get(
  "/user/:id/player-rating/me",
  async (req: Request, res: Response) => {
    try {
      const currentUser = (req as any).user;
      if (!currentUser?.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const rateeId = String(req.params.id);
      const raterId = String(currentUser.id);

      if (rateeId === raterId) {
        return res.status(200).json({
          success: true,
          canRate: false,
          rated: false,
          rating: null,
        });
      }

      const canRate = await haveSharedRoster(raterId, rateeId);
      const existing = await PlayerRating.findOne({ raterId, rateeId }).lean();

      return res.status(200).json({
        success: true,
        canRate,
        rated: !!existing,
        rating: existing || null,
      });
    } catch (error) {
      console.error("Error fetching player rating status:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch player rating status" });
    }
  },
);

/**
 * Detailed reviews + star breakdown for a user's host or player ratings.
 * GET /user/:id/ratings/:kind  kind = host | player
 */
router.get(
  "/user/:id/ratings/:kind",
  async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.id);
      const kind = String(req.params.kind || "").toLowerCase();
      if (kind !== "host" && kind !== "player") {
        return res
          .status(400)
          .json({ message: "kind must be 'host' or 'player'" });
      }
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id" });
      }

      const viewerId = (req as any).user?.id
        ? String((req as any).user.id)
        : null;
      const hiddenForSubject = await getHiddenUserIds(userId);
      const hiddenForViewer = viewerId
        ? await getHiddenUserIds(viewerId)
        : new Set<string>();
      const excludedRaters = Array.from(
        new Set([...hiddenForSubject, ...hiddenForViewer]),
      );
      const raterFilter =
        excludedRaters.length > 0
          ? { raterId: { $nin: excludedRaters } }
          : {};

      if (kind === "host") {
        const rows = await EventRating.find({ hostId: userId, ...raterFilter })
          .sort({ createdAt: -1 })
          .limit(100)
          .lean();

        const summary = (await aggregateHostRatings([userId])).get(userId) || {
          average: 0,
          count: 0,
        };
        const scores = rows.map((r) => r.hostScore);
        const raterMap = await enrichRaters(rows.map((r) => String(r.raterId)));

        const eventIds = rows
          .map((r) => r.eventId)
          .filter(Boolean)
          .map((id) => String(id));
        const events = await Event.find({ _id: { $in: eventIds } })
          .select("name")
          .lean();
        const eventNameMap = new Map(
          events.map((e: any) => [String(e._id), e.name as string]),
        );

        const reviews = rows.map((r) => {
          const rater = raterMap.get(String(r.raterId));
          return {
            id: String(r._id),
            score: r.hostScore,
            eventScore: r.eventScore,
            comment: r.comment || null,
            createdAt: r.createdAt,
            eventId: r.eventId ? String(r.eventId) : null,
            eventName: r.eventId
              ? eventNameMap.get(String(r.eventId)) || null
              : null,
            rater: rater || {
              id: String(r.raterId),
              username: "User",
            },
          };
        });

        return res.status(200).json({
          success: true,
          kind: "host",
          average: summary.count > 0 ? summary.average : null,
          count: summary.count,
          breakdown: buildBreakdown(scores),
          reviews,
        });
      }

      const rows = await PlayerRating.find({ rateeId: userId, ...raterFilter })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      const summary = (await aggregatePlayerRatings([userId])).get(userId) || {
        average: 0,
        count: 0,
      };
      const scores = rows.map((r) => r.score);
      const raterMap = await enrichRaters(rows.map((r) => String(r.raterId)));

      const reviews = rows.map((r) => {
        const rater = raterMap.get(String(r.raterId));
        return {
          id: String(r._id),
          score: r.score,
          comment: r.comment || null,
          createdAt: r.createdAt,
          eventId: r.eventId ? String(r.eventId) : null,
          eventName: null,
          rater: rater || {
            id: String(r.raterId),
            username: "User",
          },
        };
      });

      return res.status(200).json({
        success: true,
        kind: "player",
        average: summary.count > 0 ? summary.average : null,
        count: summary.count,
        breakdown: buildBreakdown(scores),
        reviews,
      });
    } catch (error) {
      console.error("Error fetching rating details:", error);
      return res.status(500).json({ message: "Failed to fetch rating details" });
    }
  },
);

// Batch player rating summaries for roster chips.
router.post(
  "/users/player-ratings/summary",
  async (req: Request, res: Response) => {
    try {
      const userIds = Array.isArray(req.body?.userIds)
        ? req.body.userIds.map(String).slice(0, 100)
        : [];
      const map = await aggregatePlayerRatings(userIds);
      const ratings: Record<string, { average: number; count: number }> = {};
      for (const [id, value] of map.entries()) {
        ratings[id] = value;
      }

      const raterId = (req as any).user?.id
        ? String((req as any).user.id)
        : null;
      let ratedByMe: string[] = [];
      if (raterId && userIds.length > 0) {
        const mine = await PlayerRating.find({
          raterId,
          rateeId: { $in: userIds },
        })
          .select("rateeId")
          .lean();
        ratedByMe = mine.map((r) => String(r.rateeId));
      }

      return res.status(200).json({ success: true, ratings, ratedByMe });
    } catch (error) {
      console.error("Error fetching player rating summaries:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch player rating summaries" });
    }
  },
);

export default router;
