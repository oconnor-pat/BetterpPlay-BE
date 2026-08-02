import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Conversation, {
  IConversation,
  buildParticipantKey,
} from "../models/conversation";
import DirectMessage from "../models/directMessage";
import User from "../models/user";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";
import blockService from "../services/blockService";
import {
  isValidEmoji,
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
  MAX_REACTIONS_PER_USER_PER_MESSAGE,
} from "../utils/emoji";

const router = Router();

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

const isValidObjectId = (value: unknown): boolean =>
  typeof value === "string" && mongoose.Types.ObjectId.isValid(value);

const isValidImageUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 2048 &&
  /^https:\/\/\S+$/i.test(value.trim());

const otherParticipant = (conv: IConversation, userId: string): string =>
  conv.participants.map(String).find((p) => p !== String(userId)) || "";

const readStateFor = (conv: IConversation, userId: string) =>
  (conv.readState || []).find((r) => String(r.userId) === String(userId));

const readAtFor = (conv: IConversation, userId: string): Date | null => {
  const entry = readStateFor(conv, userId);
  return entry?.lastReadAt ? new Date(entry.lastReadAt) : null;
};

// When this user last deleted the thread. Everything at or before this
// point is invisible to them, in the thread and in the inbox.
const clearedAtFor = (conv: IConversation, userId: string): Date | null => {
  const entry = readStateFor(conv, userId);
  return entry?.clearedAt ? new Date(entry.clearedAt) : null;
};

// The point past which messages are visible *and* countable for a user:
// the later of when they last read and when they last cleared. Deleting
// sets both, but taking the max keeps this correct regardless of order.
const visibleSince = (conv: IConversation, userId: string): Date | null => {
  const read = readAtFor(conv, userId);
  const cleared = clearedAtFor(conv, userId);
  if (read && cleared) return read > cleared ? read : cleared;
  return read || cleared;
};

// Unread is "messages in this thread newer than my cursor that I didn't
// write". No read row means the thread has never been opened, so
// everything in it counts.
const countUnread = async (
  conv: IConversation,
  userId: string,
): Promise<number> => {
  const query: any = {
    conversationId: String(conv._id),
    senderId: { $ne: String(userId) },
  };
  const since = visibleSince(conv, userId);
  if (since) {
    query.createdAt = { $gt: since };
  }
  return DirectMessage.countDocuments(query);
};

// Upsert one participant's read-state fields. Tries to bump an existing
// entry first; if this user has no row on the thread yet, pushes one.
// Two writes in the worst case, but it keeps the read state a bounded
// two-element array instead of a collection.
const updateReadState = async (
  conversationId: string,
  userId: string,
  fields: { lastReadAt?: Date; clearedAt?: Date },
) => {
  const set: any = {};
  for (const [key, value] of Object.entries(fields)) {
    set[`readState.$.${key}`] = value;
  }
  const updated = await Conversation.updateOne(
    { _id: conversationId, "readState.userId": String(userId) },
    { $set: set },
  );
  if (updated.matchedCount === 0) {
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $push: {
          readState: {
            userId: String(userId),
            lastReadAt: fields.lastReadAt || new Date(),
            clearedAt: fields.clearedAt,
          },
        },
      },
    );
  }
};

const setReadAt = (conversationId: string, userId: string) =>
  updateReadState(conversationId, userId, { lastReadAt: new Date() });

const serializeMessage = (m: any) => {
  const deleted = !!m.deletedAt;
  return {
    _id: m._id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    username: m.username,
    profilePicUrl: m.profilePicUrl,
    text: deleted ? "" : m.text || "",
    imageUrl: deleted ? undefined : m.imageUrl,
    imageWidth: deleted ? undefined : m.imageWidth,
    imageHeight: deleted ? undefined : m.imageHeight,
    reactions: deleted
      ? []
      : (m.reactions || []).map((r: any) => ({
          userId: String(r.userId),
          emoji: r.emoji,
        })),
    deletedAt: m.deletedAt || undefined,
    createdAt: m.createdAt,
  };
};

// Threads are always rendered from one side's point of view, so the
// serialized shape resolves "the other person" rather than handing the
// client a participants array to sift through.
const serializeConversation = (
  conv: IConversation,
  userId: string,
  otherUser: any,
  unreadCount: number,
) => {
  const otherId = otherParticipant(conv, userId);
  return {
    _id: conv._id,
    status: conv.status,
    requestedBy: conv.requestedBy,
    // True when the decision is mine to make: someone else opened this
    // thread and it's still waiting on me.
    isIncomingRequest:
      conv.status === "pending" && String(conv.requestedBy) !== String(userId),
    // True when I'm the one waiting: a request I sent that hasn't been
    // answered yet. Lets the inbox mark the row rather than passing it
    // off as an ordinary conversation.
    isOutgoingRequest:
      conv.status === "pending" && String(conv.requestedBy) === String(userId),
    // True when I'm the one who was turned down. The composer closes and
    // the thread reads as no longer accepting messages.
    isClosedToMe:
      conv.status === "declined" && String(conv.requestedBy) === String(userId),
    otherUser: {
      userId: otherId,
      username: otherUser?.username,
      name: otherUser?.name,
      profilePicUrl: otherUser?.profilePicUrl,
    },
    lastMessage: conv.lastMessage
      ? {
          text: conv.lastMessage.deleted ? "" : conv.lastMessage.text || "",
          senderId: String(conv.lastMessage.senderId),
          hasImage: !!conv.lastMessage.hasImage,
          deleted: !!conv.lastMessage.deleted,
          createdAt: conv.lastMessage.createdAt,
        }
      : null,
    lastMessageAt: conv.lastMessageAt,
    unreadCount,
    createdAt: (conv as any).createdAt,
  };
};

// Threads this user has deleted stay hidden from them until there's
// something new in them. Applied in memory rather than in the query
// because the comparison is between two fields on the same document
// (lastMessageAt vs. my own clearedAt), which a plain find can't express
// — and an inbox is small enough that it isn't worth an aggregation.
const visibleToUser = (convs: IConversation[], userId: string) =>
  convs.filter((c) => {
    const cleared = clearedAtFor(c, userId);
    if (!cleared) return true;
    return !!c.lastMessageAt && new Date(c.lastMessageAt) > cleared;
  });

// Hydrate display fields for the far side of each thread in one query,
// then attach unread counts. Display fields are pulled fresh (not
// snapshotted) so a renamed or repictured user looks right in the inbox.
const serializeConversations = async (
  convs: IConversation[],
  userId: string,
) => {
  if (convs.length === 0) return [];
  const otherIds = convs.map((c) => otherParticipant(c, userId));
  const users = await User.find(
    { _id: { $in: otherIds } },
    "username name profilePicUrl",
  ).lean();
  const byId = new Map<string, any>(users.map((u: any) => [String(u._id), u]));
  const counts = await Promise.all(convs.map((c) => countUnread(c, userId)));
  return convs.map((c, i) =>
    serializeConversation(
      c,
      userId,
      byId.get(otherParticipant(c, userId)),
      counts[i],
    ),
  );
};

// Loads a thread the caller is actually part of. Declined threads stay
// readable by the person who declined (so it isn't a black hole) but the
// send path refuses them separately.
const loadConversation = async (
  req: Request,
  res: Response,
  userId: string,
): Promise<IConversation | null> => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    res.status(404).json({ message: "Conversation not found" });
    return null;
  }
  const conv = await Conversation.findById(id);
  if (!conv) {
    res.status(404).json({ message: "Conversation not found" });
    return null;
  }
  if (!conv.participants.map(String).includes(String(userId))) {
    res.status(403).json({ message: "Not part of this conversation" });
    return null;
  }
  return conv;
};

const areFriends = async (a: string, b: string): Promise<boolean> => {
  const me = await User.findById(a).select("friends").lean();
  const friends = ((me as any)?.friends || []).map((f: any) => String(f));
  return friends.includes(String(b));
};

// POST /dm/conversations — open (or reopen) a thread with someone.
// Idempotent: the unique participantKey means both people tapping
// "Message" at the same moment converge on one thread.
router.post("/conversations", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const targetId = String(req.body?.userId || "");
  if (!isValidObjectId(targetId)) {
    return res.status(400).json({ message: "A valid userId is required" });
  }
  if (targetId === userId) {
    return res.status(400).json({ message: "You can't message yourself" });
  }

  try {
    const target = await User.findById(targetId)
      .select("username name profilePicUrl")
      .lean();
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }

    // A block stops a thread from opening at all. The two directions get
    // different answers on purpose: if I did the blocking I'm told so,
    // because I can undo it; if they blocked me the response is the same
    // one a deleted account gives, since confirming a block would tell a
    // blocked person exactly what blocking is meant to keep from them.
    const { iBlocked, theyBlocked } = await blockService.getPairState(
      userId,
      targetId,
    );
    if (iBlocked) {
      return res
        .status(403)
        .json({ message: "You've blocked this person", code: "blocked_by_me" });
    }
    if (theyBlocked) {
      return res.status(404).json({ message: "User not found" });
    }

    const participantKey = buildParticipantKey(userId, targetId);
    let conv = await Conversation.findOne({ participantKey });

    if (conv) {
      // Reaching out to someone whose request I previously declined is a
      // clear signal I've changed my mind, so it reopens as a real
      // thread. The reverse — the declined sender trying again — stays
      // blocked, which is the whole point of declining.
      //
      // Note the declined sender still gets a 200 here rather than a
      // 403: opening is read-only, and handing back the thread is what
      // lets their client render the "no longer accepting messages"
      // notice in place of a composer. Refusing outright would leave
      // them staring at an error with no explanation. The send route is
      // where the block is actually enforced.
      if (conv.status === "declined" && String(conv.requestedBy) !== String(userId)) {
        conv.status = "accepted";
        await conv.save();
      }
    } else {
      // Friends skip the request step; there's nothing to vet between
      // people who already agreed to be connected.
      const friends = await areFriends(userId, targetId);
      conv = await Conversation.create({
        participants: [userId, targetId].sort(),
        participantKey,
        status: friends ? "accepted" : "pending",
        requestedBy: userId,
        readState: [{ userId, lastReadAt: new Date() }],
      });
    }

    const unreadCount = await countUnread(conv, userId);
    return res.status(200).json({
      success: true,
      conversation: serializeConversation(conv, userId, target, unreadCount),
    });
  } catch (err) {
    console.error("Failed to open conversation:", err);
    return res.status(500).json({ message: "Failed to open conversation" });
  }
});

// GET /dm/conversations — the inbox: threads with at least one message,
// most recently active first. A thread someone opened but never wrote in
// would just be an empty row, so it stays hidden until it has something
// to show.
//
// Alongside accepted threads this includes requests *I* sent that are
// still pending or were declined. Those aren't conversations yet, but
// leaving them out made the sender's own outbox a black hole: they'd
// write to a stranger and the thread would vanish from every surface.
// Keeping them visible is also what makes the "no longer accepting
// messages" notice findable after a decline. Requests sent *to* me stay
// out — those live under Requests until I rule on them.
router.get("/conversations", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const convs = await Conversation.find({
      participants: String(userId),
      lastMessageAt: { $ne: null },
      $or: [
        { status: "accepted" },
        {
          requestedBy: String(userId),
          status: { $in: ["pending", "declined"] },
        },
      ],
    })
      .sort({ lastMessageAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      conversations: await serializeConversations(
        visibleToUser(convs, userId),
        userId,
      ),
    });
  } catch (err) {
    console.error("Failed to list conversations:", err);
    return res.status(500).json({ message: "Failed to load conversations" });
  }
});

// GET /dm/requests — threads a non-friend opened with me that I haven't
// acted on yet. Deliberately a separate surface from the inbox: the
// point of the request step is that these don't mix in with real
// conversations until I say so.
router.get("/requests", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const convs = await Conversation.find({
      participants: String(userId),
      status: "pending",
      requestedBy: { $ne: String(userId) },
      lastMessageAt: { $ne: null },
    })
      .sort({ lastMessageAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      requests: await serializeConversations(
        visibleToUser(convs, userId),
        userId,
      ),
    });
  } catch (err) {
    console.error("Failed to list message requests:", err);
    return res.status(500).json({ message: "Failed to load requests" });
  }
});

// GET /dm/declined — requests I turned down. These are deliberately
// absent from both the inbox and the Requests tab, so without this the
// decision would be irreversible in practice: there'd be no surface
// anywhere to change my mind from. It backs the "declined" half of the
// blocked-and-declined settings screen.
router.get("/declined", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const convs = await Conversation.find({
      participants: String(userId),
      status: "declined",
      requestedBy: { $ne: String(userId) },
      lastMessageAt: { $ne: null },
    })
      .sort({ lastMessageAt: -1 })
      .limit(100);

    return res.status(200).json({
      success: true,
      declined: await serializeConversations(
        visibleToUser(convs, userId),
        userId,
      ),
    });
  } catch (err) {
    console.error("Failed to list declined conversations:", err);
    return res.status(500).json({ message: "Failed to load declined" });
  }
});

// GET /dm/unread-count — drives the Messages tab badge. Requests are
// counted as threads rather than messages: the badge should say "one
// person wants to reach you", not "a stranger sent you nine things".
router.get("/unread-count", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const [acceptedRaw, pendingRaw] = await Promise.all([
      Conversation.find({
        participants: String(userId),
        status: "accepted",
        lastMessageAt: { $ne: null },
      }),
      Conversation.find({
        participants: String(userId),
        status: "pending",
        requestedBy: { $ne: String(userId) },
        lastMessageAt: { $ne: null },
      }),
    ]);

    // Deleted threads shouldn't badge the tab either, so both sides go
    // through the same visibility filter the lists use.
    const accepted = visibleToUser(acceptedRaw, userId);
    const requests = visibleToUser(pendingRaw, userId).length;

    const counts = await Promise.all(
      accepted.map((c) => countUnread(c, userId)),
    );
    const unread = counts.reduce((sum, n) => sum + n, 0);
    const unreadThreads = counts.filter((n) => n > 0).length;

    return res
      .status(200)
      .json({ success: true, unread, unreadThreads, requests });
  } catch (err) {
    console.error("Failed to count unread DMs:", err);
    return res.status(500).json({ message: "Failed to count unread" });
  }
});

// GET /dm/conversations/:id — a single thread's header state. The thread
// screen needs the other person and the status (to know whether to show
// the accept/decline bar) before any messages load.
router.get("/conversations/:id", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const conv = await loadConversation(req, res, userId);
    if (!conv) return;

    const other = await User.findById(otherParticipant(conv, userId))
      .select("username name profilePicUrl")
      .lean();
    const unreadCount = await countUnread(conv, userId);

    return res.status(200).json({
      success: true,
      conversation: serializeConversation(conv, userId, other, unreadCount),
    });
  } catch (err) {
    console.error("Failed to load conversation:", err);
    return res.status(500).json({ message: "Failed to load conversation" });
  }
});

// GET /dm/conversations/:id/messages — newest-first page. `before` (ISO
// date) is a cursor for loading older messages; `limit` caps at 50.
router.get("/conversations/:id/messages", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const conv = await loadConversation(req, res, userId);
    if (!conv) return;

    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || "30"), 10) || 30, 1),
      50,
    );
    const query: any = { conversationId: String(conv._id) };
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !isNaN(before.getTime())) {
      query.createdAt = { $lt: before };
    }
    // Anything from before this user deleted the thread is gone as far
    // as they're concerned, even though the other side still has it.
    const cleared = clearedAtFor(conv, userId);
    if (cleared) {
      query.createdAt = { ...(query.createdAt || {}), $gt: cleared };
    }

    const messages = await DirectMessage.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      messages: messages.map(serializeMessage),
      hasMore: messages.length === limit,
    });
  } catch (err) {
    console.error("Failed to fetch direct messages:", err);
    return res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// POST /dm/conversations/:id/messages — send. Broadcasts to the thread
// room (live view) and both user rooms (inbox/badge), then pushes the
// recipient if they aren't currently watching.
router.post(
  "/conversations/:id/messages",
  async (req: Request, res: Response) => {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const text = (req.body?.text || "").toString().trim();
    const rawImageUrl = req.body?.imageUrl;
    const hasImage =
      rawImageUrl !== undefined && rawImageUrl !== null && rawImageUrl !== "";

    if (hasImage && !isValidImageUrl(rawImageUrl)) {
      return res.status(400).json({ message: "Invalid image URL" });
    }
    const imageUrl = hasImage ? String(rawImageUrl).trim() : undefined;

    if (!text && !imageUrl) {
      return res.status(400).json({ message: "Message text is required" });
    }
    if (text.length > 2000) {
      return res.status(400).json({ message: "Message is too long" });
    }

    const toDimension = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 && n <= 20000
        ? Math.round(n)
        : undefined;
    };

    try {
      const conv = await loadConversation(req, res, userId);
      if (!conv) return;

      if (conv.status === "declined") {
        return res
          .status(403)
          .json({ message: "This conversation is no longer accepting messages" });
      }

      // Replying to a request accepts it. Tapping "Accept" and simply
      // writing back mean the same thing, so we don't make people do
      // both.
      const wasPending = conv.status === "pending";
      const isRecipient = String(conv.requestedBy) !== String(userId);
      if (wasPending && isRecipient) {
        conv.status = "accepted";
      }

      // Captured before we overwrite it: the very first message in a
      // request thread is the only one that earns the recipient a push.
      const isFirstMessage = !conv.lastMessageAt;

      const sender = await User.findById(userId)
        .select("username name profilePicUrl")
        .lean();

      const created = await DirectMessage.create({
        conversationId: String(conv._id),
        senderId: userId,
        username: (sender as any)?.username || (sender as any)?.name || "User",
        profilePicUrl: (sender as any)?.profilePicUrl,
        text,
        imageUrl,
        imageWidth: imageUrl ? toDimension(req.body?.imageWidth) : undefined,
        imageHeight: imageUrl ? toDimension(req.body?.imageHeight) : undefined,
      });
      const message = serializeMessage(created);

      conv.lastMessageAt = created.createdAt;
      conv.lastMessage = {
        text,
        senderId: String(userId),
        hasImage: !!imageUrl,
        deleted: false,
        createdAt: created.createdAt,
      };
      await conv.save();

      // The sender has, by definition, read up to their own message.
      await setReadAt(String(conv._id), userId);

      const recipientId = otherParticipant(conv, userId);

      socketService.emitToConversation(
        String(conv._id),
        "dm:message:new",
        message,
      );

      // Inbox/badge update for both sides' other surfaces.
      socketService.emitToUsers([String(userId), recipientId], "dm:activity", {
        conversationId: String(conv._id),
        senderId: String(userId),
        status: conv.status,
        lastMessage: {
          text,
          senderId: String(userId),
          hasImage: !!imageUrl,
          deleted: false,
          createdAt: created.createdAt,
        },
      });

      const inRoom = await socketService.getUserIdsInConversationRoom(
        String(conv._id),
      );
      if (!inRoom.has(recipientId)) {
        const senderName =
          (sender as any)?.name || (sender as any)?.username || "Someone";
        const preview = text || "📷 Photo";
        if (conv.status === "accepted") {
          notificationService.sendPushNotification({
            userId: recipientId,
            title: senderName,
            body: preview,
            type: "direct_message",
            data: {
              conversationId: String(conv._id),
              senderId: String(userId),
              senderName,
            },
          });
        } else if (isFirstMessage) {
          // Still pending: exactly one ping, on the opening message. Every
          // send after this is silent until they accept, so an unwanted
          // sender can't buzz someone repeatedly.
          notificationService.sendPushNotification({
            userId: recipientId,
            title: "New message request",
            body: `${senderName} wants to send you a message`,
            type: "message_request",
            data: {
              conversationId: String(conv._id),
              senderId: String(userId),
              senderName,
            },
          });
        }
      }

      return res.status(201).json({ success: true, message });
    } catch (err) {
      console.error("Failed to send direct message:", err);
      return res.status(500).json({ message: "Failed to send message" });
    }
  },
);

// POST /dm/conversations/:id/read — mark the thread read up to now.
router.post("/conversations/:id/read", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const conv = await loadConversation(req, res, userId);
    if (!conv) return;

    await setReadAt(String(conv._id), userId);
    // Tell the user's other devices to clear the badge for this thread.
    socketService.emitToUser(userId, "dm:read", {
      conversationId: String(conv._id),
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Failed to mark conversation read:", err);
    return res.status(500).json({ message: "Failed to mark read" });
  }
});

// DELETE /dm/conversations/:id — remove the thread from my inbox.
//
// One-sided by design: the other participant keeps their copy, since a
// conversation isn't mine alone to destroy. We record when I cleared it
// and hide everything up to that point from me; if they write again the
// thread returns with only the new messages in it.
router.delete("/conversations/:id", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const conv = await loadConversation(req, res, userId);
    if (!conv) return;

    const now = new Date();
    await updateReadState(String(conv._id), userId, {
      lastReadAt: now,
      clearedAt: now,
    });

    // Only this user's other devices care — the far side sees nothing.
    socketService.emitToUser(userId, "dm:conversation:cleared", {
      conversationId: String(conv._id),
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Failed to delete conversation:", err);
    return res.status(500).json({ message: "Failed to delete conversation" });
  }
});

// Loads a message that belongs to this thread. Scoping by conversation
// stops a valid id from someone else's thread being acted on through a
// conversation the caller happens to be in.
const loadMessage = async (
  req: Request,
  res: Response,
  conv: IConversation,
) => {
  const { messageId } = req.params;
  if (!isValidObjectId(messageId)) {
    res.status(404).json({ message: "Message not found" });
    return null;
  }
  const message = await DirectMessage.findById(messageId);
  if (!message || String(message.conversationId) !== String(conv._id)) {
    res.status(404).json({ message: "Message not found" });
    return null;
  }
  return message;
};

// DELETE /dm/conversations/:id/messages/:messageId — retract your own
// message. Soft delete, matching group chat: the row stays so pagination
// and unread counts don't shift under the other person, but the content
// is cleared server-side so a client holding the id can't recover it.
router.delete(
  "/conversations/:id/messages/:messageId",
  async (req: Request, res: Response) => {
    const userId = requireUserId(req, res);
    if (!userId) return;

    try {
      const conv = await loadConversation(req, res, userId);
      if (!conv) return;

      const message = await loadMessage(req, res, conv);
      if (!message) return;

      if (String(message.senderId) !== String(userId)) {
        return res
          .status(403)
          .json({ message: "You can only delete your own messages" });
      }

      if (!message.deletedAt) {
        message.deletedAt = new Date();
        message.text = "";
        message.imageUrl = undefined;
        message.imageWidth = undefined;
        message.imageHeight = undefined;
        message.reactions = [];
        await message.save();
      }

      socketService.emitToConversation(
        String(conv._id),
        "dm:message:deleted",
        {
          conversationId: String(conv._id),
          messageId: String(message._id),
        },
      );

      // The inbox previews the newest message, which may be the one just
      // retracted — recompute it so the row doesn't keep quoting text
      // that no longer exists.
      const latest = await DirectMessage.findOne({
        conversationId: String(conv._id),
      })
        .sort({ createdAt: -1 })
        .lean();
      if (latest) {
        conv.lastMessage = {
          text: (latest as any).deletedAt ? "" : (latest as any).text || "",
          senderId: String((latest as any).senderId),
          hasImage: !(latest as any).deletedAt && !!(latest as any).imageUrl,
          deleted: !!(latest as any).deletedAt,
          createdAt: (latest as any).createdAt,
        };
        await conv.save();
      }

      socketService.emitToUsers(
        [String(userId), otherParticipant(conv, userId)],
        "dm:activity",
        {
          conversationId: String(conv._id),
          senderId: String(userId),
          status: conv.status,
          lastMessage: conv.lastMessage,
        },
      );

      return res.status(200).json({
        success: true,
        conversationId: String(conv._id),
        messageId: String(message._id),
      });
    } catch (err) {
      console.error("Failed to delete direct message:", err);
      return res.status(500).json({ message: "Failed to delete message" });
    }
  },
);

// GET /dm/conversations/:id/messages/:messageId/reactions — who reacted,
// and with what. Hydrated here so the client doesn't have to resolve ids
// against a user list it doesn't have.
router.get(
  "/conversations/:id/messages/:messageId/reactions",
  async (req: Request, res: Response) => {
    const userId = requireUserId(req, res);
    if (!userId) return;

    try {
      const conv = await loadConversation(req, res, userId);
      if (!conv) return;

      const message = await loadMessage(req, res, conv);
      if (!message) return;
      if (message.deletedAt) {
        return res.status(200).json({ success: true, reactions: [] });
      }

      const raw = (message.reactions || []) as any[];
      const users = await User.find({ _id: { $in: raw.map((r) => r.userId) } })
        .select("username name profilePicUrl")
        .lean();
      const byId = new Map(users.map((u: any) => [String(u._id), u]));

      // Reactors we can't resolve (deleted accounts) are dropped rather
      // than rendered as blanks; the pill count still reflects them.
      const reactions = raw
        .map((r) => {
          const u = byId.get(String(r.userId));
          return u
            ? {
                userId: String(r.userId),
                emoji: r.emoji,
                username: u.username,
                name: u.name,
                profilePicUrl: u.profilePicUrl,
              }
            : null;
        })
        .filter(Boolean);

      return res.status(200).json({ success: true, reactions });
    } catch (err) {
      console.error("Failed to fetch DM reactions:", err);
      return res.status(500).json({ message: "Failed to fetch reactions" });
    }
  },
);

// POST /dm/conversations/:id/messages/:messageId/react — toggle one
// (user, emoji) pair, with the same Discord-style semantics as group
// chat: several different emoji at once, and tapping one you already
// used removes just that one.
router.post(
  "/conversations/:id/messages/:messageId/react",
  async (req: Request, res: Response) => {
    const userId = requireUserId(req, res);
    if (!userId) return;

    const requested = req.body?.emoji;
    if (!isValidEmoji(requested)) {
      return res.status(400).json({ message: "Invalid reaction" });
    }
    const emoji = requested.trim();

    try {
      const conv = await loadConversation(req, res, userId);
      if (!conv) return;

      // A thread that won't take messages won't take reactions either,
      // otherwise emoji become a way around being declined.
      if (conv.status === "declined") {
        return res
          .status(403)
          .json({ message: "This conversation is no longer accepting messages" });
      }

      const message = await loadMessage(req, res, conv);
      if (!message) return;
      if (message.deletedAt) {
        return res
          .status(400)
          .json({ message: "Can't react to a deleted message" });
      }

      const existing = message.reactions || [];
      const index = existing.findIndex(
        (r) => String(r.userId) === String(userId) && r.emoji === emoji,
      );

      const added = index < 0;
      if (index >= 0) {
        existing.splice(index, 1);
      } else {
        // Only guard growth — removing is always allowed, so a user can
        // always undo their way back under a limit.
        const distinct = new Set(existing.map((r) => r.emoji));
        if (
          !distinct.has(emoji) &&
          distinct.size >= MAX_DISTINCT_REACTIONS_PER_MESSAGE
        ) {
          return res
            .status(400)
            .json({ message: "This message has too many different reactions" });
        }
        const mine = existing.filter(
          (r) => String(r.userId) === String(userId),
        );
        if (mine.length >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
          return res
            .status(400)
            .json({ message: "You've added too many reactions" });
        }
        existing.push({
          userId: String(userId),
          emoji,
          reactedAt: new Date(),
        });
      }

      message.reactions = existing;
      message.markModified("reactions");
      await message.save();

      const reactions = (message.reactions || []).map((r) => ({
        userId: String(r.userId),
        emoji: r.emoji,
      }));
      socketService.emitToConversation(
        String(conv._id),
        "dm:message:reacted",
        {
          conversationId: String(conv._id),
          messageId: String(message._id),
          reactions,
        },
      );

      // Only the author hears about it, only on add, and only if they
      // aren't already looking at the thread — a removal isn't news.
      const authorId = String(message.senderId);
      if (added && authorId !== String(userId)) {
        const inRoom = await socketService.getUserIdsInConversationRoom(
          String(conv._id),
        );
        if (!inRoom.has(authorId)) {
          const reactor = await User.findById(userId)
            .select("username name")
            .lean();
          const reactorName =
            (reactor as any)?.name || (reactor as any)?.username || "Someone";
          const preview = message.text
            ? `"${message.text.slice(0, 60)}"`
            : "your photo";
          notificationService.sendPushNotification({
            userId: authorId,
            title: reactorName,
            body: `Reacted ${emoji} to ${preview}`,
            type: "direct_message_reaction",
            data: {
              conversationId: String(conv._id),
              messageId: String(message._id),
              senderId: String(userId),
              senderName: reactorName,
            },
          });
        }
      }

      return res.status(200).json({ success: true, reactions });
    } catch (err) {
      console.error("Failed to react to direct message:", err);
      return res.status(500).json({ message: "Failed to react" });
    }
  },
);

// POST /dm/conversations/:id/accept and /decline — the recipient's
// verdict on a message request. Only the person who *received* the
// request can rule on it.
const decideRequest = (decision: "accepted" | "declined") =>
  async function handle(req: Request, res: Response) {
    const userId = requireUserId(req, res);
    if (!userId) return;

    try {
      const conv = await loadConversation(req, res, userId);
      if (!conv) return;

      if (String(conv.requestedBy) === String(userId)) {
        return res
          .status(403)
          .json({ message: "You can't respond to your own request" });
      }
      // Accepting is also how a decline gets undone, so a declined
      // thread is still decidable. What's refused is re-deciding an
      // accepted one: shutting someone out belongs to blocking, not to
      // a second pass through the request flow.
      if (conv.status === "accepted") {
        return res
          .status(400)
          .json({ message: "This request has already been answered" });
      }
      if (conv.status === decision) {
        return res.status(200).json({
          success: true,
          conversationId: String(conv._id),
          status: decision,
        });
      }

      // Undoing a decline shouldn't quietly reopen a thread with someone
      // who has since been blocked — the block is the stronger signal.
      if (decision === "accepted") {
        const otherId = otherParticipant(conv, userId);
        if (await blockService.isBlockedBetween(userId, otherId)) {
          return res.status(403).json({
            message: "Unblock this person before reopening the conversation",
            code: "blocked",
          });
        }
      }

      conv.status = decision;
      await conv.save();

      const payload = {
        conversationId: String(conv._id),
        status: decision,
      };
      // Both sides need this: the recipient's other devices drop it from
      // Requests, and the sender's client stops offering a composer on a
      // thread that's been shut.
      socketService.emitToUsers(
        conv.participants.map(String),
        "dm:conversation:updated",
        payload,
      );

      return res.status(200).json({ success: true, ...payload });
    } catch (err) {
      console.error(`Failed to ${decision} message request:`, err);
      return res.status(500).json({ message: "Failed to update request" });
    }
  };

router.post("/conversations/:id/accept", decideRequest("accepted"));
router.post("/conversations/:id/decline", decideRequest("declined"));

export default router;
