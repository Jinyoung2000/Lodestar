import type { ServerEvent, Settings } from "../shared/protocol";
import { defaultsReader } from "./defaults";
import type { Store } from "./store";
import type { HandlersFor } from "./rpcHandlers";

export type SettingsEffect = { keys?: readonly (keyof Settings)[]; apply: (next: Settings, previous: Settings) => void | Promise<void> };

export type SettingsHandlerDeps = { store: Store; broadcast: (event: ServerEvent) => void; effects: readonly SettingsEffect[] };

export function settingsHandlers(deps: SettingsHandlerDeps): HandlersFor<"settings.get" | "settings.set" | "defaults.get"> {
  const { store, broadcast, effects } = deps;
  return {
    "settings.get": () => store.settings,
    "defaults.get": () => defaultsReader.resolve(store.settings, true),
    "settings.set": async (patch) => {
      const previous = store.settings;
      const settings = store.updateSettings(patch);
      const changed = (key: keyof Settings) => !!patch && typeof patch === "object" && key in patch;
      for (const effect of effects) {
        if (effect.keys && !effect.keys.some(changed)) continue;
        const done = effect.apply(settings, previous);
        if (done instanceof Promise) await done;
      }
      broadcast({ type: "settings", settings, defaults: defaultsReader.resolve(settings, true) });
      return settings;
    },
  };
}
