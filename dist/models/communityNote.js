"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const commentSchema = new mongoose_1.default.Schema({
    text: String,
    username: String,
    userId: String,
    createdAt: { type: Date, default: Date.now },
});
const postSchema = new mongoose_1.default.Schema({
    text: String,
    userId: String,
    username: String,
    comments: [commentSchema],
    createdAt: { type: Date, default: Date.now },
});
exports.default = mongoose_1.default.model("CommunityNote", postSchema);
