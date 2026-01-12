import mongoose, { Document, Schema } from "mongoose";

export interface IBooking extends Document {
  venueId: mongoose.Types.ObjectId;
  spaceId: string; // Maps to subVenue id
  spaceName: string;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  eventName: string; // Name of the event booked for this slot
  date: string; // Format: YYYY-MM-DD
  startTime: string; // Format: HH:MM (24hr)
  endTime: string; // Format: HH:MM (24hr)
  status: "pending" | "confirmed" | "cancelled";
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BookingSchema: Schema = new Schema(
  {
    venueId: { type: Schema.Types.ObjectId, ref: "Venue", required: true },
    spaceId: { type: String, required: true },
    spaceName: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "Users", required: true },
    userName: { type: String, required: true },
    userEmail: { type: String, required: true },
    eventName: { type: String, required: true }, // Name of the event
    date: { type: String, required: true }, // YYYY-MM-DD
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true }, // HH:MM
    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled"],
      default: "pending",
    },
    notes: { type: String, required: false },
  },
  { timestamps: true }
);

// Compound index to prevent double bookings
BookingSchema.index(
  { venueId: 1, spaceId: 1, date: 1, startTime: 1 },
  { unique: true }
);

// Index for querying by user
BookingSchema.index({ userId: 1 });

// Index for querying by venue and date
BookingSchema.index({ venueId: 1, date: 1 });

const Booking = mongoose.model<IBooking>("Booking", BookingSchema);

export default Booking;
