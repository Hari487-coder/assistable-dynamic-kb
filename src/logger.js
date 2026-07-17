const REDACT = /key|secret|password|token|authorization|connection/i;

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = REDACT.test(k) ? "[redacted]" : v;
  }
  return out;
}

export function createLogger({ write = (s) => process.stdout.write(s + "\n") } = {}) {
  const emit = (level, msg, fields) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields) }));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
