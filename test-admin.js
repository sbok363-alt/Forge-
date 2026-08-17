import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const app = initializeApp({ projectId: config.projectId });
// For named databases, we use getFirestore(app, databaseId) but wait, nodejs firebase-admin firestore named dbs is not well documented for old versions, let's just use getFirestore() since the default db is usually what we need or we can pass databaseId.
// Actually firebase-applet-config.json has `firestoreDatabaseId`.
getFirestore(config.firestoreDatabaseId).collection('users').limit(1).get().then(snap => {
  console.log("Firestore success:", snap.size);
  process.exit(0);
}).catch(e => {
  console.error("Firestore error:", e.message);
  process.exit(1);
});
