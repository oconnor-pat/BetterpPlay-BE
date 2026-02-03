import Event from "../models/event";
import notificationService from "./notificationService";

// Track which events we've already sent reminders for (in-memory for this session)
const sentReminders = new Set<string>();

/**
 * Parse event date and time into a Date object
 * Assumes date format: "MM/DD/YYYY" or "YYYY-MM-DD" and time format: "HH:MM AM/PM" or "HH:MM"
 */
const parseEventDateTime = (dateStr: string, timeStr: string): Date | null => {
  try {
    // Try to parse the date
    let dateParts: number[];

    if (dateStr.includes("/")) {
      // MM/DD/YYYY format
      const parts = dateStr.split("/");
      if (parts.length === 3) {
        dateParts = [
          parseInt(parts[2]), // year
          parseInt(parts[0]) - 1, // month (0-indexed)
          parseInt(parts[1]), // day
        ];
      } else {
        return null;
      }
    } else if (dateStr.includes("-")) {
      // YYYY-MM-DD format
      const parts = dateStr.split("-");
      if (parts.length === 3) {
        dateParts = [
          parseInt(parts[0]), // year
          parseInt(parts[1]) - 1, // month (0-indexed)
          parseInt(parts[2]), // day
        ];
      } else {
        return null;
      }
    } else {
      return null;
    }

    // Parse time
    let hours = 0;
    let minutes = 0;

    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (timeMatch) {
      hours = parseInt(timeMatch[1]);
      minutes = parseInt(timeMatch[2]);
      const period = timeMatch[3]?.toUpperCase();

      if (period === "PM" && hours !== 12) {
        hours += 12;
      } else if (period === "AM" && hours === 12) {
        hours = 0;
      }
    }

    return new Date(dateParts[0], dateParts[1], dateParts[2], hours, minutes);
  } catch (error) {
    console.error("Error parsing event date/time:", error);
    return null;
  }
};

/**
 * Check for upcoming events and send reminders
 * Sends reminders for events happening in the next hour
 */
export const checkAndSendEventReminders = async (): Promise<void> => {
  try {
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    // Get all events
    const events = await Event.find();

    for (const event of events) {
      // Skip if we already sent a reminder for this event
      const reminderKey = `${event._id}-1hr`;
      if (sentReminders.has(reminderKey)) {
        continue;
      }

      const eventDateTime = parseEventDateTime(event.date, event.time);
      if (!eventDateTime) {
        continue;
      }

      // Check if event is within the reminder window (1-2 hours from now)
      // This gives a 1-hour window to catch the event
      if (eventDateTime > oneHourFromNow && eventDateTime <= twoHoursFromNow) {
        // Get all players with userIds
        const playerUserIds = event.roster
          .filter((p) => p.userId)
          .map((p) => p.userId as string);

        if (playerUserIds.length > 0) {
          console.log(
            `Sending reminder for event "${event.name}" to ${playerUserIds.length} players`,
          );

          await notificationService.sendPushNotificationToMany(
            playerUserIds,
            "Event Reminder ⏰",
            `"${event.name}" starts in about 1 hour at ${event.time}`,
            "event_reminder",
            {
              eventId: event._id.toString(),
              eventName: event.name,
              eventTime: event.time,
              eventLocation: event.location,
            },
          );

          // Mark this reminder as sent
          sentReminders.add(reminderKey);
        }
      }
    }
  } catch (error) {
    console.error("Error checking for event reminders:", error);
  }
};

/**
 * Start the event reminder scheduler
 * Runs every 15 minutes to check for upcoming events
 */
export const startEventReminderScheduler = (): NodeJS.Timeout => {
  console.log("🔔 Event reminder scheduler started");

  // Run immediately on start
  checkAndSendEventReminders();

  // Then run every 15 minutes
  const intervalId = setInterval(
    () => {
      checkAndSendEventReminders();
    },
    15 * 60 * 1000,
  ); // 15 minutes

  return intervalId;
};

/**
 * Clean up old reminder keys (call periodically to prevent memory growth)
 */
export const cleanupOldReminders = (): void => {
  // Clear reminders older than 24 hours
  // Since we're using in-memory storage, just clear all if it gets too large
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
