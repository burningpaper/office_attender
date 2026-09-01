import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Office Attendance" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;

  /**
   * Only ever redirect back inside this application. An open redirect here
   * would let a link that looks like ours land somebody on a page that is not.
   */
  const requested = params.next ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col justify-center px-4 py-24">
      <h1 className="text-xl font-semibold tracking-tight">Office attendance</h1>
      <p className="mb-6 mt-1 text-sm text-muted">
        This report contains personal information about named employees. Please sign in.
      </p>
      <LoginForm next={next} />
    </main>
  );
}
