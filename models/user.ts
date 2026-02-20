import mongoose, { Document, Schema } from "mongoose";

export interface IUser extends Document {
  name: string;
  email: string;
  username: string;
  password: string;
  profilePicUrl: string;
  tokenVersion: number;
  isAdmin: boolean;
  favoriteActivities: string[];
  friends: mongoose.Types.ObjectId[];
  friendRequestsSent: mongoose.Types.ObjectId[];
  friendRequestsReceived: mongoose.Types.ObjectId[];
  location?: {
    type: "Point";
    coordinates: [number, number];
  } | null;
  proximityVisibility: "public" | "friends" | "private";
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    profilePicUrl: { type: String }, // URL of the user's profile picture stored in S3
    tokenVersion: { type: Number, default: 0 }, // Increment to invalidate all tokens
    isAdmin: { type: Boolean, default: false }, // Admin flag for venue management
    favoriteActivities: { type: [String], default: [] }, // User's favorite activities
    friends: [{ type: Schema.Types.ObjectId, ref: "Users", default: [] }],
    friendRequestsSent: [
      { type: Schema.Types.ObjectId, ref: "Users", default: [] },
    ],
    friendRequestsReceived: [
      { type: Schema.Types.ObjectId, ref: "Users", default: [] },
    ],
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number] },
    },
    proximityVisibility: {
      type: String,
      enum: ["public", "friends", "private"],
      default: "private",
    },
  },
  { timestamps: true },
);

UserSchema.index({ location: "2dsphere" });

const User = mongoose.model<IUser>("Users", UserSchema);

export default User;
