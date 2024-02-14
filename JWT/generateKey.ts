import * as crypto from "crypto";

function generateKey() {
  return crypto.randomBytes(32).toString("hex");
}

console.log(generateKey());
