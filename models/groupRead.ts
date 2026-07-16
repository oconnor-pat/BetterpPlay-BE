import mongoose, { Document, Schema } from "mongoose";

// Per-user read state for a group's chat. We track a single `lastReadAt`
// timestamp per (group, user) rather than per-message read receipts —
// unread count is then "messages in this group newer than lastReadAt,
// authored by someone else." Cheap to write (one upsert when the user
// opens the chat) and cheap to read (a bounded count query).
//
// Absence of a row means the user has never opened the chat; treat that
// as "everything is unread since they joined" on the read path.

export interface IGroupRead extends Document {
  groupId: string;
  userId: string;
  lastReadAt: Date;
}

const GroupReadSchema: Schema = new Schema(
  {
    groupId: { type: String, required: true },
    userId: { type: String, required: true },
    lastReadAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One read-state row per (group, user); the unread computation and the
// mark-read upsert both key on this pair.
GroupReadSchema.index({ groupId: 1, userId: 1 }, { unique: true });

const GroupRead = mongoose.model<IGroupRead>("GroupRead", GroupReadSchema);

export default GroupRead;
