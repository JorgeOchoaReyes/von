import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { ensureSignedIn } from "../src/lib/firebase";
import { reportLaunchFailure } from "../src/lib/report";

// Read from app.json rather than substituted in. A template token written
// directly into JSX would parse as an object literal before substitution, which
// is a trap for anyone opening this file in an editor.
const APP_NAME = Constants.expoConfig?.name ?? "App";

/**
 * The starting screen.
 *
 * Deliberately small — this is what the agent edits and replaces on the first
 * instruction. What it does do is prove the backend connection end to end
 * before any feature is built on top of it: fetch the runtime config, connect
 * Firebase to this app's own tenant and database, and sign in. When that is
 * broken, it says so here rather than failing later inside a feature.
 */
export default function Home() {
  const [uid, setUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ensureSignedIn()
      .then(setUid)
      .catch((e: Error) => {
        setError(e.message);
        // A backend the app cannot reach is a failed launch from the user's
        // point of view, even though nothing threw past React.
        void reportLaunchFailure();
      });
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Not connected</Text>
        <Text style={styles.body}>{error}</Text>
      </View>
    );
  }

  if (!uid) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
        <Text style={styles.body}>Connecting…</Text>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>{APP_NAME}</Text>
      <Text style={styles.body}>Connected. Describe a change to get started.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  title: { fontSize: 22, fontWeight: "600" },
  body: { fontSize: 15, opacity: 0.7, textAlign: "center" },
});
