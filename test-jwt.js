import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';
const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const app = initializeApp({ projectId: config.projectId });
console.log("App initialized.");
try {
  // Just testing if getAuth works without ADC
  getAuth(app);
  console.log("Auth initialized successfully.");
  process.exit(0);
} catch (e) {
  console.error("Auth error:", e);
  process.exit(1);
}
