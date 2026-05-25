import mongoose, { Document, Schema } from "mongoose";

// A Group is a named, persistent roster of people the user plans with
// regularly — "the trivia crew," "Friday hockey guys." Used as a one-tap
// invite affordance when creating an event, and (for recurring events) as
// a live audience so adding someone to the group means they get next
// week's standing plan automatically.
//
// Membership is invite-based: anyone with a userId can be added — they
// don't have to be a friend first. Admins manage; regular members can
// only leave (and add others only if a future flag permits).
//
// Privacy controls discoverability: `private` groups are invite-only
// (today's only behavior); `public` groups will be browsable in a future
// discovery surface. The field exists from day one so the data model
// doesn't need a retrofit when the discovery UI ships.

export type GroupRole = "admin" | "member";

export interface IGroupMember {
  userId: string;
  role: GroupRole;
  joinedAt: Date;
}

const GroupMemberSchema: Schema = new Schema(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export interface IGroup extends Document {
  name: string;
  createdBy: string;
  privacy: "private" | "public";
  members: IGroupMember[];
}

const GroupSchema: Schema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    createdBy: { type: String, required: true, index: true },
    privacy: {
      type: String,
      enum: ["private", "public"],
      default: "private",
    },
    members: { type: [GroupMemberSchema], default: [] },
  },
  { timestamps: true },
);

// Compound index used by `GET /groups/mine` — finds all groups a user is
// a member of. Without this, listing groups for a user requires a full
// collection scan as soon as the data grows.
GroupSchema.index({ "members.userId": 1 });

const Group = mongoose.model<IGroup>("Group", GroupSchema);

export default Group;
