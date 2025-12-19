// models/communityNote.js or .ts
const mongoose = require("mongoose");
const { Schema } = mongoose;

const ReplySchema = new Schema(
  {
    text: String,
    username: String,
    userId: String,
    profilePicUrl: String,
    likes: [{ type: String }], // Array of userIds who liked
  },
  { timestamps: true }
);

const CommentSchema = new Schema(
  {
    text: String,
    username: String,
    userId: String,
    profilePicUrl: String,
    replies: [ReplySchema],
    likes: [{ type: String }], // Array of userIds who liked
  },
  { timestamps: true }
);

const CommunityNoteSchema = new Schema(
  {
    text: String,
    userId: String,
    username: String,
    profilePicUrl: String,
    comments: [CommentSchema],
    likes: [{ type: String }], // Array of userIds who liked
  },
  { timestamps: true }
);

export default mongoose.model("CommunityNote", CommunityNoteSchema);
