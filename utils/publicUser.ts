/**
 * Strip secrets before sending a user document to clients.
 * Mongoose docs and plain objects both supported.
 */
export function toPublicUser(user: any): any {
  if (!user) return user;
  const obj =
    typeof user.toObject === "function"
      ? user.toObject({ virtuals: true })
      : { ...user };
  delete obj.password;
  return obj;
}
