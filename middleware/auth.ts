import { Request, Response } from "express";
import User from "../models/user";

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: Function,
) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const dbUser = await User.findById(user.id);
    if (!dbUser) {
      return res.status(401).json({ message: "User not found" });
    }

    if (!dbUser.isAdmin) {
      return res.status(403).json({ message: "Admin access required" });
    }

    next();
  } catch (error) {
    console.error("Admin auth error:", error);
    return res.status(500).json({ message: "Authentication error" });
  }
};
