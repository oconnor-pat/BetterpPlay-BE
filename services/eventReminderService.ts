import Event from "../models/event";
import EventRating from "../models/eventRating";
import notificationService from "./notificationService";
import {
  resolveEventEndsAt,
  resolveEventStartsAt,
} from "../utils/eventDateTime";

// Track which events we've already sent reminders for (in-memory for this
// process). Keys are `${eventId}-${kind}` so a dyno restart can double-send
// once — acceptable vs. missing reminders.
const sentReminders = new Set<string>();

const getEventStart = (event: any): Date | null => {
  if (event.startsAt) {
    const direct = new Date(event.startsAt);
    if (!isNaN(direct.getTime())) {
      return direct;
    }
  }
  return resolveEventStartsAt({
    date: event.date,
    time: event.time,
    timezoneOffsetMinutes: event.timezoneOffsetMinutes,
  });
};

const collectRecipientIds = (event: any): string[] => {
  const ids = new Set<string>();
  if (event.createdBy) {
    ids.add(String(event.createdBy));
  }
  for (const p of event.roster || []) {
    if (p?.userId) {
      ids.add(String(p.userId));
    }
  }
  for (const invited of event.invitedUsers || []) {
    if (invited) {
      ids.add(String(invited));
    }
  }
  return Array.from(ids);
};

/**
 * Check for upcoming events and send reminders.
 *
 * Windows (polled every ~15 minutes):
 *  - "1hr": event starts in 50–75 minutes
 *  - "start": event started in the last 10 minutes (or is within 5 min)
 *
 * Uses absolute `startsAt` (or a timezone-aware reconstruction) so Heroku's
 * UTC clock doesn't treat wall-clock times as UTC.
 */
export const checkAndSendEventReminders = async (): Promise<void> => {
  try {
    const now = Date.now();
    const windowStart = new Date(now - 15 * 60 * 1000);
    const windowEnd = new Date(now + 80 * 60 * 1000);

    // Prefer indexed startsAt lookups; also scan legacy rows that predate the
    // field so existing events still get reminders after deploy.
    const events = await Event.find({
      $or: [
        { startsAt: { $gte: windowStart, $lte: windowEnd } },
        { startsAt: { $exists: false } },
        { startsAt: null },
      ],
    }).limit(1000);

    for (const event of events) {
      const eventDateTime = getEventStart(event);
      if (!eventDateTime) {
        continue;
      }

      const startMs = eventDateTime.getTime();
      const msUntilStart = startMs - now;
      const recipients = collectRecipientIds(event);
      if (recipients.length === 0) {
        continue;
      }

      // ~1 hour before (50–75 min window catches a 15-min poll cadence)
      const oneHourKey = `${event._id}-1hr`;
      if (
        !sentReminders.has(oneHourKey) &&
        msUntilStart > 50 * 60 * 1000 &&
        msUntilStart <= 75 * 60 * 1000
      ) {
        console.log(
          `Sending 1h reminder for "${event.name}" to ${recipients.length} users (starts ${eventDateTime.toISOString()})`,
        );
        await notificationService.sendPushNotificationToMany(
          recipients,
          "Event Reminder ⏰",
          `"${event.name}" starts in about 1 hour (${event.time})`,
          "event_reminder",
          {
            eventId: event._id.toString(),
            eventName: event.name,
            eventTime: event.time,
            eventLocation: event.location,
          },
        );
        sentReminders.add(oneHourKey);
      }

      // Starting now / just started
      const startKey = `${event._id}-start`;
      if (
        !sentReminders.has(startKey) &&
        msUntilStart <= 5 * 60 * 1000 &&
        msUntilStart > -10 * 60 * 1000
      ) {
        console.log(
          `Sending start reminder for "${event.name}" to ${recipients.length} users`,
        );
        await notificationService.sendPushNotificationToMany(
          recipients,
          "Event Starting 🎯",
          `"${event.name}" is starting now`,
          "event_reminder",
          {
            eventId: event._id.toString(),
            eventName: event.name,
            eventTime: event.time,
            eventLocation: event.location,
          },
        );
        sentReminders.add(startKey);
      }
    }
  } catch (error) {
    console.error("Error checking for event reminders:", error);
  }
};

/**
 * After an event ends, nudge roster attendees (not the host) to rate it.
 * Window: ended in the last ~90 minutes (covers the 15-min poll).
 */
export const checkAndSendRatingPrompts = async (): Promise<void> => {
  try {
    const now = Date.now();
    // Events that started up to ~27h ago could still be ending now
    // (24h max duration + 3h assumed + poll slack).
    const lookback = new Date(now - 27 * 60 * 60 * 1000);

    const events = await Event.find({
      $or: [
        { startsAt: { $gte: lookback, $lte: new Date(now) } },
        { startsAt: { $exists: false } },
        { startsAt: null },
      ],
      "roster.0": { $exists: true },
    }).limit(500);

    for (const event of events) {
      const ratingKey = `${event._id}-rating`;
      if (sentReminders.has(ratingKey)) {
        continue;
      }

      const endsAt = resolveEventEndsAt({
        startsAt: event.startsAt,
        date: event.date,
        time: event.time,
        timezoneOffsetMinutes: event.timezoneOffsetMinutes,
        durationMinutes: event.durationMinutes,
      });
      if (!endsAt) {
        continue;
      }

      const msSinceEnd = now - endsAt.getTime();
      // Prompt shortly after the event ends (0–90 min).
      if (msSinceEnd < 0 || msSinceEnd > 90 * 60 * 1000) {
        continue;
      }

      const hostId = String(event.createdBy || "");
      const rosterIds = Array.from(
        new Set(
          (event.roster || [])
            .map((p: any) => (p?.userId ? String(p.userId) : ""))
            .filter((id: string) => id && id !== hostId),
        ),
      );
      if (rosterIds.length === 0) {
        continue;
      }

      const alreadyRated = await EventRating.find({
        eventId: event._id,
        raterId: { $in: rosterIds },
      })
        .select("raterId")
        .lean();
      const ratedSet = new Set(alreadyRated.map((r) => String(r.raterId)));
      const recipients = rosterIds.filter((id) => !ratedSet.has(id));
      if (recipients.length === 0) {
        sentReminders.add(ratingKey);
        continue;
      }

      console.log(
        `Sending rating prompt for "${event.name}" to ${recipients.length} users`,
      );
      await notificationService.sendPushNotificationToMany(
        recipients,
        "How was it?",
        `Rate "${event.name}" and the host — it only takes a second.`,
        "event_rating_prompt",
        {
          eventId: event._id.toString(),
          eventName: event.name,
          openRating: "true",
        },
      );
      sentReminders.add(ratingKey);
    }
  } catch (error) {
    console.error("Error checking for rating prompts:", error);
  }
};

/**
 * Start the event reminder scheduler.
 * Runs every 15 minutes to check for upcoming events + post-event ratings.
 */
export const startEventReminderScheduler = (): NodeJS.Timeout => {
  console.log("🔔 Event reminder scheduler started");

  const tick = () => {
    checkAndSendEventReminders();
    checkAndSendRatingPrompts();
  };

  tick();

  const intervalId = setInterval(tick, 15 * 60 * 1000);

  return intervalId;
};

export const cleanupOldReminders = (): void => {
  if (sentReminders.size > 1000) {
    sentReminders.clear();
    console.log("Cleared event reminder cache");
  }
};

export default {
  checkAndSendEventReminders,
  checkAndSendRatingPrompts,
  startEventReminderScheduler,
  cleanupOldReminders,
};
