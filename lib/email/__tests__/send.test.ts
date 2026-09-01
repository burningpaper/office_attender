import { afterEach, describe, expect, it, vi } from "vitest";
import { sendBatch, type SendMessage } from "../send";

const options = {
  webhookUrl: "https://n8n.example/webhook/office-attendance-email",
  secret: "s3cret",
  batchId: "batch-1",
  dryRun: false,
};

const message = (id: number, to: string): SendMessage => ({
  employeeId: id,
  to,
  subject: "Office attendance",
  html: "<p>hi</p>",
});

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (body: Record<string, unknown>) => Response) {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return handler(body);
    }),
  );
  return calls;
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("what counts as a successful send", () => {
  it("accepts an explicit ok:true", async () => {
    stubFetch(ok);
    const [outcome] = await sendBatch([message(1, "a@x.com")], options);
    expect(outcome).toMatchObject({ ok: true, employeeId: 1, email: "a@x.com" });
  });

  it("treats an empty 200 as a failure, not a send", async () => {
    // The n8n workflow used to throw inside a Code node, which skipped the
    // respond node and answered 200 with an empty body. Recording that as a
    // send would mean telling someone a message went out when it never did.
    stubFetch(() => new Response("", { status: 200 }));
    const [outcome] = await sendBatch([message(1, "a@x.com")], options);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/empty body/i);
  });

  it("treats ok:false as a failure and keeps the reason", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ ok: false, error: "Not a valid email address: nope" }), {
        status: 400,
      }),
    );
    const [outcome] = await sendBatch([message(1, "nope")], options);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("Not a valid email address: nope");
  });

  it("treats a 500 as a failure", async () => {
    stubFetch(() => new Response("upstream exploded", { status: 500 }));
    const [outcome] = await sendBatch([message(1, "a@x.com")], options);
    expect(outcome.ok).toBe(false);
  });

  it("treats unparseable HTML from a proxy as a failure", async () => {
    stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 200 }));
    const [outcome] = await sendBatch([message(1, "a@x.com")], options);
    expect(outcome.ok).toBe(false);
  });

  it("survives the network being unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const [outcome] = await sendBatch([message(1, "a@x.com")], options);
    expect(outcome).toMatchObject({ ok: false, error: "ECONNREFUSED" });
  });
});

describe("the batch", () => {
  it("returns one outcome per recipient, in order", async () => {
    stubFetch(ok);
    const outcomes = await sendBatch(
      [message(1, "a@x.com"), message(2, "b@x.com"), message(3, "c@x.com")],
      options,
    );
    expect(outcomes.map((o) => o.employeeId)).toEqual([1, 2, 3]);
  });

  it("keeps going after one recipient fails", async () => {
    // Partial failure is the normal case, not an exception.
    stubFetch((body) =>
      body.to === "b@x.com"
        ? new Response(JSON.stringify({ ok: false, error: "bounced" }), { status: 400 })
        : ok(),
    );
    const outcomes = await sendBatch(
      [message(1, "a@x.com"), message(2, "b@x.com"), message(3, "c@x.com")],
      options,
    );
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
  });

  it("sends the secret and the batch id on every call", async () => {
    const calls = stubFetch(ok);
    await sendBatch([message(1, "a@x.com")], options);
    expect(calls[0]).toMatchObject({ batchId: "batch-1", employeeId: 1, dryRun: false });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-office-attendance-secret"]).toBe("s3cret");
  });

  it("passes the dry run flag straight through", async () => {
    const calls = stubFetch(() =>
      new Response(JSON.stringify({ ok: true, dryRun: true }), { status: 200 }),
    );
    const [outcome] = await sendBatch([message(1, "a@x.com")], { ...options, dryRun: true });
    expect(calls[0].dryRun).toBe(true);
    expect(outcome.dryRun).toBe(true);
  });

  it("does nothing at all for an empty list", async () => {
    const calls = stubFetch(ok);
    expect(await sendBatch([], options)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
