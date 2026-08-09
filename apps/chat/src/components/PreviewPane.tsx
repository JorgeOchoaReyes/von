import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

/**
 * The user's app, running, while they are still deciding what it should be.
 *
 * This is the fast half of the loop. Publishing is a minute for an OTA and ten
 * for a build (docs/ARCHITECTURE.md §12) — far too slow to answer "is this what
 * I meant?". The preview is the app itself, served from the working tree, so
 * the answer arrives while they are still typing.
 */
export interface PreviewPaneProps {
  url: string | null;
  /** True while a turn is running: the preview is about to change under them. */
  busy: boolean;
  error?: string;
}

/** `https://host:port/a/b` -> `https://host:port/*`, the form WebView expects. */
const originOf = (url: string): string => {
  const match = /^[a-z]+:\/\/[^/]+/i.exec(url);
  return match ? `${match[0]}/*` : url;
};

export function PreviewPane({ url, busy, error }: PreviewPaneProps) {
  // Remounts the webview when the URL changes so a new session never inherits
  // the previous app's page state.
  const [nonce, setNonce] = useState(0);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (url !== last.current) {
      last.current = url;
      setNonce((n) => n + 1);
    }
  }, [url]);

  if (!url) {
    return (
      <View style={styles.placeholder}>
        {busy ? <ActivityIndicator color="#8b8b9c" /> : null}
        <Text style={styles.placeholderText}>
          {error
            ? `Preview unavailable: ${error}`
            : busy
              ? "Starting your app…"
              : "Your app will appear here as you describe it."}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.frame}>
      {Platform.OS === "web" ? (
        // WebView has no web implementation; an iframe is the same thing here.
        <iframe
          key={nonce}
          src={url}
          style={{ border: "0", width: "100%", height: "100%" }}
          title="App preview"
        />
      ) : (
        <WebView
          key={nonce}
          source={{ uri: url }}
          style={styles.web}
          // The preview is a dev server the platform started, but what it serves
          // is model-generated code — keep it pinned to its own origin and off
          // the device's files.
          allowFileAccess={false}
          originWhitelist={[originOf(url)]}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.placeholder}>
              <ActivityIndicator color="#8b8b9c" />
            </View>
          )}
        />
      )}
      {busy ? (
        <View style={styles.updating}>
          <ActivityIndicator size="small" color="#0b0b0f" />
          <Text style={styles.updatingText}>Updating…</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: "#14141b" },
  web: { flex: 1, backgroundColor: "#14141b" },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
    backgroundColor: "#14141b",
  },
  placeholderText: { color: "#8b8b9c", fontSize: 14, textAlign: "center", lineHeight: 20 },
  updating: {
    position: "absolute",
    top: 10,
    right: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#e8e8ef",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  updatingText: { color: "#0b0b0f", fontSize: 12, fontWeight: "600" },
});
