import { notFound } from "next/navigation";
import { getApp, getHealth, getResources, listReleases } from "@/lib/api";
import { PromotePanel } from "./promote";
import { RollbackPanel } from "./rollback";
import { SubmitPanel } from "./submit";

export const dynamic = "force-dynamic";

export default async function AppDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const app = await getApp(id).catch(() => null);
  if (!app) notFound();

  // Fetched together: an operator looking at an app during an incident wants
  // the whole picture in one render, not three spinners.
  const [resources, releases, health] = await Promise.all([
    getResources(id).catch(() => []),
    listReleases(id).catch(() => []),
    getHealth(id).catch(() => null),
  ]);

  // Taken from the health response rather than recomputed here. The rule has
  // two exclusions that are easy to miss — a failed build still reports an
  // artifact, and a store submission's artifact is an app bundle no phone will
  // open — and a second implementation of it drifts.
  const installable = health?.install ?? null;

  return (
    <>
      <h1>{app.name}</h1>
      <p className="sub">
        <code>{app.id}</code> · {app.backendTier} · {app.deliveryMode}
      </p>

      <div className="card">
        <table>
          <tbody>
            <tr>
              <th>Repository</th>
              <td>{app.repoFullName ?? <span className="pill">not created</span>}</td>
            </tr>
            <tr>
              <th>Firebase project</th>
              <td>
                {app.firebaseProjectId ?? (
                  <span className="pill">pooled — no dedicated project</span>
                )}
              </td>
            </tr>
            <tr>
              <th>GCIP tenant</th>
              <td>{app.gcipTenantId ?? "—"}</td>
            </tr>
            <tr>
              <th>EAS project</th>
              <td>
                {app.easProjectId ?? (
                  // Read off the app's delivery mode rather than assumed. An
                  // adopted repo has no EAS project and is not shell delivery;
                  // labelling it so sent an operator looking for a shell binary
                  // that does not exist.
                  <span className="pill">
                    {app.deliveryMode === "shell" ? "shell delivery" : "not created"}
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Update channel</th>
              <td>
                <code>{app.channel}</code>
              </td>
            </tr>
            <tr>
              <th>Runtime version</th>
              <td>
                <code>{app.runtimeVersion}</code> — OTA updates only reach builds on
                this runtime
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 17, marginTop: 32 }}>Backend</h2>
      <PromotePanel appId={id} tier={app.backendTier} />

      <h2 style={{ fontSize: 17, marginTop: 32 }}>Releases</h2>
      <p className="sub">
        Every publish, newest first. An update reaches installed devices in about a
        minute with no review step, so this is the record that makes undo possible.
      </p>

      <div className="card">
        <strong>Install on a device</strong>
        <br />
        {installable ? (
          <>
            <a href={installable.url}>Download the APK</a>{" "}
            <span className="sub">
              built {new Date(installable.createdAt).toLocaleString()} · runtime{" "}
              {installable.runtimeVersion}
            </span>
            <p className="sub">
              Self-signed and internally distributed, so Android will ask for
              permission to install from an unknown source. Updates after this one
              arrive over the air on the same runtime version — no reinstall.
            </p>
          </>
        ) : (
          <p className="sub">
            No installable build yet. An APK is produced by a native release —
            the first publish, and any later change to dependencies or app config.
            Purely JavaScript changes ship over the air to a build that already
            exists.
          </p>
        )}
      </div>

      <SubmitPanel appId={id} submitting={health?.submitting ?? false} />

      {health ? <RollbackPanel appId={id} health={health} /> : null}

      {releases.length === 0 ? (
        <div className="empty">Nothing published yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Crashes</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id}>
                <td title={r.id}>{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  {r.isRollback ? <span className="pill">rollback</span> : null}{" "}
                  {r.instruction || <span className="sub">—</span>}
                  {r.rolledBackBy ? (
                    <>
                      <br />
                      <span className="sub">undone by {r.rolledBackBy}</span>
                    </>
                  ) : null}
                </td>
                <td>
                  <span className="pill">{r.kind}</span>
                  <br />
                  <span className="sub">rt {r.runtimeVersion}</span>
                </td>
                <td>
                  <span className={`pill ${r.status}`}>{r.status}</span>
                  {r.artifactUrl && r.kind !== "store" ? (
                    <>
                      <br />
                      <a href={r.artifactUrl}>APK</a>
                    </>
                  ) : null}
                </td>
                <td>{r.crashReports > 0 ? r.crashReports : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: 17, marginTop: 32 }}>Provisioned resources</h2>
      <p className="sub">
        The resource ledger. Every external object the platform created, keyed so a
        retried run resumes instead of duplicating.
      </p>

      {resources.length === 0 ? (
        <div className="empty">No resources recorded yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>State</th>
              <th>External id</th>
              <th>Attempts</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.key}>
                <td>
                  <code>{r.kind}</code>
                </td>
                <td>
                  <span className={`pill ${r.state}`}>{r.state}</span>
                  {r.error ? (
                    <>
                      <br />
                      <code>{r.error}</code>
                    </>
                  ) : null}
                </td>
                <td>
                  <code>{r.externalId ?? "—"}</code>
                </td>
                <td>{r.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
