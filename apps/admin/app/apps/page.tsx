import Link from "next/link";
import { listApps } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const apps = await listApps().catch(() => [] as Awaited<ReturnType<typeof listApps>>);

  if (apps.length === 0) {
    return (
      <>
        <h1>Apps</h1>
        <p className="sub">Nothing here yet.</p>
        <div className="empty">
          No apps. Start the control plane and create one from the chat app, or{" "}
          <code>POST /v1/apps</code>.
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Apps</h1>
      <p className="sub">{apps.length} total</p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Tier</th>
            <th>Delivery</th>
            <th>Channel</th>
            <th>Runtime</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id}>
              <td>
                <Link href={`/apps/${a.id}`}>{a.name}</Link>
                <br />
                <code>{a.id}</code>
              </td>
              <td>
                <span className="pill">{a.backendTier}</span>
              </td>
              <td>
                <span className="pill">{a.deliveryMode}</span>
              </td>
              <td>
                <code>{a.channel}</code>
              </td>
              <td>
                <code>{a.runtimeVersion}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
