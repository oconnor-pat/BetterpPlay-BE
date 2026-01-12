import mongoose, { Document, Schema } from "mongoose";

export interface IInquiry extends Document {
  venueId: mongoose.Types.ObjectId;
  spaceId: string;
  spaceName: string;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  userPhone?: string;
  preferredDate?: string;
  preferredTime?: string;
  message: string;
  status: "new" | "contacted" | "resolved";
  createdAt: Date;
  updatedAt: Date;
}

const InquirySchema: Schema = new Schema(
  {
    venueId: { type: Schema.Types.ObjectId, ref: "Venue", required: true },
    spaceId: { type: String, required: true },
    spaceName: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "Users", required: true },
    userName: { type: String, required: true },
    userEmail: { type: String, required: true },
    userPhone: { type: String, required: false },
    preferredDate: { type: String, required: false },
    preferredTime: { type: String, required: false },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["new", "contacted", "resolved"],
      default: "new",
    },
  },
  { timestamps: true }
);

// Index for querying by venue
InquirySchema.index({ venueId: 1 });

// Index for querying by user
InquirySchema.index({ userId: 1 });

const Inquiry = mongoose.model<IInquiry>("Inquiry", InquirySchema);

export default Inquiry;
