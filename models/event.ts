import mongoose, { Document, Schema } from "mongoose";

export interface IParticipant {
  username: string;
  paidStatus: string;
  jerseyColor?: string;
  position?: string;
  role?: string; // Generic role for non-sport events (e.g. "host", "volunteer")
  profilePicUrl?: string; // Participant's profile picture URL
  userId?: string; // Participant's user ID for profile navigation
}

const ParticipantSchema: Schema = new Schema(
  {
    username: { type: String, required: true },
    paidStatus: { type: String, required: true },
    jerseyColor: { type: String, required: false },
    position: { type: String, required: false },
    role: { type: String, required: false },
    profilePicUrl: { type: String, required: false },
    userId: { type: String, required: false },
  },
  { _id: false },
);

export interface IEvent extends Document {
  name: string;
  location: string;
  time: string;
  date: string;
  totalSpots: number;
  rosterSpotsFilled: number;
  eventType: string;
  createdBy: string;
  createdByUsername?: string; // <-- Added field
  roster: IParticipant[];
  latitude?: number;
  longitude?: number;
  jerseyColors?: string[]; // Team colors (for sports events)
  likes: string[]; // Array of userIds who liked
  privacy: "public" | "private" | "invite-only"; // Event visibility
  invitedUsers: string[]; // Array of userIds invited (for invite-only events)
}

const EventSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    location: { type: String, required: true },
    time: { type: String, required: true },
    date: { type: String, required: true },
    totalSpots: { type: Number, required: true },
    rosterSpotsFilled: { type: Number, default: 0 },
    eventType: { type: String, required: true },
    createdBy: { type: String, required: true },
    createdByUsername: { type: String }, // <-- Added field
    roster: { type: [ParticipantSchema], default: [] },
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
    jerseyColors: { type: [String], default: [] }, // Team colors (for sports events)
    likes: { type: [String], default: [] }, // Array of userIds who liked
    privacy: {
      type: String,
      enum: ["public", "private", "invite-only"],
      default: "public",
    }, // Event visibility
    invitedUsers: { type: [String], default: [] }, // Array of userIds invited
  },
  { timestamps: true },
);

const Event = mongoose.model<IEvent>("Event", EventSchema);

export default Event;
