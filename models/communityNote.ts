// models/communityNote.js or .ts
const mongoose = require("mongoose");
const { Schema } = mongoose;

// Discord-style reactions — same shape as event / group / DM reactions.
// `likes` stays as a denormalized ❤️ mirror for older clients.
const ReactionSchema = new Schema(
  {
    userId: { type: String, required: true },
    emoji: { type: String, required: true },
    reactedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ReplySchema = new Schema(
  {
    text: String,
    username: String,
    userId: String,
    profilePicUrl: String,
    likes: [{ type: String }], // Array of userIds who liked
    reactions: { type: [ReactionSchema], default: [] },
    // When set, this reply continues someone else's reply in the same comment thread
    replyToUsername: { type: String, default: null },
    replyToReplyId: { type: String, default: null },
  },
  { timestamps: true },
);

const CommentSchema = new Schema(
  {
    text: String,
    username: String,
    userId: String,
    profilePicUrl: String,
    replies: [ReplySchema],
    likes: [{ type: String }], // Array of userIds who liked
    reactions: { type: [ReactionSchema], default: [] },
    // true = nests under the discussion opener; false/absent = own top-level thread
    replyToPost: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const CommunityNoteSchema = new Schema(
  {
    text: String,
    userId: String,
    username: String,
    profilePicUrl: String,
    comments: [CommentSchema],
    likes: [{ type: String }], // Array of userIds who liked
    reactions: { type: [ReactionSchema], default: [] },
    // Event link fields (optional - for posts linked to events)
    eventId: { type: String, default: null },
    eventName: { type: String, default: null },
    eventType: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("CommunityNote", CommunityNoteSchema);
