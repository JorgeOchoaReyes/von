import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0b0b0f" },
          headerTintColor: "#e8e8ef",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: "#0b0b0f" },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Von" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
