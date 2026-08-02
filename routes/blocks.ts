// Blocking and unblocking people.
//
// Blocking is reversible and destroys nothing that can't be rebuilt.
// It does sever the live connections between two people — friendship,
// pending friend requests, and any open DM thread — because leaving
// those in place would mean a blocked person still occupied the
// blocker's friends list and inbox. Unblocking restores visibility but
// not the friendship; re-adding is a deliberate act.

import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Block from "../models/block";
import User from "../models/user";
import Conversation from "../models/conversation";
import blockService from "../services/blockService";
import socketService from "../services/socketService";

const router = Router();

const requireUserId = (req: Request, res: Response): string | null => {
  const user = (req as any).user;
  if (!user || !user.id) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }
  return String(user.id);
};

const isValidObjectId = (value: unknown): boolean =>
  typeof value === "string" && mongoose.Types.ObjectId.isValid(value);

// POST /users/:userId/block
router.post("/users/:userId/block", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const targetId = req.params.userId;
  if (!isValidObjectId(targetId)) {
    return res.status(404).json({ message: "User not found" });
  }
  if (String(targetId) === String(userId)) {
    return res.status(400).json({ message: "You can't block yourself" });
  }

  try {
    const target = await User.findById(targetId).select("_id").lean();
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }

    // Upsert so blocking twice is a no-op rather than a duplicate-key
    // error — the client may retry, or fire from two surfaces at once.
    await Block.updateOne(
      { blockerId: String(userId), blockedId: String(targetId) },
      { $setOnInsert: { blockerId: String(userId), blockedId: String(targetId) } },
      { upsert: true },
    );

    // Sever the live connections. Friendship and pending requests are
    // pulled from both sides so neither person is left holding a
    // relationship the other can't see.
    await Promise.all([
      User.findByIdAndUpdate(userId, {
        $pull: {
          friends: targetId,
          friendRequestsSent: targetId,
          friendRequestsReceived: targetId,
        },
      }),
      User.findByIdAndUpdate(targetId, {
        $pull: {
          friends: userId,
          friendRequestsSent: userId,
          friendRequestsReceived: userId,
        },
      }),
    ]);

    // Close any DM thread between them. Reusing the existing `declined`
    // status keeps one code path for "this thread won't take messages"
    // rather than adding a second, near-identical one.
    const conv = await Conversation.findOne({
      participants: { $all: [String(userId), String(targetId)] },
    });
    if (conv && conv.status !== "declined") {
      conv.status = "declined";
      await conv.save();
      socketService.emitToUsers(
        [String(userId), String(targetId)],
        "dm:conversation:updated",
        { conversationId: String(conv._id), status: "declined" },
      );
    }

    // Only the blocker is told. The blocked person gets no event and no
    // notification — being informed you've been blocked is the one piece
    // of information a block is supposed to withhold.
    socketService.emitToUser(userId, "user:blocked", {
      userId: String(targetId),
    });

    return res.status(200).json({ success: true, blocked: true });
  } catch (err) {
    console.error("Failed to block user:", err);
    return res.status(500).json({ message: "Failed to block user" });
  }
});

// DELETE /users/:userId/block — unblock. Restores visibility both ways;
// deliberately does not restore friendship.
router.delete("/users/:userId/block", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const targetId = req.params.userId;
  if (!isValidObjectId(targetId)) {
    return res.status(404).json({ message: "User not found" });
  }

  try {
    await Block.deleteOne({
      blockerId: String(userId),
      blockedId: String(targetId),
    });

    socketService.emitToUser(userId, "user:unblocked", {
      userId: String(targetId),
    });

    return res.status(200).json({ success: true, blocked: false });
  } catch (err) {
    console.error("Failed to unblock user:", err);
    return res.status(500).json({ message: "Failed to unblock user" });
  }
});

// GET /users/me/blocked — the list behind the settings screen. Only
// people *I* blocked; people who blocked me are deliberately absent.
router.get("/users/me/blocked", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const rows = await Block.find({ blockerId: String(userId) })
      .sort({ createdAt: -1 })
      .lean();

    const users = await User.find({
      _id: { $in: blockService.toObjectIds(rows.map((r) => r.blockedId)) },
    })
      .select("username name profilePicUrl")
      .lean();
    const byId = new Map(users.map((u: any) => [String(u._id), u]));

    // Rows whose user no longer exists are dropped rather than rendered
    // as blanks; the block row itself is harmless if left behind.
    const blocked = rows
      .map((r) => {
        const u = byId.get(String(r.blockedId));
        return u
          ? {
              userId: String(r.blockedId),
              username: u.username,
              name: u.name,
              profilePicUrl: u.profilePicUrl,
              blockedAt: r.createdAt,
            }
          : null;
      })
      .filter(Boolean);

    return res.status(200).json({ success: true, blocked });
  } catch (err) {
    console.error("Failed to list blocked users:", err);
    return res.status(500).json({ message: "Failed to load blocked users" });
  }
});

// GET /users/:userId/block-status — drives the profile menu's
// Block/Unblock label. Reports only whether *I* blocked *them*, for the
// same reason the block list is one-directional.
router.get(
  "/users/:userId/block-status",
  async (req: Request, res: Response) => {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const targetId = req.params.userId;
    if (!isValidObjectId(targetId)) {
      return res.status(404).json({ message: "User not found" });
    }

    try {
      const blocked = await blockService.hasBlocked(userId, targetId);
      return res.status(200).json({ success: true, blocked });
    } catch (err) {
      console.error("Failed to fetch block status:", err);
      return res.status(500).json({ message: "Failed to fetch block status" });
    }
  },
);

export default router;
