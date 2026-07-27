const RESERVED = new Set(["api", "health", "favicon.ico"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (pathname === "/api/health") {
        return json({ ok: true });
      }

      if (pathname === "/api/links" && request.method === "GET") {
        requireAuth(request, env);
        return json(await listLinks(env));
      }

      if (pathname === "/api/links" && request.method === "POST") {
        requireAuth(request, env);
        const body = await request.json().catch(() => ({}));
        return json(await createLink(body, env));
      }

      if (pathname.startsWith("/api/links/") && request.method === "DELETE") {
        requireAuth(request, env);
        const code = decodeURIComponent(pathname.split("/").pop());
        await env.LINKS.delete(`link:${code}`);
        return json({ ok: true });
      }

      // Public (no admin key) creation, gated by a free counter + paid license.
      if (pathname === "/api/public/links" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const licenseKey = (request.headers.get("X-License-Key") || "").trim();
        await requirePublicQuota(licenseKey, env);
        const created = await createLink(body, env);
        if (!licenseKey) {
          const count = parseInt((await env.LINKS.get("meta:public_count")) || "0", 10);
          await env.LINKS.put("meta:public_count", String(count + 1));
        }
        return json(created);
      }

      // Create a PayMongo Checkout Session for the "unlimited stubs" upgrade.
      if (pathname === "/api/checkout" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        return json(await createCheckoutSession(body, env));
      }

      // Poll the status of a checkout session (paid / pending).
      if (pathname.startsWith("/api/checkout/status/") && request.method === "GET") {
        const sessionId = decodeURIComponent(pathname.split("/").pop());
        const raw = await env.LINKS.get(`session:${sessionId}`);
        return json(raw ? JSON.parse(raw) : { status: "unknown" });
      }

      // PayMongo calls this when a checkout session is paid.
      if (pathname === "/api/webhook/paymongo" && request.method === "POST") {
        return handlePaymongoWebhook(request, env, ctx);
      }

      // Anything else is treated as a short code to redirect.
      const code = pathname.slice(1);
      if (code && !pathname.startsWith("/api/")) {
        const raw = await env.LINKS.get(`link:${code}`);
        if (!raw) {
          return new Response("Stub not found", { status: 404, headers: corsHeaders() });
        }
        const data = JSON.parse(raw);
        data.clicks = (data.clicks || 0) + 1;
        ctx.waitUntil(env.LINKS.put(`link:${code}`, JSON.stringify(data)));
        return Response.redirect(data.longUrl, 302);
      }

      return new Response("stub.li worker is running", { status: 200, headers: corsHeaders() });
    } catch (err) {
      return json({ error: err.message || "Server error" }, err.status || 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_KEY || token !== env.ADMIN_KEY) {
    const e = new Error("Unauthorized");
    e.status = 401;
    throw e;
  }
}

async function listLinks(env) {
  const list = await env.LINKS.list({ prefix: "link:" });
  const links = [];
  for (const key of list.keys) {
    const raw = await env.LINKS.get(key.name);
    if (raw) {
      links.push({ code: key.name.slice(5), ...JSON.parse(raw) });
    }
  }
  links.sort((a, b) => b.createdAt - a.createdAt);
  return links;
}

async function createLink(body, env) {
  const longUrl = (body.longUrl || "").trim();
  let alias = (body.alias || "").trim();

  if (!/^https?:\/\//i.test(longUrl)) {
    const e = new Error("longUrl must start with http:// or https://");
    e.status = 400;
    throw e;
  }

  if (alias) {
    if (RESERVED.has(alias.toLowerCase()) || !/^[a-zA-Z0-9-_]{3,20}$/.test(alias)) {
      const e = new Error("Alias must be 3-20 letters, numbers, - or _ and not a reserved word");
      e.status = 400;
      throw e;
    }
    const existing = await env.LINKS.get(`link:${alias}`);
    if (existing) {
      const e = new Error("That stub is already taken");
      e.status = 409;
      throw e;
    }
  } else {
    do {
      alias = randomCode(6);
    } while (await env.LINKS.get(`link:${alias}`));
  }

  const data = { longUrl, clicks: 0, createdAt: Date.now() };
  await env.LINKS.put(`link:${alias}`, JSON.stringify(data));
  return { code: alias, ...data };
}

function randomCode(len = 6) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// --- PayMongo monetization -------------------------------------------------

async function requirePublicQuota(licenseKey, env) {
  if (licenseKey) {
    const valid = await env.LINKS.get(`license:${licenseKey}`);
    if (valid) return; // paid, unlimited
    const e = new Error("That license key wasn't recognized.");
    e.status = 402;
    throw e;
  }
  const limit = parseInt(env.PUBLIC_FREE_LIMIT || "10", 10);
  const count = parseInt((await env.LINKS.get("meta:public_count")) || "0", 10);
  if (count >= limit) {
    const e = new Error("Free stub limit reached. Upgrade to keep creating stubs.");
    e.status = 402;
    throw e;
  }
}

async function createCheckoutSession(body, env) {
  if (!env.PAYMONGO_SECRET_KEY) {
    const e = new Error("PayMongo isn't configured on this Worker yet.");
    e.status = 500;
    throw e;
  }
  const price = parseInt(env.PRO_PRICE_PHP || "149", 10);
  const successUrl = body.successUrl;
  const cancelUrl = body.cancelUrl || body.successUrl;
  if (!successUrl) {
    const e = new Error("successUrl is required");
    e.status = 400;
    throw e;
  }

  const resp = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + btoa(env.PAYMONGO_SECRET_KEY + ":"),
    },
    body: JSON.stringify({
      data: {
        attributes: {
          send_email_receipt: false,
          show_description: true,
          show_line_items: true,
          description: "stub.li — unlimited stubs upgrade",
          line_items: [
            { name: "stub.li unlimited stubs", amount: price * 100, currency: "PHP", quantity: 1 },
          ],
          payment_method_types: ["gcash", "card", "paymaya"],
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
      },
    }),
  });

  const payload = await resp.json();
  if (!resp.ok) {
    const e = new Error(payload?.errors?.[0]?.detail || "Could not start checkout");
    e.status = resp.status;
    throw e;
  }

  const sessionId = payload.data.id;
  const checkoutUrl = payload.data.attributes.checkout_url;
  await env.LINKS.put(`session:${sessionId}`, JSON.stringify({ status: "pending", createdAt: Date.now() }));
  return { sessionId, checkoutUrl };
}

async function handlePaymongoWebhook(request, env, ctx) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get("Paymongo-Signature") || "";

  const verified = await verifyPaymongoSignature(rawBody, sigHeader, env.PAYMONGO_WEBHOOK_SECRET);
  if (!verified) {
    return new Response("Invalid signature", { status: 401, headers: corsHeaders() });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad payload", { status: 400, headers: corsHeaders() });
  }

  const eventType = event?.data?.attributes?.type || "";
  const resource = event?.data?.attributes?.data;
  const sessionId = resource?.id;
  const payments = resource?.attributes?.payments || [];
  const isPaid = eventType.includes("paid") && payments.some((p) => p?.attributes?.status === "paid");

  if (sessionId && isPaid) {
    let licenseKey = randomCode(4) + "-" + randomCode(4) + "-" + randomCode(4);
    await env.LINKS.put(`license:${licenseKey}`, JSON.stringify({ createdAt: Date.now(), sessionId }));
    await env.LINKS.put(`session:${sessionId}`, JSON.stringify({ status: "paid", licenseKey }));
  }

  // Always 200 quickly so PayMongo doesn't retry a request we've already read.
  return json({ received: true });
}

async function verifyPaymongoSignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  );
  if (!parts.t) return false;

  const signedPayload = parts.t + rawBody;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return computed === parts.te || computed === parts.li;
}
