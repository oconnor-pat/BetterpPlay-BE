import express, { Application, Request, Response } from "express";
import { createServer } from "http";
import mongoose from "mongoose";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import cors from "cors";
import socketService from "./services/socketService";
import eventReminderService from "./services/eventReminderService";

import healthRoutes from "./routes/health";
import notificationRoutes from "./routes/notifications";
import eventRoutes from "./routes/events";
import venueRoutes from "./routes/venues";
import bookingRoutes from "./routes/bookings";
import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import friendRoutes from "./routes/friends";
import userEventRoutes from "./routes/userEvents";
import communityNoteRoutes from "./routes/communityNotes";

const app: Application = express();
const httpServer = createServer(app);

app.use(cors());
app.set("trust proxy", 1);

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set. Check your environment variables.");
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

app.use(express.json());
app.use(
  express.urlencoded({
    extended: true,
  }),
);

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

app.use(healthRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/events", eventRoutes);
app.use("/api/venues", venueRoutes);
app.use("/api", bookingRoutes);
app.use(authRoutes);
app.use(userRoutes);
app.use(friendRoutes);
app.use(userEventRoutes);
app.use("/community-notes", communityNoteRoutes);

const PORT = process.env.PORT || 8001;

socketService.initialize(httpServer);

httpServer.listen(PORT, async () => {
  console.log(`🗄️ Server Fire on http://localhost:${PORT}`);

  try {
    const DATABASE_URL =
      process.env.MONGODB_URI || "mongodb://localhost:27017/OMHL";
    await mongoose.connect(DATABASE_URL);
    console.log("🛢️ Connected To Database");

    eventReminderService.startEventReminderScheduler();
  } catch (error) {
    console.log("⚠️ Error connecting to the database:", error);
    process.exit(1);
  }
});
