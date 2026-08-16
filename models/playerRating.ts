import mongoose, { Document, Schema } from "mongoose";

/**
 * Peer "player" rating — independent of hosting. One rating per
 * (rater, ratee) pair; re-submitting updates the score.
 * Rater must have shared at least one event roster with the ratee.
 */
export interface IPlayerRating extends Document {
  raterId: string;
  rateeId: string;
  score: number;
  comment?: string;
  /** Optional event context when rated from a roster. */
  eventId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlayerRatingSchema: Schema = new Schema(
  {
    raterId: { type: String, required: true, index: true },
    rateeId: { type: String, required: true, index: true },
    score: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, maxlength: 500, trim: true },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: false,
      default: null,
    },
  },
  { timestamps: true },
);

PlayerRatingSchema.index({ raterId: 1, rateeId: 1 }, { unique: true });
PlayerRatingSchema.index({ rateeId: 1, createdAt: -1 });

const PlayerRating = mongoose.model<IPlayerRating>(
  "PlayerRating",
  PlayerRatingSchema,
);

export default PlayerRating;
