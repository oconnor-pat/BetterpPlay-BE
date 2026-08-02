import mongoose, { Document, Schema } from "mongoose";

// What the reporter says is wrong. A fixed list rather than free text so
// reports can be counted and sorted; `details` carries the specifics.
export const reportReasons = [
  "spam",
  "harassment",
  "hate_speech",
  "sexual_content",
  "violence",
  "impersonation",
  "other",
] as const;
export type ReportReason = (typeof reportReasons)[number];

// What was reported. A user report is about the person; the others point
// at a specific piece of content, with `contentId` identifying it.
export const reportTargets = [
  "user",
  "direct_message",
  "group_message",
  "event",
  "community_note",
] as const;
export type ReportTarget = (typeof reportTargets)[number];

export const reportStatuses = [
  "open",
  "reviewed",
  "actioned",
  "dismissed",
] as const;
export type ReportStatus = (typeof reportStatuses)[number];

export interface IReport extends Document {
  reporterId: string;
  reportedUserId: string;
  target: ReportTarget;
  contentId?: string;
  // Snapshot of what was reported, taken at report time. Kept because
  // the original can be deleted — by the author or by us acting on this
  // very report — and a report nobody can read is useless for review.
  contentSnapshot?: string;
  reason: ReportReason;
  details?: string;
  status: ReportStatus;
  reviewedBy?: string;
  reviewedAt?: Date;
  moderatorNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReportSchema: Schema = new Schema(
  {
    reporterId: { type: String, required: true, index: true },
    reportedUserId: { type: String, required: true, index: true },
    target: { type: String, enum: reportTargets, required: true },
    contentId: { type: String },
    contentSnapshot: { type: String, maxlength: 2000 },
    reason: { type: String, enum: reportReasons, required: true },
    details: { type: String, maxlength: 1000 },
    status: { type: String, enum: reportStatuses, default: "open", index: true },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
    moderatorNote: { type: String, maxlength: 1000 },
  },
  { timestamps: true },
);

// The review queue is "open reports, newest first".
ReportSchema.index({ status: 1, createdAt: -1 });

const Report = mongoose.model<IReport>("Report", ReportSchema);

export default Report;
