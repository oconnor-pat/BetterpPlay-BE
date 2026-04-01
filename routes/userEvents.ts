import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/event";
import User from "../models/user";

const router = Router();

router.get("/user/:id/events/created", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const events = await Event.find({ createdBy: userId })
      .sort({ date: -1 })
      .lean();

    const userIds = new Set<string>();
    events.forEach((event: any) => {
      event.likes?.forEach((id: string) => userIds.add(String(id)));
    });

    const objectIds = Array.from(userIds).map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return id;
      }
    });
    const users = await User.find({ _id: { $in: objectIds } })
      .select("username")
      .lean();
    const userNameMap = new Map<string, string>();
    users.forEach((u: any) => {
      userNameMap.set(u._id.toString(), u.username || "");
    });

    const eventsWithLikedBy = events.map((event: any) => ({
      ...event,
      likedByUsernames: (event.likes || [])
        .map((id: string) => userNameMap.get(String(id)))
        .filter((name: string | undefined): name is string => !!name),
    }));

    return res.status(200).json({
      success: true,
      events: eventsWithLikedBy,
      count: eventsWithLikedBy.length,
    });
  } catch (error) {
    console.error("Error fetching created events:", error);
    return res.status(500).json({ message: "Failed to fetch created events" });
  }
});

router.get("/user/:id/events/joined", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;

    const user = await User.findById(userId).select("username");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const events = await Event.find({
      "roster.username": user.username,
      createdBy: { $ne: userId },
    })
      .sort({ date: -1 })
      .lean();

    const likerIds = new Set<string>();
    events.forEach((event: any) => {
      event.likes?.forEach((id: string) => likerIds.add(String(id)));
    });

    const objectIds = Array.from(likerIds).map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return id;
      }
    });
    const users = await User.find({ _id: { $in: objectIds } })
      .select("username")
      .lean();
    const userNameMap = new Map<string, string>();
    users.forEach((u: any) => {
      userNameMap.set(u._id.toString(), u.username || "");
    });

    const eventsWithLikedBy = events.map((event: any) => ({
      ...event,
      likedByUsernames: (event.likes || [])
        .map((id: string) => userNameMap.get(String(id)))
        .filter((name: string | undefined): name is string => !!name),
    }));

    return res.status(200).json({
      success: true,
      events: eventsWithLikedBy,
      count: eventsWithLikedBy.length,
    });
  } catch (error) {
    console.error("Error fetching joined events:", error);
    return res.status(500).json({ message: "Failed to fetch joined events" });
  }
});

router.get("/user/:id/events/stats", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;

    const user = await User.findById(userId).select("username");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const createdCount = await Event.countDocuments({ createdBy: userId });

    const joinedCount = await Event.countDocuments({
      "roster.username": user.username,
      createdBy: { $ne: userId },
    });

    return res.status(200).json({
      success: true,
      created: createdCount,
      joined: joinedCount,
    });
  } catch (error) {
    console.error("Error fetching event stats:", error);
    return res.status(500).json({ message: "Failed to fetch event stats" });
  }
});

router.put("/events/:id/roster", async (req: Request, res: Response) => {
  const eventId = req.params.id;
  const { roster } = req.body;
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    event.roster = roster;
    event.rosterSpotsFilled = roster.length;
    await event.save();
    return res.status(200).json({ success: true, roster: event.roster });
  } catch (error) {
    console.error("Error updating event roster:", error);
    return res.status(500).json({ message: "Error updating event roster" });
  }
});

export default router;
