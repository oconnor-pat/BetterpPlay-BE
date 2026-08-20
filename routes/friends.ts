import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import User from "../models/user";
import Event from "../models/event";
import notificationService from "../services/notificationService";
import blockService from "../services/blockService";

const { getHiddenUserIds, isBlockedBetween } = blockService;

const router = Router();

router.get("/users/me/friends", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const currentUser = await User.findById(user.id)
      .populate("friends", "-password")
      .select("friends");

    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Blocking already unfriends both sides, so this is a backstop: the
    // two updates aren't in a transaction, and a stale friendship
    // surviving a block is the one failure mode worth being defensive
    // about here.
    const hiddenIds = await blockService.getHiddenUserIds(String(user.id));
    const visibleFriends = (currentUser.friends as any[]).filter(
      (friend: any) => !hiddenIds.has(String(friend._id)),
    );

    const friendsWithStats = await Promise.all(
      visibleFriends.map(async (friend: any) => {
        const eventsCreated = await Event.countDocuments({
          createdBy: friend._id.toString(),
        });
        const eventsJoined = await Event.countDocuments({
          "roster.userId": friend._id.toString(),
        });

        return {
          _id: friend._id,
          name: friend.name,
          username: friend.username,
          profilePicUrl: friend.profilePicUrl,
          favoriteActivities: friend.favoriteActivities,
          eventsCreated,
          eventsJoined,
        };
      }),
    );

    return res.status(200).json({ success: true, friends: friendsWithStats });
  } catch (error) {
    console.error("Failed to fetch friends:", error);
    return res.status(500).json({ message: "Failed to fetch friends" });
  }
});

router.delete(
  "/users/me/friends/:friendId",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { friendId } = req.params;

      await User.findByIdAndUpdate(user.id, {
        $pull: { friends: friendId },
      });

      await User.findByIdAndUpdate(friendId, {
        $pull: { friends: user.id },
      });

      return res.status(200).json({ success: true, message: "Friend removed" });
    } catch (error) {
      console.error("Failed to remove friend:", error);
      return res.status(500).json({ message: "Failed to remove friend" });
    }
  },
);

router.post(
  "/users/:userId/friend-request",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      if (userId === user.id) {
        return res
          .status(400)
          .json({ message: "Cannot send friend request to yourself" });
      }

      const targetUser = await User.findById(userId);
      if (!targetUser) {
        return res.status(404).json({ message: "User not found" });
      }

      // Blocked in either direction: reads as a missing account rather
      // than a refusal, so the request can't be used to probe whether
      // someone has blocked you.
      if (await blockService.isBlockedBetween(String(user.id), String(userId))) {
        return res.status(404).json({ message: "User not found" });
      }

      const currentUser = await User.findById(user.id);
      if (!currentUser) {
        return res.status(404).json({ message: "Current user not found" });
      }

      if (currentUser.friends.includes(userId as any)) {
        return res.status(400).json({ message: "Already friends" });
      }

      if (currentUser.friendRequestsSent.includes(userId as any)) {
        return res.status(400).json({ message: "Friend request already sent" });
      }

      if (currentUser.friendRequestsReceived.includes(userId as any)) {
        await User.findByIdAndUpdate(user.id, {
          $push: { friends: userId },
          $pull: { friendRequestsReceived: userId },
        });
        await User.findByIdAndUpdate(userId, {
          $push: { friends: user.id },
          $pull: { friendRequestsSent: user.id },
        });

        notificationService.sendPushNotification({
          userId: userId,
          title: "Friend Request Accepted",
          body: `${currentUser.username} accepted your friend request`,
          type: "friend_accepted",
          data: {
            accepterId: user.id,
            accepterUsername: currentUser.username,
          },
        });

        return res.status(200).json({
          success: true,
          message: "Friend request accepted",
          status: "friends",
        });
      }

      await User.findByIdAndUpdate(user.id, {
        $addToSet: { friendRequestsSent: userId },
      });

      await User.findByIdAndUpdate(userId, {
        $addToSet: { friendRequestsReceived: user.id },
      });

      notificationService.sendPushNotification({
        userId: userId,
        title: "New Friend Request",
        body: `${currentUser.username} sent you a friend request`,
        type: "friend_request",
        data: {
          senderId: user.id,
          senderUsername: currentUser.username,
        },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request sent" });
    } catch (error) {
      console.error("Failed to send friend request:", error);
      return res.status(500).json({ message: "Failed to send friend request" });
    }
  },
);

router.get(
  "/users/me/friend-requests/incoming",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const currentUser = await User.findById(user.id)
        .populate("friendRequestsReceived", "-password")
        .select("friendRequestsReceived");

      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const requests = (currentUser.friendRequestsReceived as any[]).map(
        (requester: any) => ({
          _id: requester._id,
          name: requester.name,
          username: requester.username,
          profilePicUrl: requester.profilePicUrl,
          favoriteActivities: requester.favoriteActivities,
        }),
      );

      return res.status(200).json({ success: true, requests });
    } catch (error) {
      console.error("Failed to fetch incoming friend requests:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch friend requests" });
    }
  },
);

router.get(
  "/users/me/friend-requests/outgoing",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const currentUser = await User.findById(user.id)
        .populate("friendRequestsSent", "-password")
        .select("friendRequestsSent");

      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const requests = (currentUser.friendRequestsSent as any[]).map(
        (recipient: any) => ({
          _id: recipient._id,
          name: recipient.name,
          username: recipient.username,
          profilePicUrl: recipient.profilePicUrl,
          favoriteActivities: recipient.favoriteActivities,
        }),
      );

      return res.status(200).json({ success: true, requests });
    } catch (error) {
      console.error("Failed to fetch outgoing friend requests:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch friend requests" });
    }
  },
);

router.post(
  "/users/me/friend-requests/:userId/accept",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      const currentUser = await User.findById(user.id);
      if (!currentUser) {
        return res.status(404).json({ message: "User not found" });
      }

      if (!currentUser.friendRequestsReceived.includes(userId as any)) {
        return res
          .status(400)
          .json({ message: "No friend request from this user" });
      }

      await User.findByIdAndUpdate(user.id, {
        $push: { friends: userId },
        $pull: { friendRequestsReceived: userId },
      });

      await User.findByIdAndUpdate(userId, {
        $push: { friends: user.id },
        $pull: { friendRequestsSent: user.id },
      });

      notificationService.sendPushNotification({
        userId: userId,
        title: "Friend Request Accepted",
        body: `${currentUser.username} accepted your friend request`,
        type: "friend_accepted",
        data: {
          accepterId: user.id,
          accepterUsername: currentUser.username,
        },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request accepted" });
    } catch (error) {
      console.error("Failed to accept friend request:", error);
      return res
        .status(500)
        .json({ message: "Failed to accept friend request" });
    }
  },
);

router.post(
  "/users/me/friend-requests/:userId/decline",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      await User.findByIdAndUpdate(user.id, {
        $pull: { friendRequestsReceived: userId },
      });

      await User.findByIdAndUpdate(userId, {
        $pull: { friendRequestsSent: user.id },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request declined" });
    } catch (error) {
      console.error("Failed to decline friend request:", error);
      return res
        .status(500)
        .json({ message: "Failed to decline friend request" });
    }
  },
);

router.delete(
  "/users/me/friend-requests/:userId/cancel",
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { userId } = req.params;

      await User.findByIdAndUpdate(user.id, {
        $pull: { friendRequestsSent: userId },
      });

      await User.findByIdAndUpdate(userId, {
        $pull: { friendRequestsReceived: user.id },
      });

      return res
        .status(200)
        .json({ success: true, message: "Friend request cancelled" });
    } catch (error) {
      console.error("Failed to cancel friend request:", error);
      return res
        .status(500)
        .json({ message: "Failed to cancel friend request" });
    }
  },
);

router.get("/users/:userId/friend-status", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const { userId } = req.params;

    if (userId === user.id) {
      return res.status(200).json({ success: true, status: "self" });
    }

    const currentUser = await User.findById(user.id);
    if (!currentUser) {
      return res.status(404).json({ message: "User not found" });
    }

    let status = "none";

    if (currentUser.friends.includes(userId as any)) {
      status = "friends";
    } else if (currentUser.friendRequestsSent.includes(userId as any)) {
      status = "pending_sent";
    } else if (currentUser.friendRequestsReceived.includes(userId as any)) {
      status = "pending_received";
    }

    return res.status(200).json({ success: true, status });
  } catch (error) {
    console.error("Failed to get friend status:", error);
    return res.status(500).json({ message: "Failed to get friend status" });
  }
});

// Mutual friends between the viewer and another user (count + small preview).
router.get(
  "/users/:userId/mutual-friends",
  async (req: Request, res: Response) => {
    try {
      const viewer = (req as any).user;
      if (!viewer?.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const targetId = String(req.params.userId);
      if (String(viewer.id) === targetId) {
        return res.status(200).json({ success: true, count: 0, friends: [] });
      }

      if (await isBlockedBetween(String(viewer.id), targetId)) {
        return res.status(404).json({ message: "User not found" });
      }

      const [viewerUser, targetUser] = await Promise.all([
        User.findById(viewer.id).select("friends").lean(),
        User.findById(targetId).select("friends").lean(),
      ]);
      if (!viewerUser || !targetUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const viewerFriends = new Set(
        ((viewerUser as any).friends || []).map((id: any) => String(id)),
      );
      const mutualIds = ((targetUser as any).friends || [])
        .map((id: any) => String(id))
        .filter((id: string) => viewerFriends.has(id));

      const hidden = await getHiddenUserIds(String(viewer.id));
      const visibleMutualIds = mutualIds.filter(
        (id: string) =>
          id &&
          id !== String(viewer.id) &&
          id !== targetId &&
          !hidden.has(id),
      );

      const previewLimit = 8;
      const previewIds = visibleMutualIds.slice(0, previewLimit);
      const objectIds = previewIds
        .filter((id: string) => mongoose.Types.ObjectId.isValid(id))
        .map((id: string) => new mongoose.Types.ObjectId(id));

      const previewUsers =
        objectIds.length > 0
          ? await User.find({ _id: { $in: objectIds } })
              .select("username name profilePicUrl")
              .lean()
          : [];

      const byId = new Map(
        (previewUsers as any[]).map((u) => [String(u._id), u]),
      );
      const friends = previewIds
        .map((id: string) => byId.get(id))
        .filter(Boolean)
        .map((u: any) => ({
          _id: String(u._id),
          username: u.username,
          name: u.name,
          profilePicUrl: u.profilePicUrl,
        }));

      return res.status(200).json({
        success: true,
        count: visibleMutualIds.length,
        friends,
      });
    } catch (error) {
      console.error("Failed to fetch mutual friends:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch mutual friends" });
    }
  },
);

export default router;
