import mongoose, { Document, Schema } from "mongoose";

/** Google Place a venue-account manager is allowed to post for. */
export interface IManagedVenue {
  placeId: string;
  name: string;
  photoUrl?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

export interface IUser extends Document {
  name: string;
  email: string;
  username: string;
  /** Optional for Apple/Google-only accounts. */
  password?: string;
  appleId?: string;
  googleId?: string;
  authProviders: string[];
  profilePicUrl: string;
  tokenVersion: number;
  isAdmin: boolean;
  /**
   * `venue` accounts post official nights for a claimed Place (managedVenue).
   * Default remains a normal consumer account.
   */
  accountType: "user" | "venue";
  managedVenue?: IManagedVenue | null;
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
    password: { type: String, required: false },
    appleId: { type: String, sparse: true, unique: true },
    googleId: { type: String, sparse: true, unique: true },
    authProviders: { type: [String], default: [] },
    profilePicUrl: { type: String }, // URL of the user's profile picture stored in S3
    tokenVersion: { type: Number, default: 0 }, // Increment to invalidate all tokens
    isAdmin: { type: Boolean, default: false }, // App moderation / partner tooling
    accountType: {
      type: String,
      enum: ["user", "venue"],
      default: "user",
    },
    managedVenue: {
      type: {
        placeId: { type: String, required: true },
        name: { type: String, required: true },
        photoUrl: { type: String, required: false },
        address: { type: String, required: false },
        latitude: { type: Number, required: false },
        longitude: { type: Number, required: false },
      },
      required: false,
      default: null,
    },
    favoriteActivities: { type: [String], default: [] }, // User's favorite activities
    friends: [{ type: Schema.Types.ObjectId, ref: "Users", default: [] }],
    friendRequestsSent: [
      { type: Schema.Types.ObjectId, ref: "Users", default: [] },
    ],
    friendRequestsReceived: [
      { type: Schema.Types.ObjectId, ref: "Users", default: [] },
    ],
    location: {
      type: { type: String, enum: ["Point"] },
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
