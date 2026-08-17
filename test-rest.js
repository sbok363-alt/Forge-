import fs from 'fs';
const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const projectId = config.projectId;
const dbId = config.firestoreDatabaseId || '(default)';
console.log(`URL: https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}/documents/users`);
