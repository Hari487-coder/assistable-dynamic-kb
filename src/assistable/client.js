export class AssistableClient {
  constructor({ apiKey, base = "https://apiv3.createassistants.com", mock = false, logger, fetchImpl = fetch }) {
    this.apiKey = apiKey; this.base = base; this.mock = mock; this.logger = logger;
    this.fetchImpl = fetchImpl; this.mockCalls = []; this._mockN = 0;
  }

  async _req(method, path, body) {
    if (this.mock) {
      this.mockCalls.push({ method, path, body });
      this.logger.info("MOCK assistable call", { method, path });
      if (method === "POST" && path === "/v3/tools") return { id: `mock-tool-${++this._mockN}` };
      if (path.startsWith("/v3/assistants")) return [{ id: "mock-assistant-1", name: "Mock Assistant" }];
      return { ok: true };
    }
    const doFetch = () => this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let res = await doFetch();
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers?.get?.("retry-after") || 2), 15);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await doFetch();
    }
    const payload = await res.json().catch(() => ({}));
    if (res.status === 409) { const e = new Error("conflict"); e.status = 409; throw e; }
    if (res.status >= 400) {
      const e = new Error(payload?.error?.message || `assistable API ${res.status}`);
      e.status = res.status; throw e;
    }
    return payload.data ?? payload;
  }

  listAssistants() { return this._req("GET", "/v3/assistants?limit=100"); }
  async verifyKey() { try { await this.listAssistants(); return true; } catch { return false; } }
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
