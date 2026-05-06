import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/event";
import User from "../models/user";
import communityNote from "../models/communityNote";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const currentUserId = currentUser?.id;

    // Optional filter — used by the Venues tab to populate a venue's
    // "Happening here" feed. Matches either:
    //   1. events explicitly linked via venueId (planned through the
    //      Venues-tab bridge), OR
    //   2. events whose lat/lng falls within a tight box around the venue's
    //      coordinates (catches events created via the regular `+` FAB
    //      where the user picked the same place via Google Places
    //      autocomplete — those events end up with identical coordinates
    //      to the venue but no venueId link).
    // Privacy rules below still apply, so private/invite-only events are
    // hidden from outsiders.
    const {
      venueId,
      lat: latRaw,
      lng: lngRaw,
    } = req.query as { venueId?: string; lat?: string; lng?: string };

    const lat = latRaw ? parseFloat(latRaw) : NaN;
    const lng = lngRaw ? parseFloat(lngRaw) : NaN;
    // ~55m at 40°N. Tight enough to avoid bleeding into adjacent businesses,
    // generous enough to absorb GPS jitter and slight pin offsets.
    const COORD_TOLERANCE = 0.0005;

    const venueClauses: Record<string, unknown>[] = [];
    if (venueId && typeof venueId === "string") {
      venueClauses.push({ venueId });
    }
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      venueClauses.push({
        latitude: { $gte: lat - COORD_TOLERANCE, $lte: lat + COORD_TOLERANCE },
        longitude: { $gte: lng - COORD_TOLERANCE, $lte: lng + COORD_TOLERANCE },
      });
    }
    const baseQuery: Record<string, unknown> =
      venueClauses.length > 0 ? { $or: venueClauses } : {};

    const allEvents = await Event.find(baseQuery).lean();

    const visibleEvents = allEvents.filter((event: any) => {
      const privacy = event.privacy || "public";

      if (privacy === "public") {
        return true;
      }

      if (!currentUserId) {
        return false;
      }

      const eventCreatorId = String(event.createdBy);
      const userId = String(currentUserId);

      if (privacy === "private") {
        return eventCreatorId === userId;
      }

      if (privacy === "invite-only") {
        const invitedUsers = (event.invitedUsers || []).map((id: any) =>
          String(id),
        );
        return eventCreatorId === userId || invitedUsers.includes(userId);
      }

      return false;
    });

    const userIds = new Set<string>();
    visibleEvents.forEach((event: any) => {
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

    const eventIds = visibleEvents.map((e: any) => e._id.toString());
    const commentCounts = await communityNote.aggregate([
      { $match: { eventId: { $in: eventIds } } },
      {
        $project: {
          eventId: 1,
          commentCount: { $size: { $ifNull: ["$comments", []] } },
        },
      },
    ]);
    const commentCountMap = new Map<string, number>();
    commentCounts.forEach((c: any) => {
      commentCountMap.set(c.eventId, c.commentCount);
    });

    const eventsWithLikedBy = visibleEvents.map((event: any) => ({
      ...event,
      likedByUsernames: (event.likes || [])
        .map((id: string) => userNameMap.get(String(id)))
        .filter((name: string | undefined): name is string => !!name),
      commentCount: commentCountMap.get(event._id.toString()) || 0,
    }));

    res.status(200).json(eventsWithLikedBy);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const event = await Event.findById(req.params.id).lean();
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const currentUser = (req as any).user;
    const currentUserId = currentUser?.id ? String(currentUser.id) : null;
    const privacy = (event as any).privacy || "public";
    const invitedUsers = ((event as any).invitedUsers || []).map((id: any) =>
      String(id),
    );
    const eventCreatorId = String((event as any).createdBy);

    if (privacy === "private") {
      if (!currentUserId || eventCreatorId !== currentUserId) {
        return res.status(403).json({ message: "This event is private" });
      }
    } else if (privacy === "invite-only") {
      if (
        !currentUserId ||
        (eventCreatorId !== currentUserId &&
          !invitedUsers.includes(currentUserId))
      ) {
        return res
          .status(403)
          .json({ message: "You are not invited to this event" });
      }
    }

    const likerIds = ((event as any).likes || []).map((id: string) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return id;
      }
    });
    const likers = await User.find({ _id: { $in: likerIds } })
      .select("username")
      .lean();
    const likedByUsernames = ((event as any).likes || [])
      .map((id: string) => {
        const user = likers.find((u: any) => u._id.toString() === String(id));
        return user?.username;
      })
      .filter((name: string | undefined): name is string => !!name);

    res.status(200).json({ ...event, likedByUsernames });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch event" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      name,
      location,
      time,
      date,
      totalSpots,
      eventType,
      createdBy,
      createdByUsername,
      latitude,
      longitude,
      jerseyColors,
      privacy,
      invitedUsers,
      isRecurring,
      recurrenceFrequency,
      recurrenceCount,
      venueId,
      venueName,
      sourceUrl,
    } = req.body;

    if (
      !name ||
      !location ||
      !time ||
      !date ||
      !totalSpots ||
      !eventType ||
      !createdBy
    ) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const VALID_EVENT_TYPES = [
      "Basketball",
      "Soccer",
      "Football",
      "Baseball",
      "Softball",
      "Tennis",
      "Pickleball",
      "Volleyball",
      "Hockey",
      "Golf",
      "Swimming",
      "Running",
      "Bowling",
      "Table Tennis",
      "Badminton",
      "Cricket",
      "Rugby",
      "Lacrosse",
      "Wrestling",
      "Skateboarding",
      "Surfing",
      "Climbing",
      "Martial Arts",
      "Frisbee",
      "Handball",
      "Trivia Night",
      "Game Night",
      "Karaoke",
      "Open Mic",
      "Watch Party",
      "Potluck",
      "Meetup",
      "Happy Hour",
      "Dance Social",
      "Speed Friending",
      "Hiking",
      "Cycling",
      "Yoga in the Park",
      "Kayaking",
      "Fishing",
      "Camping",
      "Trail Running",
      "Bird Watching",
      "Beach Day",
      "Outdoor Yoga",
      "Book Club",
      "Workshop",
      "Volunteer",
      "Cleanup",
      "Fundraiser",
      "Study Group",
      "Art Jam",
      "Farmers Market",
      "Community Garden",
      "Skill Share",
      "Other",
    ];

    if (!VALID_EVENT_TYPES.includes(eventType)) {
      console.warn(`Unrecognized eventType: "${eventType}" — allowing anyway`);
    }

    const user = await User.findById(createdBy);
    if (!user) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const validPrivacy = ["public", "private", "invite-only"];
    const eventPrivacy = validPrivacy.includes(privacy) ? privacy : "public";

    const baseEventData = {
      name,
      location,
      time,
      totalSpots,
      eventType,
      createdBy,
      createdByUsername: createdByUsername || user.username,
      rosterSpotsFilled: 0,
      roster: [],
      latitude,
      longitude,
      jerseyColors: jerseyColors || [],
      privacy: eventPrivacy,
      invitedUsers: invitedUsers || [],
      // Optional venue listing reference (set when a user planned this event
      // from the Venues tab via "Plan event from this page").
      venueId: venueId || undefined,
      venueName: venueName || undefined,
      sourceUrl: sourceUrl || undefined,
    };

    if (isRecurring && recurrenceFrequency && recurrenceCount > 1) {
      const recurrenceGroupId = new mongoose.Types.ObjectId().toString();
      const count = Math.min(Math.max(parseInt(recurrenceCount), 2), 12);
      const eventsToCreate = [];

      for (let i = 0; i < count; i++) {
        const eventDate = new Date(date);
        if (recurrenceFrequency === "weekly") {
          eventDate.setDate(eventDate.getDate() + i * 7);
        } else if (recurrenceFrequency === "biweekly") {
          eventDate.setDate(eventDate.getDate() + i * 14);
        } else if (recurrenceFrequency === "monthly") {
          eventDate.setMonth(eventDate.getMonth() + i);
        }

        eventsToCreate.push({
          ...baseEventData,
          date: eventDate.toISOString().split("T")[0],
          isRecurring: true,
          recurrenceGroupId,
          recurrenceFrequency,
        });
      }

      const newEvents = await Event.insertMany(eventsToCreate);

      if (invitedUsers && Array.isArray(invitedUsers) && invitedUsers.length > 0) {
        const currentUser = (req as any).user;
        notificationService.sendPushNotificationToMany(
          invitedUsers,
          "Event Invitation 📩",
          `You've been invited to "${name}" (${count} recurring events)`,
          "event_invitation",
          {
            eventId: newEvents[0]._id.toString(),
            eventName: name,
            invitedBy: (currentUser?.id || createdBy).toString(),
          },
        );
      }

      socketService.emitToAll("events:refresh", { reason: "created" });
      res.status(201).json(newEvents);
    } else {
      const newEvent = await Event.create({
        ...baseEventData,
        date,
      });

      if (invitedUsers && Array.isArray(invitedUsers) && invitedUsers.length > 0) {
        const currentUser = (req as any).user;
        notificationService.sendPushNotificationToMany(
          invitedUsers,
          "Event Invitation 📩",
          `You've been invited to "${name}"`,
          "event_invitation",
          {
            eventId: newEvent._id.toString(),
            eventName: name,
            invitedBy: (currentUser?.id || createdBy).toString(),
          },
        );
      }

      socketService.emitToAll("events:refresh", { reason: "created" });
      res.status(201).json(newEvent);
    }
  } catch (error) {
    console.error("Error creating event:", error);
    res.status(500).json({ message: "Failed to create event" });
  }
});

router.put("/:id", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.id;
    const {
      name,
      location,
      time,
      date,
      totalSpots,
      eventType,
      createdByUsername,
      latitude,
      longitude,
      jerseyColors,
      privacy,
      invitedUsers,
    } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const oldValues: Record<string, any> = {
      name: event.name,
      date: event.date,
      time: event.time,
      location: event.location,
      totalSpots: event.totalSpots,
      eventType: event.eventType,
    };

    event.name = name || event.name;
    event.location = location || event.location;
    event.time = time || event.time;
    event.date = date || event.date;
    event.totalSpots = totalSpots || event.totalSpots;
    event.eventType = eventType || event.eventType;
    event.createdByUsername = createdByUsername || event.createdByUsername;

    if (latitude !== undefined) event.latitude = latitude;
    if (longitude !== undefined) event.longitude = longitude;
    if (jerseyColors !== undefined) event.jerseyColors = jerseyColors;

    if (privacy !== undefined) {
      const validPrivacy = ["public", "private", "invite-only"];
      if (validPrivacy.includes(privacy)) {
        event.privacy = privacy;
      }
    }
    const previousInvitedUsers = [...(event.invitedUsers || [])];
    if (invitedUsers !== undefined) {
      event.invitedUsers = invitedUsers;
    }

    await event.save();

    if (invitedUsers !== undefined) {
      const newlyInvited = invitedUsers.filter(
        (id: string) => !previousInvitedUsers.includes(id),
      );
      if (newlyInvited.length > 0) {
        const currentUser = (req as any).user;
        notificationService.sendPushNotificationToMany(
          newlyInvited,
          "Event Invitation 📩",
          `You've been invited to "${event.name}"`,
          "event_invitation",
          {
            eventId: event._id.toString(),
            eventName: event.name,
            invitedBy: currentUser?.id || String(event.createdBy),
          },
        );
      }
    }

    const newValues: Record<string, any> = {
      name: event.name,
      date: event.date,
      time: event.time,
      location: event.location,
      totalSpots: event.totalSpots,
      eventType: event.eventType,
    };

    const fieldLabels: Record<string, string> = {
      name: "name",
      date: "date",
      time: "time",
      location: "location",
      totalSpots: "total spots",
      eventType: "activity type",
    };

    const changedFields: string[] = [];
    const changeDescriptions: string[] = [];
    for (const key of Object.keys(oldValues)) {
      if (String(oldValues[key]) !== String(newValues[key])) {
        changedFields.push(key);
        changeDescriptions.push(
          `${fieldLabels[key]} changed to '${newValues[key]}'`,
        );
      }
    }

    if (event.roster && event.roster.length > 0) {
      const participantUserIds = event.roster
        .filter((p: any) => p.userId)
        .map((p: any) => p.userId);

      if (participantUserIds.length > 0) {
        const notifBody =
          changedFields.length > 0
            ? `${event.name}: ${changeDescriptions.join(", ")}`
            : `Event "${event.name}" has been updated`;

        notificationService.sendPushNotificationToMany(
          participantUserIds,
          "Event Updated",
          notifBody,
          "event_update",
          {
            eventId: event._id.toString(),
            eventName: event.name,
            changedFields: changedFields.join(","),
          },
        );
      }
    }

    socketService.emitToAll("events:refresh", { reason: "updated", eventId: event._id.toString() });
    socketService.emitToEvent(event._id.toString(), "event:updated", { event });

    res.status(200).json(event);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event" });
  }
});

router.post("/:id/roster", async (req: Request, res: Response) => {
  const eventId = req.params.id;
  const { player, participant } = req.body;
  const entry = participant || player;
  if (!entry || !entry.username) {
    return res.status(400).json({ message: "Missing participant data" });
  }
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    if (event.roster.some((p: any) => p.username === entry.username)) {
      return res.status(409).json({ message: "Participant already in roster" });
    }

    // Clear expired reservation if present
    if (
      event.spotReservation &&
      new Date(event.spotReservation.expiresAt) <= new Date()
    ) {
      event.spotReservation = null;
    }

    if (event.roster.length >= event.totalSpots) {
      // If there's a valid reservation for this user, allow them through
      if (
        event.spotReservation &&
        entry.userId &&
        event.spotReservation.userId === entry.userId
      ) {
        // Reserved user is claiming their spot — handled below
      } else {
        return res.status(400).json({ message: "Event is full", full: true });
      }
    }

    // If spot is reserved for someone else and roster is at totalSpots - 1,
    // block non-reserved users from taking the last spot
    if (
      event.spotReservation &&
      entry.userId !== event.spotReservation.userId &&
      event.roster.length >= event.totalSpots - 1
    ) {
      return res.status(400).json({
        message: "The last spot is temporarily reserved for another player",
        reserved: true,
      });
    }

    event.roster.push(entry);
    event.rosterSpotsFilled = event.roster.length;

    // Clear reservation if this user was the reserved one
    if (
      event.spotReservation &&
      entry.userId &&
      event.spotReservation.userId === entry.userId
    ) {
      event.spotReservation = null;
    }

    // Remove from waitlist if they were on it
    if (entry.userId) {
      event.waitlist = event.waitlist.filter(
        (w: any) => w.userId !== entry.userId,
      );
    }

    await event.save();

    if (entry.userId) {
      notificationService.sendPushNotification({
        userId: entry.userId,
        title: "Added to Event",
        body: `You've been added to "${event.name}"`,
        type: "event_roster",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
    }

    if (event.createdBy && String(event.createdBy) !== String(entry.userId)) {
      notificationService.sendPushNotification({
        userId: String(event.createdBy),
        title: "New Player Joined!",
        body: `${entry.username} joined "${event.name}"`,
        type: "event_join",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
    }

    socketService.emitToEvent(eventId, "roster:updated", {
      eventId,
      roster: event.roster,
      rosterSpotsFilled: event.rosterSpotsFilled,
      spotReservation: event.spotReservation,
    });
    socketService.emitToAll("events:refresh", { reason: "roster_join", eventId });

    return res.status(200).json({ success: true, roster: event.roster });
  } catch (error) {
    console.error("Error adding participant to roster:", error);
    return res
      .status(500)
      .json({ message: "Error adding participant to roster" });
  }
});

// How long a waitlisted user has to claim their spot (in minutes)
const SPOT_RESERVATION_MINUTES = 15;

router.delete(
  "/:id/roster/:username",
  async (req: Request, res: Response) => {
    const eventId = req.params.id;
    const username = req.params.username;
    try {
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      const wasFull = event.roster.length >= event.totalSpots;
      const initialLength = event.roster.length;
      event.roster = event.roster.filter((p: any) => p.username !== username);
      if (event.roster.length === initialLength) {
        return res
          .status(404)
          .json({ message: "Participant not found in roster" });
      }
      event.rosterSpotsFilled = event.roster.length;

      // Reserve the spot for the first waitlisted user
      if (wasFull && event.waitlist && event.waitlist.length > 0) {
        const nextInLine = event.waitlist.shift()!;
        const expiresAt = new Date(
          Date.now() + SPOT_RESERVATION_MINUTES * 60 * 1000,
        );
        event.spotReservation = {
          userId: nextInLine.userId,
          username: nextInLine.username,
          profilePicUrl: nextInLine.profilePicUrl,
          expiresAt,
        };

        notificationService.sendPushNotification({
          userId: nextInLine.userId,
          title: "A spot opened up! 🎉",
          body: `A spot in "${event.name}" is reserved for you for ${SPOT_RESERVATION_MINUTES} minutes. Tap to claim it!`,
          type: "event_spot_available",
          data: { eventId: event._id.toString(), eventName: event.name },
        });

        // Schedule expiry check
        setTimeout(async () => {
          try {
            const freshEvent = await Event.findById(eventId);
            if (
              freshEvent?.spotReservation &&
              freshEvent.spotReservation.userId === nextInLine.userId &&
              new Date(freshEvent.spotReservation.expiresAt) <= new Date()
            ) {
              // Reservation expired — clear it and promote the next person
              freshEvent.spotReservation = null;

              // If there's another person waiting, reserve for them
              if (freshEvent.waitlist && freshEvent.waitlist.length > 0) {
                const nextNext = freshEvent.waitlist.shift()!;
                const newExpiry = new Date(
                  Date.now() + SPOT_RESERVATION_MINUTES * 60 * 1000,
                );
                freshEvent.spotReservation = {
                  userId: nextNext.userId,
                  username: nextNext.username,
                  profilePicUrl: nextNext.profilePicUrl,
                  expiresAt: newExpiry,
                };

                notificationService.sendPushNotification({
                  userId: nextNext.userId,
                  title: "A spot opened up! 🎉",
                  body: `A spot in "${freshEvent.name}" is reserved for you for ${SPOT_RESERVATION_MINUTES} minutes. Tap to claim it!`,
                  type: "event_spot_available",
                  data: {
                    eventId: freshEvent._id.toString(),
                    eventName: freshEvent.name,
                  },
                });
              }

              await freshEvent.save();

              socketService.emitToEvent(eventId, "roster:updated", {
                eventId,
                roster: freshEvent.roster,
                rosterSpotsFilled: freshEvent.rosterSpotsFilled,
                waitlist: freshEvent.waitlist,
                spotReservation: freshEvent.spotReservation,
              });
              socketService.emitToAll("events:refresh", {
                reason: "reservation_expired",
                eventId,
              });
            }
          } catch (err) {
            console.error("Error processing reservation expiry:", err);
          }
        }, SPOT_RESERVATION_MINUTES * 60 * 1000 + 5000);
      }

      await event.save();

      if (event.createdBy) {
        notificationService.sendPushNotification({
          userId: String(event.createdBy),
          title: "Player Left",
          body: `${username} left "${event.name}"`,
          type: "event_leave",
          data: { eventId: event._id.toString(), eventName: event.name },
        });
      }

      socketService.emitToEvent(eventId, "roster:updated", {
        eventId,
        roster: event.roster,
        rosterSpotsFilled: event.rosterSpotsFilled,
        waitlist: event.waitlist,
        spotReservation: event.spotReservation,
      });
      socketService.emitToAll("events:refresh", { reason: "roster_leave", eventId });

      return res.status(200).json({ success: true, roster: event.roster });
    } catch (error) {
      console.error("Error removing participant from roster:", error);
      return res
        .status(500)
        .json({ message: "Error removing participant from roster" });
    }
  },
);

router.patch("/:id/roster", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.id;
    const { playerAdded } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (typeof playerAdded !== "boolean") {
      return res.status(400).json({ message: "playerAdded must be boolean" });
    }

    if (playerAdded) {
      if (event.rosterSpotsFilled < event.totalSpots) {
        event.rosterSpotsFilled += 1;
      }
    } else {
      if (event.rosterSpotsFilled > 0) {
        event.rosterSpotsFilled -= 1;
      }
    }

    await event.save();
    res.status(200).json({ rosterSpotsFilled: event.rosterSpotsFilled });
  } catch (error) {
    res.status(500).json({ message: "Failed to update roster" });
  }
});

router.delete(
  "/series/:recurrenceGroupId",
  async (req: Request, res: Response) => {
    try {
      const currentUser = (req as any).user;
      if (!currentUser || !currentUser.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { recurrenceGroupId } = req.params;

      const sample = await Event.findOne({ recurrenceGroupId });
      if (!sample) {
        return res
          .status(404)
          .json({ message: "No events found for this series" });
      }

      if (String(sample.createdBy) !== currentUser.id) {
        return res
          .status(403)
          .json({ message: "Only the event creator can delete the series" });
      }

      const result = await Event.deleteMany({ recurrenceGroupId });

      res.status(200).json({
        success: true,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error("Failed to delete recurring series:", error);
      res.status(500).json({ message: "Failed to delete recurring series" });
    }
  },
);

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.id;
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    await Event.findByIdAndDelete(eventId);
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ message: "Failed to delete event" });
  }
});

router.post("/:eventId/invite", async (req: Request, res: Response) => {
  try {
    const { userIds } = req.body;
    const currentUser = (req as any).user;

    if (!currentUser || !currentUser.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "User IDs array is required" });
    }

    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    if (String(event.createdBy) !== String(currentUser.id)) {
      return res
        .status(403)
        .json({ message: "Only the event creator can invite users" });
    }

    if (!event.invitedUsers) {
      event.invitedUsers = [];
    }

    const newInvites: string[] = [];
    userIds.forEach((userId: string) => {
      if (!event.invitedUsers.includes(userId)) {
        event.invitedUsers.push(userId);
        newInvites.push(userId);
      }
    });

    await event.save();

    if (newInvites.length > 0) {
      notificationService.sendPushNotificationToMany(
        newInvites,
        "Event Invitation 📩",
        `You've been invited to "${event.name}"`,
        "event_invitation",
        {
          eventId: event._id.toString(),
          eventName: event.name,
          invitedBy: currentUser.id,
        },
      );
    }

    res.status(200).json({
      success: true,
      invitedUsers: event.invitedUsers,
      newlyInvited: newInvites.length,
    });
  } catch (error) {
    console.error("Error inviting users to event:", error);
    res.status(500).json({ message: "Failed to invite users" });
  }
});

router.delete(
  "/:eventId/invite/:userId",
  async (req: Request, res: Response) => {
    try {
      const currentUser = (req as any).user;
      const { eventId, userId } = req.params;

      if (!currentUser || !currentUser.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      if (String(event.createdBy) !== String(currentUser.id)) {
        return res
          .status(403)
          .json({ message: "Only the event creator can remove invites" });
      }

      event.invitedUsers = (event.invitedUsers || []).filter(
        (id) => id !== userId,
      );

      await event.save();

      res.status(200).json({
        success: true,
        invitedUsers: event.invitedUsers,
      });
    } catch (error) {
      console.error("Error removing invite:", error);
      res.status(500).json({ message: "Failed to remove invite" });
    }
  },
);

router.post("/:eventId/like", async (req: Request, res: Response) => {
  try {
    let userId = req.body.userId;
    if (!userId) {
      const user = (req as any).user;
      if (user && user.id) {
        userId = user.id;
      }
    }

    if (!userId) {
      return res.status(400).json({ message: "Missing userId." });
    }

    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found." });
    }

    if (!event.likes) {
      event.likes = [];
    }

    const likeIndex = event.likes.indexOf(userId);
    if (likeIndex === -1) {
      event.likes.push(userId);
    } else {
      event.likes.splice(likeIndex, 1);
    }
    await event.save();

    if (likeIndex === -1 && event.createdBy && String(event.createdBy) !== String(userId)) {
      const liker = await User.findById(userId).select("username");
      if (liker) {
        notificationService.sendPushNotification({
          userId: String(event.createdBy),
          title: "Someone liked your event!",
          body: `${liker.username} liked "${event.name}"`,
          type: "event_like",
          data: { eventId: event._id.toString(), eventName: event.name },
        });
      }
    }

    const likerIds = event.likes.map((id: string) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return id;
      }
    });
    const likers = await User.find({ _id: { $in: likerIds } })
      .select("username")
      .lean();
    const likedByUsernames = event.likes
      .map((id: string) => {
        const user = likers.find((u: any) => u._id.toString() === String(id));
        return user?.username;
      })
      .filter((name: string | undefined): name is string => !!name);

    const likePayload = { likes: event.likes, likedByUsernames };
    socketService.emitToAll("event:liked", {
      eventId: req.params.eventId,
      ...likePayload,
    });

    res.status(200).json(likePayload);
  } catch (error) {
    console.error("Error toggling event like:", error);
    res.status(500).json({ message: "Failed to toggle like on event." });
  }
});

// Join waitlist
router.post("/:id/waitlist", async (req: Request, res: Response) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const currentUser = (req as any).user;
    if (!currentUser || !currentUser.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const user = await User.findById(currentUser.id).select("username profilePicUrl");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (event.roster.some((p: any) => p.userId === currentUser.id)) {
      return res.status(400).json({ message: "Already on the roster" });
    }

    if (event.waitlist.some((w: any) => w.userId === currentUser.id)) {
      return res.status(409).json({ message: "Already on the waitlist" });
    }

    event.waitlist.push({
      userId: currentUser.id,
      username: user.username,
      profilePicUrl: (user as any).profilePicUrl || undefined,
      joinedAt: new Date(),
    });
    await event.save();

    const position = event.waitlist.length;

    if (event.createdBy && String(event.createdBy) !== currentUser.id) {
      notificationService.sendPushNotification({
        userId: String(event.createdBy),
        title: "New Waitlist Entry",
        body: `${user.username} joined the waitlist for "${event.name}"`,
        type: "event_waitlist_join",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
    }

    socketService.emitToEvent(req.params.id, "waitlist:updated", {
      eventId: req.params.id,
      waitlist: event.waitlist,
    });
    socketService.emitToAll("events:refresh", { reason: "waitlist_join", eventId: req.params.id });

    return res.status(200).json({
      success: true,
      position,
      waitlist: event.waitlist,
    });
  } catch (error) {
    console.error("Error joining waitlist:", error);
    return res.status(500).json({ message: "Failed to join waitlist" });
  }
});

// Leave waitlist
router.delete("/:id/waitlist", async (req: Request, res: Response) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const currentUser = (req as any).user;
    if (!currentUser || !currentUser.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const initialLength = event.waitlist.length;
    event.waitlist = event.waitlist.filter(
      (w: any) => w.userId !== currentUser.id,
    );

    if (event.waitlist.length === initialLength) {
      return res.status(404).json({ message: "Not on the waitlist" });
    }

    await event.save();

    socketService.emitToEvent(req.params.id, "waitlist:updated", {
      eventId: req.params.id,
      waitlist: event.waitlist,
    });
    socketService.emitToAll("events:refresh", { reason: "waitlist_leave", eventId: req.params.id });

    return res.status(200).json({ success: true, waitlist: event.waitlist });
  } catch (error) {
    console.error("Error leaving waitlist:", error);
    return res.status(500).json({ message: "Failed to leave waitlist" });
  }
});

export default router;
