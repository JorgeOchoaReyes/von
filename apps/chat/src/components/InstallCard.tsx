import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { HealthInfo } from "../lib/client";

/**
 * "Where is my app?"
 *
 * The question the whole product is answering, and until this card existed the
 * chat had no answer to it. Previews run in a browser and updates land on a
 * binary that is already installed — neither one puts the app on a phone. Only
 * a native build does, so this is where that build surfaces.
 *
 * It appears once and then stays: reinstalling is how a user gets a second
 * device onto the app, and hiding the link after the first build would make
 * that look impossible.
 */
export interface InstallCardProps {
  health: HealthInfo | null;
}

export function InstallCard({ health }: InstallCardProps) {
  if (!health) return null;

  // A build in flight is worth saying even before there is anything to install:
  // it is ten minutes of silence otherwise, which reads as nothing happening.
  if (!health.install) {
    if (!health.building) return null;
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Building your app</Text>
        <Text style={styles.body}>
          About ten minutes. When it finishes there will be a link here to install
          it on your phone.
        </Text>
      </View>
    );
  }

  const { install } = health;

  return (
    <View style={styles.card}>
      <View style={styles.copy}>
        <Text style={styles.title}>Your app is ready to install</Text>
        <Text style={styles.body}>
          {health.building
            ? // The link points at the previous binary. Saying "install" without
              // this would have the user install it, look for the change they
              // just published, and not find it.
              "A newer build is still going — this link is the previous one, without your latest change."
            : "Android will ask about installing from an unknown source. After this, updates arrive on their own."}
        </Text>
      </View>

      <Pressable style={styles.button} onPress={() => void Linking.openURL(install.url)}>
        <Text style={styles.buttonText}>Install</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#141b21",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#2f4a6b",
  },
  copy: { flex: 1 },
  title: { color: "#e8e8ef", fontWeight: "600", fontSize: 13 },
  body: { color: "#8b8b9c", fontSize: 12, marginTop: 2, lineHeight: 16 },
  button: {
    backgroundColor: "#3b7ddd",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
