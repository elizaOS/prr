# Audit: output.log 2026-02-22 20:41 — “Codex starts to work then 401”

**Run:** 2026-02-22 20:41:37 · plugin-jupiter#4  
**Observation:** OpenAI key works at startup (we fetch 111 models); Codex is given the same key but fails with 401 after ~9.4s. So “Codex starts to work and then throws 401.”

---

## Timeline from output.log

| Time (log) | Event |
|------------|--------|
| 20:41:42.851 | **Fetched 111 available OpenAI models** — prr’s process calls the OpenAI API with `config.openaiApiKey` (during setup / `validateAndFilterModels`). So the **same key is valid** for `GET /v1/models` when used by our Node process. |
| 20:42:05.151 | We spawn Codex: key from options (length 164), `OPENAI_API_KEY` set in spawn env, `forced_login_method=api`, no `OPENAI_BASE_URL`. |
| 20:42:05.151 | Codex exec starts (80,048 char prompt). |
| 20:42:14.551 | **~9.4s later** — Codex exits; we see 0 chars output and classify as **401 auth error**. |

So:

- **Startup / prr:** The key **does** work for the standard OpenAI API (list models).
- **Codex child:** Same key in env; after several seconds, Codex fails with 401.

So the 401 is **not** “key missing” and **not** “key invalid for api.openai.com in general.” It happens **inside Codex** after it has started.

---

## Why “starts to work then 401” is consistent

Codex can do **several** API calls in one run, for example:

1. **Initial/auth or model check** — might use `OPENAI_API_KEY` and succeed (or use cached session).
2. **Actual task endpoint** (e.g. `/v1/responses` or a chat/completions-style call) — this call may return 401.

So “starts to work” can mean: Codex process starts, maybe one request succeeds, then a **later** request (different endpoint or different auth path inside Codex) returns 401. That fits “starts to work and then throws 401.”

Possible causes:

1. **Different endpoint**  
   Codex may call e.g. `https://api.openai.com/v1/responses` (or another path). That endpoint might:
   - Require different permissions or product (e.g. only ChatGPT/Codex product, not platform key).
   - Return 401 for this key even though `GET /v1/models` works (e.g. key valid for “models” but not for “responses”).

2. **Codex auth mix**  
   With `forced_login_method=api` we tell Codex to use API key. If Codex still uses a cached ChatGPT session for one request and that session is invalid or not allowed for that endpoint, you could get 401 on that request.

3. **Key type**  
   A 164-char key may be a proxy/aggregator key (e.g. ElizaCloud) that works for `GET /v1/models` but is rejected by the endpoint Codex uses for execution (e.g. `/v1/responses`).

---

## What we know from this run

- Key is passed correctly: `fromParam: "set (length 164)"`, `keyForRunner: "set (length 164)"`, `source: "options"`, `willSetInSpawnEnv: true`.
- Key works in prr: “Fetched 111 available OpenAI models” using the same key.
- Codex runs with that key in env and fails with 401 after ~9.4s.
- So: **failure is inside Codex’s use of the key or choice of endpoint**, not in prr’s passing of the key.

---

## Recommendations

1. **Check Codex’s own logs**  
   Look under `~/.codex/logs` (or path from `log_dir` in Codex config). Find the request that returns 401 (URL, response body). That tells you whether it’s:
   - A different URL (e.g. `/v1/responses`) than `/v1/models`.
   - A different error body (e.g. “invalid key” vs “endpoint not allowed for this key”).

2. **Try a standard OpenAI platform key**  
   If the current key is from an aggregator or non-OpenAI dashboard, try a key created at https://platform.openai.com/api-keys and the same Codex + prr flow. If 401 goes away, the issue is key type/endpoint compatibility.

3. **Startup validation**  
   We now have `validateOpenAIKey` at startup; it uses `GET /v1/models`. So we already fail fast if the key is wrong for that endpoint. In this run the key passed that check (or would have); the 401 is specifically from whatever request Codex makes later (e.g. `/v1/responses`).

4. **Optional: log which URL returned 401**  
   If we ever capture Codex’s stderr and parse it for “url: …” in the 401 message, we could log that URL in our error (e.g. “401 from https://api.openai.com/v1/responses”) so users see which call failed without opening Codex logs.

---

## Summary

- **output.log shows:** Same key works for listing models in prr; Codex receives that key and still gets 401 after ~9.4s.
- **“Starts to work then 401”** fits Codex making more than one request, with the 401 on a later one (e.g. execution endpoint like `/v1/responses`).
- Next step is to inspect Codex’s logs to see the exact URL (and body) for the 401, then either switch key type or report to OpenAI/Codex if that endpoint rejects valid platform keys.
