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
import { PreviewPane } from "../src/components/PreviewPane";
import { PublishBar } from "../src/components/PublishBar";
import {
  createApp,
  discardPreview,
  publish,
  streamChat,
  type PreviewInfo,
  type ReleaseInfo,
} from "../src/lib/client";

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * The product surface: describe an app, watch it get built, publish when it is
 * right.
 *
 * The screen is split on purpose. Above, the app is actually running and
 * changing as the agent works — that is the loop that has to feel instant.
 * Below, the conversation. Between them, the publish bar, which is the only
 * thing here that reaches anyone else's phone; a user should never be able to
 * ship by accident, and should never have to guess whether they have.
 */
export default function ChatScreen() {
  const [appId, setAppId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [published, setPublished] = useState<ReleaseInfo | null>(null);
  const listRef = useRef<FlatList<Turn>>(null);

  const append = (turn: Turn) => setTurns((t) => [...t, turn]);

  const patchLast = (patch: (t: Turn) => Turn) =>
    setTurns((t) => (t.length === 0 ? t : [...t.slice(0, -1), patch(t[t.length - 1]!)]));

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;

    setInput("");
    setBusy(true);
    // A new instruction supersedes the last result: the old "published" banner
    // would otherwise still be claiming success for a change nobody is looking
    // at any more.
    setPublished(null);
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
          } else if (e.type === "preview") {
            setPreview(e.preview);
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

  const onPublish = useCallback(async () => {
    if (!appId || publishing) return;
    setPublishing(true);
    try {
      setPublished(await publish(appId));
      setPreview(null);
    } catch (err) {
      append({ id: `p${Date.now()}`, role: "assistant", text: (err as Error).message });
    } finally {
      setPublishing(false);
    }
  }, [appId, publishing]);

  const onDiscard = useCallback(async () => {
    if (!appId || publishing) return;
    setPublishing(true);
    try {
      await discardPreview(appId);
      setPreview(null);
      append({
        id: `d${Date.now()}`,
        role: "assistant",
        text: "Reverted to the last published version.",
      });
    } catch (err) {
      append({ id: `d${Date.now()}`, role: "assistant", text: (err as Error).message });
    } finally {
      setPublishing(false);
    }
  }, [appId, publishing]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.previewPane}>
        <PreviewPane url={preview?.url ?? null} busy={busy} error={preview?.error} />
      </View>

      <PublishBar
        preview={preview}
        published={published}
        busy={publishing}
        onPublish={onPublish}
        onDiscard={onDiscard}
      />

      <View style={styles.chatPane}>
        <FlatList
          ref={listRef}
          data={turns}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>What do you want to build?</Text>
              <Text style={styles.emptyBody}>
                Describe it in a sentence. It will start running above as you go —
                nothing reaches anyone else until you publish.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={item.role === "user" ? styles.userTurn : styles.assistantTurn}>
              <Text style={styles.turnText}>{item.text || " "}</Text>
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
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b0b0f" },
  // Slightly more room to the running app than to the transcript: the app is
  // what the user is judging, the transcript is how they got there.
  previewPane: { flex: 1.2 },
  chatPane: { flex: 1 },
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
