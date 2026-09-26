// Venue partner accounts: hand-onboarded businesses that post official
// nights into the main Events feed (`source: "venue"`).
//
// BetterPlay admins assign a Place via /admin/venues/assign. Venue owners
// (and BP admins) invite personal accounts as staff who post *as* the venue.

import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import User from "../models/user";
import { requireAdmin } from "../middleware/auth";
import {
  getPendingVenueInvitesForUser,
  getVenueMembershipsForUser,
} from "../utils/venueAccess";

const router = Router();

const requireUserId = (req: Request, res: Response): string | null => {
  const user = (req as any).user;
  if (!user || !user.id) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }
  return String(user.id);
};

const ensureManagedVenueShape = (venueUser: any) => {
  if (!venueUser.managedVenue) return;
  if (!Array.isArray(venueUser.managedVenue.adminUserIds)) {
    venueUser.managedVenue.adminUserIds = [];
  }
  if (!Array.isArray(venueUser.managedVenue.pendingAdminUserIds)) {
    venueUser.managedVenue.pendingAdminUserIds = [];
  }
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
 * Venues the current user can post as: owned venue account + staff memberships.
 */
router.get("/venues/memberships", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const owned = await User.findById(userId)
      .select("accountType managedVenue username name profilePicUrl")
      .lean();
    const memberships = await getVenueMembershipsForUser(userId);
    const pending = await getPendingVenueInvitesForUser(userId);

    const actingAs: Array<{
      venueUserId: string;
      username: string;
      name: string;
      profilePicUrl?: string;
      managedVenue: any;
      role: "owner" | "admin";
    }> = [];

    if (
      owned &&
      (owned as any).accountType === "venue" &&
      (owned as any).managedVenue?.placeId
    ) {
      actingAs.push({
        venueUserId: String((owned as any)._id),
        username: (owned as any).username,
        name: (owned as any).name,
        profilePicUrl: (owned as any).profilePicUrl,
        managedVenue: (owned as any).managedVenue,
        role: "owner",
      });
    }

    for (const m of memberships) {
      actingAs.push({ ...m, role: "admin" });
    }

    return res.status(200).json({
      actingAs,
      pendingInvites: pending,
    });
  } catch (error) {
    console.error("GET /venues/memberships error:", error);
    return res.status(500).json({ message: "Failed to load memberships" });
  }
});

/** List admins + pending invites for a venue brand account (owner or BP admin). */
router.get("/venues/:venueUserId/admins", async (req: Request, res: Response) => {
  const actorId = requireUserId(req, res);
  if (!actorId) return;

  try {
    const venueUserId = String(req.params.venueUserId);
    const venueUser = await User.findById(venueUserId).select(
      "accountType managedVenue username name isAdmin",
    );
    if (!venueUser || venueUser.accountType !== "venue") {
      return res.status(404).json({ message: "Venue account not found" });
    }

    const actor = await User.findById(actorId).select("isAdmin").lean();
    const isOwner = String(venueUser._id) === actorId;
    const isBpAdmin = !!(actor as any)?.isAdmin;
    if (!isOwner && !isBpAdmin) {
      return res.status(403).json({ message: "Not allowed" });
    }

    ensureManagedVenueShape(venueUser);
    const adminIds = (venueUser.managedVenue?.adminUserIds || []).map(String);
    const pendingIds = (
      venueUser.managedVenue?.pendingAdminUserIds || []
    ).map(String);

    const users = await User.find({
      _id: { $in: [...adminIds, ...pendingIds] },
    })
      .select("username name profilePicUrl")
      .lean();
    const byId = new Map(users.map((u: any) => [String(u._id), u]));

    return res.status(200).json({
      venueUserId,
      venueName: venueUser.managedVenue?.name || venueUser.name,
      admins: adminIds.map((id) => ({
        userId: id,
        username: byId.get(id)?.username,
        name: byId.get(id)?.name,
        profilePicUrl: byId.get(id)?.profilePicUrl,
        status: "active",
      })),
      pending: pendingIds.map((id) => ({
        userId: id,
        username: byId.get(id)?.username,
        name: byId.get(id)?.name,
        profilePicUrl: byId.get(id)?.profilePicUrl,
        status: "pending",
      })),
    });
  } catch (error) {
    console.error("GET /venues/:id/admins error:", error);
    return res.status(500).json({ message: "Failed to list admins" });
  }
});

/**
 * Invite a personal account as venue staff (by username or userId).
 * Owner of the venue account or BP admin.
 */
router.post(
  "/venues/:venueUserId/admins/invite",
  async (req: Request, res: Response) => {
    const actorId = requireUserId(req, res);
    if (!actorId) return;

    try {
      const venueUserId = String(req.params.venueUserId);
      const { username, userId } = req.body || {};

      const venueUser = await User.findById(venueUserId);
      if (!venueUser || venueUser.accountType !== "venue" || !venueUser.managedVenue) {
        return res.status(404).json({ message: "Venue account not found" });
      }

      const actor = await User.findById(actorId).select("isAdmin").lean();
      const isOwner = String(venueUser._id) === actorId;
      const isBpAdmin = !!(actor as any)?.isAdmin;
      if (!isOwner && !isBpAdmin) {
        return res.status(403).json({ message: "Not allowed" });
      }

      const invitee =
        (userId && (await User.findById(String(userId)))) ||
        (username &&
          (await User.findOne({
            username: String(username).trim(),
          })));

      if (!invitee) {
        return res.status(404).json({ message: "User not found" });
      }
      if (String(invitee._id) === String(venueUser._id)) {
        return res.status(400).json({ message: "Cannot invite the venue account itself" });
      }
      if ((invitee as any).accountType === "venue") {
        return res
          .status(400)
          .json({ message: "Invite a personal account, not another venue" });
      }

      ensureManagedVenueShape(venueUser);
      const adminIds = venueUser.managedVenue!.adminUserIds!.map(String);
      const pendingIds = venueUser.managedVenue!.pendingAdminUserIds!.map(String);
      const inviteeId = String(invitee._id);

      if (adminIds.includes(inviteeId)) {
        return res.status(200).json({ message: "Already an admin", status: "active" });
      }
      if (pendingIds.includes(inviteeId)) {
        return res
          .status(200)
          .json({ message: "Invite already pending", status: "pending" });
      }

      venueUser.managedVenue!.pendingAdminUserIds!.push(
        new mongoose.Types.ObjectId(inviteeId),
      );
      venueUser.markModified("managedVenue");
      await venueUser.save();

      return res.status(200).json({
        message: "Invite sent",
        status: "pending",
        user: {
          userId: inviteeId,
          username: invitee.username,
          name: invitee.name,
        },
      });
    } catch (error) {
      console.error("POST invite admin error:", error);
      return res.status(500).json({ message: "Failed to invite admin" });
    }
  },
);

/** Accept a pending venue staff invite. */
router.post(
  "/venues/:venueUserId/admins/accept",
  async (req: Request, res: Response) => {
    const actorId = requireUserId(req, res);
    if (!actorId) return;

    try {
      const venueUserId = String(req.params.venueUserId);
      const venueUser = await User.findById(venueUserId);
      if (!venueUser || venueUser.accountType !== "venue" || !venueUser.managedVenue) {
        return res.status(404).json({ message: "Venue account not found" });
      }

      ensureManagedVenueShape(venueUser);
      const pending = venueUser.managedVenue!.pendingAdminUserIds || [];
      const idx = pending.findIndex((id) => String(id) === actorId);
      if (idx < 0) {
        return res.status(404).json({ message: "No pending invite" });
      }

      pending.splice(idx, 1);
      const admins = venueUser.managedVenue!.adminUserIds || [];
      if (!admins.some((id) => String(id) === actorId)) {
        admins.push(new mongoose.Types.ObjectId(actorId));
      }
      venueUser.managedVenue!.pendingAdminUserIds = pending;
      venueUser.managedVenue!.adminUserIds = admins;
      venueUser.markModified("managedVenue");
      await venueUser.save();

      return res.status(200).json({
        message: "Joined venue staff",
        venueUserId,
        managedVenue: venueUser.managedVenue,
      });
    } catch (error) {
      console.error("POST accept admin error:", error);
      return res.status(500).json({ message: "Failed to accept invite" });
    }
  },
);

/** Decline a pending invite. */
router.post(
  "/venues/:venueUserId/admins/decline",
  async (req: Request, res: Response) => {
    const actorId = requireUserId(req, res);
    if (!actorId) return;

    try {
      const venueUserId = String(req.params.venueUserId);
      const venueUser = await User.findById(venueUserId);
      if (!venueUser?.managedVenue) {
        return res.status(404).json({ message: "Venue account not found" });
      }
      ensureManagedVenueShape(venueUser);
      const pending = venueUser.managedVenue!.pendingAdminUserIds || [];
      venueUser.managedVenue!.pendingAdminUserIds = pending.filter(
        (id) => String(id) !== actorId,
      ) as any;
      venueUser.markModified("managedVenue");
      await venueUser.save();
      return res.status(200).json({ message: "Invite declined" });
    } catch (error) {
      console.error("POST decline admin error:", error);
      return res.status(500).json({ message: "Failed to decline invite" });
    }
  },
);

/** Remove an admin (or cancel pending). Owner / BP admin / self-leave. */
router.delete(
  "/venues/:venueUserId/admins/:memberUserId",
  async (req: Request, res: Response) => {
    const actorId = requireUserId(req, res);
    if (!actorId) return;

    try {
      const venueUserId = String(req.params.venueUserId);
      const memberUserId = String(req.params.memberUserId);
      const venueUser = await User.findById(venueUserId);
      if (!venueUser?.managedVenue || venueUser.accountType !== "venue") {
        return res.status(404).json({ message: "Venue account not found" });
      }

      const actor = await User.findById(actorId).select("isAdmin").lean();
      const isOwner = String(venueUser._id) === actorId;
      const isBpAdmin = !!(actor as any)?.isAdmin;
      const isSelf = memberUserId === actorId;
      if (!isOwner && !isBpAdmin && !isSelf) {
        return res.status(403).json({ message: "Not allowed" });
      }

      ensureManagedVenueShape(venueUser);
      venueUser.managedVenue!.adminUserIds = (
        venueUser.managedVenue!.adminUserIds || []
      ).filter((id) => String(id) !== memberUserId) as any;
      venueUser.managedVenue!.pendingAdminUserIds = (
        venueUser.managedVenue!.pendingAdminUserIds || []
      ).filter((id) => String(id) !== memberUserId) as any;
      venueUser.markModified("managedVenue");
      await venueUser.save();

      return res.status(200).json({ message: "Removed" });
    } catch (error) {
      console.error("DELETE venue admin error:", error);
      return res.status(500).json({ message: "Failed to remove admin" });
    }
  },
);

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

      const existingAdmins = Array.isArray(
        (user.managedVenue as any)?.adminUserIds,
      )
        ? (user.managedVenue as any).adminUserIds
        : [];
      const existingPending = Array.isArray(
        (user.managedVenue as any)?.pendingAdminUserIds,
      )
        ? (user.managedVenue as any).pendingAdminUserIds
        : [];

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
        adminUserIds: existingAdmins,
        pendingAdminUserIds: existingPending,
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
