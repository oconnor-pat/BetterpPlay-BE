import { Router, Request, Response } from "express";
import Notification from "../models/notification";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";

const router = Router();

router.post(
  "/register-device",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { deviceToken, platform } = req.body;

      if (!deviceToken || !platform) {
        return res
          .status(400)
          .json({ message: "Device token and platform are required" });
      }

      if (!["ios", "android", "web"].includes(platform)) {
        return res
          .status(400)
          .json({ message: "Platform must be ios, android, or web" });
      }

      const success = await notificationService.registerDeviceToken(
        user.id,
        deviceToken,
        platform,
      );

      if (success) {
        return res
          .status(200)
          .json({ success: true, message: "Device registered successfully" });
      } else {
        return res.status(500).json({ message: "Failed to register device" });
      }
    } catch (error) {
      console.error("Error registering device:", error);
      return res.status(500).json({ message: "Failed to register device" });
    }
  },
);

router.post(
  "/unregister-device",
  async (req: Request, res: Response) => {
    try {
      const { deviceToken } = req.body;

      if (!deviceToken) {
        return res.status(400).json({ message: "Device token is required" });
      }

      const success =
        await notificationService.unregisterDeviceToken(deviceToken);

      if (success) {
        return res
          .status(200)
          .json({ success: true, message: "Device unregistered successfully" });
      } else {
        return res.status(500).json({ message: "Failed to unregister device" });
      }
    } catch (error) {
      console.error("Error unregistering device:", error);
      return res.status(500).json({ message: "Failed to unregister device" });
    }
  },
);

router.get(
  "/preferences",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const preferences = await notificationService.getNotificationPreferences(
        user.id,
      );

      if (preferences) {
        return res.status(200).json({
          success: true,
          preferences: {
            friendRequests: preferences.friendRequests,
            friendRequestAccepted: preferences.friendRequestAccepted,
            eventUpdates: preferences.eventUpdates,
            eventRoster: preferences.eventRoster,
            eventReminders: preferences.eventReminders,
            communityNotes: preferences.communityNotes,
            pushEnabled: preferences.pushEnabled,
          },
        });
      } else {
        return res
          .status(500)
          .json({ message: "Failed to get notification preferences" });
      }
    } catch (error) {
      console.error("Error getting notification preferences:", error);
      return res
        .status(500)
        .json({ message: "Failed to get notification preferences" });
    }
  },
);

router.put(
  "/preferences",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const {
        friendRequests,
        friendRequestAccepted,
        eventUpdates,
        eventRoster,
        eventReminders,
        communityNotes,
        pushEnabled,
      } = req.body;

      const updates: any = {};
      if (typeof friendRequests === "boolean")
        updates.friendRequests = friendRequests;
      if (typeof friendRequestAccepted === "boolean")
        updates.friendRequestAccepted = friendRequestAccepted;
      if (typeof eventUpdates === "boolean")
        updates.eventUpdates = eventUpdates;
      if (typeof eventRoster === "boolean") updates.eventRoster = eventRoster;
      if (typeof eventReminders === "boolean")
        updates.eventReminders = eventReminders;
      if (typeof communityNotes === "boolean")
        updates.communityNotes = communityNotes;
      if (typeof pushEnabled === "boolean") updates.pushEnabled = pushEnabled;

      const preferences =
        await notificationService.updateNotificationPreferences(
          user.id,
          updates,
        );

      if (preferences) {
        return res.status(200).json({
          success: true,
          message: "Preferences updated successfully",
          preferences: {
            friendRequests: preferences.friendRequests,
            friendRequestAccepted: preferences.friendRequestAccepted,
            eventUpdates: preferences.eventUpdates,
            eventRoster: preferences.eventRoster,
            eventReminders: preferences.eventReminders,
            communityNotes: preferences.communityNotes,
            pushEnabled: preferences.pushEnabled,
          },
        });
      } else {
        return res
          .status(500)
          .json({ message: "Failed to update notification preferences" });
      }
    } catch (error) {
      console.error("Error updating notification preferences:", error);
      return res
        .status(500)
        .json({ message: "Failed to update notification preferences" });
    }
  },
);

router.get("/history", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const skip = parseInt(req.query.skip as string) || 0;

    const notifications = await notificationService.getNotificationHistory(
      user.id,
      limit,
      skip,
    );

    return res.status(200).json({
      success: true,
      notifications,
    });
  } catch (error) {
    console.error("Error getting notification history:", error);
    return res
      .status(500)
      .json({ message: "Failed to get notification history" });
  }
});

router.post(
  "/mark-read",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { notificationIds } = req.body;

      const success = await notificationService.markNotificationsAsRead(
        user.id,
        notificationIds,
      );

      if (success) {
        return res
          .status(200)
          .json({ success: true, message: "Notifications marked as read" });
      } else {
        return res
          .status(500)
          .json({ message: "Failed to mark notifications as read" });
      }
    } catch (error) {
      console.error("Error marking notifications as read:", error);
      return res
        .status(500)
        .json({ message: "Failed to mark notifications as read" });
    }
  },
);

router.get(
  "/unread-count",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const count = await Notification.countDocuments({
        userId: user.id,
        read: false,
      });

      return res.status(200).json({ count });
    } catch (error) {
      console.error("Error getting unread count:", error);
      return res.status(500).json({ message: "Failed to get unread count" });
    }
  },
);

router.get("/", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const skip = parseInt(req.query.skip as string) || 0;

    const notifications = await notificationService.getNotificationHistory(
      user.id,
      limit,
      skip,
    );

    const unreadCount = await Notification.countDocuments({
      userId: user.id,
      read: false,
    });

    return res.status(200).json({
      success: true,
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Error getting notifications:", error);
    return res.status(500).json({ message: "Failed to get notifications" });
  }
});

router.put("/:id/read", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: user.id },
      { read: true },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const unreadCount = await Notification.countDocuments({ userId: user.id, read: false });
    socketService.emitToUser(user.id, "notification:badge", { count: unreadCount });

    return res.status(200).json({
      success: true,
      notification,
    });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return res
      .status(500)
      .json({ message: "Failed to mark notification as read" });
  }
});

router.put(
  "/mark-all-read",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      await Notification.updateMany(
        { userId: user.id, read: false },
        { read: true },
      );

      socketService.emitToUser(user.id, "notification:badge", { count: 0 });

      return res.status(200).json({
        success: true,
        message: "All notifications marked as read",
      });
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      return res
        .status(500)
        .json({ message: "Failed to mark all notifications as read" });
    }
  },
);

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: user.id,
    });

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Notification deleted",
    });
  } catch (error) {
    console.error("Error deleting notification:", error);
    return res.status(500).json({ message: "Failed to delete notification" });
  }
});

export default router;
