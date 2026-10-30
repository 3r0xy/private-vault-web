import { mkdir, copyFile } from 'node:fs/promises';
const files = ['index.html', 'app.js', 'domain.mjs', 'task-hub.mjs', 'auth.mjs', 'loader.js',
  'styles.css', 'manifest.webmanifest', 'favicon.ico', 'vendor/codemirror.js', 'vendor/d3.js',
  'icons/note-cat-192.png', 'icons/note-cat-512.png'];
for (const file of files) {
  const destination = new URL('../work/worker-assets/' + file, import.meta.url);
  await mkdir(new URL('.', destination), { recursive: true });
  await copyFile(new URL('../' + file, import.meta.url), destination);
}
