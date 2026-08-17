const fs = require('fs');
let code = fs.readFileSync('src/components/WorkoutDetailModal.tsx', 'utf8');

const targetStr = `      try {
        const token = user ? await user.getIdToken() : '';
        const res = await fetch('/api/optimize-workout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': \`Bearer \${token}\` })
          },
          body: JSON.stringify({ workout: { ...workout, sets }, strategy: chosenStrategy, geminiApiKey })
        });
        const data = await res.json();
        if (data.success && data.sets) {
          newSets = data.sets;
          summaryText = chosenStrategy === 'SWAP_EXERCISE' ? 'Equipment Busy: Exercise Swapped' : 'Low Energy: Mid-Session Deload Applied';
          rationales = [
            "Analyzed remaining incomplete sets using Gemini AI.",
            chosenStrategy === 'SWAP_EXERCISE' ? "Replaced exercise with a biomechanically similar alternative." : "Reduced load by 20% and reps by 2 for remaining sets.",
            "Locked version utilizing OCC for conflict-free state merging."
          ];
        } else {
          throw new Error('API failed');
        }
      } catch (e) {
        // Fallback simulation`;

const replacementStr = `      try {
        const token = user ? await user.getIdToken() : '';
        const res = await fetch('/api/optimize-workout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': \`Bearer \${token}\` })
          },
          body: JSON.stringify({ workout: { ...workout, sets }, strategy: chosenStrategy, geminiApiKey })
        });
        if (res.status === 401 || res.status === 403) {
           const err = new Error('Invalid API Key');
           (err as any).status = res.status;
           throw err;
        }
        const data = await res.json();
        if (data.success && data.sets) {
          newSets = data.sets;
          summaryText = chosenStrategy === 'SWAP_EXERCISE' ? 'Equipment Busy: Exercise Swapped' : 'Low Energy: Mid-Session Deload Applied';
          rationales = [
            "Analyzed remaining incomplete sets using Gemini AI.",
            chosenStrategy === 'SWAP_EXERCISE' ? "Replaced exercise with a biomechanically similar alternative." : "Reduced load by 20% and reps by 2 for remaining sets.",
            "Locked version utilizing OCC for conflict-free state merging."
          ];
        } else {
          throw new Error('API failed');
        }
      } catch (e: any) {
        if (e.status === 401 || e.status === 403) {
           openBYOKModal();
        } else {
           console.error("AI Optimization fallback triggered due to network/server error.");
        }
        // Fallback simulation`;

code = code.replace(targetStr, replacementStr);
fs.writeFileSync('src/components/WorkoutDetailModal.tsx', code);
