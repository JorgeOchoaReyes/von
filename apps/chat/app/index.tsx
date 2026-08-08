import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { createApp, streamChat, type ReleaseInfo } from "../src/lib/client";

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  release?: ReleaseInfo;
}

/**
 * The product surface: describe an app, watch it get built.
 *
 * Two things are deliberately visible here that a generic chat UI would hide —
 * the tool activity line, so the user can tell work is happening during a long
 * turn, and the release banner, which tells them *how* the change reaches their
 * phone. That second one is the difference between "it says done but my app
 * looks the same" and a user who understands they need to install a build.
 */
export default function ChatScreen() {
  const [appId, setAppId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const listRef = useRef<FlatList<Turn>>(null);

  const append = (turn: Turn) => setTurns((t) => [...t, turn]);

  const patchLast = (patch: (t: Turn) => Turn) =>
    setTurns((t) => (t.length === 0 ? t : [...t.slice(0, -1), patch(t[t.length - 1]!)]));

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;

    setInput("");
    setBusy(true);
    append({ id: `u${Date.now()}`, role: "user", text: message });

    try {
      // First message doubles as the app description — no setup form.
      let id = appId;
      if (!id) {
        setActivity("Creating your app…");
        const created = await createApp(message.slice(0, 40), message);
        id = created.id;
        setAppId(id);
      }

      append({ id: `a${Date.now()}`, role: "assistant", text: "" });

      await new Promise<void>((resolve) => {
        streamChat(id!, message, (e) => {
          if (e.type === "text") {
            setActivity(null);
            patchLast((t) => ({ ...t, text: t.text + e.text }));
          } else if (e.type === "tool") {
            setActivity(`${e.name.replace(/_/g, " ")}…`);
          } else if (e.type === "release") {
            patchLast((t) => ({ ...t, release: e.release }));
          } else if (e.type === "error") {
            patchLast((t) => ({ ...t, text: `${t.text}\n\n${e.message}` }));
          } else if (e.type === "end") {
            resolve();
          }
        });
      });
    } catch (err) {
      append({
        id: `e${Date.now()}`,
        role: "assistant",
        text: (err as Error).message,
      });
    } finally {
      setBusy(false);
      setActivity(null);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [input, busy, appId]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        ref={listRef}
        data={turns}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>What do you want to build?</Text>
            <Text style={styles.emptyBody}>
              Describe it in a sentence. You will have something running on your
              phone in under a minute.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={item.role === "user" ? styles.userTurn : styles.assistantTurn}>
            <Text style={styles.turnText}>{item.text || " "}</Text>
            {item.release && item.release.kind !== "none" ? (
              <View
                style={[
                  styles.release,
                  item.release.kind === "ota" ? styles.releaseOta : styles.releaseNative,
                ]}
              >
                <Text style={styles.releaseLabel}>
                  {item.release.kind === "ota" ? "Shipping now" : "New build needed"}
                </Text>
                <Text style={styles.releaseReason}>{item.release.reason}</Text>
              </View>
            ) : null}
          </View>
        )}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {activity ? (
        <View style={styles.activity}>
          <ActivityIndicator size="small" color="#8b8b9c" />
          <Text style={styles.activityText}>{activity}</Text>
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={appId ? "Describe a change…" : "Describe your app…"}
          placeholderTextColor="#5c5c6b"
          multiline
          editable={!busy}
          onSubmitEditing={send}
        />
        <Pressable
          style={[styles.send, (busy || !input.trim()) && styles.sendDisabled]}
          onPress={send}
          disabled={busy || !input.trim()}
        >
          <Text style={styles.sendText}>{busy ? "…" : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0b0f" },
  list: { padding: 16, gap: 12, flexGrow: 1 },
  empty: { flex: 1, justifyContent: "center", paddingHorizontal: 12 },
  emptyTitle: { color: "#e8e8ef", fontSize: 22, fontWeight: "600", marginBottom: 8 },
  emptyBody: { color: "#8b8b9c", fontSize: 15, lineHeight: 22 },
  userTurn: {
    alignSelf: "flex-end",
    maxWidth: "86%",
    backgroundColor: "#7c6cff",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  assistantTurn: { alignSelf: "flex-start", maxWidth: "94%" },
  turnText: { color: "#e8e8ef", fontSize: 15, lineHeight: 22 },
  release: { marginTop: 10, borderRadius: 10, borderWidth: 1, padding: 12 },
  releaseOta: { borderColor: "#2f6b53", backgroundColor: "#12211b" },
  releaseNative: { borderColor: "#6b5a2f", backgroundColor: "#211d12" },
  releaseLabel: { color: "#e8e8ef", fontWeight: "600", fontSize: 13, marginBottom: 4 },
  releaseReason: { color: "#8b8b9c", fontSize: 13, lineHeight: 19 },
  activity: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  activityText: { color: "#8b8b9c", fontSize: 13 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#24242e",
  },
  input: {
    flex: 1,
    maxHeight: 120,
    color: "#e8e8ef",
    backgroundColor: "#14141b",
    borderWidth: 1,
    borderColor: "#24242e",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  send: {
    backgroundColor: "#7c6cff",
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
