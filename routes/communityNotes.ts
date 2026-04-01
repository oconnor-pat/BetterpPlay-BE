import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import communityNote from "../models/communityNote";
import User from "../models/user";
import Event from "../models/event";
import notificationService from "../services/notificationService";
import socketService from "../services/socketService";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const posts = await communityNote.find().lean();
    console.log("📝 Fetched posts count:", posts.length);

    const userIds = new Set<string>();
    posts.forEach((post: any) => {
      if (post.userId) userIds.add(String(post.userId));
      post.likes?.forEach((id: string) => userIds.add(String(id)));
      post.comments?.forEach((comment: any) => {
        if (comment.userId) userIds.add(String(comment.userId));
        comment.likes?.forEach((id: string) => userIds.add(String(id)));
        comment.replies?.forEach((reply: any) => {
          if (reply.userId) userIds.add(String(reply.userId));
          reply.likes?.forEach((id: string) => userIds.add(String(id)));
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
        comments: post.comments?.map((comment: any) => {
          const commentUserId = String(comment.userId);
          const commentPic = userPicMap.get(commentUserId) || "";
          return {
            ...comment,
            profilePicUrl: commentPic,
            likedByUsernames: getLikedByUsernames(comment.likes),
            replies: comment.replies?.map((reply: any) => {
              const replyUserId = String(reply.userId);
              const replyPic = userPicMap.get(replyUserId) || "";
              return {
                ...reply,
                profilePicUrl: replyPic,
                likedByUsernames: getLikedByUsernames(reply.likes),
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
      const post = await communityNote.findOne({ eventId }).lean();

      if (!post) {
        return res
          .status(404)
          .json({ message: "No post found for this event." });
      }

      const userIds = new Set<string>();
      if ((post as any).userId) userIds.add(String((post as any).userId));
      (post as any).likes?.forEach((id: string) => userIds.add(String(id)));
      (post as any).comments?.forEach((comment: any) => {
        if (comment.userId) userIds.add(String(comment.userId));
        comment.likes?.forEach((id: string) => userIds.add(String(id)));
        comment.replies?.forEach((reply: any) => {
          if (reply.userId) userIds.add(String(reply.userId));
          reply.likes?.forEach((id: string) => userIds.add(String(id)));
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
        comments: (post as any).comments?.map((comment: any) => {
          const commentUserId = String(comment.userId);
          const commentPic = userPicMap.get(commentUserId) || "";
          return {
            ...comment,
            profilePicUrl: commentPic,
            likedByUsernames: getLikedByUsernames(comment.likes),
            replies: comment.replies?.map((reply: any) => {
              const replyUserId = String(reply.userId);
              const replyPic = userPicMap.get(replyUserId) || "";
              return {
                ...reply,
                profilePicUrl: replyPic,
                likedByUsernames: getLikedByUsernames(reply.likes),
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
      const { text, userId, username } = req.body;
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
      const { text, userId, username } = req.body;
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
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });

      const likeIndex = post.likes.indexOf(userId);
      if (likeIndex === -1) {
        post.likes.push(userId);
      } else {
        post.likes.splice(likeIndex, 1);
      }
      await post.save();

      if (likeIndex === -1 && post.userId && post.userId !== userId) {
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

      const likerIds = post.likes.map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = post.likes
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
      });

      res.status(200).json({ likes: post.likes, likedByUsernames });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on post." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/like",
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ message: "Missing userId." });
      }
      const post = await communityNote.findById(req.params.postId);
      if (!post) return res.status(404).json({ message: "Post not found." });
      const comment = post.comments.id(req.params.commentId);
      if (!comment)
        return res.status(404).json({ message: "Comment not found." });

      const likeIndex = comment.likes.indexOf(userId);
      if (likeIndex === -1) {
        comment.likes.push(userId);
      } else {
        comment.likes.splice(likeIndex, 1);
      }
      await post.save();

      if (likeIndex === -1 && comment.userId && comment.userId !== userId) {
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

      const likerIds = comment.likes.map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = comment.likes
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

      res.status(200).json({ likes: comment.likes, likedByUsernames });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on comment." });
    }
  },
);

router.post(
  "/:postId/comments/:commentId/replies/:replyId/like",
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
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

      const likeIndex = reply.likes.indexOf(userId);
      if (likeIndex === -1) {
        reply.likes.push(userId);
      } else {
        reply.likes.splice(likeIndex, 1);
      }
      await post.save();

      if (likeIndex === -1 && reply.userId && reply.userId !== userId) {
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

      const likerIds = reply.likes.map((id: string) => {
        try {
          return new mongoose.Types.ObjectId(id);
        } catch {
          return id;
        }
      });
      const likers = await User.find({ _id: { $in: likerIds } })
        .select("username")
        .lean();
      const likedByUsernames = reply.likes
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

      res.status(200).json({ likes: reply.likes, likedByUsernames });
    } catch (error) {
      res.status(500).json({ message: "Failed to toggle like on reply." });
    }
  },
);

export default router;
