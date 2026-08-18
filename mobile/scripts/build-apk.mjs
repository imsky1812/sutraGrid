/**
 * Builds the debug APK with settings that fit a memory-constrained machine.
 *
 * The problem this solves: ninja spawns one clang process per CPU core (12 here)
 * to compile the React Native C++ codegen. With ~1GB free that overruns memory
 * and clang dies with "LLVM ERROR: out of memory", which surfaces as a Gradle
 * task failure with no obvious cause.
 *
 * org.gradle.workers.max does NOT reach ninja's internal parallelism.
 * CMAKE_BUILD_PARALLEL_LEVEL does, which is why it is set here rather than in
 * gradle.properties.
 *
 * Usage: npm run apk
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ANDROID = join(HERE, '..', 'android');

if (!existsSync(ANDROID)) {
  console.error('No android/ directory. Run "npm run prebuild" first.');
  process.exit(1);
}

// Android Studio ships a JDK; use it when JAVA_HOME is not already set.
const BUNDLED_JDK = 'C:\\Program Files\\Android\\Android Studio\\jbr';
const env = { ...process.env };
if (!env.JAVA_HOME && existsSync(BUNDLED_JDK)) env.JAVA_HOME = BUNDLED_JDK;

// The setting that actually matters. Raise it if the machine has spare RAM.
env.CMAKE_BUILD_PARALLEL_LEVEL = env.CMAKE_BUILD_PARALLEL_LEVEL || '2';

const isWindows = process.platform === 'win32';
const gradlew = join(ANDROID, isWindows ? 'gradlew.bat' : 'gradlew');

console.log(`Building with CMAKE_BUILD_PARALLEL_LEVEL=${env.CMAKE_BUILD_PARALLEL_LEVEL}`);

const child = spawn(
  gradlew,
  ['assembleDebug', '--console=plain', '--no-daemon', '--max-workers=1'],
  { cwd: ANDROID, env, stdio: 'inherit', shell: isWindows },
);

child.on('exit', (code) => {
  if (code === 0) {
    console.log('\nAPK: android/app/build/outputs/apk/debug/app-debug.apk');
  } else {
    console.error(
      '\nBuild failed. If the log mentions "LLVM ERROR: out of memory", close other ' +
        'applications or lower CMAKE_BUILD_PARALLEL_LEVEL to 1.',
    );
  }
  process.exit(code ?? 1);
});
