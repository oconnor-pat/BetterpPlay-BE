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

export interface IWaitlistEntry {
  userId: string;
  username: string;
  profilePicUrl?: string;
  joinedAt: Date;
}

const WaitlistEntrySchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    profilePicUrl: { type: String, required: false },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export interface ISpotReservation {
  userId: string;
  username: string;
  profilePicUrl?: string;
  expiresAt: Date;
}

const SpotReservationSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    profilePicUrl: { type: String, required: false },
    expiresAt: { type: Date, required: true },
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
  createdByUsername?: string;
  roster: IParticipant[];
  waitlist: IWaitlistEntry[];
  spotReservation?: ISpotReservation | null;
  latitude?: number;
  longitude?: number;
  jerseyColors?: string[];
  likes: string[];
  privacy: "public" | "private" | "invite-only";
  invitedUsers: string[];
  isRecurring?: boolean;
  recurrenceGroupId?: string;
  recurrenceFrequency?: "weekly" | "biweekly" | "monthly";
  // Optional reference to a venue listing the event was planned from. The
  // venue itself isn't stored in our DB — venueId is a Google Place ID.
  // venueName is cached so we can render a "Happening at X" badge without
  // re-fetching Place Details for every event card.
  venueId?: string;
  venueName?: string;
  // The URL the user was looking at when they tapped "Plan event from this
  // page" (e.g. the venue's official site, an Instagram post, an Eventbrite
  // listing). Surfaced as a "View source" link on the event detail.
  sourceUrl?: string;
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
    waitlist: { type: [WaitlistEntrySchema], default: [] },
    spotReservation: { type: SpotReservationSchema, default: null },
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
    isRecurring: { type: Boolean, default: false },
    recurrenceGroupId: { type: String, default: null },
    recurrenceFrequency: {
      type: String,
      enum: ["weekly", "biweekly", "monthly", null],
      default: null,
    },
    // Venue listing reference (Google Place ID + cached display fields).
    // Indexed because the venue detail page queries by venueId.
    venueId: { type: String, required: false, index: true },
    venueName: { type: String, required: false },
    sourceUrl: { type: String, required: false },
  },
  { timestamps: true },
);

const Event = mongoose.model<IEvent>("Event", EventSchema);

export default Event;
