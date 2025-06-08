import mongoose from "mongoose";

const commentSchema = new mongoose.Schema({
  text: String,
  username: String,
  userId: String,
  createdAt: { type: Date, default: Date.now },
});

const postSchema = new mongoose.Schema({
  text: String,
  userId: String,
  username: String,
  comments: [commentSchema],
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("CommunityNote", postSchema);
