export default {
  async email(message, env, ctx) {
    const from = message.headers.get("from") || message.from || "";
    const shouldPost = /system@spohabi\.com/i.test(from);

    if (!shouldPost) {
      if (env.FORWARD_NON_SPOHABI_TO) {
        await message.forward(env.FORWARD_NON_SPOHABI_TO);
      }
      return;
    }

    const rawEmailBase64 = await streamToBase64(message.raw);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await hmacSignature(env.INBOUND_EMAIL_HMAC_SECRET, timestamp, rawEmailBase64);
    const response = await fetch(env.CLOUD_RUN_EMAIL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spohabi-email-timestamp": timestamp,
        "x-spohabi-email-signature": signature
      },
      body: JSON.stringify({
        source: "cloudflare_email_worker",
        receivedAt: new Date().toISOString(),
        rawEmailBase64
      })
    });

    if (!response.ok) {
      throw new Error(`Cloud Run email endpoint failed: ${response.status}`);
    }

    if (env.FORWARD_SPOHABI_TO) {
      ctx.waitUntil(message.forward(env.FORWARD_SPOHABI_TO));
    }
  }
};

async function streamToBase64(stream) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function hmacSignature(secret, timestamp, rawEmailBase64) {
  if (!secret) throw new Error("INBOUND_EMAIL_HMAC_SECRET is required");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawEmailBase64}`));
  return `sha256=${hex(new Uint8Array(signature))}`;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
