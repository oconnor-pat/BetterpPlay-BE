import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import AWS from "aws-sdk";
import { body, validationResult } from "express-validator";
import nodemailer from "nodemailer";
import User from "../models/user";
import Event from "../models/event";
import communityNote from "../models/communityNote";

const router = Router();

function getJwtSecret(): string {
  return process.env.JWT_SECRET!;
}

function getS3(): AWS.S3 {
  return new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });
}

router.post(
  "/auth/register",
  [
    body("name").notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { name, email, username, password } = req.body;

      const emailAlreadyExists = await User.findOne({ email });
      const usernameAlreadyExists = await User.findOne({ username });

      if (emailAlreadyExists) {
        return res
          .status(400)
          .json({ status: 400, message: "Email already in use" });
      }

      if (usernameAlreadyExists) {
        return res
          .status(400)
          .json({ status: 400, message: "Username already in use" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = await User.create({
        name,
        email,
        username,
        password: hashedPassword,
      });

      const token = jwt.sign(
        { id: newUser._id, tokenVersion: newUser.tokenVersion },
        getJwtSecret(),
      );
      return res.status(201).json({ success: true, user: newUser, token });
    } catch (error) {
      console.error("Error in /auth/register:", error);
      res
        .status(500)
        .json({ message: "Failed to create a new user. Please try again" });
    }
  },
);

router.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const token = jwt.sign(
      { id: user._id, tokenVersion: user.tokenVersion },
      getJwtSecret(),
    );
    return res.status(200).json({ success: true, user, token });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to process the login request" });
  }
});

router.get("/auth/validate", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, getJwtSecret()) as {
      id: string;
      tokenVersion?: number;
    };

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (
      decoded.tokenVersion !== undefined &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Token has been invalidated. Please log in again.",
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        profilePicUrl: user.profilePicUrl,
      },
    });
  } catch (error) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

router.put("/auth/change-password", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, getJwtSecret()) as { id: string };

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current and new password are required",
      });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const passwordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    const newToken = jwt.sign(
      { id: user._id, tokenVersion: user.tokenVersion },
      getJwtSecret(),
    );

    return res.status(200).json({
      success: true,
      message:
        "Password changed successfully. All other sessions have been logged out.",
      token: newToken,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to change password" });
  }
});

router.post("/auth/forgot-password", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an account exists, a reset email has been sent",
      });
    }

    const resetToken = jwt.sign(
      { id: user._id, purpose: "password-reset" },
      getJwtSecret(),
      { expiresIn: "1h" },
    );

    const transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    const baseUrl =
      process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "BetterPlay - Reset Your Password",
      html: `
        <h2>Password Reset Request</h2>
        <p>You requested to reset your password. Click the link below to set a new password:</p>
        <a href="${resetLink}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px;">Reset Password</a>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });

    return res.status(200).json({
      success: true,
      message: "If an account exists, a reset email has been sent",
    });
  } catch (error: any) {
    console.error("Error in forgot-password:", error);
    console.error("Email error details:", error?.message, error?.code);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/reset-password", (req: Request, res: Response) => {
  const { token } = req.query;
  const deepLink = `betterplay://reset-password?token=${token}`;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reset Password - BetterPlay</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, sans-serif; text-align: center; padding: 50px 20px; background: #1a1a2e; color: #fff; }
        .btn { display: inline-block; padding: 14px 28px; background: #10B981; color: #fff; text-decoration: none; border-radius: 8px; font-size: 17px; font-weight: 600; margin-top: 20px; }
        p { color: #aaa; margin-top: 16px; }
      </style>
    </head>
    <body>
      <h2>Reset Your Password</h2>
      <p>Tap the button below to open BetterPlay and reset your password.</p>
      <a href="${deepLink}" class="btn">Open BetterPlay</a>
      <p style="font-size: 13px; margin-top: 30px;">If the app doesn't open, make sure BetterPlay is installed on your device.</p>
      <script>
        // Attempt automatic redirect via JavaScript (more reliable than meta refresh)
        window.location.href = "${deepLink}";
      </script>
    </body>
    </html>
  `);
});

router.post("/auth/reset-password", async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Token and new password required" });
    }

    const decoded = jwt.verify(token, getJwtSecret()) as {
      id: string;
      purpose: string;
    };

    if (decoded.purpose !== "password-reset") {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return res
      .status(200)
      .json({ success: true, message: "Password reset successful" });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res
        .status(400)
        .json({ success: false, message: "Reset link has expired" });
    }
    return res
      .status(400)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

router.get("/auth/user-data", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    let token = authHeader;
    if (authHeader.toLowerCase().startsWith("bearer")) {
      token = authHeader.replace(/^bearer:?\s*/i, "").trim();
    }

    if (!token || token === "null" || token === "undefined") {
      return res.status(401).json({
        success: false,
        message: "No valid token provided. Please log in again.",
      });
    }

    const decoded = jwt.verify(token, getJwtSecret()) as {
      id: string;
      tokenVersion?: number;
    };

    const user = await User.findById(decoded.id).select("-password");
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (
      decoded.tokenVersion !== undefined &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Token has been invalidated. Please log in again.",
      });
    }

    const userId = user._id.toString();
    const username = user.username;

    const [eventsCreated, eventsJoined, communityNotes, userComments] =
      await Promise.all([
        Event.find({ createdBy: userId }),
        Event.find({ "roster.username": username }),
        communityNote.find({ userId: userId }),
        communityNote.find({
          $or: [
            { "comments.userId": userId },
            { "comments.replies.userId": userId },
          ],
        }),
      ]);

    const userCommentsAndReplies: any[] = [];
    userComments.forEach((note: any) => {
      note.comments?.forEach((comment: any) => {
        if (comment.userId === userId) {
          userCommentsAndReplies.push({
            type: "comment",
            noteId: note._id,
            commentId: comment._id,
            text: comment.text,
            createdAt: comment.createdAt,
            likes: comment.likes?.length || 0,
          });
        }
        comment.replies?.forEach((reply: any) => {
          if (reply.userId === userId) {
            userCommentsAndReplies.push({
              type: "reply",
              noteId: note._id,
              commentId: comment._id,
              replyId: reply._id,
              text: reply.text,
              createdAt: reply.createdAt,
              likes: reply.likes?.length || 0,
            });
          }
        });
      });
    });

    const userData = {
      exportDate: new Date().toISOString(),
      profile: {
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        profilePicUrl: user.profilePicUrl,
        createdAt: (user as any).createdAt,
        updatedAt: (user as any).updatedAt,
      },
      eventsCreated: eventsCreated.map((event: any) => ({
        id: event._id,
        name: event.name,
        location: event.location,
        date: event.date,
        time: event.time,
        eventType: event.eventType,
        totalSpots: event.totalSpots,
        rosterSpotsFilled: event.rosterSpotsFilled,
        roster: event.roster,
        createdAt: event.createdAt,
      })),
      eventsJoined: eventsJoined
        .filter((event: any) => String(event.createdBy) !== userId)
        .map((event: any) => ({
          id: event._id,
          name: event.name,
          location: event.location,
          date: event.date,
          time: event.time,
          eventType: event.eventType,
          createdBy: event.createdByUsername,
          joinedAt: event.roster?.find((p: any) => p.username === username),
        })),
      communityPosts: communityNotes.map((note: any) => ({
        id: note._id,
        text: note.text,
        likes: note.likes?.length || 0,
        commentsCount: note.comments?.length || 0,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
      commentsAndReplies: userCommentsAndReplies,
      statistics: {
        totalEventsCreated: eventsCreated.length,
        totalEventsJoined: eventsJoined.filter(
          (e: any) => String(e.createdBy) !== userId,
        ).length,
        totalCommunityPosts: communityNotes.length,
        totalComments: userCommentsAndReplies.filter(
          (c) => c.type === "comment",
        ).length,
        totalReplies: userCommentsAndReplies.filter((c) => c.type === "reply")
          .length,
      },
    };

    return res.status(200).json({
      success: true,
      data: userData,
    });
  } catch (error) {
    console.error("Error fetching user data:", error);
    if (error instanceof jwt.JsonWebTokenError) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired token" });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch user data" });
  }
});

router.delete("/auth/delete-account", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    console.log("Delete account - Auth header:", authHeader);

    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }

    let token = authHeader;
    if (authHeader.toLowerCase().startsWith("bearer")) {
      token = authHeader.replace(/^bearer:?\s*/i, "").trim();
    }

    console.log(
      "Delete account - Extracted token (first 20 chars):",
      token.substring(0, 20),
    );

    if (!token || token === "null" || token === "undefined") {
      return res.status(401).json({
        success: false,
        message: "No valid token provided. Please log in again.",
      });
    }

    const decoded = jwt.verify(token, getJwtSecret()) as {
      id: string;
      tokenVersion?: number;
    };

    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (
      decoded.tokenVersion !== undefined &&
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({
        success: false,
        message: "Token has been invalidated. Please log in again.",
      });
    }

    const userId = user._id.toString();
    const username = user.username;

    if (user.profilePicUrl) {
      try {
        const url = new URL(user.profilePicUrl);
        const key = url.pathname.substring(1);
        await getS3()
          .deleteObject({
            Bucket: process.env.AWS_S3_BUCKET_NAME || "",
            Key: key,
          })
          .promise();
      } catch (s3Error) {
        console.error("Error deleting profile picture from S3:", s3Error);
      }
    }

    await Event.deleteMany({ createdBy: userId });

    await Event.updateMany(
      { "roster.username": username },
      {
        $pull: { roster: { username: username } },
        $inc: { rosterSpotsFilled: -1 },
      },
    );

    await communityNote.deleteMany({ userId: userId });

    await communityNote.updateMany(
      { "comments.userId": userId },
      { $pull: { comments: { userId: userId } } },
    );

    await communityNote.updateMany(
      { "comments.replies.userId": userId },
      { $pull: { "comments.$[].replies": { userId: userId } } },
    );

    await communityNote.updateMany(
      { likes: userId },
      { $pull: { likes: userId } },
    );
    await communityNote.updateMany(
      { "comments.likes": userId },
      { $pull: { "comments.$[].likes": userId } },
    );
    await communityNote.updateMany(
      { "comments.replies.likes": userId },
      { $pull: { "comments.$[].replies.$[].likes": userId } },
    );

    await User.findByIdAndDelete(userId);

    return res.status(200).json({
      success: true,
      message: "Account and all associated data have been permanently deleted.",
    });
  } catch (error) {
    console.error("Error deleting account:", error);
    if (error instanceof jwt.JsonWebTokenError) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired token" });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete account" });
  }
});

export default router;
