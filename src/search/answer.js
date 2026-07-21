import { searchStructured } from "./structured.js";
import { searchText } from "./text.js";
import { buildToolResponse } from "./respond.js";

/**
 * The one place a question becomes an answer.
 *
 * The live webhook, the portal's "Try it", and the daily answer checks all come
 * through here. That matters most for the checks: a replay that walked its own
 * code path would be testing a fiction, and would stay green while real callers
 * got errors.
 *
 * `structured` may be passed in when the caller has already computed it (the
 * webhook does, because conversational follow-ups merge in filters remembered
 * from earlier in the same call - state a replay must not have).
 */
export function answerQuery(db, source, args, { startedAt = Date.now(), structured = null } = {}) {
  if (source.type === "website") {
    return buildToolResponse({ source, textResult: searchText(db, source, args.query), args, tookMs: Date.now() - startedAt });
  }
  return buildToolResponse({
    source,
    structured: structured ?? searchStructured(db, source, args),
    args,
    tookMs: Date.now() - startedAt,
  });
}
