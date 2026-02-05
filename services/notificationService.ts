import admin from "firebase-admin";
import DeviceToken from "../models/deviceToken";
import NotificationPreferences from "../models/notificationPreferences";
import Notification from "../models/notification";

// Initialize Firebase Admin SDK
// Credentials should be set via environment variables:
// FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL
const initializeFirebase = () => {
  if (admin.apps.length === 0) {
    // Handle both escaped newlines (\\n) and already-parsed newlines
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey) {
      // Replace literal \n with actual newlines (handles Heroku env var escaping)
      privateKey = privateKey.replace(/\\n/g, "\n");
      // Also handle double-escaped newlines (\\\\n)
      privateKey = privateKey.replace(/\\\\n/g, "\n");
    }

    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !privateKey ||
      !process.env.FIREBASE_CLIENT_EMAIL
    ) {
      console.warn(
        "Firebase credentials not configured. Push notifications will be disabled.",
      );
      console.warn("Missing:", {
        hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
        hasPrivateKey: !!privateKey,
        hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
      });
      return false;
    }

    // Validate private key format
    if (
      !privateKey.includes("-----BEGIN") ||
      !privateKey.includes("PRIVATE KEY-----")
    ) {
      console.error(
        "FIREBASE_PRIVATE_KEY appears to be malformed. Expected PEM format.",
      );
      console.error("Key starts with:", privateKey.substring(0, 50));
      return false;
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: privateKey,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
      console.log("Firebase Admin SDK initialized successfully");
      console.log("Project ID:", process.env.FIREBASE_PROJECT_ID);
      console.log("Client Email:", process.env.FIREBASE_CLIENT_EMAIL);
      return true;
    } catch (error) {
      console.error("Failed to initialize Firebase Admin SDK:", error);
      return false;
    }
  }
  return true;
};

// Initialize Firebase on module load
const firebaseInitialized = initializeFirebase();

export type NotificationType =
  | "friend_request"
  | "friend_accepted"
  | "event_roster"
  | "event_update"
  | "event_reminder"
  | "community_note"
  | "general";

interface SendNotificationOptions {
  userId: string;
  title: string;
  body: string;
  type: NotificationType;
  data?: Record<string, string>;
  saveToHistory?: boolean;
}

/**
 * Send a push notification to a user
 */
export const sendPushNotification = async (
  options: SendNotificationOptions,
): Promise<boolean> => {
  const {
    userId,
    title,
    body,
    type,
    data = {},
    saveToHistory = true,
  } = options;

  try {
    // Check if user has notifications enabled for this type
    const preferences = await NotificationPreferences.findOne({ userId });

    // If no preferences exist, use defaults (all enabled)
    if (preferences) {
      if (!preferences.pushEnabled) {
        console.log(`Push notifications disabled for user ${userId}`);
        return false;
      }

      // Check specific notification type preferences
      switch (type) {
        case "friend_request":
          if (!preferences.friendRequests) return false;
          break;
        case "friend_accepted":
          if (!preferences.friendRequestAccepted) return false;
          break;
        case "event_roster":
          if (!preferences.eventRoster) return false;
          break;
        case "event_update":
          if (!preferences.eventUpdates) return false;
          break;
        case "event_reminder":
          if (!preferences.eventReminders) return false;
          break;
        case "community_note":
          if (!preferences.communityNotes) return false;
          break;
      }
    }

    // Save notification to history if requested
    if (saveToHistory) {
      await Notification.create({
        userId,
        title,
        body,
        type,
        data,
        read: false,
      });
    }

    // If Firebase is not initialized, just save to history
    if (!firebaseInitialized) {
      console.log(
        `Firebase not initialized. Notification saved to history only.`,
      );
      return true;
    }

    // Get user's device tokens
    const deviceTokens = await DeviceToken.find({ userId });

    if (deviceTokens.length === 0) {
      console.log(`No device tokens found for user ${userId}`);
      return true; // Still consider success if saved to history
    }

    // Prepare messages for all devices
    const messages: admin.messaging.Message[] = deviceTokens.map((dt) => ({
      token: dt.deviceToken,
      notification: {
        title,
        body,
      },
      data: {
        ...data,
        type,
        click_action: "FLUTTER_NOTIFICATION_CLICK",
      },
      apns: {
        payload: {
          aps: {
            badge: 1,
            sound: "default",
          },
        },
      },
      android: {
        priority: "high" as const,
        notification: {
          sound: "default",
          channelId: "default",
        },
      },
    }));

    // Send notifications
    const response = await admin.messaging().sendEach(messages);

    // Handle failed tokens (remove invalid ones)
    const failedTokens: string[] = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const error = resp.error;
        if (
          error?.code === "messaging/invalid-registration-token" ||
          error?.code === "messaging/registration-token-not-registered"
        ) {
          failedTokens.push(deviceTokens[idx].deviceToken);
        }
        console.error(
          `Failed to send to token ${deviceTokens[idx].deviceToken}:`,
          error?.message,
        );
      }
    });

    // Remove invalid tokens
    if (failedTokens.length > 0) {
      await DeviceToken.deleteMany({ deviceToken: { $in: failedTokens } });
      console.log(`Removed ${failedTokens.length} invalid device tokens`);
    }

    console.log(
      `Sent ${response.successCount}/${messages.length} notifications to user ${userId}`,
    );
    return response.successCount > 0;
  } catch (error) {
    console.error("Error sending push notification:", error);
    return false;
  }
};

/**
 * Send notification to multiple users
 */
export const sendPushNotificationToMany = async (
  userIds: string[],
  title: string,
  body: string,
  type: NotificationType,
  data?: Record<string, string>,
): Promise<void> => {
  const promises = userIds.map((userId) =>
    sendPushNotification({
      userId,
      title,
      body,
      type,
      data,
    }),
  );

  await Promise.allSettled(promises);
};

/**
 * Register a device token for a user
 */
export const registerDeviceToken = async (
  userId: string,
  deviceToken: string,
  platform: "ios" | "android" | "web",
): Promise<boolean> => {
  try {
    // Remove this token from any other user (in case of device transfer)
    await DeviceToken.deleteMany({ deviceToken, userId: { $ne: userId } });

    // Upsert the device token for this user
    await DeviceToken.findOneAndUpdate(
      { userId, deviceToken },
      { userId, deviceToken, platform },
      { upsert: true, new: true },
    );

    // Create default notification preferences if they don't exist
    await NotificationPreferences.findOneAndUpdate(
      { userId },
      { userId },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return true;
  } catch (error) {
    console.error("Error registering device token:", error);
    return false;
  }
};

/**
 * Unregister a device token
 */
export const unregisterDeviceToken = async (
  deviceToken: string,
): Promise<boolean> => {
  try {
    await DeviceToken.deleteOne({ deviceToken });
    return true;
  } catch (error) {
    console.error("Error unregistering device token:", error);
    return false;
  }
};

/**
 * Get notification preferences for a user
 */
export const getNotificationPreferences = async (userId: string) => {
  try {
    let preferences = await NotificationPreferences.findOne({ userId });

    // Create default preferences if they don't exist
    if (!preferences) {
      preferences = await NotificationPreferences.create({ userId });
    }

    return preferences;
  } catch (error) {
    console.error("Error getting notification preferences:", error);
    return null;
  }
};

/**
 * Update notification preferences for a user
 */
export const updateNotificationPreferences = async (
  userId: string,
  updates: Partial<{
    friendRequests: boolean;
    friendRequestAccepted: boolean;
    eventUpdates: boolean;
    eventRoster: boolean;
    eventReminders: boolean;
    communityNotes: boolean;
    pushEnabled: boolean;
  }>,
) => {
  try {
    const preferences = await NotificationPreferences.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return preferences;
  } catch (error) {
    console.error("Error updating notification preferences:", error);
    return null;
  }
};

/**
 * Get notification history for a user
 */
export const getNotificationHistory = async (
  userId: string,
  limit: number = 50,
  skip: number = 0,
) => {
  try {
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    return notifications;
  } catch (error) {
    console.error("Error getting notification history:", error);
    return [];
  }
};

/**
 * Mark notifications as read
 */
export const markNotificationsAsRead = async (
  userId: string,
  notificationIds?: string[],
) => {
  try {
    const query: any = { userId };
    if (notificationIds && notificationIds.length > 0) {
      query._id = { $in: notificationIds };
    }

    await Notification.updateMany(query, { $set: { read: true } });
    return true;
  } catch (error) {
    console.error("Error marking notifications as read:", error);
    return false;
  }
};

export default {
  sendPushNotification,
  sendPushNotificationToMany,
  registerDeviceToken,
  unregisterDeviceToken,
  getNotificationPreferences,
  updateNotificationPreferences,
  getNotificationHistory,
  markNotificationsAsRead,
};
