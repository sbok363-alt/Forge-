const fs = require('fs');
let code = fs.readFileSync('src/pages/Brain.tsx', 'utf8');

const targetStr = `      const res = await fetch('/api/forge-brain', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: messagesPayload,
          targetWorkoutId: thread.targetWorkoutId,
          autonomyLevel: permissions.autonomyLevel,
          geminiApiKey: geminiApiKey || undefined
        })
      });

      if (!res.ok) throw new Error("Failed to connect to FORGE Brain");`;

const replacementStr = `      const res = await fetch('/api/forge-brain', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: messagesPayload,
          targetWorkoutId: thread.targetWorkoutId,
          autonomyLevel: permissions.autonomyLevel,
          geminiApiKey: geminiApiKey || undefined
        })
      });

      if (res.status === 401 || res.status === 403) {
         openBYOKModal();
         setMessages(prev => prev.slice(0, -1)); // Remove the user message
         return;
      }
      if (!res.ok) throw new Error("Failed to connect to FORGE Brain");`;

code = code.replace(targetStr, replacementStr);
fs.writeFileSync('src/pages/Brain.tsx', code);
