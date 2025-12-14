"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const mongoose_1 = __importDefault(require("mongoose"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const user_1 = __importDefault(require("./models/user"));
const event_1 = __importDefault(require("./models/event"));
const communityNote_1 = __importDefault(require("./models/communityNote"));
const dotenv_1 = __importDefault(require("dotenv"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const cors_1 = __importDefault(require("cors"));
const aws_sdk_1 = __importDefault(require("aws-sdk"));
const express_validator_1 = require("express-validator");
const app = (0, express_1.default)();
// Enable CORS for all origins (development)
app.use((0, cors_1.default)());
// Configure env
dotenv_1.default.config();
// S3 client setup
const s3 = new aws_sdk_1.default.S3({
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
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({
    extended: true,
}));
// JWT middleware
app.use((req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    if (req.headers.authorization) {
        const token = req.headers.authorization.split(" ")[1];
        try {
            const user = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            req.user = user;
        }
        catch (error) {
            console.error("Error verifying token:", error);
        }
    }
    next();
}));
// Check server availability
app.get("/check", (req, res) => {
    res.sendStatus(200);
});
// Basic welcome route
app.get("/", (req, res) => {
    res.send("Welcome to a better way to play!");
});
// ==================== EVENT ENDPOINTS ====================
// Get all events (include roster)
app.get("/events", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const events = yield event_1.default.find();
        res.status(200).json(events);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to fetch events" });
    }
}));
// Get a single event (include roster)
app.get("/events/:id", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const event = yield event_1.default.findById(req.params.id);
        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }
        res.status(200).json(event);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to fetch event" });
    }
}));
// Create a new event
app.post("/events", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { name, location, time, date, totalSpots, eventType, createdBy, createdByUsername, latitude, longitude, } = req.body;
        if (!name ||
            !location ||
            !time ||
            !date ||
            !totalSpots ||
            !eventType ||
            !createdBy) {
            return res.status(400).json({ message: "Missing required fields" });
        }
        // Optionally, validate that createdBy is a valid user
        const user = yield user_1.default.findById(createdBy);
        if (!user) {
            return res.status(400).json({ message: "Invalid user ID" });
        }
        const newEvent = yield event_1.default.create({
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
    }
    catch (error) {
        res.status(500).json({ message: "Failed to create event" });
    }
}));
// Update an event (edit)
app.put("/events/:id", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const eventId = req.params.id;
        const { name, location, time, date, totalSpots, eventType, createdByUsername, latitude, longitude, } = req.body;
        const event = yield event_1.default.findById(eventId);
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
        if (latitude !== undefined)
            event.latitude = latitude;
        if (longitude !== undefined)
            event.longitude = longitude;
        yield event.save();
        res.status(200).json(event);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to update event" });
    }
}));
// Add a player to the roster (append, not overwrite)
app.post("/events/:id/roster", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const eventId = req.params.id;
    const { player } = req.body; // player: { username, paidStatus, jerseyColor, position }
    if (!player || !player.username) {
        return res.status(400).json({ message: "Missing player data" });
    }
    try {
        const event = yield event_1.default.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }
        // Prevent duplicate usernames (optional)
        if (event.roster.some((p) => p.username === player.username)) {
            return res.status(409).json({ message: "Player already in roster" });
        }
        event.roster.push(player);
        event.rosterSpotsFilled = event.roster.length;
        yield event.save();
        return res.status(200).json({ success: true, roster: event.roster });
    }
    catch (error) {
        console.error("Error adding player to roster:", error);
        return res.status(500).json({ message: "Error adding player to roster" });
    }
}));
// Remove a player from the roster
app.delete("/events/:id/roster/:username", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const eventId = req.params.id;
    const username = req.params.username;
    try {
        const event = yield event_1.default.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }
        const initialLength = event.roster.length;
        event.roster = event.roster.filter((p) => p.username !== username);
        if (event.roster.length === initialLength) {
            return res.status(404).json({ message: "Player not found in roster" });
        }
        event.rosterSpotsFilled = event.roster.length;
        yield event.save();
        return res.status(200).json({ success: true, roster: event.roster });
    }
    catch (error) {
        console.error("Error removing player from roster:", error);
        return res
            .status(500)
            .json({ message: "Error removing player from roster" });
    }
}));
// Update rosterSpotsFilled (join/leave event, legacy)
app.patch("/events/:id/roster", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const eventId = req.params.id;
        const { playerAdded } = req.body;
        const event = yield event_1.default.findById(eventId);
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
        }
        else {
            if (event.rosterSpotsFilled > 0) {
                event.rosterSpotsFilled -= 1;
            }
        }
        yield event.save();
        res.status(200).json({ rosterSpotsFilled: event.rosterSpotsFilled });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to update roster" });
    }
}));
// Delete an event
app.delete("/events/:id", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const eventId = req.params.id;
        const event = yield event_1.default.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }
        yield event_1.default.findByIdAndDelete(eventId);
        res.sendStatus(204);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to delete event" });
    }
}));
// ==================== END EVENT ENDPOINTS ====================
// User API to register account
app.post("/auth/register", [
    (0, express_validator_1.body)("name").notEmpty().withMessage("Name is required"),
    (0, express_validator_1.body)("email").isEmail().withMessage("Valid email is required"),
    (0, express_validator_1.body)("password")
        .isLength({ min: 6 })
        .withMessage("Password must be at least 6 characters"),
], (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    // Check for validation errors
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    try {
        const { name, email, username, password } = req.body;
        const emailAlreadyExists = yield user_1.default.findOne({ email });
        const usernameAlreadyExists = yield user_1.default.findOne({ username });
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
        const hashedPassword = yield bcrypt_1.default.hash(password, 10);
        const newUser = yield user_1.default.create({
            name,
            email,
            username,
            password: hashedPassword,
        });
        const token = jsonwebtoken_1.default.sign({ id: newUser._id }, JWT_SECRET, {
            expiresIn: "1h",
        });
        return res.status(201).json({ success: true, user: newUser, token });
    }
    catch (error) {
        console.error("Error in /auth/register:", error);
        res
            .status(500)
            .json({ message: "Failed to create a new user. Please try again" });
    }
}));
// User API to login
app.post("/auth/login", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { username, password } = req.body;
        const user = yield user_1.default.findOne({ username });
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        const passwordMatch = yield bcrypt_1.default.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ message: "Incorrect password" });
        }
        const token = jsonwebtoken_1.default.sign({ id: user._id }, JWT_SECRET, { expiresIn: "1h" });
        return res.status(200).json({ success: true, user, token });
    }
    catch (error) {
        return res
            .status(500)
            .json({ message: "Failed to process the login request" });
    }
}));
// User API to get all users (excluding passwords)
app.get("/users", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const users = yield user_1.default.find().select("-password");
        return res.status(200).json({ success: true, users });
    }
    catch (error) {
        return res.status(500).json({ message: "Failed to fetch users" });
    }
}));
// User API to get user data by ID
app.get("/user/:id", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const user = yield user_1.default.findById(req.params.id).select("-password");
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        return res.status(200).json({ success: true, user });
    }
    catch (error) {
        return res.status(500).json({ message: "Failed to fetch user data" });
    }
}));
// Route to update profile picture URL (after S3 upload)
app.put("/user/profile-pic", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId, profilePicUrl } = req.body;
    if (!userId || !profilePicUrl) {
        return res.status(400).json({ error: "Missing userId or profilePicUrl" });
    }
    try {
        const user = yield user_1.default.findById(userId);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        user.profilePicUrl = profilePicUrl;
        yield user.save();
        return res
            .status(200)
            .json({ success: true, message: "Profile picture updated successfully" });
    }
    catch (error) {
        return res.status(500).json({ error: "Failed to update profile picture" });
    }
}));
// Legacy: bulk update roster (not recommended for add/remove single player)
app.put("/events/:id/roster", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const eventId = req.params.id;
    const { roster } = req.body;
    try {
        const event = yield event_1.default.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }
        event.roster = roster;
        event.rosterSpotsFilled = roster.length;
        yield event.save();
        return res.status(200).json({ success: true, roster: event.roster });
    }
    catch (error) {
        console.error("Error updating event roster:", error);
        return res.status(500).json({ message: "Error updating event roster" });
    }
}));
// ==================== COMMUNITY NOTES ENDPOINTS ====================
// Get all posts
app.get("/community-notes", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const posts = yield communityNote_1.default.find();
        res.status(200).json(posts);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to fetch posts." });
    }
}));
// Create a new post
app.post("/community-notes", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { text, userId, username } = req.body;
        if (!text || !userId || !username) {
            return res.status(400).json({ message: "Missing required fields." });
        }
        const newPost = yield communityNote_1.default.create({
            text,
            userId,
            username,
            comments: [],
        });
        res.status(201).json(newPost);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to create post." });
    }
}));
// Edit a post
app.put("/community-notes/:postId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { text } = req.body;
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        post.text = text || post.text;
        yield post.save();
        res.status(200).json({ text: post.text });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to edit post." });
    }
}));
// Delete a post
app.delete("/community-notes/:postId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const post = yield communityNote_1.default.findByIdAndDelete(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        res.sendStatus(204);
    }
    catch (error) {
        res.status(500).json({ message: "Failed to delete post." });
    }
}));
// Add a comment to a post
app.post("/community-notes/:postId/comments", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { text, userId, username } = req.body;
        if (!text || !userId || !username) {
            return res.status(400).json({ message: "Missing required fields." });
        }
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        const comment = {
            text,
            userId,
            username,
            replies: [],
        };
        post.comments.push(comment);
        yield post.save();
        res.status(201).json({ comments: post.comments });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to add comment." });
    }
}));
// Edit a comment
app.put("/community-notes/:postId/comments/:commentId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { text } = req.body;
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        const comment = post.comments.id(req.params.commentId);
        if (!comment)
            return res.status(404).json({ message: "Comment not found." });
        comment.text = text || comment.text;
        yield post.save();
        res.status(200).json({ text: comment.text });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to edit comment." });
    }
}));
// Delete a comment
app.delete("/community-notes/:postId/comments/:commentId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        const comment = post.comments.id(req.params.commentId);
        if (!comment)
            return res.status(404).json({ message: "Comment not found." });
        comment.remove();
        yield post.save();
        res.status(200).json({ comments: post.comments });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to delete comment." });
    }
}));
// Add a reply to a comment
app.post("/community-notes/:postId/comments/:commentId/replies", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { text, userId, username } = req.body;
        if (!text || !userId || !username) {
            return res.status(400).json({ message: "Missing required fields." });
        }
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        const comment = post.comments.id(req.params.commentId);
        if (!comment)
            return res.status(404).json({ message: "Comment not found." });
        comment.replies.push({ text, userId, username });
        yield post.save();
        res.status(201).json({ replies: comment.replies });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to add reply." });
    }
}));
// Edit a reply
app.put("/community-notes/:postId/comments/:commentId/replies/:replyId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { text } = req.body;
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        const comment = post.comments.id(req.params.commentId);
        if (!comment)
            return res.status(404).json({ message: "Comment not found." });
        const reply = comment.replies.id(req.params.replyId);
        if (!reply)
            return res.status(404).json({ message: "Reply not found." });
        reply.text = text || reply.text;
        yield post.save();
        res.status(200).json({ text: reply.text });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to edit reply." });
    }
}));
// Delete a reply
app.delete("/community-notes/:postId/comments/:commentId/replies/:replyId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const post = yield communityNote_1.default.findById(req.params.postId);
        if (!post)
            return res.status(404).json({ message: "Post not found." });
        const comment = post.comments.id(req.params.commentId);
        if (!comment)
            return res.status(404).json({ message: "Comment not found." });
        const reply = comment.replies.id(req.params.replyId);
        if (!reply)
            return res.status(404).json({ message: "Reply not found." });
        reply.remove();
        yield post.save();
        res.status(200).json({ replies: comment.replies });
    }
    catch (error) {
        res.status(500).json({ message: "Failed to delete reply." });
    }
}));
// ==================== END COMMUNITY NOTES ENDPOINTS ====================
// Declare The PORT
const PORT = process.env.PORT || 8001;
app.listen(PORT, () => __awaiter(void 0, void 0, void 0, function* () {
    console.log(`🗄️ Server Fire on http://localhost:${PORT}`);
    // Connect to Database
    try {
        const DATABASE_URL = process.env.MONGODB_URI || "mongodb://localhost:27017/OMHL";
        yield mongoose_1.default.connect(DATABASE_URL);
        console.log("🛢️ Connected To Database");
    }
    catch (error) {
        console.log("⚠️ Error connecting to the database:", error);
        process.exit(1);
    }
}));
