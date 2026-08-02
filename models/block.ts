import mongoose, { Document, Schema } from "mongoose";

// One row per (blocker, blocked) pair.
//
// A separate collection rather than an array on the user for two
// reasons. Blocking is symmetric in effect — if either side has blocked
// the other, neither should see the other — so every read needs to ask
// "is there a block in *either* direction", which two indexes answer
// cheaply and two synchronised arrays would not. And an array on the
// user document grows unboundedly inside a doc that's loaded on almost
// every request.
export interface IBlock extends Document {
  blockerId: string;
  blockedId: string;
  createdAt: Date;
  updatedAt: Date;
}

const BlockSchema: Schema = new Schema(
  {
    blockerId: { type: String, required: true, index: true },
    blockedId: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

// Blocking someone twice is a no-op, not an error — the unique index
// lets the route upsert without a read-then-write race.
BlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

const Block = mongoose.model<IBlock>("Block", BlockSchema);

export default Block;
