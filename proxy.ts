/**
 * Every request passes through here.
 *
 * Next 16 calls this `proxy.ts`; it was `middleware.ts` before. It runs on the
 * edge runtime, ahead of every page and route handler, which is what makes it
 * the right place for this: a route added later is private by default rather
 * than private once somebody remembers.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  createSessionToken,
  isPublicPath,
  readSessionToken,
} from "@/lib/auth/session";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    /**
     * Refuse rather than fall open. A missing secret is a misconfiguration, and
     * the safe reading of "I cannot check whether you are allowed in" is no.
     */
    return new NextResponse(
      "AUTH_SECRET is not set, so this application cannot verify sessions. See .env.example.",
      { status: 500 },
    );
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token, secret);

  if (session.valid) {
    const response = NextResponse.next();

    /**
     * Slide the window forward once a session is past halfway.
     *
     * The effect is that anybody using this regularly is never asked to sign in
     * again, while a session left alone still expires. Done here rather than on
     * login because the point is to reward use, not the act of signing in.
     */
    if (session.shouldRenew) {
      response.cookies.set(SESSION_COOKIE, await createSessionToken(secret), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_DURATION_SECONDS,
      });
    }

    return response;
  }

  // An API call wants a status code; a person wants the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
