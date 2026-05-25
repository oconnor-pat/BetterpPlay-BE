import { Router, Request, Response } from "express";
import Group, { IGroup, IGroupMember } from "../models/group";
import User from "../models/user";
import groupEventLink from "../services/groupEventLink";
import notificationService from "../services/notificationService";

const router = Router();

// Helper for notification body wording. Falls back to "Someone" if we
// can't resolve the actor's user record, which keeps the push readable
// instead of saying "undefined added you to..." on edge cases.
const actorDisplayName = async (userId: string): Promise<string> => {
  try {
    const u = await User.findById(userId).select("name username").lean();
    return (u as any)?.name || (u as any)?.username || "Someone";
  } catch {
    return "Someone";
  }
};

// Auth helper — every route in this file requires a logged-in user.
// Returns the userId on success or null after sending a 401 response.
const requireUserId = (req: Request, res: Response): string | null => {
  const user = (req as any).user;
  if (!user || !user.id) {
    res.status(401).json({ message: "Authentication required" });
    return null;
  }
  return String(user.id);
};

// Permission helpers — pulled out so the read paths and the write paths
// agree on what "admin" / "member" / "creator" means.
const isMember = (group: IGroup, userId: string): boolean =>
  (group.members as IGroupMember[]).some(
    (m) => String(m.userId) === String(userId),
  );

const isAdmin = (group: IGroup, userId: string): boolean =>
  (group.members as IGroupMember[]).some(
    (m) => String(m.userId) === String(userId) && m.role === "admin",
  );

const isCreator = (group: IGroup, userId: string): boolean =>
  String(group.createdBy) === String(userId);

// Hydrate the bare member list with display fields (username,
// profilePicUrl, name) from the User collection. We don't store these on
// the Group itself because they can change — pull them fresh on read so
// renamed/repictured users always look right.
const hydrateMembers = async (members: any[]) => {
  if (!members || members.length === 0) {
    return [];
  }
  const userIds = members.map((m) => m.userId);
  const users = await User.find(
    { _id: { $in: userIds } },
    "username name profilePicUrl",
  ).lean();
  const byId = new Map<string, any>(
    users.map((u: any) => [String(u._id), u]),
  );
  return members.map((m: any) => {
    const u = byId.get(String(m.userId));
    return {
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      username: u?.username,
      name: u?.name,
      profilePicUrl: u?.profilePicUrl,
    };
  });
};

const serializeGroup = async (group: IGroup) => {
  const members = await hydrateMembers((group.members as any[]) || []);
  return {
    _id: group._id,
    name: group.name,
    createdBy: group.createdBy,
    privacy: group.privacy,
    members,
    memberCount: members.length,
    createdAt: (group as any).createdAt,
    updatedAt: (group as any).updatedAt,
  };
};

// POST /groups — create a new group. The creator is automatically added
// as the first admin. Initial members (other than the creator) can be
// passed in `memberIds`; they're added with the default `member` role.
router.post("/", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { name, privacy, memberIds } = req.body as {
    name?: string;
    privacy?: "private" | "public";
    memberIds?: string[];
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ message: "Group name is required" });
  }

  const additional = Array.isArray(memberIds)
    ? memberIds
        .filter((id) => typeof id === "string" && id && id !== userId)
        .map((id) => ({ userId: id, role: "member" as const, joinedAt: new Date() }))
    : [];

  // Deduplicate additional members in case the same id was passed twice.
  const seen = new Set<string>();
  const deduped = additional.filter((m) => {
    if (seen.has(m.userId)) return false;
    seen.add(m.userId);
    return true;
  });

  try {
    const group = await Group.create({
      name: name.trim(),
      createdBy: userId,
      privacy: privacy === "public" ? "public" : "private",
      members: [
        { userId, role: "admin", joinedAt: new Date() },
        ...deduped,
      ],
    });

    // Notify each initial member (not the creator) that they were added.
    // Same notification path as `POST /:id/members` so users see the
    // same "Welcome to {Group}" message whether they were added at
    // creation or later.
    if (deduped.length > 0) {
      const actorName = await actorDisplayName(userId);
      notificationService.sendPushNotificationToMany(
        deduped.map((m) => m.userId),
        `Welcome to ${group.name}`,
        `${actorName} added you to the group`,
        "group_added",
        { groupId: String(group._id), groupName: group.name },
      );
    }

    return res.status(201).json({ success: true, group: await serializeGroup(group) });
  } catch (err) {
    console.error("Failed to create group:", err);
    return res.status(500).json({ message: "Failed to create group" });
  }
});

// GET /groups/mine — all groups the current user is a member of, sorted
// by most-recently-updated (so groups they actively engage with surface
// first).
router.get("/mine", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const groups = await Group.find({ "members.userId": userId })
      .sort({ updatedAt: -1 })
      .lean();
    // Hydrate each group's members. For the list view we could skip
    // hydration (just show member count) but keeping it consistent with
    // GET /:id makes the FE simpler — same shape everywhere.
    const serialized = await Promise.all(
      groups.map(async (g: any) => ({
        _id: g._id,
        name: g.name,
        createdBy: g.createdBy,
        privacy: g.privacy,
        members: await hydrateMembers(g.members || []),
        memberCount: (g.members || []).length,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      })),
    );
    return res.status(200).json({ success: true, groups: serialized });
  } catch (err) {
    console.error("Failed to list groups:", err);
    return res.status(500).json({ message: "Failed to list groups" });
  }
});

// GET /groups/:id — single group detail. Members-only by default; public
// groups will be readable by anyone in the future once discovery ships.
router.get("/:id", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }
    const isMember = (group.members as any[]).some(
      (m) => String(m.userId) === userId,
    );
    // Public groups are readable by anyone (forward-compat with v2
    // discovery). Private groups: members only.
    if (group.privacy !== "public" && !isMember) {
      return res.status(403).json({ message: "Not a member of this group" });
    }
    return res.status(200).json({ success: true, group: await serializeGroup(group) });
  } catch (err) {
    console.error("Failed to fetch group:", err);
    return res.status(500).json({ message: "Failed to fetch group" });
  }
});

// DELETE /groups/:id — creator only. PR 4 will add transfer-on-leave;
// for now, only the original creator can delete and the group's recurring
// events (PR 3) lose their live link but otherwise survive.
router.delete("/:id", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }
    if (String(group.createdBy) !== userId) {
      return res
        .status(403)
        .json({ message: "Only the group creator can delete it" });
    }
    // Detach the group from any future recurring events so the dangling
    // link doesn't linger. We keep the events themselves — people may
    // still be planning to show up — but the live link is severed.
    await groupEventLink.detachGroupFromEvents(String(group._id));
    await Group.deleteOne({ _id: group._id });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Failed to delete group:", err);
    return res.status(500).json({ message: "Failed to delete group" });
  }
});

// PATCH /groups/:id — rename and/or change privacy. Admin-only.
// Triggers a live-link refresh so the cached `groupName` on any future
// recurring events updates immediately (the "via [Group]" badge always
// reads the current name).
router.patch("/:id", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { name, privacy } = req.body as {
    name?: string;
    privacy?: "private" | "public";
  };

  try {
    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }
    if (!isAdmin(group, userId)) {
      return res.status(403).json({ message: "Admins only" });
    }

    let touched = false;
    if (typeof name === "string" && name.trim()) {
      group.name = name.trim();
      touched = true;
    }
    if (privacy === "private" || privacy === "public") {
      group.privacy = privacy;
      touched = true;
    }
    if (!touched) {
      return res.status(400).json({ message: "No changes provided" });
    }
    await group.save();

    // Name changes need to propagate to the `groupName` cache on linked
    // future events. Privacy changes do not affect event records.
    if (typeof name === "string" && name.trim()) {
      await groupEventLink.refreshRecurringInvitesForGroup(String(group._id));
    }

    return res.status(200).json({ success: true, group: await serializeGroup(group) });
  } catch (err) {
    console.error("Failed to update group:", err);
    return res.status(500).json({ message: "Failed to update group" });
  }
});

// POST /groups/:id/members — add a member (admin only). Accepts a
// single `userId`. Duplicates are no-ops. Triggers a recurring-event
// refresh so the new person is on the next instance automatically.
router.post("/:id/members", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const targetId = (req.body?.userId || "").toString().trim();
  if (!targetId) {
    return res.status(400).json({ message: "userId is required" });
  }

  try {
    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }
    if (!isAdmin(group, userId)) {
      return res.status(403).json({ message: "Admins only" });
    }
    // Confirm the user exists before adding — prevents typos from
    // creating ghost members that hydration can't resolve.
    const targetUser = await User.findById(targetId);
    if (!targetUser) {
      return res.status(400).json({ message: "User not found" });
    }
    if (isMember(group, targetId)) {
      return res
        .status(200)
        .json({ success: true, group: await serializeGroup(group) });
    }
    (group.members as IGroupMember[]).push({
      userId: targetId,
      role: "member",
      joinedAt: new Date(),
    });
    await group.save();

    await groupEventLink.refreshRecurringInvitesForGroup(String(group._id));

    // Welcome the newly added member. Same wording as the create-with-
    // initial-members path so the experience is symmetric.
    const actorName = await actorDisplayName(userId);
    notificationService.sendPushNotification({
      userId: targetId,
      title: `Welcome to ${group.name}`,
      body: `${actorName} added you to the group`,
      type: "group_added",
      data: { groupId: String(group._id), groupName: group.name },
    });

    return res
      .status(201)
      .json({ success: true, group: await serializeGroup(group) });
  } catch (err) {
    console.error("Failed to add member:", err);
    return res.status(500).json({ message: "Failed to add member" });
  }
});

// DELETE /groups/:id/members/:userId — remove a member. Admins can
// remove anyone (except they can't remove the creator unless ownership
// is transferred first). Non-admins can only self-remove (i.e. leave).
router.delete(
  "/:id/members/:userId",
  async (req: Request, res: Response) => {
    const callerId = requireUserId(req, res);
    if (!callerId) return;

    const { id, userId: targetId } = req.params;

    try {
      const group = await Group.findById(id);
      if (!group) {
        return res.status(404).json({ message: "Group not found" });
      }
      if (!isMember(group, targetId)) {
        return res.status(404).json({ message: "Member not found in group" });
      }

      const callerIsAdmin = isAdmin(group, callerId);
      const isSelf = String(callerId) === String(targetId);
      if (!callerIsAdmin && !isSelf) {
        return res
          .status(403)
          .json({ message: "You can only remove yourself" });
      }
      if (isCreator(group, targetId) && !isSelf) {
        // Removing the creator out from under them would orphan the
        // group's ownership. The creator must transfer ownership (or
        // delete the group) first.
        return res
          .status(400)
          .json({ message: "Transfer ownership before removing the creator" });
      }

      // Creator self-leave is allowed only after they've transferred —
      // we surface this constraint on the FE via the transfer modal
      // before the user gets here, but defend against it server-side
      // anyway. PR 4 frontend handles the successor picker; if the
      // request reaches here for the creator, force them through it.
      if (isCreator(group, targetId) && isSelf) {
        return res
          .status(400)
          .json({
            message:
              "Transfer ownership before leaving — pick a new creator first",
          });
      }

      group.members = (group.members as IGroupMember[]).filter(
        (m) => String(m.userId) !== String(targetId),
      ) as IGroupMember[];
      await group.save();

      await groupEventLink.refreshRecurringInvitesForGroup(String(group._id));

      return res
        .status(200)
        .json({ success: true, group: await serializeGroup(group) });
    } catch (err) {
      console.error("Failed to remove member:", err);
      return res.status(500).json({ message: "Failed to remove member" });
    }
  },
);

// PATCH /groups/:id/members/:userId — promote/demote. Admin only.
// Body: { role: 'admin' | 'member' }. Demoting the creator from admin
// is rejected; the creator role is special and must be transferred via
// the dedicated endpoint.
router.patch(
  "/:id/members/:userId",
  async (req: Request, res: Response) => {
    const callerId = requireUserId(req, res);
    if (!callerId) return;

    const { role } = req.body as { role?: "admin" | "member" };
    if (role !== "admin" && role !== "member") {
      return res
        .status(400)
        .json({ message: "role must be 'admin' or 'member'" });
    }

    const { id, userId: targetId } = req.params;
    try {
      const group = await Group.findById(id);
      if (!group) {
        return res.status(404).json({ message: "Group not found" });
      }
      if (!isAdmin(group, callerId)) {
        return res.status(403).json({ message: "Admins only" });
      }
      if (isCreator(group, targetId) && role === "member") {
        return res
          .status(400)
          .json({ message: "Cannot demote the group creator" });
      }
      const idx = (group.members as IGroupMember[]).findIndex(
        (m) => String(m.userId) === String(targetId),
      );
      if (idx === -1) {
        return res.status(404).json({ message: "Member not found in group" });
      }
      const previousRole = (group.members as IGroupMember[])[idx].role;
      (group.members as IGroupMember[])[idx].role = role;
      await group.save();

      // Only notify on a real transition into admin. Demotions stay
      // quiet — "you're not an admin anymore" is awkward to push and
      // the target user can see their role in the app.
      if (previousRole !== "admin" && role === "admin") {
        notificationService.sendPushNotification({
          userId: targetId,
          title: "You're now an admin",
          body: `You can manage members and settings in ${group.name}`,
          type: "group_admin_promoted",
          data: { groupId: String(group._id), groupName: group.name },
        });
      }

      return res
        .status(200)
        .json({ success: true, group: await serializeGroup(group) });
    } catch (err) {
      console.error("Failed to change member role:", err);
      return res.status(500).json({ message: "Failed to change member role" });
    }
  },
);

// POST /groups/:id/transfer — transfer the creator role. Creator only.
// The successor must already be a member. They become creator + admin;
// the previous creator stays in the group as a regular admin (they can
// then leave via the standard remove route if they want). This is the
// path the "creator leaves" flow walks the user through.
router.post("/:id/transfer", async (req: Request, res: Response) => {
  const callerId = requireUserId(req, res);
  if (!callerId) return;

  const successorId = (req.body?.userId || "").toString().trim();
  if (!successorId) {
    return res.status(400).json({ message: "userId is required" });
  }

  try {
    const group = await Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ message: "Group not found" });
    }
    if (!isCreator(group, callerId)) {
      return res.status(403).json({ message: "Only the creator can transfer ownership" });
    }
    if (String(successorId) === String(callerId)) {
      return res.status(400).json({ message: "You're already the creator" });
    }
    if (!isMember(group, successorId)) {
      return res
        .status(400)
        .json({ message: "Successor must already be a member" });
    }

    group.createdBy = String(successorId);
    // Make sure the successor is an admin (they may have been a regular
    // member). Previous creator stays an admin too — same role as any
    // other admin from here on. They can promote-demote-leave normally.
    const members = group.members as IGroupMember[];
    const successorIdx = members.findIndex(
      (m) => String(m.userId) === String(successorId),
    );
    if (successorIdx >= 0) {
      members[successorIdx].role = "admin";
    }
    await group.save();

    // Tell the successor they've inherited the group. High-signal —
    // they should know they're now responsible for it.
    const actorName = await actorDisplayName(callerId);
    notificationService.sendPushNotification({
      userId: successorId,
      title: "You're now the group creator",
      body: `${actorName} transferred ${group.name} to you`,
      type: "group_ownership_transferred",
      data: { groupId: String(group._id), groupName: group.name },
    });

    return res
      .status(200)
      .json({ success: true, group: await serializeGroup(group) });
  } catch (err) {
    console.error("Failed to transfer ownership:", err);
    return res.status(500).json({ message: "Failed to transfer ownership" });
  }
});

export default router;
