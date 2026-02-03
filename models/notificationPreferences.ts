import mongoose, { Document, Schema } from "mongoose";

export interface INotificationPreferences extends Document {
  userId: mongoose.Types.ObjectId;
  friendRequests: boolean;
  friendRequestAccepted: boolean;
  eventUpdates: boolean;
  eventRoster: boolean;
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
