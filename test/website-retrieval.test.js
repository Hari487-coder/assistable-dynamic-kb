import { test, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { openDb } from "../src/db.js";
import { searchText } from "../src/search/text.js";
import { expandToken } from "../src/search/normalize.js";

// A realistic small-business page: the answer to "same-day repair?" sits deep
// in the text, well past the old 300-char cutoff, and is phrased as "on the
// spot" rather than "same-day". These are exactly the two failures a tenant
// reported for website retrieval.
const PAGE_BODY = [
  "Riverside Phone Clinic has served the high street since 2009.",
  "Our workshop is upstairs, above the coffee shop, with step-free access from the rear.",
  "We are a family business and we take pride in honest, unhurried work.",
  "Most cracked screens are fixed on the spot while you wait, usually within the hour.",
  "Batteries, charging ports and cameras are also same-visit for the common models.",
  "We accept cash and all major cards, and there is free customer parking behind the building.",
].join(" ");

let db, source;
before(() => {
  db = openDb(":memory:");
  db.prepare(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('u1','a@b.c','h','2026-01-01')`).run();
  db.prepare(`INSERT INTO sources (id,user_id,type,name,config_ct,secret,status,active_batch_id,column_meta_json,last_sync_at,schedule_minutes,created_at)
              VALUES ('w1','u1','website','Clinic site','ct','sec','active','b1','[]',?,1440,'2026-01-01')`)
    .run(new Date().toISOString());
  const ins = db.prepare("INSERT INTO items (id,source_id,batch_id,title,body,structured_json) VALUES (?,?,?,?,?,?)");
  ins.run(crypto.randomUUID(), "w1", "b1", "About Riverside Phone Clinic",
    `About Riverside Phone Clinic ${PAGE_BODY}`, "{}");
  source = db.prepare("SELECT * FROM sources WHERE id='w1'").get();
});

test("the returned snippet contains the matched answer, not the head of the page", () => {
  const r = searchText(db, source, "do you fix screens the same day");
  assert.ok(r.resultCount >= 1);
  const snip = r.items[0].snippet.toLowerCase();
  assert.ok(/on the spot|within the hour|same-visit/.test(snip),
    `snippet must carry the answer, got: ${r.items[0].snippet}`);
  // The old bug returned the first 300 chars, which start "About ... served the
  // high street since 2009 ... family business" - none of which answers it.
  assert.ok(!snip.startsWith("about riverside phone clinic has served"),
    "must not just return the top of the page");
});

test("paraphrase gap closes: 'same-day' matches 'on the spot / same-visit' via synonyms", () => {
  const group = expandToken("today");
  assert.ok(group.includes("spot") && group.includes("same-day"),
    "the today/same-day/spot group must exist");
  const r = searchText(db, source, "same-day repair");
  assert.ok(r.resultCount >= 1, "a same-day question must find the on-the-spot line");
});

test("parking and payment questions resolve through the FAQ synonyms", () => {
  assert.ok(searchText(db, source, "is there parking").resultCount >= 1);
  assert.ok(searchText(db, source, "can I pay by card").resultCount >= 1);
});
