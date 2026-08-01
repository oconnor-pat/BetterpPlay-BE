/**
 * One-time migration: fold the legacy `likes` array into `reactions`.
 *
 * Every userId in `likes` becomes a "❤️" reaction, which is what the like
 * button turned into. Safe to re-run — an event that already has a reaction
 * from a given user is left alone, so re-running won't duplicate or clobber
 * reactions people have changed since the first pass.
 *
 * Usage: npm run migrate:reactions
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import Event from "../models/event";

dotenv.config();

const LIKE_EMOJI = "❤️";

const run = async () => {
  const DATABASE_URL =
    process.env.MONGODB_URI || "mongodb://localhost:27017/OMHL";

  await mongoose.connect(DATABASE_URL);
  console.log(`Connected to ${DATABASE_URL.replace(/\/\/.*@/, "//***@")}`);

  const events = await Event.find({
    likes: { $exists: true, $not: { $size: 0 } },
  });

  console.log(`Found ${events.length} event(s) with likes.`);

  let updated = 0;
  let reactionsAdded = 0;

  for (const event of events) {
    const existing = (event as any).reactions || [];
    const alreadyReacted = new Set(
      existing.map((r: any) => String(r.userId)),
    );

    const toAdd = (event.likes || [])
      .map((id: string) => String(id))
      .filter((id: string) => !alreadyReacted.has(id))
      .map((id: string) => ({
        userId: id,
        emoji: LIKE_EMOJI,
        reactedAt: new Date(),
      }));

    if (toAdd.length === 0) {
      continue;
    }

    (event as any).reactions = [...existing, ...toAdd];
    await event.save();

    updated += 1;
    reactionsAdded += toAdd.length;
    console.log(`  ${event._id}: +${toAdd.length} reaction(s)`);
  }

  console.log(
    `\nDone. Updated ${updated} event(s), added ${reactionsAdded} reaction(s).`,
  );

  await mongoose.disconnect();
};

run().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
