import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/event";
import User from "../models/user";
import Group from "../models/group";
import GroupMessage from "../models/groupMessage";
import communityNote from "../models/communityNote";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";
import blockService from "../services/blockService";
import { isValidEmoji } from "../utils/emoji";
import { resolveEventStartsAt } from "../utils/eventDateTime";
import { normalizeRosterForEventShape, resolveJoinParticipantFields } from "../utils/rosterNormalize";
import Notification from "../models/notification";

const router = Router();

// How often a creator can re-nudge the same pending invitee.
const RSVP_PING_COOLDOWN_MS = 60 * 60 * 1000;

// The reaction a legacy "like" maps to, in both directions.
const LIKE_EMOJI = "❤️";

// How many occurrences we materialize for an indefinite series. Enough to
// cover ~3 months of weekly events without flooding the calendar; the
// series can be extended later without changing the "no end" semantics.
const INDEFINITE_RECURRENCE_HORIZON = 12;

const resolveRecurrenceCount = (
  recurrenceCount: unknown,
  recurrenceIndefinite: unknown,
): { count: number; indefinite: boolean } => {
  if (
    recurrenceIndefinite === true ||
    recurrenceIndefinite === "true" ||
    recurrenceCount === 0 ||
    recurrenceCount === "0" ||
    recurrenceCount === "indefinite"
  ) {
    return { count: INDEFINITE_RECURRENCE_HORIZON, indefinite: true };
  }
  const n = parseInt(String(recurrenceCount ?? 4), 10);
  return {
    count: Math.min(Math.max(isNaN(n) ? 4 : n, 2), 12),
    indefinite: false,
  };
};

// Normalize any incoming date to the canonical "YYYY-MM-DD" storage format.
// The client's date picker sends `Date.toDateString()` ("Fri Jul 24 2026"),
// but recurring series are stored as ISO calendar dates at creation. Editing
// must land in the same format or the series sorts/groups inconsistently on
// the client. Already-ISO input is passed through untouched (avoids any
// UTC-parse day shift); other formats are converted via the same path used
// when a series is first generated.
const toIsoDate = (input: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  // Prefer calendar components in local time so "Fri Aug 21 2026" doesn't
  // flip a day when the server is UTC (Heroku) and we used toISOString().
  const clean = input.replace(/^[A-Za-z]{3}\s+/, "");
  const monthDayYear = clean.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  let d: Date | null = null;
  if (monthDayYear) {
    d = new Date(`${monthDayYear[1]} ${monthDayYear[2]}, ${monthDayYear[3]}`);
  }
  if (!d || isNaN(d.getTime())) {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) {
    return input;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Coerce an incoming event duration into a sane number of minutes, or undefined
// when the client didn't send one / sent null (meaning open-ended — clients
// render only a start time). Bounds mirror the schema so a bad value is
// dropped rather than failing the whole save.
const normalizeDuration = (input: unknown): number | undefined => {
  if (input === undefined || input === null || input === "") return undefined;
  const minutes = Math.round(Number(input));
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 24 * 60) {
    return undefined;
  }
  return minutes;
};

// totalSpots === 0 means "no cap". Kept as a number (not null) so the
// existing required field stays required and older clients that compare
// filled/total keep getting a numeric value.
const isUnlimitedSpots = (totalSpots: unknown): boolean =>
  Number(totalSpots) === 0;

const isRosterFull = (event: {
  roster: unknown[];
  totalSpots: number;
}): boolean =>
  !isUnlimitedSpots(event.totalSpots) &&
  event.roster.length >= event.totalSpots;

const isInvitedToEvent = (
  event: { invitedUsers?: any[] },
  userId: string,
): boolean =>
  (event.invitedUsers || []).map(String).includes(String(userId));

const isRemovedFromEvent = (
  event: { removedUserIds?: any[] },
  userId: string,
): boolean =>
  (event.removedUserIds || []).map(String).includes(String(userId));

/** Drop a user from every soft-membership list (not the kick ban list). */
function purgeUserFromEventLists(event: any, userId: string): void {
  const id = String(userId);
  event.invitedUsers = (event.invitedUsers || []).filter(
    (uid: any) => String(uid) !== id,
  );
  event.waitlist = (event.waitlist || []).filter(
    (w: any) => String(w.userId) !== id,
  );
  event.rsvps = (event.rsvps || []).filter(
    (r: any) => String(r.userId) !== id,
  );
  event.joinRequests = (event.joinRequests || []).filter(
    (r: any) => String(r.userId) !== id,
  );
  event.guestAddRequests = (event.guestAddRequests || []).filter(
    (r: any) =>
      String(r.proposedUserId) !== id && String(r.requestedBy) !== id,
  );
  if (event.spotReservation && String(event.spotReservation.userId) === id) {
    event.spotReservation = null;
  }
}

function markUserRemovedFromEvent(event: any, userId: string): void {
  const id = String(userId);
  if (!event.removedUserIds) {
    event.removedUserIds = [];
  }
  if (!event.removedUserIds.map(String).includes(id)) {
    event.removedUserIds.push(id);
  }
}

/** Host re-invite / explicit add clears the kick ban. */
function clearUserRemovedFromEvent(event: any, userId: string): void {
  const id = String(userId);
  event.removedUserIds = (event.removedUserIds || []).filter(
    (uid: any) => String(uid) !== id,
  );
}

// Host-initiated invites should not dump people onto the waitlist of a full
// event. Expand totalSpots so roster + pending invitees all have a seat.
function expandCapacityForPendingInvites(event: any): boolean {
  if (isUnlimitedSpots(event.totalSpots)) {
    return false;
  }
  const rosterIds = new Set(
    (event.roster || [])
      .map((p: any) => (p?.userId != null ? String(p.userId) : ""))
      .filter(Boolean),
  );
  const creatorId = String(event.createdBy || "");
  const pendingInvitees = (event.invitedUsers || []).filter((id: any) => {
    const s = String(id);
    return s && s !== creatorId && !rosterIds.has(s);
  });
  const needed = event.roster.length + pendingInvitees.length;
  if (needed <= event.totalSpots) {
    return false;
  }
  event.totalSpots = needed;
  return true;
}

// Invites sent before capacity was expanded: if an invitee tries to join a
// full event, give them the extra seat instead of "event is full".
function expandCapacityForInvitedJoiner(event: any, userId: string): boolean {
  if (isUnlimitedSpots(event.totalSpots) || !isRosterFull(event)) {
    return false;
  }
  if (!isInvitedToEvent(event, userId)) {
    return false;
  }
  event.totalSpots = event.roster.length + 1;
  return true;
}

// Unique userId → an affected event they're on (roster, invite, or waitlist).
// Used so series edits ping everyone tied to any updated card, not just the
// one that was opened in the editor.
function collectUpdateRecipients(
  events: any[],
  excludeUserId: string | null,
): Map<string, string> {
  const recipientToEventId = new Map<string, string>();
  const add = (userId: any, eventId: string) => {
    const id = userId != null ? String(userId) : "";
    if (!id || (excludeUserId && id === excludeUserId)) {
      return;
    }
    if (!recipientToEventId.has(id)) {
      recipientToEventId.set(id, eventId);
    }
  };
  for (const doc of events) {
    const eid = String(doc._id);
    for (const p of doc.roster || []) {
      add(p.userId, eid);
    }
    for (const id of doc.invitedUsers || []) {
      add(id, eid);
    }
    for (const w of doc.waitlist || []) {
      add(w.userId, eid);
    }
  }
  return recipientToEventId;
}

// A series of one isn't a series. Clear recurrence flags so the leftover
// card renders as a normal solo event (no stack chrome, no Recurring badge).
async function demoteSingletonSeries(
  groupId: string | null | undefined,
): Promise<any | null> {
  if (!groupId) {
    return null;
  }
  const remaining = await Event.find({ recurrenceGroupId: groupId });
  if (remaining.length !== 1) {
    return null;
  }
  const solo = remaining[0];
  solo.isRecurring = false;
  solo.recurrenceGroupId = null as any;
  solo.recurrenceFrequency = null as any;
  (solo as any).recurrenceIndefinite = false;
  (solo as any).recurrenceOffsetsDays = [];
  await solo.save();
  return solo;
}

function applySoloFlags(target: any): void {
  target.isRecurring = false;
  target.recurrenceGroupId = null as any;
  target.recurrenceFrequency = null as any;
  (target as any).recurrenceIndefinite = false;
  (target as any).recurrenceOffsetsDays = [];
}

// Shift a stored "YYYY-MM-DD" date by `steps` recurrence intervals (steps may
// be negative). Mirrors the arithmetic used when a recurring series is first
// generated so re-sequencing an edited series stays perfectly in step.
type RecurrenceFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "custom";

const CUSTOM_OFFSET_MIN = 1;
const CUSTOM_OFFSET_MAX = 365;
const CUSTOM_OFFSET_DEFAULT = 7;

const normalizeCustomOffsets = (
  raw: unknown,
  expectedGaps: number,
): number[] => {
  const arr = Array.isArray(raw) ? raw : [];
  const offsets: number[] = [];
  for (let i = 0; i < expectedGaps; i++) {
    const n = Math.round(Number(arr[i]));
    if (Number.isFinite(n) && n >= CUSTOM_OFFSET_MIN) {
      offsets.push(Math.min(n, CUSTOM_OFFSET_MAX));
    } else {
      offsets.push(CUSTOM_OFFSET_DEFAULT);
    }
  }
  return offsets;
};

// Add whole days on a YYYY-MM-DD calendar date in UTC so Heroku's timezone
// doesn't shift the day. Used by custom series (irregular gaps).
const addDaysToIsoDate = (anchorDate: string, days: number): string => {
  const iso = toIsoDate(anchorDate);
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split("T")[0];
};

const customPatternGapCount = (
  recurrenceCount: unknown,
  rawOffsets: unknown,
): number => {
  const n = parseInt(String(recurrenceCount ?? ""), 10);
  if (Number.isFinite(n) && n >= 2) {
    return Math.min(n - 1, 11);
  }
  if (Array.isArray(rawOffsets) && rawOffsets.length >= 1) {
    return Math.min(rawOffsets.length, 11);
  }
  return 1;
};

const customOccurrenceDate = (
  anchorDate: string,
  offsets: number[],
  index: number,
): string => {
  let date = toIsoDate(anchorDate);
  const cycle = offsets.length > 0 ? offsets : [CUSTOM_OFFSET_DEFAULT];
  for (let i = 0; i < index; i++) {
    date = addDaysToIsoDate(
      date,
      cycle[i % cycle.length] ?? CUSTOM_OFFSET_DEFAULT,
    );
  }
  return date;
};

const shiftRecurrenceDate = (
  anchorDate: string,
  frequency: "weekly" | "biweekly" | "monthly",
  steps: number,
): string => {
  const d = new Date(anchorDate);
  if (frequency === "weekly") {
    d.setDate(d.getDate() + steps * 7);
  } else if (frequency === "biweekly") {
    d.setDate(d.getDate() + steps * 14);
  } else if (frequency === "monthly") {
    d.setMonth(d.getMonth() + steps);
  }
  return d.toISOString().split("T")[0];
};

const occurrenceDateAt = (
  anchorDate: string,
  frequency: RecurrenceFrequency | string,
  steps: number,
  offsets?: number[],
): string => {
  if (frequency === "custom") {
    return customOccurrenceDate(anchorDate, offsets || [], steps);
  }
  const cadence =
    frequency === "biweekly" || frequency === "monthly" ? frequency : "weekly";
  return shiftRecurrenceDate(anchorDate, cadence, steps);
};

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

    // Events created by someone blocked in either direction drop out of
    // the feed entirely, before any privacy rules are considered.
    const hiddenIds = currentUserId
      ? await blockService.getHiddenUserIds(String(currentUserId))
      : new Set<string>();

    const visibleEvents = allEvents.filter((event: any) => {
      if (hiddenIds.has(String(event.createdBy))) {
        return false;
      }

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
          // Top-level threads only: the opener (if it has text) plus
          // comments that aren't nested replies to the opener. Nested
          // comment.replies never count.
          commentCount: {
            $add: [
              {
                $cond: [
                  { $gt: [{ $strLenCP: { $ifNull: ["$text", ""] } }, 0] },
                  1,
                  0,
                ],
              },
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ["$comments", []] },
                    as: "c",
                    cond: { $ne: ["$$c.replyToPost", true] },
                  },
                },
              },
            ],
          },
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

    // Reached by direct link or a stale notification: an event by
    // someone blocked in either direction reads as gone, not forbidden,
    // since a distinct error would confirm the block to the other side.
    if (
      currentUserId &&
      (await blockService.isBlockedBetween(currentUserId, eventCreatorId))
    ) {
      return res.status(404).json({ message: "Event not found" });
    }

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
      durationMinutes,
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
      allowJoinRequests,
      showLocationPublicly,
      isVirtual,
      isRecurring,
      recurrenceFrequency,
      recurrenceCount,
      recurrenceIndefinite,
      startsAt,
      timezoneOffsetMinutes,
      venueId,
      venueName,
      groupId,
      sourceUrl,
      trackPayment,
    } = req.body;

    if (
      !name ||
      !location ||
      !time ||
      !date ||
      totalSpots === undefined ||
      totalSpots === null ||
      totalSpots === "" ||
      !eventType ||
      !createdBy
    ) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const spots = Number(totalSpots);
    if (!Number.isFinite(spots) || spots < 0 || !Number.isInteger(spots)) {
      return res.status(400).json({ message: "Invalid group size" });
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

    const storedDate = toIsoDate(date);
    const offsetMinutes =
      typeof timezoneOffsetMinutes === "number"
        ? timezoneOffsetMinutes
        : typeof timezoneOffsetMinutes === "string" &&
            timezoneOffsetMinutes !== ""
          ? Number(timezoneOffsetMinutes)
          : undefined;

    const resolveStarts = (occurrenceDate: string, occurrenceStartsAt?: unknown) =>
      resolveEventStartsAt({
        startsAt: (occurrenceStartsAt as any) || undefined,
        date: occurrenceDate,
        time,
        timezoneOffsetMinutes: Number.isFinite(offsetMinutes as number)
          ? (offsetMinutes as number)
          : undefined,
      }) || undefined;

    const baseEventData = {
      name,
      location,
      time,
      durationMinutes: normalizeDuration(durationMinutes),
      totalSpots: spots,
      eventType,
      createdBy,
      createdByUsername: createdByUsername || user.username,
      rosterSpotsFilled: 0,
      roster: [],
      latitude: isVirtual === true ? undefined : latitude,
      longitude: isVirtual === true ? undefined : longitude,
      jerseyColors: jerseyColors || [],
      trackPayment: trackPayment === true,
      privacy: eventPrivacy,
      invitedUsers: mergedInvitedUsers,
      allowJoinRequests: allowJoinRequests !== false,
      showLocationPublicly: showLocationPublicly === true,
      isVirtual: isVirtual === true,
      timezoneOffsetMinutes: Number.isFinite(offsetMinutes as number)
        ? (offsetMinutes as number)
        : undefined,
      // Optional venue listing reference (set when a user planned this event
      // from the Venues tab via "Plan event from this page").
      venueId: isVirtual === true ? undefined : venueId || undefined,
      venueName: isVirtual === true ? undefined : venueName || undefined,
      // Optional Group reference (set when a user picked "Invite a group"
      // during event creation). Powers the "via [Group]" badge.
      groupId: resolvedGroupId,
      groupName: resolvedGroupName,
      sourceUrl: sourceUrl || undefined,
    };

    if (isRecurring && recurrenceFrequency && (recurrenceCount > 1 || recurrenceIndefinite || recurrenceCount === 0 || recurrenceCount === "0" || recurrenceCount === "indefinite")) {
      const recurrenceGroupId = new mongoose.Types.ObjectId().toString();
      const isCustom = recurrenceFrequency === "custom";
      const { count: resolvedCount, indefinite } = resolveRecurrenceCount(
        recurrenceCount,
        recurrenceIndefinite ?? req.body?.recurrenceIndefinite,
      );
      const parsedCustomCount = parseInt(String(recurrenceCount ?? 4), 10);
      const finiteCustomCount = Math.min(
        Math.max(
          !Number.isFinite(parsedCustomCount) || parsedCustomCount < 2
            ? 4
            : parsedCustomCount,
          2,
        ),
        12,
      );
      const count = isCustom && !indefinite ? finiteCustomCount : resolvedCount;
      const customOffsets = isCustom
        ? normalizeCustomOffsets(
            req.body?.recurrenceOffsetsDays,
            indefinite
              ? customPatternGapCount(
                  recurrenceCount,
                  req.body?.recurrenceOffsetsDays,
                )
              : count - 1,
          )
        : [];
      const eventsToCreate = [];

      for (let i = 0; i < count; i++) {
        const occurrenceDate = occurrenceDateAt(
          storedDate,
          recurrenceFrequency,
          i,
          customOffsets,
        );
        eventsToCreate.push({
          ...baseEventData,
          date: occurrenceDate,
          // Only the anchor occurrence may carry the client's absolute
          // startsAt; later ones are derived from date + time + offset.
          startsAt: resolveStarts(
            occurrenceDate,
            i === 0 ? startsAt : undefined,
          ),
          isRecurring: true,
          recurrenceGroupId,
          recurrenceFrequency,
          recurrenceIndefinite: indefinite,
          recurrenceOffsetsDays: customOffsets,
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
        const seriesLabel = indefinite
          ? `${recurrenceFrequency}, no end date`
          : `${count} recurring events`;
        if (groupRecipients.length > 0 && resolvedGroupName) {
          notificationService.sendPushNotificationToMany(
            groupRecipients,
            `${resolvedGroupName} has a new event`,
            `${name} — ${seriesLabel}`,
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
            `You've been invited to "${name}" (${seriesLabel})`,
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
          text: indefinite
            ? `📅 ${name} scheduled — ${recurrenceFrequency}, no end date`
            : `📅 ${name} scheduled — ${count} recurring events`,
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
        date: storedDate,
        startsAt: resolveStarts(storedDate, startsAt),
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
      durationMinutes,
      date,
      totalSpots,
      eventType,
      createdByUsername,
      latitude,
      longitude,
      jerseyColors,
      privacy,
      invitedUsers,
      allowJoinRequests,
      showLocationPublicly,
      isVirtual,
      isRecurring,
      recurrenceFrequency,
      recurrenceCount,
      startsAt,
      timezoneOffsetMinutes,
      trackPayment,
    } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    const oldValues: Record<string, any> = {
      name: event.name,
      date: event.date,
      time: event.time,
      durationMinutes: event.durationMinutes,
      location: event.location,
      totalSpots: event.totalSpots,
      eventType: event.eventType,
    };

    event.name = name || event.name;
    event.location = location || event.location;
    event.time = time || event.time;
    // Sent explicitly as null to clear a previously set duration.
    if (durationMinutes !== undefined) {
      event.durationMinutes = normalizeDuration(durationMinutes);
    }
    event.date = date ? toIsoDate(date) : event.date;
    // `0` is a valid "unlimited" value, so don't treat it as falsy.
    if (totalSpots !== undefined && totalSpots !== null && totalSpots !== "") {
      const spots = Number(totalSpots);
      if (Number.isFinite(spots) && spots >= 0 && Number.isInteger(spots)) {
        event.totalSpots = spots;
      }
    }

    if (
      typeof timezoneOffsetMinutes === "number" ||
      (typeof timezoneOffsetMinutes === "string" &&
        timezoneOffsetMinutes !== "")
    ) {
      const offset = Number(timezoneOffsetMinutes);
      if (Number.isFinite(offset)) {
        (event as any).timezoneOffsetMinutes = offset;
      }
    }

    // Keep the absolute start in sync whenever date/time (or an explicit
    // startsAt) changes — this is what the reminder scheduler trusts.
    if (date || time || startsAt || timezoneOffsetMinutes !== undefined) {
      const resolved = resolveEventStartsAt({
        startsAt,
        date: event.date,
        time: event.time,
        timezoneOffsetMinutes: (event as any).timezoneOffsetMinutes,
      });
      if (resolved) {
        (event as any).startsAt = resolved;
      }
    }
    event.eventType = eventType || event.eventType;
    event.createdByUsername = createdByUsername || event.createdByUsername;

    if (isVirtual !== undefined) {
      event.isVirtual = isVirtual === true;
      if (event.isVirtual) {
        event.latitude = undefined;
        event.longitude = undefined;
        event.venueId = undefined;
        event.venueName = undefined;
      }
    }
    if (latitude !== undefined && !event.isVirtual) event.latitude = latitude;
    if (longitude !== undefined && !event.isVirtual)
      event.longitude = longitude;
    if (jerseyColors !== undefined) event.jerseyColors = jerseyColors;
    if (trackPayment !== undefined) event.trackPayment = trackPayment === true;
    if (allowJoinRequests !== undefined)
      event.allowJoinRequests = allowJoinRequests !== false;
    if (showLocationPublicly !== undefined)
      event.showLocationPublicly = showLocationPublicly === true;

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

    // Scrub jersey / position / paid fields when type or team settings change
    // (e.g. Hockey → Other must not leave "Forward" / "Black" on players).
    normalizeRosterForEventShape(event);

    await event.save();

    if (invitedUsers !== undefined) {
      const newlyInvited = invitedUsers.filter(
        (id: string) => !previousInvitedUsers.includes(id),
      );
      for (const id of newlyInvited) {
        clearUserRemovedFromEvent(event, id);
      }
      if (newlyInvited.length > 0) {
        await event.save();
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
      durationMinutes: event.durationMinutes,
      location: event.location,
      totalSpots: event.totalSpots,
      eventType: event.eventType,
    };

    const fieldLabels: Record<string, string> = {
      name: "name",
      date: "date",
      time: "time",
      durationMinutes: "duration",
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

    // ── Recurrence editing ──────────────────────────────────────────────
    // Reconcile the series to match the recurrence the editor asked for. The
    // client sends `isRecurring` (+ frequency/count) only when it surfaced the
    // recurrence controls, so a missing value means "leave recurrence alone"
    // and we fall back to the legacy date-only re-sequence below. `count` is
    // the number of occurrences from the edited event *forward* (inclusive).
    let seriesChanged = false;
    const recurrenceIntentProvided = typeof isRecurring === "boolean";
    const wasRecurring = !!(event.isRecurring && event.recurrenceGroupId);
    const editedId = event._id.toString();
    const affectedEventIds = new Set<string>([editedId]);

    const buildOccurrence = (occurrenceDate: string, groupId: string) => ({
      name: event.name,
      location: event.location,
      time: event.time,
      durationMinutes: event.durationMinutes,
      date: occurrenceDate,
      startsAt: resolveEventStartsAt({
        date: occurrenceDate,
        time: event.time,
        timezoneOffsetMinutes: (event as any).timezoneOffsetMinutes,
      }),
      timezoneOffsetMinutes: (event as any).timezoneOffsetMinutes,
      totalSpots: event.totalSpots,
      rosterSpotsFilled: 0,
      eventType: event.eventType,
      createdBy: event.createdBy,
      createdByUsername: event.createdByUsername,
      roster: [],
      waitlist: [],
      rsvps: [],
      joinRequests: [],
      isVirtual: !!(event as any).isVirtual,
      latitude: (event as any).isVirtual ? undefined : event.latitude,
      longitude: (event as any).isVirtual ? undefined : event.longitude,
      jerseyColors: event.jerseyColors || [],
      trackPayment: !!(event as any).trackPayment,
      privacy: event.privacy,
      invitedUsers: event.invitedUsers || [],
      allowJoinRequests: event.allowJoinRequests,
      showLocationPublicly: event.showLocationPublicly,
      isRecurring: true,
      recurrenceGroupId: groupId,
      recurrenceFrequency: event.recurrenceFrequency,
      recurrenceIndefinite: !!(event as any).recurrenceIndefinite,
      recurrenceOffsetsDays: (event as any).recurrenceOffsetsDays || [],
      venueId: (event as any).isVirtual ? undefined : event.venueId,
      venueName: (event as any).isVirtual ? undefined : event.venueName,
      groupId: event.groupId,
      groupName: event.groupName,
      sourceUrl: event.sourceUrl,
    });

    if (recurrenceIntentProvided) {
      const frequency = (recurrenceFrequency ||
        event.recurrenceFrequency ||
        "weekly") as RecurrenceFrequency;
      const isCustom = frequency === "custom";
      const { count: resolvedCount, indefinite } = resolveRecurrenceCount(
        recurrenceCount,
        req.body?.recurrenceIndefinite,
      );
      // Allow 1 so re-saving the last occurrence of a finite series (forward
      // count of 1) is a no-op. Indefinite always uses the horizon size.
      const targetCount = indefinite
        ? resolvedCount
        : Math.min(
            Math.max(parseInt(String(recurrenceCount ?? 1), 10) || 1, 1),
            12,
          );
      const customOffsets = isCustom
        ? normalizeCustomOffsets(
            req.body?.recurrenceOffsetsDays,
            indefinite
              ? customPatternGapCount(
                  recurrenceCount,
                  req.body?.recurrenceOffsetsDays,
                )
              : Math.max(targetCount - 1, 0),
          )
        : [];
      const dateForIndex = (k: number) =>
        occurrenceDateAt(event.date, frequency, k, customOffsets);

      if (!isRecurring && wasRecurring) {
        // Recurring → single: keep only the edited occurrence, delete the rest
        // of the series (regardless of date) so a lone standalone event remains.
        await Event.deleteMany({
          recurrenceGroupId: event.recurrenceGroupId,
          _id: { $ne: event._id },
        });
        event.isRecurring = false;
        event.recurrenceGroupId = null as any;
        event.recurrenceFrequency = null as any;
        (event as any).recurrenceIndefinite = false;
        (event as any).recurrenceOffsetsDays = [];
        await event.save();
        seriesChanged = true;
      } else if (isRecurring && !wasRecurring) {
        // Single → recurring: this event becomes occurrence #1 and anchors a
        // brand-new series; generate the remaining occurrences from its date.
        const newGroupId = new mongoose.Types.ObjectId().toString();
        event.isRecurring = true;
        event.recurrenceGroupId = newGroupId;
        event.recurrenceFrequency = frequency;
        (event as any).recurrenceIndefinite = indefinite;
        (event as any).recurrenceOffsetsDays = customOffsets;
        await event.save();
        const seriesCount = indefinite ? resolvedCount : Math.max(targetCount, 2);
        const toCreate = [];
        for (let k = 1; k < seriesCount; k++) {
          toCreate.push(
            buildOccurrence(dateForIndex(k), newGroupId),
          );
        }
        if (toCreate.length > 0) {
          await Event.insertMany(toCreate);
        }
        seriesChanged = true;
      } else if (isRecurring && wasRecurring) {
        // Still recurring. `editScope` decides who gets the field updates:
        //   this   — only the edited card (already saved above)
        //   count  — this card + the next N-1 by date
        //   series — whole series (also re-shapes count / frequency)
        // Virtual vs physical (and therefore the map) stays per-occurrence
        // unless this scope copies isVirtual onto those targets.
        const rawScope = String(req.body?.editScope || "series").toLowerCase();
        const editScope =
          rawScope === "this" || rawScope === "count" ? rawScope : "series";

        const applySharedFields = (t: any) => {
          t.name = event.name;
          t.location = event.location;
          t.time = event.time;
          t.durationMinutes = event.durationMinutes;
          t.totalSpots = event.totalSpots;
          t.eventType = event.eventType;
          t.createdByUsername = event.createdByUsername;
          t.privacy = event.privacy;
          t.allowJoinRequests = event.allowJoinRequests;
          t.showLocationPublicly = event.showLocationPublicly;
          t.jerseyColors = event.jerseyColors || [];
          (t as any).trackPayment = !!(event as any).trackPayment;
          t.isVirtual = !!(event as any).isVirtual;
          if (t.isVirtual) {
            t.latitude = null;
            t.longitude = null;
            t.venueId = null;
            t.venueName = null;
          } else {
            t.latitude = event.latitude;
            t.longitude = event.longitude;
            t.venueId = event.venueId;
            t.venueName = event.venueName;
          }
          t.invitedUsers = event.invitedUsers || [];
          t.groupId = event.groupId;
          t.groupName = event.groupName;
          t.sourceUrl = event.sourceUrl;
          t.recurrenceIndefinite = !!(event as any).recurrenceIndefinite;
          (t as any).recurrenceOffsetsDays =
            (event as any).recurrenceOffsetsDays || [];
          (t as any).startsAt = resolveEventStartsAt({
            date: t.date,
            time: event.time,
            timezoneOffsetMinutes: (event as any).timezoneOffsetMinutes,
          });
          (t as any).timezoneOffsetMinutes = (
            event as any
          ).timezoneOffsetMinutes;
          normalizeRosterForEventShape(t);
        };

        if (editScope !== "this") {
          event.recurrenceFrequency = frequency;
          (event as any).recurrenceIndefinite = indefinite;
          (event as any).recurrenceOffsetsDays = customOffsets;
          await event.save();

          const series = await Event.find({
            recurrenceGroupId: event.recurrenceGroupId,
          });
          const ordered = series
            .map((e) => ({
              e,
              sortDate:
                e._id.toString() === editedId
                  ? String(oldValues.date)
                  : e.date,
            }))
            .sort((a, b) =>
              a.sortDate < b.sortDate
                ? -1
                : a.sortDate > b.sortDate
                  ? 1
                  : 0,
            );
          const editedIndex = ordered.findIndex(
            (o) => o.e._id.toString() === editedId,
          );
          const before = ordered.slice(0, editedIndex).map((o) => o.e);
          const forward = ordered.slice(editedIndex).map((o) => o.e);
          const groupId = String(event.recurrenceGroupId);
          const ops: Promise<any>[] = [];
          const dateChanged = String(oldValues.date) !== String(event.date);

          if (editScope === "count") {
            const requested =
              parseInt(String(req.body?.editScopeCount ?? 1), 10) || 1;
            const n = Math.min(
              Math.max(requested, 1),
              Math.max(forward.length, 1),
            );
            for (let k = 0; k < n; k++) {
              const existing = forward[k];
              if (!existing) {
                continue;
              }
              affectedEventIds.add(existing._id.toString());
              if (existing._id.toString() !== editedId) {
                applySharedFields(existing);
              }
              // Custom gaps (and a moved start date) re-lay out this slice
              // even when the edited card's date didn't change.
              if (dateChanged || isCustom) {
                const occurrenceDate = dateForIndex(k);
                existing.date = occurrenceDate;
                (existing as any).startsAt = resolveEventStartsAt({
                  date: occurrenceDate,
                  time: event.time,
                  timezoneOffsetMinutes: (event as any)
                    .timezoneOffsetMinutes,
                });
              }
              existing.recurrenceFrequency = frequency;
              existing.isRecurring = true;
              (existing as any).recurrenceIndefinite = indefinite;
              (existing as any).recurrenceOffsetsDays = customOffsets;
              ops.push(existing.save());
            }
          } else {
            // Entire series: keep dates on earlier cards, re-sequence from
            // this one forward, create/delete to match the requested count.
            for (const e of before) {
              applySharedFields(e);
              affectedEventIds.add(e._id.toString());
              ops.push(e.save());
            }

            for (let k = 0; k < targetCount; k++) {
              const occurrenceDate = dateForIndex(k);
              const existing = forward[k];
              if (existing) {
                affectedEventIds.add(existing._id.toString());
                if (existing._id.toString() !== editedId) {
                  applySharedFields(existing);
                }
                existing.date = occurrenceDate;
                existing.recurrenceFrequency = frequency;
                existing.isRecurring = true;
                (existing as any).recurrenceIndefinite = indefinite;
                (existing as any).recurrenceOffsetsDays = customOffsets;
                (existing as any).startsAt = resolveEventStartsAt({
                  date: occurrenceDate,
                  time: event.time,
                  timezoneOffsetMinutes: (event as any)
                    .timezoneOffsetMinutes,
                });
                (existing as any).timezoneOffsetMinutes = (
                  event as any
                ).timezoneOffsetMinutes;
                ops.push(existing.save());
              } else {
                ops.push(
                  Event.create(
                    buildOccurrence(occurrenceDate, groupId),
                  ).then((doc: any) => {
                    if (doc?._id) {
                      affectedEventIds.add(String(doc._id));
                    }
                  }) as any,
                );
              }
            }
            for (let k = targetCount; k < forward.length; k++) {
              ops.push(Event.deleteOne({ _id: forward[k]._id }) as any);
            }
          }

          await Promise.all(ops);
          seriesChanged = true;
          const demoted = await demoteSingletonSeries(groupId);
          if (demoted && String(demoted._id) === editedId) {
            applySoloFlags(event);
          }
        }
      }
    } else if (
      changedFields.includes("date") &&
      event.isRecurring &&
      event.recurrenceGroupId &&
      event.recurrenceFrequency
    ) {
      // Legacy path (client didn't send recurrence intent): just slide the
      // edited occurrence and everything after it so the series stays evenly
      // spaced. Earlier/past occurrences are left untouched.
      const series = await Event.find({
        recurrenceGroupId: event.recurrenceGroupId,
      });
      if (series.length > 1) {
        const ordered = series
          .map((e) => ({
            e,
            sortDate:
              e._id.toString() === editedId ? String(oldValues.date) : e.date,
          }))
          .sort((a, b) =>
            a.sortDate < b.sortDate ? -1 : a.sortDate > b.sortDate ? 1 : 0,
          );
        const editedIndex = ordered.findIndex(
          (o) => o.e._id.toString() === editedId,
        );
        const anchor = event.date;
        const frequency = event.recurrenceFrequency as RecurrenceFrequency;
        const customOffsets =
          frequency === "custom"
            ? normalizeCustomOffsets(
                (event as any).recurrenceOffsetsDays,
                Math.max(ordered.length - editedIndex - 1, 0),
              )
            : [];
        const saves: Promise<any>[] = [];
        for (let j = editedIndex; j < ordered.length; j++) {
          const target = ordered[j].e;
          if (target._id.toString() === editedId) continue;
          const nextDate = occurrenceDateAt(
            anchor,
            frequency,
            j - editedIndex,
            customOffsets,
          );
          if (target.date !== nextDate) {
            target.date = nextDate;
            affectedEventIds.add(target._id.toString());
            saves.push(target.save());
          }
        }
        if (saves.length > 0) {
          await Promise.all(saves);
          seriesChanged = true;
        }
      }
    }

    const actorId = (req as any).user?.id
      ? String((req as any).user.id)
      : null;
    const affectedDocs = await Event.find({
      _id: { $in: Array.from(affectedEventIds) },
    }).select("roster invitedUsers waitlist name date time");

    const recipientToEventId = collectUpdateRecipients(affectedDocs, actorId);
    if (recipientToEventId.size > 0) {
      const multi = affectedEventIds.size > 1;
      const scopeNote = multi ? ` (${affectedEventIds.size} events)` : "";
      const notifBody =
        changedFields.length > 0
          ? `${event.name}${scopeNote}: ${changeDescriptions.join(", ")}`
          : `Event "${event.name}" has been updated${scopeNote}`;
      const title = multi ? "Series updated" : "Event Updated";

      const byEvent = new Map<string, string[]>();
      for (const [userId, targetEventId] of recipientToEventId) {
        const list = byEvent.get(targetEventId) || [];
        list.push(userId);
        byEvent.set(targetEventId, list);
      }

      const dateByEvent = new Map(
        affectedDocs.map((d: any) => [String(d._id), String(d.date || "")]),
      );
      const timeByEvent = new Map(
        affectedDocs.map((d: any) => [String(d._id), String(d.time || "")]),
      );

      await Promise.all(
        Array.from(byEvent.entries()).map(([targetEventId, userIds]) =>
          notificationService.sendPushNotificationToMany(
            userIds,
            title,
            notifBody,
            "event_update",
            {
              eventId: targetEventId,
              eventName: event.name,
              date: dateByEvent.get(targetEventId) || event.date,
              time: timeByEvent.get(targetEventId) || event.time,
              changedFields: changedFields.join(","),
            },
          ),
        ),
      );
    }

    socketService.emitToAll("events:refresh", {
      reason: seriesChanged ? "series-changed" : "updated",
      eventId: event._id.toString(),
      recurrenceGroupId: seriesChanged ? event.recurrenceGroupId : undefined,
    });
    socketService.emitToEvent(event._id.toString(), "event:updated", { event });

    const payload =
      typeof (event as any).toObject === "function"
        ? (event as any).toObject()
        : event;
    res.status(200).json({
      ...payload,
      affectedEventIds: Array.from(affectedEventIds),
    });
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

    // Public events default to gated join (request → approve). When the
    // creator turns off allowJoinRequests, anyone can self-join the roster
    // directly (open join). The creator can always add anyone.
    const actorId = (req as any).user?.id
      ? String((req as any).user.id)
      : null;

    // Host-kicked users can't self-join; creator adding them clears the ban.
    if (entry.userId && isRemovedFromEvent(event, String(entry.userId))) {
      const creatorAdding =
        !!actorId && String(event.createdBy) === actorId;
      if (!creatorAdding) {
        return res.status(403).json({
          message:
            "You've been removed from this event. Ask the host to invite you again.",
          removed: true,
        });
      }
      clearUserRemovedFromEvent(event, String(entry.userId));
    }

    if (
      (event.privacy || "public") === "public" &&
      event.allowJoinRequests !== false &&
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

    if (entry.userId) {
      expandCapacityForInvitedJoiner(event, String(entry.userId));
    }

    if (isRosterFull(event)) {
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
      !isUnlimitedSpots(event.totalSpots) &&
      event.spotReservation &&
      entry.userId !== event.spotReservation.userId &&
      event.roster.length >= event.totalSpots - 1
    ) {
      return res.status(400).json({
        message: "The last spot is temporarily reserved for another player",
        reserved: true,
      });
    }

    const fields = resolveJoinParticipantFields(event, {
      position: entry.position,
      jerseyColor: entry.jerseyColor,
      paidStatus: entry.paidStatus,
    });
    event.roster.push({
      ...entry,
      ...fields,
    });
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
      totalSpots: event.totalSpots,
    });
    broadcastRosterChanged(event);
    socketService.emitToAll("events:refresh", { reason: "roster_join", eventId });

    return res.status(200).json({
      success: true,
      roster: event.roster,
      totalSpots: event.totalSpots,
    });
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
      totalSpots: event.totalSpots,
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
    const teaser: any = {
      _id: event._id,
      name: event.name,
      eventType: event.eventType,
      date: event.date,
      time: event.time,
      durationMinutes: event.durationMinutes,
      totalSpots: event.totalSpots,
      rosterSpotsFilled:
        event.rosterSpotsFilled ?? (event.roster || []).length,
      createdBy: event.createdBy,
      createdByUsername: event.createdByUsername,
      privacy,
      // Creator controls surfaced on the teaser so the card can render the
      // right join affordance / location visibility without full access.
      allowJoinRequests: event.allowJoinRequests !== false,
      showLocationPublicly: event.showLocationPublicly === true,
      isRecurring: event.isRecurring,
      recurrenceGroupId: event.recurrenceGroupId,
      recurrenceFrequency: event.recurrenceFrequency,
      recurrenceIndefinite: !!(event as any).recurrenceIndefinite,
      createdAt: event.createdAt,
      likes: event.likes || [],
      reactions: event.reactions || [],
      isGated: true,
      myJoinRequestStatus: pending ? "pending" : "none",
      roster: [],
      rsvps: [],
      waitlist: [],
      joinRequests: [],
    };
    // Optionally reveal the location/map on the public teaser if the creator
    // opted in; everything else stays hidden until approval.
    if (event.showLocationPublicly === true) {
      teaser.location = event.location;
      teaser.latitude = event.latitude;
      teaser.longitude = event.longitude;
    }
    return teaser;
  }

  const full: any = { ...event, isGated: false, myJoinRequestStatus: "none" };
  if (!isCreator) {
    // Non-creators (even approved ones) never see who else is waiting.
    full.joinRequests = [];
    full.guestAddRequests = [];
  }
  return full;
}

router.delete(
  "/:id/roster/:username",
  async (req: Request, res: Response) => {
    const eventId = req.params.id;
    const username = req.params.username;
    try {
      const actor = (req as any).user;
      if (!actor?.id) {
        return res.status(401).json({ message: "Authentication required" });
      }
      const actorId = String(actor.id);

      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }

      const target = (event.roster || []).find(
        (p: any) => p.username === username,
      );
      if (!target) {
        return res
          .status(404)
          .json({ message: "Participant not found in roster" });
      }

      const targetUserId = target.userId ? String(target.userId) : null;
      const isSelf =
        (targetUserId && targetUserId === actorId) ||
        (!!actor.username &&
          String(actor.username).toLowerCase() ===
            String(username).toLowerCase());
      const isCreator = String(event.createdBy) === actorId;
      if (!isSelf && !isCreator) {
        return res.status(403).json({
          message: "Only the host can remove other players from this event",
        });
      }
      // Host leaving their own event uses the self path; don't "boot" yourself.
      const isBoot = isCreator && !isSelf;

      const wasFull = isRosterFull(event);
      event.roster = event.roster.filter((p: any) => p.username !== username);
      event.rosterSpotsFilled = event.roster.length;

      if (isBoot && targetUserId) {
        // Full kick: off roster, off invite/waitlist/RSVP queues, and banned
        // from rejoining until the host re-invites them.
        purgeUserFromEventLists(event, targetUserId);
        markUserRemovedFromEvent(event, targetUserId);
      } else if (targetUserId) {
        // Self-leave: clear waitlist/RSVP residue but keep invite eligibility.
        event.waitlist = (event.waitlist || []).filter(
          (w: any) => String(w.userId) !== targetUserId,
        );
        event.rsvps = (event.rsvps || []).filter(
          (r: any) => String(r.userId) !== targetUserId,
        );
        if (
          event.spotReservation &&
          String(event.spotReservation.userId) === targetUserId
        ) {
          event.spotReservation = null;
        }
      }

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

      if (isBoot && targetUserId) {
        notificationService.sendPushNotification({
          userId: targetUserId,
          title: "Removed from event",
          body: `You've been removed from "${event.name}" by the host.`,
          type: "event_removed",
          data: { eventId: event._id.toString(), eventName: event.name },
        });
      } else if (event.createdBy && !isBoot) {
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
        invitedUsers: event.invitedUsers,
        removedUserIds: event.removedUserIds || [],
        rsvps: event.rsvps,
        joinRequests: event.joinRequests,
      });
      broadcastRosterChanged(event);
      socketService.emitToAll("events:refresh", {
        reason: isBoot ? "roster_boot" : "roster_leave",
        eventId,
      });

      return res.status(200).json({
        success: true,
        roster: event.roster,
        invitedUsers: event.invitedUsers || [],
        removedUserIds: event.removedUserIds || [],
        waitlist: event.waitlist || [],
        rsvps: event.rsvps || [],
        booted: isBoot,
      });
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
  const { userId, username, profilePicUrl, status, position, jerseyColor, paidStatus } =
    req.body;
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

    // Public events with approval required can't be joined via RSVP — use
    // join-request instead. Open-join public events (`allowJoinRequests`
    // false) allow "going" as a direct roster add.
    if (
      (event.privacy || "public") === "public" &&
      event.allowJoinRequests !== false &&
      String(event.createdBy) !== String(userId)
    ) {
      return res.status(403).json({
        message: "This event requires approval — request to join instead.",
        requiresApproval: true,
      });
    }

    if (isRemovedFromEvent(event, String(userId))) {
      return res.status(403).json({
        message:
          "You've been removed from this event. Ask the host to invite you again.",
        removed: true,
      });
    }

    const onRoster = event.roster.some((p: any) => p.userId === userId);

    if (status === "going") {
      // Drop any maybe/cant reply, then take a roster spot if there's room
      // (respecting a spot briefly held for a waitlisted user).
      event.rsvps = event.rsvps.filter((r: any) => r.userId !== userId);
      if (!onRoster) {
        expandCapacityForInvitedJoiner(event, String(userId));
        const reservationForOther =
          !!event.spotReservation &&
          event.spotReservation.userId !== userId &&
          new Date(event.spotReservation.expiresAt) > new Date();
        const capacity = reservationForOther
          ? event.totalSpots - 1
          : event.totalSpots;
        if (
          !isUnlimitedSpots(event.totalSpots) &&
          event.roster.length >= capacity
        ) {
          return res.status(400).json({ message: "Event is full", full: true });
        }
        const fields = resolveJoinParticipantFields(event, {
          position,
          jerseyColor,
          paidStatus,
        });
        event.roster.push({
          username,
          userId,
          profilePicUrl,
          ...fields,
        } as any);
        event.rosterSpotsFilled = event.roster.length;
        if (event.spotReservation && event.spotReservation.userId === userId) {
          event.spotReservation = null;
        }
        event.waitlist = event.waitlist.filter((w: any) => w.userId !== userId);
      } else {
        // Already going — allow updating role/jersey/paid from the join prompt.
        event.roster = event.roster.map((p: any) => {
          if (String(p.userId) !== String(userId)) {
            return p;
          }
          const plain = p?.toObject ? p.toObject() : {...p};
          const fields = resolveJoinParticipantFields(event, {
            position: position ?? plain.position,
            jerseyColor: jerseyColor ?? plain.jerseyColor,
            paidStatus: paidStatus ?? plain.paidStatus,
          });
          return {...plain, ...fields, username, profilePicUrl};
        });
      }
    } else {
      // Maybe / can't: free their roster spot (promoting the waitlist if the
      // event was full), then record the reply.
      const wasFull = isRosterFull(event);
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
      totalSpots: event.totalSpots,
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
      totalSpots: event.totalSpots,
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
    if (event.allowJoinRequests === false) {
      return res
        .status(403)
        .json({ message: "This event is not accepting join requests" });
    }
    if (isRemovedFromEvent(event, userId)) {
      return res.status(403).json({
        message:
          "You've been removed from this event. Ask the host to invite you again.",
        removed: true,
      });
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
      if (isRosterFull(event)) {
        return res.status(400).json({ message: "Event is full", full: true });
      }

      clearUserRemovedFromEvent(event, requesterId);
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

// Invitee / roster member asks the creator to invite someone else.
router.post("/:id/guest-add-request", async (req: Request, res: Response) => {
  const currentUser = (req as any).user;
  if (!currentUser?.id) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const userId = String(currentUser.id);
  const {
    proposedUserId,
    proposedUsername,
    proposedProfilePicUrl,
    requestedByUsername,
  } = req.body;
  if (!proposedUserId || !proposedUsername) {
    return res.status(400).json({ message: "proposedUserId and proposedUsername are required" });
  }
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    if (String(event.createdBy) === userId) {
      return res.status(400).json({
        message: "Creators can invite directly — use the invite endpoint",
      });
    }
    const onRoster = (event.roster || []).some(
      (p: any) => String(p.userId) === userId,
    );
    const isInvited = (event.invitedUsers || []).includes(userId);
    if (!onRoster && !isInvited) {
      return res.status(403).json({
        message: "Only invitees or roster members can suggest guests",
      });
    }
    if (String(proposedUserId) === userId) {
      return res.status(400).json({ message: "You can't suggest yourself" });
    }
    if ((event.invitedUsers || []).includes(String(proposedUserId))) {
      return res.status(409).json({ message: "That person is already invited" });
    }
    if (isRemovedFromEvent(event, String(proposedUserId))) {
      return res.status(403).json({
        message:
          "That person was removed by the host and can only be re-invited by them",
        removed: true,
      });
    }
    if (
      (event.roster || []).some(
        (p: any) => String(p.userId) === String(proposedUserId),
      )
    ) {
      return res.status(409).json({ message: "That person is already on the roster" });
    }
    if (!(event as any).guestAddRequests) {
      (event as any).guestAddRequests = [];
    }
    const already = (event as any).guestAddRequests.some(
      (r: any) =>
        String(r.proposedUserId) === String(proposedUserId) &&
        String(r.requestedBy) === userId,
    );
    if (!already) {
      (event as any).guestAddRequests.push({
        requestedBy: userId,
        requestedByUsername:
          requestedByUsername || currentUser.username || "",
        proposedUserId: String(proposedUserId),
        proposedUsername,
        proposedProfilePicUrl,
        requestedAt: new Date(),
      });
      await event.save();

      notificationService.sendPushNotification({
        userId: String(event.createdBy),
        title: "Guest suggestion",
        body: `${requestedByUsername || "Someone"} wants to add ${proposedUsername} to "${event.name}"`,
        type: "event_guest_add_request",
        data: {
          eventId: event._id.toString(),
          eventName: event.name,
          proposedUserId: String(proposedUserId),
        },
      });
      socketService.emitToUser(String(event.createdBy), "events:refresh", {
        reason: "guest_add_request",
        eventId: event._id.toString(),
      });
    }

    return res.status(200).json({
      success: true,
      guestAddRequests: (event as any).guestAddRequests,
    });
  } catch (error) {
    console.error("Error creating guest-add request:", error);
    return res.status(500).json({ message: "Error creating guest-add request" });
  }
});

router.post(
  "/:id/guest-add-request/:proposedUserId/approve",
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
          .json({ message: "Only the event creator can approve guest adds" });
      }
      const proposedUserId = String(req.params.proposedUserId);
      const requests = ((event as any).guestAddRequests || []) as any[];
      const request = requests.find(
        (r: any) => String(r.proposedUserId) === proposedUserId,
      );
      if (!request) {
        return res.status(404).json({ message: "Guest-add request not found" });
      }

      if (!event.invitedUsers) {
        event.invitedUsers = [];
      }
      clearUserRemovedFromEvent(event, proposedUserId);
      if (!event.invitedUsers.includes(proposedUserId)) {
        event.invitedUsers.push(proposedUserId);
      }
      (event as any).guestAddRequests = requests.filter(
        (r: any) => String(r.proposedUserId) !== proposedUserId,
      );
      expandCapacityForPendingInvites(event);
      await event.save();

      notificationService.sendPushNotification({
        userId: proposedUserId,
        title: "You're invited",
        body: `You've been invited to "${event.name}"`,
        type: "event_invitation",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
      notificationService.sendPushNotification({
        userId: String(request.requestedBy),
        title: "Guest approved",
        body: `${request.proposedUsername} was invited to "${event.name}"`,
        type: "event_guest_add_approved",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
      socketService.emitToUser(String(event.createdBy), "events:refresh", {
        reason: "guest_add_approved",
        eventId: event._id.toString(),
      });
      socketService.emitToUser(String(request.requestedBy), "events:refresh", {
        reason: "guest_add_approved",
        eventId: event._id.toString(),
      });

      return res.status(200).json({
        success: true,
        invitedUsers: event.invitedUsers,
        guestAddRequests: (event as any).guestAddRequests,
        totalSpots: event.totalSpots,
      });
    } catch (error) {
      console.error("Error approving guest-add request:", error);
      return res
        .status(500)
        .json({ message: "Error approving guest-add request" });
    }
  },
);

router.post(
  "/:id/guest-add-request/:proposedUserId/deny",
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
          .json({ message: "Only the event creator can deny guest adds" });
      }
      const proposedUserId = String(req.params.proposedUserId);
      const requests = ((event as any).guestAddRequests || []) as any[];
      const request = requests.find(
        (r: any) => String(r.proposedUserId) === proposedUserId,
      );
      (event as any).guestAddRequests = requests.filter(
        (r: any) => String(r.proposedUserId) !== proposedUserId,
      );
      await event.save();

      if (request) {
        notificationService.sendPushNotification({
          userId: String(request.requestedBy),
          title: "Guest suggestion declined",
          body: `${request.proposedUsername} wasn't added to "${event.name}"`,
          type: "event_guest_add_denied",
          data: { eventId: event._id.toString(), eventName: event.name },
        });
        socketService.emitToUser(String(event.createdBy), "events:refresh", {
          reason: "guest_add_denied",
          eventId: event._id.toString(),
        });
        socketService.emitToUser(String(request.requestedBy), "events:refresh", {
          reason: "guest_add_denied",
          eventId: event._id.toString(),
        });
      }

      return res.status(200).json({
        success: true,
        guestAddRequests: (event as any).guestAddRequests,
      });
    } catch (error) {
      console.error("Error denying guest-add request:", error);
      return res.status(500).json({ message: "Error denying guest-add request" });
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
      if (
        isUnlimitedSpots(event.totalSpots) ||
        event.rosterSpotsFilled < event.totalSpots
      ) {
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

      await demoteSingletonSeries(recurrenceGroupId);
      socketService.emitToAll("events:refresh", {
        reason: "series-deleted",
        recurrenceGroupId,
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
    const groupId = event.recurrenceGroupId
      ? String(event.recurrenceGroupId)
      : null;
    await Event.findByIdAndDelete(eventId);
    if (groupId) {
      await demoteSingletonSeries(groupId);
    }
    socketService.emitToAll("events:refresh", {
      reason: "deleted",
      eventId,
      recurrenceGroupId: groupId || undefined,
    });
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
      const id = String(userId);
      clearUserRemovedFromEvent(event, id);
      if (!event.invitedUsers.includes(id)) {
        event.invitedUsers.push(id);
        newInvites.push(id);
      }
    });

    expandCapacityForPendingInvites(event);
    await event.save();

    if (newInvites.length > 0) {
      socketService.emitToEvent(event._id.toString(), "event:updated", {
        event,
      });
      socketService.emitToAll("events:refresh", {
        reason: "invite",
        eventId: event._id.toString(),
      });
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
      removedUserIds: event.removedUserIds || [],
      newlyInvited: newInvites.length,
      totalSpots: event.totalSpots,
    });
  } catch (error) {
    console.error("Error inviting users to event:", error);
    res.status(500).json({ message: "Failed to invite users" });
  }
});

// Creator nudges invitees who haven't RSVP'd yet. Optional `userIds` limits
// the ping to a subset; omit it to remind everyone still pending.
router.post("/:eventId/ping-rsvp", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    if (!currentUser?.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const event = await Event.findById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    if (String(event.createdBy) !== String(currentUser.id)) {
      return res
        .status(403)
        .json({ message: "Only the event creator can send RSVP reminders" });
    }

    const invited = (event.invitedUsers || []).map(String);
    const onRoster = new Set(
      (event.roster || [])
        .map((p: any) => (p.userId ? String(p.userId) : ""))
        .filter(Boolean),
    );
    const responded = new Set(
      (event.rsvps || []).map((r: any) => String(r.userId)),
    );
    const pending = invited.filter(
      (id) =>
        id !== String(currentUser.id) &&
        !onRoster.has(id) &&
        !responded.has(id),
    );

    const requested: string[] | null = Array.isArray(req.body?.userIds)
      ? req.body.userIds.map(String).filter(Boolean)
      : null;

    const candidates = requested
      ? pending.filter((id) => requested.includes(id))
      : pending;

    const skipped: Array<{ userId: string; reason: string }> = [];
    if (requested) {
      for (const id of requested) {
        if (!invited.includes(id)) {
          skipped.push({ userId: id, reason: "not_invited" });
        } else if (onRoster.has(id) || responded.has(id)) {
          skipped.push({ userId: id, reason: "already_responded" });
        }
      }
    }

    if (candidates.length === 0) {
      return res.status(400).json({
        message: "No pending invitees to remind",
        pinged: [],
        skipped,
        rateLimited: [],
      });
    }

    const since = new Date(Date.now() - RSVP_PING_COOLDOWN_MS);
    const recent = await Notification.find({
      userId: { $in: candidates },
      type: "event_rsvp_reminder",
      "data.eventId": event._id.toString(),
      createdAt: { $gte: since },
    })
      .select("userId")
      .lean();
    const coolingDown = new Set(recent.map((n: any) => String(n.userId)));
    const rateLimited = candidates.filter((id) => coolingDown.has(id));
    const pinged = candidates.filter((id) => !coolingDown.has(id));

    if (pinged.length === 0) {
      return res.status(429).json({
        message: "RSVP reminders were already sent recently. Try again later.",
        pinged: [],
        skipped,
        rateLimited,
      });
    }

    const creator = await User.findById(currentUser.id)
      .select("username name")
      .lean();
    const creatorName =
      (creator as any)?.name || (creator as any)?.username || "The host";

    notificationService.sendPushNotificationToMany(
      pinged,
      "RSVP reminder",
      `${creatorName} is waiting for your RSVP to "${event.name}"`,
      "event_rsvp_reminder",
      {
        eventId: event._id.toString(),
        eventName: event.name,
        remindedBy: String(currentUser.id),
      },
    );

    return res.status(200).json({
      success: true,
      pinged,
      skipped,
      rateLimited,
    });
  } catch (error) {
    console.error("Error sending RSVP reminders:", error);
    return res.status(500).json({ message: "Failed to send RSVP reminders" });
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
        (id) => String(id) !== String(userId),
      );

      await event.save();

      socketService.emitToEvent(eventId, "roster:updated", {
        eventId,
        roster: event.roster,
        rosterSpotsFilled: event.rosterSpotsFilled,
        waitlist: event.waitlist,
        invitedUsers: event.invitedUsers,
        rsvps: event.rsvps,
      });

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

// Ceilings borrowed from Discord's own limits, to stop a single event
// accumulating an unbounded reaction row.
const MAX_DISTINCT_REACTIONS_PER_EVENT = 20;
const MAX_REACTIONS_PER_USER_PER_EVENT = 20;

// Add or remove one (user, emoji) pair. Unlike a single-choice reaction, a
// user may hold several different emoji at once — only the exact pair toggles.
// Returns true when the reaction was added. `likes` is rewritten from the "❤️"
// reactions each time so it stays a faithful mirror for clients released
// before reactions existed.
const toggleUserReaction = (
  event: any,
  userId: string,
  emoji: string,
): boolean => {
  const reactions = [...(event.reactions || [])];
  const index = reactions.findIndex(
    (r: any) => String(r.userId) === String(userId) && r.emoji === emoji,
  );

  let added: boolean;
  if (index >= 0) {
    reactions.splice(index, 1);
    added = false;
  } else {
    reactions.push({ userId: String(userId), emoji, reactedAt: new Date() });
    added = true;
  }

  event.reactions = reactions;
  event.likes = reactions
    .filter((r: any) => r.emoji === LIKE_EMOJI)
    .map((r: any) => String(r.userId));
  return added;
};

// Shared handler behind both POST /:eventId/react and the legacy
// POST /:eventId/like. Tapping an emoji you've already used removes just that
// one; any other emoji is added alongside what you already have.
const handleReactionToggle = async (
  req: Request,
  res: Response,
  requestedEmoji: unknown,
) => {
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

  if (!isValidEmoji(requestedEmoji)) {
    return res.status(400).json({ message: "Invalid reaction." });
  }
  const emoji = requestedEmoji.trim();

  const event = await Event.findById(req.params.eventId);
  if (!event) {
    return res.status(404).json({ message: "Event not found." });
  }

  const existing = (event as any).reactions || [];
  const alreadyReacted = existing.some(
    (r: any) => String(r.userId) === String(userId) && r.emoji === emoji,
  );

  // Only guard the growth direction — removing is always allowed, so a user
  // can always undo their way back under a limit.
  if (!alreadyReacted) {
    const distinct = new Set(existing.map((r: any) => r.emoji));
    if (!distinct.has(emoji) && distinct.size >= MAX_DISTINCT_REACTIONS_PER_EVENT) {
      return res
        .status(400)
        .json({ message: "This event has too many different reactions." });
    }
    const mine = existing.filter(
      (r: any) => String(r.userId) === String(userId),
    );
    if (mine.length >= MAX_REACTIONS_PER_USER_PER_EVENT) {
      return res
        .status(400)
        .json({ message: "You've added too many reactions to this event." });
    }
  }

  const added = toggleUserReaction(event, userId, emoji);
  await event.save();

  if (added && event.createdBy && String(event.createdBy) !== String(userId)) {
    const reactor = await User.findById(userId).select("username");
    if (reactor) {
      notificationService.sendPushNotification({
        userId: String(event.createdBy),
        title: "Someone reacted to your event!",
        body: `${reactor.username} reacted ${emoji} to "${event.name}"`,
        type: "event_like",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
    }
  }

  const reactions = (event.reactions || []).map((r: any) => ({
    userId: String(r.userId),
    emoji: r.emoji,
  }));

  const likerIds = (event.likes || []).map((id: string) => {
    try {
      return new mongoose.Types.ObjectId(id);
    } catch {
      return id;
    }
  });
  const likers = await User.find({ _id: { $in: likerIds } })
    .select("username")
    .lean();
  const likedByUsernames = (event.likes || [])
    .map((id: string) => {
      const user = likers.find((u: any) => u._id.toString() === String(id));
      return user?.username;
    })
    .filter((name: string | undefined): name is string => !!name);

  const payload = { reactions, likes: event.likes || [], likedByUsernames };
  socketService.emitToAll("event:reacted", {
    eventId: req.params.eventId,
    ...payload,
  });
  // Clients older than the reactions release only listen for event:liked, so
  // keep emitting it or their hearts would go stale until a refetch.
  socketService.emitToAll("event:liked", {
    eventId: req.params.eventId,
    likes: event.likes || [],
    likedByUsernames,
  });

  return res.status(200).json(payload);
};

router.post("/:eventId/react", async (req: Request, res: Response) => {
  try {
    return await handleReactionToggle(req, res, req.body.emoji);
  } catch (error) {
    console.error("Error toggling event reaction:", error);
    return res
      .status(500)
      .json({ message: "Failed to toggle reaction on event." });
  }
});

// Legacy endpoint: a like is a "❤️" reaction.
router.post("/:eventId/like", async (req: Request, res: Response) => {
  try {
    return await handleReactionToggle(req, res, LIKE_EMOJI);
  } catch (error) {
    console.error("Error toggling event like:", error);
    return res.status(500).json({ message: "Failed to toggle like on event." });
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

    if (event.roster.some((p: any) => String(p.userId) === String(currentUser.id))) {
      return res.status(400).json({ message: "Already on the roster" });
    }

    if (event.waitlist.some((w: any) => String(w.userId) === String(currentUser.id))) {
      return res.status(409).json({ message: "Already on the waitlist" });
    }

    if (isRemovedFromEvent(event, String(currentUser.id))) {
      return res.status(403).json({
        message:
          "You've been removed from this event. Ask the host to invite you again.",
        removed: true,
      });
    }

    // Host invitees should take a roster seat, not the waitlist — even if the
    // client still thinks the event is full from a stale card.
    expandCapacityForInvitedJoiner(event, String(currentUser.id));
    if (!isRosterFull(event) && isInvitedToEvent(event, String(currentUser.id))) {
      event.roster.push({
        username: user.username,
        paidStatus: "Unpaid",
        userId: currentUser.id,
        profilePicUrl: (user as any).profilePicUrl || undefined,
      } as any);
      event.rosterSpotsFilled = event.roster.length;
      event.waitlist = event.waitlist.filter(
        (w: any) => String(w.userId) !== String(currentUser.id),
      );
      event.rsvps = event.rsvps.filter(
        (r: any) => String(r.userId) !== String(currentUser.id),
      );
      await event.save();
      socketService.emitToEvent(req.params.id, "roster:updated", {
        eventId: req.params.id,
        roster: event.roster,
        rosterSpotsFilled: event.rosterSpotsFilled,
        spotReservation: event.spotReservation,
        totalSpots: event.totalSpots,
      });
      broadcastRosterChanged(event);
      socketService.emitToAll("events:refresh", {
        reason: "invitee_join",
        eventId: req.params.id,
      });
      return res.status(200).json({
        success: true,
        joinedRoster: true,
        roster: event.roster,
        totalSpots: event.totalSpots,
      });
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
