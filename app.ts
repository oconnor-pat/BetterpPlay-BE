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
  // Return a 200 status if the server is available
  res.sendStatus(200);
});

// Basic welcome route
app.get("/", (req: Request, res: Response) => {
  res.send("Welcome to a better way to play!");
});

// User API to register account
app.post("/auth/register", async (req: Request, res: Response) => {
  try {
    // Get user data from the request body
    const { name, email, username, password } = req.body;

    // Check if the email or username already exists in the database
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

    user.profilePicUrl = profilePicUrl; // Update the profilePicUrl
    await user.save();

    return res
      .status(200)
      .json({ success: true, message: "Profile picture updated successfully" });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update profile picture" });
  }
});

// New endpoint to update an event's roster
app.put("/events/:id/roster", async (req: Request, res: Response) => {
  const eventId = req.params.id;
  const { roster } = req.body;
  try {
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }
    // Update the event's roster. Make sure your Event schema defines a "roster" field.
    event.roster = roster;
    await event.save();
    return res.status(200).json({ success: true, roster: event.roster });
  } catch (error) {
    console.error("Error updating event roster:", error);
    return res.status(500).json({ message: "Error updating event roster" });
  }
});

// Get all posts
app.get("/community-notes", async (req, res) => {
  const notes = await communityNote.find();
  res.json(notes);
});

// Create a post
app.post("/community-notes", async (req, res) => {
  const { text, userId, username } = req.body;
  const note = await communityNote.create({
    text,
    userId,
    username,
    comments: [],
  });
  res.status(201).json(note);
});

// Edit a post
app.put("/community-notes/:id", async (req, res) => {
  const { text } = req.body;
  const note = await communityNote.findById(req.params.id);
  if (!note) {
    return res.status(404).json({ message: "Post not found" });
  }
  note.text = text;
  await note.save();
  res.json({ text: note.text });
});

// Add a comment
app.post("/community-notes/:id/comments", async (req, res) => {
  const { text, userId, username } = req.body;
  const note = await communityNote.findById(req.params.id);
  if (!note) {
    return res.status(404).json({ message: "Post not found" });
  }
  note.comments.push({ text, userId, username });
  await note.save();
  res.status(201).json({ comments: note.comments });
});

// Edit a comment
app.put("/community-notes/:postId/comments/:commentId", async (req, res) => {
  const { text } = req.body;
  const note = await communityNote.findById(req.params.postId);
  if (!note) {
    return res.status(404).json({ message: "Post not found" });
  }
  const comment = note.comments.id(req.params.commentId);
  if (!comment) {
    return res.status(404).json({ message: "Comment not found" });
  }
  comment.text = text;
  await note.save();
  res.json({ text: comment.text });
});

// Delete a post
app.delete("/community-notes/:id", async (req, res) => {
  await communityNote.findByIdAndDelete(req.params.id);
  res.sendStatus(204);
});

// Delete a comment
app.delete("/community-notes/:postId/comments/:commentId", async (req, res) => {
  const note = await communityNote.findById(req.params.postId);
  if (!note) {
    return res.status(404).json({ message: "Post not found" });
  }
  note.comments.pull({ _id: req.params.commentId });
  await note.save();
  res.status(200).json({ comments: note.comments });
});

// Add a reply to a comment
app.post(
  "/community-notes/:postId/comments/:commentId/replies",
  async (req, res) => {
    const { text, userId, username } = req.body;
    const { postId, commentId } = req.params;
    const note = await communityNote.findById(postId);
    if (!note) {
      return res.status(404).json({ message: "Post not found" });
    }
    const comment = note.comments.id(commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }
    comment.replies.push({ text, userId, username });
    await note.save();
    res.status(201).json({ replies: comment.replies });
  }
);

// Edit a reply
app.put(
  "/community-notes/:postId/comments/:commentId/replies/:replyId",
  async (req, res) => {
    const { text } = req.body;
    const { postId, commentId, replyId } = req.params;
    const note = await communityNote.findById(postId);
    if (!note) {
      return res.status(404).json({ message: "Post not found" });
    }
    const comment = note.comments.id(commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }
    const reply = comment.replies.id(replyId);
    if (!reply) {
      return res.status(404).json({ message: "Reply not found" });
    }
    reply.text = text;
    await note.save();
    res.json({ text: reply.text });
  }
);

// Delete a reply from a comment (FIXED)
app.delete(
  "/community-notes/:postId/comments/:commentId/replies/:replyId",
  async (req, res) => {
    const { postId, commentId, replyId } = req.params;
    const note = await communityNote.findById(postId);
    if (!note) {
      return res.status(404).json({ message: "Post not found" });
    }
    const comment = note.comments.id(commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }
    // Find the index of the reply to remove
    const replyIndex = comment.replies.findIndex(
      (reply: any) => reply._id.toString() === replyId
    );
    if (replyIndex === -1) {
      return res.status(404).json({ message: "Reply not found" });
    }
    comment.replies.splice(replyIndex, 1);
    await note.save();
    res.status(200).json({ replies: comment.replies });
  }
);

// Declare The PORT
const PORT = process.env.PORT || 8001;
app.get("/", (req: Request, res: Response) => {
  res.send("Welcome to a better way to play!");
});

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
    process.exit(1); // Exit the process
  }
});
