import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import User from "../models/user";
import Event from "../models/event";

const router = Router();

router.get("/api/user/isAdmin", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(200).json({ isAdmin: false });
    }

    const dbUser = await User.findById(user.id);
    if (!dbUser) {
      return res.status(200).json({ isAdmin: false });
    }

    res.status(200).json({ isAdmin: dbUser.isAdmin || false });
  } catch (error) {
    console.error("Error checking admin status:", error);
    res.status(200).json({ isAdmin: false });
  }
});

router.put("/users/me/location", async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    if (!currentUser || !currentUser.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const { latitude, longitude } = req.body;

    let location = null;
    if (latitude != null && longitude != null) {
      location = {
        type: "Point" as const,
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
      };
    }

    await User.findByIdAndUpdate(currentUser.id, { location });

    return res
      .status(200)
      .json({ success: true, message: "Location updated successfully" });
  } catch (error) {
    console.error("Failed to update location:", error);
    return res.status(500).json({ message: "Failed to update location" });
  }
});

router.put(
  "/users/me/proximity-visibility",
  async (req: Request, res: Response) => {
    try {
      const currentUser = (req as any).user;
      if (!currentUser || !currentUser.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      const { proximityVisibility } = req.body;
      const allowed = ["public", "friends", "private"];
      if (!allowed.includes(proximityVisibility)) {
        return res.status(400).json({
          message:
            "proximityVisibility must be one of: public, friends, private",
        });
      }

      await User.findByIdAndUpdate(currentUser.id, { proximityVisibility });

      return res.status(200).json({
        success: true,
        message: "Proximity visibility updated successfully",
      });
    } catch (error) {
      console.error("Failed to update proximity visibility:", error);
      return res
        .status(500)
        .json({ message: "Failed to update proximity visibility" });
    }
  },
);

router.get("/users", async (req: Request, res: Response) => {
  try {
    const { search, sport, activity, lat, lng, maxDistance } = req.query;
    const currentUser = (req as any).user;

    const useProximity = lat && lng && maxDistance;

    let users: any[];

    if (useProximity) {
      const maxDistanceMeters = parseFloat(maxDistance as string) * 1609.34;

      const pipeline: any[] = [
        {
          $geoNear: {
            near: {
              type: "Point",
              coordinates: [
                parseFloat(lng as string),
                parseFloat(lat as string),
              ],
            },
            distanceField: "distanceMeters",
            maxDistance: maxDistanceMeters,
            spherical: true,
          },
        },
      ];

      const currentUserId = currentUser?.id
        ? new mongoose.Types.ObjectId(currentUser.id)
        : null;

      const visibilityFilter: any = {
        $or: [
          { proximityVisibility: "public" },
          ...(currentUserId
            ? [
                {
                  proximityVisibility: "friends",
                  friends: currentUserId,
                },
              ]
            : []),
        ],
      };

      if (currentUserId) {
        visibilityFilter._id = { $ne: currentUserId };
      }

      pipeline.push({ $match: visibilityFilter });

      const matchFilter: any = {};
      if (search && typeof search === "string") {
        matchFilter.username = { $regex: search, $options: "i" };
      }
      const activityFilter = activity || sport;
      if (activityFilter && typeof activityFilter === "string") {
        matchFilter.favoriteActivities = activityFilter;
      }
      if (Object.keys(matchFilter).length > 0) {
        pipeline.push({ $match: matchFilter });
      }

      pipeline.push(
        { $addFields: { distance: { $divide: ["$distanceMeters", 1609.34] } } },
        { $project: { distanceMeters: 0, password: 0 } },
      );

      users = await User.aggregate(pipeline);
    } else {
      let filter: any = {};

      if (search && typeof search === "string") {
        filter.username = { $regex: search, $options: "i" };
      }

      const activityFilter = activity || sport;
      if (activityFilter && typeof activityFilter === "string") {
        filter.favoriteActivities = activityFilter;
      }

      users = await User.find(filter).select("-password").lean();
    }

    let currentUserData: any = null;
    if (currentUser && currentUser.id) {
      currentUserData = await User.findById(currentUser.id);
    }

    const usersWithStats = await Promise.all(
      users.map(async (user: any) => {
        const userId = user._id.toString();

        const eventsCreated = await Event.countDocuments({
          createdBy: userId,
        });
        const eventsJoined = await Event.countDocuments({
          "roster.userId": userId,
        });

        let friendStatus = "none";
        if (currentUserData && userId !== currentUser.id) {
          if (currentUserData.friends?.includes(user._id)) {
            friendStatus = "friends";
          } else if (currentUserData.friendRequestsSent?.includes(user._id)) {
            friendStatus = "pending_sent";
          } else if (
            currentUserData.friendRequestsReceived?.includes(user._id)
          ) {
            friendStatus = "pending_received";
          }
        } else if (currentUser && userId === currentUser.id) {
          friendStatus = "self";
        }

        const result: any = {
          _id: user._id,
          name: user.name,
          email: user.email,
          username: user.username,
          profilePicUrl: user.profilePicUrl,
          favoriteActivities: user.favoriteActivities,
          eventsCreated,
          eventsJoined,
          friendStatus,
        };

        if (user.distance != null) {
          result.distance = user.distance;
        }

        if (
          user.location &&
          user.location.coordinates &&
          user.location.coordinates.length === 2
        ) {
          result.longitude = user.location.coordinates[0];
          result.latitude = user.location.coordinates[1];
        }

        return result;
      }),
    );

    return res.status(200).json({ success: true, users: usersWithStats });
  } catch (error) {
    console.error("Failed to fetch users:", error);
    return res.status(500).json({ message: "Failed to fetch users" });
  }
});

router.get("/user/:id", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch user data" });
  }
});

router.put("/user/profile-pic", async (req: Request, res: Response) => {
  const { userId, profilePicUrl } = req.body;

  if (!userId || !profilePicUrl) {
    return res.status(400).json({ error: "Missing userId or profilePicUrl" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    user.profilePicUrl = profilePicUrl;
    await user.save();

    return res
      .status(200)
      .json({ success: true, message: "Profile picture updated successfully" });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update profile picture" });
  }
});

router.get(
  "/user/:id/favorite-activities",
  async (req: Request, res: Response) => {
    try {
      const user = await User.findById(req.params.id).select(
        "favoriteActivities",
      );
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      return res.status(200).json({
        success: true,
        favoriteActivities: user.favoriteActivities || [],
      });
    } catch (error) {
      console.error("Error fetching favorite activities:", error);
      return res
        .status(500)
        .json({ message: "Failed to fetch favorite activities" });
    }
  },
);

router.get("/user/:id/favorite-sports", async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id).select(
      "favoriteActivities",
    );
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({
      success: true,
      favoriteSports: user.favoriteActivities || [],
      favoriteActivities: user.favoriteActivities || [],
    });
  } catch (error) {
    console.error("Error fetching favorite activities:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch favorite activities" });
  }
});

router.put(
  "/user/:id/favorite-activities",
  async (req: Request, res: Response) => {
    try {
      const { favoriteActivities } = req.body;

      if (!Array.isArray(favoriteActivities)) {
        return res
          .status(400)
          .json({ message: "favoriteActivities must be an array" });
      }

      const user = await User.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      user.favoriteActivities = favoriteActivities;
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Favorite activities updated successfully",
        favoriteActivities: user.favoriteActivities,
      });
    } catch (error) {
      console.error("Error updating favorite activities:", error);
      return res
        .status(500)
        .json({ message: "Failed to update favorite activities" });
    }
  },
);

router.put("/user/:id/favorite-sports", async (req: Request, res: Response) => {
  try {
    const { favoriteSports, favoriteActivities } = req.body;
    const activities = favoriteActivities || favoriteSports;

    if (!Array.isArray(activities)) {
      return res
        .status(400)
        .json({ message: "favoriteActivities must be an array" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.favoriteActivities = activities;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Favorite activities updated successfully",
      favoriteSports: user.favoriteActivities,
      favoriteActivities: user.favoriteActivities,
    });
  } catch (error) {
    console.error("Error updating favorite activities:", error);
    return res
      .status(500)
      .json({ message: "Failed to update favorite activities" });
  }
});

export default router;
