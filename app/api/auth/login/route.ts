import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  constantTimeEquals,
  createSessionToken,
} from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * A wrong password should not answer instantly.
 *
 * This is not rate limiting - serverless functions have nowhere shared to count
 * attempts - but it does turn a fast guessing loop into a slow one, and it costs
 * an honest person a fifth of a second once a day.
 */
const WRONG_PASSWORD_DELAY_MS = 200;

export async function POST(request: Request) {
  const password = process.env.APP_PASSWORD;
  const secret = process.env.AUTH_SECRET;

  if (!password || !secret) {
    return NextResponse.json(
      { error: "APP_PASSWORD and AUTH_SECRET must be set. See .env.example." },
      { status: 500 },
    );
  }

  let submitted = "";
  try {
    const body = await request.json();
    submitted = typeof body.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (!constantTimeEquals(submitted, password)) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
    return NextResponse.json({ error: "That password is not right." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, await createSessionToken(secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
  return response;
}
