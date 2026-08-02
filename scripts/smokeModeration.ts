// End-to-end smoke test for blocking, reporting and undo-decline.
//
// Runs against a live local server (npm run dev) using the same HTTP
// surface the app uses, so it exercises auth, routing and the block
// filters together rather than calling the models directly.
//
//   npx ts-node scripts/smokeModeration.ts
//
// Creates its own throwaway users and removes them at the end.

import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import User from "../models/user";
import Block from "../models/block";
import Report from "../models/report";
import Conversation from "../models/conversation";

dotenv.config();

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:8001";
const PASSWORD = "SmokeTest123!";
const stamp = Date.now();

const tag = (name: string) => `smoke_mod_${name}_${stamp}`;

let passed = 0;
let failed = 0;

const check = (label: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`, extra ?? "");
  }
};

interface Res {
  status: number;
  body: any;
}

const request = async (
  method: string,
  path: string,
  opts: {token?: string; body?: unknown} = {},
): Promise<Res> => {
  const headers: Record<string, string> = {"Content-Type": "application/json"};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return {status: res.status, body};
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI as string);

  const hashed = await bcrypt.hash(PASSWORD, 10);
  const mk = async (name: string, isAdmin = false) =>
    User.create({
      name: `Smoke ${name}`,
      email: `${tag(name)}@example.com`,
      username: tag(name),
      password: hashed,
      isAdmin,
    });

  console.log(`\nCreating test users (${BASE})`);
  const alice = await mk("alice");
  const bob = await mk("bob");
  const admin = await mk("admin", true);

  const login = async (u: any) => {
    const res = await request("POST", "/auth/login", {
      body: {username: u.username, password: PASSWORD},
    });
    if (!res.body?.token) {
      throw new Error(
        `Login failed for ${u.username}: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body.token as string;
  };

  const aliceT = await login(alice);
  const bobT = await login(bob);
  const adminT = await login(admin);
  const aliceId = String(alice._id);
  const bobId = String(bob._id);

  try {
    // ── Undo decline ────────────────────────────────────────────────
    console.log("\nUndo decline");
    const open = await request("POST", "/dm/conversations", {
      token: bobT,
      body: {userId: aliceId},
    });
    const convId = open.body?.conversation?._id;
    check("bob opens a thread with alice", !!convId, open.body);

    await request("POST", `/dm/conversations/${convId}/messages`, {
      token: bobT,
      body: {text: "hey, pickup hockey friday?"},
    });

    const requests = await request("GET", "/dm/requests", {token: aliceT});
    check(
      "lands in alice's requests",
      (requests.body?.requests || []).some((c: any) => c._id === convId),
      requests.body,
    );

    const declined = await request(
      "POST",
      `/dm/conversations/${convId}/decline`,
      {token: aliceT},
    );
    check("alice declines", declined.status === 200, declined.body);

    const afterDecline = await request("GET", "/dm/requests", {token: aliceT});
    check(
      "gone from requests after declining",
      !(afterDecline.body?.requests || []).some((c: any) => c._id === convId),
    );

    const declinedList = await request("GET", "/dm/declined", {token: aliceT});
    check(
      "appears in alice's declined list",
      (declinedList.body?.declined || []).some((c: any) => c._id === convId),
      declinedList.body,
    );

    const undo = await request("POST", `/dm/conversations/${convId}/accept`, {
      token: aliceT,
    });
    check("alice undoes the decline", undo.status === 200, undo.body);

    const inbox = await request("GET", "/dm/conversations", {token: aliceT});
    check(
      "thread moves into the real inbox",
      (inbox.body?.conversations || []).some((c: any) => c._id === convId),
      inbox.body,
    );

    const declinedAfterUndo = await request("GET", "/dm/declined", {
      token: aliceT,
    });
    check(
      "no longer in the declined list",
      !(declinedAfterUndo.body?.declined || []).some(
        (c: any) => c._id === convId,
      ),
    );

    // ── Reporting ───────────────────────────────────────────────────
    console.log("\nReporting");
    const report = await request("POST", "/reports", {
      token: aliceT,
      body: {reportedUserId: bobId, target: "user", reason: "harassment"},
    });
    check("alice reports bob", report.status === 201, report.body);

    const dupe = await request("POST", "/reports", {
      token: aliceT,
      body: {reportedUserId: bobId, target: "user", reason: "harassment"},
    });
    check(
      "duplicate report collapses instead of stacking",
      dupe.status === 200 && dupe.body?.duplicate === true,
      dupe.body,
    );

    const selfReport = await request("POST", "/reports", {
      token: aliceT,
      body: {reportedUserId: aliceId, target: "user", reason: "spam"},
    });
    check("can't report yourself", selfReport.status === 400, selfReport.body);

    const badReason = await request("POST", "/reports", {
      token: aliceT,
      body: {reportedUserId: bobId, target: "user", reason: "not_a_reason"},
    });
    check("rejects an unknown reason", badReason.status === 400);

    const nonAdminQueue = await request("GET", "/admin/reports", {
      token: aliceT,
    });
    check(
      "non-admin can't read the queue",
      nonAdminQueue.status === 403,
      nonAdminQueue.status,
    );

    const queue = await request("GET", "/admin/reports?status=open", {
      token: adminT,
    });
    const mine = (queue.body?.reports || []).find(
      (r: any) => r.reportedUserId === bobId,
    );
    check("admin sees the report, both sides hydrated", !!mine?.reporter, queue.body);

    const decided = await request("PATCH", `/admin/reports/${mine?._id}`, {
      token: adminT,
      body: {status: "dismissed", moderatorNote: "smoke test"},
    });
    check("admin records a verdict", decided.status === 200, decided.body);

    // ── Blocking ────────────────────────────────────────────────────
    console.log("\nBlocking");
    const selfBlock = await request("POST", `/users/${aliceId}/block`, {
      token: aliceT,
    });
    check("can't block yourself", selfBlock.status === 400);

    const block = await request("POST", `/users/${bobId}/block`, {
      token: aliceT,
    });
    check("alice blocks bob", block.status === 200, block.body);

    const twice = await request("POST", `/users/${bobId}/block`, {
      token: aliceT,
    });
    check("blocking twice is a no-op", twice.status === 200, twice.body);

    const status = await request("GET", `/users/${bobId}/block-status`, {
      token: aliceT,
    });
    check("block status reads true for alice", status.body?.blocked === true);

    const reverseStatus = await request("GET", `/users/${aliceId}/block-status`, {
      token: bobT,
    });
    check(
      "block status stays false for bob (he isn't told)",
      reverseStatus.body?.blocked === false,
      reverseStatus.body,
    );

    const convAfterBlock = await Conversation.findById(convId);
    check(
      "the DM thread is closed by the block",
      convAfterBlock?.status === "declined",
      convAfterBlock?.status,
    );

    const bobSendsAfterBlock = await request(
      "POST",
      `/dm/conversations/${convId}/messages`,
      {token: bobT, body: {text: "still there?"}},
    );
    check(
      "bob can't send into the blocked thread",
      bobSendsAfterBlock.status === 403,
      bobSendsAfterBlock.status,
    );

    const aliceReopen = await request("POST", "/dm/conversations", {
      token: aliceT,
      body: {userId: bobId},
    });
    check(
      "alice is told she blocked him rather than hitting a dead end",
      aliceReopen.status === 403 && aliceReopen.body?.code === "blocked_by_me",
      aliceReopen.body,
    );

    const bobReopen = await request("POST", "/dm/conversations", {
      token: bobT,
      body: {userId: aliceId},
    });
    check(
      "bob gets the deleted-account response, not a block confirmation",
      bobReopen.status === 404,
      bobReopen.status,
    );

    const bobViewsAlice = await request("GET", `/user/${aliceId}`, {
      token: bobT,
    });
    check(
      "alice's profile reads as missing to bob",
      bobViewsAlice.status === 404,
      bobViewsAlice.status,
    );

    const aliceViewsBob = await request("GET", `/user/${bobId}`, {
      token: aliceT,
    });
    check(
      "alice sees an unblockable state on bob's profile",
      aliceViewsBob.status === 403 &&
        aliceViewsBob.body?.code === "blocked_by_me",
      aliceViewsBob.body,
    );

    const search = await request("GET", `/users?search=${tag("bob")}`, {
      token: aliceT,
    });
    check(
      "bob is absent from alice's search",
      !(search.body?.users || []).some((u: any) => String(u._id) === bobId),
      search.body?.users?.length,
    );

    const reverseSearch = await request("GET", `/users?search=${tag("alice")}`, {
      token: bobT,
    });
    check(
      "alice is absent from bob's search too (symmetric)",
      !(reverseSearch.body?.users || []).some(
        (u: any) => String(u._id) === aliceId,
      ),
    );

    const friendReq = await request("POST", `/users/${bobId}/friend-request`, {
      token: aliceT,
    });
    check(
      "friend requests are refused across a block",
      friendReq.status === 404,
      friendReq.status,
    );

    const undoBlocked = await request(
      "POST",
      `/dm/conversations/${convId}/accept`,
      {token: aliceT},
    );
    check(
      "can't undo a decline while the block stands",
      undoBlocked.status === 403 && undoBlocked.body?.code === "blocked",
      undoBlocked.body,
    );

    // ── Unblocking ──────────────────────────────────────────────────
    console.log("\nUnblocking");
    const list = await request("GET", "/users/me/blocked", {token: aliceT});
    check(
      "bob is on alice's blocked list",
      (list.body?.blocked || []).some((b: any) => b.userId === bobId),
      list.body,
    );

    const unblock = await request("DELETE", `/users/${bobId}/block`, {
      token: aliceT,
    });
    check("alice unblocks bob", unblock.status === 200, unblock.body);

    const listAfter = await request("GET", "/users/me/blocked", {token: aliceT});
    check(
      "blocked list is empty again",
      !(listAfter.body?.blocked || []).some((b: any) => b.userId === bobId),
    );

    const searchAfter = await request("GET", `/users?search=${tag("bob")}`, {
      token: aliceT,
    });
    check(
      "bob is discoverable again",
      (searchAfter.body?.users || []).some((u: any) => String(u._id) === bobId),
    );

    const profileAfter = await request("GET", `/user/${bobId}`, {
      token: aliceT,
    });
    check("bob's profile loads again", profileAfter.status === 200);

    const undoAfter = await request(
      "POST",
      `/dm/conversations/${convId}/accept`,
      {token: aliceT},
    );
    check(
      "the thread can be reopened once unblocked",
      undoAfter.status === 200,
      undoAfter.body,
    );
  } finally {
    console.log("\nCleaning up");
    const ids = [alice._id, bob._id, admin._id];
    const strIds = ids.map(String);
    await Promise.all([
      User.deleteMany({_id: {$in: ids}}),
      Block.deleteMany({
        $or: [{blockerId: {$in: strIds}}, {blockedId: {$in: strIds}}],
      }),
      Report.deleteMany({
        $or: [{reporterId: {$in: strIds}}, {reportedUserId: {$in: strIds}}],
      }),
      Conversation.deleteMany({participants: {$in: strIds}}),
    ]);
    await mongoose.disconnect();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  }
};

main().catch(async err => {
  console.error("Smoke test crashed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
