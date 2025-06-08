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
    // Return a 200 status if the server is available
    res.sendStatus(200);
});
// Basic welcome route
app.get("/", (req, res) => {
    res.send("Welcome to a better way to play!");
});
// User API to register account
app.post("/auth/register", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Get user data from the request body
        const { name, email, username, password } = req.body;
        // Check if the email or username already exists in the database
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
        return res
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
        user.profilePicUrl = profilePicUrl; // Update the profilePicUrl
        yield user.save();
        return res
            .status(200)
            .json({ success: true, message: "Profile picture updated successfully" });
    }
    catch (error) {
        return res.status(500).json({ error: "Failed to update profile picture" });
    }
}));
// New endpoint to update an event's roster
app.put("/events/:id/roster", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const eventId = req.params.id;
    const { roster } = req.body;
    try {
        const event = yield event_1.default.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }
        // Update the event's roster. Make sure your Event schema defines a "roster" field.
        event.roster = roster;
        yield event.save();
        return res.status(200).json({ success: true, roster: event.roster });
    }
    catch (error) {
        console.error("Error updating event roster:", error);
        return res.status(500).json({ message: "Error updating event roster" });
    }
}));
// Get all posts
app.get("/community-notes", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const notes = yield communityNote_1.default.find();
    res.json(notes);
}));
// Create a post
app.post("/community-notes", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { text, userId, username } = req.body;
    const note = yield communityNote_1.default.create({
        text,
        userId,
        username,
        comments: [],
    });
    res.status(201).json(note);
}));
// Add a comment
app.post("/community-notes/:id/comments", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { text, userId, username } = req.body;
    const note = yield communityNote_1.default.findById(req.params.id);
    if (!note) {
        return res.status(404).json({ message: "Post not found" });
    }
    note.comments.push({ text, userId, username });
    yield note.save();
    res.status(201).json(note);
}));
// Delete a post
app.delete("/community-notes/:id", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    yield communityNote_1.default.findByIdAndDelete(req.params.id);
    res.sendStatus(204);
}));
// Delete a comment
app.delete("/community-notes/:postId/comments/:commentId", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const note = yield communityNote_1.default.findById(req.params.postId);
    if (!note) {
        return res.status(404).json({ message: "Post not found" });
    }
    note.comments.pull({ _id: req.params.commentId });
    yield note.save();
    res.sendStatus(204);
}));
// Declare The PORT
const PORT = process.env.PORT || 8001;
app.get("/", (req, res) => {
    res.send("Welcome to a better way to play!");
});
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
        process.exit(1); // Exit the process
    }
}));
