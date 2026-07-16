import mongoose, { Document, Schema } from "mongoose";

// A message in a group's dedicated chat thread. Groups are the app's
// "recurring crew" primitive; the chat rounds them out so a group, its
// conversation, and the events it spawns live in one cohesive place.
//
// Two kinds of message:
//   - "text":   a normal member-authored chat message.
//   - "system": app-generated context, e.g. "📅 Trivia Night was
//               scheduled for Tue". System messages can carry an
//               `eventRef` so the FE renders a tappable card that
//               deep-links to the event.
//
// Sender display fields (username / profilePicUrl) are snapshotted at
// send time — standard chat behavior. Unlike the group roster (which we
// hydrate fresh on read so renames look right), a chat log is a
// historical record: it's fine, and cheaper, to show who someone was
// when they spoke.

export type GroupMessageKind = "text" | "system";

export interface IGroupMessageEventRef {
  eventId: string;
  eventName?: string;
  eventDate?: string;
}

export interface IGroupMessage extends Document {
  groupId: string;
  userId: string;
  username?: string;
  profilePicUrl?: string;
  text: string;
  kind: GroupMessageKind;
  eventRef?: IGroupMessageEventRef;
  createdAt: Date;
  updatedAt: Date;
}

const EventRefSchema: Schema = new Schema(
  {
    eventId: { type: String, required: true },
    eventName: { type: String },
    eventDate: { type: String },
  },
  { _id: false },
);

const GroupMessageSchema: Schema = new Schema(
  {
    groupId: { type: String, required: true, index: true },
    // For system messages this is the actor who triggered it (e.g. the
    // event creator). System rows still render without an avatar on the
    // FE, but keeping the userId lets us attribute "X scheduled ...".
    userId: { type: String, required: true },
    username: { type: String },
    profilePicUrl: { type: String },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    kind: { type: String, enum: ["text", "system"], default: "text" },
    eventRef: { type: EventRefSchema, required: false },
  },
  { timestamps: true },
);

// Primary access pattern: fetch a group's messages newest-first with a
// createdAt cursor for pagination. This compound index serves both the
// list query and the unread-count query (createdAt > lastReadAt).
GroupMessageSchema.index({ groupId: 1, createdAt: -1 });

const GroupMessage = mongoose.model<IGroupMessage>(
  "GroupMessage",
  GroupMessageSchema,
);

export default GroupMessage;
