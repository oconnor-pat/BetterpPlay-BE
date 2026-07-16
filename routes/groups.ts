import { Router, Request, Response } from "express";
import Group, { IGroup, IGroupMember } from "../models/group";
import User from "../models/user";
import GroupMessage from "../models/groupMessage";
import GroupRead from "../models/groupRead";
import Event from "../models/event";
import groupEventLink from "../services/groupEventLink";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";

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

    const groupIds = groups.map((g: any) => String(g._id));

    // Chat enrichment for the Groups tab: each row shows the latest
    // message preview and an unread badge so the tab reads like a hub.
    // Batched so this stays O(1) DB round trips regardless of group count.
    const [reads, lastMessages] = await Promise.all([
      GroupRead.find({ userId, groupId: { $in: groupIds } }).lean(),
      // One most-recent message per group via aggregation.
      GroupMessage.aggregate([
        { $match: { groupId: { $in: groupIds } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$groupId",
            text: { $first: "$text" },
            kind: { $first: "$kind" },
            username: { $first: "$username" },
            senderId: { $first: "$userId" },
            createdAt: { $first: "$createdAt" },
          },
        },
      ]),
    ]);

    const lastReadByGroup = new Map<string, Date>(
      reads.map((r: any) => [String(r.groupId), r.lastReadAt]),
    );
    const lastMsgByGroup = new Map<string, any>(
      lastMessages.map((m: any) => [String(m._id), m]),
    );

    // Unread = messages newer than the user's lastReadAt, authored by
    // someone else. The threshold differs per group, so count per group
    // (bounded by the number of groups the user is in — small).
    const unreadByGroup = new Map<string, number>();
    await Promise.all(
      groupIds.map(async (gid) => {
        const since = lastReadByGroup.get(gid);
        const query: any = { groupId: gid, userId: { $ne: userId } };
        if (since) query.createdAt = { $gt: since };
        const count = await GroupMessage.countDocuments(query);
        unreadByGroup.set(gid, count);
      }),
    );

    // Hydrate each group's members. For the list view we could skip
    // hydration (just show member count) but keeping it consistent with
    // GET /:id makes the FE simpler — same shape everywhere.
    const serialized = await Promise.all(
      groups.map(async (g: any) => {
        const gid = String(g._id);
        const lm = lastMsgByGroup.get(gid);
        return {
          _id: g._id,
          name: g.name,
          createdBy: g.createdBy,
          privacy: g.privacy,
          members: await hydrateMembers(g.members || []),
          memberCount: (g.members || []).length,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
          unreadCount: unreadByGroup.get(gid) || 0,
          lastMessage: lm
            ? {
                text: lm.text,
                kind: lm.kind,
                username: lm.username,
                senderId: lm.senderId,
                createdAt: lm.createdAt,
              }
            : null,
        };
      }),
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
    const serialized = await serializeGroup(group);
    // Surface the group's next few events so the detail screen reads as
    // a hub ("here's what's coming up") rather than just a roster. Uses
    // the string date field (yyyy-mm-dd) so a lexical >= today filter is
    // correct without any timezone math.
    const today = new Date().toISOString().split("T")[0];
    const upcoming = await Event.find({
      groupId: String(group._id),
      date: { $gte: today },
    })
      .sort({ date: 1, time: 1 })
      .limit(5)
      .select("name date time location eventType rosterSpotsFilled totalSpots")
      .lean();
    return res.status(200).json({
      success: true,
      group: { ...serialized, upcomingEvents: upcoming },
    });
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

// ── Group chat ───────────────────────────────────────────────────────
// A dedicated message thread per group. Read/write is membership-gated
// (same 403 semantics as GET /:id for private groups). Real-time is via
// the `group:{id}` socket room; unread state is tracked per-user in the
// GroupRead collection.

// Load a group and confirm the caller is a member. Sends the 404/403 and
// returns null on failure so callers can early-return.
const loadGroupForMember = async (
  req: Request,
  res: Response,
  userId: string,
): Promise<IGroup | null> => {
  const group = await Group.findById(req.params.id);
  if (!group) {
    res.status(404).json({ message: "Group not found" });
    return null;
  }
  if (!isMember(group, userId)) {
    res.status(403).json({ message: "Not a member of this group" });
    return null;
  }
  return group;
};

const serializeMessage = (m: any) => ({
  _id: m._id,
  groupId: m.groupId,
  userId: m.userId,
  username: m.username,
  profilePicUrl: m.profilePicUrl,
  text: m.text,
  kind: m.kind,
  eventRef: m.eventRef,
  createdAt: m.createdAt,
});

// GET /groups/:id/messages — newest-first page. `before` (ISO date) is a
// cursor for loading older messages; `limit` caps at 50.
router.get("/:id/messages", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const group = await loadGroupForMember(req, res, userId);
    if (!group) return;

    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || "30"), 10) || 30, 1),
      50,
    );
    const query: any = { groupId: String(group._id) };
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !isNaN(before.getTime())) {
      query.createdAt = { $lt: before };
    }

    const messages = await GroupMessage.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      messages: messages.map(serializeMessage),
      hasMore: messages.length === limit,
    });
  } catch (err) {
    console.error("Failed to fetch group messages:", err);
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// POST /groups/:id/messages — post a text message. Broadcasts to the
// group room (live thread) and each member's user room (badge/list),
// then pushes to members who aren't currently watching the thread.
router.post("/:id/messages", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const text = (req.body?.text || "").toString().trim();
  if (!text) {
    return res.status(400).json({ message: "Message text is required" });
  }
  if (text.length > 2000) {
    return res.status(400).json({ message: "Message is too long" });
  }

  try {
    const group = await loadGroupForMember(req, res, userId);
    if (!group) return;

    const sender = await User.findById(userId)
      .select("username name profilePicUrl")
      .lean();

    const created = await GroupMessage.create({
      groupId: String(group._id),
      userId,
      username: (sender as any)?.username || (sender as any)?.name || "Member",
      profilePicUrl: (sender as any)?.profilePicUrl,
      text,
      kind: "text",
    });
    const message = serializeMessage(created);

    // The sender has, by definition, "read" up to their own message.
    await GroupRead.findOneAndUpdate(
      { groupId: String(group._id), userId },
      { lastReadAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true },
    );

    // Live thread update for anyone with the chat open.
    socketService.emitToGroup(String(group._id), "group:message:new", message);

    // Badge/list update for every member's other surfaces (Groups tab).
    const memberIds = (group.members as IGroupMember[]).map((m) =>
      String(m.userId),
    );
    const activity = {
      groupId: String(group._id),
      senderId: userId,
      lastMessage: {
        text: message.text,
        kind: message.kind,
        username: message.username,
        senderId: message.userId,
        createdAt: message.createdAt,
      },
    };
    socketService.emitToUsers(memberIds, "group:activity", activity);

    // Push to members who aren't the sender and aren't actively watching
    // the thread (those get the live socket update instead).
    const inRoom = await socketService.getUserIdsInGroupRoom(String(group._id));
    const pushTargets = memberIds.filter(
      (id) => id !== userId && !inRoom.has(id),
    );
    if (pushTargets.length > 0) {
      const senderName =
        (sender as any)?.name || (sender as any)?.username || "Someone";
      notificationService.sendPushNotificationToMany(
        pushTargets,
        group.name,
        `${senderName}: ${text}`,
        "group_message",
        { groupId: String(group._id), groupName: group.name },
      );
    }

    return res.status(201).json({ success: true, message });
  } catch (err) {
    console.error("Failed to send group message:", err);
    return res.status(500).json({ message: "Failed to send message" });
  }
});

// POST /groups/:id/read — mark the thread read up to now. Clears the
// unread badge and syncs the user's other devices.
router.post("/:id/read", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const group = await loadGroupForMember(req, res, userId);
    if (!group) return;

    await GroupRead.findOneAndUpdate(
      { groupId: String(group._id), userId },
      { lastReadAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true },
    );
    // Tell the user's other devices to clear the badge for this group.
    socketService.emitToUser(userId, "group:read", {
      groupId: String(group._id),
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Failed to mark group read:", err);
    return res.status(500).json({ message: "Failed to mark read" });
  }
});

export default router;
