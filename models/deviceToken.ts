import mongoose, { Document, Schema } from "mongoose";

export interface IDeviceToken extends Document {
  userId: mongoose.Types.ObjectId;
  deviceToken: string;
  platform: "ios" | "android" | "web";
  createdAt: Date;
  updatedAt: Date;
}

const DeviceTokenSchema: Schema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    deviceToken: {
      type: String,
      required: true,
      unique: true,
    },
    platform: {
      type: String,
      enum: ["ios", "android", "web"],
      required: true,
    },
  },
  { timestamps: true },
);

// Compound index for efficient lookups
DeviceTokenSchema.index({ userId: 1, deviceToken: 1 });

const DeviceToken = mongoose.model<IDeviceToken>(
  "DeviceToken",
  DeviceTokenSchema,
);

export default DeviceToken;
