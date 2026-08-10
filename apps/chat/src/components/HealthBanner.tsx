import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { HealthInfo } from "../lib/client";

/**
 * "Your users' apps are crashing."
 *
 * The one thing in this UI that interrupts. Everything else here is about the
 * change you are making now; this is about the change you already shipped, and
 * it only appears when installed apps have reported failing to launch.
 *
 * The wording avoids certainty it does not have. The crash endpoint is
 * unauthenticated — a client app holds no secret — so the count is a prompt to
 * look, not proof of a fault, and the copy says so rather than asserting the
 * release is broken.
 */
export interface HealthBannerProps {
  health: HealthInfo | null;
  busy: boolean;
  onRollback: () => void;
}

export function HealthBanner({ health, busy, onRollback }: HealthBannerProps) {
  // Silence is the normal state and deserves no pixels.
  if (!health?.suspect) return null;

  return (
    <View style={styles.banner}>
      <View style={styles.copy}>
        <Text style={styles.title}>
          {health.crashReports} {health.crashReports === 1 ? "device" : "devices"} failed to
          open your app
        </Text>
        <Text style={styles.body}>
          {health.rollback.available
            ? "Reported since your last update. Going back restores the version before it, in about a minute."
            : health.rollback.reason}
        </Text>
      </View>

      {health.rollback.available ? (
        <Pressable style={[styles.button, busy && styles.disabled]} onPress={onRollback} disabled={busy}>
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Undo</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#2a1416",
    borderBottomWidth: 1,
    borderBottomColor: "#6b2f33",
  },
  copy: { flex: 1 },
  title: { color: "#ffd9d9", fontWeight: "600", fontSize: 14 },
  body: { color: "#c9a2a2", fontSize: 12.5, lineHeight: 17, marginTop: 3 },
  button: {
    backgroundColor: "#d9534f",
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
    minWidth: 74,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  disabled: { opacity: 0.5 },
});
