import { json, type ActionFunctionArgs } from "@remix-run/node";

import { getDefaultClientTokenTtlMs, issueWsAccessToken } from "../lib/access-token.server";

export async function action({ request }: ActionFunctionArgs) {
  const accessPin = (process.env.ACCESS_PIN ?? "").trim();
  const authRequired = accessPin.length > 0;

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!authRequired) {
    return json(
      { authRequired: false, token: "", expiresAt: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  let submittedPin = "";
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { pin?: unknown };
    submittedPin = typeof body.pin === "string" ? body.pin.trim() : "";
  } else {
    const formData = await request.formData();
    const rawPin = formData.get("pin");
    submittedPin = typeof rawPin === "string" ? rawPin.trim() : "";
  }

  if (!submittedPin || submittedPin !== accessPin) {
    return json(
      { error: "Invalid access PIN." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const ttlMs = getDefaultClientTokenTtlMs();
  const token = issueWsAccessToken(accessPin, { audience: "client", ttlMs });

  return json(
    {
      authRequired: true,
      token,
      expiresAt: Date.now() + ttlMs
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
