import { revalidatePath } from "next/cache";
import { rollbackApp } from "@/lib/api";
import type { ReleaseHealth } from "@/lib/api";

/**
 * The undo button, and the reasons it might not be one.
 *
 * A server action rather than a client component: the API key lives on the
 * server and must stay there, so the click posts a form and the request is made
 * from the console's own process. It also means this page needs no JavaScript to
 * work, which for an operator tool during an incident is the right trade.
 *
 * The refusal is rendered as prominently as the button. "You cannot undo this,
 * and here is why" is more useful during an incident than a disabled control
 * with no explanation — especially when the reason ("that was a native build")
 * tells you what to do instead.
 */
export function RollbackPanel({ appId, health }: { appId: string; health: ReleaseHealth }) {
  async function act(formData: FormData): Promise<void> {
    "use server";
    const id = String(formData.get("appId"));
    await rollbackApp(id);
    // The release list and health both change; re-render from the control
    // plane rather than guessing the new state locally.
    revalidatePath(`/apps/${id}`);
  }

  if (!health.latest) {
    return <div className="empty">Nothing published yet.</div>;
  }

  return (
    <div className={`card health ${health.suspect ? "suspect" : ""}`}>
      <div>
        <strong>
          {health.suspect
            ? `${health.crashReports} crash reports since the last release`
            : "No crash reports on the current release"}
        </strong>
        <p className="sub" style={{ margin: "4px 0 0" }}>
          {health.suspect
            ? "Reported by installed apps that failed to launch. Advisory — the endpoint is unauthenticated, so treat this as a prompt to look, not proof."
            : "Installed apps report failed launches here. Silence is weak evidence, not a guarantee."}
        </p>
      </div>

      {health.rollback.available ? (
        <form action={act}>
          <input type="hidden" name="appId" value={appId} />
          <button type="submit" className="danger">
            Roll back to {health.rollback.to}
          </button>
        </form>
      ) : (
        <p className="sub" style={{ margin: 0, maxWidth: 340 }}>
          <strong>Cannot roll back.</strong> {health.rollback.reason}
        </p>
      )}
    </div>
  );
}
