import mongoose, { Document, Schema } from "mongoose";

/**
 * One rating per (event, rater). Roster participants rate the event and its
 * host (createdBy) after the event has ended. Creators cannot rate themselves.
 */
export interface IEventRating extends Document {
  eventId: mongoose.Types.ObjectId;
  raterId: string;
  hostId: string;
  eventScore: number;
  hostScore: number;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EventRatingSchema: Schema = new Schema(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    raterId: { type: String, required: true, index: true },
    hostId: { type: String, required: true, index: true },
    eventScore: { type: Number, required: true, min: 1, max: 5 },
    hostScore: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, maxlength: 500, trim: true },
  },
  { timestamps: true },
);

EventRatingSchema.index({ eventId: 1, raterId: 1 }, { unique: true });
EventRatingSchema.index({ hostId: 1, createdAt: -1 });

const EventRating = mongoose.model<IEventRating>(
  "EventRating",
  EventRatingSchema,
);

export default EventRating;
