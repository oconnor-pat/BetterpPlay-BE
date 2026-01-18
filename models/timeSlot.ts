import mongoose, { Document, Schema } from "mongoose";

export interface ITimeSlot extends Document {
  venueId: mongoose.Types.ObjectId;
  spaceId: string; // Maps to subVenue id
  date: string; // Format: YYYY-MM-DD
  startTime: string; // Format: HH:MM (24hr)
  endTime: string; // Format: HH:MM (24hr)
  price: number;
  isCustom: boolean; // true = admin-created, false = auto-generated
  isActive: boolean; // Can be disabled without deleting
  createdBy: mongoose.Types.ObjectId; // Admin who created it
  createdAt: Date;
  updatedAt: Date;
}

const TimeSlotSchema: Schema = new Schema(
  {
    venueId: { type: Schema.Types.ObjectId, ref: "Venue", required: true },
    spaceId: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true }, // HH:MM
    price: { type: Number, required: true, default: 150 },
    isCustom: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Users", required: true },
  },
  { timestamps: true }
);

// Compound index to prevent overlapping slots (same venue, space, date, and time)
TimeSlotSchema.index(
  { venueId: 1, spaceId: 1, date: 1, startTime: 1 },
  { unique: true }
);

// Index for querying by venue and date range
TimeSlotSchema.index({ venueId: 1, spaceId: 1, date: 1 });

// Index for active slots
TimeSlotSchema.index({ isActive: 1 });

const TimeSlot = mongoose.model<ITimeSlot>("TimeSlot", TimeSlotSchema);

export default TimeSlot;
