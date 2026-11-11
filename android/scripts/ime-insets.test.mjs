// node --test android/scripts/ime-insets.test.mjs
//
// Guards how the Android app keeps the page above the on-screen keyboard
// (android/plugins/push/android/src/main/java/ImeInsets.kt, docs/android.md, "The
// keyboard"). The Kotlin cannot be compiled or run on a PC without Android Studio:
// only CI's Gradle build compiles it, and only a phone shows the keyboard. So this reads
// the source for the choices that each took finding out the hard way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'push', 'android');
const source = (name) => path.join(plugin, 'src', 'main', 'java', name);
const read = (file) => readFileSync(file, 'utf8');
// What the Kotlin says, less its comments, so a word in a comment proves nothing
const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the keyboard is handled in a file of the push plugin', () => {
  assert.ok(existsSync(source('ImeInsets.kt')), 'ImeInsets.kt is missing');
});

test('the plugin sets it up when it loads', () => {
  const push = code(source('PushPlugin.kt'));
  const load = /override fun load\(webView: WebView\) \{([\s\S]*?)\n    \}/.exec(push);
  assert.ok(load, 'PushPlugin.load not found');
  assert.match(load[1], /ImeInsets\.install\(activity\)/);
});

test('it uses only what the plugin can see', () => {
  const ime = code(source('ImeInsets.kt'));
  const imports = [...ime.matchAll(/^import ([\w.]+)/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'no imports read');
  // tauri-android keeps AppCompat to itself (`implementation`), so the plugin's own classpath
  // has no AppCompatActivity, which is also why this is not a Plugin.onResume override
  assert.deepEqual(imports.filter((i) => i.startsWith('androidx.appcompat')), []);
  for (const i of imports) {
    assert.ok(i.startsWith('android.') || i.startsWith('androidx.core.'), `${i} is not from the platform or core-ktx`);
  }
  const gradle = read(path.join(plugin, 'build.gradle.kts'));
  assert.match(gradle, /androidx\.core:core-ktx:/, 'androidx.core.view comes from core-ktx');
});

test('the activity\'s content view is padded by the keyboard, and the page is told it was', () => {
  const ime = code(source('ImeInsets.kt'));
  assert.match(ime, /findViewById<View>\(android\.R\.id\.content\)/, 'the WebView ignores its own padding, so its parent is the one to pad');
  assert.match(ime, /ViewCompat\.setOnApplyWindowInsetsListener\(content\)/);
  assert.match(ime, /getInsets\(WindowInsetsCompat\.Type\.ime\(\)\)\.bottom/);
  assert.match(ime, /setPadding\(/);
  // Zeroed, not consumed (consuming leaves the WebView with the keyboard it last heard of)
  assert.match(ime, /setInsets\(WindowInsetsCompat\.Type\.ime\(\), Insets\.NONE\)/);
  assert.doesNotMatch(ime, /CONSUMED/);
  // Not on the WebView itself: a listener there replaces the WebView's own handling of insets
  assert.doesNotMatch(ime, /setOnApplyWindowInsetsListener\((webView|view)\b/);
});

test('the bar under the keyboard is not padded for a second time', () => {
  const ime = code(source('ImeInsets.kt'));
  assert.match(ime, /setInsets\(WindowInsetsCompat\.Type\.navigationBars\(\), Insets\.of\(bar\.left, bar\.top, bar\.right, 0\)\)/);
});

test('each activity is fitted as it resumes, as the plugin is loaded once per process', () => {
  const ime = code(source('ImeInsets.kt'));
  assert.match(ime, /registerActivityLifecycleCallbacks/);
  assert.match(ime, /override fun onActivityResumed\(a: Activity\) = fit\(a\)/);
});

test('only the app\'s own activity is touched, and only where the keyboard is an inset', () => {
  const ime = code(source('ImeInsets.kt'));
  assert.match(ime, /Build\.VERSION_CODES\.R\b/, 'Android 11 is the first where the keyboard is an inset the app can read');
  assert.match(ime, /a\.javaClass != /, 'an activity of another kind (a Google one, say) is left as it is');
});
