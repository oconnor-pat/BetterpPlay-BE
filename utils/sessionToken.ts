import jwt from "jsonwebtoken";

/** Session tokens expire; password change still bumps tokenVersion to revoke early. */
export const SESSION_JWT_EXPIRES_IN = "30d";

export function getJwtSecret(): string {
  return process.env.JWT_SECRET!;
}

export function signSessionToken(user: {
  _id?: any;
  tokenVersion?: number;
}): string {
  return jwt.sign(
    { id: user._id, tokenVersion: user.tokenVersion || 0 },
    getJwtSecret(),
    { expiresIn: SESSION_JWT_EXPIRES_IN },
  );
}
