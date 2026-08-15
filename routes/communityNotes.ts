import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import communityNote from "../models/communityNote";
import User from "../models/user";
import Event from "../models/event";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";
import blockService from "../services/blockService";
import {
  isValidEmoji,
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
  MAX_REACTIONS_PER_USER_PER_MESSAGE,
} from "../utils/emoji";

const router = Router();

// Legacy "like" maps to a heart reaction; `likes` stays in sync for older clients.
const LIKE_EMOJI = "❤️";

type ReactionRow = { userId: string; emoji: string; reactedAt?: Date };

const serializeReactions = (doc: any): { userId: string; emoji: string }[] => {
  if (Array.isArray(doc?.reactions) && doc.reactions.length > 0) {
    return doc.reactions.map((r: any) => ({
      userId: String(r.userId),
      emoji: r.emoji,
    }));
  }
  // Pre-reactions data: synthesize hearts from the likes array.
  return (doc?.likes || []).map((id: string) => ({
    userId: String(id),
    emoji: LIKE_EMOJI,
  }));
};

const syncLikesFromReactions = (doc: any) => {
  const reactions = (doc.reactions || []) as ReactionRow[];
  doc.likes = reactions
    .filter((r) => r.emoji === LIKE_EMOJI)
    .map((r) => String(r.userId));
};

const resolveActorId = (req: Request): string | null => {
  if (req.body?.userId) return String(req.body.userId);
  const user = (req as any).user;
  if (user?.id) return String(user.id);
  return null;
};

const toggleReactionOnDoc = (
  doc: any,
  userId: string,
  emoji: string,
): { ok: true; added: boolean } | { ok: false; message: string } => {
  if (!Array.isArray(doc.reactions)) {
    doc.reactions = [];
  }
  // First write after the reactions ship: seed from legacy likes so we
  // don't orphan existing hearts when someone reacts with a different emoji.
  if (doc.reactions.length === 0 && Array.isArray(doc.likes) && doc.likes.length) {
    doc.reactions = doc.likes.map((id: string) => ({
      userId: String(id),
      emoji: LIKE_EMOJI,
      reactedAt: new Date(),
    }));
  }

  const existing: ReactionRow[] = doc.reactions;
  const index = existing.findIndex(
    (r) => String(r.userId) === String(userId) && r.emoji === emoji,
  );

  if (index >= 0) {
    existing.splice(index, 1);
    syncLikesFromReactions(doc);
    return { ok: true, added: false };
  }

  const distinct = new Set(existing.map((r) => r.emoji));
  if (
    !distinct.has(emoji) &&
    distinct.size >= MAX_DISTINCT_REACTIONS_PER_MESSAGE
  ) {
    return { ok: false, message: "This comment has too many different reactions" };
  }
  const mine = existing.filter((r) => String(r.userId) === String(userId));
  if (mine.length >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
    return { ok: false, message: "You've added too many reactions" };
  }

  existing.push({ userId: String(userId), emoji, reactedAt: new Date() });
  syncLikesFromReactions(doc);
  return { ok: true, added: true };
};

router.get("/", async (req: Request, res: Response) => {
  try {
    const allPosts = await communityNote.find().lean();

    // Drop anything written by someone blocked in either direction — the
    // post itself, and individual comments and replies inside posts that
    // are otherwise visible.
    const viewer = (req as any).user;
    const hiddenIds = viewer?.id
      ? await blockService.getHiddenUserIds(String(viewer.id))
      : new Set<string>();
    const posts = hiddenIds.size
      ? allPosts
          .filter((post: any) => !hiddenIds.has(String(post.userId)))
          .map((post: any) => ({
            ...post,
            comments: (post.comments || [])
              .filter((c: any) => !hiddenIds.has(String(c.userId)))
              .map((c: any) => ({
                ...c,
                replies: (c.replies || []).filter(
                  (r: any) => !hiddenIds.has(String(r.userId)),
                ),
              })),
          }))
      : allPosts;

    const userIds = new Set<string>();
    posts.forEach((post: any) => {
      if (post.userId) userIds.add(String(post.userId));
      post.likes?.forEach((id: string) => userIds.add(String(id)));
      post.comments?.forEach((comment: any) => {
        if (comment.userId) userIds.add(String(comment.userId));
        comment.likes?.forEach((id: string) => userIds.add(String(id)));
        comment.reactions?.forEach((r: any) => userIds.add(String(r.userId)));
        comment.replies?.forEach((reply: any) => {
          if (reply.userId) userIds.add(String(reply.userId));
          reply.likes?.forEach((id: string) => userIds.add(String(id)));
          reply.reactions?.forEach((r: any) => userIds.add(String(r.userId)));
        });
      });
    });

    console.log("👥 Collected userIds:", Array.from(userIds));

    const objectIds = Array.from(userIds).map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return id;
      }
    });

    const users = await User.find({ _id: { $in: objectIds } }).lean();
    console.log(
      "🔍 Found users:",
      users.map((u: any) => ({
        id: u._id.toString(),
        username: u.username,
        profilePicUrl: u.profilePicUrl || "NO_PIC",
      })),
    );

    const userPicMap = new Map<string, string>();
    const userNameMap = new Map<string, string>();
    users.forEach((u: any) => {
      userPicMap.set(u._id.toString(), u.profilePicUrl || "");
      userNameMap.set(u._id.toString(), u.username || "");
    });

    console.log("🗺️ User map entries:", Object.fromEntries(userPicMap));

    const getLikedByUsernames = (likes: string[] | undefined): string[] => {
      if (!likes || likes.length === 0) return [];
      return likes
        .map((id) => userNameMap.get(String(id)))
        .filter((name): name is string => !!name);
    };

    const postsWithPhotos = posts.map((post: any) => {
      const postUserId = String(post.userId);
      const postPic = userPicMap.get(postUserId) || "";
      console.log(
        `📸 Post by ${post.username} (${postUserId}): pic = ${
          postPic ? "YES" : "NO"
        }`,
      );

      return {
        ...post,
        profilePicUrl: postPic,
        likedByUsernames: getLikedByUsernames(post.likes),
        reactions: serializeReactions(post),
        comments: post.comments?.map((comment: any) => {
          const commentUserId = String(comment.userId);
          const commentPic = userPicMap.get(commentUserId) || "";
          return {
            ...comment,
            profilePicUrl: commentPic,
            likedByUsernames: getLikedByUsernames(comment.likes),
            reactions: serializeReactions(comment),
            replies: comment.replies?.map((reply: any) => {
              const replyUserId = String(reply.userId);
              const replyPic = userPicMap.get(replyUserId) || "";
              return {
                ...reply,
                profilePicUrl: replyPic,
                likedByUsernames: getLikedByUsernames(reply.likes),
                reactions: serializeReactions(reply),
              };
            }),
          };
        }),
      };
    });

    console.log(
      "✅ Sending postsWithPhotos, first post profilePicUrl:",
      postsWithPhotos[0]?.profilePicUrl,
    );

    res.status(200).json(postsWithPhotos);
  } catch (error) {
    console.error("❌ Error fetching community notes:", error);
    res.status(500).json({ message: "Failed to fetch posts." });
  }
});

router.get(
  "/event/:eventId",
  async (req: Request, res: Response) => {
    try {
      const { eventId } = req.params;
      const found = await communityNote.findOne({ eventId }).lean();

      if (!found) {
        return res
          .status(404)
          .json({ message: "No post found for this event." });
      }

      // Same filtering as the main feed: comments and replies from
      // blocked people are stripped out of an otherwise visible thread.
      const viewer = (req as any).user;
      const hiddenIds = viewer?.id
        ? await blockService.getHiddenUserIds(String(viewer.id))
        : new Set<string>();
      const post: any = hiddenIds.size
        ? {
            ...(found as any),
            comments: ((found as any).comments || [])
              .filter((c: any) => !hiddenIds.has(String(c.userId)))
              .map((c: any) => ({
                ...c,
                replies: (c.replies || []).filter(
                  (r: any) => !hiddenIds.has(String(r.userId)),
                ),
              })),
          }
        : found;

      const userIds = new Set<string>();
      if ((post as any).userId) userIds.add(String((post as any).userId));
      (post as any).likes?.forEach((id: string) => userIds.add(String(id)));
      (post as any).comments?.forEach((comment: any) => {
        if (comment.userId) userIds.add(String(comment.userId));
        comment.likes?.forEach((id: string) => userIds.add(String(id)));
        comment.reactions?.forEach((r: any) => userIds.add(String(r.userId)));
        comment.replies?.forEach((reply: any) => {
          if (reply.userId) userIds.add(String(reply.userId));
          reply.likes?.forEach((id: string) => userIds.add(String(id)));
          reply.reactions?.forEach((r: any) => userIds.add(String(r.userId)));
        });
      });

      const objectIds = Array.from(userIds).map((id) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });

      const users = await User.find({ _id: { $in: objectIds } }).lean();

      const userPicMap = new Map<string, string>();
      const userNameMap = new Map<string, string>();
      users.forEach((u: any) => {
        userPicMap.set(u._id.toString(), u.profilePicUrl || "");
        userNameMap.set(u._id.toString(), u.username || "");
      });

      const getLikedByUsernames = (likes: string[] | undefined): string[] => {
        if (!likes || likes.length === 0) return [];
        return likes
          .map((id) => userNameMap.get(String(id)))
          .filter((name): name is string => !!name);
      };

      const postWithDetails = {
        ...(post as any),
        profilePicUrl: userPicMap.get(String((post as any).userId)) || "",
        likedByUsernames: getLikedByUsernames((post as any).likes),
        reactions: serializeReactions(post),
        comments: (post as any).comments?.map((comment: any) => {
          const commentUserId = String(comment.userId);
          const commentPic = userPicMap.get(commentUserId) || "";
          return {
            ...comment,
            profilePicUrl: commentPic,
            likedByUsernames: getLikedByUsernames(comment.likes),
            reactions: serializeReactions(comment),
            replies: comment.replies?.map((reply: any) => {
              const replyUserId = String(reply.userId);
              const replyPic = userPicMap.get(replyUserId) || "";
              return {
                ...reply,
                profilePicUrl: replyPic,
                likedByUsernames: getLikedByUsernames(reply.likes),
                reactions: serializeReactions(reply),
              };
            }),
          };
        }),
      };

      res.status(200).json(postWithDetails);
    } catch (error) {
      console.error("❌ Error fetching community note by event:", error);
      res.status(500).json({ message: "Failed to fetch post." });
    }
  },
);

router.post("/", async (req: Request, res: Response) => {
  try {
    const { text, userId, username, eventId, eventName, eventType } = req.body;
    if (!text || !userId || !username) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    const user = await User.findById(userId).select("profilePicUrl");
    const profilePicUrl = user?.profilePicUrl || "";

    const newPost = await communityNote.create({
      text,
      userId,
      username,
      profilePicUrl,
      comments: [],
      eventId: eventId || null,
      eventName: eventName || null,
      eventType: eventType || null,
    });

    if (eventId) {
      const event = await Event.findById(eventId);
      if (event) {
        const notifyUserIds = new Set<string>();

        if (event.createdBy && String(event.createdBy) !== userId) {
          notifyUserIds.add(String(event.createdBy));
        }

        if (event.roster && event.roster.length > 0) {
          event.roster.forEach((p: any) => {
            if (p.userId && p.userId !== userId) {
              notifyUserIds.add(p.userId);
            }
          });
        }

        if (notifyUserIds.size > 0) {
          notificationService.sendPushNotificationToMany(
            Array.from(notifyUserIds),
            "New Discussion Post 💬",
            `${username} posted on "${eventName}"`,
            "community_note",
            {
              postId: newPost._id.toString(),
              eventId: eventId,
              eventName: eventName || "",
              posterUsername: username,
            },
          );
        }
      }
    }

    res.status(201).json(newPost);
  } catch (error) {
    res.status(500).json({ message: "Failed to create post." });
  }
});

router.put("/:postId", async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    const post = await communityNote.findById(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found." });
    post.text = text || post.text;
    await post.save();
    res.status(200).json({ text: post.text });
  } catch (error) {
    res.status(500).json({ message: "Failed to edit post." });
  }
});

router.delete("/:postId", async (req: Request, res: Response) => {
  try {
    const post = await communityNote.findByIdAndDelete(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post not found." });
    res.sendStatus(204);
  } catch (error) {
    res.status(500).json({ message: "Failed to delete post." });
  }
});

router.post(
  "/:postId/comments",
  async (req: Request, res: Response) => {
    try {
      const { text, userId, username, replyToPost } = req.body;
      if (!text || !userId || !username) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });

      const user = await User.findById(userId).select("profilePicUrl");
      const profilePicUrl = user?.profilePicUrl || "";

      const comment = {
        text,
        userId,
        username,
        profilePicUrl,
        replies: [],
        replyToPost: !!replyToPost,
      };
      post.comments.push(comment);
      await post.save();

      if (post.userId && post.userId !== userId) {
        notificationService.sendPushNotification({
          userId: post.userId,
          title: "New Comment 💬",
          body: `${username} commented on your post`,
          type: "community_note",
          data: {
            postId: post._id.toString(),
            eventId: post.eventId || "",
            eventName: post.eventName || "",
            commenterUsername: username,
          },
        });
      }

      if (post.eventId) {
        const linkedEvent = await Event.findById(post.eventId);
        if (
          linkedEvent &&
          linkedEvent.createdBy &&
          String(linkedEvent.createdBy) !== userId &&
          String(linkedEvent.createdBy) !== post.userId
        ) {
          notificationService.sendPushNotification({
            userId: String(linkedEvent.createdBy),
            title: "New Comment on Your Event",
            body: `${username} commented on a post about "${linkedEvent.name}"`,
            type: "event_comment",
            data: {
              postId: post._id.toString(),
              eventId: linkedEvent._id.toString(),
              eventName: linkedEvent.name,
            },
          });
        }
      }

      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });
      socketService.emitToAll("events:refresh", { reason: "comment_added" });

      res.status(201).json({ comments: post.comments });
    } catch (error) {
      res.status(500).json({ message: "Failed to add comment." });
    }
  },
);

router.put(
  "/:postId/comments/:commentId",
  async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      comment.text = text || comment.text;
      await post.save();
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });
      res.status(200).json({ text: comment.text });
    } catch (error) {
      res.status(500).json({ message: "Failed to edit comment." });
    }
  },
);

router.delete(
  "/:postId/comments/:commentId",
  async (req: Request, res: Response) => {
    try {
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      post.comments.pull(req.params.commentId);
      await post.save();
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });
      socketService.emitToAll("events:refresh", { reason: "comment_deleted" });
      res.status(200).json({ comments: post.comments });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete comment." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/replies",
  async (req: Request, res: Response) => {
    try {
      const { text, userId, username, replyToUsername, replyToReplyId } =
        req.body;
      if (!text || !userId || !username) {
        return res.status(400).json({ message: "Missing required fields." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });

      const user = await User.findById(userId).select("profilePicUrl");
      const profilePicUrl = user?.profilePicUrl || "";

      comment.replies.push({
        text,
        userId,
        username,
        profilePicUrl,
        replyToUsername: replyToUsername || null,
        replyToReplyId: replyToReplyId || null,
      });
      await post.save();

      if (comment.userId && comment.userId !== userId) {
        notificationService.sendPushNotification({
          userId: comment.userId,
          title: "New Reply 💬",
          body: `${username} replied to your comment`,
          type: "community_note",
          data: {
            postId: post._id.toString(),
            eventId: post.eventId || "",
            eventName: post.eventName || "",
          },
        });
      }

      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });
      res.status(201).json({ replies: comment.replies });
    } catch (error) {
      res.status(500).json({ message: "Failed to add reply." });
    }
  },
);

router.put(
  "/:postId/comments/:commentId/replies/:replyId",
  async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });
      reply.text = text || reply.text;
      await post.save();
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });
      res.status(200).json({ text: reply.text });
    } catch (error) {
      res.status(500).json({ message: "Failed to edit reply." });
    }
  },
);

router.delete(
  "/:postId/comments/:commentId/replies/:replyId",
  async (req: Request, res: Response) => {
    try {
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });
      comment.replies.pull(req.params.replyId);
      await post.save();
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });
      res.status(200).json({ replies: comment.replies });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete reply." });
    }
  },
);

router.post(
  "/:postId/like",
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorId(req);
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });

      const result = toggleReactionOnDoc(post, userId, LIKE_EMOJI);
      if (!result.ok) {
        return res.status(400).json({ message: result.message });
      }
      post.markModified("reactions");
      post.markModified("likes");
      await post.save();

      if (result.added && post.userId && post.userId !== userId) {
        const liker = await User.findById(userId).select("username");
        if (liker) {
          notificationService.sendPushNotification({
            userId: post.userId,
            title: "Your post was liked ❤️",
            body: `${liker.username} liked your discussion post`,
            type: "community_note",
            data: {
              postId: post._id.toString(),
              eventId: post.eventId || "",
              eventName: post.eventName || "",
            },
          });
        }
      }

      const reactions = serializeReactions(post);
      const likerIds = (post.likes || []).map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = (post.likes || [])
        .map((id: string) => {
          const user = likers.find((u: any) => u._id.toString() === String(id));
          return user?.username;
        })
        .filter((name: string | undefined): name is string => !!name);

      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
        likes: post.likes,
        likedByUsernames,
        reactions,
      });

      res.status(200).json({ likes: post.likes, likedByUsernames, reactions });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on post." });
    }
  },
);

router.post(
  "/:postId/react",
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorId(req);
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      if (!isValidEmoji(req.body?.emoji)) {
        return res.status(400).json({ message: "Invalid reaction" });
      }
      const emoji = String(req.body.emoji).trim();

      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });

      const result = toggleReactionOnDoc(post, userId, emoji);
      if (!result.ok) {
        return res.status(400).json({ message: result.message });
      }
      post.markModified("reactions");
      post.markModified("likes");
      await post.save();

      if (result.added && post.userId && String(post.userId) !== userId) {
        const reactor = await User.findById(userId).select("username");
        if (reactor) {
          notificationService.sendPushNotification({
            userId: post.userId,
            title: "Someone reacted to your discussion",
            body: `${reactor.username} reacted ${emoji} to your post`,
            type: "community_note",
            data: {
              postId: post._id.toString(),
              eventId: post.eventId || "",
              eventName: post.eventName || "",
            },
          });
        }
      }

      const reactions = serializeReactions(post);
      const likedByUsernames: string[] = [];
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
        likes: post.likes,
        reactions,
      });

      res.status(200).json({
        reactions,
        likes: post.likes || [],
        likedByUsernames,
      });
    } catch (error) {
      console.error("Failed to toggle post reaction:", error);
      res.status(500).json({ message: "Failed to toggle reaction on post." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/like",
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorId(req);
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });

      const result = toggleReactionOnDoc(comment, userId, LIKE_EMOJI);
      if (!result.ok) {
        return res.status(400).json({ message: result.message });
      }
      comment.markModified("reactions");
      comment.markModified("likes");
      post.markModified("comments");
      await post.save();

      if (result.added && comment.userId && comment.userId !== userId) {
        const liker = await User.findById(userId).select("username");
        if (liker) {
          notificationService.sendPushNotification({
            userId: comment.userId,
            title: "Your comment was liked ❤️",
            body: `${liker.username} liked your comment`,
            type: "community_note",
            data: {
              postId: post._id.toString(),
              eventId: post.eventId || "",
              eventName: post.eventName || "",
            },
          });
        }
      }

      const reactions = serializeReactions(comment);
      const likerIds = (comment.likes || []).map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = (comment.likes || [])
        .map((id: string) => {
          const user = likers.find((u: any) => u._id.toString() === String(id));
          return user?.username;
        })
        .filter((name: string | undefined): name is string => !!name);

      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });

      res.status(200).json({
        likes: comment.likes,
        likedByUsernames,
        reactions,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on comment." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/react",
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorId(req);
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      if (!isValidEmoji(req.body?.emoji)) {
        return res.status(400).json({ message: "Invalid reaction" });
      }
      const emoji = String(req.body.emoji).trim();

      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });

      const result = toggleReactionOnDoc(comment, userId, emoji);
      if (!result.ok) {
        return res.status(400).json({ message: result.message });
      }
      comment.markModified("reactions");
      comment.markModified("likes");
      post.markModified("comments");
      await post.save();

      if (result.added && comment.userId && String(comment.userId) !== userId) {
        const reactor = await User.findById(userId).select("username");
        if (reactor) {
          notificationService.sendPushNotification({
            userId: comment.userId,
            title: "Someone reacted to your comment",
            body: `${reactor.username} reacted ${emoji} to your comment`,
            type: "community_note",
            data: {
              postId: post._id.toString(),
              eventId: post.eventId || "",
              eventName: post.eventName || "",
            },
          });
        }
      }

      const reactions = serializeReactions(comment);
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });

      res.status(200).json({ reactions, likes: comment.likes || [] });
    } catch (error) {
      console.error("Failed to toggle comment reaction:", error);
      res.status(500).json({ message: "Failed to toggle reaction on comment." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/replies/:replyId/like",
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorId(req);
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });

      const result = toggleReactionOnDoc(reply, userId, LIKE_EMOJI);
      if (!result.ok) {
        return res.status(400).json({ message: result.message });
      }
      reply.markModified("reactions");
      reply.markModified("likes");
      post.markModified("comments");
      await post.save();

      if (result.added && reply.userId && reply.userId !== userId) {
        const liker = await User.findById(userId).select("username");
        if (liker) {
          notificationService.sendPushNotification({
            userId: reply.userId,
            title: "Your reply was liked ❤️",
            body: `${liker.username} liked your reply`,
            type: "community_note",
            data: {
              postId: post._id.toString(),
              eventId: post.eventId || "",
              eventName: post.eventName || "",
            },
          });
        }
      }

      const reactions = serializeReactions(reply);
      const likerIds = (reply.likes || []).map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = (reply.likes || [])
        .map((id: string) => {
          const user = likers.find((u: any) => u._id.toString() === String(id));
          return user?.username;
        })
        .filter((name: string | undefined): name is string => !!name);

      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });

      res.status(200).json({
        likes: reply.likes,
        likedByUsernames,
        reactions,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on reply." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/replies/:replyId/react",
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorId(req);
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      if (!isValidEmoji(req.body?.emoji)) {
        return res.status(400).json({ message: "Invalid reaction" });
      }
      const emoji = String(req.body.emoji).trim();

      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });
      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ message: "Reply not found." });

      const result = toggleReactionOnDoc(reply, userId, emoji);
      if (!result.ok) {
        return res.status(400).json({ message: result.message });
      }
      reply.markModified("reactions");
      reply.markModified("likes");
      post.markModified("comments");
      await post.save();

      if (result.added && reply.userId && String(reply.userId) !== userId) {
        const reactor = await User.findById(userId).select("username");
        if (reactor) {
          notificationService.sendPushNotification({
            userId: reply.userId,
            title: "Someone reacted to your reply",
            body: `${reactor.username} reacted ${emoji} to your reply`,
            type: "community_note",
            data: {
              postId: post._id.toString(),
              eventId: post.eventId || "",
              eventName: post.eventName || "",
            },
          });
        }
      }

      const reactions = serializeReactions(reply);
      socketService.emitToEvent(post.eventId || "", "comments:updated", {
        postId: post._id.toString(),
        eventId: post.eventId || "",
        comments: post.comments,
      });

      res.status(200).json({ reactions, likes: reply.likes || [] });
    } catch (error) {
      console.error("Failed to toggle reply reaction:", error);
      res.status(500).json({ message: "Failed to toggle reaction on reply." });
    }
  },
);

export default router;
