/**
 * Reapplies Gradle memory settings after `expo prebuild`, which regenerates
 * android/gradle.properties from its template and drops any local edits.
 *
 * Expo's defaults ask for a 2GB heap plus a separate Kotlin daemon. On a machine
 * with ~8GB total and little free, that fails with a native OOM and a
 * "Gradle build daemon disappeared" message that looks like a Gradle bug rather
 * than a memory problem. These settings trade build speed for fitting in RAM.
 *
 * Run automatically by `npm run prebuild`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROPS = join(HERE, '..', 'android', 'gradle.properties');

const MARKER = '# --- sutra memory tuning ---';

const TUNING = `
${MARKER}
# Tuned for a machine with ~8GB total RAM. The stock 2g heap plus a separate
# Kotlin daemon crashed the build with a native out-of-memory error.
org.gradle.jvmargs=-Xmx1400m -XX:MaxMetaspaceSize=384m
org.gradle.parallel=false
org.gradle.workers.max=2
kotlin.compiler.execution.strategy=in-process
kotlin.incremental=false

# Build native code for one ABI instead of four. Reanimated and worklets compile
# a large amount of C++, and doing it four times over exhausted memory even
# though each architecture builds fine on its own.
#
# arm64-v8a covers essentially every physical Android phone in use. It does NOT
# cover x86_64 emulators - add x86_64 to this list if you need to run on one,
# at the cost of roughly double the native build time and memory.
reactNativeArchitectures=arm64-v8a
`;

if (!existsSync(PROPS)) {
  console.error(`No ${PROPS}. Run "expo prebuild" first.`);
  process.exit(1);
}

let contents = readFileSync(PROPS, 'utf8');

if (contents.includes(MARKER)) {
  console.log('gradle.properties already tuned.');
  process.exit(0);
}

// Comment out the stock values so the intent stays visible in the file rather
// than relying on later-key-wins behaviour.
contents = contents
  .replace(/^org\.gradle\.jvmargs=/m, '# superseded below: org.gradle.jvmargs=')
  .replace(/^org\.gradle\.parallel=/m, '# superseded below: org.gradle.parallel=');

writeFileSync(PROPS, contents + TUNING);
console.log('Applied Gradle memory tuning to android/gradle.properties.');
