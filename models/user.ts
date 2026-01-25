import mongoose, { Document, Schema } from "mongoose";

export interface IUser extends Document {
  name: string;
  email: string;
  username: string;
  password: string;
  profilePicUrl: string;
  tokenVersion: number;
  isAdmin: boolean;
  favoriteSports: string[];
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
    favoriteSports: { type: [String], default: [] }, // User's favorite sports
  },
  { timestamps: true },
);

const User = mongoose.model<IUser>("Users", UserSchema);

export default User;
