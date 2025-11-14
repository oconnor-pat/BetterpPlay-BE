import express, { Application, Request, Response } from "express";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import User, { IUser } from "./models/user";
import Event from "./models/event";
import communityNote from "./models/communityNote";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cors from "cors";
import AWS from "aws-sdk";

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
  })
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

// Check server availability
app.get("/check", (req: Request, res: Response) => {
  res.sendStatus(200);
});

// Basic welcome route
app.get("/", (req: Request, res: Response) => {
  res.send("Welcome to a better way to play!");
});

// ==================== EVENT ENDPOINTS ====================

// Get all events (include roster)
app.get("/events", async (req: Request, res: Response) => {
  try {
    const events = await Event.find();
    res.status(200).json(events);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch events" });
  }
});

// Get a single event (include roster)
app.get("/events/:id", async (req: Request, res: Response) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    res.status(200).json(event);
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

    await event.save();
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
  }
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

// ==================== END EVENT ENDPOINTS ====================

// User API to register account
app.post("/auth/register", async (req: Request, res: Response) => {
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

    const token = jwt.sign({ id: newUser._id }, JWT_SECRET, {
      expiresIn: "1h",
    });
    return res.status(201).json({ success: true, user: newUser, token });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to create a new user. Please try again" });
  }
});

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

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "1h" });
    return res.status(200).json({ success: true, user, token });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to process the login request" });
  }
});

// User API to get all users (excluding passwords)
app.get("/users", async (req: Request, res: Response) => {
  try {
    const users = await User.find().select("-password");
    return res.status(200).json({ success: true, users });
  } catch (error) {
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

// Get all posts
app.get("/community-notes", async (req: Request, res: Response) => {
  try {
    const posts = await communityNote.find();
    res.status(200).json(posts);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch posts." });
  }
});

// Create a new post
app.post("/community-notes", async (req: Request, res: Response) => {
  try {
    const { text, userId, username } = req.body;
    if (!text || !userId || !username) {
      return res.status(400).json({ message: "Missing required fields." });
    }
    const newPost = await communityNote.create({
      text,
      userId,
      username,
      comments: [],
    });
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
      const comment = {
        text,
        userId,
        username,
        replies: [],
      };
      post.comments.push(comment);
      await post.save();
      res.status(201).json({ comments: post.comments });
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment." });
    }
  }
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
  }
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
      comment.remove();
      await post.save();
      res.status(200).json({ comments: post.comments });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete comment." });
    }
  }
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
      comment.replies.push({ text, userId, username });
      await post.save();
      res.status(201).json({ replies: comment.replies });
    } catch (error) {
      res.status(500).json({ message: "Failed to add reply." });
    }
  }
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
  }
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
      reply.remove();
      await post.save();
      res.status(200).json({ replies: comment.replies });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete reply." });
    }
  }
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
  } catch (error) {
    console.log("⚠️ Error connecting to the database:", error);
    process.exit(1);
  }
});
