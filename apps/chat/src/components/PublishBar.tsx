import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { PreviewInfo, ReleaseInfo } from "../lib/client";

/**
 * The gate between "I am trying things" and "my users have this".
 *
 * It states the cost before the user commits to it — an OTA lands in about a
 * minute, a native change needs a build of about ten — because the alternative
 * is a user who publishes, sees nothing change on their phone, and concludes
 * the platform is broken.
 */
export interface PublishBarProps {
  preview: PreviewInfo | null;
  published: ReleaseInfo | null;
  busy: boolean;
  onPublish: () => void;
  onDiscard: () => void;
}

export function PublishBar({ preview, published, busy, onPublish, onDiscard }: PublishBarProps) {
  if (published) {
    return (
      <View style={[styles.bar, styles.shipped]}>
        <Text style={styles.shippedText}>
          {published.kind === "ota"
            ? "Published — it will reach your app in about a minute."
            : published.kind === "native"
              ? "Published — this one needs a new build, about ten minutes."
              : published.reason}
        </Text>
      </View>
    );
  }

  if (!preview?.publishable) return null;

  const native = preview.kind === "native";

  return (
    <View style={[styles.bar, native ? styles.native : styles.ota]}>
      <View style={styles.copy}>
        <Text style={styles.title}>
          {native ? "Needs a new build (~10 min)" : "Ready to publish (~1 min)"}
        </Text>
        <Text style={styles.reason} numberOfLines={2}>
          {preview.reason}
        </Text>
      </View>

      <Pressable style={styles.discard} onPress={onDiscard} disabled={busy}>
        <Text style={styles.discardText}>Discard</Text>
      </Pressable>
      <Pressable
        style={[styles.publish, busy && styles.disabled]}
        onPress={onPublish}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.publishText}>Publish</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  ota: { borderColor: "#2f6b53", backgroundColor: "#12211b" },
  native: { borderColor: "#6b5a2f", backgroundColor: "#211d12" },
  shipped: { borderColor: "#24242e", backgroundColor: "#14141b" },
  shippedText: { color: "#8b8b9c", fontSize: 13, flex: 1 },
  copy: { flex: 1 },
  title: { color: "#e8e8ef", fontWeight: "600", fontSize: 13 },
  reason: { color: "#8b8b9c", fontSize: 12, marginTop: 2, lineHeight: 16 },
  discard: { paddingHorizontal: 10, paddingVertical: 8 },
  discardText: { color: "#8b8b9c", fontSize: 13, fontWeight: "600" },
  publish: {
    backgroundColor: "#7c6cff",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    minWidth: 82,
    alignItems: "center",
  },
  publishText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  disabled: { opacity: 0.5 },
});
