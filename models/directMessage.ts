import mongoose, { Document, Schema } from "mongoose";

// A single message inside a 1-to-1 conversation. Deliberately shaped the
// same as GroupMessage so the thread UI, pagination cursor, and unread
// math can be shared rather than reinvented.
//
// The attachment, reaction, and soft-delete fields are carried here from
// the start even though the first pass of the DM UI only sends text —
// they cost nothing empty, and having them present means adding photo
// and reaction parity later is a route-and-UI change with no migration.
//
// Sender display fields are snapshotted at send time, matching group
// chat: a chat log is a historical record of who someone was when they
// spoke, so it isn't rehydrated on read.

export interface IDirectMessageReaction {
  userId: string;
  emoji: string;
  reactedAt: Date;
}

export interface IDirectMessage extends Document {
  conversationId: string;
  senderId: string;
  username?: string;
  profilePicUrl?: string;
  text: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  reactions: IDirectMessageReaction[];
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReactionSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    emoji: { type: String, required: true },
    reactedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const DirectMessageSchema: Schema = new Schema(
  {
    conversationId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    username: { type: String },
    profilePicUrl: { type: String },
    text: { type: String, trim: true, maxlength: 2000, default: "" },
    imageUrl: { type: String },
    imageWidth: { type: Number },
    imageHeight: { type: Number },
    reactions: { type: [ReactionSchema], default: [] },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

// Serves both the newest-first thread read with a createdAt cursor and
// the unread count (createdAt > lastReadAt).
DirectMessageSchema.index({ conversationId: 1, createdAt: -1 });

const DirectMessage = mongoose.model<IDirectMessage>(
  "DirectMessage",
  DirectMessageSchema,
);

export default DirectMessage;
