import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { installCrashReporter } from "../src/lib/report";

// At module scope, before any screen mounts: an update that breaks the very
// first render has to be reportable, and that is exactly the case worth
// catching.
installCrashReporter();

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: "{{APP_NAME}}" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
