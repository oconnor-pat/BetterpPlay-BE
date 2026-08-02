import mongoose, { Document, Schema } from "mongoose";

// A 1-to-1 direct message thread between two users.
//
// Anyone can message anyone — that's a requirement for the "public event
// as an LFG post" flow, where you need to reach a stranger who posted a
// pickup game. To keep that from being a spam vector, a thread opened by
// someone you aren't friends with starts as a *request*: it lands in the
// recipient's Requests inbox rather than their real one, and the sender
// gets exactly one push for it. The recipient reads who it's from and
// what they said before deciding.
//
//   pending  — awaiting the recipient's decision. Visible to them only
//              under Requests. The initiator can send, but every send
//              after the first is silent.
//   accepted — a normal thread for both sides. Threads between existing
//              friends are created accepted, skipping the request step.
//   declined — the recipient said no. The thread is hidden from them and
//              the initiator can no longer send to it. Effectively a
//              per-conversation block, which covers the safety need
//              without a full block list.
//
// `participants` is always sorted, and `participantKey` is the sorted
// pair joined — a unique index on it is what guarantees one thread per
// pair no matter which side opens it first (or if both do at once).

export type ConversationStatus = "pending" | "accepted" | "declined";

// `clearedAt` is a per-participant delete. Threads are shared, so one
// person removing one can't destroy the other's copy — instead we record
// when they cleared it and hide everything up to that point from them
// alone. If the other person writes again the thread comes back, showing
// only what's new, which is how deleting a conversation behaves
// everywhere else people expect it to.
export interface IConversationReadState {
  userId: string;
  lastReadAt: Date;
  clearedAt?: Date;
}

// Denormalized preview for the inbox list. Unlike groups (which compute
// this with an aggregation over the member's whole group set), a DM
// inbox is a flat list of two-person threads, so storing the preview on
// the thread makes the list a single indexed find with no join.
export interface IConversationLastMessage {
  text: string;
  senderId: string;
  hasImage?: boolean;
  deleted?: boolean;
  createdAt: Date;
}

export interface IConversation extends Document {
  participants: string[];
  participantKey: string;
  status: ConversationStatus;
  requestedBy: string;
  readState: IConversationReadState[];
  lastMessageAt?: Date;
  lastMessage?: IConversationLastMessage;
  createdAt: Date;
  updatedAt: Date;
}

const ReadStateSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    lastReadAt: { type: Date, default: Date.now },
    clearedAt: { type: Date },
  },
  { _id: false },
);

const LastMessageSchema: Schema = new Schema(
  {
    text: { type: String, default: "" },
    senderId: { type: String, required: true },
    hasImage: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const ConversationSchema: Schema = new Schema(
  {
    participants: {
      type: [String],
      required: true,
      validate: {
        validator: (v: string[]) => Array.isArray(v) && v.length === 2,
        message: "A conversation must have exactly two participants",
      },
    },
    participantKey: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "pending",
    },
    requestedBy: { type: String, required: true },
    readState: { type: [ReadStateSchema], default: [] },
    lastMessageAt: { type: Date },
    lastMessage: { type: LastMessageSchema, required: false },
  },
  { timestamps: true },
);

// Inbox query: "my threads, most recently active first". The multikey
// index on participants serves both the accepted inbox and the pending
// requests list, which differ only by a status filter.
ConversationSchema.index({ participants: 1, lastMessageAt: -1 });

// Stable key for a pair of userIds regardless of who initiated. Callers
// use this for the find-or-create upsert on the way into a thread.
export const buildParticipantKey = (a: string, b: string): string =>
  [String(a), String(b)].sort().join("_");

const Conversation = mongoose.model<IConversation>(
  "Conversation",
  ConversationSchema,
);

export default Conversation;
