const encoder = new TextEncoder();
// Keep the default within the Workers Free plan's 10 ms CPU limit.
// Each message stores its own iteration count, so older messages remain readable.
const ITERATIONS = 20000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

function base64(bytes) {
  let result = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(result);
}

function fromBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeAgentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function timestampId(date) {
  const stamp = date.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
  const random = hex(crypto.getRandomValues(new Uint8Array(6)));
  return { stamp, id: `msg-${stamp}-${random}` };
}

async function encryptText(plainText, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plainText),
  );
  return {
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt_b64: base64(salt),
    iv_b64: base64(iv),
    ciphertext_b64: base64(new Uint8Array(encrypted)),
  };
}

async function decryptText(record, password) {
  const cryptoInfo = record.crypto;
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromBase64(cryptoInfo.salt_b64),
      iterations: Number(cryptoInfo.iterations),
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(cryptoInfo.iv_b64) },
    key,
    fromBase64(record.ciphertext_b64),
  );
  return new TextDecoder().decode(decrypted);
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function readGitHubJson(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodedPath(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-relay-worker",
      },
    });
  } catch (error) {
    return { ok: false, status: 502, details: `GitHub request failed: ${String(error).slice(0, 160)}` };
  }
  if (!response.ok) {
    let details = "GitHub returned an error";
    try {
      const errorBody = await response.json();
      if (typeof errorBody.message === "string") details = errorBody.message.slice(0, 160);
    } catch {
      // Keep the generic message when GitHub does not return JSON.
    }
    return { ok: false, status: response.status, details };
  }
  return { ok: true, data: await response.json() };
}

async function writeGitHubFile(env, path, contents, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodedPath(path)}`;
  const body = {
    message,
    content: base64(encoder.encode(contents)),
    branch: env.GITHUB_BRANCH || "main",
  };
  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ai-relay-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 502, details: `GitHub request failed: ${String(error).slice(0, 160)}` };
  }
  if (!response.ok) {
    let details = "GitHub returned an error";
    try {
      const errorBody = await response.json();
      if (typeof errorBody.message === "string") details = errorBody.message.slice(0, 160);
    } catch {
      // Keep the generic message when GitHub does not return JSON.
    }
    return { ok: false, status: response.status, details };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "ai-relay-writer" });
    }
    if (request.method === "GET" && url.pathname === "/read") {
      if (!env.RELAY_PASSWORD || !env.GITHUB_TOKEN) {
        return json({ error: "worker secrets are not configured" }, 500);
      }
      const suppliedPassword = request.headers.get("X-Relay-Password");
      if (suppliedPassword !== env.RELAY_PASSWORD) return json({ error: "invalid relay password" }, 401);
      const recipient = url.searchParams.get("agent_id") || "cloud-chatgpt-01";
      const conversationId = url.searchParams.get("conversation_id");
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "10", 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 20) : 10;
      if (!safeAgentId(recipient)) return json({ error: "invalid agent_id" }, 400);

      const root = await readGitHubJson(env, "messages");
      if (!root.ok) return json({ error: "GitHub read failed", status: root.status, details: root.details }, 502);
      const directories = Array.isArray(root.data)
        ? root.data.filter((entry) => entry.type === "dir" && safeAgentId(entry.name))
        : [];
      const messages = [];
      for (const directory of directories) {
        const listing = await readGitHubJson(env, `messages/${directory.name}`);
        if (!listing.ok || !Array.isArray(listing.data)) continue;
        const files = listing.data.filter((entry) => entry.type === "file" && entry.name.endsWith(".json"));
        for (const file of files) {
          const item = await readGitHubJson(env, `messages/${directory.name}/${file.name}`);
          if (!item.ok || !item.data || typeof item.data.content !== "string") continue;
          let record;
          try {
            record = JSON.parse(new TextDecoder().decode(fromBase64(item.data.content)));
          } catch {
            continue;
          }
          if (!Array.isArray(record.to) || (!record.to.includes(recipient) && !record.to.includes("broadcast"))) continue;
          if (conversationId && record.conversation_id !== conversationId) continue;
          try {
            messages.push({
              id: record.id,
              from: record.from,
              to: record.to,
              conversation_id: record.conversation_id,
              type: record.type,
              created_at: record.created_at,
              content: await decryptText(record, env.RELAY_PASSWORD),
            });
          } catch {
            // Ignore malformed or incompatible messages and continue the scan.
          }
        }
      }
      messages.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      return json({ ok: true, agent_id: recipient, conversation_id: conversationId, messages: messages.slice(-limit) });
    }
    if (request.method !== "POST" || url.pathname !== "/write") {
      return json({ error: "use POST /write, GET /read, or GET /health" }, 404);
    }
    if (!env.RELAY_PASSWORD || !env.GITHUB_TOKEN) {
      return json({ error: "worker secrets are not configured" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "request body must be JSON" }, 400);
    }

    const suppliedPassword = request.headers.get("X-Relay-Password") || body.password;
    if (suppliedPassword !== env.RELAY_PASSWORD) return json({ error: "invalid relay password" }, 401);
    if (!safeAgentId(body.agent_id)) return json({ error: "invalid agent_id" }, 400);
    if (typeof body.content !== "string" || body.content.length === 0 || body.content.length > 100000) {
      return json({ error: "content must be 1-100000 characters" }, 400);
    }
    const recipients = Array.isArray(body.to) ? body.to : [body.to || "broadcast"];
    if (!recipients.every((value) => value === "broadcast" || safeAgentId(value))) {
      return json({ error: "invalid recipient" }, 400);
    }

    const createdAt = new Date();
    const { stamp, id } = timestampId(createdAt);
    const encrypted = await encryptText(body.content, env.RELAY_PASSWORD);
    const record = {
      version: 1,
      id,
      from: body.agent_id,
      to: recipients,
      conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : null,
      type: typeof body.type === "string" ? body.type : "task",
      created_at: createdAt.toISOString(),
      crypto: {
        algorithm: encrypted.algorithm,
        kdf: encrypted.kdf,
        iterations: encrypted.iterations,
        salt_b64: encrypted.salt_b64,
        iv_b64: encrypted.iv_b64,
      },
      ciphertext_b64: encrypted.ciphertext_b64,
    };
    const path = `messages/${body.agent_id}/${stamp}-${id.slice(-12)}.json`;
    const result = await writeGitHubFile(env, path, JSON.stringify(record, null, 2), `relay: ${body.agent_id} ${id}`);
    if (!result.ok) return json({ error: "GitHub write failed", status: result.status, details: result.details }, 502);
    return json({ ok: true, id, path, created_at: record.created_at });
  },
};
