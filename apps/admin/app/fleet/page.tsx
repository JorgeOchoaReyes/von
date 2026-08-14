import { fleetUpdate, type FleetPlan, type FleetSummary } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Apply one instruction to every app the platform owns.
 *
 * This is the most dangerous button in the console, so it is built as two
 * deliberate steps rather than one. A fleet update runs an agent against every
 * generated repository and pushes to each — the blast radius is the whole
 * customer base, and "which apps would this touch" deserves an answer before
 * the answer is a list of commits.
 *
 * The preview is not decoration: it is the same call with `dryRun`, answered by
 * the control plane, so what it lists is exactly what the run would act on.
 */
export default async function Fleet({
  searchParams,
}: {
  searchParams: Promise<{ instruction?: string; ran?: string }>;
}) {
  const { instruction = "", ran } = await searchParams;

  let plan: FleetPlan | null = null;
  let summary: FleetSummary | null = null;
  let error: string | null = null;

  if (instruction) {
    try {
      const result = await fleetUpdate(instruction, ran !== "1");
      if (ran === "1") summary = result as FleetSummary;
      else plan = result as FleetPlan;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  return (
    <>
      <h1>Fleet update</h1>
      <p className="sub">
        One instruction, applied to every app. This is how a blueprint fix or a
        dependency bump reaches apps that already exist — the template only shapes
        apps created <em>after</em> it changed, so without this every existing app
        silently drifts.
      </p>

      {/* GET, so the instruction lives in the URL: a preview is shareable and
          re-runnable, and refreshing never re-applies anything. */}
      <form method="GET" className="card">
        <textarea
          name="instruction"
          defaultValue={instruction}
          rows={3}
          placeholder="e.g. bump expo-updates to ~0.27.0"
          style={{ width: "100%" }}
        />
        <button type="submit" className="primary" style={{ marginTop: 10 }}>
          Preview affected apps
        </button>
      </form>

      {error ? <div className="empty">{error}</div> : null}

      {plan ? (
        <>
          <h2 style={{ fontSize: 17, marginTop: 28 }}>
            {plan.wouldUpdate.length} app{plan.wouldUpdate.length === 1 ? "" : "s"} would
            be updated
          </h2>
          {plan.skipped > 0 ? (
            <p className="sub">
              {plan.skipped} skipped — still provisioning, so they have no repository
              to edit. They will be generated from the current blueprint anyway.
            </p>
          ) : null}

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Repository</th>
                </tr>
              </thead>
              <tbody>
                {plan.wouldUpdate.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <a href={`/apps/${a.id}`}>{a.name}</a>
                    </td>
                    <td>
                      <code>{a.repo ?? "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {plan.wouldUpdate.length > 0 ? (
            <form method="GET" style={{ marginTop: 16 }}>
              <input type="hidden" name="instruction" value={instruction} />
              <input type="hidden" name="ran" value="1" />
              <button type="submit" className="danger">
                Apply to {plan.wouldUpdate.length} app
                {plan.wouldUpdate.length === 1 ? "" : "s"}
              </button>
              <p className="sub" style={{ marginTop: 8 }}>
                Each app is previewed and published in one step — there is no
                per-app review. It stops after 5 failures rather than repeating a
                systemic error across the whole fleet.
              </p>
            </form>
          ) : null}
        </>
      ) : null}

      {summary ? (
        <>
          <h2 style={{ fontSize: 17, marginTop: 28 }}>Done</h2>
          <p className="sub">
            {summary.succeeded} succeeded, {summary.failed} failed, out of{" "}
            {summary.total}.
          </p>
          {summary.results?.length ? (
            <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {summary.results.map((r) => (
                  <tr key={r.appId}>
                    <td>
                      <a href={`/apps/${r.appId}`}>
                        <code>{r.appId}</code>
                      </a>
                    </td>
                    <td>
                      <span className={`pill ${r.status}`}>{r.status}</span>
                      {r.error ? (
                        <>
                          <br />
                          <code className="clamp">{r.error}</code>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
