"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var crypto = require("crypto");
function generateKey() {
    return crypto.randomBytes(32).toString("hex");
}
console.log(generateKey());
