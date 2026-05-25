import mongoose, { Document, Schema } from "mongoose";

export interface INotificationPreferences extends Document {
  userId: mongoose.Types.ObjectId;
  friendRequests: boolean;
  friendRequestAccepted: boolean;
  eventUpdates: boolean;
  eventRoster: boolean;
  eventReminders: boolean;
  eventActivity: boolean;
  communityNotes: boolean;
  // Group activity preferences. Three buckets for granular muting:
  //   - groupAdded: "{X} added you to {Group}"
  //   - groupRoleChanged: promoted to admin, ownership transferred to you
  //   - groupEvents: a new event was scheduled in a group you're in
  // Splitting them lets users keep the high-signal "you're now in this
  // group / now an admin" pings while muting the chattier event-creation
  // stream from groups they're passively in.
  groupAdded: boolean;
  groupRoleChanged: boolean;
  groupEvents: boolean;
  pushEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationPreferencesSchema: Schema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      unique: true,
      index: true,
    },
    friendRequests: {
      type: Boolean,
      default: true,
    },
    friendRequestAccepted: {
      type: Boolean,
      default: true,
    },
    eventUpdates: {
      type: Boolean,
      default: true,
    },
    eventRoster: {
      type: Boolean,
      default: true,
    },
    eventReminders: {
      type: Boolean,
      default: true,
    },
    eventActivity: {
      type: Boolean,
      default: true,
    },
    communityNotes: {
      type: Boolean,
      default: true,
    },
    groupAdded: {
      type: Boolean,
      default: true,
    },
    groupRoleChanged: {
      type: Boolean,
      default: true,
    },
    groupEvents: {
      type: Boolean,
      default: true,
    },
    pushEnabled: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

const NotificationPreferences = mongoose.model<INotificationPreferences>(
  "NotificationPreferences",
  NotificationPreferencesSchema,
);

export default NotificationPreferences;
