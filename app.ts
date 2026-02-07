import express, { Application, Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import User, { IUser } from "./models/user";
import Event from "./models/event";
import communityNote from "./models/communityNote";
import Venue from "./models/venue";
import Booking from "./models/booking";
import Inquiry from "./models/inquiry";
import TimeSlot from "./models/timeSlot";
import DeviceToken from "./models/deviceToken";
import NotificationPreferences from "./models/notificationPreferences";
import Notification from "./models/notification";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cors from "cors";
import AWS from "aws-sdk";
import { body, validationResult } from "express-validator";
import nodemailer from "nodemailer";
import notificationService from "./services/notificationService";
import eventReminderService from "./services/eventReminderService";

const app: Application = express();

// Enable CORS for all origins (development)
app.use(cors());

// Configure env
dotenv.config();

// S3 client setup
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Check if JWT_SECRET is set
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set. Check your environment variables.");
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

// Parser
app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  }),
);

// JWT middleware
app.use(async (req: Request, res: Response, next: Function) => {
  if (req.headers.authorization) {
    const token = req.headers.authorization.split(" ")[1];
    try {
      const user = jwt.verify(token, JWT_SECRET);
      (req as any).user = user;
    } catch (error) {
      console.error("Error verifying token:", error);
    }
  }
  next();
});

// Admin middleware - use this to protect admin-only routes
const requireAdmin = async (req: Request, res: Response, next: Function) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const dbUser = await User.findById(user.id);
    if (!dbUser) {
      return res.status(401).json({ message: "User not found" });
    }

    if (!dbUser.isAdmin) {
      return res.status(403).json({ message: "Admin access required" });
    }

    next();
  } catch (error) {
    console.error("Admin auth error:", error);
    return res.status(500).json({ message: "Authentication error" });
  }
};

// Check server availability
app.get("/check", (req: Request, res: Response) => {
  res.sendStatus(200);
});

// Basic welcome route
app.get("/", (req: Request, res: Response) => {
  res.send("Welcome to a better way to play!");
});

// ==================== NOTIFICATION ENDPOINTS ====================

// Register a device token for push notifications
app.post(
  "/api/notifications/register-device",
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

// Unregister a device token (on logout)
app.post(
  "/api/notifications/unregister-device",
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

// Get notification preferences
app.get(
  "/api/notifications/preferences",
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

// Update notification preferences
app.put(
  "/api/notifications/preferences",
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

// Get notification history
app.get("/api/notifications/history", async (req: Request, res: Response) => {
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

// Mark notifications as read
app.post(
  "/api/notifications/mark-read",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { notificationIds } = req.body; // Optional: array of specific notification IDs

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

// ==================== EVENT ENDPOINTS ====================

// Get all events (include roster)
app.get("/events", async (req: Request, res: Response) => {
  try {
    const events = await Event.find().lean();

    // Collect all unique userIds from event likes
    const userIds = new Set<string>();
    events.forEach((event: any) => {
      event.likes?.forEach((id: string) => userIds.add(String(id)));
    });

    // Fetch usernames for all likers
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

    // Add likedByUsernames to each event
    const eventsWithLikedBy = events.map((event: any) => ({
      ...event,
      likedByUsernames: (event.likes || [])
        .map((id: string) => userNameMap.get(String(id)))
        .filter((name: string | undefined): name is string => !!name),
    }));

    res.status(200).json(eventsWithLikedBy);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

// Get a single event (include roster)
app.get("/events/:id", async (req: Request, res: Response) => {
  try {
    const event = await Event.findById(req.params.id).lean();
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // Fetch usernames for likers
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

// Create a new event
app.post("/events", async (req: Request, res: Response) => {
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

    // Optionally, validate that createdBy is a valid user
    const user = await User.findById(createdBy);
    if (!user) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const newEvent = await Event.create({
      name,
      location,
      time,
      date,
      totalSpots,
      eventType,
      createdBy,
      createdByUsername: createdByUsername || user.username,
      rosterSpotsFilled: 0,
      roster: [],
      latitude,
      longitude,
      jerseyColors: jerseyColors || [],
    });

    res.status(201).json(newEvent);
  } catch (error) {
    res.status(500).json({ message: "Failed to create event" });
  }
});

// Update an event (edit)
app.put("/events/:id", async (req: Request, res: Response) => {
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
    } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

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

    await event.save();

    // Send notifications to all players in the roster about the event update
    if (event.roster && event.roster.length > 0) {
      const playerUserIds = event.roster
        .filter((p: any) => p.userId)
        .map((p: any) => p.userId);

      if (playerUserIds.length > 0) {
        notificationService.sendPushNotificationToMany(
          playerUserIds,
          "Event Updated",
          `Event "${event.name}" has been updated`,
          "event_update",
          { eventId: event._id.toString(), eventName: event.name },
        );
      }
    }

    res.status(200).json(event);
  } catch (error) {
    res.status(500).json({ message: "Failed to update event" });
  }
});

// Add a player to the roster (append, not overwrite)
app.post("/events/:id/roster", async (req: Request, res: Response) => {
  const eventId = req.params.id;
  const { player } = req.body; // player: { username, paidStatus, jerseyColor, position }
  if (!player || !player.username) {
    return res.status(400).json({ message: "Missing player data" });
  }
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    // Prevent duplicate usernames (optional)
    if (event.roster.some((p: any) => p.username === player.username)) {
      return res.status(409).json({ message: "Player already in roster" });
    }
    event.roster.push(player);
    event.rosterSpotsFilled = event.roster.length;
    await event.save();

    // Send notification to the player being added to the roster
    if (player.userId) {
      notificationService.sendPushNotification({
        userId: player.userId,
        title: "Added to Event",
        body: `You've been added to "${event.name}"`,
        type: "event_roster",
        data: { eventId: event._id.toString(), eventName: event.name },
      });
    }

    return res.status(200).json({ success: true, roster: event.roster });
  } catch (error) {
    console.error("Error adding player to roster:", error);
    return res.status(500).json({ message: "Error adding player to roster" });
  }
});

// Remove a player from the roster
app.delete(
  "/events/:id/roster/:username",
  async (req: Request, res: Response) => {
    const eventId = req.params.id;
    const username = req.params.username;
    try {
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ message: "Event not found" });
      }
      const initialLength = event.roster.length;
      event.roster = event.roster.filter((p: any) => p.username !== username);
      if (event.roster.length === initialLength) {
        return res.status(404).json({ message: "Player not found in roster" });
      }
      event.rosterSpotsFilled = event.roster.length;
      await event.save();
      return res.status(200).json({ success: true, roster: event.roster });
    } catch (error) {
      console.error("Error removing player from roster:", error);
      return res
        .status(500)
        .json({ message: "Error removing player from roster" });
    }
  },
);

// Update rosterSpotsFilled (join/leave event, legacy)
app.patch("/events/:id/roster", async (req: Request, res: Response) => {
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

// Delete an event
app.delete("/events/:id", async (req: Request, res: Response) => {
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

// Toggle like on an event
app.post("/events/:eventId/like", async (req: Request, res: Response) => {
  try {
    // Support both: userId from body OR from authenticated user (JWT)
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

    // Initialize likes array if it doesn't exist
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

    // Fetch usernames for all users who liked
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

    res.status(200).json({ likes: event.likes, likedByUsernames });
  } catch (error) {
    console.error("Error toggling event like:", error);
    res.status(500).json({ message: "Failed to toggle like on event." });
  }
});

// ==================== END EVENT ENDPOINTS ====================

// ==================== VENUE ENDPOINTS ====================

// Get all venues (with optional filters)
app.get("/api/venues", async (req: Request, res: Response) => {
  try {
    const { type, city, state, isActive } = req.query;

    // Build filter object
    const filter: any = {};

    if (type) filter.type = type;
    if (city) filter["address.city"] = { $regex: city, $options: "i" };
    if (state) filter["address.state"] = state;
    if (isActive !== undefined) filter.isActive = isActive === "true";

    const venues = await Venue.find(filter).sort({ name: 1 });
    res.status(200).json(venues);
  } catch (error) {
    console.error("Error fetching venues:", error);
    res.status(500).json({ message: "Failed to fetch venues" });
  }
});

// Get a single venue by ID
app.get("/api/venues/:id", async (req: Request, res: Response) => {
  try {
    const venue = await Venue.findById(req.params.id);
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }
    res.status(200).json(venue);
  } catch (error) {
    console.error("Error fetching venue:", error);
    res.status(500).json({ message: "Failed to fetch venue" });
  }
});

// Get sub-venues for a specific venue
app.get("/api/venues/:id/subvenues", async (req: Request, res: Response) => {
  try {
    const venue = await Venue.findById(req.params.id);
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }
    res.status(200).json(venue.subVenues);
  } catch (error) {
    console.error("Error fetching sub-venues:", error);
    res.status(500).json({ message: "Failed to fetch sub-venues" });
  }
});

// Check if current user is admin
app.get("/api/user/isAdmin", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(200).json({ isAdmin: false });
    }

    const dbUser = await User.findById(user.id);
    if (!dbUser) {
      return res.status(200).json({ isAdmin: false });
    }

    res.status(200).json({ isAdmin: dbUser.isAdmin || false });
  } catch (error) {
    console.error("Error checking admin status:", error);
    res.status(200).json({ isAdmin: false });
  }
});

// Create a new venue (admin only)
app.post("/api/venues", requireAdmin, async (req: Request, res: Response) => {
  try {
    const {
      name,
      type,
      address,
      coordinates,
      subVenues,
      amenities,
      contactEmail,
      contactPhone,
      website,
      imageUrl,
      operatingHours,
    } = req.body;

    if (!name || !type || !address || !coordinates) {
      return res.status(400).json({
        message: "Missing required fields: name, type, address, coordinates",
      });
    }

    const newVenue = await Venue.create({
      name,
      type,
      address,
      coordinates,
      subVenues: subVenues || [],
      amenities: amenities || [],
      contactEmail,
      contactPhone,
      website,
      imageUrl,
      operatingHours,
      isActive: true,
    });

    res.status(201).json(newVenue);
  } catch (error) {
    console.error("Error creating venue:", error);
    res.status(500).json({ message: "Failed to create venue" });
  }
});

// Update a venue (admin only)
app.put(
  "/api/venues/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const venueId = req.params.id;
      const venue = await Venue.findById(venueId);

      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const updateFields = [
        "name",
        "type",
        "address",
        "coordinates",
        "subVenues",
        "amenities",
        "contactEmail",
        "contactPhone",
        "website",
        "imageUrl",
        "operatingHours",
        "isActive",
      ];

      updateFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          (venue as any)[field] = req.body[field];
        }
      });

      await venue.save();
      res.status(200).json(venue);
    } catch (error) {
      console.error("Error updating venue:", error);
      res.status(500).json({ message: "Failed to update venue" });
    }
  },
);

// Delete a venue (admin only)
app.delete(
  "/api/venues/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const venueId = req.params.id;
      const venue = await Venue.findById(venueId);

      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      await Venue.findByIdAndDelete(venueId);
      res.sendStatus(204);
    } catch (error) {
      console.error("Error deleting venue:", error);
      res.status(500).json({ message: "Failed to delete venue" });
    }
  },
);

// ==================== END VENUE ENDPOINTS ====================

// ==================== BOOKING ENDPOINTS ====================

// Helper function to parse time string (supports both "14:00" and "2:00 PM" formats)
const parseTimeString = (timeStr: string): { hour: number; minute: number } => {
  // Check if it's AM/PM format
  const isPM = timeStr.toLowerCase().includes("pm");
  const isAM = timeStr.toLowerCase().includes("am");

  // Remove AM/PM suffix and trim
  const cleanTime = timeStr.replace(/\s*(am|pm)\s*/gi, "").trim();
  const [hourStr, minStr] = cleanTime.split(":");
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10) || 0;

  // Convert to 24-hour format if AM/PM
  if (isPM && hour !== 12) {
    hour += 12; // 1 PM -> 13, 11 PM -> 23
  } else if (isAM && hour === 12) {
    hour = 0; // 12 AM -> 0
  }

  return { hour, minute };
};

// Helper function to generate time slots for a day (auto-generated from operating hours)
const generateTimeSlots = (
  date: string,
  operatingHours: { open: string; close: string } | null,
  existingBookings: any[],
  customSlots: any[], // Custom slots that override auto-generation
) => {
  if (!operatingHours) {
    return []; // Venue closed on this day
  }

  const slots: any[] = [];

  // Parse opening time - round UP to next hour if minutes > 0
  const openTime = parseTimeString(operatingHours.open);
  const effectiveOpenHour =
    openTime.minute > 0 ? openTime.hour + 1 : openTime.hour;

  // Parse closing time - round DOWN to current hour (can't book partial last hour)
  const closeTime = parseTimeString(operatingHours.close);
  const closeHour = closeTime.hour;

  // Generate hourly slots
  for (let hour = effectiveOpenHour; hour < closeHour; hour++) {
    const startTime = `${hour.toString().padStart(2, "0")}:00`;
    const endTime = `${(hour + 1).toString().padStart(2, "0")}:00`;

    // Skip if there's a custom slot that overlaps this time
    const hasCustomOverlap = customSlots.some((cs) => {
      const csStart =
        parseInt(cs.startTime.split(":")[0]) * 60 +
        parseInt(cs.startTime.split(":")[1]);
      const csEnd =
        parseInt(cs.endTime.split(":")[0]) * 60 +
        parseInt(cs.endTime.split(":")[1]);
      const autoStart = hour * 60;
      const autoEnd = (hour + 1) * 60;
      return cs.date === date && csStart < autoEnd && csEnd > autoStart;
    });

    if (hasCustomOverlap) {
      continue; // Skip auto-generated slot if custom slot exists for this time
    }

    // Find if this slot is booked
    const booking = existingBookings.find(
      (b) =>
        b.date === date &&
        b.startTime === startTime &&
        b.status !== "cancelled",
    );

    slots.push({
      id: `${date}-${startTime}`,
      date,
      startTime,
      endTime,
      available: !booking,
      price: 150, // Default price - can be made dynamic later
      eventName: booking?.eventName || null, // Include event name if booked
      bookedBy: booking?.userId || null, // User ID for ownership comparison
      bookedByUsername: booking?.userName || null, // Username for display
      bookingId: booking?._id?.toString() || null, // Booking ID for cancellation
      isCustom: false,
    });
  }

  return slots;
};

// Get available time slots for a space
app.get(
  "/api/venues/:venueId/spaces/:spaceId/timeslots",
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { date, startDate, endDate } = req.query; // Support single date OR date range

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      // Get dates to generate slots for
      const dates: string[] = [];
      if (startDate && endDate) {
        // Date range query - generate all dates between start and end
        const start = new Date(startDate as string);
        const end = new Date(endDate as string);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          dates.push(d.toISOString().split("T")[0]);
        }
      } else if (date) {
        // Single date query
        dates.push(date as string);
      } else {
        // Default: next 14 days
        for (let i = 0; i < 14; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          dates.push(d.toISOString().split("T")[0]);
        }
      }

      // Get existing bookings for this space
      const existingBookings = await Booking.find({
        venueId,
        spaceId,
        date: { $in: dates },
        status: { $ne: "cancelled" },
      });

      // Get custom time slots created by admins
      const customSlots = await TimeSlot.find({
        venueId,
        spaceId,
        date: { $in: dates },
        isActive: true,
      });

      // Generate time slots for each date
      const allSlots: any[] = [];
      const dayNames = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ];

      for (const dateStr of dates) {
        const dayOfWeek = new Date(dateStr).getDay();
        const dayName = dayNames[
          dayOfWeek
        ] as keyof typeof venue.operatingHours;
        const hours = venue.operatingHours?.[dayName] || null;

        // Get custom slots for this date
        const customSlotsForDate = customSlots.filter(
          (cs) => cs.date === dateStr,
        );

        // Generate auto slots (excluding times covered by custom slots)
        const autoSlots = generateTimeSlots(
          dateStr,
          hours,
          existingBookings,
          customSlotsForDate,
        );
        allSlots.push(...autoSlots);

        // Add custom slots with booking status
        for (const customSlot of customSlotsForDate) {
          const booking = existingBookings.find(
            (b) =>
              b.date === dateStr &&
              b.startTime === customSlot.startTime &&
              b.status !== "cancelled",
          );

          allSlots.push({
            id: customSlot._id.toString(),
            date: customSlot.date,
            startTime: customSlot.startTime,
            endTime: customSlot.endTime,
            available: !booking,
            price: customSlot.price,
            eventName: booking?.eventName || null,
            bookedBy: booking?.userId || null, // User ID for ownership comparison
            bookedByUsername: booking?.userName || null, // Username for display
            bookingId: booking?._id?.toString() || null, // Booking ID for cancellation
            isCustom: true,
          });
        }
      }

      // Sort slots by date and start time
      allSlots.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startTime.localeCompare(b.startTime);
      });

      res.status(200).json({
        venueId,
        spaceId,
        spaceName: space.name,
        slots: allSlots,
      });
    } catch (error) {
      console.error("Error fetching time slots:", error);
      res.status(500).json({ message: "Failed to fetch time slots" });
    }
  },
);

// ==================== ADMIN SLOT MANAGEMENT ====================

// Helper function to check for overlapping slots
const checkSlotOverlap = async (
  venueId: string,
  spaceId: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeSlotId?: string,
): Promise<boolean> => {
  const startMinutes =
    parseInt(startTime.split(":")[0]) * 60 + parseInt(startTime.split(":")[1]);
  const endMinutes =
    parseInt(endTime.split(":")[0]) * 60 + parseInt(endTime.split(":")[1]);

  const existingSlots = await TimeSlot.find({
    venueId,
    spaceId,
    date,
    isActive: true,
    ...(excludeSlotId ? { _id: { $ne: excludeSlotId } } : {}),
  });

  for (const slot of existingSlots) {
    const slotStart =
      parseInt(slot.startTime.split(":")[0]) * 60 +
      parseInt(slot.startTime.split(":")[1]);
    const slotEnd =
      parseInt(slot.endTime.split(":")[0]) * 60 +
      parseInt(slot.endTime.split(":")[1]);

    // Check for overlap
    if (startMinutes < slotEnd && endMinutes > slotStart) {
      return true; // Overlap found
    }
  }

  return false; // No overlap
};

// Create a new custom time slot (Admin only)
app.post(
  "/api/venues/:venueId/spaces/:spaceId/slots",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { date, startTime, endTime, price } = req.body;
      const user = (req as any).user;

      // Validate required fields
      if (!date || !startTime || !endTime) {
        return res.status(400).json({
          message: "Missing required fields: date, startTime, endTime",
        });
      }

      // Validate time format (HH:MM)
      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        return res.status(400).json({
          message: "Invalid time format. Use HH:MM (24-hour format)",
        });
      }

      // Validate end time is after start time
      const startMinutes =
        parseInt(startTime.split(":")[0]) * 60 +
        parseInt(startTime.split(":")[1]);
      const endMinutes =
        parseInt(endTime.split(":")[0]) * 60 + parseInt(endTime.split(":")[1]);
      if (endMinutes <= startMinutes) {
        return res.status(400).json({
          message: "End time must be after start time",
        });
      }

      // Verify venue and space exist
      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      // Check for overlapping slots
      const hasOverlap = await checkSlotOverlap(
        venueId,
        spaceId,
        date,
        startTime,
        endTime,
      );
      if (hasOverlap) {
        return res.status(409).json({
          message: "This time slot overlaps with an existing slot",
        });
      }

      // Create the time slot
      const timeSlot = await TimeSlot.create({
        venueId,
        spaceId,
        date,
        startTime,
        endTime,
        price: price || 150,
        isCustom: true,
        isActive: true,
        createdBy: user.id,
      });

      res.status(201).json({
        message: "Time slot created successfully",
        slot: {
          id: timeSlot._id.toString(),
          date: timeSlot.date,
          startTime: timeSlot.startTime,
          endTime: timeSlot.endTime,
          price: timeSlot.price,
          isCustom: true,
          available: true,
        },
      });
    } catch (error: any) {
      console.error("Error creating time slot:", error);
      if (error.code === 11000) {
        return res.status(409).json({
          message: "A slot with this time already exists",
        });
      }
      res.status(500).json({ message: "Failed to create time slot" });
    }
  },
);

// Update a custom time slot (Admin only)
app.put(
  "/api/venues/:venueId/spaces/:spaceId/slots/:slotId",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId, slotId } = req.params;
      const { date, startTime, endTime, price } = req.body;

      // Find the existing slot
      const existingSlot = await TimeSlot.findOne({
        _id: slotId,
        venueId,
        spaceId,
      });

      if (!existingSlot) {
        return res.status(404).json({ message: "Time slot not found" });
      }

      // Validate time format if provided
      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (startTime && !timeRegex.test(startTime)) {
        return res.status(400).json({
          message: "Invalid start time format. Use HH:MM (24-hour format)",
        });
      }
      if (endTime && !timeRegex.test(endTime)) {
        return res.status(400).json({
          message: "Invalid end time format. Use HH:MM (24-hour format)",
        });
      }

      // Use existing values if not provided
      const newStartTime = startTime || existingSlot.startTime;
      const newEndTime = endTime || existingSlot.endTime;
      const newDate = date || existingSlot.date;

      // Validate end time is after start time
      const startMinutes =
        parseInt(newStartTime.split(":")[0]) * 60 +
        parseInt(newStartTime.split(":")[1]);
      const endMinutes =
        parseInt(newEndTime.split(":")[0]) * 60 +
        parseInt(newEndTime.split(":")[1]);
      if (endMinutes <= startMinutes) {
        return res.status(400).json({
          message: "End time must be after start time",
        });
      }

      // Check for overlapping slots (excluding current slot)
      const hasOverlap = await checkSlotOverlap(
        venueId,
        spaceId,
        newDate,
        newStartTime,
        newEndTime,
        slotId,
      );
      if (hasOverlap) {
        return res.status(409).json({
          message: "This time slot overlaps with an existing slot",
        });
      }

      // Check if slot has an active booking
      const booking = await Booking.findOne({
        venueId,
        spaceId,
        date: existingSlot.date,
        startTime: existingSlot.startTime,
        status: { $ne: "cancelled" },
      });

      if (
        booking &&
        (newStartTime !== existingSlot.startTime ||
          newEndTime !== existingSlot.endTime ||
          newDate !== existingSlot.date)
      ) {
        return res.status(409).json({
          message: "Cannot modify time for a slot that has an active booking",
        });
      }

      // Update the slot
      existingSlot.date = newDate;
      existingSlot.startTime = newStartTime;
      existingSlot.endTime = newEndTime;
      if (price !== undefined) {
        existingSlot.price = price;
      }
      await existingSlot.save();

      res.status(200).json({
        message: "Time slot updated successfully",
        slot: {
          id: existingSlot._id.toString(),
          date: existingSlot.date,
          startTime: existingSlot.startTime,
          endTime: existingSlot.endTime,
          price: existingSlot.price,
          isCustom: true,
        },
      });
    } catch (error) {
      console.error("Error updating time slot:", error);
      res.status(500).json({ message: "Failed to update time slot" });
    }
  },
);

// Delete a custom time slot (Admin only)
app.delete(
  "/api/venues/:venueId/spaces/:spaceId/slots/:slotId",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId, slotId } = req.params;

      // Find the existing slot
      const existingSlot = await TimeSlot.findOne({
        _id: slotId,
        venueId,
        spaceId,
      });

      if (!existingSlot) {
        return res.status(404).json({ message: "Time slot not found" });
      }

      // Check if slot has an active booking
      const booking = await Booking.findOne({
        venueId,
        spaceId,
        date: existingSlot.date,
        startTime: existingSlot.startTime,
        status: { $ne: "cancelled" },
      });

      if (booking) {
        return res.status(409).json({
          message:
            "Cannot delete a slot that has an active booking. Cancel the booking first.",
        });
      }

      // Delete the slot
      await TimeSlot.deleteOne({ _id: slotId });

      res.status(200).json({
        message: "Time slot deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting time slot:", error);
      res.status(500).json({ message: "Failed to delete time slot" });
    }
  },
);

// Generate time slots for a space based on venue operating hours (Admin only)
// This creates TimeSlot records in the database for a specified date range
app.post(
  "/api/venues/:venueId/spaces/:spaceId/generate-slots",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { startDate, endDate, price } = req.body;
      const user = (req as any).user;

      // Verify venue and space exist
      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      if (!venue.operatingHours) {
        return res.status(400).json({
          message: "Venue does not have operating hours configured",
        });
      }

      // Default to next 14 days if no dates provided
      const start = startDate ? new Date(startDate) : new Date();
      const end = endDate
        ? new Date(endDate)
        : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      const dayNames = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ] as const;

      const createdSlots: any[] = [];
      const skippedSlots: any[] = [];

      // Iterate through each day in the range
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        const dayOfWeek = d.getDay();
        const dayName = dayNames[dayOfWeek];
        const hours = venue.operatingHours[dayName];

        if (!hours) {
          continue; // Venue closed on this day
        }

        // Parse operating hours with rounding (supports AM/PM format)
        const openTime = parseTimeString(hours.open);
        const effectiveOpenHour =
          openTime.minute > 0 ? openTime.hour + 1 : openTime.hour;
        const closeTime = parseTimeString(hours.close);
        const closeHour = closeTime.hour;

        // Generate hourly slots for this day
        for (let hour = effectiveOpenHour; hour < closeHour; hour++) {
          const startTime = `${hour.toString().padStart(2, "0")}:00`;
          const endTime = `${(hour + 1).toString().padStart(2, "0")}:00`;

          try {
            const timeSlot = await TimeSlot.create({
              venueId,
              spaceId,
              date: dateStr,
              startTime,
              endTime,
              price: price || 150,
              isCustom: false, // Auto-generated
              isActive: true,
              createdBy: user.id,
            });

            createdSlots.push({
              id: timeSlot._id.toString(),
              date: dateStr,
              startTime,
              endTime,
              price: timeSlot.price,
            });
          } catch (error: any) {
            // Slot already exists, skip it
            if (error.code === 11000) {
              skippedSlots.push({ date: dateStr, startTime, endTime });
            }
          }
        }
      }

      res.status(201).json({
        message: `Generated ${createdSlots.length} time slots`,
        created: createdSlots.length,
        skipped: skippedSlots.length,
        slots: createdSlots,
      });
    } catch (error) {
      console.error("Error generating time slots:", error);
      res.status(500).json({ message: "Failed to generate time slots" });
    }
  },
);

// Book a time slot
app.post(
  "/api/venues/:venueId/spaces/:spaceId/book",
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { date, startTime, endTime, eventName, notes } = req.body;
      const user = (req as any).user;

      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!date || !startTime || !endTime || !eventName) {
        return res.status(400).json({
          message:
            "Missing required fields: date, startTime, endTime, eventName",
        });
      }

      // Verify venue and space exist
      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      // Get user details
      const dbUser = await User.findById(user.id);
      if (!dbUser) {
        return res.status(401).json({ message: "User not found" });
      }

      // Check if slot is already booked
      const existingBooking = await Booking.findOne({
        venueId,
        spaceId,
        date,
        startTime,
        status: { $ne: "cancelled" },
      });

      if (existingBooking) {
        return res
          .status(409)
          .json({ message: "This time slot is already booked" });
      }

      // Create the booking
      const booking = await Booking.create({
        venueId,
        spaceId,
        spaceName: space.name,
        userId: user.id,
        userName: dbUser.name || dbUser.username,
        userEmail: dbUser.email,
        eventName,
        date,
        startTime,
        endTime,
        status: "pending",
        notes,
      });

      res.status(201).json({
        message: "Booking created successfully",
        booking,
      });
    } catch (error: any) {
      console.error("Error creating booking:", error);
      if (error.code === 11000) {
        return res
          .status(409)
          .json({ message: "This time slot is already booked" });
      }
      res.status(500).json({ message: "Failed to create booking" });
    }
  },
);

// Send an inquiry about a space
app.post(
  "/api/venues/:venueId/spaces/:spaceId/inquire",
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { message, preferredDate, preferredTime, phone } = req.body;
      const user = (req as any).user;

      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }

      // Verify venue and space exist
      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      // Get user details
      const dbUser = await User.findById(user.id);
      if (!dbUser) {
        return res.status(401).json({ message: "User not found" });
      }

      // Create the inquiry
      const inquiry = await Inquiry.create({
        venueId,
        spaceId,
        spaceName: space.name,
        userId: user.id,
        userName: dbUser.name || dbUser.username,
        userEmail: dbUser.email,
        userPhone: phone,
        preferredDate,
        preferredTime,
        message,
        status: "new",
      });

      // TODO: Send email notification to venue contact

      res.status(201).json({
        message: "Inquiry sent successfully",
        inquiry,
      });
    } catch (error) {
      console.error("Error creating inquiry:", error);
      res.status(500).json({ message: "Failed to send inquiry" });
    }
  },
);

// Get user's bookings
app.get("/api/bookings/my", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const bookings = await Booking.find({ userId: user.id })
      .populate("venueId", "name address")
      .sort({ date: -1, startTime: -1 });

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

// Cancel a booking (deletes from database)
app.patch("/api/bookings/:id/cancel", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Only allow user to cancel their own booking (or admin)
    if (booking.userId.toString() !== user.id) {
      const dbUser = await User.findById(user.id);
      if (!dbUser?.isAdmin) {
        return res
          .status(403)
          .json({ message: "Not authorized to cancel this booking" });
      }
    }

    // Delete the booking from the database instead of soft-delete
    await Booking.findByIdAndDelete(req.params.id);

    res.status(200).json({ message: "Booking cancelled and removed" });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ message: "Failed to cancel booking" });
  }
});

// Admin: Get all bookings for a venue
app.get(
  "/api/venues/:venueId/bookings",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId } = req.params;
      const { date, status } = req.query;

      const filter: any = { venueId };
      if (date) filter.date = date;
      if (status) filter.status = status;

      const bookings = await Booking.find(filter).sort({
        date: 1,
        startTime: 1,
      });

      res.status(200).json(bookings);
    } catch (error) {
      console.error("Error fetching venue bookings:", error);
      res.status(500).json({ message: "Failed to fetch bookings" });
    }
  },
);

// Admin: Update booking status
app.patch(
  "/api/bookings/:id/status",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { status } = req.body;
      if (!status || !["pending", "confirmed", "cancelled"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      const booking = await Booking.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true },
      );

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      res.status(200).json(booking);
    } catch (error) {
      console.error("Error updating booking status:", error);
      res.status(500).json({ message: "Failed to update booking" });
    }
  },
);

// ==================== END BOOKING ENDPOINTS ====================

// User API to register account
app.post(
  "/auth/register",
  [
    body("name").notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req: Request, res: Response) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { name, email, username, password } = req.body;

      const emailAlreadyExists = await User.findOne({ email });
      const usernameAlreadyExists = await User.findOne({ username });

      if (emailAlreadyExists) {
        return res
          .status(400)
          .json({ status: 400, message: "Email already in use" });
      }

      if (usernameAlreadyExists) {
        return res
          .status(400)
          .json({ status: 400, message: "Username already in use" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = await User.create({
        name,
        email,
        username,
        password: hashedPassword,
      });

      const token = jwt.sign(
        { id: newUser._id, tokenVersion: newUser.tokenVersion },
        JWT_SECRET,
      );
      return res.status(201).json({ success: true, user: newUser, token });
    } catch (error) {
      console.error("Error in /auth/register:", error);
      res
        .status(500)
        .json({ message: "Failed to create a new user. Please try again" });
    }
  },
);

// User API to login
app.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const token = jwt.sign(
      { id: user._id, tokenVersion: user.tokenVersion },
      JWT_SECRET,
    );
    return res.status(200).json({ success: true, user, token });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to process the login request" });
  }
});

// Validate JWT token for persistent sign-in
app.get("/auth/validate", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      tokenVersion?: number;
    };

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Check if token version matches (invalidate old tokens after password change)
    if (
      decoded.tokenVersion !== undefined &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Token has been invalidated. Please log in again.",
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        profilePicUrl: user.profilePicUrl,
      },
    });
  } catch (error) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

// Change password (invalidates all existing tokens)
app.put("/auth/change-password", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string };

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current and new password are required",
      });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const passwordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Current password is incorrect" });
    }

    // Hash new password and increment tokenVersion to invalidate all existing tokens
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Issue a new token with updated tokenVersion
    const newToken = jwt.sign(
      { id: user._id, tokenVersion: user.tokenVersion },
      JWT_SECRET,
    );

    return res.status(200).json({
      success: true,
      message:
        "Password changed successfully. All other sessions have been logged out.",
      token: newToken,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to change password" });
  }
});

// Password reset request
app.post("/auth/forgot-password", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always return success to prevent email enumeration attacks
    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an account exists, a reset email has been sent",
      });
    }

    // Generate reset token (1 hour expiry)
    const resetToken = jwt.sign(
      { id: user._id, purpose: "password-reset" },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    // Configure nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    // Build reset link - use FRONTEND_URL or auto-detect from request
    const baseUrl =
      process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`;
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "BetterPlay - Reset Your Password",
      html: `
        <h2>Password Reset Request</h2>
        <p>You requested to reset your password. Click the link below to set a new password:</p>
        <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });

    return res.status(200).json({
      success: true,
      message: "If an account exists, a reset email has been sent",
    });
  } catch (error: any) {
    console.error("Error in forgot-password:", error);
    console.error("Email error details:", error?.message, error?.code);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Deep link redirect for password reset (opens the app)
app.get("/reset-password", (req: Request, res: Response) => {
  const { token } = req.query;

  // Redirect to the app's deep link
  const deepLink = `betterplay://reset-password?token=${token}`;

  // HTML page that redirects to the app
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reset Password - BetterPlay</title>
      <meta http-equiv="refresh" content="0;url=${deepLink}">
      <style>
        body { font-family: -apple-system, sans-serif; text-align: center; padding: 50px; }
        a { color: #007AFF; }
      </style>
    </head>
    <body>
      <h2>Redirecting to BetterPlay...</h2>
      <p>If the app doesn't open automatically, <a href="${deepLink}">tap here</a>.</p>
    </body>
    </html>
  `);
});

// Reset password with token (API endpoint)
app.post("/auth/reset-password", async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Token and new password required" });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      purpose: string;
    };

    if (decoded.purpose !== "password-reset") {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Hash new password and invalidate old tokens
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return res
      .status(200)
      .json({ success: true, message: "Password reset successful" });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res
        .status(400)
        .json({ success: false, message: "Reset link has expired" });
    }
    return res
      .status(400)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

// Get all user data for data portability (GDPR compliance)
app.get("/auth/user-data", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    // Handle different authorization header formats
    let token = authHeader;
    if (authHeader.toLowerCase().startsWith("bearer")) {
      token = authHeader.replace(/^bearer:?\s*/i, "").trim();
    }

    if (!token || token === "null" || token === "undefined") {
      return res.status(401).json({
        success: false,
        message: "No valid token provided. Please log in again.",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      tokenVersion?: number;
    };

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Check if token version matches
    if (
      decoded.tokenVersion !== undefined &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Token has been invalidated. Please log in again.",
      });
    }

    const userId = user._id.toString();
    const username = user.username;

    // Fetch all user-related data
    const [eventsCreated, eventsJoined, communityNotes, userComments] =
      await Promise.all([
        // Events created by user
        Event.find({ createdBy: userId }),
        // Events user has joined (in roster)
        Event.find({ "roster.username": username }),
        // Community notes created by user
        communityNote.find({ userId: userId }),
        // Get all community notes where user has commented or replied
        communityNote.find({
          $or: [
            { "comments.userId": userId },
            { "comments.replies.userId": userId },
          ],
        }),
      ]);

    // Extract user's comments and replies from community notes
    const userCommentsAndReplies: any[] = [];
    userComments.forEach((note: any) => {
      note.comments?.forEach((comment: any) => {
        if (comment.userId === userId) {
          userCommentsAndReplies.push({
            type: "comment",
            noteId: note._id,
            commentId: comment._id,
            text: comment.text,
            createdAt: comment.createdAt,
            likes: comment.likes?.length || 0,
          });
        }
        comment.replies?.forEach((reply: any) => {
          if (reply.userId === userId) {
            userCommentsAndReplies.push({
              type: "reply",
              noteId: note._id,
              commentId: comment._id,
              replyId: reply._id,
              text: reply.text,
              createdAt: reply.createdAt,
              likes: reply.likes?.length || 0,
            });
          }
        });
      });
    });

    // Compile all user data
    const userData = {
      exportDate: new Date().toISOString(),
      profile: {
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        profilePicUrl: user.profilePicUrl,
        createdAt: (user as any).createdAt,
        updatedAt: (user as any).updatedAt,
      },
      eventsCreated: eventsCreated.map((event: any) => ({
        id: event._id,
        name: event.name,
        location: event.location,
        date: event.date,
        time: event.time,
        eventType: event.eventType,
        totalSpots: event.totalSpots,
        rosterSpotsFilled: event.rosterSpotsFilled,
        roster: event.roster,
        createdAt: event.createdAt,
      })),
      eventsJoined: eventsJoined
        .filter((event: any) => event.createdBy !== userId) // Exclude events they created
        .map((event: any) => ({
          id: event._id,
          name: event.name,
          location: event.location,
          date: event.date,
          time: event.time,
          eventType: event.eventType,
          createdBy: event.createdByUsername,
          joinedAt: event.roster?.find((p: any) => p.username === username),
        })),
      communityPosts: communityNotes.map((note: any) => ({
        id: note._id,
        text: note.text,
        likes: note.likes?.length || 0,
        commentsCount: note.comments?.length || 0,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
      commentsAndReplies: userCommentsAndReplies,
      statistics: {
        totalEventsCreated: eventsCreated.length,
        totalEventsJoined: eventsJoined.filter(
          (e: any) => e.createdBy !== userId,
        ).length,
        totalCommunityPosts: communityNotes.length,
        totalComments: userCommentsAndReplies.filter(
          (c) => c.type === "comment",
        ).length,
        totalReplies: userCommentsAndReplies.filter((c) => c.type === "reply")
          .length,
      },
    };

    return res.status(200).json({
      success: true,
      data: userData,
    });
  } catch (error) {
    console.error("Error fetching user data:", error);
    if (error instanceof jwt.JsonWebTokenError) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired token" });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch user data" });
  }
});

// Delete user account and all associated data (Apple Guideline 5.1.1(v) compliance)
app.delete("/auth/delete-account", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    console.log("Delete account - Auth header:", authHeader);

    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    // Handle different authorization header formats
    // "Bearer <token>", "Bearer: <token>", or just "<token>"
    let token = authHeader;
    if (authHeader.toLowerCase().startsWith("bearer")) {
      // Remove "Bearer " or "Bearer: " prefix
      token = authHeader.replace(/^bearer:?\s*/i, "").trim();
    }

    console.log(
      "Delete account - Extracted token (first 20 chars):",
      token.substring(0, 20),
    );

    // Check for null/undefined token (frontend bug)
    if (!token || token === "null" || token === "undefined") {
      return res.status(401).json({
        success: false,
        message: "No valid token provided. Please log in again.",
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      tokenVersion?: number;
    };

    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Check if token version matches
    if (
      decoded.tokenVersion !== undefined &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Token has been invalidated. Please log in again.",
      });
    }

    const userId = user._id.toString();
    const username = user.username;

    // 1. Delete user's profile picture from S3 (if exists)
    if (user.profilePicUrl) {
      try {
        // Extract the S3 key from the URL
        const url = new URL(user.profilePicUrl);
        const key = url.pathname.substring(1); // Remove leading '/'
        await s3
          .deleteObject({
            Bucket: process.env.AWS_S3_BUCKET_NAME || "",
            Key: key,
          })
          .promise();
      } catch (s3Error) {
        console.error("Error deleting profile picture from S3:", s3Error);
        // Continue with account deletion even if S3 deletion fails
      }
    }

    // 2. Delete all events created by the user
    await Event.deleteMany({ createdBy: userId });

    // 3. Remove user from any event rosters they joined
    await Event.updateMany(
      { "roster.username": username },
      {
        $pull: { roster: { username: username } },
        $inc: { rosterSpotsFilled: -1 },
      },
    );

    // 4. Delete all community notes created by the user
    await communityNote.deleteMany({ userId: userId });

    // 5. Remove user's comments from community notes
    await communityNote.updateMany(
      { "comments.userId": userId },
      { $pull: { comments: { userId: userId } } },
    );

    // 6. Remove user's replies from comments in community notes
    await communityNote.updateMany(
      { "comments.replies.userId": userId },
      { $pull: { "comments.$[].replies": { userId: userId } } },
    );

    // 7. Remove user's likes from community notes, comments, and replies
    await communityNote.updateMany(
      { likes: userId },
      { $pull: { likes: userId } },
    );
    await communityNote.updateMany(
      { "comments.likes": userId },
      { $pull: { "comments.$[].likes": userId } },
    );
    await communityNote.updateMany(
      { "comments.replies.likes": userId },
      { $pull: { "comments.$[].replies.$[].likes": userId } },
    );

    // 8. Delete the user account
    await User.findByIdAndDelete(userId);

    return res.status(200).json({
      success: true,
      message: "Account and all associated data have been permanently deleted.",
    });
  } catch (error) {
    console.error("Error deleting account:", error);
    if (error instanceof jwt.JsonWebTokenError) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired token" });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete account" });
  }
});

// User API to get all users (excluding passwords) with optional search and filtering
app.get("/users", async (req: Request, res: Response) => {
  try {
    const { search, sport } = req.query;
    const currentUser = (req as any).user;

    // Build query filter
    let filter: any = {};

    // Search by username (case-insensitive partial match)
    if (search && typeof search === "string") {
      filter.username = { $regex: search, $options: "i" };
    }

    // Filter by favorite sport
    if (sport && typeof sport === "string") {
      filter.favoriteSports = sport;
    }

    const users = await User.find(filter).select("-password");

    // Get current user's friend data for status calculation
    let currentUserData: any = null;
    if (currentUser && currentUser.id) {
      currentUserData = await User.findById(currentUser.id);
    }

    // Get event stats and friend status for each user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const eventsCreated = await Event.countDocuments({
          createdBy: user._id.toString(),
        });
        const eventsJoined = await Event.countDocuments({
          "roster.userId": user._id.toString(),
        });

        // Calculate friend status
        let friendStatus = "none";
        if (currentUserData && user._id.toString() !== currentUser.id) {
          if (currentUserData.friends?.includes(user._id)) {
            friendStatus = "friends";
          } else if (currentUserData.friendRequestsSent?.includes(user._id)) {
            friendStatus = "pending_sent";
          } else if (
            currentUserData.friendRequestsReceived?.includes(user._id)
          ) {
            friendStatus = "pending_received";
          }
        } else if (currentUser && user._id.toString() === currentUser.id) {
          friendStatus = "self";
        }

        return {
          _id: user._id,
          name: user.name,
          email: user.email,
          username: user.username,
          profilePicUrl: user.profilePicUrl,
          favoriteSports: user.favoriteSports,
          eventsCreated,
          eventsJoined,
          friendStatus,
        };
      }),
    );

    return res.status(200).json({ success: true, users: usersWithStats });
  } catch (error) {
    console.error("Failed to fetch users:", error);
    return res.status(500).json({ message: "Failed to fetch users" });
  }
});

// User API to get user data by ID
app.get("/user/:id", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch user data" });
  }
});

// Route to update profile picture URL (after S3 upload)
app.put("/user/profile-pic", async (req: Request, res: Response) => {
  const { userId, profilePicUrl } = req.body;

  if (!userId || !profilePicUrl) {
    return res.status(400).json({ error: "Missing userId or profilePicUrl" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.profilePicUrl = profilePicUrl;
    await user.save();

    return res
      .status(200)
      .json({ success: true, message: "Profile picture updated successfully" });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update profile picture" });
  }
});

// ==================== FAVORITE SPORTS ENDPOINTS ====================

// Get user's favorite sports
app.get("/user/:id/favorite-sports", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id).select("favoriteSports");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({
      success: true,
      favoriteSports: user.favoriteSports || [],
    });
  } catch (error) {
    console.error("Error fetching favorite sports:", error);
    return res.status(500).json({ message: "Failed to fetch favorite sports" });
  }
});

// Update user's favorite sports
app.put("/user/:id/favorite-sports", async (req: Request, res: Response) => {
  try {
    const { favoriteSports } = req.body;

    if (!Array.isArray(favoriteSports)) {
      return res
        .status(400)
        .json({ message: "favoriteSports must be an array" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.favoriteSports = favoriteSports;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Favorite sports updated successfully",
      favoriteSports: user.favoriteSports,
    });
  } catch (error) {
    console.error("Error updating favorite sports:", error);
    return res
      .status(500)
      .json({ message: "Failed to update favorite sports" });
  }
});

// ==================== END FAVORITE SPORTS ENDPOINTS ====================

// ==================== FRIENDS ENDPOINTS ====================

// Get current user's friends list
app.get("/users/me/friends", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const currentUser = await User.findById(user.id)
      .populate("friends", "-password")
      .select("friends");

    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Get event stats for each friend
    const friendsWithStats = await Promise.all(
      (currentUser.friends as any[]).map(async (friend: any) => {
        const eventsCreated = await Event.countDocuments({
          createdBy: friend._id.toString(),
        });
        const eventsJoined = await Event.countDocuments({
          "roster.userId": friend._id.toString(),
        });

        return {
          _id: friend._id,
          name: friend.name,
          username: friend.username,
          profilePicUrl: friend.profilePicUrl,
          favoriteSports: friend.favoriteSports,
          eventsCreated,
          eventsJoined,
        };
      }),
    );

    return res.status(200).json({ success: true, friends: friendsWithStats });
  } catch (error) {
    console.error("Failed to fetch friends:", error);
    return res.status(500).json({ message: "Failed to fetch friends" });
  }
});

// Remove a friend
app.delete(
  "/users/me/friends/:friendId",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { friendId } = req.params;

      // Remove friend from current user's list
      await User.findByIdAndUpdate(user.id, {
        $pull: { friends: friendId },
      });

      // Remove current user from friend's list
      await User.findByIdAndUpdate(friendId, {
        $pull: { friends: user.id },
      });

      return res.status(200).json({ success: true, message: "Friend removed" });
    } catch (error) {
      console.error("Failed to remove friend:", error);
      return res.status(500).json({ message: "Failed to remove friend" });
    }
  },
);

// Send a friend request
app.post(
  "/users/:userId/friend-request",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      // Can't send friend request to yourself
      if (userId === user.id) {
        return res
          .status(400)
          .json({ message: "Cannot send friend request to yourself" });
      }

      const targetUser = await User.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const currentUser = await User.findById(user.id);
      if (!currentUser) {
        return res.status(404).json({ message: "Current user not found" });
      }

      // Check if already friends
      if (currentUser.friends.includes(userId as any)) {
        return res.status(400).json({ message: "Already friends" });
      }

      // Check if request already sent
      if (currentUser.friendRequestsSent.includes(userId as any)) {
        return res.status(400).json({ message: "Friend request already sent" });
      }

      // Check if they already sent us a request (auto-accept)
      if (currentUser.friendRequestsReceived.includes(userId as any)) {
        // Auto-accept: add to friends and remove from requests
        await User.findByIdAndUpdate(user.id, {
          $push: { friends: userId },
          $pull: { friendRequestsReceived: userId },
        });
        await User.findByIdAndUpdate(userId, {
          $push: { friends: user.id },
          $pull: { friendRequestsSent: user.id },
        });

        // Notify both users that they are now friends
        notificationService.sendPushNotification({
          userId: userId,
          title: "Friend Request Accepted",
          body: `${currentUser.username} accepted your friend request`,
          type: "friend_accepted",
          data: {
            accepterId: user.id,
            accepterUsername: currentUser.username,
          },
        });

        return res.status(200).json({
          success: true,
          message: "Friend request accepted",
          status: "friends",
        });
      }

      // Add to sent requests for current user
      await User.findByIdAndUpdate(user.id, {
        $addToSet: { friendRequestsSent: userId },
      });

      // Add to received requests for target user
      await User.findByIdAndUpdate(userId, {
        $addToSet: { friendRequestsReceived: user.id },
      });

      // Send push notification to the target user
      notificationService.sendPushNotification({
        userId: userId,
        title: "New Friend Request",
        body: `${currentUser.username} sent you a friend request`,
        type: "friend_request",
        data: {
          senderId: user.id,
          senderUsername: currentUser.username,
        },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request sent" });
    } catch (error) {
      console.error("Failed to send friend request:", error);
      return res.status(500).json({ message: "Failed to send friend request" });
    }
  },
);

// Get incoming friend requests
app.get(
  "/users/me/friend-requests/incoming",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const currentUser = await User.findById(user.id)
        .populate("friendRequestsReceived", "-password")
        .select("friendRequestsReceived");

      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const requests = (currentUser.friendRequestsReceived as any[]).map(
        (requester: any) => ({
          _id: requester._id,
          name: requester.name,
          username: requester.username,
          profilePicUrl: requester.profilePicUrl,
          favoriteSports: requester.favoriteSports,
        }),
      );

      return res.status(200).json({ success: true, requests });
    } catch (error) {
      console.error("Failed to fetch incoming friend requests:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch friend requests" });
    }
  },
);

// Get outgoing friend requests
app.get(
  "/users/me/friend-requests/outgoing",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const currentUser = await User.findById(user.id)
        .populate("friendRequestsSent", "-password")
        .select("friendRequestsSent");

      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const requests = (currentUser.friendRequestsSent as any[]).map(
        (recipient: any) => ({
          _id: recipient._id,
          name: recipient.name,
          username: recipient.username,
          profilePicUrl: recipient.profilePicUrl,
          favoriteSports: recipient.favoriteSports,
        }),
      );

      return res.status(200).json({ success: true, requests });
    } catch (error) {
      console.error("Failed to fetch outgoing friend requests:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch friend requests" });
    }
  },
);

// Accept a friend request
app.post(
  "/users/me/friend-requests/:userId/accept",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      const currentUser = await User.findById(user.id);
      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if request exists
      if (!currentUser.friendRequestsReceived.includes(userId as any)) {
        return res
          .status(400)
          .json({ message: "No friend request from this user" });
      }

      // Add to friends for both users and remove from requests
      await User.findByIdAndUpdate(user.id, {
        $push: { friends: userId },
        $pull: { friendRequestsReceived: userId },
      });

      await User.findByIdAndUpdate(userId, {
        $push: { friends: user.id },
        $pull: { friendRequestsSent: user.id },
      });

      // Send push notification to the user whose request was accepted
      notificationService.sendPushNotification({
        userId: userId,
        title: "Friend Request Accepted",
        body: `${currentUser.username} accepted your friend request`,
        type: "friend_accepted",
        data: {
          accepterId: user.id,
          accepterUsername: currentUser.username,
        },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request accepted" });
    } catch (error) {
      console.error("Failed to accept friend request:", error);
      return res
        .status(500)
        .json({ message: "Failed to accept friend request" });
    }
  },
);

// Decline a friend request
app.post(
  "/users/me/friend-requests/:userId/decline",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      // Remove from received requests
      await User.findByIdAndUpdate(user.id, {
        $pull: { friendRequestsReceived: userId },
      });

      // Remove from sent requests for the other user
      await User.findByIdAndUpdate(userId, {
        $pull: { friendRequestsSent: user.id },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request declined" });
    } catch (error) {
      console.error("Failed to decline friend request:", error);
      return res
        .status(500)
        .json({ message: "Failed to decline friend request" });
    }
  },
);

// Cancel a sent friend request
app.delete(
  "/users/me/friend-requests/:userId/cancel",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      // Remove from sent requests
      await User.findByIdAndUpdate(user.id, {
        $pull: { friendRequestsSent: userId },
      });

      // Remove from received requests for the other user
      await User.findByIdAndUpdate(userId, {
        $pull: { friendRequestsReceived: user.id },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request cancelled" });
    } catch (error) {
      console.error("Failed to cancel friend request:", error);
      return res
        .status(500)
        .json({ message: "Failed to cancel friend request" });
    }
  },
);

// Get friend status with a specific user (for UI state)
app.get("/users/:userId/friend-status", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const { userId } = req.params;

    if (userId === user.id) {
      return res.status(200).json({ success: true, status: "self" });
    }

    const currentUser = await User.findById(user.id);
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    let status = "none";

    if (currentUser.friends.includes(userId as any)) {
      status = "friends";
    } else if (currentUser.friendRequestsSent.includes(userId as any)) {
      status = "pending_sent";
    } else if (currentUser.friendRequestsReceived.includes(userId as any)) {
      status = "pending_received";
    }

    return res.status(200).json({ success: true, status });
  } catch (error) {
    console.error("Failed to get friend status:", error);
    return res.status(500).json({ message: "Failed to get friend status" });
  }
});

// ==================== END FRIENDS ENDPOINTS ====================

// ==================== USER EVENTS ENDPOINTS ====================

// Get events created by a specific user
app.get("/user/:id/events/created", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const events = await Event.find({ createdBy: userId })
      .sort({ date: -1 })
      .lean();

    // Collect all unique userIds from event likes
    const userIds = new Set<string>();
    events.forEach((event: any) => {
      event.likes?.forEach((id: string) => userIds.add(String(id)));
    });

    // Fetch usernames for all likers
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

    // Add likedByUsernames to each event
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

// Get events joined by a specific user (where user is in the roster)
app.get("/user/:id/events/joined", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;

    // First get the user to get their username
    const user = await User.findById(userId).select("username");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Find events where user is in roster but NOT the creator
    const events = await Event.find({
      "roster.username": user.username,
      createdBy: { $ne: userId }, // Exclude events they created
    })
      .sort({ date: -1 })
      .lean();

    // Collect all unique userIds from event likes
    const likerIds = new Set<string>();
    events.forEach((event: any) => {
      event.likes?.forEach((id: string) => likerIds.add(String(id)));
    });

    // Fetch usernames for all likers
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

    // Add likedByUsernames to each event
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

// Get count of events created and joined by user (for profile stats)
app.get("/user/:id/events/stats", async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;

    // Get the user to get their username
    const user = await User.findById(userId).select("username");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Count events created
    const createdCount = await Event.countDocuments({ createdBy: userId });

    // Count events joined (in roster but not creator)
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

// ==================== END USER EVENTS ENDPOINTS ====================

// Legacy: bulk update roster (not recommended for add/remove single player)
app.put("/events/:id/roster", async (req: Request, res: Response) => {
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

// ==================== COMMUNITY NOTES ENDPOINTS ====================

// Get all posts (with profile pictures and likedByUsernames populated from Users collection)
app.get("/community-notes", async (req: Request, res: Response) => {
  try {
    const posts = await communityNote.find().lean();
    console.log("📝 Fetched posts count:", posts.length);

    // Collect all unique userIds from posts, comments, replies, AND likes
    const userIds = new Set<string>();
    posts.forEach((post: any) => {
      if (post.userId) userIds.add(String(post.userId));
      // Add post likers
      post.likes?.forEach((id: string) => userIds.add(String(id)));
      post.comments?.forEach((comment: any) => {
        if (comment.userId) userIds.add(String(comment.userId));
        // Add comment likers
        comment.likes?.forEach((id: string) => userIds.add(String(id)));
        comment.replies?.forEach((reply: any) => {
          if (reply.userId) userIds.add(String(reply.userId));
          // Add reply likers
          reply.likes?.forEach((id: string) => userIds.add(String(id)));
        });
      });
    });

    console.log("👥 Collected userIds:", Array.from(userIds));

    // Convert string IDs to ObjectIds for MongoDB query
    const objectIds = Array.from(userIds).map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return id;
      }
    });

    // Fetch all users and create lookup maps
    const users = await User.find({ _id: { $in: objectIds } }).lean();
    console.log(
      "🔍 Found users:",
      users.map((u: any) => ({
        id: u._id.toString(),
        username: u.username,
        profilePicUrl: u.profilePicUrl || "NO_PIC",
      })),
    );

    // Map for profile pictures
    const userPicMap = new Map<string, string>();
    // Map for usernames (for likedByUsernames)
    const userNameMap = new Map<string, string>();
    users.forEach((u: any) => {
      userPicMap.set(u._id.toString(), u.profilePicUrl || "");
      userNameMap.set(u._id.toString(), u.username || "");
    });

    console.log("🗺️ User map entries:", Object.fromEntries(userPicMap));

    // Helper function to get likedByUsernames from likes array
    const getLikedByUsernames = (likes: string[] | undefined): string[] => {
      if (!likes || likes.length === 0) return [];
      return likes
        .map((id) => userNameMap.get(String(id)))
        .filter((name): name is string => !!name);
    };

    // Populate profilePicUrl and likedByUsernames for posts, comments, and replies
    const postsWithPhotos = posts.map((post: any) => {
      const postUserId = String(post.userId);
      const postPic = userPicMap.get(postUserId) || "";
      console.log(
        `📸 Post by ${post.username} (${postUserId}): pic = ${
          postPic ? "YES" : "NO"
        }`,
      );

      return {
        ...post,
        profilePicUrl: postPic,
        likedByUsernames: getLikedByUsernames(post.likes),
        comments: post.comments?.map((comment: any) => {
          const commentUserId = String(comment.userId);
          const commentPic = userPicMap.get(commentUserId) || "";
          return {
            ...comment,
            profilePicUrl: commentPic,
            likedByUsernames: getLikedByUsernames(comment.likes),
            replies: comment.replies?.map((reply: any) => {
              const replyUserId = String(reply.userId);
              const replyPic = userPicMap.get(replyUserId) || "";
              return {
                ...reply,
                profilePicUrl: replyPic,
                likedByUsernames: getLikedByUsernames(reply.likes),
              };
            }),
          };
        }),
      };
    });

    console.log(
      "✅ Sending postsWithPhotos, first post profilePicUrl:",
      postsWithPhotos[0]?.profilePicUrl,
    );

    res.status(200).json(postsWithPhotos);
  } catch (error) {
    console.error("❌ Error fetching community notes:", error);
    res.status(500).json({ message: "Failed to fetch posts." });
  }
});

// Get community note by linked event ID
app.get(
  "/community-notes/event/:eventId",
  async (req: Request, res: Response) => {
    try {
      const { eventId } = req.params;
      const post = await communityNote.findOne({ eventId }).lean();

      if (!post) {
        return res
          .status(404)
          .json({ message: "No post found for this event." });
      }

      // Collect all unique userIds from the post, comments, replies, AND likes
      const userIds = new Set<string>();
      if ((post as any).userId) userIds.add(String((post as any).userId));
      // Add post likers
      (post as any).likes?.forEach((id: string) => userIds.add(String(id)));
      (post as any).comments?.forEach((comment: any) => {
        if (comment.userId) userIds.add(String(comment.userId));
        // Add comment likers
        comment.likes?.forEach((id: string) => userIds.add(String(id)));
        comment.replies?.forEach((reply: any) => {
          if (reply.userId) userIds.add(String(reply.userId));
          // Add reply likers
          reply.likes?.forEach((id: string) => userIds.add(String(id)));
        });
      });

      // Convert string IDs to ObjectIds for MongoDB query
      const objectIds = Array.from(userIds).map((id) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });

      // Fetch all users and create lookup maps
      const users = await User.find({ _id: { $in: objectIds } }).lean();

      // Map for profile pictures
      const userPicMap = new Map<string, string>();
      // Map for usernames (for likedByUsernames)
      const userNameMap = new Map<string, string>();
      users.forEach((u: any) => {
        userPicMap.set(u._id.toString(), u.profilePicUrl || "");
        userNameMap.set(u._id.toString(), u.username || "");
      });

      // Helper function to get likedByUsernames from likes array
      const getLikedByUsernames = (likes: string[] | undefined): string[] => {
        if (!likes || likes.length === 0) return [];
        return likes
          .map((id) => userNameMap.get(String(id)))
          .filter((name): name is string => !!name);
      };

      // Populate profilePicUrl and likedByUsernames for post, comments, and replies
      const postWithDetails = {
        ...(post as any),
        profilePicUrl: userPicMap.get(String((post as any).userId)) || "",
        likedByUsernames: getLikedByUsernames((post as any).likes),
        comments: (post as any).comments?.map((comment: any) => {
          const commentUserId = String(comment.userId);
          const commentPic = userPicMap.get(commentUserId) || "";
          return {
            ...comment,
            profilePicUrl: commentPic,
            likedByUsernames: getLikedByUsernames(comment.likes),
            replies: comment.replies?.map((reply: any) => {
              const replyUserId = String(reply.userId);
              const replyPic = userPicMap.get(replyUserId) || "";
              return {
                ...reply,
                profilePicUrl: replyPic,
                likedByUsernames: getLikedByUsernames(reply.likes),
              };
            }),
          };
        }),
      };

      res.status(200).json(postWithDetails);
    } catch (error) {
      console.error("❌ Error fetching community note by event:", error);
      res.status(500).json({ message: "Failed to fetch post." });
    }
  },
);

// Create a new post
app.post("/community-notes", async (req: Request, res: Response) => {
  try {
    const { text, userId, username, eventId, eventName, eventType } = req.body;
    if (!text || !userId || !username) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // Fetch the user's current profile picture from the database
    const user = await User.findById(userId).select("profilePicUrl");
    const profilePicUrl = user?.profilePicUrl || "";

    const newPost = await communityNote.create({
      text,
      userId,
      username,
      profilePicUrl,
      comments: [],
      // Event link fields (optional)
      eventId: eventId || null,
      eventName: eventName || null,
      eventType: eventType || null,
    });

    // If post is linked to an event, notify event attendees
    if (eventId) {
      const event = await Event.findById(eventId);
      if (event && event.roster && event.roster.length > 0) {
        const attendeeUserIds = event.roster
          .filter((p: any) => p.userId && p.userId !== userId) // Exclude the poster
          .map((p: any) => p.userId);

        if (attendeeUserIds.length > 0) {
          notificationService.sendPushNotificationToMany(
            attendeeUserIds,
            "New Community Post 📝",
            `${username} posted about "${eventName}"`,
            "community_note",
            {
              postId: newPost._id.toString(),
              eventId: eventId,
              eventName: eventName || "",
              posterUsername: username,
            },
          );
        }
      }
    }

    res.status(201).json(newPost);
  } catch (error) {
    res.status(500).json({ message: "Failed to create post." });
  }
});

// Edit a post
app.put("/community-notes/:postId", async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    const post = await communityNote.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found." });
    post.text = text || post.text;
    await post.save();
    res.status(200).json({ text: post.text });
  } catch (error) {
    res.status(500).json({ message: "Failed to edit post." });
  }
});

// Delete a post
app.delete("/community-notes/:postId", async (req: Request, res: Response) => {
  try {
    const post = await communityNote.findByIdAndDelete(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found." });
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ message: "Failed to delete post." });
  }
});

// Add a comment to a post
app.post(
  "/community-notes/:postId/comments",
  async (req: Request, res: Response) => {
    try {
      const { text, userId, username } = req.body;
      if (!text || !userId || !username) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });

      // Fetch the user's current profile picture from the database
      const user = await User.findById(userId).select("profilePicUrl");
      const profilePicUrl = user?.profilePicUrl || "";

      const comment = {
        text,
        userId,
        username,
        profilePicUrl,
        replies: [],
      };
      post.comments.push(comment);
      await post.save();

      // Notify the post author about the new comment (if not commenting on own post)
      if (post.userId && post.userId !== userId) {
        notificationService.sendPushNotification({
          userId: post.userId,
          title: "New Comment 💬",
          body: `${username} commented on your post`,
          type: "community_note",
          data: {
            postId: post._id.toString(),
            commenterUsername: username,
          },
        });
      }

      res.status(201).json({ comments: post.comments });
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment." });
    }
  },
);

// Edit a comment
app.put(
  "/community-notes/:postId/comments/:commentId",
  async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      comment.text = text || comment.text;
      await post.save();
      res.status(200).json({ text: comment.text });
    } catch (error) {
      res.status(500).json({ message: "Failed to edit comment." });
    }
  },
);

// Delete a comment
app.delete(
  "/community-notes/:postId/comments/:commentId",
  async (req: Request, res: Response) => {
    try {
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      post.comments.pull(req.params.commentId);
      await post.save();
      res.status(200).json({ comments: post.comments });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete comment." });
    }
  },
);

// Add a reply to a comment
app.post(
  "/community-notes/:postId/comments/:commentId/replies",
  async (req: Request, res: Response) => {
    try {
      const { text, userId, username } = req.body;
      if (!text || !userId || !username) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });

      // Fetch the user's current profile picture from the database
      const user = await User.findById(userId).select("profilePicUrl");
      const profilePicUrl = user?.profilePicUrl || "";

      comment.replies.push({
        text,
        userId,
        username,
        profilePicUrl,
      });
      await post.save();
      res.status(201).json({ replies: comment.replies });
    } catch (error) {
      res.status(500).json({ message: "Failed to add reply." });
    }
  },
);

// Edit a reply
app.put(
  "/community-notes/:postId/comments/:commentId/replies/:replyId",
  async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });
      reply.text = text || reply.text;
      await post.save();
      res.status(200).json({ text: reply.text });
    } catch (error) {
      res.status(500).json({ message: "Failed to edit reply." });
    }
  },
);

// Delete a reply
app.delete(
  "/community-notes/:postId/comments/:commentId/replies/:replyId",
  async (req: Request, res: Response) => {
    try {
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });
      comment.replies.pull(req.params.replyId);
      await post.save();
      res.status(200).json({ replies: comment.replies });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete reply." });
    }
  },
);

// Toggle like on a post
app.post(
  "/community-notes/:postId/like",
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });

      const likeIndex = post.likes.indexOf(userId);
      if (likeIndex === -1) {
        post.likes.push(userId);
      } else {
        post.likes.splice(likeIndex, 1);
      }
      await post.save();

      // Fetch usernames for all users who liked
      const likerIds = post.likes.map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = post.likes
        .map((id: string) => {
          const user = likers.find((u: any) => u._id.toString() === String(id));
          return user?.username;
        })
        .filter((name: string | undefined): name is string => !!name);

      res.status(200).json({ likes: post.likes, likedByUsernames });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on post." });
    }
  },
);

// Toggle like on a comment
app.post(
  "/community-notes/:postId/comments/:commentId/like",
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });

      const likeIndex = comment.likes.indexOf(userId);
      if (likeIndex === -1) {
        comment.likes.push(userId);
      } else {
        comment.likes.splice(likeIndex, 1);
      }
      await post.save();

      // Fetch usernames for all users who liked
      const likerIds = comment.likes.map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = comment.likes
        .map((id: string) => {
          const user = likers.find((u: any) => u._id.toString() === String(id));
          return user?.username;
        })
        .filter((name: string | undefined): name is string => !!name);

      res.status(200).json({ likes: comment.likes, likedByUsernames });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on comment." });
    }
  },
);

// Toggle like on a reply
app.post(
  "/community-notes/:postId/comments/:commentId/replies/:replyId/like",
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });

      const likeIndex = reply.likes.indexOf(userId);
      if (likeIndex === -1) {
        reply.likes.push(userId);
      } else {
        reply.likes.splice(likeIndex, 1);
      }
      await post.save();

      // Fetch usernames for all users who liked
      const likerIds = reply.likes.map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = reply.likes
        .map((id: string) => {
          const user = likers.find((u: any) => u._id.toString() === String(id));
          return user?.username;
        })
        .filter((name: string | undefined): name is string => !!name);

      res.status(200).json({ likes: reply.likes, likedByUsernames });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on reply." });
    }
  },
);

// ==================== END COMMUNITY NOTES ENDPOINTS ====================

// Declare The PORT
const PORT = process.env.PORT || 8001;

app.listen(PORT, async () => {
  console.log(`🗄️ Server Fire on http://localhost:${PORT}`);

  // Connect to Database
  try {
    const DATABASE_URL =
      process.env.MONGODB_URI || "mongodb://localhost:27017/OMHL";
    await mongoose.connect(DATABASE_URL);
    console.log("🛢️ Connected To Database");

    // Start event reminder scheduler
    eventReminderService.startEventReminderScheduler();
  } catch (error) {
    console.log("⚠️ Error connecting to the database:", error);
    process.exit(1);
  }
});
