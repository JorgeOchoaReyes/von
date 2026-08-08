import { notFound } from "next/navigation";
import { getApp, getResources } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AppDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const app = await getApp(id).catch(() => null);
  if (!app) notFound();

  const resources = await getResources(id).catch(() => []);

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
              <td>{app.easProjectId ?? <span className="pill">shell delivery</span>}</td>
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
