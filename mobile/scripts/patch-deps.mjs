import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modules = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");

const patches = [
  {
    file: "@shopify/flash-list/dist/recyclerview/ViewHolderCollection.js",
    from: "React.createElement(CompatView, { style: hasData && containerStyle }",
    to: "React.createElement(CompatView, { collapsable: false, style: hasData && containerStyle }",
  },
  {
    file: "@shopify/flash-list/src/recyclerview/ViewHolderCollection.tsx",
    from: "<CompatView style={hasData && containerStyle}>",
    to: "<CompatView collapsable={false} style={hasData && containerStyle}>",
  },
  {
    file: "@react-native-async-storage/async-storage/android/src/main/java/com/reactnativecommunity/asyncstorage/AsyncStorageModule.java",
    from: "    mShuttingDown = true;\n    // ensure we close database when activity is destroyed\n    mReactDatabaseSupplier.closeDatabase();\n",
    to: "    mShuttingDown = true;\n",
  },
];

let failed = false;
for (const { file, from, to } of patches) {
  const path = join(modules, file);
  const source = readFileSync(path, "utf8");
  if (!source.includes(from)) {
    if (source.includes(to)) continue;
    console.error(`patch-deps: ${file} no longer has the text to patch; check the dependency update`);
    failed = true;
    continue;
  }
  writeFileSync(path, source.replace(from, to));
  console.log(`patch-deps: patched ${file}`);
}
if (failed) process.exit(1);
