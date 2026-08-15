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

// RSVP responses that are NOT "going". "Going" is represented by presence on
// the roster (which owns spot counts, jersey, paid status), so this array
// only holds the "maybe" and "can't make it" replies. A user is in exactly
// one place: on the roster (going) OR here (maybe/cant) OR neither (no reply).
export type RsvpStatus = "maybe" | "cant";

export interface IRsvp {
  userId: string;
  username: string;
  profilePicUrl?: string;
  status: RsvpStatus;
  respondedAt: Date;
}

const RsvpSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    profilePicUrl: { type: String, required: false },
    status: { type: String, enum: ["maybe", "cant"], required: true },
    respondedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Pending requests to join a public event. Public events are gated: the
// creator approves requests, and only approval (which adds the user to the
// roster) unlocks the event's full details. Holds pending requests only —
// approving removes the entry and adds the user to the roster; denying just
// removes it.
export interface IJoinRequest {
  userId: string;
  username: string;
  profilePicUrl?: string;
  requestedAt: Date;
}

const JoinRequestSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    profilePicUrl: { type: String, required: false },
    requestedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Invitees (or roster members) can ask the creator to invite someone else.
// Creator approve → proposed user is added to invitedUsers; deny drops it.
export interface IGuestAddRequest {
  requestedBy: string;
  requestedByUsername: string;
  proposedUserId: string;
  proposedUsername: string;
  proposedProfilePicUrl?: string;
  requestedAt: Date;
}

const GuestAddRequestSchema: Schema = new Schema(
  {
    requestedBy: { type: String, required: true },
    requestedByUsername: { type: String, required: true },
    proposedUserId: { type: String, required: true },
    proposedUsername: { type: String, required: true },
    proposedProfilePicUrl: { type: String, required: false },
    requestedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Quick-access reactions shown before the user opens the full emoji picker.
// This is a convenience shortlist, not a whitelist — any emoji is accepted.
// "❤️" leads because it's what the old like button became, so migrated likes
// keep their meaning.
export const QUICK_REACTION_EMOJIS = ["❤️", "🔥", "🎉", "😂", "👀", "👍"];

// A single user's reaction to an event. Discord-style: a user may hold several
// different emoji on the same event, but only one row per (user, emoji) pair.
export interface IReaction {
  userId: string;
  emoji: string;
  reactedAt: Date;
}

const ReactionSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    emoji: { type: String, required: true },
    reactedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export interface IEvent extends Document {
  name: string;
  location: string;
  time: string;
  // How long the event runs, in minutes. Stored as a duration rather than an
  // end-time string because `time` is free-form ("6:30 PM", "18:30", "10:31PM")
  // and deriving an end from it would inherit that ambiguity. Optional: events
  // created before this existed have no known duration, so clients must treat
  // it as unknown rather than assuming a default.
  durationMinutes?: number;
  date: string;
  totalSpots: number;
  rosterSpotsFilled: number;
  eventType: string;
  createdBy: string;
  createdByUsername?: string;
  roster: IParticipant[];
  waitlist: IWaitlistEntry[];
  rsvps: IRsvp[];
  joinRequests: IJoinRequest[];
  guestAddRequests: IGuestAddRequest[];
  spotReservation?: ISpotReservation | null;
  latitude?: number;
  longitude?: number;
  // When true, `location` is a free-text label (e.g. "Friday night gaming")
  // rather than a physical address — no map, no lat/lng.
  isVirtual?: boolean;
  jerseyColors?: string[];
  // Superseded by `reactions` — a like is now a "❤️" reaction. Kept on the
  // model so events written before the migration still read cleanly and so
  // clients older than the reactions release keep working.
  likes: string[];
  reactions: IReaction[];
  privacy: "public" | "private" | "invite-only";
  invitedUsers: string[];
  // Public-event creator controls. `allowJoinRequests` (default true) means
  // strangers must request and wait for approval. When false, anyone can join
  // the roster directly (open join). `showLocationPublicly` (default false)
  // reveals the location/map on the public teaser before they're on the roster.
  allowJoinRequests?: boolean;
  showLocationPublicly?: boolean;
  isRecurring?: boolean;
  recurrenceGroupId?: string;
  recurrenceFrequency?: "weekly" | "biweekly" | "monthly";
  // When true the series has no fixed end; we materialize a rolling
  // horizon of occurrences (see INDEFINITE_RECURRENCE_HORIZON) rather
  // than a user-picked count.
  recurrenceIndefinite?: boolean;
  // Absolute start instant (UTC). Used by the reminder scheduler so wall-clock
  // date+time aren't misread as the server's local timezone (Heroku = UTC).
  startsAt?: Date;
  // Creator's `Date.getTimezoneOffset()` at write time — minutes to add to
  // local wall clock to reach UTC. Lets us recompute startsAt if date/time
  // change without a fresh client ISO.
  timezoneOffsetMinutes?: number;
  // Optional reference to a venue listing the event was planned from. The
  // venue itself isn't stored in our DB — venueId is a Google Place ID.
  // venueName is cached so we can render a "Happening at X" badge without
  // re-fetching Place Details for every event card.
  venueId?: string;
  venueName?: string;
  // Optional reference to a Group used as the invite list at creation
  // time. For one-off events this is metadata about origin only — the
  // actual roster lives in `invitedUsers`, which is seeded from the
  // Group's members but freely editable thereafter. For recurring
  // events (PR 3) the link stays live: each new instance re-pulls the
  // Group's current member list, so adding someone to the trivia crew
  // means they're on next Tuesday automatically.
  // `groupName` is cached for display so we can render the "via [Group]"
  // badge without a second DB hit per event card (same pattern as
  // venueName).
  groupId?: string;
  groupName?: string;
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
    durationMinutes: { type: Number, min: 5, max: 24 * 60 },
    date: { type: String, required: true },
    startsAt: { type: Date, required: false, index: true },
    timezoneOffsetMinutes: { type: Number, required: false },
    totalSpots: { type: Number, required: true },
    rosterSpotsFilled: { type: Number, default: 0 },
    eventType: { type: String, required: true },
    createdBy: { type: String, required: true },
    createdByUsername: { type: String }, // <-- Added field
    roster: { type: [ParticipantSchema], default: [] },
    waitlist: { type: [WaitlistEntrySchema], default: [] },
    rsvps: { type: [RsvpSchema], default: [] },
    joinRequests: { type: [JoinRequestSchema], default: [] },
    guestAddRequests: { type: [GuestAddRequestSchema], default: [] },
    spotReservation: { type: SpotReservationSchema, default: null },
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
    isVirtual: { type: Boolean, default: false },
    jerseyColors: { type: [String], default: [] }, // Team colors (for sports events)
    likes: { type: [String], default: [] }, // Deprecated: mirrors "❤️" reactions
    reactions: { type: [ReactionSchema], default: [] },
    privacy: {
      type: String,
      enum: ["public", "private", "invite-only"],
      default: "public",
    }, // Event visibility
    invitedUsers: { type: [String], default: [] }, // Array of userIds invited
    allowJoinRequests: { type: Boolean, default: true },
    showLocationPublicly: { type: Boolean, default: false },
    isRecurring: { type: Boolean, default: false },
    recurrenceGroupId: { type: String, default: null },
    recurrenceFrequency: {
      type: String,
      enum: ["weekly", "biweekly", "monthly", null],
      default: null,
    },
    recurrenceIndefinite: { type: Boolean, default: false },
    // Venue listing reference (Google Place ID + cached display fields).
    // Indexed because the venue detail page queries by venueId.
    venueId: { type: String, required: false, index: true },
    venueName: { type: String, required: false },
    // Group reference (Mongo _id) + cached display name. Indexed so we
    // can look up "all events created from group X" cheaply, which PR 3
    // and any future "this group's events" view will need.
    groupId: { type: String, required: false, index: true },
    groupName: { type: String, required: false },
    sourceUrl: { type: String, required: false },
  },
  { timestamps: true },
);

const Event = mongoose.model<IEvent>("Event", EventSchema);

export default Event;
