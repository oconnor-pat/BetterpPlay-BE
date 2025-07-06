"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// models/communityNote.js or .ts
const mongoose = require("mongoose");
const { Schema } = mongoose;
const ReplySchema = new Schema({
    text: String,
    username: String,
    userId: String,
}, { timestamps: true });
const CommentSchema = new Schema({
    text: String,
    username: String,
    userId: String,
    replies: [ReplySchema],
}, { timestamps: true });
const CommunityNoteSchema = new Schema({
    text: String,
    userId: String,
    username: String,
    comments: [CommentSchema],
}, { timestamps: true });
exports.default = mongoose.model("CommunityNote", CommunityNoteSchema);
