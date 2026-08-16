import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { OAuth2Client } from "google-auth-library";
import User, { IUser } from "../models/user";

export type SocialProvider = "apple" | "google";

export type VerifiedSocialIdentity = {
  provider: SocialProvider;
  providerUserId: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
};

const appleJwks = jwksClient({
  jwksUri: "https://appleid.apple.com/auth/keys",
  cache: true,
  rateLimit: true,
});

function getAppleSigningKey(
  header: jwt.JwtHeader,
  callback: (err: Error | null, key?: string) => void,
): void {
  if (!header.kid) {
    callback(new Error("Apple token missing kid"));
    return;
  }
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    callback(null, key?.getPublicKey());
  });
}

function getAppleAudiences(): string[] {
  const fromEnv = (process.env.APPLE_CLIENT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Native Sign in with Apple uses the iOS bundle id as the audience.
  return fromEnv.length > 0 ? fromEnv : ["com.oconnorpat.betterplay"];
}

function getGoogleAudiences(): string[] {
  return (
    process.env.GOOGLE_CLIENT_IDS ||
    [
      process.env.GOOGLE_WEB_CLIENT_ID,
      process.env.GOOGLE_IOS_CLIENT_ID,
      process.env.GOOGLE_ANDROID_CLIENT_ID,
    ]
      .filter(Boolean)
      .join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function verifyAppleIdToken(
  idToken: string,
): Promise<VerifiedSocialIdentity> {
  const audiences = getAppleAudiences();

  const payload = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(
      idToken,
      getAppleSigningKey,
      {
        algorithms: ["RS256"],
        issuer: "https://appleid.apple.com",
        audience: audiences.length === 1 ? audiences[0] : audiences,
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          reject(err || new Error("Invalid Apple identity token"));
          return;
        }
        resolve(decoded);
      },
    );
  });

  if (!payload.sub) {
    throw new Error("Apple token missing subject");
  }

  return {
    provider: "apple",
    providerUserId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified:
      payload.email_verified === true ||
      payload.email_verified === "true",
    name: undefined,
  };
}

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<VerifiedSocialIdentity> {
  const audiences = getGoogleAudiences();
  if (audiences.length === 0) {
    throw new Error(
      "Google Sign-In is not configured (missing GOOGLE_CLIENT_IDS)",
    );
  }

  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: audiences,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error("Invalid Google identity token");
  }

  return {
    provider: "google",
    providerUserId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
  };
}

export async function verifySocialIdToken(
  provider: SocialProvider,
  idToken: string,
): Promise<VerifiedSocialIdentity> {
  if (provider === "apple") {
    return verifyAppleIdToken(idToken);
  }
  return verifyGoogleIdToken(idToken);
}

function sanitizeUsernameBase(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
  return cleaned.length >= 3 ? cleaned : `player${cleaned}`.slice(0, 20);
}

async function allocateUniqueUsername(preferredBase: string): Promise<string> {
  const base = sanitizeUsernameBase(preferredBase);
  for (let i = 0; i < 25; i++) {
    const candidate =
      i === 0 ? base : `${base.slice(0, 14)}${Math.floor(1000 + Math.random() * 9000)}`;
    const existing = await User.findOne({ username: candidate }).select("_id");
    if (!existing) {
      return candidate;
    }
  }
  return `user${Date.now().toString(36)}`;
}

function providerField(provider: SocialProvider): "appleId" | "googleId" {
  return provider === "apple" ? "appleId" : "googleId";
}

/**
 * Find or create a user for a verified Apple/Google identity.
 * Prefer provider id match, then verified email link, then create.
 */
export async function findOrCreateSocialUser(
  identity: VerifiedSocialIdentity,
  fallbackName?: string,
): Promise<{ user: IUser; isNew: boolean }> {
  const field = providerField(identity.provider);
  const byProvider = await User.findOne({ [field]: identity.providerUserId });
  if (byProvider) {
    return { user: byProvider, isNew: false };
  }

  // Apple emails in the identity token are always verified. Google must
  // explicitly mark email_verified.
  const rawEmail = identity.email?.toLowerCase().trim();
  const email =
    rawEmail &&
    (identity.provider === "apple" || identity.emailVerified === true)
      ? rawEmail
      : undefined;

  if (email) {
    const byEmail = await User.findOne({ email });
    if (byEmail) {
      if (!byEmail[field]) {
        byEmail[field] = identity.providerUserId;
      }
      const providers = new Set([
        ...(byEmail.authProviders || []),
        identity.provider,
      ]);
      if (byEmail.password) {
        providers.add("password");
      }
      byEmail.authProviders = [...providers];
      await byEmail.save();
      return { user: byEmail, isNew: false };
    }
  }

  if (!email) {
    // Apple may omit email on subsequent sign-ins; without a prior appleId
    // link we cannot safely create an account.
    throw new Error(
      "EMAIL_REQUIRED: Apple did not return an email. Sign in with the same Apple ID you used originally, or register with email first.",
    );
  }

  const nameSource =
    fallbackName?.trim() ||
    identity.name?.trim() ||
    email.split("@")[0] ||
    "BetterPlay Player";
  const username = await allocateUniqueUsername(email.split("@")[0] || "player");

  const user = await User.create({
    name: nameSource.slice(0, 80),
    email,
    username,
    password: undefined,
    [field]: identity.providerUserId,
    authProviders: [identity.provider],
  });

  return { user, isNew: true };
}
