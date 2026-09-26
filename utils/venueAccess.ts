import User from "../models/user";

/**
 * Resolve whether `actorId` may create/edit/delete events for venue brand
 * account `venueUserId` (self or listed staff admin).
 */
export async function canActAsVenue(
  actorId: string,
  venueUserId: string,
): Promise<boolean> {
  if (!actorId || !venueUserId) return false;
  if (String(actorId) === String(venueUserId)) return true;

  const venueUser = await User.findById(venueUserId)
    .select("accountType managedVenue")
    .lean();
  if (!venueUser || (venueUser as any).accountType !== "venue") {
    return false;
  }
  const admins: string[] = Array.isArray(
    (venueUser as any).managedVenue?.adminUserIds,
  )
    ? (venueUser as any).managedVenue.adminUserIds.map(String)
    : [];
  return admins.includes(String(actorId));
}

/** Venue brand account the actor owns, or null. */
export async function getOwnedVenueUser(actorId: string): Promise<any | null> {
  const user = await User.findById(actorId)
    .select("accountType managedVenue username name profilePicUrl")
    .lean();
  if (
    user &&
    (user as any).accountType === "venue" &&
    (user as any).managedVenue?.placeId
  ) {
    return user;
  }
  return null;
}

/**
 * Find venue brand accounts where actor is listed in adminUserIds.
 */
export async function getVenueMembershipsForUser(
  actorId: string,
): Promise<
  Array<{
    venueUserId: string;
    username: string;
    name: string;
    profilePicUrl?: string;
    managedVenue: any;
  }>
> {
  const venues = await User.find({
    accountType: "venue",
    "managedVenue.adminUserIds": actorId,
  })
    .select("username name profilePicUrl managedVenue")
    .lean();

  return (venues || []).map((v: any) => ({
    venueUserId: String(v._id),
    username: v.username,
    name: v.name,
    profilePicUrl: v.profilePicUrl,
    managedVenue: v.managedVenue,
  }));
}

/**
 * Pending invites store staff userIds on the venue's managedVenue.pendingAdminUserIds.
 */
export async function getPendingVenueInvitesForUser(
  actorId: string,
): Promise<
  Array<{
    venueUserId: string;
    username: string;
    name: string;
    profilePicUrl?: string;
    managedVenue: any;
  }>
> {
  const venues = await User.find({
    accountType: "venue",
    "managedVenue.pendingAdminUserIds": actorId,
  })
    .select("username name profilePicUrl managedVenue")
    .lean();

  return (venues || []).map((v: any) => ({
    venueUserId: String(v._id),
    username: v.username,
    name: v.name,
    profilePicUrl: v.profilePicUrl,
    managedVenue: v.managedVenue,
  }));
}
