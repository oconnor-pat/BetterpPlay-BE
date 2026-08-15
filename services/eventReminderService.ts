import Event from "../models/event";
import notificationService from "./notificationService";
import { resolveEventStartsAt } from "../utils/eventDateTime";

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
 * Start the event reminder scheduler.
 * Runs every 15 minutes to check for upcoming events.
 */
export const startEventReminderScheduler = (): NodeJS.Timeout => {
  console.log("🔔 Event reminder scheduler started");

  checkAndSendEventReminders();

  const intervalId = setInterval(
    () => {
      checkAndSendEventReminders();
    },
    15 * 60 * 1000,
  );

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
  startEventReminderScheduler,
  cleanupOldReminders,
};
