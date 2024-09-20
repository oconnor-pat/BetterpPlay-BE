import mongoose, { Document, Schema } from "mongoose";

export interface IUser extends Document {
  name: string;
  email: string;
  username: string;
  password: string;
  profilePicUrl: string;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    username: { type: String, required: true },
    password: { type: String, required: true },
    profilePicUrl: { type: String }, // URL of the user's profile picture stored in S3
  },
  { timestamps: true }
);

const User = mongoose.model<IUser>("Users", UserSchema);

export default User;
