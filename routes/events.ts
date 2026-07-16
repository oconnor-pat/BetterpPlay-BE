import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/event";
import User from "../models/user";
import Group from "../models/group";
import GroupMessage from "../models/groupMessage";
import communityNote from "../models/communityNote";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";

const router = Router();

// Drop a system message into a group's chat when an event is scheduled
// from that group, so the conversation and the plans it produces live in
// one thread. Best-effort: chat is a nicety, never block event creation
// on it. Broadcasts to the live thread and each member's Groups tab.
const postGroupEventSystemMessage = async (params: {
  groupId: string;
  actorId: string;
  eventId: string;
  eventName: string;
  eventDate?: string;
  text: string;
}): Promise<void> => {
  try {
    const group = await Group.findById(params.groupId).select("members").lean();
    if (!group) return;
    const actor = await User.findById(params.actorId)
      .select("username name profilePicUrl")
      .lean();
    const created = await GroupMessage.create({
      groupId: params.groupId,
      userId: params.actorId,
      username: (actor as any)?.username || (actor as any)?.name || "Member",
      profilePicUrl: (actor as any)?.profilePicUrl,
      text: params.text,
      kind: "system",
      eventRef: {
        eventId: params.eventId,
        eventName: params.eventName,
        eventDate: params.eventDate,
      },
    });
    const message = {
      _id: created._id,
      groupId: created.groupId,
      userId: created.userId,
      username: created.username,
      profilePicUrl: created.profilePicUrl,
      text: created.text,
      kind: created.kind,
      eventRef: created.eventRef,
      createdAt: created.createdAt,
    };
    socketService.emitToGroup(params.groupId, "group:message:new", message);
    const memberIds = ((group as any).members || []).map((m: any) =>
      String(m.userId),
    );
    socketService.emitToUsers(memberIds, "group:activity", {
      groupId: params.groupId,
      senderId: params.actorId,
      lastMessage: {
        text: message.text,
        kind: message.kind,
        username: message.username,
        senderId: message.userId,
        createdAt: message.createdAt,
      },
    });
  } catch (err) {
    console.error("Failed to post group system message:", err);
  }
};

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

    // Build a compact member preview for each event that has a groupId
    // attached. Used by the FE to render an avatar strip next to the
    // group-name badge on the event card. Capped at 5 members per
    // event — that's enough to show 3 visible + a "+N" overflow chip
    // without bloating the response. One batched group fetch + one
    // batched user fetch keeps this O(1) DB round trips regardless of
    // how many events were returned.
    const PREVIEW_LIMIT = 5;
    const groupIds = Array.from(
      new Set(
        visibleEvents
          .map((e: any) => e.groupId)
          .filter((id: any): id is string => typeof id === "string" && !!id),
      ),
    );
    const groupMembersPreviewMap = new Map<string, any[]>();
    if (groupIds.length > 0) {
      const groups = await Group.find({ _id: { $in: groupIds } })
        .select("members")
        .lean();
      const allMemberIds = new Set<string>();
      groups.forEach((g: any) => {
        (g.members || [])
          .slice(0, PREVIEW_LIMIT)
          .forEach((m: any) => allMemberIds.add(String(m.userId)));
      });
      const memberUsers = await User.find({
        _id: { $in: Array.from(allMemberIds) },
      })
        .select("username name profilePicUrl")
        .lean();
      const userById = new Map<string, any>(
        memberUsers.map((u: any) => [String(u._id), u]),
      );
      groups.forEach((g: any) => {
        const preview = (g.members || []).slice(0, PREVIEW_LIMIT).map((m: any) => {
          const u = userById.get(String(m.userId));
          return {
            userId: String(m.userId),
            username: u?.username,
            name: u?.name,
            profilePicUrl: u?.profilePicUrl,
          };
        });
        groupMembersPreviewMap.set(String(g._id), preview);
      });
    }

    const eventsWithLikedBy = visibleEvents.map((event: any) => ({
      ...event,
      likedByUsernames: (event.likes || [])
        .map((id: string) => userNameMap.get(String(id)))
        .filter((name: string | undefined): name is string => !!name),
      commentCount: commentCountMap.get(event._id.toString()) || 0,
      groupMembersPreview: event.groupId
        ? groupMembersPreviewMap.get(String(event.groupId)) || []
        : undefined,
    }));

    // Gate public events per-viewer: locked ones collapse to a teaser.
    const projected = eventsWithLikedBy.map((event: any) =>
      projectEventForViewer(event, currentUserId ? String(currentUserId) : null),
    );

    res.status(200).json(projected);
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

    res
      .status(200)
      .json(projectEventForViewer({ ...event, likedByUsernames }, currentUserId));
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
      groupId,
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

    // Snapshot a Group's members into `invitedUsers` if one was attached.
    // The FE may have already merged the group members on its side, but
    // we re-resolve here so the server is the source of truth — guards
    // against drift between picker and submission, and lets us cache the
    // `groupName` for the "via [Group]" badge without an extra round
    // trip. The creator must be a member of the group to attach it.
    let resolvedGroupId: string | undefined;
    let resolvedGroupName: string | undefined;
    // Compact member preview attached to the response so the FE can
    // render the avatar strip next to the group-name badge on the new
    // event card without an extra round trip. Same shape the GET /
    // handler returns. Capped at 5 to match.
    let groupMembersPreview: Array<{
      userId: string;
      username?: string;
      name?: string;
      profilePicUrl?: string;
    }> | undefined;
    let mergedInvitedUsers: string[] = Array.isArray(invitedUsers)
      ? invitedUsers.filter((id: any) => typeof id === "string" && id)
      : [];
    // Tracked so the post-create notification step can give group
    // members a group-flavored push ("Beacon trivia has a new event")
    // and non-group invitees the generic event invitation.
    const groupMemberIdSet = new Set<string>();

    if (groupId && typeof groupId === "string") {
      const group = await Group.findById(groupId);
      if (!group) {
        return res.status(400).json({ message: "Group not found" });
      }
      const isMember = (group.members as any[]).some(
        (m) => String(m.userId) === String(createdBy),
      );
      if (!isMember) {
        return res
          .status(403)
          .json({ message: "You must be a member of the group to attach it" });
      }
      resolvedGroupId = String(group._id);
      resolvedGroupName = group.name;
      const groupMemberIds = (group.members as any[])
        .map((m) => String(m.userId))
        .filter((id) => id && id !== String(createdBy));
      groupMemberIds.forEach((id) => groupMemberIdSet.add(id));
      // Union with any individually picked invitees — picker selections
      // stack on top of the group, they don't replace it.
      const seen = new Set(mergedInvitedUsers.map(String));
      for (const id of groupMemberIds) {
        if (!seen.has(id)) {
          seen.add(id);
          mergedInvitedUsers.push(id);
        }
      }

      // Hydrate the first 5 members' display fields for the preview.
      const previewIds = (group.members as any[])
        .slice(0, 5)
        .map((m) => String(m.userId));
      const previewUsers = await User.find({ _id: { $in: previewIds } })
        .select("username name profilePicUrl")
        .lean();
      const previewById = new Map<string, any>(
        previewUsers.map((u: any) => [String(u._id), u]),
      );
      groupMembersPreview = previewIds.map((id) => {
        const u = previewById.get(id);
        return {
          userId: id,
          username: u?.username,
          name: u?.name,
          profilePicUrl: u?.profilePicUrl,
        };
      });
    }

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
      invitedUsers: mergedInvitedUsers,
      // Optional venue listing reference (set when a user planned this event
      // from the Venues tab via "Plan event from this page").
      venueId: venueId || undefined,
      venueName: venueName || undefined,
      // Optional Group reference (set when a user picked "Invite a group"
      // during event creation). Powers the "via [Group]" badge.
      groupId: resolvedGroupId,
      groupName: resolvedGroupName,
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

      if (mergedInvitedUsers.length > 0) {
        const currentUser = (req as any).user;
        // Split the invitee list so group members get the group-flavored
        // notification (highlights the ritual context) while one-off
        // invitees get the standard event invitation.
        const groupRecipients = mergedInvitedUsers.filter((id) =>
          groupMemberIdSet.has(id),
        );
        const explicitRecipients = mergedInvitedUsers.filter(
          (id) => !groupMemberIdSet.has(id),
        );
        if (groupRecipients.length > 0 && resolvedGroupName) {
          notificationService.sendPushNotificationToMany(
            groupRecipients,
            `${resolvedGroupName} has a new event`,
            `${name} — ${count} recurring events scheduled`,
            "group_event_created",
            {
              eventId: newEvents[0]._id.toString(),
              eventName: name,
              groupId: resolvedGroupId || "",
              groupName: resolvedGroupName,
              invitedBy: (currentUser?.id || createdBy).toString(),
            },
          );
        }
        if (explicitRecipients.length > 0) {
          notificationService.sendPushNotificationToMany(
            explicitRecipients,
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
      }

      if (resolvedGroupId && resolvedGroupName) {
        await postGroupEventSystemMessage({
          groupId: resolvedGroupId,
          actorId: ((req as any).user?.id || createdBy).toString(),
          eventId: newEvents[0]._id.toString(),
          eventName: name,
          eventDate: newEvents[0].date,
          text: `📅 ${name} scheduled — ${count} recurring events`,
        });
      }

      socketService.emitToAll("events:refresh", { reason: "created" });
      const newEventsWithPreview = newEvents.map((e: any) => ({
        ...(e.toObject ? e.toObject() : e),
        groupMembersPreview,
      }));
      res.status(201).json(newEventsWithPreview);
    } else {
      const newEvent = await Event.create({
        ...baseEventData,
        date,
      });

      if (mergedInvitedUsers.length > 0) {
        const currentUser = (req as any).user;
        const groupRecipients = mergedInvitedUsers.filter((id) =>
          groupMemberIdSet.has(id),
        );
        const explicitRecipients = mergedInvitedUsers.filter(
          (id) => !groupMemberIdSet.has(id),
        );
        if (groupRecipients.length > 0 && resolvedGroupName) {
          notificationService.sendPushNotificationToMany(
            groupRecipients,
            `${resolvedGroupName} has a new event`,
            `${name} — ${date}`,
            "group_event_created",
            {
              eventId: newEvent._id.toString(),
              eventName: name,
              groupId: resolvedGroupId || "",
              groupName: resolvedGroupName,
              invitedBy: (currentUser?.id || createdBy).toString(),
            },
          );
        }
        if (explicitRecipients.length > 0) {
          notificationService.sendPushNotificationToMany(
            explicitRecipients,
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
      }

      if (resolvedGroupId && resolvedGroupName) {
        await postGroupEventSystemMessage({
          groupId: resolvedGroupId,
          actorId: ((req as any).user?.id || createdBy).toString(),
          eventId: newEvent._id.toString(),
          eventName: name,
          eventDate: date,
          text: `📅 ${name} scheduled for ${date}`,
        });
      }

      socketService.emitToAll("events:refresh", { reason: "created" });
      res.status(201).json({
        ...newEvent.toObject(),
        groupMembersPreview,
      });
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

    // Public events are gated: a user can't add themselves directly, they
    // must request to join and be approved. The creator can still add anyone.
    const actorId = (req as any).user?.id
      ? String((req as any).user.id)
      : null;
    if (
      (event.privacy || "public") === "public" &&
      entry.userId &&
      actorId &&
      String(entry.userId) === actorId &&
      String(event.createdBy) !== actorId
    ) {
      return res.status(403).json({
        message: "This event requires approval — request to join instead.",
        requiresApproval: true,
      });
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
      // Joining the roster clears any prior "maybe"/"can't" reply so a user
      // is only ever in one place.
      event.rsvps = event.rsvps.filter((r: any) => r.userId !== entry.userId);
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
    broadcastRosterChanged(event);
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

// Reserve a freed spot for the first waitlisted user and schedule the
// reservation's expiry. Used by the "RSVP maybe/can't" path so a seat that
// frees up when someone backs out promotes the waitlist the same way leaving
// the roster does. Caller decides whether the event was full before calling.
function promoteWaitlistIfNeeded(event: any, eventId: string): void {
  if (!event.waitlist || event.waitlist.length === 0) {
    return;
  }
  const nextInLine = event.waitlist.shift()!;
  const expiresAt = new Date(Date.now() + SPOT_RESERVATION_MINUTES * 60 * 1000);
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

  setTimeout(
    async () => {
      try {
        const freshEvent = await Event.findById(eventId);
        if (
          freshEvent?.spotReservation &&
          freshEvent.spotReservation.userId === nextInLine.userId &&
          new Date(freshEvent.spotReservation.expiresAt) <= new Date()
        ) {
          freshEvent.spotReservation = null;
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
    },
    SPOT_RESERVATION_MINUTES * 60 * 1000 + 5000,
  );
}

// Push a roster/RSVP patch to the clients that should see it so their event
// card updates instantly (the events list isn't in the event's socket room).
// Public events go to everyone; private/invite-only events go only to the
// creator and invited users so roster PII isn't leaked to outsiders.
function broadcastRosterChanged(event: any): void {
  const payload = {
    eventId: event._id.toString(),
    roster: event.roster,
    rsvps: event.rsvps,
    rosterSpotsFilled: event.rosterSpotsFilled,
  };
  // Roster identities are gated — public events hide their roster until a
  // requester is approved — so only push this detailed patch to people who
  // are allowed to see it: the creator, anyone already on the roster, and
  // any invited users. A no-PII "events:refresh" broadcast (sent separately)
  // is what nudges everyone else to refetch a privacy-filtered copy.
  const recipients = new Set<string>([String(event.createdBy)]);
  (event.roster || []).forEach((p: any) => {
    if (p.userId) {
      recipients.add(String(p.userId));
    }
  });
  (event.invitedUsers || []).forEach((id: any) =>
    recipients.add(String(id)),
  );
  socketService.emitToUsers(
    Array.from(recipients),
    "event:rosterChanged",
    payload,
  );
}

// Project an event for a specific viewer. Public events are gated: a viewer
// who isn't the creator and hasn't been approved onto the roster sees only a
// teaser (name, type, organizer, date/time, spots) plus their own request
// status. Everything sensitive — address, coordinates/map, roster identities,
// description, venue, source link, group — is stripped until approval. Only
// the creator ever receives the pending join-request list.
function projectEventForViewer(event: any, viewerId: string | null): any {
  const privacy = event.privacy || "public";
  const isCreator = !!viewerId && String(event.createdBy) === String(viewerId);
  const onRoster =
    !!viewerId &&
    (event.roster || []).some(
      (p: any) => String(p.userId) === String(viewerId),
    );

  if (privacy === "public" && !isCreator && !onRoster) {
    const pending =
      !!viewerId &&
      (event.joinRequests || []).some(
        (r: any) => String(r.userId) === String(viewerId),
      );
    return {
      _id: event._id,
      name: event.name,
      eventType: event.eventType,
      date: event.date,
      time: event.time,
      totalSpots: event.totalSpots,
      rosterSpotsFilled:
        event.rosterSpotsFilled ?? (event.roster || []).length,
      createdBy: event.createdBy,
      createdByUsername: event.createdByUsername,
      privacy,
      isRecurring: event.isRecurring,
      recurrenceGroupId: event.recurrenceGroupId,
      recurrenceFrequency: event.recurrenceFrequency,
      createdAt: event.createdAt,
      likes: event.likes || [],
      isGated: true,
      myJoinRequestStatus: pending ? "pending" : "none",
      roster: [],
      rsvps: [],
      waitlist: [],
      joinRequests: [],
    };
  }

  const full: any = { ...event, isGated: false, myJoinRequestStatus: "none" };
  if (!isCreator) {
    // Non-creators (even approved ones) never see who else is waiting.
    full.joinRequests = [];
  }
  return full;
}

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
      broadcastRosterChanged(event);
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

// Set the current user's RSVP for an event. "Going" lives on the roster
// (which owns spot counts); "maybe"/"cant" live in `rsvps`. A user is only
// ever in one place, so switching states moves them between the two.
router.put("/:id/rsvp", async (req: Request, res: Response) => {
  const eventId = req.params.id;
  const { userId, username, profilePicUrl, status } = req.body;
  if (
    !userId ||
    !username ||
    !["going", "maybe", "cant"].includes(status)
  ) {
    return res.status(400).json({ message: "Missing or invalid RSVP data" });
  }
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // Public events are gated — non-creators join via request/approval, not by
    // RSVPing. The 3-way RSVP is for invite-only events (and the creator).
    if (
      (event.privacy || "public") === "public" &&
      String(event.createdBy) !== String(userId)
    ) {
      return res.status(403).json({
        message: "This event requires approval — request to join instead.",
        requiresApproval: true,
      });
    }

    const onRoster = event.roster.some((p: any) => p.userId === userId);

    if (status === "going") {
      // Drop any maybe/cant reply, then take a roster spot if there's room
      // (respecting a spot briefly held for a waitlisted user).
      event.rsvps = event.rsvps.filter((r: any) => r.userId !== userId);
      if (!onRoster) {
        const reservationForOther =
          !!event.spotReservation &&
          event.spotReservation.userId !== userId &&
          new Date(event.spotReservation.expiresAt) > new Date();
        const capacity = reservationForOther
          ? event.totalSpots - 1
          : event.totalSpots;
        if (event.roster.length >= capacity) {
          return res.status(400).json({ message: "Event is full", full: true });
        }
        event.roster.push({
          username,
          paidStatus: "Unpaid",
          userId,
          profilePicUrl,
        } as any);
        event.rosterSpotsFilled = event.roster.length;
        if (event.spotReservation && event.spotReservation.userId === userId) {
          event.spotReservation = null;
        }
        event.waitlist = event.waitlist.filter((w: any) => w.userId !== userId);
      }
    } else {
      // Maybe / can't: free their roster spot (promoting the waitlist if the
      // event was full), then record the reply.
      const wasFull = event.roster.length >= event.totalSpots;
      if (onRoster) {
        event.roster = event.roster.filter((p: any) => p.userId !== userId);
        event.rosterSpotsFilled = event.roster.length;
        if (wasFull) {
          promoteWaitlistIfNeeded(event, eventId);
        }
      }
      event.rsvps = event.rsvps.filter((r: any) => r.userId !== userId);
      event.rsvps.push({
        userId,
        username,
        profilePicUrl,
        status,
        respondedAt: new Date(),
      } as any);
    }

    await event.save();

    // Let the organizer see how people are responding.
    if (event.createdBy && String(event.createdBy) !== String(userId)) {
      const label =
        status === "going"
          ? "is going to"
          : status === "maybe"
            ? "might make"
            : "can't make";
      notificationService.sendPushNotification({
        userId: String(event.createdBy),
        title: "RSVP update",
        body: `${username} ${label} "${event.name}"`,
        type: "event_rsvp",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
    }

    socketService.emitToEvent(eventId, "roster:updated", {
      eventId,
      roster: event.roster,
      rosterSpotsFilled: event.rosterSpotsFilled,
      rsvps: event.rsvps,
      spotReservation: event.spotReservation,
    });
    // Push a targeted patch (privacy-scoped) so any client showing this
    // event's card — e.g. the organizer on the events list — updates its
    // roster/RSVP counts instantly without a full refetch.
    broadcastRosterChanged(event);
    socketService.emitToAll("events:refresh", { reason: "rsvp", eventId });

    return res.status(200).json({
      success: true,
      roster: event.roster,
      rsvps: event.rsvps,
      rosterSpotsFilled: event.rosterSpotsFilled,
    });
  } catch (error) {
    console.error("Error updating RSVP:", error);
    return res.status(500).json({ message: "Error updating RSVP" });
  }
});

// Clear the current user's maybe/cant reply (e.g. tapping the active state
// off). Clearing a "going" is done via the roster leave endpoint instead.
router.delete("/:id/rsvp/:userId", async (req: Request, res: Response) => {
  const eventId = req.params.id;
  const { userId } = req.params;
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    event.rsvps = event.rsvps.filter((r: any) => r.userId !== userId);
    await event.save();

    socketService.emitToEvent(eventId, "roster:updated", {
      eventId,
      roster: event.roster,
      rosterSpotsFilled: event.rosterSpotsFilled,
      rsvps: event.rsvps,
      spotReservation: event.spotReservation,
    });
    broadcastRosterChanged(event);
    socketService.emitToAll("events:refresh", { reason: "rsvp_clear", eventId });

    return res.status(200).json({ success: true, rsvps: event.rsvps });
  } catch (error) {
    console.error("Error clearing RSVP:", error);
    return res.status(500).json({ message: "Error clearing RSVP" });
  }
});

// Request to join a public (gated) event. The creator is notified and
// approves/denies. Only public events use requests — private events aren't
// visible and invite-only events are joined by invitation.
router.post("/:id/join-request", async (req: Request, res: Response) => {
  const currentUser = (req as any).user;
  if (!currentUser?.id) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const userId = String(currentUser.id);
  const { username, profilePicUrl } = req.body;
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    if ((event.privacy || "public") !== "public") {
      return res
        .status(400)
        .json({ message: "Only public events accept join requests" });
    }
    if (String(event.createdBy) === userId) {
      return res.status(400).json({ message: "You own this event" });
    }
    if (event.roster.some((p: any) => String(p.userId) === userId)) {
      return res.status(409).json({ message: "You're already on the roster" });
    }
    const alreadyRequested = event.joinRequests.some(
      (r: any) => String(r.userId) === userId,
    );
    if (!alreadyRequested) {
      event.joinRequests.push({
        userId,
        username: username || "",
        profilePicUrl,
        requestedAt: new Date(),
      } as any);
      await event.save();

      notificationService.sendPushNotification({
        userId: String(event.createdBy),
        title: "New join request",
        body: `${username || "Someone"} asked to join "${event.name}"`,
        type: "event_join_request",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
      // Nudge the creator's client to refetch so the pending list updates.
      socketService.emitToUser(String(event.createdBy), "events:refresh", {
        reason: "join_request",
        eventId: event._id.toString(),
      });
    }

    return res
      .status(200)
      .json({ success: true, myJoinRequestStatus: "pending" });
  } catch (error) {
    console.error("Error creating join request:", error);
    return res.status(500).json({ message: "Error creating join request" });
  }
});

// Approve a pending join request (creator only). Adds the requester to the
// roster — which is what unlocks the event's full details for them.
router.post(
  "/:id/join-request/:userId/approve",
  async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }
    try {
      const event = await Event.findById(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      if (String(event.createdBy) !== String(currentUser.id)) {
        return res
          .status(403)
          .json({ message: "Only the event creator can approve requests" });
      }
      const requesterId = String(req.params.userId);
      const request = event.joinRequests.find(
        (r: any) => String(r.userId) === requesterId,
      );
      if (!request) {
        return res.status(404).json({ message: "Join request not found" });
      }
      if (event.roster.length >= event.totalSpots) {
        return res.status(400).json({ message: "Event is full", full: true });
      }

      event.roster.push({
        username: request.username,
        paidStatus: "Unpaid",
        userId: requesterId,
        profilePicUrl: request.profilePicUrl,
      } as any);
      event.rosterSpotsFilled = event.roster.length;
      event.joinRequests = event.joinRequests.filter(
        (r: any) => String(r.userId) !== requesterId,
      );
      await event.save();

      notificationService.sendPushNotification({
        userId: requesterId,
        title: "Request approved 🎉",
        body: `You're in for "${event.name}"`,
        type: "event_join_approved",
        data: { eventId: event._id.toString(), eventName: event.name },
      });

      broadcastRosterChanged(event);
      // Requester's card must refetch to unlock the full (ungated) details;
      // creator's refetches to drop the request from the pending list.
      socketService.emitToUser(requesterId, "events:refresh", {
        reason: "join_approved",
        eventId: event._id.toString(),
      });
      socketService.emitToUser(String(event.createdBy), "events:refresh", {
        reason: "join_approved",
        eventId: event._id.toString(),
      });

      return res.status(200).json({
        success: true,
        roster: event.roster,
        joinRequests: event.joinRequests,
        rosterSpotsFilled: event.rosterSpotsFilled,
      });
    } catch (error) {
      console.error("Error approving join request:", error);
      return res.status(500).json({ message: "Error approving join request" });
    }
  },
);

// Deny a pending join request (creator only).
router.post(
  "/:id/join-request/:userId/deny",
  async (req: Request, res: Response) => {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }
    try {
      const event = await Event.findById(req.params.id);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      if (String(event.createdBy) !== String(currentUser.id)) {
        return res
          .status(403)
          .json({ message: "Only the event creator can deny requests" });
      }
      const requesterId = String(req.params.userId);
      const existed = event.joinRequests.some(
        (r: any) => String(r.userId) === requesterId,
      );
      event.joinRequests = event.joinRequests.filter(
        (r: any) => String(r.userId) !== requesterId,
      );
      await event.save();

      if (existed) {
        notificationService.sendPushNotification({
          userId: requesterId,
          title: "Request update",
          body: `Your request to join "${event.name}" wasn't approved`,
          type: "event_join_denied",
          data: { eventId: event._id.toString(), eventName: event.name },
        });
        socketService.emitToUser(requesterId, "events:refresh", {
          reason: "join_denied",
          eventId: event._id.toString(),
        });
        socketService.emitToUser(String(event.createdBy), "events:refresh", {
          reason: "join_denied",
          eventId: event._id.toString(),
        });
      }

      return res
        .status(200)
        .json({ success: true, joinRequests: event.joinRequests });
    } catch (error) {
      console.error("Error denying join request:", error);
      return res.status(500).json({ message: "Error denying join request" });
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

      // Series delete is scoped to future-dated instances only. Past
      // instances stay as immutable history — same principle the live
      // link service follows for member-roster propagation. The user's
      // intent here is "stop doing this thing going forward," not "erase
      // the fact that we ever did it." Matches the iOS/Google Calendar
      // convention for "Delete entire series" as well.
      const d = new Date();
      const todayString =
        `${d.getFullYear()}-` +
        `${String(d.getMonth() + 1).padStart(2, "0")}-` +
        `${String(d.getDate()).padStart(2, "0")}`;

      // Look up a future sample so the 404/403 gates also tell us
      // there's actually something future to delete. A dead series with
      // only past instances correctly returns 404 — nothing to do.
      const sample = await Event.findOne({
        recurrenceGroupId,
        date: { $gte: todayString },
      });
      if (!sample) {
        return res
          .status(404)
          .json({ message: "No future events found for this series" });
      }

      if (String(sample.createdBy) !== currentUser.id) {
        return res
          .status(403)
          .json({ message: "Only the event creator can delete the series" });
      }

      const result = await Event.deleteMany({
        recurrenceGroupId,
        date: { $gte: todayString },
      });

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
    const currentUser = (req as any).user;
    if (!currentUser || !currentUser.id) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const eventId = req.params.id;
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    // Only the event creator can delete it. Mirrors the rule the series
    // delete route enforces — without this, anyone with an event id
    // could DELETE it (the FE already sends an auth header so this
    // check doesn't break the existing client flow).
    if (String(event.createdBy) !== String(currentUser.id)) {
      return res
        .status(403)
        .json({ message: "Only the event creator can delete this event" });
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
