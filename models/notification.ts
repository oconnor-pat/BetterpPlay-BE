import mongoose, { Document, Schema } from "mongoose";

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  title: string;
  body: string;
  type:
    | "friend_request"
    | "friend_accepted"
    | "event_roster"
    | "event_update"
    | "event_reminder"
    | "community_note"
    | "general";
  data?: Record<string, any>;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema: Schema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: [
        "friend_request",
        "friend_accepted",
        "event_roster",
        "event_update",
        "event_reminder",
        "community_note",
        "general",
      ],
      required: true,
    },
    data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Index for fetching user's notifications sorted by date
NotificationSchema.index({ userId: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>(
  "Notification",
  NotificationSchema,
);

export default Notification;
