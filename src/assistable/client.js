/**
 * Turn an Assistable API failure into something the account owner can act on.
 * Verified against the platform source: `Authorization: Bearer` is the only
 * accepted auth header (managed-api-key-auth.ts), and every v3 route runs
 * requireSubAccount, which 400s unless the key resolves to exactly one
 * subaccount or the request carries X-Subaccount-Id (require-scope.ts).
 */
export function explainAssistableError({ status, code, message, network }) {
  if (network) {
    return `Couldn't reach Assistable from this server (${network}). Check your instance has internet access, then try again.`;
  }
  if (code === "subaccount_required" || status === 400) {
    return "Your key covers more than one subaccount, so Assistable needs to know which one to use. Paste your Subaccount / Location ID in the field below and connect again.";
  }
  if (status === 401) {
    return message?.includes("format")
      ? "That doesn't look like a complete Assistable API key. Copy the whole key (it's only shown once when created) and try again."
      : "Assistable didn't recognise this key. It may have been revoked or expired - create a fresh one and paste it here.";
  }
  if (status === 403) {
    return code === "subaccount_forbidden"
      ? "This key isn't allowed to access that subaccount. Check the Subaccount / Location ID, or create the key inside that subaccount."
      : `This key is missing a permission it needs${message ? ` (${message})` : ""}. It needs assistants:list, tools:create and tools:update.`;
  }
  if (status === 404) return "That API address didn't respond as expected. If Assistable gave you a different API URL for your account, set ASSISTABLE_API_BASE on your instance.";
  if (status === 429) return "Assistable is rate-limiting this account right now. Wait a minute and try again.";
  if (status >= 500) return "Assistable's API is having trouble right now (server error). Try again in a few minutes.";
  return message || "Assistable rejected this key.";
}

export class AssistableClient {
  constructor({ apiKey, base = "https://apiv3.createassistants.com", mock = false, logger, fetchImpl = fetch, subAccountId = null }) {
    this.apiKey = apiKey; this.base = base; this.mock = mock; this.logger = logger;
    this.fetchImpl = fetchImpl; this.mockCalls = []; this._mockN = 0;
    this.subAccountId = subAccountId || null;
  }

  async _req(method, path, body) {
    if (this.mock) {
      this.mockCalls.push({ method, path, body });
      this.logger.info("MOCK assistable call", { method, path });
      if (method === "POST" && path === "/v3/tools") return { id: `mock-tool-${++this._mockN}` };
      if (path.startsWith("/v3/assistants")) return [{ id: "mock-assistant-1", name: "Mock Assistant" }];
      return { ok: true };
    }
    // Bearer is the ONLY auth header the v3 API reads; X-Subaccount-Id is how
    // multi-subaccount keys say which subaccount a request targets.
    const doFetch = () => this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...(this.subAccountId ? { "x-subaccount-id": this.subAccountId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let res;
    try {
      res = await doFetch();
    } catch (err) {
      const e = new Error(String(err?.message || err));
      e.network = String(err?.cause?.code || err?.message || "connection failed");
      throw e;
    }
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers?.get?.("retry-after") || 2), 15);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await doFetch();
    }
    const payload = await res.json().catch(() => ({}));
    if (res.status === 409) { const e = new Error("conflict"); e.status = 409; throw e; }
    if (res.status >= 400) {
      const e = new Error(payload?.error?.message || `assistable API ${res.status}`);
      e.status = res.status;
      e.code = payload?.error?.code;
      throw e;
    }
    return payload.data ?? payload;
  }

  listAssistants() { return this._req("GET", "/v3/assistants?limit=100"); }

  /**
   * Probe the connection. Returns {ok} or {ok:false, status, code, reason} -
   * never a bare boolean, because "it failed" is useless to the person who has
   * to fix it.
   */
  async verifyConnection() {
    try {
      const assistants = await this.listAssistants();
      return { ok: true, assistantCount: Array.isArray(assistants) ? assistants.length : 0 };
    } catch (err) {
      return {
        ok: false,
        status: err.status ?? null,
        code: err.code ?? null,
        reason: explainAssistableError({
          status: err.status, code: err.code, message: err.message, network: err.network,
        }),
      };
    }
  }
  async createTool(def) {
    try { return await this._req("POST", "/v3/tools", def); }
    catch (e) {
      if (e.status !== 409) throw e;
      return this._req("POST", "/v3/tools", { ...def, name: `${def.name}-2`.slice(0, 64) });
    }
  }
  getTool(id) { return this._req("GET", `/v3/tools/${id}`); }
  updateTool(id, def) { return this._req("PATCH", `/v3/tools/${id}`, def); }
  deleteTool(id) { return this._req("DELETE", `/v3/tools/${id}`); }
  assignTool(toolId, assistantId) { return this._req("POST", `/v3/tools/${toolId}/assign`, { assistant_id: assistantId }); }
  removeTool(toolId, assistantId) { return this._req("POST", `/v3/tools/${toolId}/remove`, { assistant_id: assistantId }); }
}
