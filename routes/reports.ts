// Reporting users and content, plus the admin queue for reviewing them.
//
// Reports are advisory: filing one doesn't hide anything on its own,
// because a report is an accusation and acting on it is a judgement.
// The client pairs reporting with blocking so a user can protect
// themselves immediately without waiting on review.

import { Router, Request, Response } from "express";
import mongoose from "mongoose";
import Report, {
  reportReasons,
  reportTargets,
  reportStatuses,
  ReportReason,
  ReportStatus,
  ReportTarget,
} from "../models/report";
import User from "../models/user";
import DirectMessage from "../models/directMessage";
import GroupMessage from "../models/groupMessage";
import { requireAdmin } from "../middleware/auth";

const router = Router();

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

// Same person, same target, still unreviewed — filing again shouldn't
// stack up duplicates in the queue for a moderator to wade through.
const DUPLICATE_WINDOW_TARGETS: ReportTarget[] = ["user"];

// Pull a copy of what's being reported so the queue still makes sense
// after the original is deleted. Failure here is non-fatal: a report
// without a snapshot is worse than one with, but better than none.
const captureSnapshot = async (
  target: ReportTarget,
  contentId?: string,
): Promise<string | undefined> => {
  if (!contentId || !isValidObjectId(contentId)) {
    return undefined;
  }
  try {
    if (target === "direct_message") {
      const msg = await DirectMessage.findById(contentId).lean();
      if (!msg) return undefined;
      return (
        (msg as any).text || ((msg as any).imageUrl ? "[photo]" : undefined)
      );
    }
    if (target === "group_message") {
      const msg = await GroupMessage.findById(contentId).lean();
      if (!msg) return undefined;
      return (
        (msg as any).text || ((msg as any).imageUrl ? "[photo]" : undefined)
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
};

// POST /reports
router.post("/reports", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { reportedUserId, target, contentId, reason, details } = req.body || {};

  if (!isValidObjectId(reportedUserId)) {
    return res.status(400).json({ message: "Invalid user" });
  }
  if (String(reportedUserId) === String(userId)) {
    return res.status(400).json({ message: "You can't report yourself" });
  }
  if (!reportTargets.includes(target)) {
    return res.status(400).json({ message: "Invalid report target" });
  }
  if (!reportReasons.includes(reason)) {
    return res.status(400).json({ message: "Invalid reason" });
  }
  if (details != null && typeof details !== "string") {
    return res.status(400).json({ message: "Invalid details" });
  }

  try {
    const reported = await User.findById(reportedUserId).select("_id").lean();
    if (!reported) {
      return res.status(404).json({ message: "User not found" });
    }

    if (DUPLICATE_WINDOW_TARGETS.includes(target as ReportTarget)) {
      const existing = await Report.findOne({
        reporterId: String(userId),
        reportedUserId: String(reportedUserId),
        target,
        status: "open",
      });
      if (existing) {
        // Reported as success: from the reporter's side the outcome is
        // identical, and saying "you already reported this" invites
        // them to wonder whether the first one worked.
        return res.status(200).json({ success: true, duplicate: true });
      }
    }

    await Report.create({
      reporterId: String(userId),
      reportedUserId: String(reportedUserId),
      target,
      contentId: isValidObjectId(contentId) ? String(contentId) : undefined,
      contentSnapshot: await captureSnapshot(
        target as ReportTarget,
        contentId,
      ),
      reason: reason as ReportReason,
      details: typeof details === "string" ? details.slice(0, 1000) : undefined,
      status: "open",
    });

    return res.status(201).json({ success: true });
  } catch (err) {
    console.error("Failed to file report:", err);
    return res.status(500).json({ message: "Failed to submit report" });
  }
});

// GET /admin/reports?status=open — the review queue.
router.get(
  "/admin/reports",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const status = String(req.query.status || "open");
      const filter: any = {};
      if (status !== "all") {
        if (!reportStatuses.includes(status as ReportStatus)) {
          return res.status(400).json({ message: "Invalid status" });
        }
        filter.status = status;
      }

      const reports = await Report.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

      // Hydrate both sides in one query rather than per row.
      const ids = new Set<string>();
      reports.forEach((r) => {
        ids.add(String(r.reporterId));
        ids.add(String(r.reportedUserId));
      });
      const users = await User.find({
        _id: {
          $in: Array.from(ids)
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id)),
        },
      })
        .select("username name profilePicUrl")
        .lean();
      const byId = new Map(users.map((u: any) => [String(u._id), u]));

      const hydrated = reports.map((r) => ({
        _id: String(r._id),
        target: r.target,
        contentId: r.contentId,
        contentSnapshot: r.contentSnapshot,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        moderatorNote: r.moderatorNote,
        reporter: byId.get(String(r.reporterId)) || null,
        reportedUser: byId.get(String(r.reportedUserId)) || null,
        reportedUserId: String(r.reportedUserId),
      }));

      const openCount = await Report.countDocuments({ status: "open" });

      return res
        .status(200)
        .json({ success: true, reports: hydrated, openCount });
    } catch (err) {
      console.error("Failed to list reports:", err);
      return res.status(500).json({ message: "Failed to load reports" });
    }
  },
);

// PATCH /admin/reports/:id — record a verdict.
router.patch(
  "/admin/reports/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const adminId = requireUserId(req, res);
    if (!adminId) return;

    const { status, moderatorNote } = req.body || {};
    if (!reportStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Report not found" });
    }

    try {
      const report = await Report.findById(req.params.id);
      if (!report) {
        return res.status(404).json({ message: "Report not found" });
      }

      report.status = status as ReportStatus;
      report.reviewedBy = String(adminId);
      report.reviewedAt = new Date();
      if (typeof moderatorNote === "string") {
        report.moderatorNote = moderatorNote.slice(0, 1000);
      }
      await report.save();

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Failed to update report:", err);
      return res.status(500).json({ message: "Failed to update report" });
    }
  },
);

export default router;
