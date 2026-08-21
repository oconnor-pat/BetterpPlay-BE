import User from "../models/user";
import notificationService, {
  NotificationType,
} from "../services/notificationService";

const MENTION_TOKEN_RE = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{3,20})\b/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Unique usernames mentioned in text (original casing from the match). */
export function extractMentionUsernames(text: string): string[] {
  if (!text) return [];
  const found = new Map<string, string>();
  const re = new RegExp(MENTION_TOKEN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const username = match[1];
    const key = username.toLowerCase();
    if (!found.has(key)) {
      found.set(key, username);
    }
  }
  return [...found.values()];
}

export type ResolvedMention = {
  userId: string;
  username: string;
};

export async function resolveMentionedUsers(
  text: string,
  options?: {
    excludeUserId?: string;
    /** When set, only users in this set are notified (e.g. group members). */
    allowedUserIds?: Set<string> | string[];
  },
): Promise<ResolvedMention[]> {
  const usernames = extractMentionUsernames(text);
  if (!usernames.length) return [];

  const users = await User.find({
    $or: usernames.map((u) => ({
      username: new RegExp(`^${escapeRegex(u)}$`, "i"),
    })),
  })
    .select("_id username")
    .lean();

  const allowed = options?.allowedUserIds
    ? new Set(
        Array.isArray(options.allowedUserIds)
          ? options.allowedUserIds.map(String)
          : [...options.allowedUserIds].map(String),
      )
    : null;

  const out: ResolvedMention[] = [];
  const seen = new Set<string>();
  for (const user of users as Array<{_id: unknown; username?: string}>) {
    const userId = String(user._id);
    if (options?.excludeUserId && userId === String(options.excludeUserId)) {
      continue;
    }
    if (allowed && !allowed.has(userId)) {
      continue;
    }
    if (seen.has(userId)) continue;
    seen.add(userId);
    out.push({
      userId,
      username: user.username || "",
    });
  }
  return out;
}

/**
 * Notify users who were @mentioned in `text`.
 * Prefer this after the primary create/notify path so mention pings
 * don't replace ordinary message notifications — they supplement them
 * when the mentioned user wouldn't otherwise be notified (or to make
 * the mention explicit).
 *
 * For group/DM threads where everyone already gets a message push,
 * still send a mention notification so the body calls out the @.
 * Deduping identical pushes is left to the client; history shows both
 * rows which is fine for v1.
 */
export async function notifyMentions(options: {
  text: string;
  actorId: string;
  actorName: string;
  mentionChannel: "community" | "group" | "dm";
  data: Record<string, string>;
  allowedUserIds?: Set<string> | string[];
  /** Skip users who already received a push for this action. */
  skipUserIds?: Set<string> | string[];
}): Promise<void> {
  const mentioned = await resolveMentionedUsers(options.text, {
    excludeUserId: options.actorId,
    allowedUserIds: options.allowedUserIds,
  });
  if (!mentioned.length) return;

  const skip = options.skipUserIds
    ? new Set(
        Array.isArray(options.skipUserIds)
          ? options.skipUserIds.map(String)
          : [...options.skipUserIds].map(String),
      )
    : new Set<string>();

  const title = "You were mentioned";
  const body = `${options.actorName} mentioned you`;

  await Promise.all(
    mentioned.map((m) => {
      if (skip.has(m.userId)) return Promise.resolve(false);
      return notificationService.sendPushNotification({
        userId: m.userId,
        title,
        body,
        type: "mention" as NotificationType,
        data: {
          ...options.data,
          mentionChannel: options.mentionChannel,
          mentionedUsername: m.username,
        },
      });
    }),
  );
}
