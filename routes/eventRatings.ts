import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/event";
import EventRating from "../models/eventRating";
import {
  isEventEnded,
  resolveEventEndsAt,
} from "../utils/eventDateTime";
import { aggregateHostRatings } from "../services/ratingService";
import { isBlockedBetween } from "../services/blockService";

const router = Router();

const clampScore = (value: unknown): number | null => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    return null;
  }
  return n;
};

const isOnRoster = (event: any, userId: string): boolean =>
  (event.roster || []).some(
    (p: any) => p?.userId && String(p.userId) === String(userId),
  );

/**
 * Aggregate host ratings for one or many host ids.
 * Returns Map<hostId, { average, count }>.
 */
export { aggregateHostRatings };

// Pending ratings for the current user (ended events they attended, not rated).
router.get("/ratings/pending", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const userId = String(currentUser.id);
    const alreadyRated = await EventRating.find({ raterId: userId })
      .select("eventId")
      .lean();
    const ratedIds = new Set(
      alreadyRated.map((r) => String(r.eventId)),
    );

    // Recent events where the user was on the roster (not as creator).
    const candidates = await Event.find({
      "roster.userId": userId,
      createdBy: { $ne: userId },
    })
      .sort({ startsAt: -1, date: -1 })
      .limit(50)
      .lean();

    const now = Date.now();
    const pending = [];
    for (const event of candidates) {
      const eventId = String(event._id);
      if (ratedIds.has(eventId)) {
        continue;
      }
      if (
        !isEventEnded({
          startsAt: event.startsAt,
          date: event.date,
          time: event.time,
          timezoneOffsetMinutes: event.timezoneOffsetMinutes,
          durationMinutes: event.durationMinutes,
        }, now)
      ) {
        continue;
      }
      // Only prompt within ~14 days of ending so the inbox doesn't fill forever.
      const endsAt = resolveEventEndsAt({
        startsAt: event.startsAt,
        date: event.date,
        time: event.time,
        timezoneOffsetMinutes: event.timezoneOffsetMinutes,
        durationMinutes: event.durationMinutes,
      });
      if (endsAt && now - endsAt.getTime() > 14 * 24 * 60 * 60 * 1000) {
        continue;
      }
      pending.push({
        eventId,
        eventName: event.name,
        hostId: String(event.createdBy),
        hostUsername: event.createdByUsername || null,
        date: event.date,
        time: event.time,
        endsAt: endsAt?.toISOString() || null,
      });
    }

    return res.status(200).json({ success: true, pending });
  } catch (error) {
    console.error("Error fetching pending ratings:", error);
    return res.status(500).json({ message: "Failed to fetch pending ratings" });
  }
});

// Batch host rating summaries — used by roster to decorate avatars.
router.post("/ratings/hosts", async (req: Request, res: Response) => {
  try {
    const hostIds = Array.isArray(req.body?.hostIds)
      ? req.body.hostIds.map(String).slice(0, 100)
      : [];
    const map = await aggregateHostRatings(hostIds);
    const ratings: Record<string, { average: number; count: number }> = {};
    for (const [id, value] of map.entries()) {
      ratings[id] = value;
    }
    return res.status(200).json({ success: true, ratings });
  } catch (error) {
    console.error("Error fetching host ratings:", error);
    return res.status(500).json({ message: "Failed to fetch host ratings" });
  }
});

router.get("/:id/ratings/me", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid event id" });
    }

    const rating = await EventRating.findOne({
      eventId: req.params.id,
      raterId: String(currentUser.id),
    }).lean();

    return res.status(200).json({
      success: true,
      rated: !!rating,
      rating: rating || null,
    });
  } catch (error) {
    console.error("Error fetching own rating:", error);
    return res.status(500).json({ message: "Failed to fetch rating" });
  }
});

router.post("/:id/ratings", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid event id" });
    }

    const eventScore = clampScore(req.body?.eventScore);
    const hostScore = clampScore(req.body?.hostScore);
    if (eventScore === null || hostScore === null) {
      return res.status(400).json({
        message: "eventScore and hostScore must be integers from 1 to 5",
      });
    }

    const commentRaw =
      typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
    const comment = commentRaw ? commentRaw.slice(0, 500) : undefined;

    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const userId = String(currentUser.id);
    const hostId = String(event.createdBy);

    if (userId === hostId) {
      return res.status(403).json({ message: "You can't rate your own event" });
    }
    if (await isBlockedBetween(userId, hostId)) {
      return res.status(403).json({ message: "You can't rate this event" });
    }
    if (!isOnRoster(event, userId)) {
      return res
        .status(403)
        .json({ message: "Only attendees on the roster can rate this event" });
    }
    if (
      !isEventEnded({
        startsAt: event.startsAt,
        date: event.date,
        time: event.time,
        timezoneOffsetMinutes: event.timezoneOffsetMinutes,
        durationMinutes: event.durationMinutes,
      })
    ) {
      return res
        .status(400)
        .json({ message: "You can rate this event after it ends" });
    }

    try {
      const rating = await EventRating.create({
        eventId: event._id,
        raterId: userId,
        hostId,
        eventScore,
        hostScore,
        comment,
      });

      return res.status(201).json({ success: true, rating });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res
          .status(409)
          .json({ message: "You have already rated this event" });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error submitting rating:", error);
    return res.status(500).json({ message: "Failed to submit rating" });
  }
});

export default router;
