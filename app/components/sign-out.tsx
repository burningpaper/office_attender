"use client";

export function SignOut() {
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.href = "/login";
      }}
      className="rounded border border-border-soft px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-border-strong hover:text-foreground"
    >
      Sign out
    </button>
  );
}
