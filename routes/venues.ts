// Venue partner accounts: hand-onboarded businesses that post official
// nights into the main Events feed (`source: "venue"`).
//
// There is no self-serve claim portal yet — BetterPlay admins assign a
// normal User to a Google Place via /admin/venues/assign.

import { Router, Request, Response } from "express";
import User from "../models/user";
import { requireAdmin } from "../middleware/auth";

const router = Router();

const requireUserId = (req: Request, res: Response): string | null => {
  const user = (req as any).user;
  if (!user || !user.id) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }
  return String(user.id);
};

/** Current user's managed venue (if this is a venue business account). */
router.get("/venues/me", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const user = await User.findById(userId)
      .select("accountType managedVenue name username profilePicUrl")
      .lean();
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({
      accountType: (user as any).accountType || "user",
      managedVenue: (user as any).managedVenue || null,
      name: user.name,
      username: user.username,
      profilePicUrl: (user as any).profilePicUrl,
    });
  } catch (error) {
    console.error("GET /venues/me error:", error);
    return res.status(500).json({ message: "Failed to load venue profile" });
  }
});

/**
 * Hand-onboard a partner: turn an existing user into a venue account linked
 * to a Google Place. Optionally refreshes display name / logo from the body.
 */
router.post(
  "/admin/venues/assign",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const {
        username,
        userId,
        placeId,
        name,
        photoUrl,
        address,
        latitude,
        longitude,
        updateProfile = true,
      } = req.body || {};

      if (!placeId || typeof placeId !== "string") {
        return res.status(400).json({ message: "placeId is required" });
      }
      if (!name || typeof name !== "string") {
        return res.status(400).json({ message: "Venue name is required" });
      }

      const user =
        (userId && (await User.findById(String(userId)))) ||
        (username &&
          (await User.findOne({
            username: String(username).trim(),
          })));

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      user.accountType = "venue";
      user.managedVenue = {
        placeId: String(placeId).trim(),
        name: String(name).trim(),
        photoUrl:
          typeof photoUrl === "string" && photoUrl.trim()
            ? photoUrl.trim()
            : undefined,
        address:
          typeof address === "string" && address.trim()
            ? address.trim()
            : undefined,
        latitude:
          typeof latitude === "number" && Number.isFinite(latitude)
            ? latitude
            : undefined,
        longitude:
          typeof longitude === "number" && Number.isFinite(longitude)
            ? longitude
            : undefined,
      };

      if (updateProfile !== false) {
        user.name = String(name).trim();
        if (typeof photoUrl === "string" && photoUrl.trim()) {
          user.profilePicUrl = photoUrl.trim();
        }
      }

      await user.save();

      return res.status(200).json({
        message: "Venue account assigned",
        user: {
          _id: user._id,
          username: user.username,
          name: user.name,
          accountType: user.accountType,
          managedVenue: user.managedVenue,
          profilePicUrl: user.profilePicUrl,
        },
      });
    } catch (error) {
      console.error("POST /admin/venues/assign error:", error);
      return res.status(500).json({ message: "Failed to assign venue account" });
    }
  },
);

/** Revert a venue partner account back to a normal user. */
router.post(
  "/admin/venues/unassign",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { username, userId } = req.body || {};
      const user =
        (userId && (await User.findById(String(userId)))) ||
        (username &&
          (await User.findOne({
            username: String(username).trim(),
          })));

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      user.accountType = "user";
      user.managedVenue = null as any;
      await user.save();

      return res.status(200).json({
        message: "Venue account removed",
        user: {
          _id: user._id,
          username: user.username,
          accountType: user.accountType,
          managedVenue: null,
        },
      });
    } catch (error) {
      console.error("POST /admin/venues/unassign error:", error);
      return res
        .status(500)
        .json({ message: "Failed to unassign venue account" });
    }
  },
);

export default router;
