// Ajuste le projet Android généré par `npx cap add android` :
//  - permission caméra (nécessaire pour le bouton « Prendre la carte en photo »)
//  - désactive la sauvegarde cloud Android (les clés API restent sur le téléphone)
//  - plus de mémoire pour Gradle
const fs = require('fs');
const path = require('path');

const manifest = path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml');
let x = fs.readFileSync(manifest, 'utf8');
const add = (line, marker) => {
  if (!x.includes(marker)) x = x.replace('</manifest>', `    ${line}\n</manifest>`);
};
add('<uses-permission android:name="android.permission.CAMERA" />', 'android.permission.CAMERA');
add('<uses-feature android:name="android.hardware.camera" android:required="false" />', 'android.hardware.camera');
x = x.replace('android:allowBackup="true"', 'android:allowBackup="false"');
fs.writeFileSync(manifest, x);

const props = path.join('android', 'gradle.properties');
let g = fs.readFileSync(props, 'utf8');
g = /org\.gradle\.jvmargs=/.test(g) ? g.replace(/org\.gradle\.jvmargs=.*/, 'org.gradle.jvmargs=-Xmx3072m') : g + '\norg.gradle.jvmargs=-Xmx3072m\n';
fs.writeFileSync(props, g);

console.log('AndroidManifest.xml et gradle.properties patchés');
